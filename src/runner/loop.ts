/**
 * Loop runner for executing multiple ticks.
 *
 * Supports two modes:
 * - milestone: Stop when milestone completes or changes
 * - autonomous: Allow milestone changes, archive and reset budgets
 *
 * @see docs/NEW-PLAN.md PR2
 */

import type { EnvoiConfig } from '../types/config.js';
import type { ReportData } from '../types/report.js';
import type { BudgetCounts } from '../types/workspace_state.js';
import { runTick } from './tick.js';
import { readWorkspaceState, writeWorkspaceState, ensureMilestone } from '../lib/workspace_state.js';
import { refreshLinkedInstallIfStale } from '../lib/self_update.js';

const TOKEN_WARNING_ORCHESTRATOR_PREFIX = '[tokens] orchestrator';
const TOKEN_WARNING_BUILDER_PREFIX = '[tokens] builder';
const TOKEN_WARNING_TOTAL_PREFIX = '[tokens] tick_total';

interface ParsedTickTokenTotals {
  orchestrator: number | null;
  builder: number | null;
  total: number | null;
}

interface CumulativeTokenTotals {
  orchestrator: number;
  builder: number;
  total: number;
  orchestratorKnown: boolean;
  builderKnown: boolean;
  totalKnown: boolean;
}

function parseWarningTotal(warning: string): number | null {
  const match = warning.match(/total=(\d+|n\/a)$/);
  if (!match) return null;
  if (match[1] === 'n/a') return null;
  return Number.parseInt(match[1], 10);
}

function parseTickTokenTotals(report: ReportData): ParsedTickTokenTotals {
  const parsed: ParsedTickTokenTotals = { orchestrator: null, builder: null, total: null };
  for (const warning of report.budgets.warnings) {
    if (warning.startsWith(TOKEN_WARNING_ORCHESTRATOR_PREFIX)) {
      parsed.orchestrator = parseWarningTotal(warning);
    } else if (warning.startsWith(TOKEN_WARNING_BUILDER_PREFIX)) {
      parsed.builder = parseWarningTotal(warning);
    } else if (warning.startsWith(TOKEN_WARNING_TOTAL_PREFIX)) {
      parsed.total = parseWarningTotal(warning);
    }
  }
  return parsed;
}

function formatTotal(value: number, known: boolean): string {
  return known ? String(value) : 'n/a';
}

function extractOrchestratorStopReason(report: ReportData): string | null {
  const warning = report.budgets.warnings.find((entry) =>
    entry.startsWith('Orchestrator signaled stop:')
  );
  if (!warning) return null;
  const reason = warning.replace('Orchestrator signaled stop:', '').trim();
  return reason.length > 0 ? reason : 'no reason provided';
}

/**
 * Loop-level stop flag.
 * Signal handlers set this flag so the loop breaks after the current tick.
 */
let stopRequested = false;

/** Check if stop was requested (for testing) */
export function isStopRequested(): boolean {
  return stopRequested;
}

/** Reset stop flag (for testing) */
export function resetStopFlag(): void {
  stopRequested = false;
}

/** Request the loop to stop after the current tick completes */
export function requestStop(): void {
  stopRequested = true;
}

/**
 * Minimal signal handler setup for loop-level stop semantics.
 * Only sets the stop flag - no cleanup needed.
 * Note: tick.ts also installs handlers after lock acquisition for cleanup purposes.
 */
function installLoopSignalHandlers(): () => void {
  const sigintHandler = () => {
    console.log('\n[LOOP] SIGINT received, will stop after current tick');
    requestStop();
  };
  const sigtermHandler = () => {
    console.log('\n[LOOP] SIGTERM received, will stop after current tick');
    requestStop();
  };

  process.on('SIGINT', sigintHandler);
  process.on('SIGTERM', sigtermHandler);

  return () => {
    process.off('SIGINT', sigintHandler);
    process.off('SIGTERM', sigtermHandler);
  };
}

/** Mode for the loop: task-bound, milestone-bound, or autonomous. */
export type LoopMode = 'task' | 'milestone' | 'autonomous';

