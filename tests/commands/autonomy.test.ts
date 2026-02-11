import { describe, it, expect } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { autonomyCommand } from '@/commands/autonomy.js';
import { atomicReadJson, atomicWriteJson } from '@/lib/fs.js';
import { createMockConfig } from '../helpers/mocks.js';

describe('autonomy command', () => {
  it('sets fast profile and aligns permission modes', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'relais-autonomy-'));
    const configPath = join(dir, 'relais.config.json');
    await atomicWriteJson(configPath, createMockConfig({ workspace_dir: 'relais' }));

    await autonomyCommand({ configPath, set: 'fast', json: true });

    const updated = await atomicReadJson<any>(configPath);
    expect(updated.runner.autonomy.profile).toBe('fast');
    expect(updated.orchestrator.permission_mode).toBe('bypassPermissions');
    expect(updated.builder.claude_code.permission_mode).toBe('bypassPermissions');
    expect(updated.orchestrator.allowed_tools).toBe('Read,Glob,Grep');
    expect(updated.runner.autonomy.require_explicit_for_destructive).toBe(true);
    expect(updated.runner.autonomy.allow_network_prefixes).toContain('gh');

    await rm(dir, { recursive: true, force: true });
  });

  it('sets strict profile and aligns permission modes', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'relais-autonomy-'));
    const configPath = join(dir, 'relais.config.json');
    await atomicWriteJson(configPath, createMockConfig({ workspace_dir: 'relais' }));

    await autonomyCommand({ configPath, set: 'strict' });

    const updated = await atomicReadJson<any>(configPath);
    expect(updated.runner.autonomy.profile).toBe('strict');
    expect(updated.orchestrator.permission_mode).toBe('plan');
    expect(updated.builder.claude_code.permission_mode).toBe('plan');
    expect(updated.orchestrator.allowed_tools).toBe('Read,Glob,Grep');

    await rm(dir, { recursive: true, force: true });
  });

  it('adds and removes trusted prefixes', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'relais-autonomy-'));
    const configPath = join(dir, 'relais.config.json');
    await atomicWriteJson(configPath, createMockConfig({ workspace_dir: 'relais' }));

    await autonomyCommand({ configPath, set: 'balanced', trustAdd: ['git -C /tmp log'] });
    let updated = await atomicReadJson<any>(configPath);
    expect(updated.runner.autonomy.allow_prefixes).toContain('git -C /tmp log');

    await autonomyCommand({ configPath, set: 'balanced', trustRemove: ['git -C /tmp log'] });
    updated = await atomicReadJson<any>(configPath);
    expect(updated.runner.autonomy.allow_prefixes).not.toContain('git -C /tmp log');

    await rm(dir, { recursive: true, force: true });
  });
});
