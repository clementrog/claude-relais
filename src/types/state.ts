/**
 * State machine types for the relais tick execution.
 *
 * A tick is one complete execution of the relais loop through all phases:
 * LOCK → PREFLIGHT → ORCHESTRATE → BUILD → JUDGE → REPORT → END
 */

import type { RelaisConfig } from './config.js';
import type { Task } from './task.js';
import type { BuilderResult } from './builder.js';

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
