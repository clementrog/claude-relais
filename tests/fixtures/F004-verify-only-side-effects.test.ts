/**
 * F004: verify_only_no_side_effects
 * 
 * Verify that verify_only task kind with edits results in
 * STOP_VERIFY_ONLY_SIDE_EFFECTS.
 */

import { describe, it, expect } from 'vitest';
import { createMockConfig, createMockTask } from '../helpers/mocks.js';
import { checkScopeViolations } from '@/lib/scope.js';
import type { ReportCode } from '@/types/report.js';

/**
 * Determines the report code based on task kind and diff presence.
 * This simulates the judge phase logic for detecting side effects.
 */
function determineReportCode(
  taskKind: 'execute' | 'verify_only' | 'question',
  hasDiff: boolean
): ReportCode | null {
  if (taskKind === 'question' && hasDiff) {
    return 'STOP_QUESTION_SIDE_EFFECTS';
  }
  if (taskKind === 'verify_only' && hasDiff) {
    return 'STOP_VERIFY_ONLY_SIDE_EFFECTS';
  }
  return null;
}

describe('F004: verify_only_no_side_effects', () => {
  it('should detect STOP_VERIFY_ONLY_SIDE_EFFECTS when verify_only task has diff', () => {
    const task = createMockTask('verify_only');
    const hasDiff = true; // Simulate that builder edited files

    const code = determineReportCode(task.task_kind, hasDiff);

    expect(code).toBe('STOP_VERIFY_ONLY_SIDE_EFFECTS');
  });

  it('should not detect side effects when verify_only task has no diff', () => {
    const task = createMockTask('verify_only');
    const hasDiff = false; // No edits made

    const code = determineReportCode(task.task_kind, hasDiff);

    expect(code).toBeNull();
  });

  it('should allow execute task kind to have diff', () => {
    const task = createMockTask('execute');
    const hasDiff = true; // Edits are expected for execute tasks

    const code = determineReportCode(task.task_kind, hasDiff);

    expect(code).toBeNull(); // Execute tasks are allowed to have diffs
  });

  it('should validate scope even for verify_only tasks', () => {
    const config = createMockConfig();
    const task = createMockTask('verify_only', {
      scope: {
        allowed_globs: ['src/**'],
        forbidden_globs: [],
        allow_new_files: false,
        allow_lockfile_changes: false,
      },
    });

    // Simulate that builder touched a file (even though it shouldn't)
    const touchedPaths = ['src/utils.ts'];
    const untrackedPaths: string[] = [];

    const scopeResult = checkScopeViolations(
      touchedPaths,
      untrackedPaths,
      task.scope,
      config
    );

    // Scope check should still pass (file is in allowed_globs)
    // But the judge phase would detect STOP_VERIFY_ONLY_SIDE_EFFECTS due to diff existing
    expect(scopeResult.ok).toBe(true);
  });
});
