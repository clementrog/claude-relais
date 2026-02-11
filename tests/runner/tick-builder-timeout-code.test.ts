/**
 * Tests for STOP_BUILDER_TIMEOUT code mapping when builder returns timeout.
 *
 * Verifies that when runBuilder returns success=false with validationErrors
 * including STOP_BUILDER_TIMEOUT, runTick returns verdict=stop with
 * code=STOP_BUILDER_TIMEOUT (not STOP_INTERRUPTED).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { runTick } from '@/runner/tick.js';
import { createMockConfig, createMockTask } from '../helpers/mocks.js';
import type { EnvoiConfig } from '@/types/config.js';
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

describe('tick: STOP_BUILDER_TIMEOUT code mapping', () => {
  let config: EnvoiConfig;

  beforeEach(async () => {
    vi.clearAllMocks();
    writtenFiles.clear();
    config = createMockConfig();

    // Set up default mock implementations
    const { acquireLock, releaseLock } = await import('@/lib/lock.js');
    const { getHeadCommit } = await import('@/lib/git.js');
    const { runPreflight } = await import('@/lib/preflight.js');
    const { runOrchestrator } = await import('@/runner/orchestrator.js');
    const { runBuilder } = await import('@/runner/builder.js');
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
    vi.mocked(atomicWriteJson).mockImplementation(async (path: string, data: unknown) => {
      writtenFiles.set(path, data);
    });
    vi.mocked(renderReportMarkdown).mockReturnValue('# Envoi Report\n\nMock markdown content');
    vi.mocked(writeReportMarkdown).mockImplementation(async (content: string, path: string) => {
      writtenFiles.set(path, content);
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

    // Mock orchestrator to return a task
    const task = createMockTask('execute', {
      builder: {
        mode: 'claude_code',
        max_turns: 4,
        instructions: 'Test instructions',
      },
    });

    vi.mocked(runOrchestrator).mockResolvedValue({
      success: true,
      task,
      error: null,
      rawResponse: JSON.stringify(task),
      rawStderr: '',
      attempts: 1,
      retryReason: null,
    });

    // Mock builder to return failure with STOP_BUILDER_TIMEOUT
    vi.mocked(runBuilder).mockResolvedValue({
      success: false,
      result: null,
      rawResponse: 'External driver timed out after 30s',
      durationMs: 30000,
      builderOutputValid: false,
      validationErrors: ['STOP_BUILDER_TIMEOUT'],
      turnsRequested: 4,
      turnsUsed: null,
      parseErrorKind: 'cli_error',
    });
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  it('should return STOP_BUILDER_TIMEOUT when builder returns timeout', async () => {
    const report = await runTick(config);

    expect(report.verdict).toBe('stop');
    expect(report.code).toBe('STOP_BUILDER_TIMEOUT');
    expect(report.code).not.toBe('STOP_INTERRUPTED');
    expect(report.budgets.ticks).toBe(1);
    expect(report.budgets.orchestrator_calls).toBe(1);
    expect(report.budgets.builder_calls).toBe(1);
  });

  it('should persist builder failure artifacts', async () => {
    const { persistBuilderFailure } = await import('@/lib/history.js');

    await runTick(config);

    expect(persistBuilderFailure).toHaveBeenCalled();
    const callArgs = vi.mocked(persistBuilderFailure).mock.calls[0];
    expect(callArgs[3]).toBeDefined();
    expect(callArgs[3].details.validationErrors).toContain('STOP_BUILDER_TIMEOUT');
  });

  it('should prefer explicit STOP_BUILDER_TIMEOUT over parseErrorKind mapping', async () => {
    const { runBuilder } = await import('@/runner/builder.js');
    
    // Mock builder with both validationErrors and parseErrorKind
    vi.mocked(runBuilder).mockResolvedValue({
      success: false,
      result: null,
      rawResponse: 'External driver timed out after 30s',
      durationMs: 30000,
      builderOutputValid: false,
      validationErrors: ['STOP_BUILDER_TIMEOUT'],
      turnsRequested: 4,
      turnsUsed: null,
      parseErrorKind: 'json_parse', // This should be ignored in favor of explicit code
    });

    const report = await runTick(config);

    expect(report.code).toBe('STOP_BUILDER_TIMEOUT');
    expect(report.code).not.toBe('STOP_BUILDER_JSON_PARSE');
  });
});
