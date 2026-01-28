/**
 * Builder (Hands) implementation.
 *
 * Invokes Claude Code with bypassPermissions mode and restricted tools to execute tasks.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { invokeClaudeCode } from '../lib/claude.js';
import { loadSchema, validateWithSchema } from '../lib/schema.js';
import type { RelaisConfig } from '../types/config.js';
import type { TickState } from '../types/state.js';
import type { Task } from '../types/task.js';
import type { BuilderResult } from '../types/builder.js';

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
 * Runs the builder to execute a task.
 *
 * The builder invokes Claude Code with bypassPermissions mode and restricted tools.
 * Output parsing is lenient by default (strict_builder_json=false), meaning invalid JSON
 * won't cause a failure, but builderOutputValid will be false.
 *
 * @param state - Current tick state (must have a task)
 * @param task - Task to execute
 * @returns BuilderInvocationResult with result or error
 */
export async function runBuilder(
  state: TickState,
  task: Task
): Promise<BuilderInvocationResult> {
  const config = state.config;
  const workspaceDir = config.workspace_dir;
  const startTime = Date.now();

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
    };
  }

  try {
    const response = await invokeClaudeCode(config.claude_code_cli, {
      prompt: userPrompt,
      maxTurns: task.builder.max_turns,
      permissionMode: config.builder.claude_code.permission_mode as 'bypassPermissions',
      model,
      allowedTools,
      systemPrompt,
      timeout,
    });

    const durationMs = Date.now() - startTime;

    if (!response.success || !response.result) {
      // Invocation failure
      return {
        success: false,
        result: null,
        rawResponse: response.result || '',
        durationMs,
        builderOutputValid: false,
      };
    }

    // Try to parse JSON response
    let parsed: unknown;
    try {
      parsed = JSON.parse(response.result);
    } catch (error) {
      // JSON parse error - lenient mode allows this
      if (strictBuilderJson) {
        return {
          success: false,
          result: null,
          rawResponse: response.result,
          durationMs,
          builderOutputValid: false,
        };
      } else {
        // Lenient mode: return success but mark output as invalid
        return {
          success: true,
          result: null,
          rawResponse: response.result,
          durationMs,
          builderOutputValid: false,
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
          };
        } else {
          // Lenient mode: return success but mark output as invalid
          return {
            success: true,
            result: null,
            rawResponse: response.result,
            durationMs,
            builderOutputValid: false,
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
        };
      } else {
        // Invalid shape
        if (strictBuilderJson) {
          return {
            success: false,
            result: null,
            rawResponse: response.result,
            durationMs,
            builderOutputValid: false,
          };
        } else {
          return {
            success: true,
            result: null,
            rawResponse: response.result,
            durationMs,
            builderOutputValid: false,
          };
        }
      }
    }
  } catch (error) {
    // Invocation exception
    return {
      success: false,
      result: null,
      rawResponse: '',
      durationMs: Date.now() - startTime,
      builderOutputValid: false,
    };
  }
}
