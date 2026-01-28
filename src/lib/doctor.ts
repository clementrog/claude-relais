/**
 * Doctor checks for Relais configuration and environment.
 *
 * Provides functions to verify system health and configuration correctness.
 */

import { spawn, ChildProcess } from 'node:child_process';
import type { RelaisConfig } from '../types/config.js';

/**
 * Result of Codex CLI reviewer doctor check.
 */
export interface ReviewerDoctorResult {
  /** Whether the Codex CLI is available */
  cli_available: boolean;
  /** Authentication status: 'api_key_present' if CODEX_API_KEY is set, 'unknown' otherwise */
  auth_status: 'api_key_present' | 'unknown';
  /** Version string from codex --version, if available */
  version?: string;
  /** Reviewer mode: 'enabled' if reviewer.enabled is true, 'disabled' otherwise */
  reviewer_mode: 'enabled' | 'disabled';
  /** Auth mode from config: reviewer.auth.mode, or 'unknown' if not configured */
  auth_mode: 'auto' | 'api_key' | 'login' | 'unknown';
}

/**
 * Checks Codex CLI availability and authentication status.
 *
 * Performs the following checks:
 * 1. Spawns 'codex --version' to verify CLI is available
 * 2. Checks CODEX_API_KEY environment variable presence
 * 3. Reads reviewer configuration from config (enabled, auth.mode)
 *
 * @param config - Relais configuration (optional, for reading reviewer settings)
 * @returns Promise resolving to ReviewerDoctorResult with check results
 *
 * @example
 * ```typescript
 * const result = await checkCodexCli(config);
 * if (result.cli_available) {
 *   console.log(`Codex CLI available: ${result.version}`);
 * }
 * ```
 */
export async function checkCodexCli(
  config?: RelaisConfig
): Promise<ReviewerDoctorResult> {
  let cli_available = false;
  let version: string | undefined;

  // Check CLI availability by spawning 'codex --version'
  try {
    const child: ChildProcess = spawn('codex', ['--version'], {
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    child.stdout?.on('data', (chunk: Buffer) => {
      stdoutChunks.push(chunk);
    });

    child.stderr?.on('data', (chunk: Buffer) => {
      stderrChunks.push(chunk);
    });

    await new Promise<void>((resolve, reject) => {
      child.on('error', (error: Error) => {
        reject(error);
      });

      child.on('exit', (code: number | null) => {
        if (code === 0) {
          cli_available = true;
          const output = Buffer.concat(stdoutChunks).toString('utf-8').trim();
          // Extract version from output (e.g., "codex 1.2.3" or just "1.2.3")
          version = output || undefined;
          resolve();
        } else {
          reject(new Error(`codex --version exited with code ${code}`));
        }
      });
    });
  } catch {
    // CLI not available or failed to execute
    cli_available = false;
  }

  // Check auth status: look for CODEX_API_KEY environment variable
  const apiKey = process.env.CODEX_API_KEY;
  const auth_status: 'api_key_present' | 'unknown' = apiKey && apiKey.trim().length > 0
    ? 'api_key_present'
    : 'unknown';

  // Read reviewer configuration
  const reviewer_enabled = config?.reviewer?.enabled ?? false;
  const reviewer_mode: 'enabled' | 'disabled' = reviewer_enabled ? 'enabled' : 'disabled';
  const auth_mode: 'auto' | 'api_key' | 'login' | 'unknown' = config?.reviewer?.auth?.mode ?? 'unknown';

  return {
    cli_available,
    auth_status,
    version,
    reviewer_mode,
    auth_mode,
  };
}
