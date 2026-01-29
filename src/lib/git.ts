/**
 * Git helper functions for preflight checks and diff tracking.
 *
 * Uses execSync for git operations to ensure synchronous, blocking behavior.
 */

import { execSync } from 'node:child_process';
import micromatch from 'micromatch';

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
 * Parses git status porcelain output and filters files based on exclusion globs.
 *
 * This is a pure function that can be easily tested.
 *
 * @param statusOutput - Raw output from `git status --porcelain`
 * @param excludeGlobs - Glob patterns for files to exclude from the dirty check
 * @returns Object with `clean` (boolean), `dirtyFiles`, and `excludedFiles`
 */
export function parseGitStatusWithExclusions(
  statusOutput: string,
  excludeGlobs: string[]
): { clean: boolean; dirtyFiles: string[]; excludedFiles: string[] } {
  // Only trim trailing whitespace to preserve leading space in status format
  const trimmed = statusOutput.trimEnd();
  if (trimmed === '') {
    return { clean: true, dirtyFiles: [], excludedFiles: [] };
  }

  // Parse git status output to get file paths
  // Format: XY filename (X=staged, Y=unstaged, ?? for untracked)
  // XY are positions 0-1, space at position 2, path starts at position 3
  const allFiles = trimmed
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => {
      // Git status porcelain format: XY PATH or XY ORIG -> PATH for renames
      // XY is always 2 chars, then a space, then the path
      // But some entries like copies/renames have different formats
      // Handle renamed/copied files: "R  old -> new" or "C  old -> new"
      const rawPath = line.slice(3); // Use slice instead of substring for clarity
      if (rawPath.includes(' -> ')) {
        return rawPath.split(' -> ')[1];
      }
      return rawPath;
    });

  // Separate excluded vs non-excluded files
  const excludedFiles: string[] = [];
  const dirtyFiles: string[] = [];

  for (const file of allFiles) {
    if (excludeGlobs.length > 0 && micromatch.isMatch(file, excludeGlobs)) {
      excludedFiles.push(file);
    } else {
      dirtyFiles.push(file);
    }
  }

  return {
    clean: dirtyFiles.length === 0,
    dirtyFiles,
    excludedFiles,
  };
}

/**
 * Checks if the git worktree is clean, excluding files matching specified globs.
 *
 * This is useful for ignoring runner-owned files (like REPORT.json, STATE.json)
 * that are expected to change every tick.
 *
 * @param excludeGlobs - Glob patterns for files to exclude from the dirty check
 * @returns Object with `clean` (boolean) and `dirtyFiles` (non-excluded dirty files)
 *
 * @example
 * ```typescript
 * const result = isWorktreeCleanExcluding(['relais/**', 'pilot/**']);
 * if (!result.clean) {
 *   console.error('Dirty files:', result.dirtyFiles);
 * }
 * ```
 */
export function isWorktreeCleanExcluding(
  excludeGlobs: string[]
): { clean: boolean; dirtyFiles: string[]; excludedFiles: string[] } {
  try {
    const status = execSync('git status --porcelain', {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    return parseGitStatusWithExclusions(status, excludeGlobs);
  } catch {
    // If git status fails, assume not clean
    return { clean: false, dirtyFiles: ['<git status failed>'], excludedFiles: [] };
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

/**
 * Gets the current git branch name.
 *
 * @returns The current branch name
 * @throws {Error} If not in a git repo or branch cannot be determined
 *
 * @example
 * ```typescript
 * const branch = getCurrentBranch();
 * console.log(`Current branch: ${branch}`);
 * ```
 */
export function getCurrentBranch(): string {
  try {
    const branch = execSync('git branch --show-current', {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return branch.trim();
  } catch (error) {
    throw new Error(
      `Failed to get current branch: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/**
 * Stashes pilot/ directory files to prevent merge conflicts.
 *
 * Creates a stash containing only files in the pilot/ directory.
 * This allows safe merging without losing pilot state.
 *
 * @returns The stash reference (e.g., "stash@{0}")
 * @throws {Error} If the stash operation fails
 *
 * @example
 * ```typescript
 * const stashRef = stashPilotFiles();
 * // Perform merge...
 * popPilotStash(stashRef);
 * ```
 */
export function stashPilotFiles(): string {
  try {
    // Stash only pilot/ directory files
    // --keep-index keeps staged changes, but we want to stash everything in pilot/
    // Using git stash push with pathspec to stash only pilot/ files
    const output = execSync('git stash push -m "relais: auto-stash pilot files" -- pilot/', {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    // Extract stash reference from output
    // Output format: "Saved working directory and index state On <branch>: <message>"
    // We need to get the stash ref, which is typically "stash@{0}" for the most recent stash
    const stashRef = execSync('git rev-parse --short stash@{0}', {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();

    // Return the full stash reference
    return 'stash@{0}';
  } catch (error) {
    // If stash push fails (e.g., no changes to stash), check if stash exists
    try {
      // Try to get the most recent stash
      execSync('git rev-parse --verify stash@{0} > /dev/null 2>&1', {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      return 'stash@{0}';
    } catch {
      throw new Error(
        `Failed to stash pilot files: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
}

/**
 * Pops a previously created stash to restore pilot files.
 *
 * Restores the stashed pilot/ directory files back to the working tree.
 *
 * @param stashRef - The stash reference returned by stashPilotFiles (e.g., "stash@{0}")
 * @throws {Error} If the stash pop operation fails
 *
 * @example
 * ```typescript
 * const stashRef = stashPilotFiles();
 * // Perform merge...
 * popPilotStash(stashRef);
 * ```
 */
export function popPilotStash(stashRef: string): void {
  try {
    execSync(`git stash pop ${stashRef}`, {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (error) {
    throw new Error(
      `Failed to pop pilot stash ${stashRef}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}
