/**
 * Configuration loading and validation utilities.
 *
 * Provides functions to load, find, and validate Envoi config files.
 */

import { access } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { atomicReadJson, AtomicFsError } from './fs.js';
import type { EnvoiConfig } from '../types/config.js';
import { migrateLegacyLayoutIfNeeded } from './migration.js';
import { classifyCommand, commandTokens } from './command_policy.js';
import {
  CONFIG_FILE_CANDIDATES,
  CONFIG_FILE_NAME as PRIMARY_CONFIG_FILE_NAME,
  LEGACY_CONFIG_FILE_NAME,
} from './branding.js';

/** Default configuration file name */
export const CONFIG_FILE_NAME = PRIMARY_CONFIG_FILE_NAME;
export const LEGACY_CONFIG_NAME = LEGACY_CONFIG_FILE_NAME;

/**
 * Error thrown when configuration loading or validation fails.
 */
export class ConfigError extends Error {
  constructor(
    message: string,
    public readonly configPath?: string,
    public readonly cause?: Error
  ) {
    super(message);
    this.name = 'ConfigError';
  }
}

/**
 * Searches for a configuration file by walking upward from the current directory.
 * Stops at the filesystem root if not found.
 *
 * @returns Path to the config file if found, null otherwise
 */
export async function findConfigFile(): Promise<string | null> {
  let currentDir = process.cwd();
  const root = resolve('/');

  while (true) {
    for (const fileName of CONFIG_FILE_CANDIDATES) {
      const configPath = join(currentDir, fileName);
      try {
        await access(configPath);
        return configPath;
      } catch {
        // Continue checking candidates.
      }
    }

    // Stop if we've reached the filesystem root
    if (currentDir === root || currentDir === dirname(currentDir)) {
      return null;
    }

    // Move up one directory
    currentDir = dirname(currentDir);
  }
}

/**
 * Gets the repository root directory (where the config file is located).
 * If configPath is provided, returns its directory. Otherwise, searches upward
 * from the current directory.
 *
 * @param configPath - Optional path to the config file. If provided, returns its directory.
 * @returns Path to the repository root directory, or null if config not found
 */
export async function getRepoRoot(configPath?: string): Promise<string | null> {
  if (configPath) {
    return dirname(resolve(configPath));
  }

  const found = await findConfigFile();
  if (!found) {
    return null;
  }

  return dirname(found);
}

/**
 * Changes the current working directory to the repository root.
 * This ensures that relative paths in config (workspace_dir, lockfile, etc.)
 * resolve correctly regardless of where the command was invoked from.
 *
 * @param configPath - Optional path to the config file. If not provided, searches upward.
 * @throws {ConfigError} If the config file cannot be found
 */
export async function chdirToRepoRoot(configPath?: string): Promise<void> {
  const repoRoot = await getRepoRoot(configPath);
  if (!repoRoot) {
    throw new ConfigError(
      `Configuration file not found. Expected ${PRIMARY_CONFIG_FILE_NAME} in current directory or parent directories.`
    );
  }

  process.chdir(repoRoot);
}

/**
 * Validates that an object conforms to the EnvoiConfig interface.
 *
 * This performs structural validation to ensure all required fields are present
 * and have the expected types.
 *
 * @param config - The object to validate
 * @returns True if the object is a valid EnvoiConfig
 */
