/**
 * Fixture test: Persistence never blocks on REPORT.md failure.
 *
 * Verifies that if writeReportMarkdown() throws, persistence still completes:
 * - REPORT.json is written
 * - Tick returns correct verdict/code
 * - BLOCKED.json is written/deleted correctly based on verdict
 *
 * @see Signal-safe artifact persistence implementation
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile, readFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runTick } from '@/runner/tick.js';
import type { EnvoiConfig } from '@/types/config.js';
import type { Task } from '@/types/task.js';

// Mock writeReportMarkdown to throw
vi.mock('@/lib/report.js', () => ({
  renderReportMarkdown: vi.fn().mockReturnValue('# Report'),
  writeReportMarkdown: vi.fn().mockRejectedValue(new Error('Simulated REPORT.md write failure')),
}));

// Mock atomicWriteJson to actually write (we want to verify it works)
const writtenFiles: Map<string, unknown> = new Map();
vi.mock('@/lib/fs.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/fs.js')>();
  return {
    ...original,
    atomicWriteJson: vi.fn().mockImplementation(async (path: string, data: unknown) => {
      writtenFiles.set(path, data);
    }),
  };
});

// Mock blocked.js to track calls
let blockedWritten = false;
let blockedDeleted = false;
vi.mock('@/lib/blocked.js', () => ({
  writeBlocked: vi.fn().mockImplementation(async () => {
    blockedWritten = true;
  }),
  buildOrchestratorBlockedData: vi.fn().mockReturnValue({ code: 'BLOCKED_TEST' }),
  buildBlockedData: vi.fn().mockReturnValue({ code: 'BLOCKED_TEST' }),
  deleteBlocked: vi.fn().mockImplementation(async () => {
    blockedDeleted = true;
  }),
}));

// Mock lock functions
vi.mock('@/lib/lock.js', () => ({
  acquireLock: vi.fn().mockResolvedValue({ pid: process.pid, acquired_at: new Date().toISOString() }),
  releaseLock: vi.fn().mockResolvedValue(undefined),
  LockHeldError: class extends Error {},
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

// Variable to control orchestrator behavior
let orchestratorShouldSucceed = false;
let mockTask: Task | null = null;

// Mock orchestrator
vi.mock('@/runner/orchestrator.js', () => ({
  runOrchestrator: vi.fn().mockImplementation(async () => {
    if (orchestratorShouldSucceed && mockTask) {
      return {
        success: true,
        task: mockTask,
        error: null,
        rawResponse: '{}',
        attempts: 1,
        retryReason: null,
      };
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

// Mock builder for success case
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

function createMockConfig(workspaceDir: string): EnvoiConfig {
  return {
    version: '1.0',
    product_name: 'test-persistence',
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
  } as EnvoiConfig;
}

describe('F021: Persistence never blocks on REPORT.md failure', () => {
  let workspaceDir: string;

  beforeEach(async () => {
    workspaceDir = await mkdtemp(join(tmpdir(), 'relais-persist-test-'));
    await mkdir(join(workspaceDir, 'prompts'), { recursive: true });
    await mkdir(join(workspaceDir, 'schemas'), { recursive: true });

    // Create minimal prompt files
    await writeFile(join(workspaceDir, 'prompts/orchestrator.system.txt'), 'system');
    await writeFile(join(workspaceDir, 'prompts/orchestrator.user.txt'), 'user');

    // Create minimal schema
    await writeFile(join(workspaceDir, 'schemas/task.schema.json'), '{}');

    // Reset tracking state
    writtenFiles.clear();
    blockedWritten = false;
    blockedDeleted = false;
    orchestratorShouldSucceed = false;
    mockTask = null;

    vi.clearAllMocks();
  });

  afterEach(async () => {
    await rm(workspaceDir, { recursive: true, force: true });
  });

  it('should write REPORT.json even when REPORT.md write fails (blocked verdict)', async () => {
    const config = createMockConfig(workspaceDir);

    // Orchestrator returns invalid output -> blocked
    orchestratorShouldSucceed = false;

    const report = await runTick(config);

    // REPORT.json should be written
    const reportPath = join(workspaceDir, 'REPORT.json');
    expect(writtenFiles.has(reportPath)).toBe(true);

    // Verdict should be blocked
    expect(report.verdict).toBe('blocked');
    expect(report.code).toBe('BLOCKED_ORCHESTRATOR_OUTPUT_INVALID');

    // BLOCKED.json should be written (not deleted) for blocked verdict
    expect(blockedWritten).toBe(true);
    expect(blockedDeleted).toBe(false);
  });

  it('should write REPORT.json even when REPORT.md write fails (success verdict)', async () => {
    const config = createMockConfig(workspaceDir);

    // Make orchestrator succeed with a valid task
    orchestratorShouldSucceed = true;
    mockTask = {
      task_id: 'test-001',
      milestone_id: 'M1',
      task_kind: 'execute',
      intent: 'Test task',
      scope: {
        allowed_globs: ['**/*'],
        forbidden_globs: [],
        allow_new_files: true,
        allow_lockfile_changes: false,
      },
      diff_limits: {
        max_files_touched: 10,
        max_lines_changed: 100,
      },
      verification: {
        fast: [],
        slow: [],
        params: {},
      },
      builder: {
        mode: 'claude_code',
        max_turns: 1,
        instructions: 'test',
      },
    };

    const report = await runTick(config);

    // REPORT.json should be written
    const reportPath = join(workspaceDir, 'REPORT.json');
    expect(writtenFiles.has(reportPath)).toBe(true);

    // Verdict should be success
    expect(report.verdict).toBe('success');
    expect(report.code).toBe('SUCCESS');

    // BLOCKED.json should be deleted (not written) for success verdict
    expect(blockedWritten).toBe(false);
    expect(blockedDeleted).toBe(true);
  });

  it('should return correct report even when REPORT.md write fails', async () => {
    const config = createMockConfig(workspaceDir);
    orchestratorShouldSucceed = false;

    const report = await runTick(config);

    // Report should have all expected fields
    expect(report.run_id).toBeDefined();
    expect(report.started_at).toBeDefined();
    expect(report.ended_at).toBeDefined();
    expect(report.duration_ms).toBeGreaterThanOrEqual(0);
    expect(report.budgets.ticks).toBe(1);
  });

  it('should not throw when REPORT.md write fails', async () => {
    const config = createMockConfig(workspaceDir);
    orchestratorShouldSucceed = false;

    // Should not throw
    await expect(runTick(config)).resolves.toBeDefined();
  });
});
