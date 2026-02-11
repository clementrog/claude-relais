import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { runTick } from '@/runner/tick.js';
import { createMockConfig, createMockTask } from '../helpers/mocks.js';
import type { EnvoiConfig } from '@/types/config.js';
import type { BlockedData } from '@/types/blocked.js';

const writtenFiles: Map<string, unknown> = new Map();

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

describe('tick: builder mode mismatch guardrail', () => {
  let config: EnvoiConfig;

  beforeEach(async () => {
    vi.clearAllMocks();
    writtenFiles.clear();
    config = createMockConfig();
    config.builder.default_mode = 'claude_code';
    config.builder.cursor = {
      driver_kind: 'cursor_agent',
      command: 'cursor',
      args: ['agent', '--print', '--output-format', 'text', '--workspace', '.', '--force'],
      timeout_seconds: 300,
      output_file: 'BUILDER_RESULT.json',
    };

    const { acquireLock, releaseLock } = await import('@/lib/lock.js');
    const { getHeadCommit } = await import('@/lib/git.js');
    const { runPreflight } = await import('@/lib/preflight.js');
    const { runOrchestrator } = await import('@/runner/orchestrator.js');
    const { atomicWriteJson } = await import('@/lib/fs.js');
    const { renderReportMarkdown, writeReportMarkdown } = await import('@/lib/report.js');
    const { writeBlocked } = await import('@/lib/blocked.js');
    const { readWorkspaceState, ensureMilestone } = await import('@/lib/workspace_state.js');

    vi.mocked(acquireLock).mockResolvedValue({ pid: 123 });
    vi.mocked(releaseLock).mockResolvedValue(undefined);
    vi.mocked(getHeadCommit).mockReturnValue('abc123def456');
    vi.mocked(runPreflight).mockResolvedValue({
      ok: true,
      warnings: [],
      base_commit: 'abc123def456',
    });
    vi.mocked(atomicWriteJson).mockImplementation(async (path: string, data: unknown) => {
      writtenFiles.set(path, data);
    });
    vi.mocked(renderReportMarkdown).mockReturnValue('# Envoi Report\n\nMock markdown content');
    vi.mocked(writeReportMarkdown).mockImplementation(async (content: string, path: string) => {
      writtenFiles.set(path, content);
    });
    vi.mocked(writeBlocked).mockImplementation(async (data: BlockedData, path: string) => {
      writtenFiles.set(path, data);
    });
    vi.mocked(readWorkspaceState).mockResolvedValue({
      milestone_id: 'M1',
      branch: 'main',
      budgets: {
        ticks: 0,
        orchestrator_calls: 0,
        builder_calls: 0,
        verify_runs: 0,
      },
    });
    vi.mocked(ensureMilestone).mockReturnValue({
      state: {
        milestone_id: 'M1',
        branch: 'main',
        budgets: {
          ticks: 0,
          orchestrator_calls: 0,
          builder_calls: 0,
          verify_runs: 0,
        },
      },
      changed: false,
    });

    const mismatchedTask = createMockTask('execute', {
      builder: {
        mode: 'cursor',
        max_turns: 4,
        instructions: 'Use cursor',
      },
    });
    vi.mocked(runOrchestrator).mockResolvedValue({
      success: true,
      task: mismatchedTask,
      error: null,
      rawResponse: JSON.stringify(mismatchedTask),
      rawStderr: '',
      attempts: 1,
      retryReason: null,
    });
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  it('blocks early before builder execution when config default mode is not cursor', async () => {
    const { runBuilder } = await import('@/runner/builder.js');

    const report = await runTick(config);

    expect(report.verdict).toBe('blocked');
    expect(report.code).toBe('BLOCKED_MISSING_CONFIG');
    expect(report.budgets.builder_calls).toBe(0);
    expect(report.budgets.warnings.some((warning) => warning.includes('builder.default_mode="claude_code"'))).toBe(true);
    expect(runBuilder).not.toHaveBeenCalled();
  });

  it('blocks early when task builder mode is not cursor', async () => {
    config.builder.default_mode = 'cursor';

    const { runOrchestrator } = await import('@/runner/orchestrator.js');
    const { runBuilder } = await import('@/runner/builder.js');

    const invalidTask = createMockTask('execute', {
      builder: {
        mode: 'claude_code',
        max_turns: 4,
        instructions: 'Use claude builder',
      },
    });
    vi.mocked(runOrchestrator).mockResolvedValue({
      success: true,
      task: invalidTask,
      error: null,
      rawResponse: JSON.stringify(invalidTask),
      rawStderr: '',
      attempts: 1,
      retryReason: null,
    });

    const report = await runTick(config);

    expect(report.verdict).toBe('blocked');
    expect(report.code).toBe('BLOCKED_BUILDER_MODE_NOT_ALLOWED');
    expect(report.budgets.builder_calls).toBe(0);
    expect(report.budgets.warnings.some((warning) => warning.includes('only allows builder.mode="cursor"'))).toBe(true);
    expect(runBuilder).not.toHaveBeenCalled();
  });
});
