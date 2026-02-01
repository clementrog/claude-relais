/**
 * Single source of truth for report codes.
 *
 * This file defines all valid report codes as a readonly const array.
 * Both TypeScript types and JSON schema should derive from this list.
 *
 * @see tests/schema/S003-schema-parity.test.ts - enforces parity with schema
 */

/**
 * All valid report codes.
 *
 * SUCCESS: Tick completed successfully
 * STOP_*: Tick stopped due to policy violation (can retry)
 * BLOCKED_*: Tick blocked by precondition failure (requires intervention)
 */
export const REPORT_CODES = [
  'SUCCESS',
  'STOP_SCOPE_VIOLATION_FORBIDDEN',
  'STOP_SCOPE_VIOLATION_OUTSIDE_ALLOWED',
  'STOP_SCOPE_VIOLATION_NEW_FILE',
  'STOP_LOCKFILE_CHANGE_FORBIDDEN',
  'STOP_DIFF_TOO_LARGE',
  'STOP_VERIFY_FAILED_FAST',
  'STOP_VERIFY_FAILED_SLOW',
  'STOP_VERIFY_TAINTED',
  'STOP_VERIFY_ONLY_SIDE_EFFECTS',
  'STOP_QUESTION_SIDE_EFFECTS',
  'STOP_RUNNER_OWNED_MUTATION',
  'STOP_BUILDER_OUTPUT_INVALID',
  'STOP_HEAD_MOVED',
  'STOP_INTERRUPTED',
  'STOP_REVIEWER_FORCED_PATCH',
  'STOP_REVIEWER_ASK_QUESTION',
  'STOP_REDISPATCH_IDENTICAL_TASK',
  'STOP_VERIFY_FLAKY_OR_TIMEOUT',
  'STOP_ORCHESTRATOR_TIMEOUT',
  'STOP_MERGE_DIRTY_WORKTREE',
  'STOP_BRANCH_MISMATCH',
  'STOP_EVIDENCE_INCOMPLETE',
  'BLOCKED_BUDGET_EXHAUSTED',
  'BLOCKED_BUDGET_CAP',
  'BLOCKED_DIRTY_WORKTREE',
  'BLOCKED_LOCK_HELD',
  'BLOCKED_CRASH_RECOVERY_REQUIRED',
  'BLOCKED_ORCHESTRATOR_OUTPUT_INVALID',
  'BLOCKED_HISTORY_CAP_CLEANUP_REQUIRED',
  'BLOCKED_MISSING_CONFIG',
  'BLOCKED_TRANSPORT_STALLED',
] as const;

/**
 * Type derived from the const array.
 */
export type ReportCode = typeof REPORT_CODES[number];

/**
 * Set for O(1) membership checks.
 */
export const REPORT_CODES_SET: ReadonlySet<string> = new Set(REPORT_CODES);

/**
 * Checks if a string is a valid report code.
 */
export function isValidReportCode(code: string): code is ReportCode {
  return REPORT_CODES_SET.has(code);
}
