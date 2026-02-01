/**
 * S003: Schema parity test.
 *
 * Verifies that REPORT_CODES in TypeScript constants exactly match
 * the enum in report.schema.json. This ensures no drift between
 * the two sources of truth.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPORT_CODES } from '../../src/constants/report_codes.js';

describe('S003: Schema parity', () => {
  it('should have REPORT_CODES match report.schema.json enum exactly', () => {
    // Load the JSON schema
    const schemaPath = join(process.cwd(), 'relais/schemas/report.schema.json');
    const schemaContent = readFileSync(schemaPath, 'utf-8');
    const schema = JSON.parse(schemaContent);

    // Extract the enum from schema.properties.code.enum
    const schemaEnum: string[] = schema.properties?.code?.enum;
    expect(schemaEnum).toBeDefined();
    expect(Array.isArray(schemaEnum)).toBe(true);

    // Convert to sets for comparison
    const tsCodesSet = new Set(REPORT_CODES);
    const schemaCodesSet = new Set(schemaEnum);

    // Find differences
    const missingInSchema = REPORT_CODES.filter(code => !schemaCodesSet.has(code));
    const extraInSchema = schemaEnum.filter(code => !tsCodesSet.has(code));

    // Build helpful error message if there's a mismatch
    if (missingInSchema.length > 0 || extraInSchema.length > 0) {
      const errors: string[] = [];
      if (missingInSchema.length > 0) {
        errors.push(`Codes in TS but missing in schema: ${missingInSchema.join(', ')}`);
      }
      if (extraInSchema.length > 0) {
        errors.push(`Codes in schema but missing in TS: ${extraInSchema.join(', ')}`);
      }
      expect.fail(errors.join('\n'));
    }

    // Verify exact equality
    expect(REPORT_CODES.length).toBe(schemaEnum.length);
    for (const code of REPORT_CODES) {
      expect(schemaCodesSet.has(code)).toBe(true);
    }
  });

  it('should have no duplicate codes in REPORT_CODES', () => {
    const seen = new Set<string>();
    const duplicates: string[] = [];

    for (const code of REPORT_CODES) {
      if (seen.has(code)) {
        duplicates.push(code);
      }
      seen.add(code);
    }

    expect(duplicates).toEqual([]);
  });

  it('should have no duplicate codes in schema enum', () => {
    const schemaPath = join(process.cwd(), 'relais/schemas/report.schema.json');
    const schemaContent = readFileSync(schemaPath, 'utf-8');
    const schema = JSON.parse(schemaContent);
    const schemaEnum: string[] = schema.properties?.code?.enum;

    const seen = new Set<string>();
    const duplicates: string[] = [];

    for (const code of schemaEnum) {
      if (seen.has(code)) {
        duplicates.push(code);
      }
      seen.add(code);
    }

    expect(duplicates).toEqual([]);
  });

  it('should have valid code format (uppercase with underscores)', () => {
    const validPattern = /^(SUCCESS|STOP_[A-Z_]+|BLOCKED_[A-Z_]+)$/;

    for (const code of REPORT_CODES) {
      expect(code).toMatch(validPattern);
    }
  });
});
