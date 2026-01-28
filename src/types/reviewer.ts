/**
 * Type definitions for Codex CLI reviewer invocation.
 */

/**
 * Context information passed to the reviewer for review.
 */
export interface ReviewerContext {
  /** The context/prompt to send to the reviewer */
  prompt: string;
  /** System prompt (optional) */
  systemPrompt?: string;
}

/**
 * Invocation parameters for Codex CLI reviewer.
 */
export interface ReviewerInvocationConfig {
  /** Command to invoke Codex CLI */
  command: string;
  /** Model to use */
  model: string;
  /** Maximum conversation turns */
  maxTurns: number;
  /** Timeout in milliseconds */
  timeout: number;
}

/**
 * Successful reviewer result.
 */
export interface ReviewerResult {
  /** Whether the review was successful */
  success: true;
  /** The reviewer's output (parsed JSON) */
  result: object;
  /** Raw JSON response from CLI */
  raw: object;
  /** Process exit code */
  exitCode: number;
  /** Duration of invocation in milliseconds */
  durationMs: number;
}

/**
 * Reviewer error result.
 */
export interface ReviewerError {
  /** Whether the review was successful */
  success: false;
  /** Error message */
  error: string;
  /** Process exit code */
  exitCode: number;
  /** Standard error output */
  stderr?: string;
  /** Duration of invocation in milliseconds */
  durationMs: number;
}

/**
 * Union type for reviewer invocation result.
 */
export type ReviewerInvocationResult = ReviewerResult | ReviewerError;

/**
 * Risk flags indicating which risk conditions have been triggered.
 *
 * These flags are used to determine when the reviewer should be invoked.
 */
export type RiskFlags =
  | 'high_risk_path'
  | 'diff_near_cap'
  | 'verify_failed'
  | 'repeated_stop'
  | 'budget_warning';
