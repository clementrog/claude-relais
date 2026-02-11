import { basename } from 'node:path';

import type { EnvoiConfig } from '../types/config.js';

export type CommandDecision = 'allow' | 'prompt' | 'deny';
export type CommandClass = 'read_only' | 'workspace_write' | 'network' | 'destructive' | 'unknown';

export interface CommandPolicy {
  profile: 'strict' | 'balanced' | 'fast';
  allowPrefixes: string[];
  denyPrefixes: string[];
  allowNetworkPrefixes: string[];
  allowWorkspaceWritePrefixes: string[];
  requireExplicitForDestructive: boolean;
}

export interface CommandPolicyResult {
  decision: CommandDecision;
  classification: CommandClass;
  reason: string;
}

export const DEFAULT_READ_ONLY_PREFIXES = [
  'git status',
  'git log',
  'git diff',
  'git show',
  'git rev-parse',
  'git branch --show-current',
  'ls',
  'cat',
  'rg',
  'find',
  'wc',
  'head',
  'tail',
  'pwd',
  'date',
];

export const DEFAULT_NETWORK_PREFIXES = ['npm', 'pnpm', 'yarn', 'bun', 'gh'];

export const DEFAULT_WORKSPACE_WRITE_PREFIXES = [
  'pnpm test',
  'pnpm build',
  'pnpm typecheck',
  'npm test',
  'npm run build',
  'git add',
  'git commit',
  'git switch',
  'git checkout -b',
];

export const DEFAULT_DENY_PREFIXES = [
  'rm',
  'sudo rm',
  'git reset --hard',
  'git checkout --',
  'git clean -fd',
  'git clean -fdx',
  'mkfs',
  'dd',
];

function normalizePrefixList(list: string[] | undefined): string[] {
  if (!Array.isArray(list)) return [];
  const unique = new Set<string>();
  for (const entry of list) {
    if (typeof entry !== 'string') continue;
    const normalized = entry.trim().toLowerCase();
    if (normalized.length === 0) continue;
    unique.add(normalized);
  }
  return [...unique];
}

export function commandTokens(command: string, args: string[]): string[] {
  const normalizedCommand = basename(command).trim().toLowerCase();
  const normalizedArgs = args
    .map((arg) => arg.trim().toLowerCase())
    .filter((arg) => arg.length > 0);
  return [normalizedCommand, ...normalizedArgs];
}

function tokensMatchPrefix(tokens: string[], prefix: string): boolean {
  const parts = prefix
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter((part) => part.length > 0);
  if (parts.length === 0) return false;
  if (parts.length > tokens.length) return false;
  for (let index = 0; index < parts.length; index += 1) {
    if (tokens[index] !== parts[index]) return false;
  }
  return true;
}

function matchesAnyPrefix(tokens: string[], prefixes: string[]): boolean {
  for (const prefix of prefixes) {
    if (tokensMatchPrefix(tokens, prefix)) return true;
  }
  return false;
}

function extractGitSubcommand(tokens: string[]): { sub: string; third: string } {
  let index = 1;
  while (index < tokens.length) {
    const token = tokens[index];
    if (!token) break;
    if (token === '--') {
      index += 1;
      break;
    }
    if (!token.startsWith('-')) break;

    // Common git global flags that consume one following value.
    if (
      token === '-c' ||
      token === '--git-dir' ||
      token === '--work-tree' ||
      token === '--namespace' ||
      token === '--super-prefix' ||
      token === '--config-env'
    ) {
      index += 2;
      continue;
    }

    // Other global flags are standalone toggles.
    index += 1;
  }

  return {
    sub: tokens[index] ?? '',
    third: tokens[index + 1] ?? '',
  };
}

function classifyGitCommand(tokens: string[]): CommandClass {
  const { sub, third } = extractGitSubcommand(tokens);
  if (sub === 'status' || sub === 'log' || sub === 'diff' || sub === 'show' || sub === 'rev-parse') {
    return 'read_only';
  }
  if (sub === 'branch' && third === '--show-current') {
    return 'read_only';
  }
  if (sub === 'fetch' || sub === 'pull' || sub === 'clone' || sub === 'push' || sub === 'ls-remote') {
    return 'network';
  }
  if ((sub === 'reset' && third === '--hard') || (sub === 'checkout' && third === '--')) {
    return 'destructive';
  }
  if (sub === 'clean' && (third === '-fd' || third === '-fdx')) {
    return 'destructive';
  }
  return 'workspace_write';
}

