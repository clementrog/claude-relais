/**
 * Interactive (or flag-based) loop mode selection.
 *
 * Persists the default loop mode into envoi.config.json so users can re-run
 * `envoi loop` without remembering flags.
 */

import { resolve } from 'node:path';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';

import { atomicReadJson, atomicWriteJson } from '../lib/fs.js';
import { CONFIG_FILE_NAME, ConfigError, findConfigFile, loadConfig } from '../lib/config.js';
import type { EnvoiConfig } from '../types/config.js';
import { CLI_NAME } from '../lib/branding.js';

export type LoopMode = 'task' | 'milestone' | 'autonomous';

function describeMode(mode: LoopMode): { title: string; desc: string } {
  switch (mode) {
    case 'task':
      return {
        title: 'Task (small, controlled)',
        desc: 'Stops when the orchestrator signals stop (good for short bursts).',
      };
    case 'milestone':
      return {
        title: 'Milestone (recommended default)',
        desc: 'Stops when the milestone changes (good for iterative progress).',
      };
    case 'autonomous':
      return {
        title: 'Autonomous (hands-off)',
        desc: 'Allows milestone changes (good for longer runs, higher drift risk).',
      };
  }
}

async function promptForMode(current?: LoopMode): Promise<LoopMode> {
  const rl = readline.createInterface({ input, output });
  try {
    console.log('\nChoose loop mode:');
    const options: LoopMode[] = ['task', 'milestone', 'autonomous'];
    options.forEach((m, i) => {
      const meta = describeMode(m);
      const suffix = current === m ? ' (current)' : '';
      console.log(`  ${i + 1}. ${m} — ${meta.title}${suffix}`);
      console.log(`     ${meta.desc}`);
    });
    const answer = (await rl.question(`Mode [1-3]${current ? ` (default ${current})` : ''}: `)).trim();
    if (answer === '' && current) return current;
    const idx = Number.parseInt(answer, 10);
    if (idx >= 1 && idx <= 3) return options[idx - 1];
    if (answer === 'task' || answer === 'milestone' || answer === 'autonomous') return answer;
    throw new Error('Invalid selection');
  } finally {
    rl.close();
  }
}

async function resolveConfigPath(configPath?: string): Promise<string> {
  if (configPath) return resolve(configPath);
  const found = await findConfigFile();
  if (!found) {
    throw new ConfigError(
      `Configuration file not found. Expected ${CONFIG_FILE_NAME} in current directory or parent directories.`
    );
  }
  return found;
}

export async function modeCommand(options: { configPath?: string; set?: string; json?: boolean }): Promise<void> {
  // Ensure config exists and is valid (also confirms we are in repo root via caller).
  const config = await loadConfig(options.configPath);

  const current = config.runner.default_loop_mode as LoopMode | undefined;
  let next: LoopMode | undefined;

  if (options.set) {
    if (options.set !== 'task' && options.set !== 'milestone' && options.set !== 'autonomous') {
      throw new Error(`Invalid mode: ${options.set}. Must be 'task', 'milestone', or 'autonomous'.`);
    }
    next = options.set;
  } else if (input.isTTY) {
    next = await promptForMode(current);
  } else {
    throw new Error('No --set provided and stdin is not a TTY (cannot prompt).');
  }

  const configPath = await resolveConfigPath(options.configPath);
  const raw = await atomicReadJson<EnvoiConfig>(configPath);
  raw.runner = { ...raw.runner, default_loop_mode: next };
  await atomicWriteJson(configPath, raw);

  if (options.json) {
    console.log(JSON.stringify({ default_loop_mode: next }, null, 2));
    return;
  }

  const meta = describeMode(next);
  console.log(`\nDefault loop mode set to: ${next} — ${meta.title}`);
  console.log(`Next: ${CLI_NAME} loop --mode ${next}`);
  console.log(`Change again anytime: ${CLI_NAME} mode`);
}
