/**
 * Claude Code CLI wrapper for invoking Claude with proper flags.
 *
 * Provides functions to build CLI arguments, spawn processes, and parse responses.
 */

import { spawn, ChildProcess } from 'node:child_process';
import type { ClaudeCodeCliConfig } from '../types/config.js';
import type { ClaudeInvocation, ClaudeResponse } from '../types/claude.js';
import { ClaudeError, InterruptedError } from '../types/claude.js';

/**
 * Builds CLI arguments array from config and invocation parameters.
 *
 * @param config - Claude Code CLI configuration
 * @param invocation - Invocation parameters
 * @returns Array of CLI arguments
 */
export function buildClaudeArgs(
  config: ClaudeCodeCliConfig,
  invocation: ClaudeInvocation
): string[] {
  const args: string[] = [
    '-p', // prompt mode (non-interactive)
    '--output-format',
    config.output_format,
    '--max-turns',
    invocation.maxTurns.toString(),
    '--no-session-persistence', // always
    '--permission-mode',
    invocation.permissionMode,
    '--model',
    invocation.model,
  ];

  // Add optional allowedTools flag
  if (invocation.allowedTools) {
    args.push('--allowedTools', invocation.allowedTools);
  }

  // Add optional system-prompt flag
  if (invocation.systemPrompt) {
    args.push('--system-prompt', invocation.systemPrompt);
  }

  // Add the prompt as the last argument
  args.push(invocation.prompt);

  return args;
}

/**
 * Parses the JSON response from Claude Code CLI and extracts the result.
 *
 * The CLI returns a JSON wrapper with format: { result: 'model output', ... }
 * This function extracts the .result field as the actual model text.
 *
 * @param stdout - Standard output from CLI process
 * @returns Parsed result object with result field
 * @throws {Error} If JSON parsing fails or result field is missing
 */
export function parseClaudeResponse(stdout: string): { result: string; raw: object } {
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
  if (typeof obj.result !== 'string') {
    throw new Error('Response missing required "result" field or result is not a string');
  }

  return {
    result: obj.result,
    raw: parsed as object,
  };
}

/**
 * Invokes Claude Code CLI with the given configuration and invocation parameters.
 *
 * @param config - Claude Code CLI configuration
 * @param invocation - Invocation parameters including prompt, model, etc.
 * @returns Promise resolving to ClaudeResponse with parsed output
 * @throws {ClaudeError} If invocation fails or times out
 *
 * @example
 * ```typescript
 * const response = await invokeClaudeCode(config, {
 *   prompt: 'Hello, Claude!',
 *   maxTurns: 1,
 *   permissionMode: 'plan',
 *   model: 'claude-3-5-sonnet-20241022',
 *   timeout: 60000
 * });
 * ```
 */
export async function invokeClaudeCode(
  config: ClaudeCodeCliConfig,
  invocation: ClaudeInvocation
): Promise<ClaudeResponse> {
  // Short-circuit if already aborted
  if (invocation.signal?.aborted) {
    throw new InterruptedError('Claude Code invocation aborted by signal');
  }

  const startTime = Date.now();
  const args = buildClaudeArgs(config, invocation);

  return new Promise<ClaudeResponse>((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let timeoutId: NodeJS.Timeout | null = null;
    let aborted = false;
    let abortHandler: (() => void) | null = null;
    let exited = false;
    let killTimerId: NodeJS.Timeout | null = null;

    // Spawn the process
    const child: ChildProcess = spawn(config.command, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    // Cleanup function to remove all listeners and timers
    const cleanup = () => {
      if (timeoutId) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }
      if (killTimerId) {
        clearTimeout(killTimerId);
        killTimerId = null;
      }
      if (abortHandler && invocation.signal) {
        invocation.signal.removeEventListener('abort', abortHandler);
        abortHandler = null;
      }
    };

    // Track if child has exited
    child.on('exit', () => {
      exited = true;
      // Clear the SIGKILL escalation timer if child exited
      if (killTimerId) {
        clearTimeout(killTimerId);
        killTimerId = null;
      }
    });

    // Handle abort signal
    if (invocation.signal) {
      abortHandler = () => {
        if (aborted) return;
        aborted = true;
        cleanup();
        child.kill('SIGTERM');
        // Force kill after 1 second if still alive
        killTimerId = setTimeout(() => {
          if (!exited) child.kill('SIGKILL');
        }, 1000);
        reject(new InterruptedError('Claude Code invocation aborted by signal'));
      };
      invocation.signal.addEventListener('abort', abortHandler, { once: true });
    }

    // Set up timeout
    if (invocation.timeout > 0) {
      timeoutId = setTimeout(() => {
        cleanup();
        child.kill('SIGTERM');
        reject(
          new ClaudeError(
            `Claude Code CLI invocation timed out after ${invocation.timeout}ms`,
            124, // Standard timeout exit code
            stderr
          )
        );
      }, invocation.timeout);
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
      // If we were aborted, error was already handled
      if (aborted) {
        return;
      }

      cleanup();

      const durationMs = Date.now() - startTime;
      const exitCode = code ?? 0;

      // If process was killed by timeout, error was already handled
      if (code === null && !aborted) {
        return;
      }

      try {
        // Parse the JSON response
        const parsed = parseClaudeResponse(stdout);

        resolve({
          success: exitCode === 0,
          result: exitCode === 0 ? parsed.result : null,
          raw: parsed.raw,
          exitCode,
          durationMs,
        });
      } catch (error) {
        reject(
          new ClaudeError(
            `Failed to parse Claude response: ${error instanceof Error ? error.message : String(error)}`,
            exitCode,
            stderr,
            error instanceof Error ? error : undefined
          )
        );
      }
    });

    // Handle process errors
    child.on('error', (error: Error) => {
      if (aborted) {
        return;
      }

      cleanup();

      reject(
        new ClaudeError(
          `Failed to spawn Claude Code CLI process: ${error.message}`,
          1,
          stderr,
          error
        )
      );
    });
  });
}
