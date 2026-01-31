/**
 * Tests for verification execution in tick runner.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { runTick } from '@/runner/tick.js';
import type { RelaisConfig } from '@/types/config.js';

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
  getTouchedFiles: vi.fn().mockReturnValue({ modified: [], added: [], deleted: [], renamed: [], untracked: [], all: [] }),
  checkScopeViolations: vi.fn().mockReturnValue({ ok: true, stopCode: null, violatingFiles: [], reason: null }),
  computeBlastRadius: vi.fn().mockReturnValue({ files_touched: 0, lines_added: 0, lines_deleted: 0, new_files: 0 }),
  checkDiffLimits: vi.fn().mockReturnValue({ ok: true, stopCode: null, blastRadius: { files_touched: 0, lines_added: 0, lines_deleted: 0, new_files: 0 }, reason: null }),
  checkHeadMoved: vi.fn().mockReturnValue({ ok: true, stopCode: null, expectedHead: 'abc123', actualHead: 'abc123', reason: null }),
}));

vi.mock('@/runner/orchestrator.js');
vi.mock('@/runner/builder.js');

// Mock child_process spawn
vi.mock('node:child_process', async () => {
  const actual = await vi.importActual('node:child_process');
  return {
    ...actual,
    spawn: vi.fn(),
  };
});

import { runOrchestrator } from '@/runner/orchestrator.js';
import { runBuilder } from '@/runner/builder.js';
import { rollbackToCommit } from '@/lib/rollback.js';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';

const mockRunOrchestrator = vi.mocked(runOrchestrator);
const mockRunBuilder = vi.mocked(runBuilder);
const mockRollbackToCommit = vi.mocked(rollbackToCommit);
const mockSpawn = vi.mocked(spawn);

const createMockConfig = (): RelaisConfig => ({
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
  verification: {
    execution_mode: 'argv_no_shell',
    max_param_len: 128,
    reject_whitespace_in_params: true,
    reject_dotdot: true,
    reject_metachars_regex: '[;|&$`]',
    timeout_fast_seconds: 30,
    timeout_slow_seconds: 120,
    templates: [
      { id: 'typecheck', cmd: 'pnpm', args: ['typecheck'] },
      { id: 'test', cmd: 'pnpm', args: ['test'] },
    ],
  },
  reviewer: { enabled: false } as any,
  guardrails: {
    identical_task_max_redispatches: 3,
    require_branch_match: true,
    require_clean_worktree: true,
    max_consecutive_failures: 3,
  },
  history: { enabled: true, retention_count: 50, dir: 'relais/history' },
} as RelaisConfig);

const mockTask = {
  task_id: 'test-task',
  milestone_id: 'M1',
  task_kind: 'execute' as const,
  intent: 'Test task',
  scope: { allowed_globs: ['src/**'], forbidden_globs: [], allow_new_files: true, allow_lockfile_changes: false },
  verification: { fast: ['typecheck'], slow: ['test'], params: {} },
};

function createMockProcess(exitCode: number, delay = 10) {
  const proc = new EventEmitter() as any;
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.kill = vi.fn();
  
  setTimeout(() => {
    proc.emit('close', exitCode);
  }, delay);
  
  return proc;
}

describe('runTick verification', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRunOrchestrator.mockResolvedValue({ success: true, task: mockTask });
    mockRunBuilder.mockResolvedValue({ success: true, result: { status: 'completed' }, builderOutputValid: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should return SUCCESS when verification passes', async () => {
    mockSpawn.mockImplementation(() => createMockProcess(0));
    
    const config = createMockConfig();
    const report = await runTick(config);

    expect(report.verdict).toBe('success');
    expect(report.code).toBe('SUCCESS');
  });

  it('should return STOP_VERIFY_FAILED_FAST when fast verification fails', async () => {
    mockSpawn.mockImplementation(() => createMockProcess(1));
    
    const config = createMockConfig();
    const report = await runTick(config);

    expect(report.verdict).toBe('stop');
    expect(report.code).toBe('STOP_VERIFY_FAILED_FAST');
    expect(mockRollbackToCommit).toHaveBeenCalled();
  });

  it('should skip slow verification if fast fails', async () => {
    let callCount = 0;
    mockSpawn.mockImplementation(() => {
      callCount++;
      return createMockProcess(callCount === 1 ? 1 : 0);
    });
    
    const config = createMockConfig();
    const report = await runTick(config);

    expect(report.code).toBe('STOP_VERIFY_FAILED_FAST');
    expect(callCount).toBe(1); // Only fast was called
  });

  it('should return STOP_VERIFY_FAILED_SLOW when slow verification fails', async () => {
    let callCount = 0;
    mockSpawn.mockImplementation(() => {
      callCount++;
      return createMockProcess(callCount === 1 ? 0 : 1);
    });
    
    const config = createMockConfig();
    const report = await runTick(config);

    expect(report.verdict).toBe('stop');
    expect(report.code).toBe('STOP_VERIFY_FAILED_SLOW');
    expect(callCount).toBe(2); // Both fast and slow were called
  });

  it('should return STOP_VERIFY_TAINTED for tainted params', async () => {
    mockRunOrchestrator.mockResolvedValue({
      success: true,
      task: {
        ...mockTask,
        verification: {
          fast: ['typecheck'],
          slow: [],
          params: { typecheck: { file: 'test;rm -rf /' } },
        },
      },
    });
    
    const config = createMockConfig();
    const report = await runTick(config);

    expect(report.verdict).toBe('stop');
    expect(report.code).toBe('STOP_VERIFY_TAINTED');
  });

  it('should skip verification when no templates specified', async () => {
    mockRunOrchestrator.mockResolvedValue({
      success: true,
      task: {
        ...mockTask,
        verification: { fast: [], slow: [] },
      },
    });

    const config = createMockConfig();
    const report = await runTick(config);

    expect(report.verdict).toBe('success');
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it('should track verify_runs in budgets', async () => {
    mockSpawn.mockImplementation(() => createMockProcess(0));

    const config = createMockConfig();
    const report = await runTick(config);

    // Task has 1 fast and 1 slow verification template
    expect(report.budgets.verify_runs).toBe(2);
    expect(report.budgets.ticks).toBe(1);
    expect(report.budgets.orchestrator_calls).toBe(1);
    expect(report.budgets.builder_calls).toBe(1);
  });

  it('should track verify_runs even on failure', async () => {
    mockSpawn.mockImplementation(() => createMockProcess(1));

    const config = createMockConfig();
    const report = await runTick(config);

    expect(report.code).toBe('STOP_VERIFY_FAILED_FAST');
    expect(report.budgets.verify_runs).toBe(1); // Only fast ran before failure
    expect(report.budgets.ticks).toBe(1);
  });
});
