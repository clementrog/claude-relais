/**
 * Judge phase: Compute touched files from git diff.
 *
 * Provides functions to analyze git changes and categorize files
 * for scope guardrail enforcement.
 */

import { execSync } from 'node:child_process';

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
