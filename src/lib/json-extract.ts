/**
 * JSON extraction utilities for parsing LLM output.
 *
 * Handles common LLM output patterns:
 * - Preamble text before JSON
 * - Markdown code fences (```json ... ```)
 * - Multiple JSON objects (takes first valid)
 *
 * @see F001, F002 in tests/lib/F001-json-extract.test.ts
 */

/**
 * Result of JSON extraction attempt.
 */
export interface JsonExtractResult<T = unknown> {
  /** Whether extraction succeeded */
  success: boolean;
  /** Parsed JSON data (null if failed) */
  data: T | null;
  /** Error message if failed */
  error: string | null;
  /** How the JSON was extracted: 'direct' | 'fence' | 'search' */
  method: 'direct' | 'fence' | 'search' | null;
}

/**
 * Attempts to extract JSON from text that may have preamble or code fences.
 *
 * Extraction strategies (in order):
 * 1. Direct parse: Try JSON.parse on the entire string
 * 2. Fence extraction: Look for ```json ... ``` blocks
 * 3. Brace search: Find first { and matching } for object, or [ and ] for array
 *
 * @param text - Raw text that may contain JSON
 * @returns Extraction result with parsed data or error
 */
export function extractJson<T = unknown>(text: string): JsonExtractResult<T> {
  const trimmed = text.trim();

  // Strategy 1: Direct parse
  try {
    const data = JSON.parse(trimmed) as T;
    return { success: true, data, error: null, method: 'direct' };
  } catch {
    // Continue to next strategy
  }

  // Strategy 2: Extract from code fence
  const fenceResult = extractFromFence<T>(trimmed);
  if (fenceResult.success) {
    return fenceResult;
  }

  // Strategy 3: Search for JSON object or array
  const searchResult = extractByBraceSearch<T>(trimmed);
  if (searchResult.success) {
    return searchResult;
  }

  return {
    success: false,
    data: null,
    error: `Failed to extract JSON from text. Tried direct parse, fence extraction, and brace search.`,
    method: null,
  };
}

/**
 * Extracts JSON from markdown code fences.
 *
 * Supports:
 * - ```json ... ```
 * - ``` ... ``` (no language specifier)
 *
 * Takes the first valid JSON found in any fence.
 */
function extractFromFence<T>(text: string): JsonExtractResult<T> {
  // Match ```json ... ``` or ``` ... ```
  // Using non-greedy match and handling nested backticks
  const fenceRegex = /```(?:json)?\s*\n?([\s\S]*?)\n?```/g;
  let match;

  while ((match = fenceRegex.exec(text)) !== null) {
    const content = match[1].trim();
    if (!content) continue;

    try {
      const data = JSON.parse(content) as T;
      return { success: true, data, error: null, method: 'fence' };
    } catch {
      // Try next fence
      continue;
    }
  }

  return {
    success: false,
    data: null,
    error: 'No valid JSON found in code fences',
    method: null,
  };
}

/**
 * Searches for JSON by finding balanced braces.
 *
 * Finds the first { or [ and its matching closing brace,
 * respecting string escaping and nesting.
 */
function extractByBraceSearch<T>(text: string): JsonExtractResult<T> {
  // Find first { or [
  const objectStart = text.indexOf('{');
  const arrayStart = text.indexOf('[');

  let start: number;
  let openChar: string;
  let closeChar: string;

  if (objectStart === -1 && arrayStart === -1) {
    return {
      success: false,
      data: null,
      error: 'No JSON object or array found',
      method: null,
    };
  }

  if (objectStart === -1) {
    start = arrayStart;
    openChar = '[';
    closeChar = ']';
  } else if (arrayStart === -1) {
    start = objectStart;
    openChar = '{';
    closeChar = '}';
  } else {
    // Take whichever comes first
    if (objectStart < arrayStart) {
      start = objectStart;
      openChar = '{';
      closeChar = '}';
    } else {
      start = arrayStart;
      openChar = '[';
      closeChar = ']';
    }
  }

  // Find matching close brace
  let depth = 0;
  let inString = false;
  let escapeNext = false;
  let end = -1;

  for (let i = start; i < text.length; i++) {
    const char = text[i];

    if (escapeNext) {
      escapeNext = false;
      continue;
    }

    if (char === '\\' && inString) {
      escapeNext = true;
      continue;
    }

    if (char === '"') {
      inString = !inString;
      continue;
    }

    if (inString) continue;

    if (char === openChar) {
      depth++;
    } else if (char === closeChar) {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }

  if (end === -1) {
    return {
      success: false,
      data: null,
      error: 'Unbalanced braces in JSON',
      method: null,
    };
  }

  const jsonStr = text.slice(start, end + 1);
  try {
    const data = JSON.parse(jsonStr) as T;
    return { success: true, data, error: null, method: 'search' };
  } catch (e) {
    return {
      success: false,
      data: null,
      error: `Found JSON-like structure but parse failed: ${e instanceof Error ? e.message : String(e)}`,
      method: null,
    };
  }
}

/**
 * Strict JSON extraction - only accepts direct parse.
 *
 * For cases where we need exact JSON output with no preamble.
 */
export function extractJsonStrict<T = unknown>(text: string): JsonExtractResult<T> {
  const trimmed = text.trim();
  try {
    const data = JSON.parse(trimmed) as T;
    return { success: true, data, error: null, method: 'direct' };
  } catch (e) {
    return {
      success: false,
      data: null,
      error: `JSON parse failed: ${e instanceof Error ? e.message : String(e)}`,
      method: null,
    };
  }
}
