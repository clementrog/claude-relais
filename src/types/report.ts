/**
 * Report types for envoi tick execution results.
 *
 * REPORT.json is the canonical source of truth for tick outcomes.
 * REPORT.md is a deterministic rendering of REPORT.json.
 */

/**
 * Verdict indicating the outcome of a tick.
 */
export type Verdict = 'success' | 'stop' | 'blocked';

/**
 * Report codes indicating specific outcomes or failure reasons.
 */
export type ReportCode =
  | 'SUCCESS'
  | 'STOP_SCOPE_VIOLATION_FORBIDDEN'
  | 'STOP_SCOPE_VIOLATION_OUTSIDE_ALLOWED'
  | 'STOP_SCOPE_VIOLATION_NEW_FILE'
  | 'STOP_LOCKFILE_CHANGE_FORBIDDEN'
  | 'STOP_DIFF_TOO_LARGE'
  | 'STOP_VERIFY_FAILED_FAST'
  | 'STOP_VERIFY_FAILED_SLOW'
  | 'STOP_VERIFY_TAINTED'
  | 'STOP_VERIFY_ONLY_SIDE_EFFECTS'
  | 'STOP_QUESTION_SIDE_EFFECTS'
  | 'STOP_RUNNER_OWNED_MUTATION'
  | 'STOP_BUILDER_JSON_PARSE'
  | 'STOP_BUILDER_SCHEMA_INVALID'
  | 'STOP_BUILDER_SHAPE_INVALID'
  | 'STOP_BUILDER_CLI_ERROR'
  | 'STOP_BUILDER_TIMEOUT'
  | 'STOP_HEAD_MOVED'
  | 'STOP_INTERRUPTED'
  | 'STOP_REVIEWER_FORCED_PATCH'
  | 'STOP_REVIEWER_ASK_QUESTION'
  | 'STOP_ORCHESTRATOR_ASK_QUESTION'
  | 'STOP_REDISPATCH_IDENTICAL_TASK'
  | 'STOP_VERIFY_FLAKY_OR_TIMEOUT'
  | 'STOP_ORCHESTRATOR_TIMEOUT'
  | 'STOP_MERGE_DIRTY_WORKTREE'
  | 'STOP_BRANCH_MISMATCH'
  | 'STOP_EVIDENCE_INCOMPLETE'
  | 'BLOCKED_BUDGET_EXHAUSTED'
  | 'BLOCKED_BUDGET_CAP'
  | 'BLOCKED_DIRTY_WORKTREE'
  | 'BLOCKED_LOCK_HELD'
  | 'BLOCKED_CRASH_RECOVERY_REQUIRED'
  | 'BLOCKED_ORCHESTRATOR_OUTPUT_INVALID'
  | 'BLOCKED_HISTORY_CAP_CLEANUP_REQUIRED'
  | 'BLOCKED_MISSING_CONFIG'
  | 'BLOCKED_TRANSPORT_STALLED'
  | 'BLOCKED_ROLLBACK_FAILED'
  | 'BLOCKED_ROLLBACK_DIRTY'
  | 'BLOCKED_BUILDER_COMMAND_NOT_FOUND'
  | 'BLOCKED_BUILDER_MODE_NOT_ALLOWED'
  | 'BLOCKED_BRANCH_FAILED';

/**
 * Blast radius information about changes made during the tick.
 */
export interface BlastRadius {
  /** Number of files touched */
  files_touched: number;
  /** Number of lines added */
  lines_added: number;
  /** Number of lines deleted */
  lines_deleted: number;
  /** Number of new files created */
  new_files: number;
}

/**
 * Scope checking results.
 */
export interface ScopeResult {
  /** Whether scope checks passed */
  ok: boolean;
  /** List of scope violations found */
  violations: string[];
  /** List of file paths that were touched */
  touched_paths: string[];
}

/**
 * Diff information.
 */
export interface DiffInfo {
  /** Number of files changed */
  files_changed: number;
  /** Number of lines changed */
  lines_changed: number;
  /** Path to the diff patch file */
  diff_patch_path: string;
}

/**
 * Verification run result.
 */
export interface VerificationRun {
  /** Template ID used */
  template_id: string;
  /** Phase (fast or slow) */
  phase: 'fast' | 'slow';
  /** Command executed */
  cmd: string;
  /** Command arguments */
  args: string[];
  /** Exit code */
  exit_code: number;
  /** Duration in milliseconds */
  duration_ms: number;
  /** Whether the command timed out */
  timed_out: boolean;
}

/**
 * Verification results.
 */
export interface VerificationResult {
  /** Execution mode */
  exec_mode: 'argv_no_shell';
  /** List of verification runs */
  runs: VerificationRun[];
  /** Path to verification log file */
  verify_log_path: string;
}

/**
 * Budget information.
 */
export interface BudgetInfo {
  /** Milestone ID */
  milestone_id: string;
  /** Number of ticks consumed */
  ticks: number;
  /** Number of orchestrator calls */
  orchestrator_calls: number;
  /** Number of builder calls */
  builder_calls: number;
  /** Number of verification runs */
  verify_runs: number;
  /** Estimated cost in USD */
  estimated_cost_usd: number;
  /** Budget warnings */
  warnings: string[];
}

/**
 * Task summary in report (minimal task info).
 */
export interface TaskSummary {
  /** Task ID */
  task_id: string;
  /** Milestone ID */
  milestone_id: string;
  /** Task kind */
  task_kind: 'execute' | 'verify_only' | 'question';
  /** Task intent */
  intent: string;
}

/**
 * Optional pointers to related files.
 */
export interface ReportPointers {
  /** Path to REPORT.md file */
  report_md_path?: string;
  /** Path to history directory */
  history_dir?: string;
}

/**
 * Complete report data structure.
 *
 * This matches the report.schema.json structure and serves as the
 * canonical source of truth for tick execution results.
 */
export interface ReportData {
  /** Unique run ID */
  run_id: string;
  /** ISO timestamp when tick started */
  started_at: string;
  /** ISO timestamp when tick ended */
  ended_at: string;
  /** Duration in milliseconds */
  duration_ms: number;
  /** Base commit SHA at start */
  base_commit: string;
  /** Head commit SHA at end */
  head_commit: string;
  /** Task summary */
  task: TaskSummary;
  /** Verdict */
  verdict: Verdict;
  /** Report code */
  code: ReportCode;
  /** Blast radius */
  blast_radius: BlastRadius;
  /** Scope checking results */
  scope: ScopeResult;
  /** Diff information */
  diff: DiffInfo;
  /** Verification results */
  verification: VerificationResult;
  /** Budget information */
  budgets: BudgetInfo;
  /** Optional pointers */
  pointers?: ReportPointers;
  /** Reviewer error message (if reviewer invocation failed) */
  reviewer_error?: string;
}
