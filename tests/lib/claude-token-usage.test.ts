import { describe, it, expect } from 'vitest';
import { parseClaudeResponse } from '@/lib/claude';

describe('parseClaudeResponse token usage', () => {
  it('extracts usage from top-level usage object', () => {
    const response = parseClaudeResponse(
      JSON.stringify({
        result: '{"ok":true}',
        usage: {
          input_tokens: 120,
          output_tokens: 30,
          total_tokens: 150,
        },
      })
    );

    expect(response.tokenUsage).toEqual({
      input_tokens: 120,
      output_tokens: 30,
      total_tokens: 150,
      cache_creation_input_tokens: null,
      cache_read_input_tokens: null,
    });
  });

  it('extracts nested usage and computes total when missing', () => {
    const response = parseClaudeResponse(
      JSON.stringify({
        result: '{"ok":true}',
        message: {
          usage: {
            input_tokens: 80,
            output_tokens: 20,
          },
        },
      })
    );

    expect(response.tokenUsage).toEqual({
      input_tokens: 80,
      output_tokens: 20,
      total_tokens: 100,
      cache_creation_input_tokens: null,
      cache_read_input_tokens: null,
    });
  });

  it('returns null token usage when no usage fields exist', () => {
    const response = parseClaudeResponse(
      JSON.stringify({
        result: '{"ok":true}',
      })
    );
    expect(response.tokenUsage).toBeNull();
  });
});
