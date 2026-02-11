/**
 * Test helpers and mocks for fixture tests.
 * 
 * Provides utilities for creating mock runner states, tasks, and configurations
 * for testing core runner behaviors.
 */

import type { EnvoiConfig } from '@/types/config.js';
import type { TickState } from '@/types/state.js';
import type { Task, TaskKind } from '@/types/task.js';
import { TickPhase } from '@/types/state.js';

/**
 * Creates a minimal valid EnvoiConfig for testing.
 */
export function createMockConfig(overrides?: Partial<EnvoiConfig>): EnvoiConfig {
  return {
    version: '1.0',
    product_name: 'relais',
    workspace_dir: 'relais',
    runner: {
      require_git: true,
      max_tick_seconds: 900,
      lockfile: 'relais/lock.json',
      runner_owned_globs: [
        'relais/STATE.json',
        'relais/TASK.json',
        'relais/REPORT.json',
        'relais/REPORT.md',
        'relais/BLOCKED.json',
        'relais/FACTS.md',
        'relais/history/**',
        'relais/lock.json',
        'relais/schemas/**',
        'relais/prompts/**',
      ],
      crash_cleanup: {
        delete_tmp_glob: 'relais/*.tmp',
        validate_runner_json_files: true,
      },
      render_report_md: {
        enabled: true,
        max_chars: 6000,
      },
    },
    claude_code_cli: {
      command: 'claude',
      output_format: 'json',
      no_session_persistence: true,
    },
    models: {
      orchestrator_model: 'opus',
      orchestrator_fallback_model: 'sonnet',
      builder_model: 'sonnet',
      builder_fallback_model: 'haiku',
    },
    orchestrator: {
      max_turns: 1,
      permission_mode: 'plan',
      allowed_tools: '',
      system_prompt_file: 'relais/prompts/orchestrator.system.txt',
      user_prompt_file: 'relais/prompts/orchestrator.user.txt',
      task_schema_file: 'relais/schemas/task.schema.json',
      max_parse_retries_per_tick: 1,
      max_budget_usd: 0.4,
    },
    builder: {
      default_mode: 'claude_code',
      allow_patch_mode: true,
      claude_code: {
        max_turns: 8,
        permission_mode: 'bypassPermissions',
        allowed_tools: 'Read,Edit,Glob,Grep,Bash',
        system_prompt_file: 'relais/prompts/builder.system.txt',
        user_prompt_file: 'relais/prompts/builder.user.txt',
        builder_result_schema_file: 'relais/schemas/builder_result.schema.json',
        max_budget_usd: 1.5,
        strict_builder_json: false,
      },
      patch: {
        max_patch_attempts_per_milestone: 10,
      },
    },
    scope: {
      default_allowed_globs: ['src/**', 'tests/**'],
      default_forbidden_globs: ['.git/**', 'relais/**', '**/.env*'],
      default_allow_new_files: false,
      default_allow_lockfile_changes: false,
      lockfiles: ['pnpm-lock.yaml', 'package-lock.json', 'yarn.lock'],
    },
    diff_limits: {
      default_max_files_touched: 12,
      default_max_lines_changed: 400,
    },
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
    ...overrides,
  };
}

/**
 * Creates a mock task with the specified kind.
 */
export function createMockTask(
  taskKind: TaskKind,
  overrides?: Partial<Task>
): Task {
  return {
    task_id: 'test-task-001',
    milestone_id: 'M1',
    task_kind: taskKind,
    intent: 'Test task intent',
    scope: {
      allowed_globs: ['src/**'],
      forbidden_globs: ['.git/**', 'relais/**'],
      allow_new_files: false,
      allow_lockfile_changes: false,
    },
    diff_limits: {
      max_files_touched: 12,
      max_lines_changed: 400,
    },
    verification: {
      fast: [],
      slow: [],
      params: {},
    },
    builder: {
      mode: 'claude_code',
      max_turns: 4,
      instructions: 'Test instructions',
    },
    ...overrides,
  };
}

/**
 * Creates a minimal TickState for testing.
 */
export function createMockTickState(
  config: EnvoiConfig,
  task: Task | null = null,
  overrides?: Partial<TickState>
): TickState {
  return {
    phase: TickPhase.ORCHESTRATE,
    run_id: 'test-run-001',
    started_at: new Date().toISOString(),
    base_commit: 'abc123',
    config,
    task,
    builder_result: null,
    errors: [],
    ...overrides,
  };
}
