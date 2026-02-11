import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { initCommand } from '@/commands/init';
import { mkdir, rm, readFile, access, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execSync } from 'node:child_process';

describe('initCommand - repo root awareness', () => {
  let testDir: string;
  let originalCwd: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), `relais-init-repo-root-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(testDir, { recursive: true });
    originalCwd = process.cwd();
    process.chdir(testDir);
    
    // Initialize git repo (may fail in some environments, tests will handle gracefully)
    try {
      execSync('git init', { stdio: 'pipe', cwd: testDir });
      execSync('git config user.email "test@example.com"', { stdio: 'pipe', cwd: testDir });
      execSync('git config user.name "Test User"', { stdio: 'pipe', cwd: testDir });
    } catch {
      // Git init may fail in some test environments, but we can still test non-git scenarios
    }
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    try {
      await rm(testDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  async function fileExists(path: string): Promise<boolean> {
    try {
      await access(path);
      return true;
    } catch {
      return false;
    }
  }

  it('should create workspace and config at repo root when invoked from subdirectory', async () => {
    // Ensure git repo exists - try to initialize if needed
    if (!(await fileExists(join(testDir, '.git')))) {
      try {
        execSync('git init', { stdio: 'pipe', cwd: testDir });
        execSync('git config user.email "test@example.com"', { stdio: 'pipe', cwd: testDir });
        execSync('git config user.name "Test User"', { stdio: 'pipe', cwd: testDir });
      } catch (error) {
        // If git init fails (e.g., permission issues), skip this test
        // This can happen in some CI/test environments
        return;
      }
    }

    // Verify git repo exists before proceeding
    if (!(await fileExists(join(testDir, '.git')))) {
      return; // Skip test if git repo still doesn't exist
    }

    // Create a subdirectory
    const subdir = join(testDir, 'subdir');
    await mkdir(subdir, { recursive: true });
    process.chdir(subdir);

    await initCommand();

    // Verify workspace and config are at repo root, not subdir
    expect(await fileExists(join(testDir, 'envoi'))).toBe(true);
    expect(await fileExists(join(testDir, 'envoi/STATE.json'))).toBe(true);
    expect(await fileExists(join(testDir, 'envoi.config.json'))).toBe(true);
    
    // Verify they are NOT in subdir
    expect(await fileExists(join(subdir, 'envoi'))).toBe(false);
    expect(await fileExists(join(subdir, 'envoi.config.json'))).toBe(false);
  });

  it('should use current directory when not in git repo', async () => {
    // Remove git repo
    await rm(join(testDir, '.git'), { recursive: true, force: true });
    
    // Create a subdirectory
    const subdir = join(testDir, 'subdir');
    await mkdir(subdir, { recursive: true });
    process.chdir(subdir);

    await initCommand();

    // Verify workspace and config are in subdir (current directory)
    expect(await fileExists(join(subdir, 'envoi'))).toBe(true);
    expect(await fileExists(join(subdir, 'envoi/STATE.json'))).toBe(true);
    expect(await fileExists(join(subdir, 'envoi.config.json'))).toBe(true);
  });

  it('should detect pnpm and use non-workspace templates when pnpm-lock.yaml exists but no pnpm-workspace.yaml', async () => {
    // Ensure we're in testDir (not a subdir) for this test
    process.chdir(testDir);
    
    // Create pnpm-lock.yaml but no pnpm-workspace.yaml
    await writeFile(join(testDir, 'pnpm-lock.yaml'), 'lockfileVersion: 5.4\n');

    await initCommand();

    const configPath = join(testDir, 'envoi.config.json');
    const config = JSON.parse(await readFile(configPath, 'utf-8'));

    // Verify templates use pnpm without -w flag
    const lintTemplate = config.verification.templates.find((t: { id: string }) => t.id === 'lint');
    expect(lintTemplate).toBeDefined();
    expect(lintTemplate.cmd).toBe('pnpm');
    expect(lintTemplate.args).not.toContain('-w');
    expect(lintTemplate.args).toEqual(['lint']);
  });

  it('should detect pnpm workspace and use -w flag when pnpm-workspace.yaml exists', async () => {
    // Ensure we're in testDir (not a subdir) for this test
    process.chdir(testDir);
    
    // Create both pnpm-lock.yaml and pnpm-workspace.yaml
    await writeFile(join(testDir, 'pnpm-lock.yaml'), 'lockfileVersion: 5.4\n');
    await writeFile(join(testDir, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n');

    await initCommand();

    const configPath = join(testDir, 'envoi.config.json');
    const config = JSON.parse(await readFile(configPath, 'utf-8'));

    // Verify templates use pnpm with -w flag
    const lintTemplate = config.verification.templates.find((t: { id: string }) => t.id === 'lint');
    expect(lintTemplate).toBeDefined();
    expect(lintTemplate.cmd).toBe('pnpm');
    expect(lintTemplate.args).toContain('-w');
    expect(lintTemplate.args).toEqual(['-w', 'lint']);
  });

  it('should detect npm when package-lock.json exists', async () => {
    process.chdir(testDir);
    await writeFile(join(testDir, 'package-lock.json'), '{"lockfileVersion": 3}\n');

    await initCommand();

    const configPath = join(testDir, 'envoi.config.json');
    const config = JSON.parse(await readFile(configPath, 'utf-8'));

    // Verify templates use npm
    const lintTemplate = config.verification.templates.find((t: { id: string }) => t.id === 'lint');
    expect(lintTemplate).toBeDefined();
    expect(lintTemplate.cmd).toBe('npm');
    expect(lintTemplate.args).not.toContain('-w');
  });

  it('should detect yarn when yarn.lock exists', async () => {
    process.chdir(testDir);
    await writeFile(join(testDir, 'yarn.lock'), '# yarn lockfile v1\n');

    await initCommand();

    const configPath = join(testDir, 'envoi.config.json');
    const config = JSON.parse(await readFile(configPath, 'utf-8'));

    // Verify templates use yarn
    const lintTemplate = config.verification.templates.find((t: { id: string }) => t.id === 'lint');
    expect(lintTemplate).toBeDefined();
    expect(lintTemplate.cmd).toBe('yarn');
    expect(lintTemplate.args).not.toContain('-w');
  });

  it('should detect bun when bun.lockb exists', async () => {
    process.chdir(testDir);
    // Create a dummy bun.lockb file (binary, but we'll just create an empty file for testing)
    await writeFile(join(testDir, 'bun.lockb'), Buffer.from([]));

    await initCommand();

    const configPath = join(testDir, 'envoi.config.json');
    const config = JSON.parse(await readFile(configPath, 'utf-8'));

    // Verify templates use bun
    const lintTemplate = config.verification.templates.find((t: { id: string }) => t.id === 'lint');
    expect(lintTemplate).toBeDefined();
    expect(lintTemplate.cmd).toBe('bun');
    expect(lintTemplate.args).not.toContain('-w');
  });

  it('should default to pnpm when no lockfile is found', async () => {
    process.chdir(testDir);
    await initCommand();

    const configPath = join(testDir, 'envoi.config.json');
    const config = JSON.parse(await readFile(configPath, 'utf-8'));

    // Verify templates default to pnpm
    const lintTemplate = config.verification.templates.find((t: { id: string }) => t.id === 'lint');
    expect(lintTemplate).toBeDefined();
    expect(lintTemplate.cmd).toBe('pnpm');
  });

  it('should preserve template params when adjusting verification templates', async () => {
    process.chdir(testDir);
    await initCommand();

    const configPath = join(testDir, 'envoi.config.json');
    const config = JSON.parse(await readFile(configPath, 'utf-8'));

    // Verify test_filter template preserves params
    const testFilterTemplate = config.verification.templates.find((t: { id: string }) => t.id === 'test_filter');
    expect(testFilterTemplate).toBeDefined();
    expect(testFilterTemplate.params).toBeDefined();
    expect(testFilterTemplate.params.pkg).toBeDefined();
    expect(testFilterTemplate.params.pkg.kind).toBe('string_token');
    expect(testFilterTemplate.args).toContain('--filter');
    expect(testFilterTemplate.args).toContain('{{pkg}}');
  });
});
