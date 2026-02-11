import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, rm, access, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { onboardCommand } from '@/commands/onboard';

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

describe('onboard session behavior', () => {
  let testDir: string;
  let originalCwd: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), `relais-onboard-session-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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

  it('auto-initializes git before non-interactive onboarding', async () => {
    const result = await onboardCommand({ showTourPrompt: false });
    expect(result.needsInput).toBe(true);
    expect(await fileExists(join(testDir, '.git'))).toBe(true);

    const sessionPath = join(testDir, 'envoi', 'ONBOARDING_SESSION.json');
    const session = JSON.parse(await readFile(sessionPath, 'utf-8')) as {
      status: string;
      current_step?: string;
      pending_question_ids?: string[];
    };
    expect(session.status).toBe('waiting_input');
    expect(session.current_step).toBe('mode');
    expect(session.pending_question_ids?.[0]).toBe('mode');
  });

  it('skips onboarding when completed session exists and no explicit reconfigure is requested', async () => {
    await onboardCommand({ showTourPrompt: false });

    const completedSessionPath = join(testDir, 'envoi', 'ONBOARDING_SESSION.json');
    const completedSession = {
      v: 1,
      type: 'envoi.onboarding.session.v1',
      session_id: 'completed-session',
      status: 'completed',
      updated_at: new Date().toISOString(),
      pending_question_ids: [],
      answers: {},
    };
    await writeFile(completedSessionPath, `${JSON.stringify(completedSession, null, 2)}\n`, 'utf-8');

    const result = await onboardCommand({ showTourPrompt: false, autoRun: false });
    expect(result.needsInput).toBe(false);
  });

  it('rejects answers for mismatched session ids', async () => {
    await onboardCommand({ showTourPrompt: false });

    await expect(
      onboardCommand({
        showTourPrompt: false,
        answersJson: JSON.stringify({
          type: 'envoi.onboarding.answer.v1',
          session_id: 'wrong-session',
          question_id: 'mode',
          value: 'milestone',
        }),
      })
    ).rejects.toThrow('Onboarding session mismatch');
  });
});
