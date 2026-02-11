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
import { invokeReviewer } from '../lib/reviewer.js';
import { loadSchema, validateWithSchema, type RawAjvError } from '../lib/schema.js';
import { readWorkspaceState } from '../lib/workspace_state.js';
import { truncatePromptSection } from '../lib/prompt_budget.js';
import { resolveOrchestratorPermissionMode } from '../lib/autonomy.js';
import { formatPolicyForPrompt } from '../lib/command_policy.js';
import type { EnvoiConfig } from '../types/config.js';
import type { TickState } from '../types/state.js';
import type { Task } from '../types/task.js';
import { isInterruptedError, isTimeoutError } from '../types/claude.js';
import type { ClaudeTokenUsage } from '../types/claude.js';
import { resolveInWorkspace } from '../lib/paths.js';

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
  /** Raw model output from Claude Code (the CLI wrapper's `.result` field). */
  rawResponse: string;
  /** Raw stderr from Claude Code */
  rawStderr: string;
  /** Raw CLI wrapper JSON (stringified) for debugging when `.result` is missing/empty. */
  rawCliStdout?: string;
  /** Number of orchestrator calls made (1 or 2) */
  attempts: number;
  /** The error that triggered retry (null if no retry or successful) */
  retryReason: string | null;
  /** Diagnostics for debugging failures */
  diagnostics?: OrchestratorDiagnosticsResult;
  /** Optional token usage telemetry from CLI output */
  tokenUsage?: ClaudeTokenUsage | null;
}

const ORCHESTRATOR_PROMPT_CAPS = {
  gitStatusChars: 2000,
  factsChars: 7000,
  prdChars: 14000,
  roadmapChars: 8000,
  lastReportChars: 6000,
  pendingIdeasChars: 3000,
  planningDigestChars: 2000,
  openQuestionsChars: 2500,
} as const;

function safeStringifyCliJson(raw: unknown): string {
  if (typeof raw !== 'object' || raw === null) return '';
  try {
    return JSON.stringify(raw, null, 2);
  } catch {
    return '';
  }
}

interface PlannerInvocationResult {
  success: boolean;
  rawResponse: string;
  rawStderr: string;
  rawCliStdout?: string;
  parsedObject?: unknown;
  tokenUsage?: ClaudeTokenUsage | null;
  error?: string;
}

async function invokePlanner(
  config: EnvoiConfig,
  provider: 'claude_code' | 'chatgpt',
  model: string,
  userPrompt: string,
  systemPrompt: string,
  timeout: number,
  signal?: AbortSignal
): Promise<PlannerInvocationResult> {
  if (provider === 'chatgpt') {
    const response = await invokeReviewer(
      {
        command: 'codex',
        model,
        maxTurns: config.orchestrator.max_turns,
        timeout,
      },
      {
        prompt: userPrompt,
        systemPrompt,
      }
    );
    if (!response.success) {
      return {
        success: false,
        rawResponse: '',
        rawStderr: response.stderr ?? '',
        error: response.error,
      };
    }
    const rawCliStdout = safeStringifyCliJson((response as any).raw);
    return {
      success: true,
      rawResponse: rawCliStdout || JSON.stringify(response.result),
      rawStderr: '',
      rawCliStdout: rawCliStdout || undefined,
      parsedObject: response.result,
      tokenUsage: null,
    };
  }

  const response = await invokeClaudeCode(config.claude_code_cli, {
    prompt: userPrompt,
    maxTurns: config.orchestrator.max_turns,
    permissionMode: resolveOrchestratorPermissionMode(config),
    model,
    systemPrompt,
    timeout,
    signal,
  });
  const rawObj: unknown = (response as any).raw;
  const rawCliStdout = safeStringifyCliJson(rawObj);
  const cliSubtype =
    typeof (rawObj as any)?.subtype === 'string' ? String((rawObj as any).subtype) : null;
  const hasResultField = Object.prototype.hasOwnProperty.call((rawObj as any) ?? {}, 'result');
  const modelOutput = response.result ?? '';

  if (!response.success) {
    return {
      success: false,
      rawResponse: modelOutput,
      rawStderr: response.stderr,
      rawCliStdout: rawCliStdout || undefined,
      tokenUsage: response.tokenUsage ?? null,
      error:
        `Claude Code invocation failed (exit code ${response.exitCode})` +
        (cliSubtype ? `, subtype=${cliSubtype}` : '') +
        (!hasResultField ? ', missing result field' : ''),
    };
  }

  if (modelOutput.trim().length === 0) {
    return {
      success: false,
      rawResponse: modelOutput,
      rawStderr: response.stderr,
      rawCliStdout: rawCliStdout || undefined,
      tokenUsage: response.tokenUsage ?? null,
      error:
        `Claude Code returned empty output (exit code ${response.exitCode})` +
        (cliSubtype ? `, subtype=${cliSubtype}` : '') +
        (!hasResultField ? ', missing result field' : ''),
    };
  }

  return {
    success: true,
    rawResponse: modelOutput,
    rawStderr: response.stderr,
    rawCliStdout: rawCliStdout || undefined,
    tokenUsage: response.tokenUsage ?? null,
  };
}

