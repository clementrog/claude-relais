/**
 * Tests for src/lib/tick.ts - Tick runner stall handling and retry policy.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  handleTransportStall,
  checkAndHandleStall,
  formatStallResult,
  getRetryAction,
  computeRetryDecision,
  computeDegradedSettings,
  canRetry,
  formatRetryDecision,
  MAX_RETRY_ATTEMPTS,
  type StallHandlingResult,
} from '@/lib/tick.js';
import { createTransportStallError } from '@/lib/transport.js';
import type { TransportStallError } from '@/types/preflight.js';

// Mock git and rollback modules
vi.mock('@/lib/git.js', () => ({
  isWorktreeClean: vi.fn(),
  getHeadCommit: vi.fn(),
}));

vi.mock('@/lib/rollback.js', () => ({
  rollbackToCommit: vi.fn(),
  verifyCleanWorktree: vi.fn(),
}));

import { isWorktreeClean } from '@/lib/git.js';
import { rollbackToCommit } from '@/lib/rollback.js';

const mockIsWorktreeClean = vi.mocked(isWorktreeClean);
const mockRollbackToCommit = vi.mocked(rollbackToCommit);

describe('handleTransportStall', () => {
  const baseCommit = 'abc123def456';

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should return BLOCKED_TRANSPORT_STALLED status', async () => {
    mockIsWorktreeClean.mockReturnValue(true);
    const stallError = createTransportStallError('BUILD', 'Connection stalled', 'req-123');

    const result = await handleTransportStall(stallError, baseCommit);

    expect(result.status).toBe('BLOCKED');
    expect(result.blockedCode).toBe('BLOCKED_TRANSPORT_STALLED');
  });

  it('should include stage from stall error', async () => {
    mockIsWorktreeClean.mockReturnValue(true);
    const stallError = createTransportStallError('ORCHESTRATE', 'Timeout');

    const result = await handleTransportStall(stallError, baseCommit);

    expect(result.stage).toBe('ORCHESTRATE');
  });

  it('should include request_id from stall error', async () => {
    mockIsWorktreeClean.mockReturnValue(true);
    const stallError = createTransportStallError('BUILD', 'Error', 'my-request-id');

    const result = await handleTransportStall(stallError, baseCommit);

    expect(result.requestId).toBe('my-request-id');
  });

  it('should include raw_error from stall error', async () => {
    mockIsWorktreeClean.mockReturnValue(true);
    const stallError = createTransportStallError('BUILD', 'Connection stalled message');

    const result = await handleTransportStall(stallError, baseCommit);

    expect(result.rawError).toBe('Connection stalled message');
  });

  it('should not rollback when worktree is clean', async () => {
    mockIsWorktreeClean.mockReturnValue(true);
    const stallError = createTransportStallError('BUILD', 'Error');

    const result = await handleTransportStall(stallError, baseCommit);

    expect(result.wasDirty).toBe(false);
    expect(result.rollbackPerformed).toBe(false);
    expect(result.rollbackResult).toBeNull();
    expect(mockRollbackToCommit).not.toHaveBeenCalled();
  });

  it('should rollback when worktree is dirty', async () => {
    mockIsWorktreeClean.mockReturnValue(false);
    mockRollbackToCommit.mockReturnValue({
      ok: true,
      restoredCommit: baseCommit,
      removedFiles: [],
      error: null,
    });
    const stallError = createTransportStallError('BUILD', 'Error');

    const result = await handleTransportStall(stallError, baseCommit);

    expect(result.wasDirty).toBe(true);
    expect(result.rollbackPerformed).toBe(true);
    expect(result.rollbackResult).not.toBeNull();
    expect(mockRollbackToCommit).toHaveBeenCalledWith(baseCommit);
  });

  it('should skip rollback when option is set', async () => {
    mockIsWorktreeClean.mockReturnValue(false);
    const stallError = createTransportStallError('BUILD', 'Error');

    const result = await handleTransportStall(stallError, baseCommit, { skipRollback: true });

    expect(result.wasDirty).toBe(true);
    expect(result.rollbackPerformed).toBe(false);
    expect(result.rollbackResult).toBeNull();
    expect(mockRollbackToCommit).not.toHaveBeenCalled();
  });

  it('should include baseCommit in result', async () => {
    mockIsWorktreeClean.mockReturnValue(true);
    const stallError = createTransportStallError('BUILD', 'Error');

    const result = await handleTransportStall(stallError, baseCommit);

    expect(result.baseCommit).toBe(baseCommit);
  });

  it('should handle rollback failure', async () => {
    mockIsWorktreeClean.mockReturnValue(false);
    mockRollbackToCommit.mockReturnValue({
      ok: false,
      restoredCommit: null,
      removedFiles: [],
      error: 'Rollback failed',
    });
    const stallError = createTransportStallError('BUILD', 'Error');

    const result = await handleTransportStall(stallError, baseCommit);

    expect(result.wasDirty).toBe(true);
    expect(result.rollbackPerformed).toBe(false);
    expect(result.rollbackResult?.ok).toBe(false);
  });
});

describe('checkAndHandleStall', () => {
  const baseCommit = 'abc123def456';

  beforeEach(() => {
    vi.clearAllMocks();
    mockIsWorktreeClean.mockReturnValue(true);
  });

  it('should return null when no stall error', async () => {
    const result = await checkAndHandleStall(null, baseCommit);
    expect(result).toBeNull();
  });

  it('should handle stall when error is provided', async () => {
    const stallError = createTransportStallError('BUILD', 'Connection stalled');

    const result = await checkAndHandleStall(stallError, baseCommit);

    expect(result).not.toBeNull();
    expect(result?.blockedCode).toBe('BLOCKED_TRANSPORT_STALLED');
  });

  it('should pass options through to handleTransportStall', async () => {
    mockIsWorktreeClean.mockReturnValue(false);
    const stallError = createTransportStallError('BUILD', 'Error');

    const result = await checkAndHandleStall(stallError, baseCommit, { skipRollback: true });

    expect(result?.rollbackPerformed).toBe(false);
    expect(mockRollbackToCommit).not.toHaveBeenCalled();
  });
});

describe('formatStallResult', () => {
  it('should format basic stall result', () => {
    const result: StallHandlingResult = {
      status: 'BLOCKED',
      blockedCode: 'BLOCKED_TRANSPORT_STALLED',
      stage: 'BUILD',
      requestId: null,
      rawError: 'Connection stalled',
      rollbackPerformed: false,
      rollbackResult: null,
      wasDirty: false,
      baseCommit: 'abc123',
    };

    const formatted = formatStallResult(result);

    expect(formatted).toContain('Transport stall detected during BUILD');
    expect(formatted).toContain('BLOCKED_TRANSPORT_STALLED');
    expect(formatted).toContain('Connection stalled');
  });

  it('should include request ID when present', () => {
    const result: StallHandlingResult = {
      status: 'BLOCKED',
      blockedCode: 'BLOCKED_TRANSPORT_STALLED',
      stage: 'ORCHESTRATE',
      requestId: 'req-12345',
      rawError: 'Error',
      rollbackPerformed: false,
      rollbackResult: null,
      wasDirty: false,
      baseCommit: 'abc123',
    };

    const formatted = formatStallResult(result);

    expect(formatted).toContain('Request ID: req-12345');
  });

  it('should indicate rollback performed', () => {
    const result: StallHandlingResult = {
      status: 'BLOCKED',
      blockedCode: 'BLOCKED_TRANSPORT_STALLED',
      stage: 'BUILD',
      requestId: null,
      rawError: 'Error',
      rollbackPerformed: true,
      rollbackResult: { ok: true, restoredCommit: 'abc123', removedFiles: [], error: null },
      wasDirty: true,
      baseCommit: 'abc123def',
    };

    const formatted = formatStallResult(result);

    expect(formatted).toContain('Rollback: performed to abc123d');
  });

  it('should indicate rollback not needed when clean', () => {
    const result: StallHandlingResult = {
      status: 'BLOCKED',
      blockedCode: 'BLOCKED_TRANSPORT_STALLED',
      stage: 'BUILD',
      requestId: null,
      rawError: 'Error',
      rollbackPerformed: false,
      rollbackResult: null,
      wasDirty: false,
      baseCommit: 'abc123',
    };

    const formatted = formatStallResult(result);

    expect(formatted).toContain('not needed (repo was clean)');
  });

  it('should truncate long error messages', () => {
    const result: StallHandlingResult = {
      status: 'BLOCKED',
      blockedCode: 'BLOCKED_TRANSPORT_STALLED',
      stage: 'BUILD',
      requestId: null,
      rawError: 'A'.repeat(200),
      rollbackPerformed: false,
      rollbackResult: null,
      wasDirty: false,
      baseCommit: 'abc123',
    };

    const formatted = formatStallResult(result);

    expect(formatted).toContain('...');
    expect(formatted.length).toBeLessThan(result.rawError.length + 200);
  });
});

describe('getRetryAction', () => {
  it('should return retry_unchanged for retry_count 0', () => {
    expect(getRetryAction(0)).toBe('retry_unchanged');
  });

  it('should return retry_degraded for retry_count 1', () => {
    expect(getRetryAction(1)).toBe('retry_degraded');
  });

  it('should return block for retry_count 2', () => {
    expect(getRetryAction(2)).toBe('block');
  });

  it('should return block for retry_count 3 or higher', () => {
    expect(getRetryAction(3)).toBe('block');
    expect(getRetryAction(10)).toBe('block');
  });
});

describe('computeDegradedSettings', () => {
  it('should reduce max_turns by 50%', () => {
    const settings = computeDegradedSettings(50, { max_files_touched: 20, max_lines_changed: 500 });
    expect(settings.max_turns).toBe(25);
  });

  it('should enforce minimum max_turns of 5', () => {
    const settings = computeDegradedSettings(6, { max_files_touched: 20, max_lines_changed: 500 });
    expect(settings.max_turns).toBe(5);
  });

  it('should reduce max_files_touched by 50%', () => {
    const settings = computeDegradedSettings(50, { max_files_touched: 20, max_lines_changed: 500 });
    expect(settings.diff_limits.max_files_touched).toBe(10);
  });

  it('should enforce minimum max_files_touched of 5', () => {
    const settings = computeDegradedSettings(50, { max_files_touched: 6, max_lines_changed: 500 });
    expect(settings.diff_limits.max_files_touched).toBe(5);
  });

  it('should reduce max_lines_changed by 50%', () => {
    const settings = computeDegradedSettings(50, { max_files_touched: 20, max_lines_changed: 500 });
    expect(settings.diff_limits.max_lines_changed).toBe(250);
  });

  it('should enforce minimum max_lines_changed of 100', () => {
    const settings = computeDegradedSettings(50, { max_files_touched: 20, max_lines_changed: 100 });
    expect(settings.diff_limits.max_lines_changed).toBe(100);
  });

  it('should set prefer_patch_mode to true', () => {
    const settings = computeDegradedSettings(50, { max_files_touched: 20, max_lines_changed: 500 });
    expect(settings.prefer_patch_mode).toBe(true);
  });
});

describe('computeRetryDecision', () => {
  it('should return retry_unchanged for first failure', () => {
    const decision = computeRetryDecision(0);

    expect(decision.action).toBe('retry_unchanged');
    expect(decision.retry_count).toBe(1);
    expect(decision.degraded_settings).toBeUndefined();
    expect(decision.reason).toContain('retry');
  });

  it('should return retry_degraded for second failure with settings', () => {
    const decision = computeRetryDecision(1, 50, { max_files_touched: 20, max_lines_changed: 500 });

    expect(decision.action).toBe('retry_degraded');
    expect(decision.retry_count).toBe(2);
    expect(decision.degraded_settings).toBeDefined();
    expect(decision.degraded_settings?.max_turns).toBe(25);
    expect(decision.reason).toContain('degraded');
  });

  it('should return block for third failure', () => {
    const decision = computeRetryDecision(2);

    expect(decision.action).toBe('block');
    expect(decision.retry_count).toBe(3);
    expect(decision.degraded_settings).toBeUndefined();
    expect(decision.reason).toContain('limit');
  });

  it('should use default values if not provided', () => {
    const decision = computeRetryDecision(1);

    expect(decision.degraded_settings?.max_turns).toBe(25); // default 50 / 2
    expect(decision.degraded_settings?.diff_limits.max_files_touched).toBe(10); // default 20 / 2
  });
});

describe('canRetry', () => {
  it('should return true for retry_count 0', () => {
    expect(canRetry(0)).toBe(true);
  });

  it('should return true for retry_count 1', () => {
    expect(canRetry(1)).toBe(true);
  });

  it('should return false for retry_count 2', () => {
    expect(canRetry(2)).toBe(false);
  });

  it('should return false for retry_count 3 or higher', () => {
    expect(canRetry(3)).toBe(false);
    expect(canRetry(10)).toBe(false);
  });
});

describe('formatRetryDecision', () => {
  it('should format retry_unchanged decision', () => {
    const decision = computeRetryDecision(0);
    const formatted = formatRetryDecision(decision);

    expect(formatted).toContain('Retry attempt 1/3');
  });

  it('should include degraded settings for retry_degraded', () => {
    const decision = computeRetryDecision(1, 50, { max_files_touched: 20, max_lines_changed: 500 });
    const formatted = formatRetryDecision(decision);

    expect(formatted).toContain('Degraded settings');
    expect(formatted).toContain('max_turns: 25');
    expect(formatted).toContain('max_files: 10');
    expect(formatted).toContain('max_lines: 250');
  });

  it('should include human action message for block', () => {
    const decision = computeRetryDecision(2);
    const formatted = formatRetryDecision(decision);

    expect(formatted).toContain('Human action required');
  });
});

describe('MAX_RETRY_ATTEMPTS', () => {
  it('should be 3', () => {
    expect(MAX_RETRY_ATTEMPTS).toBe(3);
  });
});
