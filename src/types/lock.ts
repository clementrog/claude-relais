/**
 * Lock mechanism type definitions.
 *
 * These types support the lock acquisition/release system that prevents
 * concurrent relais runs and enables safe lock reclaim after crashes.
 */

/**
 * Information stored in the lock file.
 *
 * This structure enables crash-safe lock reclaim by storing enough
 * information to determine if the lock holder is still running.
 */
export interface LockInfo {
  /** Process ID that holds the lock */
  pid: number;
  /** ISO timestamp when lock was acquired */
  started_at: string;
  /** Unique identifier for the current boot session */
  boot_id: string;
}
