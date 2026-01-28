/**
 * F001: one_tick_limits
 * 
 * Verify that orchestrator calls are bounded (<= 2, only if first JSON invalid)
 * and builder calls are exactly 1 per tick.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runOrchestrator } from '@/runner/orchestrator.js';
import { runBuilder } from '@/runner/builder.js';
import { createMockConfig, createMockTickState, createMockTask } from '../helpers/mocks.js';
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

describe('F001: one_tick_limits', () => {
  let config: ReturnType<typeof createMockConfig>;
  let state: TickState;

  beforeEach(() => {
    vi.resetAllMocks();
    config = createMockConfig();
    state = createMockTickState(config);
  });

  it('should limit orchestrator calls to at most 2 (retry only on invalid JSON)', async () => {
    const { invokeClaudeCode } = await import('@/lib/claude.js');
    const { readFile } = await import('node:fs/promises');
    const { loadSchema, validateWithSchema } = await import('@/lib/schema.js');

    // Mock successful orchestrator call (valid JSON on first attempt)
    vi.mocked(readFile).mockResolvedValue('system prompt');
    vi.mocked(loadSchema).mockResolvedValue({});
    vi.mocked(invokeClaudeCode).mockResolvedValue({
      success: true,
      result: JSON.stringify({
        task_id: 'test-001',
        milestone_id: 'M1',
        task_kind: 'execute',
        intent: 'Test',
        scope: {
          allowed_globs: ['src/**'],
          forbidden_globs: [],
          allow_new_files: false,
          allow_lockfile_changes: false,
        },
        diff_limits: {
          max_files_touched: 10,
          max_lines_changed: 100,
        },
        verification: {
          fast: [],
          slow: [],
          params: {},
        },
        builder: {
          mode: 'claude_code',
          max_turns: 4,
          instructions: 'Test',
        },
      }),
      exitCode: 0,
    });
    vi.mocked(validateWithSchema).mockReturnValue({
      valid: true,
      data: createMockTask('execute'),
      errors: [],
    });

    const result = await runOrchestrator(state);

    expect(result.success).toBe(true);
    expect(result.attempts).toBe(1); // Should succeed on first attempt
    expect(invokeClaudeCode).toHaveBeenCalledTimes(1);
  });

  it('should retry orchestrator once on invalid JSON (max 2 calls)', async () => {
    const { invokeClaudeCode } = await import('@/lib/claude.js');
    const { readFile } = await import('node:fs/promises');
    const { loadSchema, validateWithSchema } = await import('@/lib/schema.js');

    vi.mocked(readFile).mockResolvedValue('system prompt');
    vi.mocked(loadSchema).mockResolvedValue({});
    
    // First attempt: invalid JSON
    vi.mocked(invokeClaudeCode)
      .mockResolvedValueOnce({
        success: true,
        result: 'invalid json {',
        exitCode: 0,
      })
      // Second attempt: valid JSON
      .mockResolvedValueOnce({
        success: true,
        result: JSON.stringify(createMockTask('execute')),
        exitCode: 0,
      });
    
    vi.mocked(validateWithSchema).mockReturnValue({
      valid: true,
      data: createMockTask('execute'),
      errors: [],
    });

    const result = await runOrchestrator(state);

    expect(result.success).toBe(true);
    expect(result.attempts).toBe(2); // Should retry once
    expect(invokeClaudeCode).toHaveBeenCalledTimes(2);
  });

  it('should limit builder calls to exactly 1 per tick', async () => {
    const { invokeClaudeCode } = await import('@/lib/claude.js');
    const { readFile } = await import('node:fs/promises');
    const { loadSchema, validateWithSchema } = await import('@/lib/schema.js');

    const task = createMockTask('execute');
    const stateWithTask = createMockTickState(config, task);

    // Mock file reads for system prompt and user prompt
    vi.mocked(readFile).mockImplementation(async (path: string) => {
      if (typeof path === 'string' && path.includes('system')) {
        return 'system prompt';
      }
      if (typeof path === 'string' && path.includes('user')) {
        return 'user prompt';
      }
      return 'file content';
    });
    
    vi.mocked(loadSchema).mockResolvedValue({});
    vi.mocked(validateWithSchema).mockReturnValue({
      valid: true,
      data: {
        subtasks_completed: [],
        git_diff_files: [],
        files: { changed: [], created: [], deleted: [] },
        verify: [],
        notes: [],
        blockers: [],
      },
      errors: [],
    });
    
    vi.mocked(invokeClaudeCode).mockResolvedValue({
      success: true,
      result: JSON.stringify({
        subtasks_completed: [],
        git_diff_files: [],
        files: { changed: [], created: [], deleted: [] },
        verify: [],
        notes: [],
        blockers: [],
      }),
      exitCode: 0,
      raw: {},
    });

    const result = await runBuilder(stateWithTask, task);

    expect(result.success).toBe(true);
    expect(invokeClaudeCode).toHaveBeenCalledTimes(1); // Builder should be called exactly once
  });
});
