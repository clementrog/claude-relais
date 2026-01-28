/**
 * F007: new_file_rejected
 * 
 * Verify that creating new files when allow_new_files=false results in
 * STOP_SCOPE_VIOLATION_NEW_FILE.
 */

import { describe, it, expect } from 'vitest';
import { checkScopeViolations, NEW_FILE_FORBIDDEN } from '@/lib/scope.js';
import { createMockConfig, createMockTask } from '../helpers/mocks.js';

describe('F007: new_file_rejected', () => {
  it('should detect STOP_SCOPE_VIOLATION_NEW_FILE when allow_new_files=false and new file created', () => {
    const config = createMockConfig();
    const task = createMockTask('execute', {
      scope: {
        allowed_globs: ['src/**'],
        forbidden_globs: [],
        allow_new_files: false,
        allow_lockfile_changes: false,
      },
    });

    // Builder creates a new file
    const touchedPaths = ['src/new.ts'];
    const untrackedPaths = ['src/new.ts']; // This is a new/untracked file

    const result = checkScopeViolations(
      touchedPaths,
      untrackedPaths,
      task.scope,
      config
    );

    expect(result.ok).toBe(false);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0].type).toBe(NEW_FILE_FORBIDDEN);
    expect(result.violations[0].path).toBe('src/new.ts');
    expect(result.violations[0].detail).toContain('allow_new_files is false');
  });

  it('should allow new files when allow_new_files=true', () => {
    const config = createMockConfig();
    const task = createMockTask('execute', {
      scope: {
        allowed_globs: ['src/**'],
        forbidden_globs: [],
        allow_new_files: true,
        allow_lockfile_changes: false,
      },
    });

    // Builder creates a new file
    const touchedPaths = ['src/new.ts'];
    const untrackedPaths = ['src/new.ts'];

    const result = checkScopeViolations(
      touchedPaths,
      untrackedPaths,
      task.scope,
      config
    );

    expect(result.ok).toBe(true);
    expect(result.violations).toHaveLength(0);
  });

  it('should detect violation for multiple new files when allow_new_files=false', () => {
    const config = createMockConfig();
    const task = createMockTask('execute', {
      scope: {
        allowed_globs: ['src/**'],
        forbidden_globs: [],
        allow_new_files: false,
        allow_lockfile_changes: false,
      },
    });

    // Builder creates multiple new files
    const touchedPaths = ['src/file1.ts', 'src/file2.ts', 'src/file3.ts'];
    const untrackedPaths = ['src/file1.ts', 'src/file2.ts', 'src/file3.ts'];

    const result = checkScopeViolations(
      touchedPaths,
      untrackedPaths,
      task.scope,
      config
    );

    expect(result.ok).toBe(false);
    expect(result.violations.length).toBe(3);
    expect(result.violations.every(v => v.type === NEW_FILE_FORBIDDEN)).toBe(true);
  });

  it('should not flag modified existing files as new files', () => {
    const config = createMockConfig();
    const task = createMockTask('execute', {
      scope: {
        allowed_globs: ['src/**'],
        forbidden_globs: [],
        allow_new_files: false,
        allow_lockfile_changes: false,
      },
    });

    // Builder modifies an existing file (not in untrackedPaths)
    const touchedPaths = ['src/existing.ts'];
    const untrackedPaths: string[] = []; // Empty - file already exists

    const result = checkScopeViolations(
      touchedPaths,
      untrackedPaths,
      task.scope,
      config
    );

    expect(result.ok).toBe(true);
    expect(result.violations).toHaveLength(0);
  });
});
