/**
 * BLOCKED.json generation for preflight failures.
 *
 * When runner cannot safely start (missing config, dirty worktree, lock held, etc.),
 * it must write BLOCKED.json explaining the exact remediation required.
 */

import { unlink } from 'node:fs/promises';
import { atomicWriteJson } from './fs.js';
import type { BlockedData, OrchestratorDiagnostics } from '../types/blocked.js';
import type { BlockedCode } from '../types/preflight.js';

/**
 * Remediation messages for each BLOCKED code.
 */
const REMEDIATION_MESSAGES: Record<string, string> = {
  BLOCKED_MISSING_CONFIG:
    'Create or fix relais.config.json in the project root. Ensure the file is readable and contains valid JSON configuration.',
  BLOCKED_DIRTY_WORKTREE:
    'Commit or stash all uncommitted changes and remove untracked files. The worktree must be clean before running a tick.',
  BLOCKED_LOCK_HELD:
    'Another process is holding the lock. Wait for it to complete, or if the process has crashed, manually remove the lock file.',
  BLOCKED_CRASH_RECOVERY_REQUIRED:
    'Manual cleanup is required after a crash. Check for stale lock files, incomplete state files, or corrupted artifacts and remove them.',
  BLOCKED_BUDGET_EXHAUSTED:
    'Milestone budgets have been exceeded. Review your budget configuration or wait for budget reset.',
  BLOCKED_HISTORY_CAP_CLEANUP_REQUIRED:
    'History directory exceeds the configured size limit. Manually clean up old history artifacts to free space.',
  BLOCKED_ORCHESTRATOR_OUTPUT_INVALID:
    'The orchestrator returned invalid JSON after retry attempts. Check orchestrator logs and configuration.',
  BLOCKED_TRANSPORT_STALLED:
    'Transport stall detected (connection stalled, timeout, or CLI hang). Check network connectivity, Claude API status, and retry. If the issue persists, check the request ID in the error for debugging.',
};

/**
 * Builds BlockedData from a code, reason, and optional remediation.
 *
 * If remediation is not provided, a default remediation message is used
 * based on the blocked code.
 *
 * @param code - The BLOCKED_* code
 * @param reason - Human-readable explanation of why execution is blocked
 * @param remediation - Optional remediation message (defaults to code-based message)
 * @returns Complete BlockedData object
 *
 * @example
 * ```typescript
 * const data = buildBlockedData(
 *   'BLOCKED_DIRTY_WORKTREE',
 *   'Git worktree has uncommitted changes',
 *   'Please commit or stash your changes'
 * );
 * ```
 */
export function buildBlockedData(
  code: BlockedCode | string,
  reason: string,
  remediation?: string
): BlockedData {
  const remediationMessage =
    remediation ?? REMEDIATION_MESSAGES[code] ?? 'No specific remediation available.';

  return {
    blocked_at: new Date().toISOString(),
    code,
    reason,
    remediation: remediationMessage,
  };
}

/**
 * Writes BLOCKED.json atomically to the specified path.
 *
 * Uses atomic write to ensure the file is never in a partially-written state,
 * even if the process crashes during the write operation.
 *
 * @param data - The BlockedData to write
 * @param path - The file path where BLOCKED.json should be written
 * @throws {Error} If the write operation fails
 *
 * @example
 * ```typescript
 * const data = buildBlockedData(
 *   'BLOCKED_DIRTY_WORKTREE',
 *   'Git worktree has uncommitted changes'
 * );
 * await writeBlocked(data, '/relais/BLOCKED.json');
 * ```
 */
export async function writeBlocked(data: BlockedData, path: string): Promise<void> {
  await atomicWriteJson(path, data);
}

/**
 * Deletes BLOCKED.json from the specified path (best-effort).
 *
 * Used to clean up stale BLOCKED.json files when a tick completes
 * with a non-blocked outcome (success or stop).
 *
 * @param path - The file path where BLOCKED.json should be deleted
 *
 * @example
 * ```typescript
 * await deleteBlocked('/relais/BLOCKED.json');
 * ```
 */
export async function deleteBlocked(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch {
    // Best-effort: ignore ENOENT and other errors
  }
}

/**
 * Builds BlockedData specifically for orchestrator output validation failures.
 *
 * Includes detailed diagnostics to help debug why the orchestrator output
 * failed validation.
 *
 * @param reason - Human-readable explanation of the failure
 * @param diagnostics - Detailed diagnostics including AJV errors and excerpts
 * @returns Complete BlockedData object with diagnostics
 *
 * @example
 * ```typescript
 * const data = buildOrchestratorBlockedData(
 *   'Task validation failed: Missing required property: task_id',
 *   {
 *     schema_errors: [{ keyword: 'required', ... }],
 *     stdout_excerpt: '{ "invalid": "json" }',
 *     extract_method: 'direct_parse',
 *   }
 * );
 * ```
 */
export function buildOrchestratorBlockedData(
  reason: string,
  diagnostics: OrchestratorDiagnostics
): BlockedData {
  return {
    blocked_at: new Date().toISOString(),
    code: 'BLOCKED_ORCHESTRATOR_OUTPUT_INVALID',
    reason,
    remediation: REMEDIATION_MESSAGES['BLOCKED_ORCHESTRATOR_OUTPUT_INVALID'],
    diagnostics,
  };
}
