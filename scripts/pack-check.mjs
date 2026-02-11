#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

const requiredFiles = [
  'SKILL.md',
  'agents/openai.yaml',
  'references/how-it-works.md',
  'scripts/install.sh',
  'README.md',
];

const forbiddenPrefixes = [
  '.claude/',
  '.npm-cache/',
  'docs/',
  'relais/',
  'prd/',
  'src/',
  'tests/',
];
const cacheDir = resolve('.npm-cache');

function fail(message) {
  console.error(`[pack:check] ${message}`);
  process.exit(1);
}

let packJson;
try {
  const stdout = execFileSync(
    'npm',
    ['--cache', cacheDir, 'pack', '--dry-run', '--json', '--ignore-scripts'],
    {
      encoding: 'utf-8',
      env: {
        ...process.env,
        npm_config_cache: process.env.npm_config_cache ?? '.npm-cache',
        NPM_CONFIG_CACHE: process.env.NPM_CONFIG_CACHE ?? process.env.npm_config_cache ?? '.npm-cache',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    }
  );
  const parsed = JSON.parse(stdout);
  packJson = Array.isArray(parsed) ? parsed[0] : parsed;
} catch (error) {
  const stderr = error && typeof error === 'object' && 'stderr' in error ? String(error.stderr ?? '') : '';
  const stdout = error && typeof error === 'object' && 'stdout' in error ? String(error.stdout ?? '') : '';
  const detail = [stderr.trim(), stdout.trim()].filter(Boolean).join('\n');
  fail(
    `Unable to inspect npm pack output: ${error instanceof Error ? error.message : String(error)}${
      detail ? `\n${detail}` : ''
    }`
  );
}

if (!packJson || !Array.isArray(packJson.files)) {
  fail('Unexpected npm pack JSON output (missing files list).');
}

const files = new Set(packJson.files.map((entry) => entry.path));

for (const required of requiredFiles) {
  if (!files.has(required)) {
    fail(`Missing required runtime file in tarball: ${required}`);
  }
}

for (const file of files) {
  for (const prefix of forbiddenPrefixes) {
    if (file.startsWith(prefix)) {
      fail(`Forbidden path found in tarball: ${file}`);
    }
  }
}

console.log(`[pack:check] OK (${files.size} files in dry-run tarball)`);
