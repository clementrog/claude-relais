/**
 * F002: orchestrator_invalid_json_blocks
 * 
 * Verify that invalid JSON from orchestrator twice results in
 * BLOCKED_ORCHESTRATOR_OUTPUT_INVALID.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runOrchestrator } from '@/runner/orchestrator.js';
import { createMockConfig, createMockTickState } from '../helpers/mocks.js';
import type { TickState } from '@/types/state.js';

// Mock Claude Code CLI
vi.mock('@/lib/claude.js', () => ({
  invokeClaudeCode: vi.fn(),
}));

// Mock file system operations
vi.mock('node:fs/promises', () => ({
  readFile: vi.fn(),
}));

// Mock schema loading
vi.mock('@/lib/schema.js', () => ({
  loadSchema: vi.fn(),
  validateWithSchema: vi.fn(),
}));

describe('F002: orchestrator_invalid_json_blocks', () => {
  let config: ReturnType<typeof createMockConfig>;
  let state: TickState;

  beforeEach(() => {
    vi.resetAllMocks();
    config = createMockConfig();
    state = createMockTickState(config);
  });

  it('should return BLOCKED when orchestrator outputs invalid JSON twice', async () => {
    const { invokeClaudeCode } = await import('@/lib/claude.js');
    const { readFile } = await import('node:fs/promises');
    const { loadSchema } = await import('@/lib/schema.js');

    vi.mocked(readFile).mockResolvedValue('system prompt');
    vi.mocked(loadSchema).mockResolvedValue({});
    
    // Both attempts return invalid JSON
    vi.mocked(invokeClaudeCode)
      .mockResolvedValueOnce({
        success: true,
        result: 'invalid json {',
        exitCode: 0,
      })
      .mockResolvedValueOnce({
        success: true,
        result: 'still invalid { broken',
        exitCode: 0,
      });

    const result = await runOrchestrator(state);

    expect(result.success).toBe(false);
    expect(result.task).toBeNull();
    expect(result.attempts).toBe(2);
    expect(result.error).toContain('Failed to parse orchestrator output as JSON');
    expect(invokeClaudeCode).toHaveBeenCalledTimes(2);
  });

  it('should return BLOCKED when orchestrator outputs invalid schema twice', async () => {
    const { invokeClaudeCode } = await import('@/lib/claude.js');
    const { readFile } = await import('node:fs/promises');
    const { loadSchema, validateWithSchema } = await import('@/lib/schema.js');

    vi.mocked(readFile).mockResolvedValue('system prompt');
    vi.mocked(loadSchema).mockResolvedValue({});
    
    // Both attempts return JSON that fails schema validation
    vi.mocked(invokeClaudeCode)
      .mockResolvedValueOnce({
        success: true,
        result: JSON.stringify({ invalid: 'task' }),
        exitCode: 0,
      })
      .mockResolvedValueOnce({
        success: true,
        result: JSON.stringify({ still_invalid: 'task' }),
        exitCode: 0,
      });
    
    vi.mocked(validateWithSchema).mockReturnValue({
      valid: false,
      data: null,
      errors: ['Missing required property: task_id'],
    });

    const result = await runOrchestrator(state);

    expect(result.success).toBe(false);
    expect(result.task).toBeNull();
    expect(result.attempts).toBe(2);
    expect(result.error).toContain('Task validation failed');
    expect(invokeClaudeCode).toHaveBeenCalledTimes(2);
  });
});
