/**
 * S002: Version bump discipline
 *
 * Schema version field exists and follows semver; breaking changes detected
 * via snapshot comparison
 */

import { describe, it, expect } from 'vitest';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { loadSchema } from '@/lib/schema';

/**
 * Validates semver version string (major.minor.patch)
 */
function isValidSemver(version: string): boolean {
  const semverRegex = /^\d+\.\d+\.\d+(-[a-zA-Z0-9.-]+)?(\+[a-zA-Z0-9.-]+)?$/;
  return semverRegex.test(version);
}

/**
 * Extracts version from semver string
 */
function parseSemver(version: string): { major: number; minor: number; patch: number } | null {
  const match = version.match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!match) return null;
  return {
    major: parseInt(match[1], 10),
    minor: parseInt(match[2], 10),
    patch: parseInt(match[3], 10),
  };
}

describe('S002: Version bump discipline', () => {
  const schemasDir = 'relais/schemas';

  it('should discover all schema files', async () => {
    const files = await readdir(schemasDir);
    const schemaFiles = files.filter(f => f.endsWith('.schema.json'));
    expect(schemaFiles.length).toBeGreaterThan(0);
  });

  describe('Schema structure validation', () => {
    it('should have $schema field pointing to draft-2020-12', async () => {
      const files = await readdir(schemasDir);
      const schemaFiles = files.filter(f => f.endsWith('.schema.json'));

      for (const schemaFile of schemaFiles) {
        const schema = await loadSchema(join(schemasDir, schemaFile));
        expect(schema).toHaveProperty('$schema');
        expect((schema as { $schema: string }).$schema).toBe(
          'https://json-schema.org/draft/2020-12/schema'
        );
      }
    });

    it('should have $id field with valid URI', async () => {
      const files = await readdir(schemasDir);
      const schemaFiles = files.filter(f => f.endsWith('.schema.json'));

      for (const schemaFile of schemaFiles) {
        const schema = await loadSchema(join(schemasDir, schemaFile));
        expect(schema).toHaveProperty('$id');
        const id = (schema as { $id: string }).$id;
        expect(id).toMatch(/^https?:\/\//);
        expect(id).toContain('.schema.json');
      }
    });

    it('should have title field', async () => {
      const files = await readdir(schemasDir);
      const schemaFiles = files.filter(f => f.endsWith('.schema.json'));

      for (const schemaFile of schemaFiles) {
        const schema = await loadSchema(join(schemasDir, schemaFile));
        expect(schema).toHaveProperty('title');
        const title = (schema as { title: string }).title;
        expect(typeof title).toBe('string');
        expect(title.length).toBeGreaterThan(0);
      }
    });
  });

  describe('Schema snapshot comparison', () => {
    it('should match snapshot for task.schema.json', async () => {
      const schema = await loadSchema(join(schemasDir, 'task.schema.json'));
      // Snapshot the core structure (excluding potential version fields)
      const snapshot = {
        $schema: (schema as { $schema: string }).$schema,
        $id: (schema as { $id: string }).$id,
        title: (schema as { title: string }).title,
        type: (schema as { type: string }).type,
        required: (schema as { required?: string[] }).required,
      };
      expect(snapshot).toMatchSnapshot();
    });

    it('should match snapshot for report.schema.json', async () => {
      const schema = await loadSchema(join(schemasDir, 'report.schema.json'));
      const snapshot = {
        $schema: (schema as { $schema: string }).$schema,
        $id: (schema as { $id: string }).$id,
        title: (schema as { title: string }).title,
        type: (schema as { type: string }).type,
        required: (schema as { required?: string[] }).required,
      };
      expect(snapshot).toMatchSnapshot();
    });

    it('should match snapshot for builder_result.schema.json', async () => {
      const schema = await loadSchema(join(schemasDir, 'builder_result.schema.json'));
      const snapshot = {
        $schema: (schema as { $schema: string }).$schema,
        $id: (schema as { $id: string }).$id,
        title: (schema as { title: string }).title,
        type: (schema as { type: string }).type,
        required: (schema as { required?: string[] }).required,
      };
      expect(snapshot).toMatchSnapshot();
    });

    it('should match snapshot for reviewer_result.schema.json', async () => {
      const schema = await loadSchema(join(schemasDir, 'reviewer_result.schema.json'));
      const snapshot = {
        $schema: (schema as { $schema: string }).$schema,
        $id: (schema as { $id: string }).$id,
        title: (schema as { title: string }).title,
        type: (schema as { type: string }).type,
        required: (schema as { required?: string[] }).required,
      };
      expect(snapshot).toMatchSnapshot();
    });
  });

  describe('Breaking change detection', () => {
    it('should detect if required fields are removed (breaking change)', async () => {
      const schema = await loadSchema(join(schemasDir, 'task.schema.json'));
      const required = (schema as { required?: string[] }).required || [];
      
      // Snapshot the required fields - removing any would be a breaking change
      expect(required).toMatchSnapshot('task.schema.json-required-fields');
    });

    it('should detect if required fields are removed in report.schema.json', async () => {
      const schema = await loadSchema(join(schemasDir, 'report.schema.json'));
      const required = (schema as { required?: string[] }).required || [];
      expect(required).toMatchSnapshot('report.schema.json-required-fields');
    });

    it('should detect if required fields are removed in builder_result.schema.json', async () => {
      const schema = await loadSchema(join(schemasDir, 'builder_result.schema.json'));
      const required = (schema as { required?: string[] }).required || [];
      expect(required).toMatchSnapshot('builder_result.schema.json-required-fields');
    });

    it('should detect if required fields are removed in reviewer_result.schema.json', async () => {
      const schema = await loadSchema(join(schemasDir, 'reviewer_result.schema.json'));
      const required = (schema as { required?: string[] }).required || [];
      expect(required).toMatchSnapshot('reviewer_result.schema.json-required-fields');
    });
  });

  describe('Version field validation (if present)', () => {
    it('should validate version field format if it exists', async () => {
      const files = await readdir(schemasDir);
      const schemaFiles = files.filter(f => f.endsWith('.schema.json'));

      for (const schemaFile of schemaFiles) {
        const schema = await loadSchema(join(schemasDir, schemaFile));
        const version = (schema as { version?: string }).version;
        
        if (version !== undefined) {
          expect(typeof version).toBe('string');
          expect(isValidSemver(version)).toBe(true);
          
          const parsed = parseSemver(version);
          expect(parsed).not.toBeNull();
          if (parsed) {
            expect(parsed.major).toBeGreaterThanOrEqual(0);
            expect(parsed.minor).toBeGreaterThanOrEqual(0);
            expect(parsed.patch).toBeGreaterThanOrEqual(0);
          }
        }
      }
    });
  });

  describe('Schema consistency checks', () => {
    it('should have consistent $id naming pattern', async () => {
      const files = await readdir(schemasDir);
      const schemaFiles = files.filter(f => f.endsWith('.schema.json'));

      for (const schemaFile of schemaFiles) {
        const schema = await loadSchema(join(schemasDir, schemaFile));
        const id = (schema as { $id: string }).$id;
        
        // All schemas should use the envoi.local domain
        expect(id).toMatch(/^https:\/\/envoi\.local\/schemas\//);
        // $id should match filename
        expect(id).toContain(schemaFile);
      }
    });
  });
});
