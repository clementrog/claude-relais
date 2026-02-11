/**
 * Reviewer flow integration for pre-builder risk checks.
 *
 * Integrates the reviewer into the tick flow to be called pre-builder when
 * risk is detected. Handles reviewer decisions and returns appropriate stop
 * codes or proceeds to builder.
 */

import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import type { EnvoiConfig } from '../types/config.js';
import type { ReportCode } from '../types/report.js';
import type { RiskFlags } from '../types/reviewer.js';
import type { Task } from '../types/task.js';
import { invokeReviewer, parseReviewerOutput } from './reviewer.js';
import { shouldTriggerReviewer, computeRiskFlags } from './risk.js';
import type { DiffAnalysis } from './diff.js';
import type { StopHistoryEntry } from './risk.js';

/**
 * Context information for reviewer invocation.
 */
export interface ReviewerFlowContext {
  /** Risk flags that triggered the reviewer */
  riskFlags: RiskFlags[];
  /** Current task (if available) */
  task: Task | null;
  /** Diff analysis (if available) */
  diffAnalysis?: DiffAnalysis;
  /** Stop history entries */
  stopHistory: StopHistoryEntry[];
  /** Current tick number */
  currentTick: number;
  /** Whether verification failed */
  verifyFailed: boolean;
  /** Whether budget warning threshold reached */
  budgetWarning: boolean;
  /** Last report markdown (if available) */
  lastReportMd?: string;
  /** Diff patch content (if available) */
  diffPatch?: string;
  /** Verification log excerpt (if available) */
  verifyLogExcerpt?: string;
  /** Touched file paths */
  touchedPaths: string[];
}

/**
 * Result of reviewer flow execution.
 */
export interface ReviewerFlowResult {
  /** Stop code if reviewer decided to stop, null if proceed */
  stopCode: ReportCode | null;
  /** Question object if ask_question decision */
  question?: {
    prompt: string;
    choices?: string[];
  };
  /** Reviewer error message if invocation failed */
  reviewerError?: string;
}

/**
 * Handles reviewer decision and returns appropriate stop code or null.
 *
 * @param decision - Reviewer decision object from parsed output
 * @returns ReviewerFlowResult with stopCode or null (proceed)
 */
export function handleReviewerDecision(decision: {
  decision: 'proceed' | 'force_patch' | 'ask_question';
  question?: {
    prompt: string;
    choices?: string[];
  };
}): ReviewerFlowResult {
  if (decision.decision === 'proceed') {
    return { stopCode: null };
  }

  if (decision.decision === 'force_patch') {
    return { stopCode: 'STOP_REVIEWER_FORCED_PATCH' };
  }

  if (decision.decision === 'ask_question') {
    if (!decision.question) {
      // Invalid decision - missing question, default to force_patch
      return { stopCode: 'STOP_REVIEWER_FORCED_PATCH' };
    }
    return {
      stopCode: 'STOP_REVIEWER_ASK_QUESTION',
      question: {
        prompt: decision.question.prompt,
        choices: decision.question.choices,
      },
    };
  }

  // Unknown decision - default to force_patch for safety
  return { stopCode: 'STOP_REVIEWER_FORCED_PATCH' };
}

/**
 * Runs reviewer if needed based on risk flags and configuration.
 *
 * This function should be called pre-builder when risk is detected.
 * It checks if reviewer should be triggered, invokes it if needed, and
 * handles the decision.
 *
 * @param config - Envoi configuration
 * @param context - Reviewer flow context
 * @returns Promise resolving to ReviewerFlowResult
 */
export async function runReviewerIfNeeded(
  config: EnvoiConfig,
  context: ReviewerFlowContext
): Promise<ReviewerFlowResult> {
  // Reviewer must be configured
  if (!config.reviewer) {
    return { stopCode: null };
  }

  // Check if reviewer should be triggered
  if (!shouldTriggerReviewer(config.reviewer, context.riskFlags)) {
    return { stopCode: null };
  }

  // Check authentication
  const authCheck = await import('./reviewer.js').then((m) => m.checkReviewerAuth());
  if (!authCheck.authenticated) {
    // Degrade gracefully - log error but proceed (or default to force_patch if pre-build)
    return {
      stopCode: 'STOP_REVIEWER_FORCED_PATCH',
      reviewerError: `Reviewer authentication failed: ${authCheck.reason || 'unknown reason'}`,
    };
  }

  // Build reviewer prompt
  const reviewerConfig = config.reviewer;
  const workspaceDir = config.workspace_dir;
  const userPromptPath = join(workspaceDir, reviewerConfig.user_prompt_file);
  const systemPromptPath = join(workspaceDir, reviewerConfig.system_prompt_file);

  let userPrompt: string;
  let systemPrompt: string;

  try {
    userPrompt = await readFile(userPromptPath, 'utf-8');
    systemPrompt = await readFile(systemPromptPath, 'utf-8');
  } catch (error) {
    return {
      stopCode: 'STOP_REVIEWER_FORCED_PATCH',
      reviewerError: `Failed to read reviewer prompt files: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  // Interpolate placeholders in user prompt
  const replacements: Record<string, string> = {
    '{{RISK_FLAGS}}': context.riskFlags.join(', ') || 'none',
    '{{TASK_JSON}}': context.task ? JSON.stringify(context.task, null, 2) : 'null',
    '{{LAST_REPORT_MD}}': context.lastReportMd || '',
    '{{DIFF_PATCH_OR_EMPTY}}': context.diffPatch || '',
    '{{VERIFY_LOG_EXCERPT_OR_EMPTY}}': context.verifyLogExcerpt || '',
    '{{TOUCHED_PATHS}}': context.touchedPaths.join('\n') || 'none',
  };

  for (const [placeholder, value] of Object.entries(replacements)) {
    userPrompt = userPrompt.replace(new RegExp(placeholder.replace(/[{}]/g, '\\$&'), 'g'), value);
  }

  // Invoke reviewer
  const invocationConfig = {
    command: reviewerConfig.command,
    model: reviewerConfig.model,
    maxTurns: reviewerConfig.max_turns,
    timeout: config.runner.max_tick_seconds * 1000, // Convert to milliseconds
  };

  const reviewerContext = {
    prompt: userPrompt,
    systemPrompt: systemPromptPath,
  };

  const invocationResult = await invokeReviewer(invocationConfig, reviewerContext);

  if (!invocationResult.success) {
    // Reviewer invocation failed - degrade gracefully
    return {
      stopCode: 'STOP_REVIEWER_FORCED_PATCH',
      reviewerError: invocationResult.error,
    };
  }

  // Parse and validate reviewer output
  let decision: {
    decision: 'proceed' | 'force_patch' | 'ask_question';
    question?: {
      prompt: string;
      choices?: string[];
    };
  };

  try {
    // The result should match reviewer_result.schema.json structure
    const parsed = invocationResult.result as {
      decision: 'proceed' | 'force_patch' | 'ask_question';
      question?: {
        prompt: string;
        choices?: string[];
      };
    };

    if (
      !parsed.decision ||
      !['proceed', 'force_patch', 'ask_question'].includes(parsed.decision)
    ) {
      throw new Error(`Invalid decision: ${parsed.decision}`);
    }

    decision = parsed;
  } catch (error) {
    return {
      stopCode: 'STOP_REVIEWER_FORCED_PATCH',
      reviewerError: `Failed to parse reviewer decision: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  // Handle the decision
  return handleReviewerDecision(decision);
}
