import { describe, it, expect, vi, beforeEach } from 'vitest';

import { runOrchestrator } from '@/runner/orchestrator.js';
import { createMockTickState, createMockConfig } from '../helpers/mocks.js';

vi.mock('@/lib/claude.js', () => ({
  invokeClaudeCode: vi.fn(),
}));

vi.mock('@/lib/reviewer.js', () => ({
  invokeReviewer: vi.fn(),
}));

vi.mock('@/lib/schema.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/schema.js')>();
  return {
    ...actual,
    loadSchema: vi.fn(async () => ({})),
    validateWithSchema: vi.fn((parsed: unknown) => ({ valid: true, data: parsed, errors: [], rawErrors: [] })),
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

describe('orchestrator provider dispatch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('uses codex reviewer adapter when orchestrator_provider=chatgpt', async () => {
    const { invokeClaudeCode } = await import('@/lib/claude.js');
    const { invokeReviewer } = await import('@/lib/reviewer.js');

    vi.mocked(invokeReviewer).mockResolvedValue({
      success: true,
      result: {
        task_id: 'TASK-1',
        milestone_id: 'M1',
        task_kind: 'execute',
        intent: 'Implement feature',
      },
      raw: { result: { ok: true } },
      exitCode: 0,
      durationMs: 10,
    } as any);

    const config = createMockConfig();
    (config.models as any).orchestrator_provider = 'chatgpt';
    config.models.orchestrator_model = 'gpt-5.3';
    const state = createMockTickState(config, null);

    const result = await runOrchestrator(state);
    expect(result.success).toBe(true);
    expect(vi.mocked(invokeReviewer)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(invokeClaudeCode)).not.toHaveBeenCalled();
  });

  it('uses claude adapter when orchestrator_provider is missing/default', async () => {
    const { invokeClaudeCode } = await import('@/lib/claude.js');
    const { invokeReviewer } = await import('@/lib/reviewer.js');

    vi.mocked(invokeClaudeCode).mockResolvedValue({
      success: true,
      result: JSON.stringify({
        task_id: 'TASK-2',
        milestone_id: 'M1',
        task_kind: 'execute',
        intent: 'Implement feature',
      }),
      raw: { subtype: 'success' },
      stderr: '',
      exitCode: 0,
      durationMs: 10,
    } as any);

    const config = createMockConfig();
    const state = createMockTickState(config, null);

    const result = await runOrchestrator(state);
    expect(result.success).toBe(true);
    expect(vi.mocked(invokeClaudeCode)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(invokeReviewer)).not.toHaveBeenCalled();
  });
});
