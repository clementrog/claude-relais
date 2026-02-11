/**
 * Tests for BLOCKED_MISSING_CONFIG behavior when cursor builder mode is selected
 * but cursor config is missing.
 *
 * Verifies that when orchestrator returns a task with builder.mode='cursor'
 * but config.builder.cursor is absent, runTick returns verdict=blocked with
 * code=BLOCKED_MISSING_CONFIG with actionable remediation.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { runTick } from '@/runner/tick.js';
import { createMockConfig, createMockTask } from '../helpers/mocks.js';
import type { EnvoiConfig } from '@/types/config.js';
import type { BlockedData } from '@/types/blocked.js';
import type { ReportData } from '@/types/report.js';

// Track what gets written
const writtenFiles: Map<string, unknown> = new Map();

// Mock external dependencies
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

vi.mock('@/lib/history.js', () => ({
  persistBuilderFailure: vi.fn(),
}));

describe('tick: BLOCKED_MISSING_CONFIG for cursor builder', () => {
  let config: EnvoiConfig;

  beforeEach(async () => {
    vi.clearAllMocks();
    writtenFiles.clear();
    config = createMockConfig();
    // Ensure cursor config is NOT present
    config.builder.default_mode = 'cursor';
    config.builder.cursor = undefined;

    // Set up default mock implementations
    const { acquireLock, releaseLock } = await import('@/lib/lock.js');
    const { getHeadCommit } = await import('@/lib/git.js');
    const { runPreflight } = await import('@/lib/preflight.js');
    const { runOrchestrator } = await import('@/runner/orchestrator.js');
    const { runBuilder } = await import('@/runner/builder.js');
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

    // Mock orchestrator to return a task with cursor mode
    const taskWithCursor = createMockTask('execute', {
      builder: {
        mode: 'cursor',
        max_turns: 4,
        instructions: 'Test instructions',
      },
    });

    vi.mocked(runOrchestrator).mockResolvedValue({
      success: true,
      task: taskWithCursor,
      error: null,
      rawResponse: JSON.stringify(taskWithCursor),
      rawStderr: '',
      attempts: 1,
      retryReason: null,
    });

    // Mock builder to return failure with STOP_CURSOR_CONFIG_MISSING
    vi.mocked(runBuilder).mockResolvedValue({
      success: false,
      result: null,
      rawResponse: 'Cursor config not defined',
      durationMs: 0,
      builderOutputValid: false,
      validationErrors: ['STOP_CURSOR_CONFIG_MISSING'],
      turnsRequested: 4,
      turnsUsed: null,
    });
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  it('should return BLOCKED_MISSING_CONFIG when cursor mode selected but config missing', async () => {
    const report = await runTick(config);

    expect(report.verdict).toBe('blocked');
    expect(report.code).toBe('BLOCKED_MISSING_CONFIG');
    expect(report.budgets.ticks).toBe(1);
    expect(report.budgets.orchestrator_calls).toBe(1);
    expect(report.budgets.builder_calls).toBe(1);
  });

  it('should write BLOCKED.json with actionable remediation', async () => {
    await runTick(config);

    const blockedPath = Array.from(writtenFiles.keys()).find((k) => k.includes('BLOCKED.json'));
    expect(blockedPath).toBeDefined();

    const blockedData = writtenFiles.get(blockedPath!) as BlockedData;
    expect(blockedData.code).toBe('BLOCKED_MISSING_CONFIG');
    expect(blockedData.reason).toContain('builder.cursor config is missing');
  });

  it('should include actionable warning in report', async () => {
    const report = await runTick(config);

    expect(report.budgets.warnings.length).toBeGreaterThan(0);
    const warning = report.budgets.warnings.find((w) =>
      w.includes('builder.mode="cursor"') && w.includes('builder.cursor')
    );
    expect(warning).toBeDefined();
    expect(warning).toContain('Configure cursor builder settings');
  });

  it('should persist builder failure artifacts for debugging', async () => {
    const { persistBuilderFailure } = await import('@/lib/history.js');

    await runTick(config);

    expect(persistBuilderFailure).toHaveBeenCalled();
    const callArgs = vi.mocked(persistBuilderFailure).mock.calls[0];
    expect(callArgs[3]).toBeDefined();
    expect(callArgs[3].details.validationErrors).toContain('STOP_CURSOR_CONFIG_MISSING');
  });
});
