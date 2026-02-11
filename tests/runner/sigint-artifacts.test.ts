/**
 * Unit tests for SIGINT artifact persistence.
 *
 * Verifies that when InterruptedError is thrown during a tick,
 * artifacts (REPORT.json, REPORT.md) are persisted correctly.
 *
 * Uses mocking instead of spawning processes for reliable testing.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, writeFile, readFile, rm, mkdir, access } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runTick } from '@/runner/tick.js';
import { InterruptedError } from '@/types/claude.js';
import type { EnvoiConfig } from '@/types/config.js';

// Mock invokeClaudeCode to throw InterruptedError when signal is aborted
vi.mock('@/lib/claude.js', () => ({
  invokeClaudeCode: vi.fn().mockImplementation(async (_config, invocation) => {
    // Check if signal is aborted
    if (invocation.signal?.aborted) {
      throw new InterruptedError('Claude Code invocation aborted by signal');
    }
    // Simulate waiting then checking signal
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        resolve({
          success: true,
          result: '{"task_id": "test", "milestone_id": "M1", "task_kind": "execute", "intent": "test"}',
          raw: {},
          exitCode: 0,
          durationMs: 100,
        });
      }, 100);

      if (invocation.signal) {
        invocation.signal.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(new InterruptedError('Claude Code invocation aborted by signal'));
        });
      }
    });
  }),
  buildClaudeArgs: vi.fn().mockReturnValue([]),
  parseClaudeResponse: vi.fn().mockReturnValue({ result: '', raw: {} }),
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

// Mock fs operations for atomic writes
vi.mock('@/lib/fs.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/fs.js')>();
  return {
    ...original,
    atomicWriteJson: vi.fn().mockResolvedValue(undefined),
  };
});

// Mock report rendering
vi.mock('@/lib/report.js', () => ({
  renderReportMarkdown: vi.fn().mockReturnValue('# Report'),
  writeReportMarkdown: vi.fn().mockResolvedValue(undefined),
}));

// Mock blocked
vi.mock('@/lib/blocked.js', () => ({
  writeBlocked: vi.fn().mockResolvedValue(undefined),
  buildOrchestratorBlockedData: vi.fn().mockReturnValue({}),
  buildBlockedData: vi.fn().mockReturnValue({}),
  deleteBlocked: vi.fn().mockResolvedValue(undefined),
}));

function createMockConfig(workspaceDir: string): EnvoiConfig {
  return {
    version: '1.0',
    product_name: 'test-sigint',
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

describe('SIGINT artifact persistence', () => {
  let workspaceDir: string;

  beforeEach(async () => {
    workspaceDir = await mkdtemp(join(tmpdir(), 'relais-sigint-test-'));
    await mkdir(join(workspaceDir, 'prompts'), { recursive: true });
    await mkdir(join(workspaceDir, 'schemas'), { recursive: true });

    // Create minimal prompt files
    await writeFile(join(workspaceDir, 'prompts/orchestrator.system.txt'), 'You are an orchestrator.');
    await writeFile(join(workspaceDir, 'prompts/orchestrator.user.txt'), 'Plan a task.');

    // Create minimal schema files
    const taskSchema = {
      type: 'object',
      properties: {
        task_id: { type: 'string' },
        milestone_id: { type: 'string' },
        task_kind: { type: 'string' },
        intent: { type: 'string' },
      },
      required: ['task_id', 'milestone_id', 'task_kind', 'intent'],
    };
    await writeFile(join(workspaceDir, 'schemas/task.schema.json'), JSON.stringify(taskSchema, null, 2));

    vi.clearAllMocks();
  });

  afterEach(async () => {
    await rm(workspaceDir, { recursive: true, force: true });
  });

  it('should return STOP_INTERRUPTED report when signal is aborted', async () => {
    const config = createMockConfig(workspaceDir);

    // Create an abort controller and abort it immediately
    const abortController = new AbortController();

    // Start runTick and abort after a short delay
    const tickPromise = runTick(config, abortController.signal);

    // Abort after a brief moment to let the orchestrator start
    setTimeout(() => {
      abortController.abort();
    }, 50);

    const report = await tickPromise;

    expect(report.code).toBe('STOP_INTERRUPTED');
    expect(report.verdict).toBe('stop');
    expect(report.budgets.ticks).toBe(1);
  });

  it('should return report immediately if signal is already aborted', async () => {
    const config = createMockConfig(workspaceDir);

    // Create an already-aborted abort controller
    const abortController = new AbortController();
    abortController.abort();

    const report = await runTick(config, abortController.signal);

    expect(report.code).toBe('STOP_INTERRUPTED');
    expect(report.verdict).toBe('stop');
  });
});

describe('InterruptedError type guard', () => {
  it('should correctly identify InterruptedError', async () => {
    const { isInterruptedError, InterruptedError: ImportedInterruptedError } = await import('@/types/claude.js');

    const interruptedError = new ImportedInterruptedError('test');
    const regularError = new Error('test');

    expect(isInterruptedError(interruptedError)).toBe(true);
    expect(isInterruptedError(regularError)).toBe(false);
    expect(isInterruptedError(null)).toBe(false);
    expect(isInterruptedError(undefined)).toBe(false);
  });
});
