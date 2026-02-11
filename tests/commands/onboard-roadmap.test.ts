import { describe, it, expect } from 'vitest';
import {
  extractRoadmapMilestones,
  extractRoadmapMilestonesFromPrd,
  extractRoadmapQuestions,
  isMeaningfulPrdText,
} from '@/commands/onboard';

describe('onboard roadmap helpers', () => {
  it('extracts milestone-style lines', () => {
    const prompt = [
      'Proposed milestones:',
      '- M1: Auth and sessions',
      '- M2: Billing flows',
      '- M3: Observability hardening',
    ].join('\n');

    expect(extractRoadmapMilestones(prompt)).toEqual([
      'M1: Auth and sessions',
      'M2: Billing flows',
      'M3: Observability hardening',
    ]);
  });

  it('extracts milestones from choice lines when prompt body is sparse', () => {
    const prompt = 'Pick one path:';
    const choices = [
      'M1: Platform setup',
      'M2: Core API',
      'M3: Release hardening',
    ];

    expect(extractRoadmapMilestones(prompt, choices)).toEqual([
      'M1: Platform setup',
      'M2: Core API',
      'M3: Release hardening',
    ]);
  });

  it('extracts clarifying questions from prompt text', () => {
    const prompt = [
      'Clarifications needed:',
      'What is the expected launch date?',
      '- Which team owns production support?',
      'M1: Auth and sessions',
    ].join('\n');

    expect(extractRoadmapQuestions(prompt)).toEqual([
      'What is the expected launch date?',
      'Which team owns production support?',
    ]);
  });

  it('detects placeholder PRD as not meaningful', () => {
    const placeholder = '# PRD\n\n(Paste the user PRD here. This is the source of truth.)\n';
    expect(isMeaningfulPrdText(placeholder)).toBe(false);
    expect(isMeaningfulPrdText('# PRD\n\nBuild a B2B invoicing app with role-based access control and audit logs.')).toBe(true);
  });

  it('extracts roadmap milestones from PRD headings when explicit labels are missing', () => {
    const prd = [
      '# PRD',
      '## Authentication and Org Setup',
      '## Billing and Subscription Flows',
      '## Audit Logs and Compliance Hardening',
    ].join('\n');

    expect(extractRoadmapMilestonesFromPrd(prd)).toEqual([
      'M1: Authentication and Org Setup',
      'M2: Billing and Subscription Flows',
      'M3: Audit Logs and Compliance Hardening',
    ]);
  });

  it('prefers explicit milestone labels in PRD and filters generic headings', () => {
    const prd = [
      '# PRD',
      '## Overview',
      '- M1: Foundation',
      '- M2: Core Product',
      '## Requirements',
      '## Launch Readiness',
    ].join('\n');

    expect(extractRoadmapMilestonesFromPrd(prd)).toEqual([
      'M1: Foundation',
      'M2: Core Product',
      'M3: Launch Readiness',
    ]);
  });
});
