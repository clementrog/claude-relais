/**
 * Scope enforcement utilities for validating file access against task scope.
 *
 * Provides functions to check if touched paths comply with task scope rules:
 * - Forbidden glob patterns
 * - Allowed glob patterns
 * - New file creation restrictions
 * - Lockfile change restrictions
 */

import micromatch from 'micromatch';
import type { TaskScope } from '../types/task.js';
import type { RelaisConfig } from '../types/config.js';

/**
 * Violation type identifiers.
 */
export const SCOPE_VIOLATION_FORBIDDEN = 'SCOPE_VIOLATION_FORBIDDEN';
export const SCOPE_VIOLATION_OUTSIDE_ALLOWED = 'SCOPE_VIOLATION_OUTSIDE_ALLOWED';
export const NEW_FILE_FORBIDDEN = 'NEW_FILE_FORBIDDEN';
export const LOCKFILE_CHANGE_FORBIDDEN = 'LOCKFILE_CHANGE_FORBIDDEN';

/**
 * Represents a single scope violation.
 */
export interface ScopeViolation {
  /** Violation type identifier */
  type: string;
  /** The path that violated scope */
  path: string;
  /** Human-readable explanation */
  detail: string;
}

/**
 * Result of scope checking operation.
 */
export interface ScopeCheckResult {
  /** True if no violations found */
  ok: boolean;
  /** List of violations found */
  violations: ScopeViolation[];
  /** All paths that were checked */
  touched_paths: string[];
}

/**
 * Checks if a path matches any of the given glob patterns.
 *
 * @param path - The file path to check
 * @param patterns - Array of glob patterns to match against
 * @returns True if path matches any pattern, false otherwise
 *
 * @example
 * ```typescript
 * matchesGlob('src/utils.ts', ['src/**', '*.ts']); // true
 * matchesGlob('test/file.js', ['src/**']); // false
 * ```
 */
export function matchesGlob(path: string, patterns: string[]): boolean {
  if (patterns.length === 0) {
    return false;
  }
  return micromatch.isMatch(path, patterns);
}

/**
 * Checks if a path is a lockfile based on config.scope.lockfiles list.
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
 * Checks all touched paths against task scope rules and returns violations.
 *
 * Validates:
 * - No paths match forbidden_globs
 * - All paths match at least one allowed_globs pattern
 * - No new files when allow_new_files=false
 * - No lockfile changes when allow_lockfile_changes=false
 *
 * @param touchedPaths - All file paths that were touched (modified or created)
 * @param untrackedPaths - Subset of touchedPaths that are new/untracked files
 * @param taskScope - Scope configuration from the task
 * @param config - Full Relais configuration (for lockfiles list)
 * @returns ScopeCheckResult with violations and status
 *
 * @example
 * ```typescript
 * const result = checkScopeViolations(
 *   ['src/utils.ts', 'src/new.ts'],
 *   ['src/new.ts'],
 *   {
 *     allowed_globs: ['src/**'],
 *     forbidden_globs: ['*.key'],
 *     allow_new_files: false,
 *     allow_lockfile_changes: true
 *   },
 *   config
 * );
 * if (!result.ok) {
 *   console.error('Scope violations:', result.violations);
 * }
 * ```
 */
export function checkScopeViolations(
  touchedPaths: string[],
  untrackedPaths: string[],
  taskScope: TaskScope,
  config: RelaisConfig
): ScopeCheckResult {
  const violations: ScopeViolation[] = [];
  const untrackedSet = new Set(untrackedPaths);

  for (const path of touchedPaths) {
    // Check forbidden globs
    if (matchesGlob(path, taskScope.forbidden_globs)) {
      violations.push({
        type: SCOPE_VIOLATION_FORBIDDEN,
        path,
        detail: `Path "${path}" matches forbidden glob pattern(s): ${taskScope.forbidden_globs.join(', ')}`,
      });
      continue; // Don't check other rules for forbidden paths
    }

    // Check allowed globs (path must match at least one)
    if (taskScope.allowed_globs.length > 0 && !matchesGlob(path, taskScope.allowed_globs)) {
      violations.push({
        type: SCOPE_VIOLATION_OUTSIDE_ALLOWED,
        path,
        detail: `Path "${path}" does not match any allowed glob pattern(s): ${taskScope.allowed_globs.join(', ')}`,
      });
    }

    // Check new file restrictions
    if (!taskScope.allow_new_files && untrackedSet.has(path)) {
      violations.push({
        type: NEW_FILE_FORBIDDEN,
        path,
        detail: `New file "${path}" created but allow_new_files is false`,
      });
    }

    // Check lockfile change restrictions
    if (!taskScope.allow_lockfile_changes && isLockfile(path, config.scope.lockfiles)) {
      violations.push({
        type: LOCKFILE_CHANGE_FORBIDDEN,
        path,
        detail: `Lockfile "${path}" was modified but allow_lockfile_changes is false`,
      });
    }
  }

  return {
    ok: violations.length === 0,
    violations,
    touched_paths: touchedPaths,
  };
}
