/**
 * Tests for orchestrator failure history artifacts in tick.ts
 *
 * Verifies that when orchestrator output is invalid:
 * 1. History artifacts are written to history/<run_id>/orchestrator/
 * 2. REPORT.json budgets.warnings includes history path pointer
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { runTick } from '@/runner/tick.js';
import { createMockConfig } from '../helpers/mocks.js';
import type { EnvoiConfig } from '@/types/config.js';
import type { OrchestratorFailureMeta } from '@/lib/history.js';

// Track what gets written to history
const historyArtifacts: Map<string, unknown> = new Map();

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

// Mock history.js to capture orchestrator failure artifacts
vi.mock('@/lib/history.js', () => ({
  persistBuilderFailure: vi.fn(),
  persistOrchestratorFailure: vi.fn(),
}));

describe('tick: orchestrator failure history artifacts', () => {
  let config: EnvoiConfig;

  beforeEach(async () => {
    vi.clearAllMocks();
    historyArtifacts.clear();
    config = createMockConfig();
    config.runner.render_report_md = { enabled: false, max_chars: 6000 };

    // Set up default mock implementations
    const { acquireLock, releaseLock } = await import('@/lib/lock.js');
    const { getHeadCommit } = await import('@/lib/git.js');
    const { runPreflight } = await import('@/lib/preflight.js');
    const { atomicWriteJson } = await import('@/lib/fs.js');
    const { writeBlocked, deleteBlocked } = await import('@/lib/blocked.js');
    const { persistOrchestratorFailure } = await import('@/lib/history.js');

    vi.mocked(acquireLock).mockResolvedValue({ pid: 123 });
    vi.mocked(releaseLock).mockResolvedValue(undefined);
    vi.mocked(getHeadCommit).mockReturnValue('abc123def456');
    vi.mocked(runPreflight).mockResolvedValue({
      ok: true,
      warnings: [],
      base_commit: 'abc123def456',
    });
    vi.mocked(atomicWriteJson).mockResolvedValue(undefined);
    vi.mocked(writeBlocked).mockResolvedValue(undefined);
    vi.mocked(deleteBlocked).mockResolvedValue(undefined);
    vi.mocked(persistOrchestratorFailure).mockImplementation(
      async (
        runId: string,
        stdout: string,
        stderr: string,
        extractedJson: unknown | null,
        schemaErrors: unknown[] | null,
        meta: OrchestratorFailureMeta,
      ) => {
        historyArtifacts.set(`${runId}/orchestrator/stdout.txt`, stdout);
        historyArtifacts.set(`${runId}/orchestrator/stderr.txt`, stderr);
        if (extractedJson !== null) {
          historyArtifacts.set(`${runId}/orchestrator/extracted.json`, extractedJson);
        }
        if (schemaErrors !== null && schemaErrors.length > 0) {
          historyArtifacts.set(`${runId}/orchestrator/schema_error.json`, schemaErrors);
        }
        historyArtifacts.set(`${runId}/orchestrator/meta.json`, meta);
      }
    );
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  it('should call persistOrchestratorFailure with stdout, stderr, meta on schema failure', async () => {
    const { runOrchestrator } = await import('@/runner/orchestrator.js');
    const { persistOrchestratorFailure } = await import('@/lib/history.js');

    const schemaErrors = [
      {
        instancePath: '',
        schemaPath: '#/required',
        keyword: 'required',
        params: { missingProperty: 'task_id' },
        message: "must have required property 'task_id'",
      },
    ];

    vi.mocked(runOrchestrator).mockResolvedValue({
      success: false,
      task: null,
      error: 'Task validation failed: Missing required property: task_id',
      rawResponse: '{ "invalid": "not a task" }',
      rawStderr: 'some stderr output',
      attempts: 2,
      retryReason: 'Task validation failed: Missing required property: task_id',
      diagnostics: {
        schemaErrors,
        extractMethod: 'direct_parse',
        extractedJson: { invalid: 'not a task' },
      },
    });

    const report = await runTick(config);

    // Verify persistOrchestratorFailure was called
    expect(persistOrchestratorFailure).toHaveBeenCalledTimes(1);

    // Verify call arguments
    const callArgs = vi.mocked(persistOrchestratorFailure).mock.calls[0];
    expect(callArgs[0]).toBe(report.run_id); // runId
    expect(callArgs[1]).toBe('{ "invalid": "not a task" }'); // stdout
    expect(callArgs[2]).toBe('some stderr output'); // stderr
    expect(callArgs[3]).toEqual({ invalid: 'not a task' }); // extractedJson
    expect(callArgs[4]).toEqual(schemaErrors); // schemaErrors
    expect(callArgs[5]).toMatchObject({
      run_id: report.run_id,
      phase: 'orchestrator',
      model: config.models.orchestrator_model,
    }); // meta
  });

  it('should include history path in REPORT.json warnings on orchestrator failure', async () => {
    const { runOrchestrator } = await import('@/runner/orchestrator.js');

    vi.mocked(runOrchestrator).mockResolvedValue({
      success: false,
      task: null,
      error: 'Failed to parse orchestrator output as JSON',
      rawResponse: 'not valid json',
      rawStderr: '',
      attempts: 2,
      retryReason: 'Failed to parse orchestrator output as JSON',
      diagnostics: {
        extractMethod: 'direct_parse',
      },
    });

    const report = await runTick(config);

    expect(report.code).toBe('BLOCKED_ORCHESTRATOR_OUTPUT_INVALID');

    // Check that one of the warnings contains the history path
    const historyWarning = report.budgets.warnings.find(w => w.includes('history/') && w.includes('/orchestrator/'));
    expect(historyWarning).toBeDefined();
    expect(historyWarning).toContain(report.run_id);
  });

  it('should pass null extractedJson when JSON parsing fails', async () => {
    const { runOrchestrator } = await import('@/runner/orchestrator.js');
    const { persistOrchestratorFailure } = await import('@/lib/history.js');

    vi.mocked(runOrchestrator).mockResolvedValue({
      success: false,
      task: null,
      error: 'Failed to parse orchestrator output as JSON',
      rawResponse: 'this is not json at all',
      rawStderr: '',
      attempts: 2,
      retryReason: 'Failed to parse orchestrator output as JSON',
      diagnostics: {
        extractMethod: 'direct_parse',
        // No extractedJson since parsing failed
      },
    });

    await runTick(config);

    expect(persistOrchestratorFailure).toHaveBeenCalledTimes(1);
    const callArgs = vi.mocked(persistOrchestratorFailure).mock.calls[0];
    expect(callArgs[3]).toBeNull(); // extractedJson is null
    expect(callArgs[4]).toBeNull(); // schemaErrors is null (no schema validation reached)
  });

  it('should pass empty stderr when not available', async () => {
    const { runOrchestrator } = await import('@/runner/orchestrator.js');
    const { persistOrchestratorFailure } = await import('@/lib/history.js');

    vi.mocked(runOrchestrator).mockResolvedValue({
      success: false,
      task: null,
      error: 'Failed to parse orchestrator output as JSON',
      rawResponse: 'not json',
      rawStderr: '', // empty stderr
      attempts: 2,
      retryReason: 'Failed to parse orchestrator output as JSON',
    });

    await runTick(config);

    expect(persistOrchestratorFailure).toHaveBeenCalledTimes(1);
    const callArgs = vi.mocked(persistOrchestratorFailure).mock.calls[0];
    expect(callArgs[2]).toBe(''); // stderr is empty string
  });

  it('should include correct meta fields', async () => {
    const { runOrchestrator } = await import('@/runner/orchestrator.js');
    const { persistOrchestratorFailure } = await import('@/lib/history.js');

    vi.mocked(runOrchestrator).mockResolvedValue({
      success: false,
      task: null,
      error: 'Task validation failed',
      rawResponse: '{}',
      rawStderr: '',
      attempts: 2,
      retryReason: 'Task validation failed',
      diagnostics: {
        schemaErrors: [{ instancePath: '', schemaPath: '', keyword: 'required', params: {} }],
      },
    });

    const report = await runTick(config);

    expect(persistOrchestratorFailure).toHaveBeenCalledTimes(1);
    const meta = vi.mocked(persistOrchestratorFailure).mock.calls[0][5] as OrchestratorFailureMeta;

    expect(meta.run_id).toBe(report.run_id);
    expect(meta.phase).toBe('orchestrator');
    expect(meta.model).toBe(config.models.orchestrator_model);
    expect(meta.timeout_ms).toBe(config.runner.max_tick_seconds * 1000);
    expect(meta.cwd).toBeDefined();
    expect(meta.args_summary_redacted).toContain('--max-turns');
    expect(meta.args_summary_redacted).toContain('--permission-mode');
  });
});
