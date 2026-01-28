/**
 * F008: lockfile_change_rejected
 * 
 * Verify that changing lockfiles when allow_lockfile_changes=false results in
 * STOP_LOCKFILE_CHANGE_FORBIDDEN.
 */

import { describe, it, expect } from 'vitest';
import { checkScopeViolations, LOCKFILE_CHANGE_FORBIDDEN } from '@/lib/scope.js';
import { createMockConfig, createMockTask } from '../helpers/mocks.js';

describe('F008: lockfile_change_rejected', () => {
  it('should detect STOP_LOCKFILE_CHANGE_FORBIDDEN when allow_lockfile_changes=false and lockfile changed', () => {
    const config = createMockConfig({
      scope: {
        default_allowed_globs: ['**'],
        default_forbidden_globs: [],
        default_allow_new_files: true,
        default_allow_lockfile_changes: false,
        lockfiles: ['pnpm-lock.yaml', 'package-lock.json', 'yarn.lock'],
      },
    });
    const task = createMockTask('execute', {
      scope: {
        allowed_globs: ['**'],
        forbidden_globs: [],
        allow_new_files: true,
        allow_lockfile_changes: false,
      },
    });

    // Builder changes a lockfile
    const touchedPaths = ['pnpm-lock.yaml'];
    const untrackedPaths: string[] = []; // Lockfile already exists, just modified

    const result = checkScopeViolations(
      touchedPaths,
      untrackedPaths,
      task.scope,
      config
    );

    expect(result.ok).toBe(false);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0].type).toBe(LOCKFILE_CHANGE_FORBIDDEN);
    expect(result.violations[0].path).toBe('pnpm-lock.yaml');
    expect(result.violations[0].detail).toContain('allow_lockfile_changes is false');
  });

  it('should allow lockfile changes when allow_lockfile_changes=true', () => {
    const config = createMockConfig({
      scope: {
        default_allowed_globs: ['**'],
        default_forbidden_globs: [],
        default_allow_new_files: true,
        default_allow_lockfile_changes: true,
        lockfiles: ['pnpm-lock.yaml'],
      },
    });
    const task = createMockTask('execute', {
      scope: {
        allowed_globs: ['**'],
        forbidden_globs: [],
        allow_new_files: true,
        allow_lockfile_changes: true,
      },
    });

    // Builder changes a lockfile
    const touchedPaths = ['pnpm-lock.yaml'];
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

  it('should detect violation for package-lock.json', () => {
    const config = createMockConfig({
      scope: {
        default_allowed_globs: ['**'],
        default_forbidden_globs: [],
        default_allow_new_files: true,
        default_allow_lockfile_changes: false,
        lockfiles: ['package-lock.json'],
      },
    });
    const task = createMockTask('execute', {
      scope: {
        allowed_globs: ['**'],
        forbidden_globs: [],
        allow_new_files: true,
        allow_lockfile_changes: false,
      },
    });

    const touchedPaths = ['package-lock.json'];
    const untrackedPaths: string[] = [];

    const result = checkScopeViolations(
      touchedPaths,
      untrackedPaths,
      task.scope,
      config
    );

    expect(result.ok).toBe(false);
    expect(result.violations[0].type).toBe(LOCKFILE_CHANGE_FORBIDDEN);
    expect(result.violations[0].path).toBe('package-lock.json');
  });

  it('should detect violation for yarn.lock', () => {
    const config = createMockConfig({
      scope: {
        default_allowed_globs: ['**'],
        default_forbidden_globs: [],
        default_allow_new_files: true,
        default_allow_lockfile_changes: false,
        lockfiles: ['yarn.lock'],
      },
    });
    const task = createMockTask('execute', {
      scope: {
        allowed_globs: ['**'],
        forbidden_globs: [],
        allow_new_files: true,
        allow_lockfile_changes: false,
      },
    });

    const touchedPaths = ['yarn.lock'];
    const untrackedPaths: string[] = [];

    const result = checkScopeViolations(
      touchedPaths,
      untrackedPaths,
      task.scope,
      config
    );

    expect(result.ok).toBe(false);
    expect(result.violations[0].type).toBe(LOCKFILE_CHANGE_FORBIDDEN);
    expect(result.violations[0].path).toBe('yarn.lock');
  });

  it('should not flag non-lockfile files', () => {
    const config = createMockConfig({
      scope: {
        default_allowed_globs: ['**'],
        default_forbidden_globs: [],
        default_allow_new_files: true,
        default_allow_lockfile_changes: false,
        lockfiles: ['pnpm-lock.yaml'],
      },
    });
    const task = createMockTask('execute', {
      scope: {
        allowed_globs: ['**'],
        forbidden_globs: [],
        allow_new_files: true,
        allow_lockfile_changes: false,
      },
    });

    // Builder changes a regular file
    const touchedPaths = ['package.json'];
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
});