export function classifyCommand(tokens: string[]): CommandClass {
  const cmd = tokens[0] ?? '';
  if (cmd === 'git') return classifyGitCommand(tokens);
  if (cmd === 'rm' || cmd === 'mkfs' || cmd === 'dd') return 'destructive';
  if (cmd === 'curl' || cmd === 'wget' || cmd === 'npm' || cmd === 'pnpm' || cmd === 'yarn' || cmd === 'bun' || cmd === 'gh') {
    return 'network';
  }
  if (
    cmd === 'ls' ||
    cmd === 'cat' ||
    cmd === 'rg' ||
    cmd === 'find' ||
    cmd === 'wc' ||
    cmd === 'head' ||
    cmd === 'tail' ||
    cmd === 'pwd' ||
    cmd === 'date'
  ) {
    return 'read_only';
  }
  return 'unknown';
}

export function resolveCommandPolicy(config: EnvoiConfig): CommandPolicy {
  const autonomy = config.runner.autonomy;
  const profile = autonomy?.profile ?? 'balanced';
  const legacyTrust = normalizePrefixList(autonomy?.command_trust);
  const explicitAllow = normalizePrefixList(autonomy?.allow_prefixes);
  const explicitDeny = normalizePrefixList(autonomy?.deny_prefixes);
  const explicitNetwork = normalizePrefixList(autonomy?.allow_network_prefixes);
  const explicitWorkspaceWrite = normalizePrefixList(autonomy?.allow_workspace_write_prefixes);

  const allowPrefixes = [...new Set([...DEFAULT_READ_ONLY_PREFIXES, ...legacyTrust, ...explicitAllow])];
  const denyPrefixes = [...new Set([...DEFAULT_DENY_PREFIXES, ...explicitDeny])];

  const allowNetworkPrefixes = explicitNetwork.length > 0
    ? explicitNetwork
    : (profile === 'fast' ? DEFAULT_NETWORK_PREFIXES : []);
  const allowWorkspaceWritePrefixes = explicitWorkspaceWrite.length > 0
    ? explicitWorkspaceWrite
    : (profile === 'fast' ? DEFAULT_WORKSPACE_WRITE_PREFIXES : []);

  return {
    profile,
    allowPrefixes,
    denyPrefixes,
    allowNetworkPrefixes,
    allowWorkspaceWritePrefixes,
    requireExplicitForDestructive: autonomy?.require_explicit_for_destructive ?? true,
  };
}

export function evaluateCommandPolicy(
  config: EnvoiConfig,
  command: string,
  args: string[],
  options: { explicitDestructiveApproval?: boolean } = {}
): CommandPolicyResult {
  const policy = resolveCommandPolicy(config);
  const tokens = commandTokens(command, args);
  const classification = classifyCommand(tokens);

  if (matchesAnyPrefix(tokens, policy.denyPrefixes) || classification === 'destructive') {
    if (policy.requireExplicitForDestructive && !options.explicitDestructiveApproval) {
      return {
        decision: 'deny',
        classification: 'destructive',
        reason: 'destructive command denied without explicit user intent',
      };
    }
    return {
      decision: 'prompt',
      classification: 'destructive',
      reason: 'destructive command requires explicit approval',
    };
  }

  if (classification === 'read_only' || matchesAnyPrefix(tokens, policy.allowPrefixes)) {
    return {
      decision: 'allow',
      classification: classification === 'unknown' ? 'read_only' : classification,
      reason: 'trusted read-only or allowlisted command',
    };
  }

  if (classification === 'network') {
    if (matchesAnyPrefix(tokens, policy.allowNetworkPrefixes)) {
      return {
        decision: 'allow',
        classification,
        reason: 'trusted network command prefix',
      };
    }
    return {
      decision: policy.profile === 'fast' ? 'prompt' : 'prompt',
      classification,
      reason: 'network command outside trusted prefixes',
    };
  }

  if (classification === 'workspace_write') {
    if (matchesAnyPrefix(tokens, policy.allowWorkspaceWritePrefixes)) {
      return {
        decision: 'allow',
        classification,
        reason: 'trusted workspace-write command prefix',
      };
    }
    return {
      decision: 'prompt',
      classification,
      reason: 'workspace-write command outside trusted prefixes',
    };
  }

  return {
    decision: policy.profile === 'fast' ? 'prompt' : 'prompt',
    classification,
    reason: 'unknown command family',
  };
}

export function formatPolicyForPrompt(config: EnvoiConfig): string {
  const policy = resolveCommandPolicy(config);
  const allowReadOnly = policy.allowPrefixes.slice(0, 14).join(', ') || '(none)';
  const allowNetwork = policy.allowNetworkPrefixes.join(', ') || '(none)';
  const allowWorkspace = policy.allowWorkspaceWritePrefixes.join(', ') || '(none)';
  const deny = policy.denyPrefixes.join(', ') || '(none)';
  return [
    `Autonomy profile: ${policy.profile}`,
    `Auto-allow read-only/trusted: ${allowReadOnly}`,
    `Auto-allow network prefixes: ${allowNetwork}`,
    `Auto-allow workspace-write prefixes: ${allowWorkspace}`,
    `Hard deny prefixes: ${deny}`,
    'Never execute destructive commands without explicit user intent in this task.',
  ].join('\n');
}
