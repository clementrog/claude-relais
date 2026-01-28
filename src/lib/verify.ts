/**
 * Verification command execution module.
 *
 * Provides functions to execute verification commands safely using argv arrays
 * (no shell) with parameter interpolation and timeout handling.
 */

import { spawn, ChildProcess } from 'node:child_process';
import type {
  VerificationTemplate,
  VerificationConfig,
} from '../types/config.js';
import type { Task, TaskVerification } from '../types/task.js';

/**
 * Result of a single verification command execution.
 */
export interface VerificationRun {
  /** ID of the verification template */
  template_id: string;
  /** Process exit code */
  exit_code: number;
  /** Captured stdout */
  stdout: string;
  /** Captured stderr */
  stderr: string;
  /** Execution time in milliseconds */
  duration_ms: number;
  /** Whether the command succeeded (exit_code === 0) */
  success: boolean;
}

/**
 * Validation error for a single parameter.
 */
export interface ParamValidationError {
  /** Name of the parameter */
  param_name: string;
  /** The invalid value */
  value: string;
  /** Reason for failure: too_long, whitespace, dotdot, or metachar */
  reason: 'too_long' | 'whitespace' | 'dotdot' | 'metachar';
}

/**
 * Result of parameter validation.
 */
export interface ParamValidationResult {
  /** True if all parameters are valid */
  ok: boolean;
  /** List of validation failures */
  errors: ParamValidationError[];
}

/**
 * Validates a single parameter value against security constraints.
 *
 * Checks for:
 * - Length exceeding max_param_len
 * - Whitespace (if reject_whitespace_in_params is true)
 * - Path traversal '..' (if reject_dotdot is true)
 * - Shell metacharacters (using reject_metachars_regex)
 *
 * @param paramName - Name of the parameter being validated
 * @param value - The parameter value to validate (converted to string)
 * @param config - Verification configuration with validation rules
 * @returns ParamValidationError if validation fails, null if valid
 */
export function validateParam(
  paramName: string,
  value: string | number | boolean | null,
  config: VerificationConfig
): ParamValidationError | null {
  // Convert value to string for validation
  const strValue = value === null ? '' : String(value);

  // Check length
  if (strValue.length > config.max_param_len) {
    return {
      param_name: paramName,
      value: strValue,
      reason: 'too_long',
    };
  }

  // Check for whitespace if enabled
  if (config.reject_whitespace_in_params && /\s/.test(strValue)) {
    return {
      param_name: paramName,
      value: strValue,
      reason: 'whitespace',
    };
  }

  // Check for path traversal '..' if enabled
  if (config.reject_dotdot) {
    // Match: ../, ^..$, /..$
    if (/\.\.\/|^\.\.$|\/\.\.$/.test(strValue)) {
      return {
        param_name: paramName,
        value: strValue,
        reason: 'dotdot',
      };
    }
  }

  // Check for shell metacharacters
  try {
    const metacharRegex = new RegExp(config.reject_metachars_regex);
    if (metacharRegex.test(strValue)) {
      return {
        param_name: paramName,
        value: strValue,
        reason: 'metachar',
      };
    }
  } catch (error) {
    // If regex is invalid, treat as validation failure
    // This shouldn't happen with valid config, but be defensive
    return {
      param_name: paramName,
      value: strValue,
      reason: 'metachar',
    };
  }

  return null;
}

/**
 * Validates all verification parameters for a task.
 *
 * Validates all parameters in task.verification.params against the security
 * constraints defined in the verification config.
 *
 * @param task - Task containing verification configuration and parameters
 * @param config - Verification configuration with validation rules
 * @returns ParamValidationResult with ok=true if all params valid, errors otherwise
 *
 * @example
 * ```typescript
 * const result = validateVerificationParams(task, config.verification);
 * if (!result.ok) {
 *   // Handle validation errors
 *   console.error('Invalid parameters:', result.errors);
 * }
 * ```
 */
export function validateVerificationParams(
  task: Task,
  config: VerificationConfig
): ParamValidationResult {
  const errors: ParamValidationError[] = [];
  const verification = task.verification;
  const params = verification.params ?? {};

  // Validate all parameters for all templates
  for (const [templateId, templateParams] of Object.entries(params)) {
    for (const [paramName, paramValue] of Object.entries(templateParams)) {
      const error = validateParam(paramName, paramValue, config);
      if (error) {
        // Prefix param name with template ID for clarity
        errors.push({
          ...error,
          param_name: `${templateId}.${error.param_name}`,
        });
      }
    }
  }

  return {
    ok: errors.length === 0,
    errors,
  };
}

/**
 * Interpolates parameter placeholders in command arguments.
 *
 * Replaces {{param_name}} placeholders with values from the params object.
 *
 * @param args - Array of command arguments that may contain {{param}} placeholders
 * @param params - Object mapping parameter names to values
 * @returns Array of arguments with placeholders replaced
 *
 * @example
 * ```typescript
 * interpolateArgs(['--filter', '{{pkg}}'], { pkg: 'my-package' })
 * // Returns: ['--filter', 'my-package']
 * ```
 */
export function interpolateArgs(
  args: string[],
  params: Record<string, string | number | boolean | null>
): string[] {
  return args.map((arg) => {
    // Replace {{param_name}} placeholders
    return arg.replace(/\{\{(\w+)\}\}/g, (match, paramName) => {
      const value = params[paramName];
      if (value === undefined) {
        throw new Error(
          `Missing parameter '${paramName}' for template argument '${arg}'`
        );
      }
      // Convert to string, handling null explicitly
      return value === null ? '' : String(value);
    });
  });
}

