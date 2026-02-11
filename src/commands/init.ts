/**
 * Initialize Envoi workspace in the current directory.
 *
 * Creates the directory structure, copies templates, and sets up configuration.
 */

import { mkdir, copyFile, access, readFile, writeFile } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { addEnvoiIgnores, getEnvoiGitignoreEntries } from '../lib/gitignore.js';
import { atomicWriteJson } from '../lib/fs.js';
import { getGitTopLevel, isGitRepo } from '../lib/git.js';
import { CLI_NAME, CONFIG_FILE_NAME, PRODUCT_NAME, WORKSPACE_DIR_NAME } from '../lib/branding.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Path to package assets (prompts/schemas templates)
 */
const ASSET_PACKAGE_ROOT = join(__dirname, '../../relais');

/**
 * Prompts to copy from package prompts to workspace
 */
const PROMPTS_TO_COPY = [
  'orchestrator.system.txt',
  'orchestrator.user.txt',
  'builder.system.txt',
  'builder.user.txt',
  'reviewer.system.txt',
  'reviewer.user.txt',
];

/**
 * Schemas to copy from package schemas to workspace
 */
const SCHEMAS_TO_COPY = [
  'task.schema.json',
  'builder_result.schema.json',
  'report.schema.json',
  'reviewer_result.schema.json',
];

/**
 * Default STATE.json content for new workspace
 */
function createInitialState(): {
  v: number;
  phase: string;
  mode: string;
  task: null;
  milestone: null;
  branch: string;
  batch_tasks: never[];
  attempt: number;
  blockers: never[];
  next: null;
  ts: string;
  milestone_id: string | null;
  budgets: { ticks: number; orchestrator_calls: number; builder_calls: number; verify_runs: number };
  budget_warning: boolean;
  last_run_id: string | null;
  last_verdict: string | null;
  idea_inbox: never[];
  planning_digest: null;
  open_product_questions: never[];
} {
  return {
    v: 3,
    phase: 'IDLE',
    mode: 'single',
    task: null,
    milestone: null,
    branch: 'main',
    batch_tasks: [],
    attempt: 0,
    blockers: [],
    next: null,
    ts: new Date().toISOString(),
    milestone_id: null,
    budgets: {
      ticks: 0,
      orchestrator_calls: 0,
      builder_calls: 0,
      verify_runs: 0,
    },
    budget_warning: false,
    last_run_id: null,
    last_verdict: null,
    idea_inbox: [],
    planning_digest: null,
    open_product_questions: [],
  };
}

/**
 * Checks if a file or directory exists
 */
async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function writeTextFileSafe(
  dest: string,
  contents: string,
  force: boolean
): Promise<{ written: boolean; reason?: string }> {
  if (await exists(dest)) {
    if (!force) {
      return { written: false, reason: `File already exists: ${dest} (use --force to overwrite)` };
    }
  }
  await mkdir(dirname(dest), { recursive: true });
  await writeFile(dest, contents, 'utf-8');
  return { written: true };
}

/**
 * Detects the package manager based on lockfiles present in the directory.
 *
 * @param repoRoot - The repository root directory to check
 * @returns The detected package manager: 'pnpm', 'npm', 'yarn', 'bun', or 'pnpm' as default
 */
async function detectPackageManager(repoRoot: string): Promise<'pnpm' | 'npm' | 'yarn' | 'bun'> {
  // Check in order of preference (pnpm-workspace.yaml first, then lockfiles)
  if (await exists(join(repoRoot, 'pnpm-workspace.yaml'))) {
    return 'pnpm';
  }
  if (await exists(join(repoRoot, 'pnpm-lock.yaml'))) {
    return 'pnpm';
  }
  if (await exists(join(repoRoot, 'package-lock.json'))) {
    return 'npm';
  }
  if (await exists(join(repoRoot, 'yarn.lock'))) {
    return 'yarn';
  }
  if (await exists(join(repoRoot, 'bun.lockb'))) {
    return 'bun';
  }
  // Default to pnpm if no lockfile found
  return 'pnpm';
}

/**
 * Checks if pnpm workspace is configured (pnpm-workspace.yaml exists).
 *
 * @param repoRoot - The repository root directory to check
 * @returns true if pnpm-workspace.yaml exists
 */
