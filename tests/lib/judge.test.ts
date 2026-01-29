import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { parseGitDiffNameStatus, getTouchedFiles } from '@/lib/judge.js';
import { execSync } from 'node:child_process';

// Mock execSync
vi.mock('node:child_process', () => ({
  execSync: vi.fn(),
}));

describe('parseGitDiffNameStatus', () => {
  it('should return empty arrays when output is empty', () => {
    const result = parseGitDiffNameStatus('');

    expect(result.modified).toEqual([]);
    expect(result.added).toEqual([]);
    expect(result.deleted).toEqual([]);
    expect(result.renamed).toEqual([]);
  });

  it('should parse modified files', () => {
    const output = 'M\tfile1.ts\nM\tfile2.ts\n';

    const result = parseGitDiffNameStatus(output);

    expect(result.modified).toEqual(['file1.ts', 'file2.ts']);
    expect(result.added).toEqual([]);
    expect(result.deleted).toEqual([]);
    expect(result.renamed).toEqual([]);
  });

  it('should parse added files', () => {
    const output = 'A\tnew-file.ts\n';

    const result = parseGitDiffNameStatus(output);

    expect(result.added).toEqual(['new-file.ts']);
    expect(result.modified).toEqual([]);
    expect(result.deleted).toEqual([]);
  });

  it('should parse deleted files', () => {
    const output = 'D\tdeleted-file.ts\n';

    const result = parseGitDiffNameStatus(output);

    expect(result.deleted).toEqual(['deleted-file.ts']);
    expect(result.modified).toEqual([]);
    expect(result.added).toEqual([]);
  });

  it('should parse renamed files with similarity score', () => {
    const output = 'R100\told.ts\tnew.ts\n';

    const result = parseGitDiffNameStatus(output);

    expect(result.renamed).toEqual([{ from: 'old.ts', to: 'new.ts' }]);
    expect(result.modified).toEqual([]);
  });

  it('should parse renamed files with low similarity score', () => {
    const output = 'R50\told.ts\tnew.ts\n';

    const result = parseGitDiffNameStatus(output);

    expect(result.renamed).toEqual([{ from: 'old.ts', to: 'new.ts' }]);
  });

  it('should parse multiple renamed files', () => {
    const output = 'R100\told1.ts\tnew1.ts\nR90\told2.ts\tnew2.ts\n';

    const result = parseGitDiffNameStatus(output);

    expect(result.renamed).toEqual([
      { from: 'old1.ts', to: 'new1.ts' },
      { from: 'old2.ts', to: 'new2.ts' },
    ]);
  });

  it('should parse mixed status codes', () => {
    const output = 'M\tmodified.ts\nA\tadded.ts\nD\tdeleted.ts\nR100\told.ts\tnew.ts\n';

    const result = parseGitDiffNameStatus(output);

    expect(result.modified).toEqual(['modified.ts']);
    expect(result.added).toEqual(['added.ts']);
    expect(result.deleted).toEqual(['deleted.ts']);
    expect(result.renamed).toEqual([{ from: 'old.ts', to: 'new.ts' }]);
  });

  it('should handle paths with spaces', () => {
    const output = 'M\tfile with spaces.ts\n';

    const result = parseGitDiffNameStatus(output);

    expect(result.modified).toEqual(['file with spaces.ts']);
  });

  it('should ignore invalid lines', () => {
    const output = 'M\tvalid.ts\ninvalid line\nA\talso-valid.ts\n';

    const result = parseGitDiffNameStatus(output);

    expect(result.modified).toEqual(['valid.ts']);
    expect(result.added).toEqual(['also-valid.ts']);
  });

  it('should handle whitespace-only output', () => {
    const result = parseGitDiffNameStatus('   \n  \n');

    expect(result.modified).toEqual([]);
    expect(result.added).toEqual([]);
    expect(result.deleted).toEqual([]);
    expect(result.renamed).toEqual([]);
  });
});

