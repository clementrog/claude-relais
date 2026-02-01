/**
 * History management utilities for preserving tick run artifacts.
 *
 * Each tick's artifacts (report.json, report.md, diff.patch, verify.log) are
 * preserved in history/<run_id>/ to enable debugging and audit trails.
 */

import { mkdir, readdir, open, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { RelaisConfig } from '../types/config.js';
import type { ReportData, Verdict, ReportCode } from '../types/report.js';
import { atomicWriteJson, AtomicFsError } from './fs.js';
import type { RawAjvError } from './schema.js';

/**
 * Gets the full path to the history directory for a specific run.
 *
 * @param config - Relais configuration
 * @param runId - Run ID
 * @returns Full path to the run's history directory
 */
function getHistoryRunPath(config: RelaisConfig, runId: string): string {
  return join(config.workspace_dir, config.history.dir, runId);
}

/**
 * Atomically writes text content to a file.
 *
 * Uses the write-tmp-fsync-rename pattern to ensure crash-safe writes.
 *
 * @param filePath - Path to write the file
 * @param content - Text content to write
 * @throws {AtomicFsError} If the write operation fails
 */
async function atomicWriteText(filePath: string, content: string): Promise<void> {
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
      `Failed to atomically write text to ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
      filePath,
      error instanceof Error ? error : undefined
    );
  }
}

/**
 * Creates the history snapshot directory for a run.
 *
 * @param runId - Run ID
 * @param config - Relais configuration
 * @returns Promise that resolves when directory is created
 * @throws {Error} If directory creation fails
 */
export async function createHistorySnapshot(runId: string, config: RelaisConfig): Promise<void> {
  const runPath = getHistoryRunPath(config, runId);
  await mkdir(runPath, { recursive: true });
}

/**
 * Writes an artifact file to the history directory for a run.
 *
 * @param runId - Run ID
 * @param filename - Name of the artifact file (e.g., 'report.json', 'diff.patch')
 * @param content - Content to write (string for text files, object for JSON)
 * @param config - Relais configuration
 * @returns Promise that resolves when write completes
 * @throws {Error} If the write operation fails
 */
export async function writeHistoryArtifact(
  runId: string,
  filename: string,
  content: string | object,
  config: RelaisConfig
): Promise<void> {
  const runPath = getHistoryRunPath(config, runId);
  const filePath = join(runPath, filename);

  if (typeof content === 'object') {
    await atomicWriteJson(filePath, content);
  } else {
    await atomicWriteText(filePath, content);
  }
}

/**
 * Metadata structure for history meta.json file.
 */
interface HistoryMeta {
  run_id: string;
  created_at: string;
  verdict: Verdict;
  code: string;
}

/**
 * Creates a complete history snapshot for a tick run.
 *
 * Saves all artifacts (meta.json, report.json, report.md, and optionally
 * diff.patch and verify.log) to history/<run_id>/.
 *
 * @param runId - Run ID
 * @param report - Report data
 * @param markdown - Markdown rendering of the report
 * @param diffPatch - Optional diff patch content
 * @param verifyLog - Optional verification log content
 * @param config - Relais configuration
 * @returns Promise that resolves when all artifacts are saved
 * @throws {Error} If any write operation fails
 */
export async function snapshotRun(
  runId: string,
  report: ReportData,
  markdown: string,
  diffPatch: string | null,
  verifyLog: string | null,
  config: RelaisConfig
): Promise<void> {
  // Create the history directory
  await createHistorySnapshot(runId, config);

  // Create meta.json with run metadata
  const meta: HistoryMeta = {
    run_id: runId,
    created_at: report.ended_at,
    verdict: report.verdict,
    code: report.code,
  };
  await writeHistoryArtifact(runId, 'meta.json', meta, config);

  // Write report.json (full report data)
  await writeHistoryArtifact(runId, 'report.json', report, config);

  // Write report.md (markdown rendering)
  await writeHistoryArtifact(runId, 'report.md', markdown, config);

  // Write optional diff.patch if provided and enabled
  if (diffPatch !== null && diffPatch !== undefined && config.history.include_diff_patch) {
    await writeHistoryArtifact(runId, 'diff.patch', diffPatch, config);
  }

  // Write optional verify.log if provided and enabled
  if (verifyLog !== null && verifyLog !== undefined && config.history.include_verify_log) {
    await writeHistoryArtifact(runId, 'verify.log', verifyLog, config);
  }
}

/**
 * Counts the number of existing history entries.
 *
 * @param config - Relais configuration
 * @returns Promise that resolves to the count of history entries
 * @throws {Error} If reading the history directory fails
 */
/**
 * Error information for builder failures.
 */
export interface BuilderErrorInfo {
  /** Error kind matching BuilderParseErrorKind or 'cli_error' */
  kind: 'json_parse' | 'schema' | 'shape' | 'cli_error';
  /** Human-readable error message */
  message: string;
  /** Additional error details */
  details?: unknown;
}

/**
 * Persists builder failure artifacts to history for debugging.
 *
 * Writes raw stdout, stderr (if available), and error info to
 * history/<run_id>/ for post-mortem analysis.
 *
 * @param runId - Run ID
 * @param stdout - Raw stdout from builder invocation
 * @param stderr - Raw stderr from builder invocation (may be null)
 * @param errorInfo - Structured error information
 * @param config - Relais configuration
 * @returns Promise that resolves when all artifacts are saved
 * @throws {Error} If any write operation fails
 */
export async function persistBuilderFailure(
  runId: string,
  stdout: string,
  stderr: string | null,
  errorInfo: BuilderErrorInfo,
  config: RelaisConfig
): Promise<void> {
  // Ensure history directory exists
  await createHistorySnapshot(runId, config);

  // Write raw stdout
  await writeHistoryArtifact(runId, 'builder.stdout.raw.txt', stdout, config);

  // Write raw stderr if available
  if (stderr !== null && stderr.length > 0) {
    await writeHistoryArtifact(runId, 'builder.stderr.raw.txt', stderr, config);
  }

  // Write structured error info
  await writeHistoryArtifact(runId, 'builder.error.json', errorInfo, config);
}

/** Maximum size for stdout/stderr artifacts (200KB) */
const MAX_OUTPUT_SIZE = 200 * 1024;

/**
 * Truncates content to max size with marker.
 */
function truncateWithMarker(content: string, maxSize: number): string {
  if (content.length <= maxSize) {
    return content;
  }
  return content.slice(0, maxSize - 12) + '\n[truncated]';
}

/**
 * Metadata for orchestrator failure artifacts.
 */
export interface OrchestratorFailureMeta {
  run_id: string;
  phase: 'orchestrator';
  model: string;
  timeout_ms: number;
  prompt_chars: number;
  system_prompt_chars: number;
  cwd: string;
  args_summary_redacted: string;
}

/**
 * Persists orchestrator failure artifacts to history for debugging.
 *
 * Writes stdout, stderr, extracted JSON, schema errors, and meta to
 * history/<run_id>/orchestrator/ for post-mortem analysis.
 *
 * @param runId - Run ID
 * @param stdout - Raw stdout from orchestrator invocation
 * @param stderr - Raw stderr from orchestrator invocation
 * @param extractedJson - Extracted JSON candidate if extraction succeeded
 * @param schemaErrors - Ajv errors array when validation fails
 * @param meta - Invocation metadata
 * @param config - Relais configuration
 * @returns Promise that resolves when all artifacts are saved
 * @throws {Error} If any write operation fails
 */
export async function persistOrchestratorFailure(
  runId: string,
  stdout: string,
  stderr: string,
  extractedJson: unknown | null,
  schemaErrors: RawAjvError[] | null,
  meta: OrchestratorFailureMeta,
  config: RelaisConfig
): Promise<void> {
  // Create orchestrator subdirectory under run history
  const orchestratorPath = join(config.workspace_dir, config.history.dir, runId, 'orchestrator');
  await mkdir(orchestratorPath, { recursive: true });

  // Helper to write to orchestrator subdir
  const writeArtifact = async (filename: string, content: string | object) => {
    const filePath = join(orchestratorPath, filename);
    if (typeof content === 'object') {
      await atomicWriteJson(filePath, content);
    } else {
      await atomicWriteText(filePath, content);
    }
  };

  // Write stdout.txt (truncated to 200KB)
  await writeArtifact('stdout.txt', truncateWithMarker(stdout, MAX_OUTPUT_SIZE));

  // Write stderr.txt (truncated, create even if empty)
  await writeArtifact('stderr.txt', truncateWithMarker(stderr || '', MAX_OUTPUT_SIZE));

  // Write extracted.json if extraction succeeded
  if (extractedJson !== null && extractedJson !== undefined) {
    await writeArtifact('extracted.json', extractedJson);
  }

  // Write schema_error.json if validation failed
  if (schemaErrors !== null && schemaErrors.length > 0) {
    await writeArtifact('schema_error.json', schemaErrors);
  }

  // Write meta.json
  await writeArtifact('meta.json', meta);
}

export async function getHistoryCount(config: RelaisConfig): Promise<number> {
  const historyPath = join(config.workspace_dir, config.history.dir);

  try {
    const entries = await readdir(historyPath, { withFileTypes: true });
    // Count only directories (each run_id is a directory)
    return entries.filter((entry) => entry.isDirectory()).length;
  } catch (error) {
    // If directory doesn't exist, return 0
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return 0;
    }
    throw error;
  }
}
