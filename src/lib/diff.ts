/**
 * Git diff analysis functions for computing touched set.
 *
 * Used by Judge phase to compute the touched set (all files modified by builder)
 * based on git reality, not builder's self-report.
 */

import { execSync } from 'node:child_process';

/**
 * Analysis result of git diff operations.
 */
export interface DiffAnalysis {
  /** Total files in touched set */
  files_touched: number;
  /** Total lines added */
  lines_added: number;
  /** Total lines deleted */
  lines_deleted: number;
  /** Count of newly created files */
  new_files: number;
  /** All paths in touched set (tracked + untracked) */
  touched_paths: string[];
}

/**
 * Result of checking diff limits.
 */
export interface DiffLimitCheckResult {
  /** True if within limits, false if limits exceeded */
  ok: boolean;
  /** Actual files touched */
  files_touched: number;
  /** Actual lines changed (added + deleted) */
  lines_changed: number;
  /** Maximum files limit from task */
  max_files: number;
  /** Maximum lines limit from task */
  max_lines: number;
  /** Description of violation if limits exceeded, null otherwise */
  violation: string | null;
}

/**
 * Gets tracked files that have changed since a base commit.
 *
 * Uses `git diff --name-status` to get all tracked changes.
 * Parses status codes: A=added, M=modified, D=deleted, R=renamed.
 *
 * @param baseCommit - The base commit SHA to diff against
 * @returns Array of file paths that have changed
 * @throws {Error} If the diff operation fails
 *
 * @example
 * ```typescript
 * const paths = getTouchedTracked('abc123');
 * console.log(`${paths.length} tracked files changed`);
 * ```
 */
