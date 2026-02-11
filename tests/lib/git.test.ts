import { describe, it, expect } from 'vitest';
import { parseGitStatusWithExclusions } from '@/lib/git.js';

describe('parseGitStatusWithExclusions', () => {
  it('should return clean=true when git status is empty', () => {
    const result = parseGitStatusWithExclusions('', []);

    expect(result.clean).toBe(true);
    expect(result.dirtyFiles).toEqual([]);
    expect(result.excludedFiles).toEqual([]);
  });

  it('should return dirty files when no exclusions match', () => {
    const statusOutput = ' M src/file.ts\n?? src/new.ts\n';

    const result = parseGitStatusWithExclusions(statusOutput, []);

    expect(result.clean).toBe(false);
    expect(result.dirtyFiles).toContain('src/file.ts');
    expect(result.dirtyFiles).toContain('src/new.ts');
    expect(result.excludedFiles).toEqual([]);
  });

  it('should exclude files matching runner_owned_globs', () => {
    const statusOutput = ' M relais/REPORT.json\n M relais/STATE.json\n M src/file.ts\n';

    const result = parseGitStatusWithExclusions(statusOutput, ['relais/**']);

    expect(result.clean).toBe(false);
    expect(result.dirtyFiles).toEqual(['src/file.ts']);
    expect(result.excludedFiles).toContain('relais/REPORT.json');
    expect(result.excludedFiles).toContain('relais/STATE.json');
  });

  it('should return clean=true when all dirty files are excluded', () => {
    const statusOutput = ' M relais/REPORT.json\n M relais/STATE.json\n?? relais/history/run1.json\n';

    const result = parseGitStatusWithExclusions(statusOutput, ['relais/**']);

    expect(result.clean).toBe(true);
    expect(result.dirtyFiles).toEqual([]);
    expect(result.excludedFiles).toHaveLength(3);
  });

  it('should handle multiple exclusion patterns', () => {
    const statusOutput = ' M relais/REPORT.json\n M relais/STATE.json\n M src/file.ts\n';

    const result = parseGitStatusWithExclusions(statusOutput, ['relais/**', 'relais/**']);

    expect(result.clean).toBe(false);
    expect(result.dirtyFiles).toEqual(['src/file.ts']);
    expect(result.excludedFiles).toContain('relais/REPORT.json');
    expect(result.excludedFiles).toContain('relais/STATE.json');
  });

  it('should handle specific file patterns', () => {
    const statusOutput = ' M relais/REPORT.json\n M relais/schemas/task.schema.json\n';

    // Only exclude REPORT.json, not schemas
    const result = parseGitStatusWithExclusions(statusOutput, ['relais/REPORT.json', 'relais/STATE.json']);

    expect(result.clean).toBe(false);
    expect(result.dirtyFiles).toEqual(['relais/schemas/task.schema.json']);
    expect(result.excludedFiles).toEqual(['relais/REPORT.json']);
  });

  it('should handle renamed files', () => {
    const statusOutput = 'R  old.ts -> new.ts\n';

    const result = parseGitStatusWithExclusions(statusOutput, []);

    expect(result.clean).toBe(false);
    expect(result.dirtyFiles).toEqual(['new.ts']);
  });

  it('should handle various git status codes', () => {
    const statusOutput =
      'M  staged.ts\n' +
      ' M unstaged.ts\n' +
      'MM both.ts\n' +
      'A  added.ts\n' +
      '?? untracked.ts\n' +
      'D  deleted.ts\n';

    const result = parseGitStatusWithExclusions(statusOutput, []);

    expect(result.clean).toBe(false);
    expect(result.dirtyFiles).toContain('staged.ts');
    expect(result.dirtyFiles).toContain('unstaged.ts');
    expect(result.dirtyFiles).toContain('both.ts');
    expect(result.dirtyFiles).toContain('added.ts');
    expect(result.dirtyFiles).toContain('untracked.ts');
    expect(result.dirtyFiles).toContain('deleted.ts');
  });

  it('should handle whitespace-only output as clean', () => {
    const result = parseGitStatusWithExclusions('   \n  \n', []);

    expect(result.clean).toBe(true);
    expect(result.dirtyFiles).toEqual([]);
  });

  it('should handle paths with spaces', () => {
    const statusOutput = ' M src/my file.ts\n';

    const result = parseGitStatusWithExclusions(statusOutput, []);

    expect(result.clean).toBe(false);
    expect(result.dirtyFiles).toEqual(['src/my file.ts']);
  });
});
