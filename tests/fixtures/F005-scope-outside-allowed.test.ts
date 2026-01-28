/**
 * F005: scope_violation_outside_allowed
 * 
 * Verify that editing files outside allowed_globs results in
 * STOP_SCOPE_VIOLATION_OUTSIDE_ALLOWED.
 */

import { describe, it, expect } from 'vitest';
import { checkScopeViolations, SCOPE_VIOLATION_OUTSIDE_ALLOWED } from '@/lib/scope.js';
import { createMockConfig, createMockTask } from '../helpers/mocks.js';

describe('F005: scope_violation_outside_allowed', () => {
  it('should detect STOP_SCOPE_VIOLATION_OUTSIDE_ALLOWED when file is outside allowed_globs', () => {
    const config = createMockConfig();
    const task = createMockTask('execute', {
      scope: {
        allowed_globs: ['src/**'],
        forbidden_globs: [],
        allow_new_files: false,
        allow_lockfile_changes: false,
      },
    });

    // Builder edits a file outside allowed_globs
    const touchedPaths = ['package.json'];
    const untrackedPaths: string[] = [];

    const result = checkScopeViolations(
      touchedPaths,
      untrackedPaths,
      task.scope,
      config
    );

    expect(result.ok).toBe(false);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0].type).toBe(SCOPE_VIOLATION_OUTSIDE_ALLOWED);
    expect(result.violations[0].path).toBe('package.json');
    expect(result.violations[0].detail).toContain('does not match any allowed glob pattern');
  });

  it('should allow files that match allowed_globs', () => {
    const config = createMockConfig();
    const task = createMockTask('execute', {
      scope: {
        allowed_globs: ['src/**'],
        forbidden_globs: [],
        allow_new_files: false,
        allow_lockfile_changes: false,
      },
    });

    // Builder edits a file inside allowed_globs
    const touchedPaths = ['src/utils.ts'];
    const untrackedPaths: string[] = [];

    const result = checkScopeViolations(
      touchedPaths,
      untrackedPaths,
      task.scope,
      config
    );

    expect(result.ok).toBe(true);
    expect(result.violations).toHaveLength(0);
  });

  it('should detect violations for multiple files outside allowed_globs', () => {
    const config = createMockConfig();
    const task = createMockTask('execute', {
      scope: {
        allowed_globs: ['src/**'],
        forbidden_globs: [],
        allow_new_files: false,
        allow_lockfile_changes: false,
      },
    });

    // Builder edits multiple files outside allowed_globs
    const touchedPaths = ['package.json', 'README.md', 'tsconfig.json'];
    const untrackedPaths: string[] = [];

    const result = checkScopeViolations(
      touchedPaths,
      untrackedPaths,
      task.scope,
      config
    );

    expect(result.ok).toBe(false);
    expect(result.violations.length).toBeGreaterThanOrEqual(1);
    expect(result.violations.every(v => v.type === SCOPE_VIOLATION_OUTSIDE_ALLOWED)).toBe(true);
  });

  it('should prioritize forbidden_globs over allowed_globs', () => {
    const config = createMockConfig();
    const task = createMockTask('execute', {
      scope: {
        allowed_globs: ['**/*.ts'],
        forbidden_globs: ['**/*.secret.ts'],
        allow_new_files: false,
        allow_lockfile_changes: false,
      },
    });

    // File matches both patterns, but forbidden takes precedence
    const touchedPaths = ['src/config.secret.ts'];
    const untrackedPaths: string[] = [];

    const result = checkScopeViolations(
      touchedPaths,
      untrackedPaths,
      task.scope,
      config
    );

    // Should detect forbidden violation, not outside_allowed
    expect(result.ok).toBe(false);
    expect(result.violations[0].type).not.toBe(SCOPE_VIOLATION_OUTSIDE_ALLOWED);
  });
});
