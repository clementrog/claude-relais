/**
 * Lock mechanism for preventing concurrent envoi runs.
 *
 * Implements crash-safe lock acquisition with boot_id tracking to enable
 * safe reclaim of stale locks after crashes or reboots.
 */

import { execSync } from 'node:child_process';
import { hostname } from 'node:os';
import { unlink } from 'node:fs/promises';
import type { LockInfo } from '../types/lock.js';
import { atomicWriteJson, atomicReadJson, AtomicFsError } from './fs.js';

/**
 * Error thrown when a lock is already held by another process.
 */
export class LockHeldError extends Error {
  constructor(
    message: string,
    public readonly lockPath: string,
    public readonly holder: LockInfo
  ) {
    super(message);
    this.name = 'LockHeldError';
  }
}

/**
 * Error thrown when a lock file is corrupt or malformed.
 */
export class LockCorruptError extends Error {
  constructor(
    message: string,
    public readonly lockPath: string
  ) {
    super(message);
    this.name = 'LockCorruptError';
  }
}

/** Cached boot ID to avoid repeated system calls */
let cachedBootId: string | null = null;

/**
 * Gets a unique identifier for the current boot session.
 *
 * On Linux, reads /proc/sys/kernel/random/boot_id.
 * On macOS, uses system uptime + hostname as a fingerprint since macOS
 * doesn't have boot_id but uptime.boot_time is stable per boot.
 *
 * The result is cached for the lifetime of the process.
 *
 * @returns A string uniquely identifying the current boot session
 */
export function getBootId(): string {
  if (cachedBootId !== null) {
    return cachedBootId;
  }

  const platform = process.platform;

  if (platform === 'linux') {
    try {
      // Linux provides a unique boot ID
      const { readFileSync } = require('node:fs');
      const bootId: string = (readFileSync('/proc/sys/kernel/random/boot_id', 'utf-8') as string).trim();
      cachedBootId = bootId;
      return bootId;
    } catch {
      // Fall through to fallback
    }
  }

  if (platform === 'darwin') {
    try {
      // macOS: use boot time from sysctl
      const output = execSync('sysctl -n kern.boottime', { encoding: 'utf-8' });
      // Output format: { sec = 1234567890, usec = 123456 } ...
      const match = output.match(/sec\s*=\s*(\d+)/);
      if (match) {
        const bootTime = match[1];
        cachedBootId = `${hostname()}-${bootTime}`;
        return cachedBootId;
      }
    } catch {
      // Fall through to fallback
    }
  }

  // Fallback: use process start time as a rough approximation
  // This is less reliable but better than nothing
  const startTime = Date.now() - (process.uptime() * 1000);
  cachedBootId = `${hostname()}-${Math.floor(startTime / 1000)}`;
  return cachedBootId;
}

/**
 * Checks if a process with the given PID is currently running.
 *
 * Uses process.kill(pid, 0) which checks for process existence
 * without actually sending a signal.
 *
 * @param pid - The process ID to check
 * @returns true if the process is running, false otherwise
 */
export function isPidRunning(pid: number): boolean {
  try {
    // Signal 0 doesn't send anything, just checks if process exists
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // ESRCH = no such process, EPERM = exists but no permission
    if (error instanceof Error && 'code' in error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'EPERM') {
        // Process exists but we don't have permission to signal it
        return true;
      }
    }
    return false;
  }
}

/**
 * Determines if a lock is stale and can be reclaimed.
 *
 * A lock is considered stale if:
 * - The holding process is no longer running, OR
 * - The boot_id differs from the current boot (system has rebooted)
 *
 * @param lock - The lock information to check
 * @returns true if the lock is stale and can be reclaimed
 */
export function isLockStale(lock: LockInfo): boolean {
  // If boot_id differs, the system has rebooted - lock is definitely stale
  if (lock.boot_id !== getBootId()) {
    return true;
  }

  // Same boot session - check if the process is still running
  return !isPidRunning(lock.pid);
}

/**
 * Validates that a parsed value is a valid LockInfo object.
 *
 * @param lockPath - Path to the lock file (for error messages)
 * @param value - The parsed JSON value to validate
 * @throws {LockCorruptError} If the value is not a valid LockInfo
 */
