/**
 * Envoi type definitions.
 *
 * This module exports all public types for the Envoi project.
 */

export type {
  EnvoiConfig,
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
  ReviewerAuthConfig,
  ReviewerTriggerConfig,
  ReviewerConfig,
} from './config.js';

export type { LockInfo } from './lock.js';

export type {
  BlockedCode,
  PreflightResult,
  TransportStallStage,
  TransportStallError,
} from './preflight.js';

export type { BlockedData } from './blocked.js';

export {
  TickPhase,
} from './state.js';

export type {
  TickState,
  TickContext,
  StopHistoryEntry,
  GuardrailState,
  VerifyHistoryEntry,
  EscalationState,
} from './state.js';

export type { BuilderResult } from './builder.js';

export type {
  Task,
  TaskKind,
  Question,
  TaskScope,
  DiffLimits as TaskDiffLimits,
  TaskVerification,
  TaskBuilder,
} from './task.js';

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

export type {
  ReviewerInvocationConfig,
  ReviewerContext,
  ReviewerInvocationResult,
  ReviewerResult,
  ReviewerError,
} from './reviewer.js';
