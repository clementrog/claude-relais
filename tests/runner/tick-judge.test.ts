/**
 * Tests for JUDGE phase in tick runner.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { runTick } from '@/runner/tick.js';
import type { EnvoiConfig } from '@/types/config.js';

// Mock dependencies
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

vi.mock('@/lib/judge.js', () => ({
  getTouchedFiles: vi.fn(),
  checkScopeViolations: vi.fn(),
  computeBlastRadius: vi.fn(),
  checkDiffLimits: vi.fn(),
  checkHeadMoved: vi.fn(),
}));

vi.mock('@/runner/orchestrator.js');
vi.mock('@/runner/builder.js');

import { runOrchestrator } from '@/runner/orchestrator.js';
import { runBuilder } from '@/runner/builder.js';
import { releaseLock } from '@/lib/lock.js';
import { rollbackToCommit, verifyCleanWorktree } from '@/lib/rollback.js';
import {
  getTouchedFiles,
  checkScopeViolations,
  computeBlastRadius,
  checkDiffLimits,
  checkHeadMoved,
} from '@/lib/judge.js';

const mockRunOrchestrator = vi.mocked(runOrchestrator);
const mockRunBuilder = vi.mocked(runBuilder);
const mockReleaseLock = vi.mocked(releaseLock);
const mockRollbackToCommit = vi.mocked(rollbackToCommit);
const mockVerifyCleanWorktree = vi.mocked(verifyCleanWorktree);
const mockGetTouchedFiles = vi.mocked(getTouchedFiles);
const mockCheckScopeViolations = vi.mocked(checkScopeViolations);
const mockComputeBlastRadius = vi.mocked(computeBlastRadius);
const mockCheckDiffLimits = vi.mocked(checkDiffLimits);
const mockCheckHeadMoved = vi.mocked(checkHeadMoved);

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

const mockTask = {
  task_id: 'test-task',
  milestone_id: 'M1',
  task_kind: 'execute' as const,
  intent: 'Test task',
  scope: { allowed_globs: ['src/**'], forbidden_globs: [], allow_new_files: true, allow_lockfile_changes: false },
  verify: [],
};

describe('runTick JUDGE phase', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    
    // Default successful mocks
    mockRunOrchestrator.mockResolvedValue({ success: true, task: mockTask });
    mockRunBuilder.mockResolvedValue({ success: true, result: { status: 'completed' }, builderOutputValid: true });
    mockCheckHeadMoved.mockReturnValue({ ok: true, stopCode: null, expectedHead: 'abc123', actualHead: 'abc123', reason: null });
    mockGetTouchedFiles.mockReturnValue({ modified: [], added: [], deleted: [], renamed: [], untracked: [], all: [] });
    mockComputeBlastRadius.mockReturnValue({ files_touched: 0, lines_added: 0, lines_deleted: 0, new_files: 0 });
    mockCheckScopeViolations.mockReturnValue({ ok: true, stopCode: null, violatingFiles: [], reason: null });
    mockCheckDiffLimits.mockReturnValue({ ok: true, stopCode: null, blastRadius: { files_touched: 0, lines_added: 0, lines_deleted: 0, new_files: 0 }, reason: null });
    mockRollbackToCommit.mockReturnValue({ ok: true, restoredCommit: 'abc123', removedFiles: [], error: null });
    mockVerifyCleanWorktree.mockReturnValue(true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should return STOP_HEAD_MOVED when HEAD moves externally', async () => {
    mockCheckHeadMoved.mockReturnValue({
      ok: false,
      stopCode: 'STOP_HEAD_MOVED',
      expectedHead: 'abc123',
      actualHead: 'def456',
      reason: 'HEAD moved externally',
    });

    const config = createMockConfig();
    const report = await runTick(config);

    expect(report.verdict).toBe('stop');
    expect(report.code).toBe('STOP_HEAD_MOVED');
  });

  it('should return STOP_SCOPE_VIOLATION_FORBIDDEN when touching forbidden files', async () => {
    mockGetTouchedFiles.mockReturnValue({
      modified: ['.git/config'],
      added: [],
      deleted: [],
      renamed: [],
      untracked: [],
      all: ['.git/config'],
    });
    mockComputeBlastRadius.mockReturnValue({ files_touched: 1, lines_added: 5, lines_deleted: 0, new_files: 0 });
    mockCheckScopeViolations.mockReturnValue({
      ok: false,
      stopCode: 'STOP_SCOPE_VIOLATION_FORBIDDEN',
      violatingFiles: ['.git/config'],
      reason: 'Touched forbidden path',
    });

    const config = createMockConfig();
    const report = await runTick(config);

    expect(report.verdict).toBe('stop');
    expect(report.code).toBe('STOP_SCOPE_VIOLATION_FORBIDDEN');
    expect(mockRollbackToCommit).toHaveBeenCalled();
  });

  it('should return STOP_DIFF_TOO_LARGE when diff exceeds limits', async () => {
    mockGetTouchedFiles.mockReturnValue({
      modified: ['src/big.ts'],
      added: [],
      deleted: [],
      renamed: [],
      untracked: [],
      all: ['src/big.ts'],
    });
    mockComputeBlastRadius.mockReturnValue({ files_touched: 1, lines_added: 1000, lines_deleted: 0, new_files: 0 });
    mockCheckDiffLimits.mockReturnValue({
      ok: false,
      stopCode: 'STOP_DIFF_TOO_LARGE',
      blastRadius: { files_touched: 1, lines_added: 1000, lines_deleted: 0, new_files: 0 },
      reason: 'lines_changed exceeds limit',
    });

    const config = createMockConfig();
    const report = await runTick(config);

    expect(report.verdict).toBe('stop');
    expect(report.code).toBe('STOP_DIFF_TOO_LARGE');
    expect(mockRollbackToCommit).toHaveBeenCalled();
  });

  it('should return STOP_QUESTION_SIDE_EFFECTS for question task with changes', async () => {
    mockRunOrchestrator.mockResolvedValue({
      success: true,
      task: { ...mockTask, task_kind: 'question' },
    });
    mockGetTouchedFiles.mockReturnValue({
      modified: ['src/file.ts'],
      added: [],
      deleted: [],
      renamed: [],
      untracked: [],
      all: ['src/file.ts'],
    });
    mockComputeBlastRadius.mockReturnValue({ files_touched: 1, lines_added: 5, lines_deleted: 0, new_files: 0 });

    const config = createMockConfig();
    const report = await runTick(config);

    expect(report.verdict).toBe('stop');
    expect(report.code).toBe('STOP_QUESTION_SIDE_EFFECTS');
    expect(mockRollbackToCommit).toHaveBeenCalled();
  });

  it('should return SUCCESS when all judge checks pass', async () => {
    const config = createMockConfig();
    const report = await runTick(config);

    expect(report.verdict).toBe('success');
    expect(report.code).toBe('SUCCESS');
    expect(mockRollbackToCommit).not.toHaveBeenCalled();
  });

  it('should call rollback with untracked files on scope violation', async () => {
    mockGetTouchedFiles.mockReturnValue({
      modified: [],
      added: [],
      deleted: [],
      renamed: [],
      untracked: ['new-file.ts'],
      all: ['new-file.ts'],
    });
    mockComputeBlastRadius.mockReturnValue({ files_touched: 1, lines_added: 10, lines_deleted: 0, new_files: 1 });
    mockCheckScopeViolations.mockReturnValue({
      ok: false,
      stopCode: 'STOP_SCOPE_VIOLATION_OUTSIDE_ALLOWED',
      violatingFiles: ['new-file.ts'],
      reason: 'Outside allowed globs',
    });

    const config = createMockConfig();
    await runTick(config);

    expect(mockRollbackToCommit).toHaveBeenCalledWith('abc123', ['new-file.ts']);
  });

  it('should delete stale BLOCKED.json on successful tick', async () => {
    const { deleteBlocked } = await import('@/lib/blocked.js');
    const mockDeleteBlocked = vi.mocked(deleteBlocked);

    const config = createMockConfig();
    await runTick(config);

    expect(mockDeleteBlocked).toHaveBeenCalledWith(
      expect.stringContaining('BLOCKED.json')
    );
  });

  it('should set budgets on STOP outcomes', async () => {
    mockCheckHeadMoved.mockReturnValue({
      ok: false,
      stopCode: 'STOP_HEAD_MOVED',
      expectedHead: 'abc123',
      actualHead: 'def456',
      reason: 'HEAD moved externally',
    });

    const config = createMockConfig();
    const report = await runTick(config);

    expect(report.budgets.ticks).toBe(1);
    expect(report.budgets.orchestrator_calls).toBe(1);
    expect(report.budgets.builder_calls).toBe(1);
  });

  it('should return BLOCKED_ROLLBACK_FAILED when rollback fails', async () => {
    mockGetTouchedFiles.mockReturnValue({
      modified: ['.git/config'],
      added: [],
      deleted: [],
      renamed: [],
      untracked: [],
      all: ['.git/config'],
    });
    mockComputeBlastRadius.mockReturnValue({ files_touched: 1, lines_added: 5, lines_deleted: 0, new_files: 0 });
    mockCheckScopeViolations.mockReturnValue({
      ok: false,
      stopCode: 'STOP_SCOPE_VIOLATION_FORBIDDEN',
      violatingFiles: ['.git/config'],
      reason: 'Touched forbidden path',
    });
    // Mock rollback to fail
    mockRollbackToCommit.mockReturnValue({
      ok: false,
      restoredCommit: 'abc123',
      removedFiles: [],
      error: 'git reset failed',
    });

    const config = createMockConfig();
    const report = await runTick(config);

    expect(report.verdict).toBe('blocked');
    expect(report.code).toBe('BLOCKED_ROLLBACK_FAILED');
    expect(mockRollbackToCommit).toHaveBeenCalled();
  });

  it('should return BLOCKED_ROLLBACK_DIRTY when rollback succeeds but worktree is dirty', async () => {
    mockGetTouchedFiles.mockReturnValue({
      modified: ['.git/config'],
      added: [],
      deleted: [],
      renamed: [],
      untracked: [],
      all: ['.git/config'],
    });
    mockComputeBlastRadius.mockReturnValue({ files_touched: 1, lines_added: 5, lines_deleted: 0, new_files: 0 });
    mockCheckScopeViolations.mockReturnValue({
      ok: false,
      stopCode: 'STOP_SCOPE_VIOLATION_FORBIDDEN',
      violatingFiles: ['.git/config'],
      reason: 'Touched forbidden path',
    });
    // Mock rollback to succeed but worktree to be dirty
    mockRollbackToCommit.mockReturnValue({
      ok: true,
      restoredCommit: 'abc123',
      removedFiles: [],
      error: null,
    });
    mockVerifyCleanWorktree.mockReturnValue(false);

    const config = createMockConfig();
    const report = await runTick(config);

    expect(report.verdict).toBe('blocked');
    expect(report.code).toBe('BLOCKED_ROLLBACK_DIRTY');
    expect(mockRollbackToCommit).toHaveBeenCalled();
    expect(mockVerifyCleanWorktree).toHaveBeenCalled();
  });

  it('should return STOP code when rollback succeeds and worktree is clean', async () => {
    mockGetTouchedFiles.mockReturnValue({
      modified: ['.git/config'],
      added: [],
      deleted: [],
      renamed: [],
      untracked: [],
      all: ['.git/config'],
    });
    mockComputeBlastRadius.mockReturnValue({ files_touched: 1, lines_added: 5, lines_deleted: 0, new_files: 0 });
    mockCheckScopeViolations.mockReturnValue({
      ok: false,
      stopCode: 'STOP_SCOPE_VIOLATION_FORBIDDEN',
      violatingFiles: ['.git/config'],
      reason: 'Touched forbidden path',
    });
    // Mock rollback to succeed and worktree to be clean
    mockRollbackToCommit.mockReturnValue({
      ok: true,
      restoredCommit: 'abc123',
      removedFiles: [],
      error: null,
    });
    mockVerifyCleanWorktree.mockReturnValue(true);

    const config = createMockConfig();
    const report = await runTick(config);

    expect(report.verdict).toBe('stop');
    expect(report.code).toBe('STOP_SCOPE_VIOLATION_FORBIDDEN');
    expect(mockRollbackToCommit).toHaveBeenCalled();
    expect(mockVerifyCleanWorktree).toHaveBeenCalled();
  });

  it('should return BLOCKED_ROLLBACK_FAILED for diff too large when rollback fails', async () => {
    mockGetTouchedFiles.mockReturnValue({
      modified: ['src/big.ts'],
      added: [],
      deleted: [],
      renamed: [],
      untracked: [],
      all: ['src/big.ts'],
    });
    mockComputeBlastRadius.mockReturnValue({ files_touched: 1, lines_added: 1000, lines_deleted: 0, new_files: 0 });
    mockCheckDiffLimits.mockReturnValue({
      ok: false,
      stopCode: 'STOP_DIFF_TOO_LARGE',
      blastRadius: { files_touched: 1, lines_added: 1000, lines_deleted: 0, new_files: 0 },
      reason: 'lines_changed exceeds limit',
    });
    // Mock rollback to fail
    mockRollbackToCommit.mockReturnValue({
      ok: false,
      restoredCommit: 'abc123',
      removedFiles: [],
      error: 'git reset failed',
    });

    const config = createMockConfig();
    const report = await runTick(config);

    expect(report.verdict).toBe('blocked');
    expect(report.code).toBe('BLOCKED_ROLLBACK_FAILED');
  });
});
