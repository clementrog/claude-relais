/**
 * Builder (Hands) implementation.
 *
 * Invokes Claude Code with bypassPermissions mode and restricted tools to execute tasks.
 */

import { lstat, readFile, writeFile, mkdir, unlink } from 'node:fs/promises';
import { join, resolve, relative } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
import { invokeClaudeCode } from '../lib/claude.js';
import { matchesGlob } from '../lib/scope.js';
import { loadSchema, validateWithSchema } from '../lib/schema.js';
import type { RelaisConfig } from '../types/config.js';
import type { TickState } from '../types/state.js';
import type { Task } from '../types/task.js';
import type { BuilderResult, BuilderResultCode } from '../types/builder.js';
import { isInterruptedError } from '../types/claude.js';

/**
 * Result of builder invocation.
 */
export interface BuilderInvocationResult {
  /** Whether the invocation was successful */
  success: boolean;
  /** The parsed builder result (null if unsuccessful or invalid JSON) */
  result: BuilderResult | null;
  /** Raw response from Claude Code */
  rawResponse: string;
  /** Duration of invocation in milliseconds */
  durationMs: number;
  /** Whether the builder output was valid JSON matching the schema */
  builderOutputValid: boolean;
  /** Schema validation errors if any */
  validationErrors: string[];
  /** The turns requested by task (before clamping) */
  turnsRequested: number;
  /** Actual turns used (from raw response, if available) */
  turnsUsed: number | null;
}

/**
 * Builds the builder user prompt by loading the template and interpolating placeholders.
 *
 * @param config - Relais configuration
 * @param task - Task to execute
 * @returns The interpolated user prompt
 */
