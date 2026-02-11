/**
 * Interactive (or flag-based) builder selection.
 *
 * This is the "hands" engine choice:
 * - cursor: external driver (fast / auto-mode), requires builder.cursor config
 */

import { resolve } from 'node:path';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';

import { atomicReadJson, atomicWriteJson } from '../lib/fs.js';
import { CONFIG_FILE_NAME, ConfigError, findConfigFile, loadConfig, validateConfig } from '../lib/config.js';
import type { EnvoiConfig } from '../types/config.js';
import { CLI_NAME, WORKSPACE_DIR_NAME } from '../lib/branding.js';

type BuilderChoice = 'cursor';

function describeBuilder(choice: BuilderChoice): { title: string; desc: string } {
  switch (choice) {
    case 'cursor':
      return {
        title: 'Cursor agent (auto-mode) — fast + (almost) unlimited (recommended)',
        desc: `Requires a headless driver that reads ${WORKSPACE_DIR_NAME}/TASK.json and writes BUILDER_RESULT.json.`,
      };
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

async function promptForBuilder(current?: BuilderChoice): Promise<BuilderChoice> {
  const meta = describeBuilder('cursor');
  const suffix = current === 'cursor' ? ' (current)' : '';
  console.log(`\nBuilder is fixed to: cursor — ${meta.title}${suffix}`);
  console.log(`  ${meta.desc}`);
  return 'cursor';
}

async function promptCursorConfig(existing?: EnvoiConfig['builder']['cursor']): Promise<NonNullable<EnvoiConfig['builder']['cursor']>> {
  const rl = readline.createInterface({ input, output });
  try {
    console.log('\nCursor driver config (Cursor Agent):');
    console.log(`  This should point to the Cursor CLI executable (usually 'cursor'). ${CLI_NAME} will run: <command> <args...> <prompt>`);
    const command =
      (await rl.question(`  command (Cursor CLI, must support 'agent') [${existing?.command ?? 'cursor'}]: `)).trim() ||
      (existing?.command ?? 'cursor');
    const defaultArgs = existing?.args?.length
      ? existing.args
      : ['agent', '--print', '--output-format', 'text', '--workspace', '.', '--force'];
    const argsLine =
      (await rl.question(
        `  args (space-separated, no quoting) [${defaultArgs.join(' ')}]: `
      )).trim();
    const args = argsLine ? argsLine.split(/\s+/).filter(Boolean) : defaultArgs;
    const timeoutStr = (await rl.question(`  timeout_seconds [${existing?.timeout_seconds ?? 300}]: `)).trim();
    const timeout_seconds = timeoutStr ? Number.parseInt(timeoutStr, 10) : (existing?.timeout_seconds ?? 300);
    const driverKind =
      (await rl.question(`  driver_kind [${existing?.driver_kind ?? 'cursor_agent'}]: `)).trim() ||
      (existing?.driver_kind ?? 'cursor_agent');
    const output_file =
      (await rl.question(`  output_file (relative to workspace_dir) [${existing?.output_file ?? 'BUILDER_RESULT.json'}]: `)).trim() ||
      (existing?.output_file ?? 'BUILDER_RESULT.json');

    return { driver_kind: driverKind as any, command, args, timeout_seconds, output_file };
  } finally {
    rl.close();
  }
}

export async function builderCommand(options: { configPath?: string; set?: string; json?: boolean }): Promise<void> {
  const config = await loadConfig(options.configPath);
  const current: BuilderChoice = 'cursor';

  let next: BuilderChoice;
  if (options.set) {
    if (options.set !== 'cursor') {
      throw new Error(`Invalid builder: ${options.set}. Only 'cursor' is supported.`);
    }
    next = options.set;
  } else if (input.isTTY) {
    next = await promptForBuilder(current);
  } else {
    throw new Error('No --set provided and stdin is not a TTY (cannot prompt).');
  }

  const configPath = await resolveConfigPath(options.configPath);
  const raw = await atomicReadJson<EnvoiConfig>(configPath);

  const cursor = input.isTTY ? await promptCursorConfig(raw.builder.cursor) : raw.builder.cursor;
  if (!cursor) {
    throw new Error('builder.cursor is required for cursor mode (cannot prompt in non-TTY).');
  }
  raw.builder = {
    ...raw.builder,
    default_mode: 'cursor',
    cursor: {
      driver_kind: cursor.driver_kind ?? 'cursor_agent',
      command: cursor.command,
      args: cursor.args,
      timeout_seconds: cursor.timeout_seconds,
      output_file: cursor.output_file,
    },
  };

  // Validate before writing (keeps strict cursor requirements)
  if (!validateConfig(raw)) {
    throw new Error('Updated config is invalid (validateConfig failed).');
  }

  await atomicWriteJson(configPath, raw);

  if (options.json) {
    console.log(
      JSON.stringify(
        {
          default_mode: raw.builder.default_mode,
          cursor_configured: raw.builder.cursor ? 'yes' : 'no',
        },
        null,
        2
      )
    );
    return;
  }

  const meta = describeBuilder(next);
  console.log(`\nBuilder set to: ${next} — ${meta.title}`);
  console.log(`If your driver isn't installed/configured yet, the next tick will BLOCK until you fix builder.cursor.`);
}
