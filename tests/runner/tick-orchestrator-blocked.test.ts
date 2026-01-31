/**
 * Tests for BLOCKED_ORCHESTRATOR_OUTPUT_INVALID behavior in tick.ts
 *
 * Verifies that when orchestrator output is invalid:
 * 1. BLOCKED.json is written with diagnostics
 * 2. REPORT.json has correct orchestrator_calls and warnings
 * 3. REPORT.md is written when render_report_md.enabled=true
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { runTick } from '@/runner/tick.js';
import { createMockConfig } from '../helpers/mocks.js';
import type { RelaisConfig } from '@/types/config.js';
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

vi.mock('@/lib/fs.js', () => ({
  atomicWriteJson: vi.fn(),
  AtomicFsError: class extends Error {
    constructor(message: string, public readonly path: string) {
      super(message);
    }
  },
}));

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

describe('tick: BLOCKED_ORCHESTRATOR_OUTPUT_INVALID', () => {
  let config: RelaisConfig;

  beforeEach(async () => {
    vi.clearAllMocks();
    writtenFiles.clear();
    config = createMockConfig();
    config.runner.render_report_md = { enabled: true, max_chars: 6000 };

    // Set up default mock implementations
    const { acquireLock, releaseLock } = await import('@/lib/lock.js');
    const { getHeadCommit } = await import('@/lib/git.js');
    const { runPreflight } = await import('@/lib/preflight.js');
    const { atomicWriteJson } = await import('@/lib/fs.js');
    const { renderReportMarkdown, writeReportMarkdown } = await import('@/lib/report.js');
    const { writeBlocked } = await import('@/lib/blocked.js');

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
    vi.mocked(renderReportMarkdown).mockReturnValue('# Relais Report\n\nMock markdown content');
    vi.mocked(writeReportMarkdown).mockImplementation(async (content: string, path: string) => {
      writtenFiles.set(path, content);
    });
    vi.mocked(writeBlocked).mockImplementation(async (data: BlockedData, path: string) => {
      writtenFiles.set(path, data);
    });
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  it('should write BLOCKED.json with diagnostics when orchestrator fails', async () => {
    const { runOrchestrator } = await import('@/runner/orchestrator.js');

    vi.mocked(runOrchestrator).mockResolvedValue({
      success: false,
      task: null,
      error: 'Task validation failed: Missing required property: task_id',
      rawResponse: '{ "invalid": "task" }',
      attempts: 2,
      retryReason: 'Task validation failed: Missing required property: task_id',
      diagnostics: {
        schemaErrors: [
          {
            instancePath: '',
            schemaPath: '#/required',
            keyword: 'required',
            params: { missingProperty: 'task_id' },
            message: "must have required property 'task_id'",
          },
        ],
        extractMethod: 'direct_parse',
      },
    });

    const report = await runTick(config);

    // Verify BLOCKED.json was written
    const blockedPath = Array.from(writtenFiles.keys()).find((k) => k.includes('BLOCKED.json'));
    expect(blockedPath).toBeDefined();

    const blockedData = writtenFiles.get(blockedPath!) as BlockedData;
    expect(blockedData.code).toBe('BLOCKED_ORCHESTRATOR_OUTPUT_INVALID');
    expect(blockedData.reason).toContain('Task validation failed');
    expect(blockedData.diagnostics).toBeDefined();
    expect(blockedData.diagnostics?.schema_errors).toBeDefined();
    expect(blockedData.diagnostics?.schema_errors?.length).toBeGreaterThan(0);
    expect(blockedData.diagnostics?.extract_method).toBe('direct_parse');
    expect(blockedData.diagnostics?.stdout_excerpt).toBeDefined();
    expect(blockedData.diagnostics?.json_excerpt).toBeDefined();
  });

  it('should set orchestrator_calls >= 1 in REPORT.json when orchestrator fails', async () => {
    const { runOrchestrator } = await import('@/runner/orchestrator.js');

    vi.mocked(runOrchestrator).mockResolvedValue({
      success: false,
      task: null,
      error: 'Failed to parse orchestrator output as JSON',
      rawResponse: 'not json',
      attempts: 2,
      retryReason: 'Failed to parse orchestrator output as JSON',
      diagnostics: {
        extractMethod: 'direct_parse',
      },
    });

    const report = await runTick(config);

    expect(report.code).toBe('BLOCKED_ORCHESTRATOR_OUTPUT_INVALID');
    expect(report.budgets.orchestrator_calls).toBe(2);
    expect(report.budgets.warnings.length).toBeGreaterThan(0);
    expect(report.budgets.warnings[0]).toContain('Orchestrator output invalid');
  });

  it('should write REPORT.md when render_report_md.enabled=true and orchestrator fails', async () => {
    const { runOrchestrator } = await import('@/runner/orchestrator.js');
    const { writeReportMarkdown } = await import('@/lib/report.js');

    vi.mocked(runOrchestrator).mockResolvedValue({
      success: false,
      task: null,
      error: 'Failed to parse orchestrator output as JSON',
      rawResponse: 'not json',
      attempts: 2,
      retryReason: 'Failed to parse orchestrator output as JSON',
    });

    await runTick(config);

    expect(writeReportMarkdown).toHaveBeenCalled();
    const reportMdPath = Array.from(writtenFiles.keys()).find((k) => k.includes('REPORT.md'));
    expect(reportMdPath).toBeDefined();
  });

  it('should NOT write REPORT.md when render_report_md.enabled=false', async () => {
    const { runOrchestrator } = await import('@/runner/orchestrator.js');
    const { writeReportMarkdown } = await import('@/lib/report.js');

    config.runner.render_report_md = { enabled: false, max_chars: 6000 };

    vi.mocked(runOrchestrator).mockResolvedValue({
      success: false,
      task: null,
      error: 'Failed to parse orchestrator output as JSON',
      rawResponse: 'not json',
      attempts: 2,
      retryReason: 'Failed to parse orchestrator output as JSON',
    });

    await runTick(config);

    expect(writeReportMarkdown).not.toHaveBeenCalled();
  });

  it('should include AJV schema errors in BLOCKED.json diagnostics', async () => {
    const { runOrchestrator } = await import('@/runner/orchestrator.js');

    const schemaErrors = [
      {
        instancePath: '',
        schemaPath: '#/required',
        keyword: 'required',
        params: { missingProperty: 'task_id' },
        message: "must have required property 'task_id'",
      },
      {
        instancePath: '/task_kind',
        schemaPath: '#/properties/task_kind/enum',
        keyword: 'enum',
        params: { allowedValues: ['execute', 'question', 'verify_only'] },
        message: 'must be equal to one of the allowed values',
      },
    ];

    vi.mocked(runOrchestrator).mockResolvedValue({
      success: false,
      task: null,
      error: 'Task validation failed: multiple errors',
      rawResponse: '{ "task_kind": "invalid_kind" }',
      attempts: 2,
      retryReason: 'Task validation failed: multiple errors',
      diagnostics: {
        schemaErrors,
        extractMethod: 'direct_parse',
      },
    });

    await runTick(config);

    const blockedPath = Array.from(writtenFiles.keys()).find((k) => k.includes('BLOCKED.json'));
    const blockedData = writtenFiles.get(blockedPath!) as BlockedData;

    expect(blockedData.diagnostics?.schema_errors).toHaveLength(2);
    expect(blockedData.diagnostics?.schema_errors?.[0].keyword).toBe('required');
    expect(blockedData.diagnostics?.schema_errors?.[1].keyword).toBe('enum');
  });

  it('should set ticks=1 in budgets for blocked outcomes', async () => {
    const { runOrchestrator } = await import('@/runner/orchestrator.js');

    vi.mocked(runOrchestrator).mockResolvedValue({
      success: false,
      task: null,
      error: 'Failed to parse orchestrator output as JSON',
      rawResponse: 'not json',
      attempts: 2,
      retryReason: 'Failed to parse orchestrator output as JSON',
    });

    const report = await runTick(config);

    expect(report.budgets.ticks).toBe(1);
  });
});
