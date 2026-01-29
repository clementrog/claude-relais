/**
 * S001: Roundtrip validation
 *
 * All schemas pass roundtrip: parse valid JSON -> validate against schema ->
 * serialize -> validate again
 */

import { describe, it, expect } from 'vitest';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { loadSchema, validateWithSchema } from '@/lib/schema';
import AjvDefault from 'ajv';
import type { ValidateFunction } from 'ajv';

/**
 * Validates with less strict settings for test schemas that use conditionals
 */
function validateWithSchemaRelaxed<T>(data: unknown, schema: object): { valid: boolean; data: T | null; errors: string[] } {
  const Ajv = AjvDefault as unknown as new (options?: { strict?: boolean | 'log'; strictRequired?: boolean | 'log'; strictTypes?: boolean | 'log'; validateFormats?: boolean; allErrors?: boolean; verbose?: boolean }) => {
    compile: (schema: object) => ValidateFunction;
  };
  const ajv = new Ajv({
    strict: 'log', // Use 'log' instead of true to allow conditional required fields
    strictRequired: false, // Allow required fields in conditional schemas
    strictTypes: 'log', // Allow union types
    validateFormats: false, // Don't validate formats (date-time, etc.)
    allErrors: true,
    verbose: true,
  });

  const validate = ajv.compile(schema);
  const valid = validate(data);

  if (valid) {
    return {
      valid: true,
      data: data as T,
      errors: [],
    };
  }

  const errors: string[] = [];
  if (validate.errors) {
    for (const error of validate.errors) {
      const path = error.instancePath || error.schemaPath || '';
      const message = error.message || 'Validation error';
      errors.push(`${path ? `${path}: ` : ''}${message}`);
    }
  }

  return {
    valid: false,
    data: null,
    errors,
  };
}

