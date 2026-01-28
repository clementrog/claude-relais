/**
 * TypeScript interfaces for relais.config.json configuration.
 *
 * These types define the complete structure of the Relais configuration file.
 */

/**
 * Crash cleanup settings for recovering from interrupted operations.
 */
export interface CrashCleanupConfig {
  /** Glob pattern for temporary files to delete on crash recovery */
  delete_tmp_glob: string;
  /** Whether to validate runner-owned JSON files on startup */
  validate_runner_json_files: boolean;
}

/**
 * Configuration for rendering REPORT.md from REPORT.json.
 */
export interface RenderReportMdConfig {
  /** Whether to generate REPORT.md */
  enabled: boolean;
  /** Maximum characters to include in the report */
  max_chars: number;
}

/**
 * Runner configuration for the orchestration loop.
 */
export interface RunnerConfig {
  /** Whether git is required for operations */
  require_git: boolean;
  /** Maximum seconds per tick before timeout */
  max_tick_seconds: number;
  /** Path to the lockfile for preventing concurrent runs */
  lockfile: string;
  /** Glob patterns for files owned by the runner (not modifiable by builder) */
  runner_owned_globs: string[];
  /** Crash cleanup settings */
  crash_cleanup: CrashCleanupConfig;
  /** Report rendering settings */
  render_report_md: RenderReportMdConfig;
}

/**
 * Configuration for invoking Claude Code CLI.
 */
export interface ClaudeCodeCliConfig {
  /** Command to invoke Claude Code */
  command: string;
  /** Output format (typically 'json') */
  output_format: string;
  /** Whether to disable session persistence */
  no_session_persistence: boolean;
}

/**
 * Model configuration for different agent roles.
 */
export interface ModelsConfig {
  /** Primary model for orchestrator */
  orchestrator_model: string;
  /** Fallback model for orchestrator */
  orchestrator_fallback_model: string;
  /** Primary model for builder */
  builder_model: string;
  /** Fallback model for builder */
  builder_fallback_model: string;
}

/**
 * Orchestrator agent configuration.
 */
export interface OrchestratorConfig {
  /** Maximum conversation turns */
  max_turns: number;
  /** Permission mode for Claude Code (e.g., 'plan') */
  permission_mode: string;
  /** Allowed tools (empty string for default) */
  allowed_tools: string;
  /** Path to system prompt file */
  system_prompt_file: string;
  /** Path to user prompt file */
  user_prompt_file: string;
  /** Path to task JSON schema file */
  task_schema_file: string;
  /** Maximum parse retries per tick */
  max_parse_retries_per_tick: number;
  /** Maximum budget in USD per orchestrator call */
  max_budget_usd: number;
}

/**
 * Claude Code builder mode configuration.
 */
export interface ClaudeCodeBuilderConfig {
  /** Maximum conversation turns */
  max_turns: number;
  /** Permission mode (e.g., 'bypassPermissions') */
  permission_mode: string;
  /** Comma-separated list of allowed tools */
  allowed_tools: string;
  /** Path to system prompt file */
  system_prompt_file: string;
  /** Path to user prompt file */
  user_prompt_file: string;
  /** Path to builder result JSON schema file */
  builder_result_schema_file: string;
  /** Maximum budget in USD per builder call */
  max_budget_usd: number;
  /** Whether to enforce strict JSON output */
  strict_builder_json: boolean;
}

/**
 * Patch-based builder mode configuration.
 */
export interface PatchBuilderConfig {
  /** Maximum patch attempts per milestone */
  max_patch_attempts_per_milestone: number;
}

/**
 * Builder agent configuration.
 */
export interface BuilderConfig {
  /** Default builder mode ('claude_code' or 'patch') */
  default_mode: 'claude_code' | 'patch';
  /** Whether patch mode is allowed */
  allow_patch_mode: boolean;
  /** Claude Code builder settings */
  claude_code: ClaudeCodeBuilderConfig;
  /** Patch builder settings */
  patch: PatchBuilderConfig;
}

/**
 * Default scope rules for file access.
 */
