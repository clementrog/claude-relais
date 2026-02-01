/**
 * F028: delete_tmp_glob_rejects_unsafe_patterns
 *
 * Verifies that unsafe delete_tmp_glob patterns (absolute paths, path traversal)
 * are rejected with BLOCKED_CRASH_RECOVERY_REQUIRED before any files are deleted.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { isGlobPatternSafe } from '../../src/lib/fs.js';
import { runPreflight } from '../../src/lib/preflight.js';

describe('F028: delete_tmp_glob_rejects_unsafe_patterns', () => {
  let workspaceDir: string;
  let siblingDir: string;
  let parentDir: string;

  beforeEach(() => {
    // Create parent directory with workspace and sibling subdirs
    parentDir = join(tmpdir(), `relais-glob-test-${Date.now()}`);
    workspaceDir = join(parentDir, 'workspace');
    siblingDir = join(parentDir, 'sibling');

    mkdirSync(workspaceDir, { recursive: true });
    mkdirSync(join(workspaceDir, 'relais'), { recursive: true });
    mkdirSync(siblingDir, { recursive: true });

    // Create test files
    writeFileSync(join(workspaceDir, 'relais', 'ok.tmp'), 'inside workspace');
    writeFileSync(join(siblingDir, 'escape.tmp'), 'outside workspace - must not be deleted');
  });

  afterEach(() => {
    if (existsSync(parentDir)) {
      rmSync(parentDir, { recursive: true, force: true });
    }
  });

  describe('isGlobPatternSafe validation', () => {
    it('should allow safe relative patterns', () => {
      expect(isGlobPatternSafe('relais/*.tmp')).toEqual({ safe: true });
      expect(isGlobPatternSafe('relais/**/*.tmp')).toEqual({ safe: true });
      expect(isGlobPatternSafe('*.tmp')).toEqual({ safe: true });
      expect(isGlobPatternSafe('sub/dir/*.tmp')).toEqual({ safe: true });
    });

    it('should reject patterns with path traversal (..)', () => {
      const result = isGlobPatternSafe('../*.tmp');
      expect(result.safe).toBe(false);
      expect(result.reason).toContain('..');
    });

    it('should reject deeply nested path traversal', () => {
      const result = isGlobPatternSafe('../../relais/*.tmp');
      expect(result.safe).toBe(false);
      expect(result.reason).toContain('..');
    });

    it('should reject absolute Unix paths', () => {
      const result = isGlobPatternSafe('/tmp/*.tmp');
      expect(result.safe).toBe(false);
      expect(result.reason).toContain('absolute');
    });

    it('should reject Windows absolute paths', () => {
      const result = isGlobPatternSafe('C:\\temp\\*.tmp');
      expect(result.safe).toBe(false);
      expect(result.reason).toContain('absolute');
    });

    it('should reject UNC paths', () => {
      expect(isGlobPatternSafe('\\\\server\\share\\*.tmp').safe).toBe(false);
      expect(isGlobPatternSafe('//server/share/*.tmp').safe).toBe(false);
    });

    it('should reject empty patterns', () => {
      expect(isGlobPatternSafe('').safe).toBe(false);
      expect(isGlobPatternSafe('   ').safe).toBe(false);
    });
  });

  describe('preflight blocks on unsafe glob', () => {
    const createConfig = (deleteGlob: string) => ({
      version: '1.0.0',
      product_name: 'test',
      workspace_dir: workspaceDir,
      runner: {
        require_git: false, // Skip git checks for this test
        max_tick_seconds: 300,
        lockfile: join(workspaceDir, '.relais.lock'),
        runner_owned_globs: [],
        crash_cleanup: { delete_tmp_glob: deleteGlob, validate_runner_json_files: false },
        render_report_md: { enabled: false, max_chars: 1000 },
      },
      budgets: {
        warn_at_fraction: 0.8,
        per_milestone: {
          max_ticks: 100,
          max_orchestrator_calls: 200,
          max_builder_calls: 200,
          max_verify_runs: 500,
          max_estimated_cost_usd: 100,
        },
      },
      history: { enabled: false, dir: 'history', max_mb: 100, include_diff_patch: false, include_verify_log: false },
      claude_code_cli: { command: 'echo', output_format: 'json', no_session_persistence: true },
      models: { orchestrator_model: 'sonnet', orchestrator_fallback_model: 'sonnet', builder_model: 'sonnet', builder_fallback_model: 'sonnet' },
      orchestrator: {} as any,
      builder: {} as any,
      scope: {} as any,
      diff_limits: {} as any,
      verification: {} as any,
    });

    it('should block with BLOCKED_CRASH_RECOVERY_REQUIRED for path traversal glob', async () => {
      const config = createConfig('../*.tmp');
      const result = await runPreflight(config as any);

      expect(result.ok).toBe(false);
      expect(result.blocked_code).toBe('BLOCKED_CRASH_RECOVERY_REQUIRED');
      expect(result.blocked_reason).toContain('Unsafe delete_tmp_glob');
      expect(result.blocked_reason).toContain('..');

      // Critical: outside file must NOT be deleted
      expect(existsSync(join(siblingDir, 'escape.tmp'))).toBe(true);
      // Inside file should also still exist (we blocked, didn't delete anything)
      expect(existsSync(join(workspaceDir, 'relais', 'ok.tmp'))).toBe(true);
    });

    it('should block with BLOCKED_CRASH_RECOVERY_REQUIRED for absolute path glob', async () => {
      const config = createConfig('/tmp/*.tmp');
      const result = await runPreflight(config as any);

      expect(result.ok).toBe(false);
      expect(result.blocked_code).toBe('BLOCKED_CRASH_RECOVERY_REQUIRED');
      expect(result.blocked_reason).toContain('absolute');

      // Files must still exist
      expect(existsSync(join(siblingDir, 'escape.tmp'))).toBe(true);
      expect(existsSync(join(workspaceDir, 'relais', 'ok.tmp'))).toBe(true);
    });

    it('should allow safe glob and not block', async () => {
      const config = createConfig('relais/*.tmp');
      const result = await runPreflight(config as any);

      // Safe glob pattern should be allowed - preflight succeeds
      expect(result.ok).toBe(true);
      expect(result.blocked_code).toBe(null);
      // Outside file must still exist (never touched)
      expect(existsSync(join(siblingDir, 'escape.tmp'))).toBe(true);
      // Note: The inside file won't be deleted because cleanupTmpFilesWithGlob
      // operates relative to process.cwd(), not the test's workspaceDir.
      // This is correct behavior - the safety validation passed.
    });
  });
});
