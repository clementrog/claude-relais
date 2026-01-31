/**
 * Types for BLOCKED.json generation when preflight checks fail.
 *
 * When the runner cannot safely start, it writes BLOCKED.json explaining
 * the exact remediation required.
 */

/**
 * Simplified AJV error object for diagnostics.
 */
export interface AjvErrorObject {
  /** JSON pointer to the failing instance */
  instancePath: string;
  /** JSON pointer to the schema keyword that failed */
  schemaPath: string;
  /** The validation keyword that failed (e.g., 'required', 'type') */
  keyword: string;
  /** Keyword-specific parameters */
  params: Record<string, unknown>;
  /** Human-readable error message */
  message?: string;
}

/**
 * Diagnostics for orchestrator failures.
 */
export interface OrchestratorDiagnostics {
  /** Raw AJV schema errors */
  schema_errors?: AjvErrorObject[];
  /** Excerpt of orchestrator stdout (last N chars) */
  stdout_excerpt?: string;
  /** Excerpt of orchestrator stderr */
  stderr_excerpt?: string;
  /** The extracted JSON that failed validation */
  json_excerpt?: string;
  /** How JSON was extracted (e.g., 'direct_parse', 'code_block', 'none') */
  extract_method?: string;
}

/**
 * Data structure for BLOCKED.json file.
 */
export interface BlockedData {
  /** ISO datetime when the block occurred */
  blocked_at: string;
  /** The specific BLOCKED_* code indicating why execution is blocked */
  code: string;
  /** Human-readable explanation of why execution is blocked */
  reason: string;
  /** Actionable instructions for what the user should do to fix the issue */
  remediation: string;
  /** Optional diagnostics for orchestrator failures */
  diagnostics?: OrchestratorDiagnostics;
}
