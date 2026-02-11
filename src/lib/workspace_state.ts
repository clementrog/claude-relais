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
import type {
  WorkspaceState,
  BudgetCounts,
  BudgetDeltas,
  IdeaInboxEntry,
  IdeaStatus,
  IdeaTestabilityNeed,
  ProductQuestion,
} from '../types/workspace_state.js';
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
    idea_inbox: [],
    planning_digest: null,
    open_product_questions: [],
  };
}

/**
 * Runtime shape guard for idea status values.
 */
function isIdeaStatus(value: unknown): value is IdeaStatus {
  return value === 'new' || value === 'triaged' || value === 'scheduled' || value === 'deferred' || value === 'done';
}

/**
 * Runtime shape guard for idea testability values.
 */
function isIdeaTestabilityNeed(value: unknown): value is IdeaTestabilityNeed {
  return value === 'soon' || value === 'later' || value === 'unknown';
}

function normalizeIdeaInboxEntry(value: unknown): IdeaInboxEntry | null {
  if (typeof value !== 'object' || value === null) return null;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.id !== 'string' || candidate.id.length === 0) return null;
  if (typeof candidate.text !== 'string' || candidate.text.length === 0) return null;
  if (typeof candidate.submitted_at !== 'string' || candidate.submitted_at.length === 0) return null;
  if (candidate.source !== 'interactive' && candidate.source !== 'cli' && candidate.source !== 'api') return null;
  if (!isIdeaStatus(candidate.status)) return null;

  return {
    id: candidate.id,
    text: candidate.text,
    submitted_at: candidate.submitted_at,
    source: candidate.source,
    status: candidate.status,
    target_by: typeof candidate.target_by === 'string' ? candidate.target_by : null,
    testability_need: isIdeaTestabilityNeed(candidate.testability_need) ? candidate.testability_need : undefined,
    triaged_by_task_id:
      typeof candidate.triaged_by_task_id === 'string' ? candidate.triaged_by_task_id : undefined,
    triaged_at: typeof candidate.triaged_at === 'string' ? candidate.triaged_at : undefined,
  };
}

function normalizeOpenProductQuestion(value: unknown): ProductQuestion | null {
  if (typeof value !== 'object' || value === null) return null;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.id !== 'string' || candidate.id.length === 0) return null;
  if (typeof candidate.prompt !== 'string' || candidate.prompt.length === 0) return null;
  if (typeof candidate.created_at !== 'string' || candidate.created_at.length === 0) return null;
  if (typeof candidate.resolved !== 'boolean') return null;
  const choices = Array.isArray(candidate.choices)
    ? candidate.choices.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0)
    : undefined;

  return {
    id: candidate.id,
    prompt: candidate.prompt,
    choices,
    created_at: candidate.created_at,
    resolved: candidate.resolved,
    resolved_at: typeof candidate.resolved_at === 'string' ? candidate.resolved_at : undefined,
    resolution: typeof candidate.resolution === 'string' ? candidate.resolution : undefined,
  };
}

/**
 * Normalizes persisted state to include optional modern planning fields while
 * preserving legacy fields present in older STATE.json files.
 */
function normalizeWorkspaceState(rawState: WorkspaceState): WorkspaceState {
  const source = rawState as WorkspaceState & Record<string, unknown>;
  const ideaInbox = Array.isArray(source.idea_inbox)
    ? source.idea_inbox
        .map((entry) => normalizeIdeaInboxEntry(entry))
        .filter((entry): entry is IdeaInboxEntry => entry !== null)
    : [];

  const openQuestions = Array.isArray(source.open_product_questions)
    ? source.open_product_questions
        .map((entry) => normalizeOpenProductQuestion(entry))
        .filter((entry): entry is ProductQuestion => entry !== null)
    : [];

  const planningDigestRaw = source.planning_digest as unknown;
  const planningDigest =
    typeof planningDigestRaw === 'object' &&
    planningDigestRaw !== null &&
    typeof (planningDigestRaw as Record<string, unknown>).updated_at === 'string' &&
    typeof (planningDigestRaw as Record<string, unknown>).summary === 'string'
      ? {
          updated_at: String((planningDigestRaw as Record<string, unknown>).updated_at),
          summary: String((planningDigestRaw as Record<string, unknown>).summary),
          last_task_id:
            typeof (planningDigestRaw as Record<string, unknown>).last_task_id === 'string'
              ? String((planningDigestRaw as Record<string, unknown>).last_task_id)
              : undefined,
          suggested_milestone:
            typeof (planningDigestRaw as Record<string, unknown>).suggested_milestone === 'string'
              ? String((planningDigestRaw as Record<string, unknown>).suggested_milestone)
              : undefined,
        }
      : null;

  return {
    ...source,
    idea_inbox: ideaInbox,
    planning_digest: planningDigest,
    open_product_questions: openQuestions,
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
      return normalizeWorkspaceState(state);
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
    ...state,
    milestone_id: milestoneId,
    budgets: {
      ticks: 0,
      orchestrator_calls: 0,
      builder_calls: 0,
      verify_runs: 0,
    },
    budget_warning: false,
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

export interface NewIdeaInput {
  text: string;
  source: 'interactive' | 'cli' | 'api';
  target_by?: string | null;
  testability_need?: IdeaTestabilityNeed;
}

/**
 * Appends a new idea entry to workspace state.
 */
export function appendIdeaEntry(state: WorkspaceState, input: NewIdeaInput): WorkspaceState {
  const trimmedText = input.text.trim();
  if (!trimmedText) return state;

  const now = new Date().toISOString();
  const nextId = `idea-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const entry: IdeaInboxEntry = {
    id: nextId,
    text: trimmedText,
    submitted_at: now,
    source: input.source,
    status: 'new',
    target_by: input.target_by ?? null,
    testability_need: input.testability_need ?? 'unknown',
  };

  const inbox = [...(state.idea_inbox ?? []), entry];
  return {
    ...state,
    idea_inbox: inbox,
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
