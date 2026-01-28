/**
 * Codex CLI wrapper for invoking reviewer with proper flags.
 *
 * Provides functions to invoke the reviewer, parse responses, and check authentication.
 */

import { spawn, ChildProcess } from 'node:child_process';
import type { ReviewerInvocationConfig, ReviewerContext, ReviewerInvocationResult, ReviewerResult, ReviewerError } from '../types/reviewer.js';

/**
 * Checks if reviewer authentication is configured.
 *
 * Checks for CODEX_API_KEY environment variable presence as a best-effort
 * authentication check (V1 implementation).
 *
 * @returns Object with authentication status
 */
export function checkReviewerAuth(): { authenticated: boolean; reason?: string } {
  const apiKey = process.env.CODEX_API_KEY;
  if (!apiKey) {
    return {
      authenticated: false,
      reason: 'CODEX_API_KEY environment variable not set',
    };
  }
  if (apiKey.trim().length === 0) {
    return {
      authenticated: false,
      reason: 'CODEX_API_KEY environment variable is empty',
    };
  }
  return { authenticated: true };
}

/**
 * Parses the JSON response from Codex CLI and extracts the result.
 *
 * Handles two formats:
 * 1. Wrapper format: { result: 'JSON string', ... } - parses the .result field as JSON
 * 2. Direct JSON format: { ... } - uses the parsed JSON directly
 *
 * @param stdout - Standard output from CLI process
 * @returns Parsed result object
 * @throws {Error} If JSON parsing fails
 */
export function parseReviewerOutput(stdout: string): object {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch (error) {
    throw new Error(`Failed to parse JSON response: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('Parsed response is not an object');
  }

  const obj = parsed as Record<string, unknown>;

  // Check if it's a wrapper format with .result field
  if (typeof obj.result === 'string') {
    try {
      // Parse the nested JSON string
      const nestedParsed = JSON.parse(obj.result);
      if (typeof nestedParsed === 'object' && nestedParsed !== null) {
        return nestedParsed;
      }
      // If nested parse didn't yield an object, fall through to return wrapper
    } catch {
      // If parsing .result fails, fall through to return wrapper
    }
  }

  // Return direct JSON or wrapper object
  return parsed as object;
}

/**
 * Invokes Codex CLI reviewer with the given configuration and context.
 *
 * @param config - Codex CLI reviewer configuration
 * @param context - Reviewer context including prompt and optional system prompt
 * @returns Promise resolving to ReviewerInvocationResult (success or error)
 *
 * @example
 * ```typescript
 * const result = await invokeReviewer(config, {
 *   prompt: 'Review this code...',
 *   systemPrompt: '/path/to/system.txt'
 * });
 *
 * if (result.success) {
 *   console.log('Review result:', result.result);
 * } else {
 *   console.error('Review failed:', result.error);
 * }
 * ```
 */
export async function invokeReviewer(
  config: ReviewerInvocationConfig,
  context: ReviewerContext
): Promise<ReviewerInvocationResult> {
  const startTime = Date.now();
  
  // Build CLI arguments
  const args: string[] = [
    '-p', // prompt mode (non-interactive)
    '--model',
    config.model,
    '--max-turns',
    config.maxTurns.toString(),
  ];

  // Add optional system-prompt flag
  if (context.systemPrompt) {
    args.push('--system-prompt', context.systemPrompt);
  }

  // Add the prompt as the last argument
  args.push(context.prompt);

  return new Promise<ReviewerInvocationResult>((resolve) => {
    let stdout = '';
    let stderr = '';
    let timeoutId: NodeJS.Timeout | null = null;

    // Spawn the process (shell: false for security)
    const child: ChildProcess = spawn(config.command, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
    });

    // Set up timeout
    if (config.timeout > 0) {
      timeoutId = setTimeout(() => {
        child.kill('SIGTERM');
        const durationMs = Date.now() - startTime;
        resolve({
          success: false,
          error: `Codex CLI invocation timed out after ${config.timeout}ms`,
          exitCode: 124, // Standard timeout exit code
          stderr,
          durationMs,
        });
      }, config.timeout);
    }

    // Capture stdout
    child.stdout?.on('data', (data: Buffer) => {
      stdout += data.toString();
    });

    // Capture stderr
    child.stderr?.on('data', (data: Buffer) => {
      stderr += data.toString();
    });

    // Handle process completion
    child.on('close', (code: number | null) => {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }

      const durationMs = Date.now() - startTime;
      const exitCode = code ?? 0;

      // If process was killed by timeout, error was already handled
      if (code === null && timeoutId) {
        return;
      }

      // Try to parse the output
      try {
        const parsed = parseReviewerOutput(stdout);

        // Basic validation: ensure it's an object
        // Full schema validation will be added in WP-072 when reviewer_result.schema.json exists
        if (typeof parsed !== 'object' || parsed === null) {
          resolve({
            success: false,
            error: 'Reviewer output is not a valid object',
            exitCode,
            stderr,
            durationMs,
          });
          return;
        }

        resolve({
          success: true,
          result: parsed,
          raw: JSON.parse(stdout), // Keep original wrapper if present
          exitCode,
          durationMs,
        });
      } catch (error) {
        resolve({
          success: false,
          error: `Failed to parse reviewer output: ${error instanceof Error ? error.message : String(error)}`,
          exitCode,
          stderr,
          durationMs,
        });
      }
    });

    // Handle process errors
    child.on('error', (error: Error) => {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }

      const durationMs = Date.now() - startTime;
      resolve({
        success: false,
        error: `Failed to spawn Codex CLI process: ${error.message}`,
        exitCode: 1,
        stderr,
        durationMs,
      });
    });
  });
}
