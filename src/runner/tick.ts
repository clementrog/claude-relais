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
 * @returns Report data for this tick
 */
export async function runTick(config: RelaisConfig): Promise<ReportData> {
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

      const report = generateReport(
        {
          ...state,
          errors: preflightResult.blocked_reason
            ? [preflightResult.blocked_reason]
            : [],
        },
        preflightResult.blocked_code || 'BLOCKED_MISSING_CONFIG',
        'blocked'
      );
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

    // Phase 3: ORCHESTRATE (placeholder)
    console.log(`[${TickPhase.ORCHESTRATE}] Orchestrate phase (not yet implemented)`);
    state = transitionPhase(state, TickPhase.ORCHESTRATE);
    // Placeholder: Full implementation in M3
    console.log(`[${TickPhase.ORCHESTRATE}] Orchestrate not implemented - skipping`);

    // Phase 4: BUILD (placeholder)
    console.log(`[${TickPhase.BUILD}] Build phase (not yet implemented)`);
    state = transitionPhase(state, TickPhase.BUILD);
    // Placeholder: Full implementation in M4
    console.log(`[${TickPhase.BUILD}] Build not implemented - skipping`);

    // Phase 5: JUDGE (placeholder)
    console.log(`[${TickPhase.JUDGE}] Judge phase (not yet implemented)`);
    state = transitionPhase(state, TickPhase.JUDGE);
    // Placeholder: Full implementation in M5
    console.log(`[${TickPhase.JUDGE}] Judge not implemented - skipping`);

    // Phase 6: REPORT
    console.log(`[${TickPhase.REPORT}] Generating report...`);
    state = transitionPhase(state, TickPhase.REPORT);

    const report = generateReport(state, 'SUCCESS', 'success');

    // Write REPORT.json
    const reportPath = join(config.workspace_dir, 'REPORT.json');
    await atomicWriteJson(reportPath, report);
    console.log(`[${TickPhase.REPORT}] Report written to ${reportPath}`);

    // Write REPORT.md (placeholder - basic skeleton)
    const reportMdPath = join(config.workspace_dir, 'REPORT.md');
    const reportMd = `# Relais Report

Run ID: ${report.run_id}
Started: ${report.started_at}
Ended: ${report.ended_at}
Duration: ${report.duration_ms}ms

Verdict: ${report.verdict}
Code: ${report.code}

Base Commit: ${report.base_commit}
Head Commit: ${report.head_commit}

Task: ${report.task.task_id} (${report.task.task_kind})
Intent: ${report.task.intent}

Blast Radius:
- Files touched: ${report.blast_radius.files_touched}
- Lines added: ${report.blast_radius.lines_added}
- Lines deleted: ${report.blast_radius.lines_deleted}
- New files: ${report.blast_radius.new_files}
`;

    // Use atomicWriteJson for REPORT.md as well (write as JSON string, then convert)
    // Actually, we should write it as a text file, but for now use atomicWriteJson pattern
    const { writeFile } = await import('node:fs/promises');
    const { rename } = await import('node:fs/promises');
    const tmpPath = `${reportMdPath}.tmp`;
    await writeFile(tmpPath, reportMd, 'utf-8');
    await rename(tmpPath, reportMdPath);
    console.log(`[${TickPhase.REPORT}] Report markdown written to ${reportMdPath}`);

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

    // Try to write error report
    try {
      const reportPath = join(config.workspace_dir, 'REPORT.json');
      await atomicWriteJson(reportPath, report);
    } catch (writeError) {
      console.error(`Failed to write error report: ${writeError}`);
    }

    throw error;
  }
}
