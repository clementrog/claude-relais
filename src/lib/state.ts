/**
 * State management utilities for tick execution.
 *
 * Provides functions to create and update tick state during execution.
 */

import { randomBytes } from 'node:crypto';
import type { RelaisConfig } from '../types/config.js';
import { TickPhase } from '../types/state.js';
import type { TickState } from '../types/state.js';

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
