/**
 * Judge phase: Compute touched files from git diff.
 *
 * Provides functions to analyze git changes and categorize files
 * for scope guardrail enforcement.
 */

import { execSync } from 'node:child_process';
import micromatch from 'micromatch';
import type { TaskScope } from '../types/task.js';
import type { ScopeConfig } from '../types/config.js';
import type { ReportCode } from '../types/report.js';

/**
 * Categorized list of files touched since a base commit.
 */
export interface TouchedFiles {
  /** Files that were modified */
  modified: string[];
  /** Files that were added */
  added: string[];
  /** Files that were deleted */
  deleted: string[];
  /** Files that were renamed (with old and new paths) */
  renamed: Array<{ from: string; to: string }>;
  /** Files that are untracked (new files not yet committed) */
  untracked: string[];
  /** Union of all file paths (excluding deleted files) */
  all: string[];
}

/**
 * Parsed result from git diff --name-status output.
 */
interface ParsedDiffStatus {
  modified: string[];
  added: string[];
  deleted: string[];
  renamed: Array<{ from: string; to: string }>;
}

/**
 * Parses git diff --name-status output into categorized file lists.
 *
 * Git diff --name-status format:
 * - M <path> - Modified
 * - A <path> - Added
 * - D <path> - Deleted
 * - R<score> <old> <new> - Renamed (tab-separated, e.g., R100\told\tnew)
 *
 * This is a pure function that can be easily tested.
 *
 * @param output - Raw output from `git diff --name-status <base>...HEAD`
 * @returns Object with categorized file lists
 *
 * @example
 * ```typescript
 * const diffOutput = 'M\tfile1.ts\nA\tfile2.ts\nR100\told.ts\tnew.ts\n';
 * const result = parseGitDiffNameStatus(diffOutput);
 * // result.modified = ['file1.ts']
 * // result.added = ['file2.ts']
 * // result.renamed = [{ from: 'old.ts', to: 'new.ts' }]
 * ```
 */
export function parseGitDiffNameStatus(output: string): ParsedDiffStatus {
  const modified: string[] = [];
  const added: string[] = [];
  const deleted: string[] = [];
  const renamed: Array<{ from: string; to: string }> = [];

  const trimmed = output.trim();
  if (trimmed === '') {
    return { modified, added, deleted, renamed };
  }

  const lines = trimmed.split('\n').filter((line) => line.length > 0);

  for (const line of lines) {
    // Handle renamed files: R<score>\t<old>\t<new>
    // The similarity score can be 0-100, so we check if line starts with R
    if (line.startsWith('R')) {
      // Split by tab to get: [R<score>, old, new]
      const parts = line.split('\t');
      if (parts.length >= 3) {
        const from = parts[1];
        const to = parts[2];
        renamed.push({ from, to });
      }
      continue;
    }

    // For other status codes, format is: <code>\t<path>
    const parts = line.split('\t');
    if (parts.length < 2) {
      continue;
    }

    const status = parts[0];
    const path = parts[1];

    switch (status) {
      case 'M':
        modified.push(path);
        break;
      case 'A':
        added.push(path);
        break;
      case 'D':
        deleted.push(path);
        break;
      // Ignore other status codes (C for copy, etc.)
    }
  }

  return { modified, added, deleted, renamed };
}

/**
 * Gets all files touched since a base commit using git diff --name-status
 * and git status --porcelain.
 *
 * Combines:
 * - Tracked file changes (modified, added, deleted, renamed) from git diff
 * - Untracked files from git status
 *
 * @param baseCommit - The base commit SHA to diff against (e.g., 'main' or commit hash)
 * @returns TouchedFiles object with categorized file lists
 * @throws {Error} If git commands fail
 *
 * @example
 * ```typescript
 * const touched = getTouchedFiles('main');
 * console.log(`Modified: ${touched.modified.length}`);
 * console.log(`All files: ${touched.all.join(', ')}`);
 * ```
 */
