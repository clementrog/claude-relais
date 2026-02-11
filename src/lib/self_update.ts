import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { isKnownPackageName } from './branding.js';

type PackageManager = 'pnpm' | 'npm' | 'yarn' | 'bun';

export interface LinkedRefreshResult {
  linkedRoot: string | null;
  stale: boolean;
  refreshed: boolean;
  manager?: PackageManager;
  error?: string;
}

function isTestRuntime(): boolean {
  return process.env.VITEST === 'true' || process.env.NODE_ENV === 'test';
}

function findNearestEnvoiPackageRoot(entrypointPath: string): string | null {
  let cursor = dirname(entrypointPath);
  const root = resolve('/');

  while (true) {
    const packageJsonPath = join(cursor, 'package.json');
    if (existsSync(packageJsonPath)) {
      try {
        const parsed = JSON.parse(readFileSync(packageJsonPath, 'utf-8')) as { name?: string };
        if (isKnownPackageName(parsed.name)) {
          return cursor;
        }
      } catch {
        // Ignore parse failures and continue walking up.
      }
    }

    if (cursor === root || cursor === dirname(cursor)) return null;
    cursor = dirname(cursor);
  }
}

export function detectLinkedInstallRoot(entrypointArg = process.argv[1]): string | null {
  if (isTestRuntime()) return null;
  if (!entrypointArg) return null;
  let resolvedEntrypoint: string;
  try {
    resolvedEntrypoint = realpathSync(entrypointArg);
  } catch {
    return null;
  }

  const packageRoot = findNearestEnvoiPackageRoot(resolvedEntrypoint);
  if (!packageRoot) return null;

  const looksLinked =
    existsSync(join(packageRoot, '.git')) &&
    existsSync(join(packageRoot, 'src', 'index.ts')) &&
    existsSync(join(packageRoot, 'dist', 'index.js'));
  return looksLinked ? packageRoot : null;
}

function newestMtimeInTree(root: string): number {
  if (!existsSync(root)) return 0;
  let newest = 0;
  const stack: string[] = [root];

  while (stack.length > 0) {
    const current = stack.pop()!;
    let stats;
    try {
      stats = statSync(current);
    } catch {
      continue;
    }
    newest = Math.max(newest, stats.mtimeMs);

    if (!stats.isDirectory()) continue;

    let entries: string[];
    try {
      entries = readdirSync(current);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry === '.git' || entry === 'node_modules' || entry === 'dist') continue;
      stack.push(join(current, entry));
    }
  }

  return newest;
}

function latestSourceMtime(linkedRoot: string): number {
  const candidates = [
    join(linkedRoot, 'src'),
    join(linkedRoot, 'relais'),
    join(linkedRoot, 'README.md'),
    join(linkedRoot, 'envoi.config.json'),
    join(linkedRoot, 'relais.config.json'),
    join(linkedRoot, 'package.json'),
  ];

  let newest = 0;
  for (const candidate of candidates) {
    newest = Math.max(newest, newestMtimeInTree(candidate));
  }
  return newest;
}

function distMtime(linkedRoot: string): number {
  const distEntry = join(linkedRoot, 'dist', 'index.js');
  if (!existsSync(distEntry)) return 0;
  try {
    return statSync(distEntry).mtimeMs;
  } catch {
    return 0;
  }
}

function detectManager(linkedRoot: string): PackageManager {
  const packageJsonPath = join(linkedRoot, 'package.json');
  try {
    const parsed = JSON.parse(readFileSync(packageJsonPath, 'utf-8')) as { packageManager?: string };
    const value = parsed.packageManager ?? '';
    if (value.startsWith('pnpm@')) return 'pnpm';
    if (value.startsWith('npm@')) return 'npm';
    if (value.startsWith('yarn@')) return 'yarn';
    if (value.startsWith('bun@')) return 'bun';
  } catch {
    // Fall through.
  }
  return 'pnpm';
}

function runBuild(linkedRoot: string, manager: PackageManager): { ok: boolean; error?: string } {
  const commandMap: Record<PackageManager, { cmd: string; args: string[] }> = {
    pnpm: { cmd: 'pnpm', args: ['-C', linkedRoot, 'build'] },
    npm: { cmd: 'npm', args: ['--prefix', linkedRoot, 'run', 'build'] },
    yarn: { cmd: 'yarn', args: ['--cwd', linkedRoot, 'build'] },
    bun: { cmd: 'bun', args: ['--cwd', linkedRoot, 'run', 'build'] },
  };
  const command = commandMap[manager];
  const result = spawnSync(command.cmd, command.args, { stdio: 'inherit' });
  if (result.status === 0) return { ok: true };
  return { ok: false, error: `Build command failed (${result.status ?? 'unknown'}): ${command.cmd} ${command.args.join(' ')}` };
}

export function isLinkedInstallStale(linkedRoot: string): boolean {
  return latestSourceMtime(linkedRoot) > distMtime(linkedRoot);
}

export function refreshLinkedInstallIfStale(): LinkedRefreshResult {
  if (isTestRuntime()) {
    return { linkedRoot: null, stale: false, refreshed: false };
  }
  const linkedRoot = detectLinkedInstallRoot();
  if (!linkedRoot) {
    return { linkedRoot: null, stale: false, refreshed: false };
  }

  const stale = isLinkedInstallStale(linkedRoot);
  if (!stale) {
    return { linkedRoot, stale: false, refreshed: false };
  }

  const manager = detectManager(linkedRoot);
  const build = runBuild(linkedRoot, manager);
  if (!build.ok) {
    return {
      linkedRoot,
      stale: true,
      refreshed: false,
      manager,
      error: build.error,
    };
  }

  return {
    linkedRoot,
    stale: true,
    refreshed: true,
    manager,
  };
}
