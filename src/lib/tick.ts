/**
 * Tick runner with transport stall handling and retry policy.
 *
 * Provides functions to handle transport stalls during ORCHESTRATE or BUILD phases.
 * When a stall is detected:
 * 1. Check if repo is dirty
 * 2. Rollback if needed
 * 3. Return BLOCKED_TRANSPORT_STALLED with evidence
 *
 * Retry policy (M21):
 * - Attempt 1: Retry same task unchanged
 * - Attempt 2: Retry with degraded settings
 * - Attempt 3+: Block and require human action
 */

import type { TransportStallError, TransportStallStage } from '../types/preflight.js';
import type { RollbackResultNew } from './rollback.js';
import type { DiffLimits } from '../types/task.js';
import type { RelaisConfig } from '../types/config.js';
import { rollbackToCommit, verifyCleanWorktree } from './rollback.js';
import { isWorktreeClean, getHeadCommit } from './git.js';

/**
 * Maximum retry attempts before blocking.
 */
export const MAX_RETRY_ATTEMPTS = 3;

/**
 * Action to take based on retry count.
 */
export type RetryAction = 'retry_unchanged' | 'retry_degraded' | 'block';

/**
 * Degraded settings applied on retry attempt 2.
 */
export interface DegradedSettings {
  /** Reduced max_turns for builder (50% of original, minimum 5) */
  max_turns: number;
  /** Stricter diff limits (50% of original) */
  diff_limits: DiffLimits;
  /** Prefer patch mode if available */
  prefer_patch_mode: boolean;
}

/**
 * Result of computing retry action.
 */
export interface RetryDecision {
  /** The action to take */
  action: RetryAction;
  /** Current retry count (after this attempt) */
  retry_count: number;
  /** Degraded settings if action is 'retry_degraded' */
  degraded_settings?: DegradedSettings;
  /** Human-readable reason for the decision */
  reason: string;
}

/**
 * Computes the retry action based on the current retry count.
 *
 * Retry policy:
 * - retry_count 0 or 1 → retry_unchanged (first failure, try again)
 * - retry_count 2 → retry_degraded (second failure, use safer settings)
 * - retry_count >= 3 → block (third failure, require human)
 *
 * @param retryCount - Current retry count from state (before this attempt)
 * @returns The action to take
 */
export function getRetryAction(retryCount: number): RetryAction {
  if (retryCount < 1) {
    return 'retry_unchanged';
  } else if (retryCount < 2) {
    return 'retry_degraded';
  } else {
    return 'block';
  }
}

/**
 * Computes the full retry decision including degraded settings if needed.
 *
 * @param retryCount - Current retry count from state
 * @param originalMaxTurns - Original max_turns from config (default 50)
 * @param originalDiffLimits - Original diff limits from config
 * @returns Full retry decision with settings and reason
 */
export function computeRetryDecision(
  retryCount: number,
  originalMaxTurns: number = 50,
  originalDiffLimits: DiffLimits = { max_files_touched: 20, max_lines_changed: 500 }
): RetryDecision {
  const action = getRetryAction(retryCount);
  const newRetryCount = retryCount + 1;

  if (action === 'retry_unchanged') {
    return {
      action,
      retry_count: newRetryCount,
      reason: `Retry attempt ${newRetryCount}/${MAX_RETRY_ATTEMPTS}: retrying unchanged`,
    };
  }

  if (action === 'retry_degraded') {
    const degraded_settings = computeDegradedSettings(originalMaxTurns, originalDiffLimits);
    return {
      action,
      retry_count: newRetryCount,
      degraded_settings,
      reason: `Retry attempt ${newRetryCount}/${MAX_RETRY_ATTEMPTS}: retrying with degraded settings (max_turns=${degraded_settings.max_turns}, max_files=${degraded_settings.diff_limits.max_files_touched}, max_lines=${degraded_settings.diff_limits.max_lines_changed})`,
    };
  }

  // action === 'block'
  return {
    action,
    retry_count: newRetryCount,
    reason: `Retry limit reached (${MAX_RETRY_ATTEMPTS} attempts). Blocking for human intervention.`,
  };
}

/**
 * Computes degraded settings for retry attempt 2.
 *
 * Applies conservative reductions:
 * - max_turns: 50% of original, minimum 5
 * - max_files_touched: 50% of original, minimum 5
 * - max_lines_changed: 50% of original, minimum 100
 * - prefer_patch_mode: true
 *
 * @param originalMaxTurns - Original max_turns from config
 * @param originalDiffLimits - Original diff limits from config
 * @returns Degraded settings
 */
