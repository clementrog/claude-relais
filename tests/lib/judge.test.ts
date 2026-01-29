import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { parseGitDiffNameStatus, getTouchedFiles, checkScopeViolations } from '@/lib/judge.js';
import { execSync } from 'node:child_process';
import type { TaskScope } from '@/types/task.js';
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

  const defaultRunnerOwnedGlobs = ['pilot/**', 'relais.config.json'];

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
      modified: ['src/utils.ts', 'pilot/STATE.json'],
      added: [],
      deleted: [],
      renamed: [],
      untracked: [],
      all: ['src/utils.ts', 'pilot/STATE.json'],
    };

    const result = checkScopeViolations(touched, defaultTaskScope, defaultScopeConfig, defaultRunnerOwnedGlobs);

    expect(result.ok).toBe(false);
    expect(result.stopCode).toBe('STOP_RUNNER_OWNED_MUTATION');
    expect(result.violatingFiles).toEqual(['pilot/STATE.json']);
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
      modified: ['pilot/STATE.json', 'secret.key'],
      added: [],
      deleted: [],
      renamed: [],
      untracked: [],
      all: ['pilot/STATE.json', 'secret.key'],
    };

    const result = checkScopeViolations(touched, defaultTaskScope, defaultScopeConfig, defaultRunnerOwnedGlobs);

    expect(result.ok).toBe(false);
    expect(result.stopCode).toBe('STOP_RUNNER_OWNED_MUTATION');
    expect(result.violatingFiles).toEqual(['pilot/STATE.json']);
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
