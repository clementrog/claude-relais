/**
 * F018: dirty_worktree
 * 
 * Verify that merge is rejected when worktree has uncommitted changes (STOP_MERGE_DIRTY_WORKTREE).
 * Merge eligibility checks ensure worktree is clean before allowing merge.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { checkWorktreeClean, checkMergeEligibility } from '@/lib/guardrails.js';
import { createMockConfig, createMockTickState } from '../helpers/mocks.js';
import type { TickState } from '@/types/state.js';
import * as git from '@/lib/git.js';

// Mock git functions
vi.mock('@/lib/git.js', () => ({
  getCurrentBranch: vi.fn(),
  isWorktreeClean: vi.fn(),
}));

describe('F018: dirty_worktree', () => {
  let config: ReturnType<typeof createMockConfig>;
  let state: TickState;

  beforeEach(() => {
    vi.clearAllMocks();
    config = createMockConfig();
    // Default: worktree is clean
    vi.mocked(git.isWorktreeClean).mockReturnValue(true);
    vi.mocked(git.getCurrentBranch).mockReturnValue('task/wp-001');
  });

  it('should reject merge when worktree has uncommitted changes', () => {
    vi.mocked(git.isWorktreeClean).mockReturnValue(false);

    const result = checkWorktreeClean();

    expect(result.ok).toBe(false);
    expect(result.stopCode).toBe('STOP_MERGE_DIRTY_WORKTREE');
    expect(result.reason).toContain('uncommitted changes');
  });

  it('should pass when worktree is clean', () => {
    vi.mocked(git.isWorktreeClean).mockReturnValue(true);

    const result = checkWorktreeClean();

    expect(result.ok).toBe(true);
  });

  it('should reject merge eligibility when worktree is dirty', () => {
    vi.mocked(git.isWorktreeClean).mockReturnValue(false);

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
      git_diff_files: ['src/file1.ts', 'src/file2.ts'],
    };

    const eligibility = checkMergeEligibility(state, report);

    expect(eligibility.eligible).toBe(false);
    expect(eligibility.reasons.some(r => r.includes('uncommitted changes'))).toBe(true);
  });

  it('should pass merge eligibility when worktree is clean and other checks pass', () => {
    vi.mocked(git.isWorktreeClean).mockReturnValue(true);

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
      git_diff_files: ['src/file1.ts'],
    };

    const eligibility = checkMergeEligibility(state, report);

    expect(eligibility.eligible).toBe(true);
    expect(eligibility.reasons).toContain('All merge eligibility checks passed');
  });

  it('should include dirty worktree reason even if verify_history is missing', () => {
    vi.mocked(git.isWorktreeClean).mockReturnValue(false);

    state = createMockTickState(config, null, {
      verify_history: [],
    });

    const report = {
      git_diff_files: ['src/file1.ts'],
    };

    const eligibility = checkMergeEligibility(state, report);

    expect(eligibility.eligible).toBe(false);
    expect(eligibility.reasons.some(r => r.includes('uncommitted changes'))).toBe(true);
    // Should also include verify_history reason
    expect(eligibility.reasons).toContain('verify_history does not contain any PASS results');
  });
});
