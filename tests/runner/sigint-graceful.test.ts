/**
 * Acceptance test: SIGINT graceful shutdown.
 *
 * Verifies that the loop's stop flag mechanism works: resetStopFlag(),
 * isStopRequested(), and that the SIGINT handler sets the flag so the loop
 * can exit gracefully after the current tick.
 *
 * @see docs/NEW-PLAN.md lines 399-401
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { isStopRequested, resetStopFlag, runLoop } from '@/runner/loop.js';
import type { RelaisConfig } from '@/types/config.js';
import type { ReportData } from '@/types/report.js';
import type { WorkspaceState } from '@/types/workspace_state.js';

// Mock dependencies so runLoop can run and install the SIGINT handler
vi.mock('@/lib/preflight.js', () => ({
  runPreflight: vi.fn().mockResolvedValue({
    ok: true,
    blocked_code: null,
    blocked_reason: null,
    warnings: [],
    base_commit: 'abc123',
  }),
}));

vi.mock('@/lib/workspace_state.js', () => ({
  readWorkspaceState: vi.fn().mockResolvedValue({
    milestone_id: 'M1',
    budgets: { ticks: 0, orchestrator_calls: 0, builder_calls: 0, verify_runs: 0 },
    budget_warning: false,
    last_run_id: null,
    last_verdict: null,
  } as WorkspaceState),
  writeWorkspaceState: vi.fn().mockResolvedValue(undefined),
  ensureMilestone: vi.fn(),
}));

vi.mock('@/runner/tick.js', () => ({
  runTick: vi.fn(),
}));

import { runPreflight } from '@/lib/preflight.js';
import { readWorkspaceState } from '@/lib/workspace_state.js';
import { runTick } from '@/runner/tick.js';

const mockRunTick = vi.mocked(runTick);

function createMockConfig(workspaceDir: string): RelaisConfig {
  return {
    version: '1',
    workspace_dir: workspaceDir,
    runner: {
      require_git: true,
      max_tick_seconds: 300,
      lockfile: 'relais/lock.json',
      runner_owned_globs: ['relais/**'],
      crash_cleanup: { delete_tmp_glob: 'relais/*.tmp', validate_runner_json_files: true },
      render_report_md: { enabled: true, max_chars: 5000 },
    },
    claude_code_cli: { command: 'claude', args: [] },
    models: {
      orchestrator_model: 'claude-sonnet-4-20250514',
      builder_model: 'claude-sonnet-4-20250514',
      reviewer_model: 'claude-sonnet-4-20250514',
    },
    orchestrator: {
      system_prompt_file: 'relais/prompts/orchestrator.system.txt',
      user_prompt_file: 'relais/prompts/orchestrator.user.txt',
      task_schema_file: 'relais/schemas/task.schema.json',
      max_turns: 3,
      permission_mode: 'plan',
    },
    builder: {
      default_mode: 'claude_code',
      claude_code: {
        system_prompt_file: 'relais/prompts/builder.system.txt',
        user_prompt_file: 'relais/prompts/builder.user.txt',
        builder_result_schema_file: 'relais/schemas/builder_result.schema.json',
      },
    },
    scope: {
      default_allowed_globs: ['src/**'],
      default_forbidden_globs: [],
      default_allow_new_files: true,
      default_allow_lockfile_changes: false,
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
      templates: [],
    },
    reviewer: { enabled: false } as RelaisConfig['reviewer'],
    guardrails: {
      identical_task_max_redispatches: 3,
      require_branch_match: true,
      require_clean_worktree: true,
      max_consecutive_failures: 3,
    },
    history: { enabled: true, retention_count: 50, dir: 'relais/history' },
    budgets: { per_milestone: {} },
  } as RelaisConfig;
}

const minimalReport: ReportData = {
  run_id: 'test-run',
  started_at: new Date().toISOString(),
  ended_at: new Date().toISOString(),
  duration_ms: 0,
  base_commit: 'abc123',
  head_commit: 'abc123',
  task: { id: 'WP-0', milestone: 'M1', goal: '', scope: {} as any },
  verdict: 'success',
  code: 'SUCCESS',
  blast_radius: { files_touched: 0, lines_added: 0, lines_deleted: 0, new_files: 0 },
  scope: { allowed: true, violations: [] },
  diff: { files_modified: [], files_added: [], files_deleted: [] },
  verification: { fast: [], slow: [] },
  budgets: {} as any,
};

describe('Acceptance: SIGINT graceful shutdown', () => {
  beforeEach(() => {
    resetStopFlag();
    vi.mocked(runPreflight).mockResolvedValue({
      ok: true,
      blocked_code: null,
      blocked_reason: null,
      warnings: [],
      base_commit: 'abc123',
    });
    vi.mocked(readWorkspaceState).mockResolvedValue({
      milestone_id: 'M1',
      budgets: { ticks: 0, orchestrator_calls: 0, builder_calls: 0, verify_runs: 0 },
      budget_warning: false,
      last_run_id: null,
      last_verdict: null,
    } as WorkspaceState);
  });

  afterEach(() => {
    resetStopFlag();
  });

  it('should have stop flag initially false', () => {
    expect(isStopRequested()).toBe(false);
  });

  it('should detect stop request after flag is set', async () => {
    // Deferred promise: we resolve it after emitting SIGINT so the loop
    // is "in" a tick when the handler runs, then we let it finish and break.
    let resolveTick!: (report: ReportData) => void;
    const tickPromise = new Promise<ReportData>((resolve) => {
      resolveTick = resolve;
    });
    mockRunTick.mockReturnValue(tickPromise);

    const config = createMockConfig('/tmp/sigint-test');
    const runPromise = runLoop(config, { mode: 'milestone' });

    // Let runLoop install the handler and reach the first await runTick()
    await vi.waitFor(() => expect(mockRunTick).toHaveBeenCalled(), { timeout: 500 });

    // Simulate SIGINT: emit so the handler runs and sets the flag
    process.emit('SIGINT' as any);

    // Let the handler run
    await new Promise((r) => setImmediate(r));

    expect(isStopRequested()).toBe(true);

    // Resolve the tick so the loop can break and return
    resolveTick(minimalReport);
    const result = await runPromise;

    expect(result.stop_reason).toBe('sigint');
    expect(result.ticks_executed).toBe(1);
  });
});
