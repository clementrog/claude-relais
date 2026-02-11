/**
 * Main tick execution runner.
 *
 * Implements the Envoi state machine:
 * LOCK → PREFLIGHT → ORCHESTRATE → BUILD → JUDGE → REPORT → END
 */

import { join } from 'node:path';
import type { EnvoiConfig } from '../types/config.js';
import type { ReportData, ReportCode } from '../types/report.js';
import { isValidReportCode } from '../constants/report_codes.js';
import { TickPhase } from '../types/state.js';
import type { TickState } from '../types/state.js';
import { acquireLock, releaseLock, LockHeldError } from '../lib/lock.js';
import { runPreflight } from '../lib/preflight.js';
import { atomicWriteJson } from '../lib/fs.js';
import {
  createInitialState,
  transitionPhase,
  addError,
} from '../lib/state.js';
import { runOrchestrator } from './orchestrator.js';
import { requestStop } from './loop.js';
import { writeBlocked, buildOrchestratorBlockedData, buildBlockedData, deleteBlocked } from '../lib/blocked.js';
import type { BlockedData } from '../types/blocked.js';
import { renderReportMarkdown, writeReportMarkdown } from '../lib/report.js';
import type { AjvErrorObject } from '../types/blocked.js';
import { runBuilder } from './builder.js';
import { isTransportStallError } from '../lib/transport.js';
import { handleTransportStall, type StallHandlingResult } from '../lib/tick.js';
import {
  getTouchedFiles,
  checkScopeViolations,
  computeBlastRadius,
  checkDiffLimits,
  checkHeadMoved,
  type TouchedFiles,
  type ScopeCheckResult,
  type DiffCheckResult,
  type HeadCheckResult,
} from '../lib/judge.js';
import { rollbackToCommit, verifyCleanWorktree } from '../lib/rollback.js';
import { validateAllParams } from '../lib/verify-safety.js';
import { readWorkspaceState, writeWorkspaceState, ensureMilestone } from '../lib/workspace_state.js';
import { syncRoadmapMilestoneForWorkspace } from '../lib/roadmap.js';
import { spawn } from 'node:child_process';
import { isInterruptedError, isTimeoutError } from '../types/claude.js';
import type { ClaudeTokenUsage } from '../types/claude.js';
import type { WorkspaceState, ProductQuestion } from '../types/workspace_state.js';
import type { Task } from '../types/task.js';
import { persistBuilderFailure, persistOrchestratorFailure, type OrchestratorFailureMeta } from '../lib/history.js';
import {
  ensureBranchPerTick,
  ensureBranchPerNTasks,
  ensureBranchPerMilestone,
} from '../lib/git_branching.js';
import { runReviewerIfNeeded } from '../lib/reviewer-flow.js';
import { computeRiskFlags } from '../lib/risk.js';
import type { DiffAnalysis } from '../lib/diff.js';

const TOKEN_WARNING_ORCHESTRATOR_PREFIX = '[tokens] orchestrator';
const TOKEN_WARNING_BUILDER_PREFIX = '[tokens] builder';
const TOKEN_WARNING_TOTAL_PREFIX = '[tokens] tick_total';
const MAX_WARNING_CHARS = 500;

interface TickTokenUsageSnapshot {
  orchestrator: ClaudeTokenUsage | null;
  builder: ClaudeTokenUsage | null;
}

let activeTickTokenUsage: TickTokenUsageSnapshot | null = null;

function isDebugEnabled(): boolean {
  return process.env.ENVOI_DEBUG === '1';
}

function tokenNumber(value: number | null | undefined): string {
  return typeof value === 'number' ? String(value) : 'n/a';
}

function formatTokenUsageForLog(usage: ClaudeTokenUsage | null | undefined): string {
  if (!usage) return 'input=n/a output=n/a total=n/a';
  return `input=${tokenNumber(usage.input_tokens)} output=${tokenNumber(usage.output_tokens)} total=${tokenNumber(usage.total_tokens)}`;
}

function pushUniqueWarning(warnings: string[], warning: string): void {
  if (!warnings.includes(warning)) {
    warnings.push(warning);
  }
}

