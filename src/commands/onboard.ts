/**
 * Guided onboarding flow for Envoi.
 *
 * Goals:
 * - Ensure workspace is initialized
 * - Capture project brief (PRD)
 * - Configure execution mode + builder + optional reviewer
 * - Validate role connectivity
 * - Generate initial roadmap snapshot
 * - Optionally start execution immediately
 */

import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { resolve, join, relative } from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';

import { atomicReadJson, atomicWriteJson } from '../lib/fs.js';
import { CONFIG_FILE_NAME, findConfigFile, loadConfig, validateConfig, ConfigError } from '../lib/config.js';
import { checkCursorAgent, checkCodexCli, checkClaudeCodeCli } from '../lib/doctor.js';
import { getGitTopLevel, isGitRepo, getHeadCommit } from '../lib/git.js';
import { normalizeRoadmapMilestones, readRoadmap, writeRoadmap, type RoadmapFile, type RoadmapMilestone } from '../lib/roadmap.js';
import type { EnvoiConfig } from '../types/config.js';
import type { Task } from '../types/task.js';
import type { ClaudeTokenUsage } from '../types/claude.js';
import { CLI_NAME, PRODUCT_NAME, PACKAGE_NAME } from '../lib/branding.js';
import { createInitialState } from '../lib/state.js';

import { initCommand } from './init.js';

type LoopMode = 'task' | 'milestone' | 'autonomous';
type BuilderChoice = 'cursor';
type PlannerProvider = 'claude_code' | 'chatgpt';
type ReviewerChoice = 'none' | 'codex';
type StartIntent = 'tour' | 'setup';
type PrdSource = 'file' | 'stdin' | 'existing' | 'paste' | 'editor' | 'skip';

interface PrdCaptureResult {
  text: string;
  source: PrdSource;
}

interface RoadmapDraft extends RoadmapFile {
  generated_at: string;
  updated_at: string;
  source: 'orchestrator_question' | 'orchestrator_execute';
  summary: string;
  task_id: string;
  milestone_id: string;
  current_milestone_id: string | null;
  mode: LoopMode;
  milestones: RoadmapMilestone[];
  clarifying_questions: string[];
  planner_prompt: string;
  choices: string[];
  token_usage?: ClaudeTokenUsage | null;
}

const ONBOARDING_NEEDS_INPUT_EXIT_CODE = 20;
const ONBOARDING_DEFAULT_CONTINUE_EXIT_CODE = 0;
const ONBOARDING_QUESTION_PAYLOAD_TYPE = 'envoi.onboarding.questions.v1';
const ONBOARDING_NEXT_QUESTION_PAYLOAD_TYPE = 'envoi.onboarding.next_question.v1';
const ONBOARDING_PROMPT_PAYLOAD_TYPE = 'envoi.onboarding.prompt.v1';
const ONBOARDING_REVIEW_PAYLOAD_TYPE = 'envoi.onboarding.review.v1';
const ONBOARDING_ANSWER_PAYLOAD_TYPE = 'envoi.onboarding.answer.v1';
const ONBOARDING_SESSION_FILENAME = 'ONBOARDING_SESSION.json';
const NON_INTERACTIVE_STDIN_PROBE_TIMEOUT_MS = 200;
const NON_INTERACTIVE_ANSWER_TIMEOUT_MS = 20_000;
const NON_INTERACTIVE_MAX_INVALID_RETRIES = 2;

export type OnboardingOutputMode = 'compact' | 'json' | 'verbose';

export interface OnboardingNeedsInputPolicy {
  outputMode: OnboardingOutputMode;
  strictExit: boolean;
}

const MODE_CHOICES: Array<{ value: LoopMode; label: string; desc: string }> = [
  { value: 'milestone', label: 'milestone', desc: 'Runs until milestone boundary, then pauses.' },
  { value: 'autonomous', label: 'autonomous', desc: 'Runs continuously until blocked or limited.' },
  { value: 'task', label: 'task', desc: 'One bounded cycle each time (lowest drift).' },
];

const PLANNER_PROVIDER_CHOICES: Array<{ value: PlannerProvider; label: string; desc: string }> = [
  { value: 'claude_code', label: 'claude code', desc: 'Claude Code orchestrator runtime.' },
  { value: 'chatgpt', label: 'chatgpt', desc: 'Codex/OpenAI orchestrator runtime.' },
];
const CLAUDE_PLANNER_MODEL = 'opus';
const CHATGPT_PLANNER_MODEL = 'gpt-5.3';
const REVIEWER_MODEL_CHOICES = ['gpt-5', 'o3', 'gpt-5-mini'] as const;

type OnboardingQuestionType = 'select' | 'text' | 'multiline';

export interface OnboardingQuestion {
  id: string;
  label: string;
  type: OnboardingQuestionType;
  required: boolean;
  choices?: Array<{ value: string; label: string; desc?: string }>;
  default?: string;
  help?: string;
}

interface OnboardingQuestionPayload {
  type: typeof ONBOARDING_QUESTION_PAYLOAD_TYPE;
  session_id: string;
  message: string;
  questions: OnboardingQuestion[];
  next_action: {
    command: string;
    examples: string[];
    accepted_inputs: string[];
    exit_code: number;
  };
}

interface OnboardingNextQuestionPayload {
  type: typeof ONBOARDING_NEXT_QUESTION_PAYLOAD_TYPE;
  session_id: string;
  message: string;
  question: OnboardingQuestion;
  next_action: {
    command: string;
    examples: string[];
    accepted_inputs: string[];
    exit_code: number;
  };
}

interface OnboardingPromptPayload {
  type: typeof ONBOARDING_PROMPT_PAYLOAD_TYPE;
  session_id: string;
  message: string;
  question: OnboardingQuestion;
  timeout_ms: number;
}

interface OnboardingReviewPayload {
  type: typeof ONBOARDING_REVIEW_PAYLOAD_TYPE;
  session_id: string;
  message: string;
  summary: {
    mode?: string;
    builder?: string;
    planner_provider?: string;
    orchestrator_model?: string;
    builder_model?: string;
    reviewer?: string;
    reviewer_model?: string;
    prd_preview?: string;
    prd_full?: string;
    prd_path?: string;
  };
  options: Array<{ value: 'confirm' | 'confirm_and_start' | 'edit'; label: string; desc?: string }>;
}

interface OnboardingAnswerPayload {
  type?: string;
  question_id?: string;
  value?: unknown;
  action?: unknown;
  field?: unknown;
}

interface OnboardingSessionState {
  v: 1;
  type: 'envoi.onboarding.session.v1';
  session_id: string;
  status: 'waiting_input' | 'completed';
  updated_at: string;
  current_step?: string;
  awaiting_review?: boolean;
  pending_question_ids: string[];
  answers: Record<string, unknown>;
}

export interface OnboardingQuestionInputs {
  mode?: LoopMode;
  builder?: BuilderChoice;
  plannerProvider?: PlannerProvider;
  orchestratorModel?: string;
  builderModel?: string;
  reviewer?: ReviewerChoice;
  reviewerModel?: string;
  prdText?: string;
  defaults: {
    mode: LoopMode;
    builder: BuilderChoice;
    plannerProvider: PlannerProvider;
    orchestratorModel: string;
    builderModel: string;
    reviewer: ReviewerChoice;
    reviewerModel: string;
  };
}

interface InlineAnswersState {
  mode?: LoopMode;
  builder?: BuilderChoice;
  plannerProvider?: PlannerProvider;
  orchestratorModel?: string;
  builderModel?: string;
  reviewer?: ReviewerChoice;
  reviewerModel?: string;
  prdText?: string;
}

type InlineWizardResult =
  | { kind: 'completed'; answers: InlineAnswersState }
  | { kind: 'fallback'; questions: OnboardingQuestion[]; answers: Record<string, unknown> };

interface NonTtyLineReader {
  nextLine: (timeoutMs: number) => Promise<{ status: 'line'; line: string } | { status: 'timeout' | 'end' }>;
  close: () => void;
}

function normalizeLoopMode(value?: string): LoopMode | undefined {
  if (!value || value.trim() === '') return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'task' || normalized === 'milestone' || normalized === 'autonomous') {
    return normalized;
  }
  throw new Error(`Invalid mode: ${value}. Must be 'task', 'milestone', or 'autonomous'.`);
}

function normalizeBuilderChoice(value?: string): BuilderChoice | undefined {
  if (!value || value.trim() === '') return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'cursor') return normalized;
  throw new Error(`Invalid builder: ${value}. Only 'cursor' is supported.`);
}

function normalizePlannerProvider(value?: string): PlannerProvider | undefined {
  if (!value || value.trim() === '') return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'claude_code' || normalized === 'chatgpt') return normalized;
  throw new Error(`Invalid planner provider: ${value}. Must be 'claude_code' or 'chatgpt'.`);
}

function resolvePlannerModel(provider: PlannerProvider): string {
  return provider === 'chatgpt' ? CHATGPT_PLANNER_MODEL : CLAUDE_PLANNER_MODEL;
}

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

export function computeOnboardingNeedsInputExitCode(strictExit: boolean): number {
  return strictExit ? ONBOARDING_NEEDS_INPUT_EXIT_CODE : ONBOARDING_DEFAULT_CONTINUE_EXIT_CODE;
}

export function parseOnboardingOutputMode(value?: string): OnboardingOutputMode | undefined {
  if (!value || value.trim() === '') return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'compact' || normalized === 'json' || normalized === 'verbose') {
    return normalized;
  }
  throw new Error(`Invalid onboarding output mode: ${value}. Must be 'compact', 'json', or 'verbose'.`);
}

export function resolveOnboardingNeedsInputPolicy(options: {
  json?: boolean;
  verboseOnboarding?: boolean;
  onboardingOutput?: string;
  strictExit?: boolean;
}): OnboardingNeedsInputPolicy {
  const outputFromOption = parseOnboardingOutputMode(options.onboardingOutput);

  if (outputFromOption && options.json) {
    throw new Error("Conflicting options: use either '--onboarding-output' or '--json'.");
  }
  if (outputFromOption && options.verboseOnboarding) {
    throw new Error("Conflicting options: use either '--onboarding-output' or '--verbose-onboarding'.");
  }
  if (options.json && options.verboseOnboarding) {
    throw new Error("Conflicting options: use either '--json' or '--verbose-onboarding'.");
  }

  const outputMode: OnboardingOutputMode = outputFromOption
    ?? (options.json ? 'json' : options.verboseOnboarding ? 'verbose' : 'compact');
  return {
    outputMode,
    strictExit: Boolean(options.strictExit),
  };
}

function normalizeAnswerEnvelope(
  answers: Record<string, unknown>
): Record<string, unknown> {
  const envelopeType = asNonEmptyString(answers.type);
  const questionId = asNonEmptyString(answers.question_id);
  if (envelopeType !== ONBOARDING_ANSWER_PAYLOAD_TYPE || !questionId) {
    return answers;
  }

  const normalized: Record<string, unknown> = {};
  if (questionId === 'review') {
    const action = asNonEmptyString(answers.action);
    const field = asNonEmptyString(answers.field);
    const value = asNonEmptyString(answers.value);
    if (action === 'confirm') {
      normalized.__review_action = 'confirm';
    } else if (action === 'confirm_and_start') {
      normalized.__review_action = 'confirm_and_start';
    } else if (action === 'edit' && field) {
      normalized.__review_action = `edit:${field}`;
    } else if (value) {
      normalized.__review_action = value;
    }
    const sessionId = asNonEmptyString(answers.session_id);
    if (sessionId) normalized.__session_id = sessionId;
    return normalized;
  }

  if (Object.prototype.hasOwnProperty.call(answers, 'value')) {
    normalized[questionId] = answers.value;
  }
  const sessionId = asNonEmptyString(answers.session_id);
  if (sessionId) normalized.__session_id = sessionId;
  return normalized;
}

