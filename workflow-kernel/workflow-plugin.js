import { tool } from "@opencode-ai/plugin";
import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { integrateLaneCommits } from "./integration-mode.js";
import { createExtensionRegistry } from "./extension-registry.js";
import { assertWritableWorkflowPath, safeWriteFileWithinRoot } from "./path-policy.js";
import {
  BUNDLED_COMMAND_DIR,
  BUNDLED_SKILL_DIR,
  BUNDLED_WORKFLOW_DIR,
  DEFAULT_CHILD_PROMPT_TIMEOUT_MS,
  DEFAULT_CONCURRENCY,
  DEFAULT_GUEST_DEADLINE_MS,
  DEFAULT_MAX_AGENTS,
  DEFAULT_SUBPROCESS_MAX_BUFFER,
  DEFAULT_SUBPROCESS_TIMEOUT_MS,
  HARD_CONCURRENCY_LIMIT,
  LANE_OUTCOMES,
  MAX_CHILD_PROMPT_TIMEOUT_MS,
  OPENCODE_WORKFLOWS_DEBUG_CAPTURE_ENV,
  MAX_STATUS_STRING_CHARS,
  SECRET_GLOBS,
  normalizeHardConcurrencyLimit,
  resolveOpencodeConfigDir,
} from "./constants.js";
import {
  extractTextFromError,
  hash,
  hashStable,
  jsonPreview,
  redactDurableValue,
  stableStringify,
  truncateText,
} from "./text-json.js";
import {
  WorkflowCancelledError,
  WorkflowBudgetStoppedError,
} from "./errors.js";
import { sessionApi } from "./session-access.js";
import { redactFreeTextSecrets } from "./free-text-redactor.js";
import {
  cancelRun,
  clearNotificationRuntimeState,
  deliverWorkflowNotifications,
  idleNotificationSessions,
  killRun,
  maybeDeliverCompletionNotification,
  pauseRun,
  abortRunChildren,
  rejectWaitingAgents,
  updateNotificationIdleState,
  writeCompletionNotification,
} from "./lifecycle-control.js";
import {
  assertLiveGateProbeAllowed,
  collectTextParts,
  createCapabilityAdapter,
  liveGateReport,
  promoteCapabilities,
  promoteVerifiedGateCapabilities,
  unwrapClientResult,
  verifyRequiredAuthorityGates,
  verifyNetworkMcpAuthorityGates,
  VERIFIED_PROBE_TTL_MS,
} from "./capability-adapter.js";
import {
  normalizeBudgetCeilings,
} from "./budget-accounting.js";
import {
  approvalSnapshotList,
  approvalHash,
  computeDiffPlanHash,
} from "./approval-hashing.js";
import {
  appendApplyLedger,
  appendEvent,
  appendIntegrationLedger,
  appendValidationLedger,
  buildResumeSignatureIndex,
  compactJournal,
  applyLedgerHasCompleted,
  computeDomainMutationHash,
  countNonEmptyLines,
  domainMutationApprovalManifestForRun,
  domainMutationManifest,
  finalizeStagedDomainMutations,
  loadJournal,
  stagedDomainMutationManifest,
} from "./event-journal.js";
import {
  acquireWorkflowLock,
  assertSafeRunId,
  cleanupRuns,
  computeSalvageCandidates,
  ensurePrivateDir,
  ensureRunRoot,
  isPathInside,
  lifecycleRequestPath,
  lockPathForRun,
  readLock,
  readLaneProjections,
  readLaneRequestCheckpoint,
  readLifecycleRequests,
  readRunById,
  reconcileRuns,
  rehydrateRunFromPriorState,
  runDirForRoot,
  runRoots,
  runs,
  statusText,
  eventsText,
  timeoutResumeEligibilityForState,
  writeFilePrivate,
  writeJsonAtomic,
  writeSalvagedLaneOutcome,
  writeState,
} from "./run-store-status.js";
import {
  createWorkflowToastEventSink,
  showToast,
  startWorkflowProgressToasts,
  workflowApplyToastCard,
  workflowHeartbeatToastCard,
  workflowTerminalToastCard,
} from "./notification-toast.js";
import { applyLaneEffortParams } from "./lane-effort-policy.js";
import {
  AD_HOC_AUTHORITY_PROFILE,
  WORKFLOW_AUTHORITY_PROFILES,
  assertWriteWorkflowAllowed,
  authorityAutoApproveTier,
  authorityArgsForWorkflow,
  authoritySummary,
  autoApproveCovers,
  configureWorkflowPermissions,
  effectiveAutoApproveCeiling,
  modelKey,
  normalizeAutoApproveTier,
  resolveDrainMode,
  resolveLaneModel,
  resolveRequestedModel,
  resolveRunAuthority,
} from "./authority-policy.js";
import {
  buildNestedSnapshots,
  hasExplicitWorkflowSource,
  isTrustedWorkflowPath,
  parseWorkflowSource,
  resolveWorkflowSourceForStart,
} from "./workflow-source.js";
import {
  listRoles,
  listTemplates,
  listWorkflows,
  saveTemplate,
  saveWorkflow,
} from "./role-template-loading.js";
import { readJsonFile } from "./run-store-status.js";
import { ajv, compileSchemaWithIdentity, validateStructuredResult } from "./structured-output.js";
// Re-exported below (and surfaced through index.js + the kernel barrel) so the public
// workflow-plugin export contract and the __test surface are preserved after the
// child-agent-runner / sandbox-executor extraction.
import {
  addEditPlanFromResult,
  checkpointHitForSignature,
  classifyResumeCacheHit,
  createEditWorktree,
  normalizePatches,
  runChildAgent,
} from "./child-agent-runner.js";
import { executeSandbox, runNestedWorkflow } from "./sandbox-executor.js";
import { inlineResultProjection } from "./result-readback.js";

const execFileAsync = promisify(execFile);

// Coupling-surface contract for the shared mutable run object threaded through this
// orchestrator and the extracted boundaries (sandbox-executor.js, child-agent-runner.js).
// @typedef {import("./run-context.js").RunContext} RunContext

// Terminal states a run may be resumed from (jbs3.1). "paused"/"interrupted" are
// cooperative/force-kill stops. "failed" (a lane threw a non-cancellation error) and
// "budget_stopped" (a cost/token/agent ceiling was hit) are ALSO resumable: their
// completed lanes are journaled and replay from cache at zero re-spend, so resuming
// re-runs only the failed/remaining lanes instead of stranding finished work. An
// explicit operator "cancelled" stays NON-resumable by design (cancel == abandon).
const RESUMABLE_STATUSES = new Set(["paused", "interrupted", "failed", "budget_stopped"]);

// Background heuristic (jbs3.7, mfv9.6). A foreground run blocks the calling agent inside
// workflow_run for the whole execution, so the agent cannot workflow_pause / workflow_cancel its
// own run mid-flight -- only the human ESC-to-interrupt path can. For a large fan-out that is a real
// loss of control. Wide, deep, or explicitly long runs default to background when background is
// omitted; explicit args.background and resume-pinned priorState.background still win.
const BACKGROUND_RECOMMEND_MAX_AGENTS = 8;
const BACKGROUND_RECOMMEND_WAVES = 3;
const BACKGROUND_RECOMMEND_DURATION_MS = 10 * 60 * 1000;
async function gitOutput(directory, args) {
  const { stdout } = await execFileAsync("git", ["-C", directory, ...args], { encoding: "utf8", timeout: DEFAULT_SUBPROCESS_TIMEOUT_MS, maxBuffer: DEFAULT_SUBPROCESS_MAX_BUFFER });
  return stdout.trim();
}

async function gitHead(directory) {
  try {
    return await gitOutput(directory, ["rev-parse", "HEAD"]);
  } catch (error) {
    throw new Error(`Workflow edit/apply requires a Git worktree with an initial commit: ${extractTextFromError(error)}`);
  }
}

async function assertGitCleanAtBase(directory, baseCommit) {
  const head = await gitHead(directory);
  if (head !== baseCommit) throw new Error(`baseCommit mismatch: primary HEAD is ${head}, expected ${baseCommit}`);
  const status = await gitOutput(directory, ["status", "--porcelain=v1", "--untracked-files=all"]);
  const dirty = status.split(/\r?\n/).filter((line) => {
    if (!line.trim()) return false;
    const rel = line.slice(3).replace(/\\/g, "/");
    return !rel.startsWith(".opencode/workflows/runs/");
  });
  if (dirty.length > 0) {
    throw new Error(`Primary Git worktree is dirty; refusing apply: ${dirty.slice(0, 5).join(", ")}`);
  }
}

async function gitPathTracked(directory, relativePath) {
  try {
    await execFileAsync("git", ["-C", directory, "ls-files", "--error-unmatch", "--", relativePath], { encoding: "utf8", timeout: DEFAULT_SUBPROCESS_TIMEOUT_MS, maxBuffer: DEFAULT_SUBPROCESS_MAX_BUFFER });
    return true;
  } catch {
    return false;
  }
}

function parseGitStatusFiles(status) {
  return status.split(/\r?\n/).filter(Boolean).map((line) => {
    const statusCode = line.slice(0, 2).trim() || "modified";
    const rawPath = line.slice(3).trim();
    const file = rawPath.includes(" -> ") ? rawPath.split(" -> ").pop() : rawPath;
    return { status: statusCode, path: file.replace(/\\/g, "/") };
  });
}

async function dirtyWorktreeSalvage(worktreePath, extra = {}) {
  if (!worktreePath) return undefined;
  let status;
  try {
    status = await gitOutput(worktreePath, ["status", "--porcelain=v1", "--untracked-files=all"]);
  } catch (error) {
    return { ...extra, dirty: undefined, worktreePath, error: truncateText(extractTextFromError(error), MAX_STATUS_STRING_CHARS) };
  }
  const changedFiles = parseGitStatusFiles(status);
  if (changedFiles.length === 0) return undefined;
  let diffStat = "";
  try {
    diffStat = await gitOutput(worktreePath, ["diff", "--stat", "HEAD", "--"]);
  } catch {
    // Diff stat is best-effort salvage metadata; status remains authoritative.
  }
  return {
    ...extra,
    dirty: true,
    worktreePath,
    changedFiles,
    changedFileCount: changedFiles.length,
    diffStat,
    statusLines: status.split(/\r?\n/).filter(Boolean),
  };
}

