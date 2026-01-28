/**
 * Report generation module for relais tick execution results.
 *
 * Provides functions to generate REPORT.json containing complete tick data:
 * run_id, timestamps, task info, verdict, code, blast_radius, scope check,
 * diff, verification results, and budgets.
 */

import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { open, rename, unlink } from 'node:fs/promises';
import type { ReportData, Verdict, ReportCode, BlastRadius, ScopeResult, DiffInfo, VerificationResult, BudgetInfo, TaskSummary, VerificationRun as ReportVerificationRun } from '../types/report.js';
import type { TickState } from '../types/state.js';
import type { DiffAnalysis } from './diff.js';
import type { ScopeCheckResult } from './scope.js';
import type { VerificationRun as VerifyRun } from './verify.js';
import type { VerificationTemplate } from '../types/config.js';
import { atomicWriteJson, AtomicFsError } from './fs.js';
import { getHeadCommit } from './git.js';

/**
 * Generates a unique run ID for a tick.
 *
 * Format: timestamp + random suffix (hex encoded)
 * Example: "20250128T123456Z-a1b2c3d4e5f6..."
 *
 * @returns A unique identifier string
 */
export function generateRunId(): string {
  // Generate timestamp prefix (ISO format without colons)
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').replace('T', 'T').substring(0, 19) + 'Z';
  
  // Generate 8 random bytes and encode as hex (16 chars)
  const randomSuffix = randomBytes(8).toString('hex');
  
  return `${timestamp}-${randomSuffix}`;
}

/**
 * Tick data required to build a complete report.
 */
export interface TickReportData {
  /** Tick state */
  state: TickState;
  /** Verdict */
  verdict: Verdict;
  /** Report code */
  code: ReportCode;
  /** Head commit SHA (may differ from base_commit if HEAD moved) */
  head_commit: string;
  /** Diff analysis results */
  diff_analysis?: DiffAnalysis;
  /** Scope check results */
  scope_check?: ScopeCheckResult;
  /** Verification runs (from verify.ts) */
  verification_runs?: VerifyRun[];
  /** Verification templates map (for transforming verification runs) */
  verification_templates?: Map<string, VerificationTemplate>;
  /** Verification log file path */
  verify_log_path?: string;
  /** Diff patch file path */
  diff_patch_path?: string;
  /** Budget information */
  budgets?: BudgetInfo;
}

/**
 * Transforms verification runs from verify.ts format to report format.
 *
 * @param runs - Verification runs from verify.ts
 * @param templates - Map of verification templates
 * @param task - Task containing verification configuration
 * @returns Array of verification runs in report format
 */
function transformVerificationRuns(
  runs: VerifyRun[],
  templates: Map<string, VerificationTemplate>,
  task: TickState['task']
): ReportVerificationRun[] {
  if (!task) {
    return [];
  }

  const result: ReportVerificationRun[] = [];
  const fastSet = new Set(task.verification.fast);
  const slowSet = new Set(task.verification.slow);

  for (const run of runs) {
    const template = templates.get(run.template_id);
    if (!template) {
      // Skip runs without templates
      continue;
    }

    // Determine phase based on task verification config
    const phase = fastSet.has(run.template_id) ? 'fast' : slowSet.has(run.template_id) ? 'slow' : 'fast';

    // Get args from template (they may have been interpolated, but we store original)
    const args = template.args || [];

    // Determine if timed out (exit code 124 is standard timeout code)
    const timed_out = run.exit_code === 124;

    result.push({
      template_id: run.template_id,
      phase,
      cmd: template.cmd,
      args,
      exit_code: run.exit_code,
      duration_ms: run.duration_ms,
      timed_out,
    });
  }

  return result;
}

/**
 * Builds a complete report from tick execution data.
 *
 * @param tickData - Complete tick data including state, verdict, diff, scope, verification, budgets
 * @returns Complete ReportData matching report.schema.json
 */
