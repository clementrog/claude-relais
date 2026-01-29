/**
 * Transport layer utilities for Claude invocations.
 *
 * Provides stall detection and timeout wrapper for reliable
 * handling of connection issues, timeouts, and transport failures.
 */

import type { ClaudeCodeCliConfig } from '../types/config.js';
import type { ClaudeInvocation, ClaudeResponse } from '../types/claude.js';
import { ClaudeError } from '../types/claude.js';
import type { TransportStallError, TransportStallStage } from '../types/preflight.js';
import { invokeClaudeCode } from './claude.js';

/**
 * Maximum length for raw_error in TransportStallError.
 * Truncates error messages to prevent excessive memory usage.
 */
const MAX_RAW_ERROR_LENGTH = 500;

/**
 * Patterns that indicate a transport stall.
 */
const STALL_PATTERNS = [
  'Connection stalled',
  'streamFromAgentBackend',
  'ECONNRESET',
  'ETIMEDOUT',
  'socket hang up',
] as const;

/**
 * Result of stall pattern detection.
 */
export interface StallDetectionResult {
  /** Whether a stall pattern was detected */
  stalled: boolean;
  /** Request ID if found in error output */
  request_id: string | null;
  /** Which pattern was matched, if any */
  matched_pattern: string | null;
}

/**
 * Detects transport stall patterns in error output.
 *
 * Checks for known patterns that indicate connection issues:
 * - "Connection stalled" - Cursor/CLI connection issue
 * - "streamFromAgentBackend" - Backend stream failure
 * - "ECONNRESET" - Connection reset by peer
 * - "ETIMEDOUT" - Connection timeout
 * - "socket hang up" - Socket disconnection
 *
 * Also extracts Request ID if present for debugging.
 *
 * @param error - Error message or stderr output to analyze
 * @returns Detection result with stalled flag and optional request_id
 *
 * @example
 * ```typescript
 * const result = isTransportStall('Connection stalled. Request ID: abc123');
 * // result.stalled === true
 * // result.request_id === 'abc123'
 * ```
 */
export function isTransportStall(error: string): StallDetectionResult {
  if (!error) {
    return { stalled: false, request_id: null, matched_pattern: null };
  }

  // Check for stall patterns
  let matchedPattern: string | null = null;
  for (const pattern of STALL_PATTERNS) {
    if (error.includes(pattern)) {
      matchedPattern = pattern;
      break;
    }
  }

  // Extract Request ID if present
  // Common formats: "Request ID: xxx", "request_id: xxx", "requestId: xxx"
  let requestId: string | null = null;
  const requestIdMatch = error.match(/[Rr]equest[_\s]?[Ii][Dd][:\s]+([a-zA-Z0-9_-]+)/);
  if (requestIdMatch) {
    requestId = requestIdMatch[1];
  }

  return {
    stalled: matchedPattern !== null,
    request_id: requestId,
    matched_pattern: matchedPattern,
  };
}

/**
 * Creates a TransportStallError from error information.
 *
 * @param stage - The stage where the stall occurred (ORCHESTRATE or BUILD)
 * @param rawError - The raw error message
 * @param requestId - Optional request ID extracted from error
 * @returns Structured TransportStallError
 */
export function createTransportStallError(
  stage: TransportStallStage,
  rawError: string,
  requestId: string | null = null
): TransportStallError {
  // Truncate raw_error to prevent excessive length
  const truncatedError =
    rawError.length > MAX_RAW_ERROR_LENGTH
      ? rawError.substring(0, MAX_RAW_ERROR_LENGTH) + '...'
      : rawError;

  return {
    kind: 'transport_stalled',
    stage,
    request_id: requestId,
    raw_error: truncatedError,
  };
}

/**
 * Result type for invokeWithStallDetection.
 * Either a successful ClaudeResponse or a TransportStallError.
 */
export type InvokeResult =
  | { ok: true; response: ClaudeResponse }
  | { ok: false; error: TransportStallError };

/**
 * Invokes Claude Code CLI with stall detection.
 *
 * Wraps the standard invokeClaudeCode function and:
 * 1. Catches timeout errors and converts to TransportStallError
 * 2. Detects stall patterns in error output
 * 3. Returns structured error for transport failures
 *
 * @param config - Claude Code CLI configuration
 * @param invocation - Invocation parameters
 * @param stage - The stage (ORCHESTRATE or BUILD) for error context
 * @returns InvokeResult with either response or stall error
 *
 * @example
 * ```typescript
 * const result = await invokeWithStallDetection(config, invocation, 'BUILD');
 * if (result.ok) {
 *   console.log('Success:', result.response.result);
 * } else {
 *   console.log('Stall:', result.error.raw_error);
 * }
 * ```
 */
