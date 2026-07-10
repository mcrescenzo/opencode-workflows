// Kernel barrel. Real modules own their symbols; the workflow-plugin orchestrator
// exposes only its core (sandbox/run/child/apply/git/lane) symbols.
import WorkflowPlugin from "./workflow-plugin.js";
import * as kernel from "./index.js";
export { default } from "./workflow-plugin.js";
export {
  acquireAgentSlot,
  applyWorkflow,
  approvalSummary,
  assertGitCleanAtBase,
  cleanupWorktrees,
  configureWorkflowEntrypoints,
  executeSandbox,
  gitHead,
  gitOutput,
  gitPathTracked,
  isRunAborted,
  normalizePatches,
  planWorkflowEnvelope,
  releaseAgentSlot,
  rollbackPatches,
  runWorkflowExecution,
  salvageRun,
  startWorkflow,
  throwIfAborted,
  validatePatchTargets,
} from "./workflow-plugin.js";
export * from "./approval-hashing.js";
export * from "./async-util.js";
export * from "./audited-shell-policy.js";
export * from "./authority-policy.js";
export * from "./budget-accounting.js";
export * from "./capability-adapter.js";
export * from "./child-agent-runner.js";
export * from "./constants.js";
export * from "./drain-runtime.js";
export * from "./errors.js";
export * from "./event-journal.js";
export * from "./extension-registry.js";
export * from "./git-util.js";
export * from "./integration-mode.js";
export * from "./lifecycle-control.js";
export * from "./lane-effort-policy.js";
export * from "./notification-toast.js";
export * from "./notification-toast-cards.js";
export * from "./notification-toast-policy.js";
export * from "./notification-toast-scope.js";
export * from "./path-policy.js";
export * from "./role-template-loading.js";
export * from "./result-readback.js";
export * from "./run-context.js";
export * from "./run-observability.js";
export * from "./run-store-status.js";
export * from "./sandbox-executor.js";
export * from "./session-access.js";
export * from "./structured-output.js";
export * from "./text-json.js";
export * from "./workflow-source.js";
export * from "./worktree-adapter.js";
export { isPathInside, parseWorktreeList } from "./worktree-git.js";

// Test-only surface. The orchestrator's WorkflowPlugin.__test carries only its core
// (sandbox/run/child/apply/git/lane) symbols; the extracted modules own everything else.
// Aggregate the kernel barrel (this module's own namespace) onto __test so test suites
// reach module internals via this barrel's default export without importing the entry
// (opencode-workflows.js). The orchestrator's own __test wins on conflict. Not part of the runtime
// plugin contract.
WorkflowPlugin.__test = { ...kernel, ...WorkflowPlugin.__test };
