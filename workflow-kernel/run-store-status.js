// Run store + status aggregator.
//
// This module was a 957-line file mixing five concerns (opencode-workflows-nbp). It has been
// split along its five existing concerns using the documented RunContext coupling surface
// (run-context.js), plus a shared FS/primitive base:
//
//   - run-store-fs.js              shared FS/JSON/path/PID/run-root primitives + `runs` registry
//   - run-store-state.js           (1) durable state writes (writeState)
//   - run-store-locks.js           (2) lock-file management (acquire/read/clear, lifecycle requests)
//   - run-store-projections.js     (3) lane outcome / projection recording + checkpoints + salvage
//   - run-store-rehydrate.js       (4) run rehydration from prior on-disk state
//   - run-store-status-format.js   (5) status formatting (compact/full/list/cleanup/reconcile)
//
// This file now exists only to preserve the historical public surface: every symbol the old
// run-store-status.js exported is re-exported here so existing importers
// (workflow-plugin.js, sandbox-executor.js, child-agent-runner.js, lifecycle-control.js,
// role-template-loading.js) and the index.js barrel resolve identically.
// The split is behavior-preserving; no logic lives here.

export {
  PRIVATE_DIR_MODE,
  PRIVATE_FILE_MODE,
  LOCK_LIVENESS_FALLBACK_TTL_MS,
  runs,
  selfStartTime,
  readJsonFile,
  writeJsonAtomic,
  ensurePrivateDir,
  writeFilePrivate,
  appendFilePrivate,
  pathExists,
  assertSafeRunId,
  runDirForRoot,
  processStartTime,
  selfProcessStartTime,
  processAppearsAlive,
  currentProcessInfo,
  runRoot,
  globalRunRoot,
  runRoots,
  ensureRunRoot,
  assertContainedRealPath,
  assertContainedRunDir,
  safeProjectionName,
  isPathInside,
} from "./run-store-fs.js";

export {
  RUN_LOCK_FILE,
  APPLY_LOCK_FILE,
  CLEANUP_LOCK_FILE,
  CANCEL_REQUEST_FILE,
  PAUSE_REQUEST_FILE,
  KILL_REQUEST_FILE,
  lockPathForRun,
  cleanupLockPath,
  readLock,
  acquireWorkflowLock,
  runLocksForEntry,
  clearStaleRunLocks,
  lifecycleRequestPath,
  writeLifecycleRequest,
  readLifecycleRequests,
} from "./run-store-locks.js";

export {
  recordLaneOutcome,
  writeSalvagedLaneOutcome,
  recoverySummary,
  writeLaneProjection,
  writeDurableProjections,
  readLaneProjections,
  writeLaneCheckpoint,
  readLaneRequestCheckpoint,
  readLaneResultCheckpoint,
  removeLaneCheckpoint,
  computeSalvageCandidates,
  attachSalvageCandidates,
} from "./run-store-projections.js";

export { writeState, computeLastProgressAt, __setWriteStateTestHook } from "./run-store-state.js";

export { rehydrateRunFromPriorState } from "./run-store-rehydrate.js";

export {
  STALE_PROGRESS_THRESHOLD_MS,
  lastProgressAtForState,
  stalenessSignal,
  laneFailureSummaries,
  timeoutResumeEligibilityForState,
  readRunEntry,
  compactStatusForEntry,
  declaredProfileForState,
  resultStatusForEntry,
  notificationStatusForEntry,
  fullStatusForEntry,
  statusForEntry,
  eventsForEntry,
  eventsText,
  listRunEntries,
  cleanupProtectionReason,
  summarizeEntries,
  statusText,
  reconcileRuns,
  cleanupRuns,
  readRunById,
} from "./run-store-status-format.js";
