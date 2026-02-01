/**
 * Pure parser module for builder output validation.
 *
 * Provides typed error discrimination for builder output parsing failures,
 * separating JSON parse errors, schema validation errors, and shape errors.
 */

import { validateWithSchema } from '../lib/schema.js';
import type { BuilderResult } from '../types/builder.js';

/**
 * Error kind for builder parse failures.
 */
export type BuilderParseErrorKind = 'json_parse' | 'schema' | 'shape';

/**
 * Result of parsing builder output.
 */
export type BuilderParseResult =
  | { ok: true; value: BuilderResult }
  | { ok: false; kind: BuilderParseErrorKind; message: string; details?: unknown };

/**
 * Checks if parsed JSON has the expected BuilderResult shape.
 *
 * This is a fallback validation when schema is not available.
 */
function hasBuilderResultShape(data: unknown): data is BuilderResult {
  return (
    typeof data === 'object' &&
    data !== null &&
    'summary' in data &&
    typeof (data as Record<string, unknown>).summary === 'string' &&
    'files_intended' in data &&
    Array.isArray((data as Record<string, unknown>).files_intended) &&
    'commands_ran' in data &&
    Array.isArray((data as Record<string, unknown>).commands_ran) &&
    'notes' in data &&
    Array.isArray((data as Record<string, unknown>).notes)
  );
}

/**
 * Parses raw builder output into a typed BuilderResult.
 *
 * Performs three-step validation:
 * 1. JSON.parse() → json_parse error on failure
 * 2. Schema validation (if schema provided) → schema error on failure
 * 3. Shape check (fallback) → shape error on failure
 *
 * @param raw - Raw string output from builder
 * @param schema - Optional JSON schema object for validation
 * @returns BuilderParseResult with typed error discrimination
 */
export function parseBuilderResultRaw(
  raw: string,
  schema?: object
): BuilderParseResult {
  // Step 1: JSON.parse
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      kind: 'json_parse',
      message: `JSON parse error: ${message}`,
      details: { rawPreview: raw.substring(0, 200) },
    };
  }

  // Step 2: Schema validation (if schema provided)
  if (schema) {
    const validationResult = validateWithSchema<BuilderResult>(parsed, schema);
    if (!validationResult.valid) {
      return {
        ok: false,
        kind: 'schema',
        message: `Schema validation failed: ${validationResult.errors.join(', ')}`,
        details: { errors: validationResult.errors, rawErrors: validationResult.rawErrors },
      };
    }
    return { ok: true, value: validationResult.data! };
  }

  // Step 3: Fallback shape check (no schema available)
  if (!hasBuilderResultShape(parsed)) {
    return {
      ok: false,
      kind: 'shape',
      message: 'Parsed JSON does not match expected BuilderResult shape',
      details: { keys: typeof parsed === 'object' && parsed !== null ? Object.keys(parsed) : [] },
    };
  }

  return { ok: true, value: parsed };
}
