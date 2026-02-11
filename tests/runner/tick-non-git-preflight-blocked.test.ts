/**
 * Regression: runTick must not touch git before preflight.
 *
 * When invoked outside a git repo, preflight should BLOCK cleanly and the tick
 * should persist artifacts + return a blocked report (not throw).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runTick } from '@/runner/tick.js';
import { createMockConfig } from '../helpers/mocks.js';
import type { BlockedData } from '@/types/blocked.js';

const written: Map<string, unknown> = new Map();

vi.mock('@/lib/lock.js', () => ({
  acquireLock: vi.fn(),
  releaseLock: vi.fn(),
  LockHeldError: class extends Error {},
}));

// If runTick calls getHeadCommit before preflight, this test should fail.
vi.mock('@/lib/git.js', () => ({
  getHeadCommit: vi.fn(() => {
    throw new Error('git should not be called before preflight');
  }),
}));

vi.mock('@/lib/preflight.js', () => ({
  runPreflight: vi.fn(),
}));

vi.mock('@/runner/orchestrator.js', () => ({
  runOrchestrator: vi.fn(),
}));

vi.mock('@/runner/builder.js', () => ({
  runBuilder: vi.fn(),
}));

vi.mock('@/lib/fs.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/fs.js')>();
  return {
    ...actual,
    atomicWriteJson: vi.fn(async (path: string, data: unknown) => {
      written.set(path, data);
    }),
  };
});

vi.mock('@/lib/report.js', () => ({
  renderReportMarkdown: vi.fn(() => '# report'),
  writeReportMarkdown: vi.fn(async (content: string, path: string) => {
    written.set(path, content);
  }),
}));

vi.mock('@/lib/blocked.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/blocked.js')>();
  return {
    ...actual,
    writeBlocked: vi.fn(async (data: BlockedData, path: string) => {
      written.set(path, data);
    }),
    deleteBlocked: vi.fn(),
  };
});

vi.mock('@/lib/workspace_state.js', () => ({
  readWorkspaceState: vi.fn(),
  writeWorkspaceState: vi.fn(),
  ensureMilestone: vi.fn(),
}));

describe('tick: preflight blocked outside git repo', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    written.clear();

    const { acquireLock, releaseLock } = await import('@/lib/lock.js');
    const { runPreflight } = await import('@/lib/preflight.js');
    const { readWorkspaceState } = await import('@/lib/workspace_state.js');

    vi.mocked(acquireLock).mockResolvedValue({ pid: 123 });
    vi.mocked(releaseLock).mockResolvedValue(undefined);

    vi.mocked(runPreflight).mockResolvedValue({
      ok: false,
      blocked_code: 'BLOCKED_MISSING_CONFIG',
      blocked_reason: 'Not inside a git repository (require_git is enabled)',
      warnings: [],
      base_commit: null,
    });

    vi.mocked(readWorkspaceState).mockResolvedValue({
      milestone_id: null,
      branch: null,
      budgets: { ticks: 0, orchestrator_calls: 0, builder_calls: 0, verify_runs: 0 },
      budget_warning: false,
    });
  });

  it('returns a blocked report and persists REPORT.json/BLOCKED.json', async () => {
    const config = createMockConfig();
    const report = await runTick(config);

    expect(report.verdict).toBe('blocked');
    expect(report.code).toBe('BLOCKED_MISSING_CONFIG');

    expect(written.has('relais/REPORT.json')).toBe(true);
    expect(written.has('relais/BLOCKED.json')).toBe(true);
  });
});

