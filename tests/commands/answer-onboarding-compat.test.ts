import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/commands/onboard.js', () => ({
  onboardCommand: vi.fn(),
}));

import { answerCommand } from '@/commands/answer.js';
import { onboardCommand } from '@/commands/onboard.js';

describe('answer command onboarding compatibility', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('routes --session/--id/--value to onboarding envelope flow', async () => {
    vi.mocked(onboardCommand).mockResolvedValue({ needsInput: true });

    const result = await answerCommand(
      {
        sessionId: 'session-123',
        id: 'mode',
        value: 'milestone',
        json: true,
      },
      'envoi'
    );

    expect(onboardCommand).toHaveBeenCalledTimes(1);
    expect(vi.mocked(onboardCommand).mock.calls[0]?.[0]).toMatchObject({
      json: true,
      showTourPrompt: false,
    });
    const answersJson = vi.mocked(onboardCommand).mock.calls[0]?.[0]?.answersJson;
    expect(typeof answersJson).toBe('string');
    expect(JSON.parse(String(answersJson))).toEqual({
      type: 'envoi.onboarding.answer.v1',
      session_id: 'session-123',
      question_id: 'mode',
      value: 'milestone',
    });
    expect(result.kind).toBe('onboarding');
    expect(result.needsInput).toBe(true);
    expect(result.questionId).toBe('mode');
  });

  it('accepts positional text as fallback onboarding value', async () => {
    vi.mocked(onboardCommand).mockResolvedValue({ needsInput: false });

    const result = await answerCommand(
      {
        sessionId: 'session-abc',
        id: 'reviewer',
        text: 'codex',
      },
      'envoi'
    );

    const answersJson = vi.mocked(onboardCommand).mock.calls[0]?.[0]?.answersJson;
    expect(JSON.parse(String(answersJson))).toEqual({
      type: 'envoi.onboarding.answer.v1',
      session_id: 'session-abc',
      question_id: 'reviewer',
      value: 'codex',
    });
    expect(result.needsInput).toBe(false);
  });

  it('fails fast when onboarding compat flags are incomplete', async () => {
    await expect(
      answerCommand(
        {
          id: 'mode',
          value: 'milestone',
        },
        'envoi'
      )
    ).rejects.toThrow("Onboarding answer mode requires '--session <id>'.");

    await expect(
      answerCommand(
        {
          sessionId: 'session-1',
          value: 'milestone',
        },
        'envoi'
      )
    ).rejects.toThrow("Onboarding answer mode requires '--id <question_id>'.");
  });
});
