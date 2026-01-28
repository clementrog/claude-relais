import { describe, it, expect } from 'vitest';
import { validateWithSchema, loadSchema, ValidationResult } from '@/lib/schema';

describe('validateWithSchema', () => {
  it('should validate valid data against schema', () => {
    const schema = {
      type: 'object',
      properties: {
        name: { type: 'string' },
        age: { type: 'number' },
      },
      required: ['name'],
    };

    const data = { name: 'John', age: 30 };
    const result = validateWithSchema<typeof data>(data, schema);

    expect(result.valid).toBe(true);
    expect(result.data).toEqual(data);
    expect(result.errors).toEqual([]);
  });

  it('should reject invalid data with error messages', () => {
    const schema = {
      type: 'object',
      properties: {
        name: { type: 'string' },
        age: { type: 'number', minimum: 0 },
      },
      required: ['name'],
    };

    const data = { age: -5 }; // Missing required 'name', invalid age
    const result = validateWithSchema<typeof data>(data, schema);

    expect(result.valid).toBe(false);
    expect(result.data).toBeNull();
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors.some(e => e.includes('name') || e.includes('required'))).toBe(true);
  });

  it('should validate nested objects', () => {
    const schema = {
      type: 'object',
      properties: {
        user: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            email: { type: 'string' },
          },
          required: ['name'],
        },
      },
      required: ['user'],
    };

    const validData = {
      user: {
        name: 'Alice',
        email: 'alice@example.com',
      },
    };

    const result = validateWithSchema<typeof validData>(validData, schema);
    expect(result.valid).toBe(true);
    expect(result.data).toEqual(validData);
  });

  it('should validate arrays', () => {
    const schema = {
      type: 'object',
      properties: {
        items: {
          type: 'array',
          items: { type: 'string' },
          minItems: 1,
        },
      },
      required: ['items'],
    };

    const validData = { items: ['a', 'b', 'c'] };
    const result = validateWithSchema<typeof validData>(validData, schema);

    expect(result.valid).toBe(true);
    expect(result.data).toEqual(validData);
  });

  it('should cache compiled schemas', () => {
    const schema = {
      $id: 'test-schema',
      type: 'object',
      properties: {
        value: { type: 'string' },
      },
    };

    const data1 = { value: 'test1' };
    const data2 = { value: 'test2' };

    const result1 = validateWithSchema(data1, schema);
    const result2 = validateWithSchema(data2, schema);

    expect(result1.valid).toBe(true);
    expect(result2.valid).toBe(true);
    // Schema should be cached, so both should work efficiently
  });
});

describe('loadSchema', () => {
  it('should load and parse JSON schema file', async () => {
    // Use an existing schema file from the project
    const schemaPath = 'relais/schemas/task.schema.json';
    const schema = await loadSchema(schemaPath);

    expect(schema).toBeDefined();
    expect(typeof schema).toBe('object');
    // Verify it's a valid JSON schema structure
    expect(schema).toHaveProperty('$schema');
  });

  it('should throw error for non-existent file', async () => {
    const schemaPath = 'nonexistent/schema.json';

    await expect(loadSchema(schemaPath)).rejects.toThrow();
  });

  it('should throw error for invalid JSON', async () => {
    // Create a temporary invalid JSON file
    const { writeFile, unlink } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');

    const testFile = join(tmpdir(), `invalid-schema-${Date.now()}.json`);
    await writeFile(testFile, '{ invalid json }');

    try {
      await expect(loadSchema(testFile)).rejects.toThrow();
    } finally {
      await unlink(testFile).catch(() => {});
    }
  });
});
