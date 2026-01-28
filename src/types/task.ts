/**
 * Task type definition matching task.schema.json.
 *
 * This represents the task structure output by the orchestrator.
 */

/**
 * Task kind indicating the type of task.
 */
export type TaskKind = 'execute' | 'verify_only' | 'question';

/**
 * Question object for question-type tasks.
 */
export interface Question {
  /** The question prompt */
  prompt: string;
  /** Optional list of choices */
  choices?: string[];
}

/**
 * Scope configuration for the task.
 */
export interface TaskScope {
  /** Glob patterns for allowed file access */
  allowed_globs: string[];
  /** Glob patterns for forbidden file access */
  forbidden_globs: string[];
  /** Whether new files can be created */
  allow_new_files: boolean;
  /** Whether lockfile changes are allowed */
  allow_lockfile_changes: boolean;
}

/**
 * Diff limits for the task.
 */
export interface DiffLimits {
  /** Maximum number of files that can be touched */
  max_files_touched: number;
  /** Maximum number of lines that can be changed */
  max_lines_changed: number;
}

/**
 * Verification configuration.
 */
export interface TaskVerification {
  /** Fast verification template IDs */
  fast: string[];
  /** Slow verification template IDs */
  slow: string[];
  /** Optional parameters for verification templates */
  params?: Record<string, Record<string, string | number | boolean | null>>;
}

/**
 * Builder configuration.
 */
export interface TaskBuilder {
  /** Builder mode */
  mode: 'claude_code' | 'patch';
  /** Maximum number of turns */
  max_turns: number;
  /** Instructions for the builder */
  instructions: string;
  /** Patch content (required if mode is 'patch') */
  patch?: string;
}

/**
 * Task structure output by the orchestrator.
 *
 * This matches the structure defined in task.schema.json.
 */
export interface Task {
  /** Unique task identifier */
  task_id: string;
  /** Milestone identifier */
  milestone_id: string;
  /** Task kind */
  task_kind: TaskKind;
  /** Intent description */
  intent: string;
  /** Question object (required if task_kind is 'question') */
  question?: Question;
  /** Scope configuration */
  scope: TaskScope;
  /** Diff limits */
  diff_limits: DiffLimits;
  /** Verification configuration */
  verification: TaskVerification;
  /** Builder configuration */
  builder: TaskBuilder;
}
