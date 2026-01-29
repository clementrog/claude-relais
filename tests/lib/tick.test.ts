/**
 * Tests for src/lib/tick.ts - Tick runner stall handling.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  handleTransportStall,
  checkAndHandleStall,
  formatStallResult,
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
