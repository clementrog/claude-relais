/**
 * Preflight check types for determining if a tick can safely start.
 *
 * Preflight checks produce BLOCKED verdicts if conditions are not met,
 * preventing the runner from executing a tick.
 */

/**
 * Codes indicating why a preflight check blocked execution.
 */
export type BlockedCode =
  | 'BLOCKED_MISSING_CONFIG'
  | 'BLOCKED_DIRTY_WORKTREE'
  | 'BLOCKED_LOCK_HELD'
  | 'BLOCKED_CRASH_RECOVERY_REQUIRED'
  | 'BLOCKED_HISTORY_CAP_CLEANUP_REQUIRED'
  | 'BLOCKED_BUDGET_EXHAUSTED'
  | 'BLOCKED_TRANSPORT_STALLED';

/**
 * Stage where a transport stall occurred.
 */
export type TransportStallStage = 'ORCHESTRATE' | 'BUILD';

/**
 * Structured error for transport stalls (Cursor/CLI hang, Connection stalled).
 *
 * Used when the builder or orchestrator invocation stalls or throws
 * connection-related errors that prevent completion.
 */
export interface TransportStallError {
  /** Error classification */
  kind: 'transport_stalled';
  /** Stage where the stall occurred */
  stage: TransportStallStage;
  /** Request ID if parsable from error output */
  request_id: string | null;
  /** Raw error message (trimmed to reasonable length) */
  raw_error: string;
}

/**
 * Result of running preflight checks.
 *
 * If ok is true, the tick can proceed. If ok is false, blocked_code and
 * blocked_reason explain why execution is blocked.
 */
export interface PreflightResult {
  /** Whether all preflight checks passed */
  ok: boolean;
  /** The specific reason for blocking, if any */
  blocked_code: BlockedCode | null;
  /** Human-readable explanation of why execution is blocked */
  blocked_reason: string | null;
  /** Non-fatal warnings discovered during preflight */
  warnings: string[];
  /** The current HEAD commit SHA if git checks passed */
  base_commit: string | null;
}