function validateLockShape(lockPath: string, value: unknown): asserts value is LockInfo {
  const remediation = `Delete the lock file at ${lockPath} and retry.`;

  // Must be an object (not null, not array)
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new LockCorruptError(
      `Lock file has invalid structure (expected object, got ${value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value}). ${remediation}`,
      lockPath
    );
  }

  const obj = value as Record<string, unknown>;

  // pid must be integer > 0
  if (typeof obj.pid !== 'number' || !Number.isInteger(obj.pid) || obj.pid <= 0) {
    throw new LockCorruptError(
      `Lock file has invalid pid (expected integer > 0, got ${JSON.stringify(obj.pid)}). ${remediation}`,
      lockPath
    );
  }

  // started_at must be non-empty string
  if (typeof obj.started_at !== 'string' || obj.started_at === '') {
    throw new LockCorruptError(
      `Lock file has invalid started_at (expected non-empty string, got ${JSON.stringify(obj.started_at)}). ${remediation}`,
      lockPath
    );
  }

  // boot_id must be non-empty string
  if (typeof obj.boot_id !== 'string' || obj.boot_id === '') {
    throw new LockCorruptError(
      `Lock file has invalid boot_id (expected non-empty string, got ${JSON.stringify(obj.boot_id)}). ${remediation}`,
      lockPath
    );
  }
}

/**
 * Acquires a lock by creating a lock file atomically.
 *
 * If a lock already exists:
 * - If stale (process dead or different boot), reclaims it with a warning
 * - If held by an active process, throws LockHeldError
 *
 * @param lockPath - Path to the lock file
 * @returns The lock information that was written
 * @throws {LockHeldError} If the lock is held by another active process
 * @throws {LockCorruptError} If the lock file is corrupt or malformed
 * @throws {AtomicFsError} If the lock file cannot be written
 */
export async function acquireLock(lockPath: string): Promise<LockInfo> {
  // Check if lock file exists
  let existingLock: LockInfo | null = null;
  try {
    const rawValue = await atomicReadJson<unknown>(lockPath);
    validateLockShape(lockPath, rawValue);
    existingLock = rawValue;
  } catch (error) {
    // Re-throw LockCorruptError as-is
    if (error instanceof LockCorruptError) {
      throw error;
    }

    if (error instanceof AtomicFsError) {
      const cause = error.cause;
      // File doesn't exist - no lock, proceed
      if (cause && 'code' in cause && (cause as NodeJS.ErrnoException).code === 'ENOENT') {
        // No lock file exists
      } else if (cause instanceof SyntaxError) {
        // JSON parse error - corrupt lock file
        const remediation = `Delete the lock file at ${lockPath} and retry.`;
        throw new LockCorruptError(
          `Lock file contains invalid JSON. ${remediation}`,
          lockPath
        );
      } else {
        // Real error (I/O issue, permission denied, etc.)
        throw error;
      }
    } else {
      // Unknown error, rethrow
      throw error;
    }
  }

  if (existingLock) {
    if (isLockStale(existingLock)) {
      // Lock is stale - log warning and reclaim
      console.warn(
        `Reclaiming stale lock from PID ${existingLock.pid} (started_at: ${existingLock.started_at}, boot_id: ${existingLock.boot_id})`
      );
    } else {
      // Lock is held by an active process
      throw new LockHeldError(
        `Lock is held by PID ${existingLock.pid} (started_at: ${existingLock.started_at})`,
        lockPath,
        existingLock
      );
    }
  }

  // Create new lock
  const lockInfo: LockInfo = {
    pid: process.pid,
    started_at: new Date().toISOString(),
    boot_id: getBootId(),
  };

  await atomicWriteJson(lockPath, lockInfo);
  return lockInfo;
}

/**
 * Releases a lock by deleting the lock file.
 *
 * Only releases the lock if it belongs to the current process.
 * Silently succeeds if the lock doesn't exist or belongs to another process.
 *
 * @param lockPath - Path to the lock file
 */
export async function releaseLock(lockPath: string): Promise<void> {
  try {
    // Read current lock to verify ownership
    const lock = await atomicReadJson<LockInfo>(lockPath);

    // Only delete if we own the lock
    if (lock.pid === process.pid && lock.boot_id === getBootId()) {
      await unlink(lockPath);
    }
  } catch (error) {
    // Lock doesn't exist or can't be read - nothing to release
    if (error instanceof AtomicFsError) {
      const cause = error.cause;
      if (cause && 'code' in cause && (cause as NodeJS.ErrnoException).code === 'ENOENT') {
        // File doesn't exist - already released
        return;
      }
    }
    // For other errors, also silently succeed - lock cleanup shouldn't fail the process
  }
}