async function loadOnboardingAnswers(options: {
  answersJson?: string;
  answersFile?: string;
}): Promise<Record<string, unknown>> {
  let fileAnswers: Record<string, unknown> = {};
  if (options.answersFile) {
    const filePath = resolve(options.answersFile);
    const fileRaw = await readFile(filePath, 'utf-8');
    const parsed = JSON.parse(fileRaw) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error(`Answers file must contain a JSON object: ${filePath}`);
    }
    fileAnswers = normalizeAnswerEnvelope(parsed as Record<string, unknown>);
  }

  let inlineAnswers: Record<string, unknown> = {};
  if (options.answersJson) {
    const parsed = JSON.parse(options.answersJson) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('--answers-json must be a JSON object');
    }
    inlineAnswers = normalizeAnswerEnvelope(parsed as Record<string, unknown>);
  }

  return { ...fileAnswers, ...inlineAnswers };
}

function onboardingSessionPath(workspaceDir: string): string {
  return join(workspaceDir, ONBOARDING_SESSION_FILENAME);
}

async function persistOnboardingSession(path: string, state: OnboardingSessionState): Promise<void> {
  await atomicWriteJson(path, state);
}

async function loadOnboardingSession(path: string): Promise<OnboardingSessionState | null> {
  try {
    const session = await atomicReadJson<OnboardingSessionState>(path);
    if (session?.type !== 'envoi.onboarding.session.v1') return null;
    return session;
  } catch {
    return null;
  }
}

export function buildNonInteractiveQuestions(input: OnboardingQuestionInputs): OnboardingQuestion[] {
  const questions: OnboardingQuestion[] = [];

  if (!input.mode) {
    questions.push({
      id: 'mode',
      label: 'How should Envoi run by default?',
      type: 'select',
      required: true,
      default: input.defaults.mode,
      choices: MODE_CHOICES.map((choice) => ({ value: choice.value, label: choice.label, desc: choice.desc })),
    });
  }

  if (!input.plannerProvider) {
    questions.push({
      id: 'planner_provider',
      label: 'Planner provider',
      type: 'select',
      required: true,
      default: input.defaults.plannerProvider,
      choices: PLANNER_PROVIDER_CHOICES.map((choice) => ({ value: choice.value, label: choice.label, desc: choice.desc })),
    });
  }

  if (!input.reviewer) {
    questions.push({
      id: 'reviewer',
      label: 'Optional reviewer',
      type: 'select',
      required: true,
      default: input.defaults.reviewer,
      choices: [
        { value: 'codex', label: 'codex', desc: 'Adds second-pass checks for risky changes.' },
        { value: 'none', label: 'none', desc: 'Skip reviewer for less friction.' },
      ],
    });
  }

  if (input.reviewer === 'codex' && !asNonEmptyString(input.reviewerModel)) {
    questions.push({
      id: 'reviewer_model',
      label: 'Reviewer model',
      type: 'select',
      required: true,
      default: input.defaults.reviewerModel,
      choices: REVIEWER_MODEL_CHOICES.map((value) => ({ value, label: value })),
    });
  }

  if (!isNonEmptyContent(input.prdText ?? '')) {
    questions.push({
      id: 'prd_text',
      label: 'Paste your project PRD/context',
      type: 'multiline',
      required: true,
      help: 'This is the source of truth for planning. Include goals, constraints, and scope.',
    });
  }

  return questions;
}

function buildQuestionPayload(
  sessionId: string,
  questions: OnboardingQuestion[],
  workspaceDir: string,
  exitCode: number
): OnboardingQuestionPayload {
  return {
    type: ONBOARDING_QUESTION_PAYLOAD_TYPE,
    session_id: sessionId,
    message: 'Onboarding needs your input before continuing.',
    questions,
    next_action: {
      command: `${CLI_NAME} start --answers-file ${workspaceDir}/onboarding.answers.json`,
      examples: [
        `${CLI_NAME} start --answers-json '{"mode":"milestone","builder":"cursor","planner_provider":"claude_code","reviewer":"codex","prd_text":"..."}'`,
        `npx -y ${PACKAGE_NAME}@latest start --answers-file ${workspaceDir}/onboarding.answers.json`,
      ],
      accepted_inputs: ['--answers-json <json-object>', '--answers-file <path-to-json>'],
      exit_code: exitCode,
    },
  };
}

function buildNextQuestionPayload(
  sessionId: string,
  question: OnboardingQuestion,
  workspaceDir: string,
  exitCode: number
): OnboardingNextQuestionPayload {
  return {
    type: ONBOARDING_NEXT_QUESTION_PAYLOAD_TYPE,
    session_id: sessionId,
    message: 'Onboarding needs one answer before continuing.',
    question,
    next_action: {
      command: `${CLI_NAME} start --answers-json '{"type":"${ONBOARDING_ANSWER_PAYLOAD_TYPE}","session_id":"${sessionId}","question_id":"${question.id}","value":"..."}'`,
      examples: [
        `${CLI_NAME} start --answers-json '{"type":"${ONBOARDING_ANSWER_PAYLOAD_TYPE}","session_id":"${sessionId}","question_id":"${question.id}","value":"${question.default ?? ''}"}'`,
        `npx -y ${PACKAGE_NAME}@latest start --answers-file ${workspaceDir}/onboarding.answer.json`,
      ],
      accepted_inputs: [
        `--answers-json '{"type":"${ONBOARDING_ANSWER_PAYLOAD_TYPE}","session_id":"<session-id>","question_id":"<question-id>","value":"..."}'`,
        '--answers-file <path-to-json>',
      ],
      exit_code: exitCode,
    },
  };
}

function createNonTtyLineReader(stream: NodeJS.ReadStream): NonTtyLineReader {
  let buffer = '';
  const queuedLines: string[] = [];
  const waiters: Array<(value: { status: 'line'; line: string } | { status: 'timeout' | 'end' }) => void> = [];
  let ended = stream.readableEnded;

  const flushBuffer = (): void => {
    while (true) {
      const index = buffer.indexOf('\n');
      if (index === -1) break;
      const raw = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      const line = raw.replace(/\r$/, '').trim();
      if (line.length === 0) continue;
      if (waiters.length > 0) {
        const waiter = waiters.shift();
        waiter?.({ status: 'line', line });
      } else {
        queuedLines.push(line);
      }
    }
  };

  const onData = (chunk: string | Buffer): void => {
    buffer += Buffer.isBuffer(chunk) ? chunk.toString('utf-8') : chunk;
    flushBuffer();
  };

  const onEnd = (): void => {
    ended = true;
    const lastLine = buffer.trim();
    buffer = '';
    if (lastLine.length > 0) {
      queuedLines.push(lastLine);
    }
    while (waiters.length > 0) {
      const waiter = waiters.shift();
      if (queuedLines.length > 0) {
        waiter?.({ status: 'line', line: queuedLines.shift()! });
      } else {
        waiter?.({ status: 'end' });
      }
    }
  };

  const onError = (): void => {
    ended = true;
    while (waiters.length > 0) {
      waiters.shift()?.({ status: 'end' });
    }
  };

  stream.on('data', onData);
  stream.on('end', onEnd);
  stream.on('error', onError);

  return {
    nextLine: async (timeoutMs: number) => {
      if (queuedLines.length > 0) {
        return { status: 'line', line: queuedLines.shift()! };
      }
      if (ended) return { status: 'end' };
      return await new Promise((resolve) => {
        let settled = false;
        const finish = (value: { status: 'line'; line: string } | { status: 'timeout' | 'end' }) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          const index = waiters.indexOf(waiter);
          if (index >= 0) waiters.splice(index, 1);
          resolve(value);
        };
        const waiter = (value: { status: 'line'; line: string } | { status: 'timeout' | 'end' }) => finish(value);
        waiters.push(waiter);
        const timer = setTimeout(() => finish({ status: 'timeout' }), timeoutMs);
      });
    },
    close: () => {
      stream.off('data', onData);
      stream.off('end', onEnd);
      stream.off('error', onError);
    },
  };
}

export function parseInlineAnswer(line: string): OnboardingAnswerPayload {
  const trimmed = line.trim();
  if (trimmed === '') return {};
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (typeof parsed === 'object' && parsed !== null) {
      return parsed as OnboardingAnswerPayload;
    }
    return { value: parsed };
  } catch {
    return { value: trimmed };
  }
}

export function normalizeQuestionAnswer(question: OnboardingQuestion, raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  if (trimmed === '') return undefined;

  if (question.type === 'select') {
    const choices = question.choices ?? [];
    const index = Number.parseInt(trimmed, 10);
    if (!Number.isNaN(index) && index >= 1 && index <= choices.length) {
      return choices[index - 1].value;
    }
    const direct = choices.find((choice) => choice.value.toLowerCase() === trimmed.toLowerCase());
    return direct?.value;
  }

  return trimmed;
}

function summarizePrdPreview(text: string): string {
  const compact = text.trim().replace(/\s+/g, ' ');
  if (compact.length <= 180) return compact;
  return `${compact.slice(0, 177)}...`;
}

function normalizeGitStatusPath(pathText: string): string {
  const trimmed = pathText.trim();
  if (!trimmed.startsWith('"') || !trimmed.endsWith('"')) return trimmed;
  const body = trimmed.slice(1, -1);
  return body
    .replace(/\\n/g, '\n')
    .replace(/\\t/g, '\t')
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, '\\');
}

export function parseGitPorcelainPaths(stdout: string): string[] {
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.length >= 4)
    .map((line) => {
      const pathPart = line.slice(3).trim();
      const renamedIndex = pathPart.indexOf(' -> ');
      const candidate = renamedIndex >= 0 ? pathPart.slice(renamedIndex + 4) : pathPart;
      return normalizeGitStatusPath(candidate);
    })
    .filter((path) => path.length > 0);
}

export function isScaffoldOnlyInitialDirtyFiles(
  files: string[],
  workspaceDir: string,
  configFileName: string
): boolean {
  const normalizedWorkspacePrefix = `${workspaceDir.replace(/^\.\/+/, '').replace(/\/+$/, '')}/`;
  return files.every((file) => {
    const normalized = file.replace(/^\.\/+/, '');
    return (
      normalized === '.gitignore' ||
      normalized === configFileName ||
      normalized.startsWith(normalizedWorkspacePrefix)
    );
  });
}

async function autoCommitInitialScaffoldIfSafe(config: EnvoiConfig, configFilePath?: string): Promise<void> {
  if (!isGitRepo()) return;

  const hasHeadCommit = spawnSync('git', ['rev-parse', '--verify', 'HEAD'], { stdio: 'pipe' }).status === 0;
  if (hasHeadCommit) return;

  const statusResult = spawnSync('git', ['status', '--porcelain'], { stdio: 'pipe' });
  if (statusResult.status !== 0) return;

  const dirtyFiles = parseGitPorcelainPaths(statusResult.stdout?.toString('utf-8') ?? '');
  if (dirtyFiles.length === 0) {
    console.log('Skipping auto-start: repository has no initial commit yet.');
    console.log('Create an initial commit, then run envoi start again.');
    throw new Error('Initial repository commit required before auto-start.');
  }

  const normalizedConfigPath = (() => {
    if (!configFilePath) return CONFIG_FILE_NAME;
    const relPath = relative(process.cwd(), resolve(configFilePath)).replace(/\\/g, '/');
    return relPath.startsWith('../') ? CONFIG_FILE_NAME : relPath;
  })();

  if (!isScaffoldOnlyInitialDirtyFiles(dirtyFiles, config.workspace_dir, normalizedConfigPath)) {
    console.log('Skipping auto-start: initial repo has non-Envoi uncommitted files.');
    console.log('Commit your existing files first, then run envoi start again.');
    throw new Error('Initial repository contains non-scaffold changes; not auto-committing.');
  }

  const addResult = spawnSync('git', ['add', '--', '.gitignore', normalizedConfigPath, config.workspace_dir], { stdio: 'pipe' });
  if (addResult.status !== 0) {
    const stderr = addResult.stderr?.toString('utf-8').trim();
    throw new Error(`Failed to stage Envoi scaffold for initial commit: ${stderr || 'git add failed'}`);
  }

  const commitResult = spawnSync(
    'git',
    [
      '-c',
      'user.name=Envoi',
      '-c',
      'user.email=envoi@local',
      'commit',
      '-m',
      'Initialize Envoi workspace',
    ],
    { stdio: 'pipe' }
  );
  if (commitResult.status !== 0) {
    const stderr = commitResult.stderr?.toString('utf-8').trim();
    const stdout = commitResult.stdout?.toString('utf-8').trim();
    const combined = `${stderr}\n${stdout}`.toLowerCase();
    if (combined.includes('nothing to commit')) return;
    throw new Error(`Failed to create initial scaffold commit: ${stderr || stdout || 'git commit failed'}`);
  }

  console.log('Created initial git commit for Envoi scaffold.');
}