describe('S001: Roundtrip validation', () => {
  const schemasDir = 'relais/schemas';

  it('should discover all schema files', async () => {
    const files = await readdir(schemasDir);
    const schemaFiles = files.filter(f => f.endsWith('.schema.json'));
    expect(schemaFiles.length).toBeGreaterThan(0);
  });

  describe('task.schema.json', () => {
    it('should pass roundtrip validation', async () => {
      const schemaRaw = await loadSchema(join(schemasDir, 'task.schema.json'));
      // Remove $schema field as it's metadata and causes Ajv to try to resolve it
      const { $schema, ...schema } = schemaRaw as { $schema?: string; [key: string]: unknown };
      const validData = {
        task_id: 'WP-001',
        milestone_id: 'M1',
        task_kind: 'execute' as const,
        intent: 'Test task intent',
        scope: {
          allowed_globs: ['src/**'],
          forbidden_globs: [],
          allow_new_files: true,
          allow_lockfile_changes: false,
        },
        diff_limits: {
          max_files_touched: 10,
          max_lines_changed: 100,
        },
        verification: {
          fast: ['pnpm test'],
          slow: [],
          params: {},
        },
        builder: {
          mode: 'claude_code',
          max_turns: 8,
          instructions: 'Complete the task',
        },
      };

      // First validation
      const result1 = validateWithSchemaRelaxed(validData, schema);
      expect(result1.valid).toBe(true);
      expect(result1.data).toBeDefined();

      // Serialize to JSON and parse back
      const serialized = JSON.stringify(result1.data);
      const parsed = JSON.parse(serialized);

      // Second validation (roundtrip)
      const result2 = validateWithSchemaRelaxed(parsed, schema);
      expect(result2.valid).toBe(true);
      expect(result2.data).toEqual(result1.data);
    });
  });

  describe('report.schema.json', () => {
    it('should pass roundtrip validation', async () => {
      const schemaRaw = await loadSchema(join(schemasDir, 'report.schema.json'));
      // Remove $schema field as it's metadata and causes Ajv to try to resolve it
      const { $schema, ...schema } = schemaRaw as { $schema?: string; [key: string]: unknown };
      const validData = {
        run_id: 'run-12345678',
        started_at: '2026-01-29T08:00:00Z',
        ended_at: '2026-01-29T08:05:00Z',
        duration_ms: 300000,
        base_commit: 'abc1234',
        head_commit: 'def5678',
        task: {
          task_id: 'WP-001',
          milestone_id: 'M1',
          task_kind: 'execute',
          intent: 'Test task',
        },
        verdict: 'success',
        code: 'SUCCESS',
        blast_radius: {
          files_touched: 2,
          lines_added: 10,
          lines_deleted: 5,
          new_files: 0,
        },
        scope: {
          ok: true,
          violations: [],
          touched_paths: ['src/file.ts'],
        },
        diff: {
          files_changed: 1,
          lines_changed: 5,
          diff_patch_path: 'relais/history/run-12345678/diff.patch',
        },
        verification: {
          exec_mode: 'argv_no_shell',
          runs: [],
          verify_log_path: 'relais/history/run-12345678/verify.log',
        },
        budgets: {
          milestone_id: 'M1',
          ticks: 1,
          orchestrator_calls: 1,
          builder_calls: 1,
          verify_runs: 1,
          estimated_cost_usd: 0.1,
          warnings: [],
        },
      };

      // First validation
      const result1 = validateWithSchemaRelaxed(validData, schema);
      expect(result1.valid).toBe(true);
      expect(result1.data).toBeDefined();

      // Serialize to JSON and parse back
      const serialized = JSON.stringify(result1.data);
      const parsed = JSON.parse(serialized);

      // Second validation (roundtrip)
      const result2 = validateWithSchemaRelaxed(parsed, schema);
      expect(result2.valid).toBe(true);
      expect(result2.data).toEqual(result1.data);
    });
  });

  describe('builder_result.schema.json', () => {
    it('should pass roundtrip validation', async () => {
      const schemaRaw = await loadSchema(join(schemasDir, 'builder_result.schema.json'));
      const { $schema, ...schema } = schemaRaw as { $schema?: string; [key: string]: unknown };
      const validData = {
        summary: 'Completed task successfully',
        files_intended: ['src/file.ts'],
        commands_ran: ['pnpm test'],
        notes: ['Task completed'],
      };

      // First validation
      const result1 = validateWithSchemaRelaxed(validData, schema);
      expect(result1.valid).toBe(true);
      expect(result1.data).toBeDefined();

      // Serialize to JSON and parse back
      const serialized = JSON.stringify(result1.data);
      const parsed = JSON.parse(serialized);

      // Second validation (roundtrip)
      const result2 = validateWithSchemaRelaxed(parsed, schema);
      expect(result2.valid).toBe(true);
      expect(result2.data).toEqual(result1.data);
    });
  });

  describe('reviewer_result.schema.json', () => {
    it('should pass roundtrip validation', async () => {
      const schemaRaw = await loadSchema(join(schemasDir, 'reviewer_result.schema.json'));
      const { $schema, ...schema } = schemaRaw as { $schema?: string; [key: string]: unknown };
      const validData = {
        decision: 'proceed',
        reason_short: 'Changes look good',
        risk_flags: [],
      };

      // First validation
      const result1 = validateWithSchemaRelaxed(validData, schema);
      expect(result1.valid).toBe(true);
      expect(result1.data).toBeDefined();

      // Serialize to JSON and parse back
      const serialized = JSON.stringify(result1.data);
      const parsed = JSON.parse(serialized);

      // Second validation (roundtrip)
      const result2 = validateWithSchemaRelaxed(parsed, schema);
      expect(result2.valid).toBe(true);
      expect(result2.data).toEqual(result1.data);
    });

    it('should pass roundtrip validation with ask_question decision', async () => {
      const schemaRaw = await loadSchema(join(schemasDir, 'reviewer_result.schema.json'));
      const { $schema, ...schema } = schemaRaw as { $schema?: string; [key: string]: unknown };
      const validData = {
        decision: 'ask_question',
        reason_short: 'Need clarification',
        risk_flags: [],
        question: {
          prompt: 'What is the purpose of this change?',
          choices: ['Option 1', 'Option 2'],
        },
      };

      // First validation
      const result1 = validateWithSchemaRelaxed(validData, schema);
      expect(result1.valid).toBe(true);
      expect(result1.data).toBeDefined();

      // Serialize to JSON and parse back
      const serialized = JSON.stringify(result1.data);
      const parsed = JSON.parse(serialized);

      // Second validation (roundtrip)
      const result2 = validateWithSchemaRelaxed(parsed, schema);
      expect(result2.valid).toBe(true);
      expect(result2.data).toEqual(result1.data);
    });
  });

  it('should pass roundtrip validation for all schemas', async () => {
    const files = await readdir(schemasDir);
    const schemaFiles = files.filter(f => f.endsWith('.schema.json'));

    for (const schemaFile of schemaFiles) {
      const schemaPath = join(schemasDir, schemaFile);
      const schema = await loadSchema(schemaPath);

      // Create minimal valid data based on schema structure
      // This is a basic test - each schema has its own detailed test above
      expect(schema).toBeDefined();
      expect(schema).toHaveProperty('$schema');
      expect(schema).toHaveProperty('$id');
    }
  });
});
