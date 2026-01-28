/**
 * F010: verify_taint_rejected
 * 
 * Verify that verification parameters with metacharacters result in
 * STOP_VERIFY_TAINTED.
 */

import { describe, it, expect } from 'vitest';
import { validateParam, validateVerificationParams } from '@/lib/verify.js';
import { createMockConfig, createMockTask } from '../helpers/mocks.js';

describe('F010: verify_taint_rejected', () => {
  it('should detect metacharacter in parameter value', () => {
    const config = createMockConfig({
      verification: {
        execution_mode: 'argv_no_shell',
        max_param_len: 128,
        reject_whitespace_in_params: false, // Disable whitespace check to test metachar
        reject_dotdot: true,
        reject_metachars_regex: '[;&|$\\\\><(){}\\[\\]`\\n\\r\\t\\0]',
        timeout_fast_seconds: 90,
        timeout_slow_seconds: 600,
        templates: [],
      },
    });

    // Parameter with shell metacharacter (semicolon) - no whitespace
    const error = validateParam('pkg', 'a;rm-rf', config.verification);

    expect(error).not.toBeNull();
    expect(error?.param_name).toBe('pkg');
    expect(error?.value).toBe('a;rm-rf');
    expect(error?.reason).toBe('metachar');
  });

  it('should detect multiple metacharacters', () => {
    const config = createMockConfig({
      verification: {
        execution_mode: 'argv_no_shell',
        max_param_len: 128,
        reject_whitespace_in_params: true,
        reject_dotdot: true,
        reject_metachars_regex: '[;&|$\\\\><(){}\\[\\]`\\n\\r\\t\\0]',
        timeout_fast_seconds: 90,
        timeout_slow_seconds: 600,
        templates: [],
      },
    });

    // Parameter with pipe and ampersand
    const error = validateParam('cmd', 'test|rm&', config.verification);

    expect(error).not.toBeNull();
    expect(error?.reason).toBe('metachar');
  });

  it('should detect backslash metacharacter', () => {
    const config = createMockConfig({
      verification: {
        execution_mode: 'argv_no_shell',
        max_param_len: 128,
        reject_whitespace_in_params: true,
        reject_dotdot: true,
        reject_metachars_regex: '[;&|$\\\\><(){}\\[\\]`\\n\\r\\t\\0]',
        timeout_fast_seconds: 90,
        timeout_slow_seconds: 600,
        templates: [],
      },
    });

    const error = validateParam('path', 'test\\file', config.verification);

    expect(error).not.toBeNull();
    expect(error?.reason).toBe('metachar');
  });

  it('should detect newline metacharacter', () => {
    const config = createMockConfig({
      verification: {
        execution_mode: 'argv_no_shell',
        max_param_len: 128,
        reject_whitespace_in_params: false, // Disable whitespace check to test metachar
        reject_dotdot: true,
        reject_metachars_regex: '[;&|$\\\\><(){}\\[\\]`\\n\\r\\t\\0]',
        timeout_fast_seconds: 90,
        timeout_slow_seconds: 600,
        templates: [],
      },
    });

    const error = validateParam('text', 'line1\nline2', config.verification);

    expect(error).not.toBeNull();
    expect(error?.reason).toBe('metachar');
  });

  it('should pass valid parameters without metacharacters', () => {
    const config = createMockConfig({
      verification: {
        execution_mode: 'argv_no_shell',
        max_param_len: 128,
        reject_whitespace_in_params: true,
        reject_dotdot: true,
        reject_metachars_regex: '[;&|$\\\\><(){}\\[\\]`\\n\\r\\t\\0]',
        timeout_fast_seconds: 90,
        timeout_slow_seconds: 600,
        templates: [],
      },
    });

    const error = validateParam('pkg', 'my-package', config.verification);

    expect(error).toBeNull();
  });

  it('should validate all parameters via validateVerificationParams', () => {
    const config = createMockConfig({
      verification: {
        execution_mode: 'argv_no_shell',
        max_param_len: 128,
        reject_whitespace_in_params: false, // Disable whitespace check to test metachar
        reject_dotdot: true,
        reject_metachars_regex: '[;&|$\\\\><(){}\\[\\]`\\n\\r\\t\\0]',
        timeout_fast_seconds: 90,
        timeout_slow_seconds: 600,
        templates: [],
      },
    });

    const task = createMockTask('execute', {
      verification: {
        fast: [],
        slow: [],
        params: {
          test_filter: {
            pkg: 'a;rm-rf', // Metacharacter in param (no whitespace)
          },
        },
      },
    });

    const result = validateVerificationParams(task, config.verification);

    expect(result.ok).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0].reason).toBe('metachar');
    expect(result.errors[0].param_name).toContain('test_filter');
  });

  it('should detect metacharacter in multiple template parameters', () => {
    const config = createMockConfig({
      verification: {
        execution_mode: 'argv_no_shell',
        max_param_len: 128,
        reject_whitespace_in_params: true,
        reject_dotdot: true,
        reject_metachars_regex: '[;&|$\\\\><(){}\\[\\]`\\n\\r\\t\\0]',
        timeout_fast_seconds: 90,
        timeout_slow_seconds: 600,
        templates: [],
      },
    });

    const task = createMockTask('execute', {
      verification: {
        fast: [],
        slow: [],
        params: {
          template1: {
            param1: 'value|test',
          },
          template2: {
            param2: 'value&test',
          },
        },
      },
    });

    const result = validateVerificationParams(task, config.verification);

    expect(result.ok).toBe(false);
    expect(result.errors.length).toBeGreaterThanOrEqual(2);
    expect(result.errors.every(e => e.reason === 'metachar')).toBe(true);
  });
});