function clearInlineField(state: InlineAnswersState, field: string): void {
  switch (field) {
    case 'mode':
      state.mode = undefined;
      return;
    case 'builder':
      state.builder = undefined;
      state.builderModel = undefined;
      return;
    case 'planner_provider':
      state.plannerProvider = undefined;
      state.orchestratorModel = undefined;
      return;
    case 'orchestrator_model':
      state.orchestratorModel = undefined;
      return;
    case 'builder_model':
      state.builderModel = undefined;
      return;
    case 'reviewer':
      state.reviewer = undefined;
      state.reviewerModel = undefined;
      return;
    case 'reviewer_model':
      state.reviewerModel = undefined;
      return;
    case 'prd_text':
      state.prdText = undefined;
      return;
    default:
      return;
  }
}

function applyQuestionValue(state: InlineAnswersState, questionId: string, value: string): void {
  switch (questionId) {
    case 'mode':
      state.mode = normalizeLoopMode(value);
      return;
    case 'builder':
      state.builder = normalizeBuilderChoice(value);
      state.builderModel = undefined;
      return;
    case 'planner_provider':
      state.plannerProvider = normalizePlannerProvider(value);
      if (state.plannerProvider) {
        state.orchestratorModel = resolvePlannerModel(state.plannerProvider);
      }
      return;
    case 'orchestrator_model':
      state.orchestratorModel = value;
      return;
    case 'builder_model':
      state.builderModel = value;
      return;
    case 'reviewer':
      state.reviewer = normalizeReviewerChoice(value);
      if (state.reviewer !== 'codex') {
        state.reviewerModel = undefined;
      }
      return;
    case 'reviewer_model':
      state.reviewerModel = value;
      return;
    case 'prd_text':
      state.prdText = value;
      return;
    default:
      return;
  }
}

export function buildReviewPayload(sessionId: string, state: InlineAnswersState): OnboardingReviewPayload {
  const prdFull = (state.prdText ?? '').trim();
  return {
    type: ONBOARDING_REVIEW_PAYLOAD_TYPE,
    session_id: sessionId,
    message: 'Review onboarding choices before saving. Full PRD is included below and saved to envoi/PRD.md.',
    summary: {
      mode: state.mode,
      builder: state.builder,
      planner_provider: state.plannerProvider,
      orchestrator_model: state.orchestratorModel,
      builder_model: state.builderModel,
      reviewer: state.reviewer,
      reviewer_model: state.reviewerModel,
      prd_preview: summarizePrdPreview(prdFull),
      prd_full: prdFull,
      prd_path: 'envoi/PRD.md',
    },
    options: [
      { value: 'confirm', label: 'confirm', desc: 'Save and continue onboarding.' },
      { value: 'confirm_and_start', label: 'confirm_and_start', desc: 'Save and immediately start the first cycle.' },
      { value: 'edit', label: 'edit', desc: 'Change one field before continuing.' },
    ],
  };
}

async function promptInlineQuestion(
  sessionId: string,
  question: OnboardingQuestion,
  reader: NonTtyLineReader,
  timeoutMs: number
): Promise<{ kind: 'answered'; value: string } | { kind: 'fallback' }> {
  let invalidAttempts = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const payload: OnboardingPromptPayload = {
      type: ONBOARDING_PROMPT_PAYLOAD_TYPE,
      session_id: sessionId,
      message: `Provide answer for '${question.id}' as JSON {"type":"${ONBOARDING_ANSWER_PAYLOAD_TYPE}","question_id":"${question.id}","value":"..."}`,
      question,
      timeout_ms: timeoutMs,
    };
    console.log(`Onboarding prompt: ${question.id} (${question.label})`);
    console.log(JSON.stringify(payload, null, 2));

    const response = await reader.nextLine(timeoutMs);
    if (response.status !== 'line') {
      return { kind: 'fallback' };
    }

    const parsed = parseInlineAnswer(response.line);
    if (parsed.type && parsed.type !== ONBOARDING_ANSWER_PAYLOAD_TYPE) {
      invalidAttempts += 1;
      console.warn(`[WARN] Ignoring answer with unexpected type: ${parsed.type}`);
      if (invalidAttempts > NON_INTERACTIVE_MAX_INVALID_RETRIES) return { kind: 'fallback' };
      continue;
    }
    if (parsed.question_id && parsed.question_id !== question.id) {
      invalidAttempts += 1;
      console.warn(`[WARN] Ignoring answer for '${parsed.question_id}'. Expected '${question.id}'.`);
      if (invalidAttempts > NON_INTERACTIVE_MAX_INVALID_RETRIES) return { kind: 'fallback' };
      continue;
    }

    const normalized = normalizeQuestionAnswer(question, parsed.value);
    if (!normalized) {
      invalidAttempts += 1;
      console.warn(`[WARN] Invalid value for '${question.id}'.`);
      if (invalidAttempts > NON_INTERACTIVE_MAX_INVALID_RETRIES) return { kind: 'fallback' };
      continue;
    }
    return { kind: 'answered', value: normalized };
  }
}

async function promptInlineReview(
  sessionId: string,
  state: InlineAnswersState,
  reader: NonTtyLineReader,
  timeoutMs: number
): Promise<{ kind: 'confirm' } | { kind: 'edit'; field: string } | { kind: 'fallback' }> {
  let invalidAttempts = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const payload = buildReviewPayload(sessionId, state);
    console.log('Onboarding review: confirm choices or edit one field (mode, builder, planner_provider, reviewer, reviewer_model, prd_text).');
    console.log(JSON.stringify(payload, null, 2));

    const response = await reader.nextLine(timeoutMs);
    if (response.status !== 'line') return { kind: 'fallback' };

    const parsed = parseInlineAnswer(response.line);
    if (parsed.type && parsed.type !== ONBOARDING_ANSWER_PAYLOAD_TYPE) {
      invalidAttempts += 1;
      console.warn(`[WARN] Ignoring review answer with unexpected type: ${parsed.type}`);
      if (invalidAttempts > NON_INTERACTIVE_MAX_INVALID_RETRIES) return { kind: 'fallback' };
      continue;
    }

    const action = typeof parsed.action === 'string' ? parsed.action.trim().toLowerCase() : '';
    if (action === 'confirm') return { kind: 'confirm' };
    if (action === 'edit') {
      const field = typeof parsed.field === 'string' ? parsed.field.trim() : '';
      if (
        field === 'mode' ||
        field === 'builder' ||
        field === 'planner_provider' ||
        field === 'orchestrator_model' ||
        field === 'reviewer' ||
        field === 'reviewer_model' ||
        field === 'prd_text'
      ) {
        return { kind: 'edit', field };
      }
    }

    const rawValue = typeof parsed.value === 'string' ? parsed.value.trim().toLowerCase() : '';
    if (rawValue === 'confirm') return { kind: 'confirm' };
    if (rawValue.startsWith('edit')) {
      const field = rawValue.replace(/^edit[:\s]*/, '').trim();
      if (field.length > 0) return { kind: 'edit', field };
    }

    invalidAttempts += 1;
    console.warn("[WARN] Invalid review answer. Use {'type':'envoi.onboarding.answer.v1','action':'confirm'} or {'type':'envoi.onboarding.answer.v1','action':'edit','field':'...'}.");
    if (invalidAttempts > NON_INTERACTIVE_MAX_INVALID_RETRIES) return { kind: 'fallback' };
  }
}

async function runInlineNonInteractiveWizard(params: {
  sessionId: string;
  defaults: OnboardingQuestionInputs['defaults'];
  initial: InlineAnswersState;
  answerBag: Record<string, unknown>;
}): Promise<InlineWizardResult> {
  const reader = createNonTtyLineReader(input);
  try {
    const state: InlineAnswersState = { ...params.initial };
    const mergedAnswerBag: Record<string, unknown> = { ...params.answerBag };

    // eslint-disable-next-line no-constant-condition
    while (true) {
      const questions = buildNonInteractiveQuestions({
        mode: state.mode,
        builder: state.builder,
        plannerProvider: state.plannerProvider,
        orchestratorModel: state.orchestratorModel,
        builderModel: state.builderModel,
        reviewer: state.reviewer,
        reviewerModel: state.reviewerModel,
        prdText: state.prdText,
        defaults: params.defaults,
      });

      for (const question of questions) {
        const promptResult = await promptInlineQuestion(
          params.sessionId,
          question,
          reader,
          NON_INTERACTIVE_ANSWER_TIMEOUT_MS
        );
        if (promptResult.kind === 'fallback') {
          const unresolved = buildNonInteractiveQuestions({
            mode: state.mode,
            builder: state.builder,
            plannerProvider: state.plannerProvider,
            orchestratorModel: state.orchestratorModel,
            builderModel: state.builderModel,
            reviewer: state.reviewer,
            reviewerModel: state.reviewerModel,
            prdText: state.prdText,
            defaults: params.defaults,
          });
          return {
            kind: 'fallback',
            questions: unresolved.length > 0 ? unresolved : [question],
            answers: mergedAnswerBag,
          };
        }
        applyQuestionValue(state, question.id, promptResult.value);
        mergedAnswerBag[question.id] = promptResult.value;
      }

      const reviewResult = await promptInlineReview(
        params.sessionId,
        state,
        reader,
        NON_INTERACTIVE_ANSWER_TIMEOUT_MS
      );
      if (reviewResult.kind === 'fallback') {
        const unresolved = buildNonInteractiveQuestions({
          mode: state.mode,
          builder: state.builder,
          plannerProvider: state.plannerProvider,
          orchestratorModel: state.orchestratorModel,
          builderModel: state.builderModel,
          reviewer: state.reviewer,
          reviewerModel: state.reviewerModel,
          prdText: state.prdText,
          defaults: params.defaults,
        });
        if (unresolved.length > 0) {
          return { kind: 'fallback', questions: unresolved, answers: mergedAnswerBag };
        }
        return {
          kind: 'fallback',
          questions: [
            {
              id: 'prd_text',
              label: 'Re-send PRD/context to confirm onboarding in non-interactive mode',
              type: 'multiline',
              required: true,
              help: 'No review confirmation was received. Provide PRD and resume onboarding.',
            },
          ],
          answers: mergedAnswerBag,
        };
      }
      if (reviewResult.kind === 'confirm') {
        return { kind: 'completed', answers: state };
      }
      clearInlineField(state, reviewResult.field);
      delete mergedAnswerBag[reviewResult.field];
      if (reviewResult.field === 'reviewer') {
        delete mergedAnswerBag.reviewer_model;
      }
      if (reviewResult.field === 'planner_provider') {
        delete mergedAnswerBag.orchestrator_model;
      }
    }
  } finally {
    reader.close();
  }
}

