/**
 * F020: stop_window_escalation
 * 
 * Verify that stop-window escalation triggers: N stops in M ticks triggers reviewer/human escalation.
 * Stop-window escalation prevents repeated failures by escalating when too many stops occur in a time window.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { shouldEscalate } from '@/lib/guardrails.js';
import { createMockConfig, createMockTickState } from '../helpers/mocks.js';
import type { RelaisConfig } from '@/types/config.js';
import type { TickState } from '@/types/state.js';

describe('F020: stop_window_escalation', () => {
  let config: RelaisConfig;

  beforeEach(() => {
    vi.clearAllMocks();
    config = createMockConfig({
      reviewer: {
        enabled: false,
        trigger: {
          on_repeated_stop: true,
          stop_window_ticks: 5,
          max_stops_in_window: 3,
        },
      },
    });
  });

  it('should escalate when stop_history has >= max_stops_in_window stops in window', () => {
    const state = createMockTickState(config, null, {
      failure_streak: 0,
      guardrail: {
        stop_history: [
          { tick: 1, verdict: 'stop' },
          { tick: 2, verdict: 'stop' },
          { tick: 3, verdict: 'stop' },
        ],
      },
    });

    const currentTick = 5;
    const decision = shouldEscalate(state, config, currentTick);

    expect(decision.mode).not.toBe('none');
    expect(decision.reason).toContain('stops in last');
    expect(decision.reason).toContain('>= 3');
  });

  it('should escalate to human when reviewer is disabled and stop window exceeded', () => {
    config = createMockConfig({
      reviewer: {
        enabled: false,
        trigger: {
          on_repeated_stop: true,
          stop_window_ticks: 5,
          max_stops_in_window: 2,
        },
      },
    });

    const state = createMockTickState(config, null, {
      failure_streak: 0,
      guardrail: {
        stop_history: [
          { tick: 1, verdict: 'stop' },
          { tick: 2, verdict: 'stop' },
        ],
      },
    });

    const currentTick = 5;
    const decision = shouldEscalate(state, config, currentTick);

    expect(decision.mode).toBe('human');
    expect(decision.reason).toContain('stops in last');
  });

  it('should escalate to reviewer when reviewer is enabled and stop window exceeded', () => {
    config = createMockConfig({
      reviewer: {
        enabled: true,
        trigger: {
          on_repeated_stop: true,
          stop_window_ticks: 5,
          max_stops_in_window: 2,
        },
      },
    });

    const state = createMockTickState(config, null, {
      failure_streak: 0,
      guardrail: {
        stop_history: [
          { tick: 1, verdict: 'stop' },
          { tick: 2, verdict: 'stop' },
        ],
      },
    });

    const currentTick = 5;
    const decision = shouldEscalate(state, config, currentTick);

    expect(decision.mode).toBe('reviewer');
    expect(decision.reason).toContain('stops in last');
  });

  it('should not escalate when stop count is below threshold', () => {
    const state = createMockTickState(config, null, {
      failure_streak: 0,
      guardrail: {
        stop_history: [
          { tick: 1, verdict: 'stop' },
          { tick: 2, verdict: 'stop' },
        ],
      },
    });

    // max_stops_in_window is 3, but we only have 2 stops
    const currentTick = 5;
    const decision = shouldEscalate(state, config, currentTick);

    expect(decision.mode).toBe('none');
    expect(decision.reason).toContain('No escalation triggers detected');
  });

  it('should not escalate when stop count is below threshold even with many entries', () => {
    config = createMockConfig({
      reviewer: {
        enabled: false,
        trigger: {
          on_repeated_stop: true,
          stop_window_ticks: 5,
          max_stops_in_window: 4, // Higher threshold
        },
      },
    });

    const state = createMockTickState(config, null, {
      failure_streak: 0,
      guardrail: {
        stop_history: [
          { tick: 1, verdict: 'stop' },
          { tick: 2, verdict: 'stop' },
          { tick: 3, verdict: 'stop' },
        ],
      },
    });

    // Window is 5, so we look at last 5 entries (all 3 stops)
    // But max_stops_in_window is 4, so 3 < 4, should not escalate
    const currentTick = 20;
    const decision = shouldEscalate(state, config, currentTick);

    expect(decision.mode).toBe('none');
  });

  it('should escalate when exactly max_stops_in_window stops are in window', () => {
    config = createMockConfig({
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
      guardrail: {
        stop_history: [
          { tick: 1, verdict: 'stop' },
          { tick: 2, verdict: 'stop' },
          { tick: 3, verdict: 'stop' },
        ],
      },
    });

    const currentTick = 5;
    const decision = shouldEscalate(state, config, currentTick);

    expect(decision.mode).toBe('human');
    expect(decision.reason).toContain('>= 3');
  });

  it('should prioritize failure_streak >= 2 over stop window escalation', () => {
    const state = createMockTickState(config, null, {
      failure_streak: 2,
      guardrail: {
        stop_history: [
          { tick: 1, verdict: 'stop' },
          { tick: 2, verdict: 'stop' },
          { tick: 3, verdict: 'stop' },
        ],
      },
    });

    const currentTick = 5;
    const decision = shouldEscalate(state, config, currentTick);

    // Should escalate due to failure_streak, not stop window
    expect(decision.mode).toBe('human');
    expect(decision.reason).toContain('Failure streak is 2');
    expect(decision.reason).not.toContain('stops in last');
  });

  it('should handle empty stop_history gracefully', () => {
    const state = createMockTickState(config, null, {
      failure_streak: 0,
      guardrail: {
        stop_history: [],
      },
    });

    const currentTick = 5;
    const decision = shouldEscalate(state, config, currentTick);

    expect(decision.mode).toBe('none');
  });

  it('should handle undefined stop_history gracefully', () => {
    const state = createMockTickState(config, null, {
      failure_streak: 0,
      guardrail: undefined,
    });

    const currentTick = 5;
    const decision = shouldEscalate(state, config, currentTick);

    expect(decision.mode).toBe('none');
  });

  it('should use last N entries when stop_history length exceeds window', () => {
    config = createMockConfig({
      reviewer: {
        enabled: false,
        trigger: {
          on_repeated_stop: true,
          stop_window_ticks: 3,
          max_stops_in_window: 2,
        },
      },
    });

    const state = createMockTickState(config, null, {
      failure_streak: 0,
      guardrail: {
        stop_history: [
          { tick: 1, verdict: 'stop' },
          { tick: 2, verdict: 'stop' },
          { tick: 3, verdict: 'stop' },
          { tick: 4, verdict: 'stop' },
        ],
      },
    });

    // Window is 3, so we look at last 3 entries: ticks 2, 3, 4
    // That's 3 stops >= max_stops_in_window (2)
    const currentTick = 5;
    const decision = shouldEscalate(state, config, currentTick);

    expect(decision.mode).toBe('human');
    expect(decision.reason).toContain('>= 2');
  });
});
