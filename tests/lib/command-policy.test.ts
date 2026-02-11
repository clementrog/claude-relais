import { describe, it, expect } from 'vitest';

import { evaluateCommandPolicy, resolveCommandPolicy } from '@/lib/command_policy.js';
import { createMockConfig } from '../helpers/mocks.js';

describe('command policy', () => {
  it('allows trusted read-only commands', () => {
    const config = createMockConfig({
      workspace_dir: 'relais',
      runner: {
        autonomy: {
          profile: 'fast',
          command_trust: [],
          allow_prefixes: ['git log'],
          deny_prefixes: [],
          allow_network_prefixes: ['gh'],
          allow_workspace_write_prefixes: [],
          require_explicit_for_destructive: true,
          fs_policy: 'workspace_write',
          network_policy: 'deny',
          audit_log: { enabled: true, path: 'relais/history/autonomy.log' },
        },
      } as any,
    } as any);

    const result = evaluateCommandPolicy(config as any, 'git', ['log', '--oneline', '-10']);
    expect(result.decision).toBe('allow');
    expect(result.classification).toBe('read_only');
  });

  it('treats git read-only commands with -C as read_only', () => {
    const config = createMockConfig({ workspace_dir: 'relais' } as any);
    const result = evaluateCommandPolicy(
      config as any,
      'git',
      ['-C', '/Users/clement/projects/envoi', 'log', '--oneline', '-10']
    );
    expect(result.decision).toBe('allow');
    expect(result.classification).toBe('read_only');
  });

  it('denies destructive commands without explicit intent', () => {
    const config = createMockConfig({ workspace_dir: 'relais' } as any);
    const result = evaluateCommandPolicy(config as any, 'git', ['reset', '--hard']);
    expect(result.decision).toBe('deny');
    expect(result.classification).toBe('destructive');
  });

  it('allows trusted network prefixes in fast profile', () => {
    const config = createMockConfig({
      workspace_dir: 'relais',
      runner: {
        autonomy: {
          profile: 'fast',
          command_trust: [],
          allow_prefixes: [],
          deny_prefixes: [],
          allow_network_prefixes: ['gh'],
          allow_workspace_write_prefixes: [],
          require_explicit_for_destructive: true,
          fs_policy: 'workspace_write',
          network_policy: 'deny',
          audit_log: { enabled: true, path: 'relais/history/autonomy.log' },
        },
      } as any,
    } as any);

    const result = evaluateCommandPolicy(config as any, 'gh', ['repo', 'view']);
    expect(result.decision).toBe('allow');
    expect(result.classification).toBe('network');
  });

  it('merges legacy command_trust into allow list', () => {
    const config = createMockConfig({
      workspace_dir: 'relais',
      runner: {
        autonomy: {
          profile: 'balanced',
          command_trust: ['git rev-parse'],
          fs_policy: 'workspace_write',
          network_policy: 'deny',
        },
      } as any,
    } as any);

    const policy = resolveCommandPolicy(config as any);
    expect(policy.allowPrefixes).toContain('git rev-parse');
  });
});
