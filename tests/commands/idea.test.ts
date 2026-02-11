import { describe, it, expect } from 'vitest';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ideaCommand } from '@/commands/idea.js';
import { createDefaultState, readWorkspaceState, writeWorkspaceState } from '@/lib/workspace_state.js';

describe('idea command', () => {
  it('captures an idea into STATE.json inbox', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'relais-idea-'));
    const workspace = join(dir, 'relais');
    await mkdir(workspace, { recursive: true });
    await writeWorkspaceState(workspace, createDefaultState());

    await ideaCommand(
      {
        text: 'Users should test draft flows earlier.',
        testability: 'soon',
        source: 'cli',
      },
      workspace
    );

    const state = await readWorkspaceState(workspace);
    expect(state.idea_inbox?.length).toBe(1);
    expect(state.idea_inbox?.[0].text).toContain('test draft flows');
    expect(state.idea_inbox?.[0].status).toBe('new');
    expect(state.idea_inbox?.[0].testability_need).toBe('soon');

    await rm(dir, { recursive: true, force: true });
  });

  it('rejects invalid testability values', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'relais-idea-'));
    const workspace = join(dir, 'relais');
    await mkdir(workspace, { recursive: true });
    await writeWorkspaceState(workspace, createDefaultState());

    await expect(
      ideaCommand(
        {
          text: 'This should fail',
          testability: 'urgent',
        },
        workspace
      )
    ).rejects.toThrow("Invalid testability value: urgent. Must be 'soon', 'later', or 'unknown'.");

    await rm(dir, { recursive: true, force: true });
  });
});