async function isPnpmWorkspace(repoRoot: string): Promise<boolean> {
  return await exists(join(repoRoot, 'pnpm-workspace.yaml'));
}

/**
 * Generates verification template args based on package manager and workspace detection.
 *
 * @param pkgManager - The detected package manager
 * @param isWorkspace - Whether this is a pnpm workspace
 * @returns Array of args for the verification command
 */
function getVerificationArgs(pkgManager: 'pnpm' | 'npm' | 'yarn' | 'bun', isWorkspace: boolean): string[] {
  if (pkgManager === 'pnpm') {
    return isWorkspace ? ['-w'] : [];
  }
  // npm, yarn, and bun don't have workspace flags in the same way
  return [];
}

/**
 * Gets the command name for the package manager.
 *
 * @param pkgManager - The detected package manager
 * @returns The command name (e.g., 'pnpm', 'npm', 'yarn', 'bun')
 */
function getPackageManagerCommand(pkgManager: 'pnpm' | 'npm' | 'yarn' | 'bun'): string {
  return pkgManager;
}

/**
 * Copies a file from source to destination, optionally overwriting
 */
async function copyFileSafe(
  source: string,
  dest: string,
  force: boolean
): Promise<{ copied: boolean; reason?: string }> {
  if (!(await exists(source))) {
    return { copied: false, reason: `Source file does not exist: ${source}` };
  }

  if (await exists(dest)) {
    if (!force) {
      return { copied: false, reason: `File already exists: ${dest} (use --force to overwrite)` };
    }
  }

  // Ensure destination directory exists
  await mkdir(dirname(dest), { recursive: true });
  await copyFile(source, dest);
  return { copied: true };
}

/**
 * Reads the default config template and adjusts workspace_dir and verification templates
 */
