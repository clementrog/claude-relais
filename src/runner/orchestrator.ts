/**
 * Orchestrator (Brain) implementation.
 *
 * Invokes Claude Code in plan mode to propose the next task.
 */

import { readFile } from 'node:fs/promises';
import { readFileSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join } from 'node:path';
import { invokeClaudeCode } from '../lib/claude.js';
import { loadSchema, validateWithSchema, type RawAjvError } from '../lib/schema.js';
import { readWorkspaceState } from '../lib/workspace_state.js';
import type { RelaisConfig } from '../types/config.js';
import type { TickState } from '../types/state.js';
import type { Task } from '../types/task.js';
import { isInterruptedError } from '../types/claude.js';

/**
 * Diagnostics for orchestrator failures.
 */
export interface OrchestratorDiagnosticsResult {
  /** Raw AJV schema errors */
  schemaErrors?: RawAjvError[];
  /** How JSON was extracted */
  extractMethod?: string;
  /** Extracted JSON candidate before validation */
  extractedJson?: unknown;
}

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
  /** Raw stderr from Claude Code */
  rawStderr: string;
  /** Number of orchestrator calls made (1 or 2) */
  attempts: number;
  /** The error that triggered retry (null if no retry or successful) */
  retryReason: string | null;
  /** Diagnostics for debugging failures */
  diagnostics?: OrchestratorDiagnosticsResult;
}

/**
 * Builds the orchestrator user prompt by loading the template and interpolating placeholders.
 *
 * @param config - Relais configuration
 * @param state - Current tick state
 * @param retryReason - Optional error reason for retry attempts
 * @returns The interpolated user prompt
 */
export async function buildOrchestratorPrompt(
  config: RelaisConfig,
  state: TickState,
  retryReason?: string | null
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

  // Get git status (tiny, shows uncommitted changes)
  let gitStatus = '';
  try {
    gitStatus = execSync('git status --porcelain', {
      encoding: 'utf-8',
      maxBuffer: 10000,
      cwd: workspaceDir,
    }).trim();
  } catch {
    gitStatus = '(git status unavailable)';
  }

  // Read FACTS.md if exists
  const factsPath = join(workspaceDir, 'relais/FACTS.md');
  const facts = existsSync(factsPath) ? readFileSync(factsPath, 'utf-8') : '';

  // Read REPORT.md if exists (last report)
  const reportPath = join(workspaceDir, 'REPORT.md');
  const lastReport = existsSync(reportPath) ? readFileSync(reportPath, 'utf-8') : '';

  // Read STATE.json for milestone and budget summary
  let milestoneId = 'none';
  let budgetSummary = 'Budgets: (unavailable)';
  try {
    const wsState = await readWorkspaceState(workspaceDir);
    milestoneId = wsState.milestone_id || 'none';
    budgetSummary = `Milestone: ${milestoneId}, Ticks: ${wsState.budgets.ticks}, Orchestrator: ${wsState.budgets.orchestrator_calls}, Builder: ${wsState.budgets.builder_calls}, Verify: ${wsState.budgets.verify_runs}`;
  } catch {
    // STATE.json may not exist yet
  }

  // Interpolate placeholders with real values
  const replacements: Record<string, string> = {
    '{{PROJECT_GOAL}}': '[See FACTS.md for project context]',
    '{{MILESTONE_ID}}': milestoneId,
    '{{BUDGETS_SUMMARY}}': budgetSummary,
    '{{VERIFY_TEMPLATE_IDS}}': config.verification.templates.map((t) => t.id).join(', ') || '[No templates]',
    '{{REPO_SUMMARY}}': gitStatus || '(clean)',
    '{{FACTS_MD}}': facts,
    '{{LAST_REPORT_MD}}': lastReport,
    '{{BLOCKED_JSON_OR_EMPTY}}': '',
  };

  let prompt = template;
  for (const [placeholder, value] of Object.entries(replacements)) {
    prompt = prompt.replace(new RegExp(placeholder.replace(/[{}]/g, '\\$&'), 'g'), value);
  }

  // Append retry reason if this is a retry attempt
  if (retryReason) {
    prompt += `\n\n=== RETRY ===\nYour previous output was invalid: ${retryReason}\nPlease output ONLY valid JSON matching the schema.`;
  }

  return prompt;
}

// Cache for loaded task schema
let taskSchemaCache: object | null = null;

/**
 * Runs the orchestrator to propose the next task.
 *
 * Implements retry logic: if the first attempt fails due to invalid JSON or schema
 * validation, retries once with the error reason appended to the prompt.
 *
 * @param state - Current tick state
 * @param signal - Optional AbortSignal for cancellation
 * @returns OrchestratorResult with task or error
 */