function parseCommandMarkdown(source, fallbackDescription) {
  const normalized = String(source ?? "").replace(/\r\n/g, "\n");
  const match = normalized.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) return { description: fallbackDescription, template: normalized.trim() };

  const description = match[1].match(/^description:\s*(.+?)\s*$/m)?.[1]?.replace(/^['"]|['"]$/g, "") ?? fallbackDescription;
  return { description, template: match[2].trimStart() };
}

async function registerBundledCommand(cfg, name, commandPath, fallbackDescription) {
  if (cfg.command[name]) return;
  try {
    const source = await fs.readFile(commandPath, "utf8");
    cfg.command[name] = parseCommandMarkdown(source, fallbackDescription);
  } catch {
    /* bundled command markdown absent (e.g. trimmed tarball) — degrade, do not break plugin load */
  }
}

async function registerCommandsFromDir(cfg, commandDir) {
  let commandFiles = [];
  try {
    commandFiles = (await fs.readdir(commandDir)).filter((file) => file.endsWith(".md"));
  } catch {
    /* command dir absent (e.g. trimmed tarball or an extension without commands) — degrade */
    return;
  }
  for (const file of commandFiles.sort()) {
    const name = file.slice(0, -3);
    await registerBundledCommand(cfg, name, path.join(commandDir, file), `Run the ${name} workflow`);
  }
}

async function configureWorkflowEntrypoints(cfg, extensionAssetDirs = { workflows: [], commands: [], skills: [] }) {
  cfg.skills = cfg.skills && typeof cfg.skills === "object" && !Array.isArray(cfg.skills) ? cfg.skills : {};
  cfg.skills.paths = Array.isArray(cfg.skills.paths) ? cfg.skills.paths : [];
  if (!cfg.skills.paths.includes(BUNDLED_SKILL_DIR)) cfg.skills.paths.push(BUNDLED_SKILL_DIR);
  // Extension skill dirs merge in (explicitly-configured trusted asset dirs).
  for (const skillDir of extensionAssetDirs?.skills ?? []) {
    if (!cfg.skills.paths.includes(skillDir)) cfg.skills.paths.push(skillDir);
  }

  cfg.command = cfg.command && typeof cfg.command === "object" && !Array.isArray(cfg.command) ? cfg.command : {};
  // Register every bundled command markdown generically (no per-command hardcoding). The command
  // name is the file basename; the description is parsed from the markdown (fallback otherwise).
  // Bundled FIRST, then extensions: registerBundledCommand's `if (cfg.command[name]) return` guard
  // gives bundled > extension precedence — an extension can only add NET-NEW command names.
  await registerCommandsFromDir(cfg, BUNDLED_COMMAND_DIR);
  for (const cmdDir of extensionAssetDirs?.commands ?? []) {
    await registerCommandsFromDir(cfg, cmdDir);
  }
}

function coerceLaneTimeoutMs(value, label) {
  if (value === undefined || value === null) return undefined;
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${label} must be a positive integer number of milliseconds`);
  if (value > MAX_CHILD_PROMPT_TIMEOUT_MS) throw new Error(`${label} must be <= ${MAX_CHILD_PROMPT_TIMEOUT_MS}ms`);
  return value;
}

function laneTimeoutAliasValue(source = {}, label = "lane timeout") {
  const laneTimeoutMs = coerceLaneTimeoutMs(source.laneTimeoutMs, `${label}.laneTimeoutMs`);
  const childPromptTimeoutMs = coerceLaneTimeoutMs(source.childPromptTimeoutMs, `${label}.childPromptTimeoutMs`);
  if (laneTimeoutMs !== undefined && childPromptTimeoutMs !== undefined && laneTimeoutMs !== childPromptTimeoutMs) {
    throw new Error(`${label} laneTimeoutMs and childPromptTimeoutMs must match when both are provided`);
  }
  return laneTimeoutMs ?? childPromptTimeoutMs;
}

async function checkDurableLifecycleRequest(pluginContextOrRun, maybeToolContext, maybeRun) {
  const run = maybeRun ?? pluginContextOrRun;
  const pluginContext = maybeRun ? pluginContextOrRun : {};
  const toolContext = maybeRun ? maybeToolContext : {};
  const requests = await readLifecycleRequests(run.dir);
  if (requests.kill) {
    // A force-terminate request observed by a still-live owner: abandon the run to a resumable
    // terminal state (interrupted) rather than the cooperative cancel/pause path. run.killed
    // makes runWorkflowExecution's catch keep the interrupted status.
    run.lifecycleRequests = requests;
    run.killed = true;
    run.status = "interrupted";
    run.abortController.abort();
    rejectWaitingAgents(run, new WorkflowCancelledError(requests.kill.reason || "Workflow run was force-terminated by durable request"));
    await abortRunChildren(pluginContext, run, toolContext?.directory);
    await appendEvent(run, { type: "run.killed", requestedAt: requests.kill.requestedAt, reason: requests.kill.reason });
    await writeState(run);
    throw new WorkflowCancelledError(requests.kill.reason || "Workflow run was force-terminated by durable request");
  }
  if (requests.cancel) {
    run.lifecycleRequests = requests;
    run.status = "cancelling";
    run.abortController.abort();
    rejectWaitingAgents(run, new WorkflowCancelledError(requests.cancel.reason || "Workflow run was cancelled by durable request"));
    await abortRunChildren(pluginContext, run, toolContext?.directory);
    await appendEvent(run, { type: "run.cancel_requested", requestedAt: requests.cancel.requestedAt, reason: requests.cancel.reason });
    await writeState(run);
    throw new WorkflowCancelledError(requests.cancel.reason || "Workflow run was cancelled by durable request");
  }
  if (requests.pause) {
    run.lifecycleRequests = requests;
    run.pauseRequested = true;
    run.status = "pausing";
    run.abortController.abort();
    rejectWaitingAgents(run, new WorkflowCancelledError(requests.pause.reason || "Workflow run was paused by durable request"));
    await abortRunChildren(pluginContext, run, toolContext?.directory);
    await appendEvent(run, { type: "run.pause_requested", requestedAt: requests.pause.requestedAt, reason: requests.pause.reason });
    await writeState(run);
    throw new WorkflowCancelledError(requests.pause.reason || "Workflow run was paused by durable request");
  }
}

async function readResumeRunEntry(context, runId) {
  for (const root of runRoots(context)) {
    const dir = runDirForRoot(root, runId);
    const state = await readJsonFile(path.join(dir, "state.json"), undefined);
    if (state !== undefined) return { root, dir, state };
  }
  throw new Error(`Workflow run is not resumable: ${runId} was not found`);
}

// Transitional lifecycle statuses: a cooperative pause/cancel has been requested but the run has
// not finished unwinding yet, so it is neither still cleanly running nor settled into a
// resumable/terminal status. A resume attempt in this window previously hit the generic "not
// resumable from status pausing" error, which reads like a hard rejection. Return actionable
// settle guidance instead so an agent that pauses-then-immediately-resumes knows to poll for the
// settled status rather than treating the transitional state as a dead end.
const SETTLING_STATUSES = new Set(["pausing", "cancelling"]);

async function assertResumableState(entry, runId, args = {}) {
  const status = String(entry?.state?.status ?? "unknown");
  if (RESUMABLE_STATUSES.has(status)) {
    if (Object.hasOwn(args, "resumePolicy")) {
      throw new Error("resumePolicy is only valid when resuming an eligible timed-out run");
    }
    return;
  }
  if (status === "timed-out") {
    const runLock = await readLock(lockPathForRun(entry.dir, "run"));
    const state = runLock ? { ...entry.state, locks: { ...(entry.state.locks ?? {}), run: runLock } } : entry.state;
    const timeoutRecovery = timeoutResumeEligibilityForState(state);
    if (!timeoutRecovery.eligible) {
      throw new Error(`Workflow run ${runId} timed-out resume is blocked: ${timeoutRecovery.blockedReasons.join("; ")}`);
    }
    if (args.resumePolicy !== "extend-deadline") {
      throw new Error(`Workflow run ${runId} timed-out resume requires resumePolicy:"extend-deadline"`);
    }
    const priorMaxRuntimeMs = entry.state.maxRuntimeMs;
    if (!Number.isInteger(args.maxRuntimeMs) || args.maxRuntimeMs <= priorMaxRuntimeMs) {
      throw new Error(`Workflow run ${runId} timed-out resume requires maxRuntimeMs greater than prior maxRuntimeMs ${priorMaxRuntimeMs}`);
    }
    return;
  }
  if (SETTLING_STATUSES.has(status)) {
    if (status === "pausing") {
      throw new Error(`Workflow run ${runId} is still settling (status pausing); poll workflow_status({ runId: "${runId}" }) until status is paused, then resume with workflow_run({ resumeRunId: "${runId}" }).`);
    }
    throw new Error(`Workflow run ${runId} is still settling (status cancelling); poll workflow_status({ runId: "${runId}" }) until it reaches a terminal status. A cancelled run is terminal and not resumable.`);
  }
  throw new Error(`Workflow run ${runId} is not resumable from status ${status}; only ${[...RESUMABLE_STATUSES].join(", ")} runs can be resumed`);
}

function backgroundHeuristic(approval = {}) {
  const maxAgents = Number.isInteger(approval?.maxAgents) ? approval.maxAgents : 0;
  const concurrency = Math.max(1, Number.isInteger(approval?.concurrency) ? approval.concurrency : 1);
  const waves = Math.max(1, Math.ceil(maxAgents / concurrency));
  const maxAgentsSignal = approval?.maxAgentsSignal !== false;
  const maxRuntimeSignal = approval?.maxRuntimeSignal !== false;
  const wide = maxAgentsSignal && maxAgents >= BACKGROUND_RECOMMEND_MAX_AGENTS;
  const deep = maxAgentsSignal && waves >= BACKGROUND_RECOMMEND_WAVES;
  const long = maxRuntimeSignal && Number.isInteger(approval?.maxRuntimeMs) && approval.maxRuntimeMs >= BACKGROUND_RECOMMEND_DURATION_MS;
  const signals = [
    wide ? `maxAgents=${maxAgents}` : undefined,
    deep ? `~${waves} concurrency waves (concurrency=${concurrency})` : undefined,
    long ? `maxRuntimeMs=${approval.maxRuntimeMs}ms` : undefined,
  ].filter(Boolean);
  return { recommended: wide || deep || long, maxAgents, concurrency, waves, wide, deep, long, signals };
}

function backgroundSignalsText(heuristic) {
  return (heuristic?.signals ?? []).join(", ");
}

function workflowBackgroundDecision(meta = {}, sourcePath = "", args = {}, priorState = null, sizing = {}) {
  if (priorState && typeof priorState.background === "boolean") {
    return { enabled: priorState.background, source: "resume" };
  }
  if (typeof args.background === "boolean") {
    return { enabled: args.background, source: "explicit" };
  }
  if (meta.harness === "drain") {
    const runtimeArgs = args.args && typeof args.args === "object" && !Array.isArray(args.args) ? args.args : {};
    if (resolveDrainMode(runtimeArgs) === "autonomous-local") {
      return { enabled: true, source: "drain-autonomous-local" };
    }
  }
  const heuristic = backgroundHeuristic(sizing);
  if (heuristic.recommended) return { enabled: true, source: "heuristic", heuristic };
  return { enabled: false, source: "foreground-default", heuristic };
}

function effectiveWorkflowBackground(meta = {}, sourcePath = "", args = {}, priorState = null, sizing = {}) {
  return workflowBackgroundDecision(meta, sourcePath, args, priorState, sizing).enabled;
}

// Returns an advisory background-recommendation line for the approval preview, or undefined when
// background is already enabled or the run is small enough that blocking the agent foreground is
// cheap. Gates on maxAgents (wide), concurrency via wave count (deep/serialized), and an explicit
// maxRuntimeMs (long-running) so all three size signals from the bead are considered.
function backgroundRecommendation(approval) {
  if (approval?.background === true) return undefined;
  if (approval?.backgroundDecision?.source === "resume") return undefined;
  const heuristic = backgroundHeuristic(approval);
  if (!heuristic.recommended) return undefined;
  const signals = backgroundSignalsText(heuristic);
  return [
    `Background recommended (heuristic): this is a large/long run (${signals}).`,
    "Running it foreground blocks the calling agent for the whole run, so the agent cannot workflow_pause/workflow_cancel it mid-run (only the human ESC-to-interrupt path can).",
    "Pass background: true to retain a control channel: poll workflow_status, then workflow_pause/workflow_cancel as needed. The human ESC path is unchanged either way.",
  ].join(" ");
}

function backgroundDefaultLine(approval) {
  if (approval?.backgroundDecision?.source !== "heuristic") return undefined;
  const heuristic = approval.backgroundDecision.heuristic ?? backgroundHeuristic(approval);
  return [
    `Background defaulted (heuristic): this is a large/long run (${backgroundSignalsText(heuristic)}).`,
    "The run starts in background so the calling agent keeps a control channel for workflow_status, workflow_pause, and workflow_cancel.",
  ].join(" ");
}

function backgroundNotificationWarning(approval, runId) {
  if (approval?.background !== true) return undefined;
  if (approval?.notificationDelivery?.promptAsyncAvailable !== false) return undefined;
  const statusHint = runId
    ? `Poll workflow_status({ runId: "${runId}" }) for completion and use detail:"result" for final output.`
    : "After launch, poll workflow_status with the returned run id and use detail:\"result\" for final output.";
  return `Background notification warning: session.promptAsync is unavailable, so no completion prompt can be delivered to the invoking session. ${statusHint}`;
}

function authorityIsolationSummary(authority) {
  if (authority.integration) return "local integration worktrees; primary-tree writes require workflow_apply";
  if (authority.worktreeEdit) return "native edit worktrees; primary-tree writes require workflow_apply";
  if (authority.edit) return "primary-tree write authority gated by workflow_apply";
  return "no workflow-managed write isolation requested";
}

function mutationDomainSummary(run) {
  if (run.meta?.harness === "drain") {
    const runtimeArgs = run.runtimeArgs && typeof run.runtimeArgs === "object" ? run.runtimeArgs : {};
    const mode = resolveDrainMode(runtimeArgs);
    return mode === "autonomous-local"
      ? "domain state via the trusted drain adapter; primary tree changes require workflow_apply"
      : "none (drain dry-run)";
  }
  if (run.authority?.integration) return "integration worktrees and workflow_apply-gated primary tree";
  if (run.authority?.edit || run.authority?.worktreeEdit) return "workflow_apply-gated primary tree";
  return "none declared";
}

function isRunAborted(run, toolContext) {
  return run.abortController.signal.aborted || (!run.ignoreToolAbort && toolContext.abort?.aborted);
}

function throwIfAborted(run, toolContext) {
  if (isRunAborted(run, toolContext)) throw new WorkflowCancelledError();
}

function laneCancelledByFanout(run, callId) {
  for (const scope of run.cancelledFanoutScopes ?? []) {
    if (callId === scope || callId.startsWith(`${scope}/`)) return true;
  }
  return false;
}

function throwIfLaneCancelled(run, callId) {
  if (laneCancelledByFanout(run, callId)) throw new WorkflowCancelledError("Workflow lane was cancelled by failFast fanout");
}

async function acquireAgentSlot(run, callId) {
  if (run.abortController.signal.aborted) throw new WorkflowCancelledError();
  throwIfLaneCancelled(run, callId);
  if (run.activeAgents < run.concurrency) {
    run.activeAgents += 1;
    return;
  }
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  run.waitingAgents.push({ resolve, reject, callId });
  await promise;
  if (run.abortController.signal.aborted) {
    releaseAgentSlot(run);
    throw new WorkflowCancelledError();
  }
  // A waiter is resolved by releaseAgentSlot HANDING OFF the slot (it does not
  // decrement activeAgents), so this just-resolved lane now owns the slot. If the
  // lane is fanout-cancelled in the microtask window after the hand-off, throwing
  // here leaves runChildAgent with acquired=false, so its finally skips
  // releaseAgentSlot and the handed-off slot leaks -> activeAgents permanently
  // inflates and the concurrency gate eventually deadlocks (leak survives resume).
  // Release the slot before throwing, mirroring the abort branch above (R5).
  if (laneCancelledByFanout(run, callId)) {
    releaseAgentSlot(run);
    throw new WorkflowCancelledError("Workflow lane was cancelled by failFast fanout");
  }
}

function releaseAgentSlot(run) {
  const next = run.waitingAgents.shift();
  if (next) {
    next.resolve();
    return;
  }
  run.activeAgents = Math.max(0, run.activeAgents - 1);
}

// Nested workflow() lanes execute inside the parent run and draw from the same maxAgents
// budget; a nested workflow's own declared maxAgents is ignored at runtime. Surface this so
// authors do not underbudget a parent that delegates to a larger nested cold path, and warn
// (heuristically) when a snapshotted nested workflow statically declares more agents than the
// parent budget. The warning is advisory only — dynamic workflow code may launch fewer lanes —
// so it never blocks an otherwise-valid approval.
function nestedBudgetNotes(run) {
  if (!run.nestedSnapshots?.size) return [];
  const uniqueByPath = [...new Map([...run.nestedSnapshots.values()].map((item) => [item.sourcePath, item])).values()];
  const notes = ["Nested budget: nested workflow() lanes run inside this run and share its Max agents budget; a nested workflow's own declared maxAgents is ignored at runtime."];
  for (const item of uniqueByPath) {
    let declared;
    try {
      declared = parseWorkflowSource(item.source).meta?.maxAgents;
    } catch {
      declared = undefined;
    }
    if (typeof declared === "number" && declared > run.maxAgents) {
      notes.push(`Nested budget warning (heuristic): nested workflow ${item.sourcePath} declares maxAgents=${declared}, higher than this run's Max agents=${run.maxAgents}. If it cold-runs its full fan-out it may budget-stop; raise this workflow's maxAgents or pass a precomputed result to skip the nested run.`);
    }
  }
  return notes;
}

function finiteOrNull(value) {
  return Number.isFinite(value) ? value : null;
}

function intOrNull(value) {
  return Number.isInteger(value) ? value : null;
}

function truthyEnvFlag(value) {
  if (typeof value !== "string") return false;
  return /^(1|true|yes|on)$/i.test(value.trim());
}

function sourceLineCount(source) {
  if (source.length === 0) return 0;
  return source.split(/\r\n|\r|\n/).length;
}

function sourcePreviewMetadata(source, sourcePath, args = {}) {
  const metadata = {
    path: sourcePath,
    byteLength: Buffer.byteLength(source, "utf8"),
    lineCount: sourceLineCount(source),
    inline: sourcePath === "<inline>",
  };
  if (args.includeSourceSnippet === true) {
    const maxChars = Number.isInteger(args.sourceSnippetMaxChars) ? Math.min(Math.max(args.sourceSnippetMaxChars, 1), 2000) : 800;
    metadata.snippet = truncateText(source, maxChars);
    metadata.snippetChars = maxChars;
  }
  return metadata;
}

function approvalPreviewEnvelope(run) {
  const phases = Array.isArray(run.meta.phases) ? run.meta.phases.join(", ") : "not declared";
  const phaseList = Array.isArray(run.meta.phases) ? [...run.meta.phases] : [];
  const nestedSnapshots = approvalSnapshotList(run.nestedSnapshots);
  const nested = nestedSnapshots.length ? nestedSnapshots.map((item) => `${item.sourcePath} ${item.sourceHash}`).join("\n") : "none";
  const approvedHash = approvalHash(run);
  const backgroundHint = backgroundRecommendation(run) || null;
  const backgroundDefault = backgroundDefaultLine(run) || null;
  const notificationWarning = backgroundNotificationWarning(run) || null;
  const requiredGates = Array.isArray(run.authority?.requiredGates) ? [...run.authority.requiredGates] : [];
  return {
    type: "workflow_preview",
    status: "approval_required",
    executed: false,
    workflow: {
      name: run.meta.name || "unnamed workflow",
      description: run.meta.description || "not declared",
      phases: phaseList,
      phasesText: phases,
    },
    source: {
      path: run.sourcePath,
      sourceHash: run.sourceHash,
      external: run.externalSource === true,
      ...run.sourceMetadata,
    },
    approvalHash: approvedHash,
    runtimeArgsPreview: run.argsPreview,
    laneBudget: {
      maxAgents: run.maxAgents,
      concurrency: run.concurrency,
      laneTimeoutMs: run.laneTimeoutMs,
      guestDeadlineMs: run.guestDeadlineMs,
      maxRuntimeMs: intOrNull(run.maxRuntimeMs),
    },
    modelPlan: {
      defaultChildModel: run.defaultChildModel,
      fast: run.modelTiers?.fast ?? run.defaultChildModel,
      deep: run.modelTiers?.deep ?? run.defaultChildModel,
    },
    budgetCeilings: {
      maxCost: finiteOrNull(run.budgetCeilings?.maxCost),
      maxTokens: intOrNull(run.budgetCeilings?.maxTokens),
    },
    autoApprove: run.autoApprove ?? null,
    background: {
      enabled: run.background === true,
      source: run.backgroundDecision?.source ?? null,
      defaultReason: backgroundDefault,
      recommendation: backgroundHint,
      notificationWarning,
    },
    notificationDelivery: {
      promptAsyncAvailable: run.notificationDelivery?.promptAsyncAvailable === true,
      completionPrompt: run.background === true
        ? (run.notificationDelivery?.promptAsyncAvailable === true ? "available" : "unavailable")
        : "not_applicable",
      warning: notificationWarning,
    },
    debugCapture: {
      enabled: run.debugCapture === true,
      source: run.debugCaptureSource ?? (run.debugCapture === true ? "unknown" : "off"),
      artifacts: run.debugCapture === true ? "debug/<lane>/prompt.md, schema.json, transcript.jsonl" : "none",
    },
    authority: {
      profile: run.authority.profile || AD_HOC_AUTHORITY_PROFILE,
      requiredGates,
      isolation: authorityIsolationSummary(run.authority),
      summary: authoritySummary(run.authority),
      details: run.authority,
    },
    mutationDomains: {
      summary: mutationDomainSummary(run),
    },
    resume: run.resumePreview ? {
      policy: run.resumePolicy ?? null,
      ...run.resumePreview,
      summary: resumeReplayLine(run.resumePreview),
    } : null,
    nestedSnapshots,
    nestedSnapshotText: nested,
    nestedBudgetNotes: nestedBudgetNotes(run),
    capabilities: {
      childSession: run.capabilities.childSession,
      permissions: run.capabilities.permissions,
      structuredOutput: run.capabilities.structuredOutput,
      worktree: run.capabilities.worktree,
      directoryRooting: run.capabilities.directoryRooting,
      worktreeEditIsolation: run.capabilities.worktreeEditIsolation,
    },
    consent: [
      ...(run.meta?.harness === "drain" && run.authority?.profile === "drain-autonomous-local"
        ? ["for an autonomous-local drain, this launch approval authorizes in-run apply of a verified successful diff plan to the local primary tree (accepted changes land; staged domain mutations finalize) instead of stopping at awaiting-diff-approval. Failed drains keep failed-with-diff-plan for review via workflow_apply."]
        : []),
      ...(requiredGates.length
        ? ["after approval, elevated launch may run required live-gate preflight probes before mutation/lane launch; probes spawn short-lived child sessions (model token use) and, for worktree/directory-rooting gates, create and remove scratch worktrees. The preview never probes; these side effects begin only after approval."]
        : []),
      ...(run.debugCapture === true
        ? ["debug capture is enabled; lane prompts, schemas, and child transcripts are persisted under the private run directory after secrets redaction and size caps. This increases local sensitive evidence and disk usage."]
        : []),
    ],
    approvalHashCovers: "workflow source, runtime args, authority, model, budgets, concurrency, debug capture, resume policy, capabilities, and nested snapshots",
  };
}

function autoApprovePreviewLine(autoApprove) {
  if (!autoApprove) return null;
  if (autoApprove.eligible) {
    return `Auto-approve: eligible (tier=${autoApprove.tier}, ceiling=${autoApprove.effectiveCeiling})`;
  }
  if (!autoApprove.configuredCeiling) {
    return `Auto-approve: off (resolved tier=${autoApprove.tier}; configure options.autoApprove to enable single-call launch)`;
  }
  if (!autoApprove.effectiveCeiling) {
    return `Auto-approve: off for this call (configured=${autoApprove.configuredCeiling}, requested=${autoApprove.requestedCeiling ?? "none"})`;
  }
  return `Auto-approve: not eligible (tier=${autoApprove.tier}, ceiling=${autoApprove.effectiveCeiling})`;
}

function workflowPreviewJson(run) {
  return JSON.stringify(approvalPreviewEnvelope(run), null, 2);
}

function approvalSummary(run) {
  const preview = approvalPreviewEnvelope(run);
  // Human-first layout: the plan a user needs to reason about (what/models/lanes/authority/cost)
  // leads; hashes, capabilities, and consent demote into a "Technical envelope" footer. Every line
  // label is preserved verbatim so order-independent regex assertions over the preview still match.
  return [
    `Workflow approval required for ${preview.workflow.name}.`,
    `Description: ${preview.workflow.description}`,
    `Phases: ${preview.workflow.phasesText}`,
    `Runtime args preview: ${preview.runtimeArgsPreview}`,
    `Max agents: ${preview.laneBudget.maxAgents}`,
    `Concurrency: ${preview.laneBudget.concurrency}`,
    `Default child model: ${preview.modelPlan.defaultChildModel}`,
    `Model plan: fast=${preview.modelPlan.fast} deep=${preview.modelPlan.deep}`,
    `Lane timeout: ${preview.laneBudget.laneTimeoutMs}ms`,
    ...(preview.laneBudget.maxRuntimeMs !== null ? [`Run deadline (maxRuntimeMs, operability limit, not approval-bound): ${preview.laneBudget.maxRuntimeMs}ms`] : []),
    `Budget ceilings: maxCost=${preview.budgetCeilings.maxCost ?? "none"}, maxTokens=${preview.budgetCeilings.maxTokens ?? "none"}`,
    `Debug capture: ${preview.debugCapture.enabled ? `enabled (${preview.debugCapture.source})` : "off"}`,
    `Background: ${preview.background.enabled}`,
    ...(preview.background.defaultReason ? [preview.background.defaultReason] : []),
    ...(preview.background.recommendation ? [preview.background.recommendation] : []),
    ...(preview.background.notificationWarning ? [preview.background.notificationWarning] : []),
    `Authority profile: ${preview.authority.profile}`,
    `Required gates: ${preview.authority.requiredGates.length ? preview.authority.requiredGates.join(", ") : "none"}`,
    `Isolation: ${preview.authority.isolation}`,
    `Authority: ${preview.authority.summary}`,
    ...(preview.autoApprove ? [autoApprovePreviewLine(preview.autoApprove)] : []),
    `Mutation domains: ${preview.mutationDomains.summary}`,
    ...(preview.resume?.policy ? [`Resume policy: ${preview.resume.policy}`] : []),
    ...(preview.resume ? [preview.resume.summary] : []),
    `Nested workflow snapshots:\n${preview.nestedSnapshotText}`,
    ...preview.nestedBudgetNotes,
    "--- Technical envelope (hashes, capabilities, consent) ---",
    `Source: ${preview.source.path}`,
    `sourceHash: ${preview.source.sourceHash}`,
    ...(preview.source.external ? [`External source (allowExternalScriptPath opt-in): true`] : []),
    `approvalHash: ${preview.approvalHash}`,
    `Capability summary: childSession=${preview.capabilities.childSession}, permissions=${preview.capabilities.permissions}, structuredOutput=${preview.capabilities.structuredOutput}, worktree=${preview.capabilities.worktree}, directoryRooting=${preview.capabilities.directoryRooting}, worktreeEditIsolation=${preview.capabilities.worktreeEditIsolation}`,
    "Capability note: available-unverified is API shape only, not behavioral proof; elevated authority fails closed unless required capabilities are available/verified.",
    ...preview.consent.map((line) => `Consent: ${line}`),
    `approvalHash covers ${preview.approvalHashCovers}.`,
    "Re-run with approve: true and approvalHash set to this approvalHash to execute this exact workflow envelope.",
  ].join("\n");
}

function approvalPreviewResponse(run, args) {
  return args.format === "json" ? workflowPreviewJson(run) : approvalSummary(run);
}

function approvalMismatchResponse(run, args) {
  const freshPreview = approvalPreviewEnvelope(run);
  return JSON.stringify({
    type: "workflow_approval_mismatch",
    status: "approval_mismatch",
    executed: false,
    reason: typeof args.approvalHash === "string" && args.approvalHash.length > 0 ? "approval_hash_mismatch" : "missing_approval_hash",
    message: "Workflow approval required: nothing executed because approve:true did not include the current approvalHash for this workflow envelope. Review the freshPreview and re-run with its approvalHash if the plan is acceptable.",
    suppliedApprovalHash: typeof args.approvalHash === "string" ? args.approvalHash : null,
    freshApprovalHash: freshPreview.approvalHash,
    freshPreview,
  }, null, 2);
}

function workflowAutoApprovePreview(pluginContext, args, authority) {
  const configuredCeiling = normalizeAutoApproveTier(pluginContext?.workflowAutoApproveCeiling);
  const hasRequestedCeiling = args.autoApprove !== undefined && args.autoApprove !== null;
  const requestedCeiling = hasRequestedCeiling ? normalizeAutoApproveTier(args.autoApprove) : null;
  if (!configuredCeiling && !hasRequestedCeiling) return null;
  const tier = authorityAutoApproveTier(authority);
  const effectiveCeiling = effectiveAutoApproveCeiling(configuredCeiling, args.autoApprove);
  return {
    tier,
    configuredCeiling: configuredCeiling || null,
    requestedCeiling: requestedCeiling || null,
    effectiveCeiling: effectiveCeiling || null,
    eligible: Boolean(effectiveCeiling && autoApproveCovers(effectiveCeiling, tier)),
  };
}

function workflowAutoApproval(pluginContext, args, approval) {
  const autoApprove = approval.autoApprove ?? workflowAutoApprovePreview(pluginContext, args, approval.authority);
  if (!autoApprove?.eligible) return null;
  return { tier: autoApprove.tier, ceiling: autoApprove.effectiveCeiling };
}

function applyApprovalMismatchError({ runId, reason, field, supplied, expected, state, plan, actualPlanHash, currentDomainHash }) {
  const mismatchSummary = reason === "staged_domain_mutations_changed"
    ? "staged domain mutations changed after diff approval"
    : `${field} mismatch`;
  const freshApplyApproval = {
    runId,
    status: state?.status ?? null,
    approvedSourceHash: state?.sourceHash ?? null,
    baseCommit: plan?.baseCommit ?? null,
    diffPlanHash: actualPlanHash ?? plan?.diffPlanHash ?? null,
    domainMutationHash: currentDomainHash ?? plan?.domainMutationHash ?? null,
  };
  return new Error(JSON.stringify({
    type: "workflow_apply_approval_mismatch",
    status: "approval_mismatch",
    executed: false,
    reason,
    field,
    message: `${mismatchSummary}. Re-read workflow_status with detail:"full" for the run and retry with the fresh hash fields if the diff plan is still acceptable.`,
    supplied,
    expected,
    freshStatusCommand: `workflow_status({ runId: "${runId}", format: "json", detail: "full" })`,
    freshApplyApproval,
  }, null, 2));
}

function workflowResultReadbackCommand(runId) {
  return `workflow_status({ runId: "${runId}", format: "json", detail: "result" })`;
}

function workflowResultReadbackLines(run) {
  return [
    `Read redacted result: ${workflowResultReadbackCommand(run.id)}`,
    "JSON result payload: status.result.output",
  ];
}

function workflowInlineResultLines(run, output) {
  const projection = inlineResultProjection(output);
  if (projection.inline) {
    return [
      `Result (redacted JSON, ${projection.bytes} bytes):`,
      projection.text,
    ];
  }
  return [
    `Result omitted from workflow_run: redacted JSON is ${projection.bytes} bytes, above inline cap ${projection.maxBytes}.`,
    `Read full/partial result: ${workflowResultReadbackCommand(run.id)}`,
  ];
}

function workflowToastOptions(pluginContext) {
  return { ascii: pluginContext?.__workflowToastAscii === true };
}

function normalizeWorkflowToastAscii(value) {
  return value === true || value === "ascii" || value === "plain-ascii";
}

async function showWorkflowRunToast(pluginContext, run, kind) {
  const options = workflowToastOptions(pluginContext);
  const card = kind === "heartbeat" ? workflowHeartbeatToastCard(run, options) : workflowTerminalToastCard(run, options);
  await showToast(pluginContext, card.variant, card.title, card.message);
}

async function showWorkflowApplyToast(pluginContext, state) {
  if (!["apply-running", "applied", "review-required", "apply-failed"].includes(state.status)) return;
  const card = workflowApplyToastCard(state, workflowToastOptions(pluginContext));
  await showToast(pluginContext, card.variant, card.title, card.message);
}

function msBetween(start, end) {
  const startMs = typeof start === "string" ? Date.parse(start) : Number.NaN;
  const endMs = typeof end === "string" ? Date.parse(end) : Number.NaN;
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return undefined;
  return Math.max(0, endMs - startMs);
}

async function appendPersistedRunEvent(runDir, state, event) {
  const eventRun = {
    id: state.id,
    dir: runDir,
    eventCount: await countNonEmptyLines(path.join(runDir, "events.jsonl")),
  };
  await appendEvent(eventRun, event);
  state.lastEventAt = eventRun.lastEventAt;
  state.lastEventType = eventRun.lastEventType;
}

async function completeApprovalWaitMetric(runDir, state, diffPlanHash) {
  if (!state.approvalWait?.startedAt) return;
  const completedAt = new Date().toISOString();
  const durationMs = msBetween(state.approvalWait.startedAt, completedAt);
  state.approvalWait = {
    ...state.approvalWait,
    completedAt,
    durationMs,
    diffPlanHash: state.approvalWait.diffPlanHash ?? diffPlanHash,
  };
  state.operatorMetrics = {
    ...(state.operatorMetrics ?? {}),
    approvalWaitMs: durationMs ?? null,
    awaitingDiffApprovalAt: state.approvalWait.startedAt,
    appliedAt: completedAt,
  };
  await appendPersistedRunEvent(runDir, state, {
    type: "run.approval_wait_completed",
    diffPlanHash,
    awaitingDiffApprovalAt: state.approvalWait.startedAt,
    appliedAt: completedAt,
    approvalWaitMs: durationMs,
  });
}

// createEditWorktree and createIntegrationLaneWorktree moved to child-agent-runner.js
// (lane-owned worktree creation); imported above and re-exported below for the barrel.

async function cleanupWorktrees(run) {
  // Best-effort removal of every worktree created for this run. The native (v2) removeWorktree
  // also deletes the worktree's branch. The filesystem fallback only removes throwaway
  // worktree directories created under the run dir, never anything outside it.
  for (const record of run.editWorktrees ?? []) {
    try {
      await run.adapter.removeWorktree({ directory: record.path, id: record.id });
    } catch {
      // Native worktree removal is best effort.
    }
    if (record.path && record.path.startsWith(`${run.dir}${path.sep}`)) {
      try {
        await fs.rm(record.path, { recursive: true, force: true });
      } catch {
        // Filesystem fallback cleanup is best effort.
      }
    }
  }
  const integrationRecords = run.integrationWorktrees ?? [];
  if (integrationRecords.length === 0) return false;
  run.worktreeCleanup = run.worktreeCleanup ?? { integration: [] };
  let changed = false;
  for (const record of integrationRecords) {
    const summary = {
      role: record.role,
      callId: record.callId,
      laneId: record.laneId,
      path: record.path,
      branch: record.branch,
    };
    try {
      if (!run.worktreeAdapter?.remove) {
        Object.assign(summary, { removed: false, preserved: true, reason: "missing-worktree-adapter" });
      } else {
        const result = await run.worktreeAdapter.remove(record);
        Object.assign(summary, {
          path: result.path ?? summary.path,
          removed: result.removed === true,
          preserved: result.preserved === true,
          reason: result.reason,
        });
      }
    } catch (error) {
      Object.assign(summary, { removed: false, preserved: true, reason: "remove-failed", error: truncateText(extractTextFromError(error), MAX_STATUS_STRING_CHARS) });
    }
    changed = true;
    run.worktreeCleanup.integration.push(summary);
    try { await appendIntegrationLedger(run, { phase: "worktree-cleanup", ...summary }); } catch {}
    if (!summary.removed) {
      try { await appendEvent(run, { type: "integration.worktree_preserved", ...summary }); } catch {}
    }
  }
  return changed;
}

// Hard-enforced read-only-vs-edit asymmetry for integration. A salvaged lane is read-only by
// construction: workflow_salvage skips edit/integration lanes entirely and never writes a
// worktree commit, so a salvaged entry cannot merge or auto-apply. This predicate encodes that
// invariant in code, not just docs: even a salvaged entry that somehow carried committed: true
// is rejected here, keeping it out of integrateLaneCommits() and the path to runAutoApply().
function isLaneIntegrable(lane) {
  return Boolean(lane)
    && lane.committed === true
    && lane.salvagedFromTranscript !== true
    && lane.acceptedForIntegration !== false;
}

const DRAIN_FAILURE_STATUSES = new Set(["failed", "not_dry", "max_waves_exceeded", "budget_exhausted"]);
function drainOutputFailed(output) {
  return output !== null && typeof output === "object" && (DRAIN_FAILURE_STATUSES.has(output.status) || output.drainBlocking === true);
}

function applyErrorWithRollbackFailures(error, rollbackFailures) {
  const primary = extractTextFromError(error);
  if (!Array.isArray(rollbackFailures) || rollbackFailures.length === 0) return primary;
  const paths = rollbackFailures.map((failure) => failure.path).filter(Boolean).join(", ");
  return `${primary}; Rollback incomplete${paths ? `: ${paths}` : ""}`;
}

// Only host/extension-trusted workflow sources may auto-apply (never a project/global shadow), so an
// approved-but-untrusted script cannot escalate a launch approval into an unattended primary-tree write
// + domain mutation. Trusted = the core bundled dir + any explicitly-configured extension workflow dir
// (read from the SAME registry that confers drain-adapter trust). A project/global shadow that WINS
// resolution still lands on a project/global path, so it is denied here regardless of resolution order.
function isTrustedAutoApplySource(sourcePath, pluginContext) {
  const resolved = path.resolve(String(sourcePath ?? ""));
  const isUnder = (root) => resolved === root || resolved.startsWith(root + path.sep);
  if (isUnder(BUNDLED_WORKFLOW_DIR)) return true;
  const extWfDirs = pluginContext?.workflowExtensionRegistry?.assetDirs()?.workflows ?? [];
  return extWfDirs.some((dir) => isUnder(path.resolve(String(dir))));
}

// Generic autonomous-local auto-apply gate. Keyed on the PERSISTED authority (resume-safe), the drain
// harness, a trusted source, and the registered adapter opting in (supportsAutoApply). Domain-neutral.
function shouldAutoApplyDrain(run, pluginContext) {
  if (run.meta?.harness !== "drain") return false;
  if (run.authority?.profile !== "drain-autonomous-local") return false;
  if (!isTrustedAutoApplySource(run.sourcePath, pluginContext)) return false;
  const registration = pluginContext.workflowExtensionRegistry?.drainAdapter(run.meta?.adapter);
  if (registration && registration.supportsAutoApply !== true) return false;
  return true;
}

// Autonomous-local auto-apply (.5): for an autonomous-local drain in a trusted source, a successful
// drain with a verified diff plan is applied to the primary tree IN-RUN (still hash-gated, still using
// the same patch/rollback/domain-finalization path as workflow_apply) instead of stopping at
// awaiting-diff-approval. Staged domain mutations are finalized and read back. Apply failures
// enter the retryable apply-failed state. Returns true on success.
async function runAutoApply(pluginContext, toolContext, run) {
  const plan = run.editPlan;
  if (!plan || !Array.isArray(plan.patches) || plan.patches.length === 0) return false;
  const root = path.resolve(toolContext.worktree || toolContext.directory);
  let planned;
  try {
    await assertGitCleanAtBase(root, plan.baseCommit);
    planned = await validatePatchTargets(root, plan.patches);
  } catch (error) {
    run.status = "apply-failed";
    run.error = extractTextFromError(error);
    await appendApplyLedger(run.dir, { phase: "failed", diffPlanHash: plan.diffPlanHash, error: run.error, auto: true });
    await writeState(run);
    return false;
  }
  run.status = "apply-running";
  await writeState(run);
  await appendApplyLedger(run.dir, { phase: "started", diffPlanHash: plan.diffPlanHash, patchCount: plan.patches.length, auto: true });
  try {
    for (const { patch } of planned) {
      await appendApplyLedger(run.dir, { phase: "before-write", diffPlanHash: plan.diffPlanHash, path: patch.path, contentHash: hash(patch.content), auto: true });
      // TOCTOU-safe (R18): re-validate ancestors + open the final component with
      // O_NOFOLLOW immediately at write time, so a symlink swapped in after
      // validatePatchTargets cannot redirect the write outside root.
      await safeWriteFileWithinRoot(root, patch.path, patch.content);
      await appendApplyLedger(run.dir, { phase: "after-write", diffPlanHash: plan.diffPlanHash, path: patch.path, contentHash: hash(patch.content), auto: true });
    }
    await appendApplyLedger(run.dir, { phase: "completed", diffPlanHash: plan.diffPlanHash, auto: true });
  } catch (error) {
    const rollbackFailures = await rollbackPatches(planned, root);
    run.status = "apply-failed";
    run.error = applyErrorWithRollbackFailures(error, rollbackFailures);
    await appendApplyLedger(run.dir, { phase: "failed", diffPlanHash: plan.diffPlanHash, error: run.error, rollbackFailures, auto: true });
    await writeState(run);
    return false;
  }
  try {
    const domainFinalization = await finalizeStagedDomainMutations(run.dir, run, (op) => pluginContext.__workflowDomainMutationHandlers?.[op] ?? pluginContext.workflowExtensionRegistry?.mutationHandler(op));
    run.domainFinalization = domainFinalization;
    run.error = undefined;
    await appendApplyLedger(run.dir, { phase: "domain-finalized", finalized: domainFinalization?.finalized ?? 0, auto: true });
    return true;
  } catch (error) {
    run.status = "apply-failed";
    run.error = `Domain finalization failed after auto-apply: ${extractTextFromError(error)}`;
    await appendApplyLedger(run.dir, { phase: "failed", diffPlanHash: plan.diffPlanHash, error: run.error, auto: true });
    await writeState(run);
    return false;
  }
}

// Orchestrator-resident primitives the extracted sandbox/child-agent boundaries depend on.
// Injected (rather than imported by those modules) so the import graph stays acyclic:
// workflow-plugin.js -> sandbox-executor.js -> child-agent-runner.js, never back. These all
// read/write the shared mutable run object and remain owned here because other orchestrator
// code (and the test surface) also uses them.
const SANDBOX_DEPS = {
  throwIfAborted,
  throwIfLaneCancelled,
  acquireAgentSlot,
  releaseAgentSlot,
  checkDurableLifecycleRequest,
  dirtyWorktreeSalvage,
  laneTimeoutAliasValue,
};

async function runWorkflowExecution(pluginContext, toolContext, run, body, args) {
  let stopProgressToasts = () => {};
  // Run-level wall-clock deadline (jbs3.6): when maxRuntimeMs is set, arm a single timer that
  // aborts the run controller so a wedged lane/host call cannot outlive the deadline. The abort
  // surfaces as a WorkflowCancelledError through the cooperative checks; run.deadlineExceeded
  // makes the catch below record a terminal "timed-out" status with a partial result.json.
  let deadlineTimer;
  if (Number.isInteger(run.maxRuntimeMs) && run.maxRuntimeMs > 0) {
    deadlineTimer = setTimeout(() => {
      if (run.abortController.signal.aborted) return;
      run.deadlineExceeded = true;
      run.abortController.abort();
      rejectWaitingAgents(run, new WorkflowCancelledError(`Workflow run exceeded maxRuntimeMs deadline of ${run.maxRuntimeMs}ms`));
      abortRunChildren(pluginContext, run, toolContext.directory).catch(() => {});
      appendEvent(run, { type: "run.deadline_exceeded", maxRuntimeMs: run.maxRuntimeMs }).catch(() => {});
    }, run.maxRuntimeMs);
    if (typeof deadlineTimer.unref === "function") deadlineTimer.unref();
  }
  try {
    await showWorkflowRunToast(pluginContext, run, "heartbeat");
    stopProgressToasts = startWorkflowProgressToasts(pluginContext, run);
    const output = await executeSandbox(pluginContext, toolContext, run, body, args, {
      ...SANDBOX_DEPS,
      checkDurableLifecycleRequest: (checkedRun) => checkDurableLifecycleRequest(pluginContext, toolContext, checkedRun),
    });
    throwIfAborted(run, toolContext);
    const drainFailed = drainOutputFailed(output);
    const integrationLanes = run.integrationPlan?.lanes?.filter(isLaneIntegrable) ?? [];
    if (integrationLanes.length > 0) {
      await appendIntegrationLedger(run, { phase: "integration-started", laneCount: integrationLanes.length });
      const result = await integrateLaneCommits({
        adapter: run.worktreeAdapter,
        runId: run.id,
        baseCommit: run.integrationPlan.baseCommit,
        lanes: integrationLanes,
        secretGlobs: SECRET_GLOBS,
        signal: run.abortController.signal,
      });
      await appendIntegrationLedger(run, { phase: "integration-completed", status: result.status, mergedLaneCount: result.mergedLanes?.length ?? 0, patchCount: result.patches?.length ?? 0 });
      if (result.validation) {
        const validationRecord = {
          phase: "integration-validation",
          validationKey: `integration:${run.id}`,
          status: result.validation.accepted === true ? "passed" : "failed",
          reason: result.validation.reason,
          validationCommands: result.validation.validationCommands,
          evidence: result.validation.evidence,
        };
        await appendValidationLedger(run, validationRecord);
        await appendEvent(run, { type: "integration.validation", status: validationRecord.status, reason: validationRecord.reason });
      }
      run.integrationPlan.integrationResult = result;
      run.integrationPlan.patches = result.patches ?? [];
      if (result.integrationWorktree) run.integrationWorktrees.push({ role: "integration", ...result.integrationWorktree });
      if (result.status === "review-required") {
        run.status = "review-required";
        run.error = result.reason || result.error || "Integration requires review";
        run.finishedAt = new Date().toISOString();
        run.resultPath = path.join(run.dir, "result.json");
        await writeJsonAtomic(run.resultPath, redactDurableValue({ output, integration: result }));
        await appendIntegrationLedger(run, { phase: "review-required", reason: result.reason, culpritLane: result.culpritLane, conflictCount: result.conflicts?.length ?? 0 });
        await appendEvent(run, { type: "integration.review_required", reason: result.reason, culpritLane: result.culpritLane, conflictCount: result.conflicts?.length ?? 0 });
        const notification = await writeCompletionNotification(run);
        await writeState(run);
        await maybeDeliverCompletionNotification(pluginContext, notification);
        await showWorkflowRunToast(pluginContext, run, "terminal");
        return [
          `Workflow ${run.id} review-required.`,
          ...workflowInlineResultLines(run, output),
          `Result file: ${run.resultPath}`,
          ...workflowResultReadbackLines(run),
          result.reason ? `Reason: ${result.reason}` : undefined,
          result.culpritLane ? `Culprit lane: ${result.culpritLane}` : undefined,
        ].filter((line) => line !== undefined).join("\n");
      }
      if (result.patches?.length > 0) {
        run.editPlan = {
          sourceHash: run.sourceHash,
          baseCommit: run.integrationPlan.baseCommit,
          patches: result.patches,
          worktrees: run.integrationWorktrees,
          integration: true,
          lanes: result.lanes,
          mergedLanes: result.mergedLanes,
        };
      }
    }
    if (run.editPlan?.patches?.length > 0) {
      run.editPlan.worktrees = run.editPlan.integration ? run.integrationWorktrees : run.editWorktrees;
      run.editPlan.domainMutationManifest = await stagedDomainMutationManifest(run.dir);
      run.editPlan.domainMutationHash = computeDomainMutationHash(run.editPlan.domainMutationManifest);
      run.editPlan.diffPlanHash = computeDiffPlanHash(run.editPlan);
      await writeJsonAtomic(path.join(run.dir, "diff-plan.json"), run.editPlan);
      if (run.editPlan.integration) await appendIntegrationLedger(run, { phase: "diff-plan-created", diffPlanHash: run.editPlan.diffPlanHash, patchCount: run.editPlan.patches.length });
      // A failed/partial drain must not be masked as a clean apply-ready success.
      // Preserve the diff plan for review but surface the failure in run status, event, toast, and summary.
      run.status = drainFailed ? "failed-with-diff-plan" : "awaiting-diff-approval";
      if (run.status === "awaiting-diff-approval" && !run.approvalWait?.startedAt) {
        run.approvalWait = { startedAt: new Date().toISOString(), diffPlanHash: run.editPlan.diffPlanHash };
      }
    } else {
      run.editPlan = undefined;
      run.status = "completed";
    }
    // Autonomous-local auto-apply (.5): a trusted autonomous-local drain applies a verified, successful
    // diff plan in-run instead of stopping at awaiting-diff-approval. Failed drains keep failed-with-diff-plan.
    if (run.status === "awaiting-diff-approval" && shouldAutoApplyDrain(run, pluginContext)) {
      const applied = await runAutoApply(pluginContext, toolContext, run);
      if (applied) run.status = "completed";
    }
    run.finishedAt = new Date().toISOString();
    run.resultPath = path.join(run.dir, "result.json");
    await writeJsonAtomic(run.resultPath, redactDurableValue({ output }));
    await appendEvent(run, {
      type: run.status === "awaiting-diff-approval" ? "run.awaiting_diff_approval" : run.status === "failed-with-diff-plan" ? "run.failed_with_diff_plan" : run.status === "apply-failed" ? "run.apply_failed" : "run.completed",
      diffPlanHash: run.editPlan?.diffPlanHash,
      awaitingDiffApprovalAt: run.approvalWait?.startedAt,
      drainStatus: typeof output === "object" && output ? output.status : undefined,
    });
    const notification = await writeCompletionNotification(run);
    await writeState(run);
    await maybeDeliverCompletionNotification(pluginContext, notification);
    await showWorkflowRunToast(pluginContext, run, "terminal");
    return [
      `Workflow ${run.id} ${run.status === "awaiting-diff-approval" ? "awaiting diff approval" : run.status === "failed-with-diff-plan" ? "failed with diff plan for review" : run.status === "apply-failed" ? "auto-apply failed" : "completed"}.`,
      ...workflowInlineResultLines(run, output),
      `Result file: ${run.resultPath}`,
      ...workflowResultReadbackLines(run),
      run.editPlan?.diffPlanHash ? `Diff plan hash: ${run.editPlan.diffPlanHash}` : undefined,
      drainFailed && typeof output === "object" && output ? `Drain status: ${output.status}` : undefined,
    ].filter((line) => line !== undefined).join("\n");
  } catch (error) {
    rejectWaitingAgents(run, error);
    // Precedence: an explicit force-kill (resumable "interrupted") and a wall-clock deadline
    // (terminal "timed-out") both abort the controller, so they must be classified before the
    // generic aborted->"cancelled" fallback.
    // Precedence: a budget stop does NOT abort the controller, so it is classified before the
    // generic aborted->"cancelled"/"failed" fallback. The thrown WorkflowBudgetStoppedError loses
    // its prototype/code crossing the QuickJS guest boundary (sandbox-executor re-wraps lane
    // errors as plain VM errors), so detect it the same way the rest of the run state is tracked:
    // off the durable run object. journalFailure records a per-lane "budget_stopped" outcome via
    // laneOutcomeForError BEFORE the error crosses that boundary, so run.laneOutcomes is the
    // reliable run-level signal. Keep the direct error checks for any controller-side throw that
    // never crossed the VM. budget_stopped and failed are both resumable (RESUMABLE_STATUSES).
    const budgetStopped = error instanceof WorkflowBudgetStoppedError
      || error?.code === "WORKFLOW_BUDGET_STOPPED"
      || (run.laneOutcomes?.budget_stopped ?? 0) > 0;
    run.status = run.killed ? "interrupted"
      : run.deadlineExceeded ? "timed-out"
      : run.pauseRequested ? "paused"
      : budgetStopped ? "budget_stopped"
      : run.abortController.signal.aborted ? "cancelled"
      : "failed";
    run.error = extractTextFromError(error);
    run.finishedAt = new Date().toISOString();
    if (run.status === "timed-out" || run.status === "budget_stopped" || run.status === "failed") {
      // Persist a partial result so an operator/agent can see how the run terminated and what
      // completed-lane work survived (durable lane projections/journal remain on disk
      // independently). For the resumable terminal states (failed/budget_stopped) this makes the
      // recoverable work observable so a resume reuses it instead of re-spending.
      run.resultPath = path.join(run.dir, "result.json");
      await writeJsonAtomic(run.resultPath, redactDurableValue({
        status: run.status,
        partial: true,
        resumable: RESUMABLE_STATUSES.has(run.status),
        maxRuntimeMs: run.maxRuntimeMs,
        budgetCeilings: run.budgetCeilings,
        laneOutcomes: run.laneOutcomes,
        error: truncateText(run.error, MAX_STATUS_STRING_CHARS),
      }));
    }
    const eventType = run.status === "paused" ? "run.paused"
      : run.status === "interrupted" ? "run.killed"
      : run.status === "timed-out" ? "run.timed_out"
      : run.status === "budget_stopped" ? "run.budget_stopped"
      : run.status === "cancelled" ? "run.cancelled"
      : "run.failed";
    await appendEvent(run, { type: eventType, error: truncateText(run.error, MAX_STATUS_STRING_CHARS) });
    const notification = await writeCompletionNotification(run);
    await writeState(run);
    await maybeDeliverCompletionNotification(pluginContext, notification);
    await showWorkflowRunToast(pluginContext, run, "terminal");
    throw error;
  } finally {
    clearTimeout(deadlineTimer);
    stopProgressToasts();
    run.eventSink = undefined;
    try {
      // The diff plan is self-contained (patches carry their content), so worktrees are
      // vestigial once the sandbox finishes; remove them for every terminal outcome to
      // avoid leaking git worktrees/branches and throwaway directories.
      const cleaned = await cleanupWorktrees(run);
      if (cleaned && run.status !== "running") await writeState(run);
    } catch (error) {
      run.diagnostics ??= {};
      run.diagnostics.finalizationCleanupError = truncateText(extractTextFromError(error), MAX_STATUS_STRING_CHARS);
      try { await appendEvent(run, { type: "run.finalization_cleanup_failed", error: run.diagnostics.finalizationCleanupError }); } catch {}
    } finally {
      if (!run.background || run.status !== "running") runs.delete(run.id);
      if (run.status !== "running") await run.releaseRunLock?.();
    }
  }
}

function sameStableValue(a, b) {
  return stableStringify(a) === stableStringify(b);
}

// jbs3.4: resume replay preview for the approval gate. A resumed run re-executes the body and
// serves completed lanes from the journal cache when each lane's signature still matches. The
// signature (event-journal.laneSignature) is keyed on sourceHash + runtimeArgs + the lane's resolved
// model + body/capability-derived fields. On an allowed resume the source and model envelope are
// PINNED (a change is rejected by assertResumeEnvelopeUnchanged before approval), so the only
// operator-facing lever that still invalidates the cache is runtimeArgs -- and changing any of these
// shared, top-level signature inputs invalidates EVERY completed lane uniformly, forcing it to
// re-run and re-pay its prior spend (which still counts toward the budget ceiling). This computes
// how many completed lanes would re-run and the approximate dollar re-spend so the operator sees it
// before approving. Returns null for a cold start (no prior run to replay).
async function computeResumeReplayPreview(resumeEntry, priorState, proposed) {
  if (!resumeEntry || !priorState) return null;
  const journal = await loadJournal(resumeEntry.dir);
  const completedLanes = [...journal.values()].filter((entry) => entry.outcome === "success");
  // jbs3.3 edit-and-resume: an edited body changes sourceHash, but lane reuse is now content-addressed
  // PER LANE (event-journal.laneSignature no longer mixes in the whole-file hash), so a source edit no
  // longer uniformly invalidates every completed lane — only the lanes whose own resolved inputs
  // changed re-run. Which lanes those are is not known until the new body executes (each lane's prompt
  // is resolved during replay), so the preview reports an honest worst-case bound rather than the false
  // "everything re-runs" the whole-run hash compare would give. The other levers (runtimeArgs, model)
  // are top-level signature inputs whose change DOES invalidate every lane uniformly, so they are still
  // reported as a hard count.
  const editedBody = proposed.editAndResume === true && proposed.sourceHash !== priorState.sourceHash;
  const reasons = [];
  if (!editedBody && proposed.sourceHash !== priorState.sourceHash) reasons.push("source");
  if (stableStringify(proposed.runtimeArgs ?? null) !== stableStringify(priorState.runtimeArgs ?? null)) reasons.push("runtime args");
  if (typeof priorState.defaultChildModel === "string" && proposed.defaultChildModel !== priorState.defaultChildModel) reasons.push("model");
  const invalidated = reasons.length > 0;
  const willReRun = invalidated ? completedLanes : [];
  const reSpend = willReRun.reduce((sum, entry) => sum + (Number.isFinite(entry.cost) ? entry.cost : 0), 0);
  const maxReSpend = completedLanes.reduce((sum, entry) => sum + (Number.isFinite(entry.cost) ? entry.cost : 0), 0);
  return { completed: completedLanes.length, willReRun: willReRun.length, reSpend, reasons, editedBody, maxReSpend };
}

function resumeReplayLine(preview) {
  if (preview.editedBody) {
    return `Resume replay: edited body — unchanged lanes replay from cache at no new spend; only edited/dependent lanes re-run (up to ${preview.completed} cached lanes, ~$${preview.maxReSpend.toFixed(4)} worst-case re-spend; replayed spend already counts toward the budget ceiling).`;
  }
  if (preview.willReRun > 0) {
    return `Resume replay: ${preview.willReRun} lanes will re-run, ~$${preview.reSpend.toFixed(4)} re-spend (changed ${preview.reasons.join(", ")} invalidates ${preview.willReRun} of ${preview.completed} cached lanes; replayed spend already counts toward the budget ceiling).`;
  }
  return `Resume replay: 0 lanes will re-run, ~$0 re-spend (${preview.completed} completed lanes replay from cache at no new spend).`;
}

function assertResumeEnvelopeUnchanged(args, prior, requested, opts = {}) {
  if (!prior) return;
  if (Object.hasOwn(args, "maxAgents") && args.maxAgents !== prior.maxAgents) throw new Error(`resumeRunId cannot change maxAgents from ${prior.maxAgents} to ${args.maxAgents}`);
  // jbs3.4: the model envelope is pinned to the prior segment (defaultChildModel/modelTiers above).
  // Reject -- rather than silently ignore -- an operator who passes a DIFFERENT childModel/modelTiers
  // on resume: changing the model would invalidate every completed lane's cached signature and force
  // a full re-run/re-spend, so it must start a new workflow instead. Read the requested arg directly
  // (normalized the same way as the resolved envelope) so the comparison is apples-to-apples.
  if (Object.hasOwn(args, "childModel") && args.childModel != null && typeof prior.defaultChildModel === "string") {
    const requestedModel = modelKey(resolveRequestedModel(args.childModel, "default child"));
    if (requestedModel !== prior.defaultChildModel) throw new Error(`resumeRunId cannot change the child model from ${prior.defaultChildModel} to ${requestedModel} without starting a new workflow`);
  }
  if (Object.hasOwn(args, "modelTiers") && args.modelTiers && typeof args.modelTiers === "object" && !Array.isArray(args.modelTiers)) {
    for (const tier of ["fast", "deep"]) {
      if (!Object.hasOwn(args.modelTiers, tier) || args.modelTiers[tier] == null) continue;
      const requestedTier = modelKey(resolveRequestedModel(args.modelTiers[tier], `${tier} tier`));
      const priorTier = prior.modelTiers && typeof prior.modelTiers[tier] === "string" ? prior.modelTiers[tier] : prior.defaultChildModel;
      if (typeof priorTier === "string" && requestedTier !== priorTier) throw new Error(`resumeRunId cannot change the ${tier}-tier model from ${priorTier} to ${requestedTier} without starting a new workflow`);
    }
  }
  const requestedLaneTimeoutMs = laneTimeoutAliasValue(args, "workflow_run");
  if (requestedLaneTimeoutMs !== undefined && requestedLaneTimeoutMs !== (prior.laneTimeoutMs ?? DEFAULT_CHILD_PROMPT_TIMEOUT_MS)) throw new Error("resumeRunId cannot change laneTimeoutMs without starting a new workflow");
  const priorBudget = normalizeBudgetCeilings(prior.budgetCeilings);
  // jbs3.1: resuming a budget-stopped run may RAISE the cost/token ceiling (re-approved) so the
  // remaining/failed lanes get headroom; the raise (never a lower) is validated by
  // resolveResumeBudgetCeilings, so the equality pin is relaxed only on that path.
  if (!opts.allowBudgetRaise) {
    if (Object.hasOwn(args, "maxCost") && args.maxCost !== priorBudget.maxCost) throw new Error("resumeRunId cannot change maxCost without starting a new workflow");
    if (Object.hasOwn(args, "maxTokens") && args.maxTokens !== priorBudget.maxTokens) throw new Error("resumeRunId cannot change maxTokens without starting a new workflow");
  }
  if (Object.hasOwn(args, "authority") && !sameStableValue(args.authority, prior.authority)) throw new Error("resumeRunId cannot change authority without starting a new workflow");
  if (Object.hasOwn(args, "profile") && args.profile !== prior.authority?.profile) throw new Error("resumeRunId cannot change profile without starting a new workflow");
  if (Object.hasOwn(args, "background") && args.background !== (prior.background === true)) throw new Error("resumeRunId cannot change background mode without starting a new workflow");
  if (Object.hasOwn(args, "debugCapture") && args.debugCapture !== (prior.debugCapture?.enabled === true)) throw new Error("resumeRunId cannot change debugCapture without starting a new workflow");
}

// jbs3.1: on a budget-stopped resume the operator may RAISE the cost/token ceiling so the
// remaining/failed lanes have headroom; completed lanes still replay from cache at zero new
// spend. A raise is the ONLY permitted change — lowering a ceiling below the prior value (which
// historical replayed spend may already exceed) is rejected; omitting a ceiling keeps the prior.
function resolveResumeBudgetCeilings(args, priorBudget) {
  const next = { maxCost: priorBudget.maxCost, maxTokens: priorBudget.maxTokens };
  if (Object.hasOwn(args, "maxCost") && Number.isFinite(args.maxCost)) {
    if (Number.isFinite(priorBudget.maxCost) && args.maxCost < priorBudget.maxCost) {
      throw new Error(`resumeRunId cannot lower maxCost on a budget-stopped resume (prior ${priorBudget.maxCost}, requested ${args.maxCost}); raise it or start a new workflow`);
    }
    next.maxCost = args.maxCost;
  }
  if (Object.hasOwn(args, "maxTokens") && Number.isInteger(args.maxTokens)) {
    if (Number.isInteger(priorBudget.maxTokens) && args.maxTokens < priorBudget.maxTokens) {
      throw new Error(`resumeRunId cannot lower maxTokens on a budget-stopped resume (prior ${priorBudget.maxTokens}, requested ${args.maxTokens}); raise it or start a new workflow`);
    }
    next.maxTokens = args.maxTokens;
  }
  return normalizeBudgetCeilings(next);
}

// Best-effort read of the invoking session's active model so the default child
// model can inherit it. Tries the live session first (when the SDK exposes a
// model on the session), then the global config default. Never throws; returns
// { model: null } when nothing is readable, in which case callers must supply an
// explicit child model (there is no hard-coded model fallback).
async function readActiveSessionModel(pluginContext, toolContext) {
  const client = pluginContext?.client;
  if (!client) return { model: null, source: "none" };
  try {
    if (toolContext?.sessionID && client.session?.get) {
      const got = await client.session.get({ path: { id: toolContext.sessionID } });
      const m = got?.data?.model;
      if (typeof m === "string" && m.includes("/")) return { model: m, source: "active" };
    }
  } catch { /* fall through to config default */ }
  try {
    const cfg = await client.config?.get?.();
    const m = cfg?.data?.model;
    if (typeof m === "string" && m.includes("/")) return { model: m, source: "config-default" };
  } catch { /* fall through */ }
  return { model: null, source: "none" };
}

const WORKFLOW_PROVIDER_LIST_TTL_MS = VERIFIED_PROBE_TTL_MS;
const workflowProviderListCache = new Map();
const workflowProviderListClientKeys = new WeakMap();
let workflowProviderListClientKeySeq = 0;

function workflowProviderListCacheKey(pluginContext) {
  if (pluginContext?.serverUrl !== undefined && pluginContext?.serverUrl !== null && pluginContext?.serverUrl !== false) {
    return `server:${String(pluginContext.serverUrl)}`;
  }
  const client = pluginContext?.client;
  if (client && (typeof client === "object" || typeof client === "function")) {
    let key = workflowProviderListClientKeys.get(client);
    if (!key) {
      workflowProviderListClientKeySeq += 1;
      key = `client:${workflowProviderListClientKeySeq}`;
      workflowProviderListClientKeys.set(client, key);
    }
    return key;
  }
  return "default";
}

function emptyProviderListReadback() {
  return { providersRaw: [], providerDefault: {} };
}

async function readWorkflowProviderList(pluginContext) {
  const client = pluginContext?.client;
  if (!client?.config?.providers) return emptyProviderListReadback();

  const key = workflowProviderListCacheKey(pluginContext);
  const existing = workflowProviderListCache.get(key);
  const now = Date.now();
  if (existing) {
    if (now - existing.ts < WORKFLOW_PROVIDER_LIST_TTL_MS) return await existing.promise;
    workflowProviderListCache.delete(key);
  }

  const entry = { ts: now, promise: undefined };
  entry.promise = (async () => {
    try {
      const res = await client.config.providers();
      return {
        providersRaw: Array.isArray(res?.data?.providers) ? res.data.providers : [],
        providerDefault: res?.data?.default ?? {},
      };
    } catch {
      if (workflowProviderListCache.get(key) === entry) workflowProviderListCache.delete(key);
      return emptyProviderListReadback();
    }
  })();
  workflowProviderListCache.set(key, entry);
  return await entry.promise;
}

function invalidateWorkflowProviderListCache(pluginContextOrScope) {
  if (pluginContextOrScope === undefined || pluginContextOrScope === "all") {
    const count = workflowProviderListCache.size;
    workflowProviderListCache.clear();
    return count;
  }
  const key = typeof pluginContextOrScope === "string"
    ? pluginContextOrScope
    : workflowProviderListCacheKey(pluginContextOrScope);
  return workflowProviderListCache.delete(key) ? 1 : 0;
}

function hardConcurrencyLimitForContext(pluginContext) {
  return normalizeHardConcurrencyLimit(pluginContext?.__workflowHardConcurrencyLimit, HARD_CONCURRENCY_LIMIT);
}

// Read-only model discovery for the planning agent: the invoking session's model
// plus every available/authenticated provider and its models, and a no-deviation
// fast/deep suggestion (both default to the session model — stay in family).
// Never throws; missing providers degrade to an empty list.
async function buildWorkflowModels(pluginContext, toolContext) {
  const session = await readActiveSessionModel(pluginContext, toolContext);
  const { providersRaw, providerDefault } = await readWorkflowProviderList(pluginContext);
  const providers = providersRaw.map((p) => ({
    id: p.id,
    name: p.name,
    source: p.source,
    default: providerDefault[p.id] ?? null,
    models: Object.values(p.models ?? {}).map((m) => ({
      id: m.id,
      name: m.name,
      ...(m.variants ? { variants: Object.keys(m.variants) } : {}),
    })),
  }));
  const sessionModel = session.model;
  const slash = typeof sessionModel === "string" ? sessionModel.indexOf("/") : -1;
  const providerID = slash > 0 ? sessionModel.slice(0, slash) : null;
  const modelID = slash > 0 ? sessionModel.slice(slash + 1) : null;
  // Default suggestion = stay in the session family at the same model (no deviation).
  const suggested = { fast: sessionModel ?? null, deep: sessionModel ?? null };
  return {
    session: { model: sessionModel, providerID, modelID, family: providerID, source: session.source },
    providers,
    suggested,
  };
}

// Pre-flight model validation (jbs3.5): cross-reference every resolved run model
// (defaultChildModel + modelTiers.fast/deep) against the live provider/model list
// at plan time and reject an unknown model BEFORE approval, any capability probe,
// or any lane launch — with the available-models list in the message.
//
// Degrades gracefully for transient provider-list gaps: an empty/unreadable
// provider list (buildWorkflowModels never throws and returns [] when the read
// fails) skips validation rather than rejecting every model. Only a non-empty,
// successfully-read list can reject, so a real list that genuinely omits the
// requested model is the only way to fail closed.
function assertModelsAvailable(providers, models) {
  if (!Array.isArray(providers) || providers.length === 0) return;
  const index = new Map();
  for (const p of providers) {
    index.set(p.id, new Set((p.models ?? []).map((m) => m.id)));
  }
  const available = providers
    .map((p) => `${p.id}: ${(p.models ?? []).map((m) => m.id).join(", ") || "(none)"}`)
    .join("; ");
  for (const { label, model } of models) {
    if (!model || typeof model !== "string") continue;
    const slash = model.indexOf("/");
    const providerID = slash > 0 ? model.slice(0, slash) : null;
    const modelID = slash > 0 ? model.slice(slash + 1) : null;
    const providerModels = providerID ? index.get(providerID) : undefined;
    if (!providerModels) {
      throw new Error(`Model "${model}" (${label}) not available: provider "${providerID ?? model}" is not in the available provider list. Available: ${available}`);
    }
    if (!providerModels.has(modelID)) {
      throw new Error(`Model "${model}" (${label}) not available from provider "${providerID}"; available: ${available}`);
    }
  }
}

// jbs3.10: a workflow may declare meta.argsSchema (a JSON Schema). When present, the runtime args
// payload (args.args) is validated against it at plan time — before the approval envelope is built
// and before any lane launches — so a malformed payload fails loudly here instead of surfacing as a
// confusing mid-run failure (or silently running with missing/extra fields). Reuses the existing
// shared AJV instance (structured-output.js) rather than adding a second validator.
function assertWorkflowArgsMatchSchema(meta, runtimeArgs) {
  const schema = meta?.argsSchema;
  if (schema === undefined || schema === null) return;
  if (typeof schema !== "object" || Array.isArray(schema)) {
    throw new Error("Workflow meta.argsSchema must be a JSON Schema object");
  }
  let validate;
  try {
    // A workflow is typically planned twice (preview, then approve) in one process; if the author
    // gave the schema an $id, reuse the already-compiled validator instead of recompiling (which
    // AJV rejects as a duplicate id) — but only when the schema CONTENT still matches what was
    // registered under that $id. A reused $id carrying a differently-shaped schema (edit-and-resume,
    // or an unrelated workflow picking the same id) must recompile, not silently validate against the
    // stale rules. compileSchemaWithIdentity enforces that content check; see structured-output.js.
    validate = compileSchemaWithIdentity(schema);
  } catch (error) {
    throw new Error(`Invalid workflow meta.argsSchema: ${extractTextFromError(error)}`);
  }
  if (validate(runtimeArgs ?? null)) return;
  throw new Error(
    `Workflow args do not match meta.argsSchema:\n${ajv.errorsText(validate.errors, { separator: "\n", dataVar: "args" })}`,
  );
}

async function planWorkflowEnvelope(pluginContext, toolContext, args) {
  const resumeRunId = args.resumeRunId ? assertSafeRunId(args.resumeRunId, "resumeRunId") : undefined;
  // jbs3.3 edit-and-resume: the opt-in only makes sense when resuming AND supplying the edited body.
  // Reject up front (before any source read) so a misuse can never silently fall back to running the
  // unedited persisted script or starting a brand-new run.
  if (args.editAndResume === true) {
    if (!resumeRunId) throw new Error("editAndResume requires resumeRunId (it resumes a prior run with an edited body)");
    if (!hasExplicitWorkflowSource(args)) throw new Error("editAndResume requires the edited body via source/scriptPath/name");
  }
  const resumeEntry = resumeRunId ? await readResumeRunEntry(toolContext, resumeRunId) : undefined;
  if (resumeEntry) await assertResumableState(resumeEntry, resumeRunId, args);
  const priorState = resumeEntry ? await readJsonFile(path.join(resumeEntry.dir, "state.json"), null) : null;
  // Trusted extension workflow dirs (read uniformly from pluginContext — the single source of truth
  // under double-instantiation) merge into source resolution + scriptPath admission + nested snapshots.
  const extWfDirs = pluginContext.workflowExtensionRegistry?.assetDirs()?.workflows ?? [];
  const { source, sourcePath } = await resolveWorkflowSourceForStart(toolContext, args, resumeEntry, extWfDirs);
  const sourceHash = hash(source);
  const { meta, body } = parseWorkflowSource(source);
  const sourceMetadata = sourcePreviewMetadata(source, sourcePath, args);
  assertWorkflowArgsMatchSchema(meta, args.args);
  // Drain workflows accept a runtime-args laneTimeoutMs alias; arg-shape validation is handled by
  // the canonical drain normalization (authorityArgsForWorkflow) for harness==="drain" workflows.
  const isDrainHarness = meta.harness === "drain";
  const nestedSnapshots = await buildNestedSnapshots(toolContext, source, extWfDirs);
  const adapter = await createCapabilityAdapter(pluginContext);
  const maxAgents = resumeEntry && Number.isInteger(priorState?.maxAgents)
    ? priorState.maxAgents
    : Number.isInteger(args.maxAgents)
      ? args.maxAgents
      : Number.isInteger(meta.maxAgents)
        ? meta.maxAgents
        : DEFAULT_MAX_AGENTS;
  const sessionModel = await readActiveSessionModel(pluginContext, toolContext);
  // jbs3.4: pin the model envelope on resume exactly like maxAgents/authority/budget/concurrency.
  // A resumed run reuses the prior segment's resolved defaultChildModel/modelTiers so completed
  // lanes keep matching their cached signatures (event-journal.laneSignature keys on the resolved
  // model) even when the invoking session's model has since changed -- otherwise every completed
  // lane would silently invalidate and re-spend. A different childModel/modelTiers passed on resume
  // is rejected by assertResumeEnvelopeUnchanged below rather than being silently honored.
  const defaultChildModel = resumeEntry && typeof priorState?.defaultChildModel === "string"
    ? priorState.defaultChildModel
    : modelKey(resolveRequestedModel(args.childModel || meta.childModel || meta.defaultChildModel || sessionModel.model, "default child"));
  // No hard-coded model fallback (AGENTS.md: "Model IDs from config, never literals"). The default
  // child model is resolved, in order, from an explicit childModel arg, the workflow meta, then the
  // invoking session's model. When none is readable there is no model to launch lanes with, so fail
  // explicitly and prompt the caller for one rather than silently selecting a provider/model.
  if (!defaultChildModel) {
    throw new Error(
      "No child model could be resolved: the active session exposes no model and no childModel was supplied. " +
      "Pass childModel (\"provider/model\") to workflow_run, set meta.childModel/meta.defaultChildModel in the workflow, " +
      "or run from a session that has a configured model.",
    );
  }
  // A lane that declares tier: "fast"|"deep" resolves to modelTiers[tier]; both tiers always
  // populate (defaulting to defaultChildModel) so the value is deterministic and hash-stable,
  // and legacy lanes (no tier) stay on defaultChildModel via resolveLaneModel's fallback.
  const tierSource = (args.modelTiers && typeof args.modelTiers === "object" && !Array.isArray(args.modelTiers))
    ? args.modelTiers
    : (meta.modelTiers && typeof meta.modelTiers === "object" && !Array.isArray(meta.modelTiers) ? meta.modelTiers : {});
  const modelTiers = resumeEntry && priorState?.modelTiers && typeof priorState.modelTiers === "object" && !Array.isArray(priorState.modelTiers)
    ? { fast: priorState.modelTiers.fast ?? defaultChildModel, deep: priorState.modelTiers.deep ?? defaultChildModel }
    : {
        fast: modelKey(resolveRequestedModel(tierSource.fast || defaultChildModel, "fast tier")),
        deep: modelKey(resolveRequestedModel(tierSource.deep || defaultChildModel, "deep tier")),
      };
  // Pre-flight model validation against the live provider list (jbs3.5). Reuse
  // buildWorkflowModels' provider read and reject an unknown model here — before
  // the approval envelope is built, before capability probes, and before any lane
  // launches. Skip on resume: the resumed models are pinned by priorState and were
  // validated at original plan time, and re-checking against a possibly-changed
  // provider list could spuriously block a previously-approved run.
  if (!resumeEntry) {
    const { providers: availableProviders } = await buildWorkflowModels(pluginContext, toolContext);
    assertModelsAvailable(availableProviders, [
      { label: "default child model", model: defaultChildModel },
      { label: "fast tier", model: modelTiers.fast },
      { label: "deep tier", model: modelTiers.deep },
    ]);
  }
  // Canonicalize drain invocations (profile<->mode reconciliation) BEFORE authority/background/hash
  // so all of them — and the workflow body — see one consistent args object. No-op for non-drain.
  args = authorityArgsForWorkflow(meta, args);
  const authority = resumeEntry && priorState?.authority && typeof priorState.authority === "object" ? priorState.authority : resolveRunAuthority(meta, args);
  const argsPreview = jsonPreview(args.args ?? null);
  const requestedBudgetCeilings = {
    maxCost: Number.isFinite(args.maxCost) ? args.maxCost : Number.isFinite(meta.maxCost) ? meta.maxCost : undefined,
    maxTokens: Number.isInteger(args.maxTokens) ? args.maxTokens : Number.isInteger(meta.maxTokens) ? meta.maxTokens : undefined,
  };
  // jbs3.1: a budget-stopped resume may RAISE the ceiling (re-approved); any other resume pins
  // the prior ceiling exactly. A cold start uses the requested ceiling.
  const resumingBudgetStopped = resumeEntry && String(priorState?.status ?? "") === "budget_stopped";
  const priorBudgetCeilings = normalizeBudgetCeilings(priorState?.budgetCeilings);
  const budgetCeilings = !resumeEntry
    ? requestedBudgetCeilings
    : resumingBudgetStopped
      ? resolveResumeBudgetCeilings(args, priorBudgetCeilings)
      : priorBudgetCeilings;
  const hardConcurrencyLimit = hardConcurrencyLimitForContext(pluginContext);
  const concurrency = resumeEntry && Number.isInteger(priorState?.concurrency) ? priorState.concurrency : Math.max(1, Math.min(Number.isInteger(args.concurrency) ? args.concurrency : meta.concurrency || DEFAULT_CONCURRENCY, hardConcurrencyLimit));
  const workflowRunLaneTimeoutMs = laneTimeoutAliasValue(args, "workflow_run");
  const bundledRuntimeLaneTimeoutMs = isDrainHarness && args.args && typeof args.args === "object" && !Array.isArray(args.args) ? laneTimeoutAliasValue(args.args, "drain args") : undefined;
  if (workflowRunLaneTimeoutMs !== undefined && bundledRuntimeLaneTimeoutMs !== undefined && workflowRunLaneTimeoutMs !== bundledRuntimeLaneTimeoutMs) {
    throw new Error("workflow_run laneTimeoutMs and drain args laneTimeoutMs must match when both are provided");
  }
  const requestedLaneTimeoutMs = workflowRunLaneTimeoutMs ?? bundledRuntimeLaneTimeoutMs ?? laneTimeoutAliasValue(meta, "workflow meta");
  const laneTimeoutMs = resumeEntry && Number.isInteger(priorState?.laneTimeoutMs) ? priorState.laneTimeoutMs : requestedLaneTimeoutMs ?? DEFAULT_CHILD_PROMPT_TIMEOUT_MS;
  const guestDeadlineMs = resumeEntry && Number.isInteger(priorState?.guestDeadlineMs) ? priorState.guestDeadlineMs : Number.isInteger(args.guestDeadlineMs) ? args.guestDeadlineMs : Number.isInteger(meta.guestDeadlineMs) ? meta.guestDeadlineMs : DEFAULT_GUEST_DEADLINE_MS;
  // Optional run-level wall-clock deadline (jbs3.6). Distinct from the per-lane laneTimeoutMs
  // and the synchronous guest-burst guestDeadlineMs: when set, runWorkflowExecution hard-stops
  // the whole run (terminal status "timed-out" + partial result) after this many ms regardless
  // of where work is wedged. undefined => no run-level deadline.
  const resumingTimedOutWithExtendedDeadline = resumeEntry && priorState?.status === "timed-out" && args.resumePolicy === "extend-deadline";
  const maxRuntimeMs = resumeEntry
    ? resumingTimedOutWithExtendedDeadline && Number.isInteger(args.maxRuntimeMs)
      ? args.maxRuntimeMs
      : Number.isInteger(priorState?.maxRuntimeMs)
        ? priorState.maxRuntimeMs
        : undefined
    : Number.isInteger(args.maxRuntimeMs)
      ? args.maxRuntimeMs
      : Number.isInteger(meta.maxRuntimeMs)
        ? meta.maxRuntimeMs
        : undefined;
  const baseCommit = authority.edit || authority.worktreeEdit || authority.integration ? await gitHead(toolContext.worktree || toolContext.directory) : undefined;
  const backgroundSizingSignals = {
    // Workflow meta.maxAgents is a ceiling, and many bundled review workflows intentionally
    // over-provision it. Treat only per-call maxAgents as an expected fan-out signal.
    maxAgentsSignal: Number.isInteger(args.maxAgents),
    maxRuntimeSignal: Number.isInteger(args.maxRuntimeMs) || Number.isInteger(meta.maxRuntimeMs),
  };
  const backgroundDecision = workflowBackgroundDecision(meta, sourcePath, args, priorState, { maxAgents, concurrency, maxRuntimeMs, ...backgroundSizingSignals });
  const background = backgroundDecision.enabled;
  const notificationDelivery = { promptAsyncAvailable: sessionApi(pluginContext).has("promptAsync") };
  const requestedDebugCapture = args.debugCapture === true || truthyEnvFlag(process.env[OPENCODE_WORKFLOWS_DEBUG_CAPTURE_ENV]);
  const debugCapture = resumeEntry
    ? priorState?.debugCapture?.enabled === true
    : requestedDebugCapture;
  const debugCaptureSource = debugCapture
    ? (args.debugCapture === true ? "workflow_run" : truthyEnvFlag(process.env[OPENCODE_WORKFLOWS_DEBUG_CAPTURE_ENV]) ? OPENCODE_WORKFLOWS_DEBUG_CAPTURE_ENV : "resume")
    : "off";
  assertResumeEnvelopeUnchanged(args, priorState, { defaultChildModel, authority, budgetCeilings, maxAgents }, { allowBudgetRaise: resumingBudgetStopped });
  const resumePreview = await computeResumeReplayPreview(resumeEntry, priorState, { sourceHash, runtimeArgs: args.args ?? null, defaultChildModel, modelTiers, editAndResume: args.editAndResume === true });
  const externalSource = sourcePath !== "<inline>" && !isTrustedWorkflowPath(sourcePath, toolContext, extWfDirs);
  const autoApprove = workflowAutoApprovePreview(pluginContext, args, authority);

  return {
    resumeRunId,
    resumeEntry,
    priorState,
    source,
    body,
    adapter,
    meta,
    approval: {
      meta,
      sourcePath,
      sourceHash,
      sourceMetadata,
      externalSource,
      runtimeArgs: args.args ?? null,
      maxAgents,
      concurrency,
      laneTimeoutMs,
      defaultChildModel,
      modelTiers,
      authority,
      argsPreview,
      budgetCeilings,
      baseCommit,
      guestDeadlineMs,
      maxRuntimeMs,
      debugCapture,
      debugCaptureSource,
      ...backgroundSizingSignals,
      background,
      backgroundDecision,
      notificationDelivery,
      resumeRunId: args.resumeRunId,
      resumePolicy: args.resumePolicy ?? null,
      resumePreview,
      capabilities: adapter.capabilities,
      nestedSnapshots,
      autoApprove,
    },
  };
}

async function startWorkflow(pluginContext, toolContext, args) {
  assertWriteWorkflowAllowed(toolContext, "workflow_run");
  const { resumeRunId, resumeEntry, priorState, source, body, adapter, meta, approval } = await planWorkflowEnvelope(pluginContext, toolContext, args);
  const autoApproved = args.approve === true ? null : workflowAutoApproval(pluginContext, args, approval);
  if (args.approve !== true && !autoApproved) return approvalPreviewResponse(approval, args);
  if (args.approve === true && args.approvalHash !== approvalHash(approval)) return approvalMismatchResponse(approval, args);
  const {
    sourcePath,
    sourceHash,
    sourceMetadata,
    nestedSnapshots,
    argsPreview,
    maxAgents,
    concurrency,
    laneTimeoutMs,
    defaultChildModel,
    modelTiers,
    authority,
    budgetCeilings,
    baseCommit,
    guestDeadlineMs,
    maxRuntimeMs,
    background,
    backgroundDecision,
    notificationDelivery,
    debugCapture,
    debugCaptureSource,
  } = approval;
  // Verify shape-derived capabilities with live probes before the run starts (after the
  // approval check, so the approval envelope is hashed over pre-probe state and a preview
  // never probes). This settles run.capabilities before any lane executes.
  await promoteCapabilities(pluginContext, toolContext, adapter, authority, { childLanesAllowed: maxAgents > 0 });
  // A non-dry drain manages its own integration-worktree isolation internally (the drain runtime),
  // so it delegates those capability checks rather than requiring them pre-launch here.
  const drainDelegatesIntegrationGates = meta.harness === "drain" && args.args?.dryRun !== true;
  const requiredGateStatus = await verifyRequiredAuthorityGates(pluginContext, toolContext, adapter, authority);
  // Keep the historical network/MCP verifier hook for diagnostics compatibility.
  // webfetch/websearch/mcp authority is enforced by permission rules plus the
  // permissionEnforcement gate; networkAccess remains informational/reserved,
  // while mcpAccess can be probed explicitly through workflow_live_gates.
  await verifyNetworkMcpAuthorityGates(pluginContext, toolContext, authority);
  promoteVerifiedGateCapabilities(adapter, requiredGateStatus);
  if (authority.profile === AD_HOC_AUTHORITY_PROFILE) {
    const needsPermissions = authority.shell || authority.network || authority.mcp || authority.edit || authority.worktreeEdit || authority.integration || maxAgents > 0;
    const needsWorktreeIsolation = authority.edit || authority.worktreeEdit || authority.integration;
    function requireCapability(name, reason) {
      if (adapter.capabilities[name] !== "available") {
        throw new Error(`${reason}; ${name}=${adapter.capabilities[name]} (available-unverified is not behavioral proof)`);
      }
    }
    if (needsPermissions) requireCapability("permissions", "Child-lane or elevated workflow authority requires verified permission enforcement");
    if (needsWorktreeIsolation && !drainDelegatesIntegrationGates) {
      requireCapability("worktree", "Edit/worktreeEdit/integration workflows require verified worktree API behavior");
      requireCapability("directoryRooting", "Edit/worktreeEdit/integration workflows require verified child directory rooting");
      requireCapability("worktreeEditIsolation", "Edit/worktreeEdit/integration workflows require verified worktree edit isolation");
    }
  }

  const root = resumeEntry?.root ?? await ensureRunRoot(toolContext);
  const runId = resumeRunId ?? crypto.randomUUID();
  const dir = runDirForRoot(root, runId);
  if (runs.has(runId)) throw new Error(`Workflow run is already active: ${runId}`);
  await ensurePrivateDir(dir);
  let releaseRunLock = await acquireWorkflowLock(lockPathForRun(dir, "run"), { operation: "run", runId });
  let run;
  try {
    if (resumeRunId) {
      await fs.rm(lifecycleRequestPath(dir, "pause"), { force: true });
      // A force-killed run is resumable; its durable kill-request.json must be cleared on resume
      // or checkDurableLifecycleRequest would immediately re-abandon the freshly resumed run.
      await fs.rm(lifecycleRequestPath(dir, "kill"), { force: true });
    }
    await writeFilePrivate(path.join(dir, "script.js"), source, "utf8");
    const resumeJournal = args.resumeRunId ? await loadJournal(dir) : new Map();
    if (args.resumeRunId) await compactJournal(dir, resumeJournal);
    const resumeSignatureIndex = buildResumeSignatureIndex(resumeJournal);

    run = {
    id: runId,
    dir,
    projectDirectory: toolContext.directory,
    projectWorktree: toolContext.worktree,
    sourcePath,
    sourceHash,
    sourceMetadata,
    meta,
    authority,
    runtimeArgs: args.args ?? null,
    nestedSnapshots,
    argsPreview,
    status: "running",
    startedAt: new Date().toISOString(),
    resumedAt: undefined,
    finishedAt: undefined,
    currentPhase: undefined,
    agentsStarted: 0,
    maxAgents,
    concurrency,
    laneTimeoutMs,
    defaultChildModel,
    modelTiers,
    activeAgents: 0,
    waitingAgents: [],
    tokens: { input: 0, output: 0, reasoning: 0 },
    replayedTokens: { input: 0, output: 0, reasoning: 0 },
    cost: 0,
    replayedCost: 0,
    cacheStats: { hits: 0, misses: 0, invalidated: 0 },
    budgetCeilings,
    laneOutcomes: Object.fromEntries(LANE_OUTCOMES.map((outcome) => [outcome, 0])),
    droppedLaneCount: 0,
    error: undefined,
    resultPath: undefined,
    closeout: undefined,
    lifecycleRequests: undefined,
    notification: undefined,
    notificationTarget: background ? {
      sessionID: toolContext.sessionID,
      messageID: toolContext.messageID,
      directory: toolContext.directory,
      agent: toolContext.agent,
    } : undefined,
    recovery: undefined,
    capabilities: adapter.capabilities,
    diagnostics: adapter.diagnostics,
    adapter,
    editWorktrees: [],
    editPlan: authority.edit || authority.worktreeEdit ? { sourceHash, baseCommit, patches: [], worktrees: [] } : undefined,
    integrationPlan: authority.integration ? { sourceHash, baseCommit, lanes: [], worktrees: [], integrationResult: undefined } : undefined,
    integrationWorktrees: [],
    worktreeAdapter: undefined,
    laneRecords: new Map(),
    children: new Map(),
    activeLaneAbortControllers: new Map(),
    cancelledFanoutScopes: new Set(),
    resumeJournal,
    resumeSignatureIndex,
    resumeSignatureClaims: new Set(),
    abortController: new AbortController(),
    pauseRequested: false,
    background,
    backgroundDecision,
    notificationDelivery,
    debugCapture: { enabled: debugCapture === true, source: debugCaptureSource },
    autoApproved,
    recentLogs: [],
    ignoreToolAbort: background,
    hostCalls: 0,
    eventCount: 0,
    journalRecords: 0,
    nestingDepth: 0,
    guestDeadlineMs,
    maxRuntimeMs,
    deadlineExceeded: false,
    killed: false,
    releaseRunLock,
  };
  if (run.notificationTarget?.sessionID) idleNotificationSessions.delete(run.notificationTarget.sessionID);
  if (args.resumeRunId) {
    // Rehydrate run-level state persisted by the prior segment so a resumed run does not
    // reset observability/limit counters, worktree ledgers, or the original start time.
    rehydrateRunFromPriorState(run, priorState);
    // jbs3.1: rehydrate restores the prior (possibly breached) ceiling from state.json; re-apply
    // the approved envelope ceiling so a budget-stopped resume's RAISED ceiling takes effect.
    // For every non-raise resume this is the same value rehydrate just set (a safe no-op).
    run.budgetCeilings = budgetCeilings;
    run.resumedAt = new Date().toISOString();
    // Seed the in-memory caps from the true on-disk totals so the MAX_* limits enforce
    // against the whole append-only file, not just this session's appends.
    run.journalRecords = await countNonEmptyLines(path.join(dir, "journal.jsonl"));
    run.eventCount = await countNonEmptyLines(path.join(dir, "events.jsonl"));
  }
  runs.set(run.id, run);
  run.eventSink = createWorkflowToastEventSink(pluginContext, run);
  if (run.autoApproved) {
    await appendEvent(run, { type: "run.auto_approved", tier: run.autoApproved.tier, ceiling: run.autoApproved.ceiling });
  }
  await appendEvent(run, { type: "run.started", capabilities: run.capabilities, diagnostics: run.diagnostics });
  await writeState(run);

  if (run.background) {
    run.done = runWorkflowExecution(pluginContext, toolContext, run, body, args.args).catch((_error) => {
      // Background run error after state-write attempt: best effort.
    });
    void run.done;
    const notificationWarning = backgroundNotificationWarning(run, run.id);
    return [
      `Workflow ${run.id} started in background.`,
      `Status: workflow_status({ runId: "${run.id}" })`,
      ...(notificationWarning ? [notificationWarning] : []),
      "Background runs continue only while the current OpenCode process stays alive.",
    ].join("\n");
  }

    return await runWorkflowExecution(pluginContext, toolContext, run, body, args.args);
  } catch (error) {
    if (!run || run.status === "running") {
      // A throw after runs.set (e.g. appendEvent/writeState failing) leaves a phantom
      // 'running' entry that would block resume-id retry for the process lifetime. Drop it,
      // but only if this invocation still owns the slot (guard against a concurrent owner).
      if (run && runs.get(run.id) === run) runs.delete(run.id);
      await releaseRunLock?.();
    }
    throw error;
  }
}

async function validatePatchAncestors(root, patchPath) {
  const rootReal = await fs.realpath(root);
  const parts = patchPath.split(/[\\/]+/).filter(Boolean);
  let current = root;
  for (const part of parts.slice(0, -1)) {
    current = path.join(current, part);
    let stat;
    try {
      stat = await fs.lstat(current);
    } catch (error) {
      if (error.code === "ENOENT") return;
      throw error;
    }
    if (stat.isSymbolicLink()) throw new Error(`Patch ancestor is a symlink: ${patchPath}`);
    if (!stat.isDirectory()) throw new Error(`Patch ancestor is not a directory: ${patchPath}`);
    const real = await fs.realpath(current);
    if (!isPathInside(rootReal, real)) throw new Error(`Patch ancestor escapes primary root: ${patchPath}`);
  }
}

async function validatePatchTargets(root, patches, options = {}) {
  const requireTracked = options.requireTracked !== false;
  const seen = new Set();
  const planned = [];
  for (const patch of patches) {
    if (!patch || typeof patch !== "object") throw new Error("Invalid edit patch entry");
    if (typeof patch.path !== "string" || typeof patch.content !== "string") throw new Error("Edit patches must include string path and content");
    if (seen.has(patch.path)) {
      const overlappingError = new Error(`Overlapping edit patch path: ${patch.path}`);
      overlappingError.code = "OVERLAPPING_PATCH";
      throw overlappingError;
    }
    seen.add(patch.path);
    if (path.isAbsolute(patch.path) || patch.path.split(/[\\/]+/).includes("..")) throw new Error(`Patch escapes primary root: ${patch.path}`);
    assertWritableWorkflowPath(patch.path);
    const target = path.resolve(root, patch.path);
    if (!target.startsWith(`${root}${path.sep}`) && target !== root) throw new Error(`Patch escapes primary root: ${patch.path}`);
    await validatePatchAncestors(root, patch.path);
    let existed = false;
    let previousContent;
    try {
      const stat = await fs.lstat(target);
      if (stat.isSymbolicLink()) throw new Error(`Patch target is a symlink: ${patch.path}`);
      if (stat.isDirectory()) throw new Error(`Patch target is a directory: ${patch.path}`);
      previousContent = await fs.readFile(target, "utf8");
      existed = true;
      if (requireTracked) {
        const tracked = await gitPathTracked(root, patch.path);
        if (!tracked) throw new Error(`Patch target exists but is untracked: ${patch.path}`);
      }
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    planned.push({ patch, target, existed, previousContent });
  }
  return planned;
}

function verifyAppliedPatchContents(planned) {
  for (const item of planned) {
    if (!item.existed || item.previousContent !== item.patch.content) {
      throw new Error(`Applied patch content no longer matches approved diff plan: ${item.patch.path}`);
    }
  }
}

async function rollbackPatches(planned, root) {
  const failures = [];
  for (const item of [...planned].reverse()) {
    try {
      if (item.existed) {
        // Restore prior content TOCTOU-safely (R18): when a root is supplied, the
        // O_NOFOLLOW write refuses to follow a symlink swapped in for the target so
        // rollback cannot be redirected outside root either.
        if (root) await safeWriteFileWithinRoot(root, item.patch.path, item.previousContent);
        else await fs.writeFile(item.target, item.previousContent, "utf8");
      } else {
        await fs.rm(item.target, { force: true });
      }
    } catch (error) {
      failures.push({
        path: item.patch?.path,
        error: truncateText(extractTextFromError(error), MAX_STATUS_STRING_CHARS),
      });
    }
  }
  return failures;
}

// Read a raw, unredacted child transcript via the SDK session.messages API. Salvage must
// read transcripts directly (not through the redacting session_read wrapper some setups may
// layer on top of session history, e.g. a separate opencode-sessions plugin — not a dependency
// of this package, named only as a point of comparison):
// the journal already stores unredacted lane results, and salvage recovers that same class of
// content. Returns { readable, messages, reason }.
async function readRawTranscript(pluginContext, childID) {
  const session = sessionApi(pluginContext);
  if (!session.has("messages")) return { readable: false, messages: null, reason: "session.messages unavailable" };
  try {
    const result = await session.messages({ sessionID: childID });
    const unwrapped = unwrapClientResult(result, `Salvage transcript read for ${childID}`);
    return { readable: true, messages: unwrapped, reason: undefined };
  } catch (error) {
    return { readable: false, messages: null, reason: extractTextFromError(error) };
  }
}

function extractMessagesArray(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  if (Array.isArray(value.data)) return value.data;
  if (value.data && Array.isArray(value.data.messages)) return value.data.messages;
  if (value.data && Array.isArray(value.data.data)) return value.data.data;
  if (Array.isArray(value.messages)) return value.messages;
  return [];
}

function isAssistantMessage(message) {
  if (!message || typeof message !== "object") return false;
  const role = String(message.role ?? message.type ?? "").toLowerCase();
  return role === "assistant";
}

// Find the final assistant message in a transcript and return its concatenated text. Structured
// (schema) lanes normally surface their JSON as the model's final text reply, so this is the
// best-effort recovery target for salvage.
function extractFinalAssistantText(messagesValue) {
  const messages = extractMessagesArray(messagesValue);
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (isAssistantMessage(message)) {
      const parts = [];
      collectTextParts(message, parts);
      const text = parts.join("\n").trim();
      if (text) return { found: true, text };
    }
  }
  return { found: false, text: "" };
}

function tryParseJson(text) {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (error) {
    return { ok: false, error: extractTextFromError(error) };
  }
}

// The approval hash covers the recomputed preview facts (per-candidate callId/childID, skip
// reason, final-message presence/length, final-message hash, parse verdict, signature
// availability). Re-reading transcripts and re-verifying this hash on approve guarantees the
// transcript state has not drifted between preview and approve.
function normalizeSalvageSchemaSnapshot(requestCheckpoint) {
  const snapshot = requestCheckpoint?.schemaSnapshot;
  if (!snapshot || typeof snapshot !== "object") {
    return {
      status: requestCheckpoint?.schemaHash ? "unavailable" : "absent",
      hash: requestCheckpoint?.schemaHash,
      schema: undefined,
    };
  }
  const status = ["present", "absent", "oversized"].includes(snapshot.status) ? snapshot.status : "unavailable";
  return {
    status,
    hash: typeof snapshot.hash === "string" ? snapshot.hash : requestCheckpoint?.schemaHash,
    bytes: Number.isInteger(snapshot.bytes) ? snapshot.bytes : undefined,
    schema: status === "present" && snapshot.schema && typeof snapshot.schema === "object" ? snapshot.schema : undefined,
  };
}

function salvageValidationForParsedValue(parsed, schemaSnapshot) {
  const base = {
    kind: schemaSnapshot.schema ? "json-schema" : "json-parse",
    originalSchemaAvailable: Boolean(schemaSnapshot.schema),
    schemaSnapshotStatus: schemaSnapshot.status,
    schemaHash: schemaSnapshot.hash,
  };
  if (!parsed.ok) {
    return { ...base, schemaVerdict: "not-checked", recoveredResultValid: false, validationError: parsed.error };
  }
  if (!schemaSnapshot.schema) {
    return { ...base, schemaVerdict: "not-checked", recoveredResultValid: true };
  }
  try {
    validateStructuredResult(schemaSnapshot.schema, parsed.value);
    return { ...base, schemaVerdict: "valid", recoveredResultValid: true };
  } catch (error) {
    return {
      ...base,
      schemaVerdict: "invalid",
      recoveredResultValid: false,
      validationError: truncateText(extractTextFromError(error), MAX_STATUS_STRING_CHARS),
    };
  }
}

function salvageApprovalPayload(enriched) {
  return enriched.map((entry) => ({
    callId: entry.callId,
    childID: entry.childID,
    skipped: entry.skipped ?? null,
    finalMessageFound: entry.finalMessageFound,
    finalMessageLength: entry.finalMessageLength,
    parseVerdict: entry.parseVerdict,
    finalMessageHash: entry.finalMessageHash,
    resumeSignatureAvailable: entry.resumeSignatureAvailable,
    validationKind: entry.salvageValidation?.kind,
    originalSchemaAvailable: entry.salvageValidation?.originalSchemaAvailable,
    schemaSnapshotStatus: entry.salvageValidation?.schemaSnapshotStatus,
    schemaHash: entry.salvageValidation?.schemaHash,
    schemaVerdict: entry.salvageValidation?.schemaVerdict,
    validationErrorHash: entry.salvageValidation?.validationError ? hash(entry.salvageValidation.validationError) : undefined,
  }));
}

function computeSalvageApprovalHash(runId, payload) {
  return hashStable({ scope: "workflow_salvage.v1", runId, candidates: payload });
}

// Build the enriched per-candidate preview by reading each orphan's lane projection + raw
// transcript. Edit/integration lanes are reported but never salvaged (no worktree commit
// exists; integrate() requires lane.committed). Read-only lanes are JSON-structurally
// validated against their final assistant message.
async function computeSalvagePreview(pluginContext, runDir, state, runId) {
  const candidates = await computeSalvageCandidates(runDir, state);
  const lanes = await readLaneProjections(runDir, state);
  const laneByCallId = new Map(lanes.map((lane) => [lane.callId, lane]).filter(([, lane]) => lane));
  const enriched = [];
  for (const candidate of candidates) {
    const lane = laneByCallId.get(candidate.callId) ?? {};
    const resumeSignatureAvailable = Boolean(lane.signatureHash);
    const base = {
      callId: candidate.callId,
      childID: candidate.childID,
      title: lane.title,
      taskSummary: lane.taskSummary,
      model: lane.model,
      agent: lane.agent,
      role: lane.role,
      timeoutMs: lane.timeoutMs,
      permissionPolicy: lane.permissionPolicy,
      signatureHash: lane.signatureHash,
      startedAt: lane.startedAt,
    };
    // Edit/integration lanes carry a worktree (and integration lanes carry an integrationLane
    // record). Salvage is read-only-only: there is no worktree commit to recover and integrate()
    // already requires lane.committed, so report-and-skip rather than ever salvaging.
    if (lane.worktreePath || lane.integrationLane) {
      enriched.push({
        ...base,
        skipped: "edit-lane-without-commit",
        finalMessageFound: false,
        finalMessageLength: 0,
        parseVerdict: "skipped",
        finalMessageHash: null,
        resumeSignatureAvailable,
      });
      continue;
    }
    const transcript = await readRawTranscript(pluginContext, candidate.childID);
    if (!transcript.readable) {
      enriched.push({
        ...base,
        skipped: `transcript-unreadable:${truncateText(transcript.reason, 120)}`,
        finalMessageFound: false,
        finalMessageLength: 0,
        parseVerdict: "unreadable",
        finalMessageHash: null,
        resumeSignatureAvailable,
      });
      continue;
    }
    const final = extractFinalAssistantText(transcript.messages);
    const parsed = tryParseJson(final.text);
    const requestCheckpoint = await readLaneRequestCheckpoint(runDir, candidate.callId);
    const schemaSnapshot = normalizeSalvageSchemaSnapshot(requestCheckpoint);
    const salvageValidation = salvageValidationForParsedValue(parsed, schemaSnapshot);
    enriched.push({
      ...base,
      skipped: undefined,
      finalMessageFound: final.found,
      finalMessageLength: final.text.length,
      finalText: final.text,
      parsedValue: parsed.ok ? parsed.value : undefined,
      parseVerdict: parsed.ok ? "valid" : "invalid",
      parseError: parsed.ok ? undefined : parsed.error,
      salvageValidation,
      finalMessageHash: hash(final.text),
      resumeSignatureAvailable,
    });
  }
  return enriched;
}

// Explicit, hash-gated recovery of orphaned read-only lane results from persisted child
// transcripts. Gated like workflow_reconcile (assertWriteWorkflowAllowed). Preview lists
// recoverable lanes without writing; approve (matching hash) writes synthetic journal entries
// tagged salvagedFromTranscript: true. Salvage never calls integrate()/runAutoApply and never
// touches state.json, worktrees, or integration ledgers.
async function salvageRun(pluginContext, context, args) {
  assertWriteWorkflowAllowed(context, "workflow_salvage");
  if (typeof args.runId !== "string" || !args.runId.trim()) throw new Error("workflow_salvage requires runId");
  const runId = args.runId.trim();
  const entry = await readRunById(context, runId);
  if (entry.kind !== "valid") throw new Error(`Cannot salvage invalid run ${runId}: ${entry.status}`);
  const runDir = entry.dir;
  const state = entry.state;
  const runLock = await readLock(lockPathForRun(runDir, "run"));
  if (runLock?.active) {
    throw new Error(
      `Workflow ${runId} still holds an active run lock (pid ${runLock.process?.pid}); ` +
      "wait for the owning run to settle (or run workflow_reconcile) before retrying workflow_salvage."
    );
  }

  const enriched = await computeSalvagePreview(pluginContext, runDir, state, runId);
  const computedHash = computeSalvageApprovalHash(runId, salvageApprovalPayload(enriched));

  const selectedCallIds = Array.isArray(args.callIds) && args.callIds.length > 0
    ? new Set(args.callIds.filter((callId) => typeof callId === "string"))
    : null;

  if (args.approve !== true || args.approvalHash !== computedHash) {
    const candidates = enriched.map((entry) => {
      const view = {
        callId: entry.callId,
        childID: entry.childID,
        parseVerdict: entry.parseVerdict,
        validationKind: entry.salvageValidation?.kind ?? "not-checked",
        originalSchemaAvailable: entry.salvageValidation?.originalSchemaAvailable === true,
        schemaSnapshotStatus: entry.salvageValidation?.schemaSnapshotStatus,
        schemaHash: entry.salvageValidation?.schemaHash,
        schemaVerdict: entry.salvageValidation?.schemaVerdict,
        finalMessageFound: entry.finalMessageFound,
        finalMessageLength: entry.finalMessageLength,
        resumeSignatureAvailable: entry.resumeSignatureAvailable,
      };
      if (entry.skipped) view.skipped = entry.skipped;
      if (entry.salvageValidation?.validationError) view.validationError = truncateText(entry.salvageValidation.validationError, MAX_STATUS_STRING_CHARS);
      if (entry.finalMessageFound) view.redactedSnippet = truncateText(redactFreeTextSecrets(entry.finalText ?? ""), 200);
      return view;
    });
    return JSON.stringify({
      mode: "preview",
      runId,
      approvalHash: computedHash,
      candidates,
      note: "Preview only; nothing written. Re-run with approve: true and this approvalHash (optionally callIds to narrow) to write tagged synthetic journal entries for schema-validated or JSON-parse-validated read-only lanes. Salvage never calls integrate/runAutoApply.",
    }, null, 2);
  }

  // Approve: the recomputed preview hash already matched args.approvalHash, so the transcript
  // state is exactly what the operator approved. Write synthetic entries only for non-skipped
  // read-only lanes; outcome is success only when the final message parsed as JSON.
  const salvaged = [];
  const skipped = [];
  for (const entry of enriched) {
    if (selectedCallIds && !selectedCallIds.has(entry.callId)) continue;
    if (entry.skipped) {
      skipped.push({ callId: entry.callId, childID: entry.childID, reason: entry.skipped });
      continue;
    }
    const outcome = entry.salvageValidation?.recoveredResultValid === true ? "success" : "failure";
    await writeSalvagedLaneOutcome(runDir, entry.callId, {
      runId,
      signatureHash: entry.signatureHash,
      outcome,
      childID: entry.childID,
      title: entry.title,
      taskSummary: entry.taskSummary,
      model: entry.model,
      agent: entry.agent,
      role: entry.role,
      timeoutMs: entry.timeoutMs,
      permissionPolicy: entry.permissionPolicy,
      startedAt: entry.startedAt,
      result: outcome === "success" ? entry.parsedValue : undefined,
      errorSummary: outcome === "success"
        ? undefined
        : entry.salvageValidation?.kind === "json-schema"
          ? `Salvaged transcript final message did not match stored JSON schema: ${truncateText(entry.salvageValidation?.validationError ?? "", MAX_STATUS_STRING_CHARS)}`
          : `Salvaged transcript final message did not parse as JSON: ${truncateText(entry.parseError ?? "", MAX_STATUS_STRING_CHARS)}`,
      salvageValidation: entry.salvageValidation,
    });
    salvaged.push({
      callId: entry.callId,
      childID: entry.childID,
      outcome,
      parseVerdict: entry.parseVerdict,
      validationKind: entry.salvageValidation?.kind,
      schemaSnapshotStatus: entry.salvageValidation?.schemaSnapshotStatus,
      schemaVerdict: entry.salvageValidation?.schemaVerdict,
      resumeSignatureAvailable: entry.resumeSignatureAvailable,
    });
  }
  return JSON.stringify({ mode: "approve", runId, approvalHash: computedHash, salvaged, skipped }, null, 2);
}

async function applyWorkflow(pluginContext, context, args) {
  assertWriteWorkflowAllowed(context, "workflow_apply");
  if (args.approvalIntent !== "apply") throw new Error('workflow_apply requires approvalIntent: "apply"');
  const entry = await readRunById(context, args.runId);
  if (entry.kind !== "valid") throw new Error(`Cannot apply invalid run ${args.runId}: ${entry.status}`);
  const releaseApplyLock = await acquireWorkflowLock(lockPathForRun(entry.dir, "apply"), { operation: "apply", runId: args.runId });
  try {
  // Fail closed while the owning run still holds an ACTIVE run.lock. apply.lock serializes two
  // concurrent applies, but it does NOT serialize apply-vs-active-run: a backgrounded run writes
  // awaiting-diff-approval/apply-failed to state.json and only releases run.lock afterward in its
  // finally block (runWorkflowExecution line ~1085). Applying in that window races the owner's own
  // writeState() in its finally, which would clobber apply-running/applied back to the pre-apply
  // status (a lost update on state.json). The on-disk status alone is not proof of settlement.
  // Stale/dead run.locks (no live owner) are admitted so interrupted/stale-active recovery and the
  // normal foreground path (run.lock already released before the caller can call apply) still work.
  const runLock = await readLock(lockPathForRun(entry.dir, "run"));
  if (runLock?.active) {
    throw new Error(
      `Workflow ${args.runId} still holds an active run lock (pid ${runLock.process?.pid}); ` +
      `wait for the owning run to settle (or run workflow_reconcile) before retrying workflow_apply.`
    );
  }
  const state = entry.state;
  // A crash between the completed-ledger append and the state.json=applied write leaves
  // on-disk status apply-running, which reconcile (workflow_reconcile / stale detection)
  // rewrites to interrupted or stale-active. Those statuses are admitted here only so the
  // matching-completed-ledger idempotency path below can finalize the staged mutations; if
  // no completed record matches, the gate still rejects them (verified after actualPlanHash).
  const isInterruptedRecovery = state.status === "interrupted" || state.status === "stale-active";
  if (state.status !== "applied" && state.status !== "awaiting-diff-approval" && state.status !== "apply-failed" && state.status !== "failed-with-diff-plan" && !isInterruptedRecovery) {
    throw new Error(`Workflow ${args.runId} is not awaiting diff approval; status=${state.status}`);
  }
  if (state.sourceHash !== args.approvedSourceHash) {
    throw applyApprovalMismatchError({
      runId: args.runId,
      reason: "approved_source_hash_mismatch",
      field: "approvedSourceHash",
      supplied: args.approvedSourceHash,
      expected: state.sourceHash ?? null,
      state,
    });
  }
  const plan = JSON.parse(await fs.readFile(path.join(entry.dir, "diff-plan.json"), "utf8"));
  const actualPlanHash = computeDiffPlanHash(plan);
  if (actualPlanHash !== args.diffPlanHash) {
    throw applyApprovalMismatchError({
      runId: args.runId,
      reason: "diff_plan_hash_mismatch",
      field: "diffPlanHash",
      supplied: args.diffPlanHash,
      expected: actualPlanHash,
      state,
      plan,
      actualPlanHash,
    });
  }
  if (plan.baseCommit !== args.baseCommit) {
    throw applyApprovalMismatchError({
      runId: args.runId,
      reason: "base_commit_mismatch",
      field: "baseCommit",
      supplied: args.baseCommit,
      expected: plan.baseCommit ?? null,
      state,
      plan,
      actualPlanHash,
    });
  }
  if (plan.domainMutationHash !== args.domainMutationHash) {
    throw applyApprovalMismatchError({
      runId: args.runId,
      reason: "domain_mutation_hash_mismatch",
      field: "domainMutationHash",
      supplied: args.domainMutationHash,
      expected: plan.domainMutationHash ?? null,
      state,
      plan,
      actualPlanHash,
    });
  }
   const currentDomainManifest = await domainMutationApprovalManifestForRun(entry.dir);
  const currentDomainHash = computeDomainMutationHash(currentDomainManifest);
  if (currentDomainHash !== plan.domainMutationHash) {
    throw applyApprovalMismatchError({
      runId: args.runId,
      reason: "staged_domain_mutations_changed",
      field: "domainMutationHash",
      supplied: args.domainMutationHash,
      expected: currentDomainHash,
      state,
      plan,
      actualPlanHash,
      currentDomainHash,
    });
  }
  // Primary-tree cleanliness is enforced by assertGitCleanAtBase(root, plan.baseCommit) on the
  // fresh-apply path below; there is no caller-supplied dirty-state proof to validate here.
  const root = path.resolve(context.worktree || context.directory);
  async function finalizeAfterApply() {
    try {
      const domainFinalization = await finalizeStagedDomainMutations(entry.dir, state, (op) => pluginContext.__workflowDomainMutationHandlers?.[op] ?? pluginContext.workflowExtensionRegistry?.mutationHandler(op));
      state.domainFinalization = domainFinalization;
      state.status = "applied";
      state.finishedAt = new Date().toISOString();
      state.error = undefined;
      await completeApprovalWaitMetric(entry.dir, state, actualPlanHash);
      await writeJsonAtomic(path.join(entry.dir, "state.json"), state);
      await writeJsonAtomic(path.join(entry.dir, "closeout.json"), {
        runId: state.id,
        status: state.status,
        finishedAt: state.finishedAt,
        resultPath: state.resultPath,
        operatorMetrics: state.operatorMetrics,
        domainFinalization: state.domainFinalization,
        durability: state.durability,
      });
      await showWorkflowApplyToast(pluginContext, state);
      return domainFinalization;
    } catch (error) {
      state.status = "apply-failed";
      state.error = `Domain finalization failed after apply: ${extractTextFromError(error)}`;
      await writeJsonAtomic(path.join(entry.dir, "state.json"), state);
      await showWorkflowApplyToast(pluginContext, state);
      throw error;
    }
  }
  async function verifyRecoveryAppliedContents() {
    try {
      const planned = await validatePatchTargets(root, plan.patches, { requireTracked: false });
      verifyAppliedPatchContents(planned);
    } catch (error) {
      state.status = "apply-failed";
      state.error = extractTextFromError(error);
      await writeJsonAtomic(path.join(entry.dir, "state.json"), state);
      await showWorkflowApplyToast(pluginContext, state);
      throw error;
    }
  }
  if (state.status === "applied") {
    await verifyRecoveryAppliedContents();
    const domainFinalization = await finalizeAfterApply();
    return domainFinalization.finalized > 0
      ? `Workflow ${args.runId} already applied; finalized ${domainFinalization.finalized} domain mutations.`
      : `Workflow ${args.runId} already applied.`;
  }
  const alreadyCompleted = await applyLedgerHasCompleted(entry.dir, actualPlanHash);
  if (isInterruptedRecovery && !alreadyCompleted) {
    // Admitted into the gate above, but no completed ledger record matches: the crash (if
    // any) happened before the patch writes finished, so there is nothing to finalize
    // idempotently and a fresh apply from this status is unsafe. Reject like the original gate.
    throw new Error(`Workflow ${args.runId} is not awaiting diff approval; status=${state.status}`);
  }
  if (alreadyCompleted) {
    await verifyRecoveryAppliedContents();
    const domainFinalization = await finalizeAfterApply();
    return domainFinalization.finalized > 0
      ? `Workflow ${args.runId} already applied; finalized ${domainFinalization.finalized} domain mutations.`
      : `Workflow ${args.runId} already applied.`;
  }

  let planned;
  try {
    await assertGitCleanAtBase(root, plan.baseCommit);
    planned = await validatePatchTargets(root, plan.patches);
  } catch (error) {
    state.status = error?.code === "OVERLAPPING_PATCH" ? "review-required" : "apply-failed";
    state.error = extractTextFromError(error);
    await writeJsonAtomic(path.join(entry.dir, "state.json"), state);
    await showWorkflowApplyToast(pluginContext, state);
    throw error;
  }

  state.status = "apply-running";
  await writeJsonAtomic(path.join(entry.dir, "state.json"), state);
  await appendApplyLedger(entry.dir, { phase: "started", diffPlanHash: actualPlanHash, patchCount: plan.patches.length });
  await showWorkflowApplyToast(pluginContext, state);
  try {
    for (const { patch } of planned) {
      await appendApplyLedger(entry.dir, { phase: "before-write", path: patch.path, contentHash: hash(patch.content) });
      // TOCTOU-safe (R18): re-validate ancestors + open the final component with
      // O_NOFOLLOW immediately at write time, so a symlink swapped in after
      // validatePatchTargets cannot redirect the write outside root.
      await safeWriteFileWithinRoot(root, patch.path, patch.content);
      await appendApplyLedger(entry.dir, { phase: "after-write", path: patch.path, contentHash: hash(patch.content) });
    }
    await appendApplyLedger(entry.dir, { phase: "completed", diffPlanHash: actualPlanHash });
  } catch (error) {
    const rollbackFailures = await rollbackPatches(planned, root);
    state.status = error?.code === "OVERLAPPING_PATCH" ? "review-required" : "apply-failed";
    state.error = applyErrorWithRollbackFailures(error, rollbackFailures);
    await appendApplyLedger(entry.dir, { phase: "failed", diffPlanHash: actualPlanHash, error: state.error, rollbackFailures });
    await writeJsonAtomic(path.join(entry.dir, "state.json"), state);
    await showWorkflowApplyToast(pluginContext, state);
    throw error;
  }
  const domainFinalization = await finalizeAfterApply();
  return domainFinalization.finalized > 0
    ? `Workflow ${args.runId} applied ${plan.patches.length} patches and finalized ${domainFinalization.finalized} domain mutations.`
    : `Workflow ${args.runId} applied ${plan.patches.length} patches.`;
  } finally {
    await releaseApplyLock();
  }
}

async function WorkflowPlugin(pluginContext, options) {
  pluginContext.__workflowHardConcurrencyLimit = normalizeHardConcurrencyLimit(
    options?.hardConcurrencyLimit ?? pluginContext?.hardConcurrencyLimit ?? pluginContext?.__workflowHardConcurrencyLimit,
    HARD_CONCURRENCY_LIMIT,
  );
  pluginContext.__workflowToastAscii = normalizeWorkflowToastAscii(
    options?.toastCards?.ascii ?? options?.workflowToastAscii ?? pluginContext?.__workflowToastAscii,
  );
  pluginContext.workflowAutoApproveCeiling = normalizeAutoApproveTier(
    options?.autoApprove ?? pluginContext?.workflowAutoApproveCeiling,
  ) || false;
  const hardConcurrencyLimit = hardConcurrencyLimitForContext(pluginContext);
  // Trusted extension seam: opencode delivers per-plugin `options` as the factory's second arg
  // (the [path, {options}] tuple form in opencode.json). One registry per pluginContext — factories
  // are double-instantiated, so a per-instance registry avoids duplicate-name throws. Extension
  // modules are TRUSTED host code, loaded only from explicit config (never auto-discovered).
  const extensionRegistry = createExtensionRegistry();
  pluginContext.workflowExtensionRegistry = extensionRegistry;
  const extensionPaths = Array.isArray(options?.extensions) ? options.extensions : [];
  // Load extensions in the factory body (the factory is async and opencode awaits it) so the static
  // `tool` map returned below can include extension-contributed tools. Fail loud: a configured-but-
  // unloadable extension rejects the factory promise rather than silently disabling itself.
  if (extensionPaths.length) {
    await extensionRegistry.loadExtensions(extensionPaths, { configDir: resolveOpencodeConfigDir() });
  }
  const hooks = {
    config: async (cfg) => {
      configureWorkflowPermissions(cfg);
      await configureWorkflowEntrypoints(cfg, pluginContext.workflowExtensionRegistry?.assetDirs());
    },
    event: async ({ event }) => {
      // The event hook is fire-and-forget: opencode does not await it, and a throw (or rejected
      // promise) can destabilize the session or silence later events (AGENTS.md non-negotiable
      // invariant). deliverWorkflowNotifications touches the filesystem (readdir/readFile), which
      // can reject with EPERM/EACCES/EIO, so guard the whole body and swallow any failure here.
      try {
        updateNotificationIdleState(event);
        await deliverWorkflowNotifications(pluginContext, event);
      } catch {
        // Notification delivery is best effort; persisted state on disk remains authoritative.
      }
    },
    dispose: async () => {
      clearNotificationRuntimeState();
    },
    "chat.params": async (input, output) => {
      applyLaneEffortParams(input, output);
    },
    tool: {
    workflow_run: tool({
      description:
        "Run a sandboxed OpenCode workflow. By default this is two-phase: call WITHOUT approve=true to get the plan summary (use format=json for a structured workflow_preview with approvalHash, models, lane budget, authority, and cost), then call WITH approve=true and the matching approvalHash to execute; missing/stale hashes return approval_mismatch with executed=false. If the plugin is configured with options.autoApprove, an eligible call may launch immediately without approvalHash when the resolved authority tier is covered by the configured ceiling; args.autoApprove can only narrow that configured ceiling for one call. workflow_apply remains independently hash-gated.",
      args: {
        name: tool.schema.string().optional(),
        scriptPath: tool.schema.string().optional(),
        allowExternalScriptPath: tool.schema.boolean().optional(),
        source: tool.schema.string().optional(),
        includeSourceSnippet: tool.schema.boolean().optional(),
        sourceSnippetMaxChars: tool.schema.number().int().positive().max(2000).optional(),
        args: tool.schema.any().optional(),
        approve: tool.schema.boolean().optional(),
        approvalHash: tool.schema.string().optional(),
        autoApprove: tool.schema.enum(["readOnly", "worktree", "all"]).optional(),
        format: tool.schema.enum(["summary", "json"]).optional(),
        resumeRunId: tool.schema.string().optional(),
        resumePolicy: tool.schema.enum(["extend-deadline"]).optional(),
        editAndResume: tool.schema.boolean().optional(),
        maxAgents: tool.schema.number().int().positive().max(100000).optional(),
        concurrency: tool.schema.number().int().positive().max(hardConcurrencyLimit).optional(),
        laneTimeoutMs: tool.schema.number().int().positive().max(MAX_CHILD_PROMPT_TIMEOUT_MS).optional(),
        childPromptTimeoutMs: tool.schema.number().int().positive().max(MAX_CHILD_PROMPT_TIMEOUT_MS).optional(),
        childModel: tool.schema.string().optional(),
        modelTiers: tool.schema.object({
          fast: tool.schema.string().optional(),
          deep: tool.schema.string().optional(),
        }).optional(),
        profile: tool.schema.enum(Object.keys(WORKFLOW_AUTHORITY_PROFILES)).optional(),
        background: tool.schema.boolean().optional(),
        debugCapture: tool.schema.boolean().optional(),
        authority: tool.schema.any().optional(),
        baseCommit: tool.schema.string().optional(),
        maxCost: tool.schema.number().nonnegative().optional(),
        maxTokens: tool.schema.number().int().nonnegative().optional(),
        guestDeadlineMs: tool.schema.number().int().positive().max(60_000).optional(),
        maxRuntimeMs: tool.schema.number().int().positive().max(24 * 60 * 60 * 1000).optional(),
      },
      async execute(args, context) {
        return await startWorkflow(pluginContext, context, args);
      },
    }),
    workflow_status: tool({
      description: "Show recent workflow runs or one workflow run state.",
      args: {
        runId: tool.schema.string().optional(),
        limit: tool.schema.number().int().positive().max(100).optional(),
        includePendingApproval: tool.schema.boolean().optional(),
        format: tool.schema.enum(["summary", "json"]).optional(),
        detail: tool.schema.enum(["compact", "full", "result"]).optional(),
        reconcile: tool.schema.boolean().optional(),
      },
      async execute(args, context) {
        return await statusText(context, args);
      },
    }),
    workflow_events: tool({
      description: "Read a workflow run's redacted lifecycle events with type-prefix filtering and offset pagination.",
      args: {
        runId: tool.schema.string(),
        typePrefix: tool.schema.string().optional(),
        sinceTimestamp: tool.schema.string().optional(),
        beforeTimestamp: tool.schema.string().optional(),
        offset: tool.schema.number().int().nonnegative().optional(),
        limit: tool.schema.number().int().positive().max(500).optional(),
        order: tool.schema.enum(["newest", "oldest"]).optional(),
        format: tool.schema.enum(["json", "summary"]).optional(),
      },
      async execute(args, context) {
        return await eventsText(context, args);
      },
    }),
    workflow_reconcile: tool({
      description: "Persist recovery state for stale workflow runs and clear stale workflow locks.",
      args: {
        runId: tool.schema.string().optional(),
        limit: tool.schema.number().int().positive().max(100).optional(),
        includePendingApproval: tool.schema.boolean().optional(),
        format: tool.schema.enum(["summary", "json"]).optional(),
        detail: tool.schema.enum(["compact", "full", "result"]).optional(),
      },
      async execute(args, context) {
        return await reconcileRuns(context, args);
      },
    }),
    workflow_cancel: tool({
      description: "Cancel an active workflow run and abort its child OpenCode sessions best-effort.",
      args: {
        runId: tool.schema.string(),
      },
      async execute(args, context) {
        return await cancelRun(pluginContext, context, args);
      },
    }),
    workflow_pause: tool({
      description: "Pause an active workflow run, abort active child sessions best-effort, and preserve durable state for resume.",
      args: {
        runId: tool.schema.string(),
      },
      async execute(args, context) {
        return await pauseRun(pluginContext, context, args);
      },
    }),
    workflow_kill: tool({
      description: "Force-terminate a wedged workflow run immediately: abort it, release its locks without waiting on cooperative settle, and leave it in a resumable (interrupted) state. Use when workflow_cancel/workflow_pause do not return because a lane is stuck.",
      args: {
        runId: tool.schema.string(),
      },
      async execute(args, context) {
        return await killRun(pluginContext, context, args);
      },
    }),
    workflow_save: tool({
      description: "Save a reusable workflow script to the project workflow directory by default, or globally with an explicit globalScopeIntent opt-in.",
      args: {
        name: tool.schema.string(),
        source: tool.schema.string(),
        scope: tool.schema.enum(["global", "project"]).optional(),
        globalScopeIntent: tool.schema.literal("save-global-workflow").optional(),
        overwrite: tool.schema.boolean().optional(),
      },
      async execute(args, context) {
        return await saveWorkflow(context, args);
      },
    }),
    workflow_list: tool({
      description: "List saved project and global workflows without running them.",
      args: {
        format: tool.schema.enum(["summary", "json"]).optional(),
      },
      async execute(args, context) {
        // Surface the invoking session's model as the display default for workflows that declare no
        // model (the child default is the session model at run time). Read-only and best-effort:
        // readActiveSessionModel never throws and never prompts a model.
        const sessionModel = await readActiveSessionModel(pluginContext, context);
        return await listWorkflows(
          context,
          args,
          sessionModel.model,
          pluginContext.workflowExtensionRegistry?.assetDirs()?.workflows ?? [],
        );
      },
    }),
    workflow_cleanup: tool({
      description: "Dry-run or apply workflow run retention cleanup while preserving active, corrupt, and ambiguous edit runs.",
      args: {
        dryRun: tool.schema.boolean().optional().describe("When true or omitted, only previews which completed run dirs would be removed. Set false to delete eligible old runs."),
        keep: tool.schema.number().int().min(0).max(1000).optional().describe("Number of newest completed terminal runs to preserve; active, corrupt, ambiguous edit, and pinned runs are always preserved."),
      },
      async execute(args, context) {
        return await cleanupRuns(context, args);
      },
    }),
    workflow_apply: tool({
      description: "Apply an awaiting workflow diff plan to the primary tree after explicit hash-gated approval. Use hash fields copied from a prior workflow_status({detail:\"full\"}) or workflow_run apply-preview for the same run; stale or missing hashes fail closed with a structured workflow_apply_approval_mismatch payload.",
      args: {
        runId: tool.schema.string().describe("Run id currently in awaiting-diff-approval, apply-failed, failed-with-diff-plan, applied, or an interrupted recovery state."),
        approvedSourceHash: tool.schema.string().describe("Exact sourceHash copied from workflow_status detail:\"full\" for this run; proves the workflow source that produced the diff plan."),
        baseCommit: tool.schema.string().describe("Exact editPlan.baseCommit from workflow_status detail:\"full\"; primary HEAD must still match before patch writes."),
        diffPlanHash: tool.schema.string().describe("Exact editPlan.diffPlanHash from workflow_status detail:\"full\"; covers the normalized patch plan and staged domain manifest."),
        domainMutationHash: tool.schema.string().describe("Exact editPlan.domainMutationHash from workflow_status detail:\"full\"; fails if staged domain mutations changed after diff approval."),
        approvalIntent: tool.schema.literal("apply").describe("Must be the literal string \"apply\" to show this call is an explicit apply approval."),
      },
      async execute(args, context) {
        return await applyWorkflow(pluginContext, context, args);
      },
    }),
    workflow_salvage: tool({
      description: "Recover orphaned read-only lane results from persisted child transcripts into tagged synthetic journal entries, behind an explicit preview/approve gate.",
      args: {
        runId: tool.schema.string().describe("Interrupted or stale-active run id whose lane checkpoints should be inspected for salvage candidates."),
        callIds: tool.schema.array(tool.schema.string()).optional().describe("Optional subset of candidate lane callIds to salvage; omitted means preview or approve all eligible candidates."),
        approve: tool.schema.boolean().optional().describe("Omit or false to preview candidates and approvalHash; true writes tagged synthetic journal entries when the hash matches."),
        approvalHash: tool.schema.string().optional().describe("Approval hash returned by a prior salvage preview for the same run and candidate set. Required when approve is true."),
      },
      async execute(args, context) {
        return await salvageRun(pluginContext, context, args);
      },
    }),
    workflow_roles: tool({
      description: "List workflow specialist role prompts, hash provenance, and typed roles.json defaults.",
      args: {
        format: tool.schema.enum(["summary", "json"]).optional(),
      },
      async execute(args) {
        return await listRoles(args, { roleDir: pluginContext?.__workflowRoleDir });
      },
    }),
    workflow_models: tool({
      description: "List the invoking session's model and all available/authenticated providers and models, with a no-deviation fast/deep suggestion. Read-only; no run is started.",
      args: {
        format: tool.schema.enum(["summary", "json"]).optional(),
      },
      async execute(args, context) {
        const models = await buildWorkflowModels(pluginContext, context);
        if (args.format === "json") return JSON.stringify(models);
        const lines = [
          `Session model: ${models.session.model ?? "unknown"} (source: ${models.session.source})`,
          `Suggested: fast=${models.suggested.fast ?? "?"} deep=${models.suggested.deep ?? "?"}`,
          "Providers:",
          ...models.providers.map((p) => `  ${p.id} [${p.source}] -> ${p.models.map((m) => m.id).join(", ")}`),
        ];
        return lines.join("\n");
      },
    }),
    workflow_templates: tool({
      description: "List shipped v2 workflow templates without writing files; pass includeSource=true to retrieve source bodies explicitly.",
      args: {
        format: tool.schema.enum(["summary", "json"]).optional(),
        template: tool.schema.string().optional(),
        includeSource: tool.schema.boolean().optional(),
      },
      async execute(args, context) {
        return await listTemplates(args);
      },
    }),
    workflow_template_save: tool({
      description: "Save a shipped v2 workflow template to project or global workflows.",
      args: {
        template: tool.schema.string().describe("Bundled template name from workflow_templates, for example first-run-slice or scoped-parallel."),
        name: tool.schema.string().optional().describe("Saved workflow slug; omitted uses the template name."),
        scope: tool.schema.enum(["global", "project"]).optional().describe("Destination workflow directory; omitted defaults to project for template saves."),
        globalScopeIntent: tool.schema.literal("save-global-workflow").optional().describe("Required only with scope:\"global\" to confirm this writes into the shared global workflow directory."),
        overwrite: tool.schema.boolean().optional().describe("Set true to replace an existing saved workflow with the same name."),
      },
      async execute(args, context) {
        return await saveTemplate(context, args);
      },
    }),
    workflow_live_gates: tool({
      description: "Report workflow v2 live-gate capability status for the active runtime.",
      args: {
        format: tool.schema.enum(["summary", "json"]).optional(),
        probePermissionEnforcement: tool.schema.boolean().optional(),
        probeDeniedBash: tool.schema.boolean().optional(),
        probeCommandScopedBash: tool.schema.boolean().optional(),
        probeSecretReadDeny: tool.schema.boolean().optional(),
        probeStructuredOutput: tool.schema.boolean().optional(),
        probeWorktreeApi: tool.schema.boolean().optional(),
        probeDirectoryRooting: tool.schema.boolean().optional(),
        probeWorktreeEditIsolation: tool.schema.boolean().optional(),
        probeIntegrationWorktreeIsolation: tool.schema.boolean().optional(),
        probeBackgroundContinuation: tool.schema.boolean().optional(),
        probeConcurrencyCapacity: tool.schema.boolean().optional(),
        concurrencyProbeLimit: tool.schema.number().int().positive().max(hardConcurrencyLimit).optional(),
        probeCancellation: tool.schema.boolean().optional(),
        probeWorkflowNotification: tool.schema.boolean().optional(),
        probeNetworkAccess: tool.schema.boolean().optional(),
        probeMcpAccess: tool.schema.boolean().optional(),
        resetProbeCache: tool.schema.boolean().optional(),
        resetProbeCacheScope: tool.schema.enum(["runtime", "all"]).optional(),
        approvalIntent: tool.schema.literal("probe").optional(),
      },
      async execute(args, context) {
        assertLiveGateProbeAllowed(context, args);
        if (args.resetProbeCache === true) {
          invalidateWorkflowProviderListCache(args.resetProbeCacheScope === "all" ? "all" : pluginContext);
        }
        return await liveGateReport(pluginContext, context, args);
      },
    }),
    // review_materialize is contributed by the beads extension (workflow-domains/beads/beads-extension.js
    // `tools` factory); the core kernel ships no beads-specific tool.
  },
  };
  // Merge extension-contributed tools into the static tool map (Stage 4). toolKit injects the kernel's
  // single @opencode-ai/plugin `tool`/`schema` (one zod instance) plus pluginContext + the write guard,
  // so an extension needs no @opencode-ai/plugin dependency of its own. Core tool names are reserved
  // (fail-closed): an extension may only contribute NET-NEW tool names.
  const toolKit = { tool, schema: tool.schema, assertWriteWorkflowAllowed, pluginContext };
  Object.assign(hooks.tool, extensionRegistry.tools(toolKit, Object.keys(hooks.tool)));
  return hooks;
}

WorkflowPlugin.__test = {
  acquireAgentSlot,
  releaseAgentSlot,
  configureWorkflowEntrypoints,
  isTrustedAutoApplySource,
  shouldAutoApplyDrain,
  normalizePatches,
  planWorkflowEnvelope,
  assertWorkflowArgsMatchSchema,
  readActiveSessionModel,
  buildWorkflowModels,
  hardConcurrencyLimitForContext,
  normalizeWorkflowToastAscii,
  workflowProviderListCache,
  workflowProviderListCacheKey,
  WORKFLOW_PROVIDER_LIST_TTL_MS,
  invalidateWorkflowProviderListCache,
  salvageRun,
  extractFinalAssistantText,
  tryParseJson,
  computeSalvageApprovalHash,
  salvageApprovalPayload,
  classifyResumeCacheHit,
  checkpointHitForSignature,
  isLaneIntegrable,
  backgroundRecommendation,
  assertResumableState,
};

export {
  acquireAgentSlot,
  addEditPlanFromResult,
  applyWorkflow,
  approvalSummary,
  assertGitCleanAtBase,
  cleanupWorktrees,
  configureWorkflowEntrypoints,
  createEditWorktree,
  executeSandbox,
  gitHead,
  gitOutput,
  gitPathTracked,
  isRunAborted,
  normalizePatches,
  planWorkflowEnvelope,
  releaseAgentSlot,
  rollbackPatches,
  runChildAgent,
  runNestedWorkflow,
  runWorkflowExecution,
  salvageRun,
  startWorkflow,
  throwIfAborted,
  validatePatchTargets,
};

export default WorkflowPlugin;
