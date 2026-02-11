/**
 * Acceptance test: Patch path traversal rejected.
 *
 * Verifies that patch mode rejects dangerous paths: .. traversal,
 * absolute paths, and null bytes. Builder returns success: false with
 * validationErrors including STOP_PATCH_INVALID_PATH.
 *
 * @see docs/NEW-PLAN.md M14 (patch builder mode security)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runBuilder } from '@/runner/builder.js';
import { TickPhase } from '@/types/state.js';
import type { TickState } from '@/types/state.js';
import type { Task } from '@/types/task.js';
import type { EnvoiConfig } from '@/types/config.js';

describe('Acceptance: Patch path traversal rejected', () => {
  let tmpDir: string;
  let state: TickState;
  let config: EnvoiConfig;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'relais-patch-traversal-'));
    await mkdir(join(tmpDir, 'relais'), { recursive: true });

    config = {
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
      budgets: { per_milestone: { max_ticks: 100, max_orchestrator_calls: 50, max_builder_calls: 50, max_verify_runs: 100 } },
      runner: {
        require_git: true,
        max_tick_seconds: 300,
        lockfile: '.relais.lock',
        runner_owned_globs: ['relais/*'],
        crash_cleanup: { delete_tmp_glob: '.tmp/**', validate_runner_json_files: true },
        render_report_md: { enabled: false, max_chars: 50000 },
      },
    } as EnvoiConfig;

    state = {
      phase: TickPhase.BUILD,
      run_id: 'test-run',
      started_at: new Date().toISOString(),
      base_commit: 'abc123',
      config,
      task: null,
      builder_result: null,
      errors: [],
    };
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  function createPatchTask(patchContent: string): Task {
    return {
      task_id: 'WP-164',
      milestone_id: 'M17',
      task_kind: 'execute',
      intent: 'Patch path traversal test',
      scope: {
        allowed_globs: ['**/*'],
        forbidden_globs: [],
        allow_new_files: true,
        allow_lockfile_changes: false,
      },
      diff_limits: { max_files_touched: 10, max_lines_changed: 100 },
      verification: { fast: [], slow: [] },
      builder: {
        mode: 'patch',
        max_turns: 1,
        instructions: 'Apply patch',
        patch: patchContent,
      },
    };
  }

  it('rejects .. traversal path with STOP_PATCH_INVALID_PATH', async () => {
    const patch = `--- a/../etc/passwd
+++ b/../etc/passwd
@@ -1 +1 @@
-old
+new
`;
    const task = createPatchTask(patch);
    const result = await runBuilder(state, task);

    expect(result.success).toBe(false);
    expect(result.validationErrors).toContain('STOP_PATCH_INVALID_PATH');
  });

  it('rejects absolute path with STOP_PATCH_INVALID_PATH', async () => {
    // parsePatchPaths extracts path after "a/" or "b/" -> "/etc/passwd"
    const patch = `--- a//etc/passwd
+++ b//etc/passwd
@@ -1 +1 @@
-old
+new
`;
    const task = createPatchTask(patch);
    const result = await runBuilder(state, task);

    expect(result.success).toBe(false);
    expect(result.validationErrors).toContain('STOP_PATCH_INVALID_PATH');
  });

  it('rejects null byte in path with STOP_PATCH_INVALID_PATH', async () => {
    const patch = `--- a/foo\0bar
+++ b/foo\0bar
@@ -1 +1 @@
-old
+new
`;
    const task = createPatchTask(patch);
    const result = await runBuilder(state, task);

    expect(result.success).toBe(false);
    expect(result.validationErrors).toContain('STOP_PATCH_INVALID_PATH');
  });
});