export async function runOrchestrator(
  state: TickState,
  signal?: AbortSignal
): Promise<OrchestratorResult> {
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
      rawStderr: '',
      attempts: 0,
      retryReason: null,
    };
  }

  // Load task schema (cache after first load)
  if (taskSchemaCache === null) {
    const schemaPath = join(workspaceDir, config.orchestrator.task_schema_file);
    try {
      taskSchemaCache = await loadSchema(schemaPath);
    } catch (error) {
      return {
        success: false,
        task: null,
        error: `Failed to load task schema: ${error instanceof Error ? error.message : String(error)}`,
        rawResponse: '',
        rawStderr: '',
        attempts: 0,
        retryReason: null,
      };
    }
  }

  const model = config.models.orchestrator_model;
  const timeout = config.runner.max_tick_seconds * 1000; // Convert to milliseconds

  // First attempt
  let retryReason: string | null = null;
  let attempts = 0;

  for (let attempt = 0; attempt < 2; attempt++) {
    attempts++;
    
    // Build user prompt (with retry reason if this is the second attempt)
    let userPrompt: string;
    try {
      userPrompt = await buildOrchestratorPrompt(config, state, retryReason);
    } catch (error) {
      return {
        success: false,
        task: null,
        error: `Failed to build orchestrator prompt: ${error instanceof Error ? error.message : String(error)}`,
        rawResponse: '',
        rawStderr: '',
        attempts,
        retryReason,
      };
    }

    try {
      const response = await invokeClaudeCode(config.claude_code_cli, {
        prompt: userPrompt,
        maxTurns: config.orchestrator.max_turns,
        permissionMode: config.orchestrator.permission_mode as 'plan' | 'bypassPermissions',
        model,
        systemPrompt,
        timeout,
        signal,
      });

      if (!response.success || !response.result) {
        // Non-retryable error (invocation failure)
        return {
          success: false,
          task: null,
          error: `Claude Code invocation failed with exit code ${response.exitCode}`,
          rawResponse: response.result || '',
          rawStderr: response.stderr,
          attempts,
          retryReason,
        };
      }

      // Parse JSON response
      let parsed: unknown;
      try {
        const raw = response.result.trim();
        const unfenced = raw.startsWith("```")
          ? raw.replace(/^```[a-zA-Z0-9_-]*\s*\n?/, "").replace(/```[\s]*$/, "").trim()
          : raw;
        parsed = JSON.parse(unfenced);
      } catch (error) {
        // JSON parse error - retryable
        retryReason = `Failed to parse orchestrator output as JSON: ${error instanceof Error ? error.message : String(error)}`;
        console.log(`[ORCHESTRATOR] Attempt ${attempts} failed: ${retryReason}`);
        if (attempt === 0) {
          // Retry once
          continue;
        } else {
          // Second attempt also failed - include diagnostics
          return {
            success: false,
            task: null,
            error: retryReason,
            rawResponse: response.result,
            rawStderr: response.stderr,
            attempts,
            retryReason,
            diagnostics: {
              extractMethod: 'direct_parse',
            },
          };
        }
      }

      // Validate task structure against schema
      const validationResult = validateWithSchema<Task>(parsed, taskSchemaCache!);
      if (!validationResult.valid) {
        // Schema validation error - retryable
        const errorMessages = validationResult.errors.length > 0
          ? validationResult.errors.join('; ')
          : 'Orchestrator output does not match task schema';
        retryReason = `Task validation failed: ${errorMessages}`;
        console.log(`[ORCHESTRATOR] Attempt ${attempts} failed: ${retryReason}`);
        if (attempt === 0) {
          // Retry once
          continue;
        } else {
          // Second attempt also failed - include diagnostics
          return {
            success: false,
            task: null,
            error: retryReason,
            rawResponse: response.result,
            rawStderr: response.stderr,
            attempts,
            retryReason,
            diagnostics: {
              schemaErrors: validationResult.rawErrors,
              extractMethod: 'direct_parse',
              extractedJson: parsed,
            },
          };
        }
      }

      // Success!
      return {
        success: true,
        task: validationResult.data!,
        error: null,
        rawResponse: response.result,
        rawStderr: response.stderr,
        attempts,
        retryReason: attempt === 1 ? retryReason : null,
      };
    } catch (error) {
      // Re-throw InterruptedError to propagate to tick level
      if (isInterruptedError(error)) {
        throw error;
      }
      // Non-retryable error (invocation exception)
      return {
        success: false,
        task: null,
        error: `Claude Code invocation error: ${error instanceof Error ? error.message : String(error)}`,
        rawResponse: '',
        rawStderr: '',
        attempts,
        retryReason,
      };
    }
  }

  // Should never reach here, but TypeScript needs this
  return {
    success: false,
    task: null,
    error: 'Unexpected error in orchestrator retry logic',
    rawResponse: '',
    rawStderr: '',
    attempts,
    retryReason,
  };
}
