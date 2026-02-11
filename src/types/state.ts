/**
 * State machine types for the envoi tick execution.
 *
 * A tick is one complete execution of the envoi loop through all phases:
 * LOCK → PREFLIGHT → ORCHESTRATE → BUILD → JUDGE → REPORT → END
 */

import type { EnvoiConfig } from './config.js';
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
 * Stop history entry representing a single stop event.
 */
export interface StopHistoryEntry {
  /** Run ID when the stop occurred */
  run_id: string;
  /** Stop code/reason */
  code: string;
  /** ISO timestamp when the stop occurred */
  at: string;
}

/**
 * Verify history entry representing a single verification run.
 */
export interface VerifyHistoryEntry {
  /** ISO timestamp when verification ran */
  ts: string;
  /** Task ID that was verified */
  task: string;
  /** Verification result */
  result: 'PASS' | 'FAIL' | 'TIMEOUT';
  /** Command that was executed */
  cmd: string;
  /** Duration in milliseconds */
  ms: number;
}

/**
 * Guardrail state tracking escalation and risk flags.
 */
export interface GuardrailState {
  /** Force patch mode until success (escalation flag) */
  force_patch_until_success: boolean;
  /** Last risk flags that triggered reviewer */
  last_risk_flags: string[];
  /** History of stop events (capped to 50 entries) */
  stop_history: StopHistoryEntry[];
}

/**
 * Escalation state tracking escalation mode and configuration.
 */
export interface EscalationState {
  /** Escalation mode */
  mode: 'none' | 'reviewer' | 'human';
  /** Reason for escalation */
  reason: string;
  /** Window ticks for escalation tracking */
  window_ticks: number;
  /** Maximum stops allowed in window */
  max_stops_in_window: number;
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
  /** Envoi configuration */
  config: EnvoiConfig;
  /** Task from orchestrator (null until ORCHESTRATE phase completes) */
  task: Task | null;
  /** Builder result (null until BUILD phase completes) */
  builder_result: BuilderResult | null;
  /** Accumulated errors during execution */
  errors: string[];
  /** Guardrail state (optional - absent means no escalation state) */
  guardrail?: GuardrailState;
  /** Current TASK fingerprint (sha256) */
  task_fingerprint?: string;
  /** Fingerprint of last failed task */
  last_failed_fingerprint?: string;
  /** Consecutive failures count */
  failure_streak?: number;
  /** Last N verify results (capped to 50 entries) */
  verify_history?: VerifyHistoryEntry[];
  /** Current escalation state */
  escalation?: EscalationState;
  /** Retry count for transport stalls (resets on success) */
  retry_count?: number;
  /** Kind of error that triggered retry (e.g., 'transport_stalled') */
  last_error_kind?: string;
  /** Request ID from last transport stall (for debugging) */
  last_request_id?: string | null;
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