/**
 * Builds the orchestrator user prompt by loading the template and interpolating placeholders.
 *
 * @param config - Envoi configuration
 * @param state - Current tick state
 * @param retryReason - Optional error reason for retry attempts
 * @returns The interpolated user prompt
 */
export async function buildOrchestratorPrompt(
  config: EnvoiConfig,
  state: TickState,
  retryReason?: string | null
): Promise<string> {
  const workspaceDir = config.workspace_dir;
  const userPromptPath = resolveInWorkspace(workspaceDir, config.orchestrator.user_prompt_file);

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
      maxBuffer: 50000,
      cwd: workspaceDir,
    }).trim();
  } catch {
    gitStatus = '(git status unavailable)';
  }
  gitStatus = truncatePromptSection('REPO_SUMMARY', gitStatus, ORCHESTRATOR_PROMPT_CAPS.gitStatusChars).text;

  // Read FACTS.md if exists
  const factsPath = resolveInWorkspace(workspaceDir, 'FACTS.md');
  const factsRaw = existsSync(factsPath) ? readFileSync(factsPath, 'utf-8') : '';
  const facts = truncatePromptSection('FACTS_MD', factsRaw, ORCHESTRATOR_PROMPT_CAPS.factsChars).text;

  // Read PRD.md if exists
  const prdPath = resolveInWorkspace(workspaceDir, 'PRD.md');
  const prdRaw = existsSync(prdPath) ? readFileSync(prdPath, 'utf-8') : '';
  const prd = truncatePromptSection('PRD_MD', prdRaw, ORCHESTRATOR_PROMPT_CAPS.prdChars).text;

  // Read ROADMAP.json if exists
  const roadmapPath = resolveInWorkspace(workspaceDir, 'ROADMAP.json');
  const roadmapRaw = existsSync(roadmapPath) ? readFileSync(roadmapPath, 'utf-8') : '';
  const roadmap = truncatePromptSection('ROADMAP_JSON', roadmapRaw, ORCHESTRATOR_PROMPT_CAPS.roadmapChars).text;

  // Read REPORT.md if exists (last report)
  const reportPath = join(workspaceDir, 'REPORT.md');
  const lastReportRaw = existsSync(reportPath) ? readFileSync(reportPath, 'utf-8') : '';
  const lastReport = truncatePromptSection(
    'LAST_REPORT_MD',
    lastReportRaw,
    ORCHESTRATOR_PROMPT_CAPS.lastReportChars
  ).text;

  // Read STATE.json for milestone, budget summary, and planning context
  let milestoneId = 'none';
  let budgetSummary = 'Budgets: (unavailable)';
  let pendingIdeasContext = '[]';
  let planningDigestContext = '{}';
  let openQuestionsContext = '[]';
  try {
    const wsState = await readWorkspaceState(workspaceDir);
    milestoneId = wsState.milestone_id || 'none';
    budgetSummary = `Milestone: ${milestoneId}, Ticks: ${wsState.budgets.ticks}, Orchestrator: ${wsState.budgets.orchestrator_calls}, Builder: ${wsState.budgets.builder_calls}, Verify: ${wsState.budgets.verify_runs}`;

    const pendingIdeas = (wsState.idea_inbox ?? [])
      .filter((idea) => idea.status === 'new' || idea.status === 'triaged')
      .slice(-12);
    pendingIdeasContext = truncatePromptSection(
      'PENDING_IDEAS',
      JSON.stringify(pendingIdeas),
      ORCHESTRATOR_PROMPT_CAPS.pendingIdeasChars
    ).text;

    const planningDigest = wsState.planning_digest ?? {};
    planningDigestContext = truncatePromptSection(
      'PLANNING_DIGEST',
      JSON.stringify(planningDigest),
      ORCHESTRATOR_PROMPT_CAPS.planningDigestChars
    ).text;

    const openQuestions = (wsState.open_product_questions ?? [])
      .filter((question) => !question.resolved)
      .slice(-8);
    openQuestionsContext = truncatePromptSection(
      'OPEN_PRODUCT_QUESTIONS',
      JSON.stringify(openQuestions),
      ORCHESTRATOR_PROMPT_CAPS.openQuestionsChars
    ).text;
  } catch {
    // STATE.json may not exist yet
  }

  // Determine builder capabilities
  const builderDefaultMode = config.builder.default_mode;
  const cursorConfigured = config.builder.cursor !== undefined && config.builder.cursor !== null ? 'yes' : 'no';

  // Interpolate placeholders with real values
  const replacements: Record<string, string> = {
    '{{PROJECT_GOAL}}': '[See FACTS.md for project context]',
    '{{MILESTONE_ID}}': milestoneId,
    '{{BUDGETS_SUMMARY}}': budgetSummary,
    '{{VERIFY_TEMPLATE_IDS}}': config.verification.templates.map((t) => t.id).join(', ') || '[No templates]',
    '{{REPO_SUMMARY}}': gitStatus || '(clean)',
    '{{FACTS_MD}}': facts,
    '{{PRD_MD}}': prd || '[No PRD provided yet]',
    '{{ROADMAP_JSON}}': roadmap || '{}',
    '{{LAST_REPORT_MD}}': lastReport,
    '{{BLOCKED_JSON_OR_EMPTY}}': '',
    '{{PENDING_IDEAS_JSON}}': pendingIdeasContext,
    '{{PLANNING_DIGEST_JSON}}': planningDigestContext,
    '{{OPEN_PRODUCT_QUESTIONS_JSON}}': openQuestionsContext,
    '{{BUILDER_DEFAULT_MODE}}': builderDefaultMode,
    '{{BUILDER_CURSOR_CONFIGURED}}': cursorConfigured,
    '{{AUTONOMY_POLICY}}': formatPolicyForPrompt(config),
  };

  let prompt = template;
  const templateHasRoadmapPlaceholder = template.includes('{{ROADMAP_JSON}}');
  for (const [placeholder, value] of Object.entries(replacements)) {
    prompt = prompt.replace(new RegExp(placeholder.replace(/[{}]/g, '\\$&'), 'g'), value);
  }
  if (!templateHasRoadmapPlaceholder) {
    prompt += `\n- roadmap_json: ${roadmap || '{}'}`;
  }
  if (!template.includes('{{AUTONOMY_POLICY}}')) {
    prompt += `\n- autonomy_policy:\n${replacements['{{AUTONOMY_POLICY}}']}`;
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
  const systemPromptPath = resolveInWorkspace(workspaceDir, config.orchestrator.system_prompt_file);
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
        tokenUsage: null,
      };
  }

  // Load task schema (cache after first load)
  if (taskSchemaCache === null) {
    const schemaPath = resolveInWorkspace(workspaceDir, config.orchestrator.task_schema_file);
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
        tokenUsage: null,
      };
    }
  }

  const provider = (config.models.orchestrator_provider === 'chatgpt' ? 'chatgpt' : 'claude_code');
  const model = config.models.orchestrator_model;
  const timeout = (config.orchestrator.timeout_seconds ?? config.runner.max_tick_seconds) * 1000; // Convert to milliseconds

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
        tokenUsage: null,
      };
    }

    try {
      const invocation = await invokePlanner(
        config,
        provider,
        model,
        userPrompt,
        systemPrompt,
        timeout,
        signal
      );
      const modelOutput = invocation.rawResponse ?? '';
      if (!invocation.success) {
        return {
          success: false,
          task: null,
          error: invocation.error ?? 'Planner invocation failed',
          rawResponse: modelOutput,
          rawStderr: invocation.rawStderr,
          rawCliStdout: invocation.rawCliStdout,
          attempts,
          retryReason,
          tokenUsage: invocation.tokenUsage ?? null,
        };
      }

      // Parse JSON response
      let parsed: unknown;
      try {
        if (invocation.parsedObject !== undefined) {
          parsed = invocation.parsedObject;
        } else {
          const raw = modelOutput.trim();
          const unfenced = raw.startsWith("```")
            ? raw.replace(/^```[a-zA-Z0-9_-]*\s*\n?/, "").replace(/```[\s]*$/, "").trim()
            : raw;
          parsed = JSON.parse(unfenced);
        }
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
            rawResponse: modelOutput,
            rawStderr: invocation.rawStderr,
            rawCliStdout: invocation.rawCliStdout,
            attempts,
            retryReason,
            diagnostics: {
              extractMethod: 'direct_parse',
            },
            tokenUsage: invocation.tokenUsage ?? null,
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
            rawResponse: modelOutput,
            rawStderr: invocation.rawStderr,
            rawCliStdout: invocation.rawCliStdout,
            attempts,
            retryReason,
            diagnostics: {
              schemaErrors: validationResult.rawErrors,
              extractMethod: 'direct_parse',
              extractedJson: parsed,
            },
            tokenUsage: invocation.tokenUsage ?? null,
          };
        }
      }

      // Success!
      return {
        success: true,
        task: validationResult.data!,
        error: null,
        rawResponse: modelOutput,
        rawStderr: invocation.rawStderr,
        rawCliStdout: invocation.rawCliStdout,
        attempts,
        retryReason: attempt === 1 ? retryReason : null,
        tokenUsage: invocation.tokenUsage ?? null,
      };
    } catch (error) {
      // Re-throw InterruptedError to propagate to tick level
      if (isInterruptedError(error)) {
        throw error;
      }
      // Re-throw timeout errors to propagate to tick level for proper STOP_ORCHESTRATOR_TIMEOUT handling
      if (isTimeoutError(error)) {
        throw error;
      }
      // Non-retryable error (invocation exception)
      return {
        success: false,
        task: null,
        error: `Planner invocation error: ${error instanceof Error ? error.message : String(error)}`,
        rawResponse: '',
        rawStderr: '',
        attempts,
        retryReason,
        tokenUsage: null,
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
    tokenUsage: null,
  };
}
