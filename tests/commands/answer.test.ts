import { describe, it, expect } from 'vitest';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { answerCommand } from '@/commands/answer.js';
import { createDefaultState, readWorkspaceState, writeWorkspaceState } from '@/lib/workspace_state.js';

describe('answer command', () => {
  it('resolves latest open question and appends answer context into idea inbox', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'relais-answer-'));
    const workspace = join(dir, 'relais');
    await mkdir(workspace, { recursive: true });

    const state = createDefaultState();
    state.open_product_questions = [
      {
        id: 'pq-1',
        prompt: 'What stack should we use?',
        created_at: new Date().toISOString(),
        resolved: false,
      },
      {
        id: 'pq-2',
        prompt: 'Which run mode should be default?',
        choices: ['task', 'milestone', 'autonomous'],
        created_at: new Date().toISOString(),
        resolved: false,
      },
    ];
    await writeWorkspaceState(workspace, state);

    const result = await answerCommand(
      {
        text: '2',
      },
      workspace
    );

    expect(result.resolved).toBe(true);
    expect(result.questionId).toBe('pq-2');
    expect(result.pendingQuestions).toBe(1);

    const next = await readWorkspaceState(workspace);
    const q1 = next.open_product_questions?.find((question) => question.id === 'pq-1');
    const q2 = next.open_product_questions?.find((question) => question.id === 'pq-2');

    expect(q1?.resolved).toBe(false);
    expect(q2?.resolved).toBe(true);
    expect(q2?.resolution).toBe('milestone');
    expect(q2?.resolved_at).toBeTruthy();
    expect(next.idea_inbox?.some((entry) => entry.text.includes('Resolution: milestone'))).toBe(true);

    await rm(dir, { recursive: true, force: true });
  });

  it('supports resolving by explicit question id', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'relais-answer-'));
    const workspace = join(dir, 'relais');
    await mkdir(workspace, { recursive: true });

    const state = createDefaultState();
    state.open_product_questions = [
      {
        id: 'pq-a',
        prompt: 'Question A?',
        created_at: new Date().toISOString(),
        resolved: false,
      },
      {
        id: 'pq-b',
        prompt: 'Question B?',
        created_at: new Date().toISOString(),
        resolved: false,
      },
    ];
    await writeWorkspaceState(workspace, state);

    const result = await answerCommand(
      {
        questionId: 'pq-a',
        text: 'Use plain HTML/CSS/JS',
      },
      workspace
    );

    expect(result.questionId).toBe('pq-a');

    const next = await readWorkspaceState(workspace);
    const target = next.open_product_questions?.find((question) => question.id === 'pq-a');
    const other = next.open_product_questions?.find((question) => question.id === 'pq-b');
    expect(target?.resolved).toBe(true);
    expect(other?.resolved).toBe(false);

    await rm(dir, { recursive: true, force: true });
  });

  it('fails when no open question exists', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'relais-answer-'));
    const workspace = join(dir, 'relais');
    await mkdir(workspace, { recursive: true });
    await writeWorkspaceState(workspace, createDefaultState());

    await expect(
      answerCommand(
        {
          text: 'No-op',
        },
        workspace
      )
    ).rejects.toThrow('No open product questions found in STATE.json.');

    await rm(dir, { recursive: true, force: true });
  });
});
