/**
 * Preflight checks for determining if a tick can safely start.
 *
 * Runs a series of checks and returns a PreflightResult indicating
 * whether execution can proceed or is blocked.
 */

import { stat, readdir, lstat, readlink } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import type { EnvoiConfig } from '../types/config.js';
import type { PreflightResult, BlockedCode } from '../types/preflight.js';
import { cleanupTmpFiles, isGlobPatternSafe } from './fs.js';
import { isGitRepo, isWorktreeCleanExcluding, getHeadCommit, getGitTopLevel, getTrackedSymlinkPaths } from './git.js';
import { readWorkspaceState } from './workspace_state.js';
import { resolveInWorkspace } from './paths.js';

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

function isPathInsideRoot(rootPath: string, candidatePath: string): boolean {
  const rel = relative(rootPath, candidatePath);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

async function findTrackedSymlinkEscapes(repoRoot: string, trackedSymlinkPaths: string[]): Promise<string[]> {
  const offenders: string[] = [];
  for (const relPath of trackedSymlinkPaths) {
    const linkPath = join(repoRoot, relPath);
    try {
      const stats = await lstat(linkPath);
      if (!stats.isSymbolicLink()) continue;
      const rawTarget = await readlink(linkPath);
      const resolvedTarget = resolve(dirname(linkPath), rawTarget);
      if (!isPathInsideRoot(repoRoot, resolvedTarget)) {
        offenders.push(`${relPath} -> ${rawTarget}`);
      }
    } catch {
      // Ignore missing/broken entries here; git/index integrity is handled elsewhere.
    }
  }
  return offenders;
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
 * @param config - The Envoi configuration
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
export async function runPreflight(config: EnvoiConfig): Promise<PreflightResult> {
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

    // 2. Check if worktree is clean (excluding runner-owned files)
    const worktreeStatus = isWorktreeCleanExcluding(config.runner.runner_owned_globs);
    if (!worktreeStatus.clean) {
      return blocked(
        'BLOCKED_DIRTY_WORKTREE',
        `Git worktree has uncommitted changes: ${worktreeStatus.dirtyFiles.join(', ')}`
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

    const repoRoot = getGitTopLevel();
    if (repoRoot) {
      const trackedSymlinks = getTrackedSymlinkPaths();
      const escapes = await findTrackedSymlinkEscapes(repoRoot, trackedSymlinks);
      if (escapes.length > 0) {
        const preview = escapes.slice(0, 5).join(', ');
        const suffix = escapes.length > 5 ? ` (+${escapes.length - 5} more)` : '';
        return blocked(
          'BLOCKED_MISSING_CONFIG',
          `Unsafe tracked symlink(s) escaping repository root: ${preview}${suffix}`
        );
      }
    }
  }

  // 3. Validate delete_tmp_glob pattern if configured
  const deleteGlob = config.runner.crash_cleanup?.delete_tmp_glob;
  if (deleteGlob && deleteGlob.trim() !== '') {
    const globSafety = isGlobPatternSafe(deleteGlob);
    if (!globSafety.safe) {
      return blocked(
        'BLOCKED_CRASH_RECOVERY_REQUIRED',
        `Unsafe delete_tmp_glob pattern: ${globSafety.reason}`
      );
    }
  }

  // 4. Cleanup .tmp files (crash artifacts)
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
    const historyPath = resolveInWorkspace(config.workspace_dir, config.history.dir);
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

  // 5. Budget hard-cap check
  // Read workspace state and check if any budget exceeds its per-milestone cap
  try {
    const state = await readWorkspaceState(config.workspace_dir);
    const caps = config.budgets.per_milestone;
    
    if (state.budgets.ticks >= caps.max_ticks) {
      return blocked(
        'BLOCKED_BUDGET_CAP',
        `Tick budget exceeded: ${state.budgets.ticks} >= ${caps.max_ticks}`
      );
    }
    if (state.budgets.orchestrator_calls >= caps.max_orchestrator_calls) {
      return blocked(
        'BLOCKED_BUDGET_CAP',
        `Orchestrator call budget exceeded: ${state.budgets.orchestrator_calls} >= ${caps.max_orchestrator_calls}`
      );
    }
    if (state.budgets.builder_calls >= caps.max_builder_calls) {
      return blocked(
        'BLOCKED_BUDGET_CAP',
        `Builder call budget exceeded: ${state.budgets.builder_calls} >= ${caps.max_builder_calls}`
      );
    }
    if (state.budgets.verify_runs >= caps.max_verify_runs) {
      return blocked(
        'BLOCKED_BUDGET_CAP',
        `Verify run budget exceeded: ${state.budgets.verify_runs} >= ${caps.max_verify_runs}`
      );
    }
    
    // Add warning if approaching any limit
    if (state.budget_warning) {
      warnings.push('Budget warning: approaching limit on one or more budget categories');
    }
  } catch (error) {
    // If we can't read state, add warning but don't block
    warnings.push(`Could not read workspace state for budget check: ${error instanceof Error ? error.message : String(error)}`);
  }

  return success(baseCommit, warnings);
}