export function computeDegradedSettings(
  originalMaxTurns: number,
  originalDiffLimits: DiffLimits
): DegradedSettings {
  return {
    max_turns: Math.max(5, Math.floor(originalMaxTurns / 2)),
    diff_limits: {
      max_files_touched: Math.max(5, Math.floor(originalDiffLimits.max_files_touched / 2)),
      max_lines_changed: Math.max(100, Math.floor(originalDiffLimits.max_lines_changed / 2)),
    },
    prefer_patch_mode: true,
  };
}

/**
 * Checks if retry is allowed based on current retry count.
 *
 * @param retryCount - Current retry count
 * @returns true if retry is allowed, false if blocked
 */
export function canRetry(retryCount: number): boolean {
  return retryCount < MAX_RETRY_ATTEMPTS - 1;
}

/**
 * Formats retry decision as human-readable message.
 *
 * @param decision - The retry decision
 * @returns Formatted message
 */
export function formatRetryDecision(decision: RetryDecision): string {
  const lines = [decision.reason];

  if (decision.degraded_settings) {
    lines.push('Degraded settings:');
    lines.push(`  - max_turns: ${decision.degraded_settings.max_turns}`);
    lines.push(`  - max_files: ${decision.degraded_settings.diff_limits.max_files_touched}`);
    lines.push(`  - max_lines: ${decision.degraded_settings.diff_limits.max_lines_changed}`);
    lines.push(`  - patch_mode: ${decision.degraded_settings.prefer_patch_mode}`);
  }

  if (decision.action === 'block') {
    lines.push('');
    lines.push('Human action required: Review logs, fix issues, then reset retry state.');
  }

  return lines.join('\n');
}

/**
 * Applies degraded settings to a RelaisConfig.
 *
 * Used during retry attempt 2 to run with more conservative settings.
 * Creates a new config object without mutating the original.
 *
 * Settings applied:
 * - builder.claude_code.max_turns: reduced to degraded value
 * - diff_limits.default_max_files_touched: reduced to degraded value
 * - diff_limits.default_max_lines_changed: reduced to degraded value
 * - builder.default_mode: set to 'patch' if allow_patch_mode is true and prefer_patch_mode is set
 *
 * @param config - Original RelaisConfig
 * @param degraded - Degraded settings to apply
 * @returns New config with degraded settings applied
 */
export function applyDegradedConfig(
  config: RelaisConfig,
  degraded: DegradedSettings
): RelaisConfig {
  return {
    ...config,
    builder: {
      ...config.builder,
      // Prefer patch mode if available and degraded settings request it
      default_mode:
        degraded.prefer_patch_mode && config.builder.allow_patch_mode
          ? 'patch'
          : config.builder.default_mode,
      claude_code: {
        ...config.builder.claude_code,
        max_turns: degraded.max_turns,
      },
    },
    diff_limits: {
      ...config.diff_limits,
      default_max_files_touched: degraded.diff_limits.max_files_touched,
      default_max_lines_changed: degraded.diff_limits.max_lines_changed,
    },
  };
}

/**
 * Extracts relevant settings from config for computing degraded settings.
 *
 * @param config - RelaisConfig to extract from
 * @returns Object with max_turns and diff_limits for degradation computation
 */
export function extractDegradationInputs(config: RelaisConfig): {
  max_turns: number;
  diff_limits: DiffLimits;
} {
  return {
    max_turns: config.builder.claude_code.max_turns,
    diff_limits: {
      max_files_touched: config.diff_limits.default_max_files_touched,
      max_lines_changed: config.diff_limits.default_max_lines_changed,
    },
  };
}

/**
 * Convenience function to degrade a config based on retry count.
 *
 * If retry action is 'retry_degraded', applies degraded settings to config.
 * Otherwise, returns the original config unchanged.
 *
 * @param config - Original config
 * @param retryCount - Current retry count
 * @returns Degraded config if appropriate, original config otherwise
 */
export function getDegradedConfigIfNeeded(
  config: RelaisConfig,
  retryCount: number
): RelaisConfig {
  const action = getRetryAction(retryCount);

  if (action !== 'retry_degraded') {
    return config;
  }

  const inputs = extractDegradationInputs(config);
  const degraded = computeDegradedSettings(inputs.max_turns, inputs.diff_limits);
  return applyDegradedConfig(config, degraded);
}