export function getTouchedTracked(baseCommit: string): string[] {
  try {
    const output = execSync(`git diff --name-status ${baseCommit}..HEAD`, {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    if (!output.trim()) {
      return [];
    }

    return output
      .trim()
      .split('\n')
      .map((line) => {
        // Parse format: STATUS\tpath or STATUS\told_path\tnew_path (for renames)
        const parts = line.split('\t');
        if (parts.length >= 2) {
          // For renames (R), return the new path
          // For others, return the path
          return parts.length === 3 ? parts[2] : parts[1];
        }
        return '';
      })
      .filter((path) => path.length > 0);
  } catch (error) {
    throw new Error(
      `Failed to get touched tracked files from ${baseCommit}: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
}

/**
 * Gets untracked files that are new or modified.
 *
 * Uses `git status --porcelain` and filters for:
 * - Lines starting with `??` (untracked files)
 * - Lines starting with `A` (added files in index, but also catches untracked)
 *
 * @returns Array of untracked file paths
 *
 * @example
 * ```typescript
 * const untracked = getTouchedUntracked();
 * console.log(`${untracked.length} untracked files`);
 * ```
 */
export function getTouchedUntracked(): string[] {
  try {
    const output = execSync('git status --porcelain', {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    if (!output.trim()) {
      return [];
    }

    return output
      .trim()
      .split('\n')
      .filter((line) => {
        // Filter for untracked files (??) or added files (A)
        const status = line.substring(0, 2);
        return status === '??' || status.startsWith('A');
      })
      .map((line) => {
        // Remove status prefix (2 chars + space)
        return line.substring(3);
      })
      .filter((path) => path.length > 0);
  } catch {
    // If git status fails, return empty array
    return [];
  }
}

/**
 * Gets line statistics (added/deleted) for changes since a base commit.
 *
 * Uses `git diff --numstat` to get line counts.
 * Handles binary files which show `- -` instead of numbers.
 *
 * @param baseCommit - The base commit SHA to diff against
 * @returns Object with lines_added and lines_deleted totals
 * @throws {Error} If the diff operation fails
 *
 * @example
 * ```typescript
 * const stats = getDiffStats('abc123');
 * console.log(`Added: ${stats.lines_added}, Deleted: ${stats.lines_deleted}`);
 * ```
 */
export function getDiffStats(baseCommit: string): {
  lines_added: number;
  lines_deleted: number;
} {
  try {
    const output = execSync(`git diff --numstat ${baseCommit}..HEAD`, {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    if (!output.trim()) {
      return { lines_added: 0, lines_deleted: 0 };
    }

    let lines_added = 0;
    let lines_deleted = 0;

    output
      .trim()
      .split('\n')
      .forEach((line) => {
        const parts = line.split('\t');
        if (parts.length >= 2) {
          const added = parts[0];
          const deleted = parts[1];

          // Handle binary files which show "-" instead of numbers
          if (added !== '-' && !isNaN(Number(added))) {
            lines_added += Number(added);
          }
          if (deleted !== '-' && !isNaN(Number(deleted))) {
            lines_deleted += Number(deleted);
          }
        }
      });

    return { lines_added, lines_deleted };
  } catch (error) {
    throw new Error(
      `Failed to get diff stats from ${baseCommit}: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
}

/**
 * Analyzes git diff to compute the complete touched set.
 *
 * Combines tracked changes, untracked files, and line statistics
 * into a complete DiffAnalysis object.
 *
 * @param baseCommit - The base commit SHA to diff against
 * @returns Complete DiffAnalysis with all metrics
 * @throws {Error} If any git operation fails
 *
 * @example
 * ```typescript
 * const analysis = analyzeDiff('abc123');
 * console.log(`Touched ${analysis.files_touched} files`);
 * console.log(`Added ${analysis.lines_added} lines`);
 * ```
 */
export function analyzeDiff(baseCommit: string): DiffAnalysis {
  const trackedPaths = getTouchedTracked(baseCommit);
  const untrackedPaths = getTouchedUntracked();
  const stats = getDiffStats(baseCommit);

  // Combine all touched paths
  const allPaths = [...new Set([...trackedPaths, ...untrackedPaths])];

  // Count new files: files that are added (A) in tracked changes
  // plus all untracked files
  let newFilesCount = untrackedPaths.length;
  try {
    const nameStatusOutput = execSync(
      `git diff --name-status ${baseCommit}..HEAD`,
      {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      }
    );

    if (nameStatusOutput.trim()) {
      const addedFiles = nameStatusOutput
        .trim()
        .split('\n')
        .filter((line) => line.startsWith('A\t') || line.startsWith('A\t'))
        .length;
      newFilesCount += addedFiles;
    }
  } catch {
    // If this fails, we already have untracked count
  }

  return {
    files_touched: allPaths.length,
    lines_added: stats.lines_added,
    lines_deleted: stats.lines_deleted,
    new_files: newFilesCount,
    touched_paths: allPaths.sort(),
  };
}

/**
 * Checks if diff analysis exceeds task diff limits.
 *
 * Compares files_touched against max_files_touched and lines_changed
 * (added + deleted) against max_lines_changed.
 *
 * @param analysis - The diff analysis result
 * @param limits - The diff limits from the task
 * @returns DiffLimitCheckResult with ok status and violation details
 *
 * @example
 * ```typescript
 * const analysis = analyzeDiff('abc123');
 * const limits = { max_files_touched: 10, max_lines_changed: 100 };
 * const result = checkDiffLimits(analysis, limits);
 * if (!result.ok) {
 *   console.error(`Violation: ${result.violation}`);
 * }
 * ```
 */
export function checkDiffLimits(
  analysis: DiffAnalysis,
  limits: { max_files_touched: number; max_lines_changed: number }
): DiffLimitCheckResult {
  const lines_changed = analysis.lines_added + analysis.lines_deleted;
  const filesExceeded = analysis.files_touched > limits.max_files_touched;
  const linesExceeded = lines_changed > limits.max_lines_changed;

  let violation: string | null = null;
  if (filesExceeded && linesExceeded) {
    violation = `Files touched (${analysis.files_touched}) exceeds limit (${limits.max_files_touched}) and lines changed (${lines_changed}) exceeds limit (${limits.max_lines_changed})`;
  } else if (filesExceeded) {
    violation = `Files touched (${analysis.files_touched}) exceeds limit (${limits.max_files_touched})`;
  } else if (linesExceeded) {
    violation = `Lines changed (${lines_changed}) exceeds limit (${limits.max_lines_changed})`;
  }

  return {
    ok: !filesExceeded && !linesExceeded,
    files_touched: analysis.files_touched,
    lines_changed,
    max_files: limits.max_files_touched,
    max_lines: limits.max_lines_changed,
    violation,
  };
}

/**
 * Formats blast radius summary string from diff analysis.
 *
 * Format: "<files_touched> files, +<lines_added>/-<lines_deleted>, <new_files> new"
 *
 * @param analysis - The diff analysis result
 * @returns Formatted blast radius summary string
 *
 * @example
 * ```typescript
 * const analysis = analyzeDiff('abc123');
 * const summary = formatBlastRadius(analysis);
 * // "5 files, +120/-30, 2 new"
 * ```
 */
export function formatBlastRadius(analysis: DiffAnalysis): string {
  return `${analysis.files_touched} files, +${analysis.lines_added}/-${analysis.lines_deleted}, ${analysis.new_files} new`;
}
