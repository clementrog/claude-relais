/**
 * State management utilities for tick execution.
 *
 * Provides functions to create and update tick state during execution.
 */

import { randomBytes } from 'node:crypto';
import type { RelaisConfig } from '../types/config.js';
import { TickPhase } from '../types/state.js';
import type {
  TickState,
  GuardrailState,
  StopHistoryEntry,
  VerifyHistoryEntry,
} from '../types/state.js';

/**
 * Generates a unique run ID for a tick.
 *
 * @returns A unique identifier string
 */
export function generateRunId(): string {
  // Generate 16 random bytes and encode as hex (32 chars)
  return randomBytes(16).toString('hex');
}

/**
 * Creates initial tick state.
 *
 * @param config - Relais configuration
 * @param baseCommit - Git HEAD commit SHA at start
 * @returns Initial tick state
 */
export function createInitialState(config: RelaisConfig, baseCommit: string): TickState {
  return {
    phase: TickPhase.LOCK,
    run_id: generateRunId(),
    started_at: new Date().toISOString(),
    base_commit: baseCommit,
    config,
    task: null,
    builder_result: null,
    errors: [],
  };
}

/**
 * Transitions tick state to a new phase.
 *
 * @param state - Current tick state
 * @param newPhase - Phase to transition to
 * @returns Updated tick state
 */
export function transitionPhase(state: TickState, newPhase: TickPhase): TickState {
  return {
    ...state,
    phase: newPhase,
  };
}

/**
 * Adds an error to the tick state.
 *
 * @param state - Current tick state
 * @param error - Error message to add
 * @returns Updated tick state
 */
export function addError(state: TickState, error: string): TickState {
  return {
    ...state,
    errors: [...state.errors, error],
  };
}

/**
 * Updates task in tick state.
 *
 * @param state - Current tick state
 * @param task - Task to set
 * @returns Updated tick state
 */
export function setTask(state: TickState, task: TickState['task']): TickState {
  return {
    ...state,
    task,
  };
}

/**
 * Updates builder result in tick state.
 *
 * @param state - Current tick state
 * @param builderResult - Builder result to set
 * @returns Updated tick state
 */
export function setBuilderResult(
  state: TickState,
  builderResult: TickState['builder_result']
): TickState {
  return {
    ...state,
    builder_result: builderResult,
  };
}

/**
 * Appends a stop history entry to guardrail state, capping at 50 entries.
 *
 * @param state - Current tick state
 * @param entry - Stop history entry to add
 * @returns Updated tick state
 */
export function appendStopHistory(
  state: TickState,
  entry: StopHistoryEntry
): TickState {
  const guardrail: GuardrailState = state.guardrail ?? {
    force_patch_until_success: false,
    last_risk_flags: [],
    stop_history: [],
  };

  // Add entry and cap to 50 entries (keep most recent)
  const updatedHistory = [...guardrail.stop_history, entry].slice(-50);

  return {
    ...state,
    guardrail: {
      ...guardrail,
      stop_history: updatedHistory,
    },
  };
}

/**
 * Clears force patch flag (sets force_patch_until_success to false).
 *
 * Called when a patch succeeds to reset escalation state.
 *
 * @param state - Current tick state
 * @returns Updated tick state
 */
export function clearForcePatch(state: TickState): TickState {
  if (!state.guardrail) {
    return state;
  }

  return {
    ...state,
    guardrail: {
      ...state.guardrail,
      force_patch_until_success: false,
    },
  };
}

/**
 * Sets force patch flag (sets force_patch_until_success to true).
 *
 * Called to enable escalation mode when guardrails trigger.
 *
 * @param state - Current tick state
 * @returns Updated tick state
 */
export function setForcePatch(state: TickState): TickState {
  const guardrail: GuardrailState = state.guardrail ?? {
    force_patch_until_success: false,
    last_risk_flags: [],
    stop_history: [],
  };

  return {
    ...state,
    guardrail: {
      ...guardrail,
      force_patch_until_success: true,
    },
  };
}

/**
 * Updates the task fingerprint in tick state.
 *
 * @param state - Current tick state
 * @param fingerprint - SHA256 fingerprint of the current task
 * @returns Updated tick state
 */
export function updateTaskFingerprint(
  state: TickState,
  fingerprint: string
): TickState {
  return {
    ...state,
    task_fingerprint: fingerprint,
  };
}

/**
 * Updates failure tracking when a task fails.
 *
 * Increments failure_streak and updates last_failed_fingerprint.
 *
 * @param state - Current tick state
 * @param fingerprint - SHA256 fingerprint of the failed task
 * @returns Updated tick state
 */
export function recordTaskFailure(
  state: TickState,
  fingerprint: string
): TickState {
  return {
    ...state,
    last_failed_fingerprint: fingerprint,
    failure_streak: (state.failure_streak ?? 0) + 1,
  };
}

/**
 * Resets failure streak when a task succeeds.
 *
 * @param state - Current tick state
 * @returns Updated tick state
 */
export function resetFailureStreak(state: TickState): TickState {
  return {
    ...state,
    failure_streak: 0,
  };
}

/**
 * Appends a verify history entry, capping at 50 entries.
 *
 * @param state - Current tick state
 * @param entry - Verify history entry to add
 * @returns Updated tick state
 */
export function appendVerifyHistory(
  state: TickState,
  entry: VerifyHistoryEntry
): TickState {
  const currentHistory = state.verify_history ?? [];
  // Add entry and cap to 50 entries (keep most recent)
  const updatedHistory = [...currentHistory, entry].slice(-50);

  return {
    ...state,
    verify_history: updatedHistory,
  };
}

/**
 * Increments the retry count for transport stall recovery.
 *
 * @param state - Current tick state
 * @returns Updated tick state with incremented retry_count
 */
export function incrementRetryCount(state: TickState): TickState {
  return {
    ...state,
    retry_count: (state.retry_count ?? 0) + 1,
  };
}

/**
 * Records a transport stall error in state.
 *
 * Used to track the last error kind and request ID for debugging
 * and retry policy decisions.
 *
 * @param state - Current tick state
 * @param errorKind - Kind of error (e.g., 'transport_stalled')
 * @param requestId - Request ID from the stall (for debugging)
 * @returns Updated tick state
 */
export function recordTransportStall(
  state: TickState,
  errorKind: string,
  requestId: string | null
): TickState {
  return {
    ...state,
    last_error_kind: errorKind,
    last_request_id: requestId,
    retry_count: (state.retry_count ?? 0) + 1,
  };
}

/**
 * Resets retry state after a successful tick.
 *
 * Clears retry_count, last_error_kind, and last_request_id.
 * Called when a tick completes successfully to reset recovery state.
 *
 * @param state - Current tick state
 * @returns Updated tick state with cleared retry fields
 */
export function resetRetryState(state: TickState): TickState {
  return {
    ...state,
    retry_count: 0,
    last_error_kind: undefined,
    last_request_id: undefined,
  };
}
