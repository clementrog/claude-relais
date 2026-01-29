/**
 * Relais library utilities.
 *
 * This module exports all public utilities for the Relais project.
 */

export {
  atomicWriteJson,
  atomicReadJson,
  cleanupTmpFiles,
  AtomicFsError,
} from './fs.js';

export {
  loadConfig,
  findConfigFile,
  validateConfig,
  ConfigError,
  CONFIG_FILE_NAME,
} from './config.js';

export {
  getBootId,
  isPidRunning,
  isLockStale,
  acquireLock,
  releaseLock,
  LockHeldError,
} from './lock.js';

export {
  isGitRepo,
  isWorktreeClean,
  getHeadCommit,
  getDiffFiles,
  getUntrackedFiles,
  getCurrentBranch,
  stashPilotFiles,
  popPilotStash,
} from './git.js';

export { runPreflight } from './preflight.js';

export {
  generateRunId,
  createInitialState,
  transitionPhase,
  addError,
  setTask,
  setBuilderResult,
  appendStopHistory,
  clearForcePatch,
  setForcePatch,
  updateTaskFingerprint,
  recordTaskFailure,
  resetFailureStreak,
  appendVerifyHistory,
} from './state.js';

export {
  buildClaudeArgs,
  parseClaudeResponse,
  invokeClaudeCode,
} from './claude.js';

export {
  loadSchema,
  validateWithSchema,
  type ValidationResult,
} from './schema.js';

export {
  getTouchedTracked,
  getTouchedUntracked,
  getDiffStats,
  analyzeDiff,
  checkDiffLimits,
  formatBlastRadius,
  type DiffAnalysis,
  type DiffLimitCheckResult,
} from './diff.js';

export {
  matchesGlob,
  checkScopeViolations,
  SCOPE_VIOLATION_FORBIDDEN,
  SCOPE_VIOLATION_OUTSIDE_ALLOWED,
  NEW_FILE_FORBIDDEN,
  LOCKFILE_CHANGE_FORBIDDEN,
  type ScopeCheckResult,
  type ScopeViolation,
} from './scope.js';

export {
  interpolateArgs,
  executeVerification,
  runVerifications,
  validateParam,
  validateVerificationParams,
  type VerificationRun,
  type ParamValidationError,
  type ParamValidationResult,
} from './verify.js';

export {
  rollbackTracked,
  removeUntrackedPaths,
  rollback,
  rollbackToCommit,
  verifyCleanWorktree,
  type RollbackResult,
  type RollbackResultNew,
} from './rollback.js';

export {
  generateRunId as generateReportRunId,
  buildReport,
  writeReport,
  renderReportMarkdown,
  writeReportMarkdown,
  type TickReportData,
} from './report.js';

export {
  createHistorySnapshot,
  writeHistoryArtifact,
  snapshotRun,
  getHistoryCount,
} from './history.js';

export {
  buildBlockedData,
  writeBlocked,
} from './blocked.js';

export {
  invokeReviewer,
  parseReviewerOutput,
  checkReviewerAuth,
} from './reviewer.js';

export {
  checkHighRiskGlobs,
  checkDiffFraction,
  checkRepeatedStops,
  computeRiskFlags,
  shouldTriggerReviewer,
  type StopHistoryEntry,
} from './risk.js';

export {
  runReviewerIfNeeded,
  handleReviewerDecision,
  type ReviewerFlowContext,
  type ReviewerFlowResult,
} from './reviewer-flow.js';

export {
  checkCodexCli,
  type ReviewerDoctorResult,
} from './doctor.js';

export {
  canonicalizeTask,
  computeFingerprint,
} from './fingerprint.js';

export {
  checkBranchMatch,
  checkFingerprintMatch,
  checkWorktreeClean,
  runGuardrailPreflight,
  classifyVerifyResult,
  shouldEscalate,
  checkMergeEligibility,
  type GuardrailState,
  type PreflightResult as GuardrailPreflightResult,
  type VerifyResultType,
  type VerifyClassification,
  type EscalationDecision,
  type MergeEligibility,
  type MergeEligibilityReport,
} from './guardrails.js';

export {
  isTransportStall,
  createTransportStallError,
  invokeWithStallDetection,
  normalizeTransportError,
  isTransportStallError,
  type StallDetectionResult,
  type InvokeResult,
  type NormalizedError,
} from './transport.js';
