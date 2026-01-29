import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { rollbackToCommit, verifyCleanWorktree } from '@/lib/rollback.js';
import { execSync } from 'node:child_process';
import { unlinkSync, rmSync, statSync } from 'node:fs';

// Mock execSync
vi.mock('node:child_process', () => ({
  execSync: vi.fn(),
}));

// Mock fs sync functions
vi.mock('node:fs', async () => {
  const actual = await vi.importActual('node:fs');
  return {
    ...actual,
    unlinkSync: vi.fn(),
    rmSync: vi.fn(),
    statSync: vi.fn(),
  };
});

describe('rollbackToCommit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should successfully rollback to base commit and remove untracked files', () => {
    const baseCommit = 'abc123';
    const untrackedFiles = ['temp.txt', 'build/'];

    // Mock statSync to return file stats
    vi.mocked(statSync).mockReturnValue({
      isDirectory: () => false,
    } as any);

    // Mock execSync for git reset
    vi.mocked(execSync).mockReturnValue('');

    const result = rollbackToCommit(baseCommit, untrackedFiles);

    expect(result.ok).toBe(true);
    expect(result.restoredCommit).toBe(baseCommit);
    expect(result.removedFiles).toEqual(untrackedFiles);
    expect(result.error).toBeNull();
    expect(execSync).toHaveBeenCalledWith(`git reset --hard ${baseCommit}`, expect.any(Object));
    expect(unlinkSync).toHaveBeenCalledTimes(2);
  });

  it('should handle directories correctly', () => {
    const baseCommit = 'abc123';
    const untrackedFiles = ['build/', 'dist/'];

    // Mock statSync to return directory stats
    vi.mocked(statSync).mockReturnValue({
      isDirectory: () => true,
    } as any);

    vi.mocked(execSync).mockReturnValue('');

    const result = rollbackToCommit(baseCommit, untrackedFiles);

    expect(result.ok).toBe(true);
    expect(result.restoredCommit).toBe(baseCommit);
    expect(result.removedFiles).toEqual(untrackedFiles);
    expect(rmSync).toHaveBeenCalledTimes(2);
    expect(rmSync).toHaveBeenCalledWith('build/', { recursive: true, force: true });
    expect(rmSync).toHaveBeenCalledWith('dist/', { recursive: true, force: true });
  });

  it('should handle empty untracked files array', () => {
    const baseCommit = 'abc123';

    vi.mocked(execSync).mockReturnValue('');

    const result = rollbackToCommit(baseCommit, []);

    expect(result.ok).toBe(true);
    expect(result.restoredCommit).toBe(baseCommit);
    expect(result.removedFiles).toEqual([]);
    expect(result.error).toBeNull();
    expect(execSync).toHaveBeenCalledWith(`git reset --hard ${baseCommit}`, expect.any(Object));
  });

  it('should handle git reset failure', () => {
    const baseCommit = 'abc123';
    const error = new Error('git reset failed');

    vi.mocked(execSync).mockImplementation(() => {
      throw error;
    });

    const result = rollbackToCommit(baseCommit, []);

    expect(result.ok).toBe(false);
    expect(result.restoredCommit).toBe(baseCommit);
    expect(result.removedFiles).toEqual([]);
    expect(result.error).toContain('Failed to rollback');
    expect(result.error).toContain('git reset failed');
  });

  it('should handle file removal errors gracefully', () => {
    const baseCommit = 'abc123';
    const untrackedFiles = ['temp.txt', 'build/'];

    vi.mocked(execSync).mockReturnValue('');
    vi.mocked(statSync).mockReturnValue({
      isDirectory: () => false,
    } as any);

    // Mock unlinkSync to throw an error for the first file
    vi.mocked(unlinkSync).mockImplementation((path: string) => {
      if (path === 'temp.txt') {
        const err = new Error('Permission denied') as any;
        err.code = 'EACCES';
        throw err;
      }
    });

    const result = rollbackToCommit(baseCommit, untrackedFiles);

    // Should still succeed but report error
    expect(result.ok).toBe(false);
    expect(result.restoredCommit).toBe(baseCommit);
    expect(result.removedFiles).toContain('build/');
    expect(result.error).toContain('Failed to remove');
  });

  it('should ignore ENOENT errors (file not found)', () => {
    const baseCommit = 'abc123';
    const untrackedFiles = ['temp.txt'];

    vi.mocked(execSync).mockReturnValue('');
    vi.mocked(statSync).mockReturnValue({
      isDirectory: () => false,
    } as any);

    // Mock unlinkSync to throw ENOENT error
    vi.mocked(unlinkSync).mockImplementation(() => {
      const err = new Error('File not found') as any;
      err.code = 'ENOENT';
      throw err;
    });

    const result = rollbackToCommit(baseCommit, untrackedFiles);

    // Should succeed (ENOENT is acceptable - file already removed)
    expect(result.ok).toBe(true);
    expect(result.restoredCommit).toBe(baseCommit);
    expect(result.removedFiles).toEqual([]); // File wasn't actually removed
    expect(result.error).toBeNull();
  });

  it('should use default empty array when untrackedToRemove is not provided', () => {
    const baseCommit = 'abc123';

    vi.mocked(execSync).mockReturnValue('');

    const result = rollbackToCommit(baseCommit);

    expect(result.ok).toBe(true);
    expect(result.restoredCommit).toBe(baseCommit);
    expect(result.removedFiles).toEqual([]);
    expect(result.error).toBeNull();
  });
});

