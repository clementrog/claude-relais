/**
 * Tests for per_tick branching in tick runner.
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

vi.mock('@/lib/git_branching.js', () => ({
  ensureBranchPerTick: vi.fn(),
  ensureBranchPerNTasks: vi.fn(),
  ensureBranchPerMilestone: vi.fn(),
}));

vi.mock('@/lib/workspace_state.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/workspace_state.js')>();
  return {
    ...actual,
    readWorkspaceState: vi.fn(),
    writeWorkspaceState: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock('@/runner/orchestrator.js');
vi.mock('@/runner/builder.js');

import { runOrchestrator } from '@/runner/orchestrator.js';
import { runBuilder } from '@/runner/builder.js';
import {
  ensureBranchPerTick,
  ensureBranchPerNTasks,
  ensureBranchPerMilestone,
} from '@/lib/git_branching.js';
import { readWorkspaceState } from '@/lib/workspace_state.js';
import {
  getTouchedFiles,
  checkScopeViolations,
  computeBlastRadius,
  checkDiffLimits,
  checkHeadMoved,
} from '@/lib/judge.js';

const mockRunOrchestrator = vi.mocked(runOrchestrator);
const mockRunBuilder = vi.mocked(runBuilder);
const mockEnsureBranchPerTick = vi.mocked(ensureBranchPerTick);
const mockReadWorkspaceState = vi.mocked(readWorkspaceState);
const mockGetTouchedFiles = vi.mocked(getTouchedFiles);
const mockCheckScopeViolations = vi.mocked(checkScopeViolations);
const mockComputeBlastRadius = vi.mocked(computeBlastRadius);
const mockCheckDiffLimits = vi.mocked(checkDiffLimits);
const mockCheckHeadMoved = vi.mocked(checkHeadMoved);

const createMockConfig = (branchingMode: 'off' | 'per_tick' = 'off'): EnvoiConfig => ({
  version: '1.0',
  product_name: 'relais',
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
    reject_metachars_regex: '[;&|$\\\\><(){}\\[\\]`\\n\\r\\t\\0]',
    timeout_fast_seconds: 90,
    timeout_slow_seconds: 600,
    templates: [],
  },
  budgets: {
    per_milestone: {
      max_ticks: 200,
      max_orchestrator_calls: 260,
      max_builder_calls: 200,
      max_verify_runs: 600,
      max_estimated_cost_usd: 80.0,
    },
    warn_at_fraction: 0.8,
  },
  history: {
    enabled: true,
    dir: 'relais/history',
    max_mb: 500,
    include_diff_patch: true,
    include_verify_log: true,
  },
  git: {
    branching: {
      mode: branchingMode,
      name_template: 'relais/{{task_id}}',
    },
  },
} as EnvoiConfig);

const mockTask = {
  task_id: 'WP-001',
  milestone_id: 'M1',
  task_kind: 'execute' as const,
  intent: 'Test task',
  scope: { allowed_globs: ['src/**'], forbidden_globs: [], allow_new_files: true, allow_lockfile_changes: false },
  verification: { fast: [], slow: [] },
};

describe('runTick branching (per_tick)', () => {
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
    mockReadWorkspaceState.mockResolvedValue({
      milestone_id: 'M1',
      budgets: {
        ticks: 0,
        orchestrator_calls: 0,
        builder_calls: 0,
        verify_runs: 0,
      },
      budget_warning: false,
      last_run_id: null,
      last_verdict: null,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should create/switch branch before BUILD when mode=per_tick and task_kind=execute', async () => {
    const config = createMockConfig('per_tick');
    mockEnsureBranchPerTick.mockReturnValue({
      ok: true,
      branchName: 'relais/WP-001',
      existed: false,
    });

    const report = await runTick(config);

    expect(mockEnsureBranchPerTick).toHaveBeenCalledWith(
      config.git!.branching!,
      expect.objectContaining({
        task_id: 'WP-001',
        milestone_id: 'M1',
        run_id: expect.any(String),
        tick_count: 1,
      })
    );
    expect(report.verdict).toBe('success');
    expect(report.budgets.warnings).toContain('Branch: relais/WP-001');
  });

  it('should reuse existing branch if it already exists', async () => {
    const config = createMockConfig('per_tick');
    mockEnsureBranchPerTick.mockReturnValue({
      ok: true,
      branchName: 'relais/WP-001',
      existed: true,
    });

    const report = await runTick(config);

    expect(mockEnsureBranchPerTick).toHaveBeenCalled();
    expect(report.verdict).toBe('success');
    expect(report.budgets.warnings).toContain('Branch: relais/WP-001');
  });

  it('should not create branch when mode=off', async () => {
    const config = createMockConfig('off');

    const report = await runTick(config);

    expect(mockEnsureBranchPerTick).not.toHaveBeenCalled();
    expect(report.verdict).toBe('success');
    expect(report.budgets.warnings.find((w) => w.startsWith('Branch:'))).toBeUndefined();
  });

  it('should not create branch when task_kind is not execute', async () => {
    const config = createMockConfig('per_tick');
    mockRunOrchestrator.mockResolvedValue({
      success: true,
      task: {
        ...mockTask,
        task_kind: 'question' as const,
      },
    });

    const report = await runTick(config);

    expect(mockEnsureBranchPerTick).not.toHaveBeenCalled();
    expect(report.verdict).toBe('stop');
    expect(report.code).toBe('STOP_ORCHESTRATOR_ASK_QUESTION');
  });

  it('should return BLOCKED_BRANCH_FAILED when branch creation fails', async () => {
    const config = createMockConfig('per_tick');
    mockEnsureBranchPerTick.mockReturnValue({
      ok: false,
      branchName: 'relais/WP-001',
      existed: false,
      error: 'Git checkout failed: permission denied',
    });

    const report = await runTick(config);

    expect(report.verdict).toBe('blocked');
    expect(report.code).toBe('BLOCKED_BRANCH_FAILED');
    expect(report.budgets.warnings.some((w) => w.includes('Failed to create/switch branch'))).toBe(true);
    expect(mockRunBuilder).not.toHaveBeenCalled(); // Builder should not run if branching fails
  });

  it('should use tick_count from workspace state', async () => {
    const config = createMockConfig('per_tick');
    mockReadWorkspaceState.mockResolvedValue({
      milestone_id: 'M1',
      budgets: {
        ticks: 5, // Already had 5 ticks
        orchestrator_calls: 0,
        builder_calls: 0,
        verify_runs: 0,
      },
      budget_warning: false,
      last_run_id: null,
      last_verdict: null,
    });
    mockEnsureBranchPerTick.mockReturnValue({
      ok: true,
      branchName: 'relais/WP-001',
      existed: false,
    });

    await runTick(config);

    expect(mockEnsureBranchPerTick).toHaveBeenCalledWith(
      config.git!.branching!,
      expect.objectContaining({
        tick_count: 6, // Should be 5 + 1
      })
    );
  });

  it('should handle second tick with deterministic branch naming', async () => {
    const config = createMockConfig('per_tick');
    
    // First tick
    mockEnsureBranchPerTick.mockReturnValueOnce({
      ok: true,
      branchName: 'relais/WP-001',
      existed: false,
    });
    
    const report1 = await runTick(config);
    expect(report1.verdict).toBe('success');
    expect(report1.budgets.warnings).toContain('Branch: relais/WP-001');
    
    // Second tick - should reuse or create deterministically
    mockReadWorkspaceState.mockResolvedValue({
      milestone_id: 'M1',
      budgets: {
        ticks: 1,
        orchestrator_calls: 1,
        builder_calls: 1,
        verify_runs: 0,
      },
      budget_warning: false,
      last_run_id: report1.run_id,
      last_verdict: 'success',
    });
    mockEnsureBranchPerTick.mockReturnValueOnce({
      ok: true,
      branchName: 'relais/WP-001-1', // Collision handled with suffix
      existed: false,
    });
    
    const report2 = await runTick(config);
    expect(report2.verdict).toBe('success');
    expect(report2.budgets.warnings).toContain('Branch: relais/WP-001-1');
  });
});
