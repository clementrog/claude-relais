import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile, symlink, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execSync } from 'node:child_process';

import { runPreflight } from '@/lib/preflight.js';
import { createMockConfig } from '../helpers/mocks.js';

describe('preflight symlink safety', () => {
  const originalCwd = process.cwd();
  let rootDir = '';
  let repoDir = '';

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), 'relais-preflight-symlink-'));
    repoDir = join(rootDir, 'repo');
    await mkdir(repoDir, { recursive: true });

    process.chdir(repoDir);
    execSync('git init', { stdio: 'pipe' });
    execSync('git config user.email "test@example.com"', { stdio: 'pipe' });
    execSync('git config user.name "Test User"', { stdio: 'pipe' });
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    if (rootDir) {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it('blocks when a tracked symlink escapes repo root', async () => {
    const outsideFile = join(rootDir, 'outside.txt');
    await writeFile(outsideFile, 'outside', 'utf-8');
    await symlink('../outside.txt', join(repoDir, 'escape-link'));
    execSync('git add escape-link', { stdio: 'pipe' });
    execSync('git commit -m "add escaping symlink"', { stdio: 'pipe' });

    const config = createMockConfig({
      workspace_dir: 'relais',
    } as any);
    const result = await runPreflight(config as any);

    expect(result.ok).toBe(false);
    expect(result.blocked_code).toBe('BLOCKED_MISSING_CONFIG');
    expect(result.blocked_reason).toContain('Unsafe tracked symlink');
  });
});
