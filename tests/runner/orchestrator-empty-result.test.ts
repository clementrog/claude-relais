/**
 * Regression: Orchestrator should fail with a clear error when Claude CLI returns
 * success but an empty `.result` (common when unauthenticated or misconfigured).
 */

import { describe, it, expect, vi } from 'vitest';
import { runOrchestrator } from '@/runner/orchestrator.js';
import { createMockTickState, createMockConfig } from '../helpers/mocks.js';

vi.mock('@/lib/claude.js', () => ({
  invokeClaudeCode: vi.fn(),
}));

vi.mock('@/lib/schema.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/schema.js')>();
  return {
    ...actual,
    loadSchema: vi.fn(async () => ({})),
    validateWithSchema: vi.fn(() => ({ valid: true, data: null, errors: [], rawErrors: [] })),
  };
});

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    readFile: vi.fn(async () => 'prompt {{PRD_MD}}'),
  };
});

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    existsSync: vi.fn(() => false),
    readFileSync: vi.fn(() => ''),
  };
});

vi.mock('@/lib/workspace_state.js', () => ({
  readWorkspaceState: vi.fn(async () => ({
    milestone_id: null,
    branch: null,
    budgets: { ticks: 0, orchestrator_calls: 0, builder_calls: 0, verify_runs: 0 },
    budget_warning: false,
  })),
}));

describe('orchestrator: empty result is blocked with diagnostics', () => {
  it('returns success=false with rawCliStdout and a useful error message', async () => {
    const { invokeClaudeCode } = await import('@/lib/claude.js');
    vi.mocked(invokeClaudeCode).mockResolvedValue({
      success: true,
      result: '',
      raw: { subtype: 'error_not_logged_in' },
      exitCode: 0,
      durationMs: 10,
      stderr: 'not logged in',
    } as any);

    const config = createMockConfig();
    const state = createMockTickState(config, null);

    const res = await runOrchestrator(state);
    expect(res.success).toBe(false);
    expect(res.task).toBeNull();
    expect(res.error).toContain('empty output');
    expect(res.error).toContain('subtype=');
    expect(res.rawCliStdout).toContain('error_not_logged_in');
    expect(res.rawStderr).toContain('not logged in');
  });
});

