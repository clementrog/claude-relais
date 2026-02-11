/**
 * Prompt budgeting helpers to keep context payloads bounded and deterministic.
 */

export interface TruncatePromptSectionResult {
  text: string;
  truncated: boolean;
  originalChars: number;
}

/**
 * Truncates a prompt section to a max size with a deterministic marker.
 *
 * Strategy:
 * - keep the beginning (usually most structural context)
 * - keep the tail (usually latest status/error detail)
 * - insert a deterministic marker between both
 */
export function truncatePromptSection(
  sectionName: string,
  value: string,
  maxChars: number
): TruncatePromptSectionResult {
  const effectiveMax = Math.max(0, maxChars);
  if (value.length <= effectiveMax) {
    return { text: value, truncated: false, originalChars: value.length };
  }

  const marker = `\n\n[TRUNCATED ${sectionName}: kept head+tail within ${effectiveMax} of ${value.length} chars]\n\n`;
  const keep = Math.max(0, effectiveMax - marker.length);
  if (keep === 0) {
    return {
      text: marker.slice(0, effectiveMax),
      truncated: true,
      originalChars: value.length,
    };
  }

  const headKeep = Math.max(1, Math.floor(keep * 0.7));
  const tailKeep = Math.max(0, keep - headKeep);
  const head = value.slice(0, headKeep);
  const tail = tailKeep > 0 ? value.slice(value.length - tailKeep) : '';

  return {
    text: head + marker + tail,
    truncated: true,
    originalChars: value.length,
  };
}
