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
