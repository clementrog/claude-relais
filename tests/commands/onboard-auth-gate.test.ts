import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdir, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const mockCheckCursorAgent = vi.fn();
const mockCheckCodexCli = vi.fn();
const mockCheckClaudeCodeCli = vi.fn();

vi.mock('@/lib/doctor.js', () => ({
  checkCursorAgent: (...args: unknown[]) => mockCheckCursorAgent(...args),
  checkCodexCli: (...args: unknown[]) => mockCheckCodexCli(...args),
  checkClaudeCodeCli: (...args: unknown[]) => mockCheckClaudeCodeCli(...args),
}));

describe('onboard auth gate', () => {
  let testDir: string;
  let originalCwd: string;

  beforeEach(async () => {
    vi.resetModules();
    mockCheckCursorAgent.mockReset();
    mockCheckCodexCli.mockReset();
    mockCheckClaudeCodeCli.mockReset();

    mockCheckCursorAgent.mockResolvedValue({
      cli_available: true,
      version: 'cursor 1.0.0',
      agent_available: true,
      auth_status: 'authenticated',
      command: 'cursor',
    });
    mockCheckCodexCli.mockResolvedValue({
      cli_available: true,
      auth_status: 'authenticated',
      version: 'codex 0.98.0',
      reviewer_mode: 'enabled',
      auth_mode: 'auto',
    });
    mockCheckClaudeCodeCli.mockResolvedValue({
      cli_available: true,
      auth_status: 'authenticated',
      version: 'claude 1.0.0',
      command: 'claude',
    });

    testDir = join(tmpdir(), `relais-onboard-auth-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(testDir, { recursive: true });
    originalCwd = process.cwd();
    process.chdir(testDir);
    process.exitCode = 0;
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    process.exitCode = 0;
    await rm(testDir, { recursive: true, force: true });
  });

  it('emits auth question when selected roles are not authenticated', async () => {
    mockCheckCodexCli.mockResolvedValue({
      cli_available: true,
      auth_status: 'unauthenticated',
      version: 'codex 0.98.0',
      reviewer_mode: 'enabled',
      auth_mode: 'auto',
    });

    const { onboardCommand } = await import('@/commands/onboard');
    const result = await onboardCommand({
      showTourPrompt: false,
      autoRun: false,
      answersJson: JSON.stringify({
        mode: 'milestone',
        builder: 'cursor',
        planner_provider: 'chatgpt',
        reviewer: 'codex',
        reviewer_model: 'gpt-5',
        prd_text: 'Tiny brief text for setup.',
        __review_action: 'confirm',
      }),
    });

    expect(result.needsInput).toBe(true);

    const sessionPath = join(testDir, 'envoi', 'ONBOARDING_SESSION.json');
    const session = JSON.parse(await readFile(sessionPath, 'utf-8')) as {
      current_step?: string;
      pending_question_ids?: string[];
      status: string;
    };

    expect(session.status).toBe('waiting_input');
    expect(session.current_step).toBe('auth');
    expect(session.pending_question_ids).toEqual(['auth']);
  });

  it('completes onboarding when auth checks pass', async () => {
    const { onboardCommand } = await import('@/commands/onboard');
    const result = await onboardCommand({
      showTourPrompt: false,
      autoRun: false,
      answersJson: JSON.stringify({
        mode: 'milestone',
        builder: 'cursor',
        planner_provider: 'chatgpt',
        reviewer: 'none',
        prd_text: 'Tiny brief text for setup.',
        __review_action: 'confirm',
      }),
    });

    expect(result.needsInput).toBe(false);
  });
});
