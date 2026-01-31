/**
 * JSON Schema validation utilities using Ajv.
 *
 * Provides functions to load and validate data against JSON schemas.
 */

import AjvDefault from 'ajv';
import type { ValidateFunction } from 'ajv';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Raw AJV error object (subset of fields we care about).
 */
export interface RawAjvError {
  instancePath: string;
  schemaPath: string;
  keyword: string;
  params: Record<string, unknown>;
  message?: string;
}

/**
 * Result of schema validation.
 */
export interface ValidationResult<T> {
  /** Whether the data is valid */
  valid: boolean;
  /** Typed data if valid, null otherwise */
  data: T | null;
  /** Validation error messages if invalid */
  errors: string[];
  /** Raw AJV error objects for diagnostics */
  rawErrors?: RawAjvError[];
}

// Cache for compiled schemas
const schemaCache = new Map<string, ValidateFunction>();

/**
 * Loads and parses a JSON schema file.
 *
 * @param schemaPath - Path to the JSON schema file
 * @returns Parsed schema object
 * @throws Error if the schema file cannot be read or parsed
 */
export async function loadSchema(schemaPath: string): Promise<object> {
  try {
    const content = await readFile(schemaPath, 'utf-8');
    return JSON.parse(content);
  } catch (error) {
    throw new Error(
      `Failed to load schema from ${schemaPath}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/**
 * Validates data against a JSON schema using Ajv.
 *
 * Uses draft-2020-12 schema support and caches compiled schemas for performance.
 *
 * @param data - Data to validate
 * @param schema - JSON schema object
 * @returns ValidationResult with typed data or error messages
 */
export function validateWithSchema<T>(data: unknown, schema: object): ValidationResult<T> {
  // Create Ajv instance with draft-2020-12 support
  // Type assertion needed due to NodeNext module resolution
  const Ajv = AjvDefault as unknown as new (options?: { strict?: boolean; allErrors?: boolean; verbose?: boolean }) => {
    compile: (schema: object) => ValidateFunction;
  };
  const ajv = new Ajv({
    strict: true,
    allErrors: true,
    verbose: true,
  });

  // Use schema ID or stringified schema as cache key
  const schemaId = (schema as { $id?: string }).$id || JSON.stringify(schema);
  let validate: ValidateFunction;

  // Check cache first
  if (schemaCache.has(schemaId)) {
    validate = schemaCache.get(schemaId)!;
  } else {
    // Compile and cache schema
    validate = ajv.compile(schema);
    schemaCache.set(schemaId, validate);
  }

  // Validate data
  const valid = validate(data);

  if (valid) {
    return {
      valid: true,
      data: data as T,
      errors: [],
    };
  }

  // Collect error messages
  const errors: string[] = [];
  if (validate.errors) {
    for (const error of validate.errors) {
      const path = error.instancePath || error.schemaPath || '';
      const message = error.message || 'Validation error';
      errors.push(`${path ? `${path}: ` : ''}${message}`);
    }
  }

  // Extract raw errors for diagnostics
  const rawErrors: RawAjvError[] = validate.errors
    ? validate.errors.map((e) => ({
        instancePath: e.instancePath || '',
        schemaPath: e.schemaPath || '',
        keyword: e.keyword || '',
        params: e.params as Record<string, unknown>,
        message: e.message,
      }))
    : [];

  return {
    valid: false,
    data: null,
    errors,
    rawErrors,
  };
}
