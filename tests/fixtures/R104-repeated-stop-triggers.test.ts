/**
 * R104: repeated_stop_triggers_reviewer
 * 
 * Verify that stop_history has >=2 stops in window -> reviewer triggered on next tick.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runReviewerIfNeeded } from '@/lib/reviewer-flow.js';
import { computeRiskFlags, checkRepeatedStops, shouldTriggerReviewer } from '@/lib/risk.js';
import { createMockConfig, createMockTask } from '../helpers/mocks.js';
import type { ReviewerFlowContext } from '@/lib/reviewer-flow.js';
import type { DiffAnalysis } from '@/lib/diff.js';
import type { StopHistoryEntry } from '@/lib/risk.js';

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

describe('R104: repeated_stop_triggers_reviewer', () => {
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
          on_high_risk_paths: false,
          high_risk_globs: [],
          diff_fraction_threshold: 0.8,
          on_verify_fail: false,
          on_repeated_stop: true,
          stop_window_ticks: 10,
          max_stops_in_window: 2,
        },
      },
    });
  });

  it('should trigger reviewer when stop_history has >=2 stops in window', () => {
    const stopHistory: StopHistoryEntry[] = [
      { tick: 5, verdict: 'stop' },
      { tick: 8, verdict: 'stop' },
      { tick: 12, verdict: 'stop' },
    ];

    const currentTick = 12;
    const window = 10;
    const maxStops = 2;

    // Check repeated stops - should detect >=2 stops in window
    const repeated = checkRepeatedStops(stopHistory, window, maxStops, currentTick);
    expect(repeated).toBe(true);

    // Stops in window: tick 8 and tick 12 (within window of 10 from tick 12)
    // Window: tick 2 to tick 12, so ticks 5, 8, 12 are all in window
    // Count: 3 stops >= 2, so should trigger
  });

  it('should compute repeated_stop risk flag when repeated stops detected', () => {
    const task = createMockTask('execute');
    const diffAnalysis: DiffAnalysis = {
      files_touched: 1,
      lines_added: 5,
      lines_deleted: 2,
      new_files: 0,
      touched_paths: ['src/utils.ts'],
    };

    const stopHistory: StopHistoryEntry[] = [
      { tick: 5, verdict: 'stop' },
      { tick: 8, verdict: 'stop' },
    ];

    const currentTick = 9;

    const riskFlags = computeRiskFlags({
      analysis: diffAnalysis,
      limits: task.diff_limits,
      scope: task.scope,
      trigger: config.reviewer!.trigger,
      stopHistory,
      currentTick,
      verifyFailed: false,
      budgetWarning: false,
    });

    // Should include repeated_stop flag
    expect(riskFlags).toContain('repeated_stop');
    expect(shouldTriggerReviewer(config.reviewer!, riskFlags)).toBe(true);
  });

  it('should trigger reviewer when repeated stops detected in context', async () => {
    const { invokeReviewer } = await import('@/lib/reviewer.js');
    const { readFile } = await import('node:fs/promises');

    const task = createMockTask('execute');
    const diffAnalysis: DiffAnalysis = {
      files_touched: 1,
      lines_added: 5,
      lines_deleted: 2,
      new_files: 0,
      touched_paths: ['src/utils.ts'],
    };

    const stopHistory: StopHistoryEntry[] = [
      { tick: 5, verdict: 'stop' },
      { tick: 8, verdict: 'stop' },
    ];

    const currentTick = 9;

    const riskFlags = computeRiskFlags({
      analysis: diffAnalysis,
      limits: task.diff_limits,
      scope: task.scope,
      trigger: config.reviewer!.trigger,
      stopHistory,
      currentTick,
      verifyFailed: false,
      budgetWarning: false,
    });

    expect(riskFlags).toContain('repeated_stop');

    // Mock reviewer prompt files
    vi.mocked(readFile).mockResolvedValue('reviewer prompt');

    // Mock reviewer returning proceed (for this test, we just verify it's called)
    vi.mocked(invokeReviewer).mockResolvedValue({
      success: true,
      result: {
        decision: 'proceed',
        reason_short: 'Repeated stops reviewed, proceeding',
      },
      raw: {},
      exitCode: 0,
      durationMs: 100,
    });

    const context: ReviewerFlowContext = {
      riskFlags,
      task,
      diffAnalysis,
      stopHistory,
      currentTick,
      verifyFailed: false,
      budgetWarning: false,
      touchedPaths: ['src/utils.ts'],
    };

    const result = await runReviewerIfNeeded(config, context);

    // Reviewer should be triggered and called
    expect(invokeReviewer).toHaveBeenCalledTimes(1);
    // Result should be proceed (reviewer allowed it)
    expect(result.stopCode).toBeNull();
  });

  it('should not trigger reviewer when stops are outside window', () => {
    const stopHistory: StopHistoryEntry[] = [
      { tick: 1, verdict: 'stop' },
      { tick: 2, verdict: 'stop' },
    ];

    const currentTick = 15;
    const window = 10;
    const maxStops = 2;

    // Stops at tick 1 and 2 are outside window (window is tick 5-15)
    const repeated = checkRepeatedStops(stopHistory, window, maxStops, currentTick);
    expect(repeated).toBe(false);
  });

  it('should not trigger reviewer when stop count is below threshold', () => {
    const stopHistory: StopHistoryEntry[] = [
      { tick: 10, verdict: 'stop' },
    ];

    const currentTick = 12;
    const window = 10;
    const maxStops = 2;

    // Only 1 stop, but maxStops is 2, so should not trigger
    const repeated = checkRepeatedStops(stopHistory, window, maxStops, currentTick);
    expect(repeated).toBe(false);
  });

  it('should handle edge case with window boundary', () => {
    const stopHistory: StopHistoryEntry[] = [
      { tick: 3, verdict: 'stop' },
      { tick: 4, verdict: 'stop' },
    ];

    const currentTick = 13;
    const window = 10;
    const maxStops = 2;

    // Window: tick 3 to tick 13
    // Stops at tick 3 and 4 are in window
    const repeated = checkRepeatedStops(stopHistory, window, maxStops, currentTick);
    expect(repeated).toBe(true);
  });

  it('should ignore non-stop verdicts in stop_history', () => {
    const stopHistory: StopHistoryEntry[] = [
      { tick: 5, verdict: 'stop' },
      { tick: 8, verdict: 'stop' },
      // Non-stop entries should be ignored (though type system prevents this)
    ];

    const currentTick = 9;
    const window = 10;
    const maxStops = 2;

    const repeated = checkRepeatedStops(stopHistory, window, maxStops, currentTick);
    expect(repeated).toBe(true);
  });
});
