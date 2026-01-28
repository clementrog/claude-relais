/**
 * Risk scoring and reviewer trigger logic.
 *
 * Determines when the reviewer should be invoked based on deterministic
 * risk signals: high-risk file paths, diff fraction thresholds, repeated
 * stops, verification failures, and budget warnings.
 */

import micromatch from 'micromatch';
import type { DiffAnalysis } from './diff.js';
import type { ReviewerConfig, ReviewerTriggerConfig } from '../types/config.js';
import type { TaskScope, DiffLimits } from '../types/task.js';
import type { RiskFlags } from '../types/reviewer.js';

/**
 * Stop history entry representing a single stop event.
 */
export interface StopHistoryEntry {
  /** Tick number when the stop occurred */
  tick: number;
  /** Verdict of the stop (should be 'stop') */
  verdict: 'stop';
}

/**
 * Checks if any paths match high-risk glob patterns.
 *
 * Uses micromatch to check paths against high_risk_globs patterns.
 *
 * @param paths - Array of file paths to check
 * @param highRiskGlobs - Array of glob patterns for high-risk files
 * @returns Array of paths that match high-risk patterns
 *
 * @example
 * const riskyPaths = checkHighRiskGlobs(
 *   ['src/auth.ts', 'src/utils.ts'],
 *   ['src/auth*.ts', 'src/*secret*']
 * );
 */
export function checkHighRiskGlobs(
  paths: string[],
  highRiskGlobs: string[]
): string[] {
  if (highRiskGlobs.length === 0) {
    return [];
  }

  // Check if any paths match high-risk globs
  return paths.filter((path) => micromatch.isMatch(path, highRiskGlobs));
}

/**
 * Checks if diff fraction exceeds threshold.
 *
 * Calculates files_touched/max_files_touched or lines_changed/max_lines_changed
 * and checks if either fraction >= threshold.
 *
 * @param analysis - Diff analysis result
 * @param limits - Diff limits from task
 * @param threshold - Fraction threshold (0.0 to 1.0)
 * @returns True if diff fraction >= threshold
 *
 * @example
 * const analysis = { files_touched: 8, lines_changed: 300, ... };
 * const limits = { max_files_touched: 10, max_lines_changed: 400 };
 * const nearCap = checkDiffFraction(analysis, limits, 0.8);
 */
export function checkDiffFraction(
  analysis: DiffAnalysis,
  limits: DiffLimits,
  threshold: number
): boolean {
  if (threshold <= 0) {
    return false;
  }

  const lines_changed = analysis.lines_added + analysis.lines_deleted;
  
  // Calculate fractions
  const filesFraction =
    limits.max_files_touched > 0
      ? analysis.files_touched / limits.max_files_touched
      : 0;
  const linesFraction =
    limits.max_lines_changed > 0 ? lines_changed / limits.max_lines_changed : 0;

  // Check if either fraction exceeds threshold
  return filesFraction >= threshold || linesFraction >= threshold;
}

/**
 * Checks if there are repeated stops within a time window.
 *
 * Counts STOP verdicts in stop_history within the specified window
 * and checks if count >= maxStops.
 *
 * @param stopHistory - Array of stop history entries
 * @param window - Time window in ticks
 * @param maxStops - Maximum number of stops allowed in window
 * @param currentTick - Current tick number
 * @returns True if repeated stops detected
 *
 * @example
 * const history = [
 *   { tick: 5, verdict: 'stop' },
 *   { tick: 8, verdict: 'stop' },
 *   { tick: 12, verdict: 'stop' }
 * ];
 * const repeated = checkRepeatedStops(history, 10, 2, 12);
 */
export function checkRepeatedStops(
  stopHistory: StopHistoryEntry[],
  window: number,
  maxStops: number,
  currentTick: number
): boolean {
  if (window <= 0 || maxStops <= 0) {
    return false;
  }

  // Filter stops within the window (from currentTick - window to currentTick)
  const windowStart = Math.max(0, currentTick - window);
  const stopsInWindow = stopHistory.filter(
    (entry) => entry.verdict === 'stop' && entry.tick >= windowStart && entry.tick <= currentTick
  );

  return stopsInWindow.length >= maxStops;
}

