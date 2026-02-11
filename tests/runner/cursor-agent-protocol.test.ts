import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runBuilder } from '@/runner/builder.js';
import { createMockConfig, createMockTask, createMockTickState } from '../helpers/mocks.js';

let mockOutputPath = '';
const { execFileMock } = vi.hoisted(() => ({
  execFileMock: vi.fn(
    (
      _file: string,
      _args: string[],
      _options: object,
      callback: (err: Error | null, stdout?: string, stderr?: string) => void
    ) => {
      writeFileSync(
        mockOutputPath,
        JSON.stringify({
          summary: 'Applied changes',
          files_intended: ['src/example.ts'],
          commands_ran: [],
          notes: [],
        }),
        'utf-8'
      );
      callback(null, '', '');
    }
  ),
}));

vi.mock('node:child_process', () => ({
  execFile: execFileMock,
}));

describe('cursor agent protocol prompt', () => {
  let workspaceDir = '';

  beforeEach(async () => {
    workspaceDir = await mkdtemp(join(tmpdir(), 'relais-cursor-protocol-'));
    await mkdir(join(workspaceDir, 'relais'), { recursive: true });
    mockOutputPath = join(workspaceDir, 'BUILDER_RESULT.json');
  });

  afterEach(async () => {
    await rm(workspaceDir, { recursive: true, force: true });
    execFileMock.mockClear();
  });

  it('uses compact machine protocol prompt for cursor_agent mode', async () => {
    const base = createMockConfig();
    const config = createMockConfig({
      workspace_dir: workspaceDir,
      builder: {
        ...base.builder,
        default_mode: 'cursor',
        cursor: {
          driver_kind: 'cursor_agent',
          command: 'node',
          args: ['-e', ''],
          timeout_seconds: 30,
          output_file: 'BUILDER_RESULT.json',
        },
      },
    });
    const task = createMockTask('execute', {
      builder: {
        mode: 'cursor',
        max_turns: 4,
        instructions: 'Implement task from TASK.json',
      },
    });
    const state = createMockTickState(config, task);

    const result = await runBuilder(state, task);

    expect(execFileMock).toHaveBeenCalledTimes(1);

    const callArgs = execFileMock.mock.calls[0];
    const args = callArgs[1] as string[];
    const prompt = args[args.length - 1];
    const options = callArgs[2] as { env?: Record<string, string | undefined> };

    expect(prompt).toContain('ENVOI_BUILDER_PROTOCOL=v2_machine');
    expect(prompt).toContain('TASK_PATH=');
    expect(prompt).toContain('OUTPUT_PATH=');
    expect(prompt).toContain('SCHEMA_PATH=');
    expect(prompt).not.toContain('You are the Builder (Hands) invoked by Relais.');
    expect(prompt).not.toContain('PRD (if needed)');
    expect(prompt).not.toContain('FACTS (if needed)');
    expect(options.env?.ENVOI_BUILDER_PROTOCOL).toBe('v2_machine');
    expect(options.env?.ENVOI_DRIVER_KIND).toBe('cursor_agent');
    expect(options.env?.ENVOI_TASK_PATH).toBeDefined();
    expect(options.env?.ENVOI_OUTPUT_PATH).toBeDefined();
    expect(options.env?.ENVOI_SCHEMA_PATH).toBeDefined();
    expect(options.env?.ENVOI_BUILDER_PROTOCOL).toBe('v2_machine');
    expect(options.env?.ENVOI_DRIVER_KIND).toBe('cursor_agent');
    expect(options.env?.ENVOI_TASK_PATH).toBeDefined();
    expect(options.env?.ENVOI_OUTPUT_PATH).toBeDefined();
    expect(options.env?.ENVOI_SCHEMA_PATH).toBeDefined();

    expect(result.success).toBe(true);
    expect(result.builderOutputValid).toBe(true);
    expect(result.validationErrors).toEqual([]);
  });

  it('passes machine contract env vars for external driver without prompt text', async () => {
    const base = createMockConfig();
    const config = createMockConfig({
      workspace_dir: workspaceDir,
      builder: {
        ...base.builder,
        default_mode: 'cursor',
        cursor: {
          driver_kind: 'external',
          command: 'node',
          args: ['-e', ''],
          timeout_seconds: 30,
          output_file: 'BUILDER_RESULT.json',
        },
      },
    });
    const task = createMockTask('execute', {
      builder: {
        mode: 'cursor',
        max_turns: 4,
        instructions: 'Implement task from TASK.json',
      },
    });
    const state = createMockTickState(config, task);

    const result = await runBuilder(state, task);

    expect(execFileMock).toHaveBeenCalledTimes(1);
    const callArgs = execFileMock.mock.calls[0];
    const args = callArgs[1] as string[];
    const options = callArgs[2] as { env?: Record<string, string | undefined> };

    expect(args).toEqual(['-e', '']);
    expect(options.env?.ENVOI_BUILDER_PROTOCOL).toBe('v2_machine');
    expect(options.env?.ENVOI_DRIVER_KIND).toBe('external');
    expect(options.env?.ENVOI_TASK_PATH).toBeDefined();
    expect(options.env?.ENVOI_OUTPUT_PATH).toBeDefined();
    expect(options.env?.ENVOI_SCHEMA_PATH).toBeDefined();
    expect(options.env?.ENVOI_BUILDER_PROTOCOL).toBe('v2_machine');
    expect(options.env?.ENVOI_DRIVER_KIND).toBe('external');
    expect(options.env?.ENVOI_TASK_PATH).toBeDefined();
    expect(options.env?.ENVOI_OUTPUT_PATH).toBeDefined();
    expect(options.env?.ENVOI_SCHEMA_PATH).toBeDefined();
    expect(result.success).toBe(true);
  });

  it('normalizes legacy --prompt flag to --print for cursor_agent driver', async () => {
    const base = createMockConfig();
    const config = createMockConfig({
      workspace_dir: workspaceDir,
      builder: {
        ...base.builder,
        default_mode: 'cursor',
        cursor: {
          driver_kind: 'cursor_agent',
          command: 'node',
          args: ['agent', '--prompt', '--output-format', 'text', '--workspace', '.', '--force'],
          timeout_seconds: 30,
          output_file: 'BUILDER_RESULT.json',
        },
      },
    });
    const task = createMockTask('execute', {
      builder: {
        mode: 'cursor',
        max_turns: 4,
        instructions: 'Implement task from TASK.json',
      },
    });
    const state = createMockTickState(config, task);

    const result = await runBuilder(state, task);

    expect(execFileMock).toHaveBeenCalledTimes(1);
    const callArgs = execFileMock.mock.calls[0];
    const args = callArgs[1] as string[];

    expect(args).toContain('--print');
    expect(args).not.toContain('--prompt');
    expect(result.success).toBe(true);
    expect(result.builderOutputValid).toBe(true);
  });
});