export async function invokeWithStallDetection(
  config: ClaudeCodeCliConfig,
  invocation: ClaudeInvocation,
  stage: TransportStallStage
): Promise<InvokeResult> {
  try {
    const response = await invokeClaudeCode(config, invocation);
    return { ok: true, response };
  } catch (error) {
    // Handle ClaudeError (timeout, process errors, etc.)
    if (error instanceof ClaudeError) {
      const errorMessage = error.message + (error.stderr ? `\n${error.stderr}` : '');

      // Check if this is a timeout (exit code 124 is standard timeout)
      const isTimeout = error.exitCode === 124 || error.message.includes('timed out');

      // Check for stall patterns
      const stallCheck = isTransportStall(errorMessage);

      // If timeout or stall pattern detected, return TransportStallError
      if (isTimeout || stallCheck.stalled) {
        return {
          ok: false,
          error: createTransportStallError(stage, errorMessage, stallCheck.request_id),
        };
      }

      // For other ClaudeErrors, re-throw (not a transport stall)
      throw error;
    }

    // For unexpected errors, check if they contain stall patterns
    const errorMessage = error instanceof Error ? error.message : String(error);
    const stallCheck = isTransportStall(errorMessage);

    if (stallCheck.stalled) {
      return {
        ok: false,
        error: createTransportStallError(stage, errorMessage, stallCheck.request_id),
      };
    }

    // Re-throw non-transport errors
    throw error;
  }
}

/**
 * Result of normalizing an error for transport stall detection.
 */
export interface NormalizedError {
  /** Whether this error represents a transport stall */
  isStall: boolean;
  /** Structured stall error if isStall is true */
  stallError: TransportStallError | null;
  /** The original error wrapped as Error */
  originalError: Error;
  /** Raw error message extracted from the error */
  message: string;
}

/**
 * Normalizes any error type into a consistent format for stall detection.
 *
 * Handles:
 * - ClaudeError: extracts message + stderr, checks for timeout
 * - Error: extracts message
 * - string: wraps in Error
 * - unknown: converts to string and wraps in Error
 *
 * @param error - Any error type (ClaudeError, Error, string, unknown)
 * @param stage - The stage where the error occurred (ORCHESTRATE or BUILD)
 * @returns Normalized error with stall detection result
 *
 * @example
 * ```typescript
 * try {
 *   await invokeClaudeCode(config, invocation);
 * } catch (error) {
 *   const normalized = normalizeTransportError(error, 'BUILD');
 *   if (normalized.isStall) {
 *     handleStall(normalized.stallError);
 *   } else {
 *     throw normalized.originalError;
 *   }
 * }
 * ```
 */
/**
 * Type guard to check if an error is a TransportStallError.
 *
 * @param error - Any value to check
 * @returns True if the error is a TransportStallError
 *
 * @example
 * ```typescript
 * const result = await invokeWithStallDetection(config, invocation, 'BUILD');
 * if (!result.ok && isTransportStallError(result.error)) {
 *   console.log('Stage:', result.error.stage);
 *   console.log('Request ID:', result.error.request_id);
 * }
 * ```
 */
export function isTransportStallError(error: unknown): error is TransportStallError {
  if (typeof error !== 'object' || error === null) {
    return false;
  }

  const obj = error as Record<string, unknown>;
  return (
    obj.kind === 'transport_stalled' &&
    (obj.stage === 'ORCHESTRATE' || obj.stage === 'BUILD') &&
    (typeof obj.request_id === 'string' || obj.request_id === null) &&
    typeof obj.raw_error === 'string'
  );
}

export function normalizeTransportError(
  error: unknown,
  stage: TransportStallStage
): NormalizedError {
  let message: string;
  let originalError: Error;
  let isTimeout = false;

  // Handle different error types
  if (error instanceof ClaudeError) {
    message = error.message + (error.stderr ? `\n${error.stderr}` : '');
    originalError = error;
    isTimeout = error.exitCode === 124 || error.message.includes('timed out');
  } else if (error instanceof Error) {
    message = error.message;
    originalError = error;
  } else if (typeof error === 'string') {
    message = error;
    originalError = new Error(error);
  } else {
    message = String(error);
    originalError = new Error(message);
  }

  // Check for stall patterns
  const stallCheck = isTransportStall(message);

  // Determine if this is a stall
  const isStall = isTimeout || stallCheck.stalled;

  return {
    isStall,
    stallError: isStall
      ? createTransportStallError(stage, message, stallCheck.request_id)
      : null,
    originalError,
    message,
  };
}