export function buildReport(tickData: TickReportData): ReportData {
  const { state, verdict, code, head_commit, diff_analysis, scope_check, verification_runs, verification_templates, verify_log_path, diff_patch_path, budgets } = tickData;

  const ended_at = new Date().toISOString();
  const started_at = new Date(state.started_at);
  const ended_at_date = new Date(ended_at);
  const duration_ms = Math.max(0, ended_at_date.getTime() - started_at.getTime());

  // Build task summary
  const task: TaskSummary = state.task
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
      };

  // Build blast radius from diff analysis
  const blast_radius: BlastRadius = diff_analysis
    ? {
        files_touched: diff_analysis.files_touched,
        lines_added: diff_analysis.lines_added,
        lines_deleted: diff_analysis.lines_deleted,
        new_files: diff_analysis.new_files,
      }
    : {
        files_touched: 0,
        lines_added: 0,
        lines_deleted: 0,
        new_files: 0,
      };

  // Build scope result
  const scope: ScopeResult = scope_check
    ? {
        ok: scope_check.ok,
        violations: scope_check.violations.map((v) => v.detail),
        touched_paths: scope_check.touched_paths,
      }
    : {
        ok: true,
        violations: [],
        touched_paths: [],
      };

  // Build diff info
  const diff: DiffInfo = diff_analysis
    ? {
        files_changed: diff_analysis.files_touched,
        lines_changed: diff_analysis.lines_added + diff_analysis.lines_deleted,
        diff_patch_path: diff_patch_path || '',
      }
    : {
        files_changed: 0,
        lines_changed: 0,
        diff_patch_path: diff_patch_path || '',
      };

  // Build verification result
  const verification: VerificationResult = {
    exec_mode: 'argv_no_shell',
    runs:
      verification_runs && verification_templates && state.task
        ? transformVerificationRuns(verification_runs, verification_templates, state.task)
        : [],
    verify_log_path: verify_log_path || '',
  };

  // Build budgets
  const budgets_data: BudgetInfo = budgets || {
    milestone_id: state.task?.milestone_id || 'none',
    ticks: 0,
    orchestrator_calls: 0,
    builder_calls: 0,
    verify_runs: verification_runs?.length || 0,
    estimated_cost_usd: 0,
    warnings: [],
  };

  return {
    run_id: state.run_id,
    started_at: state.started_at,
    ended_at,
    duration_ms,
    base_commit: state.base_commit,
    head_commit,
    task,
    verdict,
    code,
    blast_radius,
    scope,
    diff,
    verification,
    budgets: budgets_data,
  };
}

/**
 * Writes a report to a file atomically.
 *
 * Uses atomicWriteJson from fs.ts to ensure crash-safe writes.
 *
 * @param report - Report data to write
 * @param filePath - Path to write the report file
 * @returns Promise that resolves when write completes
 * @throws {Error} If the write operation fails
 *
 * @example
 * ```typescript
 * const report = buildReport(tickData);
 * await writeReport(report, '/path/to/REPORT.json');
 * ```
 */
export async function writeReport(report: ReportData, filePath: string): Promise<void> {
  await atomicWriteJson(filePath, report);
}

/**
 * Formats verdict and code for markdown display.
 *
 * @param verdict - The verdict value
 * @param code - The report code
 * @returns Formatted verdict string
 */
function formatVerdict(verdict: Verdict, code: ReportCode): string {
  if (verdict === 'success') {
    return '✓ SUCCESS';
  } else if (verdict === 'stop') {
    return `✗ STOP: ${code}`;
  } else if (verdict === 'blocked') {
    return `⚠ BLOCKED: ${code}`;
  }
  return `${verdict}: ${code}`;
}

/**
 * Renders report data as markdown.
 *
 * Generates a deterministic, human-readable markdown representation
 * of the report data. Same input always produces same output.
 *
 * @param report - Report data to render
 * @returns Markdown string
 */
