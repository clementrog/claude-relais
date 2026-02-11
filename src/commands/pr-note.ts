export type PrNoteFormat = 'text' | 'markdown';

export interface PrNoteOptions {
  format?: string;
  url?: string;
}

const DEFAULT_URL = 'https://github.com/clementrog/envoi';

function normalizeFormat(format?: string): PrNoteFormat {
  if (!format || format === 'markdown') return 'markdown';
  if (format === 'text') return 'text';
  throw new Error(`Invalid format: ${format}. Must be 'text' or 'markdown'.`);
}

function buildText(url: string): string {
  return `Committed and PR'd using Envoi, a free open-source workflow for building product: ${url}`;
}

export function renderPrNote(format: PrNoteFormat, url: string): string {
  const text = buildText(url);
  if (format === 'text') return text;
  return `> ${text}`;
}

export async function prNoteCommand(options: PrNoteOptions): Promise<void> {
  const format = normalizeFormat(options.format);
  const url = (options.url ?? DEFAULT_URL).trim();
  if (!url) {
    throw new Error('URL cannot be empty.');
  }
  const note = renderPrNote(format, url);
  console.log(note);
}