async function emitOnboardingFallback(params: {
  workspaceDir: string;
  sessionId: string;
  questions: OnboardingQuestion[];
  answers: Record<string, unknown>;
  policy: OnboardingNeedsInputPolicy;
}): Promise<void> {
  const sessionPath = onboardingSessionPath(params.workspaceDir);
  await persistOnboardingSession(sessionPath, {
    v: 1,
    type: 'envoi.onboarding.session.v1',
    session_id: params.sessionId,
    status: 'waiting_input',
    updated_at: new Date().toISOString(),
    pending_question_ids: params.questions.map((question) => question.id),
    answers: params.answers,
  });
  const exitCode = computeOnboardingNeedsInputExitCode(params.policy.strictExit);
  const payload = buildQuestionPayload(params.sessionId, params.questions, params.workspaceDir, exitCode);
  const missing = params.questions.map((question) => question.id).join(',');

  if (params.policy.outputMode === 'json') {
    console.log(JSON.stringify(payload));
  } else if (params.policy.outputMode === 'verbose') {
    console.log('Onboarding needs your input before continuing.');
    console.log(`- Missing: ${params.questions.map((question) => question.id).join(', ')}`);
    console.log(`- Reply with '${CLI_NAME} start --answers-json <json>' or '${CLI_NAME} start --answers-file <path>'.`);
    console.log(JSON.stringify(payload, null, 2));
  } else {
    console.log(`Onboarding input needed: missing=${missing} session=${params.sessionId} (use --answers-json/--answers-file)`);
  }
  process.exitCode = exitCode;
}

function buildReviewQuestion(state: {
  mode?: string;
  builder?: string;
  plannerProvider?: string;
  orchestratorModel?: string;
  builderModel?: string;
  reviewer?: string;
  reviewerModel?: string;
  prdText?: string;
}): OnboardingQuestion {
  const safeMode = (() => {
    try {
      return normalizeLoopMode(state.mode);
    } catch {
      return undefined;
    }
  })();
  const safeBuilder = (() => {
    try {
      return normalizeBuilderChoice(state.builder);
    } catch {
      return undefined;
    }
  })();
  const safeReviewer = (() => {
    try {
      return parseOptionalReviewerChoice(state.reviewer);
    } catch {
      return undefined;
    }
  })();
  const safePlannerProvider = (() => {
    try {
      return normalizePlannerProvider(state.plannerProvider);
    } catch {
      return undefined;
    }
  })();
  const payload = buildReviewPayload('inline-review', {
    mode: safeMode,
    builder: safeBuilder,
    plannerProvider: safePlannerProvider,
    orchestratorModel: state.orchestratorModel,
    builderModel: state.builderModel,
    reviewer: safeReviewer,
    reviewerModel: state.reviewerModel,
    prdText: state.prdText,
  });
  const summary = payload.summary;
  const reviewHint = [
    `mode=${summary.mode ?? 'n/a'}`,
    `builder=${summary.builder ?? 'n/a'}`,
    `planner_provider=${summary.planner_provider ?? 'n/a'}`,
    `orchestrator_model=${summary.orchestrator_model ?? 'n/a'}`,
    `reviewer=${summary.reviewer ?? 'n/a'}`,
    `reviewer_model=${summary.reviewer_model ?? 'n/a'}`,
    `prd_preview=${summary.prd_preview ?? '(empty)'}`,
    `prd_path=${summary.prd_path ?? 'envoi/PRD.md'}`,
    `prd_full=${summary.prd_full ?? '(empty)'}`,
  ].join('\n');

  return {
    id: 'review',
    label: 'Review onboarding choices',
    type: 'text',
    required: true,
    help: `${reviewHint}\nReply with 'confirm', 'confirm_and_start', or 'edit:<field>' (field: mode|builder|planner_provider|reviewer|reviewer_model|prd_text).`,
  };
}

function clearAnswerByField(answers: Record<string, unknown>, field: string): void {
  if (field === 'mode') delete answers.mode;
  if (field === 'builder') {
    delete answers.builder;
    delete answers.builder_model;
  }
  if (field === 'planner_provider') {
    delete answers.planner_provider;
    delete answers.orchestrator_model;
  }
  if (field === 'orchestrator_model') delete answers.orchestrator_model;
  if (field === 'builder_model') delete answers.builder_model;
  if (field === 'reviewer') {
    delete answers.reviewer;
    delete answers.reviewer_model;
  }
  if (field === 'reviewer_model') delete answers.reviewer_model;
  if (field === 'prd_text') delete answers.prd_text;
}

function stripOnboardingMetaAnswers(answers: Record<string, unknown>): Record<string, unknown> {
  const cleaned: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(answers)) {
    if (key.startsWith('__')) continue;
    cleaned[key] = value;
  }
  return cleaned;
}

function formatCompactQuestionLine(sessionId: string, question: OnboardingQuestion): string {
  const base = `Onboarding question: id=${question.id} session=${sessionId} prompt="${question.label}"`;
  if (question.id === 'review') {
    return `${base} actions=confirm|confirm_and_start|edit:<field>`;
  }
  if (question.type === 'select' && Array.isArray(question.choices) && question.choices.length > 0) {
    const choices = question.choices.map((choice) => choice.value).join('|');
    return `${base} choices=${choices}`;
  }
  if (question.type === 'multiline') {
    return `${base} answer=<multiline text>`;
  }
  return `${base} answer=<text>`;
}

async function emitNextQuestion(params: {
  workspaceDir: string;
  sessionId: string;
  question: OnboardingQuestion;
  pendingQuestionIds: string[];
  answers: Record<string, unknown>;
  awaitingReview?: boolean;
  policy: OnboardingNeedsInputPolicy;
}): Promise<void> {
  const sessionPath = onboardingSessionPath(params.workspaceDir);
  await persistOnboardingSession(sessionPath, {
    v: 1,
    type: 'envoi.onboarding.session.v1',
    session_id: params.sessionId,
    status: 'waiting_input',
    updated_at: new Date().toISOString(),
    current_step: params.question.id,
    awaiting_review: Boolean(params.awaitingReview),
    pending_question_ids: params.pendingQuestionIds,
    answers: params.answers,
  });
  const exitCode = computeOnboardingNeedsInputExitCode(params.policy.strictExit);
  const payload = buildNextQuestionPayload(params.sessionId, params.question, params.workspaceDir, exitCode);
  if (params.policy.outputMode === 'json') {
    console.log(JSON.stringify(payload));
  } else if (params.policy.outputMode === 'verbose') {
    console.log('Onboarding needs your input before continuing.');
    console.log(`- Next: ${params.question.id}`);
    console.log(JSON.stringify(payload, null, 2));
  } else {
    console.log(formatCompactQuestionLine(params.sessionId, params.question));
  }
  process.exitCode = exitCode;
}

function parseReviewAction(value: string | undefined):
  | { action: 'confirm' }
  | { action: 'confirm_and_start' }
  | { action: 'edit'; field: string }
  | null {
  if (!value) return null;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'confirm') return { action: 'confirm' };
  if (normalized === 'confirm_and_start') return { action: 'confirm_and_start' };
  if (normalized.startsWith('edit:')) {
    const field = normalized.slice('edit:'.length).trim();
    if (
      field === 'mode' ||
      field === 'builder' ||
      field === 'planner_provider' ||
      field === 'orchestrator_model' ||
      field === 'reviewer' ||
      field === 'reviewer_model' ||
      field === 'prd_text'
    ) {
      return { action: 'edit', field };
    }
  }
  return null;
}

function withDefaultCursorConfig(
  existing?: EnvoiConfig['builder']['cursor']
): NonNullable<EnvoiConfig['builder']['cursor']> {
  const defaultArgs = ['agent', '--print', '--output-format', 'text', '--workspace', '.', '--force'];
  return {
    driver_kind: (existing?.driver_kind ?? 'cursor_agent') as any,
    command: existing?.command ?? 'cursor',
    args: existing?.args?.length ? existing.args : defaultArgs,
    timeout_seconds: existing?.timeout_seconds ?? 300,
    output_file: existing?.output_file ?? 'BUILDER_RESULT.json',
  };
}

function withDefaultReviewerConfig(workspaceDir: string, existing?: EnvoiConfig['reviewer']): NonNullable<EnvoiConfig['reviewer']> {
  return {
    enabled: true,
    engine: existing?.engine ?? 'codex',
    command: existing?.command ?? 'codex',
    model: existing?.model ?? 'gpt-5',
    max_turns: existing?.max_turns ?? 2,
    max_budget_usd: existing?.max_budget_usd ?? 0.6,
    auth: {
      mode: existing?.auth?.mode ?? 'auto',
      ci_requires_api_key: existing?.auth?.ci_requires_api_key ?? true,
      api_key_env: existing?.auth?.api_key_env ?? 'CODEX_API_KEY',
    },
    trigger: {
      on_verify_fail: existing?.trigger?.on_verify_fail ?? true,
      on_repeated_stop: existing?.trigger?.on_repeated_stop ?? true,
      stop_window_ticks: existing?.trigger?.stop_window_ticks ?? 5,
      max_stops_in_window: existing?.trigger?.max_stops_in_window ?? 2,
      on_high_risk_paths: existing?.trigger?.on_high_risk_paths ?? true,
      high_risk_globs: existing?.trigger?.high_risk_globs ?? ['src/**', 'app/**', 'packages/**', 'infra/**', '**/*.sql'],
      diff_fraction_threshold: existing?.trigger?.diff_fraction_threshold ?? 0.25,
    },
    schema_file: existing?.schema_file ?? `${workspaceDir}/schemas/reviewer_result.schema.json`,
    system_prompt_file: existing?.system_prompt_file ?? `${workspaceDir}/prompts/reviewer.system.txt`,
    user_prompt_file: existing?.user_prompt_file ?? `${workspaceDir}/prompts/reviewer.user.txt`,
  };
}

function isNonEmptyContent(value: string): boolean {
  return value.trim().length > 0;
}

export function isMeaningfulPrdText(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.length === 0) return false;

  const compact = trimmed
    .replace(/^#\s*PRD\s*$/im, '')
    .replace(/\(Paste the user PRD here\. This is the source of truth\.\)/gi, '')
    .trim();

  return compact.length >= 30;
}

export interface OnboardCommandResult {
  needsInput: boolean;
}

interface OnboardingAuthIssue {
  key: string;
  roles: Array<'planner' | 'builder' | 'reviewer'>;
  reason: string;
  remediation: string[];
  details?: string;
}

function roleLabel(role: 'planner' | 'builder' | 'reviewer'): string {
  if (role === 'planner') return 'planner';
  if (role === 'builder') return 'builder';
  return 'reviewer';
}

function isAuthenticatedStatus(status: 'authenticated' | 'api_key_present' | 'unauthenticated' | 'unknown'): boolean {
  return status === 'authenticated' || status === 'api_key_present';
}

function mergeAuthIssue(
  issues: Map<string, OnboardingAuthIssue>,
  issue: OnboardingAuthIssue
): void {
  const existing = issues.get(issue.key);
  if (!existing) {
    issues.set(issue.key, issue);
    return;
  }
  const mergedRoles = new Set([...existing.roles, ...issue.roles]);
  existing.roles = Array.from(mergedRoles);
}

function formatAuthIssue(issue: OnboardingAuthIssue): string {
  const roles = issue.roles.map((role) => roleLabel(role)).join('/');
  const details = issue.details ? ` (${issue.details})` : '';
  const remediation = issue.remediation.map((step) => `- ${step}`).join('\n');
  return `${roles}: ${issue.reason}${details}\n${remediation}`;
}

function buildAuthQuestion(issues: OnboardingAuthIssue[]): OnboardingQuestion {
  const helpLines = [
    'Authenticate the required CLI(s), then reply with: done',
    ...issues.flatMap((issue) => formatAuthIssue(issue).split('\n')),
  ];
  return {
    id: 'auth',
    label: 'Authentication required before continuing onboarding',
    type: 'text',
    required: true,
    default: 'done',
    help: helpLines.join('\n'),
  };
}

