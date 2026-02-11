import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { initCommand } from '@/commands/init';
import { mkdir, rm, readFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('initCommand', () => {
  let testDir: string;
  let originalCwd: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), `relais-init-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(testDir, { recursive: true });
    originalCwd = process.cwd();
    process.chdir(testDir);
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

  it('should create workspace directory structure', async () => {
    await initCommand();

    expect(await fileExists('envoi')).toBe(true);
    expect(await fileExists('envoi/prompts')).toBe(true);
    expect(await fileExists('envoi/schemas')).toBe(true);
    expect(await fileExists('envoi/history')).toBe(true);
  });

  it('should copy prompt templates', async () => {
    await initCommand();

    expect(await fileExists('envoi/prompts/orchestrator.system.txt')).toBe(true);
    expect(await fileExists('envoi/prompts/orchestrator.user.txt')).toBe(true);
    expect(await fileExists('envoi/prompts/builder.system.txt')).toBe(true);
    expect(await fileExists('envoi/prompts/builder.user.txt')).toBe(true);
  });

  it('should copy schema files', async () => {
    await initCommand();

    expect(await fileExists('envoi/schemas/task.schema.json')).toBe(true);
    expect(await fileExists('envoi/schemas/builder_result.schema.json')).toBe(true);
    expect(await fileExists('envoi/schemas/report.schema.json')).toBe(true);
  });

  it('should initialize STATE.json with correct structure', async () => {
    await initCommand();

    const statePath = 'envoi/STATE.json';
    expect(await fileExists(statePath)).toBe(true);

    const state = JSON.parse(await readFile(statePath, 'utf-8'));
    expect(state.v).toBe(3);
    expect(state.phase).toBe('IDLE');
    expect(state.mode).toBe('single');
    expect(state.task).toBe(null);
    expect(state.milestone).toBe(null);
    expect(state.branch).toBe('main');
    expect(state.batch_tasks).toEqual([]);
    expect(state.attempt).toBe(0);
    expect(state.blockers).toEqual([]);
    expect(state.next).toBe(null);
    expect(state.ts).toBeDefined();
    expect(typeof state.ts).toBe('string');
  });

  it('should create envoi.config.json', async () => {
    await initCommand();

    const configPath = 'envoi.config.json';
    expect(await fileExists(configPath)).toBe(true);

    const config = JSON.parse(await readFile(configPath, 'utf-8'));
    expect(config.workspace_dir).toBe('envoi');
    expect(config.runner).toBeDefined();
  });

  it('should add .gitignore entries', async () => {
    await initCommand();

    const gitignorePath = '.gitignore';
    expect(await fileExists(gitignorePath)).toBe(true);

    const content = await readFile(gitignorePath, 'utf-8');
    expect(content).toContain('# Envoi runner-owned (auto-generated)');
    expect(content).toContain('envoi/REPORT.json');
    expect(content).toContain('envoi/STATE.json');
  });

  it('should not overwrite existing files without --force', async () => {
    // First initialization
    await initCommand();

    // Modify STATE.json
    const statePath = 'envoi/STATE.json';
    const originalState = JSON.parse(await readFile(statePath, 'utf-8'));
    originalState.phase = 'MODIFIED';
    await require('node:fs/promises').writeFile(statePath, JSON.stringify(originalState, null, 2));

    // Re-running start should be idempotent and not throw
    await expect(initCommand()).resolves.toBeUndefined();

    // Verify STATE.json was not overwritten
    const state = JSON.parse(await readFile(statePath, 'utf-8'));
    expect(state.phase).toBe('MODIFIED');
  });

  it('should overwrite existing files with --force', async () => {
    // First initialization
    await initCommand();

    // Modify STATE.json
    const statePath = 'envoi/STATE.json';
    const modifiedState = JSON.parse(await readFile(statePath, 'utf-8'));
    modifiedState.phase = 'MODIFIED';
    await require('node:fs/promises').writeFile(statePath, JSON.stringify(modifiedState, null, 2));

    // Initialize again with force
    await initCommand({ force: true });

    // Verify STATE.json was overwritten
    const state = JSON.parse(await readFile(statePath, 'utf-8'));
    expect(state.phase).toBe('IDLE');
  });

  it('should work with custom workspace directory', async () => {
    await initCommand({ workspaceDir: 'custom-workspace' });

    expect(await fileExists('custom-workspace')).toBe(true);
    expect(await fileExists('custom-workspace/STATE.json')).toBe(true);

    const config = JSON.parse(await readFile('envoi.config.json', 'utf-8'));
    expect(config.workspace_dir).toBe('custom-workspace');
  });

  it('should handle existing .gitignore gracefully', async () => {
    // Create existing .gitignore
    await require('node:fs/promises').writeFile('.gitignore', 'node_modules/\n.env\n');

    await initCommand();

    const content = await readFile('.gitignore', 'utf-8');
    expect(content).toContain('node_modules/');
    expect(content).toContain('.env');
    expect(content).toContain('# Envoi runner-owned (auto-generated)');
  });
});
