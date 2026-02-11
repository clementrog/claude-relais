/**
 * Doctor checks for Envoi configuration and environment.
 *
 * Provides functions to verify system health and configuration correctness.
 */

import { spawn, ChildProcess } from 'node:child_process';
import type { EnvoiConfig } from '../types/config.js';

/**
 * Result of Codex CLI reviewer doctor check.
 */
export interface ReviewerDoctorResult {
  /** Whether the Codex CLI is available */
  cli_available: boolean;
  /** Authentication status for Codex reviewer CLI */
  auth_status: 'authenticated' | 'api_key_present' | 'unauthenticated' | 'unknown';
  /** Version string from codex --version, if available */
  version?: string;
  /** Reviewer mode: 'enabled' if reviewer.enabled is true, 'disabled' otherwise */
  reviewer_mode: 'enabled' | 'disabled';
  /** Auth mode from config: reviewer.auth.mode, or 'unknown' if not configured */
  auth_mode: 'auto' | 'api_key' | 'login' | 'unknown';
}

/**
 * Result of Cursor Agent doctor check.
 */
export interface CursorAgentDoctorResult {
  /** Whether the Cursor CLI command is available */
  cli_available: boolean;
  /** Cursor CLI version output, if available */
  version?: string;
  /** Whether `cursor agent` subcommand appears available */
  agent_available: boolean;
  /** Auth status for Cursor Agent */
  auth_status: 'authenticated' | 'unauthenticated' | 'api_key_present' | 'unknown';
  /** Optional details for debugging auth / CLI failures */
  details?: string;
  /** The command that was checked (e.g. "cursor") */
  command: string;
}

/**
 * Result of Claude Code CLI auth check.
 */
export interface ClaudeCliDoctorResult {
  /** Whether the configured Claude CLI command is available */
  cli_available: boolean;
  /** Claude CLI version output, if available */
  version?: string;
  /** Auth status for Claude Code */
  auth_status: 'authenticated' | 'api_key_present' | 'unauthenticated' | 'unknown';
  /** Optional details for debugging auth / CLI failures */
  details?: string;
  /** The command that was checked (e.g. "claude") */
  command: string;
}

type SpawnResult = { ok: boolean; code: number | null; stdout: string; stderr: string; error?: string };

