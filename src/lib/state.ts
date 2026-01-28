/**
 * State management utilities for tick execution.
 *
 * Provides functions to create and update tick state during execution.
 */

import { randomBytes } from 'node:crypto';
import type { RelaisConfig } from '../types/config.js';
import { TickPhase } from '../types/state.js';
import type { TickState, GuardrailState, StopHistoryEntry } from '../types/state.js';

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
