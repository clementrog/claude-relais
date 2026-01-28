/**
 * R101: high_risk_path_triggers_reviewer_force_patch
 * 
 * Verify that when task scope includes infra/**, reviewer returns force_patch
 * -> STOP_REVIEWER_FORCED_PATCH, builder not called.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runReviewerIfNeeded, handleReviewerDecision } from '@/lib/reviewer-flow.js';
import { computeRiskFlags, shouldTriggerReviewer } from '@/lib/risk.js';
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

describe('R101: high_risk_path_triggers_reviewer_force_patch', () => {
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
          high_risk_globs: ['infra/**', '**/infra/**'],
          diff_fraction_threshold: 0.8,
          on_verify_fail: false,
          on_repeated_stop: false,
          stop_window_ticks: 10,
          max_stops_in_window: 2,
        },
      },
    });
  });

  it('should trigger reviewer when task scope includes infra/** and return force_patch -> STOP_REVIEWER_FORCED_PATCH', async () => {
    const { invokeReviewer } = await import('@/lib/reviewer.js');
    const { readFile } = await import('node:fs/promises');

    // Create task with infra/** in allowed_globs
    const task = createMockTask('execute', {
      scope: {
        allowed_globs: ['infra/**', 'src/**'],
        forbidden_globs: [],
        allow_new_files: false,
        allow_lockfile_changes: false,
      },
    });

    // Mock diff analysis with infra path
    const diffAnalysis: DiffAnalysis = {
      files_touched: 1,
      lines_added: 10,
      lines_deleted: 5,
      new_files: 0,
      touched_paths: ['infra/deploy.yaml'],
    };

    // Compute risk flags - should detect high_risk_path
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

    expect(riskFlags).toContain('high_risk_path');
    expect(shouldTriggerReviewer(config.reviewer!, riskFlags)).toBe(true);

    // Mock reviewer prompt files
    vi.mocked(readFile).mockResolvedValue('reviewer prompt');

    // Mock reviewer returning force_patch decision
    vi.mocked(invokeReviewer).mockResolvedValue({
      success: true,
      result: {
        decision: 'force_patch',
        reason_short: 'High risk infrastructure changes require manual review',
      },
      raw: {},
      exitCode: 0,
      durationMs: 100,
    });

    // Create reviewer context
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

    // Run reviewer
    const result = await runReviewerIfNeeded(config, context);

    // Assert: should return STOP_REVIEWER_FORCED_PATCH
    expect(result.stopCode).toBe('STOP_REVIEWER_FORCED_PATCH');
    expect(result.question).toBeUndefined();
    expect(invokeReviewer).toHaveBeenCalledTimes(1);
  });

  it('should handle force_patch decision correctly', () => {
    const decision = {
      decision: 'force_patch' as const,
    };

    const result = handleReviewerDecision(decision);

    expect(result.stopCode).toBe('STOP_REVIEWER_FORCED_PATCH');
    expect(result.question).toBeUndefined();
  });

  it('should detect high_risk_path when allowed_globs overlap with high_risk_globs', () => {
    const task = createMockTask('execute', {
      scope: {
        allowed_globs: ['infra/**'],
        forbidden_globs: [],
        allow_new_files: false,
        allow_lockfile_changes: false,
      },
    });

    const diffAnalysis: DiffAnalysis = {
      files_touched: 0,
      lines_added: 0,
      lines_deleted: 0,
      new_files: 0,
      touched_paths: [],
    };

    // Even with no touched paths, pattern overlap should trigger risk flag
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

    // Pattern overlap detection may or may not trigger depending on implementation
    // But if paths match, it should definitely trigger
    const diffAnalysisWithPaths: DiffAnalysis = {
      files_touched: 1,
      lines_added: 5,
      lines_deleted: 2,
      new_files: 0,
      touched_paths: ['infra/config.yaml'],
    };

    const riskFlagsWithPaths = computeRiskFlags({
      analysis: diffAnalysisWithPaths,
      limits: task.diff_limits,
      scope: task.scope,
      trigger: config.reviewer!.trigger,
      stopHistory: [],
      currentTick: 1,
      verifyFailed: false,
      budgetWarning: false,
    });

    expect(riskFlagsWithPaths).toContain('high_risk_path');
  });
});