export function validateConfig(config: unknown): config is EnvoiConfig {
  if (typeof config !== 'object' || config === null) {
    return false;
  }

  const c = config as Record<string, unknown>;

  // Check top-level required fields
  if (typeof c.version !== 'string') return false;
  if (typeof c.product_name !== 'string') return false;
  if (typeof c.workspace_dir !== 'string') return false;

  // Validate runner
  if (typeof c.runner !== 'object' || c.runner === null) return false;
  const runner = c.runner as Record<string, unknown>;
  if (typeof runner.require_git !== 'boolean') return false;
  if (typeof runner.max_tick_seconds !== 'number') return false;
  if (
    runner.default_loop_mode !== undefined &&
    runner.default_loop_mode !== 'task' &&
    runner.default_loop_mode !== 'milestone' &&
    runner.default_loop_mode !== 'autonomous'
  ) {
    return false;
  }
  if (typeof runner.lockfile !== 'string') return false;
  if (!Array.isArray(runner.runner_owned_globs)) return false;

  // Validate runner.crash_cleanup
  if (typeof runner.crash_cleanup !== 'object' || runner.crash_cleanup === null) return false;
  const crashCleanup = runner.crash_cleanup as Record<string, unknown>;
  if (typeof crashCleanup.delete_tmp_glob !== 'string') return false;
  if (typeof crashCleanup.validate_runner_json_files !== 'boolean') return false;

  // Validate runner.render_report_md
  if (typeof runner.render_report_md !== 'object' || runner.render_report_md === null) return false;
  const renderReportMd = runner.render_report_md as Record<string, unknown>;
  if (typeof renderReportMd.enabled !== 'boolean') return false;
  if (typeof renderReportMd.max_chars !== 'number') return false;

  // Validate optional runner.autonomy
  if (runner.autonomy !== undefined) {
    if (typeof runner.autonomy !== 'object' || runner.autonomy === null) return false;
    const autonomy = runner.autonomy as Record<string, unknown>;
    if (
      autonomy.profile !== 'strict' &&
      autonomy.profile !== 'balanced' &&
      autonomy.profile !== 'fast'
    ) {
      return false;
    }
    if (autonomy.command_trust !== undefined) {
      if (!Array.isArray(autonomy.command_trust)) return false;
      if (!autonomy.command_trust.every((entry) => typeof entry === 'string')) return false;
    }
    if (autonomy.allow_prefixes !== undefined) {
      if (!Array.isArray(autonomy.allow_prefixes)) return false;
      if (!autonomy.allow_prefixes.every((entry) => typeof entry === 'string')) return false;
    }
    if (autonomy.deny_prefixes !== undefined) {
      if (!Array.isArray(autonomy.deny_prefixes)) return false;
      if (!autonomy.deny_prefixes.every((entry) => typeof entry === 'string')) return false;
    }
    if (autonomy.allow_network_prefixes !== undefined) {
      if (!Array.isArray(autonomy.allow_network_prefixes)) return false;
      if (!autonomy.allow_network_prefixes.every((entry) => typeof entry === 'string')) return false;
    }
    if (autonomy.allow_workspace_write_prefixes !== undefined) {
      if (!Array.isArray(autonomy.allow_workspace_write_prefixes)) return false;
      if (!autonomy.allow_workspace_write_prefixes.every((entry) => typeof entry === 'string')) return false;
    }
    if (
      autonomy.require_explicit_for_destructive !== undefined &&
      typeof autonomy.require_explicit_for_destructive !== 'boolean'
    ) {
      return false;
    }
    if (autonomy.audit_log !== undefined) {
      if (typeof autonomy.audit_log !== 'object' || autonomy.audit_log === null) return false;
      const auditLog = autonomy.audit_log as Record<string, unknown>;
      if (typeof auditLog.enabled !== 'boolean') return false;
      if (typeof auditLog.path !== 'string') return false;
    }
    if (
      autonomy.fs_policy !== undefined &&
      autonomy.fs_policy !== 'workspace_write' &&
      autonomy.fs_policy !== 'read_only'
    ) {
      return false;
    }
    if (
      autonomy.network_policy !== undefined &&
      autonomy.network_policy !== 'deny' &&
      autonomy.network_policy !== 'allow'
    ) {
      return false;
    }
  }

  // Validate claude_code_cli
  if (typeof c.claude_code_cli !== 'object' || c.claude_code_cli === null) return false;
  const cli = c.claude_code_cli as Record<string, unknown>;
  if (typeof cli.command !== 'string') return false;
  if (typeof cli.output_format !== 'string') return false;
  if (typeof cli.no_session_persistence !== 'boolean') return false;

  // Validate models
  if (typeof c.models !== 'object' || c.models === null) return false;
  const models = c.models as Record<string, unknown>;
  if (
    models.orchestrator_provider !== undefined &&
    models.orchestrator_provider !== 'claude_code' &&
    models.orchestrator_provider !== 'chatgpt'
  ) {
    return false;
  }
  if (typeof models.orchestrator_model !== 'string') return false;
  if (typeof models.orchestrator_fallback_model !== 'string') return false;
  if (typeof models.builder_model !== 'string') return false;
  if (typeof models.builder_fallback_model !== 'string') return false;

  // Validate orchestrator
  if (typeof c.orchestrator !== 'object' || c.orchestrator === null) return false;
  const orchestrator = c.orchestrator as Record<string, unknown>;
  if (typeof orchestrator.max_turns !== 'number') return false;
  if (typeof orchestrator.permission_mode !== 'string') return false;
  if (typeof orchestrator.allowed_tools !== 'string') return false;
  if (typeof orchestrator.system_prompt_file !== 'string') return false;
  if (typeof orchestrator.user_prompt_file !== 'string') return false;
  if (typeof orchestrator.task_schema_file !== 'string') return false;
  if (typeof orchestrator.max_parse_retries_per_tick !== 'number') return false;
  if (typeof orchestrator.max_budget_usd !== 'number') return false;

  // Validate builder
  if (typeof c.builder !== 'object' || c.builder === null) return false;
  const builder = c.builder as Record<string, unknown>;
  if (
    builder.default_mode !== 'claude_code' &&
    builder.default_mode !== 'patch' &&
    builder.default_mode !== 'cursor'
  )
    return false;
  if (typeof builder.allow_patch_mode !== 'boolean') return false;

  // Validate builder.claude_code
  if (typeof builder.claude_code !== 'object' || builder.claude_code === null) return false;
  const ccBuilder = builder.claude_code as Record<string, unknown>;
  if (typeof ccBuilder.max_turns !== 'number') return false;
  if (typeof ccBuilder.permission_mode !== 'string') return false;
  if (typeof ccBuilder.allowed_tools !== 'string') return false;
  if (typeof ccBuilder.system_prompt_file !== 'string') return false;
  if (typeof ccBuilder.user_prompt_file !== 'string') return false;
  if (typeof ccBuilder.builder_result_schema_file !== 'string') return false;
  if (typeof ccBuilder.max_budget_usd !== 'number') return false;
  if (typeof ccBuilder.strict_builder_json !== 'boolean') return false;

  // Validate builder.patch
  if (typeof builder.patch !== 'object' || builder.patch === null) return false;
  const patchBuilder = builder.patch as Record<string, unknown>;
  if (typeof patchBuilder.max_patch_attempts_per_milestone !== 'number') return false;

  // When default_mode is cursor, require and validate builder.cursor (argv-only, no shell string)
  if (builder.default_mode === 'cursor') {
    if (typeof builder.cursor !== 'object' || builder.cursor === null) {
      throw new ConfigError('builder.cursor is required when default_mode is cursor');
    }
    const cursor = builder.cursor as Record<string, unknown>;
    if (
      cursor.driver_kind !== undefined &&
      cursor.driver_kind !== 'external' &&
      cursor.driver_kind !== 'cursor_agent'
    ) {
      throw new ConfigError("builder.cursor.driver_kind must be 'external' or 'cursor_agent'");
    }
    if (typeof cursor.command !== 'string' || cursor.command === '') {
      throw new ConfigError('builder.cursor.command is required');
    }
    if (!Array.isArray(cursor.args)) {
      throw new ConfigError('builder.cursor.args must be an array');
    }
    if (
      typeof cursor.timeout_seconds !== 'number' ||
      cursor.timeout_seconds <= 0 ||
      !Number.isFinite(cursor.timeout_seconds)
    ) {
      throw new ConfigError('builder.cursor.timeout_seconds must be a positive number');
    }
    if (typeof cursor.output_file !== 'string' || cursor.output_file === '') {
      throw new ConfigError('builder.cursor.output_file is required');
    }
    const shellMetachars = /[;&|`$(){}\[\]<>\n\r]/;
    if (shellMetachars.test(cursor.command as string)) {
      throw new ConfigError('builder.cursor.command contains shell metacharacters');
    }
    for (const arg of cursor.args as unknown[]) {
      if (typeof arg !== 'string') {
        throw new ConfigError('builder.cursor.args must contain only strings');
      }
      if (shellMetachars.test(arg)) {
        throw new ConfigError(`builder.cursor.args contains shell metacharacter in: ${arg}`);
      }
    }
  }

  // Validate scope
  if (typeof c.scope !== 'object' || c.scope === null) return false;
  const scope = c.scope as Record<string, unknown>;
  if (!Array.isArray(scope.default_allowed_globs)) return false;
  if (!Array.isArray(scope.default_forbidden_globs)) return false;
  if (typeof scope.default_allow_new_files !== 'boolean') return false;
  if (typeof scope.default_allow_lockfile_changes !== 'boolean') return false;
  if (!Array.isArray(scope.lockfiles)) return false;

  // Validate diff_limits
  if (typeof c.diff_limits !== 'object' || c.diff_limits === null) return false;
  const diffLimits = c.diff_limits as Record<string, unknown>;
  if (typeof diffLimits.default_max_files_touched !== 'number') return false;
  if (typeof diffLimits.default_max_lines_changed !== 'number') return false;

  // Validate verification
  if (typeof c.verification !== 'object' || c.verification === null) return false;
  const verification = c.verification as Record<string, unknown>;
  if (verification.execution_mode !== 'argv_no_shell') return false;
  if (typeof verification.max_param_len !== 'number') return false;
  if (typeof verification.reject_whitespace_in_params !== 'boolean') return false;
  if (typeof verification.reject_dotdot !== 'boolean') return false;
  if (typeof verification.reject_metachars_regex !== 'string') return false;
  if (typeof verification.timeout_fast_seconds !== 'number') return false;
  if (typeof verification.timeout_slow_seconds !== 'number') return false;
  if (!Array.isArray(verification.templates)) return false;
  for (const template of verification.templates as unknown[]) {
    if (typeof template !== 'object' || template === null) return false;
    const t = template as Record<string, unknown>;
    if (typeof t.id !== 'string' || t.id.length === 0) return false;
    if (typeof t.cmd !== 'string' || t.cmd.length === 0) return false;
    if (!Array.isArray(t.args) || !(t.args as unknown[]).every((arg) => typeof arg === 'string')) return false;
    const classification = classifyCommand(commandTokens(t.cmd, t.args as string[]));
    if (classification === 'destructive') {
      throw new ConfigError(`verification template '${t.id}' is destructive and not allowed`);
    }
  }

  // Validate budgets
  if (typeof c.budgets !== 'object' || c.budgets === null) return false;
  const budgets = c.budgets as Record<string, unknown>;
  if (typeof budgets.warn_at_fraction !== 'number') return false;

  // Validate budgets.per_milestone
  if (typeof budgets.per_milestone !== 'object' || budgets.per_milestone === null) return false;
  const perMilestone = budgets.per_milestone as Record<string, unknown>;
  if (typeof perMilestone.max_ticks !== 'number') return false;
  if (typeof perMilestone.max_orchestrator_calls !== 'number') return false;
  if (typeof perMilestone.max_builder_calls !== 'number') return false;
  if (typeof perMilestone.max_verify_runs !== 'number') return false;
  if (typeof perMilestone.max_estimated_cost_usd !== 'number') return false;

  // Validate history
  if (typeof c.history !== 'object' || c.history === null) return false;
  const history = c.history as Record<string, unknown>;
  if (typeof history.enabled !== 'boolean') return false;
  if (typeof history.dir !== 'string') return false;
  if (typeof history.max_mb !== 'number') return false;
  if (typeof history.include_diff_patch !== 'boolean') return false;
  if (typeof history.include_verify_log !== 'boolean') return false;

  return true;
}

/**
 * Loads and validates an Envoi configuration file.
 *
 * @param configPath - Optional path to the config file. If not provided,
 *                     searches upward for a known config file name.
 * @returns The validated configuration object
 * @throws {ConfigError} If the config file cannot be found, read, or is invalid
 *
 * @example
 * ```typescript
 * // Load from default location
 * const config = await loadConfig();
 *
 * // Load from specific path
 * const config = await loadConfig('/path/to/envoi.config.json');
 * ```
 */
export async function loadConfig(configPath?: string): Promise<EnvoiConfig> {
  let resolvedPath: string;

  if (configPath) {
    // If --config is provided, use it directly (no search)
    resolvedPath = resolve(configPath);
  } else {
    const found = await findConfigFile();
    if (!found) {
      throw new ConfigError(
        `Configuration file not found. Expected ${PRIMARY_CONFIG_FILE_NAME} in current directory or parent directories.`
      );
    }
    resolvedPath = found;
  }

  let rawConfig: unknown;
  try {
    rawConfig = await atomicReadJson<unknown>(resolvedPath);
  } catch (error) {
    if (error instanceof AtomicFsError) {
      throw new ConfigError(
        `Failed to read configuration file: ${error.message}`,
        resolvedPath,
        error
      );
    }
    throw error;
  }

  if (!validateConfig(rawConfig)) {
    throw new ConfigError(
      'Invalid configuration file: structure does not match expected schema',
      resolvedPath
    );
  }

  const migrationResult = await migrateLegacyLayoutIfNeeded(resolvedPath, rawConfig);
  return migrationResult.config;
}