async function createConfigFile(
  workspaceDir: string,
  force: boolean,
  repoRoot: string,
  pkgManager: 'pnpm' | 'npm' | 'yarn' | 'bun',
  isWorkspace: boolean
): Promise<{ created: boolean; reason?: string }> {
  const configPath = join(repoRoot, CONFIG_FILE_NAME);

  if (await exists(configPath) && !force) {
    return { created: false, reason: `Config file already exists: ${configPath} (use --force to overwrite)` };
  }

  // Read the template from package root (prefer envoi config, fallback to legacy)
  const primaryTemplatePath = join(ASSET_PACKAGE_ROOT, `../${CONFIG_FILE_NAME}`);
  const legacyTemplatePath = join(ASSET_PACKAGE_ROOT, '../relais.config.json');
  const templatePath = (await exists(primaryTemplatePath)) ? primaryTemplatePath : legacyTemplatePath;
  if (!(await exists(templatePath))) {
    // Fallback: create a minimal config
    const minimalConfig = {
      version: '1.0',
      product_name: PRODUCT_NAME.toLowerCase(),
      workspace_dir: workspaceDir,
      runner: {
        require_git: true,
        max_tick_seconds: 900,
        lockfile: `${workspaceDir}/lock.json`,
        runner_owned_globs: [
        `${workspaceDir}/STATE.json`,
        `${workspaceDir}/TASK.json`,
        `${workspaceDir}/REPORT.json`,
        `${workspaceDir}/REPORT.md`,
        `${workspaceDir}/BLOCKED.json`,
        `${workspaceDir}/FACTS.md`,
        `${workspaceDir}/history/**`,
        `${workspaceDir}/lock.json`,
        `${workspaceDir}/schemas/**`,
        `${workspaceDir}/prompts/**`,
      ],
      },
      claude_code_cli: {
        command: 'claude',
        output_format: 'json',
        no_session_persistence: true,
      },
      models: {
        orchestrator_model: 'opus',
        orchestrator_fallback_model: 'sonnet',
        builder_model: 'sonnet',
        builder_fallback_model: 'haiku',
      },
    };
    await atomicWriteJson(configPath, minimalConfig);
    return { created: true };
  }

  // Read and adjust the template
  const template = JSON.parse(await readFile(templatePath, 'utf-8'));
  template.workspace_dir = workspaceDir;
  
  // Adjust paths in runner_owned_globs
  if (template.runner?.runner_owned_globs) {
    template.runner.runner_owned_globs = template.runner.runner_owned_globs.map((glob: string) =>
      glob.replace(/^(?:relais|envoi)\//, `${workspaceDir}/`)
    );
  }
  
  // Adjust lockfile path
  if (template.runner?.lockfile) {
    template.runner.lockfile = template.runner.lockfile.replace(/^(?:relais|envoi)\//, `${workspaceDir}/`);
  }
  
  // Adjust prompt and schema paths
  if (template.orchestrator?.system_prompt_file) {
    template.orchestrator.system_prompt_file = template.orchestrator.system_prompt_file.replace(
      /^(?:relais|envoi)\//,
      `${workspaceDir}/`
    );
  }
  if (template.orchestrator?.user_prompt_file) {
    template.orchestrator.user_prompt_file = template.orchestrator.user_prompt_file.replace(
      /^(?:relais|envoi)\//,
      `${workspaceDir}/`
    );
  }
  if (template.orchestrator?.task_schema_file) {
    template.orchestrator.task_schema_file = template.orchestrator.task_schema_file.replace(
      /^(?:relais|envoi)\//,
      `${workspaceDir}/`
    );
  }
  if (template.builder?.claude_code?.system_prompt_file) {
    template.builder.claude_code.system_prompt_file = template.builder.claude_code.system_prompt_file.replace(
      /^(?:relais|envoi)\//,
      `${workspaceDir}/`
    );
  }
  if (template.builder?.claude_code?.user_prompt_file) {
    template.builder.claude_code.user_prompt_file = template.builder.claude_code.user_prompt_file.replace(
      /^(?:relais|envoi)\//,
      `${workspaceDir}/`
    );
  }
  if (template.builder?.claude_code?.builder_result_schema_file) {
    template.builder.claude_code.builder_result_schema_file = template.builder.claude_code.builder_result_schema_file.replace(
      /^(?:relais|envoi)\//,
      `${workspaceDir}/`
    );
  }
  if (template.history?.dir) {
    template.history.dir = template.history.dir.replace(/^(?:relais|envoi)\//, `${workspaceDir}/`);
  }

  // Adjust verification templates based on detected package manager and workspace
  if (template.verification?.templates && Array.isArray(template.verification.templates)) {
    const cmd = getPackageManagerCommand(pkgManager);
    const baseArgs = getVerificationArgs(pkgManager, isWorkspace);
    
    for (const templateItem of template.verification.templates) {
      if (templateItem.cmd) {
        templateItem.cmd = cmd;
      }
      if (Array.isArray(templateItem.args)) {
        // Replace args, preserving any template params
        const newArgs: string[] = [];
        for (const arg of templateItem.args) {
          // If it's a workspace flag (-w), only include if isWorkspace
          if (arg === '-w' && !isWorkspace) {
            continue;
          }
          // If it's the command name, replace with detected package manager command
          if (arg === 'pnpm' || arg === 'npm' || arg === 'yarn' || arg === 'bun') {
            // Skip, we'll add base args separately
            continue;
          }
          // Keep other args (like 'lint', 'test', etc.)
          newArgs.push(arg);
        }
        // Prepend base args (workspace flag if needed)
        templateItem.args = [...baseArgs, ...newArgs];
      }
    }
  }

  await atomicWriteJson(configPath, template);
  return { created: true };
}

/**
 * Initializes an Envoi workspace in the current directory.
 *
 * @param options - Command options
 * @param options.force - Overwrite existing files
 * @param options.workspaceDir - Workspace directory name (default: 'envoi')
 */
export async function initCommand(options: { force?: boolean; workspaceDir?: string; showNextSteps?: boolean } = {}): Promise<void> {
  const { force = false, workspaceDir = WORKSPACE_DIR_NAME, showNextSteps = true } = options;
  
  // Determine repository root: use git top-level if in git, otherwise use current directory
  let repoRoot: string;
  if (isGitRepo()) {
    const gitTopLevel = getGitTopLevel();
    if (gitTopLevel) {
      repoRoot = gitTopLevel;
    } else {
      repoRoot = process.cwd();
    }
  } else {
    repoRoot = process.cwd();
  }
  
  // Detect package manager and workspace configuration
  const pkgManager = await detectPackageManager(repoRoot);
  const isWorkspace = await isPnpmWorkspace(repoRoot);
  
  const workspacePath = join(repoRoot, workspaceDir);

  const errors: string[] = [];
  const skippedExisting: string[] = [];

  // 1. Create directory structure
  const directories = [
    workspacePath,
    join(workspacePath, 'prompts'),
    join(workspacePath, 'schemas'),
    join(workspacePath, 'history'),
  ];

  for (const dir of directories) {
    try {
      await mkdir(dir, { recursive: true });
    } catch (error) {
      errors.push(`Failed to create directory ${dir}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // 2. Copy prompt templates
  for (const prompt of PROMPTS_TO_COPY) {
    const source = join(ASSET_PACKAGE_ROOT, 'prompts', prompt);
    const dest = join(workspacePath, 'prompts', prompt);
    const result = await copyFileSafe(source, dest, force);
    if (!result.copied) {
      if (result.reason?.includes('already exists')) {
        skippedExisting.push(result.reason);
      } else {
        errors.push(`Failed to copy ${prompt}: ${result.reason || 'Unknown error'}`);
      }
    }
  }

  // 3. Copy schema files
  for (const schema of SCHEMAS_TO_COPY) {
    const source = join(ASSET_PACKAGE_ROOT, 'schemas', schema);
    const dest = join(workspacePath, 'schemas', schema);
    const result = await copyFileSafe(source, dest, force);
    if (!result.copied) {
      if (result.reason?.includes('already exists')) {
        skippedExisting.push(result.reason);
      } else {
        errors.push(`Failed to copy ${schema}: ${result.reason || 'Unknown error'}`);
      }
    }
  }

  // 4. Initialize STATE.json
  const statePath = join(workspacePath, 'STATE.json');
  if (await exists(statePath) && !force) {
    skippedExisting.push(`STATE.json already exists: ${statePath} (use --force to overwrite)`);
  } else {
    try {
      await atomicWriteJson(statePath, createInitialState());
    } catch (error) {
      errors.push(`Failed to create STATE.json: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // 4b. Create FACTS.md + PRD.md placeholders (user-authored, runner-owned)
  const factsPath = join(workspacePath, 'FACTS.md');
  const prdPath = join(workspacePath, 'PRD.md');
  const factsResult = await writeTextFileSafe(
    factsPath,
    `# FACTS\n\n(Short, curated facts about this repo. Keep it tight.)\n`,
    force
  );
  if (!factsResult.written && factsResult.reason?.includes('already exists')) {
    // Do not treat as fatal; it's expected on re-init without --force
  } else if (!factsResult.written && factsResult.reason) {
    errors.push(factsResult.reason);
  }
  const prdResult = await writeTextFileSafe(
    prdPath,
    `# PRD\n\n(Paste the user PRD here. This is the source of truth.)\n`,
    force
  );
  if (!prdResult.written && prdResult.reason?.includes('already exists')) {
    // expected
  } else if (!prdResult.written && prdResult.reason) {
    errors.push(prdResult.reason);
  }

  // 5. Create config file
  const configResult = await createConfigFile(workspaceDir, force, repoRoot, pkgManager, isWorkspace);
  if (!configResult.created && configResult.reason) {
    if (configResult.reason.includes('already exists')) {
      skippedExisting.push(configResult.reason);
    } else {
      errors.push(`Failed to create config file: ${configResult.reason}`);
    }
  }

  // 6. Add .gitignore entries
  try {
    await addEnvoiIgnores(repoRoot, getEnvoiGitignoreEntries(workspaceDir));
  } catch (error) {
    errors.push(`Failed to update .gitignore: ${error instanceof Error ? error.message : String(error)}`);
  }

  // Report errors
  if (errors.length > 0) {
    console.error('Errors during initialization:');
    for (const error of errors) {
      console.error(`  - ${error}`);
    }
    throw new Error(`Initialization failed with ${errors.length} error(s)`);
  }

  // 7. Print success message
  const wasAlreadyInitialized = !force && skippedExisting.length > 0;
  if (wasAlreadyInitialized) {
    console.log(`${PRODUCT_NAME} workspace already initialized (kept existing files)\n`);
  } else {
    console.log(`${PRODUCT_NAME} workspace initialized\n`);
  }
  if (showNextSteps) {
    console.log('Next steps:');
    console.log('  1. Run ' + CLI_NAME + ' start for guided onboarding');
    console.log('  2. Or run ' + CLI_NAME + ' brief for PRD intake only');
  }
}
