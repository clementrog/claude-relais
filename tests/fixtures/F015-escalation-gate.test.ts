/**
 * F015: escalation_gate
 * 
 * Verify that after failure_streak >= 2, shouldEscalate returns non-none mode.
 * Escalation gate prevents infinite retry loops after 2 consecutive failures.
 */

import { describe, it, expect } from 'vitest';
import { shouldEscalate } from '@/lib/guardrails.js';
import { createMockConfig, createMockTickState } from '../helpers/mocks.js';
import type { RelaisConfig } from '@/types/config.js';
import type { TickState } from '@/types/state.js';

describe('F015: escalation_gate', () => {
  it('should escalate when failure_streak >= 2', () => {
    const config = createMockConfig({
      reviewer: {
        enabled: false,
        trigger: {
          on_repeated_stop: true,
          stop_window_ticks: 5,
          max_stops_in_window: 3,
        },
      },
    });

    const state = createMockTickState(config, null, {
      failure_streak: 2,
    });

    const decision = shouldEscalate(state, config, 10);

    expect(decision.mode).not.toBe('none');
    expect(decision.reason).toContain('Failure streak is 2');
    expect(decision.reason).toContain('>= 2');
  });

  it('should escalate when failure_streak > 2', () => {
    const config = createMockConfig({
      reviewer: {
        enabled: false,
        trigger: {
          on_repeated_stop: true,
          stop_window_ticks: 5,
          max_stops_in_window: 3,
        },
      },
    });

    const state = createMockTickState(config, null, {
      failure_streak: 3,
    });

    const decision = shouldEscalate(state, config, 10);

    expect(decision.mode).not.toBe('none');
    expect(decision.reason).toContain('Failure streak is 3');
  });

  it('should return mode "human" when reviewer is disabled and failure_streak >= 2', () => {
    const config = createMockConfig({
      reviewer: {
        enabled: false,
        trigger: {
          on_repeated_stop: true,
          stop_window_ticks: 5,
          max_stops_in_window: 3,
        },
      },
    });

    const state = createMockTickState(config, null, {
      failure_streak: 2,
    });

    const decision = shouldEscalate(state, config, 10);

    expect(decision.mode).toBe('human');
    expect(decision.reason).toContain('prevent infinite retry loops');
  });

  it('should return mode "reviewer" when reviewer is enabled and failure_streak >= 2', () => {
    const config = createMockConfig({
      reviewer: {
        enabled: true,
        trigger: {
          on_repeated_stop: true,
          stop_window_ticks: 5,
          max_stops_in_window: 3,
        },
      },
    });

    const state = createMockTickState(config, null, {
      failure_streak: 2,
    });

    const decision = shouldEscalate(state, config, 10);

    expect(decision.mode).toBe('reviewer');
    expect(decision.reason).toContain('Failure streak is 2');
  });

  it('should not escalate when failure_streak < 2', () => {
    const config = createMockConfig({
      reviewer: {
        enabled: false,
        trigger: {
          on_repeated_stop: true,
          stop_window_ticks: 5,
          max_stops_in_window: 3,
        },
      },
    });

    const state = createMockTickState(config, null, {
      failure_streak: 1,
    });

    const decision = shouldEscalate(state, config, 10);

    expect(decision.mode).toBe('none');
    expect(decision.reason).toContain('No escalation triggers detected');
  });

  it('should not escalate when failure_streak is 0', () => {
    const config = createMockConfig({
      reviewer: {
        enabled: false,
        trigger: {
          on_repeated_stop: true,
          stop_window_ticks: 5,
          max_stops_in_window: 3,
        },
      },
    });

    const state = createMockTickState(config, null, {
      failure_streak: 0,
    });

    const decision = shouldEscalate(state, config, 10);

    expect(decision.mode).toBe('none');
  });

  it('should not escalate when failure_streak is undefined', () => {
    const config = createMockConfig({
      reviewer: {
        enabled: false,
        trigger: {
          on_repeated_stop: true,
          stop_window_ticks: 5,
          max_stops_in_window: 3,
        },
      },
    });

    const state = createMockTickState(config, null, {
      // failure_streak is undefined
    });

    const decision = shouldEscalate(state, config, 10);

    expect(decision.mode).toBe('none');
  });

  it('should escalate at exactly failure_streak === 2', () => {
    const config = createMockConfig({
      reviewer: {
        enabled: false,
        trigger: {
          on_repeated_stop: true,
          stop_window_ticks: 5,
          max_stops_in_window: 3,
        },
      },
    });

    const state = createMockTickState(config, null, {
      failure_streak: 2,
    });

    const decision = shouldEscalate(state, config, 10);

    // Should escalate at exactly 2
    expect(decision.mode).not.toBe('none');
    expect(decision.mode).toBe('human'); // Reviewer disabled
  });
});
