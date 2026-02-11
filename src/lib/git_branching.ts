/**
 * Git branching helper functions for runner-owned branch management.
 *
 * Uses execSync for git operations to ensure synchronous, blocking behavior.
 * All git commands use argv-only (no shell strings) for security.
 */

import { spawnSync } from 'node:child_process';
import type { GitBranchingConfig } from '../types/config.js';

/**
 * Result of branch creation/switch operation.
 */
export interface BranchResult {
  /** Whether the operation succeeded */
  ok: boolean;
  /** The branch name that was created/switched to */
  branchName: string;
  /** Error message if operation failed */
  error?: string;
  /** Whether the branch already existed */
  existed: boolean;
}

/**
 * Parameters for branch template expansion.
 */
export interface BranchTemplateParams {
  task_id?: string;
  milestone_id?: string;
  run_id?: string;
  tick_count?: number;
  seq?: number; // Sequence/batch index (0-based)
  batch_index?: number; // Alias for seq
  YYYYMMDD?: string; // Date in YYYYMMDD format
}

/**
 * Expands a branch name template with placeholders.
 *
 * Supported placeholders (both {{...}} and {...} styles):
 * - {{task_id}} or {task_id} - Task ID
 * - {{milestone_id}} or {milestone_id} - Milestone ID
 * - {{run_id}} or {run_id} - Run ID
 * - {{tick_count}} or {tick_count} - Tick count (1-based)
 * - {{seq}} or {seq} or {{batch_index}} or {batch_index} - Sequence/batch index (0-based)
 * - {{YYYYMMDD}} or {YYYYMMDD} - Date in YYYYMMDD format
 *
 * @param template - Template string with placeholders
 * @param params - Parameters to substitute
 * @returns Expanded branch name
 */
export function expandBranchTemplate(
  template: string,
  params: BranchTemplateParams
): string {
  let result = template;
  
  // Generate YYYYMMDD if not provided
  if (!params.YYYYMMDD) {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    params.YYYYMMDD = `${year}${month}${day}`;
  }
  
  // Use seq if batch_index is provided but seq is not
  if (params.batch_index !== undefined && params.seq === undefined) {
    params.seq = params.batch_index;
  }
  
  // Replace both {{...}} and {...} styles
  const replacements: Array<[RegExp, string]> = [
    [/\{\{task_id\}\}|\{task_id\}/g, params.task_id || ''],
    [/\{\{milestone_id\}\}|\{milestone_id\}/g, params.milestone_id || ''],
    [/\{\{run_id\}\}|\{run_id\}/g, params.run_id || ''],
    [/\{\{tick_count\}\}|\{tick_count\}/g, params.tick_count !== undefined ? String(params.tick_count) : ''],
    [/\{\{seq\}\}|\{seq\}/g, params.seq !== undefined ? String(params.seq) : ''],
    [/\{\{batch_index\}\}|\{batch_index\}/g, params.seq !== undefined ? String(params.seq) : ''],
    [/\{\{YYYYMMDD\}\}|\{YYYYMMDD\}/g, params.YYYYMMDD || ''],
  ];
  
  for (const [pattern, replacement] of replacements) {
    result = result.replace(pattern, replacement);
  }
  
  // Remove any remaining placeholders (replace with empty string)
  result = result.replace(/\{\{?\w+\}?\}/g, '');
  
  return result;
}

/**
 * Checks if a branch exists locally.
 *
 * @param branchName - Branch name to check
 * @returns true if branch exists, false otherwise
 */
