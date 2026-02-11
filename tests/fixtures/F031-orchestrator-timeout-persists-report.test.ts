/**
 * F031: orchestrator_timeout_persists_report
 *
 * Verifies that when the orchestrator times out:
 * - A REPORT.json is written with code STOP_ORCHESTRATOR_TIMEOUT
 * - The lock is released
 * - The tick returns a stop verdict
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { runTick } from '@/runner/tick.js';
import type { EnvoiConfig } from '@/types/config.js';
import { existsSync, readFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Mock dependencies
vi.mock('@/lib/lock.js', () => ({
  acquireLock: vi.fn().mockResolvedValue({ pid: 1234, acquired_at: new Date().toISOString() }),
  releaseLock: vi.fn().mockResolvedValue(undefined),
  LockHeldError: class LockHeldError extends Error {},
  LockCorruptError: class LockCorruptError extends Error {},
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

vi.mock('@/lib/workspace_state.js', () => ({
  readWorkspaceState: vi.fn().mockResolvedValue({
    milestone_id: 'M1',
    budgets: { ticks: 0, orchestrator_calls: 0, builder_calls: 0, verify_runs: 0 },
    budget_warning: false,
    last_run_id: null,
    last_verdict: null,
  }),
  writeWorkspaceState: vi.fn().mockResolvedValue(undefined),
  ensureMilestone: vi.fn().mockImplementation((state, id) => ({ state: { ...state, milestone_id: id }, changed: true })),
  applyDeltas: vi.fn().mockImplementation((state) => state),
  computeBudgetWarning: vi.fn().mockReturnValue(false),
}));

vi.mock('@/lib/fs.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/fs.js')>();
  return {
    ...actual,
    atomicWriteJson: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock('@/lib/claude.js', () => ({
  invokeClaudeCode: vi.fn(),
  buildClaudeArgs: vi.fn().mockReturnValue([]),
  parseClaudeResponse: vi.fn(),
}));

vi.mock('@/lib/schema.js', () => ({
  loadSchema: vi.fn().mockResolvedValue({}),
  validateWithSchema: vi.fn().mockReturnValue({ valid: true, data: {}, errors: [] }),
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    readFile: vi.fn().mockResolvedValue('mock system prompt'),
    writeFile: vi.fn().mockResolvedValue(undefined),
    rename: vi.fn().mockResolvedValue(undefined),
  };
});

import { releaseLock } from '@/lib/lock.js';
import { invokeClaudeCode } from '@/lib/claude.js';
import { atomicWriteJson } from '@/lib/fs.js';
import { ClaudeError } from '@/types/claude.js';

const mockReleaseLock = vi.mocked(releaseLock);
const mockInvokeClaudeCode = vi.mocked(invokeClaudeCode);
const mockAtomicWriteJson = vi.mocked(atomicWriteJson);

function createMockConfig(workspaceDir: string): EnvoiConfig {
  return {
    version: '1',
    workspace_dir: workspaceDir,
    runner: {
      require_git: true,
      max_tick_seconds: 300,
      lockfile: join(workspaceDir, 'relais', 'lock.json'),
      runner_owned_globs: ['relais/**'],
      crash_cleanup: { delete_tmp_glob: '', validate_runner_json_files: false },
      render_report_md: { enabled: false, max_chars: 5000 },
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
      timeout_seconds: 1, // 1 second timeout for test
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
      reject_metachars_regex: '[;&|$]',
      timeout_fast_seconds: 30,
      timeout_slow_seconds: 120,
      templates: [],
    },
    budgets: {
      warn_at_fraction: 0.8,
      per_milestone: {
        max_ticks: 100,
        max_orchestrator_calls: 200,
        max_builder_calls: 200,
        max_verify_runs: 500,
        max_estimated_cost_usd: 100,
      },
    },
    reviewer: { enabled: false } as any,
    guardrails: {
      identical_task_max_redispatches: 3,
      require_branch_match: true,
      require_clean_worktree: true,
      max_consecutive_failures: 3,
    },
    history: { enabled: false, retention_count: 50, dir: 'relais/history', max_mb: 100, include_diff_patch: false, include_verify_log: false },
  } as EnvoiConfig;
}

describe('F031: orchestrator_timeout_persists_report', () => {
  let testDir: string;

  beforeEach(() => {
    vi.clearAllMocks();
    testDir = join(tmpdir(), `relais-f031-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(join(testDir, 'relais'), { recursive: true });
  });

  afterEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('should return STOP_ORCHESTRATOR_TIMEOUT when orchestrator times out', async () => {
    // Mock invokeClaudeCode to throw a timeout error (exit code 124)
    mockInvokeClaudeCode.mockRejectedValue(
      new ClaudeError('Claude Code CLI invocation timed out after 1000ms', 124, '')
    );

    const config = createMockConfig(testDir);
    const report = await runTick(config);

    // Assert report has correct code and verdict
    expect(report.verdict).toBe('stop');
    expect(report.code).toBe('STOP_ORCHESTRATOR_TIMEOUT');
    expect(report.task.intent).toContain('Orchestrator timed out after');
    expect(report.budgets.warnings[0]).toContain('Orchestrator timed out after');
  }, 5000);

  it('should write REPORT.json on orchestrator timeout', async () => {
    // Mock invokeClaudeCode to throw a timeout error
    mockInvokeClaudeCode.mockRejectedValue(
      new ClaudeError('Claude Code CLI invocation timed out after 1000ms', 124, '')
    );

    const config = createMockConfig(testDir);
    await runTick(config);

    // Assert atomicWriteJson was called with the report
    expect(mockAtomicWriteJson).toHaveBeenCalledWith(
      join(testDir, 'REPORT.json'),
      expect.objectContaining({
        code: 'STOP_ORCHESTRATOR_TIMEOUT',
        verdict: 'stop',
      })
    );
  }, 5000);

  it('should release lock on orchestrator timeout', async () => {
    // Mock invokeClaudeCode to throw a timeout error
    mockInvokeClaudeCode.mockRejectedValue(
      new ClaudeError('Claude Code CLI invocation timed out after 1000ms', 124, '')
    );

    const config = createMockConfig(testDir);
    await runTick(config);

    // Assert lock was released
    expect(mockReleaseLock).toHaveBeenCalled();
  }, 5000);

  it('should include base_commit in report on timeout', async () => {
    // Mock invokeClaudeCode to throw a timeout error
    mockInvokeClaudeCode.mockRejectedValue(
      new ClaudeError('Claude Code CLI invocation timed out after 1000ms', 124, '')
    );

    const config = createMockConfig(testDir);
    const report = await runTick(config);

    // Assert base_commit is populated
    expect(report.base_commit).toBe('abc123');
    expect(report.head_commit).toBe('abc123');
  }, 5000);

  it('should have empty scope and diff on timeout (no changes made)', async () => {
    // Mock invokeClaudeCode to throw a timeout error
    mockInvokeClaudeCode.mockRejectedValue(
      new ClaudeError('Claude Code CLI invocation timed out after 1000ms', 124, '')
    );

    const config = createMockConfig(testDir);
    const report = await runTick(config);

    // Assert no changes
    expect(report.blast_radius.files_touched).toBe(0);
    expect(report.scope.ok).toBe(true);
    expect(report.scope.violations).toEqual([]);
    expect(report.diff.files_changed).toBe(0);
  }, 5000);

  it('should use configured timeout_seconds in error message', async () => {
    // Mock invokeClaudeCode to throw a timeout error
    mockInvokeClaudeCode.mockRejectedValue(
      new ClaudeError('Claude Code CLI invocation timed out after 1000ms', 124, '')
    );

    const config = createMockConfig(testDir);
    // Config has timeout_seconds: 1
    const report = await runTick(config);

    // The error message should mention 1s (the configured timeout)
    expect(report.task.intent).toContain('1s');
    expect(report.budgets.warnings[0]).toContain('1s');
  }, 5000);
});
