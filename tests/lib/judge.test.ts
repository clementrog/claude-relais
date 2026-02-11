import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  parseGitDiffNameStatus,
  getTouchedFiles,
  checkScopeViolations,
  parseGitDiffStat,
  computeBlastRadius,
  checkDiffLimits,
  checkHeadMoved,
} from '@/lib/judge.js';
import { execSync } from 'node:child_process';
import type { TaskScope, DiffLimits } from '@/types/task.js';
import type { ScopeConfig } from '@/types/config.js';

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

describe('checkScopeViolations', () => {
  const defaultTaskScope: TaskScope = {
    allowed_globs: ['src/**'],
    forbidden_globs: ['*.key', '*.pem'],
    allow_new_files: true,
    allow_lockfile_changes: true,
  };

  const defaultScopeConfig: ScopeConfig = {
    lockfiles: ['package-lock.json', 'yarn.lock'],
    default_allowed_globs: [],
    default_forbidden_globs: [],
    default_allow_new_files: true,
    default_allow_lockfile_changes: false,
  };

  const defaultRunnerOwnedGlobs = ['relais/**', 'relais.config.json'];

  it('should return ok=true when no violations', () => {
    const touched = {
      modified: ['src/utils.ts'],
      added: ['src/new.ts'],
      deleted: [],
      renamed: [],
      untracked: ['src/new.ts'],
      all: ['src/utils.ts', 'src/new.ts'],
    };

    const result = checkScopeViolations(touched, defaultTaskScope, defaultScopeConfig, defaultRunnerOwnedGlobs);

    expect(result.ok).toBe(true);
    expect(result.stopCode).toBeNull();
    expect(result.violatingFiles).toEqual([]);
    expect(result.reason).toBeNull();
  });

  it('should detect STOP_RUNNER_OWNED_MUTATION (highest priority)', () => {
    const touched = {
      modified: ['src/utils.ts', 'relais/STATE.json'],
      added: [],
      deleted: [],
      renamed: [],
      untracked: [],
      all: ['src/utils.ts', 'relais/STATE.json'],
    };

    const result = checkScopeViolations(touched, defaultTaskScope, defaultScopeConfig, defaultRunnerOwnedGlobs);

    expect(result.ok).toBe(false);
    expect(result.stopCode).toBe('STOP_RUNNER_OWNED_MUTATION');
    expect(result.violatingFiles).toEqual(['relais/STATE.json']);
    expect(result.reason).toContain('runner-owned globs');
  });

  it('should detect STOP_SCOPE_VIOLATION_FORBIDDEN', () => {
    const touched = {
      modified: ['src/utils.ts', 'secret.key'],
      added: [],
      deleted: [],
      renamed: [],
      untracked: [],
      all: ['src/utils.ts', 'secret.key'],
    };

    const result = checkScopeViolations(touched, defaultTaskScope, defaultScopeConfig, defaultRunnerOwnedGlobs);

    expect(result.ok).toBe(false);
    expect(result.stopCode).toBe('STOP_SCOPE_VIOLATION_FORBIDDEN');
    expect(result.violatingFiles).toEqual(['secret.key']);
    expect(result.reason).toContain('forbidden glob');
  });

  it('should detect STOP_SCOPE_VIOLATION_OUTSIDE_ALLOWED', () => {
    const touched = {
      modified: ['src/utils.ts', 'other/file.ts'],
      added: [],
      deleted: [],
      renamed: [],
      untracked: [],
      all: ['src/utils.ts', 'other/file.ts'],
    };

    const result = checkScopeViolations(touched, defaultTaskScope, defaultScopeConfig, defaultRunnerOwnedGlobs);

    expect(result.ok).toBe(false);
    expect(result.stopCode).toBe('STOP_SCOPE_VIOLATION_OUTSIDE_ALLOWED');
    expect(result.violatingFiles).toEqual(['other/file.ts']);
    expect(result.reason).toContain('allowed glob');
  });

  it('should not check allowed globs when allowed_globs is empty', () => {
    const taskScope: TaskScope = {
      allowed_globs: [],
      forbidden_globs: [],
      allow_new_files: true,
      allow_lockfile_changes: true,
    };

    const touched = {
      modified: ['any/file.ts'],
      added: [],
      deleted: [],
      renamed: [],
      untracked: [],
      all: ['any/file.ts'],
    };

    const result = checkScopeViolations(touched, taskScope, defaultScopeConfig, defaultRunnerOwnedGlobs);

    expect(result.ok).toBe(true);
  });

  it('should detect STOP_SCOPE_VIOLATION_NEW_FILE', () => {
    const taskScope: TaskScope = {
      ...defaultTaskScope,
      allow_new_files: false,
    };

    const touched = {
      modified: ['src/utils.ts'],
      added: ['src/new.ts'],
      deleted: [],
      renamed: [],
      untracked: ['src/new.ts'],
      all: ['src/utils.ts', 'src/new.ts'],
    };

    const result = checkScopeViolations(touched, taskScope, defaultScopeConfig, defaultRunnerOwnedGlobs);

    expect(result.ok).toBe(false);
    expect(result.stopCode).toBe('STOP_SCOPE_VIOLATION_NEW_FILE');
    expect(result.violatingFiles).toEqual(['src/new.ts']);
    expect(result.reason).toContain('allow_new_files is false');
  });

  it('should detect new files from renamed files', () => {
    const taskScope: TaskScope = {
      allowed_globs: ['src/**', 'new.ts'],
      forbidden_globs: [],
      allow_new_files: false,
      allow_lockfile_changes: true,
    };

    const touched = {
      modified: [],
      added: [],
      deleted: [],
      renamed: [{ from: 'old.ts', to: 'new.ts' }],
      untracked: [],
      all: ['new.ts'],
    };

    const result = checkScopeViolations(touched, taskScope, defaultScopeConfig, defaultRunnerOwnedGlobs);

    expect(result.ok).toBe(false);
    expect(result.stopCode).toBe('STOP_SCOPE_VIOLATION_NEW_FILE');
    expect(result.violatingFiles).toEqual(['new.ts']);
  });

  it('should detect STOP_LOCKFILE_CHANGE_FORBIDDEN', () => {
    const taskScope: TaskScope = {
      allowed_globs: ['src/**', 'package-lock.json'],
      forbidden_globs: [],
      allow_new_files: true,
      allow_lockfile_changes: false,
    };

    const touched = {
      modified: ['src/utils.ts', 'package-lock.json'],
      added: [],
      deleted: [],
      renamed: [],
      untracked: [],
      all: ['src/utils.ts', 'package-lock.json'],
    };

    const result = checkScopeViolations(touched, taskScope, defaultScopeConfig, defaultRunnerOwnedGlobs);

    expect(result.ok).toBe(false);
    expect(result.stopCode).toBe('STOP_LOCKFILE_CHANGE_FORBIDDEN');
    expect(result.violatingFiles).toEqual(['package-lock.json']);
    expect(result.reason).toContain('allow_lockfile_changes is false');
  });

  it('should check priority order - runner-owned takes precedence over forbidden', () => {
    const touched = {
      modified: ['relais/STATE.json', 'secret.key'],
      added: [],
      deleted: [],
      renamed: [],
      untracked: [],
      all: ['relais/STATE.json', 'secret.key'],
    };

    const result = checkScopeViolations(touched, defaultTaskScope, defaultScopeConfig, defaultRunnerOwnedGlobs);

    expect(result.ok).toBe(false);
    expect(result.stopCode).toBe('STOP_RUNNER_OWNED_MUTATION');
    expect(result.violatingFiles).toEqual(['relais/STATE.json']);
  });

  it('should return multiple violating files for same violation type', () => {
    const touched = {
      modified: ['secret1.key', 'secret2.key'],
      added: [],
      deleted: [],
      renamed: [],
      untracked: [],
      all: ['secret1.key', 'secret2.key'],
    };

    const result = checkScopeViolations(touched, defaultTaskScope, defaultScopeConfig, defaultRunnerOwnedGlobs);

    expect(result.ok).toBe(false);
    expect(result.stopCode).toBe('STOP_SCOPE_VIOLATION_FORBIDDEN');
    expect(result.violatingFiles).toEqual(['secret1.key', 'secret2.key']);
  });

  it('should handle empty touched files', () => {
    const touched = {
      modified: [],
      added: [],
      deleted: [],
      renamed: [],
      untracked: [],
      all: [],
    };

    const result = checkScopeViolations(touched, defaultTaskScope, defaultScopeConfig, defaultRunnerOwnedGlobs);

    expect(result.ok).toBe(true);
    expect(result.stopCode).toBeNull();
    expect(result.violatingFiles).toEqual([]);
  });

  it('should handle lockfile glob patterns', () => {
    const scopeConfig: ScopeConfig = {
      ...defaultScopeConfig,
      lockfiles: ['**/package-lock.json', 'yarn.lock'],
    };

    const taskScope: TaskScope = {
      allowed_globs: ['**/package-lock.json'],
      forbidden_globs: [],
      allow_new_files: true,
      allow_lockfile_changes: false,
    };

    const touched = {
      modified: ['subdir/package-lock.json'],
      added: [],
      deleted: [],
      renamed: [],
      untracked: [],
      all: ['subdir/package-lock.json'],
    };

    const result = checkScopeViolations(touched, taskScope, scopeConfig, defaultRunnerOwnedGlobs);

    expect(result.ok).toBe(false);
    expect(result.stopCode).toBe('STOP_LOCKFILE_CHANGE_FORBIDDEN');
    expect(result.violatingFiles).toEqual(['subdir/package-lock.json']);
  });
});