function printAuthIssues(issues: OnboardingAuthIssue[]): void {
  console.log('\nAuthentication required before continuing onboarding:');
  for (const issue of issues) {
    console.log(`- ${formatAuthIssue(issue).replace(/\n/g, '\n  ')}`);
  }
}

async function collectOnboardingAuthIssues(params: {
  config: EnvoiConfig;
  plannerProvider: PlannerProvider;
  builderChoice: BuilderChoice;
  reviewerChoice: ReviewerChoice;
}): Promise<OnboardingAuthIssue[]> {
  const issues = new Map<string, OnboardingAuthIssue>();
  const claudeCommand = params.config.claude_code_cli.command ?? 'claude';

  let claudeCheckPromise: ReturnType<typeof checkClaudeCodeCli> | undefined;
  let codexCheckPromise: ReturnType<typeof checkCodexCli> | undefined;
  let cursorCheckPromise: ReturnType<typeof checkCursorAgent> | undefined;

  const checkClaude = async () => {
    if (!claudeCheckPromise) claudeCheckPromise = checkClaudeCodeCli(claudeCommand);
    return await claudeCheckPromise;
  };

  const checkCodex = async () => {
    if (!codexCheckPromise) codexCheckPromise = checkCodexCli(params.config);
    return await codexCheckPromise;
  };

  const checkCursor = async () => {
    if (!cursorCheckPromise) cursorCheckPromise = checkCursorAgent(params.config);
    return await cursorCheckPromise;
  };

  if (params.plannerProvider === 'claude_code') {
    const claude = await checkClaude();
    if (!claude.cli_available) {
      mergeAuthIssue(issues, {
        key: 'claude-missing-cli',
        roles: ['planner'],
        reason: `CLI '${claude.command}' is not available`,
        remediation: [
          `Install Claude Code and ensure '${claude.command}' is on your PATH.`,
        ],
        details: claude.details,
      });
    } else if (!isAuthenticatedStatus(claude.auth_status)) {
      mergeAuthIssue(issues, {
        key: 'claude-auth-required',
        roles: ['planner'],
        reason: `CLI '${claude.command}' is not authenticated`,
        remediation: [
          `Run '${claude.command}' and complete login/authentication in the CLI.`,
          "If you use API auth, set ANTHROPIC_API_KEY in your environment.",
        ],
        details: claude.details,
      });
    }
  } else {
    const codex = await checkCodex();
    if (!codex.cli_available) {
      mergeAuthIssue(issues, {
        key: 'codex-missing-cli',
        roles: ['planner'],
        reason: "CLI 'codex' is not available",
        remediation: [
          "Install Codex CLI and ensure 'codex' is on your PATH.",
        ],
      });
    } else if (!isAuthenticatedStatus(codex.auth_status)) {
      mergeAuthIssue(issues, {
        key: 'codex-auth-required',
        roles: ['planner'],
        reason: "CLI 'codex' is not authenticated",
        remediation: [
          "Run 'codex login' in this shell.",
          'Or set CODEX_API_KEY in your environment.',
        ],
      });
    }
  }

  if (params.builderChoice === 'cursor') {
    const cursor = await checkCursor();
    if (!cursor.cli_available) {
      mergeAuthIssue(issues, {
        key: 'cursor-missing-cli',
        roles: ['builder'],
        reason: `CLI '${cursor.command}' is not available`,
        remediation: [
          `Install Cursor CLI and ensure '${cursor.command}' is on your PATH.`,
        ],
        details: cursor.details,
      });
    } else if (!cursor.agent_available) {
      mergeAuthIssue(issues, {
        key: 'cursor-agent-missing',
        roles: ['builder'],
        reason: `'${cursor.command} agent' is unavailable`,
        remediation: [
          `Update Cursor CLI so '${cursor.command} agent' is supported.`,
        ],
        details: cursor.details,
      });
    } else if (!isAuthenticatedStatus(cursor.auth_status)) {
      mergeAuthIssue(issues, {
        key: 'cursor-auth-required',
        roles: ['builder'],
        reason: `'${cursor.command} agent' is not authenticated`,
        remediation: [
          `Run '${cursor.command} agent login' in this shell.`,
          'Or set CURSOR_API_KEY in your environment.',
        ],
        details: cursor.details,
      });
    }
  }

  if (params.reviewerChoice === 'codex') {
    const codex = await checkCodex();
    if (!codex.cli_available) {
      mergeAuthIssue(issues, {
        key: 'codex-missing-cli',
        roles: ['reviewer'],
        reason: "CLI 'codex' is not available",
        remediation: [
          "Install Codex CLI and ensure 'codex' is on your PATH.",
        ],
      });
    } else if (!isAuthenticatedStatus(codex.auth_status)) {
      mergeAuthIssue(issues, {
        key: 'codex-auth-required',
        roles: ['reviewer'],
        reason: "CLI 'codex' is not authenticated",
        remediation: [
          "Run 'codex login' in this shell.",
          'Or set CODEX_API_KEY in your environment.',
        ],
      });
    }
  }

  return Array.from(issues.values());
}

function normalizeReviewerChoice(value?: string): ReviewerChoice {
  if (!value || value.trim() === '') return 'none';
  const normalized = value.trim().toLowerCase();
  if (normalized === 'none' || normalized === 'off' || normalized === 'disabled' || normalized === 'no') {
    return 'none';
  }
  if (normalized === 'codex' || normalized === 'on' || normalized === 'enabled' || normalized === 'yes') {
    return 'codex';
  }
  throw new Error(`Invalid reviewer value: ${value}. Must be 'none' or 'codex'.`);
}

function parseOptionalReviewerChoice(value?: string): ReviewerChoice | undefined {
  if (value === undefined) return undefined;
  return normalizeReviewerChoice(value);
}

async function ensureRepoRootCwd(): Promise<void> {
  if (isGitRepo()) {
    const top = getGitTopLevel();
    if (top) process.chdir(top);
  }
}

async function ensureGitRepoInitialized(): Promise<void> {
  if (isGitRepo()) return;
  const result = spawnSync('git', ['init'], { stdio: 'pipe' });
  if (result.status !== 0) {
    const error = result.stderr?.toString('utf-8').trim() || 'git init failed';
    throw new Error(`Unable to initialize git repository: ${error}`);
  }
  console.log('Initialized git repository for Envoi onboarding.');
}

async function resolveConfigPath(configPath?: string): Promise<string> {
  if (configPath) return resolve(configPath);
  const found = await findConfigFile();
  if (!found) {
    throw new ConfigError(
      `Configuration file not found. Expected ${CONFIG_FILE_NAME} in current directory or parent directories.`
    );
  }
  return found;
}

async function ensureInitialized(forceInit: boolean): Promise<void> {
  const existing = await findConfigFile();
  if (existing && !forceInit) return;
  await initCommand({ force: forceInit, showNextSteps: false });
}

async function promptMultiline(label: string): Promise<string> {
  const rl = readline.createInterface({ input, output });
  try {
    console.log(`\nPaste ${label} now. End input with a line containing only: END\n`);
    const lines: string[] = [];
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const line = await rl.question('');
      if (line.trim() === 'END') break;
      lines.push(line);
    }
    return lines.join('\n').trim();
  } finally {
    rl.close();
  }
}

async function promptYesNo(question: string, defaultValue: boolean): Promise<boolean> {
  if (!input.isTTY) return defaultValue;
  const rl = readline.createInterface({ input, output });
  try {
    const hint = defaultValue ? 'Y/n' : 'y/N';
    const answer = (await rl.question(`${question} [${hint}]: `)).trim().toLowerCase();
    if (!answer) return defaultValue;
    if (answer === 'y' || answer === 'yes') return true;
    if (answer === 'n' || answer === 'no') return false;
    return defaultValue;
  } finally {
    rl.close();
  }
}

export const PRD_DISCOVERY_CANDIDATES = [
  'PRD.md',
  'prd.md',
  'docs/PRD.md',
  'docs/prd.md',
  'specs/PRD.md',
  'product/PRD.md',
] as const;

export async function discoverLocalPrdCandidates(repoRoot: string): Promise<string[]> {
  const existing: string[] = [];
  const seen = new Set<string>();
  for (const relativePath of PRD_DISCOVERY_CANDIDATES) {
    const fullPath = join(repoRoot, relativePath);
    try {
      const content = (await readFile(fullPath, 'utf-8')).trim();
      if (content.length > 0) {
        const key = fullPath.toLowerCase();
        if (!seen.has(key)) {
          seen.add(key);
          existing.push(fullPath);
        }
      }
    } catch {
      // Ignore missing/unreadable candidates.
    }
  }
  return existing;
}

async function choosePrdCandidate(paths: string[], defaultPath: string): Promise<string | null> {
  if (paths.length === 0) return null;
  if (!input.isTTY || paths.length === 1) return paths[0];

  const rl = readline.createInterface({ input, output });
  try {
    console.log('\nFound multiple PRD files:');
    paths.forEach((path, index) => {
      console.log(`  ${index + 1}. ${path}`);
    });
    console.log(`  ${paths.length + 1}. Open ${defaultPath} in editor instead`);
    const answer = (await rl.question(`Select [1-${paths.length + 1}] (default 1): `)).trim();
    if (answer === '') return paths[0];
    const index = Number.parseInt(answer, 10);
    if (index >= 1 && index <= paths.length) {
      return paths[index - 1];
    }
    if (index === paths.length + 1) {
      return null;
    }
    throw new Error('Invalid selection');
  } finally {
    rl.close();
  }
}

function getEditorCommand(): string | null {
  const editor = (process.env.VISUAL ?? process.env.EDITOR ?? '').trim();
  return editor.length > 0 ? editor : null;
}

async function openEditorForPrd(prdPath: string): Promise<{ ok: boolean; content: string; reason?: string }> {
  const editor = getEditorCommand();
  if (!editor) {
    return {
      ok: false,
      content: '',
      reason: 'No $VISUAL or $EDITOR configured.',
    };
  }
  const parts = editor.split(/\s+/).filter(Boolean);
  const [editorCmd, ...editorArgs] = parts;
  if (!editorCmd) {
    return {
      ok: false,
      content: '',
      reason: 'Invalid editor command.',
    };
  }
  const result = spawnSync(editorCmd, [...editorArgs, prdPath], { stdio: 'inherit' });
  if (result.status !== 0) {
    return {
      ok: false,
      content: '',
      reason: `Editor exited with code ${result.status ?? 'unknown'}`,
    };
  }
  const content = (await readFile(prdPath, 'utf-8')).trim();
  return { ok: true, content };
}

async function readPipedStdin(timeoutMs = NON_INTERACTIVE_STDIN_PROBE_TIMEOUT_MS): Promise<string> {
  if (input.readableEnded) return '';

  return await new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let sawData = false;
    let done = false;

    const finish = (text: string) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      input.off('data', onData);
      input.off('end', onEnd);
      input.off('error', onError);
      resolve(text);
    };

    const onData = (chunk: string | Buffer) => {
      sawData = true;
      chunks.push(Buffer.from(chunk));
    };

    const onEnd = () => {
      finish(Buffer.concat(chunks).toString('utf-8').trim());
    };

    const onError = () => {
      finish('');
    };

    const timer = setTimeout(() => {
      if (!sawData) {
        finish('');
      }
    }, timeoutMs);

    input.on('data', onData);
    input.on('end', onEnd);
    input.on('error', onError);
  });
}

