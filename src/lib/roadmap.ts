import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ClaudeTokenUsage } from '../types/claude.js';

export type RoadmapMilestoneStatus = 'pending' | 'active' | 'done';

export interface RoadmapMilestone {
  id: string;
  title: string;
  status: RoadmapMilestoneStatus;
}

export interface RoadmapFile {
  v: 1;
  generated_at: string;
  updated_at: string;
  source: string;
  mode?: 'task' | 'milestone' | 'autonomous';
  summary: string;
  current_milestone_id: string | null;
  milestones: RoadmapMilestone[];
  clarifying_questions: string[];
  planner_prompt: string;
  choices: string[];
  token_usage?: ClaudeTokenUsage | null;
  task_id?: string;
  milestone_id?: string;
}

function asNonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function parseMilestoneLabel(label: string): { id: string; title: string } | null {
  const normalized = label.trim();
  if (!normalized) return null;
  const tagged = normalized.match(/^(M\d+[A-Za-z0-9_-]*)\s*[:\-]\s*(.+)$/i);
  if (!tagged) return null;
  return {
    id: tagged[1].toUpperCase(),
    title: tagged[2].trim(),
  };
}

function normalizeMilestoneStatus(value: unknown): RoadmapMilestoneStatus {
  return value === 'active' || value === 'done' ? value : 'pending';
}

export function normalizeRoadmapMilestones(
  labels: string[],
  activeMilestoneId?: string | null
): RoadmapMilestone[] {
  const milestones: RoadmapMilestone[] = [];
  const seen = new Set<string>();
  let seq = 1;

  for (const raw of labels) {
    const clean = asNonEmptyString(raw);
    if (!clean) continue;

    const parsed = parseMilestoneLabel(clean);
    let id = '';
    let title = '';
    if (parsed) {
      id = parsed.id;
      title = parsed.title;
    } else {
      while (seen.has(`m${seq}`)) seq++;
      id = `M${seq}`;
      title = clean;
    }

    const key = id.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    milestones.push({
      id,
      title,
      status: 'pending',
    });
  }

  const active = asNonEmptyString(activeMilestoneId ?? null);
  if (active) {
    const existing = milestones.find((entry) => entry.id.toLowerCase() === active.toLowerCase());
    if (existing) {
      existing.status = 'active';
      existing.id = existing.id.toUpperCase();
    } else {
      milestones.unshift({
        id: active.toUpperCase(),
        title: active,
        status: 'active',
      });
    }
  } else if (milestones.length > 0) {
    milestones[0].status = 'active';
  }

  return milestones;
}

