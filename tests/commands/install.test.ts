import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockSpawn = vi.fn();
const mockBuildUpdatePlan = vi.fn();
const mockOnboardCommand = vi.fn();

vi.mock('node:child_process', () => ({
  spawn: (...args: unknown[]) => mockSpawn(...args),
}));

vi.mock('@/commands/update', () => ({
  buildUpdatePlan: (...args: unknown[]) => mockBuildUpdatePlan(...args),
}));

vi.mock('@/commands/onboard', () => ({
  onboardCommand: (...args: unknown[]) => mockOnboardCommand(...args),
}));

describe('install command', () => {
  const createChild = (status = 0) => {
    const handlers: Record<string, (...args: unknown[]) => void> = {};
    let child: { once: ReturnType<typeof vi.fn> };
    child = {
      once: vi.fn((event: string, callback: (...args: unknown[]) => void) => {
        handlers[event] = callback;
        return child;
      }),
    };
    queueMicrotask(() => {
      handlers.close?.(status, null);
    });
    return child;
  };

  beforeEach(() => {
    vi.resetModules();
    mockSpawn.mockReset();
    mockBuildUpdatePlan.mockReset();
    mockOnboardCommand.mockReset();
    mockSpawn.mockImplementation(() => createChild(0));
    mockBuildUpdatePlan.mockResolvedValue({
      commands: [{ cmd: 'npm', args: ['install', '-g', '@ttfw/envoi@latest'] }],
    });
    mockOnboardCommand.mockResolvedValue(undefined);
  });

  it('runs onboarding by default without global install', async () => {
    const { installCommand } = await import('@/commands/install');
    await installCommand({ manager: 'npm', mode: 'milestone', builder: 'cursor' });

    expect(mockBuildUpdatePlan).not.toHaveBeenCalled();
    expect(mockSpawn).not.toHaveBeenCalled();
    expect(mockOnboardCommand).toHaveBeenCalledTimes(1);
  });

  it('stops after onboarding when more answers are required', async () => {
    mockOnboardCommand.mockResolvedValue({ needsInput: true });
    const { installCommand } = await import('@/commands/install');
    await installCommand({ manager: 'npm', mode: 'milestone', builder: 'cursor', globalInstall: true });

    expect(mockBuildUpdatePlan).not.toHaveBeenCalled();
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it('runs global install only when explicitly requested', async () => {
    const { installCommand } = await import('@/commands/install');
    await installCommand({ manager: 'npm', mode: 'milestone', builder: 'cursor', globalInstall: true });

    expect(mockBuildUpdatePlan).toHaveBeenCalledWith({ mode: 'registry', manager: 'npm' });
    expect(mockSpawn).toHaveBeenCalledWith('npm', ['install', '-g', '@ttfw/envoi@latest'], { stdio: 'inherit' });
    expect(mockOnboardCommand).toHaveBeenCalledTimes(1);
  });

  it('continues when global install fails after onboarding', async () => {
    mockBuildUpdatePlan.mockRejectedValue(new Error('network down'));
    const { installCommand } = await import('@/commands/install');
    await installCommand({ mode: 'milestone', builder: 'cursor', globalInstall: true });

    expect(mockOnboardCommand).toHaveBeenCalledTimes(1);
  });

  it('rejects conflicting global install flags', async () => {
    const { installCommand } = await import('@/commands/install');
    await expect(
      installCommand({ globalInstall: true, skipGlobalInstall: true })
    ).rejects.toThrow("Conflicting options: use either '--global-install' or '--skip-global-install'.");
  });
});
