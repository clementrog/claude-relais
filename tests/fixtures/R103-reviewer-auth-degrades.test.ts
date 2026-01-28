/**
 * R103: reviewer_missing_auth_degrades
 * 
 * Verify that simulating codex CLI auth error -> reviewer_error recorded,
 * force_patch_until_success set (STOP_REVIEWER_FORCED_PATCH).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runReviewerIfNeeded } from '@/lib/reviewer-flow.js';
import { computeRiskFlags } from '@/lib/risk.js';
import { createMockConfig, createMockTask } from '../helpers/mocks.js';
import type { ReviewerFlowContext } from '@/lib/reviewer-flow.js';
import type { DiffAnalysis } from '@/lib/diff.js';

// Mock reviewer invocation
vi.mock('@/lib/reviewer.js', () => ({
  invokeReviewer: vi.fn(),
  checkReviewerAuth: vi.fn(),
  parseReviewerOutput: vi.fn(),
}));

// Mock file system operations
vi.mock('node:fs/promises', () => ({
  readFile: vi.fn(),
}));

describe('R103: reviewer_missing_auth_degrades', () => {
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

  it('should degrade gracefully when reviewer auth fails -> STOP_REVIEWER_FORCED_PATCH with reviewerError', async () => {
    const { checkReviewerAuth } = await import('@/lib/reviewer.js');

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

    // Mock auth check failing
    vi.mocked(checkReviewerAuth).mockReturnValue({
      authenticated: false,
      reason: 'CODEX_API_KEY environment variable not set',
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

    // Assert: should return STOP_REVIEWER_FORCED_PATCH with reviewerError
    expect(result.stopCode).toBe('STOP_REVIEWER_FORCED_PATCH');
    expect(result.reviewerError).toBeDefined();
    expect(result.reviewerError).toContain('authentication failed');
    expect(result.reviewerError).toContain('CODEX_API_KEY');
  });

  it('should degrade gracefully when reviewer prompt files cannot be read', async () => {
    const { checkReviewerAuth, invokeReviewer } = await import('@/lib/reviewer.js');
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

    // Mock auth check passing
    vi.mocked(checkReviewerAuth).mockReturnValue({
      authenticated: true,
    });

    // Mock file read failure
    vi.mocked(readFile).mockRejectedValue(new Error('ENOENT: no such file or directory'));

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

    // Assert: should return STOP_REVIEWER_FORCED_PATCH with reviewerError
    expect(result.stopCode).toBe('STOP_REVIEWER_FORCED_PATCH');
    expect(result.reviewerError).toBeDefined();
    expect(result.reviewerError).toContain('Failed to read reviewer prompt files');
    expect(invokeReviewer).not.toHaveBeenCalled();
  });

  it('should degrade gracefully when reviewer invocation fails', async () => {
    const { checkReviewerAuth, invokeReviewer } = await import('@/lib/reviewer.js');
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

    // Mock auth check passing
    vi.mocked(checkReviewerAuth).mockReturnValue({
      authenticated: true,
    });

    // Mock prompt files reading successfully
    vi.mocked(readFile).mockResolvedValue('reviewer prompt');

    // Mock reviewer invocation failing
    vi.mocked(invokeReviewer).mockResolvedValue({
      success: false,
      error: 'Codex CLI invocation timed out after 30000ms',
      exitCode: 124,
      stderr: 'timeout',
      durationMs: 30000,
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

    // Assert: should return STOP_REVIEWER_FORCED_PATCH with reviewerError
    expect(result.stopCode).toBe('STOP_REVIEWER_FORCED_PATCH');
    expect(result.reviewerError).toBeDefined();
    expect(result.reviewerError).toContain('timed out');
    expect(invokeReviewer).toHaveBeenCalledTimes(1);
  });

  it('should degrade gracefully when reviewer output parsing fails', async () => {
    const { checkReviewerAuth, invokeReviewer } = await import('@/lib/reviewer.js');
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

    // Mock auth check passing
    vi.mocked(checkReviewerAuth).mockReturnValue({
      authenticated: true,
    });

    // Mock prompt files reading successfully
    vi.mocked(readFile).mockResolvedValue('reviewer prompt');

    // Mock reviewer returning invalid output (missing decision field)
    vi.mocked(invokeReviewer).mockResolvedValue({
      success: true,
      result: {
        // Missing decision field - invalid
        reason_short: 'Some reason',
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

    // Assert: should return STOP_REVIEWER_FORCED_PATCH with reviewerError
    expect(result.stopCode).toBe('STOP_REVIEWER_FORCED_PATCH');
    expect(result.reviewerError).toBeDefined();
    expect(result.reviewerError).toContain('Failed to parse reviewer decision');
    expect(invokeReviewer).toHaveBeenCalledTimes(1);
  });
});
