/**
 * Utilities for managing .gitignore entries for Relais runner-owned files.
 *
 * Runner-owned files (STATE.json, REPORT.json, etc.) change every tick and
 * should be gitignored to prevent BLOCKED_DIRTY_WORKTREE on subsequent runs.
 */

import { readFile, writeFile, access } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Marker comment to identify Relais-managed section in .gitignore
 */
export const RELAIS_GITIGNORE_MARKER = '# Relais runner-owned (auto-generated)';

/**
 * Default entries to add to .gitignore for Relais runner-owned files
 */
export const RELAIS_GITIGNORE_ENTRIES = [
  'relais/REPORT.json',
  'relais/REPORT.md',
  'relais/STATE.json',
  'relais/TASK.json',
  'relais/BLOCKED.json',
  'relais/lock.json',
  'relais/history/',
  'relais/*.tmp',
];

/**
 * Checks if a file exists at the given path.
 */
async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Adds Relais runner-owned entries to .gitignore.
 *
 * This function is idempotent - it won't duplicate entries if they already exist.
 * If .gitignore doesn't exist, it creates one.
 *
 * @param repoRoot - The root directory of the repository
 * @param entries - Optional custom entries to add (defaults to RELAIS_GITIGNORE_ENTRIES)
 * @returns Object with `added` (entries actually added) and `alreadyPresent` (entries that existed)
 *
 * @example
 * ```typescript
 * const result = await addRelaisIgnores('/path/to/repo');
 * console.log(`Added ${result.added.length} entries to .gitignore`);
 * ```
 */
export async function addRelaisIgnores(
  repoRoot: string,
  entries: string[] = RELAIS_GITIGNORE_ENTRIES
): Promise<{ added: string[]; alreadyPresent: string[]; created: boolean }> {
  const gitignorePath = join(repoRoot, '.gitignore');

  let existingContent = '';
  let created = false;

  // Read existing .gitignore if it exists
  if (await fileExists(gitignorePath)) {
    existingContent = await readFile(gitignorePath, 'utf-8');
  } else {
    created = true;
  }

  // Parse existing entries (split by newlines, trim whitespace)
  const existingLines = new Set(
    existingContent
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
  );

  // Check if marker already exists
  const hasMarker = existingContent.includes(RELAIS_GITIGNORE_MARKER);

  // Determine which entries need to be added
  const added: string[] = [];
  const alreadyPresent: string[] = [];

  for (const entry of entries) {
    if (existingLines.has(entry)) {
      alreadyPresent.push(entry);
    } else {
      added.push(entry);
    }
  }

  // If nothing to add, return early
  if (added.length === 0 && hasMarker) {
    return { added: [], alreadyPresent, created: false };
  }

  // Build the new content
  let newContent = existingContent;

  // Ensure content ends with newline before appending
  if (newContent.length > 0 && !newContent.endsWith('\n')) {
    newContent += '\n';
  }

  // Add blank line separator if content exists and no marker yet
  if (newContent.length > 0 && !hasMarker) {
    newContent += '\n';
  }

  // Add marker if not present
  if (!hasMarker) {
    newContent += RELAIS_GITIGNORE_MARKER + '\n';
  }

  // Add new entries
  for (const entry of added) {
    newContent += entry + '\n';
  }

  // Write the updated .gitignore
  await writeFile(gitignorePath, newContent, 'utf-8');

  return { added, alreadyPresent, created };
}

/**
 * Checks if Relais gitignore entries are already present.
 *
 * @param repoRoot - The root directory of the repository
 * @returns Object with `complete` (all entries present), `missing` (entries not found)
 */
export async function checkRelaisIgnores(
  repoRoot: string
): Promise<{ complete: boolean; missing: string[]; present: string[] }> {
  const gitignorePath = join(repoRoot, '.gitignore');

  if (!(await fileExists(gitignorePath))) {
    return {
      complete: false,
      missing: [...RELAIS_GITIGNORE_ENTRIES],
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

  for (const entry of RELAIS_GITIGNORE_ENTRIES) {
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
