/**
 * F006: forbidden_path_violation
 * 
 * Verify that editing forbidden paths (runner-owned or forbidden_globs)
 * results in STOP_RUNNER_OWNED_MUTATION or STOP_SCOPE_VIOLATION_FORBIDDEN.
 */

import { describe, it, expect } from 'vitest';
import { checkScopeViolations, SCOPE_VIOLATION_FORBIDDEN } from '@/lib/scope.js';
import { matchesGlob } from '@/lib/scope.js';
import { createMockConfig, createMockTask } from '../helpers/mocks.js';

/**
 * Checks if a path matches runner-owned globs.
 * This simulates the judge phase logic for detecting runner-owned mutations.
 */
function isRunnerOwnedPath(path: string, runnerOwnedGlobs: string[]): boolean {
  return matchesGlob(path, runnerOwnedGlobs);
}

describe('F006: forbidden_path_violation', () => {
  it('should detect STOP_RUNNER_OWNED_MUTATION for runner-owned paths', () => {
    const config = createMockConfig();
    const runnerOwnedGlobs = config.runner.runner_owned_globs;

    // Builder edits a runner-owned file
    const touchedPath = 'relais/STATE.json';
    const isRunnerOwned = isRunnerOwnedPath(touchedPath, runnerOwnedGlobs);

    expect(isRunnerOwned).toBe(true);
  });

  it('should detect STOP_SCOPE_VIOLATION_FORBIDDEN for paths matching forbidden_globs', () => {
    const config = createMockConfig();
    const task = createMockTask('execute', {
      scope: {
        allowed_globs: ['src/**'],
        forbidden_globs: ['.git/**', '**/.env*'],
        allow_new_files: false,
        allow_lockfile_changes: false,
      },
    });

    // Builder edits a forbidden file
    const touchedPaths = ['.git/config'];
    const untrackedPaths: string[] = [];

    const result = checkScopeViolations(
      touchedPaths,
      untrackedPaths,
      task.scope,
      config
    );

    expect(result.ok).toBe(false);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0].type).toBe(SCOPE_VIOLATION_FORBIDDEN);
    expect(result.violations[0].path).toBe('.git/config');
  });

  it('should detect runner-owned mutation for relais/REPORT.json', () => {
    const config = createMockConfig();
    const runnerOwnedGlobs = config.runner.runner_owned_globs;

    const touchedPath = 'relais/REPORT.json';
    const isRunnerOwned = isRunnerOwnedPath(touchedPath, runnerOwnedGlobs);

    expect(isRunnerOwned).toBe(true);
  });

  it('should detect runner-owned mutation for files under relais/history/', () => {
    const config = createMockConfig();
    const runnerOwnedGlobs = config.runner.runner_owned_globs;

    const touchedPath = 'relais/history/2025-01-28/run-001.json';
    const isRunnerOwned = isRunnerOwnedPath(touchedPath, runnerOwnedGlobs);

    expect(isRunnerOwned).toBe(true);
  });

  it('should detect forbidden violation for .env files', () => {
    const config = createMockConfig();
    const task = createMockTask('execute', {
      scope: {
        allowed_globs: ['src/**'],
        forbidden_globs: ['**/.env*'],
        allow_new_files: false,
        allow_lockfile_changes: false,
      },
    });

    const touchedPaths = ['.env.local'];
    const untrackedPaths: string[] = [];

    const result = checkScopeViolations(
      touchedPaths,
      untrackedPaths,
      task.scope,
      config
    );

    expect(result.ok).toBe(false);
    expect(result.violations[0].type).toBe(SCOPE_VIOLATION_FORBIDDEN);
  });

  it('should prioritize forbidden_globs check over allowed_globs', () => {
    const config = createMockConfig();
    const task = createMockTask('execute', {
      scope: {
        allowed_globs: ['**/*'],
        forbidden_globs: ['**/.env*'],
        allow_new_files: false,
        allow_lockfile_changes: false,
      },
    });

    // File matches allowed pattern but also matches forbidden
    const touchedPaths = ['.env'];
    const untrackedPaths: string[] = [];

    const result = checkScopeViolations(
      touchedPaths,
      untrackedPaths,
      task.scope,
      config
    );

    expect(result.ok).toBe(false);
    expect(result.violations[0].type).toBe(SCOPE_VIOLATION_FORBIDDEN);
    // Should not check outside_allowed after finding forbidden
    expect(result.violations.every(v => v.type !== 'SCOPE_VIOLATION_OUTSIDE_ALLOWED')).toBe(true);
  });
});
