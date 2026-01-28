/**
 * Task fingerprinting utilities.
 *
 * Task fingerprint is used to detect identical re-dispatch loops.
 * If orchestrator 'retries' without changing the plan, fingerprint stays same and runner stops.
 */

import { createHash } from 'node:crypto';

/**
 * Top-level fields to include in the fingerprint computation.
 */
const TOP_LEVEL_FIELDS = [
  'goal',
  'subtasks',
  'acceptance',
  'verify',
  'implementation',
  'risk',
  'notes',
] as const;

/**
 * Scope fields to include in the fingerprint computation.
 */
const SCOPE_FIELDS = [
  'write',
  'create_under',
  'forbidden',
  'read_forbidden',
] as const;

/**
 * Fields to exclude from fingerprint computation.
 */
const EXCLUDED_FIELDS = new Set(['task_id', 'id', 'v', 'milestone', 'context']);

/**
 * Recursively processes an object to trim strings and ensure canonical form.
 */
function processValue(value: unknown): unknown {
  if (value === null || value === undefined) {
    return value;
  }

  if (typeof value === 'string') {
    return value.trim();
  }

  if (Array.isArray(value)) {
    return value.map(processValue);
  }

  if (typeof value === 'object') {
    const processed: Record<string, unknown> = {};
    const sortedKeys = Object.keys(value).sort();
    for (const key of sortedKeys) {
      processed[key] = processValue((value as Record<string, unknown>)[key]);
    }
    return processed;
  }

  return value;
}

/**
 * Extracts fingerprint-relevant fields from a task object.
 */
function extractFingerprintFields(task: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  // Extract top-level fields
  for (const field of TOP_LEVEL_FIELDS) {
    if (field in task && !EXCLUDED_FIELDS.has(field)) {
      result[field] = task[field];
    }
  }

  // Extract scope fields if scope exists
  if (task.scope && typeof task.scope === 'object') {
    const scope = task.scope as Record<string, unknown>;
    const scopeResult: Record<string, unknown> = {};
    for (const field of SCOPE_FIELDS) {
      if (field in scope) {
        scopeResult[field] = scope[field];
      }
    }
    // Only add scope if it has at least one field
    if (Object.keys(scopeResult).length > 0) {
      result.scope = scopeResult;
    }
  }

  return result;
}

/**
 * Canonicalizes a task object to a stable JSON string.
 *
 * The canonical form:
 * - Has sorted keys (alphabetical order)
 * - Has trimmed strings
 * - Excludes task_id, id, v, milestone, and context fields
 * - Only includes fingerprint-relevant fields
 *
 * @param task - The task object to canonicalize
 * @returns A canonical JSON string representation
 */
export function canonicalizeTask(task: Record<string, unknown>): string {
  // Extract only fingerprint-relevant fields
  const fingerprintData = extractFingerprintFields(task);

  // Process the data (trim strings, sort keys recursively)
  const processed = processValue(fingerprintData);

  // Convert to JSON with stable key ordering
  // JSON.stringify already produces stable output for objects with sorted keys
  return JSON.stringify(processed);
}

/**
 * Computes a SHA-256 fingerprint of a task.
 *
 * @param task - The task object to fingerprint
 * @returns A 64-character hexadecimal SHA-256 hash string
 */
export function computeFingerprint(task: Record<string, unknown>): string {
  const canonical = canonicalizeTask(task);
  const hash = createHash('sha256');
  hash.update(canonical, 'utf8');
  return hash.digest('hex');
}
