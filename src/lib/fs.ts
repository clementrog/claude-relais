/**
 * Atomic file system utilities for crash-safe JSON operations.
 *
 * These utilities implement the write-tmp-fsync-rename pattern to ensure
 * atomic file writes that survive crashes and power failures on POSIX systems.
 */

import { open, rename, unlink, readFile, readdir } from 'node:fs/promises';
import { join, dirname, isAbsolute } from 'node:path';

/**
 * Result of glob pattern safety check.
 */
export type GlobSafetyResult = { safe: true } | { safe: false; reason: string };

/**
 * Checks if a glob pattern is safe for file deletion operations.
 *
 * Safe patterns:
 * - Relative paths like `envoi/*.tmp`, `envoi/**\/*.tmp`, `*.tmp`
 *
 * Unsafe patterns:
 * - Empty or whitespace-only patterns
 * - Patterns containing path traversal (`..`)
 * - Unix absolute paths (starting with `/`)
 * - Windows absolute paths (e.g., `C:\`)
 * - UNC paths (`\\server\share` or `//server/share`)
 *
 * @param pattern - The glob pattern to check
 * @returns Result indicating if the pattern is safe
 */
export function isGlobPatternSafe(pattern: string): GlobSafetyResult {
  // Check for empty or whitespace-only patterns
  if (!pattern || pattern.trim() === '') {
    return { safe: false, reason: 'Empty or whitespace-only pattern' };
  }

  // Check for path traversal
  if (pattern.includes('..')) {
    return { safe: false, reason: 'Pattern contains path traversal (..)' };
  }

  // Check for Unix absolute paths
  if (pattern.startsWith('/')) {
    return { safe: false, reason: 'Pattern is an absolute Unix path' };
  }

  // Check for Windows absolute paths (e.g., C:\, D:\)
  if (/^[A-Za-z]:[\\\/]/.test(pattern)) {
    return { safe: false, reason: 'Pattern is an absolute Windows path' };
  }

  // Check for UNC paths (\\server\share or //server/share)
  if (pattern.startsWith('\\\\') || pattern.startsWith('//')) {
    return { safe: false, reason: 'Pattern is a UNC path' };
  }

  return { safe: true };
}

/**
 * Error thrown when atomic file operations fail.
 */
export class AtomicFsError extends Error {
  constructor(
    message: string,
    public readonly filePath: string,
    public readonly cause?: Error
  ) {
    super(message);
    this.name = 'AtomicFsError';
  }
}

/**
 * Atomically writes JSON data to a file using the write-tmp-fsync-rename pattern.
 *
 * This ensures that the file is never in a partially-written state, even if the
 * process crashes or the system loses power during the write operation.
 *
 * @param filePath - The path to write the JSON file to
 * @param data - The data to serialize and write
 * @throws {AtomicFsError} If the write operation fails
 *
 * @example
 * ```typescript
 * await atomicWriteJson('/path/to/config.json', { version: 1, enabled: true });
 * ```
 */
export async function atomicWriteJson<T>(filePath: string, data: T): Promise<void> {
  const tmpPath = `${filePath}.tmp`;
  let fileHandle: Awaited<ReturnType<typeof open>> | null = null;

  try {
    // Serialize with 2-space indent for readability
    const content = JSON.stringify(data, null, 2) + '\n';

    // Open file for writing, create if doesn't exist, truncate if exists
    fileHandle = await open(tmpPath, 'w');

    // Write the content
    await fileHandle.writeFile(content, 'utf-8');

    // fsync to ensure data is flushed to disk
    await fileHandle.sync();

    // Close before rename
    await fileHandle.close();
    fileHandle = null;

    // Atomic rename (POSIX guarantees atomicity)
    await rename(tmpPath, filePath);
  } catch (error) {
    // Attempt to clean up the tmp file on error
    if (fileHandle) {
      try {
        await fileHandle.close();
      } catch {
        // Ignore close errors during cleanup
      }
    }

    try {
      await unlink(tmpPath);
    } catch {
      // Ignore unlink errors - file may not exist
    }

    throw new AtomicFsError(
      `Failed to atomically write JSON to ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
      filePath,
      error instanceof Error ? error : undefined
    );
  }
}

/**
 * Reads and parses a JSON file with proper typing.
 *
 * @param filePath - The path to the JSON file to read
 * @returns The parsed JSON data
 * @throws {AtomicFsError} If the file cannot be read or parsed
 *
 * @example
 * ```typescript
 * interface Config {
 *   version: number;
 *   enabled: boolean;
 * }
 * const config = await atomicReadJson<Config>('/path/to/config.json');
 * ```
 */
export async function atomicReadJson<T>(filePath: string): Promise<T> {
  try {
    const content = await readFile(filePath, 'utf-8');
    return JSON.parse(content) as T;
  } catch (error) {
    throw new AtomicFsError(
      `Failed to read JSON from ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
      filePath,
      error instanceof Error ? error : undefined
    );
  }
}

/**
 * Cleans up stale .tmp files in a directory.
 *
 * This should be called during startup preflight to remove any .tmp files
 * left behind by interrupted write operations.
 *
 * @param dir - The directory to scan for .tmp files
 * @param pattern - Optional pattern to match (defaults to '*.tmp')
 * @returns List of deleted file paths
 * @throws {AtomicFsError} If the cleanup operation fails
 *
 * @example
 * ```typescript
 * // Clean up all .tmp files in /envoi directory
 * const deleted = await cleanupTmpFiles('/envoi');
 * console.log(`Cleaned up ${deleted.length} stale tmp files`);
 * ```
 */
export async function cleanupTmpFiles(dir: string, pattern = '.tmp'): Promise<string[]> {
  const deleted: string[] = [];

  try {
    const entries = await readdir(dir, { withFileTypes: true });

    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith(pattern)) {
        const filePath = join(dir, entry.name);
        try {
          await unlink(filePath);
          deleted.push(filePath);
        } catch (error) {
          // Log but continue - we want to clean up as many as possible
          console.warn(`Failed to delete tmp file ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }

    return deleted;
  } catch (error) {
    throw new AtomicFsError(
      `Failed to cleanup tmp files in ${dir}: ${error instanceof Error ? error.message : String(error)}`,
      dir,
      error instanceof Error ? error : undefined
    );
  }
}
