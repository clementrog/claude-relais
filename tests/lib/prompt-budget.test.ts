import { describe, expect, it } from 'vitest';
import { truncatePromptSection } from '@/lib/prompt_budget.js';

describe('truncatePromptSection', () => {
  it('returns source when under limit', () => {
    const input = 'short text';
    const result = truncatePromptSection('TEST', input, 50);
    expect(result.truncated).toBe(false);
    expect(result.text).toBe(input);
    expect(result.originalChars).toBe(input.length);
  });

  it('keeps head and tail when over limit', () => {
    const input = `HEAD-${'a'.repeat(200)}-TAIL`;
    const result = truncatePromptSection('TEST', input, 80);
    expect(result.truncated).toBe(true);
    expect(result.text.length).toBeLessThanOrEqual(80);
    expect(result.text).toContain('[TRUNCATED TEST');
    expect(result.text).toContain('HEAD-');
    expect(result.text).toContain('-TAIL');
  });
});
