import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('node:child_process', () => ({
  spawnSync: vi.fn(() => ({ status: 0 })),
}));

describe('update planning', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('builds registry update plan with explicit manager', async () => {
    const { buildUpdatePlan } = await import('@/commands/update');
    const plan = await buildUpdatePlan({ mode: 'registry', manager: 'npm' });
    expect(plan.mode).toBe('registry');
    expect(plan.manager).toBe('npm');
    expect(plan.commands).toEqual([
      {
        cmd: 'npm',
        args: ['install', '-g', '@ttfw/envoi@latest'],
      },
    ]);
  });

  it('rejects invalid update mode values', async () => {
    const { buildUpdatePlan } = await import('@/commands/update');
    await expect(buildUpdatePlan({ mode: 'invalid-mode' })).rejects.toThrow(
      "Invalid mode: invalid-mode. Must be 'auto', 'linked', or 'registry'."
    );
  });
});
