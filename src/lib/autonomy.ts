import type { EnvoiConfig } from '../types/config.js';

type PermissionMode = 'plan' | 'bypassPermissions';

function normalizeProfile(config: EnvoiConfig): 'strict' | 'balanced' | 'fast' {
  return config.runner.autonomy?.profile ?? 'balanced';
}

function hasTrustedPrefixes(config: EnvoiConfig): boolean {
  const autonomy = config.runner.autonomy;
  if (!autonomy) return false;
  const counts = [
    autonomy.command_trust?.length ?? 0,
    autonomy.allow_prefixes?.length ?? 0,
    autonomy.allow_network_prefixes?.length ?? 0,
    autonomy.allow_workspace_write_prefixes?.length ?? 0,
  ];
  return counts.some((count) => count > 0);
}

/**
 * Resolves orchestrator permission mode from autonomy profile and config.
 */
export function resolveOrchestratorPermissionMode(config: EnvoiConfig): PermissionMode {
  const profile = normalizeProfile(config);
  if (profile === 'fast') return 'bypassPermissions';
  if (profile === 'strict') return 'plan';
  if (hasTrustedPrefixes(config)) return 'bypassPermissions';
  return config.orchestrator.permission_mode as PermissionMode;
}

/**
 * Resolves builder permission mode from autonomy profile and config.
 */
export function resolveBuilderPermissionMode(config: EnvoiConfig): PermissionMode {
  const profile = normalizeProfile(config);
  if (profile === 'strict') return 'plan';
  if (profile === 'fast') return 'bypassPermissions';
  if (hasTrustedPrefixes(config)) return 'bypassPermissions';
  return config.builder.claude_code.permission_mode as PermissionMode;
}

/**
 * Human-readable profile summary for CLI output.
 */
export function describeAutonomyProfile(profile: 'strict' | 'balanced' | 'fast'): string {
  if (profile === 'strict') {
    return 'Strict: explicit approvals for most tool actions.';
  }
  if (profile === 'fast') {
    return 'Fast: fewer prompts, higher autonomy within configured safeguards.';
  }
  return 'Balanced: reduced prompt friction while keeping risky actions gated.';
}
