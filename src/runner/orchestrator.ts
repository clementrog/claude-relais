/**
 * Orchestrator (Brain) implementation.
 *
 * Invokes Claude Code in plan mode to propose the next task.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { invokeClaudeCode } from '../lib/claude.js';
import type { RelaisConfig } from '../types/config.js';
import type { TickState } from '../types/state.js';
import type { Task } from '../types/task.js';

/**
 * Result of orchestrator invocation.
 */
export interface OrchestratorResult {
  /** Whether the invocation was successful */
  success: boolean;
  /** The parsed task (null if unsuccessful) */
  task: Task | null;
  /** Error message (null if successful) */
  error: string | null;
  /** Raw response from Claude Code */
  rawResponse: string;
}

/**
 * Builds the orchestrator user prompt by loading the template and interpolating placeholders.
 *
 * @param config - Relais configuration
 * @param state - Current tick state
 * @returns The interpolated user prompt
 */
export async function buildOrchestratorPrompt(
  config: RelaisConfig,
  state: TickState
): Promise<string> {
  const workspaceDir = config.workspace_dir;
  const userPromptPath = join(workspaceDir, config.orchestrator.user_prompt_file);

  // Load user prompt template
  let template: string;
  try {
    template = await readFile(userPromptPath, 'utf-8');
  } catch (error) {
    throw new Error(
      `Failed to read orchestrator user prompt template from ${userPromptPath}: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  // Interpolate placeholders
  // For now, use placeholder values as noted in the task requirements
  const replacements: Record<string, string> = {
    '{{PROJECT_GOAL}}': '[Placeholder: Project goal]',
    '{{MILESTONE_ID}}': '[Placeholder: Milestone ID]',
    '{{BUDGETS_SUMMARY}}': '[Placeholder: Budgets summary]',
    '{{VERIFY_TEMPLATE_IDS}}': config.verification.templates.map((t) => t.id).join(', ') || '[No templates]',
    '{{REPO_SUMMARY}}': '[Placeholder: Repo summary]',
    '{{FACTS_MD}}': '[Placeholder: Facts markdown]',
    '{{LAST_REPORT_MD}}': '[Placeholder: Last report markdown]',
    '{{BLOCKED_JSON_OR_EMPTY}}': '',
  };

  let prompt = template;
  for (const [placeholder, value] of Object.entries(replacements)) {
    prompt = prompt.replace(new RegExp(placeholder.replace(/[{}]/g, '\\$&'), 'g'), value);
  }

  return prompt;
}

/**
 * Validates a task object against the task schema (basic validation).
 *
 * @param obj - Object to validate
 * @returns True if the object appears to be a valid Task
 */
function validateTask(obj: unknown): obj is Task {
  if (typeof obj !== 'object' || obj === null) {
    return false;
  }

  const task = obj as Record<string, unknown>;

  // Check required fields
  if (typeof task.task_id !== 'string' || task.task_id.length === 0) return false;
  if (typeof task.milestone_id !== 'string' || task.milestone_id.length === 0) return false;
  if (task.task_kind !== 'execute' && task.task_kind !== 'verify_only' && task.task_kind !== 'question') {
    return false;
  }
  if (typeof task.intent !== 'string' || task.intent.length === 0) return false;

  // Check scope
  if (typeof task.scope !== 'object' || task.scope === null) return false;
  const scope = task.scope as Record<string, unknown>;
  if (!Array.isArray(scope.allowed_globs)) return false;
  if (!Array.isArray(scope.forbidden_globs)) return false;
  if (typeof scope.allow_new_files !== 'boolean') return false;
  if (typeof scope.allow_lockfile_changes !== 'boolean') return false;

  // Check diff_limits
  if (typeof task.diff_limits !== 'object' || task.diff_limits === null) return false;
  const diffLimits = task.diff_limits as Record<string, unknown>;
  if (typeof diffLimits.max_files_touched !== 'number') return false;
  if (typeof diffLimits.max_lines_changed !== 'number') return false;

  // Check verification
  if (typeof task.verification !== 'object' || task.verification === null) return false;
  const verification = task.verification as Record<string, unknown>;
  if (!Array.isArray(verification.fast)) return false;
  if (!Array.isArray(verification.slow)) return false;

  // Check builder
  if (typeof task.builder !== 'object' || task.builder === null) return false;
  const builder = task.builder as Record<string, unknown>;
  if (builder.mode !== 'claude_code' && builder.mode !== 'patch') return false;
  if (typeof builder.max_turns !== 'number') return false;
  if (typeof builder.instructions !== 'string' || builder.instructions.length === 0) return false;

  // Check question (required if task_kind is 'question')
  if (task.task_kind === 'question') {
    if (typeof task.question !== 'object' || task.question === null) return false;
    const question = task.question as Record<string, unknown>;
    if (typeof question.prompt !== 'string' || question.prompt.length === 0) return false;
  }

  return true;
}

/**
 * Runs the orchestrator to propose the next task.
 *
 * @param state - Current tick state
 * @returns OrchestratorResult with task or error
 */
export async function runOrchestrator(state: TickState): Promise<OrchestratorResult> {
  const config = state.config;
  const workspaceDir = config.workspace_dir;

  // Load system prompt
  const systemPromptPath = join(workspaceDir, config.orchestrator.system_prompt_file);
  let systemPrompt: string;
  try {
    systemPrompt = await readFile(systemPromptPath, 'utf-8');
  } catch (error) {
    return {
      success: false,
      task: null,
      error: `Failed to read orchestrator system prompt from ${systemPromptPath}: ${error instanceof Error ? error.message : String(error)}`,
      rawResponse: '',
    };
  }

  // Build user prompt
  let userPrompt: string;
  try {
    userPrompt = await buildOrchestratorPrompt(config, state);
  } catch (error) {
    return {
      success: false,
      task: null,
      error: `Failed to build orchestrator prompt: ${error instanceof Error ? error.message : String(error)}`,
      rawResponse: '',
    };
  }

  // Invoke Claude Code
  const model = config.models.orchestrator_model;
  const timeout = config.runner.max_tick_seconds * 1000; // Convert to milliseconds

  try {
    const response = await invokeClaudeCode(config.claude_code_cli, {
      prompt: userPrompt,
      maxTurns: config.orchestrator.max_turns,
      permissionMode: config.orchestrator.permission_mode as 'plan' | 'bypassPermissions',
      model,
      systemPrompt,
      timeout,
    });

    if (!response.success || !response.result) {
      return {
        success: false,
        task: null,
        error: `Claude Code invocation failed with exit code ${response.exitCode}`,
        rawResponse: response.result || '',
      };
    }

    // Parse JSON response
    let parsed: unknown;
    try {
      parsed = JSON.parse(response.result);
    } catch (error) {
      return {
        success: false,
        task: null,
        error: `Failed to parse orchestrator output as JSON: ${error instanceof Error ? error.message : String(error)}`,
        rawResponse: response.result,
      };
    }

    // Validate task structure
    if (!validateTask(parsed)) {
      return {
        success: false,
        task: null,
        error: 'Orchestrator output does not match task schema (missing or invalid required fields)',
        rawResponse: response.result,
      };
    }

    return {
      success: true,
      task: parsed as Task,
      error: null,
      rawResponse: response.result,
    };
  } catch (error) {
    return {
      success: false,
      task: null,
      error: `Claude Code invocation error: ${error instanceof Error ? error.message : String(error)}`,
      rawResponse: '',
    };
  }
}
