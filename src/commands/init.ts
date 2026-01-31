/**
 * Initialize Relais workspace in the current directory.
 *
 * Creates the directory structure, copies templates, and sets up configuration.
 */

import { mkdir, copyFile, access, readFile, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { addRelaisIgnores } from '../lib/gitignore.js';
import { atomicWriteJson } from '../lib/fs.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Path to the relais package root (where templates are stored)
 */
const RELAIS_PACKAGE_ROOT = join(__dirname, '../../relais');

/**
 * Prompts to copy from relais/prompts/ to workspace
 */
const PROMPTS_TO_COPY = [
  'orchestrator.system.txt',
  'orchestrator.user.txt',
  'builder.system.txt',
  'builder.user.txt',
];

/**
 * Schemas to copy from relais/schemas/ to workspace
 */
const SCHEMAS_TO_COPY = [
  'task.schema.json',
  'builder_result.schema.json',
  'report.schema.json',
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
 * Reads the default relais.config.json template and adjusts workspace_dir
 */
async function createConfigFile(
  workspaceDir: string,
  force: boolean
): Promise<{ created: boolean; reason?: string }> {
  const configPath = join(process.cwd(), 'relais.config.json');

  if (await exists(configPath) && !force) {
    return { created: false, reason: `Config file already exists: ${configPath} (use --force to overwrite)` };
  }

  // Read the template from the relais package
  const templatePath = join(RELAIS_PACKAGE_ROOT, '../relais.config.json');
  if (!(await exists(templatePath))) {
    // Fallback: create a minimal config
    const minimalConfig = {
      version: '1.0',
      product_name: 'relais',
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
      glob.replace(/^relais\//, `${workspaceDir}/`)
    );
  }
  
  // Adjust lockfile path
  if (template.runner?.lockfile) {
    template.runner.lockfile = template.runner.lockfile.replace(/^relais\//, `${workspaceDir}/`);
  }
  
  // Adjust prompt and schema paths
  if (template.orchestrator?.system_prompt_file) {
    template.orchestrator.system_prompt_file = template.orchestrator.system_prompt_file.replace(
      /^relais\//,
      `${workspaceDir}/`
    );
  }
  if (template.orchestrator?.user_prompt_file) {
    template.orchestrator.user_prompt_file = template.orchestrator.user_prompt_file.replace(
      /^relais\//,
      `${workspaceDir}/`
    );
  }
  if (template.orchestrator?.task_schema_file) {
    template.orchestrator.task_schema_file = template.orchestrator.task_schema_file.replace(
      /^relais\//,
      `${workspaceDir}/`
    );
  }
  if (template.builder?.claude_code?.system_prompt_file) {
    template.builder.claude_code.system_prompt_file = template.builder.claude_code.system_prompt_file.replace(
      /^relais\//,
      `${workspaceDir}/`
    );
  }
  if (template.builder?.claude_code?.user_prompt_file) {
    template.builder.claude_code.user_prompt_file = template.builder.claude_code.user_prompt_file.replace(
      /^relais\//,
      `${workspaceDir}/`
    );
  }
  if (template.builder?.claude_code?.builder_result_schema_file) {
    template.builder.claude_code.builder_result_schema_file = template.builder.claude_code.builder_result_schema_file.replace(
      /^relais\//,
      `${workspaceDir}/`
    );
  }
  if (template.history?.dir) {
    template.history.dir = template.history.dir.replace(/^relais\//, `${workspaceDir}/`);
  }

  await atomicWriteJson(configPath, template);
  return { created: true };
}

/**
 * Initializes a Relais workspace in the current directory.
 *
 * @param options - Command options
 * @param options.force - Overwrite existing files
 * @param options.workspaceDir - Workspace directory name (default: 'relais')
 */
export async function initCommand(options: { force?: boolean; workspaceDir?: string } = {}): Promise<void> {
  const { force = false, workspaceDir = 'relais' } = options;
  const cwd = process.cwd();
  const workspacePath = join(cwd, workspaceDir);

  const errors: string[] = [];

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
    const source = join(RELAIS_PACKAGE_ROOT, 'prompts', prompt);
    const dest = join(workspacePath, 'prompts', prompt);
    const result = await copyFileSafe(source, dest, force);
    if (!result.copied) {
      if (result.reason?.includes('already exists')) {
        errors.push(result.reason);
      } else {
        errors.push(`Failed to copy ${prompt}: ${result.reason || 'Unknown error'}`);
      }
    }
  }

  // 3. Copy schema files
  for (const schema of SCHEMAS_TO_COPY) {
    const source = join(RELAIS_PACKAGE_ROOT, 'schemas', schema);
    const dest = join(workspacePath, 'schemas', schema);
    const result = await copyFileSafe(source, dest, force);
    if (!result.copied) {
      if (result.reason?.includes('already exists')) {
        errors.push(result.reason);
      } else {
        errors.push(`Failed to copy ${schema}: ${result.reason || 'Unknown error'}`);
      }
    }
  }

  // 4. Initialize STATE.json
  const statePath = join(workspacePath, 'STATE.json');
  if (await exists(statePath) && !force) {
    errors.push(`STATE.json already exists: ${statePath} (use --force to overwrite)`);
  } else {
    try {
      await atomicWriteJson(statePath, createInitialState());
    } catch (error) {
      errors.push(`Failed to create STATE.json: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // 5. Create relais.config.json
  const configResult = await createConfigFile(workspaceDir, force);
  if (!configResult.created && configResult.reason) {
    if (configResult.reason.includes('already exists')) {
      errors.push(configResult.reason);
    } else {
      errors.push(`Failed to create config file: ${configResult.reason}`);
    }
  }

  // 6. Add .gitignore entries
  try {
    await addRelaisIgnores(cwd);
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
  console.log('Relais workspace initialized\n');
  console.log('Next steps:');
  console.log('  1. Edit relais.config.json to configure your project');
  console.log('  2. Create relais/FACTS.md with project context');
  console.log('  3. Run \'relais run\' to start the first tick');
}
