/**
 * Type definitions for Claude Code CLI invocation.
 */

/**
 * Configuration for invoking Claude Code CLI.
 */
export interface ClaudeInvocation {
  /** The prompt to send to Claude */
  prompt: string;
  /** Maximum number of agentic turns */
  maxTurns: number;
  /** Permission mode: 'plan' or 'bypassPermissions' */
  permissionMode: 'plan' | 'bypassPermissions';
  /** Model alias or full name */
  model: string;
  /** Comma-separated list of allowed tools (optional) */
  allowedTools?: string;
  /** Path to system prompt file (optional) */
  systemPrompt?: string;
  /** Timeout in milliseconds */
  timeout: number;
  /** AbortSignal for cancellation (optional) */
  signal?: AbortSignal;
}

/**
 * Response from Claude Code CLI invocation.
 */
export interface ClaudeResponse {
  /** Whether the invocation was successful */
  success: boolean;
  /** The model's text output (null if unsuccessful) */
  result: string | null;
  /** Full JSON response from CLI */
  raw: object;
  /** Process exit code */
  exitCode: number;
  /** Duration of invocation in milliseconds */
  durationMs: number;
  /** Standard error output from CLI */
  stderr: string;
}

/**
 * Error thrown when Claude Code CLI invocation fails.
 */
export class ClaudeError extends Error {
  constructor(
    message: string,
    public readonly exitCode: number,
    public readonly stderr?: string,
    public readonly cause?: Error
  ) {
    super(message);
    this.name = 'ClaudeError';
  }
}

/**
 * Error thrown when a Claude Code invocation is interrupted by an AbortSignal.
 */
export class InterruptedError extends Error {
  constructor(message: string = 'Operation interrupted by signal') {
    super(message);
    this.name = 'InterruptedError';
  }
}

/**
 * Type guard for InterruptedError.
 */
export function isInterruptedError(error: unknown): error is InterruptedError {
  return error instanceof InterruptedError ||
    (error instanceof Error && error.name === 'InterruptedError');
}
