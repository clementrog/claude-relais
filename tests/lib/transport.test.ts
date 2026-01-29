/**
 * Tests for src/lib/transport.ts - Transport stall detection and timeout wrapper.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  isTransportStall,
  createTransportStallError,
  invokeWithStallDetection,
  normalizeTransportError,
  isTransportStallError,
  type StallDetectionResult,
  type InvokeResult,
  type NormalizedError,
} from '@/lib/transport.js';
import { ClaudeError } from '@/types/claude.js';

// Mock the claude module
vi.mock('@/lib/claude.js', () => ({
  invokeClaudeCode: vi.fn(),
}));

import { invokeClaudeCode } from '@/lib/claude.js';

const mockInvokeClaudeCode = vi.mocked(invokeClaudeCode);

describe('isTransportStall', () => {
  it('should return false for empty string', () => {
    const result = isTransportStall('');
    expect(result.stalled).toBe(false);
    expect(result.request_id).toBeNull();
    expect(result.matched_pattern).toBeNull();
  });

  it('should return false for normal error messages', () => {
    const result = isTransportStall('File not found: src/missing.ts');
    expect(result.stalled).toBe(false);
    expect(result.matched_pattern).toBeNull();
  });

  it('should detect "Connection stalled" pattern', () => {
    const result = isTransportStall('Error: Connection stalled while waiting for response');
    expect(result.stalled).toBe(true);
    expect(result.matched_pattern).toBe('Connection stalled');
  });

  it('should detect "streamFromAgentBackend" pattern', () => {
    const result = isTransportStall('Failed to streamFromAgentBackend: timeout');
    expect(result.stalled).toBe(true);
    expect(result.matched_pattern).toBe('streamFromAgentBackend');
  });

  it('should detect "ECONNRESET" pattern', () => {
    const result = isTransportStall('Error: read ECONNRESET');
    expect(result.stalled).toBe(true);
    expect(result.matched_pattern).toBe('ECONNRESET');
  });

  it('should detect "ETIMEDOUT" pattern', () => {
    const result = isTransportStall('connect ETIMEDOUT 1.2.3.4:443');
    expect(result.stalled).toBe(true);
    expect(result.matched_pattern).toBe('ETIMEDOUT');
  });

  it('should detect "socket hang up" pattern', () => {
    const result = isTransportStall('Error: socket hang up');
    expect(result.stalled).toBe(true);
    expect(result.matched_pattern).toBe('socket hang up');
  });

  it('should extract Request ID from error message', () => {
    const result = isTransportStall('Connection stalled. Request ID: abc123-def456');
    expect(result.stalled).toBe(true);
    expect(result.request_id).toBe('abc123-def456');
  });

  it('should extract request_id with underscore format', () => {
    const result = isTransportStall('Error occurred. request_id: my_request_123');
    expect(result.request_id).toBe('my_request_123');
  });

  it('should extract requestId with camelCase format', () => {
    const result = isTransportStall('Failed. requestId: req-xyz-789');
    expect(result.request_id).toBe('req-xyz-789');
  });

  it('should return request_id even without stall pattern', () => {
    const result = isTransportStall('Unknown error. Request ID: test123');
    expect(result.stalled).toBe(false);
    expect(result.request_id).toBe('test123');
  });
});

describe('createTransportStallError', () => {
  it('should create error with correct fields', () => {
    const error = createTransportStallError('BUILD', 'Connection stalled', 'req-123');
    expect(error.kind).toBe('transport_stalled');
    expect(error.stage).toBe('BUILD');
    expect(error.request_id).toBe('req-123');
    expect(error.raw_error).toBe('Connection stalled');
  });

  it('should create error with null request_id', () => {
    const error = createTransportStallError('ORCHESTRATE', 'Timeout occurred');
    expect(error.kind).toBe('transport_stalled');
    expect(error.stage).toBe('ORCHESTRATE');
    expect(error.request_id).toBeNull();
    expect(error.raw_error).toBe('Timeout occurred');
  });

  it('should truncate long error messages', () => {
    const longError = 'A'.repeat(600);
    const error = createTransportStallError('BUILD', longError);
    expect(error.raw_error.length).toBeLessThanOrEqual(503); // 500 + '...'
    expect(error.raw_error.endsWith('...')).toBe(true);
  });

  it('should not truncate short error messages', () => {
    const shortError = 'Short error message';
    const error = createTransportStallError('BUILD', shortError);
    expect(error.raw_error).toBe(shortError);
    expect(error.raw_error.endsWith('...')).toBe(false);
  });
});

describe('invokeWithStallDetection', () => {
  const mockConfig = {
    command: 'claude',
    output_format: 'json',
    no_session_persistence: true,
  };

  const mockInvocation = {
    prompt: 'Test prompt',
    maxTurns: 1,
    permissionMode: 'plan' as const,
    model: 'claude-3-5-sonnet',
    timeout: 30000,
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should return success response when invocation succeeds', async () => {
    const mockResponse = {
      success: true,
      result: 'Hello, world!',
      raw: { result: 'Hello, world!' },
      exitCode: 0,
      durationMs: 1000,
    };
    mockInvokeClaudeCode.mockResolvedValue(mockResponse);

    const result = await invokeWithStallDetection(mockConfig, mockInvocation, 'BUILD');

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.response).toEqual(mockResponse);
    }
  });

  it('should return TransportStallError on timeout', async () => {
    mockInvokeClaudeCode.mockRejectedValue(
      new ClaudeError('Claude Code CLI invocation timed out after 30000ms', 124, '')
    );

    const result = await invokeWithStallDetection(mockConfig, mockInvocation, 'BUILD');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('transport_stalled');
      expect(result.error.stage).toBe('BUILD');
      expect(result.error.raw_error).toContain('timed out');
    }
  });

  it('should return TransportStallError when stall pattern detected in stderr', async () => {
    mockInvokeClaudeCode.mockRejectedValue(
      new ClaudeError('Process failed', 1, 'Connection stalled. Request ID: abc123')
    );

    const result = await invokeWithStallDetection(mockConfig, mockInvocation, 'ORCHESTRATE');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('transport_stalled');
      expect(result.error.stage).toBe('ORCHESTRATE');
      expect(result.error.request_id).toBe('abc123');
      expect(result.error.raw_error).toContain('Connection stalled');
    }
  });

  it('should re-throw non-transport ClaudeErrors', async () => {
    const claudeError = new ClaudeError('Invalid JSON response', 1, 'Parsing failed');
    mockInvokeClaudeCode.mockRejectedValue(claudeError);

    await expect(
      invokeWithStallDetection(mockConfig, mockInvocation, 'BUILD')
    ).rejects.toThrow(claudeError);
  });

  it('should detect stall in generic errors', async () => {
    mockInvokeClaudeCode.mockRejectedValue(new Error('ECONNRESET during request'));

    const result = await invokeWithStallDetection(mockConfig, mockInvocation, 'BUILD');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('transport_stalled');
      expect(result.error.raw_error).toContain('ECONNRESET');
    }
  });

  it('should re-throw non-transport generic errors', async () => {
    const genericError = new Error('Some other error');
    mockInvokeClaudeCode.mockRejectedValue(genericError);

    await expect(
      invokeWithStallDetection(mockConfig, mockInvocation, 'BUILD')
    ).rejects.toThrow(genericError);
  });

  it('should handle streamFromAgentBackend error', async () => {
    mockInvokeClaudeCode.mockRejectedValue(
      new ClaudeError('Backend error', 1, 'Failed to streamFromAgentBackend: connection lost')
    );

    const result = await invokeWithStallDetection(mockConfig, mockInvocation, 'BUILD');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('transport_stalled');
      expect(result.error.raw_error).toContain('streamFromAgentBackend');
    }
  });
});

describe('normalizeTransportError', () => {
  it('should handle ClaudeError with stall pattern in stderr', () => {
    const error = new ClaudeError('Process failed', 1, 'Connection stalled. Request ID: req-123');
    const result = normalizeTransportError(error, 'BUILD');

    expect(result.isStall).toBe(true);
    expect(result.stallError).not.toBeNull();
    expect(result.stallError?.kind).toBe('transport_stalled');
    expect(result.stallError?.stage).toBe('BUILD');
    expect(result.stallError?.request_id).toBe('req-123');
    expect(result.originalError).toBe(error);
  });

  it('should handle ClaudeError with timeout exit code', () => {
    const error = new ClaudeError('Command timed out', 124, '');
    const result = normalizeTransportError(error, 'ORCHESTRATE');

    expect(result.isStall).toBe(true);
    expect(result.stallError).not.toBeNull();
    expect(result.stallError?.stage).toBe('ORCHESTRATE');
    expect(result.originalError).toBe(error);
  });

  it('should handle ClaudeError with "timed out" in message', () => {
    const error = new ClaudeError('Claude invocation timed out after 30000ms', 1, '');
    const result = normalizeTransportError(error, 'BUILD');

    expect(result.isStall).toBe(true);
    expect(result.stallError).not.toBeNull();
  });

  it('should handle ClaudeError without stall pattern', () => {
    const error = new ClaudeError('Invalid JSON', 1, 'Parsing error');
    const result = normalizeTransportError(error, 'BUILD');

    expect(result.isStall).toBe(false);
    expect(result.stallError).toBeNull();
    expect(result.originalError).toBe(error);
    expect(result.message).toContain('Invalid JSON');
    expect(result.message).toContain('Parsing error');
  });

  it('should handle regular Error with stall pattern', () => {
    const error = new Error('ECONNRESET during connection');
    const result = normalizeTransportError(error, 'BUILD');

    expect(result.isStall).toBe(true);
    expect(result.stallError).not.toBeNull();
    expect(result.stallError?.raw_error).toContain('ECONNRESET');
    expect(result.originalError).toBe(error);
  });

  it('should handle regular Error without stall pattern', () => {
    const error = new Error('File not found');
    const result = normalizeTransportError(error, 'BUILD');

    expect(result.isStall).toBe(false);
    expect(result.stallError).toBeNull();
    expect(result.originalError).toBe(error);
  });

  it('should handle string error with stall pattern', () => {
    const error = 'Connection stalled while waiting';
    const result = normalizeTransportError(error, 'ORCHESTRATE');

    expect(result.isStall).toBe(true);
    expect(result.stallError).not.toBeNull();
    expect(result.stallError?.stage).toBe('ORCHESTRATE');
    expect(result.originalError).toBeInstanceOf(Error);
    expect(result.originalError.message).toBe(error);
  });

  it('should handle string error without stall pattern', () => {
    const error = 'Some random error';
    const result = normalizeTransportError(error, 'BUILD');

    expect(result.isStall).toBe(false);
    expect(result.stallError).toBeNull();
    expect(result.originalError).toBeInstanceOf(Error);
    expect(result.originalError.message).toBe(error);
  });

  it('should handle unknown error types', () => {
    const error = { code: 500, reason: 'Unknown' };
    const result = normalizeTransportError(error, 'BUILD');

    expect(result.isStall).toBe(false);
    expect(result.stallError).toBeNull();
    expect(result.originalError).toBeInstanceOf(Error);
    // String({ code: 500, reason: 'Unknown' }) returns '[object Object]'
    expect(result.message).toBe('[object Object]');
  });

  it('should handle null error', () => {
    const result = normalizeTransportError(null, 'BUILD');

    expect(result.isStall).toBe(false);
    expect(result.stallError).toBeNull();
    expect(result.originalError).toBeInstanceOf(Error);
  });

  it('should handle undefined error', () => {
    const result = normalizeTransportError(undefined, 'BUILD');

    expect(result.isStall).toBe(false);
    expect(result.stallError).toBeNull();
    expect(result.originalError).toBeInstanceOf(Error);
  });

  it('should combine message and stderr from ClaudeError', () => {
    const error = new ClaudeError('Main message', 1, 'Stderr content');
    const result = normalizeTransportError(error, 'BUILD');

    expect(result.message).toContain('Main message');
    expect(result.message).toContain('Stderr content');
  });
});

describe('isTransportStallError', () => {
  it('should return true for valid TransportStallError', () => {
    const error = createTransportStallError('BUILD', 'Connection stalled', 'req-123');
    expect(isTransportStallError(error)).toBe(true);
  });

  it('should return true for TransportStallError with null request_id', () => {
    const error = createTransportStallError('ORCHESTRATE', 'Timeout');
    expect(isTransportStallError(error)).toBe(true);
  });

  it('should verify all required fields are present', () => {
    const error = createTransportStallError('BUILD', 'Error message', 'req-456');

    expect(error.kind).toBe('transport_stalled');
    expect(error.stage).toBe('BUILD');
    expect(error.request_id).toBe('req-456');
    expect(error.raw_error).toBe('Error message');
    expect(isTransportStallError(error)).toBe(true);
  });

  it('should return false for null', () => {
    expect(isTransportStallError(null)).toBe(false);
  });

  it('should return false for undefined', () => {
    expect(isTransportStallError(undefined)).toBe(false);
  });

  it('should return false for plain object without required fields', () => {
    expect(isTransportStallError({})).toBe(false);
    expect(isTransportStallError({ kind: 'other' })).toBe(false);
  });

  it('should return false for object with wrong kind', () => {
    const error = {
      kind: 'other_error',
      stage: 'BUILD',
      request_id: null,
      raw_error: 'test',
    };
    expect(isTransportStallError(error)).toBe(false);
  });

  it('should return false for object with invalid stage', () => {
    const error = {
      kind: 'transport_stalled',
      stage: 'INVALID',
      request_id: null,
      raw_error: 'test',
    };
    expect(isTransportStallError(error)).toBe(false);
  });

  it('should return false for object with wrong request_id type', () => {
    const error = {
      kind: 'transport_stalled',
      stage: 'BUILD',
      request_id: 123, // should be string or null
      raw_error: 'test',
    };
    expect(isTransportStallError(error)).toBe(false);
  });

  it('should return false for object with wrong raw_error type', () => {
    const error = {
      kind: 'transport_stalled',
      stage: 'BUILD',
      request_id: null,
      raw_error: 123, // should be string
    };
    expect(isTransportStallError(error)).toBe(false);
  });

  it('should return false for Error instance', () => {
    expect(isTransportStallError(new Error('test'))).toBe(false);
  });

  it('should return false for ClaudeError instance', () => {
    expect(isTransportStallError(new ClaudeError('test', 1, ''))).toBe(false);
  });

  it('should return false for string', () => {
    expect(isTransportStallError('error message')).toBe(false);
  });

  it('should return false for number', () => {
    expect(isTransportStallError(42)).toBe(false);
  });
});