describe('getTouchedFiles', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should return categorized files from git diff and status', () => {
    const mockDiffOutput = 'M\tmodified.ts\nA\tadded.ts\nD\tdeleted.ts\nR100\told.ts\tnew.ts\n';
    const mockStatusOutput = ' M modified.ts\n?? untracked.ts\n';

    vi.mocked(execSync)
      .mockReturnValueOnce(mockDiffOutput) // git diff
      .mockReturnValueOnce(mockStatusOutput); // git status

    const result = getTouchedFiles('main');

    expect(result.modified).toEqual(['modified.ts']);
    expect(result.added).toEqual(['added.ts']);
    expect(result.deleted).toEqual(['deleted.ts']);
    expect(result.renamed).toEqual([{ from: 'old.ts', to: 'new.ts' }]);
    expect(result.untracked).toEqual(['untracked.ts']);
    expect(result.all).toEqual(['modified.ts', 'added.ts', 'new.ts', 'untracked.ts']);
  });

  it('should only include untracked files from git status', () => {
    const mockDiffOutput = 'M\tmodified.ts\n';
    const mockStatusOutput = ' M modified.ts\n?? untracked.ts\nA  staged.ts\n';

    vi.mocked(execSync)
      .mockReturnValueOnce(mockDiffOutput)
      .mockReturnValueOnce(mockStatusOutput);

    const result = getTouchedFiles('main');

    expect(result.untracked).toEqual(['untracked.ts']);
    expect(result.all).toContain('untracked.ts');
    expect(result.all).not.toContain('staged.ts'); // Not untracked
  });

  it('should compute all as union of modified, added, renamed.to, and untracked', () => {
    const mockDiffOutput = 'M\tmod.ts\nA\tadd.ts\nR100\told.ts\tnew.ts\n';
    const mockStatusOutput = '?? untracked.ts\n';

    vi.mocked(execSync)
      .mockReturnValueOnce(mockDiffOutput)
      .mockReturnValueOnce(mockStatusOutput);

    const result = getTouchedFiles('abc123');

    expect(result.all).toEqual(['mod.ts', 'add.ts', 'new.ts', 'untracked.ts']);
    expect(result.all).not.toContain('old.ts'); // Deleted/renamed from path not included
  });

  it('should exclude deleted files from all array', () => {
    const mockDiffOutput = 'M\tmod.ts\nD\tdeleted.ts\n';
    const mockStatusOutput = '';

    vi.mocked(execSync)
      .mockReturnValueOnce(mockDiffOutput)
      .mockReturnValueOnce(mockStatusOutput);

    const result = getTouchedFiles('main');

    expect(result.deleted).toEqual(['deleted.ts']);
    expect(result.all).toEqual(['mod.ts']);
    expect(result.all).not.toContain('deleted.ts');
  });

  it('should handle empty git diff output', () => {
    const mockDiffOutput = '';
    const mockStatusOutput = '?? untracked.ts\n';

    vi.mocked(execSync)
      .mockReturnValueOnce(mockDiffOutput)
      .mockReturnValueOnce(mockStatusOutput);

    const result = getTouchedFiles('main');

    expect(result.modified).toEqual([]);
    expect(result.added).toEqual([]);
    expect(result.deleted).toEqual([]);
    expect(result.renamed).toEqual([]);
    expect(result.untracked).toEqual(['untracked.ts']);
    expect(result.all).toEqual(['untracked.ts']);
  });

  it('should handle empty git status output', () => {
    const mockDiffOutput = 'M\tmodified.ts\n';
    const mockStatusOutput = '';

    vi.mocked(execSync)
      .mockReturnValueOnce(mockDiffOutput)
      .mockReturnValueOnce(mockStatusOutput);

    const result = getTouchedFiles('main');

    expect(result.modified).toEqual(['modified.ts']);
    expect(result.untracked).toEqual([]);
    expect(result.all).toEqual(['modified.ts']);
  });

  it('should throw error if git diff fails', () => {
    const error = new Error('git diff failed');
    vi.mocked(execSync).mockImplementationOnce(() => {
      throw error;
    });

    expect(() => getTouchedFiles('invalid-commit')).toThrow('Failed to get git diff from invalid-commit');
  });

  it('should continue if git status fails (untracked files are optional)', () => {
    const mockDiffOutput = 'M\tmodified.ts\n';

    vi.mocked(execSync)
      .mockReturnValueOnce(mockDiffOutput)
      .mockImplementationOnce(() => {
        throw new Error('git status failed');
      });

    const result = getTouchedFiles('main');

    expect(result.modified).toEqual(['modified.ts']);
    expect(result.untracked).toEqual([]);
    expect(result.all).toEqual(['modified.ts']);
  });

  it('should handle multiple untracked files', () => {
    const mockDiffOutput = '';
    const mockStatusOutput = '?? file1.ts\n?? file2.ts\n?? file3.ts\n';

    vi.mocked(execSync)
      .mockReturnValueOnce(mockDiffOutput)
      .mockReturnValueOnce(mockStatusOutput);

    const result = getTouchedFiles('main');

    expect(result.untracked).toEqual(['file1.ts', 'file2.ts', 'file3.ts']);
    expect(result.all).toEqual(['file1.ts', 'file2.ts', 'file3.ts']);
  });

  it('should handle renamed files in all array', () => {
    const mockDiffOutput = 'R100\told.ts\tnew.ts\n';
    const mockStatusOutput = '';

    vi.mocked(execSync)
      .mockReturnValueOnce(mockDiffOutput)
      .mockReturnValueOnce(mockStatusOutput);

    const result = getTouchedFiles('main');

    expect(result.renamed).toEqual([{ from: 'old.ts', to: 'new.ts' }]);
    expect(result.all).toEqual(['new.ts']);
    expect(result.all).not.toContain('old.ts');
  });
});
