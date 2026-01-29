/**
 * Tests for src/lib/transport.ts - Transport stall detection and timeout wrapper.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  isTransportStall,
  createTransportStallError,
  invokeWithStallDetection,
  type StallDetectionResult,
  type InvokeResult,
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
