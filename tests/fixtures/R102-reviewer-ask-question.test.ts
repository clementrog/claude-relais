/**
 * R102: reviewer_ask_question
 * 
 * Verify that reviewer returns ask_question -> STOP_REVIEWER_ASK_QUESTION,
 * report includes question.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runReviewerIfNeeded, handleReviewerDecision } from '@/lib/reviewer-flow.js';
import { computeRiskFlags } from '@/lib/risk.js';
import { createMockConfig, createMockTask } from '../helpers/mocks.js';
import type { ReviewerFlowContext } from '@/lib/reviewer-flow.js';
import type { DiffAnalysis } from '@/lib/diff.js';

// Mock reviewer invocation
vi.mock('@/lib/reviewer.js', () => ({
  invokeReviewer: vi.fn(),
  checkReviewerAuth: vi.fn(() => ({ authenticated: true })),
  parseReviewerOutput: vi.fn(),
}));

// Mock file system operations
vi.mock('node:fs/promises', () => ({
  readFile: vi.fn(),
}));

describe('R102: reviewer_ask_question', () => {
  let config: ReturnType<typeof createMockConfig>;

  beforeEach(() => {
    vi.resetAllMocks();
    config = createMockConfig({
      reviewer: {
        enabled: true,
        command: 'codex',
        model: 'sonnet',
        max_turns: 1,
        system_prompt_file: 'relais/prompts/reviewer.system.txt',
        user_prompt_file: 'relais/prompts/reviewer.user.txt',
        trigger: {
          on_high_risk_paths: true,
          high_risk_globs: ['infra/**'],
          diff_fraction_threshold: 0.8,
          on_verify_fail: false,
          on_repeated_stop: false,
          stop_window_ticks: 10,
          max_stops_in_window: 2,
        },
      },
    });
  });

  it('should return STOP_REVIEWER_ASK_QUESTION with question when reviewer returns ask_question', async () => {
    const { invokeReviewer } = await import('@/lib/reviewer.js');
    const { readFile } = await import('node:fs/promises');

    const task = createMockTask('execute', {
      scope: {
        allowed_globs: ['infra/**'],
        forbidden_globs: [],
        allow_new_files: false,
        allow_lockfile_changes: false,
      },
    });

    const diffAnalysis: DiffAnalysis = {
      files_touched: 1,
      lines_added: 10,
      lines_deleted: 5,
      new_files: 0,
      touched_paths: ['infra/deploy.yaml'],
    };

    const riskFlags = computeRiskFlags({
      analysis: diffAnalysis,
      limits: task.diff_limits,
      scope: task.scope,
      trigger: config.reviewer!.trigger,
      stopHistory: [],
      currentTick: 1,
      verifyFailed: false,
      budgetWarning: false,
    });

    // Mock reviewer prompt files
    vi.mocked(readFile).mockResolvedValue('reviewer prompt');

    // Mock reviewer returning ask_question decision with question
    const questionPrompt = 'Should this infrastructure change be deployed to production?';
    const questionChoices = ['Yes', 'No', 'Deploy to staging first'];

    vi.mocked(invokeReviewer).mockResolvedValue({
      success: true,
      result: {
        decision: 'ask_question',
        reason_short: 'Infrastructure changes require confirmation',
        question: {
          prompt: questionPrompt,
          choices: questionChoices,
        },
      },
      raw: {},
      exitCode: 0,
      durationMs: 100,
    });

    const context: ReviewerFlowContext = {
      riskFlags,
      task,
      diffAnalysis,
      stopHistory: [],
      currentTick: 1,
      verifyFailed: false,
      budgetWarning: false,
      touchedPaths: ['infra/deploy.yaml'],
    };

    const result = await runReviewerIfNeeded(config, context);

    // Assert: should return STOP_REVIEWER_ASK_QUESTION with question
    expect(result.stopCode).toBe('STOP_REVIEWER_ASK_QUESTION');
    expect(result.question).toBeDefined();
    expect(result.question?.prompt).toBe(questionPrompt);
    expect(result.question?.choices).toEqual(questionChoices);
    expect(invokeReviewer).toHaveBeenCalledTimes(1);
  });

  it('should handle ask_question decision correctly', () => {
    const decision = {
      decision: 'ask_question' as const,
      question: {
        prompt: 'Test question?',
        choices: ['Option 1', 'Option 2'],
      },
    };

    const result = handleReviewerDecision(decision);

    expect(result.stopCode).toBe('STOP_REVIEWER_ASK_QUESTION');
    expect(result.question).toBeDefined();
    expect(result.question?.prompt).toBe('Test question?');
    expect(result.question?.choices).toEqual(['Option 1', 'Option 2']);
  });

  it('should default to force_patch if ask_question decision missing question', () => {
    const decision = {
      decision: 'ask_question' as const,
      // Missing question field
    };

    const result = handleReviewerDecision(decision);

    // Should default to force_patch for invalid decision
    expect(result.stopCode).toBe('STOP_REVIEWER_FORCED_PATCH');
    expect(result.question).toBeUndefined();
  });

  it('should handle ask_question with optional choices', () => {
    const decision = {
      decision: 'ask_question' as const,
      question: {
        prompt: 'Simple question without choices?',
        // choices is optional
      },
    };

    const result = handleReviewerDecision(decision);

    expect(result.stopCode).toBe('STOP_REVIEWER_ASK_QUESTION');
    expect(result.question).toBeDefined();
    expect(result.question?.prompt).toBe('Simple question without choices?');
    expect(result.question?.choices).toBeUndefined();
  });
});
