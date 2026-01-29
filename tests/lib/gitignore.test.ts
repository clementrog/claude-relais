import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  addRelaisIgnores,
  checkRelaisIgnores,
  RELAIS_GITIGNORE_MARKER,
  RELAIS_GITIGNORE_ENTRIES,
} from '@/lib/gitignore';
import { mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('addRelaisIgnores', () => {
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
    const result = await addRelaisIgnores(testDir);

    expect(result.created).toBe(true);
    expect(result.added).toEqual(RELAIS_GITIGNORE_ENTRIES);
    expect(result.alreadyPresent).toEqual([]);

    const content = await readFile(join(testDir, '.gitignore'), 'utf-8');
    expect(content).toContain(RELAIS_GITIGNORE_MARKER);
    for (const entry of RELAIS_GITIGNORE_ENTRIES) {
      expect(content).toContain(entry);
    }
  });

  it('should append to existing .gitignore', async () => {
    const gitignorePath = join(testDir, '.gitignore');
    await writeFile(gitignorePath, 'node_modules/\n.env\n');

    const result = await addRelaisIgnores(testDir);

    expect(result.created).toBe(false);
    expect(result.added).toEqual(RELAIS_GITIGNORE_ENTRIES);

    const content = await readFile(gitignorePath, 'utf-8');
    expect(content).toContain('node_modules/');
    expect(content).toContain('.env');
    expect(content).toContain(RELAIS_GITIGNORE_MARKER);
    for (const entry of RELAIS_GITIGNORE_ENTRIES) {
      expect(content).toContain(entry);
    }
  });

  it('should be idempotent - not duplicate entries', async () => {
    // First call
    await addRelaisIgnores(testDir);
    const firstContent = await readFile(join(testDir, '.gitignore'), 'utf-8');

    // Second call
    const result = await addRelaisIgnores(testDir);

    expect(result.added).toEqual([]);
    expect(result.alreadyPresent).toEqual(RELAIS_GITIGNORE_ENTRIES);

    const secondContent = await readFile(join(testDir, '.gitignore'), 'utf-8');
    expect(secondContent).toBe(firstContent);
  });

  it('should not duplicate marker on repeated calls', async () => {
    await addRelaisIgnores(testDir);
    await addRelaisIgnores(testDir);
    await addRelaisIgnores(testDir);

    const content = await readFile(join(testDir, '.gitignore'), 'utf-8');
    // Escape regex special characters in marker
    const escapedMarker = RELAIS_GITIGNORE_MARKER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const markerCount = (content.match(new RegExp(escapedMarker, 'g')) || []).length;
    expect(markerCount).toBe(1);
  });

  it('should detect already present entries', async () => {
    const gitignorePath = join(testDir, '.gitignore');
    await writeFile(gitignorePath, 'relais/REPORT.json\nrelais/STATE.json\n');

    const result = await addRelaisIgnores(testDir);

    expect(result.alreadyPresent).toContain('relais/REPORT.json');
    expect(result.alreadyPresent).toContain('relais/STATE.json');
    expect(result.added).not.toContain('relais/REPORT.json');
    expect(result.added).not.toContain('relais/STATE.json');
  });

  it('should handle .gitignore without trailing newline', async () => {
    const gitignorePath = join(testDir, '.gitignore');
    await writeFile(gitignorePath, 'node_modules/'); // No trailing newline

    await addRelaisIgnores(testDir);

    const content = await readFile(gitignorePath, 'utf-8');
    expect(content).toContain('node_modules/\n');
    expect(content).toContain(RELAIS_GITIGNORE_MARKER);
  });

  it('should accept custom entries', async () => {
    const customEntries = ['custom/path', 'another/path'];
    const result = await addRelaisIgnores(testDir, customEntries);

    expect(result.added).toEqual(customEntries);

    const content = await readFile(join(testDir, '.gitignore'), 'utf-8');
    expect(content).toContain('custom/path');
    expect(content).toContain('another/path');
  });
});

describe('checkRelaisIgnores', () => {
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
    const result = await checkRelaisIgnores(testDir);

    expect(result.complete).toBe(false);
    expect(result.missing).toEqual(RELAIS_GITIGNORE_ENTRIES);
    expect(result.present).toEqual([]);
  });

  it('should return complete=true when all entries present', async () => {
    await addRelaisIgnores(testDir);

    const result = await checkRelaisIgnores(testDir);

    expect(result.complete).toBe(true);
    expect(result.missing).toEqual([]);
    expect(result.present).toEqual(RELAIS_GITIGNORE_ENTRIES);
  });

  it('should detect partial presence', async () => {
    const gitignorePath = join(testDir, '.gitignore');
    await writeFile(gitignorePath, 'relais/REPORT.json\nrelais/STATE.json\n');

    const result = await checkRelaisIgnores(testDir);

    expect(result.complete).toBe(false);
    expect(result.present).toContain('relais/REPORT.json');
    expect(result.present).toContain('relais/STATE.json');
    expect(result.missing).not.toContain('relais/REPORT.json');
    expect(result.missing).not.toContain('relais/STATE.json');
    expect(result.missing.length).toBeGreaterThan(0);
  });
});
