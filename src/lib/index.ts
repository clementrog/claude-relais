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
} from './git.js';

export { runPreflight } from './preflight.js';

export {
  generateRunId,
  createInitialState,
  transitionPhase,
  addError,
  setTask,
  setBuilderResult,
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
  type RollbackResult,
} from './rollback.js';
