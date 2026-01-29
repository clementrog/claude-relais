/**
 * Verification parameter safety validation module.
 *
 * Provides functions to validate verification parameters against security constraints
 * to prevent shell injection and other security issues.
 */

import type { VerificationConfig } from '../types/config.js';

/**
 * Result of parameter validation.
 */
export interface ParamValidationResult {
  /** True if the parameter(s) are valid */
  ok: boolean;
  /** Stop code to use if validation fails */
  stopCode: 'STOP_VERIFY_TAINTED' | null;
  /** Name of the invalid parameter (if any) */
  invalidParam: string | null;
  /** Reason for validation failure */
  reason: string | null;
}

/**
 * Validates a single verification parameter against security constraints.
 *
 * Checks for:
 * - Length exceeding max_param_len
 * - Whitespace (if reject_whitespace_in_params is true)
 * - Path traversal '..' (if reject_dotdot is true)
 * - Shell metacharacters (using reject_metachars_regex)
 *
 * @param param - The parameter value to validate
 * @param config - Verification configuration with validation rules
 * @returns ParamValidationResult with ok=true if valid, or failure details
 *
 * @example
 * ```typescript
 * const result = validateVerifyParam('my-value', config);
 * if (!result.ok) {
 *   console.error(`Invalid param: ${result.reason}`);
 * }
 * ```
 */
export function validateVerifyParam(
  param: string,
  config: VerificationConfig
): ParamValidationResult {
  // Check length
  if (param.length > config.max_param_len) {
    return {
      ok: false,
      stopCode: 'STOP_VERIFY_TAINTED',
      invalidParam: null,
      reason: `Parameter length ${param.length} exceeds maximum ${config.max_param_len}`,
    };
  }

  // Check for whitespace if enabled
  if (config.reject_whitespace_in_params && /\s/.test(param)) {
    return {
      ok: false,
      stopCode: 'STOP_VERIFY_TAINTED',
      invalidParam: null,
      reason: 'Parameter contains whitespace',
    };
  }

  // Check for path traversal '..' if enabled
  if (config.reject_dotdot && param.includes('..')) {
    return {
      ok: false,
      stopCode: 'STOP_VERIFY_TAINTED',
      invalidParam: null,
      reason: "Parameter contains '..' path traversal",
    };
  }

  // Check for shell metacharacters
  try {
    const metacharRegex = new RegExp(config.reject_metachars_regex);
    if (metacharRegex.test(param)) {
      return {
        ok: false,
        stopCode: 'STOP_VERIFY_TAINTED',
        invalidParam: null,
        reason: `Parameter matches metacharacter regex: ${config.reject_metachars_regex}`,
      };
    }
  } catch (error) {
    // If regex is invalid, treat as validation failure
    // This shouldn't happen with valid config, but be defensive
    return {
      ok: false,
      stopCode: 'STOP_VERIFY_TAINTED',
      invalidParam: null,
      reason: `Invalid metacharacter regex in config: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  // All checks passed
  return {
    ok: true,
    stopCode: null,
    invalidParam: null,
    reason: null,
  };
}

/**
 * Validates all parameters in a record, returning the first failure.
 *
 * Validates each parameter value in the params object against the security
 * constraints defined in the verification config. Returns the first validation
 * failure encountered, or success if all parameters are valid.
 *
 * @param params - Record mapping parameter names to string values
 * @param config - Verification configuration with validation rules
 * @returns ParamValidationResult with ok=true if all params valid, or first failure details
 *
 * @example
 * ```typescript
 * const result = validateAllParams({ pkg: 'my-package', env: 'prod' }, config);
 * if (!result.ok) {
 *   console.error(`Invalid param '${result.invalidParam}': ${result.reason}`);
 * }
 * ```
 */
export function validateAllParams(
  params: Record<string, string>,
  config: VerificationConfig
): ParamValidationResult {
  for (const [paramName, paramValue] of Object.entries(params)) {
    const result = validateVerifyParam(paramValue, config);
    if (!result.ok) {
      return {
        ...result,
        invalidParam: paramName,
      };
    }
  }

  // All parameters are valid
  return {
    ok: true,
    stopCode: null,
    invalidParam: null,
    reason: null,
  };
}
