/**
 * Rollback utilities to restore repository to base_commit state.
 *
 * Used when Judge detects violations (scope, diff limits, etc.) to reset
 * tracked files and remove only the untracked files that were touched by the builder.
 */

import { execSync } from 'node:child_process';
import { unlink, rm } from 'node:fs/promises';
import { stat } from 'node:fs/promises';

/**
 * Result of a rollback operation.
 */
export interface RollbackResult {
  /**
   * True if rollback completed successfully.
   */
  success: boolean;

  /**
   * Whether git reset succeeded.
   */
  tracked_reset: boolean;

  /**
   * Untracked paths that were removed.
   */
  paths_removed: string[];

  /**
   * Any errors encountered during rollback.
   */
  errors: string[];
}

/**
 * Resets tracked files to a specific base commit using git reset --hard.
 *
 * @param baseCommit - The commit SHA to reset to
 * @returns Object indicating success and any errors
 *
 * @example
 * ```typescript
 * const result = rollbackTracked('abc123');
 * if (!result.tracked_reset) {
 *   console.error('Failed to reset tracked files');
 * }
 * ```
 */
export function rollbackTracked(baseCommit: string): {
  tracked_reset: boolean;
  errors: string[];
} {
  const errors: string[] = [];

  try {
    execSync(`git reset --hard ${baseCommit}`, {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { tracked_reset: true, errors: [] };
  } catch (error) {
    const errorMsg = `Failed to reset tracked files to ${baseCommit}: ${
      error instanceof Error ? error.message : String(error)
    }`;
    errors.push(errorMsg);
    return { tracked_reset: false, errors };
  }
}

/**
 * Removes specific untracked files and directories.
 *
 * Handles errors gracefully (file already removed, permission issues, etc.)
 * and continues removing other paths even if some fail.
 *
 * @param paths - Array of file or directory paths to remove
 * @returns Object with list of successfully removed paths and any errors
 *
 * @example
 * ```typescript
 * const result = await removeUntrackedPaths(['temp.txt', 'build/']);
 * console.log(`Removed ${result.paths_removed.length} paths`);
 * ```
 */
export async function removeUntrackedPaths(paths: string[]): Promise<{
  paths_removed: string[];
  errors: string[];
}> {
  const paths_removed: string[] = [];
  const errors: string[] = [];

  for (const path of paths) {
    try {
      // Check if path exists and is a directory
      const stats = await stat(path);
      const isDirectory = stats.isDirectory();

      if (isDirectory) {
        // Use rm with recursive for directories
        await rm(path, { recursive: true, force: true });
      } else {
        // Use unlink for files
        await unlink(path);
      }

      paths_removed.push(path);
    } catch (error) {
      // Handle errors gracefully - file may already be removed, permission issues, etc.
      const errorMsg = `Failed to remove ${path}: ${
        error instanceof Error ? error.message : String(error)
      }`;

      // Check if it's a "file not found" error (ENOENT) - this is acceptable
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        // File/directory doesn't exist - consider it already removed, but don't add to paths_removed
        // since we didn't actually remove it
        continue;
      }

      errors.push(errorMsg);
    }
  }

  return { paths_removed, errors };
}

/**
 * Performs a full rollback operation: resets tracked files to base_commit
 * and removes specified untracked paths.
 *
 * @param baseCommit - The commit SHA to reset tracked files to
 * @param untrackedPaths - Array of untracked file/directory paths to remove
 * @returns RollbackResult with complete status of the operation
 *
 * @example
 * ```typescript
 * const result = await rollback('abc123', ['temp.txt', 'build/']);
 * if (result.success) {
 *   console.log('Rollback completed successfully');
 * }
 * ```
 */
export async function rollback(
  baseCommit: string,
  untrackedPaths: string[]
): Promise<RollbackResult> {
  const errors: string[] = [];

  // Step 1: Reset tracked files
  const trackedResult = rollbackTracked(baseCommit);
  errors.push(...trackedResult.errors);

  // Step 2: Remove untracked paths
  const untrackedResult = await removeUntrackedPaths(untrackedPaths);
  errors.push(...untrackedResult.errors);

  // Rollback is considered successful if tracked files were reset
  // (untracked removal errors are less critical)
  const success = trackedResult.tracked_reset && errors.length === 0;

  return {
    success,
    tracked_reset: trackedResult.tracked_reset,
    paths_removed: untrackedResult.paths_removed,
    errors,
  };
}
