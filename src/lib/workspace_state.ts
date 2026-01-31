/**
 * Workspace state persistence library.
 *
 * Manages reading and writing STATE.json to track milestone progress
 * and budget consumption across restarts.
 *
 * @see docs/NEW-PLAN.md lines 48-59
 */

import { join } from 'node:path';
import { atomicReadJson, atomicWriteJson, AtomicFsError } from './fs.js';
import type { WorkspaceState, BudgetCounts, BudgetDeltas } from '../types/workspace_state.js';
import type { PerMilestoneBudgets } from '../types/config.js';

/**
 * Creates a default empty WorkspaceState.
 *
 * @returns Default state with null milestone_id, zero budgets, false budget_warning
 */
export function createDefaultState(): WorkspaceState {
  return {
    milestone_id: null,
    budgets: {
      ticks: 0,
      orchestrator_calls: 0,
      builder_calls: 0,
      verify_runs: 0,
    },
    budget_warning: false,
    last_run_id: null,
    last_verdict: null,
  };
}

/**
 * Reads and parses STATE.json from workspaceDir.
 *
 * Returns default state if file doesn't exist.
 *
 * @param workspaceDir - The workspace directory containing STATE.json
 * @returns Parsed WorkspaceState or default if file doesn't exist
 */
export async function readWorkspaceState(workspaceDir: string): Promise<WorkspaceState> {
  const filePath = join(workspaceDir, 'STATE.json');

  try {
    const state = await atomicReadJson<WorkspaceState>(filePath);
    // Validate shape matches WorkspaceState interface
    // TypeScript will catch type mismatches, but we ensure required fields exist
    if (
      typeof state === 'object' &&
      state !== null &&
      'milestone_id' in state &&
      'budgets' in state &&
      'budget_warning' in state &&
      'last_run_id' in state &&
      'last_verdict' in state
    ) {
      return state;
    }
    // If shape doesn't match, return default
    return createDefaultState();
  } catch (error) {
    // If file doesn't exist or can't be read, return default state
    if (error instanceof AtomicFsError) {
      return createDefaultState();
    }
    // Re-throw unexpected errors
    throw error;
  }
}

/**
 * Writes WorkspaceState to STATE.json atomically.
 *
 * Uses atomic write pattern for crash safety.
 *
 * @param workspaceDir - The workspace directory to write STATE.json to
 * @param state - The WorkspaceState to persist
 */
export async function writeWorkspaceState(
  workspaceDir: string,
  state: WorkspaceState
): Promise<void> {
  const filePath = join(workspaceDir, 'STATE.json');
  await atomicWriteJson(filePath, state);
}

/**
 * Ensures state has the given milestone_id.
 *
 * If milestone changes, resets budgets to zero.
 *
 * @param state - Current WorkspaceState
 * @param milestoneId - Milestone ID to ensure
 * @returns Updated state and whether milestone changed
 */
export function ensureMilestone(
  state: WorkspaceState,
  milestoneId: string
): { state: WorkspaceState; changed: boolean } {
  if (state.milestone_id === milestoneId) {
    return { state, changed: false };
  }

  // Milestone is different or null - create new state with reset budgets
  const newState: WorkspaceState = {
    milestone_id: milestoneId,
    budgets: {
      ticks: 0,
      orchestrator_calls: 0,
      builder_calls: 0,
      verify_runs: 0,
    },
    budget_warning: false,
    last_run_id: state.last_run_id,
    last_verdict: state.last_verdict,
  };

  return { state: newState, changed: true };
}

/**
 * Applies incremental budget changes to state.
 *
 * Creates new state with updated budgets (immutable update).
 *
 * @param state - Current WorkspaceState
 * @param deltas - Partial budget counts to add
 * @returns New state with updated budgets
 */
export function applyDeltas(state: WorkspaceState, deltas: BudgetDeltas): WorkspaceState {
  const newBudgets: BudgetCounts = {
    ticks: state.budgets.ticks + (deltas.ticks ?? 0),
    orchestrator_calls: state.budgets.orchestrator_calls + (deltas.orchestrator_calls ?? 0),
    builder_calls: state.budgets.builder_calls + (deltas.builder_calls ?? 0),
    verify_runs: state.budgets.verify_runs + (deltas.verify_runs ?? 0),
  };

  return {
    ...state,
    budgets: newBudgets,
  };
}

/**
 * Checks if any budget is approaching its limit.
 *
 * Returns true if any budget count >= max * warnAtFraction.
 *
 * @param state - Current WorkspaceState
 * @param perMilestone - Per-milestone budget limits
 * @param warnAtFraction - Fraction (0-1) at which to warn
 * @returns True if any budget is at warning level
 */
export function computeBudgetWarning(
  state: WorkspaceState,
  perMilestone: PerMilestoneBudgets,
  warnAtFraction: number
): boolean {
  // Check ticks
  if (state.budgets.ticks >= perMilestone.max_ticks * warnAtFraction) {
    return true;
  }

  // Check orchestrator_calls
  if (state.budgets.orchestrator_calls >= perMilestone.max_orchestrator_calls * warnAtFraction) {
    return true;
  }

  // Check builder_calls
  if (state.budgets.builder_calls >= perMilestone.max_builder_calls * warnAtFraction) {
    return true;
  }

  // Check verify_runs
  if (state.budgets.verify_runs >= perMilestone.max_verify_runs * warnAtFraction) {
    return true;
  }

  return false;
}
