/**
 * Tests for src/lib/state.ts - Retry state management functions.
 */

import { describe, it, expect } from 'vitest';
import {
  incrementRetryCount,
  recordTransportStall,
  resetRetryState,
  createInitialState,
} from '@/lib/state.js';
import type { TickState } from '@/types/state.js';
import type { RelaisConfig } from '@/types/config.js';

const mockConfig: RelaisConfig = {
  v: 1,
  workspace_dir: './relais',
  prompts: {
    orchestrator_system: 'orchestrator.system.txt',
    orchestrator_user: 'orchestrator.user.txt',
    builder_system: 'builder.system.txt',
    builder_user: 'builder.user.txt',
  },
  schemas: {
    task: 'task.schema.json',
    builder_result: 'builder_result.schema.json',
    report: 'report.schema.json',
  },
  scope: {
    allowed_globs: ['src/**'],
    forbidden_globs: ['.git/**'],
    allow_new_files: true,
    allow_lockfile_changes: false,
  },
  diff_limits: {
    max_files_touched: 20,
    max_lines_changed: 500,
  },
  verify: [],
  runner_owned_globs: ['relais/**'],
};

function createTestState(): TickState {
  return createInitialState(mockConfig, 'abc123def');
}

describe('incrementRetryCount', () => {
  it('should increment retry_count from 0 to 1', () => {
    const state = createTestState();
    expect(state.retry_count).toBeUndefined();

    const updated = incrementRetryCount(state);

    expect(updated.retry_count).toBe(1);
  });

  it('should increment retry_count from 1 to 2', () => {
    const state = { ...createTestState(), retry_count: 1 };

    const updated = incrementRetryCount(state);

    expect(updated.retry_count).toBe(2);
  });

  it('should increment retry_count from 2 to 3', () => {
    const state = { ...createTestState(), retry_count: 2 };

    const updated = incrementRetryCount(state);

    expect(updated.retry_count).toBe(3);
  });

  it('should preserve other state fields', () => {
    const state = {
      ...createTestState(),
      last_error_kind: 'transport_stalled',
      last_request_id: 'req-123',
    };

    const updated = incrementRetryCount(state);

    expect(updated.last_error_kind).toBe('transport_stalled');
    expect(updated.last_request_id).toBe('req-123');
  });
});

describe('recordTransportStall', () => {
  it('should set error kind and request ID', () => {
    const state = createTestState();

    const updated = recordTransportStall(state, 'transport_stalled', 'req-456');

    expect(updated.last_error_kind).toBe('transport_stalled');
    expect(updated.last_request_id).toBe('req-456');
  });

  it('should increment retry_count', () => {
    const state = createTestState();
    expect(state.retry_count).toBeUndefined();

    const updated = recordTransportStall(state, 'transport_stalled', 'req-123');

    expect(updated.retry_count).toBe(1);
  });

  it('should handle null request ID', () => {
    const state = createTestState();

    const updated = recordTransportStall(state, 'transport_stalled', null);

    expect(updated.last_error_kind).toBe('transport_stalled');
    expect(updated.last_request_id).toBeNull();
  });

  it('should increment existing retry_count', () => {
    const state = { ...createTestState(), retry_count: 2 };

    const updated = recordTransportStall(state, 'transport_stalled', 'req-789');

    expect(updated.retry_count).toBe(3);
  });

  it('should preserve other state fields', () => {
    const state = {
      ...createTestState(),
      failure_streak: 1,
      task_fingerprint: 'fp-abc',
    };

    const updated = recordTransportStall(state, 'transport_stalled', 'req-123');

    expect(updated.failure_streak).toBe(1);
    expect(updated.task_fingerprint).toBe('fp-abc');
  });
});

describe('resetRetryState', () => {
  it('should clear retry_count', () => {
    const state = { ...createTestState(), retry_count: 3 };

    const updated = resetRetryState(state);

    expect(updated.retry_count).toBe(0);
  });

  it('should clear last_error_kind', () => {
    const state = { ...createTestState(), last_error_kind: 'transport_stalled' };

    const updated = resetRetryState(state);

    expect(updated.last_error_kind).toBeUndefined();
  });

  it('should clear last_request_id', () => {
    const state = { ...createTestState(), last_request_id: 'req-123' };

    const updated = resetRetryState(state);

    expect(updated.last_request_id).toBeUndefined();
  });

  it('should clear all retry fields at once', () => {
    const state = {
      ...createTestState(),
      retry_count: 2,
      last_error_kind: 'transport_stalled',
      last_request_id: 'req-456',
    };

    const updated = resetRetryState(state);

    expect(updated.retry_count).toBe(0);
    expect(updated.last_error_kind).toBeUndefined();
    expect(updated.last_request_id).toBeUndefined();
  });

  it('should preserve other state fields', () => {
    const state = {
      ...createTestState(),
      retry_count: 2,
      failure_streak: 1,
      task_fingerprint: 'fp-abc',
    };

    const updated = resetRetryState(state);

    expect(updated.failure_streak).toBe(1);
    expect(updated.task_fingerprint).toBe('fp-abc');
  });

  it('should work on state without retry fields', () => {
    const state = createTestState();

    const updated = resetRetryState(state);

    expect(updated.retry_count).toBe(0);
    expect(updated.last_error_kind).toBeUndefined();
    expect(updated.last_request_id).toBeUndefined();
  });
});
