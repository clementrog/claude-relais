/**
 * F019: evidence_gating
 * 
 * Verify that merge requires verify evidence - cannot merge without PASS in verify_history.
 * Evidence gating ensures that merges only happen after successful verification.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { checkMergeEligibility } from '@/lib/guardrails.js';
import { createMockConfig, createMockTickState } from '../helpers/mocks.js';
import type { TickState } from '@/types/state.js';
import * as git from '@/lib/git.js';

// Mock git functions
vi.mock('@/lib/git.js', () => ({
  getCurrentBranch: vi.fn(),
  isWorktreeClean: vi.fn(),
}));

describe('F019: evidence_gating', () => {
  let config: ReturnType<typeof createMockConfig>;
  let state: TickState;

  beforeEach(() => {
    vi.clearAllMocks();
    config = createMockConfig();
    // Default: worktree is clean
    vi.mocked(git.isWorktreeClean).mockReturnValue(true);
    vi.mocked(git.getCurrentBranch).mockReturnValue('task/wp-001');
  });

  it('should reject merge when verify_history is empty', () => {
    state = createMockTickState(config, null, {
      verify_history: [],
    });

    const report = {
      git_diff_files: ['src/file1.ts'],
    };

    const eligibility = checkMergeEligibility(state, report);

    expect(eligibility.eligible).toBe(false);
    expect(eligibility.reasons).toContain('verify_history does not contain any PASS results');
  });

  it('should reject merge when verify_history contains only FAIL results', () => {
    state = createMockTickState(config, null, {
      verify_history: [
        {
          ts: '2024-01-01T00:00:00Z',
          task: 'WP-001',
          result: 'FAIL',
          cmd: 'pnpm test',
          ms: 1500,
        },
        {
          ts: '2024-01-01T00:01:00Z',
          task: 'WP-001',
          result: 'FAIL',
          cmd: 'pnpm build',
          ms: 2000,
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

  it('should reject merge when verify_history contains only TIMEOUT results', () => {
    state = createMockTickState(config, null, {
      verify_history: [
        {
          ts: '2024-01-01T00:00:00Z',
          task: 'WP-001',
          result: 'TIMEOUT',
          cmd: 'pnpm test',
          ms: 90000,
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

  it('should pass merge when verify_history contains at least one PASS', () => {
    state = createMockTickState(config, null, {
      verify_history: [
        {
          ts: '2024-01-01T00:00:00Z',
          task: 'WP-001',
          result: 'FAIL',
          cmd: 'pnpm lint',
          ms: 500,
        },
        {
          ts: '2024-01-01T00:01:00Z',
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

    expect(eligibility.eligible).toBe(true);
    expect(eligibility.reasons).toContain('All merge eligibility checks passed');
  });

  it('should pass merge when verify_history contains multiple PASS results', () => {
    state = createMockTickState(config, null, {
      verify_history: [
        {
          ts: '2024-01-01T00:00:00Z',
          task: 'WP-001',
          result: 'PASS',
          cmd: 'pnpm test',
          ms: 1500,
        },
        {
          ts: '2024-01-01T00:01:00Z',
          task: 'WP-001',
          result: 'PASS',
          cmd: 'pnpm build',
          ms: 2000,
        },
      ],
    });

    const report = {
      git_diff_files: ['src/file1.ts'],
    };

    const eligibility = checkMergeEligibility(state, report);

    expect(eligibility.eligible).toBe(true);
    expect(eligibility.reasons).toContain('All merge eligibility checks passed');
  });

  it('should require both PASS in verify_history and non-empty git_diff_files', () => {
    state = createMockTickState(config, null, {
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

  it('should combine multiple eligibility reasons when multiple checks fail', () => {
    state = createMockTickState(config, null, {
      verify_history: [],
    });

    const report = {
      git_diff_files: [],
    };

    const eligibility = checkMergeEligibility(state, report);

    expect(eligibility.eligible).toBe(false);
    expect(eligibility.reasons.length).toBeGreaterThan(1);
    expect(eligibility.reasons).toContain('verify_history does not contain any PASS results');
    expect(eligibility.reasons).toContain('git_diff_files is empty (no evidence of changes)');
  });
});
