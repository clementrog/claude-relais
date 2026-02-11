import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runTick } from '@/runner/tick.js';
import { createMockConfig, createMockTask } from '../helpers/mocks.js';
import type { EnvoiConfig } from '@/types/config.js';

vi.mock('@/lib/lock.js', () => ({
  acquireLock: vi.fn(),
  releaseLock: vi.fn(),
  LockHeldError: class extends Error {
    constructor() {
      super('Lock held');
    }
  },
}));

vi.mock('@/lib/git.js', () => ({
  getHeadCommit: vi.fn(),
}));

vi.mock('@/lib/preflight.js', () => ({
  runPreflight: vi.fn(),
}));

vi.mock('@/runner/orchestrator.js', () => ({
  runOrchestrator: vi.fn(),
}));

vi.mock('@/runner/builder.js', () => ({
  runBuilder: vi.fn(),
}));

vi.mock('@/lib/reviewer-flow.js', () => ({
  runReviewerIfNeeded: vi.fn(),
}));

vi.mock('@/lib/fs.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/fs.js')>();
  return {
    ...actual,
    atomicWriteJson: vi.fn(),
  };
});

vi.mock('@/lib/report.js', () => ({
  renderReportMarkdown: vi.fn(),
  writeReportMarkdown: vi.fn(),
}));

vi.mock('@/lib/blocked.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/blocked.js')>();
  return {
    ...actual,
    writeBlocked: vi.fn(),
    deleteBlocked: vi.fn(),
  };
});

vi.mock('@/lib/workspace_state.js', () => ({
  readWorkspaceState: vi.fn(),
  writeWorkspaceState: vi.fn(),
  ensureMilestone: vi.fn(),
}));

describe('tick reviewer gate', () => {
  let config: EnvoiConfig;

  beforeEach(async () => {
    vi.clearAllMocks();

    config = createMockConfig();
    config.reviewer = {
      enabled: true,
      engine: 'codex',
      command: 'codex',
      model: 'gpt-5',
      max_turns: 1,
      max_budget_usd: 0.2,
      auth: {
        mode: 'auto',
        ci_requires_api_key: false,
        api_key_env: 'CODEX_API_KEY',
      },
      trigger: {
        on_verify_fail: false,
        on_repeated_stop: false,
        stop_window_ticks: 10,
        max_stops_in_window: 2,
        on_high_risk_paths: true,
        high_risk_globs: ['src/**'],
        diff_fraction_threshold: 1,
      },
      schema_file: 'relais/schemas/reviewer_result.schema.json',
      system_prompt_file: 'relais/prompts/reviewer.system.txt',
      user_prompt_file: 'relais/prompts/reviewer.user.txt',
    };

    const { acquireLock, releaseLock } = await import('@/lib/lock.js');
    const { getHeadCommit } = await import('@/lib/git.js');
    const { runPreflight } = await import('@/lib/preflight.js');
    const { runOrchestrator } = await import('@/runner/orchestrator.js');
    const { runBuilder } = await import('@/runner/builder.js');
    const { runReviewerIfNeeded } = await import('@/lib/reviewer-flow.js');
    const { atomicWriteJson } = await import('@/lib/fs.js');
    const { renderReportMarkdown, writeReportMarkdown } = await import('@/lib/report.js');
    const { readWorkspaceState, ensureMilestone } = await import('@/lib/workspace_state.js');

    vi.mocked(acquireLock).mockResolvedValue({ pid: 123 });
    vi.mocked(releaseLock).mockResolvedValue(undefined);
    vi.mocked(getHeadCommit).mockReturnValue('abc123def456');
    vi.mocked(runPreflight).mockResolvedValue({
      ok: true,
      warnings: [],
      base_commit: 'abc123def456',
    });
    vi.mocked(atomicWriteJson).mockResolvedValue(undefined);
    vi.mocked(renderReportMarkdown).mockReturnValue('# Envoi Report\n\nMock markdown content');
    vi.mocked(writeReportMarkdown).mockResolvedValue(undefined);
    vi.mocked(readWorkspaceState).mockResolvedValue({
      milestone_id: 'M1',
      branch: 'main',
      budgets: {
        ticks: 0,
        orchestrator_calls: 0,
        builder_calls: 0,
        verify_runs: 0,
      },
      budget_warning: false,
      last_run_id: null,
      last_verdict: null,
    } as any);
    vi.mocked(ensureMilestone).mockImplementation((state: any) => ({ state, changed: false }));

    const task = createMockTask('execute');
    vi.mocked(runOrchestrator).mockResolvedValue({
      success: true,
      task,
      error: null,
      rawResponse: JSON.stringify(task),
      rawStderr: '',
      attempts: 1,
      retryReason: null,
    });

    vi.mocked(runReviewerIfNeeded).mockResolvedValue({
      stopCode: 'STOP_REVIEWER_FORCED_PATCH',
    });

    vi.mocked(runBuilder).mockResolvedValue({
      success: true,
      result: {
        summary: 'ok',
        files_intended: [],
        commands_ran: [],
        notes: [],
      },
      rawResponse: '{}',
      durationMs: 10,
      builderOutputValid: true,
      validationErrors: [],
      turnsRequested: 1,
      turnsUsed: 1,
    });
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  it('stops before builder when reviewer requests forced patch', async () => {
    const { runBuilder } = await import('@/runner/builder.js');

    const report = await runTick(config);

    expect(report.verdict).toBe('stop');
    expect(report.code).toBe('STOP_REVIEWER_FORCED_PATCH');
    expect(report.budgets.builder_calls).toBe(0);
    expect(runBuilder).not.toHaveBeenCalled();
  });
});