/** Options for running the loop. */
export interface LoopOptions {
  /** Loop mode (task, milestone, or autonomous). */
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
  /** Why loop stopped: 'blocked' | 'budget_warning' | 'sigint' | 'verdict' | 'max_ticks' | 'milestone_change' | 'orchestrator_stop' | 'self_update' */
  stop_reason: string;
  /** Optional orchestrator completion reason when stop_reason is orchestrator_stop */
  orchestrator_stop_reason?: string;
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
 * Runs the envoi loop: one or more ticks.
 *
 * Preflight is performed by runTick() exactly once per tick, so we don't
 * need to call it at the loop level.
 *
 * @param config - Envoi configuration
 * @param opts - Loop options (mode, optional max_ticks)
 * @returns Loop execution summary
 */
export async function runLoop(
  config: EnvoiConfig,
  opts: LoopOptions
): Promise<LoopResult> {
  // Install loop-level signal handlers to set stop flag
  const cleanupSignalHandlers = installLoopSignalHandlers();
  resetStopFlag();

  const reports: ReportData[] = [];
  let ticks_executed = 0;
  let final_verdict = 'blocked';
  let stop_reason: string = 'blocked';
  let orchestratorStopReason: string | undefined;
  const cumulativeTokens: CumulativeTokenTotals = {
    orchestrator: 0,
    builder: 0,
    total: 0,
    orchestratorKnown: true,
    builderKnown: true,
    totalKnown: true,
  };

  const initialState = await readWorkspaceState(config.workspace_dir);
  let currentMilestoneId = initialState.milestone_id;
  let previousBudgets: BudgetCounts = initialState.budgets;

  try {
  while (true) {
    if (stopRequested) {
      stop_reason = 'sigint';
      break;
    }

    if (ticks_executed > 0) {
      const refresh = refreshLinkedInstallIfStale();
      if (refresh.error) {
        console.warn(`[LOOP] Linked install refresh failed: ${refresh.error}`);
      } else if (refresh.refreshed) {
        console.log(
          `[LOOP] Linked install refreshed from ${refresh.linkedRoot}. Stopping loop to reload fresh code.`
        );
        stop_reason = 'self_update';
        break;
      }
    }

    if (opts.max_ticks !== undefined && ticks_executed >= opts.max_ticks) {
      stop_reason = 'max_ticks';
      break;
    }

    const report = await runTick(config);
    ticks_executed++;
    reports.push(report);
    final_verdict = report.verdict;

    const tickTokens = parseTickTokenTotals(report);
    if (tickTokens.orchestrator === null) {
      cumulativeTokens.orchestratorKnown = false;
    } else {
      cumulativeTokens.orchestrator += tickTokens.orchestrator;
    }
    if (tickTokens.builder === null) {
      cumulativeTokens.builderKnown = false;
    } else {
      cumulativeTokens.builder += tickTokens.builder;
    }
    if (tickTokens.total === null) {
      cumulativeTokens.totalKnown = false;
    } else {
      cumulativeTokens.total += tickTokens.total;
    }
    console.log(
      `[LOOP] Tokens after tick ${ticks_executed}: orchestrator=${formatTotal(cumulativeTokens.orchestrator, cumulativeTokens.orchestratorKnown)} builder=${formatTotal(cumulativeTokens.builder, cumulativeTokens.builderKnown)} loop_total=${formatTotal(cumulativeTokens.total, cumulativeTokens.totalKnown)}`
    );

    const wsState = await readWorkspaceState(config.workspace_dir);
    if (wsState.budget_warning) {
      stop_reason = 'budget_warning';
      break;
    }

    // Check for orchestrator stop signal (control.action='stop')
    // This is encoded in report.budgets.warnings when tick detects it.
    const completionReason = extractOrchestratorStopReason(report);
    if (completionReason) {
      if (opts.mode === 'autonomous') {
        console.log(
          `Autonomous mode: orchestrator signaled completion (${completionReason}); continuing automatically.`
        );
      } else {
        const modeLabel = opts.mode === 'milestone' ? 'Milestone mode' : 'Task mode';
        console.log(`${modeLabel}: orchestrator signaled completion (${completionReason}); stopping loop.`);
        orchestratorStopReason = completionReason;
        stop_reason = 'orchestrator_stop';
        break;
      }
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

  console.log(
    `[LOOP] Token summary: orchestrator=${formatTotal(cumulativeTokens.orchestrator, cumulativeTokens.orchestratorKnown)} builder=${formatTotal(cumulativeTokens.builder, cumulativeTokens.builderKnown)} loop_total=${formatTotal(cumulativeTokens.total, cumulativeTokens.totalKnown)}`
  );

  return { ticks_executed, final_verdict, stop_reason, orchestrator_stop_reason: orchestratorStopReason, reports };
  } finally {
    cleanupSignalHandlers();
  }
}
