import { describe, it, expect } from 'vitest';
import {
  validateVerifyParam,
  validateAllParams,
  type ParamValidationResult,
} from '@/lib/verify-safety.js';
import type { VerificationConfig } from '@/types/config.js';

/**
 * Creates a mock VerificationConfig for testing.
 */
function createMockConfig(
  overrides: Partial<VerificationConfig> = {}
): VerificationConfig {
  return {
    execution_mode: 'argv_no_shell',
    max_param_len: 100,
    reject_whitespace_in_params: true,
    reject_dotdot: true,
    reject_metachars_regex: '[;&|`$(){}\\[\\]<>]',
    timeout_fast_seconds: 30,
    timeout_slow_seconds: 300,
    templates: [],
    ...overrides,
  };
}

describe('verify-safety', () => {
  describe('validateVerifyParam', () => {
    it('should accept valid parameters', () => {
      const config = createMockConfig();
      const result = validateVerifyParam('valid-param-value', config);

      expect(result.ok).toBe(true);
      expect(result.stopCode).toBeNull();
      expect(result.invalidParam).toBeNull();
      expect(result.reason).toBeNull();
    });

    it('should reject parameters exceeding max length', () => {
      const config = createMockConfig({ max_param_len: 10 });
      const longParam = 'a'.repeat(11);
      const result = validateVerifyParam(longParam, config);

      expect(result.ok).toBe(false);
      expect(result.stopCode).toBe('STOP_VERIFY_TAINTED');
      expect(result.reason).toContain('exceeds maximum');
      expect(result.reason).toContain('11');
      expect(result.reason).toContain('10');
    });

    it('should accept parameters at max length boundary', () => {
      const config = createMockConfig({ max_param_len: 10 });
      const param = 'a'.repeat(10);
      const result = validateVerifyParam(param, config);

      expect(result.ok).toBe(true);
    });

    it('should reject whitespace when reject_whitespace_in_params is true', () => {
      const config = createMockConfig({ reject_whitespace_in_params: true });
      const result = validateVerifyParam('param with space', config);

      expect(result.ok).toBe(false);
      expect(result.stopCode).toBe('STOP_VERIFY_TAINTED');
      expect(result.reason).toBe('Parameter contains whitespace');
    });

    it('should reject tabs when reject_whitespace_in_params is true', () => {
      const config = createMockConfig({ reject_whitespace_in_params: true });
      const result = validateVerifyParam('param\twith\ttab', config);

      expect(result.ok).toBe(false);
      expect(result.stopCode).toBe('STOP_VERIFY_TAINTED');
      expect(result.reason).toBe('Parameter contains whitespace');
    });

    it('should reject newlines when reject_whitespace_in_params is true', () => {
      const config = createMockConfig({ reject_whitespace_in_params: true });
      const result = validateVerifyParam('param\nwith\nnewline', config);

      expect(result.ok).toBe(false);
      expect(result.stopCode).toBe('STOP_VERIFY_TAINTED');
      expect(result.reason).toBe('Parameter contains whitespace');
    });

    it('should accept whitespace when reject_whitespace_in_params is false', () => {
      const config = createMockConfig({ reject_whitespace_in_params: false });
      const result = validateVerifyParam('param with space', config);

      expect(result.ok).toBe(true);
    });

    it('should reject ".." when reject_dotdot is true', () => {
      const config = createMockConfig({ reject_dotdot: true });
      const result = validateVerifyParam('../path', config);

      expect(result.ok).toBe(false);
      expect(result.stopCode).toBe('STOP_VERIFY_TAINTED');
      expect(result.reason).toContain("'..'");
    });

    it('should reject ".." in middle of path when reject_dotdot is true', () => {
      const config = createMockConfig({ reject_dotdot: true });
      const result = validateVerifyParam('path/../other', config);

      expect(result.ok).toBe(false);
      expect(result.stopCode).toBe('STOP_VERIFY_TAINTED');
      expect(result.reason).toContain("'..'");
    });

    it('should reject standalone ".." when reject_dotdot is true', () => {
      const config = createMockConfig({ reject_dotdot: true });
      const result = validateVerifyParam('..', config);

      expect(result.ok).toBe(false);
      expect(result.stopCode).toBe('STOP_VERIFY_TAINTED');
      expect(result.reason).toContain("'..'");
    });

    it('should accept ".." when reject_dotdot is false', () => {
      const config = createMockConfig({ reject_dotdot: false });
      const result = validateVerifyParam('../path', config);

      expect(result.ok).toBe(true);
    });

    it('should accept single dot when reject_dotdot is true', () => {
      const config = createMockConfig({ reject_dotdot: true });
      const result = validateVerifyParam('./path', config);

      expect(result.ok).toBe(true);
    });

    it('should reject metacharacters matching regex', () => {
      const config = createMockConfig({
        reject_metachars_regex: '[;&|`$(){}\\[\\]<>]',
      });
      const result = validateVerifyParam('param;command', config);

      expect(result.ok).toBe(false);
      expect(result.stopCode).toBe('STOP_VERIFY_TAINTED');
      expect(result.reason).toContain('metacharacter regex');
    });

    it('should reject various metacharacters', () => {
      const config = createMockConfig({
        reject_metachars_regex: '[;&|`$(){}\\[\\]<>]',
      });
      const metachars = [';', '&', '|', '`', '$', '(', ')', '{', '}', '[', ']', '<', '>'];

      for (const char of metachars) {
        const result = validateVerifyParam(`param${char}command`, config);
        expect(result.ok).toBe(false);
        expect(result.stopCode).toBe('STOP_VERIFY_TAINTED');
        expect(result.reason).toContain('metacharacter regex');
      }
    });

    it('should accept parameters without metacharacters', () => {
      const config = createMockConfig({
        reject_metachars_regex: '[;&|`$(){}\\[\\]<>]',
      });
      const result = validateVerifyParam('valid-param-value', config);

      expect(result.ok).toBe(true);
    });

    it('should handle invalid regex gracefully', () => {
      const config = createMockConfig({
        reject_metachars_regex: '[invalid-regex',
      });
      const result = validateVerifyParam('any-param', config);

      expect(result.ok).toBe(false);
      expect(result.stopCode).toBe('STOP_VERIFY_TAINTED');
      expect(result.reason).toContain('Invalid metacharacter regex');
    });

    it('should check all constraints in order', () => {
      // Length check should come first
      const config = createMockConfig({ max_param_len: 5 });
      const longParamWithWhitespace = 'a'.repeat(10) + ' space';
      const result = validateVerifyParam(longParamWithWhitespace, config);

      expect(result.ok).toBe(false);
      expect(result.reason).toContain('exceeds maximum');
    });

    it('should handle empty string', () => {
      const config = createMockConfig();
      const result = validateVerifyParam('', config);

      expect(result.ok).toBe(true);
    });
  });

  describe('validateAllParams', () => {
    it('should accept all valid parameters', () => {
      const config = createMockConfig();
      const params = {
        pkg: 'my-package',
        env: 'production',
        version: '1.0.0',
      };
      const result = validateAllParams(params, config);

      expect(result.ok).toBe(true);
      expect(result.stopCode).toBeNull();
      expect(result.invalidParam).toBeNull();
      expect(result.reason).toBeNull();
    });

    it('should return first failure with param name', () => {
      const config = createMockConfig({ max_param_len: 5 });
      const params = {
        pkg: 'valid',
        env: 'too-long-value',
        version: 'also-too-long',
      };
      const result = validateAllParams(params, config);

      expect(result.ok).toBe(false);
      expect(result.stopCode).toBe('STOP_VERIFY_TAINTED');
      expect(result.invalidParam).toBe('env');
      expect(result.reason).toContain('exceeds maximum');
    });

    it('should identify invalid param with whitespace', () => {
      const config = createMockConfig({ reject_whitespace_in_params: true });
      const params = {
        pkg: 'valid-package',
        env: 'invalid env',
      };
      const result = validateAllParams(params, config);

      expect(result.ok).toBe(false);
      expect(result.stopCode).toBe('STOP_VERIFY_TAINTED');
      expect(result.invalidParam).toBe('env');
      expect(result.reason).toBe('Parameter contains whitespace');
    });

    it('should identify invalid param with dotdot', () => {
      const config = createMockConfig({ reject_dotdot: true });
      const params = {
        pkg: 'valid-package',
        path: '../suspicious',
      };
      const result = validateAllParams(params, config);

      expect(result.ok).toBe(false);
      expect(result.stopCode).toBe('STOP_VERIFY_TAINTED');
      expect(result.invalidParam).toBe('path');
      expect(result.reason).toContain("'..'");
    });

    it('should identify invalid param with metacharacters', () => {
      const config = createMockConfig({
        reject_metachars_regex: '[;&|`$(){}\\[\\]<>]',
      });
      const params = {
        pkg: 'valid-package',
        cmd: 'test;rm-rf',
      };
      const result = validateAllParams(params, config);

      expect(result.ok).toBe(false);
      expect(result.stopCode).toBe('STOP_VERIFY_TAINTED');
      expect(result.invalidParam).toBe('cmd');
      expect(result.reason).toContain('metacharacter regex');
    });

    it('should handle empty params object', () => {
      const config = createMockConfig();
      const result = validateAllParams({}, config);

      expect(result.ok).toBe(true);
      expect(result.stopCode).toBeNull();
      expect(result.invalidParam).toBeNull();
      expect(result.reason).toBeNull();
    });

    it('should check all params even if first is invalid', () => {
      // This tests that we iterate through all params
      // The function returns first failure, so order matters
      const config = createMockConfig({ max_param_len: 5 });
      const params = {
        first: 'too-long-value',
        second: 'also-too-long',
      };
      const result = validateAllParams(params, config);

      expect(result.ok).toBe(false);
      expect(result.invalidParam).toBe('first');
    });
  });
});
