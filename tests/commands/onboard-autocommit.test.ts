import { describe, it, expect } from 'vitest';
import { parseGitPorcelainPaths, isScaffoldOnlyInitialDirtyFiles } from '@/commands/onboard';

describe('onboard initial scaffold autocommit helpers', () => {
  it('parses git porcelain paths including renames', () => {
    const paths = parseGitPorcelainPaths(
      [
        '?? .gitignore',
        '?? envoi.config.json',
        '?? envoi/PRD.md',
        'R  old/name.ts -> envoi/new/name.ts',
      ].join('\n')
    );

    expect(paths).toEqual([
      '.gitignore',
      'envoi.config.json',
      'envoi/PRD.md',
      'envoi/new/name.ts',
    ]);
  });

  it('detects scaffold-only dirty file sets', () => {
    expect(
      isScaffoldOnlyInitialDirtyFiles(
        ['.gitignore', 'envoi.config.json', 'envoi/PRD.md', 'envoi/ROADMAP.json'],
        'envoi',
        'envoi.config.json'
      )
    ).toBe(true);

    expect(
      isScaffoldOnlyInitialDirtyFiles(
        ['.gitignore', 'envoi.config.json', 'src/index.ts'],
        'envoi',
        'envoi.config.json'
      )
    ).toBe(false);
  });
});