async function promptChoice(
  question: string,
  options: Array<{ value: string; label: string; desc?: string }>,
  defaultValue?: string
): Promise<string> {
  const rl = readline.createInterface({ input, output });
  try {
    console.log(`\n${question}`);
    options.forEach((option, index) => {
      const suffix = defaultValue === option.value ? ' (default)' : '';
      console.log(`  ${index + 1}. ${option.label}${suffix}`);
      if (option.desc) console.log(`     ${option.desc}`);
    });
    const answer = (await rl.question(`Select [1-${options.length}]${defaultValue ? ` (Enter for ${defaultValue})` : ''}: `)).trim();
    if (answer === '' && defaultValue) return defaultValue;
    const index = Number.parseInt(answer, 10);
    if (index >= 1 && index <= options.length) return options[index - 1].value;
    const direct = options.find((option) => option.value === answer);
    if (direct) return direct.value;
    throw new Error('Invalid selection');
  } finally {
    rl.close();
  }
}

async function capturePrdFromInteractiveMenu(workspacePrdPath: string): Promise<PrdCaptureResult> {
  const repoRoot = process.cwd();
  const discovered = await discoverLocalPrdCandidates(repoRoot);

  const sourceChoiceOptions: Array<{ value: string; label: string; desc?: string }> = [
    {
      value: 'paste',
      label: 'Paste PRD inline',
      desc: 'Fastest when you already have the brief in chat or clipboard.',
    },
  ];

  if (discovered.length > 0) {
    sourceChoiceOptions.push({
      value: 'existing',
      label: `Use existing PRD file (${discovered.length} found)`,
      desc: 'Reuses your local PRD document.',
    });
  }

  sourceChoiceOptions.push({
    value: 'editor',
    label: 'Open editor for envoi/PRD.md',
    desc: 'Writes directly to workspace source-of-truth.',
  });

  sourceChoiceOptions.push({
    value: 'skip',
    label: 'Skip for now',
    desc: 'Setup continues; planner will wait for your brief.',
  });

  const sourceChoice = await promptChoice(
    'How do you want to describe your project?',
    sourceChoiceOptions,
    discovered.length > 0 ? 'existing' : 'paste'
  );

  if (sourceChoice === 'existing') {
    const selected = await choosePrdCandidate(discovered, workspacePrdPath);
    if (selected) {
      const content = (await readFile(selected, 'utf-8')).trim();
      return { text: content, source: 'existing' };
    }
  }

  if (sourceChoice === 'editor') {
    console.log(`\nOpening ${workspacePrdPath}...`);
    const editorResult = await openEditorForPrd(workspacePrdPath);
    if (editorResult.ok) return { text: editorResult.content, source: 'editor' };

    console.log(`\n[WARN] Could not open editor: ${editorResult.reason}`);
    const fallback = await promptMultiline('your PRD (markdown)');
    return { text: fallback, source: 'paste' };
  }

  if (sourceChoice === 'skip') {
    return { text: '', source: 'skip' };
  }

  return {
    text: await promptMultiline('your PRD (markdown)'),
    source: 'paste',
  };
}

async function collectPrdText(options: { prdFile?: string; prdText?: string }, workspacePrdPath: string): Promise<PrdCaptureResult> {
  if (isNonEmptyContent(options.prdText ?? '')) {
    return { text: options.prdText!.trim(), source: 'paste' };
  }

  if (options.prdFile) {
    return {
      text: (await readFile(resolve(options.prdFile), 'utf-8')).trim(),
      source: 'file',
    };
  }

  if (!input.isTTY) {
    const piped = await readPipedStdin();
    if (isNonEmptyContent(piped)) {
      return { text: piped, source: 'stdin' };
    }
    return { text: '', source: 'skip' };
  }

  return await capturePrdFromInteractiveMenu(workspacePrdPath);
}

async function promptStartIntentIfNeeded(showTourPrompt: boolean): Promise<StartIntent> {
  if (!showTourPrompt || !input.isTTY) return 'setup';
  const choice = await promptChoice(
    'How would you like to begin?',
    [
      { value: 'tour', label: 'Tour first', desc: 'Quick walkthrough of roles, commands, and flow.' },
      { value: 'setup', label: 'Setup now', desc: 'Go straight to project onboarding.' },
    ],
    'setup'
  );
  return choice === 'tour' ? 'tour' : 'setup';
}

function printTour(): void {
  console.log(`\n${PRODUCT_NAME} tour`);
  console.log('- You decide direction, approve, and unblock.');
  console.log('- Planner sequences milestones and budgets.');
  console.log('- Builder implements scoped tasks.');
  console.log('- Checker verifies and blocks unsafe output.');
  console.log('- One tick = plan -> edit -> verify -> stop.');
  console.log(`- Main commands: ${CLI_NAME} tick, ${CLI_NAME} loop, ${CLI_NAME} status, ${CLI_NAME} undo.`);
}

function checkCommandVersion(command: string): { available: boolean; version?: string } {
  const first = spawnSync(command, ['--version'], { stdio: 'pipe' });
  if (first.status === 0) {
    const version = `${first.stdout ?? ''}`.trim() || undefined;
    return { available: true, version };
  }

  const second = spawnSync(command, ['-v'], { stdio: 'pipe' });
  if (second.status === 0) {
    const version = `${second.stdout ?? ''}`.trim() || undefined;
    return { available: true, version };
  }

  return { available: false };
}

export function extractRoadmapMilestones(prompt: string, extraLines: string[] = []): string[] {
  const lines = [...prompt.split(/\r?\n/), ...extraLines]
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  const milestones: string[] = [];
  const seen = new Set<string>();

  for (const line of lines) {
    const normalized = line.replace(/^[-*]\s+/, '').replace(/^\d+[.)]\s+/, '').trim();
    const tagged = normalized.match(/^(M\d+[A-Za-z0-9_-]*)\s*[:\-]\s*(.+)$/i);
    if (tagged) {
      const entry = `${tagged[1].toUpperCase()}: ${tagged[2].trim()}`;
      if (!seen.has(entry.toLowerCase())) {
        seen.add(entry.toLowerCase());
        milestones.push(entry);
      }
      continue;
    }

    if (/^milestone\b/i.test(normalized) && normalized.includes(':')) {
      if (!seen.has(normalized.toLowerCase())) {
        seen.add(normalized.toLowerCase());
        milestones.push(normalized);
      }
    }
  }

  return milestones.slice(0, 7);
}

function mergeRoadmapLabels(...groups: string[][]): string[] {
  const merged: string[] = [];
  const seen = new Set<string>();

  for (const group of groups) {
    for (const raw of group) {
      const normalized = raw.trim().replace(/\s+/g, ' ');
      if (!normalized) continue;
      const key = normalized.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(normalized);
      if (merged.length >= 7) return merged;
    }
  }

  return merged;
}

export function extractRoadmapMilestonesFromPrd(prdText: string): string[] {
  if (!isMeaningfulPrdText(prdText)) return [];

  const explicitMilestones = extractRoadmapMilestones(prdText);
  const lines = prdText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  const topicalMilestones: string[] = [];
  const ignoredHeadings = new Set([
    'prd',
    'overview',
    'summary',
    'context',
    'problem',
    'goals',
    'goal',
    'non goals',
    'non goal',
    'requirements',
    'functional requirements',
    'non functional requirements',
    'scope',
    'out of scope',
    'acceptance criteria',
    'constraints',
    'risks',
    'metrics',
    'timeline',
    'rollout',
    'appendix',
  ]);

  for (const line of lines) {
    const normalized = line.replace(/^[-*]\s+/, '').replace(/^\d+[.)]\s+/, '').trim();
    if (!normalized) continue;

    const thematic = normalized.match(/^(?:milestone|phase|sprint|epic)\s*[:\-]\s*(.+)$/i);
    if (thematic?.[1]) {
      topicalMilestones.push(thematic[1].trim());
      continue;
    }

    const heading = normalized.match(/^#{1,3}\s+(.+)$/);
    if (!heading?.[1]) continue;
    const title = heading[1].trim();
    const canonical = title.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    if (!canonical || ignoredHeadings.has(canonical)) continue;
    if (title.length < 4 || title.length > 90) continue;
    topicalMilestones.push(title);
  }

  let nextMilestoneIndex = 1;
  for (const label of explicitMilestones) {
    const match = label.match(/^M(\d+)/i);
    if (!match) continue;
    const id = Number.parseInt(match[1], 10);
    if (Number.isFinite(id) && id >= nextMilestoneIndex) {
      nextMilestoneIndex = id + 1;
    }
  }
  const generatedMilestones = topicalMilestones.slice(0, 7).map((title) => {
    const label = `M${nextMilestoneIndex}: ${title}`;
    nextMilestoneIndex += 1;
    return label;
  });
  return mergeRoadmapLabels(explicitMilestones, generatedMilestones);
}

export function extractRoadmapQuestions(prompt: string): string[] {
  const lines = prompt
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  const questions: string[] = [];
  const seen = new Set<string>();

  for (const line of lines) {
    const normalized = line.replace(/^[-*]\s+/, '').replace(/^\d+[.)]\s+/, '').trim();
    if (!normalized.endsWith('?')) continue;
    if (!seen.has(normalized.toLowerCase())) {
      seen.add(normalized.toLowerCase());
      questions.push(normalized);
    }
  }

  return questions.slice(0, 8);
}

async function generateRoadmapDraft(config: EnvoiConfig, mode: LoopMode): Promise<{ draft?: RoadmapDraft; reason?: string }> {
  const baseCommit = (() => {
    try {
      return getHeadCommit();
    } catch {
      return '0000000000000000000000000000000000000000';
    }
  })();

  const state = createInitialState(config, baseCommit);
  const { runOrchestrator } = await import('../runner/orchestrator.js');
  const orchestratorResult = await runOrchestrator(state);

  if (!orchestratorResult.success || !orchestratorResult.task) {
    return {
      reason: orchestratorResult.error ?? 'orchestrator returned no task',
    };
  }

  const task: Task = orchestratorResult.task;
  const prompt = task.question?.prompt?.trim() || task.intent.trim();
  let milestoneLabels = extractRoadmapMilestones(prompt, task.question?.choices ?? []);
  let prdText = '';
  try {
    prdText = await readFile(join(config.workspace_dir, 'PRD.md'), 'utf-8');
  } catch {
    prdText = '';
  }

  if (milestoneLabels.length < 2) {
    const prdMilestones = extractRoadmapMilestonesFromPrd(prdText);
    milestoneLabels = mergeRoadmapLabels(milestoneLabels, prdMilestones);
  }

  const existingRoadmap = await readRoadmap(config.workspace_dir);
  if (existingRoadmap?.milestones.length) {
    const existingLabels = existingRoadmap.milestones.map((entry) => `${entry.id}: ${entry.title}`);
    milestoneLabels = mergeRoadmapLabels(existingLabels, milestoneLabels);
  }

  if (milestoneLabels.length === 0 && task.milestone_id) {
    milestoneLabels = [`${task.milestone_id}: ${task.milestone_id}`];
  }

  const milestones = normalizeRoadmapMilestones(milestoneLabels, task.milestone_id);
  const clarifyingQuestions = extractRoadmapQuestions(prompt);
  const summary = task.intent.trim().slice(0, 500);
  const now = new Date().toISOString();
  const activeMilestone = milestones.find((entry) => entry.status === 'active');

  return {
    draft: {
      v: 1,
      generated_at: now,
      updated_at: now,
      source: task.task_kind === 'question' ? 'orchestrator_question' : 'orchestrator_execute',
      summary,
      task_id: task.task_id,
      milestone_id: task.milestone_id,
      current_milestone_id: activeMilestone?.id ?? task.milestone_id ?? null,
      mode,
      milestones,
      clarifying_questions: clarifyingQuestions,
      planner_prompt: prompt,
      choices: task.question?.choices ?? [],
      token_usage: orchestratorResult.tokenUsage ?? null,
    },
  };
}

