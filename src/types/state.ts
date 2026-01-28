/**
 * State machine types for the relais tick execution.
 *
 * A tick is one complete execution of the relais loop through all phases:
 * LOCK → PREFLIGHT → ORCHESTRATE → BUILD → JUDGE → REPORT → END
 */

import type { RelaisConfig } from './config.js';

/**
 * Phases of the tick state machine.
 */
export enum TickPhase {
  LOCK = 'LOCK',
  PREFLIGHT = 'PREFLIGHT',
  ORCHESTRATE = 'ORCHESTRATE',
  BUILD = 'BUILD',
  JUDGE = 'JUDGE',
  REPORT = 'REPORT',
  END = 'END',
}

/**
 * Task structure from orchestrator (placeholder - full type will be defined later).
 */
export interface Task {
  task_id: string;
  milestone_id: string;
  task_kind: 'execute' | 'verify_only' | 'question';
  intent: string;
  scope: {
    allowed_globs: string[];
    forbidden_globs: string[];
    allow_new_files: boolean;
    allow_lockfile_changes: boolean;
  };
  diff_limits: {
    max_files_touched: number;
    max_lines_changed: number;
  };
  verification: {
    exec_mode: 'argv_no_shell';
    runs: Array<{
      template_id: string;
      phase: 'fast' | 'slow';
      cmd: string;
      args: string[];
      exit_code: number;
      duration_ms: number;
      timed_out: boolean;
    }>;
    verify_log_path: string;
  };
  builder: {
    mode: 'claude_code' | 'patch';
  };
  question?: {
    prompt: string;
    choices?: string[];
  };
}

/**
 * Builder result structure (placeholder - full type will be defined later).
 */
export interface BuilderResult {
  summary: string;
  files_intended: string[];
  commands_ran: string[];
  notes: string[];
}

/**
 * Complete state of a tick execution.
 */
export interface TickState {
  /** Current phase of the tick */
  phase: TickPhase;
  /** Unique ID for this tick run */
  run_id: string;
  /** ISO timestamp when the tick started */
  started_at: string;
  /** Git HEAD commit SHA at the start of the tick */
  base_commit: string;
  /** Relais configuration */
  config: RelaisConfig;
  /** Task from orchestrator (null until ORCHESTRATE phase completes) */
  task: Task | null;
  /** Builder result (null until BUILD phase completes) */
  builder_result: BuilderResult | null;
  /** Accumulated errors during execution */
  errors: string[];
}

/**
 * Context passed between phase handlers.
 */
export interface TickContext {
  /** Current tick state */
  state: TickState;
  /** Lock information (set during LOCK phase) */
  lockInfo?: {
    pid: number;
    started_at: string;
    boot_id: string;
  };
}
