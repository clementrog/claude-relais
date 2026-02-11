import { access, readFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { realpathSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { isKnownPackageName, CLI_NAME, PACKAGE_NAME } from '../lib/branding.js';

type UpdateMode = 'auto' | 'linked' | 'registry';
type PackageManager = 'pnpm' | 'npm' | 'yarn' | 'bun';

export interface UpdateCommandOptions {
  mode?: string;
  manager?: string;
  dryRun?: boolean;
  yes?: boolean;
}

interface InstallDetection {
  linkedRoot: string | null;
  detectedMode: 'linked' | 'registry';
  resolvedEntrypoint: string;
  packageName: string | null;
}

interface PlannedCommand {
  cmd: string;
  args: string[];
  cwd?: string;
}

interface PlannedUpdate {
  mode: 'linked' | 'registry';
  manager: PackageManager;
  linkedRoot: string | null;
  commands: PlannedCommand[];
  resolvedEntrypoint: string;
  packageName: string;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function parseMode(mode?: string): UpdateMode {
  if (!mode || mode === 'auto') return 'auto';
  if (mode === 'linked' || mode === 'registry') return mode;
  throw new Error(`Invalid mode: ${mode}. Must be 'auto', 'linked', or 'registry'.`);
}

function parseManager(manager?: string): PackageManager | null {
  if (!manager) return null;
  if (manager === 'pnpm' || manager === 'npm' || manager === 'yarn' || manager === 'bun') {
    return manager;
  }
  throw new Error(`Invalid manager: ${manager}. Must be 'pnpm', 'npm', 'yarn', or 'bun'.`);
}

function isCommandAvailable(command: string): boolean {
  const result = spawnSync(command, ['--version'], { stdio: 'pipe' });
  return result.status === 0;
}

function pickAvailableManager(preferred?: PackageManager | null): PackageManager {
  if (preferred) {
    if (!isCommandAvailable(preferred)) {
      throw new Error(`Requested package manager '${preferred}' is not available in PATH.`);
    }
    return preferred;
  }
  const candidates: PackageManager[] = ['pnpm', 'npm', 'yarn', 'bun'];
  for (const candidate of candidates) {
    if (isCommandAvailable(candidate)) return candidate;
  }
  throw new Error('No supported package manager found in PATH (pnpm/npm/yarn/bun).');
}

async function readPackageManagerFromPackageJson(root: string): Promise<PackageManager | null> {
  const packagePath = join(root, 'package.json');
  if (!(await pathExists(packagePath))) return null;
  try {
    const raw = JSON.parse(await readFile(packagePath, 'utf-8')) as { packageManager?: string };
    if (!raw.packageManager) return null;
    if (raw.packageManager.startsWith('pnpm@')) return 'pnpm';
    if (raw.packageManager.startsWith('npm@')) return 'npm';
    if (raw.packageManager.startsWith('yarn@')) return 'yarn';
    if (raw.packageManager.startsWith('bun@')) return 'bun';
    return null;
  } catch {
    return null;
  }
}

function findNearestPackageRoot(entrypointPath: string): string | null {
  let cursor = dirname(entrypointPath);
  const root = resolve('/');
  while (true) {
    const packageJson = join(cursor, 'package.json');
    try {
      const parsed = JSON.parse(readFileSync(packageJson, 'utf-8')) as { name?: string };
      if (isKnownPackageName(parsed.name)) {
        return cursor;
      }
    } catch {
      // not found
    }
    if (cursor === root || cursor === dirname(cursor)) return null;
    cursor = dirname(cursor);
  }
}

async function detectInstall(): Promise<InstallDetection> {
  const entrypointArg = process.argv[1];
  if (!entrypointArg) {
    return { linkedRoot: null, detectedMode: 'registry', resolvedEntrypoint: '(unknown)', packageName: null };
  }

  let resolvedEntrypoint: string;
  try {
    resolvedEntrypoint = realpathSync(entrypointArg);
  } catch {
    return { linkedRoot: null, detectedMode: 'registry', resolvedEntrypoint: entrypointArg, packageName: null };
  }
  const packageRoot = findNearestPackageRoot(resolvedEntrypoint);
  if (!packageRoot) {
    return { linkedRoot: null, detectedMode: 'registry', resolvedEntrypoint, packageName: null };
  }
  let packageName: string | null = null;
  try {
    const parsed = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf-8')) as { name?: string };
    packageName = parsed.name ?? null;
  } catch {
    packageName = null;
  }

  const gitDir = join(packageRoot, '.git');
  const srcIndex = join(packageRoot, 'src', 'index.ts');
  const isLinked = (await pathExists(gitDir)) && (await pathExists(srcIndex));
  return {
    linkedRoot: isLinked ? packageRoot : null,
    detectedMode: isLinked ? 'linked' : 'registry',
    resolvedEntrypoint,
    packageName,
  };
}

function linkedUpdateCommands(manager: PackageManager, linkedRoot: string): PlannedCommand[] {
  if (manager === 'pnpm') {
    return [
      { cmd: 'pnpm', args: ['-C', linkedRoot, 'build'] },
      { cmd: 'pnpm', args: ['-C', linkedRoot, 'link', '--global'] },
    ];
  }
  if (manager === 'npm') {
    return [
      { cmd: 'npm', args: ['--prefix', linkedRoot, 'run', 'build'] },
      { cmd: 'npm', args: ['--prefix', linkedRoot, 'link'] },
    ];
  }
  if (manager === 'yarn') {
    return [
      { cmd: 'yarn', args: ['--cwd', linkedRoot, 'build'] },
      { cmd: 'yarn', args: ['--cwd', linkedRoot, 'link'] },
    ];
  }
  return [
    { cmd: 'bun', args: ['--cwd', linkedRoot, 'run', 'build'] },
    { cmd: 'bun', args: ['--cwd', linkedRoot, 'link'] },
  ];
}

function registryUpdateCommands(manager: PackageManager, packageName: string): PlannedCommand[] {
  const target = `${packageName}@latest`;
  if (manager === 'pnpm') return [{ cmd: 'pnpm', args: ['add', '-g', target] }];
  if (manager === 'npm') return [{ cmd: 'npm', args: ['install', '-g', target] }];
  if (manager === 'yarn') return [{ cmd: 'yarn', args: ['global', 'add', target] }];
  return [{ cmd: 'bun', args: ['add', '-g', target] }];
}

export async function buildUpdatePlan(options: UpdateCommandOptions): Promise<PlannedUpdate> {
  const mode = parseMode(options.mode);
  const requestedManager = parseManager(options.manager);
  const detection = await detectInstall();

  const chosenMode: 'linked' | 'registry' =
    mode === 'auto' ? detection.detectedMode : mode;

  if (chosenMode === 'linked' && !detection.linkedRoot) {
    throw new Error(
      "Unable to detect a linked development install. Use '--mode registry' or run from a linked checkout."
    );
  }

  let manager: PackageManager;
  if (chosenMode === 'linked') {
    const inferred =
      requestedManager ??
      (await readPackageManagerFromPackageJson(detection.linkedRoot!));
    manager = pickAvailableManager(inferred);
    return {
      mode: 'linked',
      manager,
      linkedRoot: detection.linkedRoot,
      commands: linkedUpdateCommands(manager, detection.linkedRoot!),
      resolvedEntrypoint: detection.resolvedEntrypoint,
      packageName: detection.packageName ?? PACKAGE_NAME,
    };
  }

  manager = pickAvailableManager(requestedManager);
  const packageName = PACKAGE_NAME;
  return {
    mode: 'registry',
    manager,
    linkedRoot: null,
    commands: registryUpdateCommands(manager, packageName),
    resolvedEntrypoint: detection.resolvedEntrypoint,
    packageName,
  };
}

function renderCommand(command: PlannedCommand): string {
  return [command.cmd, ...command.args].join(' ');
}

async function confirmExecute(plan: PlannedUpdate): Promise<boolean> {
  if (!input.isTTY) return false;
  const rl = readline.createInterface({ input, output });
  try {
    const answer = (await rl.question('Execute update now? [y/N]: ')).trim().toLowerCase();
    return answer === 'y' || answer === 'yes';
  } finally {
    rl.close();
  }
}

function runPlannedCommands(plan: PlannedUpdate): void {
  for (const command of plan.commands) {
    const result = spawnSync(command.cmd, command.args, {
      cwd: command.cwd,
      stdio: 'inherit',
    });
    if (result.status !== 0) {
      throw new Error(`Command failed (${result.status}): ${renderCommand(command)}`);
    }
  }
}

export async function updateCommand(options: UpdateCommandOptions): Promise<void> {
  const plan = await buildUpdatePlan(options);
  const dryRun = Boolean(options.dryRun);

  console.log(`Update strategy: ${plan.mode}`);
  console.log(`Target package: ${plan.packageName}`);
  console.log(`Package manager: ${plan.manager}`);
  if (plan.linkedRoot) {
    console.log(`Linked root: ${plan.linkedRoot}`);
  }
  console.log(`Entrypoint: ${plan.resolvedEntrypoint}`);
  console.log('Planned commands:');
  for (const command of plan.commands) {
    console.log(`  - ${renderCommand(command)}`);
  }

  if (dryRun) return;

  if (!options.yes) {
    if (!input.isTTY) {
      throw new Error('Non-interactive mode requires --yes (or use --dry-run).');
    }
    const proceed = await confirmExecute(plan);
    if (!proceed) {
      console.log('Update canceled.');
      return;
    }
  }

  runPlannedCommands(plan);
  console.log('Update complete.');
}
