/**
 * Tick runner with transport stall handling.
 *
 * Provides functions to handle transport stalls during ORCHESTRATE or BUILD phases.
 * When a stall is detected:
 * 1. Check if repo is dirty
 * 2. Rollback if needed
 * 3. Return BLOCKED_TRANSPORT_STALLED with evidence
 */

import type { TransportStallError, TransportStallStage } from '../types/preflight.js';
import type { RollbackResultNew } from './rollback.js';
import { rollbackToCommit, verifyCleanWorktree } from './rollback.js';
import { isWorktreeClean, getHeadCommit } from './git.js';

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
