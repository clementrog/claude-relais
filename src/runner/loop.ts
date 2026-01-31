/**
 * Loop runner for executing multiple ticks.
 *
 * Supports two modes:
 * - milestone: Stop when milestone completes or changes
 * - autonomous: Allow milestone changes, archive and reset budgets
 *
 * @see docs/NEW-PLAN.md PR2
 */

import type { RelaisConfig } from '../types/config.js';
import type { ReportData } from '../types/report.js';
import type { BudgetCounts } from '../types/workspace_state.js';
import { runTick } from './tick.js';
import { runPreflight } from '../lib/preflight.js';
import { readWorkspaceState, writeWorkspaceState, ensureMilestone } from '../lib/workspace_state.js';

let stopRequested = false;

/** Check if stop was requested (for testing) */
export function isStopRequested(): boolean {
  return stopRequested;
}

/** Reset stop flag (for testing) */
export function resetStopFlag(): void {
  stopRequested = false;
}

interface SignalHandlerResult {
  cleanup: () => void;
  signal: AbortSignal;
}

function setupSignalHandlers(): SignalHandlerResult {
  const abortController = new AbortController();
  let sigintCount = 0;

  const handler = (sig: string) => {
    sigintCount++;
    if (sigintCount === 1) {
      stopRequested = true;
      abortController.abort();
      console.log(`\n${sig} received, waiting for current tick to complete...`);
    } else {
      console.log('\nForce exit');
      process.exit(130);
    }
  };

  const sigintHandler = () => handler('SIGINT');
  const sigtermHandler = () => handler('SIGTERM');

  process.on('SIGINT', sigintHandler);
  process.on('SIGTERM', sigtermHandler);

  return {
    cleanup: () => {
      process.off('SIGINT', sigintHandler);
      process.off('SIGTERM', sigtermHandler);
    },
    signal: abortController.signal,
  };
}

/** Mode for the loop: milestone-bound or autonomous. */
export type LoopMode = 'milestone' | 'autonomous';

/** Options for running the loop. */
export interface LoopOptions {
  /** Loop mode (milestone or autonomous). */
  mode: LoopMode;
  /** Optional extra cap on number of ticks (on top of budgets). */
  max_ticks?: number;
}

/** Result of running the loop. */
export interface LoopResult {
  /** How many ticks ran. */
  ticks_executed: number;
  /** Last tick verdict or stop reason. */
  final_verdict: string;
  /** Why loop stopped: 'blocked' | 'budget_warning' | 'sigint' | 'verdict' | 'max_ticks' | 'milestone_change' */
  stop_reason: string;
  /** All tick reports. */
  reports: ReportData[];
}

/**
 * Archives the current milestone's budget data.
 * For now logs the archive action; full persistence is optional future work.
 */
async function archiveMilestoneLedger(
  workspaceDir: string,
  milestoneId: string,
  budgets: BudgetCounts
): Promise<void> {
  console.log(
    `Archiving milestone '${milestoneId}' ledger: ticks=${budgets.ticks}, orchestrator=${budgets.orchestrator_calls}, builder=${budgets.builder_calls}, verify=${budgets.verify_runs}`
  );
}

/**
 * Runs the relais loop: preflight then one or more ticks.
 *
 * Skeleton implementation: runs preflight, then a single tick, and returns
 * a LoopResult. Full loop logic (multiple ticks, SIGINT, mode behavior)
 * is implemented in later work packages.
 *
 * @param config - Relais configuration
 * @param opts - Loop options (mode, optional max_ticks)
 * @returns Loop execution summary
 */
export async function runLoop(
  config: RelaisConfig,
  opts: LoopOptions
): Promise<LoopResult> {
  const { cleanup, signal } = setupSignalHandlers();
  resetStopFlag();

  const reports: ReportData[] = [];
  let ticks_executed = 0;
  let final_verdict = 'blocked';
  let stop_reason: string = 'blocked';

  const initialState = await readWorkspaceState(config.workspace_dir);
  let currentMilestoneId = initialState.milestone_id;
  let previousBudgets: BudgetCounts = initialState.budgets;

  try {
    while (true) {
      if (stopRequested) {
        stop_reason = 'sigint';
        break;
      }

      const preflightResult = await runPreflight(config);
      if (!preflightResult.ok) {
        stop_reason = 'blocked';
        break;
      }

      if (opts.max_ticks !== undefined && ticks_executed >= opts.max_ticks) {
        stop_reason = 'max_ticks';
        break;
      }

      const report = await runTick(config, signal);
      ticks_executed++;
      reports.push(report);
      final_verdict = report.verdict;

      const wsState = await readWorkspaceState(config.workspace_dir);
      if (wsState.budget_warning) {
        stop_reason = 'budget_warning';
        break;
      }

      if (opts.mode === 'milestone' && wsState.milestone_id !== currentMilestoneId) {
        console.log(
          `Milestone mode: milestone changed from '${currentMilestoneId}' to '${wsState.milestone_id}', stopping loop`
        );
        stop_reason = 'milestone_change';
        break;
      }

      if (opts.mode === 'autonomous' && wsState.milestone_id !== currentMilestoneId) {
        if (currentMilestoneId) {
          await archiveMilestoneLedger(config.workspace_dir, currentMilestoneId, previousBudgets);
        }
        const stateWithOldMilestone = { ...wsState, milestone_id: currentMilestoneId };
        const { state: resetState } = ensureMilestone(
          stateWithOldMilestone,
          wsState.milestone_id!
        );
        await writeWorkspaceState(config.workspace_dir, resetState);
        currentMilestoneId = wsState.milestone_id;
        console.log(
          `Autonomous mode: switched to milestone '${currentMilestoneId}', budgets reset`
        );
      }

      previousBudgets = wsState.budgets;

      if (report.verdict === 'stop' || report.verdict === 'blocked') {
        stop_reason = 'verdict';
        break;
      }
    }

    // Set exit code for interrupt case
    if (stop_reason === 'sigint') {
      process.exitCode = 130;
    }

    return { ticks_executed, final_verdict, stop_reason, reports };
  } finally {
    cleanup();
  }
}
