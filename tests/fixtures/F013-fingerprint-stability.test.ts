/**
 * F013: fingerprint_stability
 * 
 * Verify that same task content produces same fingerprint across runs.
 * Fingerprint should be deterministic and stable for identical task content.
 */

import { describe, it, expect } from 'vitest';
import { computeFingerprint, canonicalizeTask } from '@/lib/fingerprint.js';
import { createMockTask } from '../helpers/mocks.js';

describe('F013: fingerprint_stability', () => {
  it('should produce same fingerprint for identical task content across multiple runs', () => {
    const task1 = createMockTask('execute', {
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

    const task2 = createMockTask('execute', {
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

    const fingerprint1 = computeFingerprint(task1 as unknown as Record<string, unknown>);
    const fingerprint2 = computeFingerprint(task2 as unknown as Record<string, unknown>);

    expect(fingerprint1).toBe(fingerprint2);
    expect(fingerprint1.length).toBe(64); // SHA-256 hex string length
  });

  it('should produce same fingerprint regardless of field order', () => {
    const task1 = {
      intent: 'Test task',
      scope: {
        allowed_globs: ['src/**'],
        forbidden_globs: ['.git/**'],
      },
      verification: {
        fast: ['lint'],
        slow: ['test'],
      },
    };

    const task2 = {
      scope: {
        forbidden_globs: ['.git/**'],
        allowed_globs: ['src/**'],
      },
      verification: {
        slow: ['test'],
        fast: ['lint'],
      },
      intent: 'Test task',
    };

    const fingerprint1 = computeFingerprint(task1 as unknown as Record<string, unknown>);
    const fingerprint2 = computeFingerprint(task2 as unknown as Record<string, unknown>);

    expect(fingerprint1).toBe(fingerprint2);
  });

  it('should produce same fingerprint with whitespace differences', () => {
    const task1 = {
      intent: '  Test task  ',
      scope: {
        allowed_globs: ['src/**'],
      },
    };

    const task2 = {
      intent: 'Test task',
      scope: {
        allowed_globs: ['src/**'],
      },
    };

    const fingerprint1 = computeFingerprint(task1 as unknown as Record<string, unknown>);
    const fingerprint2 = computeFingerprint(task2 as unknown as Record<string, unknown>);

    expect(fingerprint1).toBe(fingerprint2);
  });

  it('should produce different fingerprints for different task content', () => {
    const task1 = createMockTask('execute', {
      goal: 'Test task goal',
      scope: {
        write: ['src/**'],
      },
    });

    const task2 = createMockTask('execute', {
      goal: 'Different task goal',
      scope: {
        write: ['src/**'],
      },
    });

    const fingerprint1 = computeFingerprint(task1 as unknown as Record<string, unknown>);
    const fingerprint2 = computeFingerprint(task2 as unknown as Record<string, unknown>);

    expect(fingerprint1).not.toBe(fingerprint2);
  });

  it('should produce same canonical form for identical tasks', () => {
    const task1 = {
      intent: 'Test task',
      scope: {
        allowed_globs: ['src/**'],
        forbidden_globs: ['.git/**'],
      },
    };

    const task2 = {
      scope: {
        forbidden_globs: ['.git/**'],
        allowed_globs: ['src/**'],
      },
      intent: 'Test task',
    };

    const canonical1 = canonicalizeTask(task1 as unknown as Record<string, unknown>);
    const canonical2 = canonicalizeTask(task2 as unknown as Record<string, unknown>);

    expect(canonical1).toBe(canonical2);
  });

  it('should exclude task_id and other non-fingerprint fields', () => {
    const task1 = {
      task_id: 'WP-001',
      intent: 'Test task',
      scope: {
        allowed_globs: ['src/**'],
      },
    };

    const task2 = {
      task_id: 'WP-002', // Different task_id
      intent: 'Test task',
      scope: {
        allowed_globs: ['src/**'],
      },
    };

    const fingerprint1 = computeFingerprint(task1 as unknown as Record<string, unknown>);
    const fingerprint2 = computeFingerprint(task2 as unknown as Record<string, unknown>);

    // Fingerprints should be same because task_id is excluded
    expect(fingerprint1).toBe(fingerprint2);
  });
});
