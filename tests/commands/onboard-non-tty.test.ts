import { describe, it, expect } from 'vitest';
import {
  buildNonInteractiveQuestions,
  parseInlineAnswer,
  normalizeQuestionAnswer,
  buildReviewPayload,
  resolveOnboardingNeedsInputPolicy,
  computeOnboardingNeedsInputExitCode,
} from '@/commands/onboard';

describe('onboard non-interactive validation', () => {
  const defaults = {
    mode: 'milestone' as const,
    builder: 'cursor' as const,
    plannerProvider: 'claude_code' as const,
    orchestratorModel: 'opus',
    builderModel: 'sonnet',
    reviewer: 'codex' as const,
    reviewerModel: 'gpt-5',
  };

  it('returns required onboarding questions when data is missing', () => {
    const questions = buildNonInteractiveQuestions({
      defaults,
      prdText: '',
    });
    const ids = questions.map((question) => question.id);
    expect(ids).toEqual([
      'mode',
      'planner_provider',
      'reviewer',
      'prd_text',
    ]);
  });

  it('asks reviewer model only when reviewer is codex', () => {
    const questions = buildNonInteractiveQuestions({
      defaults: { ...defaults, reviewer: 'codex' },
      mode: 'milestone',
      builder: 'cursor',
      plannerProvider: 'claude_code',
      orchestratorModel: 'opus',
      builderModel: 'sonnet',
      reviewer: 'codex',
      prdText: '# PRD\nBuild this product',
    });
    const ids = questions.map((question) => question.id);
    expect(ids).toEqual(['reviewer_model']);
  });

  it('does not ask builder model in cursor-only onboarding', () => {
    const cursorQuestions = buildNonInteractiveQuestions({
      defaults,
      mode: 'milestone',
      builder: 'cursor',
      plannerProvider: 'claude_code',
      orchestratorModel: 'opus',
      reviewer: 'none',
      prdText: '# PRD\nBuild this product',
    });
    expect(cursorQuestions.map((question) => question.id)).not.toContain('builder_model');
  });

  it('returns no questions when required onboarding answers are present', () => {
    const questions = buildNonInteractiveQuestions({
      defaults,
      mode: 'milestone',
      builder: 'cursor',
      plannerProvider: 'claude_code',
      orchestratorModel: 'opus',
      builderModel: 'sonnet',
      reviewer: 'codex',
      reviewerModel: 'gpt-5',
      prdText: '# PRD\nBuild this product',
    });
    expect(questions).toEqual([]);
  });

  it('parses structured and plain inline answers', () => {
    expect(
      parseInlineAnswer('{"type":"envoi.onboarding.answer.v1","question_id":"mode","value":"task"}')
    ).toEqual({
      type: 'envoi.onboarding.answer.v1',
      question_id: 'mode',
      value: 'task',
    });
    expect(parseInlineAnswer('milestone')).toEqual({ value: 'milestone' });
  });

  it('normalizes select answers by value or index', () => {
    const question = {
      id: 'mode',
      label: 'Mode',
      type: 'select' as const,
      required: true,
      choices: [
        { value: 'task', label: 'task' },
        { value: 'milestone', label: 'milestone' },
      ],
    };

    expect(normalizeQuestionAnswer(question, 'milestone')).toBe('milestone');
    expect(normalizeQuestionAnswer(question, '2')).toBe('milestone');
    expect(normalizeQuestionAnswer(question, 'unknown')).toBeUndefined();
  });

  it('builds review payload with summary and confirm/edit actions', () => {
    const payload = buildReviewPayload('session-1', {
      mode: 'milestone',
      builder: 'cursor',
      plannerProvider: 'claude_code',
      orchestratorModel: 'opus',
      builderModel: 'sonnet',
      reviewer: 'codex',
      prdText: '# PRD\nBuild a robust onboarding flow.',
    });

    expect(payload.type).toBe('envoi.onboarding.review.v1');
    expect(payload.session_id).toBe('session-1');
    expect(payload.summary.mode).toBe('milestone');
    expect(payload.summary.prd_preview).toContain('Build a robust onboarding flow.');
    expect(payload.summary.prd_full).toContain('Build a robust onboarding flow.');
    expect(payload.summary.prd_path).toBe('envoi/PRD.md');
    expect(payload.options.map((option) => option.value)).toEqual(['confirm', 'confirm_and_start', 'edit']);
  });

  it('defaults non-tty needs-input policy to compact output and exit 0', () => {
    const policy = resolveOnboardingNeedsInputPolicy({});
    expect(policy.outputMode).toBe('compact');
    expect(computeOnboardingNeedsInputExitCode(policy.strictExit)).toBe(0);
  });

  it('supports strict exit with json output policy', () => {
    const policy = resolveOnboardingNeedsInputPolicy({ json: true, strictExit: true });
    expect(policy.outputMode).toBe('json');
    expect(computeOnboardingNeedsInputExitCode(policy.strictExit)).toBe(20);
  });

  it('rejects conflicting output flags', () => {
    expect(() =>
      resolveOnboardingNeedsInputPolicy({ json: true, verboseOnboarding: true })
    ).toThrow("Conflicting options: use either '--json' or '--verbose-onboarding'.");
  });
});
