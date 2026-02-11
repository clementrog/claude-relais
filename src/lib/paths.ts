/**
 * Path helpers for workspace-relative files.
 *
 * Config paths may be expressed either:
 * - relative to `workspace_dir` (e.g. "prompts/orchestrator.user.txt"), OR
 * - already prefixed with `workspace_dir` (e.g. "envoi/prompts/orchestrator.user.txt")
 *
 * We support both forms for backwards compatibility.
 */

import { isAbsolute, join } from 'node:path';

/**
 * Resolves a config path into a filesystem path.
 *
 * If `p` is absolute, returns it as-is.
 * If `p` already starts with `${workspaceDir}/`, returns it as-is.
 * Otherwise returns `join(workspaceDir, p)`.
 */
export function resolveInWorkspace(workspaceDir: string, p: string): string {
  if (isAbsolute(p)) return p;
  const normalized = p.replace(/^[.][/]/, '');
  if (normalized === workspaceDir || normalized.startsWith(`${workspaceDir}/`)) {
    return normalized;
  }
  return join(workspaceDir, normalized);
}
