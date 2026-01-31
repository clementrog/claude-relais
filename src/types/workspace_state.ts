/**
 * TypeScript interfaces for workspace state persistence.
 *
 * WorkspaceState tracks milestone progress and budget consumption
 * across restarts, enabling budget enforcement and crash recovery.
 *
 * @see docs/NEW-PLAN.md lines 32-45
 */

/**
 * Count-based budget tracking for a single milestone.
 *
 * All fields are counts (not dollar amounts) per NEW-PLAN.md decision:
 * "Do not implement dollar cost estimation in v1. Track counts only."
 */
export interface BudgetCounts {
  /** Number of ticks consumed in current milestone */
  ticks: number;
  /** Number of orchestrator invocations in current milestone */
  orchestrator_calls: number;
  /** Number of builder invocations in current milestone */
  builder_calls: number;
  /** Number of verification runs in current milestone */
  verify_runs: number;
}

/**
 * Partial budget counts for applying incremental changes.
 *
 * Used by applyDeltas() to add to specific budget counters
 * without requiring all fields.
 */
export type BudgetDeltas = Partial<BudgetCounts>;

/**
 * Workspace state persisted to STATE.json.
 *
 * This state survives restarts and enables:
 * - Budget enforcement (hard cap in preflight, soft stop in loop)
 * - Milestone tracking (crash recovery knows which milestone is active)
 * - Resume logic (last_run_id + last_verdict for continuation)
 */
export interface WorkspaceState {
  /** Current milestone being worked on, or null if none active */
  milestone_id: string | null;

  /** Count-based budget consumption for current milestone */
  budgets: BudgetCounts;

  /**
   * True when approaching budget limit.
   * Triggers soft stop in loop (PR2) - runner breaks loop gracefully.
   * Computed by computeBudgetWarning() using warn_at_fraction from config.
   */
  budget_warning: boolean;

  /** ID of last tick run, for crash recovery and resume logic */
  last_run_id: string | null;

  /** Last verdict (PASS/FAIL/STOP/etc) for resume logic */
  last_verdict: string | null;
}
