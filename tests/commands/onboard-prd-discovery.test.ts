import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { discoverLocalPrdCandidates } from '@/commands/onboard';

describe('onboard PRD discovery', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'relais-onboard-prd-'));
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it('returns candidates in deterministic priority order', async () => {
    await mkdir(join(testDir, 'docs'), { recursive: true });
    await writeFile(join(testDir, 'docs', 'PRD.md'), '# docs prd\n', 'utf-8');
    await writeFile(join(testDir, 'PRD.md'), '# root prd\n', 'utf-8');

    const result = await discoverLocalPrdCandidates(testDir);
    expect(result).toEqual([
      join(testDir, 'PRD.md'),
      join(testDir, 'docs', 'PRD.md'),
    ]);
  });

  it('ignores empty candidate files', async () => {
    await writeFile(join(testDir, 'PRD.md'), '\n\n', 'utf-8');
    const result = await discoverLocalPrdCandidates(testDir);
    expect(result).toEqual([]);
  });
});