function printRoadmapPreview(roadmap: RoadmapDraft, roadmapPath: string): void {
  console.log(`\nPlanner snapshot (${roadmapPath}):`);
  console.log(`- Source: ${roadmap.source}`);
  console.log(`- Task: ${roadmap.task_id} (${roadmap.milestone_id})`);
  if (roadmap.summary) {
    console.log(`- Summary: ${roadmap.summary}`);
  }

  if (roadmap.milestones.length > 0) {
    console.log('- Proposed milestones:');
    for (const milestone of roadmap.milestones) {
      console.log(`  - ${milestone.id}: ${milestone.title} [${milestone.status}]`);
    }
  }

  if (roadmap.clarifying_questions.length > 0) {
    console.log('- Clarifying questions:');
    for (const question of roadmap.clarifying_questions) {
      console.log(`  - ${question}`);
    }
  }

  if (roadmap.choices.length > 0) {
    console.log('- Suggested choices:');
    for (const choice of roadmap.choices) {
      console.log(`  - ${choice}`);
    }
  }

  if (roadmap.token_usage) {
    const promptTokens = roadmap.token_usage.input_tokens ?? 'n/a';
    const completionTokens = roadmap.token_usage.output_tokens ?? 'n/a';
    const totalTokens = roadmap.token_usage.total_tokens ?? 'n/a';
    console.log(`- Orchestrator tokens: in=${promptTokens} out=${completionTokens} total=${totalTokens}`);
  }
}

async function runConnectivityChecks(config: EnvoiConfig): Promise<void> {
  console.log('\nRole connectivity checks:');

  const plannerProvider = (config.models.orchestrator_provider === 'chatgpt' ? 'chatgpt' : 'claude_code');
  const plannerCommand = plannerProvider === 'chatgpt' ? 'codex' : config.claude_code_cli.command;
  const plannerCli = checkCommandVersion(plannerCommand);
  if (plannerCli.available) {
    console.log(`- planner: CLEARED (${plannerCommand}${plannerCli.version ? ` ${plannerCli.version}` : ''})`);
  } else {
    console.log(`- planner: BLOCKED (${plannerCommand} not available)`);
  }

  const cursor = await checkCursorAgent(config);
  if (!cursor.cli_available) {
    console.log(`- builder: BLOCKED (cursor CLI '${cursor.command}' missing)`);
  } else if (!cursor.agent_available) {
    console.log(`- builder: BLOCKED ('${cursor.command} agent' unavailable)`);
  } else if (cursor.auth_status === 'unauthenticated') {
    console.log(`- builder: STANDBY (cursor agent not authenticated)`);
  } else {
    console.log(`- builder: CLEARED (cursor agent ready)`);
  }

  if (config.reviewer?.enabled) {
    if (config.reviewer.command === 'codex') {
      const codex = await checkCodexCli(config);
      if (!codex.cli_available) {
        console.log('- checker: BLOCKED (codex CLI not available)');
      } else if (codex.auth_status === 'api_key_present' || codex.auth_status === 'authenticated') {
        console.log('- checker: CLEARED (codex CLI authenticated)');
      } else if (codex.auth_status === 'unauthenticated') {
        console.log('- checker: STANDBY (codex CLI available; login required)');
      } else {
        console.log('- checker: STANDBY (codex CLI available; auth status unknown)');
      }
    } else {
      const reviewerCli = checkCommandVersion(config.reviewer.command);
      if (reviewerCli.available) {
        console.log(`- checker: CLEARED (${config.reviewer.command}${reviewerCli.version ? ` ${reviewerCli.version}` : ''})`);
      } else {
        console.log(`- checker: BLOCKED (${config.reviewer.command} not available)`);
      }
    }
  } else {
    console.log('- checker: STANDBY (optional reviewer disabled)');
  }
}

async function maybeStartRun(config: EnvoiConfig, mode: LoopMode, autoRun: boolean, configFilePath?: string): Promise<void> {
  if (!autoRun) {
    console.log('\nSetup complete. Waiting for you.');
    console.log(`- Run '${CLI_NAME} tick' for one bounded cycle`);
    console.log(`- Or run '${CLI_NAME} loop --mode ${mode}'`);
    return;
  }

  await autoCommitInitialScaffoldIfSafe(config, configFilePath);

  console.log(`\nStarting now using mode '${mode}'...`);

  if (mode === 'task') {
    const { runTick } = await import('../runner/tick.js');
    const report = await runTick(config);
    console.log(`- First tick verdict: ${report.verdict.toUpperCase()} (${report.code})`);
    return;
  }

  const { runLoop } = await import('../runner/loop.js');
  const loopResult = await runLoop(config, { mode });
  console.log(`- Loop finished: ${loopResult.final_verdict} (${loopResult.stop_reason})`);
}