export function getTouchedFiles(baseCommit: string): TouchedFiles {
  // Get tracked file changes from git diff
  let diffStatus: ParsedDiffStatus;
  try {
    const diffOutput = execSync(`git diff --name-status ${baseCommit}...HEAD`, {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    diffStatus = parseGitDiffNameStatus(diffOutput);
  } catch (error) {
    throw new Error(
      `Failed to get git diff from ${baseCommit}: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  // Get untracked files from git status
  let untracked: string[] = [];
  try {
    const statusOutput = execSync('git status --porcelain', {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    // Untracked files have ?? prefix
    untracked = statusOutput
      .trim()
      .split('\n')
      .filter((line) => line.startsWith('??'))
      .map((line) => line.substring(3).trim()); // Remove "?? " prefix
  } catch (error) {
    // If git status fails, continue without untracked files
    // (this is less critical than diff failure)
  }

  // Compute union of all file paths (excluding deleted files)
  const all: string[] = [
    ...diffStatus.modified,
    ...diffStatus.added,
    ...diffStatus.renamed.map((r) => r.to),
    ...untracked,
  ];

  return {
    modified: diffStatus.modified,
    added: diffStatus.added,
    deleted: diffStatus.deleted,
    renamed: diffStatus.renamed,
    untracked,
    all,
  };
}

/**
 * Result of scope violation checking.
 */
export interface ScopeCheckResult {
  /** True if no violations found */
  ok: boolean;
  /** Stop code if violation found, null otherwise */
  stopCode: ReportCode | null;
  /** List of file paths that caused the violation */
  violatingFiles: string[];
  /** Human-readable reason for the violation */
  reason: string | null;
}

/**
 * Checks if a path matches any of the given glob patterns.
 *
 * @param path - The file path to check
 * @param patterns - Array of glob patterns to match against
 * @returns True if path matches any pattern, false otherwise
 */
function matchesGlob(path: string, patterns: string[]): boolean {
  if (patterns.length === 0) {
    return false;
  }
  return micromatch.isMatch(path, patterns);
}

/**
 * Checks if a path is a lockfile based on scopeConfig.lockfiles list.
 *
 * @param path - The file path to check
 * @param lockfiles - Array of lockfile names/patterns
 * @returns True if path matches any lockfile pattern
 */
function isLockfile(path: string, lockfiles: string[]): boolean {
  if (lockfiles.length === 0) {
    return false;
  }
  // Check if path ends with any lockfile name, or matches lockfile globs
  return lockfiles.some((lockfile) => {
    // If lockfile is a simple name (e.g., "package-lock.json"), check if path ends with it
    if (!lockfile.includes('/') && !lockfile.includes('*')) {
      return path.endsWith(lockfile);
    }
    // Otherwise, treat as glob pattern
    return micromatch.isMatch(path, [lockfile]);
  });
}

/**
 * Checks touched files against scope rules and returns first violation or success.
 *
 * Checks are performed in priority order:
 * 1. Runner-owned mutation (highest priority)
 * 2. Forbidden globs
 * 3. Outside allowed globs
 * 4. New file when not allowed
 * 5. Lockfile change when not allowed
 *
 * Returns the first violation found, or success if no violations.
 *
 * @param touched - TouchedFiles object with categorized file lists
 * @param taskScope - Task scope configuration with allowed/forbidden globs and permissions
 * @param scopeConfig - Scope configuration with lockfiles list
 * @param runnerOwnedGlobs - Glob patterns for files owned by the runner
 * @returns ScopeCheckResult with stopCode and violatingFiles
 *
 * @example
 * ```typescript
 * const result = checkScopeViolations(
 *   { modified: ['src/utils.ts'], added: ['src/new.ts'], deleted: [], renamed: [], untracked: ['src/new.ts'], all: ['src/utils.ts', 'src/new.ts'] },
 *   { allowed_globs: ['src/**'], forbidden_globs: ['*.key'], allow_new_files: false, allow_lockfile_changes: true },
 *   { lockfiles: ['package-lock.json'], default_allowed_globs: [], default_forbidden_globs: [], default_allow_new_files: true, default_allow_lockfile_changes: false },
 *   ['pilot/**']
 * );
 * if (!result.ok) {
 *   console.error(`Violation: ${result.stopCode}`, result.violatingFiles);
 * }
 * ```
 */
export function checkScopeViolations(
  touched: TouchedFiles,
  taskScope: TaskScope,
  scopeConfig: ScopeConfig,
  runnerOwnedGlobs: string[]
): ScopeCheckResult {
  // Get all touched paths (excluding deleted files)
  const allPaths = touched.all;
  const untrackedSet = new Set(touched.untracked);
  const newFilesSet = new Set([...touched.added, ...touched.untracked, ...touched.renamed.map((r) => r.to)]);

  // Check 1: Runner-owned mutation (highest priority)
  const runnerOwnedViolations: string[] = [];
  for (const path of allPaths) {
    if (matchesGlob(path, runnerOwnedGlobs)) {
      runnerOwnedViolations.push(path);
    }
  }
  if (runnerOwnedViolations.length > 0) {
    return {
      ok: false,
      stopCode: 'STOP_RUNNER_OWNED_MUTATION',
      violatingFiles: runnerOwnedViolations,
      reason: `Files match runner-owned globs: ${runnerOwnedViolations.join(', ')}`,
    };
  }

  // Check 2: Forbidden globs
  const forbiddenViolations: string[] = [];
  for (const path of allPaths) {
    if (matchesGlob(path, taskScope.forbidden_globs)) {
      forbiddenViolations.push(path);
    }
  }
  if (forbiddenViolations.length > 0) {
    return {
      ok: false,
      stopCode: 'STOP_SCOPE_VIOLATION_FORBIDDEN',
      violatingFiles: forbiddenViolations,
      reason: `Files match forbidden glob patterns: ${forbiddenViolations.join(', ')}`,
    };
  }

  // Check 3: Outside allowed globs
  if (taskScope.allowed_globs.length > 0) {
    const outsideAllowedViolations: string[] = [];
    for (const path of allPaths) {
      if (!matchesGlob(path, taskScope.allowed_globs)) {
        outsideAllowedViolations.push(path);
      }
    }
    if (outsideAllowedViolations.length > 0) {
      return {
        ok: false,
        stopCode: 'STOP_SCOPE_VIOLATION_OUTSIDE_ALLOWED',
        violatingFiles: outsideAllowedViolations,
        reason: `Files do not match any allowed glob pattern: ${outsideAllowedViolations.join(', ')}`,
      };
    }
  }

  // Check 4: New file when not allowed
  if (!taskScope.allow_new_files) {
    const newFileViolations: string[] = [];
    for (const path of allPaths) {
      if (newFilesSet.has(path)) {
        newFileViolations.push(path);
      }
    }
    if (newFileViolations.length > 0) {
      return {
        ok: false,
        stopCode: 'STOP_SCOPE_VIOLATION_NEW_FILE',
        violatingFiles: newFileViolations,
        reason: `New files created but allow_new_files is false: ${newFileViolations.join(', ')}`,
      };
    }
  }

  // Check 5: Lockfile change when not allowed
  if (!taskScope.allow_lockfile_changes) {
    const lockfileViolations: string[] = [];
    for (const path of allPaths) {
      if (isLockfile(path, scopeConfig.lockfiles)) {
        lockfileViolations.push(path);
      }
    }
    if (lockfileViolations.length > 0) {
      return {
        ok: false,
        stopCode: 'STOP_LOCKFILE_CHANGE_FORBIDDEN',
        violatingFiles: lockfileViolations,
        reason: `Lockfiles modified but allow_lockfile_changes is false: ${lockfileViolations.join(', ')}`,
      };
    }
  }

  // No violations found
  return {
    ok: true,
    stopCode: null,
    violatingFiles: [],
    reason: null,
  };
}
