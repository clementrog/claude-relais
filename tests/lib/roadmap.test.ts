import { describe, it, expect } from 'vitest';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  normalizeRoadmapMilestones,
  syncRoadmapMilestone,
  syncRoadmapMilestoneForWorkspace,
  type RoadmapFile,
} from '@/lib/roadmap.js';

describe('roadmap helpers', () => {
  it('normalizes milestone labels and marks active milestone', () => {
    const milestones = normalizeRoadmapMilestones(
      ['M1: Setup', 'M2: API', 'Ship frontend'],
      'M2'
    );

    expect(milestones).toEqual([
      { id: 'M1', title: 'Setup', status: 'pending' },
      { id: 'M2', title: 'API', status: 'active' },
      { id: 'M3', title: 'Ship frontend', status: 'pending' },
    ]);
  });

  it('marks previous current milestone done when advancing', () => {
    const roadmap: RoadmapFile = {
      v: 1,
      generated_at: '2026-02-11T00:00:00.000Z',
      updated_at: '2026-02-11T00:00:00.000Z',
      source: 'test',
      mode: 'milestone',
      summary: 'Test roadmap',
      current_milestone_id: 'M1',
      milestones: [
        { id: 'M1', title: 'Setup', status: 'active' },
        { id: 'M2', title: 'API', status: 'pending' },
      ],
      clarifying_questions: [],
      planner_prompt: '',
      choices: [],
      token_usage: null,
      task_id: 'T-1',
      milestone_id: 'M1',
    };

    const updated = syncRoadmapMilestone(roadmap, 'M2');
    expect(updated.current_milestone_id).toBe('M2');
    expect(updated.milestones).toEqual([
      { id: 'M1', title: 'Setup', status: 'done' },
      { id: 'M2', title: 'API', status: 'active' },
    ]);
  });

  it('upgrades legacy ROADMAP.json and syncs milestone state', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'relais-roadmap-'));
    try {
      const legacy = {
        generated_at: '2026-02-11T00:00:00.000Z',
        source: 'orchestrator_question',
        milestone_id: 'M1',
        milestones: ['M1: Setup', 'M2: API', 'M3: UI'],
        clarifying_questions: [],
        prompt: 'legacy',
        choices: [],
      };
      await writeFile(join(workspace, 'ROADMAP.json'), `${JSON.stringify(legacy, null, 2)}\n`, 'utf-8');

      const changed = await syncRoadmapMilestoneForWorkspace(workspace, 'M2');
      expect(changed).toBe(true);

      const saved = JSON.parse(await readFile(join(workspace, 'ROADMAP.json'), 'utf-8')) as RoadmapFile;
      expect(saved.current_milestone_id).toBe('M2');
      expect(saved.milestones).toEqual([
        { id: 'M1', title: 'Setup', status: 'done' },
        { id: 'M2', title: 'API', status: 'active' },
        { id: 'M3', title: 'UI', status: 'pending' },
      ]);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