function compactWarningText(raw: string, maxChars = MAX_WARNING_CHARS): string {
  const normalized = raw.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, Math.max(0, maxChars - 38))}… [truncated ${normalized.length - maxChars} chars]`;
}

function annotateReportWithTokenUsage(report: ReportData): ReportData {
  if (!activeTickTokenUsage) return report;
  const warnings = report.budgets.warnings;
  const orchestrator = activeTickTokenUsage.orchestrator;
  const builder = activeTickTokenUsage.builder;

  if (orchestrator) {
    pushUniqueWarning(
      warnings,
      `${TOKEN_WARNING_ORCHESTRATOR_PREFIX} input=${tokenNumber(orchestrator.input_tokens)} output=${tokenNumber(orchestrator.output_tokens)} total=${tokenNumber(orchestrator.total_tokens)}`
    );
  }

  if (builder) {
    pushUniqueWarning(
      warnings,
      `${TOKEN_WARNING_BUILDER_PREFIX} input=${tokenNumber(builder.input_tokens)} output=${tokenNumber(builder.output_tokens)} total=${tokenNumber(builder.total_tokens)}`
    );
  }

  const total = (orchestrator?.total_tokens ?? 0) + (builder?.total_tokens ?? 0);
  const hasKnownTotal = orchestrator?.total_tokens !== null || builder?.total_tokens !== null;
  pushUniqueWarning(
    warnings,
    `${TOKEN_WARNING_TOTAL_PREFIX} total=${hasKnownTotal ? total : 'n/a'}`
  );

  return report;
}

function applyPlanningDecisionToWorkspaceState(
  wsState: WorkspaceState,
  task: Task
): WorkspaceState {
  const planningDecision = task.planning_decision;
  if (!planningDecision) return wsState;

  const now = new Date().toISOString();
  const considered = new Set(planningDecision.idea_ids_considered);
  const mappedStatus: 'scheduled' | 'deferred' =
    planningDecision.decision === 'defer' ? 'deferred' : 'scheduled';
  const updatedInbox = (wsState.idea_inbox ?? []).map((entry) => {
    if (!considered.has(entry.id)) return entry;
    return {
      ...entry,
      status: mappedStatus,
      triaged_by_task_id: task.task_id,
      triaged_at: now,
    };
  });

  const summaryPrefix = planningDecision.decision === 'schedule_now'
    ? 'Scheduled now'
    : planningDecision.decision === 'schedule_next'
      ? 'Scheduled next'
      : 'Deferred';
  const summary = `${summaryPrefix}: ${planningDecision.rationale_short}`;

  return {
    ...wsState,
    idea_inbox: updatedInbox,
    planning_digest: {
      updated_at: now,
      summary,
      last_task_id: task.task_id,
      suggested_milestone: planningDecision.suggested_milestone,
    },
  };
}

function upsertOpenProductQuestion(
  wsState: WorkspaceState,
  task: Task,
  runId: string
): WorkspaceState {
  if (task.task_kind !== 'question' || !task.question?.prompt) {
    return wsState;
  }

  const openQuestions = wsState.open_product_questions ?? [];
  const existingOpen = openQuestions.find(
    (question) => !question.resolved && question.prompt.trim() === task.question?.prompt.trim()
  );
  if (existingOpen) return wsState;

  const question: ProductQuestion = {
    id: `pq-${runId}`,
    prompt: task.question.prompt,
    choices: Array.isArray(task.question.choices) ? task.question.choices : undefined,
    created_at: new Date().toISOString(),
    resolved: false,
  };

  return {
    ...wsState,
    open_product_questions: [...openQuestions, question],
  };
}

/**
 * Generates a basic report from tick state.
 *
 * This is a placeholder implementation. Full report generation will be
 * implemented in M6.
 *
 * @param state - Tick state
 * @param code - Report code
 * @param verdict - Verdict (success/stop/blocked)
 * @returns Basic report data
 */
function generateReport(
  state: TickState,
  code: ReportCode,
  verdict: 'success' | 'stop' | 'blocked'
): ReportData {
  const endedAt = new Date().toISOString();
  const startedAt = new Date(state.started_at);
  const endedAtDate = new Date(endedAt);
  const durationMs = endedAtDate.getTime() - startedAt.getTime();

  return {
    run_id: state.run_id,
    started_at: state.started_at,
    ended_at: endedAt,
    duration_ms: durationMs,
    base_commit: state.base_commit,
    head_commit: state.base_commit, // Placeholder - will be updated in JUDGE phase
    task: state.task
      ? {
          task_id: state.task.task_id,
          milestone_id: state.task.milestone_id,
          task_kind: state.task.task_kind,
          intent: state.task.intent,
        }
      : {
          task_id: 'none',
          milestone_id: 'none',
          task_kind: 'execute',
          intent: 'No task assigned',
        },
    verdict,
    code,
    blast_radius: {
      files_touched: 0,
      lines_added: 0,
      lines_deleted: 0,
      new_files: 0,
    },
    scope: {
      ok: true,
      violations: [],
      touched_paths: [],
    },
    diff: {
      files_changed: 0,
      lines_changed: 0,
      diff_patch_path: '',
    },
    verification: {
      exec_mode: 'argv_no_shell',
      runs: [],
      verify_log_path: '',
    },
    budgets: {
      milestone_id: state.task?.milestone_id || 'none',
      ticks: 0,
      orchestrator_calls: 0,
      builder_calls: 0,
      verify_runs: 0,
      estimated_cost_usd: 0,
      warnings: [],
    },
  };
}

/**
 * Options for persisting run artifacts.
 */
interface PersistArtifactsOptions {
  config: EnvoiConfig;
  report: ReportData;
  blockedData?: BlockedData | null;
}

/**
 * Persists all run artifacts atomically.
 *
 * This is the single point of artifact persistence for all tick outcomes.
 * Every tick must call this before returning, regardless of verdict.
 *
 * Writes:
 * 1. REPORT.json - Always written
 * 2. REPORT.md - Written if config.runner.render_report_md.enabled (with hard truncation)
 * 3. BLOCKED.json - Written if blocked, deleted otherwise (cleans up stale blocked files)
 *
 * @param options - Persistence options including config, report, and optional blocked data
 */
async function persistRunArtifacts(options: PersistArtifactsOptions): Promise<void> {
  const { config, blockedData } = options;
  const report = annotateReportWithTokenUsage(options.report);
  const workspaceDir = config.workspace_dir;

  // 1. ALWAYS write REPORT.json first (most critical)
  await atomicWriteJson(join(workspaceDir, 'REPORT.json'), report);

  // 1a. Update STATE.json with run metadata and budgets (non-critical)
  try {
    const wsState = await readWorkspaceState(workspaceDir);
    const updatedState = {
      ...wsState,
      last_run_id: report.run_id,
      last_verdict: report.verdict,
      budgets: {
        ticks: wsState.budgets.ticks + report.budgets.ticks,
        orchestrator_calls: wsState.budgets.orchestrator_calls + report.budgets.orchestrator_calls,
        builder_calls: wsState.budgets.builder_calls + report.budgets.builder_calls,
        verify_runs: wsState.budgets.verify_runs + report.budgets.verify_runs,
      },
    };
    await writeWorkspaceState(workspaceDir, updatedState);
  } catch (stateError) {
    console.error(`Failed to update STATE.json: ${stateError}`);
  }

  // 2. Write REPORT.md if enabled (non-critical, don't block on failure)
  if (config.runner.render_report_md?.enabled) {
    try {
      let markdown = renderReportMarkdown(report);
      const maxChars = config.runner.render_report_md.max_chars;
      if (markdown.length > maxChars) {
        markdown = markdown.slice(0, maxChars - 4) + '\n...';
      }
      await writeReportMarkdown(markdown, join(workspaceDir, 'REPORT.md'));
    } catch (mdError) {
      console.error(`Failed to write REPORT.md: ${mdError}`);
    }
  }

  // 3. Handle BLOCKED.json (best-effort, don't block on failure)
  const blockedPath = join(workspaceDir, 'BLOCKED.json');
  try {
    if (report.verdict === 'blocked' && blockedData) {
      await writeBlocked(blockedData, blockedPath);
    } else {
      await deleteBlocked(blockedPath);
    }
  } catch (blockedError) {
    console.error(`Failed to handle BLOCKED.json: ${blockedError}`);
  }
}

/**
 * Generates a BLOCKED report for transport stall.
 */
function generateStallReport(
  state: TickState,
  stallResult: StallHandlingResult
): ReportData {
  const endedAt = new Date().toISOString();
  const startedAt = new Date(state.started_at);
  const endedAtDate = new Date(endedAt);
  const durationMs = endedAtDate.getTime() - startedAt.getTime();

  return {
    run_id: state.run_id,
    started_at: state.started_at,
    ended_at: endedAt,
    duration_ms: durationMs,
    base_commit: state.base_commit,
    head_commit: state.base_commit,
    task: state.task
      ? {
          task_id: state.task.task_id,
          milestone_id: state.task.milestone_id,
          task_kind: state.task.task_kind,
          intent: state.task.intent,
        }
      : {
          task_id: 'none',
          milestone_id: 'none',
          task_kind: 'execute',
          intent: 'Transport stalled before task assignment',
        },
    verdict: 'blocked',
    code: 'BLOCKED_TRANSPORT_STALLED',
    blast_radius: {
      files_touched: 0,
      lines_added: 0,
      lines_deleted: 0,
      new_files: 0,
    },
    scope: {
      ok: true,
      violations: [],
      touched_paths: [],
    },
    diff: {
      files_changed: 0,
      lines_changed: 0,
      diff_patch_path: '',
    },
    verification: {
      exec_mode: 'argv_no_shell',
      runs: [],
      verify_log_path: '',
    },
    budgets: {
      milestone_id: state.task?.milestone_id || 'none',
      ticks: 0,
      orchestrator_calls: 0,
      builder_calls: 0,
      verify_runs: 0,
      estimated_cost_usd: 0,
      warnings: [`Transport stalled during ${stallResult.stage}. Request ID: ${stallResult.requestId || 'unknown'}`],
    },
  };
}

/**
 * Generates a STOP report for judge violations.
 */
function generateJudgeStopReport(
  state: TickState,
  stopCode: ReportCode,
  blastRadius: { files_touched: number; lines_added: number; lines_deleted: number; new_files: number },
  touchedPaths: string[],
  violations: string[],
  reason: string
): ReportData {
  const endedAt = new Date().toISOString();
  const startedAt = new Date(state.started_at);
  const endedAtDate = new Date(endedAt);
  const durationMs = endedAtDate.getTime() - startedAt.getTime();

  return {
    run_id: state.run_id,
    started_at: state.started_at,
    ended_at: endedAt,
    duration_ms: durationMs,
    base_commit: state.base_commit,
    head_commit: state.base_commit,
    task: state.task
      ? {
          task_id: state.task.task_id,
          milestone_id: state.task.milestone_id,
          task_kind: state.task.task_kind,
          intent: state.task.intent,
        }
      : {
          task_id: 'none',
          milestone_id: 'none',
          task_kind: 'execute',
          intent: 'No task',
        },
    verdict: 'stop',
    code: stopCode,
    blast_radius: blastRadius,
    scope: {
      ok: false,
      violations,
      touched_paths: touchedPaths,
    },
    diff: {
      files_changed: blastRadius.files_touched,
      lines_changed: blastRadius.lines_added + blastRadius.lines_deleted,
      diff_patch_path: '',
    },
    verification: {
      exec_mode: 'argv_no_shell',
      runs: [],
      verify_log_path: '',
    },
    budgets: {
      milestone_id: state.task?.milestone_id || 'none',
      ticks: 0,
      orchestrator_calls: 1,
      builder_calls: 1,
      verify_runs: 0,
      estimated_cost_usd: 0,
      warnings: [reason],
    },
  };
}

/**
 * Result of performing rollback with cleanliness check.
 */
interface RollbackWithCleanCheckResult {
  /**
   * BLOCKED code if rollback failed or worktree is dirty, null if clean.
   */
  blockedCode: ReportCode | null;
  /**
   * Reason for blocking, if applicable.
   */
  reason: string | null;
}

/**
 * Performs rollback and verifies worktree cleanliness.
 *
 * If rollback fails or worktree remains dirty, returns a BLOCKED code.
 * Otherwise returns null (rollback succeeded and worktree is clean).
 *
 * @param baseCommit - Commit to rollback to
 * @param untrackedPaths - Untracked paths to remove
 * @returns RollbackWithCleanCheckResult with blocked code if needed
 */
function performRollbackWithCleanCheck(
  baseCommit: string,
  untrackedPaths: string[]
): RollbackWithCleanCheckResult {
  console.log(`[${TickPhase.JUDGE}] Rolling back to ${baseCommit}`);
  const rollbackResult = rollbackToCommit(baseCommit, untrackedPaths);
  
  if (!rollbackResult.ok) {
    console.log(`[${TickPhase.JUDGE}] Rollback failed: ${rollbackResult.error}`);
    return {
      blockedCode: 'BLOCKED_ROLLBACK_FAILED',
      reason: `Rollback failed: ${rollbackResult.error}`,
    };
  }
  
  // Verify worktree is clean after rollback
  const isClean = verifyCleanWorktree();
  if (!isClean) {
    console.log(`[${TickPhase.JUDGE}] Rollback succeeded but worktree is dirty`);
    return {
      blockedCode: 'BLOCKED_ROLLBACK_DIRTY',
      reason: 'Rollback succeeded but worktree remains dirty (uncommitted changes or untracked files)',
    };
  }
  
  console.log(`[${TickPhase.JUDGE}] Rollback succeeded and worktree is clean`);
  return {
    blockedCode: null,
    reason: null,
  };
}

/**
 * Generates a BLOCKED report for rollback failures.
 */
function generateRollbackBlockedReport(
  state: TickState,
  blockedCode: ReportCode,
  reason: string,
  blastRadius: { files_touched: number; lines_added: number; lines_deleted: number; new_files: number },
  touchedPaths: string[]
): ReportData {
  const endedAt = new Date().toISOString();
  const startedAt = new Date(state.started_at);
  const endedAtDate = new Date(endedAt);
  const durationMs = endedAtDate.getTime() - startedAt.getTime();

  return {
    run_id: state.run_id,
    started_at: state.started_at,
    ended_at: endedAt,
    duration_ms: durationMs,
    base_commit: state.base_commit,
    head_commit: state.base_commit,
    task: state.task
      ? {
          task_id: state.task.task_id,
          milestone_id: state.task.milestone_id,
          task_kind: state.task.task_kind,
          intent: state.task.intent,
        }
      : {
          task_id: 'none',
          milestone_id: 'none',
          task_kind: 'execute',
          intent: 'No task',
        },
    verdict: 'blocked',
    code: blockedCode,
    blast_radius: blastRadius,
    scope: {
      ok: false,
      violations: [],
      touched_paths: touchedPaths,
    },
    diff: {
      files_changed: blastRadius.files_touched,
      lines_changed: blastRadius.lines_added + blastRadius.lines_deleted,
      diff_patch_path: '',
    },
    verification: {
      exec_mode: 'argv_no_shell',
      runs: [],
      verify_log_path: '',
    },
    budgets: {
      milestone_id: state.task?.milestone_id || 'none',
      ticks: 0,
      orchestrator_calls: 1,
      builder_calls: 1,
      verify_runs: 0,
      estimated_cost_usd: 0,
      warnings: [reason],
    },
  };
}

/**
 * Result of running a verification command.
 */
interface VerifyCommandResult {
  ok: boolean;
  exitCode: number;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  durationMs: number;
}

/**
 * Runs a single verification command with timeout.
 *
 * @param cmd - Command to execute
 * @param args - Command arguments
 * @param timeoutSeconds - Timeout in seconds
 * @returns VerifyCommandResult
 */
async function runVerifyCommand(
  cmd: string,
  args: string[],
  timeoutSeconds: number
): Promise<VerifyCommandResult> {
  const startTime = Date.now();
  
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    
    const child = spawn(cmd, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: timeoutSeconds * 1000,
    });
    
    child.stdout?.on('data', (data) => {
      stdout += data.toString();
    });
    
    child.stderr?.on('data', (data) => {
      stderr += data.toString();
    });
    
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, timeoutSeconds * 1000);
    
    child.on('close', (code) => {
      clearTimeout(timer);
      const durationMs = Date.now() - startTime;
      resolve({
        ok: code === 0 && !timedOut,
        exitCode: code ?? -1,
        timedOut,
        stdout: stdout.slice(-2000),
        stderr: stderr.slice(-2000),
        durationMs,
      });
    });
    
    child.on('error', (err) => {
      clearTimeout(timer);
      const durationMs = Date.now() - startTime;
      resolve({
        ok: false,
        exitCode: -1,
        timedOut: false,
        stdout: '',
        stderr: err.message,
        durationMs,
      });
    });
  });
}

/**
 * Expands a verification template with params.
 *
 * @param template - Template from config
 * @param params - Params from task verification
 * @returns Expanded command and args
 */
function expandTemplate(
  template: { cmd: string; args: string[] },
  params: Record<string, string | number | boolean | null>
): { cmd: string; args: string[] } {
  const expandArg = (arg: string): string => {
    return arg.replace(/\{\{(\w+)\}\}/g, (_, key) => {
      const value = params[key];
      return value !== null && value !== undefined ? String(value) : '';
    });
  };
  
  return {
    cmd: template.cmd,
    args: template.args.map(expandArg),
  };
}

/**
 * Verification result for a single phase (fast or slow).
 */
interface VerificationPhaseResult {
  ok: boolean;
  stopCode: ReportCode | null;
  runs: Array<{
    template_id: string;
    phase: 'fast' | 'slow';
    cmd: string;
    args: string[];
    exit_code: number;
    duration_ms: number;
    timed_out: boolean;
  }>;
  reason: string | null;
}

/**
 * Runs verification commands for a phase (fast or slow).
 *
 * @param templateIds - Template IDs to run
 * @param templates - Available templates from config
 * @param params - Params from task
 * @param phase - 'fast' or 'slow'
 * @param timeoutSeconds - Timeout per command
 * @returns VerificationPhaseResult
 */
async function runVerificationPhase(
  templateIds: string[],
  templates: Array<{ id: string; cmd: string; args: string[] }>,
  params: Record<string, Record<string, string | number | boolean | null>>,
  phase: 'fast' | 'slow',
  timeoutSeconds: number
): Promise<VerificationPhaseResult> {
  const runs: VerificationPhaseResult['runs'] = [];
  
  for (const templateId of templateIds) {
    const template = templates.find(t => t.id === templateId);
    if (!template) {
      console.log(`[VERIFY] Template not found: ${templateId}`);
      continue;
    }
    
    const templateParams = params[templateId] || {};
    const expanded = expandTemplate(template, templateParams);
    
    console.log(`[VERIFY] Running ${phase}: ${expanded.cmd} ${expanded.args.join(' ')}`);
    const result = await runVerifyCommand(expanded.cmd, expanded.args, timeoutSeconds);
    
    runs.push({
      template_id: templateId,
      phase,
      cmd: expanded.cmd,
      args: expanded.args,
      exit_code: result.exitCode,
      duration_ms: result.durationMs,
      timed_out: result.timedOut,
    });
    
    if (result.timedOut) {
      return {
        ok: false,
        stopCode: 'STOP_VERIFY_FLAKY_OR_TIMEOUT',
        runs,
        reason: `Verification timed out: ${templateId} (${timeoutSeconds}s)`,
      };
    }
    
    if (!result.ok) {
      const stopCode = phase === 'fast' ? 'STOP_VERIFY_FAILED_FAST' : 'STOP_VERIFY_FAILED_SLOW';
      return {
        ok: false,
        stopCode,
        runs,
        reason: `Verification failed: ${templateId} (exit code ${result.exitCode})`,
      };
    }
  }
  
  return {
    ok: true,
    stopCode: null,
    runs,
    reason: null,
  };
}

/**
 * Executes one complete tick of the envoi loop.
 *
 * Phases:
 * 1. LOCK: Acquire lock to prevent concurrent runs
 * 2. PREFLIGHT: Run safety checks
 * 3. ORCHESTRATE: Get task from orchestrator (placeholder)
 * 4. BUILD: Execute task via builder (placeholder)
 * 5. JUDGE: Validate changes and run verifications (placeholder)
 * 6. REPORT: Generate REPORT.json and REPORT.md
 * 7. END: Release lock and return report
 *
 * @param config - Envoi configuration
 * @param signal - Optional AbortSignal for cancellation
 * @returns Report data for this tick
 */
/**
 * Sets up SIGINT/SIGTERM handlers for graceful shutdown.
 * Must be called after lock acquisition and cleaned up before lock release.
 * Also notifies the loop to stop after this tick completes.
 */
function setupSignalHandlers(): () => void {
  const sigintHandler = () => {
    console.log('\nSIGINT received during tick');
    requestStop(); // Notify loop to stop after this tick
  };
  const sigtermHandler = () => {
    console.log('\nSIGTERM received during tick');
    requestStop(); // Notify loop to stop after this tick
  };

  process.on('SIGINT', sigintHandler);
  process.on('SIGTERM', sigtermHandler);

  return () => {
    process.off('SIGINT', sigintHandler);
    process.off('SIGTERM', sigtermHandler);
  };
}

export async function runTick(
  config: EnvoiConfig,
  signal?: AbortSignal
): Promise<ReportData> {
  let state: TickState | undefined;
  let lockAcquired = false;
  let signalCleanup: (() => void) | null = null;
  let currentBranchName: string | null = null;
  const lockPath = config.runner.lockfile;
  activeTickTokenUsage = { orchestrator: null, builder: null };

  try {
    // Phase 1: LOCK
    console.log(`[${TickPhase.LOCK}] Acquiring lock...`);
    try {
      const lockInfo = await acquireLock(lockPath);
      lockAcquired = true;
      console.log(`[${TickPhase.LOCK}] Lock acquired (PID: ${lockInfo.pid})`);

      // Install signal handlers AFTER lock acquisition
      signalCleanup = setupSignalHandlers();

      // Initialize state without touching git yet.
      // Preflight is responsible for git checks (and for deriving base_commit).
      state = createInitialState(config, '');
    } catch (error) {
      if (error instanceof LockHeldError) {
        const report = generateReport(
          {
            phase: TickPhase.LOCK,
            run_id: 'lock-failed',
            started_at: new Date().toISOString(),
            base_commit: '',
            config,
            task: null,
            builder_result: null,
            errors: [],
          },
          'BLOCKED_LOCK_HELD',
          'blocked'
        );
        report.budgets.ticks = 1;
        const blockedData = buildBlockedData(
          'BLOCKED_LOCK_HELD',
          'Another process is holding the lock',
        );
        await persistRunArtifacts({ config, report, blockedData });
        return report;
      }
      throw error;
    }

    // Phase 2: PREFLIGHT
    console.log(`[${TickPhase.PREFLIGHT}] Running preflight checks...`);
    state = transitionPhase(state, TickPhase.PREFLIGHT);
    const preflightResult = await runPreflight(config);

    if (!preflightResult.ok) {
      // Preflight failed - cleanup handlers and release lock
      if (signalCleanup) {
        signalCleanup();
        signalCleanup = null;
      }
      if (lockAcquired) {
        await releaseLock(lockPath);
        lockAcquired = false;
      }

      const blockedCode = preflightResult.blocked_code || 'BLOCKED_MISSING_CONFIG';
      const report = generateReport(
        {
          ...state,
          errors: preflightResult.blocked_reason
            ? [preflightResult.blocked_reason]
            : [],
        },
        blockedCode,
        'blocked'
      );
      report.budgets.ticks = 1;
      const blockedData = buildBlockedData(
        blockedCode,
        preflightResult.blocked_reason || 'Preflight check failed',
      );
      await persistRunArtifacts({ config, report, blockedData });
      return report;
    }

    if (preflightResult.warnings.length > 0) {
      console.log(`[${TickPhase.PREFLIGHT}] Warnings:`);
      for (const warning of preflightResult.warnings) {
        console.log(`  - ${warning}`);
      }
    }

    if (preflightResult.base_commit) {
      // Update base commit from preflight if available
      state = {
        ...state,
        base_commit: preflightResult.base_commit,
      };
    }

    console.log(`[${TickPhase.PREFLIGHT}] Preflight passed (base: ${state.base_commit})`);

    // Phase 3: ORCHESTRATE
    console.log(`[${TickPhase.ORCHESTRATE}] Running orchestrator...`);
    state = transitionPhase(state, TickPhase.ORCHESTRATE);
    
    let orchestratorResult;
    try {
      orchestratorResult = await runOrchestrator(state, signal);
      activeTickTokenUsage.orchestrator = orchestratorResult.tokenUsage ?? null;
      console.log(`[${TickPhase.ORCHESTRATE}] Tokens: ${formatTokenUsageForLog(orchestratorResult.tokenUsage)}`);
    } catch (error) {
      // Check if this is a transport stall
      if (isTransportStallError(error)) {
        console.log(`[${TickPhase.ORCHESTRATE}] Transport stall detected`);
        const stallResult = await handleTransportStall(error, state.base_commit);

        if (lockAcquired) {
          await releaseLock(lockPath);
          lockAcquired = false;
        }

        const report = generateStallReport(state, stallResult);
        report.budgets.ticks = 1;
        report.budgets.orchestrator_calls = 1;
        const blockedData = buildBlockedData(
          'BLOCKED_TRANSPORT_STALLED',
          `Transport stalled during orchestrator: ${stallResult.requestId || 'unknown'}`,
        );
        await persistRunArtifacts({ config, report, blockedData });
        return report;
      }

      // Check if this is an orchestrator timeout
      if (isTimeoutError(error)) {
        console.log(`[${TickPhase.ORCHESTRATE}] Orchestrator timeout detected`);

        if (lockAcquired) {
          await releaseLock(lockPath);
          lockAcquired = false;
        }

        // Get configured timeout for display
        const timeoutSeconds = config.orchestrator.timeout_seconds ?? config.runner.max_tick_seconds;
        const timeoutDisplay = `${timeoutSeconds}s`;

        const report = generateReport(state, 'STOP_ORCHESTRATOR_TIMEOUT', 'stop');
        report.budgets.ticks = 1;
        report.budgets.orchestrator_calls = 1;
        report.task.intent = `Orchestrator timed out after ${timeoutDisplay}`;
        report.budgets.warnings.push(`Orchestrator timed out after ${timeoutDisplay}`);
        await persistRunArtifacts({ config, report });
        return report;
      }

      // Not a stall or timeout - rethrow
      throw error;
    }

    if (!orchestratorResult.success || !orchestratorResult.task) {
      // Orchestrator failed - release lock and return blocked report
      if (lockAcquired) {
        await releaseLock(lockPath);
        lockAcquired = false;
      }

      // Build BLOCKED.json with diagnostics
      const schemaErrors: AjvErrorObject[] | undefined = orchestratorResult.diagnostics?.schemaErrors?.map((e) => ({
        instancePath: e.instancePath,
        schemaPath: e.schemaPath,
        keyword: e.keyword,
        params: e.params,
        message: e.message,
      }));

      const blockedData = buildOrchestratorBlockedData(
        orchestratorResult.error || 'Orchestrator output invalid',
        {
          schema_errors: schemaErrors,
          stdout_excerpt: (orchestratorResult.rawCliStdout ?? orchestratorResult.rawResponse ?? '').slice(-2000),
          stderr_excerpt: (orchestratorResult.rawStderr ?? '').slice(-2000),
          json_excerpt: (() => {
            const extracted = orchestratorResult.diagnostics?.extractedJson;
            if (extracted !== undefined && extracted !== null) {
              try {
                return JSON.stringify(extracted).slice(0, 1000);
              } catch {
                // fall through
              }
            }
            return (orchestratorResult.rawCliStdout ?? orchestratorResult.rawResponse ?? '').slice(0, 1000);
          })(),
          extract_method: orchestratorResult.diagnostics?.extractMethod || 'direct_parse',
        }
      );

      // Generate REPORT.json with correct orchestrator_calls and warnings
      const report = generateReport(
        {
          ...state,
          errors: orchestratorResult.error ? [orchestratorResult.error] : [],
        },
        'BLOCKED_ORCHESTRATOR_OUTPUT_INVALID',
        'blocked'
      );
      report.budgets.ticks = 1;
      report.budgets.orchestrator_calls = orchestratorResult.attempts;
      report.budgets.warnings.push(
        `Orchestrator output invalid after ${orchestratorResult.attempts} attempt(s): ${orchestratorResult.error || 'unknown error'}`
      );

      // Persist orchestrator failure artifacts for debugging
      try {
        const meta: OrchestratorFailureMeta = {
          run_id: state.run_id,
          phase: 'orchestrator',
          model: config.models.orchestrator_model,
          timeout_ms: config.runner.max_tick_seconds * 1000,
          prompt_chars: 0, // Not available at this level
          system_prompt_chars: 0, // Not available at this level
          cwd: process.cwd(),
          args_summary_redacted: `--max-turns ${config.orchestrator.max_turns} --permission-mode ${config.orchestrator.permission_mode} --model <model>`,
        };
        await persistOrchestratorFailure(
          state.run_id,
          orchestratorResult.rawCliStdout ?? orchestratorResult.rawResponse,
          orchestratorResult.rawStderr,
          orchestratorResult.diagnostics?.extractedJson ?? null,
          orchestratorResult.diagnostics?.schemaErrors ?? null,
          meta,
          config
        );
        // Add pointer to history artifacts in warnings
        report.budgets.warnings.push(
          `Orchestrator output invalid; see ${config.workspace_dir}/history/${state.run_id}/orchestrator/`
        );
      } catch (persistError) {
        console.warn(`Failed to persist orchestrator failure: ${persistError instanceof Error ? persistError.message : String(persistError)}`);
      }

      await persistRunArtifacts({ config, report, blockedData });
      console.log(`[${TickPhase.ORCHESTRATE}] Artifacts persisted`);

      return report;
    }

    // Update state with the task from orchestrator
    state = {
      ...state,
      task: orchestratorResult.task,
    };
    console.log(`[${TickPhase.ORCHESTRATE}] Task proposed: ${orchestratorResult.task.task_id} (${orchestratorResult.task.task_kind})`);
    const task = orchestratorResult.task;

    // Persist planning metadata and milestone context early for crash tolerance.
    let wsState = await readWorkspaceState(config.workspace_dir);
    wsState = applyPlanningDecisionToWorkspaceState(wsState, task);
    wsState = upsertOpenProductQuestion(wsState, task, state.run_id);

    if (task.milestone_id) {
      const result = ensureMilestone(wsState, task.milestone_id);
      wsState = result.state;
      if (result.changed) {
        console.log(`Milestone persisted early: ${task.milestone_id}`);
      }
      try {
        const synced = await syncRoadmapMilestoneForWorkspace(config.workspace_dir, task.milestone_id);
        if (synced && result.changed) {
          console.log(`Roadmap synced for milestone: ${task.milestone_id}`);
        }
      } catch (error) {
        console.warn(
          `[${TickPhase.ORCHESTRATE}] Failed to sync ROADMAP.json milestone state: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      }
    }
    await writeWorkspaceState(config.workspace_dir, wsState);

    // control.action='stop' acts as completion stop for non-question tasks.
    if (task.task_kind !== 'question' && task.control?.action === 'stop') {
      console.log(`[${TickPhase.ORCHESTRATE}] Control action: stop (reason: ${task.control.reason || 'none'})`);
      if (lockAcquired) {
        await releaseLock(lockPath);
        lockAcquired = false;
      }

      const report = generateReport(state, 'SUCCESS', 'success');
      report.budgets.ticks = 1;
      report.budgets.orchestrator_calls = 1;
      report.budgets.warnings.push(`Orchestrator signaled stop: ${task.control.reason || 'no reason given'}`);
      await persistRunArtifacts({ config, report });
      return report;
    }

    // Question tasks: ask the user and stop immediately (no builder).
    if (task.task_kind === 'question') {
      // Safety: question tasks must have zero side effects. If anything changed between base_commit and now,
      // rollback and STOP with STOP_QUESTION_SIDE_EFFECTS.
      const touched = getTouchedFiles(state.base_commit);
      if (touched.all.length > 0) {
        const blastRadius = computeBlastRadius(state.base_commit, touched);
        const rollbackCheck = performRollbackWithCleanCheck(state.base_commit, touched.untracked);
        if (rollbackCheck.blockedCode) {
          if (lockAcquired) {
            await releaseLock(lockPath);
            lockAcquired = false;
          }
          const report = generateRollbackBlockedReport(
            state,
            rollbackCheck.blockedCode,
            rollbackCheck.reason || 'Rollback failed or worktree dirty',
            blastRadius,
            touched.all
          );
          report.budgets.ticks = 1;
          report.budgets.orchestrator_calls = orchestratorResult.attempts;
          report.budgets.builder_calls = 0;
          const blockedData = buildBlockedData(
            rollbackCheck.blockedCode,
            rollbackCheck.reason || 'Rollback failed or worktree dirty',
          );
          await persistRunArtifacts({ config, report, blockedData });
          return report;
        }
        if (lockAcquired) {
          await releaseLock(lockPath);
          lockAcquired = false;
        }
        const report = generateJudgeStopReport(
          state,
          'STOP_QUESTION_SIDE_EFFECTS',
          blastRadius,
          touched.all,
          touched.all,
          'Question task had side effects (git diff not empty)'
        );
        report.budgets.ticks = 1;
        report.budgets.orchestrator_calls = orchestratorResult.attempts;
        report.budgets.builder_calls = 0;
        await persistRunArtifacts({ config, report });
        return report;
      }

      const prompt = task.question?.prompt ?? '(missing question.prompt)';
      const choices = Array.isArray(task.question?.choices) ? task.question!.choices : [];
      console.log('\n[QUESTION]');
      console.log(prompt);
      if (choices.length > 0) {
        console.log('\nChoices:');
        for (const c of choices) console.log(`- ${c}`);
      }
      console.log('');

      if (lockAcquired) {
        await releaseLock(lockPath);
        lockAcquired = false;
      }

      const report = generateReport(state, 'STOP_ORCHESTRATOR_ASK_QUESTION', 'stop');
      report.budgets.ticks = 1;
      report.budgets.orchestrator_calls = orchestratorResult.attempts;
      report.budgets.builder_calls = 0;
      report.task.intent = `Orchestrator asked a question:\n${prompt}${
        choices.length > 0 ? `\n\nChoices:\n${choices.map((c) => `- ${c}`).join('\n')}` : ''
      }`;
      report.budgets.warnings.push('Answer the question, then rerun: envoi tick');
      await persistRunArtifacts({ config, report });
      return report;
    }

    // Cursor-only guardrail: all execute tasks must use the cursor builder.
    if (task.task_kind === 'execute' && task.builder && task.builder.mode !== 'cursor') {
      if (lockAcquired) {
        await releaseLock(lockPath);
        lockAcquired = false;
      }

      const reason = `Task requested builder.mode="${task.builder.mode}", but this runtime only allows builder.mode="cursor".`;
      const report = generateReport(
        {
          ...state,
          errors: [reason],
        },
        'BLOCKED_BUILDER_MODE_NOT_ALLOWED',
        'blocked'
      );
      report.budgets.ticks = 1;
      report.budgets.orchestrator_calls = orchestratorResult.attempts;
      report.budgets.builder_calls = 0;
      report.budgets.warnings.push(
        `${reason} Reconfigure onboarding/builder to cursor and rerun '${config.product_name} tick'.`
      );
      const blockedData = buildBlockedData(
        'BLOCKED_BUILDER_MODE_NOT_ALLOWED',
        `${reason} Use cursor agent as the only builder.`,
      );
      await persistRunArtifacts({ config, report, blockedData });
      return report;
    }

    // Optional reviewer gate (Second Brain) before builder execution.
    if (task.task_kind === 'execute' && config.reviewer?.enabled && config.reviewer.trigger) {
      const emptyAnalysis: DiffAnalysis = {
        files_touched: 0,
        lines_added: 0,
        lines_deleted: 0,
        new_files: 0,
        touched_paths: [],
      };
      const currentTick = wsState.budgets.ticks + 1;
      const riskFlags = computeRiskFlags({
        analysis: emptyAnalysis,
        limits: task.diff_limits,
        scope: task.scope,
        trigger: config.reviewer.trigger,
        stopHistory: [],
        currentTick,
        verifyFailed: false,
        budgetWarning: wsState.budget_warning,
      });

      const reviewerResult = await runReviewerIfNeeded(config, {
        riskFlags,
        task,
        stopHistory: [],
        currentTick,
        verifyFailed: false,
        budgetWarning: wsState.budget_warning,
        touchedPaths: [],
      });

      if (reviewerResult.stopCode) {
        if (lockAcquired) {
          await releaseLock(lockPath);
          lockAcquired = false;
        }

        if (reviewerResult.stopCode === 'STOP_REVIEWER_ASK_QUESTION' && reviewerResult.question) {
          console.log('\n[REVIEW QUESTION]');
          console.log(reviewerResult.question.prompt);
          if (reviewerResult.question.choices && reviewerResult.question.choices.length > 0) {
            console.log('\nChoices:');
            for (const choice of reviewerResult.question.choices) {
              console.log(`- ${choice}`);
            }
          }
          console.log('');
        }

        const report = generateReport(state, reviewerResult.stopCode, 'stop');
        report.budgets.ticks = 1;
        report.budgets.orchestrator_calls = orchestratorResult.attempts;
        report.budgets.builder_calls = 0;
        if (reviewerResult.reviewerError) {
          report.reviewer_error = reviewerResult.reviewerError;
          report.budgets.warnings.push(`Reviewer error: ${compactWarningText(reviewerResult.reviewerError)}`);
        }
        if (reviewerResult.stopCode === 'STOP_REVIEWER_FORCED_PATCH') {
          report.budgets.warnings.push('Reviewer requested manual intervention before builder execution.');
        } else if (reviewerResult.stopCode === 'STOP_REVIEWER_ASK_QUESTION') {
          report.budgets.warnings.push('Reviewer asked a product question; answer then rerun.');
        }
        await persistRunArtifacts({ config, report });
        return report;
      }
    }

    // Guardrail: prevent stale task execution when configured builder mode is not cursor.
    if (task.task_kind === 'execute' && task.builder) {
      const configuredMode = config.builder.default_mode;
      if (configuredMode !== 'cursor') {
        if (lockAcquired) {
          await releaseLock(lockPath);
          lockAcquired = false;
        }

        const mismatchReason =
          `Config has builder.default_mode="${configuredMode}" but cursor-only mode is required.`;
        const report = generateReport(
          {
            ...state,
            errors: [mismatchReason],
          },
          'BLOCKED_MISSING_CONFIG',
          'blocked'
        );
        report.budgets.ticks = 1;
        report.budgets.orchestrator_calls = orchestratorResult.attempts;
        report.budgets.builder_calls = 0;
        report.budgets.warnings.push(
          `${mismatchReason} Run '${config.product_name} builder --set cursor' or rerun onboarding, then run '${config.product_name} tick'.`
        );
        const blockedData = buildBlockedData(
          'BLOCKED_MISSING_CONFIG',
          `${mismatchReason} Switch default builder to cursor.`,
        );
        await persistRunArtifacts({ config, report, blockedData });
        return report;
      }
    }

    // Branching: Create/switch branch before BUILD (runner-owned)
    if (config.git?.branching && config.git.branching.mode !== 'off' && task.task_kind === 'execute') {
      console.log(`[BRANCHING] Ensuring branch for mode=${config.git.branching.mode}...`);
      
      let branchResult;
      let branchingError: string | null = null;
      
      // Validate config based on mode
      if (config.git.branching.mode === 'per_n_tasks') {
        if (!config.git.branching.n_tasks || config.git.branching.n_tasks < 1) {
          branchingError = `per_n_tasks mode requires n_tasks >= 1, but got ${config.git.branching.n_tasks}`;
        } else {
          // Calculate batch index: use builder_calls as proxy for task count
          // Each execute task results in a builder call
          const batchIndex = Math.floor(wsState.budgets.builder_calls / config.git.branching.n_tasks);
          branchResult = ensureBranchPerNTasks(config.git.branching, {
            task_id: task.task_id,
            milestone_id: task.milestone_id,
            run_id: state.run_id,
            tick_count: wsState.budgets.ticks + 1,
            seq: batchIndex,
            batch_index: batchIndex,
          });
        }
      } else if (config.git.branching.mode === 'per_milestone') {
        if (!task.milestone_id) {
          branchingError = 'per_milestone mode requires task.milestone_id';
        } else {
          branchResult = ensureBranchPerMilestone(config.git.branching, {
            task_id: task.task_id,
            milestone_id: task.milestone_id,
            run_id: state.run_id,
            tick_count: wsState.budgets.ticks + 1,
          });
        }
      } else if (config.git.branching.mode === 'per_tick') {
        branchResult = ensureBranchPerTick(config.git.branching, {
          task_id: task.task_id,
          milestone_id: task.milestone_id,
          run_id: state.run_id,
          tick_count: wsState.budgets.ticks + 1,
        });
      } else {
        // Unknown mode - should not happen due to TypeScript, but handle gracefully
        branchingError = `Unsupported branching mode: ${config.git.branching.mode}`;
      }
      
      // Handle branching errors or failures
      if (branchingError || (branchResult && !branchResult.ok)) {
        const errorMsg = branchingError || branchResult?.error || 'Unknown branching error';
        
        // Branching failed or config invalid - return BLOCKED report
        if (lockAcquired) {
          await releaseLock(lockPath);
          lockAcquired = false;
        }
        
        const report = generateReport(
          {
            ...state,
            errors: [`Branch creation/switch failed: ${errorMsg}`],
          },
          'BLOCKED_BRANCH_FAILED',
          'blocked'
        );
        report.budgets.ticks = 1;
        report.budgets.orchestrator_calls = 1;
        report.budgets.warnings.push(
          `Failed to create/switch branch: ${errorMsg}. ` +
          `Check git repository state and ensure branching configuration is valid.`
        );
        const blockedData = buildBlockedData(
          'BLOCKED_BRANCH_FAILED',
          `Branch creation/switch failed: ${errorMsg}`,
        );
        await persistRunArtifacts({ config, report, blockedData });
        return report;
      }
      
      if (branchResult) {
        currentBranchName = branchResult.branchName;
        console.log(`[BRANCHING] Branch ensured: ${currentBranchName} (existed: ${branchResult.existed})`);
      }
    }

    // Phase 4: BUILD
    console.log(`[${TickPhase.BUILD}] Running builder...`);
    if (isDebugEnabled() && state.task) {
      console.log(`[BUILD_DEBUG] task_id=${state.task.task_id}, task_kind=${state.task.task_kind}, max_turns=${state.task.builder?.max_turns ?? 'N/A'}`);
    }
    state = transitionPhase(state, TickPhase.BUILD);

    if (!state.task) {
      // This should not happen, but handle gracefully
      if (lockAcquired) {
        await releaseLock(lockPath);
        lockAcquired = false;
      }

      const report = generateReport(
        {
          ...state,
          errors: ['No task available for builder'],
        },
        'STOP_INTERRUPTED',
        'stop'
      );
      report.budgets.ticks = 1;
      report.budgets.orchestrator_calls = 1;
      await persistRunArtifacts({ config, report });
      return report;
    }

    let builderResult;
    try {
      builderResult = await runBuilder(state, state.task, signal);
      activeTickTokenUsage.builder = builderResult.tokenUsage ?? null;
      console.log(`[${TickPhase.BUILD}] Tokens: ${formatTokenUsageForLog(builderResult.tokenUsage)}`);
    } catch (error) {
      // Check if this is a transport stall
      if (isTransportStallError(error)) {
        console.log(`[${TickPhase.BUILD}] Transport stall detected`);
        const stallResult = await handleTransportStall(error, state.base_commit);

        if (lockAcquired) {
          await releaseLock(lockPath);
          lockAcquired = false;
        }

        const report = generateStallReport(state, stallResult);
        report.budgets.ticks = 1;
        report.budgets.orchestrator_calls = 1;
        report.budgets.builder_calls = 1;
        const blockedData = buildBlockedData(
          'BLOCKED_TRANSPORT_STALLED',
          `Transport stalled during builder: ${stallResult.requestId || 'unknown'}`,
        );
        await persistRunArtifacts({ config, report, blockedData });
        return report;
      }
      // Not a stall - rethrow
      throw error;
    }
    
    if (!builderResult.success) {
      // Builder invocation failed - release lock and return stopped report
      if (lockAcquired) {
        await releaseLock(lockPath);
        lockAcquired = false;
      }

      // Check for cursor missing config - this is a deterministic BLOCKED condition
      if (builderResult.validationErrors.includes('STOP_CURSOR_CONFIG_MISSING')) {
        // Persist builder failure artifacts for debugging
        if (builderResult.rawResponse) {
          try {
            await persistBuilderFailure(
              state.run_id,
              builderResult.rawResponse,
              null, // stderr not available from builder
              {
                kind: 'cli_error',
                message: builderResult.validationErrors.join('; ') || 'Builder invocation failed',
                details: { validationErrors: builderResult.validationErrors },
              },
              config
            );
          } catch (persistError) {
            // Log but don't fail the tick due to persistence issues
            console.warn(`Failed to persist builder failure: ${persistError instanceof Error ? persistError.message : String(persistError)}`);
          }
        }

        const report = generateReport(
          {
            ...state,
            builder_result: builderResult.result,
            errors: ['Builder mode is cursor but cursor config is missing'],
          },
          'BLOCKED_MISSING_CONFIG',
          'blocked'
        );
        report.budgets.ticks = 1;
        report.budgets.orchestrator_calls = 1;
        report.budgets.builder_calls = 1;
        report.budgets.warnings.push(
          'Task requested builder.mode="cursor" but config is missing builder.cursor. ' +
          `Configure cursor builder settings, then rerun '${config.product_name} tick'.`
        );
        const blockedData = buildBlockedData(
          'BLOCKED_MISSING_CONFIG',
          'Cursor builder mode selected but builder.cursor config is missing.',
        );
        await persistRunArtifacts({ config, report, blockedData });
        return report;
      }

      // Check if validationErrors contains a known BLOCKED_* report code
      const explicitBlockedCode = builderResult.validationErrors.find(
        (err) => isValidReportCode(err) && err.startsWith('BLOCKED_')
      );
      if (explicitBlockedCode) {
        // Persist builder failure artifacts for debugging
        if (builderResult.rawResponse) {
          try {
            await persistBuilderFailure(
              state.run_id,
              builderResult.rawResponse,
              null, // stderr not available from builder
              {
                kind: 'cli_error',
                message: builderResult.validationErrors.join('; ') || 'Builder invocation failed',
                details: { validationErrors: builderResult.validationErrors },
              },
              config
            );
          } catch (persistError) {
            // Log but don't fail the tick due to persistence issues
            console.warn(`Failed to persist builder failure: ${persistError instanceof Error ? persistError.message : String(persistError)}`);
          }
        }

        const report = generateReport(
          {
            ...state,
            builder_result: builderResult.result,
            errors: builderResult.rawResponse
              ? [`Builder preflight failed: ${builderResult.rawResponse.substring(0, 200)}`]
              : ['Builder preflight failed'],
          },
          explicitBlockedCode as ReportCode,
          'blocked'
        );
        report.budgets.ticks = 1;
        report.budgets.orchestrator_calls = 1;
        report.budgets.builder_calls = 1;
        if (builderResult.rawResponse) {
          report.budgets.warnings.push(compactWarningText(builderResult.rawResponse));
        }
        const blockedData = buildBlockedData(
          explicitBlockedCode as ReportCode,
          builderResult.rawResponse || 'Builder preflight failed',
        );
        await persistRunArtifacts({ config, report, blockedData });
        return report;
      }

      // Prefer explicit STOP_* codes from validationErrors over parseErrorKind mapping
      let reportCode: ReportCode = 'STOP_INTERRUPTED';
      
      // Check if validationErrors contains a known STOP_* report code
      const explicitStopCode = builderResult.validationErrors.find(
        (err) => isValidReportCode(err) && err.startsWith('STOP_')
      );
      if (explicitStopCode) {
        reportCode = explicitStopCode as ReportCode;
      } else if (builderResult.parseErrorKind) {
        // Fall back to parseErrorKind mapping if no explicit code found
        switch (builderResult.parseErrorKind) {
          case 'json_parse':
            reportCode = 'STOP_BUILDER_JSON_PARSE';
            break;
          case 'schema':
            reportCode = 'STOP_BUILDER_SCHEMA_INVALID';
            break;
          case 'shape':
            reportCode = 'STOP_BUILDER_SHAPE_INVALID';
            break;
          case 'cli_error':
            reportCode = 'STOP_BUILDER_CLI_ERROR';
            break;
        }
      }

      // Persist builder failure artifacts for debugging
      if (builderResult.rawResponse) {
        try {
          await persistBuilderFailure(
            state.run_id,
            builderResult.rawResponse,
            null, // stderr not available from builder
            {
              kind: builderResult.parseErrorKind ?? 'cli_error',
              message: builderResult.validationErrors.join('; ') || 'Builder invocation failed',
              details: { validationErrors: builderResult.validationErrors },
            },
            config
          );
        } catch (persistError) {
          // Log but don't fail the tick due to persistence issues
          console.warn(`Failed to persist builder failure: ${persistError instanceof Error ? persistError.message : String(persistError)}`);
        }
      }

      const report = generateReport(
        {
          ...state,
          builder_result: builderResult.result,
          errors: builderResult.rawResponse
            ? [`Builder invocation failed: ${builderResult.rawResponse.substring(0, 200)}`]
            : ['Builder invocation failed'],
        },
        reportCode,
        'stop'
      );
      report.budgets.ticks = 1;
      report.budgets.orchestrator_calls = 1;
      report.budgets.builder_calls = 1;
      await persistRunArtifacts({ config, report });
      return report;
    }

    // Update state with builder result
    state = {
      ...state,
      builder_result: builderResult.result,
    };
    
    if (builderResult.builderOutputValid) {
      console.log(`[${TickPhase.BUILD}] Builder completed successfully`);
    } else {
      console.log(`[${TickPhase.BUILD}] Builder completed but output was invalid JSON (lenient mode)`);
    }

    // Phase 5: JUDGE
    console.log(`[${TickPhase.JUDGE}] Running judge phase...`);
    state = transitionPhase(state, TickPhase.JUDGE);

    // Step 1: Check if HEAD moved externally
    const headCheck = checkHeadMoved(state.base_commit);
    if (!headCheck.ok) {
      console.log(`[${TickPhase.JUDGE}] HEAD moved externally`);
      if (lockAcquired) {
        await releaseLock(lockPath);
        lockAcquired = false;
      }
      const report = generateJudgeStopReport(
        state,
        'STOP_HEAD_MOVED',
        { files_touched: 0, lines_added: 0, lines_deleted: 0, new_files: 0 },
        [],
        [],
        headCheck.reason || 'HEAD moved externally'
      );
      report.budgets.ticks = 1;
      report.budgets.orchestrator_calls = 1;
      report.budgets.builder_calls = 1;
      await persistRunArtifacts({ config, report });
      return report;
    }

    // Step 2: Get touched files
    let touched: TouchedFiles;
    try {
      touched = getTouchedFiles(state.base_commit);
    } catch (error) {
      console.log(`[${TickPhase.JUDGE}] Failed to get touched files: ${error}`);
      if (lockAcquired) {
        await releaseLock(lockPath);
        lockAcquired = false;
      }
      const report = generateReport(state, 'STOP_INTERRUPTED', 'stop');
      report.budgets.ticks = 1;
      report.budgets.orchestrator_calls = 1;
      report.budgets.builder_calls = 1;
      await persistRunArtifacts({ config, report });
      return report;
    }
    console.log(`[${TickPhase.JUDGE}] Touched files: ${touched.all.length}`);

    // Step 3: Compute blast radius
    let blastRadius: { files_touched: number; lines_added: number; lines_deleted: number; new_files: number };
    try {
      blastRadius = computeBlastRadius(state.base_commit, touched);
    } catch (error) {
      console.log(`[${TickPhase.JUDGE}] Failed to compute blast radius: ${error}`);
      blastRadius = { files_touched: touched.all.length, lines_added: 0, lines_deleted: 0, new_files: 0 };
    }
    console.log(`[${TickPhase.JUDGE}] Blast radius: ${blastRadius.files_touched} files, ${blastRadius.lines_added}+ ${blastRadius.lines_deleted}- lines`);

    // Step 4: Check scope violations
    if (state.task) {
      const scopeCheck = checkScopeViolations(
        touched,
        state.task.scope,
        config.scope,
        config.runner.runner_owned_globs
      );
      if (!scopeCheck.ok && scopeCheck.stopCode) {
        console.log(`[${TickPhase.JUDGE}] Scope violation: ${scopeCheck.stopCode}`);
        // Rollback and check cleanliness
        const rollbackCheck = performRollbackWithCleanCheck(state.base_commit, touched.untracked);
        if (rollbackCheck.blockedCode) {
          // Rollback failed or worktree dirty - return BLOCKED
          if (lockAcquired) {
            await releaseLock(lockPath);
            lockAcquired = false;
          }
          const report = generateRollbackBlockedReport(
            state,
            rollbackCheck.blockedCode,
            rollbackCheck.reason || 'Rollback failed or worktree dirty',
            blastRadius,
            touched.all
          );
          report.budgets.ticks = 1;
          report.budgets.orchestrator_calls = 1;
          report.budgets.builder_calls = 1;
          const blockedData = buildBlockedData(
            rollbackCheck.blockedCode,
            rollbackCheck.reason || 'Rollback failed or worktree dirty',
          );
          await persistRunArtifacts({ config, report, blockedData });
          return report;
        }
        // Rollback succeeded and worktree is clean - proceed with STOP code
        if (lockAcquired) {
          await releaseLock(lockPath);
          lockAcquired = false;
        }
        const report = generateJudgeStopReport(
          state,
          scopeCheck.stopCode,
          blastRadius,
          touched.all,
          scopeCheck.violatingFiles,
          scopeCheck.reason || 'Scope violation'
        );
        report.budgets.ticks = 1;
        report.budgets.orchestrator_calls = 1;
        report.budgets.builder_calls = 1;
        await persistRunArtifacts({ config, report });
        return report;
      }
    }

    // Step 5: Check diff limits
    const diffLimits = state.task?.diff_limits || {
      max_files_touched: config.diff_limits.default_max_files_touched,
      max_lines_changed: config.diff_limits.default_max_lines_changed,
    };
    const diffCheck = checkDiffLimits(blastRadius, diffLimits);
    if (!diffCheck.ok && diffCheck.stopCode) {
      console.log(`[${TickPhase.JUDGE}] Diff too large: ${diffCheck.reason}`);
      // Rollback and check cleanliness
      const rollbackCheck = performRollbackWithCleanCheck(state.base_commit, touched.untracked);
      if (rollbackCheck.blockedCode) {
        // Rollback failed or worktree dirty - return BLOCKED
        if (lockAcquired) {
          await releaseLock(lockPath);
          lockAcquired = false;
        }
        const report = generateRollbackBlockedReport(
          state,
          rollbackCheck.blockedCode,
          rollbackCheck.reason || 'Rollback failed or worktree dirty',
          blastRadius,
          touched.all
        );
        report.budgets.ticks = 1;
        report.budgets.orchestrator_calls = 1;
        report.budgets.builder_calls = 1;
        const blockedData = buildBlockedData(
          rollbackCheck.blockedCode,
          rollbackCheck.reason || 'Rollback failed or worktree dirty',
        );
        await persistRunArtifacts({ config, report, blockedData });
        return report;
      }
      // Rollback succeeded and worktree is clean - proceed with STOP code
      if (lockAcquired) {
        await releaseLock(lockPath);
        lockAcquired = false;
      }
      const report = generateJudgeStopReport(
        state,
        diffCheck.stopCode,
        blastRadius,
        touched.all,
        [],
        diffCheck.reason || 'Diff too large'
      );
      report.budgets.ticks = 1;
      report.budgets.orchestrator_calls = 1;
      report.budgets.builder_calls = 1;
      await persistRunArtifacts({ config, report });
      return report;
    }

    // Step 6: Check task_kind side effects
    if (state.task && touched.all.length > 0) {
      if (state.task.task_kind === 'question') {
        console.log(`[${TickPhase.JUDGE}] Question task has side effects`);
        // Rollback and check cleanliness
        const rollbackCheck = performRollbackWithCleanCheck(state.base_commit, touched.untracked);
        if (rollbackCheck.blockedCode) {
          // Rollback failed or worktree dirty - return BLOCKED
          if (lockAcquired) {
            await releaseLock(lockPath);
            lockAcquired = false;
          }
          const report = generateRollbackBlockedReport(
            state,
            rollbackCheck.blockedCode,
            rollbackCheck.reason || 'Rollback failed or worktree dirty',
            blastRadius,
            touched.all
          );
          report.budgets.ticks = 1;
          report.budgets.orchestrator_calls = 1;
          report.budgets.builder_calls = 1;
          const blockedData = buildBlockedData(
            rollbackCheck.blockedCode,
            rollbackCheck.reason || 'Rollback failed or worktree dirty',
          );
          await persistRunArtifacts({ config, report, blockedData });
          return report;
        }
        // Rollback succeeded and worktree is clean - proceed with STOP code
        if (lockAcquired) {
          await releaseLock(lockPath);
          lockAcquired = false;
        }
        const report = generateJudgeStopReport(
          state,
          'STOP_QUESTION_SIDE_EFFECTS',
          blastRadius,
          touched.all,
          touched.all,
          'Question task made file changes'
        );
        report.budgets.ticks = 1;
        report.budgets.orchestrator_calls = 1;
        report.budgets.builder_calls = 1;
        await persistRunArtifacts({ config, report });
        return report;
      }
      if (state.task.task_kind === 'verify_only') {
        console.log(`[${TickPhase.JUDGE}] Verify-only task has side effects`);
        // Rollback and check cleanliness
        const rollbackCheck = performRollbackWithCleanCheck(state.base_commit, touched.untracked);
        if (rollbackCheck.blockedCode) {
          // Rollback failed or worktree dirty - return BLOCKED
          if (lockAcquired) {
            await releaseLock(lockPath);
            lockAcquired = false;
          }
          const report = generateRollbackBlockedReport(
            state,
            rollbackCheck.blockedCode,
            rollbackCheck.reason || 'Rollback failed or worktree dirty',
            blastRadius,
            touched.all
          );
          report.budgets.ticks = 1;
          report.budgets.orchestrator_calls = 1;
          report.budgets.builder_calls = 1;
          const blockedData = buildBlockedData(
            rollbackCheck.blockedCode,
            rollbackCheck.reason || 'Rollback failed or worktree dirty',
          );
          await persistRunArtifacts({ config, report, blockedData });
          return report;
        }
        // Rollback succeeded and worktree is clean - proceed with STOP code
        if (lockAcquired) {
          await releaseLock(lockPath);
          lockAcquired = false;
        }
        const report = generateJudgeStopReport(
          state,
          'STOP_VERIFY_ONLY_SIDE_EFFECTS',
          blastRadius,
          touched.all,
          touched.all,
          'Verify-only task made file changes'
        );
        report.budgets.ticks = 1;
        report.budgets.orchestrator_calls = 1;
        report.budgets.builder_calls = 1;
        await persistRunArtifacts({ config, report });
        return report;
      }
    }

    console.log(`[${TickPhase.JUDGE}] All checks passed`);

    // Step 7: Validate verification params
    if (state.task && state.task.verification) {
      const allParams: Record<string, string> = {};
      const taskParams = state.task.verification.params || {};
      for (const [templateId, templateParams] of Object.entries(taskParams)) {
        for (const [key, value] of Object.entries(templateParams)) {
          if (typeof value === 'string') {
            allParams[`${templateId}.${key}`] = value;
          }
        }
      }
      
      if (Object.keys(allParams).length > 0) {
        const paramCheck = validateAllParams(allParams, config.verification);
        if (!paramCheck.ok) {
          console.log(`[${TickPhase.JUDGE}] Verification params tainted: ${paramCheck.reason}`);
          // Rollback and check cleanliness
          const rollbackCheck = performRollbackWithCleanCheck(state.base_commit, touched.untracked);
          if (rollbackCheck.blockedCode) {
            // Rollback failed or worktree dirty - return BLOCKED
            if (lockAcquired) {
              await releaseLock(lockPath);
              lockAcquired = false;
            }
            const report = generateRollbackBlockedReport(
              state,
              rollbackCheck.blockedCode,
              rollbackCheck.reason || 'Rollback failed or worktree dirty',
              blastRadius,
              touched.all
            );
            report.budgets.ticks = 1;
            report.budgets.orchestrator_calls = 1;
            report.budgets.builder_calls = 1;
            const blockedData = buildBlockedData(
              rollbackCheck.blockedCode,
              rollbackCheck.reason || 'Rollback failed or worktree dirty',
            );
            await persistRunArtifacts({ config, report, blockedData });
            return report;
          }
          // Rollback succeeded and worktree is clean - proceed with STOP code
          if (lockAcquired) {
            await releaseLock(lockPath);
            lockAcquired = false;
          }
          const report = generateJudgeStopReport(
            state,
            'STOP_VERIFY_TAINTED',
            blastRadius,
            touched.all,
            [],
            paramCheck.reason || 'Verification params tainted'
          );
          report.budgets.ticks = 1;
          report.budgets.orchestrator_calls = 1;
          report.budgets.builder_calls = 1;
          await persistRunArtifacts({ config, report });
          return report;
        }
      }
    }

    // Step 8: Run fast verification
    if (state.task?.verification?.fast && state.task.verification.fast.length > 0) {
      console.log(`[${TickPhase.JUDGE}] Running fast verification...`);
      const fastResult = await runVerificationPhase(
        state.task.verification.fast,
        config.verification.templates,
        state.task.verification.params || {},
        'fast',
        config.verification.timeout_fast_seconds
      );
      
      if (!fastResult.ok && fastResult.stopCode) {
        console.log(`[${TickPhase.JUDGE}] Fast verification failed: ${fastResult.reason}`);
        // Rollback and check cleanliness
        const rollbackCheck = performRollbackWithCleanCheck(state.base_commit, touched.untracked);
        if (rollbackCheck.blockedCode) {
          // Rollback failed or worktree dirty - return BLOCKED
          if (lockAcquired) {
            await releaseLock(lockPath);
            lockAcquired = false;
          }
          const report = generateRollbackBlockedReport(
            state,
            rollbackCheck.blockedCode,
            rollbackCheck.reason || 'Rollback failed or worktree dirty',
            blastRadius,
            touched.all
          );
          report.verification.runs = fastResult.runs;
          report.budgets.ticks = 1;
          report.budgets.orchestrator_calls = 1;
          report.budgets.builder_calls = 1;
          report.budgets.verify_runs = fastResult.runs.length;
          const blockedData = buildBlockedData(
            rollbackCheck.blockedCode,
            rollbackCheck.reason || 'Rollback failed or worktree dirty',
          );
          await persistRunArtifacts({ config, report, blockedData });
          return report;
        }
        // Rollback succeeded and worktree is clean - proceed with STOP code
        if (lockAcquired) {
          await releaseLock(lockPath);
          lockAcquired = false;
        }
        const report = generateJudgeStopReport(
          state,
          fastResult.stopCode,
          blastRadius,
          touched.all,
          [],
          fastResult.reason || 'Fast verification failed'
        );
        report.verification.runs = fastResult.runs;
        report.budgets.ticks = 1;
        report.budgets.orchestrator_calls = 1;
        report.budgets.builder_calls = 1;
        report.budgets.verify_runs = fastResult.runs.length;
        await persistRunArtifacts({ config, report });
        return report;
      }
      console.log(`[${TickPhase.JUDGE}] Fast verification passed`);
    }

    // Step 9: Run slow verification (only if fast passed)
    if (state.task?.verification?.slow && state.task.verification.slow.length > 0) {
      console.log(`[${TickPhase.JUDGE}] Running slow verification...`);
      const slowResult = await runVerificationPhase(
        state.task.verification.slow,
        config.verification.templates,
        state.task.verification.params || {},
        'slow',
        config.verification.timeout_slow_seconds
      );
      
      if (!slowResult.ok && slowResult.stopCode) {
        console.log(`[${TickPhase.JUDGE}] Slow verification failed: ${slowResult.reason}`);
        // Rollback and check cleanliness
        const rollbackCheck = performRollbackWithCleanCheck(state.base_commit, touched.untracked);
        if (rollbackCheck.blockedCode) {
          // Rollback failed or worktree dirty - return BLOCKED
          if (lockAcquired) {
            await releaseLock(lockPath);
            lockAcquired = false;
          }
          const report = generateRollbackBlockedReport(
            state,
            rollbackCheck.blockedCode,
            rollbackCheck.reason || 'Rollback failed or worktree dirty',
            blastRadius,
            touched.all
          );
          report.verification.runs = slowResult.runs;
          // Count fast verification runs that passed (from state.task.verification.fast)
          const fastVerifyCount = state.task?.verification?.fast?.length || 0;
          report.budgets.ticks = 1;
          report.budgets.orchestrator_calls = 1;
          report.budgets.builder_calls = 1;
          report.budgets.verify_runs = fastVerifyCount + slowResult.runs.length;
          const blockedData = buildBlockedData(
            rollbackCheck.blockedCode,
            rollbackCheck.reason || 'Rollback failed or worktree dirty',
          );
          await persistRunArtifacts({ config, report, blockedData });
          return report;
        }
        // Rollback succeeded and worktree is clean - proceed with STOP code
        if (lockAcquired) {
          await releaseLock(lockPath);
          lockAcquired = false;
        }
        const report = generateJudgeStopReport(
          state,
          slowResult.stopCode,
          blastRadius,
          touched.all,
          [],
          slowResult.reason || 'Slow verification failed'
        );
        report.verification.runs = slowResult.runs;
        // Count fast verification runs that passed (from state.task.verification.fast)
        const fastVerifyCount = state.task?.verification?.fast?.length || 0;
        report.budgets.ticks = 1;
        report.budgets.orchestrator_calls = 1;
        report.budgets.builder_calls = 1;
        report.budgets.verify_runs = fastVerifyCount + slowResult.runs.length;
        await persistRunArtifacts({ config, report });
        return report;
      }
      console.log(`[${TickPhase.JUDGE}] Slow verification passed`);
    }

    console.log(`[${TickPhase.JUDGE}] Verification complete`);

    // Phase 6: REPORT
    console.log(`[${TickPhase.REPORT}] Generating report...`);
    state = transitionPhase(state, TickPhase.REPORT);

    const report = generateReport(state, 'SUCCESS', 'success');

    // Count verification runs for budgets
    const fastVerifyCount = state.task?.verification?.fast?.length || 0;
    const slowVerifyCount = state.task?.verification?.slow?.length || 0;
    report.budgets.ticks = 1;
    report.budgets.orchestrator_calls = 1;
    report.budgets.builder_calls = 1;
    report.budgets.verify_runs = fastVerifyCount + slowVerifyCount;
    
    // Add branch name to warnings for traceability (if branching was used)
    if (currentBranchName) {
      report.budgets.warnings.push(`Branch: ${currentBranchName}`);
    }

    const orchestratorTotal = activeTickTokenUsage?.orchestrator?.total_tokens ?? null;
    const builderTotal = activeTickTokenUsage?.builder?.total_tokens ?? null;
    const tickTotal =
      orchestratorTotal !== null || builderTotal !== null
        ? (orchestratorTotal ?? 0) + (builderTotal ?? 0)
        : null;
    console.log(
      `[${TickPhase.REPORT}] Token totals: orchestrator=${tokenNumber(orchestratorTotal)} builder=${tokenNumber(builderTotal)} tick_total=${tokenNumber(tickTotal)}`
    );

    await persistRunArtifacts({ config, report });
    console.log(`[${TickPhase.REPORT}] Artifacts persisted`);

    // Phase 7: END
    console.log(`[${TickPhase.END}] Releasing lock...`);
    state = transitionPhase(state, TickPhase.END);

    // Cleanup signal handlers before releasing lock
    if (signalCleanup) {
      signalCleanup();
      signalCleanup = null;
    }

    await releaseLock(lockPath);
    lockAcquired = false;
    console.log(`[${TickPhase.END}] Lock released`);

    return report;
  } catch (error) {
    // Cleanup signal handlers before releasing lock
    if (signalCleanup) {
      signalCleanup();
      signalCleanup = null;
    }

    // Ensure lock is released on error
    if (lockAcquired) {
      try {
        await releaseLock(lockPath);
      } catch (releaseError) {
        console.error(`Failed to release lock: ${releaseError}`);
      }
    }

    // Generate error report
    const errorState: TickState = state || {
      phase: TickPhase.END,
      run_id: 'error',
      started_at: new Date().toISOString(),
      base_commit: '',
      config,
      task: null,
      builder_result: null,
      errors: [error instanceof Error ? error.message : String(error)],
    };

    const report = generateReport(
      errorState,
      'STOP_INTERRUPTED',
      'stop'
    );
    report.budgets.ticks = 1;

    // Set budget counts based on which phase we reached
    if (state) {
      const phase = state.phase;
      // If we got past ORCHESTRATE, count orchestrator call
      if (phase !== TickPhase.LOCK && phase !== TickPhase.PREFLIGHT && phase !== TickPhase.ORCHESTRATE) {
        report.budgets.orchestrator_calls = 1;
      }
      // If we got past BUILD, count builder call
      if (phase === TickPhase.JUDGE || phase === TickPhase.REPORT || phase === TickPhase.END) {
        report.budgets.builder_calls = 1;
      }
    }

    // Try to write error report
    try {
      await persistRunArtifacts({ config, report });
    } catch (writeError) {
      console.error(`Failed to write error report: ${writeError}`);
    }

    // For interrupt, return gracefully (don't re-throw)
    if (isInterruptedError(error)) {
      console.log('[INTERRUPT] Abort signal received; persisting STOP_INTERRUPTED report');
      return report;
    }

    throw error;
  }
}