/**
 * Executes a single verification command.
 *
 * Runs the command using spawn with shell:false for security. Captures stdout
 * and stderr, enforces timeout, and returns execution results.
 *
 * @param template - Verification template containing cmd and args
 * @param params - Parameters for template argument interpolation
 * @param timeoutMs - Timeout in milliseconds (0 means no timeout)
 * @returns Promise resolving to VerificationRun result
 *
 * @example
 * ```typescript
 * const result = await executeVerification(
 *   { id: 'lint', cmd: 'pnpm', args: ['-w', 'lint'] },
 *   {},
 *   90000
 * );
 * ```
 */
export async function executeVerification(
  template: VerificationTemplate,
  params: Record<string, string | number | boolean | null>,
  timeoutMs: number
): Promise<VerificationRun> {
  const startTime = Date.now();
  let stdout = '';
  let stderr = '';

  // Interpolate parameters in args
  const args = interpolateArgs(template.args, params);

  return new Promise<VerificationRun>((resolve, reject) => {
    let timeoutId: NodeJS.Timeout | null = null;
    let child: ChildProcess | null = null;

    // Set up timeout handler
    const handleTimeout = () => {
      if (child) {
        child.kill('SIGTERM');
        // Give it a moment to terminate gracefully, then force kill
        setTimeout(() => {
          if (child && !child.killed) {
            child.kill('SIGKILL');
          }
        }, 1000);
      }
      const durationMs = Date.now() - startTime;
      resolve({
        template_id: template.id,
        exit_code: 124, // Standard timeout exit code
        stdout,
        stderr: stderr + '\n[Command timed out]',
        duration_ms: durationMs,
        success: false,
      });
    };

    // Set up timeout if specified
    if (timeoutMs > 0) {
      timeoutId = setTimeout(handleTimeout, timeoutMs);
    }

    try {
      // Spawn the process with shell:false for security
      child = spawn(template.cmd, args, {
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      // Capture stdout
      child.stdout?.on('data', (data: Buffer) => {
        stdout += data.toString();
      });

      // Capture stderr
      child.stderr?.on('data', (data: Buffer) => {
        stderr += data.toString();
      });

      // Handle process completion
      child.on('close', (code: number | null) => {
        if (timeoutId) {
          clearTimeout(timeoutId);
        }

        const durationMs = Date.now() - startTime;
        const exitCode = code ?? 0;

        // If process was killed by timeout, result was already resolved
        if (code === null && timeoutId) {
          return;
        }

        resolve({
          template_id: template.id,
          exit_code: exitCode,
          stdout,
          stderr,
          duration_ms: durationMs,
          success: exitCode === 0,
        });
      });

      // Handle process errors
      child.on('error', (error: Error) => {
        if (timeoutId) {
          clearTimeout(timeoutId);
        }

        const durationMs = Date.now() - startTime;
        resolve({
          template_id: template.id,
          exit_code: 1,
          stdout,
          stderr: stderr + `\n[Process error: ${error.message}]`,
          duration_ms: durationMs,
          success: false,
        });
      });
    } catch (error) {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }

      const durationMs = Date.now() - startTime;
      resolve({
        template_id: template.id,
        exit_code: 1,
        stdout,
        stderr: stderr + `\n[Failed to spawn process: ${error instanceof Error ? error.message : String(error)}]`,
        duration_ms: durationMs,
        success: false,
      });
    }
  });
}

/**
 * Runs verification commands for a task.
 *
 * Executes fast verifications first, then slow verifications. Each verification
 * uses the appropriate timeout from config. Parameters are taken from the task's
 * verification.params object, keyed by template ID.
 *
 * @param templates - Map of template ID to VerificationTemplate
 * @param task - Task containing verification configuration
 * @param config - Verification configuration with timeouts
 * @returns Promise resolving to array of VerificationRun results
 *
 * @example
 * ```typescript
 * const templates = new Map([
 *   ['lint', { id: 'lint', cmd: 'pnpm', args: ['-w', 'lint'] }]
 * ]);
 * const runs = await runVerifications(templates, task, config.verification);
 * ```
 */
export async function runVerifications(
  templates: Map<string, VerificationTemplate>,
  task: Task,
  config: VerificationConfig
): Promise<VerificationRun[]> {
  const results: VerificationRun[] = [];
  const verification = task.verification;
  const params = verification.params ?? {};

  // Run fast verifications first
  for (const templateId of verification.fast) {
    const template = templates.get(templateId);
    if (!template) {
      throw new Error(
        `Verification template '${templateId}' not found in config`
      );
    }

    const templateParams = params[templateId] ?? {};
    const timeoutMs = config.timeout_fast_seconds * 1000;

    const result = await executeVerification(template, templateParams, timeoutMs);
    results.push(result);
  }

  // Then run slow verifications
  for (const templateId of verification.slow) {
    const template = templates.get(templateId);
    if (!template) {
      throw new Error(
        `Verification template '${templateId}' not found in config`
      );
    }

    const templateParams = params[templateId] ?? {};
    const timeoutMs = config.timeout_slow_seconds * 1000;

    const result = await executeVerification(template, templateParams, timeoutMs);
    results.push(result);
  }

  return results;
}
