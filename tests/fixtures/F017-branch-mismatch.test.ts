/**
 * F017: branch_mismatch
 * 
 * Verify that preflight rejects when current branch does not match STATE.branch.
 * Preflight checks run before verify commands to ensure we're on the correct branch.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { checkBranchMatch, runGuardrailPreflight } from '@/lib/guardrails.js';
import { createMockTask } from '../helpers/mocks.js';
import type { GuardrailState } from '@/lib/guardrails.js';
import * as git from '@/lib/git.js';

// Mock git functions
vi.mock('@/lib/git.js', () => ({
  getCurrentBranch: vi.fn(),
  isWorktreeClean: vi.fn(),
}));

describe('F017: branch_mismatch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: worktree is clean
    vi.mocked(git.isWorktreeClean).mockReturnValue(true);
  });

  it('should reject when current branch does not match STATE.branch', () => {
    vi.mocked(git.getCurrentBranch).mockReturnValue('main');
    
    const state: GuardrailState = { branch: 'task/wp-001' };
    const result = checkBranchMatch(state);

    expect(result.ok).toBe(false);
    expect(result.stopCode).toBe('STOP_BRANCH_MISMATCH');
    expect(result.reason).toContain("does not match expected branch");
    expect(result.reason).toContain('main');
    expect(result.reason).toContain('task/wp-001');
  });

  it('should pass when current branch matches STATE.branch', () => {
    vi.mocked(git.getCurrentBranch).mockReturnValue('task/wp-001');
    
    const state: GuardrailState = { branch: 'task/wp-001' };
    const result = checkBranchMatch(state);

    expect(result.ok).toBe(true);
  });

  it('should reject in runGuardrailPreflight when branch mismatch detected', () => {
    vi.mocked(git.getCurrentBranch).mockReturnValue('main');
    
    const state: GuardrailState = { branch: 'task/wp-001' };
    const task = createMockTask('execute');
    
    const result = runGuardrailPreflight(state, task);

    expect(result.ok).toBe(false);
    expect(result.stopCode).toBe('STOP_BRANCH_MISMATCH');
    expect(result.reason).toContain("does not match expected branch");
  });

  it('should fail when getCurrentBranch throws an error', () => {
    vi.mocked(git.getCurrentBranch).mockImplementation(() => {
      throw new Error('Git error: not a git repository');
    });
    
    const state: GuardrailState = { branch: 'task/wp-001' };
    const result = checkBranchMatch(state);

    expect(result.ok).toBe(false);
    expect(result.stopCode).toBe('STOP_BRANCH_MISMATCH');
    expect(result.reason).toContain('Failed to get current branch');
  });

  it('should check branch match first in preflight (before other checks)', () => {
    vi.mocked(git.getCurrentBranch).mockReturnValue('wrong-branch');
    // Even if worktree is dirty, branch check should fail first
    vi.mocked(git.isWorktreeClean).mockReturnValue(false);
    
    const state: GuardrailState = { branch: 'task/wp-001' };
    const task = createMockTask('execute');
    
    const result = runGuardrailPreflight(state, task);

    // Should fail on branch mismatch, not worktree
    expect(result.ok).toBe(false);
    expect(result.stopCode).toBe('STOP_BRANCH_MISMATCH');
    expect(result.reason).toContain('wrong-branch');
  });
});
