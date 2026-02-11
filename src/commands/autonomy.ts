import { resolve } from 'node:path';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';

import { atomicReadJson, atomicWriteJson } from '../lib/fs.js';
import { CONFIG_FILE_NAME, ConfigError, findConfigFile } from '../lib/config.js';
import type { EnvoiConfig } from '../types/config.js';
import { describeAutonomyProfile } from '../lib/autonomy.js';
import {
  DEFAULT_NETWORK_PREFIXES,
  DEFAULT_READ_ONLY_PREFIXES,
  DEFAULT_WORKSPACE_WRITE_PREFIXES,
} from '../lib/command_policy.js';

type AutonomyProfile = 'strict' | 'balanced' | 'fast';

function normalizePrefixEntries(entries: string[] | undefined): string[] {
  if (!Array.isArray(entries)) return [];
  return [...new Set(entries.map((entry) => entry.trim()).filter((entry) => entry.length > 0))];
}

function parseProfile(value?: string): AutonomyProfile | null {
  if (!value) return null;
  if (value === 'strict' || value === 'balanced' || value === 'fast') return value;
  throw new Error(`Invalid profile: ${value}. Must be 'strict', 'balanced', or 'fast'.`);
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

async function promptProfile(current: AutonomyProfile): Promise<AutonomyProfile> {
  const rl = readline.createInterface({ input, output });
  try {
    const options: AutonomyProfile[] = ['strict', 'balanced', 'fast'];
    console.log('\nChoose autonomy profile:');
    options.forEach((profile, index) => {
      const suffix = profile === current ? ' (current)' : '';
      console.log(`  ${index + 1}. ${profile}${suffix}`);
      console.log(`     ${describeAutonomyProfile(profile)}`);
    });
    const answer = (await rl.question(`Profile [1-3] (default ${current}): `)).trim();
    if (!answer) return current;
    const index = Number.parseInt(answer, 10);
    if (index >= 1 && index <= options.length) return options[index - 1];
    if (answer === 'strict' || answer === 'balanced' || answer === 'fast') return answer;
    throw new Error('Invalid selection');
  } finally {
    rl.close();
  }
}

export async function autonomyCommand(options: {
  configPath?: string;
  set?: string;
  json?: boolean;
  trustAdd?: string[];
  trustRemove?: string[];
  trustList?: boolean;
}): Promise<void> {
  const configPath = await resolveConfigPath(options.configPath);
  const raw = await atomicReadJson<EnvoiConfig>(configPath);

  const existingAutonomy = raw.runner.autonomy;
  const existingAllow = normalizePrefixEntries(existingAutonomy?.allow_prefixes);

  if (options.trustList) {
    if (options.json) {
      console.log(JSON.stringify({ allow_prefixes: existingAllow }, null, 2));
      return;
    }
    console.log('\nTrusted command prefixes:');
    if (existingAllow.length === 0) {
      console.log('  (none)');
    } else {
      for (const prefix of existingAllow) {
        console.log(`  - ${prefix}`);
      }
    }
    return;
  }

  const trustAdd = normalizePrefixEntries(options.trustAdd);
  const trustRemove = normalizePrefixEntries(options.trustRemove);

  const current = (raw.runner.autonomy?.profile ?? 'balanced') as AutonomyProfile;
  const selected = parseProfile(options.set) ?? (input.isTTY ? await promptProfile(current) : current);
  let nextAllowPrefixes = [...existingAllow];
  if (trustAdd.length > 0) {
    nextAllowPrefixes = [...new Set([...nextAllowPrefixes, ...trustAdd])];
  }
  if (trustRemove.length > 0) {
    const removeSet = new Set(trustRemove);
    nextAllowPrefixes = nextAllowPrefixes.filter((prefix) => !removeSet.has(prefix));
  }
  const trustMutated = trustAdd.length > 0 || trustRemove.length > 0;
  raw.runner = {
    ...raw.runner,
    autonomy: {
      profile: selected,
      command_trust: existingAutonomy?.command_trust ?? [],
      allow_prefixes: trustMutated
        ? nextAllowPrefixes
        : (existingAutonomy?.allow_prefixes ?? DEFAULT_READ_ONLY_PREFIXES),
      deny_prefixes: existingAutonomy?.deny_prefixes ?? [],
      allow_network_prefixes:
        existingAutonomy?.allow_network_prefixes ??
        (selected === 'fast' ? DEFAULT_NETWORK_PREFIXES : []),
      allow_workspace_write_prefixes:
        existingAutonomy?.allow_workspace_write_prefixes ??
        (selected === 'fast' ? DEFAULT_WORKSPACE_WRITE_PREFIXES : []),
      require_explicit_for_destructive: existingAutonomy?.require_explicit_for_destructive ?? true,
      audit_log: existingAutonomy?.audit_log ?? {
        enabled: true,
        path: `${raw.workspace_dir}/history/autonomy.log`,
      },
      fs_policy: existingAutonomy?.fs_policy ?? 'workspace_write',
      network_policy: existingAutonomy?.network_policy ?? 'deny',
    },
  };

  if (selected === 'strict') {
    raw.orchestrator = { ...raw.orchestrator, permission_mode: 'plan' };
    raw.builder = {
      ...raw.builder,
      claude_code: { ...raw.builder.claude_code, permission_mode: 'plan' },
    };
  } else if (selected === 'fast') {
    raw.orchestrator = { ...raw.orchestrator, permission_mode: 'bypassPermissions' };
    raw.builder = {
      ...raw.builder,
      claude_code: { ...raw.builder.claude_code, permission_mode: 'bypassPermissions' },
    };
  }

  // Orchestrator should stay read-oriented; removing Bash dramatically reduces pointless approval prompts.
  raw.orchestrator = {
    ...raw.orchestrator,
    allowed_tools: 'Read,Glob,Grep',
  };

  await atomicWriteJson(configPath, raw);

  if (options.json) {
    console.log(
      JSON.stringify(
        {
          profile: selected,
          allow_prefixes: raw.runner.autonomy?.allow_prefixes ?? [],
          orchestrator_permission_mode: raw.orchestrator.permission_mode,
          builder_permission_mode: raw.builder.claude_code.permission_mode,
        },
        null,
        2
      )
    );
    return;
  }

  console.log(`\nAutonomy profile set to: ${selected}`);
  console.log(describeAutonomyProfile(selected));
  console.log(`Orchestrator permission mode: ${raw.orchestrator.permission_mode}`);
  console.log(`Builder permission mode: ${raw.builder.claude_code.permission_mode}`);
}