describe('parseGitDiffStat', () => {
  it('should return zeros when output is empty', () => {
    const result = parseGitDiffStat('');

    expect(result.linesAdded).toBe(0);
    expect(result.linesDeleted).toBe(0);
  });

  it('should parse summary line with insertions and deletions', () => {
    const output = ' file1.ts | 5 +++++\n file2.ts | 3 ---\n 2 files changed, 5 insertions(+), 3 deletions(-)';

    const result = parseGitDiffStat(output);

    expect(result.linesAdded).toBe(5);
    expect(result.linesDeleted).toBe(3);
  });

  it('should parse summary line with only insertions', () => {
    const output = ' file1.ts | 10 ++++++++++\n 1 file changed, 10 insertions(+)';

    const result = parseGitDiffStat(output);

    expect(result.linesAdded).toBe(10);
    expect(result.linesDeleted).toBe(0);
  });

  it('should parse summary line with only deletions', () => {
    const output = ' file1.ts | 7 -------\n 1 file changed, 7 deletions(-)';

    const result = parseGitDiffStat(output);

    expect(result.linesAdded).toBe(0);
    expect(result.linesDeleted).toBe(7);
  });

  it('should parse summary line with multiple files', () => {
    const output =
      ' file1.ts | 5 +++++\n file2.ts | 10 ++++++++++\n file3.ts | 3 ---\n 3 files changed, 15 insertions(+), 3 deletions(-)';

    const result = parseGitDiffStat(output);

    expect(result.linesAdded).toBe(15);
    expect(result.linesDeleted).toBe(3);
  });

  it('should handle singular forms (insertion/deletion)', () => {
    const output = ' file1.ts | 1 +\n 1 file changed, 1 insertion(+), 1 deletion(-)';

    const result = parseGitDiffStat(output);

    expect(result.linesAdded).toBe(1);
    expect(result.linesDeleted).toBe(1);
  });

  it('should return zeros when summary line is missing', () => {
    const output = ' file1.ts | 5 +++++\n file2.ts | 3 ---';

    const result = parseGitDiffStat(output);

    expect(result.linesAdded).toBe(0);
    expect(result.linesDeleted).toBe(0);
  });

  it('should handle whitespace-only output', () => {
    const result = parseGitDiffStat('   \n  \n');

    expect(result.linesAdded).toBe(0);
    expect(result.linesDeleted).toBe(0);
  });
});

