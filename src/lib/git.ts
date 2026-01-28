/**
 * Git helper functions for preflight checks and diff tracking.
 *
 * Uses execSync for git operations to ensure synchronous, blocking behavior.
 */

import { execSync } from 'node:child_process';

/**
 * Checks if the current directory is inside a git repository.
 *
 * @returns true if in a git repo, false otherwise
 *
 * @example
 * ```typescript
 * if (!isGitRepo()) {
 *   console.error('Not in a git repository');
 * }
 * ```
 */
export function isGitRepo(): boolean {
  try {
    execSync('git rev-parse --is-inside-work-tree', {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Checks if the git worktree is clean (no uncommitted tracked changes
 * AND no untracked files).
 *
 * A clean worktree means:
 * - No staged changes
 * - No unstaged changes to tracked files
 * - No untracked files
 *
 * @returns true if worktree is clean, false otherwise
 *
 * @example
 * ```typescript
 * if (!isWorktreeClean()) {
 *   console.error('Worktree has uncommitted changes');
 * }
 * ```
 */
export function isWorktreeClean(): boolean {
  try {
    // git status --porcelain returns empty if nothing to report
    // (no staged, unstaged, or untracked files)
    const status = execSync('git status --porcelain', {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return status.trim() === '';
  } catch {
    // If git status fails, assume not clean
    return false;
  }
}

/**
 * Gets the current HEAD commit SHA.
 *
 * @returns The full 40-character SHA of HEAD
 * @throws {Error} If not in a git repo or HEAD doesn't exist
 *
 * @example
 * ```typescript
 * const sha = getHeadCommit();
 * console.log(`Current commit: ${sha}`);
 * ```
 */
export function getHeadCommit(): string {
  try {
    const sha = execSync('git rev-parse HEAD', {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return sha.trim();
  } catch (error) {
    throw new Error(
      `Failed to get HEAD commit: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/**
 * Gets the list of files that have changed since a base commit.
 *
 * Returns both modified and added files in the diff.
 *
 * @param base - The base commit SHA to diff against
 * @returns Array of file paths that have changed
 * @throws {Error} If the diff operation fails
 *
 * @example
 * ```typescript
 * const changedFiles = getDiffFiles('abc123');
 * console.log(`${changedFiles.length} files changed`);
 * ```
 */
export function getDiffFiles(base: string): string[] {
  try {
    const output = execSync(`git diff --name-only ${base}`, {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return output
      .trim()
      .split('\n')
      .filter((line) => line.length > 0);
  } catch (error) {
    throw new Error(
      `Failed to get diff files from ${base}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/**
 * Gets the list of untracked files in the repository.
 *
 * @returns Array of untracked file paths
 *
 * @example
 * ```typescript
 * const untracked = getUntrackedFiles();
 * if (untracked.length > 0) {
 *   console.log(`Found ${untracked.length} untracked files`);
 * }
 * ```
 */
export function getUntrackedFiles(): string[] {
  try {
    // -u shows untracked files, --porcelain gives machine-readable output
    // Untracked files have ?? prefix
    const output = execSync('git status --porcelain', {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return output
      .trim()
      .split('\n')
      .filter((line) => line.startsWith('??'))
      .map((line) => line.substring(3)); // Remove "?? " prefix
  } catch {
    // If git status fails, return empty array
    return [];
  }
}
