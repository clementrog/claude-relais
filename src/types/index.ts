/**
 * Relais type definitions.
 *
 * This module exports all public types for the Relais project.
 */

export type {
  RelaisConfig,
  RunnerConfig,
  CrashCleanupConfig,
  RenderReportMdConfig,
  ClaudeCodeCliConfig,
  ModelsConfig,
  OrchestratorConfig,
  ClaudeCodeBuilderConfig,
  PatchBuilderConfig,
  BuilderConfig,
  ScopeConfig,
  DiffLimitsConfig,
  VerificationParam,
  VerificationTemplate,
  VerificationConfig,
  PerMilestoneBudgets,
  BudgetsConfig,
  HistoryConfig,
} from './config.js';

export type { LockInfo } from './lock.js';

export type { BlockedCode, PreflightResult } from './preflight.js';

export {
  TickPhase,
} from './state.js';

export type {
  TickState,
  TickContext,
  Task,
  BuilderResult,
} from './state.js';

export type {
  Verdict,
  ReportCode,
  BlastRadius,
  ScopeResult,
  DiffInfo,
  VerificationRun,
  VerificationResult,
  BudgetInfo,
  TaskSummary,
  ReportPointers,
  ReportData,
} from './report.js';

export type {
  ClaudeInvocation,
  ClaudeResponse,
} from './claude.js';

export { ClaudeError } from './claude.js';
