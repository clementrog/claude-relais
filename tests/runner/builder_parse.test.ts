import { describe, it, expect, beforeAll } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseBuilderResultRaw } from '@/runner/builder_parse';
import { loadSchema } from '@/lib/schema';

const FIXTURES_DIR = join(__dirname, '..', 'fixtures', 'builder_parse');

describe('parseBuilderResultRaw', () => {
  let builderResultSchema: object;

  beforeAll(async () => {
    builderResultSchema = await loadSchema('relais/schemas/builder_result.schema.json');
  });

  describe('json_parse errors', () => {
    it('should return json_parse error for fenced JSON with prose', async () => {
      const raw = await readFile(join(FIXTURES_DIR, 'builder_raw_fenced.txt'), 'utf-8');
      const result = parseBuilderResultRaw(raw, builderResultSchema);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.kind).toBe('json_parse');
        expect(result.message).toContain('JSON parse error');
      }
    });

    it('should return json_parse error for plain prose', () => {
      const raw = 'I completed the task successfully. Everything looks good!';
      const result = parseBuilderResultRaw(raw, builderResultSchema);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.kind).toBe('json_parse');
        expect(result.message).toContain('JSON parse error');
      }
    });

    it('should return json_parse error for empty string', () => {
      const raw = '';
      const result = parseBuilderResultRaw(raw, builderResultSchema);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.kind).toBe('json_parse');
        expect(result.message).toContain('JSON parse error');
      }
    });

    it('should return json_parse error for malformed JSON', () => {
      const raw = '{ "summary": "test", missing quotes }';
      const result = parseBuilderResultRaw(raw, builderResultSchema);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.kind).toBe('json_parse');
        expect(result.message).toContain('JSON parse error');
      }
    });
  });

  describe('schema errors', () => {
    it('should return schema error for missing required fields', async () => {
      const raw = await readFile(join(FIXTURES_DIR, 'builder_raw_missing_required.json'), 'utf-8');
      const result = parseBuilderResultRaw(raw, builderResultSchema);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.kind).toBe('schema');
        expect(result.message).toContain('Schema validation failed');
      }
    });

    it('should return schema error for wrong types', () => {
      const raw = JSON.stringify({
        summary: 123, // should be string
        files_intended: ['config.ts'],
        commands_ran: ['pnpm test'],
        notes: ['done'],
      });
      const result = parseBuilderResultRaw(raw, builderResultSchema);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.kind).toBe('schema');
        expect(result.message).toContain('Schema validation failed');
      }
    });

    it('should return schema error for array with wrong item types', () => {
      const raw = JSON.stringify({
        summary: 'test',
        files_intended: [123, 456], // should be strings
        commands_ran: ['pnpm test'],
        notes: ['done'],
      });
      const result = parseBuilderResultRaw(raw, builderResultSchema);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.kind).toBe('schema');
        expect(result.message).toContain('Schema validation failed');
      }
    });
  });

  describe('shape errors (without schema)', () => {
    it('should return shape error for missing fields when no schema', () => {
      const raw = JSON.stringify({
        summary: 'test',
        // missing files_intended, commands_ran, notes
      });
      const result = parseBuilderResultRaw(raw);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.kind).toBe('shape');
        expect(result.message).toContain('does not match expected BuilderResult shape');
      }
    });

    it('should return shape error for array instead of object when no schema', () => {
      const raw = JSON.stringify(['summary', 'files']);
      const result = parseBuilderResultRaw(raw);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.kind).toBe('shape');
      }
    });

    it('should return shape error for wrong types when no schema', () => {
      const raw = JSON.stringify({
        summary: 123, // wrong type but shape check doesn't catch this
        files_intended: 'not-an-array', // wrong type
        commands_ran: [],
        notes: [],
      });
      const result = parseBuilderResultRaw(raw);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.kind).toBe('shape');
      }
    });
  });

  describe('success cases', () => {
    it('should parse valid JSON with schema', async () => {
      const raw = await readFile(join(FIXTURES_DIR, 'builder_raw_valid.json'), 'utf-8');
      const result = parseBuilderResultRaw(raw, builderResultSchema);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.summary).toBe('Implemented the new feature');
        expect(result.value.files_intended).toEqual(['src/feature.ts', 'src/feature.test.ts']);
        expect(result.value.commands_ran).toEqual(['pnpm build', 'pnpm test']);
        expect(result.value.notes).toEqual(['All tests pass', 'Feature is ready for review']);
      }
    });

    it('should parse valid JSON without schema (shape check)', async () => {
      const raw = await readFile(join(FIXTURES_DIR, 'builder_raw_valid.json'), 'utf-8');
      const result = parseBuilderResultRaw(raw);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.summary).toBe('Implemented the new feature');
        expect(result.value.files_intended).toEqual(['src/feature.ts', 'src/feature.test.ts']);
      }
    });

    it('should parse minimal valid JSON', () => {
      const raw = JSON.stringify({
        summary: 'Done',
        files_intended: [],
        commands_ran: [],
        notes: [],
      });
      const result = parseBuilderResultRaw(raw, builderResultSchema);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.summary).toBe('Done');
        expect(result.value.files_intended).toEqual([]);
      }
    });
  });

  describe('error details', () => {
    it('should include rawPreview in json_parse error details', () => {
      const raw = 'This is not JSON at all';
      const result = parseBuilderResultRaw(raw, builderResultSchema);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.details).toBeDefined();
        expect((result.details as { rawPreview: string }).rawPreview).toBe('This is not JSON at all');
      }
    });

    it('should include errors in schema error details', () => {
      const raw = JSON.stringify({ summary: 123 });
      const result = parseBuilderResultRaw(raw, builderResultSchema);

      expect(result.ok).toBe(false);
      if (!result.ok && result.kind === 'schema') {
        expect(result.details).toBeDefined();
        expect((result.details as { errors: string[] }).errors).toBeDefined();
      }
    });

    it('should include keys in shape error details', () => {
      const raw = JSON.stringify({ foo: 'bar', baz: 123 });
      const result = parseBuilderResultRaw(raw);

      expect(result.ok).toBe(false);
      if (!result.ok && result.kind === 'shape') {
        expect(result.details).toBeDefined();
        expect((result.details as { keys: string[] }).keys).toEqual(['foo', 'baz']);
      }
    });
  });
});
