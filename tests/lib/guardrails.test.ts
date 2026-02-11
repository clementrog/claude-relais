import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  classifyVerifyResult,
  shouldEscalate,
  checkBranchMatch,
  checkFingerprintMatch,
  checkWorktreeClean,
  checkMergeEligibility,
  type GuardrailState,
} from '@/lib/guardrails';
import { canonicalizeTask } from '@/lib/fingerprint';
import type { Task } from '@/types/task.js';
import type { TickState } from '@/types/state.js';
import type { EnvoiConfig } from '@/types/config.js';
import { TickPhase } from '@/types/state.js';
import { createMockConfig, createMockTask, createMockTickState } from '../helpers/mocks.js';
import * as git from '@/lib/git.js';

// Mock git functions
vi.mock('@/lib/git.js', () => ({
  getCurrentBranch: vi.fn(),
  isWorktreeClean: vi.fn(),
}));

describe('guardrails', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('U001: canonicalizeTask', () => {
    it('should produce deterministic sorted JSON', () => {
      // canonicalizeTask only includes fingerprint-relevant fields (goal, subtasks, acceptance, verify, implementation, risk, notes, scope)
      // Keys are sorted alphabetically, so 'goal' comes before 'risk' comes before 'subtasks'
      const task1 = { goal: 'test', subtasks: ['task1'], risk: 'LOW' };
      const task2 = { risk: 'LOW', goal: 'test', subtasks: ['task1'] };
      
      const result1 = canonicalizeTask(task1);
      const result2 = canonicalizeTask(task2);
      
      // Both should produce identical JSON strings with sorted keys
      expect(result1).toBe(result2);
      // Verify the keys are sorted alphabetically
      expect(result1).toMatch(/^\{.*"goal".*"risk".*"subtasks".*\}$/);
    });

    it('should handle nested objects with sorted keys', () => {
      const task1 = { scope: { forbidden: ['a'], write: ['b'] }, goal: 'test' };
      const task2 = { goal: 'test', scope: { write: ['b'], forbidden: ['a'] } };
      
      const result1 = canonicalizeTask(task1);
      const result2 = canonicalizeTask(task2);
      
      expect(result1).toBe(result2);
      expect(result1).toContain('"goal":"test"');
      expect(result1).toContain('"scope"');
    });

    it('should exclude task_id, id, v, milestone, and context fields', () => {
      const task = {
        task_id: 'WP-001',
        id: 'WP-001',
        v: 5,
        milestone: 'M10',
        context: { why: 'test' },
        goal: 'test goal',
        subtasks: ['task1'],
      };
      
      const result = canonicalizeTask(task);
      const parsed = JSON.parse(result);
      
      expect(parsed).not.toHaveProperty('task_id');
      expect(parsed).not.toHaveProperty('id');
      expect(parsed).not.toHaveProperty('v');
      expect(parsed).not.toHaveProperty('milestone');
      expect(parsed).not.toHaveProperty('context');
      expect(parsed).toHaveProperty('goal');
      expect(parsed).toHaveProperty('subtasks');
    });

    it('should trim strings', () => {
      const task = { goal: '  test goal  ', subtasks: ['  task1  '] };
      const result = canonicalizeTask(task);
      const parsed = JSON.parse(result);
      
      expect(parsed.goal).toBe('test goal');
      expect(parsed.subtasks[0]).toBe('task1');
    });
  });

  describe('U002: classifyVerifyResult', () => {
    it('should return PASS for exit code 0 and not timed out', () => {
      const result = classifyVerifyResult(0, false, 1500, 'fast');
      
      expect(result.resultType).toBe('PASS');
      expect(result.stopCode).toBeNull();
      expect(result.shouldIncrementFailureStreak).toBe(false);
    });

    it('should return FAIL with STOP_VERIFY_FAILED_FAST for non-zero exit code in fast phase', () => {
      const result = classifyVerifyResult(1, false, 2000, 'fast');
      
      expect(result.resultType).toBe('FAIL');
      expect(result.stopCode).toBe('STOP_VERIFY_FAILED_FAST');
      expect(result.shouldIncrementFailureStreak).toBe(true);
    });

    it('should return FAIL with STOP_VERIFY_FAILED_SLOW for non-zero exit code in slow phase', () => {
      const result = classifyVerifyResult(1, false, 2000, 'slow');
      
      expect(result.resultType).toBe('FAIL');
      expect(result.stopCode).toBe('STOP_VERIFY_FAILED_SLOW');
      expect(result.shouldIncrementFailureStreak).toBe(true);
    });

    it('should return TIMEOUT with STOP_VERIFY_FLAKY_OR_TIMEOUT when timed out', () => {
      const result = classifyVerifyResult(124, true, 30000, 'fast');
      
      expect(result.resultType).toBe('TIMEOUT');
      expect(result.stopCode).toBe('STOP_VERIFY_FLAKY_OR_TIMEOUT');
      expect(result.shouldIncrementFailureStreak).toBe(true);
    });

    it('should prioritize TIMEOUT over exit code', () => {
      const result = classifyVerifyResult(0, true, 30000, 'fast');
      
      expect(result.resultType).toBe('TIMEOUT');
      expect(result.stopCode).toBe('STOP_VERIFY_FLAKY_OR_TIMEOUT');
      expect(result.shouldIncrementFailureStreak).toBe(true);
    });
  });

  describe('U003: shouldEscalate', () => {
    let config: EnvoiConfig;
    let state: TickState;

    beforeEach(() => {
      config = createMockConfig({
        reviewer: {
          enabled: false,
          trigger: {
            on_repeated_stop: true,
            stop_window_ticks: 5,
            max_stops_in_window: 3,
          },
        },
      });
    });

    it('should escalate when failure_streak >= 2', () => {
      state = createMockTickState(config, null, {
        failure_streak: 2,
      });

      const decision = shouldEscalate(state, config, 10);

      expect(decision.mode).not.toBe('none');
      expect(decision.reason).toContain('Failure streak is 2');
    });

    it('should return mode "human" when reviewer is disabled and failure_streak >= 2', () => {
      state = createMockTickState(config, null, {
        failure_streak: 2,
      });

      const decision = shouldEscalate(state, config, 10);

      expect(decision.mode).toBe('human');
    });

    it('should return mode "reviewer" when reviewer is enabled and failure_streak >= 2', () => {
      config = createMockConfig({
        reviewer: {
          enabled: true,
          trigger: {
            on_repeated_stop: true,
            stop_window_ticks: 5,
            max_stops_in_window: 3,
          },
        },
      });
      state = createMockTickState(config, null, {
        failure_streak: 2,
      });

      const decision = shouldEscalate(state, config, 10);

      expect(decision.mode).toBe('reviewer');
    });

    it('should escalate when stop_history exceeds max_stops_in_window', () => {
      state = createMockTickState(config, null, {
        failure_streak: 0,
        guardrail: {
          force_patch_until_success: false,
          last_risk_flags: [],
          stop_history: [
            { run_id: 'run1', code: 'STOP_VERIFY_FAILED_FAST', at: '2024-01-01T00:00:00Z' },
            { run_id: 'run2', code: 'STOP_VERIFY_FAILED_FAST', at: '2024-01-01T00:01:00Z' },
            { run_id: 'run3', code: 'STOP_VERIFY_FAILED_FAST', at: '2024-01-01T00:02:00Z' },
          ],
        },
      });

      const decision = shouldEscalate(state, config, 10);

      expect(decision.mode).not.toBe('none');
      expect(decision.reason).toContain('Found 3 stops');
    });

    it('should not escalate when failure_streak < 2 and stop_history is within limits', () => {
      state = createMockTickState(config, null, {
        failure_streak: 1,
        guardrail: {
          force_patch_until_success: false,
          last_risk_flags: [],
          stop_history: [
            { run_id: 'run1', code: 'STOP_VERIFY_FAILED_FAST', at: '2024-01-01T00:00:00Z' },
          ],
        },
      });

      const decision = shouldEscalate(state, config, 10);

      expect(decision.mode).toBe('none');
      expect(decision.reason).toContain('No escalation triggers detected');
    });

    it('should not escalate when stop_window_ticks is 0', () => {
      config = createMockConfig({
        reviewer: {
          enabled: false,
          trigger: {
            on_repeated_stop: true,
            stop_window_ticks: 0,
            max_stops_in_window: 3,
          },
        },
      });
      state = createMockTickState(config, null, {
        failure_streak: 0,
        guardrail: {
          force_patch_until_success: false,
          last_risk_flags: [],
          stop_history: [
            { run_id: 'run1', code: 'STOP_VERIFY_FAILED_FAST', at: '2024-01-01T00:00:00Z' },
            { run_id: 'run2', code: 'STOP_VERIFY_FAILED_FAST', at: '2024-01-01T00:01:00Z' },
            { run_id: 'run3', code: 'STOP_VERIFY_FAILED_FAST', at: '2024-01-01T00:02:00Z' },
          ],
        },
      });

      const decision = shouldEscalate(state, config, 10);

      expect(decision.mode).toBe('none');
    });
  });

  describe('U004: preflight checks', () => {
    describe('checkBranchMatch', () => {
      it('should pass when branch matches', () => {
        vi.mocked(git.getCurrentBranch).mockReturnValue('task/wp-001');
        
        const state: GuardrailState = { branch: 'task/wp-001' };
        const result = checkBranchMatch(state);

        expect(result.ok).toBe(true);
      });

      it('should fail with STOP_BRANCH_MISMATCH when branch differs', () => {
        vi.mocked(git.getCurrentBranch).mockReturnValue('main');
        
        const state: GuardrailState = { branch: 'task/wp-001' };
        const result = checkBranchMatch(state);

        expect(result.ok).toBe(false);
        expect(result.stopCode).toBe('STOP_BRANCH_MISMATCH');
        expect(result.reason).toContain("does not match expected branch");
      });

      it('should fail when getCurrentBranch throws', () => {
        vi.mocked(git.getCurrentBranch).mockImplementation(() => {
          throw new Error('Git error');
        });
        
        const state: GuardrailState = { branch: 'task/wp-001' };
        const result = checkBranchMatch(state);

        expect(result.ok).toBe(false);
        expect(result.stopCode).toBe('STOP_BRANCH_MISMATCH');
        expect(result.reason).toContain('Failed to get current branch');
      });
    });

    describe('checkFingerprintMatch', () => {
      it('should pass when fingerprint does not match last_failed_fingerprint', () => {
        const state: GuardrailState = {
          branch: 'task/wp-001',
          last_failed_fingerprint: 'abc123',
        };
        const task = createMockTask('execute', {
          goal: 'test goal',
          subtasks: ['task1'],
        });

        const result = checkFingerprintMatch(state, task);

        expect(result.ok).toBe(true);
      });

      it('should fail with STOP_REDISPATCH_IDENTICAL_TASK when fingerprint matches last_failed_fingerprint', async () => {
        const task = createMockTask('execute', {
          goal: 'test goal',
          subtasks: ['task1'],
        });
        
        // Compute fingerprint first
        const { computeFingerprint } = await import('@/lib/fingerprint.js');
        const fingerprint = computeFingerprint(task as unknown as Record<string, unknown>);
        
        const state: GuardrailState = {
          branch: 'task/wp-001',
          last_failed_fingerprint: fingerprint,
        };

        const result = checkFingerprintMatch(state, task);

        expect(result.ok).toBe(false);
        expect(result.stopCode).toBe('STOP_REDISPATCH_IDENTICAL_TASK');
        expect(result.reason).toContain('identical task re-dispatch detected');
      });
    });

    describe('checkWorktreeClean', () => {
      it('should pass when worktree is clean', () => {
        vi.mocked(git.isWorktreeClean).mockReturnValue(true);

        const result = checkWorktreeClean();

        expect(result.ok).toBe(true);
      });

      it('should fail with STOP_MERGE_DIRTY_WORKTREE when worktree is dirty', () => {
        vi.mocked(git.isWorktreeClean).mockReturnValue(false);

        const result = checkWorktreeClean();

        expect(result.ok).toBe(false);
        expect(result.stopCode).toBe('STOP_MERGE_DIRTY_WORKTREE');
        expect(result.reason).toContain('uncommitted changes');
      });
    });
  });

  describe('U005: checkMergeEligibility', () => {
    let state: TickState;

    beforeEach(() => {
      vi.mocked(git.isWorktreeClean).mockReturnValue(true);
    });

    it('should pass when verify_history contains PASS and git_diff_files is non-empty', () => {
      state = createMockTickState(createMockConfig(), null, {
        verify_history: [
          {
            ts: '2024-01-01T00:00:00Z',
            task: 'WP-001',
            result: 'PASS',
            cmd: 'pnpm test',
            ms: 1500,
          },
        ],
      });

      const report = {
        git_diff_files: ['src/file1.ts', 'src/file2.ts'],
      };

      const eligibility = checkMergeEligibility(state, report);

      expect(eligibility.eligible).toBe(true);
      expect(eligibility.reasons).toContain('All merge eligibility checks passed');
    });

    it('should fail when verify_history does not contain PASS', () => {
      state = createMockTickState(createMockConfig(), null, {
        verify_history: [
          {
            ts: '2024-01-01T00:00:00Z',
            task: 'WP-001',
            result: 'FAIL',
            cmd: 'pnpm test',
            ms: 1500,
          },
        ],
      });

      const report = {
        git_diff_files: ['src/file1.ts'],
      };

      const eligibility = checkMergeEligibility(state, report);

      expect(eligibility.eligible).toBe(false);
      expect(eligibility.reasons).toContain('verify_history does not contain any PASS results');
    });

    it('should fail when git_diff_files is empty', () => {
      state = createMockTickState(createMockConfig(), null, {
        verify_history: [
          {
            ts: '2024-01-01T00:00:00Z',
            task: 'WP-001',
            result: 'PASS',
            cmd: 'pnpm test',
            ms: 1500,
          },
        ],
      });

      const report = {
        git_diff_files: [],
      };

      const eligibility = checkMergeEligibility(state, report);

      expect(eligibility.eligible).toBe(false);
      expect(eligibility.reasons).toContain('git_diff_files is empty (no evidence of changes)');
    });

    it('should fail when git_diff_files is undefined', () => {
      state = createMockTickState(createMockConfig(), null, {
        verify_history: [
          {
            ts: '2024-01-01T00:00:00Z',
            task: 'WP-001',
            result: 'PASS',
            cmd: 'pnpm test',
            ms: 1500,
          },
        ],
      });

      const report = {};

      const eligibility = checkMergeEligibility(state, report);

      expect(eligibility.eligible).toBe(false);
      expect(eligibility.reasons).toContain('git_diff_files is empty (no evidence of changes)');
    });

    it('should fail when worktree is dirty', () => {
      vi.mocked(git.isWorktreeClean).mockReturnValue(false);
      
      state = createMockTickState(createMockConfig(), null, {
        verify_history: [
          {
            ts: '2024-01-01T00:00:00Z',
            task: 'WP-001',
            result: 'PASS',
            cmd: 'pnpm test',
            ms: 1500,
          },
        ],
      });

      const report = {
        git_diff_files: ['src/file1.ts'],
      };

      const eligibility = checkMergeEligibility(state, report);

      expect(eligibility.eligible).toBe(false);
      expect(eligibility.reasons.some(r => r.includes('uncommitted changes'))).toBe(true);
    });

    it('should fail when verify_history is empty', () => {
      state = createMockTickState(createMockConfig(), null, {
        verify_history: [],
      });

      const report = {
        git_diff_files: ['src/file1.ts'],
      };

      const eligibility = checkMergeEligibility(state, report);

      expect(eligibility.eligible).toBe(false);
      expect(eligibility.reasons).toContain('verify_history does not contain any PASS results');
    });

    it('should fail when verify_history is undefined', () => {
      state = createMockTickState(createMockConfig(), null, {});

      const report = {
        git_diff_files: ['src/file1.ts'],
      };

      const eligibility = checkMergeEligibility(state, report);

      expect(eligibility.eligible).toBe(false);
      expect(eligibility.reasons).toContain('verify_history does not contain any PASS results');
    });

    it('should accumulate multiple failure reasons', () => {
      vi.mocked(git.isWorktreeClean).mockReturnValue(false);
      
      state = createMockTickState(createMockConfig(), null, {
        verify_history: [],
      });

      const report = {
        git_diff_files: [],
      };

      const eligibility = checkMergeEligibility(state, report);

      expect(eligibility.eligible).toBe(false);
      expect(eligibility.reasons.length).toBeGreaterThan(1);
      expect(eligibility.reasons.some(r => r.includes('verify_history'))).toBe(true);
      expect(eligibility.reasons.some(r => r.includes('git_diff_files'))).toBe(true);
      expect(eligibility.reasons.some(r => r.includes('uncommitted changes'))).toBe(true);
    });
  });
});