export async function buildBuilderPrompt(
  config: RelaisConfig,
  task: Task
): Promise<string> {
  const workspaceDir = config.workspace_dir;
  const userPromptPath = join(workspaceDir, config.builder.claude_code.user_prompt_file);

  // Load user prompt template
  let template: string;
  try {
    template = await readFile(userPromptPath, 'utf-8');
  } catch (error) {
    throw new Error(
      `Failed to read builder user prompt template from ${userPromptPath}: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  // Interpolate placeholders
  const replacements: Record<string, string> = {
    '{{TASK_JSON}}': JSON.stringify(task, null, 2),
    '{{ALLOWED_GLOBS}}': task.scope.allowed_globs.join(', '),
    '{{FORBIDDEN_GLOBS}}': task.scope.forbidden_globs.join(', '),
    '{{ALLOW_NEW_FILES}}': task.scope.allow_new_files ? 'true' : 'false',
    '{{ALLOW_LOCKFILE_CHANGES}}': task.scope.allow_lockfile_changes ? 'true' : 'false',
    '{{MAX_FILES_TOUCHED}}': task.diff_limits.max_files_touched.toString(),
    '{{MAX_LINES_CHANGED}}': task.diff_limits.max_lines_changed.toString(),
  };

  let prompt = template;
  for (const [placeholder, value] of Object.entries(replacements)) {
    prompt = prompt.replace(new RegExp(placeholder.replace(/[{}]/g, '\\$&'), 'g'), value);
  }

  return prompt;
}

// Cache for loaded builder result schema
let builderResultSchemaCache: object | null = null;

/**
 * Extracts file paths from unified diff headers (lines starting with +++ or ---).
 */
function parsePatchPaths(patch: string): string[] {
  const paths: string[] = [];
  const lines = patch.split('\n');
  for (const line of lines) {
    if (line.startsWith('+++ ') || line.startsWith('--- ')) {
      const match = line.match(/^[+-]{3} [ab]\/(.+)$/);
      if (match) {
        paths.push(match[1]);
      }
    }
  }
  return [...new Set(paths)];
}

/**
 * Validates a single path against security rules: no .., no leading /, no null bytes, must resolve inside repo.
 */
function validatePatchPath(
  path: string,
  repoRoot: string
): { valid: boolean; reason?: string } {
  if (path.includes('\0')) {
    return { valid: false, reason: 'Path contains null byte' };
  }
  if (path.startsWith('/')) {
    return { valid: false, reason: 'Absolute path not allowed' };
  }
  if (path.includes('..')) {
    return { valid: false, reason: 'Parent directory traversal (..) not allowed' };
  }
  const resolved = resolve(repoRoot, path);
  const rel = relative(repoRoot, resolved);
  if (rel.startsWith('..') || rel.startsWith('/')) {
    return { valid: false, reason: 'Path resolves outside repository root' };
  }
  return { valid: true };
}

/**
 * Checks if a path is within task scope using allowed_globs and forbidden_globs.
 * Forbidden is checked first (deny wins).
 */
function checkPatchScope(
  path: string,
  allowedGlobs: string[],
  forbiddenGlobs: string[]
): { allowed: boolean; reason?: string } {
  if (matchesGlob(path, forbiddenGlobs)) {
    return { allowed: false, reason: 'Path matches forbidden glob' };
  }
  if (allowedGlobs.length > 0 && !matchesGlob(path, allowedGlobs)) {
    return { allowed: false, reason: 'Path does not match any allowed glob' };
  }
  return { allowed: true };
}

/**
 * Checks if a path is a symlink or any parent directory segment is a symlink.
 * Uses lstat (not stat) so symlinks are detected without following them.
 * Non-existent paths are OK (patch may create new files).
 */
async function isSymlinkOrHasSymlinkParent(
  filePath: string,
  repoRoot: string
): Promise<{ isSymlink: boolean; symlinkPath?: string }> {
  const fullPath = resolve(repoRoot, filePath);
  const rel = relative(repoRoot, fullPath);
  if (rel.startsWith('..') || rel === '') return { isSymlink: false };
  const segments = rel.split('/');

  let currentPath = repoRoot;
  for (const segment of segments) {
    currentPath = join(currentPath, segment);
    try {
      const stats = await lstat(currentPath);
      if (stats.isSymbolicLink()) {
        return { isSymlink: true, symlinkPath: currentPath };
      }
    } catch {
      // Path doesn't exist yet - that's OK for new files
      break;
    }
  }
  return { isSymlink: false };
}

/**
 * Writes the patch to a temp file and runs git apply.
 *
 * @param patch - Raw patch content (unified diff)
 * @param workspaceDir - Workspace directory (for .tmp)
 * @param repoRoot - Repository root (cwd and --directory for git apply)
 * @returns success, output, and optional error message
 */
async function applyPatch(
  patch: string,
  workspaceDir: string,
  repoRoot: string
): Promise<{ success: boolean; output: string; error?: string }> {
  const tmpDir = join(workspaceDir, '.tmp');
  await mkdir(tmpDir, { recursive: true });
  const patchFile = join(tmpDir, 'patch.diff');
  await writeFile(patchFile, patch, 'utf-8');

  try {
    const { stdout, stderr } = await execFileAsync('git', [
      'apply',
      '--whitespace=nowarn',
      `--directory=${repoRoot}`,
      patchFile,
    ], { cwd: repoRoot });
    return { success: true, output: (stdout ?? '') + (stderr ?? '') };
  } catch (error: unknown) {
    const err = error as { stdout?: string; stderr?: string; message?: string };
    return {
      success: false,
      output: err.stdout ?? '',
      error: err.stderr ?? err.message ?? String(error),
    };
  }
}

/**
 * Handles patch builder mode.
 *
 * Validates and applies a unified diff patch from task.builder.patch.
 * Security: validates paths, rejects traversal, checks symlinks, enforces scope.
 *
 * STOP_PATCH_* codes (including STOP_PATCH_APPLY_FAILED) trigger rollback via the
 * existing tick pipeline: builder returns success=false, tick emits a stop report,
 * and the orchestrator can treat it as a stop (e.g. state rollback). See docs/NEW-PLAN.md PR4.
 *
 * @see docs/NEW-PLAN.md PR4
 */
async function handlePatchMode(
  config: RelaisConfig,
  task: Task
): Promise<BuilderInvocationResult> {
  const patch = task.builder?.patch ?? '';
  const paths = parsePatchPaths(patch);
  const repoRoot = config.workspace_dir;

  for (const path of paths) {
    const validation = validatePatchPath(path, repoRoot);
    if (!validation.valid) {
      const message = `Invalid patch path '${path}': ${validation.reason}`;
      return {
        success: false,
        result: null,
        rawResponse: message,
        durationMs: 0,
        builderOutputValid: false,
        validationErrors: ['STOP_PATCH_INVALID_PATH'],
        turnsRequested: task.builder!.max_turns,
        turnsUsed: null,
      };
    }
  }

  const allowedGlobs =
    task.scope.allowed_globs.length > 0
      ? task.scope.allowed_globs
      : config.scope.default_allowed_globs;
  const forbiddenGlobs =
    task.scope.forbidden_globs.length > 0
      ? task.scope.forbidden_globs
      : config.scope.default_forbidden_globs;

  for (const path of paths) {
    const scopeCheck = checkPatchScope(path, allowedGlobs, forbiddenGlobs);
    if (!scopeCheck.allowed) {
      const message = `Patch path '${path}' violates scope: ${scopeCheck.reason}`;
      return {
        success: false,
        result: null,
        rawResponse: message,
        durationMs: 0,
        builderOutputValid: false,
        validationErrors: ['STOP_PATCH_SCOPE_VIOLATION'],
        turnsRequested: task.builder!.max_turns,
        turnsUsed: null,
      };
    }
  }

  for (const path of paths) {
    const symlinkCheck = await isSymlinkOrHasSymlinkParent(path, repoRoot);
    if (symlinkCheck.isSymlink) {
      const message = `Symlink detected in patch path: ${symlinkCheck.symlinkPath}`;
      return {
        success: false,
        result: null,
        rawResponse: message,
        durationMs: 0,
        builderOutputValid: false,
        validationErrors: ['STOP_PATCH_SYMLINK'],
        turnsRequested: task.builder!.max_turns,
        turnsUsed: null,
      };
    }
  }

  const applyResult = await applyPatch(patch, config.workspace_dir, repoRoot);

  if (!applyResult.success) {
    const patchFile = join(config.workspace_dir, '.tmp', 'patch.diff');
    try {
      await unlink(patchFile);
    } catch {
      /* ignore cleanup errors */
    }
    return {
      success: false,
      result: null,
      rawResponse: `git apply failed: ${applyResult.error}`,
      durationMs: 0,
      builderOutputValid: false,
      validationErrors: ['STOP_PATCH_APPLY_FAILED'],
      turnsRequested: task.builder!.max_turns,
      turnsUsed: null,
    };
  }

  const result: BuilderResult = {
    summary: 'Patch applied successfully',
    files_intended: paths,
    commands_ran: ['git apply --whitespace=nowarn --directory=<repoRoot> .tmp/patch.diff'],
    notes: [applyResult.output.trim() || 'Applied.'],
  };
  return {
    success: true,
    result,
    rawResponse: applyResult.output,
    durationMs: 0,
    builderOutputValid: true,
    validationErrors: [],
    turnsRequested: task.builder!.max_turns,
    turnsUsed: null,
  };
}

/**
 * Handles cursor builder mode.
 *
 * Delegates build to an external process (e.g., Cursor IDE).
 * Writes TASK.json to workspace, spawns the external driver,
 * waits for completion, then reads and validates the result file.
 *
 * @see docs/NEW-PLAN.md PR5
 */
async function handleCursorMode(
  config: RelaisConfig,
  task: Task
): Promise<BuilderInvocationResult> {
  const startTime = Date.now();
  const cursor = config.builder.cursor;

  if (!cursor) {
    return {
      success: false,
      result: null,
      rawResponse: 'Cursor config not defined',
      durationMs: Date.now() - startTime,
      builderOutputValid: false,
      validationErrors: ['STOP_CURSOR_CONFIG_MISSING'],
      turnsRequested: task.builder!.max_turns,
      turnsUsed: null,
    };
  }

  const taskJsonPath = join(config.workspace_dir, 'TASK.json');
  const outputPath = join(config.workspace_dir, cursor.output_file);

  // Write TASK.json for external driver
  try {
    await writeFile(taskJsonPath, JSON.stringify(task, null, 2), 'utf-8');
  } catch (error) {
    return {
      success: false,
      result: null,
      rawResponse: `Failed to write TASK.json: ${error instanceof Error ? error.message : String(error)}`,
      durationMs: Date.now() - startTime,
      builderOutputValid: false,
      validationErrors: ['Failed to write TASK.json'],
      turnsRequested: task.builder!.max_turns,
      turnsUsed: null,
    };
  }

  // Spawn external driver
  try {
    await execFileAsync(cursor.command, cursor.args, {
      cwd: config.workspace_dir,
      timeout: cursor.timeout_seconds * 1000,
    });
  } catch (error) {
    const err = error as { killed?: boolean; signal?: string; message?: string };
    // Detect timeout: Node kills the process and sets killed=true
    if (err.killed && (err.signal === 'SIGTERM' || err.signal === 'SIGKILL')) {
      return {
        success: false,
        result: null,
        rawResponse: `External driver timed out after ${cursor.timeout_seconds}s`,
        durationMs: Date.now() - startTime,
        builderOutputValid: false,
        validationErrors: ['STOP_BUILDER_TIMEOUT'],
        turnsRequested: task.builder!.max_turns,
        turnsUsed: null,
      };
    }
    // Other spawn errors
    return {
      success: false,
      result: null,
      rawResponse: err.message ?? String(error),
      durationMs: Date.now() - startTime,
      builderOutputValid: false,
      validationErrors: ['External driver failed'],
      turnsRequested: task.builder!.max_turns,
      turnsUsed: null,
    };
  }

  // Read output file
  let rawOutput: string;
  try {
    rawOutput = await readFile(outputPath, 'utf-8');
  } catch (error) {
    return {
      success: false,
      result: null,
      rawResponse: `Failed to read output file: ${error instanceof Error ? error.message : String(error)}`,
      durationMs: Date.now() - startTime,
      builderOutputValid: false,
      validationErrors: ['Output file not found or unreadable'],
      turnsRequested: task.builder!.max_turns,
      turnsUsed: null,
    };
  }

  // Parse JSON
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawOutput);
  } catch (error) {
    return {
      success: false,
      result: null,
      rawResponse: rawOutput,
      durationMs: Date.now() - startTime,
      builderOutputValid: false,
      validationErrors: [`Invalid JSON in output file: ${error instanceof Error ? error.message : String(error)}`],
      turnsRequested: task.builder!.max_turns,
      turnsUsed: null,
    };
  }

  // Validate against builder_result schema
  const schemaPath = join(config.workspace_dir, 'relais/schemas/builder_result.schema.json');
  let schema: object;
  try {
    schema = await loadSchema(schemaPath);
  } catch (error) {
    // Schema loading failure - check shape manually
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      'summary' in parsed &&
      'files_intended' in parsed &&
      'commands_ran' in parsed &&
      'notes' in parsed
    ) {
      return {
        success: true,
        result: parsed as BuilderResult,
        rawResponse: rawOutput,
        durationMs: Date.now() - startTime,
        builderOutputValid: true,
        validationErrors: [],
        turnsRequested: task.builder!.max_turns,
        turnsUsed: null,
      };
    }
    return {
      success: false,
      result: null,
      rawResponse: rawOutput,
      durationMs: Date.now() - startTime,
      builderOutputValid: false,
      validationErrors: ['Schema load failed and output shape invalid'],
      turnsRequested: task.builder!.max_turns,
      turnsUsed: null,
    };
  }

  const validation = validateWithSchema<BuilderResult>(parsed, schema);
  if (!validation.valid) {
    return {
      success: false,
      result: null,
      rawResponse: rawOutput,
      durationMs: Date.now() - startTime,
      builderOutputValid: false,
      validationErrors: validation.errors,
      turnsRequested: task.builder!.max_turns,
      turnsUsed: null,
    };
  }

  return {
    success: true,
    result: validation.data!,
    rawResponse: rawOutput,
    durationMs: Date.now() - startTime,
    builderOutputValid: true,
    validationErrors: [],
    turnsRequested: task.builder!.max_turns,
    turnsUsed: null,
  };
}

/**
 * Runs the builder to execute a task.
 *
 * The builder invokes Claude Code with bypassPermissions mode and restricted tools.
 * Output parsing is lenient by default (strict_builder_json=false), meaning invalid JSON
 * won't cause a failure, but builderOutputValid will be false.
 *
 * @param state - Current tick state (must have a task)
 * @param task - Task to execute
 * @param signal - Optional AbortSignal for cancellation
 * @returns BuilderInvocationResult with result or error
 */
export async function runBuilder(
  state: TickState,
  task: Task,
  signal?: AbortSignal
): Promise<BuilderInvocationResult> {
  const config = state.config;

  // Guard: builder must be present (schema enforces control XOR builder)
  if (!task.builder) {
    return {
      success: false,
      result: null,
      rawResponse: 'Task has no builder configuration',
      durationMs: 0,
      builderOutputValid: false,
      validationErrors: ['STOP_NO_BUILDER'],
      turnsRequested: 0,
      turnsUsed: null,
    };
  }

  if (task.builder.mode === 'patch') {
    return await handlePatchMode(config, task);
  }
  if (task.builder.mode === 'cursor') {
    return await handleCursorMode(config, task);
  }
  const workspaceDir = config.workspace_dir;
  const startTime = Date.now();

  // Validate and clamp max_turns
  const requestedTurns = task.builder.max_turns;
  const maxTurnsLimit = config.builder.claude_code.max_turns;
  const clampedTurns = Math.max(1, Math.min(requestedTurns, maxTurnsLimit));
  
  if (requestedTurns !== clampedTurns) {
    console.warn(
      `Task ${task.task_id}: max_turns ${requestedTurns} clamped to ${clampedTurns} (limit: ${maxTurnsLimit})`
    );
  }

  // Load system prompt
  const systemPromptPath = join(workspaceDir, config.builder.claude_code.system_prompt_file);
  let systemPrompt: string;
  try {
    systemPrompt = await readFile(systemPromptPath, 'utf-8');
  } catch (error) {
    return {
      success: false,
      result: null,
      rawResponse: '',
      durationMs: Date.now() - startTime,
      builderOutputValid: false,
      validationErrors: [],
      turnsRequested: requestedTurns,
      turnsUsed: null,
    };
  }

  // Load builder result schema (cache after first load)
  if (builderResultSchemaCache === null) {
    const schemaPath = join(workspaceDir, config.builder.claude_code.builder_result_schema_file);
    try {
      builderResultSchemaCache = await loadSchema(schemaPath);
    } catch (error) {
      // Schema loading failure is non-fatal if strict_builder_json is false
      // But we still want to try to parse JSON if possible
      console.warn(`Failed to load builder result schema: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const model = config.models.builder_model;
  const timeout = config.runner.max_tick_seconds * 1000; // Convert to milliseconds
  const allowedTools = config.builder.claude_code.allowed_tools;
  const strictBuilderJson = config.builder.claude_code.strict_builder_json;

  // Build user prompt
  let userPrompt: string;
  try {
    userPrompt = await buildBuilderPrompt(config, task);
  } catch (error) {
    return {
      success: false,
      result: null,
      rawResponse: '',
      durationMs: Date.now() - startTime,
      builderOutputValid: false,
      validationErrors: [],
      turnsRequested: requestedTurns,
      turnsUsed: null,
    };
  }

  try {
    const response = await invokeClaudeCode(config.claude_code_cli, {
      prompt: userPrompt,
      maxTurns: clampedTurns,
      permissionMode: config.builder.claude_code.permission_mode as 'bypassPermissions',
      model,
      allowedTools,
      systemPrompt,
      timeout,
      signal,
    });

    // Extract num_turns from raw response if available
    let turnsUsed: number | null = null;
    if (response.raw && typeof response.raw === 'object' && 'num_turns' in response.raw) {
      const numTurns = (response.raw as Record<string, unknown>).num_turns;
      if (typeof numTurns === 'number') {
        turnsUsed = numTurns;
      }
    }

    const durationMs = Date.now() - startTime;

    if (!response.success || !response.result) {
      // Invocation failure
      return {
        success: false,
        result: null,
        rawResponse: response.result || '',
        durationMs,
        builderOutputValid: false,
        validationErrors: [],
        turnsRequested: requestedTurns,
        turnsUsed,
      };
    }

    // Try to parse JSON response
    let parsed: unknown;
    try {
      parsed = JSON.parse(response.result);
    } catch (error) {
      // JSON parse error - lenient mode allows this
      const parseError = error instanceof Error ? error.message : String(error);
      if (strictBuilderJson) {
        return {
          success: false,
          result: null,
          rawResponse: response.result,
          durationMs,
          builderOutputValid: false,
          validationErrors: [`JSON parse error: ${parseError}`],
          turnsRequested: requestedTurns,
          turnsUsed,
        };
      } else {
        // Lenient mode: return success but mark output as invalid
        return {
          success: true,
          result: null,
          rawResponse: response.result,
          durationMs,
          builderOutputValid: false,
          validationErrors: [`JSON parse error: ${parseError}`],
          turnsRequested: requestedTurns,
          turnsUsed,
        };
      }
    }

    // Validate against schema if schema was loaded
    if (builderResultSchemaCache) {
        const validationResult = validateWithSchema<BuilderResult>(parsed, builderResultSchemaCache);
      if (!validationResult.valid) {
        // Schema validation error
        if (strictBuilderJson) {
          return {
            success: false,
            result: null,
            rawResponse: response.result,
            durationMs,
            builderOutputValid: false,
            validationErrors: validationResult.errors,
            turnsRequested: requestedTurns,
            turnsUsed,
          };
        } else {
          // Lenient mode: return success but mark output as invalid
          return {
            success: true,
            result: null,
            rawResponse: response.result,
            durationMs,
            builderOutputValid: false,
            validationErrors: validationResult.errors,
            turnsRequested: requestedTurns,
            turnsUsed,
          };
        }
      }

      // Success with valid JSON
      return {
        success: true,
        result: validationResult.data!,
        rawResponse: response.result,
        durationMs,
        builderOutputValid: true,
        validationErrors: [],
        turnsRequested: requestedTurns,
        turnsUsed,
      };
    } else {
      // Schema not loaded - assume parsed JSON is valid if it has the right shape
      // This is a fallback for when schema loading fails
      if (
        typeof parsed === 'object' &&
        parsed !== null &&
        'summary' in parsed &&
        'files_intended' in parsed &&
        'commands_ran' in parsed &&
        'notes' in parsed
      ) {
        return {
          success: true,
          result: parsed as BuilderResult,
          rawResponse: response.result,
          durationMs,
          builderOutputValid: true,
          validationErrors: [],
          turnsRequested: requestedTurns,
          turnsUsed,
        };
      } else {
        // Invalid shape
        const shapeError = 'Parsed JSON does not match expected BuilderResult shape';
        if (strictBuilderJson) {
          return {
            success: false,
            result: null,
            rawResponse: response.result,
            durationMs,
            builderOutputValid: false,
            validationErrors: [shapeError],
            turnsRequested: requestedTurns,
            turnsUsed,
          };
        } else {
          return {
            success: true,
            result: null,
            rawResponse: response.result,
            durationMs,
            builderOutputValid: false,
            validationErrors: [shapeError],
            turnsRequested: requestedTurns,
            turnsUsed,
          };
        }
      }
    }
  } catch (error) {
    // Re-throw InterruptedError to propagate to tick level
    if (isInterruptedError(error)) {
      throw error;
    }
    // Invocation exception
    return {
      success: false,
      result: null,
      rawResponse: '',
      durationMs: Date.now() - startTime,
      builderOutputValid: false,
      validationErrors: [],
      turnsRequested: requestedTurns,
      turnsUsed: null,
    };
  }
}
