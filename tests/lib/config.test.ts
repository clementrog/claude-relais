import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { findConfigFile, loadConfig, chdirToRepoRoot, getRepoRoot, ConfigError } from '@/lib/config';
import { atomicWriteJson } from '@/lib/fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

describe('config discovery', () => {
  let testDir: string;
  let originalCwd: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), `relais-config-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(testDir, { recursive: true });
    originalCwd = process.cwd();
    process.chdir(testDir);
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    try {
      await rm(testDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  it('should find config file in current directory', async () => {
    const configPath = join(testDir, 'relais.config.json');
    await atomicWriteJson(configPath, {
      version: '1.0',
      product_name: 'test',
      workspace_dir: 'relais',
      runner: {
        require_git: false,
        max_tick_seconds: 900,
        lockfile: 'relais/lock.json',
        runner_owned_globs: [],
        crash_cleanup: {
          delete_tmp_glob: 'relais/*.tmp',
          validate_runner_json_files: false,
        },
        render_report_md: {
          enabled: false,
          max_chars: 1000,
        },
      },
      claude_code_cli: {
        command: 'claude',
        output_format: 'json',
        no_session_persistence: true,
      },
      models: {
        orchestrator_model: 'sonnet',
        orchestrator_fallback_model: 'haiku',
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
        allow_patch_mode: false,
        claude_code: {
          max_turns: 8,
          permission_mode: 'bypassPermissions',
          allowed_tools: '',
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
        default_allowed_globs: [],
        default_forbidden_globs: [],
        default_allow_new_files: false,
        default_allow_lockfile_changes: false,
        lockfiles: [],
      },
      diff_limits: {
        default_max_files_touched: 10,
        default_max_lines_changed: 100,
      },
      verification: {
        execution_mode: 'argv_no_shell',
        max_param_len: 128,
        reject_whitespace_in_params: true,
        reject_dotdot: true,
        reject_metachars_regex: '',
        timeout_fast_seconds: 90,
        timeout_slow_seconds: 600,
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
      history: {
        enabled: false,
        dir: 'relais/history',
        max_mb: 100,
        include_diff_patch: false,
        include_verify_log: false,
      },
    });

    const found = await findConfigFile();
    expect(found ? realpathSync(found) : null).toBe(realpathSync(configPath));
  });

  it('should find config file in parent directory when running from subdirectory', async () => {
    // Create root config
    const rootConfigPath = join(testDir, 'relais.config.json');
    await atomicWriteJson(rootConfigPath, {
      version: '1.0',
      product_name: 'test',
      workspace_dir: 'relais',
      runner: {
        require_git: false,
        max_tick_seconds: 900,
        lockfile: 'relais/lock.json',
        runner_owned_globs: [],
        crash_cleanup: {
          delete_tmp_glob: 'relais/*.tmp',
          validate_runner_json_files: false,
        },
        render_report_md: {
          enabled: false,
          max_chars: 1000,
        },
      },
      claude_code_cli: {
        command: 'claude',
        output_format: 'json',
        no_session_persistence: true,
      },
      models: {
        orchestrator_model: 'sonnet',
        orchestrator_fallback_model: 'haiku',
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
        allow_patch_mode: false,
        claude_code: {
          max_turns: 8,
          permission_mode: 'bypassPermissions',
          allowed_tools: '',
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
        default_allowed_globs: [],
        default_forbidden_globs: [],
        default_allow_new_files: false,
        default_allow_lockfile_changes: false,
        lockfiles: [],
      },
      diff_limits: {
        default_max_files_touched: 10,
        default_max_lines_changed: 100,
      },
      verification: {
        execution_mode: 'argv_no_shell',
        max_param_len: 128,
        reject_whitespace_in_params: true,
        reject_dotdot: true,
        reject_metachars_regex: '',
        timeout_fast_seconds: 90,
        timeout_slow_seconds: 600,
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
      history: {
        enabled: false,
        dir: 'relais/history',
        max_mb: 100,
        include_diff_patch: false,
        include_verify_log: false,
      },
    });

    // Create nested subdirectory
    const subDir = join(testDir, 'nested', 'subdir');
    await mkdir(subDir, { recursive: true });
    process.chdir(subDir);

    // Should find root config
    const found = await findConfigFile();
    expect(found ? realpathSync(found) : null).toBe(realpathSync(rootConfigPath));
  });

  it('should return null when config file not found', async () => {
    const found = await findConfigFile();
    expect(found).toBeNull();
  });

  it('should change directory to repo root when config found in parent', async () => {
    // Create root config
    const rootConfigPath = join(testDir, 'relais.config.json');
    await atomicWriteJson(rootConfigPath, {
      version: '1.0',
      product_name: 'test',
      workspace_dir: 'relais',
      runner: {
        require_git: false,
        max_tick_seconds: 900,
        lockfile: 'relais/lock.json',
        runner_owned_globs: [],
        crash_cleanup: {
          delete_tmp_glob: 'relais/*.tmp',
          validate_runner_json_files: false,
        },
        render_report_md: {
          enabled: false,
          max_chars: 1000,
        },
      },
      claude_code_cli: {
        command: 'claude',
        output_format: 'json',
        no_session_persistence: true,
      },
      models: {
        orchestrator_model: 'sonnet',
        orchestrator_fallback_model: 'haiku',
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
        allow_patch_mode: false,
        claude_code: {
          max_turns: 8,
          permission_mode: 'bypassPermissions',
          allowed_tools: '',
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
        default_allowed_globs: [],
        default_forbidden_globs: [],
        default_allow_new_files: false,
        default_allow_lockfile_changes: false,
        lockfiles: [],
      },
      diff_limits: {
        default_max_files_touched: 10,
        default_max_lines_changed: 100,
      },
      verification: {
        execution_mode: 'argv_no_shell',
        max_param_len: 128,
        reject_whitespace_in_params: true,
        reject_dotdot: true,
        reject_metachars_regex: '',
        timeout_fast_seconds: 90,
        timeout_slow_seconds: 600,
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
      history: {
        enabled: false,
        dir: 'relais/history',
        max_mb: 100,
        include_diff_patch: false,
        include_verify_log: false,
      },
    });

    // Create nested subdirectory
    const subDir = join(testDir, 'nested', 'subdir');
    await mkdir(subDir, { recursive: true });
    process.chdir(subDir);

    // Change to repo root
    await chdirToRepoRoot();

    // Verify we're now in the repo root
    expect(realpathSync(process.cwd())).toBe(realpathSync(testDir));

    // Verify workspace_dir resolves correctly from root
    const config = await loadConfig();
    expect(config.workspace_dir).toBe('envoi');
    
    // Verify workspace path resolves to root workspace, not subdir workspace
    // Since we changed to repo root, workspace_dir should resolve relative to root
    const { join: pathJoin } = await import('node:path');
    const cwd = realpathSync(process.cwd());
    const normalizedTestDir = realpathSync(testDir);
    const workspacePath = pathJoin(cwd, config.workspace_dir);
    const expectedWorkspacePath = pathJoin(normalizedTestDir, 'envoi');
    // Both should resolve to the same path
    expect(resolve(workspacePath)).toBe(resolve(expectedWorkspacePath));
  });

  it('should throw ConfigError when config not found', async () => {
    await expect(chdirToRepoRoot()).rejects.toThrow(ConfigError);
  });

  it('should use provided config path directly when --config is used', async () => {
    // Create config in a different location
    const configDir = join(testDir, 'custom-config');
    await mkdir(configDir, { recursive: true });
    const configPath = join(configDir, 'relais.config.json');
    
    await atomicWriteJson(configPath, {
      version: '1.0',
      product_name: 'test',
      workspace_dir: 'custom-workspace',
      runner: {
        require_git: false,
        max_tick_seconds: 900,
        lockfile: 'custom-workspace/lock.json',
        runner_owned_globs: [],
        crash_cleanup: {
          delete_tmp_glob: 'custom-workspace/*.tmp',
          validate_runner_json_files: false,
        },
        render_report_md: {
          enabled: false,
          max_chars: 1000,
        },
      },
      claude_code_cli: {
        command: 'claude',
        output_format: 'json',
        no_session_persistence: true,
      },
      models: {
        orchestrator_model: 'sonnet',
        orchestrator_fallback_model: 'haiku',
        builder_model: 'sonnet',
        builder_fallback_model: 'haiku',
      },
      orchestrator: {
        max_turns: 1,
        permission_mode: 'plan',
        allowed_tools: '',
        system_prompt_file: 'custom-workspace/prompts/orchestrator.system.txt',
        user_prompt_file: 'custom-workspace/prompts/orchestrator.user.txt',
        task_schema_file: 'custom-workspace/schemas/task.schema.json',
        max_parse_retries_per_tick: 1,
        max_budget_usd: 0.4,
      },
      builder: {
        default_mode: 'claude_code',
        allow_patch_mode: false,
        claude_code: {
          max_turns: 8,
          permission_mode: 'bypassPermissions',
          allowed_tools: '',
          system_prompt_file: 'custom-workspace/prompts/builder.system.txt',
          user_prompt_file: 'custom-workspace/prompts/builder.user.txt',
          builder_result_schema_file: 'custom-workspace/schemas/builder_result.schema.json',
          max_budget_usd: 1.5,
          strict_builder_json: false,
        },
        patch: {
          max_patch_attempts_per_milestone: 10,
        },
      },
      scope: {
        default_allowed_globs: [],
        default_forbidden_globs: [],
        default_allow_new_files: false,
        default_allow_lockfile_changes: false,
        lockfiles: [],
      },
      diff_limits: {
        default_max_files_touched: 10,
        default_max_lines_changed: 100,
      },
      verification: {
        execution_mode: 'argv_no_shell',
        max_param_len: 128,
        reject_whitespace_in_params: true,
        reject_dotdot: true,
        reject_metachars_regex: '',
        timeout_fast_seconds: 90,
        timeout_slow_seconds: 600,
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
      history: {
        enabled: false,
        dir: 'custom-workspace/history',
        max_mb: 100,
        include_diff_patch: false,
        include_verify_log: false,
      },
    });

    // Change to a different directory
    const otherDir = join(testDir, 'other');
    await mkdir(otherDir, { recursive: true });
    process.chdir(otherDir);

    // Use the custom config path
    await chdirToRepoRoot(configPath);
    expect(realpathSync(process.cwd())).toBe(realpathSync(configDir));

    const config = await loadConfig(configPath);
    expect(config.workspace_dir).toBe('custom-workspace');
  });

  it('should get repo root correctly', async () => {
    // Create root config
    const rootConfigPath = join(testDir, 'relais.config.json');
    await atomicWriteJson(rootConfigPath, {
      version: '1.0',
      product_name: 'test',
      workspace_dir: 'relais',
      runner: {
        require_git: false,
        max_tick_seconds: 900,
        lockfile: 'relais/lock.json',
        runner_owned_globs: [],
        crash_cleanup: {
          delete_tmp_glob: 'relais/*.tmp',
          validate_runner_json_files: false,
        },
        render_report_md: {
          enabled: false,
          max_chars: 1000,
        },
      },
      claude_code_cli: {
        command: 'claude',
        output_format: 'json',
        no_session_persistence: true,
      },
      models: {
        orchestrator_model: 'sonnet',
        orchestrator_fallback_model: 'haiku',
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
        allow_patch_mode: false,
        claude_code: {
          max_turns: 8,
          permission_mode: 'bypassPermissions',
          allowed_tools: '',
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
        default_allowed_globs: [],
        default_forbidden_globs: [],
        default_allow_new_files: false,
        default_allow_lockfile_changes: false,
        lockfiles: [],
      },
      diff_limits: {
        default_max_files_touched: 10,
        default_max_lines_changed: 100,
      },
      verification: {
        execution_mode: 'argv_no_shell',
        max_param_len: 128,
        reject_whitespace_in_params: true,
        reject_dotdot: true,
        reject_metachars_regex: '',
        timeout_fast_seconds: 90,
        timeout_slow_seconds: 600,
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
      history: {
        enabled: false,
        dir: 'relais/history',
        max_mb: 100,
        include_diff_patch: false,
        include_verify_log: false,
      },
    });

    // Create nested subdirectory
    const subDir = join(testDir, 'nested', 'subdir');
    await mkdir(subDir, { recursive: true });
    process.chdir(subDir);

    const repoRoot = await getRepoRoot();
    expect(repoRoot ? realpathSync(repoRoot) : null).toBe(realpathSync(testDir));

    const repoRootFromPath = await getRepoRoot(rootConfigPath);
    expect(repoRootFromPath ? realpathSync(repoRootFromPath) : null).toBe(realpathSync(testDir));
  });
});
