/**
 * TypeScript interfaces for envoi.config.json configuration.
 *
 * These types define the complete structure of the Envoi configuration file.
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
 * Runtime autonomy profile for balancing speed vs approvals.
 */
export interface RunnerAutonomyConfig {
  /** Profile selector controlling default permission behavior */
  profile: 'strict' | 'balanced' | 'fast';
  /** Optional trusted command prefixes for operator documentation */
  command_trust?: string[];
  /** Enforced trusted command prefixes (argv prefix match, e.g. "git log") */
  allow_prefixes?: string[];
  /** Enforced denied command prefixes (argv prefix match, e.g. "git reset --hard") */
  deny_prefixes?: string[];
  /** Trusted network command prefixes (e.g. "pnpm", "gh") */
  allow_network_prefixes?: string[];
  /** Trusted workspace-write command prefixes (e.g. "pnpm test", "git commit") */
  allow_workspace_write_prefixes?: string[];
  /** Whether destructive commands require explicit user intent */
  require_explicit_for_destructive?: boolean;
  /** Optional autonomy audit log settings */
  audit_log?: {
    /** Whether to persist autonomy decisions */
    enabled: boolean;
    /** Relative path to the autonomy decision log file */
    path: string;
  };
  /** Optional file-system policy label for operator documentation */
  fs_policy?: 'workspace_write' | 'read_only';
  /** Optional network policy label for operator documentation */
  network_policy?: 'deny' | 'allow';
}

/**
 * Runner configuration for the orchestration loop.
 */
export interface RunnerConfig {
  /** Whether git is required for operations */
  require_git: boolean;
  /** Maximum seconds per tick before timeout */
  max_tick_seconds: number;
  /** Default loop mode used when `envoi loop` is invoked without --mode (optional) */
  default_loop_mode?: 'task' | 'milestone' | 'autonomous';
  /** Path to the lockfile for preventing concurrent runs */
  lockfile: string;
  /** Glob patterns for files owned by the runner (not modifiable by builder) */
  runner_owned_globs: string[];
  /** Crash cleanup settings */
  crash_cleanup: CrashCleanupConfig;
  /** Report rendering settings */
  render_report_md: RenderReportMdConfig;
  /** Optional autonomy profile and policy hints */
  autonomy?: RunnerAutonomyConfig;
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
  /** Orchestrator runtime provider */
  orchestrator_provider?: 'claude_code' | 'chatgpt';
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
  /** Timeout in seconds for orchestrator invocation (optional, falls back to runner.max_tick_seconds) */
  timeout_seconds?: number;
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
 * External builder driver ("cursor mode") configuration.
 * Works with any headless script: Cursor wrapper, llm CLI, etc.
 */
export interface CursorBuilderConfig {
  /**
   * Driver kind:
   * - 'external' (default): an arbitrary driver that reads TASK.json and writes output_file
   * - 'cursor_agent': invoke `cursor agent` and pass a generated prompt to execute TASK.json
   */
  driver_kind?: 'external' | 'cursor_agent';
  /** Command to invoke the external driver */
  command: string;
  /** Arguments to pass (argv-only, no shell string) */
  args: string[];
  /** Timeout in seconds before killing the process */
  timeout_seconds: number;
  /** Output file path where driver writes result (e.g., 'envoi/BUILDER_RESULT.json') */
  output_file: string;
}

/**
 * Builder agent configuration.
 */
export interface BuilderConfig {
  /** Default builder mode ('claude_code' or 'patch' or 'cursor') */
  default_mode: 'claude_code' | 'patch' | 'cursor';
  /** Whether patch mode is allowed */
  allow_patch_mode: boolean;
  /** Claude Code builder settings */
  claude_code: ClaudeCodeBuilderConfig;
  /** Patch builder settings */
  patch: PatchBuilderConfig;
  /** Cursor (external driver) settings */
  cursor?: CursorBuilderConfig;
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
 * Authentication configuration for the reviewer agent.
 */
export interface ReviewerAuthConfig {
  /** Authentication mode ('auto', 'api_key', or 'login') */
  mode: 'auto' | 'api_key' | 'login';
  /** Whether CI environments require an API key */
  ci_requires_api_key: boolean;
  /** Environment variable name for the API key */
  api_key_env: string;
}

/**
 * Trigger configuration for when the reviewer should be invoked.
 */
export interface ReviewerTriggerConfig {
  /** Whether to trigger reviewer on verification failures */
  on_verify_fail: boolean;
  /** Whether to trigger reviewer on repeated stops */
  on_repeated_stop: boolean;
  /** Time window in ticks for tracking repeated stops */
  stop_window_ticks: number;
  /** Maximum number of stops allowed within the window */
  max_stops_in_window: number;
  /** Whether to trigger reviewer on high-risk file paths */
  on_high_risk_paths: boolean;
  /** Glob patterns for files considered high-risk */
  high_risk_globs: string[];
  /** Fraction of diff that must match high-risk patterns to trigger */
  diff_fraction_threshold: number;
}

/**
 * Reviewer agent configuration for Codex CLI integration.
 *
 * The reviewer acts as a 'Second Brain' that triggers on risky situations
 * to provide additional review and validation.
 */
export interface ReviewerConfig {
  /** Whether the reviewer feature is enabled */
  enabled: boolean;
  /** Engine to use for reviewer (e.g., 'claude_code') */
  engine: string;
  /** Command to invoke the reviewer engine */
  command: string;
  /** Model to use for reviewer */
  model: string;
  /** Maximum conversation turns */
  max_turns: number;
  /** Maximum budget in USD per reviewer call */
  max_budget_usd: number;
  /** Authentication settings */
  auth: ReviewerAuthConfig;
  /** Trigger conditions for reviewer invocation */
  trigger: ReviewerTriggerConfig;
  /** Path to JSON schema file */
  schema_file: string;
  /** Path to system prompt file */
  system_prompt_file: string;
  /** Path to user prompt file */
  user_prompt_file: string;
}

/**
 * Git branching configuration for runner-owned branch management.
 */
export interface GitBranchingConfig {
  /** Branching mode: 'off' (disabled), 'per_tick' (create branch per tick), 'per_n_tasks' (create branch per N tasks), 'per_milestone' (create branch per milestone) */
  mode: 'off' | 'per_tick' | 'per_n_tasks' | 'per_milestone';
  /** Number of tasks per branch (only used when mode='per_n_tasks') */
  n_tasks?: number;
  /** Base ref (commit/branch) to create new branches from. Default: 'HEAD' */
  base_ref?: string;
  /** Branch name template. Supports placeholders: {{task_id}}, {{milestone_id}}, {{run_id}}, {{tick_count}}, {{YYYYMMDD}}, {{seq}} (or {{batch_index}}). Also supports {task_id}, {milestone_id} style. Default: 'envoi/{{task_id}}' */
  name_template?: string;
}

/**
 * Main Envoi configuration interface.
 *
 * This matches the structure of envoi.config.json.
 */
export interface EnvoiConfig {
  /** Configuration version */
  version: string;
  /** Product name */
  product_name: string;
  /** Directory for envoi workspace files */
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
  /** Reviewer agent settings (optional, feature can be disabled) */
  reviewer?: ReviewerConfig;
  /** Git branching settings (optional, defaults to mode='off') */
  git?: {
    branching?: GitBranchingConfig;
  };
}
