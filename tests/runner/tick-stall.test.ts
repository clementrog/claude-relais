/**
 * Tests for transport stall handling in tick runner.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { runTick } from '@/runner/tick.js';
import { createTransportStallError } from '@/lib/transport.js';
import type { EnvoiConfig } from '@/types/config.js';

// Mock all dependencies
vi.mock('@/lib/lock.js', () => ({
  acquireLock: vi.fn().mockResolvedValue({ pid: 1234, acquired_at: new Date().toISOString() }),
  releaseLock: vi.fn().mockResolvedValue(undefined),
  LockHeldError: class LockHeldError extends Error {},
}));

vi.mock('@/lib/preflight.js', () => ({
  runPreflight: vi.fn().mockResolvedValue({
    ok: true,
    blocked_code: null,
    blocked_reason: null,
    warnings: [],
    base_commit: 'abc123',
  }),
}));

vi.mock('@/lib/git.js', () => ({
  getHeadCommit: vi.fn().mockReturnValue('abc123'),
  isWorktreeClean: vi.fn().mockReturnValue(true),
}));

vi.mock('@/lib/rollback.js', () => ({
  rollbackToCommit: vi.fn().mockReturnValue({ ok: true, restoredCommit: 'abc123', removedFiles: [], error: null }),
  verifyCleanWorktree: vi.fn().mockReturnValue(true),
}));

vi.mock('@/lib/fs.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/fs.js')>();
  return {
    ...actual,
    atomicWriteJson: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock('@/lib/blocked.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/blocked.js')>();
  return {
    ...actual,
    writeBlocked: vi.fn().mockResolvedValue(undefined),
    deleteBlocked: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock('@/lib/report.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/report.js')>();
  return {
    ...actual,
    writeReportMarkdown: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock('node:fs/promises', () => ({
  writeFile: vi.fn().mockResolvedValue(undefined),
  rename: vi.fn().mockResolvedValue(undefined),
  open: vi.fn().mockResolvedValue({
    writeFile: vi.fn().mockResolvedValue(undefined),
    sync: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
  }),
  unlink: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/lib/tick.js', () => ({
  handleTransportStall: vi.fn().mockResolvedValue({
    status: 'BLOCKED',
    blockedCode: 'BLOCKED_TRANSPORT_STALLED',
    stage: 'ORCHESTRATE',
    requestId: 'req-123',
    rawError: 'Connection stalled',
    rollbackPerformed: false,
    rollbackResult: null,
    wasDirty: false,
    baseCommit: 'abc123',
  }),
}));

vi.mock('@/runner/orchestrator.js');
vi.mock('@/runner/builder.js');

import { runOrchestrator } from '@/runner/orchestrator.js';
import { runBuilder } from '@/runner/builder.js';
import { releaseLock } from '@/lib/lock.js';
import { atomicWriteJson } from '@/lib/fs.js';
import { handleTransportStall } from '@/lib/tick.js';

const mockRunOrchestrator = vi.mocked(runOrchestrator);
const mockRunBuilder = vi.mocked(runBuilder);
const mockReleaseLock = vi.mocked(releaseLock);
const mockAtomicWriteJson = vi.mocked(atomicWriteJson);
const mockHandleTransportStall = vi.mocked(handleTransportStall);

const createMockConfig = (): EnvoiConfig => ({
  v: 2,
  workspace_dir: '/tmp/test-workspace',
  runner: {
    require_git: true,
    max_tick_seconds: 300,
    lockfile: 'relais/lock.json',
    runner_owned_globs: ['relais/**'],
    crash_cleanup: { delete_tmp_glob: 'relais/*.tmp', validate_runner_json_files: true },
    render_report_md: { enabled: true, max_chars: 5000 },
  },
  claude_code_cli: { command: 'claude', output_format: 'json', no_session_persistence: true },
  models: {
    orchestrator_model: 'claude-sonnet-4-20250514',
    orchestrator_fallback_model: 'claude-sonnet-4-20250514',
    builder_model: 'claude-sonnet-4-20250514',
    builder_fallback_model: 'claude-sonnet-4-20250514',
  },
  orchestrator: {
    max_turns: 10,
    permission_mode: 'plan',
    allowed_tools: '',
    system_prompt_file: 'prompts/orchestrator.system.txt',
    user_prompt_file: 'prompts/orchestrator.user.txt',
    task_schema_file: 'schemas/task.schema.json',
    max_parse_retries_per_tick: 2,
    max_budget_usd: 1,
  },
  builder: {
    default_mode: 'claude_code',
    allow_patch_mode: true,
    claude_code: {
      max_turns: 50,
      permission_mode: 'bypassPermissions',
      allowed_tools: '',
      system_prompt_file: 'prompts/builder.system.txt',
      user_prompt_file: 'prompts/builder.user.txt',
      builder_result_schema_file: 'schemas/builder_result.schema.json',
      max_budget_usd: 5,
      strict_builder_json: true,
    },
    patch: { max_patch_attempts_per_milestone: 3 },
  },
  scope: {
    default_allowed_globs: ['src/**'],
    default_forbidden_globs: ['.git/**'],
    default_allow_new_files: true,
    default_allow_lockfile_changes: false,
    lockfiles: ['pnpm-lock.yaml'],
  },
  diff_limits: { default_max_files_touched: 20, default_max_lines_changed: 500 },
  verify: [],
  reviewer: { enabled: false } as any,
  guardrails: {
    identical_task_max_redispatches: 3,
    require_branch_match: true,
    require_clean_worktree: true,
    max_consecutive_failures: 3,
  },
  history: { enabled: true, retention_count: 50, dir: 'relais/history' },
} as EnvoiConfig);

describe('runTick stall handling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should handle transport stall during ORCHESTRATE phase', async () => {
    const stallError = createTransportStallError('ORCHESTRATE', 'Connection stalled', 'req-123');
    mockRunOrchestrator.mockRejectedValue(stallError);
    mockHandleTransportStall.mockResolvedValue({
      status: 'BLOCKED',
      blockedCode: 'BLOCKED_TRANSPORT_STALLED',
      stage: 'ORCHESTRATE',
      requestId: 'req-123',
      rawError: 'Connection stalled',
      rollbackPerformed: false,
      rollbackResult: null,
      wasDirty: false,
      baseCommit: 'abc123',
    });

    const config = createMockConfig();
    const report = await runTick(config);

    expect(report.verdict).toBe('blocked');
    expect(report.code).toBe('BLOCKED_TRANSPORT_STALLED');
    expect(mockReleaseLock).toHaveBeenCalled();
  });

  it('should handle transport stall during BUILD phase', async () => {
    mockRunOrchestrator.mockResolvedValue({
      success: true,
      task: {
        task_id: 'test-task',
        milestone_id: 'M1',
        task_kind: 'execute',
        intent: 'Test task',
        scope: { allowed_globs: ['src/**'], forbidden_globs: [], allow_new_files: true, allow_lockfile_changes: false },
        verify: [],
      },
    });
    
    const stallError = createTransportStallError('BUILD', 'Connection stalled', 'req-456');
    mockRunBuilder.mockRejectedValue(stallError);
    mockHandleTransportStall.mockResolvedValue({
      status: 'BLOCKED',
      blockedCode: 'BLOCKED_TRANSPORT_STALLED',
      stage: 'BUILD',
      requestId: 'req-456',
      rawError: 'Connection stalled',
      rollbackPerformed: false,
      rollbackResult: null,
      wasDirty: false,
      baseCommit: 'abc123',
    });

    const config = createMockConfig();
    const report = await runTick(config);

    expect(report.verdict).toBe('blocked');
    expect(report.code).toBe('BLOCKED_TRANSPORT_STALLED');
    expect(mockReleaseLock).toHaveBeenCalled();
  });

  it('should write BLOCKED report to REPORT.json on stall', async () => {
    const stallError = createTransportStallError('ORCHESTRATE', 'Connection stalled');
    mockRunOrchestrator.mockRejectedValue(stallError);
    mockHandleTransportStall.mockResolvedValue({
      status: 'BLOCKED',
      blockedCode: 'BLOCKED_TRANSPORT_STALLED',
      stage: 'ORCHESTRATE',
      requestId: null,
      rawError: 'Connection stalled',
      rollbackPerformed: false,
      rollbackResult: null,
      wasDirty: false,
      baseCommit: 'abc123',
    });

    const config = createMockConfig();
    await runTick(config);

    expect(mockAtomicWriteJson).toHaveBeenCalledWith(
      expect.stringContaining('REPORT.json'),
      expect.objectContaining({ code: 'BLOCKED_TRANSPORT_STALLED' })
    );
  });

  it('should rethrow non-stall errors', async () => {
    const regularError = new Error('Some other error');
    mockRunOrchestrator.mockRejectedValue(regularError);

    const config = createMockConfig();

    await expect(runTick(config)).rejects.toThrow('Some other error');
  });

  it('should write BLOCKED.json on transport stall', async () => {
    const { writeBlocked } = await import('@/lib/blocked.js');
    const mockWriteBlocked = vi.mocked(writeBlocked);

    const stallError = createTransportStallError('ORCHESTRATE', 'Connection stalled', 'req-123');
    mockRunOrchestrator.mockRejectedValue(stallError);
    mockHandleTransportStall.mockResolvedValue({
      status: 'BLOCKED',
      blockedCode: 'BLOCKED_TRANSPORT_STALLED',
      stage: 'ORCHESTRATE',
      requestId: 'req-123',
      rawError: 'Connection stalled',
      rollbackPerformed: false,
      rollbackResult: null,
      wasDirty: false,
      baseCommit: 'abc123',
    });

    const config = createMockConfig();
    await runTick(config);

    expect(mockWriteBlocked).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'BLOCKED_TRANSPORT_STALLED' }),
      expect.stringContaining('BLOCKED.json')
    );
  });

  it('should set budgets on transport stall', async () => {
    const stallError = createTransportStallError('ORCHESTRATE', 'Connection stalled', 'req-123');
    mockRunOrchestrator.mockRejectedValue(stallError);
    mockHandleTransportStall.mockResolvedValue({
      status: 'BLOCKED',
      blockedCode: 'BLOCKED_TRANSPORT_STALLED',
      stage: 'ORCHESTRATE',
      requestId: 'req-123',
      rawError: 'Connection stalled',
      rollbackPerformed: false,
      rollbackResult: null,
      wasDirty: false,
      baseCommit: 'abc123',
    });

    const config = createMockConfig();
    const report = await runTick(config);

    expect(report.budgets.ticks).toBe(1);
    expect(report.budgets.orchestrator_calls).toBe(1);
  });
});
