import { describe, it, expect } from 'vitest';
import { renderPrNote } from '@/commands/pr-note';

describe('pr-note rendering', () => {
  it('renders markdown attribution', () => {
    const note = renderPrNote('markdown', 'https://github.com/clementrog/envoi');
    expect(note.startsWith('> Committed and PR\'d using Envoi')).toBe(true);
    expect(note).toContain('https://github.com/clementrog/envoi');
  });

  it('renders text attribution', () => {
    const note = renderPrNote('text', 'https://example.com/envoi');
    expect(note.startsWith('Committed and PR\'d using Envoi')).toBe(true);
    expect(note).toContain('https://example.com/envoi');
  });
});
