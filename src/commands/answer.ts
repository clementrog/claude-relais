import { stdin as input, stdout as output } from 'node:process';
import readline from 'node:readline/promises';

import type { ProductQuestion, WorkspaceState } from '../types/workspace_state.js';
import { appendIdeaEntry, readWorkspaceState, writeWorkspaceState } from '../lib/workspace_state.js';

type AnswerSource = 'interactive' | 'cli' | 'api';

export interface AnswerCommandOptions {
  text?: string;
  questionId?: string;
  sessionId?: string;
  id?: string;
  value?: string;
  source?: string;
  json?: boolean;
}

export interface AnswerCommandResult {
  kind: 'product_question' | 'onboarding';
  resolved: boolean;
  questionId: string;
  pendingQuestions: number;
  pendingIdeas: number;
  needsInput?: boolean;
}

interface OnboardingCompatAnswer {
  sessionId: string;
  questionId: string;
  value: string;
}

function normalizeSource(value?: string): AnswerSource {
  if (!value || value.trim() === '') return 'cli';
  if (value === 'interactive' || value === 'cli' || value === 'api') return value;
  throw new Error(`Invalid source value: ${value}. Must be 'interactive', 'cli', or 'api'.`);
}

function listUnresolvedQuestions(state: WorkspaceState): ProductQuestion[] {
  return (state.open_product_questions ?? []).filter((question) => !question.resolved);
}

function selectQuestion(state: WorkspaceState, questionId?: string): ProductQuestion {
  const unresolved = listUnresolvedQuestions(state);
  if (unresolved.length === 0) {
    throw new Error('No open product questions found in STATE.json. Use `envoi idea` for general input.');
  }

  if (!questionId || questionId.trim() === '') {
    return unresolved[unresolved.length - 1];
  }

  const selected = unresolved.find((question) => question.id === questionId.trim());
  if (!selected) {
    const ids = unresolved.map((question) => question.id).join(', ');
    throw new Error(`Question '${questionId}' is not open. Open question IDs: ${ids}`);
  }
  return selected;
}

function normalizeAnswerValue(question: ProductQuestion, raw: string): string {
  const trimmed = raw.trim();
  if (trimmed === '') return '';
  if (!Array.isArray(question.choices) || question.choices.length === 0) return trimmed;

  const index = Number.parseInt(trimmed, 10);
  if (!Number.isNaN(index) && index >= 1 && index <= question.choices.length) {
    return question.choices[index - 1];
  }

  const matched = question.choices.find((choice) => choice.toLowerCase() === trimmed.toLowerCase());
  return matched ?? trimmed;
}

function resolveOnboardingCompatAnswer(options: AnswerCommandOptions): OnboardingCompatAnswer | null {
  const sessionId = options.sessionId?.trim() ?? '';
  const questionId = options.id?.trim() ?? '';
  const valueFromFlag = options.value?.trim() ?? '';
  const valueFromText = options.text?.trim() ?? '';
  const hasCompatInput = sessionId !== '' || questionId !== '' || valueFromFlag !== '';
  if (!hasCompatInput) return null;

  if (sessionId === '') {
    throw new Error("Onboarding answer mode requires '--session <id>'.");
  }
  if (questionId === '') {
    throw new Error("Onboarding answer mode requires '--id <question_id>'.");
  }

  const value = valueFromFlag || valueFromText;
  if (value === '') {
    throw new Error("Onboarding answer mode requires '--value <value>' (or positional text).");
  }

  return {
    sessionId,
    questionId,
    value,
  };
}

async function promptForAnswer(question: ProductQuestion): Promise<string> {
  if (!input.isTTY) return '';
  const rl = readline.createInterface({ input, output });
  try {
    console.log('\nOpen product question:');
    console.log(`- id: ${question.id}`);
    console.log(`- prompt: ${question.prompt}`);
    if (Array.isArray(question.choices) && question.choices.length > 0) {
      console.log('- choices:');
      question.choices.forEach((choice, idx) => {
        console.log(`  ${idx + 1}. ${choice}`);
      });
    }
    return (await rl.question('\nYour answer: ')).trim();
  } finally {
    rl.close();
  }
}

function markQuestionResolved(
  state: WorkspaceState,
  questionId: string,
  resolution: string
): WorkspaceState {
  const now = new Date().toISOString();
  const questions = (state.open_product_questions ?? []).map((question) =>
    question.id === questionId
      ? {
          ...question,
          resolved: true,
          resolved_at: now,
          resolution,
        }
      : question
  );

  return {
    ...state,
    open_product_questions: questions,
  };
}

export async function answerCommand(
  options: AnswerCommandOptions,
  workspaceDir: string
): Promise<AnswerCommandResult> {
  const onboardingCompat = resolveOnboardingCompatAnswer(options);
  if (onboardingCompat) {
    const { onboardCommand } = await import('./onboard.js');
    const onboardingResult = await onboardCommand({
      answersJson: JSON.stringify({
        type: 'envoi.onboarding.answer.v1',
        session_id: onboardingCompat.sessionId,
        question_id: onboardingCompat.questionId,
        value: onboardingCompat.value,
      }),
      json: options.json,
      showTourPrompt: false,
    });
    return {
      kind: 'onboarding',
      resolved: true,
      questionId: onboardingCompat.questionId,
      pendingQuestions: onboardingResult.needsInput ? 1 : 0,
      pendingIdeas: 0,
      needsInput: onboardingResult.needsInput,
    };
  }

  const state = await readWorkspaceState(workspaceDir);
  const question = selectQuestion(state, options.questionId);

  const explicitText = options.text?.trim() ?? '';
  const prompted = explicitText || (await promptForAnswer(question));
  if (!prompted) {
    throw new Error('Answer text is required. Pass text or run in TTY to be prompted.');
  }

  const normalizedResolution = normalizeAnswerValue(question, prompted);
  if (!normalizedResolution) {
    throw new Error('Answer text cannot be empty.');
  }

  const source = normalizeSource(options.source ?? (explicitText ? 'cli' : 'interactive'));
  const resolvedState = markQuestionResolved(state, question.id, normalizedResolution);
  const withIdea = appendIdeaEntry(resolvedState, {
    text: `Answer to product question (${question.id}): ${question.prompt}\nResolution: ${normalizedResolution}`,
    source,
    testability_need: 'soon',
  });

  await writeWorkspaceState(workspaceDir, withIdea);

  const pendingQuestions = listUnresolvedQuestions(withIdea).length;
  const pendingIdeas = withIdea.idea_inbox?.filter((entry) => entry.status === 'new').length ?? 0;
  const result: AnswerCommandResult = {
    kind: 'product_question',
    resolved: true,
    questionId: question.id,
    pendingQuestions,
    pendingIdeas,
  };

  if (options.json) {
    console.log(
      JSON.stringify(
        {
          ...result,
          resolution: normalizedResolution,
        },
        null,
        2
      )
    );
  } else {
    console.log(`Resolved question: ${question.id}`);
    console.log(`- Answer: ${normalizedResolution}`);
    console.log(`- Remaining open questions: ${pendingQuestions}`);
    console.log('Run `envoi tick` to continue with the updated context.');
  }

  return result;
}