describe('computeBlastRadius', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should compute blast radius from git diff and touched files', () => {
    const mockDiffStatOutput = ' file1.ts | 5 +++++\n file2.ts | 3 ---\n 2 files changed, 5 insertions(+), 3 deletions(-)';
    const touched: ReturnType<typeof getTouchedFiles> = {
      modified: ['file1.ts'],
      added: ['file2.ts'],
      deleted: [],
      renamed: [],
      untracked: [],
      all: ['file1.ts', 'file2.ts'],
    };

    vi.mocked(execSync).mockReturnValueOnce(mockDiffStatOutput);

    const result = computeBlastRadius('main', touched);

    expect(result.files_touched).toBe(2);
    expect(result.lines_added).toBe(5);
    expect(result.lines_deleted).toBe(3);
    expect(result.new_files).toBe(1); // file2.ts is added
  });

  it('should count new files correctly (added + untracked + renamed)', () => {
    const mockDiffStatOutput = ' file1.ts | 10 ++++++++++\n 1 file changed, 10 insertions(+)';
    const touched: ReturnType<typeof getTouchedFiles> = {
      modified: [],
      added: ['file1.ts'],
      deleted: [],
      renamed: [{ from: 'old.ts', to: 'new.ts' }],
      untracked: ['untracked.ts'],
      all: ['file1.ts', 'new.ts', 'untracked.ts'],
    };

    vi.mocked(execSync).mockReturnValueOnce(mockDiffStatOutput);

    const result = computeBlastRadius('main', touched);

    expect(result.files_touched).toBe(3);
    expect(result.new_files).toBe(3); // file1.ts (added) + new.ts (renamed.to) + untracked.ts
  });

  it('should handle empty touched files', () => {
    const mockDiffStatOutput = '';
    const touched: ReturnType<typeof getTouchedFiles> = {
      modified: [],
      added: [],
      deleted: [],
      renamed: [],
      untracked: [],
      all: [],
    };

    vi.mocked(execSync).mockReturnValueOnce(mockDiffStatOutput);

    const result = computeBlastRadius('main', touched);

    expect(result.files_touched).toBe(0);
    expect(result.lines_added).toBe(0);
    expect(result.lines_deleted).toBe(0);
    expect(result.new_files).toBe(0);
  });

  it('should throw error if git diff --stat fails', () => {
    const touched: ReturnType<typeof getTouchedFiles> = {
      modified: ['file1.ts'],
      added: [],
      deleted: [],
      renamed: [],
      untracked: [],
      all: ['file1.ts'],
    };

    const error = new Error('git diff --stat failed');
    vi.mocked(execSync).mockImplementationOnce(() => {
      throw error;
    });

    expect(() => computeBlastRadius('invalid-commit', touched)).toThrow(
      'Failed to get git diff --stat from invalid-commit'
    );
  });
});