export interface ScopeConfig {
  /** Default glob patterns for allowed file access */
  default_allowed_globs: string[];
  /** Default glob patterns for forbidden file access */
  default_forbidden_globs: string[];
  /** Whether new file creation is allowed by default */
  default_allow_new_files: boolean;
  /** Whether lockfile changes are allowed by default */
  default_allow_lockfile_changes: boolean;
  /** List of recognized lockfile names */
  lockfiles: string[];
}

/**
 * Limits on diff size per task.
 */
export interface DiffLimitsConfig {
  /** Maximum number of files that can be touched per task */
  default_max_files_touched: number;
  /** Maximum number of lines that can be changed per task */
  default_max_lines_changed: number;
}

/**
 * Parameter definition for verification template.
 */
export interface VerificationParam {
  /** Parameter type */
  kind: 'string_token';
}

/**
 * Verification command template.
 */
export interface VerificationTemplate {
  /** Unique identifier for this template */
  id: string;
  /** Command to execute */
  cmd: string;
  /** Command arguments (may contain {{param}} placeholders) */
  args: string[];
  /** Optional parameter definitions */
  params?: Record<string, VerificationParam>;
}

/**
 * Verification command execution configuration.
 */
export interface VerificationConfig {
  /** Execution mode (argv_no_shell for security) */
  execution_mode: 'argv_no_shell';
  /** Maximum parameter length */
  max_param_len: number;
  /** Whether to reject whitespace in parameters */
  reject_whitespace_in_params: boolean;
  /** Whether to reject '..' in paths */
  reject_dotdot: boolean;
  /** Regex pattern for rejected shell metacharacters */
  reject_metachars_regex: string;
  /** Timeout for fast verification commands (seconds) */
  timeout_fast_seconds: number;
  /** Timeout for slow verification commands (seconds) */
  timeout_slow_seconds: number;
  /** Available verification command templates */
  templates: VerificationTemplate[];
}

/**
 * Per-milestone budget limits.
 */
export interface PerMilestoneBudgets {
  /** Maximum ticks per milestone */
  max_ticks: number;
  /** Maximum orchestrator calls per milestone */
  max_orchestrator_calls: number;
  /** Maximum builder calls per milestone */
  max_builder_calls: number;
  /** Maximum verification runs per milestone */
  max_verify_runs: number;
  /** Maximum estimated cost in USD per milestone */
  max_estimated_cost_usd: number;
}

/**
 * Budget configuration for cost and resource limits.
 */
export interface BudgetsConfig {
  /** Per-milestone limits */
  per_milestone: PerMilestoneBudgets;
  /** Fraction of budget at which to emit warnings */
  warn_at_fraction: number;
}

/**
 * History tracking configuration.
 */
export interface HistoryConfig {
  /** Whether history tracking is enabled */
  enabled: boolean;
  /** Directory to store history files */
  dir: string;
  /** Maximum history size in megabytes */
  max_mb: number;
  /** Whether to include diff patches in history */
  include_diff_patch: boolean;
  /** Whether to include verification logs in history */
  include_verify_log: boolean;
}

/**
 * Main Relais configuration interface.
 *
 * This matches the structure of relais.config.json.
 */
export interface RelaisConfig {
  /** Configuration version */
  version: string;
  /** Product name */
  product_name: string;
  /** Directory for relais workspace files */
  workspace_dir: string;
  /** Runner settings */
  runner: RunnerConfig;
  /** Claude Code CLI settings */
  claude_code_cli: ClaudeCodeCliConfig;
  /** Model configuration */
  models: ModelsConfig;
  /** Orchestrator settings */
  orchestrator: OrchestratorConfig;
  /** Builder settings */
  builder: BuilderConfig;
  /** Default scope rules */
  scope: ScopeConfig;
  /** Diff size limits */
  diff_limits: DiffLimitsConfig;
  /** Verification command settings */
  verification: VerificationConfig;
  /** Budget limits */
  budgets: BudgetsConfig;
  /** History settings */
  history: HistoryConfig;
}
