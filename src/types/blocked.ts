/**
 * Types for BLOCKED.json generation when preflight checks fail.
 *
 * When the runner cannot safely start, it writes BLOCKED.json explaining
 * the exact remediation required.
 */

/**
 * Data structure for BLOCKED.json file.
 */
export interface BlockedData {
  /** ISO datetime when the block occurred */
  blocked_at: string;
  /** The specific BLOCKED_* code indicating why execution is blocked */
  code: string;
  /** Human-readable explanation of why execution is blocked */
  reason: string;
  /** Actionable instructions for what the user should do to fix the issue */
  remediation: string;
}