describe('checkDiffLimits', () => {
  it('should return ok=true when within limits', () => {
    const blastRadius = {
      files_touched: 5,
      lines_added: 50,
      lines_deleted: 10,
      new_files: 2,
    };
    const limits: DiffLimits = {
      max_files_touched: 10,
      max_lines_changed: 100,
    };

    const result = checkDiffLimits(blastRadius, limits);

    expect(result.ok).toBe(true);
    expect(result.stopCode).toBeNull();
    expect(result.reason).toBeNull();
    expect(result.blastRadius).toEqual(blastRadius);
  });

  it('should return STOP_DIFF_TOO_LARGE when files_touched exceeds limit', () => {
    const blastRadius = {
      files_touched: 15,
      lines_added: 50,
      lines_deleted: 10,
      new_files: 2,
    };
    const limits: DiffLimits = {
      max_files_touched: 10,
      max_lines_changed: 100,
    };

    const result = checkDiffLimits(blastRadius, limits);

    expect(result.ok).toBe(false);
    expect(result.stopCode).toBe('STOP_DIFF_TOO_LARGE');
    expect(result.reason).toContain('files_touched (15) exceeds max_files_touched (10)');
    expect(result.blastRadius).toEqual(blastRadius);
  });

  it('should return STOP_DIFF_TOO_LARGE when lines_changed exceeds limit', () => {
    const blastRadius = {
      files_touched: 5,
      lines_added: 80,
      lines_deleted: 30,
      new_files: 2,
    };
    const limits: DiffLimits = {
      max_files_touched: 10,
      max_lines_changed: 100,
    };

    const result = checkDiffLimits(blastRadius, limits);

    expect(result.ok).toBe(false);
    expect(result.stopCode).toBe('STOP_DIFF_TOO_LARGE');
    expect(result.reason).toContain('lines_changed (110) exceeds max_lines_changed (100)');
    expect(result.blastRadius).toEqual(blastRadius);
  });

  it('should return STOP_DIFF_TOO_LARGE when both limits exceeded', () => {
    const blastRadius = {
      files_touched: 15,
      lines_added: 80,
      lines_deleted: 30,
      new_files: 2,
    };
    const limits: DiffLimits = {
      max_files_touched: 10,
      max_lines_changed: 100,
    };

    const result = checkDiffLimits(blastRadius, limits);

    expect(result.ok).toBe(false);
    expect(result.stopCode).toBe('STOP_DIFF_TOO_LARGE');
    expect(result.reason).toContain('files_touched (15) exceeds max_files_touched (10)');
    expect(result.reason).toContain('lines_changed (110) exceeds max_lines_changed (100)');
    expect(result.blastRadius).toEqual(blastRadius);
  });

  it('should handle edge case: exactly at limits', () => {
    const blastRadius = {
      files_touched: 10,
      lines_added: 50,
      lines_deleted: 50,
      new_files: 2,
    };
    const limits: DiffLimits = {
      max_files_touched: 10,
      max_lines_changed: 100,
    };

    const result = checkDiffLimits(blastRadius, limits);

    expect(result.ok).toBe(true);
    expect(result.stopCode).toBeNull();
  });

  it('should handle zero limits', () => {
    const blastRadius = {
      files_touched: 1,
      lines_added: 1,
      lines_deleted: 0,
      new_files: 1,
    };
    const limits: DiffLimits = {
      max_files_touched: 0,
      max_lines_changed: 0,
    };

    const result = checkDiffLimits(blastRadius, limits);

    expect(result.ok).toBe(false);
    expect(result.stopCode).toBe('STOP_DIFF_TOO_LARGE');
  });
});