async function spawnAndCapture(
  command: string,
  args: string[],
  timeoutMs: number
): Promise<SpawnResult> {
  return await new Promise<SpawnResult>((resolve) => {
    let child: ChildProcess | null = null;
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let timeout: NodeJS.Timeout | null = null;

    try {
      child = spawn(command, args, { shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      resolve({
        ok: false,
        code: null,
        stdout: '',
        stderr: '',
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    child.stdout?.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr?.on('data', (chunk: Buffer) => stderrChunks.push(chunk));

    timeout = setTimeout(() => {
      try {
        child?.kill('SIGTERM');
      } catch {
        // ignore
      }
    }, timeoutMs);

    const finish = (result: SpawnResult) => {
      if (timeout) clearTimeout(timeout);
      resolve(result);
    };

    child.on('error', (error: Error) => {
      finish({
        ok: false,
        code: null,
        stdout: Buffer.concat(stdoutChunks).toString('utf-8'),
        stderr: Buffer.concat(stderrChunks).toString('utf-8'),
        error: error.message,
      });
    });

    child.on('exit', (code: number | null) => {
      const stdout = Buffer.concat(stdoutChunks).toString('utf-8').trim();
      const stderr = Buffer.concat(stderrChunks).toString('utf-8').trim();
      finish({ ok: code === 0, code, stdout, stderr });
    });
  });
}

/**
 * Checks Codex CLI availability and authentication status.
 *
 * Performs the following checks:
 * 1. Spawns 'codex --version' to verify CLI is available
 * 2. Checks CODEX_API_KEY environment variable presence
 * 3. Reads reviewer configuration from config (enabled, auth.mode)
 *
 * @param config - Envoi configuration (optional, for reading reviewer settings)
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
  config?: EnvoiConfig
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

  // Check auth status:
  // 1) API key in env
  // 2) codex whoami (if available)
  // 3) fallback: unknown
  let auth_status: ReviewerDoctorResult['auth_status'] = 'unknown';
  const apiKey = process.env.CODEX_API_KEY;
  if (apiKey && apiKey.trim().length > 0) {
    auth_status = 'api_key_present';
  } else if (cli_available) {
    const whoami = await spawnAndCapture('codex', ['whoami'], 5000);
    if (whoami.ok) {
      auth_status = 'authenticated';
    } else {
      const details = [whoami.stderr, whoami.stdout, whoami.error].filter(Boolean).join('\n').toLowerCase();
      if (
        details.includes('unauth') ||
        details.includes('not logged') ||
        details.includes('login') ||
        details.includes('sign in') ||
        details.includes('expired')
      ) {
        auth_status = 'unauthenticated';
      } else {
        auth_status = 'unknown';
      }
    }
  }

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

/**
 * Checks Claude Code CLI availability and authentication status.
 *
 * Heuristics:
 * - If ANTHROPIC_API_KEY is set, treat as "api_key_present"
 * - Otherwise, try `claude whoami` then `claude auth status`
 */
export async function checkClaudeCodeCli(command = 'claude'): Promise<ClaudeCliDoctorResult> {
  // 1) CLI availability + version
  let version: string | undefined;
  let cli_available = false;
  const versionTry1 = await spawnAndCapture(command, ['--version'], 2000);
  if (versionTry1.ok) {
    cli_available = true;
    version = versionTry1.stdout || undefined;
  } else {
    const versionTry2 = await spawnAndCapture(command, ['-v'], 2000);
    if (versionTry2.ok) {
      cli_available = true;
      version = versionTry2.stdout || undefined;
    }
  }

  if (!cli_available) {
    const details = versionTry1.error ?? versionTry1.stderr ?? versionTry1.stdout;
    return {
      cli_available: false,
      version: undefined,
      auth_status: 'unknown',
      details: details ? String(details).trim() : undefined,
      command,
    };
  }

  // 2) Env key fallback
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (apiKey && apiKey.trim().length > 0) {
    return {
      cli_available: true,
      version,
      auth_status: 'api_key_present',
      command,
    };
  }

  // 3) whoami / auth status probes
  const probes: Array<{ args: string[]; unauthHint?: string }> = [
    { args: ['whoami'] },
    { args: ['auth', 'status'] },
  ];

  for (const probe of probes) {
    const result = await spawnAndCapture(command, probe.args, 5000);
    if (result.ok) {
      return {
        cli_available: true,
        version,
        auth_status: 'authenticated',
        command,
      };
    }
    const details = [result.stderr, result.stdout, result.error].filter(Boolean).join('\n').trim();
    const lower = details.toLowerCase();
    if (
      lower.includes('unauth') ||
      lower.includes('not logged') ||
      lower.includes('login') ||
      lower.includes('sign in') ||
      lower.includes('expired') ||
      lower.includes('token')
    ) {
      return {
        cli_available: true,
        version,
        auth_status: 'unauthenticated',
        details: details || undefined,
        command,
      };
    }
  }

  return {
    cli_available: true,
    version,
    auth_status: 'unknown',
    command,
  };
}

/**
 * Checks Cursor CLI + Cursor Agent availability and basic authentication status.
 *
 * Heuristics:
 * - If CURSOR_API_KEY is set, treat as "api_key_present" (preferred: do not store secrets in config)
 * - Otherwise, attempt `cursor agent whoami` to detect authenticated vs unauthenticated
 */
export async function checkCursorAgent(config?: EnvoiConfig): Promise<CursorAgentDoctorResult> {
  const command = config?.builder?.cursor?.command ?? 'cursor';

  // 1) Cursor CLI availability + version
  let version: string | undefined;
  let cli_available = false;
  const versionTry1 = await spawnAndCapture(command, ['--version'], 2000);
  if (versionTry1.ok) {
    cli_available = true;
    version = versionTry1.stdout || undefined;
  } else {
    const versionTry2 = await spawnAndCapture(command, ['-v'], 2000);
    if (versionTry2.ok) {
      cli_available = true;
      version = versionTry2.stdout || undefined;
    }
  }

  if (!cli_available) {
    const details = versionTry1.error ?? versionTry1.stderr ?? versionTry1.stdout;
    return {
      cli_available: false,
      version: undefined,
      agent_available: false,
      auth_status: 'unknown',
      details: details ? String(details).trim() : undefined,
      command,
    };
  }

  // 2) Agent subcommand availability
  const agentHelp = await spawnAndCapture(command, ['agent', '--help'], 2000);
  const agent_available = agentHelp.ok;
  if (!agent_available) {
    return {
      cli_available: true,
      version,
      agent_available: false,
      auth_status: 'unknown',
      details: [agentHelp.stderr, agentHelp.stdout].filter(Boolean).join('\n').trim() || undefined,
      command,
    };
  }

  // 3) Auth status
  const apiKey = process.env.CURSOR_API_KEY;
  if (apiKey && apiKey.trim().length > 0) {
    return {
      cli_available: true,
      version,
      agent_available: true,
      auth_status: 'api_key_present',
      command,
    };
  }

  const whoami = await spawnAndCapture(command, ['agent', 'whoami'], 5000);
  if (whoami.ok) {
    return {
      cli_available: true,
      version,
      agent_available: true,
      auth_status: 'authenticated',
      command,
    };
  }

  const details = [whoami.stderr, whoami.stdout, whoami.error].filter(Boolean).join('\n').trim();
  return {
    cli_available: true,
    version,
    agent_available: true,
    auth_status: 'unauthenticated',
    details: details || undefined,
    command,
  };
}
