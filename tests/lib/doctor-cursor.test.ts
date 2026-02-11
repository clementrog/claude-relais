import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { checkCursorAgent } from '@/lib/doctor.js';

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

describe('checkCursorAgent', () => {
  const oldEnv = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...oldEnv };
    delete process.env.CURSOR_API_KEY;
  });

  afterEach(() => {
    process.env = { ...oldEnv };
  });

  it('returns cli_available=false when command cannot be spawned', async () => {
    vi.mocked(spawn).mockImplementation(() => {
      throw new Error('ENOENT');
    });

    const result = await checkCursorAgent({ builder: { cursor: { command: 'cursor' } } } as any);
    expect(result.cli_available).toBe(false);
    expect(result.agent_available).toBe(false);
    expect(result.command).toBe('cursor');
  });

  it('returns agent_available=false when cursor agent is missing', async () => {
    vi.mocked(spawn).mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === '--version' || args[0] === '-v') return makeChild({ code: 0, stdout: 'cursor 1.2.3\n' });
      if (args[0] === 'agent' && args[1] === '--help') return makeChild({ code: 1, stderr: 'Unknown subcommand\n' });
      return makeChild({ code: 1 });
    });

    const result = await checkCursorAgent({ builder: { cursor: { command: 'cursor' } } } as any);
    expect(result.cli_available).toBe(true);
    expect(result.agent_available).toBe(false);
    expect(result.auth_status).toBe('unknown');
  });

  it('returns auth_status=api_key_present when CURSOR_API_KEY is set', async () => {
    process.env.CURSOR_API_KEY = 'test-key';
    vi.mocked(spawn).mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === '--version' || args[0] === '-v') return makeChild({ code: 0, stdout: 'cursor 9.9.9\n' });
      if (args[0] === 'agent' && args[1] === '--help') return makeChild({ code: 0, stdout: 'help\n' });
      if (args[0] === 'agent' && args[1] === 'whoami') return makeChild({ code: 0, stdout: 'me\n' });
      return makeChild({ code: 1 });
    });

    const result = await checkCursorAgent({ builder: { cursor: { command: 'cursor' } } } as any);
    expect(result.auth_status).toBe('api_key_present');
    // should not need whoami when key is present (still safe if it runs)
  });

  it('returns auth_status=unauthenticated when whoami fails', async () => {
    vi.mocked(spawn).mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === '--version' || args[0] === '-v') return makeChild({ code: 0, stdout: 'cursor 9.9.9\n' });
      if (args[0] === 'agent' && args[1] === '--help') return makeChild({ code: 0, stdout: 'help\n' });
      if (args[0] === 'agent' && args[1] === 'whoami') return makeChild({ code: 1, stderr: 'Not logged in\n' });
      return makeChild({ code: 1 });
    });

    const result = await checkCursorAgent({ builder: { cursor: { command: 'cursor' } } } as any);
    expect(result.auth_status).toBe('unauthenticated');
    expect(result.details).toContain('Not logged in');
  });
});

