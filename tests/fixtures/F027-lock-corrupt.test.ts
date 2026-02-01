/**
 * F027: lock_corrupt_blocks_with_recovery_required
 *
 * Verifies that when a lock file exists but contains invalid/corrupted JSON,
 * the system fails closed with BLOCKED_CRASH_RECOVERY_REQUIRED rather than
 * silently overwriting the lock.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { acquireLock, LockCorruptError } from '../../src/lib/lock.js';

describe('F027: lock_corrupt_blocks_with_recovery_required', () => {
  let testDir: string;
  let lockPath: string;

  beforeEach(() => {
    // Create a unique test directory
    testDir = join(tmpdir(), `relais-lock-test-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
    lockPath = join(testDir, 'lock.json');
  });

  afterEach(() => {
    // Clean up test directory
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('should throw LockCorruptError when lock file contains truncated JSON', async () => {
    // Write a truncated/corrupted lock file (incomplete JSON)
    writeFileSync(lockPath, '{', 'utf-8');

    await expect(acquireLock(lockPath)).rejects.toThrow(LockCorruptError);
    await expect(acquireLock(lockPath)).rejects.toThrow(/invalid JSON/);

    // Verify the corrupt file was NOT overwritten
    expect(existsSync(lockPath)).toBe(true);
  });

  it('should throw LockCorruptError when lock file contains random garbage', async () => {
    // Write garbage data
    writeFileSync(lockPath, 'not json at all!!!', 'utf-8');

    await expect(acquireLock(lockPath)).rejects.toThrow(LockCorruptError);
    await expect(acquireLock(lockPath)).rejects.toThrow(/invalid JSON/);
  });

  it('should throw LockCorruptError when lock file is partial JSON object', async () => {
    // Write partial JSON (missing closing brace)
    writeFileSync(lockPath, '{"pid": 1234, "started_at": "2024-01-01"', 'utf-8');

    await expect(acquireLock(lockPath)).rejects.toThrow(LockCorruptError);
  });

  it('should include recovery instructions in error message', async () => {
    writeFileSync(lockPath, '{broken}', 'utf-8');

    try {
      await acquireLock(lockPath);
      expect.fail('Expected LockCorruptError to be thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(LockCorruptError);
      const lockError = error as LockCorruptError;
      expect(lockError.message).toContain('Delete the lock file');
      expect(lockError.lockPath).toBe(lockPath);
    }
  });

  it('should succeed with valid lock file that is stale', async () => {
    // Write a valid but stale lock file (different boot_id means stale)
    const staleLock = {
      pid: 99999, // Unlikely to exist
      started_at: '2020-01-01T00:00:00.000Z',
      boot_id: 'stale-boot-id-that-does-not-match',
    };
    writeFileSync(lockPath, JSON.stringify(staleLock), 'utf-8');

    // Should reclaim stale lock, not throw
    const lock = await acquireLock(lockPath);
    expect(lock.pid).toBe(process.pid);
  });

  it('should not throw when lock file does not exist', async () => {
    // lockPath doesn't exist - should succeed
    const lock = await acquireLock(lockPath);
    expect(lock.pid).toBe(process.pid);
    expect(existsSync(lockPath)).toBe(true);
  });

  describe('valid JSON with invalid shape', () => {
    it('should throw LockCorruptError when lock is empty object', async () => {
      writeFileSync(lockPath, '{}', 'utf-8');
      await expect(acquireLock(lockPath)).rejects.toThrow(LockCorruptError);
      await expect(acquireLock(lockPath)).rejects.toThrow(/invalid pid/);
    });

    it('should throw LockCorruptError when pid is wrong type (string)', async () => {
      writeFileSync(
        lockPath,
        JSON.stringify({ pid: 'not-a-number', started_at: '2024-01-01', boot_id: 'test' }),
        'utf-8'
      );
      await expect(acquireLock(lockPath)).rejects.toThrow(LockCorruptError);
      await expect(acquireLock(lockPath)).rejects.toThrow(/invalid pid/);
    });

    it('should throw LockCorruptError when pid is negative', async () => {
      writeFileSync(
        lockPath,
        JSON.stringify({ pid: -1, started_at: '2024-01-01', boot_id: 'test' }),
        'utf-8'
      );
      await expect(acquireLock(lockPath)).rejects.toThrow(LockCorruptError);
      await expect(acquireLock(lockPath)).rejects.toThrow(/invalid pid/);
    });

    it('should throw LockCorruptError when pid is zero', async () => {
      writeFileSync(
        lockPath,
        JSON.stringify({ pid: 0, started_at: '2024-01-01', boot_id: 'test' }),
        'utf-8'
      );
      await expect(acquireLock(lockPath)).rejects.toThrow(LockCorruptError);
      await expect(acquireLock(lockPath)).rejects.toThrow(/invalid pid/);
    });

    it('should throw LockCorruptError when pid is float', async () => {
      writeFileSync(
        lockPath,
        JSON.stringify({ pid: 123.456, started_at: '2024-01-01', boot_id: 'test' }),
        'utf-8'
      );
      await expect(acquireLock(lockPath)).rejects.toThrow(LockCorruptError);
      await expect(acquireLock(lockPath)).rejects.toThrow(/invalid pid/);
    });

    it('should throw LockCorruptError when started_at is missing', async () => {
      writeFileSync(lockPath, JSON.stringify({ pid: 123, boot_id: 'test' }), 'utf-8');
      await expect(acquireLock(lockPath)).rejects.toThrow(LockCorruptError);
      await expect(acquireLock(lockPath)).rejects.toThrow(/invalid started_at/);
    });

    it('should throw LockCorruptError when started_at is empty string', async () => {
      writeFileSync(
        lockPath,
        JSON.stringify({ pid: 123, started_at: '', boot_id: 'test' }),
        'utf-8'
      );
      await expect(acquireLock(lockPath)).rejects.toThrow(LockCorruptError);
      await expect(acquireLock(lockPath)).rejects.toThrow(/invalid started_at/);
    });

    it('should throw LockCorruptError when boot_id is missing', async () => {
      writeFileSync(lockPath, JSON.stringify({ pid: 123, started_at: '2024-01-01' }), 'utf-8');
      await expect(acquireLock(lockPath)).rejects.toThrow(LockCorruptError);
      await expect(acquireLock(lockPath)).rejects.toThrow(/invalid boot_id/);
    });

    it('should throw LockCorruptError when boot_id is empty string', async () => {
      writeFileSync(
        lockPath,
        JSON.stringify({ pid: 123, started_at: '2024-01-01', boot_id: '' }),
        'utf-8'
      );
      await expect(acquireLock(lockPath)).rejects.toThrow(LockCorruptError);
      await expect(acquireLock(lockPath)).rejects.toThrow(/invalid boot_id/);
    });

    it('should throw LockCorruptError when lock is an array', async () => {
      writeFileSync(lockPath, '[]', 'utf-8');
      await expect(acquireLock(lockPath)).rejects.toThrow(LockCorruptError);
      await expect(acquireLock(lockPath)).rejects.toThrow(/invalid structure/);
    });

    it('should throw LockCorruptError when lock is null', async () => {
      writeFileSync(lockPath, 'null', 'utf-8');
      await expect(acquireLock(lockPath)).rejects.toThrow(LockCorruptError);
      await expect(acquireLock(lockPath)).rejects.toThrow(/invalid structure/);
    });
  });
});
