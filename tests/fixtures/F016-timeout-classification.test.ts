/**
 * F016: timeout_classification
 * 
 * Verify that timed out verify command is classified as TIMEOUT
 * with STOP_VERIFY_FLAKY_OR_TIMEOUT.
 */

import { describe, it, expect } from 'vitest';
import { classifyVerifyResult } from '@/lib/guardrails.js';

describe('F016: timeout_classification', () => {
  it('should classify timed out command as TIMEOUT with STOP_VERIFY_FLAKY_OR_TIMEOUT', () => {
    const result = classifyVerifyResult(124, true, 30000, 'fast');

    expect(result.resultType).toBe('TIMEOUT');
    expect(result.stopCode).toBe('STOP_VERIFY_FLAKY_OR_TIMEOUT');
    expect(result.shouldIncrementFailureStreak).toBe(true);
  });

  it('should classify timeout in fast phase as TIMEOUT', () => {
    const result = classifyVerifyResult(124, true, 90000, 'fast');

    expect(result.resultType).toBe('TIMEOUT');
    expect(result.stopCode).toBe('STOP_VERIFY_FLAKY_OR_TIMEOUT');
  });

  it('should classify timeout in slow phase as TIMEOUT', () => {
    const result = classifyVerifyResult(124, true, 600000, 'slow');

    expect(result.resultType).toBe('TIMEOUT');
    expect(result.stopCode).toBe('STOP_VERIFY_FLAKY_OR_TIMEOUT');
  });

  it('should prioritize TIMEOUT over exit code 0', () => {
    // Even if exit code is 0, if timed out, it should be TIMEOUT
    const result = classifyVerifyResult(0, true, 30000, 'fast');

    expect(result.resultType).toBe('TIMEOUT');
    expect(result.stopCode).toBe('STOP_VERIFY_FLAKY_OR_TIMEOUT');
    expect(result.shouldIncrementFailureStreak).toBe(true);
  });

  it('should prioritize TIMEOUT over non-zero exit code', () => {
    // Even if exit code is non-zero, if timed out, it should be TIMEOUT
    const result = classifyVerifyResult(1, true, 30000, 'fast');

    expect(result.resultType).toBe('TIMEOUT');
    expect(result.stopCode).toBe('STOP_VERIFY_FLAKY_OR_TIMEOUT');
  });

  it('should always increment failure_streak for TIMEOUT', () => {
    const result1 = classifyVerifyResult(124, true, 30000, 'fast');
    const result2 = classifyVerifyResult(0, true, 30000, 'slow');
    const result3 = classifyVerifyResult(1, true, 30000, 'fast');

    expect(result1.shouldIncrementFailureStreak).toBe(true);
    expect(result2.shouldIncrementFailureStreak).toBe(true);
    expect(result3.shouldIncrementFailureStreak).toBe(true);
  });

  it('should not classify non-timed-out command as TIMEOUT', () => {
    const result = classifyVerifyResult(0, false, 1500, 'fast');

    expect(result.resultType).not.toBe('TIMEOUT');
    expect(result.resultType).toBe('PASS');
    expect(result.stopCode).toBeNull();
  });

  it('should classify non-zero exit code without timeout as FAIL', () => {
    const result = classifyVerifyResult(1, false, 2000, 'fast');

    expect(result.resultType).not.toBe('TIMEOUT');
    expect(result.resultType).toBe('FAIL');
    expect(result.stopCode).toBe('STOP_VERIFY_FAILED_FAST');
  });

  it('should handle timeout with standard timeout exit code (124)', () => {
    // Exit code 124 is the standard timeout exit code
    const result = classifyVerifyResult(124, true, 30000, 'fast');

    expect(result.resultType).toBe('TIMEOUT');
    expect(result.stopCode).toBe('STOP_VERIFY_FLAKY_OR_TIMEOUT');
  });

  it('should handle timeout regardless of duration', () => {
    const result1 = classifyVerifyResult(124, true, 1000, 'fast');
    const result2 = classifyVerifyResult(124, true, 90000, 'fast');
    const result3 = classifyVerifyResult(124, true, 600000, 'slow');

    expect(result1.resultType).toBe('TIMEOUT');
    expect(result2.resultType).toBe('TIMEOUT');
    expect(result3.resultType).toBe('TIMEOUT');
    expect(result1.stopCode).toBe('STOP_VERIFY_FLAKY_OR_TIMEOUT');
    expect(result2.stopCode).toBe('STOP_VERIFY_FLAKY_OR_TIMEOUT');
    expect(result3.stopCode).toBe('STOP_VERIFY_FLAKY_OR_TIMEOUT');
  });
});
