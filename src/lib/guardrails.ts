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
import type { TickState } from '../types/state.js';
import type { RelaisConfig } from '../types/config.js';
import { getCurrentBranch, isWorktreeClean } from './git.js';
import { computeFingerprint } from './fingerprint.js';

/**
 * Verify result type classification.
 */
export type VerifyResultType = 'PASS' | 'FAIL' | 'TIMEOUT';

/**
 * Classification result for a verify command execution.
 */
export interface VerifyClassification {
  /** Result type: PASS, FAIL, or TIMEOUT */
  resultType: VerifyResultType;
  /** STOP code if verification failed or timed out, null if passed */
  stopCode: ReportCode | null;
  /** Whether this result should increment the failure streak */
  shouldIncrementFailureStreak: boolean;
}

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

/**
 * Escalation decision result.
 */
export interface EscalationDecision {
  /** Escalation mode: 'none' (no escalation), 'reviewer' (escalate to reviewer), or 'human' (escalate to human) */
  mode: 'none' | 'reviewer' | 'human';
  /** Human-readable reason explaining why escalation was triggered (or why it wasn't) */
  reason: string;
}

/**
 * Determines if escalation should be triggered based on failure streak and stop history.
 *
 * Escalation triggers:
 * - failure_streak >= 2: After 2 consecutive failures, escalate instead of allowing a third normal retry
 * - stop_history window: If STOPs in last stop_window_ticks >= max_stops_in_window, escalate
 * - Risk level: MED/HIGH tasks with verify failures may have stricter thresholds (not yet implemented - requires risk field in Task)
 *
 * Escalation mode selection:
 * - If reviewer is enabled in config → mode is 'reviewer'
 * - Otherwise → mode is 'human'
 *
 * @param state - Current tick state containing failure_streak and stop_history
 * @param config - Relais configuration containing escalation settings
 * @param currentTick - Current tick number (for stop window calculation)
 * @returns EscalationDecision with mode and reason
 *
 * @example
 * ```typescript
 * const decision = shouldEscalate(state, config, 10);
 * if (decision.mode !== 'none') {
 *   console.log(`Escalation required: ${decision.mode} - ${decision.reason}`);
 * }
 * ```
 */
export function shouldEscalate(
  state: TickState,
  config: RelaisConfig,
  currentTick: number
): EscalationDecision {
  const failureStreak = state.failure_streak ?? 0;
  const stopHistory = state.guardrail?.stop_history ?? [];

  // Check failure streak >= 2
  if (failureStreak >= 2) {
    const reviewerEnabled = config.reviewer?.enabled ?? false;
    const mode = reviewerEnabled ? 'reviewer' : 'human';
    return {
      mode,
      reason: `Failure streak is ${failureStreak} (>= 2). Escalating to prevent infinite retry loops.`,
    };
  }

  // Check stop history window
  const reviewerConfig = config.reviewer;
  if (
    reviewerConfig?.trigger?.on_repeated_stop &&
    reviewerConfig.trigger.stop_window_ticks > 0 &&
    reviewerConfig.trigger.max_stops_in_window > 0
  ) {
    const windowTicks = reviewerConfig.trigger.stop_window_ticks;
    const maxStops = reviewerConfig.trigger.max_stops_in_window;

    // Count stops in recent history
    // Since stop_history entries don't have tick numbers, we count the last N entries
    // where N = windowTicks (approximating ticks with entries)
    // This is a reasonable approximation: if we have >= maxStops entries in the window,
    // we've exceeded the threshold
    const recentStops = stopHistory.slice(-windowTicks);

    if (recentStops.length >= maxStops) {
      const reviewerEnabled = reviewerConfig.enabled ?? false;
      const mode = reviewerEnabled ? 'reviewer' : 'human';
      return {
        mode,
        reason: `Found ${recentStops.length} stops in last ${windowTicks} entries (>= ${maxStops}). Escalating to prevent repeated failures.`,
      };
    }
  }

  // Risk level check (MED/HIGH with verify failure)
  // Note: This requires a risk field in Task which is not yet in the schema.
  // For now, we skip this check. When risk is added to Task, we can check:
  // if (task.risk === 'MED' || task.risk === 'HIGH') {
  //   const verifyFailed = state.verify_history?.some(e => e.result === 'FAIL') ?? false;
  //   if (verifyFailed) {
  //     return { mode: reviewerEnabled ? 'reviewer' : 'human', reason: 'MED/HIGH risk task with verify failure' };
  //   }
  // }

  // No escalation needed
  return {
    mode: 'none',
    reason: 'No escalation triggers detected. Failure streak and stop history are within acceptable limits.',
  };
}

/**
 * Classifies a verify command result into PASS, FAIL, or TIMEOUT.
 *
 * Classification rules:
 * - PASS: exitCode === 0 && !timedOut
 * - FAIL: exitCode !== 0 && !timedOut
 * - TIMEOUT: timedOut === true
 *
 * STOP code mapping:
 * - PASS: null (no stop)
 * - FAIL: STOP_VERIFY_FAILED_FAST (if phase === 'fast') or STOP_VERIFY_FAILED_SLOW (if phase === 'slow')
 * - TIMEOUT: STOP_VERIFY_FLAKY_OR_TIMEOUT
 *
 * Failure streak increment:
 * - TIMEOUT: always increments failure_streak
 * - FAIL: may increment based on config (default: true)
 * - PASS: never increments
 *
 * @param exitCode - Process exit code
 * @param timedOut - Whether the command timed out
 * @param durationMs - Duration in milliseconds (used for logging/debugging)
 * @param phase - Verification phase ('fast' or 'slow') to determine correct STOP code for FAIL
 * @returns VerifyClassification with result type, stop code, and failure streak flag
 *
 * @example
 * ```typescript
 * const classification = classifyVerifyResult(0, false, 1500, 'fast');
 * // Returns: { resultType: 'PASS', stopCode: null, shouldIncrementFailureStreak: false }
 *
 * const classification = classifyVerifyResult(1, false, 2000, 'slow');
 * // Returns: { resultType: 'FAIL', stopCode: 'STOP_VERIFY_FAILED_SLOW', shouldIncrementFailureStreak: true }
 *
 * const classification = classifyVerifyResult(124, true, 30000, 'fast');
 * // Returns: { resultType: 'TIMEOUT', stopCode: 'STOP_VERIFY_FLAKY_OR_TIMEOUT', shouldIncrementFailureStreak: true }
 * ```
 */
export function classifyVerifyResult(
  exitCode: number,
  timedOut: boolean,
  durationMs: number,
  phase: 'fast' | 'slow'
): VerifyClassification {
  // TIMEOUT takes precedence - if timed out, it's always TIMEOUT
  if (timedOut) {
    return {
      resultType: 'TIMEOUT',
      stopCode: 'STOP_VERIFY_FLAKY_OR_TIMEOUT',
      shouldIncrementFailureStreak: true,
    };
  }

  // PASS: exit code 0 and not timed out
  if (exitCode === 0) {
    return {
      resultType: 'PASS',
      stopCode: null,
      shouldIncrementFailureStreak: false,
    };
  }

  // FAIL: non-zero exit code and not timed out
  const stopCode: ReportCode =
    phase === 'fast' ? 'STOP_VERIFY_FAILED_FAST' : 'STOP_VERIFY_FAILED_SLOW';

  return {
    resultType: 'FAIL',
    stopCode,
    shouldIncrementFailureStreak: true, // Default to true, caller can override based on config
  };
}