export async function onboardCommand(options: {
  configPath?: string;
  forceInit?: boolean;
  reconfigure?: boolean;
  prdFile?: string;
  mode?: string;
  builder?: string;
  plannerProvider?: string;
  reviewer?: string;
  orchestratorModel?: string;
  builderModel?: string;
  reviewerModel?: string;
  answersJson?: string;
  answersFile?: string;
  json?: boolean;
  verboseOnboarding?: boolean;
  onboardingOutput?: string;
  strictExit?: boolean;
  showTourPrompt?: boolean;
  autoRun?: boolean;
}): Promise<OnboardCommandResult> {
  await ensureRepoRootCwd();
  await ensureGitRepoInitialized();
  await ensureInitialized(Boolean(options.forceInit));

  const configPath = await resolveConfigPath(options.configPath);
  const config = await loadConfig(configPath);
  const raw = await atomicReadJson<EnvoiConfig>(configPath);
  const nonInteractive = !input.isTTY;
  const inferredProviderFromModel = (model?: string): PlannerProvider | undefined => {
    if (!model) return undefined;
    return model.toLowerCase().startsWith('gpt-') ? 'chatgpt' : 'claude_code';
  };
  const existingProvider = normalizePlannerProvider((raw.models as any).orchestrator_provider)
    ?? inferredProviderFromModel(raw.models.orchestrator_model)
    ?? 'claude_code';
  const defaults = {
    mode: 'milestone' as LoopMode,
    builder: 'cursor' as BuilderChoice,
    plannerProvider: existingProvider,
    orchestratorModel: resolvePlannerModel(existingProvider),
    builderModel: 'sonnet',
    reviewer: 'codex' as ReviewerChoice,
    reviewerModel: raw.reviewer?.model || 'gpt-5',
  };
  const incomingAnswers = await loadOnboardingAnswers({
    answersJson: options.answersJson,
    answersFile: options.answersFile,
  });
  const needsInputPolicy = resolveOnboardingNeedsInputPolicy({
    json: options.json,
    verboseOnboarding: options.verboseOnboarding,
    onboardingOutput: options.onboardingOutput,
    strictExit: options.strictExit,
  });
  const sessionPath = onboardingSessionPath(config.workspace_dir);
  const existingSession = nonInteractive ? await loadOnboardingSession(sessionPath) : null;
  const incomingSessionId = asNonEmptyString(incomingAnswers.__session_id);
  if (
    nonInteractive &&
    existingSession?.status === 'waiting_input' &&
    incomingSessionId &&
    incomingSessionId !== existingSession.session_id
  ) {
    throw new Error(
      `Onboarding session mismatch: expected ${existingSession.session_id}, got ${incomingSessionId}. Resume with the expected session_id or restart with --reconfigure.`
    );
  }
  const persistedAnswers =
    nonInteractive && existingSession?.status === 'waiting_input'
      ? existingSession.answers
      : {};
  const answerBag: Record<string, unknown> = { ...persistedAnswers, ...incomingAnswers };
  const hasExplicitOnboardingInput = Boolean(
    options.answersJson ||
    options.answersFile ||
    options.prdFile ||
    options.mode ||
    options.builder ||
    options.plannerProvider ||
    options.reviewer ||
    options.orchestratorModel ||
    options.builderModel ||
    options.reviewerModel
  );
  if (
    nonInteractive &&
    !options.reconfigure &&
    existingSession?.status === 'completed' &&
    !hasExplicitOnboardingInput
  ) {
    console.log(`${PRODUCT_NAME} onboarding already complete.`);
    const mode = (raw.runner.default_loop_mode as LoopMode | undefined) ?? defaults.mode;
    const autoRunRequested = options.autoRun ?? false;
    await maybeStartRun(raw, mode, autoRunRequested, configPath);
    return { needsInput: false };
  }
  const sessionId =
    asNonEmptyString(answerBag.__session_id) ??
    existingSession?.session_id ??
    randomUUID();

  let modeSeed = normalizeLoopMode(options.mode ?? asNonEmptyString(answerBag.mode));
  let builderSeed = normalizeBuilderChoice(options.builder ?? asNonEmptyString(answerBag.builder));
  let plannerProviderSeed = normalizePlannerProvider(
    options.plannerProvider ??
    asNonEmptyString(answerBag.planner_provider) ??
    inferredProviderFromModel(asNonEmptyString(answerBag.orchestrator_model))
  );
  let reviewerSeed = parseOptionalReviewerChoice(
    options.reviewer ?? asNonEmptyString(answerBag.reviewer)
  );
  let orchestratorModelSeed = asNonEmptyString(options.orchestratorModel) ?? asNonEmptyString(answerBag.orchestrator_model);
  let builderModelSeed = asNonEmptyString(options.builderModel) ?? asNonEmptyString(answerBag.builder_model);
  let reviewerModelSeed = asNonEmptyString(options.reviewerModel) ?? asNonEmptyString(answerBag.reviewer_model);
  let prdTextSeed = asNonEmptyString(answerBag.prd_text);
  let nonInteractiveStartNow = false;
  if (!orchestratorModelSeed && plannerProviderSeed) {
    orchestratorModelSeed = resolvePlannerModel(plannerProviderSeed);
  }
  if (!plannerProviderSeed && orchestratorModelSeed) {
    plannerProviderSeed = inferredProviderFromModel(orchestratorModelSeed);
  }

  const intent = await promptStartIntentIfNeeded(Boolean(options.showTourPrompt));
  if (intent === 'tour') {
    printTour();
    const continueSetup = await promptYesNo('Continue with setup now?', true);
    if (!continueSetup) {
      console.log('Setup paused. Run envoi start again when ready.');
      return { needsInput: false };
    }
  }

  // 1) Capture PRD
  const prdPath = join(config.workspace_dir, 'PRD.md');
  await mkdir(config.workspace_dir, { recursive: true });
  const missingNonPrdQuestions = buildNonInteractiveQuestions({
    mode: modeSeed,
    builder: builderSeed,
    plannerProvider: plannerProviderSeed,
    orchestratorModel: orchestratorModelSeed,
    builderModel: builderModelSeed,
    reviewer: reviewerSeed,
    reviewerModel: reviewerModelSeed,
    prdText: 'reserved',
    defaults,
  }).some((question) => question.id !== 'prd_text');
  const reserveStdinForQuestionHandshake =
    nonInteractive &&
    !options.prdFile &&
    missingNonPrdQuestions;

  let prdCapture = reserveStdinForQuestionHandshake
    ? { text: prdTextSeed ?? '', source: isNonEmptyContent(prdTextSeed ?? '') ? 'paste' as const : 'skip' as const }
    : await collectPrdText({ prdFile: options.prdFile, prdText: prdTextSeed }, prdPath);
  if (nonInteractive) {
    let pendingQuestions = buildNonInteractiveQuestions({
      mode: modeSeed,
      builder: builderSeed,
      plannerProvider: plannerProviderSeed,
      orchestratorModel: orchestratorModelSeed,
      builderModel: builderModelSeed,
      reviewer: reviewerSeed,
      reviewerModel: reviewerModelSeed,
      prdText: prdCapture.text,
      defaults,
    });

    if (pendingQuestions.length > 0) {
      await emitNextQuestion({
        workspaceDir: config.workspace_dir,
        sessionId,
        question: pendingQuestions[0],
        pendingQuestionIds: pendingQuestions.map((question) => question.id),
        answers: answerBag,
        awaitingReview: false,
        policy: needsInputPolicy,
      });
      return { needsInput: true };
    }

    const effectivePlannerProvider = plannerProviderSeed ?? defaults.plannerProvider;
    const effectiveBuilderChoice = builderSeed ?? defaults.builder;
    const effectiveReviewerChoice = reviewerSeed ?? defaults.reviewer;
    const authIssues = await collectOnboardingAuthIssues({
      config: raw,
      plannerProvider: effectivePlannerProvider,
      builderChoice: effectiveBuilderChoice,
      reviewerChoice: effectiveReviewerChoice,
    });

    if (authIssues.length > 0) {
      await emitNextQuestion({
        workspaceDir: config.workspace_dir,
        sessionId,
        question: buildAuthQuestion(authIssues),
        pendingQuestionIds: ['auth'],
        answers: answerBag,
        awaitingReview: false,
        policy: needsInputPolicy,
      });
      return { needsInput: true };
    }
    delete answerBag.auth;

    const parsedReviewAction = parseReviewAction(asNonEmptyString(answerBag.__review_action));
    if (!parsedReviewAction) {
      const reviewQuestion = buildReviewQuestion({
        mode: modeSeed,
        builder: builderSeed,
        plannerProvider: plannerProviderSeed,
        orchestratorModel: orchestratorModelSeed,
        builderModel: builderModelSeed,
        reviewer: reviewerSeed,
        reviewerModel: reviewerModelSeed,
        prdText: prdCapture.text,
      });
      await emitNextQuestion({
        workspaceDir: config.workspace_dir,
        sessionId,
        question: reviewQuestion,
        pendingQuestionIds: ['review'],
        answers: answerBag,
        awaitingReview: true,
        policy: needsInputPolicy,
      });
      return { needsInput: true };
    }

    if (parsedReviewAction.action === 'edit') {
      clearAnswerByField(answerBag, parsedReviewAction.field);
      delete answerBag.__review_action;

      modeSeed = normalizeLoopMode(options.mode ?? asNonEmptyString(answerBag.mode));
      builderSeed = normalizeBuilderChoice(options.builder ?? asNonEmptyString(answerBag.builder));
      plannerProviderSeed = normalizePlannerProvider(
        options.plannerProvider ??
        asNonEmptyString(answerBag.planner_provider) ??
        inferredProviderFromModel(asNonEmptyString(answerBag.orchestrator_model))
      );
      reviewerSeed = parseOptionalReviewerChoice(
        options.reviewer ?? asNonEmptyString(answerBag.reviewer)
      );
      orchestratorModelSeed = asNonEmptyString(options.orchestratorModel) ?? asNonEmptyString(answerBag.orchestrator_model);
      builderModelSeed = asNonEmptyString(options.builderModel) ?? asNonEmptyString(answerBag.builder_model);
      reviewerModelSeed = asNonEmptyString(options.reviewerModel) ?? asNonEmptyString(answerBag.reviewer_model);
      prdTextSeed = asNonEmptyString(answerBag.prd_text);
      if (!orchestratorModelSeed && plannerProviderSeed) {
        orchestratorModelSeed = resolvePlannerModel(plannerProviderSeed);
      }
      if (!plannerProviderSeed && orchestratorModelSeed) {
        plannerProviderSeed = inferredProviderFromModel(orchestratorModelSeed);
      }
      prdCapture = {
        text: prdTextSeed ?? '',
        source: isNonEmptyContent(prdTextSeed ?? '') ? 'paste' : 'skip',
      };

      pendingQuestions = buildNonInteractiveQuestions({
        mode: modeSeed,
        builder: builderSeed,
        plannerProvider: plannerProviderSeed,
        orchestratorModel: orchestratorModelSeed,
        builderModel: builderModelSeed,
        reviewer: reviewerSeed,
        reviewerModel: reviewerModelSeed,
        prdText: prdCapture.text,
        defaults,
      });
      if (pendingQuestions.length > 0) {
        await emitNextQuestion({
          workspaceDir: config.workspace_dir,
          sessionId,
          question: pendingQuestions[0],
          pendingQuestionIds: pendingQuestions.map((question) => question.id),
          answers: answerBag,
          awaitingReview: false,
          policy: needsInputPolicy,
        });
        return { needsInput: true };
      }

      const reviewQuestion = buildReviewQuestion({
        mode: modeSeed,
        builder: builderSeed,
        plannerProvider: plannerProviderSeed,
        orchestratorModel: orchestratorModelSeed,
        builderModel: builderModelSeed,
        reviewer: reviewerSeed,
        reviewerModel: reviewerModelSeed,
        prdText: prdCapture.text,
      });
      await emitNextQuestion({
        workspaceDir: config.workspace_dir,
        sessionId,
        question: reviewQuestion,
        pendingQuestionIds: ['review'],
        answers: answerBag,
        awaitingReview: true,
        policy: needsInputPolicy,
      });
      return { needsInput: true };
    }

    if (parsedReviewAction.action === 'confirm_and_start') {
      nonInteractiveStartNow = true;
    }
    delete answerBag.__review_action;
  }
  if (isNonEmptyContent(prdCapture.text)) {
    await writeFile(prdPath, `${prdCapture.text.trim()}\n`, 'utf-8');
  }

  // 2) Ask mode
  const mode =
    modeSeed ??
    (input.isTTY
      ? ((await promptChoice(
          'How should Envoi run by default?',
          MODE_CHOICES,
          defaults.mode
        )) as LoopMode)
      : defaults.mode);
  raw.runner = { ...raw.runner, default_loop_mode: mode };

  // 3) Ask builder
  const builderChoice: BuilderChoice = 'cursor';

  // 4) Planner provider and model defaults
  const plannerProvider =
    plannerProviderSeed ??
    (input.isTTY
      ? ((await promptChoice(
          'Planner provider?',
          PLANNER_PROVIDER_CHOICES,
          defaults.plannerProvider
        )) as PlannerProvider)
      : defaults.plannerProvider);
  const orchestratorModel = resolvePlannerModel(plannerProvider);

  const builderModel = defaults.builderModel;

  raw.models = {
    ...raw.models,
    orchestrator_provider: plannerProvider,
    orchestrator_model: orchestratorModel,
    orchestrator_fallback_model: plannerProvider === 'chatgpt'
      ? (raw.models.orchestrator_fallback_model || CHATGPT_PLANNER_MODEL)
      : (raw.models.orchestrator_fallback_model || 'sonnet'),
    builder_model: builderModel,
    builder_fallback_model: raw.models.builder_fallback_model || 'haiku',
  };

  // 5) Builder config application
  const cursorConfig = withDefaultCursorConfig(raw.builder.cursor);
  raw.builder = {
    ...raw.builder,
    default_mode: 'cursor',
    cursor: {
      driver_kind: cursorConfig.driver_kind ?? 'cursor_agent',
      command: cursorConfig.command,
      args: cursorConfig.args,
      timeout_seconds: cursorConfig.timeout_seconds,
      output_file: cursorConfig.output_file,
    },
  };

  // 6) Optional reviewer
  const reviewerChoice =
    reviewerSeed !== undefined
      ? reviewerSeed
      : (input.isTTY
          ? normalizeReviewerChoice(
              await promptChoice(
                'Optional reviewer?',
                [
                  { value: 'codex', label: 'Use Codex reviewer (recommended)', desc: 'Adds second-pass checks for risky changes.' },
                  { value: 'none', label: 'No reviewer', desc: 'Less friction, fastest onboarding.' },
                ],
                defaults.reviewer
              )
            )
          : defaults.reviewer);

  if (reviewerChoice === 'codex') {
    const reviewerModel =
      reviewerModelSeed ??
      (input.isTTY
        ? await promptChoice(
            'Reviewer model?',
            [
              { value: 'gpt-5', label: 'gpt-5 (recommended)', desc: 'Strong review quality for complex diffs.' },
              { value: 'o3', label: 'o3', desc: 'Reasoning-heavy fallback.' },
              { value: 'gpt-5-mini', label: 'gpt-5-mini', desc: 'Lower-cost reviewer option.' },
            ],
            defaults.reviewerModel
          )
        : defaults.reviewerModel);

    raw.reviewer = {
      ...withDefaultReviewerConfig(config.workspace_dir, raw.reviewer),
      enabled: true,
      command: raw.reviewer?.command || 'codex',
      model: reviewerModel,
    };
  } else if (raw.reviewer) {
    raw.reviewer = { ...raw.reviewer, enabled: false };
  }

  const authIssues = await collectOnboardingAuthIssues({
    config: raw,
    plannerProvider,
    builderChoice,
    reviewerChoice,
  });
  if (authIssues.length > 0) {
    if (input.isTTY) {
      printAuthIssues(authIssues);
      throw new Error('Authentication required. Complete the steps above, then rerun onboarding.');
    }
    await emitNextQuestion({
      workspaceDir: config.workspace_dir,
      sessionId,
      question: buildAuthQuestion(authIssues),
      pendingQuestionIds: ['auth'],
      answers: answerBag,
      awaitingReview: false,
      policy: needsInputPolicy,
    });
    return { needsInput: true };
  }
  delete answerBag.auth;

  // Ensure PRD is runner-owned (protects from builder edits)
  if (Array.isArray(raw.runner.runner_owned_globs) && !raw.runner.runner_owned_globs.includes(`${config.workspace_dir}/PRD.md`)) {
    raw.runner.runner_owned_globs = [...raw.runner.runner_owned_globs, `${config.workspace_dir}/PRD.md`];
  }

  if (!validateConfig(raw)) {
    throw new Error('Updated config is invalid (validateConfig failed).');
  }
  await atomicWriteJson(configPath, raw);
  if (nonInteractive) {
    await persistOnboardingSession(sessionPath, {
      v: 1,
      type: 'envoi.onboarding.session.v1',
      session_id: sessionId,
      status: 'completed',
      updated_at: new Date().toISOString(),
      current_step: undefined,
      awaiting_review: false,
      pending_question_ids: [],
      answers: stripOnboardingMetaAnswers(answerBag),
    });
  }

  console.log(`\n${PRODUCT_NAME} onboarding complete.`);
  console.log(`- Workspace: ${config.workspace_dir}`);
  console.log(`- PRD source: ${prdCapture.source}`);
  console.log(`- Default mode: ${mode}`);
  console.log(`- Builder: ${builderChoice}`);
  console.log(`- Planner: ${plannerProvider} (${orchestratorModel})`);
  console.log(`- Reviewer: ${raw.reviewer?.enabled ? 'enabled' : 'disabled'}`);

  await runConnectivityChecks(raw);

  const roadmapPath = join(config.workspace_dir, 'ROADMAP.json');
  let existingPrdContent = '';
  try {
    existingPrdContent = (await readFile(prdPath, 'utf-8')).trim();
  } catch {
    existingPrdContent = '';
  }
  const shouldAttemptRoadmap =
    isMeaningfulPrdText(prdCapture.text) || isMeaningfulPrdText(existingPrdContent);

  if (shouldAttemptRoadmap) {
    const draftResult = await generateRoadmapDraft(raw, mode);
    if (draftResult.draft) {
      await writeRoadmap(config.workspace_dir, draftResult.draft);
      printRoadmapPreview(draftResult.draft, roadmapPath);
      console.log(`- Saved: ${roadmapPath}`);
    } else {
      console.log(`\n[WARN] Could not generate roadmap snapshot: ${draftResult.reason}`);
    }
  } else {
    console.log('\nNeeds you: add a meaningful project brief (PRD) to generate roadmap guidance.');
    console.log(`- Add context in ${prdPath}`);
  }

  const autoRunRequested = options.autoRun ?? input.isTTY;
  const shouldRunNow = input.isTTY
    ? await promptYesNo(`Start now with mode '${mode}'?`, autoRunRequested)
    : nonInteractiveStartNow;
  await maybeStartRun(raw, mode, shouldRunNow, configPath);
  return { needsInput: false };
}
