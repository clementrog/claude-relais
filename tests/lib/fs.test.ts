import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { atomicWriteJson, atomicReadJson, AtomicFsError, cleanupTmpFiles } from '@/lib/fs';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('atomicWriteJson', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), `relais-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    try {
      await rm(testDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  it('should write JSON data atomically', async () => {
    const filePath = join(testDir, 'test.json');
    const data = { version: 1, enabled: true, name: 'test' };

    await atomicWriteJson(filePath, data);

    const result = await atomicReadJson<typeof data>(filePath);
    expect(result).toEqual(data);
  });

  it('should format JSON with 2-space indent', async () => {
    const filePath = join(testDir, 'formatted.json');
    const data = { a: 1, b: { c: 2 } };

    await atomicWriteJson(filePath, data);

    const content = await import('node:fs/promises').then(fs => fs.readFile(filePath, 'utf-8'));
    expect(content).toMatch(/^\{\n  "a": 1,/);
    expect(content).toContain('\n');
  });

  it('should not leave .tmp file after successful write', async () => {
    const filePath = join(testDir, 'clean.json');
    const data = { test: true };

    await atomicWriteJson(filePath, data);

    const files = await import('node:fs/promises').then(fs => fs.readdir(testDir));
    expect(files).not.toContain('clean.json.tmp');
    expect(files).toContain('clean.json');
  });

  it('should throw AtomicFsError on write failure', async () => {
    const filePath = '/invalid/path/that/does/not/exist/test.json';

    await expect(atomicWriteJson(filePath, { test: true })).rejects.toThrow(AtomicFsError);
  });
});

describe('atomicReadJson', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), `relais-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    try {
      await rm(testDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  it('should read and parse JSON file', async () => {
    const filePath = join(testDir, 'read.json');
    const data = { version: 2, items: ['a', 'b'] };

    await atomicWriteJson(filePath, data);
    const result = await atomicReadJson<typeof data>(filePath);

    expect(result).toEqual(data);
  });

  it('should throw AtomicFsError when file does not exist', async () => {
    const filePath = join(testDir, 'nonexistent.json');

    await expect(atomicReadJson(filePath)).rejects.toThrow(AtomicFsError);
  });

  it('should throw AtomicFsError on invalid JSON', async () => {
    const filePath = join(testDir, 'invalid.json');
    await import('node:fs/promises').then(fs => fs.writeFile(filePath, '{ invalid json }'));

    await expect(atomicReadJson(filePath)).rejects.toThrow(AtomicFsError);
  });
});

describe('cleanupTmpFiles', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), `relais-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    try {
      await rm(testDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  it('should delete .tmp files', async () => {
    const tmpFile1 = join(testDir, 'file1.tmp');
    const tmpFile2 = join(testDir, 'file2.tmp');
    const normalFile = join(testDir, 'normal.json');

    await import('node:fs/promises').then(fs => Promise.all([
      fs.writeFile(tmpFile1, 'temp1'),
      fs.writeFile(tmpFile2, 'temp2'),
      fs.writeFile(normalFile, '{}'),
    ]));

    const deleted = await cleanupTmpFiles(testDir);

    expect(deleted).toHaveLength(2);
    expect(deleted).toContain(tmpFile1);
    expect(deleted).toContain(tmpFile2);

    const files = await import('node:fs/promises').then(fs => fs.readdir(testDir));
    expect(files).not.toContain('file1.tmp');
    expect(files).not.toContain('file2.tmp');
    expect(files).toContain('normal.json');
  });

  it('should return empty array when no .tmp files exist', async () => {
    const deleted = await cleanupTmpFiles(testDir);
    expect(deleted).toEqual([]);
  });
});