/**
 * Computes risk flags based on various risk signals.
 *
 * Returns an array of risk flag strings indicating which risk conditions
 * have been triggered.
 *
 * @param params - Parameters for risk computation
 * @param params.analysis - Diff analysis result
 * @param params.limits - Diff limits from task
 * @param params.scope - Task scope configuration
 * @param params.trigger - Reviewer trigger configuration
 * @param params.stopHistory - Array of stop history entries
 * @param params.currentTick - Current tick number
 * @param params.verifyFailed - Whether verification failed
 * @param params.budgetWarning - Whether budget warning threshold reached
 * @returns Array of risk flag strings
 *
 * @example
 * const flags = computeRiskFlags({
 *   analysis,
 *   limits,
 *   scope,
 *   trigger,
 *   stopHistory: [],
 *   currentTick: 10,
 *   verifyFailed: false,
 *   budgetWarning: false
 * });
 */
export function computeRiskFlags(params: {
  analysis: DiffAnalysis;
  limits: DiffLimits;
  scope: TaskScope;
  trigger: ReviewerTriggerConfig;
  stopHistory: StopHistoryEntry[];
  currentTick: number;
  verifyFailed: boolean;
  budgetWarning: boolean;
}): RiskFlags[] {
  const {
    analysis,
    limits,
    scope,
    trigger,
    stopHistory,
    currentTick,
    verifyFailed,
    budgetWarning,
  } = params;

  const flags: RiskFlags[] = [];

  // Check high-risk paths
  if (trigger.on_high_risk_paths && trigger.high_risk_globs.length > 0) {
    const riskyPaths = checkHighRiskGlobs(
      analysis.touched_paths,
      trigger.high_risk_globs
    );
    if (riskyPaths.length > 0) {
      flags.push('high_risk_path');
    }
    
    // Also check if allowed_globs overlap with high_risk_globs (pattern-level check)
    // This is mentioned in the PRD as a risk trigger
    const hasOverlap = scope.allowed_globs.some((allowedGlob) =>
      trigger.high_risk_globs.some((riskGlob) => {
        // Check if patterns overlap by testing if they could match similar paths
        // Simple heuristic: check if one pattern could match the other
        try {
          return micromatch.isMatch(allowedGlob, [riskGlob]) || 
                 micromatch.isMatch(riskGlob, [allowedGlob]);
        } catch {
          // If pattern matching fails, skip this comparison
          return false;
        }
      })
    );
    
    if (hasOverlap && riskyPaths.length === 0) {
      // Pattern overlap detected even if no paths match yet
      flags.push('high_risk_path');
    }
  }

  // Check diff fraction threshold
  if (trigger.diff_fraction_threshold > 0) {
    const nearCap = checkDiffFraction(
      analysis,
      limits,
      trigger.diff_fraction_threshold
    );
    if (nearCap) {
      flags.push('diff_near_cap');
    }
  }

  // Check verification failure
  if (trigger.on_verify_fail && verifyFailed) {
    flags.push('verify_failed');
  }

  // Check repeated stops
  if (
    trigger.on_repeated_stop &&
    trigger.stop_window_ticks > 0 &&
    trigger.max_stops_in_window > 0
  ) {
    const repeated = checkRepeatedStops(
      stopHistory,
      trigger.stop_window_ticks,
      trigger.max_stops_in_window,
      currentTick
    );
    if (repeated) {
      flags.push('repeated_stop');
    }
  }

  // Check budget warning
  if (budgetWarning) {
    flags.push('budget_warning');
  }

  return flags;
}

/**
 * Determines if reviewer should be triggered based on risk flags and config.
 *
 * Returns true if reviewer is enabled and any trigger condition is met.
 *
 * @param config - Reviewer configuration
 * @param riskFlags - Array of risk flags from computeRiskFlags
 * @returns True if reviewer should be triggered
 *
 * @example
 * const shouldTrigger = shouldTriggerReviewer(config, ['high_risk_path', 'diff_near_cap']);
 */
export function shouldTriggerReviewer(
  config: ReviewerConfig,
  riskFlags: RiskFlags[]
): boolean {
  // Reviewer must be enabled
  if (!config.enabled) {
    return false;
  }

  // At least one risk flag must be present
  return riskFlags.length > 0;
}