describe('verifyCleanWorktree', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should return true when worktree is clean', () => {
    // Mock git diff --exit-code to succeed (no changes)
    vi.mocked(execSync).mockImplementation((command: string) => {
      if (command === 'git diff --exit-code') {
        return '';
      }
      if (command === 'git status --porcelain') {
        return ''; // Empty status = clean
      }
      return '';
    });

    const result = verifyCleanWorktree();

    expect(result).toBe(true);
    expect(execSync).toHaveBeenCalledWith('git diff --exit-code', expect.any(Object));
    expect(execSync).toHaveBeenCalledWith('git status --porcelain', expect.any(Object));
  });

  it('should return false when there are uncommitted tracked changes', () => {
    vi.mocked(execSync).mockImplementation((command: string) => {
      if (command === 'git diff --exit-code') {
        // git diff --exit-code exits with non-zero when there are changes
        const error = new Error('Command failed') as any;
        error.status = 1;
        throw error;
      }
      if (command === 'git status --porcelain') {
        return '';
      }
      return '';
    });

    const result = verifyCleanWorktree();

    expect(result).toBe(false);
  });

  it('should return false when there are untracked files', () => {
    vi.mocked(execSync).mockImplementation((command: string) => {
      if (command === 'git diff --exit-code') {
        return '';
      }
      if (command === 'git status --porcelain') {
        return '?? untracked.txt\n'; // Untracked file
      }
      return '';
    });

    const result = verifyCleanWorktree();

    expect(result).toBe(false);
  });

  it('should return false when git diff command fails', () => {
    vi.mocked(execSync).mockImplementation(() => {
      throw new Error('git command failed');
    });

    const result = verifyCleanWorktree();

    expect(result).toBe(false);
  });

  it('should return false when git status command fails', () => {
    vi.mocked(execSync).mockImplementation((command: string) => {
      if (command === 'git diff --exit-code') {
        return '';
      }
      if (command === 'git status --porcelain') {
        throw new Error('git status failed');
      }
      return '';
    });

    const result = verifyCleanWorktree();

    expect(result).toBe(false);
  });

  it('should handle whitespace-only status output as clean', () => {
    vi.mocked(execSync).mockImplementation((command: string) => {
      if (command === 'git diff --exit-code') {
        return '';
      }
      if (command === 'git status --porcelain') {
        return '   \n  \n'; // Whitespace only
      }
      return '';
    });

    const result = verifyCleanWorktree();

    expect(result).toBe(true);
  });
});
