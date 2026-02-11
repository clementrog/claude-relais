import { stdin as input, stdout as output } from 'node:process';
import readline from 'node:readline/promises';

import { appendIdeaEntry, readWorkspaceState, writeWorkspaceState } from '../lib/workspace_state.js';

type IdeaTestabilityOption = 'soon' | 'later' | 'unknown';

export interface IdeaCommandOptions {
  text?: string;
  targetBy?: string;
  testability?: string;
  source?: string;
  json?: boolean;
}

function normalizeTestability(value?: string): IdeaTestabilityOption {
  if (!value || value.trim() === '') return 'unknown';
  if (value === 'soon' || value === 'later' || value === 'unknown') return value;
  throw new Error(`Invalid testability value: ${value}. Must be 'soon', 'later', or 'unknown'.`);
}

function normalizeSource(value?: string): 'interactive' | 'cli' | 'api' {
  if (!value || value.trim() === '') return 'cli';
  if (value === 'interactive' || value === 'cli' || value === 'api') return value;
  throw new Error(`Invalid source value: ${value}. Must be 'interactive', 'cli', or 'api'.`);
}

async function promptIdeaText(): Promise<string> {
  if (!input.isTTY) return '';
  const rl = readline.createInterface({ input, output });
  try {
    return (await rl.question('Share a new idea for planning (Enter to skip): ')).trim();
  } finally {
    rl.close();
  }
}

async function promptTestability(): Promise<IdeaTestabilityOption> {
  if (!input.isTTY) return 'unknown';
  const rl = readline.createInterface({ input, output });
  try {
    const answer = (
      await rl.question('When should this be testable? [soon/later/unknown] (default unknown): ')
    )
      .trim()
      .toLowerCase();
    if (!answer) return 'unknown';
    if (answer === 'soon' || answer === 'later' || answer === 'unknown') return answer;
    throw new Error("Invalid choice. Use 'soon', 'later', or 'unknown'.");
  } finally {
    rl.close();
  }
}

export async function ideaCommand(
  options: IdeaCommandOptions,
  workspaceDir: string
): Promise<{ saved: boolean; count: number }> {
  const explicitText = options.text?.trim() ?? '';
  const ideaText = explicitText || (await promptIdeaText());

  if (!ideaText) {
    if (options.json) {
      console.log(JSON.stringify({ saved: false, reason: 'empty_input' }, null, 2));
      return { saved: false, count: 0 };
    }
    console.log('No idea captured.');
    return { saved: false, count: 0 };
  }

  const source = normalizeSource(options.source ?? (explicitText ? 'cli' : 'interactive'));
  const promptedTestability =
    options.testability === undefined && source === 'interactive' ? await promptTestability() : undefined;
  const testability = normalizeTestability(options.testability ?? promptedTestability);
  const currentState = await readWorkspaceState(workspaceDir);
  const nextState = appendIdeaEntry(currentState, {
    text: ideaText,
    source,
    target_by: options.targetBy ?? null,
    testability_need: testability,
  });

  await writeWorkspaceState(workspaceDir, nextState);
  const count = nextState.idea_inbox?.filter((entry) => entry.status === 'new').length ?? 0;

  if (options.json) {
    console.log(JSON.stringify({ saved: true, pending_new_ideas: count }, null, 2));
  } else {
    console.log(`Idea saved to ${workspaceDir}/STATE.json`);
    console.log(`Pending new ideas: ${count}`);
  }

  return { saved: true, count };
}
