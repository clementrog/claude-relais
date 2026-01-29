/**
 * F014: identical_redispatch_rejected
 * 
 * Verify that task with fingerprint matching last_failed_fingerprint
 * is rejected with STOP_REDISPATCH_IDENTICAL_TASK.
 */

import { describe, it, expect } from 'vitest';
import { checkFingerprintMatch, type GuardrailState } from '@/lib/guardrails.js';
import { computeFingerprint } from '@/lib/fingerprint.js';
import { createMockTask } from '../helpers/mocks.js';

describe('F014: identical_redispatch_rejected', () => {
  it('should reject task when fingerprint matches last_failed_fingerprint', () => {
    const task = createMockTask('execute', {
      intent: 'Test task intent',
      scope: {
        allowed_globs: ['src/**'],
        forbidden_globs: ['.git/**'],
        allow_new_files: false,
        allow_lockfile_changes: false,
      },
      verification: {
        fast: ['lint'],
        slow: ['test'],
        params: {},
      },
    });

    // Compute fingerprint for the task
    const fingerprint = computeFingerprint(task as unknown as Record<string, unknown>);

    // Set state with matching last_failed_fingerprint
    const state: GuardrailState = {
      branch: 'task/wp-001',
      last_failed_fingerprint: fingerprint,
    };

    const result = checkFingerprintMatch(state, task);

    expect(result.ok).toBe(false);
    expect(result.stopCode).toBe('STOP_REDISPATCH_IDENTICAL_TASK');
    expect(result.reason).toContain('identical task re-dispatch detected');
  });

  it('should pass when fingerprint does not match last_failed_fingerprint', () => {
    const task = createMockTask('execute', {
      intent: 'Test task intent',
      scope: {
        allowed_globs: ['src/**'],
      },
    });

    const state: GuardrailState = {
      branch: 'task/wp-001',
      last_failed_fingerprint: 'different-fingerprint-abc123',
    };

    const result = checkFingerprintMatch(state, task);

    expect(result.ok).toBe(true);
  });

  it('should pass when last_failed_fingerprint is not set', () => {
    const task = createMockTask('execute', {
      intent: 'Test task intent',
    });

    const state: GuardrailState = {
      branch: 'task/wp-001',
      // last_failed_fingerprint is undefined
    };

    const result = checkFingerprintMatch(state, task);

    expect(result.ok).toBe(true);
  });

  it('should reject identical task even with different task_id', () => {
    const task1 = createMockTask('execute', {
      task_id: 'WP-001',
      intent: 'Test task intent',
      scope: {
        allowed_globs: ['src/**'],
      },
    });

    const task2 = createMockTask('execute', {
      task_id: 'WP-002', // Different task_id
      intent: 'Test task intent',
      scope: {
        allowed_globs: ['src/**'],
      },
    });

    // Compute fingerprint for first task
    const fingerprint1 = computeFingerprint(task1 as unknown as Record<string, unknown>);

    // Set state with fingerprint from first task
    const state: GuardrailState = {
      branch: 'task/wp-001',
      last_failed_fingerprint: fingerprint1,
    };

    // Check second task (same content, different task_id)
    const result = checkFingerprintMatch(state, task2);

    // Should be rejected because fingerprints match (task_id is excluded from fingerprint)
    expect(result.ok).toBe(false);
    expect(result.stopCode).toBe('STOP_REDISPATCH_IDENTICAL_TASK');
  });

  it('should allow task with modified goal (different fingerprint)', () => {
    const failedTask = createMockTask('execute', {
      goal: 'Original task goal',
      scope: {
        write: ['src/**'],
      },
    });

    const newTask = createMockTask('execute', {
      goal: 'Modified task goal', // Different goal
      scope: {
        write: ['src/**'],
      },
    });

    // Compute fingerprint for failed task
    const failedFingerprint = computeFingerprint(failedTask as unknown as Record<string, unknown>);

    const state: GuardrailState = {
      branch: 'task/wp-001',
      last_failed_fingerprint: failedFingerprint,
    };

    const result = checkFingerprintMatch(state, newTask);

    // Should pass because fingerprints differ
    expect(result.ok).toBe(true);
  });

  it('should allow task with modified scope (different fingerprint)', () => {
    const failedTask = createMockTask('execute', {
      goal: 'Test task goal',
      scope: {
        write: ['src/**'],
      },
    });

    const newTask = createMockTask('execute', {
      goal: 'Test task goal',
      scope: {
        write: ['src/**', 'tests/**'], // Different scope
      },
    });

    // Compute fingerprint for failed task
    const failedFingerprint = computeFingerprint(failedTask as unknown as Record<string, unknown>);

    const state: GuardrailState = {
      branch: 'task/wp-001',
      last_failed_fingerprint: failedFingerprint,
    };

    const result = checkFingerprintMatch(state, newTask);

    // Should pass because fingerprints differ
    expect(result.ok).toBe(true);
  });
});
