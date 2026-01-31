/**
 * Acceptance test: Loop stops on budget cap.
 *
 * Verifies that when budget limits are exceeded, preflight blocks
 * with BLOCKED_BUDGET_CAP code.
 *
 * @see docs/NEW-PLAN.md PR2 (budget hard-cap)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runPreflight } from '@/lib/preflight.js';
import type { RelaisConfig } from '@/types/config.js';
import type { WorkspaceState } from '@/types/workspace_state.js';

describe('Acceptance: Budget cap enforcement', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'relais-budget-test-'));
    // Create minimal directory structure
    await mkdir(join(tmpDir, 'relais'), { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  /**
   * Creates a minimal config for testing.
   */
  function createTestConfig(budgetCaps: {
    max_ticks?: number;
    max_orchestrator_calls?: number;
    max_builder_calls?: number;
    max_verify_runs?: number;
  }): RelaisConfig {
    return {
      workspace_dir: tmpDir,
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
          max_turns: 20,
          permission_mode: 'bypassPermissions',
          allowed_tools: ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep'],
          strict_builder_json: false,
        },
      },
      reviewer: {
        enabled: false,
        mode: 'codex',
        codex: {
          system_prompt_file: 'relais/prompts/reviewer.system.txt',
          result_schema_file: 'relais/schemas/reviewer_result.schema.json',
        },
        trigger: {
          risk_threshold: 'high',
          trigger_on_scope_violation: true,
          trigger_on_diff_limit_breach: true,
        },
      },
      scope: {
        default_allowed_globs: ['**/*'],
        default_forbidden_globs: [],
      },
      diff_limits: {
        default_max_files_touched: 50,
        default_max_lines_changed: 1000,
      },
      verification: {
        templates: [],
        timeout_fast_seconds: 30,
        timeout_slow_seconds: 120,
        param_rules: {
          max_length: 200,
          allow_list_patterns: [],
          block_list_patterns: [],
        },
      },
      budgets: {
        per_milestone: {
          max_ticks: budgetCaps.max_ticks ?? 100,
          max_orchestrator_calls: budgetCaps.max_orchestrator_calls ?? 200,
          max_builder_calls: budgetCaps.max_builder_calls ?? 100,
          max_verify_runs: budgetCaps.max_verify_runs ?? 500,
        },
        warn_at_percentage: 80,
      },
      runner: {
        lockfile: join(tmpDir, 'relais.lock'),
        max_tick_seconds: 300,
        runner_owned_globs: ['relais/**'],
      },
      history: {
        enabled: false,
        dir: 'relais/history',
        max_mb: 100,
        include_diff_patch: false,
        include_verify_log: false,
      },
    };
  }

  /**
   * Writes a STATE.json with given budget values.
   */
  async function writeState(budgets: {
    ticks: number;
    orchestrator_calls: number;
    builder_calls: number;
    verify_runs: number;
  }): Promise<void> {
    const state: WorkspaceState = {
      milestone_id: 'test-milestone',
      budgets,
      budget_warning: false,
      last_run_id: null,
      last_verdict: null,
    };
    // STATE.json is directly under workspace_dir, not in relais/
    await writeFile(
      join(tmpDir, 'STATE.json'),
      JSON.stringify(state, null, 2)
    );
  }

  it('should block when tick budget is exceeded', async () => {
    const config = createTestConfig({ max_ticks: 5 });
    await writeState({
      ticks: 5, // At limit
      orchestrator_calls: 0,
      builder_calls: 0,
      verify_runs: 0,
    });

    const result = await runPreflight(config);

    expect(result.ok).toBe(false);
    expect(result.blocked_code).toBe('BLOCKED_BUDGET_CAP');
    expect(result.blocked_reason).toContain('Tick budget exceeded');
  });

  it('should block when orchestrator call budget is exceeded', async () => {
    const config = createTestConfig({ max_orchestrator_calls: 10 });
    await writeState({
      ticks: 0,
      orchestrator_calls: 10, // At limit
      builder_calls: 0,
      verify_runs: 0,
    });

    const result = await runPreflight(config);

    expect(result.ok).toBe(false);
    expect(result.blocked_code).toBe('BLOCKED_BUDGET_CAP');
    expect(result.blocked_reason).toContain('Orchestrator call budget exceeded');
  });

  it('should block when builder call budget is exceeded', async () => {
    const config = createTestConfig({ max_builder_calls: 3 });
    await writeState({
      ticks: 0,
      orchestrator_calls: 0,
      builder_calls: 3, // At limit
      verify_runs: 0,
    });

    const result = await runPreflight(config);

    expect(result.ok).toBe(false);
    expect(result.blocked_code).toBe('BLOCKED_BUDGET_CAP');
    expect(result.blocked_reason).toContain('Builder call budget exceeded');
  });

  it('should block when verify run budget is exceeded', async () => {
    const config = createTestConfig({ max_verify_runs: 20 });
    await writeState({
      ticks: 0,
      orchestrator_calls: 0,
      builder_calls: 0,
      verify_runs: 20, // At limit
    });

    const result = await runPreflight(config);

    expect(result.ok).toBe(false);
    expect(result.blocked_code).toBe('BLOCKED_BUDGET_CAP');
    expect(result.blocked_reason).toContain('Verify run budget exceeded');
  });

  it('should pass preflight when within budget limits', async () => {
    const config = createTestConfig({
      max_ticks: 10,
      max_orchestrator_calls: 20,
      max_builder_calls: 10,
      max_verify_runs: 50,
    });
    await writeState({
      ticks: 5, // Under limit
      orchestrator_calls: 10,
      builder_calls: 5,
      verify_runs: 25,
    });

    const result = await runPreflight(config);

    // Should not be blocked by budget (may be blocked by other checks)
    if (!result.ok) {
      expect(result.blocked_code).not.toBe('BLOCKED_BUDGET_CAP');
    }
  });
});
