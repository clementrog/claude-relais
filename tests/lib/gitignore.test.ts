import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  addEnvoiIgnores,
  checkEnvoiIgnores,
  ENVOI_GITIGNORE_MARKER,
  ENVOI_GITIGNORE_ENTRIES,
} from '@/lib/gitignore';
import { mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('addEnvoiIgnores', () => {
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

  it('should create .gitignore if it does not exist', async () => {
    const result = await addEnvoiIgnores(testDir);

    expect(result.created).toBe(true);
    expect(result.added).toEqual(ENVOI_GITIGNORE_ENTRIES);
    expect(result.alreadyPresent).toEqual([]);

    const content = await readFile(join(testDir, '.gitignore'), 'utf-8');
    expect(content).toContain(ENVOI_GITIGNORE_MARKER);
    for (const entry of ENVOI_GITIGNORE_ENTRIES) {
      expect(content).toContain(entry);
    }
  });

  it('should append to existing .gitignore', async () => {
    const gitignorePath = join(testDir, '.gitignore');
    await writeFile(gitignorePath, 'node_modules/\n.env\n');

    const result = await addEnvoiIgnores(testDir);

    expect(result.created).toBe(false);
    expect(result.added).toEqual(ENVOI_GITIGNORE_ENTRIES);

    const content = await readFile(gitignorePath, 'utf-8');
    expect(content).toContain('node_modules/');
    expect(content).toContain('.env');
    expect(content).toContain(ENVOI_GITIGNORE_MARKER);
    for (const entry of ENVOI_GITIGNORE_ENTRIES) {
      expect(content).toContain(entry);
    }
  });

  it('should be idempotent - not duplicate entries', async () => {
    // First call
    await addEnvoiIgnores(testDir);
    const firstContent = await readFile(join(testDir, '.gitignore'), 'utf-8');

    // Second call
    const result = await addEnvoiIgnores(testDir);

    expect(result.added).toEqual([]);
    expect(result.alreadyPresent).toEqual(ENVOI_GITIGNORE_ENTRIES);

    const secondContent = await readFile(join(testDir, '.gitignore'), 'utf-8');
    expect(secondContent).toBe(firstContent);
  });

  it('should not duplicate marker on repeated calls', async () => {
    await addEnvoiIgnores(testDir);
    await addEnvoiIgnores(testDir);
    await addEnvoiIgnores(testDir);

    const content = await readFile(join(testDir, '.gitignore'), 'utf-8');
    // Escape regex special characters in marker
    const escapedMarker = ENVOI_GITIGNORE_MARKER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const markerCount = (content.match(new RegExp(escapedMarker, 'g')) || []).length;
    expect(markerCount).toBe(1);
  });

  it('should detect already present entries', async () => {
    const gitignorePath = join(testDir, '.gitignore');
    await writeFile(gitignorePath, `${ENVOI_GITIGNORE_ENTRIES[0]}\n${ENVOI_GITIGNORE_ENTRIES[2]}\n`);

    const result = await addEnvoiIgnores(testDir);

    expect(result.alreadyPresent).toContain(ENVOI_GITIGNORE_ENTRIES[0]);
    expect(result.alreadyPresent).toContain(ENVOI_GITIGNORE_ENTRIES[2]);
    expect(result.added).not.toContain(ENVOI_GITIGNORE_ENTRIES[0]);
    expect(result.added).not.toContain(ENVOI_GITIGNORE_ENTRIES[2]);
  });

  it('should handle .gitignore without trailing newline', async () => {
    const gitignorePath = join(testDir, '.gitignore');
    await writeFile(gitignorePath, 'node_modules/'); // No trailing newline

    await addEnvoiIgnores(testDir);

    const content = await readFile(gitignorePath, 'utf-8');
    expect(content).toContain('node_modules/\n');
    expect(content).toContain(ENVOI_GITIGNORE_MARKER);
  });

  it('should accept custom entries', async () => {
    const customEntries = ['custom/path', 'another/path'];
    const result = await addEnvoiIgnores(testDir, customEntries);

    expect(result.added).toEqual(customEntries);

    const content = await readFile(join(testDir, '.gitignore'), 'utf-8');
    expect(content).toContain('custom/path');
    expect(content).toContain('another/path');
  });
});

describe('checkEnvoiIgnores', () => {
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

  it('should return all entries as missing when .gitignore does not exist', async () => {
    const result = await checkEnvoiIgnores(testDir);

    expect(result.complete).toBe(false);
    expect(result.missing).toEqual(ENVOI_GITIGNORE_ENTRIES);
    expect(result.present).toEqual([]);
  });

  it('should return complete=true when all entries present', async () => {
    await addEnvoiIgnores(testDir);

    const result = await checkEnvoiIgnores(testDir);

    expect(result.complete).toBe(true);
    expect(result.missing).toEqual([]);
    expect(result.present).toEqual(ENVOI_GITIGNORE_ENTRIES);
  });

  it('should detect partial presence', async () => {
    const gitignorePath = join(testDir, '.gitignore');
    await writeFile(gitignorePath, `${ENVOI_GITIGNORE_ENTRIES[0]}\n${ENVOI_GITIGNORE_ENTRIES[2]}\n`);

    const result = await checkEnvoiIgnores(testDir);

    expect(result.complete).toBe(false);
    expect(result.present).toContain(ENVOI_GITIGNORE_ENTRIES[0]);
    expect(result.present).toContain(ENVOI_GITIGNORE_ENTRIES[2]);
    expect(result.missing).not.toContain(ENVOI_GITIGNORE_ENTRIES[0]);
    expect(result.missing).not.toContain(ENVOI_GITIGNORE_ENTRIES[2]);
    expect(result.missing.length).toBeGreaterThan(0);
  });
});
