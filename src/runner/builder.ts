/**
 * Builder (Hands) implementation.
 *
 * Invokes Claude Code with bypassPermissions mode and restricted tools to execute tasks.
 */

import { lstat, readFile, writeFile, mkdir, unlink, access } from 'node:fs/promises';
import { join, resolve, relative } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { constants } from 'node:fs';

const execFileAsync = promisify(execFile);
import { invokeClaudeCode } from '../lib/claude.js';
import { matchesGlob } from '../lib/scope.js';
import { loadSchema, validateWithSchema } from '../lib/schema.js';
import type { EnvoiConfig } from '../types/config.js';
import type { TickState } from '../types/state.js';
import type { Task } from '../types/task.js';
import type { BuilderResult, BuilderResultCode } from '../types/builder.js';
import { isInterruptedError } from '../types/claude.js';
import type { ClaudeTokenUsage } from '../types/claude.js';
import { parseBuilderResultRaw, type BuilderParseErrorKind } from './builder_parse.js';
import { resolveInWorkspace } from '../lib/paths.js';
import { resolveBuilderPermissionMode } from '../lib/autonomy.js';
import { evaluateCommandPolicy, formatPolicyForPrompt } from '../lib/command_policy.js';

function isDebugEnabled(): boolean {
  return process.env.ENVOI_DEBUG === '1';
}

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
  /** Parse error kind for granular STOP code mapping */
  parseErrorKind?: BuilderParseErrorKind | 'cli_error';
  /** Optional token usage telemetry from CLI output */
  tokenUsage?: ClaudeTokenUsage | null;
}

/**
 * Builds the builder user prompt by loading the template and interpolating placeholders.
 *
 * @param config - Envoi configuration
 * @param task - Task to execute
 * @returns The interpolated user prompt
 */