/**
 * Result of handling a transport stall.
 */
export interface StallHandlingResult {
  /** Always 'BLOCKED' for stall handling */
  status: 'BLOCKED';
  /** The blocked code */
  blockedCode: 'BLOCKED_TRANSPORT_STALLED';
  /** The stage where the stall occurred */
  stage: TransportStallStage;
  /** Request ID if available */
  requestId: string | null;
  /** Raw error message */
  rawError: string;
  /** Whether rollback was performed */
  rollbackPerformed: boolean;
  /** Rollback result if performed */
  rollbackResult: RollbackResultNew | null;
  /** Whether repo was dirty before rollback */
  wasDirty: boolean;
  /** Base commit used for rollback */
  baseCommit: string;
}

/**
 * Options for stall handling.
 */
export interface StallHandlingOptions {
  /** Skip rollback (for testing) */
  skipRollback?: boolean;
}

/**
 * Handles a transport stall during tick execution.
 *
 * When a stall is detected:
 * 1. Checks if the git worktree is dirty
 * 2. If dirty, rolls back to the base commit
 * 3. Returns a BLOCKED result with stall evidence
 *
 * @param stallError - The structured stall error
 * @param baseCommit - The commit to rollback to if needed
 * @param options - Optional handling options
 * @returns StallHandlingResult with rollback status and stall evidence
 *
 * @example
 * ```typescript
 * const result = await invokeWithStallDetection(config, invocation, 'BUILD');
 * if (!result.ok) {
 *   const stallResult = await handleTransportStall(result.error, baseCommit);
 *   // stallResult.blockedCode === 'BLOCKED_TRANSPORT_STALLED'
 * }
 * ```
 */
export async function handleTransportStall(
  stallError: TransportStallError,
  baseCommit: string,
  options: StallHandlingOptions = {}
): Promise<StallHandlingResult> {
  // Check if worktree is dirty
  const cleanCheck = isWorktreeClean();
  const wasDirty = !cleanCheck;

  let rollbackPerformed = false;
  let rollbackResult: RollbackResultNew | null = null;

  // If dirty and rollback not skipped, perform rollback
  if (wasDirty && !options.skipRollback) {
    rollbackResult = rollbackToCommit(baseCommit);
    rollbackPerformed = rollbackResult.ok;
  }

  return {
    status: 'BLOCKED',
    blockedCode: 'BLOCKED_TRANSPORT_STALLED',
    stage: stallError.stage,
    requestId: stallError.request_id,
    rawError: stallError.raw_error,
    rollbackPerformed,
    rollbackResult,
    wasDirty,
    baseCommit,
  };
}

/**
 * Checks if a stall occurred and handles it if so.
 *
 * This is a convenience wrapper that combines stall detection with handling.
 *
 * @param error - Any error that might be a stall
 * @param stage - The stage where the error occurred
 * @param baseCommit - The commit to rollback to if needed
 * @param options - Optional handling options
 * @returns StallHandlingResult if stall detected, null otherwise
 */
export async function checkAndHandleStall(
  stallError: TransportStallError | null,
  baseCommit: string,
  options: StallHandlingOptions = {}
): Promise<StallHandlingResult | null> {
  if (!stallError) {
    return null;
  }

  return handleTransportStall(stallError, baseCommit, options);
}

/**
 * Creates a human-readable message for a stall handling result.
 *
 * @param result - The stall handling result
 * @returns Formatted message string
 */
export function formatStallResult(result: StallHandlingResult): string {
  const lines: string[] = [
    `Transport stall detected during ${result.stage}`,
    `Status: ${result.blockedCode}`,
  ];

  if (result.requestId) {
    lines.push(`Request ID: ${result.requestId}`);
  }

  if (result.wasDirty) {
    if (result.rollbackPerformed) {
      lines.push(`Rollback: performed to ${result.baseCommit.substring(0, 7)}`);
    } else {
      lines.push(`Rollback: skipped (repo was dirty)`);
    }
  } else {
    lines.push(`Rollback: not needed (repo was clean)`);
  }

  lines.push(`Error: ${result.rawError.substring(0, 100)}${result.rawError.length > 100 ? '...' : ''}`);

  return lines.join('\n');
}
