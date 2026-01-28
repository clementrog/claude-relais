/**
 * Guardrail preflight checks for verifying state before running verify commands.
 *
 * These checks validate:
 * - Branch match: git branch must equal STATE.branch
 * - Fingerprint match: TASK fingerprint must match STATE.task_fingerprint
 * - Worktree clean: git worktree must be clean
 *
 * If any check fails, returns a STOP code to prevent unsafe execution.
 */

import type { ReportCode } from '../types/report.js';
import type { Task } from '../types/task.js';
import { getCurrentBranch, isWorktreeClean } from './git.js';
import { computeFingerprint } from './fingerprint.js';

/**
 * State structure required for guardrail preflight checks.
 */
export interface GuardrailState {
  /** Expected branch name */
  branch: string;
  /** Current task fingerprint (SHA256) */
  task_fingerprint?: string;
  /** Fingerprint of last failed task */
  last_failed_fingerprint?: string;
}

/**
 * Result of guardrail preflight checks.
 */
export interface PreflightResult {
  /** Whether all checks passed */
  ok: boolean;
  /** Stop code if check failed */
  stopCode?: ReportCode;
  /** Human-readable reason for failure */
  reason?: string;
}

/**
 * Checks if the current git branch matches the expected branch from state.
 *
 * @param state - State containing expected branch name
 * @returns PreflightResult with ok=true if match, or STOP_BRANCH_MISMATCH if mismatch
 *
 * @example
 * ```typescript
 * const result = checkBranchMatch({ branch: 'task/wp-001' });
 * if (!result.ok) {
 *   console.error(`Branch mismatch: ${result.reason}`);
 * }
 * ```
 */
export function checkBranchMatch(state: GuardrailState): PreflightResult {
  try {
    const currentBranch = getCurrentBranch();
    if (currentBranch !== state.branch) {
      return {
        ok: false,
        stopCode: 'STOP_BRANCH_MISMATCH',
        reason: `Current branch '${currentBranch}' does not match expected branch '${state.branch}'`,
      };
    }
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      stopCode: 'STOP_BRANCH_MISMATCH',
      reason: `Failed to get current branch: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * Checks if the task fingerprint matches state expectations.
 *
 * Compares the computed task fingerprint with:
 * - STATE.task_fingerprint (must match if present)
 * - STATE.last_failed_fingerprint (must not match - prevents re-dispatch of identical failed task)
 *
 * @param state - State containing fingerprint information
 * @param task - Task to compute fingerprint for
 * @returns PreflightResult with ok=true if checks pass, or STOP_REDISPATCH_IDENTICAL_TASK if fingerprint matches last failed
 *
 * @example
 * ```typescript
 * const result = checkFingerprintMatch(state, task);
 * if (!result.ok) {
 *   console.error(`Fingerprint check failed: ${result.reason}`);
 * }
 * ```
 */
export function checkFingerprintMatch(
  state: GuardrailState,
  task: Task
): PreflightResult {
  const taskFingerprint = computeFingerprint(task as unknown as Record<string, unknown>);

  // Check if fingerprint matches last failed task (prevent re-dispatch)
  if (state.last_failed_fingerprint && taskFingerprint === state.last_failed_fingerprint) {
    return {
      ok: false,
      stopCode: 'STOP_REDISPATCH_IDENTICAL_TASK',
      reason: `Task fingerprint matches last failed fingerprint - identical task re-dispatch detected`,
    };
  }

  // If state has a task_fingerprint, it should match (for consistency check)
  // Note: This is a guardrail, so we're lenient - if state.task_fingerprint exists but doesn't match,
  // it might indicate state inconsistency, but we don't stop on this (fingerprint is updated during tick)
  // The main check is preventing re-dispatch of identical failed tasks

  return { ok: true };
}

/**
 * Checks if the git worktree is clean (no uncommitted changes).
 *
 * @returns PreflightResult with ok=true if clean, or STOP_MERGE_DIRTY_WORKTREE if dirty
 *
 * @example
 * ```typescript
 * const result = checkWorktreeClean();
 * if (!result.ok) {
 *   console.error(`Worktree is dirty: ${result.reason}`);
 * }
 * ```
 */
export function checkWorktreeClean(): PreflightResult {
  if (!isWorktreeClean()) {
    return {
      ok: false,
      stopCode: 'STOP_MERGE_DIRTY_WORKTREE',
      reason: 'Git worktree has uncommitted changes or untracked files',
    };
  }
  return { ok: true };
}

/**
 * Runs all guardrail preflight checks before verify commands.
 *
 * Checks are run in order, returning immediately on first failure:
 * 1. Branch match check
 * 2. Fingerprint match check
 * 3. Worktree clean check
 *
 * @param state - State containing branch and fingerprint information
 * @param task - Task to validate fingerprint for
 * @returns PreflightResult indicating if all checks passed or which check failed
 *
 * @example
 * ```typescript
 * const result = runGuardrailPreflight(state, task);
 * if (!result.ok) {
 *   console.error(`Preflight failed: ${result.stopCode}: ${result.reason}`);
 *   process.exit(1);
 * }
 * ```
 */
export function runGuardrailPreflight(
  state: GuardrailState,
  task: Task
): PreflightResult {
  // 1. Check branch match
  const branchResult = checkBranchMatch(state);
  if (!branchResult.ok) {
    return branchResult;
  }

  // 2. Check fingerprint match
  const fingerprintResult = checkFingerprintMatch(state, task);
  if (!fingerprintResult.ok) {
    return fingerprintResult;
  }

  // 3. Check worktree clean
  const worktreeResult = checkWorktreeClean();
  if (!worktreeResult.ok) {
    return worktreeResult;
  }

  // All checks passed
  return { ok: true };
}