function normalizeRoadmap(raw: unknown): RoadmapFile | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const source = raw as Record<string, unknown>;
  const now = new Date().toISOString();
  const currentMilestoneId =
    asNonEmptyString(source.current_milestone_id) ??
    asNonEmptyString(source.milestone_id) ??
    null;

  const milestoneObjects: RoadmapMilestone[] = [];
  const seen = new Set<string>();
  const sourceMilestones = Array.isArray(source.milestones) ? source.milestones : [];
  for (const entry of sourceMilestones) {
    if (typeof entry === 'string') {
      const normalized = normalizeRoadmapMilestones([entry]);
      if (normalized.length === 0) continue;
      const milestone = normalized[0];
      const key = milestone.id.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      milestoneObjects.push(milestone);
      continue;
    }

    if (typeof entry === 'object' && entry !== null) {
      const candidate = entry as Record<string, unknown>;
      const id = asNonEmptyString(candidate.id);
      const title = asNonEmptyString(candidate.title);
      if (!id || !title) continue;
      const key = id.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      milestoneObjects.push({
        id: id.toUpperCase(),
        title,
        status: normalizeMilestoneStatus(candidate.status),
      });
    }
  }

  const milestones = normalizeRoadmapMilestones(
    milestoneObjects.map((entry) => `${entry.id}: ${entry.title}`),
    currentMilestoneId
  ).map((entry) => {
    const existing = milestoneObjects.find((candidate) => candidate.id.toLowerCase() === entry.id.toLowerCase());
    if (!existing) return entry;
    return {
      ...entry,
      status: existing.status === 'done' ? 'done' : entry.status,
    };
  });

  return {
    v: 1,
    generated_at: asNonEmptyString(source.generated_at) ?? now,
    updated_at: asNonEmptyString(source.updated_at) ?? asNonEmptyString(source.generated_at) ?? now,
    source: asNonEmptyString(source.source) ?? 'runtime',
    mode:
      source.mode === 'task' || source.mode === 'milestone' || source.mode === 'autonomous'
        ? source.mode
        : undefined,
    summary: asNonEmptyString(source.summary) ?? asNonEmptyString(source.intent) ?? '',
    current_milestone_id: currentMilestoneId ?? (milestones[0]?.id ?? null),
    milestones,
    clarifying_questions: Array.isArray(source.clarifying_questions)
      ? source.clarifying_questions.filter((entry): entry is string => typeof entry === 'string' && entry.trim() !== '')
      : [],
    planner_prompt: asNonEmptyString(source.planner_prompt) ?? asNonEmptyString(source.prompt) ?? '',
    choices: Array.isArray(source.choices)
      ? source.choices.filter((entry): entry is string => typeof entry === 'string' && entry.trim() !== '')
      : [],
    token_usage:
      typeof source.token_usage === 'object' && source.token_usage !== null
        ? (source.token_usage as ClaudeTokenUsage)
        : null,
    task_id: asNonEmptyString(source.task_id) ?? undefined,
    milestone_id: asNonEmptyString(source.milestone_id) ?? undefined,
  };
}

export async function readRoadmap(workspaceDir: string): Promise<RoadmapFile | null> {
  const roadmapPath = join(workspaceDir, 'ROADMAP.json');
  try {
    const raw = JSON.parse(await readFile(roadmapPath, 'utf-8')) as unknown;
    return normalizeRoadmap(raw);
  } catch {
    return null;
  }
}

export async function writeRoadmap(workspaceDir: string, roadmap: RoadmapFile): Promise<void> {
  const roadmapPath = join(workspaceDir, 'ROADMAP.json');
  await writeFile(roadmapPath, `${JSON.stringify(roadmap, null, 2)}\n`, 'utf-8');
}

export function syncRoadmapMilestone(roadmap: RoadmapFile, milestoneId: string): RoadmapFile {
  const nextMilestoneId = asNonEmptyString(milestoneId);
  if (!nextMilestoneId) return roadmap;

  const now = new Date().toISOString();
  const currentId = roadmap.current_milestone_id;
  const currentKey = currentId?.toLowerCase();
  const nextKey = nextMilestoneId.toLowerCase();

  const milestones = roadmap.milestones.map((entry) => {
    if (entry.id.toLowerCase() === nextKey) {
      return { ...entry, id: entry.id.toUpperCase(), status: 'active' as const };
    }
    if (currentKey && entry.id.toLowerCase() === currentKey && currentKey !== nextKey && entry.status !== 'done') {
      return { ...entry, status: 'done' as const };
    }
    if (entry.status === 'active') {
      return { ...entry, status: 'pending' as const };
    }
    return entry;
  });

  if (!milestones.some((entry) => entry.id.toLowerCase() === nextKey)) {
    milestones.push({
      id: nextMilestoneId.toUpperCase(),
      title: nextMilestoneId,
      status: 'active',
    });
  }

  return {
    ...roadmap,
    updated_at: now,
    current_milestone_id: nextMilestoneId.toUpperCase(),
    milestone_id: nextMilestoneId.toUpperCase(),
    milestones,
  };
}

export async function syncRoadmapMilestoneForWorkspace(
  workspaceDir: string,
  milestoneId: string
): Promise<boolean> {
  const roadmap = await readRoadmap(workspaceDir);
  if (!roadmap) return false;
  const updated = syncRoadmapMilestone(roadmap, milestoneId);
  await writeRoadmap(workspaceDir, updated);
  return true;
}
