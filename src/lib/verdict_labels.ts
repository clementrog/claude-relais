import type { Verdict } from '../types/report.js';

export type DisplayState =
  | 'CLEARED'
  | 'STANDBY'
  | 'BLOCKED'
  | 'OUT_OF_BOUNDS'
  | 'LIMIT_HIT'
  | 'ROLLED_BACK';

function isOutOfBounds(code: string): boolean {
  return (
    code.startsWith('STOP_SCOPE_VIOLATION') ||
    code === 'STOP_RUNNER_OWNED_MUTATION' ||
    code === 'STOP_LOCKFILE_CHANGE_FORBIDDEN'
  );
}

function isLimitHit(code: string): boolean {
  return code === 'STOP_DIFF_TOO_LARGE' || code.startsWith('BLOCKED_BUDGET_');
}

export function toDisplayState(verdict: Verdict, code: string): DisplayState {
  if (code === 'SUCCESS' || verdict === 'success') return 'CLEARED';
  if (isOutOfBounds(code)) return 'OUT_OF_BOUNDS';
  if (isLimitHit(code)) return 'LIMIT_HIT';
  if (code === 'STOP_INTERRUPTED' || verdict === 'stop') return 'STANDBY';
  if (code.startsWith('BLOCKED_') || verdict === 'blocked') return 'BLOCKED';
  return 'STANDBY';
}

export function formatDisplayState(verdict: Verdict, code: string): string {
  return `${toDisplayState(verdict, code)} (${code})`;
}