function branchExists(branchName: string): boolean {
  try {
    const result = spawnSync('git', ['show-ref', '--verify', '--quiet', `refs/heads/${branchName}`], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return result.status === 0;
  } catch {
    return false;
  }
}

/**
 * Gets the current branch name.
 *
 * @returns Current branch name, or null if detached HEAD
 */
function getCurrentBranch(): string | null {
  try {
    const result = spawnSync('git', ['branch', '--show-current'], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    if (result.status !== 0 || !result.stdout) {
      return null;
    }
    return result.stdout.toString().trim() || null;
  } catch {
    return null;
  }
}

/**
 * Creates a new branch or switches to existing branch.
 *
 * If the branch already exists, switches to it.
 * If the branch doesn't exist, creates it from the specified base ref (default: HEAD).
 *
 * @param branchName - Branch name to create/switch to
 * @param baseRef - Base ref (commit/branch) to create branch from. Default: 'HEAD'
 * @returns BranchResult indicating success or failure
 */
function createOrSwitchBranch(branchName: string, baseRef: string = 'HEAD'): BranchResult {
  const exists = branchExists(branchName);
  const currentBranch = getCurrentBranch();
  
  // If already on the target branch, no-op
  if (currentBranch === branchName) {
    return {
      ok: true,
      branchName,
      existed: exists,
    };
  }
  
  try {
    let result;
    if (exists) {
      // Branch exists, switch to it
      result = spawnSync('git', ['checkout', branchName], {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } else {
      // Branch doesn't exist, create it from baseRef
      result = spawnSync('git', ['checkout', '-b', branchName, baseRef], {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    }
    
    if (result.status !== 0) {
      const errorMsg = result.stderr?.toString() || `Git command failed with status ${result.status}`;
      return {
        ok: false,
        branchName,
        existed: exists,
        error: errorMsg,
      };
    }
    
    return {
      ok: true,
      branchName,
      existed: exists,
    };
  } catch (error) {
    return {
      ok: false,
      branchName,
      existed: exists,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Finds an available branch name by appending a numeric suffix.
 *
 * If the base name exists, tries base-1, base-2, etc. until finding an available name.
 *
 * @param baseName - Base branch name
 * @param maxAttempts - Maximum number of attempts (default: 100)
 * @returns Available branch name
 */
function findAvailableBranchName(baseName: string, maxAttempts: number = 100): string {
  if (!branchExists(baseName)) {
    return baseName;
  }
  
  for (let i = 1; i <= maxAttempts; i++) {
    const candidate = `${baseName}-${i}`;
    if (!branchExists(candidate)) {
      return candidate;
    }
  }
  
  // Fallback: use timestamp if all attempts exhausted
  return `${baseName}-${Date.now()}`;
}

/**
 * Sanitizes a branch name to comply with git branch naming rules.
 *
 * @param name - Branch name to sanitize
 * @returns Sanitized branch name
 */
function sanitizeBranchName(name: string): string {
  // Replace invalid characters with hyphens
  let sanitized = name
    .replace(/[^a-zA-Z0-9\/_\-\.]/g, '-')
    .replace(/\/+/g, '/')
    .replace(/^-+|-+$/g, '');
  
  // Ensure it's not empty
  if (!sanitized) {
    sanitized = 'envoi/branch';
  }
  
  return sanitized;
}

/**
 * Ensures a branch exists and HEAD is on it (per_tick mode).
 *
 * For per_tick mode, creates/switches to a branch based on the template.
 * If the branch already exists, switches to it (idempotent).
 * If there's a collision, appends a numeric suffix.
 *
 * @param config - Git branching configuration
 * @param params - Parameters for template expansion
 * @returns BranchResult indicating success or failure
 */
export function ensureBranchPerTick(
  config: GitBranchingConfig,
  params: BranchTemplateParams
): BranchResult {
  if (config.mode !== 'per_tick') {
    return {
      ok: false,
      branchName: '',
      error: `Branching mode is not 'per_tick' (got '${config.mode}')`,
      existed: false,
    };
  }
  
  const template = config.name_template || 'envoi/{{task_id}}';
  const baseName = expandBranchTemplate(template, params);
  const sanitizedName = sanitizeBranchName(baseName);
  
  if (!sanitizedName) {
    return {
      ok: false,
      branchName: '',
      error: 'Branch name template expanded to empty string',
      existed: false,
    };
  }
  
  // Find available branch name (handles collisions)
  const branchName = findAvailableBranchName(sanitizedName);
  const baseRef = config.base_ref || 'HEAD';
  
  return createOrSwitchBranch(branchName, baseRef);
}

/**
 * Ensures a branch exists and HEAD is on it (per_n_tasks mode).
 *
 * For per_n_tasks mode, creates/switches to a branch based on the template,
 * grouping tasks into batches of n_tasks. The seq parameter represents
 * the batch index (0-based).
 *
 * @param config - Git branching configuration
 * @param params - Parameters for template expansion (must include seq for batch index)
 * @returns BranchResult indicating success or failure
 */
export function ensureBranchPerNTasks(
  config: GitBranchingConfig,
  params: BranchTemplateParams
): BranchResult {
  if (config.mode !== 'per_n_tasks') {
    return {
      ok: false,
      branchName: '',
      error: `Branching mode is not 'per_n_tasks' (got '${config.mode}')`,
      existed: false,
    };
  }
  
  if (!config.n_tasks || config.n_tasks < 1) {
    return {
      ok: false,
      branchName: '',
      error: `per_n_tasks mode requires n_tasks >= 1 (got ${config.n_tasks})`,
      existed: false,
    };
  }
  
  if (params.seq === undefined && params.batch_index === undefined) {
    return {
      ok: false,
      branchName: '',
      error: 'per_n_tasks mode requires seq or batch_index parameter',
      existed: false,
    };
  }
  
  // Use seq if available, otherwise batch_index
  const batchIndex = params.seq !== undefined ? params.seq : (params.batch_index || 0);
  const templateParams = { ...params, seq: batchIndex, batch_index: batchIndex };
  
  const template = config.name_template || 'envoi/batch-{{seq}}';
  const baseName = expandBranchTemplate(template, templateParams);
  const sanitizedName = sanitizeBranchName(baseName);
  
  if (!sanitizedName) {
    return {
      ok: false,
      branchName: '',
      error: 'Branch name template expanded to empty string',
      existed: false,
    };
  }
  
  // Find available branch name (handles collisions)
  const branchName = findAvailableBranchName(sanitizedName);
  const baseRef = config.base_ref || 'HEAD';
  
  return createOrSwitchBranch(branchName, baseRef);
}

/**
 * Ensures a branch exists and HEAD is on it (per_milestone mode).
 *
 * For per_milestone mode, creates/switches to a branch based on the template
 * for the current milestone. All tasks in the same milestone use the same branch.
 *
 * @param config - Git branching configuration
 * @param params - Parameters for template expansion (must include milestone_id)
 * @returns BranchResult indicating success or failure
 */
export function ensureBranchPerMilestone(
  config: GitBranchingConfig,
  params: BranchTemplateParams
): BranchResult {
  if (config.mode !== 'per_milestone') {
    return {
      ok: false,
      branchName: '',
      error: `Branching mode is not 'per_milestone' (got '${config.mode}')`,
      existed: false,
    };
  }
  
  if (!params.milestone_id) {
    return {
      ok: false,
      branchName: '',
      error: 'per_milestone mode requires milestone_id parameter',
      existed: false,
    };
  }
  
  const template = config.name_template || 'envoi/{{milestone_id}}';
  const baseName = expandBranchTemplate(template, params);
  const sanitizedName = sanitizeBranchName(baseName);
  
  if (!sanitizedName) {
    return {
      ok: false,
      branchName: '',
      error: 'Branch name template expanded to empty string',
      existed: false,
    };
  }
  
  // Find available branch name (handles collisions)
  const branchName = findAvailableBranchName(sanitizedName);
  const baseRef = config.base_ref || 'HEAD';
  
  return createOrSwitchBranch(branchName, baseRef);
}
