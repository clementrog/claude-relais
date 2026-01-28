/**
 * Preflight checks for determining if a tick can safely start.
 *
 * Runs a series of checks and returns a PreflightResult indicating
 * whether execution can proceed or is blocked.
 */

import { stat, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { RelaisConfig } from '../types/config.js';
import type { PreflightResult, BlockedCode } from '../types/preflight.js';
import { cleanupTmpFiles } from './fs.js';
import { isGitRepo, isWorktreeClean, getHeadCommit } from './git.js';

/**
 * Creates a blocked PreflightResult with the given code and reason.
 */
function blocked(
  code: BlockedCode,
  reason: string,
  warnings: string[] = []
): PreflightResult {
  return {
    ok: false,
    blocked_code: code,
    blocked_reason: reason,
    warnings,
    base_commit: null,
  };
}

/**
 * Creates a successful PreflightResult.
 */
function success(baseCommit: string | null, warnings: string[] = []): PreflightResult {
  return {
    ok: true,
    blocked_code: null,
    blocked_reason: null,
    warnings,
    base_commit: baseCommit,
  };
}

/**
 * Calculates the total size of a directory in bytes.
 *
 * @param dirPath - Path to the directory
 * @returns Total size in bytes, or 0 if directory doesn't exist
 */
async function getDirectorySize(dirPath: string): Promise<number> {
  let totalSize = 0;

  try {
    const entries = await readdir(dirPath, { withFileTypes: true });

    for (const entry of entries) {
      const entryPath = join(dirPath, entry.name);

      if (entry.isFile()) {
        try {
          const stats = await stat(entryPath);
          totalSize += stats.size;
        } catch {
          // Skip files we can't stat
        }
      } else if (entry.isDirectory()) {
        // Recursively calculate subdirectory size
        totalSize += await getDirectorySize(entryPath);
      }
    }
  } catch {
    // Directory doesn't exist or can't be read
    return 0;
  }

  return totalSize;
}

/**
 * Runs all preflight checks to determine if a tick can safely start.
 *
 * Checks are run in order, returning immediately on BLOCKED:
 * 1. Git repo exists (if config.runner.require_git)
 * 2. Worktree is clean (no uncommitted changes)
 * 3. Cleanup .tmp files under config.workspace_dir
 * 4. Check history size (vs config.history.max_mb)
 * 5. Budget check (placeholder - returns warning for now)
 *
 * @param config - The Relais configuration
 * @returns PreflightResult indicating success or blocked state
 *
 * @example
 * ```typescript
 * const result = await runPreflight(config);
 * if (!result.ok) {
 *   console.error(`Blocked: ${result.blocked_code}: ${result.blocked_reason}`);
 *   process.exit(1);
 * }
 * console.log(`Preflight passed, base commit: ${result.base_commit}`);
 * ```
 */
export async function runPreflight(config: RelaisConfig): Promise<PreflightResult> {
  const warnings: string[] = [];
  let baseCommit: string | null = null;

  // 1. Check if git repo exists (if required)
  if (config.runner.require_git) {
    if (!isGitRepo()) {
      return blocked(
        'BLOCKED_MISSING_CONFIG',
        'Not inside a git repository (require_git is enabled)'
      );
    }

    // 2. Check if worktree is clean
    if (!isWorktreeClean()) {
      return blocked(
        'BLOCKED_DIRTY_WORKTREE',
        'Git worktree has uncommitted changes or untracked files'
      );
    }

    // Get base commit for tracking changes
    try {
      baseCommit = getHeadCommit();
    } catch (error) {
      return blocked(
        'BLOCKED_MISSING_CONFIG',
        `Failed to get HEAD commit: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  // 3. Cleanup .tmp files (crash artifacts)
  try {
    const deleted = await cleanupTmpFiles(config.workspace_dir);
    if (deleted.length > 0) {
      warnings.push(`Cleaned up ${deleted.length} stale .tmp file(s): ${deleted.join(', ')}`);
    }
  } catch (error) {
    // If cleanup fails, it might indicate a crash recovery issue
    // For now, just add a warning - the directory might not exist yet
    warnings.push(
      `Could not cleanup tmp files in ${config.workspace_dir}: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  // 4. Check history size vs cap
  if (config.history.enabled) {
    const historyPath = join(config.workspace_dir, config.history.dir);
    const historySizeBytes = await getDirectorySize(historyPath);
    const historySizeMb = historySizeBytes / (1024 * 1024);
    const maxMb = config.history.max_mb;

    if (historySizeMb >= maxMb) {
      return blocked(
        'BLOCKED_HISTORY_CAP_CLEANUP_REQUIRED',
        `History directory (${historySizeMb.toFixed(2)} MB) exceeds cap (${maxMb} MB). Manual cleanup required.`
      );
    }

    // Warn if approaching limit (>80%)
    const warnThreshold = maxMb * 0.8;
    if (historySizeMb >= warnThreshold) {
      warnings.push(
        `History size (${historySizeMb.toFixed(2)} MB) is approaching cap (${maxMb} MB)`
      );
    }
  }

  // 5. Budget check (placeholder - return warning for now)
  // Full budget checking will be implemented when milestone tracking is complete
  warnings.push('Budget checking is not yet implemented - proceeding without budget verification');

  return success(baseCommit, warnings);
}