export function renderReportMarkdown(report: ReportData): string {
  const lines: string[] = [];

  // Header
  lines.push('# Relais Run Report');
  lines.push('');

  // Summary section
  lines.push('## Summary');
  lines.push('');
  lines.push(`- **Run ID**: ${report.run_id}`);
  lines.push(`- **Started**: ${report.started_at}`);
  lines.push(`- **Ended**: ${report.ended_at}`);
  lines.push(`- **Duration**: ${report.duration_ms}ms`);
  lines.push(`- **Verdict**: ${formatVerdict(report.verdict, report.code)}`);
  lines.push(`- **Base Commit**: ${report.base_commit}`);
  lines.push(`- **Head Commit**: ${report.head_commit}`);
  lines.push('');

  // Task section
  lines.push('## Task');
  lines.push('');
  lines.push(`- **Task ID**: ${report.task.task_id}`);
  lines.push(`- **Milestone**: ${report.task.milestone_id}`);
  lines.push(`- **Kind**: ${report.task.task_kind}`);
  lines.push(`- **Intent**: ${report.task.intent}`);
  lines.push('');

  // Blast Radius section
  lines.push('## Blast Radius');
  lines.push('');
  lines.push(`- **Files Touched**: ${report.blast_radius.files_touched}`);
  lines.push(`- **Lines Added**: ${report.blast_radius.lines_added}`);
  lines.push(`- **Lines Deleted**: ${report.blast_radius.lines_deleted}`);
  lines.push(`- **New Files**: ${report.blast_radius.new_files}`);
  lines.push('');

  // Scope section
  lines.push('## Scope');
  lines.push('');
  if (report.scope.ok) {
    lines.push('✓ **OK** - No violations');
  } else {
    lines.push('✗ **Violations**:');
    for (const violation of report.scope.violations) {
      lines.push(`  - ${violation}`);
    }
  }
  if (report.scope.touched_paths.length > 0) {
    lines.push('');
    lines.push('**Touched Paths**:');
    for (const path of report.scope.touched_paths) {
      lines.push(`  - ${path}`);
    }
  }
  lines.push('');

  // Verification section
  lines.push('## Verification');
  lines.push('');
  if (report.verification.runs.length === 0) {
    lines.push('No verification runs.');
  } else {
    lines.push('| Template ID | Phase | Exit Code | Duration (ms) |');
    lines.push('|-------------|-------|-----------|---------------|');
    for (const run of report.verification.runs) {
      const status = run.exit_code === 0 ? '✓' : '✗';
      lines.push(`| ${run.template_id} | ${run.phase} | ${status} ${run.exit_code} | ${run.duration_ms} |`);
    }
  }
  if (report.verification.verify_log_path) {
    lines.push('');
    lines.push(`**Log**: ${report.verification.verify_log_path}`);
  }
  lines.push('');

  // Budgets section
  lines.push('## Budgets');
  lines.push('');
  lines.push(`- **Milestone**: ${report.budgets.milestone_id}`);
  lines.push(`- **Ticks**: ${report.budgets.ticks}`);
  lines.push(`- **Orchestrator Calls**: ${report.budgets.orchestrator_calls}`);
  lines.push(`- **Builder Calls**: ${report.budgets.builder_calls}`);
  lines.push(`- **Verification Runs**: ${report.budgets.verify_runs}`);
  lines.push(`- **Estimated Cost**: $${report.budgets.estimated_cost_usd.toFixed(4)}`);
  if (report.budgets.warnings.length > 0) {
    lines.push('');
    lines.push('**Warnings**:');
    for (const warning of report.budgets.warnings) {
      lines.push(`  - ${warning}`);
    }
  }
  lines.push('');

  return lines.join('\n');
}

/**
 * Atomically writes markdown content to a file.
 *
 * Uses the same write-tmp-fsync-rename pattern as atomicWriteJson
 * to ensure crash-safe writes.
 *
 * @param content - Markdown content to write
 * @param filePath - Path to write the markdown file
 * @returns Promise that resolves when write completes
 * @throws {AtomicFsError} If the write operation fails
 *
 * @example
 * ```typescript
 * const markdown = renderReportMarkdown(report);
 * await writeReportMarkdown(markdown, '/path/to/REPORT.md');
 * ```
 */
export async function writeReportMarkdown(content: string, filePath: string): Promise<void> {
  const tmpPath = `${filePath}.tmp`;
  let fileHandle: Awaited<ReturnType<typeof open>> | null = null;

  try {
    // Ensure content ends with newline
    const normalizedContent = content.endsWith('\n') ? content : content + '\n';

    // Open file for writing, create if doesn't exist, truncate if exists
    fileHandle = await open(tmpPath, 'w');

    // Write the content
    await fileHandle.writeFile(normalizedContent, 'utf-8');

    // fsync to ensure data is flushed to disk
    await fileHandle.sync();

    // Close before rename
    await fileHandle.close();
    fileHandle = null;

    // Atomic rename (POSIX guarantees atomicity)
    await rename(tmpPath, filePath);
  } catch (error) {
    // Attempt to clean up the tmp file on error
    if (fileHandle) {
      try {
        await fileHandle.close();
      } catch {
        // Ignore close errors during cleanup
      }
    }

    try {
      await unlink(tmpPath);
    } catch {
      // Ignore unlink errors - file may not exist
    }

    throw new AtomicFsError(
      `Failed to atomically write markdown to ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
      filePath,
      error instanceof Error ? error : undefined
    );
  }
}