export async function buildBuilderPrompt(
  config: EnvoiConfig,
  task: Task
): Promise<string> {
  const workspaceDir = config.workspace_dir;
  const userPromptPath = resolveInWorkspace(workspaceDir, config.builder.claude_code.user_prompt_file);

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
    '{{TASK_JSON}}': JSON.stringify(task),
    '{{ALLOWED_GLOBS}}': task.scope.allowed_globs.join(', '),
    '{{FORBIDDEN_GLOBS}}': task.scope.forbidden_globs.join(', '),
    '{{ALLOW_NEW_FILES}}': task.scope.allow_new_files ? 'true' : 'false',
    '{{ALLOW_LOCKFILE_CHANGES}}': task.scope.allow_lockfile_changes ? 'true' : 'false',
    '{{MAX_FILES_TOUCHED}}': task.diff_limits.max_files_touched.toString(),
    '{{MAX_LINES_CHANGED}}': task.diff_limits.max_lines_changed.toString(),
    '{{AUTONOMY_POLICY}}': formatPolicyForPrompt(config),
  };

  let prompt = template;
  for (const [placeholder, value] of Object.entries(replacements)) {
    prompt = prompt.replace(new RegExp(placeholder.replace(/[{}]/g, '\\$&'), 'g'), value);
  }

  if (!template.includes('{{AUTONOMY_POLICY}}')) {
    prompt += `\n\nAutonomy policy:\n${replacements['{{AUTONOMY_POLICY}}']}`;
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
  config: EnvoiConfig,
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
 * Checks if a command exists and is executable by searching PATH.
 * Does not use shell - manually searches PATH environment variable.
 *
 * @param command - Command name to search for
 * @returns Path to executable if found, null otherwise
 */
async function findCommandInPath(command: string): Promise<string | null> {
  // If command contains a path separator, treat it as an absolute or relative path
  if (command.includes('/') || (process.platform === 'win32' && command.includes('\\'))) {
    try {
      await access(command, constants.F_OK | constants.X_OK);
      return command;
    } catch {
      return null;
    }
  }

  // Search PATH
  const pathEnv = process.env.PATH || '';
  const pathDirs = pathEnv.split(process.platform === 'win32' ? ';' : ':');

  for (const dir of pathDirs) {
    if (!dir) continue;
    const fullPath = join(dir, command);
    try {
      await access(fullPath, constants.F_OK | constants.X_OK);
      return fullPath;
    } catch {
      // Continue searching
    }
  }

  return null;
}

/**
 * Validates that a path is a safe relative path under workspace_dir.
 * Rejects absolute paths, paths with '..', and paths that resolve outside workspace.
 *
 * @param path - Path to validate
 * @param workspaceDir - Workspace directory
 * @returns Validation result with reason if invalid
 */
function validateOutputFilePath(path: string, workspaceDir: string): { valid: boolean; reason?: string } {
  if (path.includes('\0')) {
    return { valid: false, reason: 'Path contains null byte' };
  }
  if (path.startsWith('/') || (process.platform === 'win32' && /^[A-Za-z]:/.test(path))) {
    return { valid: false, reason: 'Absolute path not allowed' };
  }
  if (path.includes('..')) {
    return { valid: false, reason: 'Parent directory traversal (..) not allowed' };
  }
  const resolved = resolve(workspaceDir, path);
  const rel = relative(workspaceDir, resolved);
  if (rel.startsWith('..') || rel.startsWith('/')) {
    return { valid: false, reason: 'Path resolves outside workspace directory' };
  }
  return { valid: true };
}

/**
 * Handles cursor builder mode.
 *
 * Delegates build to an external process (e.g., Cursor IDE).
 * Writes TASK.json to workspace, spawns the external driver,
 * waits for completion, then reads and validates the result file.
 *
 * Preflight checks:
 * - Validates cursor.output_file is a safe relative path
 * - Verifies cursor.command exists and is executable
 *
 * @see docs/NEW-PLAN.md PR5
 */
async function handleCursorMode(
  config: EnvoiConfig,
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

  // Preflight: Validate output_file path safety
  const outputFileValidation = validateOutputFilePath(cursor.output_file, config.workspace_dir);
  if (!outputFileValidation.valid) {
    return {
      success: false,
      result: null,
      rawResponse: `Invalid output_file path '${cursor.output_file}': ${outputFileValidation.reason}. ` +
        `Output file must be a safe relative path under workspace directory (no absolute paths, no '..').`,
      durationMs: Date.now() - startTime,
      builderOutputValid: false,
      validationErrors: ['STOP_BUILDER_CLI_ERROR'],
      turnsRequested: task.builder!.max_turns,
      turnsUsed: null,
      parseErrorKind: 'cli_error',
    };
  }

  // Preflight: Verify command exists and is executable
  const policyDecision = evaluateCommandPolicy(config, cursor.command, cursor.args);
  if (policyDecision.decision === 'deny') {
    return {
      success: false,
      result: null,
      rawResponse: `Command policy denied cursor driver invocation: ${policyDecision.reason}`,
      durationMs: Date.now() - startTime,
      builderOutputValid: false,
      validationErrors: ['STOP_BUILDER_CLI_ERROR'],
      turnsRequested: task.builder!.max_turns,
      turnsUsed: null,
      parseErrorKind: 'cli_error',
    };
  }
  const commandPath = await findCommandInPath(cursor.command);
  if (!commandPath) {
    return {
      success: false,
      result: null,
      rawResponse: `Command '${cursor.command}' not found or not executable. ` +
        `Please install the driver or update config.builder.cursor.command in envoi.config.json.`,
      durationMs: Date.now() - startTime,
      builderOutputValid: false,
      validationErrors: ['BLOCKED_BUILDER_COMMAND_NOT_FOUND'],
      turnsRequested: task.builder!.max_turns,
      turnsUsed: null,
    };
  }

  const taskJsonPath = join(config.workspace_dir, 'TASK.json');
  const outputPath = resolveInWorkspace(config.workspace_dir, cursor.output_file);
  const schemaPath = resolveInWorkspace(
    config.workspace_dir,
    config.builder.claude_code.builder_result_schema_file
  );
  const driverKind = cursor.driver_kind ?? 'external';
  const builderContractEnv: NodeJS.ProcessEnv = {
    ...process.env,
    ENVOI_BUILDER_PROTOCOL: 'v2_machine',
    ENVOI_DRIVER_KIND: driverKind,
    ENVOI_WORKSPACE_DIR: config.workspace_dir,
    ENVOI_TASK_PATH: taskJsonPath,
    ENVOI_OUTPUT_PATH: outputPath,
    ENVOI_SCHEMA_PATH: schemaPath,
  };

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
      validationErrors: ['STOP_BUILDER_CLI_ERROR'],
      turnsRequested: task.builder!.max_turns,
      turnsUsed: null,
      parseErrorKind: 'cli_error',
    };
  }

  // Spawn external driver
  try {
    const args = [...cursor.args];
    if (cursor.driver_kind === 'cursor_agent') {
      const agentPrompt = [
        'ENVOI_BUILDER_PROTOCOL=v2_machine',
        `TASK_PATH=${taskJsonPath}`,
        `OUTPUT_PATH=${outputPath}`,
        `SCHEMA_PATH=${schemaPath}`,
        'OUTPUT_KEYS=summary,files_intended,commands_ran,notes',
        'SINGLE_PASS=1',
        'NO_QUESTIONS=1',
        'Write exactly one JSON object to OUTPUT_PATH, then exit.',
      ].join('\n');
      console.log('[BUILD] Builder protocol: v2_machine');
      args.push(agentPrompt);
    }

    await execFileAsync(commandPath, args, {
      // Run from repo root (the CLI chdirToRepoRoot() ensures this in real usage).
      cwd: process.cwd(),
      timeout: cursor.timeout_seconds * 1000,
      env: builderContractEnv,
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
        parseErrorKind: 'cli_error',
      };
    }
    // Other spawn errors
    return {
      success: false,
      result: null,
      rawResponse: err.message ?? String(error),
      durationMs: Date.now() - startTime,
      builderOutputValid: false,
      validationErrors: ['STOP_BUILDER_CLI_ERROR'],
      turnsRequested: task.builder!.max_turns,
      turnsUsed: null,
      parseErrorKind: 'cli_error',
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
      validationErrors: ['STOP_BUILDER_CLI_ERROR'],
      turnsRequested: task.builder!.max_turns,
      turnsUsed: null,
      parseErrorKind: 'cli_error',
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
      validationErrors: ['STOP_BUILDER_JSON_PARSE'],
      turnsRequested: task.builder!.max_turns,
      turnsUsed: null,
      parseErrorKind: 'json_parse',
    };
  }

  // Validate against builder_result schema
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
      validationErrors: ['STOP_BUILDER_SHAPE_INVALID'],
      turnsRequested: task.builder!.max_turns,
      turnsUsed: null,
      parseErrorKind: 'shape',
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
      validationErrors: ['STOP_BUILDER_SCHEMA_INVALID'],
      turnsRequested: task.builder!.max_turns,
      turnsUsed: null,
      parseErrorKind: 'schema',
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
  const systemPromptPath = resolveInWorkspace(workspaceDir, config.builder.claude_code.system_prompt_file);
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
    const schemaPath = resolveInWorkspace(workspaceDir, config.builder.claude_code.builder_result_schema_file);
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
      permissionMode: resolveBuilderPermissionMode(config),
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
      // Invocation failure - extract subtype for better error classification
      const rawObj = response.raw as Record<string, unknown> | undefined;
      const subtype = typeof rawObj?.subtype === 'string' ? rawObj.subtype : '';
      const errorInfo = subtype ? `CLI error: ${subtype}` : (response.result || 'Unknown error');

      return {
        success: false,
        result: null,
        rawResponse: errorInfo,
        durationMs,
        builderOutputValid: false,
        validationErrors: subtype ? [`STOP_BUILDER_${subtype.toUpperCase()}`] : [],
        turnsRequested: requestedTurns,
        turnsUsed,
        parseErrorKind: 'cli_error',
        tokenUsage: response.tokenUsage ?? null,
      };
    }

    // Parse and validate builder output using pure parser
    if (isDebugEnabled()) {
      console.log(`[BUILDER_DEBUG] Raw response (first 500 chars): ${response.result.substring(0, 500)}`);
    }

    const parseResult = parseBuilderResultRaw(
      response.result,
      builderResultSchemaCache ?? undefined
    );

    if (parseResult.ok) {
      // Success with valid JSON
      return {
        success: true,
        result: parseResult.value,
        rawResponse: response.result,
        durationMs,
        builderOutputValid: true,
        validationErrors: [],
        turnsRequested: requestedTurns,
        turnsUsed,
        tokenUsage: response.tokenUsage ?? null,
      };
    }

    // Parse failed - handle based on strictBuilderJson and task_kind
    // Question tasks must fail-closed on invalid output
    const mustFailClosed = strictBuilderJson || task.task_kind === 'question';

    if (mustFailClosed) {
      return {
        success: false,
        result: null,
        rawResponse: response.result,
        durationMs,
        builderOutputValid: false,
        validationErrors: [parseResult.message],
        turnsRequested: requestedTurns,
        turnsUsed,
        parseErrorKind: parseResult.kind,
        tokenUsage: response.tokenUsage ?? null,
      };
    }

    // Lenient mode: return success but mark output as invalid
    return {
      success: true,
      result: null,
      rawResponse: response.result,
      durationMs,
      builderOutputValid: false,
      validationErrors: [parseResult.message],
      turnsRequested: requestedTurns,
      turnsUsed,
      parseErrorKind: parseResult.kind,
      tokenUsage: response.tokenUsage ?? null,
    };
  } catch (error) {
    // Re-throw InterruptedError to propagate to tick level
    if (isInterruptedError(error)) {
      throw error;
    }

    // Debug logging gated by ENVOI_DEBUG
    if (isDebugEnabled()) {
      console.log(`[BUILDER_DEBUG] Exception: ${error instanceof Error ? error.message : String(error)}`);
    }

    // Capture error message in rawResponse for proper classification
    const errorMessage = error instanceof Error ? error.message : String(error);

    return {
      success: false,
      result: null,
      rawResponse: `Builder invocation error: ${errorMessage}`,
      durationMs: Date.now() - startTime,
      builderOutputValid: false,
      validationErrors: [],
      turnsRequested: requestedTurns,
      turnsUsed: null,
    };
  }
}
