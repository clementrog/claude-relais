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
 * Delivery timing preference for user ideas.
 */
export type IdeaTestabilityNeed = 'soon' | 'later' | 'unknown';

/**
 * Lifecycle status of a user-submitted idea.
 */
export type IdeaStatus = 'new' | 'triaged' | 'scheduled' | 'deferred' | 'done';

/**
 * A user idea captured between execution boundaries.
 */
export interface IdeaInboxEntry {
  /** Stable ID for reference in planning decisions */
  id: string;
  /** Raw user idea text */
  text: string;
  /** ISO timestamp when the idea was submitted */
  submitted_at: string;
  /** Where the idea was captured from */
  source: 'interactive' | 'cli' | 'api';
  /** Current planning status */
  status: IdeaStatus;
  /** Optional target date or milestone hint */
  target_by?: string | null;
  /** Optional testability urgency */
  testability_need?: IdeaTestabilityNeed;
  /** Last orchestrator task that triaged this idea */
  triaged_by_task_id?: string;
  /** ISO timestamp when triaged */
  triaged_at?: string;
}

/**
 * Rolling PM-style digest generated from orchestrator planning decisions.
 */
export interface PlanningDigest {
  /** Last update timestamp */
  updated_at: string;
  /** Human-readable summary of the latest planning decision */
  summary: string;
  /** Last task that updated the digest */
  last_task_id?: string;
  /** Last milestone suggested by orchestrator */
  suggested_milestone?: string;
}

/**
 * Open product-level question asked by the orchestrator.
 */
export interface ProductQuestion {
  /** Stable question ID */
  id: string;
  /** Prompt shown to the user */
  prompt: string;
  /** Optional choices */
  choices?: string[];
  /** Created timestamp */
  created_at: string;
  /** Resolution status */
  resolved: boolean;
  /** Optional resolution timestamp */
  resolved_at?: string;
  /** Optional free-text resolution */
  resolution?: string;
}

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

  /** Optional inbox of user-submitted ideas */
  idea_inbox?: IdeaInboxEntry[];

  /** Optional rolling digest of planning decisions */
  planning_digest?: PlanningDigest | null;

  /** Optional list of open product questions from orchestrator */
  open_product_questions?: ProductQuestion[];
}
