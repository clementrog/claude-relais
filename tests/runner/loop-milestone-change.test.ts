/**
 * Acceptance test: Loop stops on milestone change in milestone mode.
 *
 * Verifies that the loop stops with stop_reason='milestone_change' when
 * workspace_state.milestone_id changes after a tick completes in milestone mode.
 *
 * @see docs/NEW-PLAN.md PR2
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { resetStopFlag, runLoop } from '@/runner/loop.js';
import type { EnvoiConfig } from '@/types/config.js';
import type { ReportData } from '@/types/report.js';
import type { WorkspaceState } from '@/types/workspace_state.js';

vi.mock('@/lib/workspace_state.js', () => ({
  readWorkspaceState: vi.fn(),
  writeWorkspaceState: vi.fn().mockResolvedValue(undefined),
  ensureMilestone: vi.fn().mockImplementation((state, milestoneId) => ({
    state: { ...state, milestone_id: milestoneId },
    changed: state.milestone_id !== milestoneId,
  })),
}));

vi.mock('@/runner/tick.js', () => ({
  runTick: vi.fn(),
}));

import { readWorkspaceState } from '@/lib/workspace_state.js';
import { runTick } from '@/runner/tick.js';

const mockReadWorkspaceState = vi.mocked(readWorkspaceState);
const mockRunTick = vi.mocked(runTick);

function createMockConfig(workspaceDir: string): EnvoiConfig {
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
    claude_code_cli: { command: 'claude', output_format: 'json', no_session_persistence: false },
    models: {
      orchestrator_model: 'claude-sonnet-4-20250514',
      orchestrator_fallback_model: 'claude-sonnet-4-20250514',
      builder_model: 'claude-sonnet-4-20250514',
      builder_fallback_model: 'claude-sonnet-4-20250514',
    },
    orchestrator: {
      system_prompt_file: 'relais/prompts/orchestrator.system.txt',
      user_prompt_file: 'relais/prompts/orchestrator.user.txt',
      task_schema_file: 'relais/schemas/task.schema.json',
      max_turns: 3,
      permission_mode: 'plan',
      allowed_tools: '',
      max_parse_retries_per_tick: 3,
      max_budget_usd: 1.0,
    },
    builder: {
      default_mode: 'claude_code',
      allow_patch_mode: false,
      claude_code: {
        system_prompt_file: 'relais/prompts/builder.system.txt',
        user_prompt_file: 'relais/prompts/builder.user.txt',
        builder_result_schema_file: 'relais/schemas/builder_result.schema.json',
        max_turns: 3,
        permission_mode: 'bypassPermissions',
        allowed_tools: '',
        max_budget_usd: 1.0,
        strict_builder_json: false,
      },
      patch: {
        max_patch_attempts_per_milestone: 3,
      },
    },
    scope: {
      default_allowed_globs: ['src/**'],
      default_forbidden_globs: [],
      default_allow_new_files: true,
      default_allow_lockfile_changes: false,
      lockfiles: [],
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
    budgets: {
      per_milestone: {
        max_ticks: 10,
        max_orchestrator_calls: 10,
        max_builder_calls: 10,
        max_verify_runs: 10,
        max_estimated_cost_usd: 10.0,
      },
      warn_at_fraction: 0.8,
    },
    history: { enabled: true, dir: 'relais/history', max_mb: 100, include_diff_patch: true, include_verify_log: true },
  } as EnvoiConfig;
}

const successReport: ReportData = {
  run_id: 'test-run-1',
  started_at: new Date().toISOString(),
  ended_at: new Date().toISOString(),
  duration_ms: 100,
  base_commit: 'abc123',
  head_commit: 'abc123',
  task: { task_id: 'WP-001', milestone_id: 'M1', task_kind: 'execute', intent: 'Test task' },
  verdict: 'success',
  code: 'SUCCESS',
  blast_radius: { files_touched: 0, lines_added: 0, lines_deleted: 0, new_files: 0 },
  scope: { ok: true, violations: [], touched_paths: [] },
  diff: { files_changed: 0, lines_changed: 0, diff_patch_path: '' },
  verification: { exec_mode: 'argv_no_shell', runs: [], verify_log_path: '' },
  budgets: {
    milestone_id: 'M1',
    ticks: 1,
    orchestrator_calls: 1,
    builder_calls: 1,
    verify_runs: 0,
    estimated_cost_usd: 0.1,
    warnings: [],
  },
};

describe('Acceptance: Loop stops on milestone change (milestone mode)', () => {
  beforeEach(() => {
    resetStopFlag();
    vi.clearAllMocks();
    // Initial state: milestone M1 (will be mocked per test)
  });

  it('should stop with stop_reason=milestone_change when milestone_id changes', async () => {
    // Initial state: milestone M1
    mockReadWorkspaceState.mockResolvedValueOnce({
      milestone_id: 'M1',
      budgets: { ticks: 0, orchestrator_calls: 0, builder_calls: 0, verify_runs: 0 },
      budget_warning: false,
      last_run_id: null,
      last_verdict: null,
    } as WorkspaceState);

    // After first tick completes, milestone changes from M1 to M2
    mockReadWorkspaceState.mockResolvedValueOnce({
      milestone_id: 'M2',
      budgets: { ticks: 1, orchestrator_calls: 1, builder_calls: 1, verify_runs: 0 },
      budget_warning: false,
      last_run_id: 'test-run-1',
      last_verdict: 'success',
    } as WorkspaceState);

    mockRunTick.mockResolvedValue(successReport);

    const config = createMockConfig('/tmp/milestone-change-test');
    const result = await runLoop(config, { mode: 'milestone' });

    expect(result.stop_reason).toBe('milestone_change');
    expect(result.ticks_executed).toBe(1);
    expect(result.final_verdict).toBe('success');
    expect(mockRunTick).toHaveBeenCalledTimes(1);
  });

  it('should continue when milestone_id does not change', async () => {
    // Initial read (already mocked in beforeEach, but we need to add it again since beforeEach resets)
    mockReadWorkspaceState.mockResolvedValueOnce({
      milestone_id: 'M1',
      budgets: { ticks: 0, orchestrator_calls: 0, builder_calls: 0, verify_runs: 0 },
      budget_warning: false,
      last_run_id: null,
      last_verdict: null,
    } as WorkspaceState);

    // After first tick, milestone remains M1
    mockReadWorkspaceState.mockResolvedValueOnce({
      milestone_id: 'M1',
      budgets: { ticks: 1, orchestrator_calls: 1, builder_calls: 1, verify_runs: 0 },
      budget_warning: false,
      last_run_id: 'test-run-1',
      last_verdict: 'success',
    } as WorkspaceState);

    // After second tick, milestone still M1, but max_ticks stops us
    mockReadWorkspaceState.mockResolvedValueOnce({
      milestone_id: 'M1',
      budgets: { ticks: 2, orchestrator_calls: 2, builder_calls: 2, verify_runs: 0 },
      budget_warning: false,
      last_run_id: 'test-run-2',
      last_verdict: 'success',
    } as WorkspaceState);

    const report2: ReportData = {
      ...successReport,
      run_id: 'test-run-2',
    };

    mockRunTick
      .mockResolvedValueOnce(successReport)
      .mockResolvedValueOnce(report2);

    const config = createMockConfig('/tmp/milestone-change-test');
    const result = await runLoop(config, { mode: 'milestone', max_ticks: 2 });

    expect(result.stop_reason).toBe('max_ticks');
    expect(result.ticks_executed).toBe(2);
    expect(mockRunTick).toHaveBeenCalledTimes(2);
  });

  it('should NOT stop on milestone change in autonomous mode', async () => {
    // Initial read (already mocked in beforeEach, but we need to add it again since beforeEach resets)
    mockReadWorkspaceState.mockResolvedValueOnce({
      milestone_id: 'M1',
      budgets: { ticks: 0, orchestrator_calls: 0, builder_calls: 0, verify_runs: 0 },
      budget_warning: false,
      last_run_id: null,
      last_verdict: null,
    } as WorkspaceState);

    // After first tick, milestone changes from M1 to M2
    mockReadWorkspaceState.mockResolvedValueOnce({
      milestone_id: 'M2',
      budgets: { ticks: 1, orchestrator_calls: 1, builder_calls: 1, verify_runs: 0 },
      budget_warning: false,
      last_run_id: 'test-run-1',
      last_verdict: 'success',
    } as WorkspaceState);

    // Second tick with milestone M2 still active
    mockReadWorkspaceState.mockResolvedValueOnce({
      milestone_id: 'M2',
      budgets: { ticks: 2, orchestrator_calls: 2, builder_calls: 2, verify_runs: 0 },
      budget_warning: false,
      last_run_id: 'test-run-2',
      last_verdict: 'success',
    } as WorkspaceState);

    const report2: ReportData = {
      ...successReport,
      run_id: 'test-run-2',
      task: { ...successReport.task, milestone_id: 'M2' },
      budgets: { ...successReport.budgets, milestone_id: 'M2' },
    };

    mockRunTick
      .mockResolvedValueOnce(successReport)
      .mockResolvedValueOnce(report2);

    const config = createMockConfig('/tmp/milestone-change-test');
    const result = await runLoop(config, { mode: 'autonomous', max_ticks: 2 });

    // Should stop due to max_ticks, not milestone_change
    expect(result.stop_reason).toBe('max_ticks');
    expect(result.ticks_executed).toBe(2);
    expect(mockRunTick).toHaveBeenCalledTimes(2);
  });
});
