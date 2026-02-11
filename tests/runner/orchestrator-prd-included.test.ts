import { describe, it, expect } from 'vitest';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildOrchestratorPrompt } from '@/runner/orchestrator.js';
import { createMockConfig, createMockTickState } from '../helpers/mocks.js';

describe('orchestrator prompt includes PRD.md when present', () => {
  it('should interpolate {{PRD_MD}} from workspace PRD.md', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'relais-orch-'));
    await mkdir(join(dir, 'prompts'), { recursive: true });

    await writeFile(
      join(dir, 'prompts', 'user.txt'),
      ['PRD:', '{{PRD_MD}}', 'FACTS:', '{{FACTS_MD}}'].join('\n'),
      'utf-8'
    );
    await writeFile(join(dir, 'PRD.md'), '# PRD\n\nBuild a tiny TODO app.\n', 'utf-8');
    await writeFile(join(dir, 'FACTS.md'), 'We use TypeScript.\n', 'utf-8');
    await writeFile(join(dir, 'REPORT.md'), '', 'utf-8');

    const config = createMockConfig({
      workspace_dir: dir,
      orchestrator: {
        ...createMockConfig().orchestrator,
        user_prompt_file: 'prompts/user.txt',
      },
    });

    const state = createMockTickState(config);
    const prompt = await buildOrchestratorPrompt(config, state);

    expect(prompt).toContain('Build a tiny TODO app.');
    expect(prompt).toContain('We use TypeScript.');
    expect(prompt).not.toContain('{{PRD_MD}}');
  });

  it('should interpolate pending ideas and planning digest context', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'relais-orch-ideas-'));
    await mkdir(join(dir, 'prompts'), { recursive: true });

    await writeFile(
      join(dir, 'prompts', 'user-ideas.txt'),
      ['Ideas:', '{{PENDING_IDEAS_JSON}}', 'Digest:', '{{PLANNING_DIGEST_JSON}}'].join('\n'),
      'utf-8'
    );
    await writeFile(join(dir, 'PRD.md'), '# PRD\n', 'utf-8');
    await writeFile(join(dir, 'FACTS.md'), '', 'utf-8');
    await writeFile(join(dir, 'REPORT.md'), '', 'utf-8');
    await writeFile(
      join(dir, 'STATE.json'),
      JSON.stringify(
        {
          milestone_id: 'M1',
          budgets: { ticks: 2, orchestrator_calls: 2, builder_calls: 1, verify_runs: 0 },
          budget_warning: false,
          last_run_id: 'run-1',
          last_verdict: 'success',
          idea_inbox: [
            {
              id: 'idea-1',
              text: 'Need a quick preview flow for PM demos.',
              submitted_at: new Date().toISOString(),
              source: 'cli',
              status: 'new',
            },
          ],
          planning_digest: {
            updated_at: new Date().toISOString(),
            summary: 'Scheduled next: preview improvements after baseline polish.',
          },
          open_product_questions: [],
        },
        null,
        2
      ),
      'utf-8'
    );

    const config = createMockConfig({
      workspace_dir: dir,
      orchestrator: {
        ...createMockConfig().orchestrator,
        user_prompt_file: 'prompts/user-ideas.txt',
      },
    });

    const state = createMockTickState(config);
    const prompt = await buildOrchestratorPrompt(config, state);

    expect(prompt).toContain('Need a quick preview flow');
    expect(prompt).toContain('Scheduled next: preview improvements');
    expect(prompt).not.toContain('{{PENDING_IDEAS_JSON}}');
    expect(prompt).not.toContain('{{PLANNING_DIGEST_JSON}}');
  });

  it('should interpolate roadmap context from envoi/ROADMAP.json', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'relais-orch-roadmap-'));
    await mkdir(join(dir, 'prompts'), { recursive: true });

    await writeFile(
      join(dir, 'prompts', 'user-roadmap.txt'),
      ['Roadmap:', '{{ROADMAP_JSON}}'].join('\n'),
      'utf-8'
    );
    await writeFile(
      join(dir, 'ROADMAP.json'),
      JSON.stringify({ milestones: ['M1: Setup', 'M2: Publish flow'] }, null, 2),
      'utf-8'
    );
    await writeFile(join(dir, 'PRD.md'), '# PRD\n\nBuild a tiny TODO app.\n', 'utf-8');
    await writeFile(join(dir, 'FACTS.md'), 'We use TypeScript.\n', 'utf-8');
    await writeFile(join(dir, 'REPORT.md'), '', 'utf-8');

    const config = createMockConfig({
      workspace_dir: dir,
      orchestrator: {
        ...createMockConfig().orchestrator,
        user_prompt_file: 'prompts/user-roadmap.txt',
      },
    });

    const state = createMockTickState(config);
    const prompt = await buildOrchestratorPrompt(config, state);

    expect(prompt).toContain('M1: Setup');
    expect(prompt).toContain('M2: Publish flow');
    expect(prompt).not.toContain('{{ROADMAP_JSON}}');
  });
});
