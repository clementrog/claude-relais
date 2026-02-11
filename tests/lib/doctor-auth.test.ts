import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { checkCodexCli, checkClaudeCodeCli } from '@/lib/doctor.js';

vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
}));

type FakeSpec = { code: number; stdout?: string; stderr?: string };

function makeChild(spec: FakeSpec) {
  const child = new EventEmitter() as any;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn();
  process.nextTick(() => {
    if (spec.stdout) child.stdout.emit('data', Buffer.from(spec.stdout));
    if (spec.stderr) child.stderr.emit('data', Buffer.from(spec.stderr));
    child.emit('exit', spec.code);
  });
  return child;
}

describe('doctor auth checks', () => {
  const oldEnv = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...oldEnv };
    delete process.env.CODEX_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
  });

  afterEach(() => {
    process.env = { ...oldEnv };
  });

  it('detects codex authenticated via whoami', async () => {
    vi.mocked(spawn).mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === '--version') return makeChild({ code: 0, stdout: 'codex 0.98.0\n' });
      if (args[0] === 'whoami') return makeChild({ code: 0, stdout: 'getrift\n' });
      return makeChild({ code: 1 });
    });

    const result = await checkCodexCli();
    expect(result.cli_available).toBe(true);
    expect(result.auth_status).toBe('authenticated');
  });

  it('detects codex unauthenticated when whoami reports login error', async () => {
    vi.mocked(spawn).mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === '--version') return makeChild({ code: 0, stdout: 'codex 0.98.0\n' });
      if (args[0] === 'whoami') return makeChild({ code: 1, stderr: 'Not logged in\n' });
      return makeChild({ code: 1 });
    });

    const result = await checkCodexCli();
    expect(result.cli_available).toBe(true);
    expect(result.auth_status).toBe('unauthenticated');
  });

  it('detects claude API key auth from environment', async () => {
    process.env.ANTHROPIC_API_KEY = 'test-key';
    vi.mocked(spawn).mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === '--version') return makeChild({ code: 0, stdout: 'claude 1.2.3\n' });
      return makeChild({ code: 1 });
    });

    const result = await checkClaudeCodeCli('claude');
    expect(result.cli_available).toBe(true);
    expect(result.auth_status).toBe('api_key_present');
  });

  it('detects claude unauthenticated when probes fail with login hint', async () => {
    vi.mocked(spawn).mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === '--version') return makeChild({ code: 0, stdout: 'claude 1.2.3\n' });
      if (args[0] === 'whoami') return makeChild({ code: 1, stderr: 'Please login first\n' });
      if (args[0] === 'auth' && args[1] === 'status') return makeChild({ code: 1, stderr: 'Unauthenticated\n' });
      return makeChild({ code: 1 });
    });

    const result = await checkClaudeCodeCli('claude');
    expect(result.cli_available).toBe(true);
    expect(result.auth_status).toBe('unauthenticated');
  });
});
