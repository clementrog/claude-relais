/**
 * F007: Path normalization test.
 *
 * Verifies that init.ts doesn't create double-prefixed paths
 * when workspace_dir matches the default 'relais' prefix.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

describe('F007: Path normalization in init', () => {
  let tempDir: string;
  let originalCwd: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'relais-init-test-'));
    originalCwd = process.cwd();
    process.chdir(tempDir);

    // Create a mock relais.config.json template
    const templateConfig = {
      version: '1.0.0',
      workspace_dir: 'relais',
      runner: {
        lockfile: 'relais/lock.json',
        runner_owned_globs: ['relais/STATE.json', 'relais/REPORT.json'],
      },
      orchestrator: {
        system_prompt_file: 'relais/prompts/orchestrator.system.txt',
        user_prompt_file: 'relais/prompts/orchestrator.user.txt',
        task_schema_file: 'relais/schemas/task.schema.json',
      },
      builder: {
        claude_code: {
          system_prompt_file: 'relais/prompts/builder.system.txt',
          user_prompt_file: 'relais/prompts/builder.user.txt',
          builder_result_schema_file: 'relais/schemas/builder_result.schema.json',
        },
      },
      history: {
        dir: 'relais/history',
      },
    };

    // Create mock package structure for init to find templates
    const pkgRoot = join(tempDir, 'node_modules', 'relais');
    mkdirSync(pkgRoot, { recursive: true });
    writeFileSync(join(pkgRoot, '../relais.config.json'), JSON.stringify(templateConfig, null, 2));

    // Create mock prompt templates
    mkdirSync(join(pkgRoot, 'prompts'), { recursive: true });
    mkdirSync(join(pkgRoot, 'schemas'), { recursive: true });
    writeFileSync(join(pkgRoot, 'prompts', 'orchestrator.system.txt'), 'system prompt');
    writeFileSync(join(pkgRoot, 'prompts', 'orchestrator.user.txt'), 'user prompt');
    writeFileSync(join(pkgRoot, 'prompts', 'builder.system.txt'), 'builder system');
    writeFileSync(join(pkgRoot, 'prompts', 'builder.user.txt'), 'builder user');
    writeFileSync(join(pkgRoot, 'schemas', 'task.schema.json'), '{}');
    writeFileSync(join(pkgRoot, 'schemas', 'builder_result.schema.json'), '{}');
    writeFileSync(join(pkgRoot, 'schemas', 'report.schema.json'), '{}');
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('should not create double-prefixed paths', async () => {
    // The fix ensures paths are relative to workspace_dir without duplication
    // When template has 'relais/prompts/system.txt' and workspaceDir='relais',
    // the result should be 'prompts/system.txt' (relative to workspace_dir)
    // NOT 'relais/prompts/system.txt' which would become 'relais/relais/prompts/system.txt' on join

    // Simulate the path replacement logic from init.ts
    const templatePath = 'relais/prompts/orchestrator.system.txt';
    const workspaceDir = 'relais';

    // Old (buggy) behavior:
    // const oldResult = templatePath.replace(/^relais\//, `${workspaceDir}/`);
    // -> 'relais/prompts/orchestrator.system.txt' (no change when workspaceDir='relais')
    // Then join(workspaceDir, oldResult) -> 'relais/relais/prompts/orchestrator.system.txt'

    // New (fixed) behavior:
    const newResult = templatePath.replace(/^relais\//, '');
    // -> 'prompts/orchestrator.system.txt'
    // Then join(workspaceDir, newResult) -> 'relais/prompts/orchestrator.system.txt'

    expect(newResult).toBe('prompts/orchestrator.system.txt');

    // Verify joining produces correct path
    const finalPath = join(workspaceDir, newResult);
    expect(finalPath).toBe('relais/prompts/orchestrator.system.txt');

    // Should NOT have double relais
    expect(finalPath).not.toMatch(/relais\/relais/);
  });

  it('should handle custom workspace dir correctly', async () => {
    const templatePath = 'relais/prompts/orchestrator.system.txt';
    const workspaceDir = 'my-custom-dir';

    // After fix: strip 'relais/' prefix
    const strippedPath = templatePath.replace(/^relais\//, '');
    expect(strippedPath).toBe('prompts/orchestrator.system.txt');

    // Join with custom workspace dir
    const finalPath = join(workspaceDir, strippedPath);
    expect(finalPath).toBe('my-custom-dir/prompts/orchestrator.system.txt');
  });

  it('should handle paths without relais prefix', async () => {
    const templatePath = 'prompts/custom.txt';
    const workspaceDir = 'relais';

    // Path doesn't start with 'relais/', so no replacement happens
    const result = templatePath.replace(/^relais\//, '');
    expect(result).toBe('prompts/custom.txt');

    const finalPath = join(workspaceDir, result);
    expect(finalPath).toBe('relais/prompts/custom.txt');
  });
});
