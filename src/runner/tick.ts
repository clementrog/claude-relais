/**
 * Main tick execution runner.
 *
 * Implements the relais state machine:
 * LOCK → PREFLIGHT → ORCHESTRATE → BUILD → JUDGE → REPORT → END
 */

import { join } from 'node:path';
import type { RelaisConfig } from '../types/config.js';
import type { ReportData, ReportCode } from '../types/report.js';
import { TickPhase } from '../types/state.js';
import type { TickState } from '../types/state.js';
import { acquireLock, releaseLock, LockHeldError } from '../lib/lock.js';
import { runPreflight } from '../lib/preflight.js';
import { atomicWriteJson } from '../lib/fs.js';
import { getHeadCommit } from '../lib/git.js';
import {
  createInitialState,
  transitionPhase,
  addError,
} from '../lib/state.js';
import { runOrchestrator } from './orchestrator.js';
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
import { rollbackToCommit } from '../lib/rollback.js';
import { validateAllParams } from '../lib/verify-safety.js';
import { readWorkspaceState, writeWorkspaceState, ensureMilestone } from '../lib/workspace_state.js';
import { spawn } from 'node:child_process';
import { isInterruptedError } from '../types/claude.js';

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
  config: RelaisConfig;
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
  const { config, report, blockedData } = options;
  const workspaceDir = config.workspace_dir;

  // 1. ALWAYS write REPORT.json first (most critical)
  await atomicWriteJson(join(workspaceDir, 'REPORT.json'), report);

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
 * Executes one complete tick of the relais loop.
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
 * @param config - Relais configuration
 * @param signal - Optional AbortSignal for cancellation
 * @returns Report data for this tick
 */
export async function runTick(
  config: RelaisConfig,
  signal?: AbortSignal
): Promise<ReportData> {
  let state: TickState | undefined;
  let lockAcquired = false;
  const lockPath = config.runner.lockfile;

  try {
    // Phase 1: LOCK
    console.log(`[${TickPhase.LOCK}] Acquiring lock...`);
    try {
      const lockInfo = await acquireLock(lockPath);
      lockAcquired = true;
      console.log(`[${TickPhase.LOCK}] Lock acquired (PID: ${lockInfo.pid})`);

      // Get base commit before proceeding
      const baseCommit = getHeadCommit();
      state = createInitialState(config, baseCommit);
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
      // Preflight failed - release lock and return blocked report
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
      // Not a stall - rethrow
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
          stdout_excerpt: orchestratorResult.rawResponse?.slice(-2000),
          json_excerpt: orchestratorResult.rawResponse?.slice(0, 1000),
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

    // PR6: Check for control.action='stop' signal from orchestrator
    if (orchestratorResult.task.control?.action === 'stop') {
      console.log(`[${TickPhase.ORCHESTRATE}] Control action: stop (reason: ${orchestratorResult.task.control.reason || 'none'})`);
      if (lockAcquired) {
        await releaseLock(lockPath);
        lockAcquired = false;
      }

      const report = generateReport(
        state,
        'SUCCESS',
        'success'
      );
      report.budgets.ticks = 1;
      report.budgets.orchestrator_calls = 1;
      // Annotate the report with control reason
      report.budgets.warnings.push(`Orchestrator signaled stop: ${orchestratorResult.task.control.reason || 'no reason given'}`);
      await persistRunArtifacts({ config, report });
      return report;
    }

    // PR3: Persist milestone_id early for crash tolerance.
    // If crash happens during build/judge/verify, restart will know which milestone was active.
    const wsState = await readWorkspaceState(config.workspace_dir);
    const task = orchestratorResult.task;
    if (task.milestone_id) {
      const { state: newState, changed } = ensureMilestone(wsState, task.milestone_id);
      if (changed) {
        await writeWorkspaceState(config.workspace_dir, newState);
        console.log(`Milestone persisted early: ${task.milestone_id}`);
      }
    }

    // Phase 4: BUILD
    console.log(`[${TickPhase.BUILD}] Running builder...`);
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

      // Use STOP_BUILDER_OUTPUT_INVALID if output was invalid, otherwise STOP_INTERRUPTED
      const reportCode = !builderResult.builderOutputValid && builderResult.rawResponse
        ? 'STOP_BUILDER_OUTPUT_INVALID'
        : 'STOP_INTERRUPTED';

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
        // Rollback
        console.log(`[${TickPhase.JUDGE}] Rolling back to ${state.base_commit}`);
        const rollbackResult = rollbackToCommit(state.base_commit, touched.untracked);
        if (!rollbackResult.ok) {
          console.log(`[${TickPhase.JUDGE}] Rollback failed: ${rollbackResult.error}`);
        }
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
      // Rollback
      console.log(`[${TickPhase.JUDGE}] Rolling back to ${state.base_commit}`);
      const rollbackResult = rollbackToCommit(state.base_commit, touched.untracked);
      if (!rollbackResult.ok) {
        console.log(`[${TickPhase.JUDGE}] Rollback failed: ${rollbackResult.error}`);
      }
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
        // Rollback
        console.log(`[${TickPhase.JUDGE}] Rolling back to ${state.base_commit}`);
        const rollbackResult = rollbackToCommit(state.base_commit, touched.untracked);
        if (!rollbackResult.ok) {
          console.log(`[${TickPhase.JUDGE}] Rollback failed: ${rollbackResult.error}`);
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
        // Rollback
        console.log(`[${TickPhase.JUDGE}] Rolling back to ${state.base_commit}`);
        const rollbackResult = rollbackToCommit(state.base_commit, touched.untracked);
        if (!rollbackResult.ok) {
          console.log(`[${TickPhase.JUDGE}] Rollback failed: ${rollbackResult.error}`);
        }
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
          // Rollback
          console.log(`[${TickPhase.JUDGE}] Rolling back to ${state.base_commit}`);
          rollbackToCommit(state.base_commit, touched.untracked);
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
        // Rollback
        console.log(`[${TickPhase.JUDGE}] Rolling back to ${state.base_commit}`);
        rollbackToCommit(state.base_commit, touched.untracked);
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
        // Rollback
        console.log(`[${TickPhase.JUDGE}] Rolling back to ${state.base_commit}`);
        rollbackToCommit(state.base_commit, touched.untracked);
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

    await persistRunArtifacts({ config, report });
    console.log(`[${TickPhase.REPORT}] Artifacts persisted`);

    // Phase 7: END
    console.log(`[${TickPhase.END}] Releasing lock...`);
    state = transitionPhase(state, TickPhase.END);
    await releaseLock(lockPath);
    lockAcquired = false;
    console.log(`[${TickPhase.END}] Lock released`);

    return report;
  } catch (error) {
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
