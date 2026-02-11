/**
 * Utilities for managing .gitignore entries for Envoi runner-owned files.
 *
 * Runner-owned files (STATE.json, REPORT.json, etc.) change every tick and
 * should be gitignored to prevent BLOCKED_DIRTY_WORKTREE on subsequent runs.
 */

import { readFile, writeFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { WORKSPACE_DIR_NAME } from './branding.js';

/**
 * Marker comment to identify Envoi-managed section in .gitignore.
 */
export const ENVOI_GITIGNORE_MARKER = '# Envoi runner-owned (auto-generated)';
const MIGRATION_GITIGNORE_MARKER = '# Relais runner-owned (auto-generated)';

/**
 * Default entries to add to .gitignore for Envoi runner-owned files.
 */
export function getEnvoiGitignoreEntries(workspaceDir: string): string[] {
  const ws = workspaceDir.replace(/\/+$/, '');
  return [
    `${ws}/REPORT.json`,
    `${ws}/REPORT.md`,
    `${ws}/STATE.json`,
    `${ws}/TASK.json`,
    `${ws}/BLOCKED.json`,
    `${ws}/lock.json`,
    `${ws}/history/`,
    `${ws}/*.tmp`,
    `${ws}/PRD.md`,
    `${ws}/FACTS.md`,
    `${ws}/BUILDER_RESULT.json`,
  ];
}

export const ENVOI_GITIGNORE_ENTRIES = getEnvoiGitignoreEntries(WORKSPACE_DIR_NAME);

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function addEnvoiIgnores(
  repoRoot: string,
  entries: string[] = ENVOI_GITIGNORE_ENTRIES
): Promise<{ added: string[]; alreadyPresent: string[]; created: boolean }> {
  const gitignorePath = join(repoRoot, '.gitignore');

  let existingContent = '';
  let created = false;

  if (await fileExists(gitignorePath)) {
    existingContent = await readFile(gitignorePath, 'utf-8');
  } else {
    created = true;
  }

  const existingLines = new Set(
    existingContent
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
  );

  const hasMarker =
    existingContent.includes(ENVOI_GITIGNORE_MARKER) ||
    existingContent.includes(MIGRATION_GITIGNORE_MARKER);

  const added: string[] = [];
  const alreadyPresent: string[] = [];

  for (const entry of entries) {
    if (existingLines.has(entry)) {
      alreadyPresent.push(entry);
    } else {
      added.push(entry);
    }
  }

  if (added.length === 0 && hasMarker) {
    return { added: [], alreadyPresent, created: false };
  }

  let newContent = existingContent;

  if (newContent.length > 0 && !newContent.endsWith('\n')) {
    newContent += '\n';
  }

  if (newContent.length > 0 && !hasMarker) {
    newContent += '\n';
  }

  if (!hasMarker) {
    newContent += ENVOI_GITIGNORE_MARKER + '\n';
  }

  for (const entry of added) {
    newContent += entry + '\n';
  }

  await writeFile(gitignorePath, newContent, 'utf-8');

  return { added, alreadyPresent, created };
}

export async function checkEnvoiIgnores(
  repoRoot: string
): Promise<{ complete: boolean; missing: string[]; present: string[] }> {
  const gitignorePath = join(repoRoot, '.gitignore');

  if (!(await fileExists(gitignorePath))) {
    return {
      complete: false,
      missing: [...ENVOI_GITIGNORE_ENTRIES],
      present: [],
    };
  }

  const content = await readFile(gitignorePath, 'utf-8');
  const existingLines = new Set(
    content
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
  );

  const missing: string[] = [];
  const present: string[] = [];

  for (const entry of ENVOI_GITIGNORE_ENTRIES) {
    if (existingLines.has(entry)) {
      present.push(entry);
    } else {
      missing.push(entry);
    }
  }

  return {
    complete: missing.length === 0,
    missing,
    present,
  };
}
