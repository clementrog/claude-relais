/**
 * Fixture test: Lock release on interrupt.
 *
 * Verifies that when SIGINT/abort is received during orchestration:
 * - releaseLock is called
 * - Lock file is gone after tick returns
 * - Lock is released even if persistence fails
 *
 * @see Signal-safe artifact persistence implementation
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runTick } from '@/runner/tick.js';
import type { RelaisConfig } from '@/types/config.js';
import { InterruptedError } from '@/types/claude.js';

// Track lock operations
let lockAcquired = false;
let lockReleased = false;

// Mock lock functions
vi.mock('@/lib/lock.js', () => ({
  acquireLock: vi.fn().mockImplementation(async () => {
    lockAcquired = true;
    return { pid: process.pid, acquired_at: new Date().toISOString() };
  }),
  releaseLock: vi.fn().mockImplementation(async () => {
    lockReleased = true;
  }),
  LockHeldError: class extends Error {},
}));

// Mock atomicWriteJson
vi.mock('@/lib/fs.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/fs.js')>();
  return {
    ...original,
    atomicWriteJson: vi.fn().mockResolvedValue(undefined),
  };
});

// Mock blocked.js
vi.mock('@/lib/blocked.js', () => ({
  writeBlocked: vi.fn().mockResolvedValue(undefined),
  buildOrchestratorBlockedData: vi.fn().mockReturnValue({ code: 'BLOCKED_TEST' }),
  buildBlockedData: vi.fn().mockReturnValue({ code: 'BLOCKED_TEST' }),
  deleteBlocked: vi.fn().mockResolvedValue(undefined),
}));

// Mock preflight
vi.mock('@/lib/preflight.js', () => ({
  runPreflight: vi.fn().mockResolvedValue({
    ok: true,
    blocked_code: null,
    blocked_reason: null,
    warnings: [],
    base_commit: 'abc123',
  }),
}));

// Mock git functions
vi.mock('@/lib/git.js', () => ({
  getHeadCommit: vi.fn().mockReturnValue('abc123'),
}));

// Mock workspace state
vi.mock('@/lib/workspace_state.js', () => ({
  readWorkspaceState: vi.fn().mockResolvedValue({
    milestone_id: 'M1',
    budgets: { ticks: 0, orchestrator_calls: 0, builder_calls: 0, verify_runs: 0 },
    budget_warning: false,
    last_run_id: null,
    last_verdict: null,
  }),
  writeWorkspaceState: vi.fn().mockResolvedValue(undefined),
  ensureMilestone: vi.fn().mockReturnValue({ state: {}, changed: false }),
}));

// Mock report
vi.mock('@/lib/report.js', () => ({
  renderReportMarkdown: vi.fn().mockReturnValue('# Report'),
  writeReportMarkdown: vi.fn().mockResolvedValue(undefined),
}));

// Variable to control orchestrator behavior
let orchestratorShouldThrowInterrupt = false;

// Mock orchestrator
vi.mock('@/runner/orchestrator.js', () => ({
  runOrchestrator: vi.fn().mockImplementation(async () => {
    if (orchestratorShouldThrowInterrupt) {
      throw new InterruptedError('Aborted by signal');
    }
    return {
      success: false,
      task: null,
      error: 'Orchestrator output invalid',
      rawResponse: 'invalid',
      attempts: 1,
      retryReason: null,
      diagnostics: { extractMethod: 'direct_parse' },
    };
  }),
}));

// Mock builder
vi.mock('@/runner/builder.js', () => ({
  runBuilder: vi.fn().mockResolvedValue({
    success: true,
    result: { summary: 'done', files_intended: [], commands_ran: [], notes: [] },
    rawResponse: '{}',
    durationMs: 100,
    builderOutputValid: true,
    validationErrors: [],
    turnsRequested: 1,
    turnsUsed: 1,
  }),
}));

// Mock judge functions
vi.mock('@/lib/judge.js', () => ({
  getTouchedFiles: vi.fn().mockReturnValue({ all: [], tracked: [], untracked: [] }),
  checkScopeViolations: vi.fn().mockReturnValue({ ok: true, violatingFiles: [] }),
  computeBlastRadius: vi.fn().mockReturnValue({ files_touched: 0, lines_added: 0, lines_deleted: 0, new_files: 0 }),
  checkDiffLimits: vi.fn().mockReturnValue({ ok: true }),
  checkHeadMoved: vi.fn().mockReturnValue({ ok: true }),
}));

// Mock rollback
vi.mock('@/lib/rollback.js', () => ({
  rollbackToCommit: vi.fn().mockReturnValue({ ok: true }),
}));

// Mock verify safety
vi.mock('@/lib/verify-safety.js', () => ({
  validateAllParams: vi.fn().mockReturnValue({ ok: true }),
}));

function createMockConfig(workspaceDir: string): RelaisConfig {
  return {
    version: '1.0',
    product_name: 'test-lock-release',
    workspace_dir: workspaceDir,
    runner: {
      require_git: false,
      max_tick_seconds: 60,
      lockfile: join(workspaceDir, 'lock.json'),
      runner_owned_globs: ['relais/**'],
      crash_cleanup: { delete_tmp_glob: 'relais/*.tmp', validate_runner_json_files: true },
      render_report_md: { enabled: true, max_chars: 5000 },
    },
    claude_code_cli: {
      command: 'echo',
      output_format: 'json',
      no_session_persistence: true,
    },
    models: {
      orchestrator_model: 'test',
      orchestrator_fallback_model: 'test',
      builder_model: 'test',
      builder_fallback_model: 'test',
    },
    orchestrator: {
      max_turns: 1,
      permission_mode: 'plan',
      allowed_tools: '',
      system_prompt_file: 'prompts/orchestrator.system.txt',
      user_prompt_file: 'prompts/orchestrator.user.txt',
      task_schema_file: 'schemas/task.schema.json',
      max_parse_retries_per_tick: 1,
      max_budget_usd: 1.0,
    },
    builder: {
      default_mode: 'claude_code',
      allow_patch_mode: false,
      claude_code: {
        max_turns: 1,
        permission_mode: 'bypassPermissions',
        allowed_tools: '',
        system_prompt_file: 'prompts/builder.system.txt',
        user_prompt_file: 'prompts/builder.user.txt',
        builder_result_schema_file: 'schemas/builder_result.schema.json',
        max_budget_usd: 1.0,
        strict_builder_json: false,
      },
      patch: {
        max_patch_attempts_per_milestone: 10,
      },
    },
    scope: {
      default_allowed_globs: ['**/*'],
      default_forbidden_globs: [],
      default_allow_new_files: true,
      default_allow_lockfile_changes: false,
      lockfiles: ['package-lock.json'],
    },
    diff_limits: {
      default_max_files_touched: 50,
      default_max_lines_changed: 1000,
    },
    verification: {
      execution_mode: 'argv_no_shell',
      max_param_len: 128,
      reject_whitespace_in_params: true,
      reject_dotdot: true,
      reject_metachars_regex: '[;|&$`]',
      timeout_fast_seconds: 30,
      timeout_slow_seconds: 120,
      templates: [],
    },
    budgets: {
      per_milestone: {
        max_ticks: 100,
        max_orchestrator_calls: 100,
        max_builder_calls: 100,
        max_verify_runs: 100,
        max_estimated_cost_usd: 100,
      },
      warn_at_fraction: 0.8,
    },
    history: {
      enabled: false,
      dir: 'history',
      max_mb: 100,
      include_diff_patch: false,
      include_verify_log: false,
    },
  } as RelaisConfig;
}