describe('checkHeadMoved', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should return ok when HEAD unchanged (HEAD === expectedBaseCommit)', () => {
    const expectedBase = 'abc123def456';
    vi.mocked(execSync).mockReturnValueOnce(expectedBase + '\n');

    const result = checkHeadMoved(expectedBase);

    expect(result.ok).toBe(true);
    expect(result.stopCode).toBeNull();
    expect(result.expectedHead).toBe(expectedBase);
    expect(result.actualHead).toBe(expectedBase);
    expect(result.reason).toBeNull();
    expect(execSync).toHaveBeenCalledTimes(1);
    expect(execSync).toHaveBeenCalledWith('git rev-parse HEAD', expect.any(Object));
  });

  it('should return ok when HEAD is descendant of base (builder made commits)', () => {
    const expectedBase = 'abc123';
    const actualHead = 'def456';
    vi.mocked(execSync)
      .mockReturnValueOnce(actualHead + '\n')
      .mockReturnValueOnce(''); // merge-base --is-ancestor succeeds (no output, exit 0)

    const result = checkHeadMoved(expectedBase);

    expect(result.ok).toBe(true);
    expect(result.stopCode).toBeNull();
    expect(result.expectedHead).toBe(expectedBase);
    expect(result.actualHead).toBe(actualHead);
    expect(result.reason).toBeNull();
    expect(execSync).toHaveBeenCalledTimes(2);
    expect(execSync).toHaveBeenNthCalledWith(1, 'git rev-parse HEAD', expect.any(Object));
    expect(execSync).toHaveBeenNthCalledWith(
      2,
      `git merge-base --is-ancestor ${expectedBase} HEAD`,
      expect.any(Object)
    );
  });

  it('should return STOP_HEAD_MOVED when HEAD moved externally', () => {
    const expectedBase = 'abc123';
    const actualHead = 'other789';
    vi.mocked(execSync)
      .mockReturnValueOnce(actualHead + '\n')
      .mockImplementationOnce(() => {
        throw new Error('merge-base failed');
      });

    const result = checkHeadMoved(expectedBase);

    expect(result.ok).toBe(false);
    expect(result.stopCode).toBe('STOP_HEAD_MOVED');
    expect(result.expectedHead).toBe(expectedBase);
    expect(result.actualHead).toBe(actualHead);
    expect(result.reason).toContain('HEAD moved externally');
    expect(result.reason).toContain(expectedBase);
    expect(result.reason).toContain(actualHead);
  });

  it('should return STOP_HEAD_MOVED when git rev-parse fails', () => {
    const expectedBase = 'abc123';
    vi.mocked(execSync).mockImplementationOnce(() => {
      throw new Error('not a git repository');
    });

    const result = checkHeadMoved(expectedBase);

    expect(result.ok).toBe(false);
    expect(result.stopCode).toBe('STOP_HEAD_MOVED');
    expect(result.expectedHead).toBe(expectedBase);
    expect(result.actualHead).toBe('');
    expect(result.reason).toContain('Failed to get current HEAD');
  });
});
