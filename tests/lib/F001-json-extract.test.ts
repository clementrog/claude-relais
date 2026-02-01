/**
 * F001/F002: JSON extraction utility tests.
 *
 * Verifies that extractJson handles preamble, fences, and brace search
 * for robust LLM output parsing.
 */

import { describe, it, expect } from 'vitest';
import { extractJson, extractJsonStrict } from '../../src/lib/json-extract.js';

describe('F001/F002: JSON extraction', () => {
  describe('direct parse', () => {
    it('should parse clean JSON directly', () => {
      const result = extractJson('{"key": "value"}');
      expect(result.success).toBe(true);
      expect(result.data).toEqual({ key: 'value' });
      expect(result.method).toBe('direct');
    });

    it('should parse JSON with leading/trailing whitespace', () => {
      const result = extractJson('  \n{"key": "value"}\n  ');
      expect(result.success).toBe(true);
      expect(result.data).toEqual({ key: 'value' });
      expect(result.method).toBe('direct');
    });

    it('should parse JSON arrays', () => {
      const result = extractJson('[1, 2, 3]');
      expect(result.success).toBe(true);
      expect(result.data).toEqual([1, 2, 3]);
      expect(result.method).toBe('direct');
    });
  });

  describe('fence extraction', () => {
    it('should extract JSON from ```json fence', () => {
      const input = `Here is the task:

\`\`\`json
{"task_id": "T001", "intent": "Fix bug"}
\`\`\`

Let me know if you need anything else.`;

      const result = extractJson(input);
      expect(result.success).toBe(true);
      expect(result.data).toEqual({ task_id: 'T001', intent: 'Fix bug' });
      expect(result.method).toBe('fence');
    });

    it('should extract JSON from ``` fence without language', () => {
      const input = `Response:

\`\`\`
{"key": "value"}
\`\`\``;

      const result = extractJson(input);
      expect(result.success).toBe(true);
      expect(result.data).toEqual({ key: 'value' });
      expect(result.method).toBe('fence');
    });

    it('should handle multiple fences and take first valid', () => {
      const input = `\`\`\`
not json
\`\`\`

\`\`\`json
{"valid": true}
\`\`\``;

      const result = extractJson(input);
      expect(result.success).toBe(true);
      expect(result.data).toEqual({ valid: true });
    });
  });

  describe('brace search', () => {
    it('should find JSON object with preamble text', () => {
      const input = 'Sure! Here is the JSON: {"key": "value"} Hope that helps!';
      const result = extractJson(input);
      expect(result.success).toBe(true);
      expect(result.data).toEqual({ key: 'value' });
      expect(result.method).toBe('search');
    });

    it('should find JSON array with preamble', () => {
      const input = 'The array is: [1, 2, 3] as requested.';
      const result = extractJson(input);
      expect(result.success).toBe(true);
      expect(result.data).toEqual([1, 2, 3]);
      expect(result.method).toBe('search');
    });

    it('should handle nested braces correctly', () => {
      const input = 'Result: {"outer": {"inner": "value"}}';
      const result = extractJson(input);
      expect(result.success).toBe(true);
      expect(result.data).toEqual({ outer: { inner: 'value' } });
    });

    it('should handle strings with braces inside', () => {
      const input = 'JSON: {"code": "function() { return {}; }"}';
      const result = extractJson(input);
      expect(result.success).toBe(true);
      expect(result.data).toEqual({ code: 'function() { return {}; }' });
    });

    it('should handle escaped quotes in strings', () => {
      const input = 'Data: {"message": "He said \\"hello\\""}';
      const result = extractJson(input);
      expect(result.success).toBe(true);
      expect(result.data).toEqual({ message: 'He said "hello"' });
    });
  });

  describe('failure cases', () => {
    it('should fail on text with no JSON', () => {
      const result = extractJson('This is just plain text with no JSON at all.');
      expect(result.success).toBe(false);
      expect(result.data).toBeNull();
      expect(result.error).toContain('Failed to extract JSON');
    });

    it('should fail on unbalanced braces', () => {
      const result = extractJson('Broken: {"key": "value"');
      expect(result.success).toBe(false);
      // May fail at different stages depending on which strategy tried
      expect(result.error).toBeTruthy();
    });

    it('should fail on invalid JSON in braces', () => {
      const result = extractJson('Bad: {key: value}');
      expect(result.success).toBe(false);
      // Will find the braces but JSON.parse will fail
    });
  });

  describe('strict extraction', () => {
    it('should only accept direct parse', () => {
      const result = extractJsonStrict('{"key": "value"}');
      expect(result.success).toBe(true);
      expect(result.method).toBe('direct');
    });

    it('should fail with preamble in strict mode', () => {
      const result = extractJsonStrict('Here: {"key": "value"}');
      expect(result.success).toBe(false);
    });
  });

  describe('real-world LLM outputs', () => {
    it('should handle Claude-style response with explanation', () => {
      const input = `I'll create a task for implementing the feature.

\`\`\`json
{
  "task_id": "TASK-001",
  "milestone_id": "M1",
  "task_kind": "execute",
  "intent": "Add user authentication",
  "scope": {
    "allowed_globs": ["src/**/*.ts"],
    "forbidden_globs": [],
    "allow_new_files": true,
    "allow_lockfile_changes": false
  },
  "diff_limits": {
    "max_files_touched": 10,
    "max_lines_changed": 200
  },
  "verification": {
    "fast": ["lint"],
    "slow": ["test"]
  },
  "builder": {
    "mode": "claude_code",
    "max_turns": 20,
    "instructions": "Implement JWT authentication"
  }
}
\`\`\`

This task will add authentication to the API.`;

      const result = extractJson(input);
      expect(result.success).toBe(true);
      expect(result.data).toHaveProperty('task_id', 'TASK-001');
      expect(result.data).toHaveProperty('task_kind', 'execute');
    });

    it('should handle builder result with notes', () => {
      const input = `I've completed the task. Here's the result:

{
  "summary": "Added login endpoint",
  "files_intended": ["src/api/auth.ts", "src/types/user.ts"],
  "commands_ran": ["npm run lint", "npm test"],
  "notes": ["Created JWT utility", "Added password hashing"]
}

The implementation is complete.`;

      const result = extractJson(input);
      expect(result.success).toBe(true);
      expect(result.data).toHaveProperty('summary', 'Added login endpoint');
    });
  });
});