describe('F022: Lock release on interrupt', () => {
  let workspaceDir: string;

  beforeEach(async () => {
    workspaceDir = await mkdtemp(join(tmpdir(), 'relais-lock-release-test-'));
    await mkdir(join(workspaceDir, 'prompts'), { recursive: true });
    await mkdir(join(workspaceDir, 'schemas'), { recursive: true });

    // Create minimal prompt files
    await writeFile(join(workspaceDir, 'prompts/orchestrator.system.txt'), 'system');
    await writeFile(join(workspaceDir, 'prompts/orchestrator.user.txt'), 'user');

    // Create minimal schema
    await writeFile(join(workspaceDir, 'schemas/task.schema.json'), '{}');

    // Reset tracking state
    lockAcquired = false;
    lockReleased = false;
    orchestratorShouldThrowInterrupt = false;

    vi.clearAllMocks();
  });

  afterEach(async () => {
    await rm(workspaceDir, { recursive: true, force: true });
  });

  it('should release lock when interrupted during orchestrator', async () => {
    const config = createMockConfig(workspaceDir);

    // Make orchestrator throw InterruptedError
    orchestratorShouldThrowInterrupt = true;

    const report = await runTick(config);

    // Lock should have been acquired
    expect(lockAcquired).toBe(true);

    // Lock should have been released in catch block
    expect(lockReleased).toBe(true);

    // Report should be STOP_INTERRUPTED
    expect(report.verdict).toBe('stop');
    expect(report.code).toBe('STOP_INTERRUPTED');
  });

  it('should release lock even if persistence fails during interrupt', async () => {
    const config = createMockConfig(workspaceDir);

    // Make orchestrator throw InterruptedError
    orchestratorShouldThrowInterrupt = true;

    // Make atomicWriteJson throw (simulating persistence failure)
    const { atomicWriteJson } = await import('@/lib/fs.js');
    vi.mocked(atomicWriteJson).mockRejectedValueOnce(new Error('Simulated write failure'));

    // Should not throw - gracefully returns
    const report = await runTick(config);

    // Lock should still be released despite persistence failure
    expect(lockReleased).toBe(true);

    // Report returned (may be partial due to persistence failure)
    expect(report).toBeDefined();
  });

  it('should return STOP_INTERRUPTED report on interrupt', async () => {
    const config = createMockConfig(workspaceDir);
    orchestratorShouldThrowInterrupt = true;

    const report = await runTick(config);

    // Report should have expected structure
    expect(report.run_id).toBeDefined();
    expect(report.started_at).toBeDefined();
    expect(report.ended_at).toBeDefined();
    expect(report.verdict).toBe('stop');
    expect(report.code).toBe('STOP_INTERRUPTED');
    expect(report.budgets.ticks).toBe(1);
  });

  it('should not throw on interrupt (graceful return)', async () => {
    const config = createMockConfig(workspaceDir);
    orchestratorShouldThrowInterrupt = true;

    // Should not throw - returns gracefully
    await expect(runTick(config)).resolves.toBeDefined();
  });
});
