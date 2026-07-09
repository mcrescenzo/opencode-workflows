// Concern (5): status formatting for external consumption. Reads a run's durable state.json
// (reconciling stale-active/interrupted status on the way), then projects it into compact /
// full / result status shapes, summarizes run lists, and serves the workflow_status /
// workflow_reconcile / workflow_cleanup tool surfaces. Extracted from run-store-status.js
// (opencode-workflows-nbp).
//
// This concern is read-mostly: it reads the persisted state snapshot plus lock/lifecycle/
// salvage projections and the in-memory `runs` registry, and (in the reconcile/cleanup paths)
// rewrites state.json/closeout.json and deletes eligible run dirs. See
// {@link import("./run-context.js").RunContext}.

import fs from "node:fs/promises";
import path from "node:path";
import {
  ACTIVE_STATUSES,
  AMBIGUOUS_EDIT_STATUSES,
  DEFAULT_CHILD_PROMPT_TIMEOUT_MS,
  DEFAULT_KEEP_RUNS,
  DEFAULT_WORKFLOW_EVENTS_LIMIT,
  DURABLE_STATE_VERSION,
  LANE_OUTCOMES,
  MAX_WORKFLOW_EVENTS_LIMIT,
  MAX_RESULT_READ_FILE_BYTES,
  MAX_STATUS_STRING_CHARS,
} from "./constants.js";
import { extractTextFromError, redactValue, summarizeArgsSchema, truncateText } from "./text-json.js";
import { redactFreeTextSecrets } from "./free-text-redactor.js";
import { resultReadbackProjection } from "./result-readback.js";
import { encodeApplyBundle } from "./approval-hashing.js";
import { WorkflowAuthorityError } from "./errors.js";
import { addTokens, zeroTokens } from "./budget-accounting.js";
import { AD_HOC_AUTHORITY_PROFILE, assertWriteWorkflowAllowed } from "./authority-policy.js";
import {
  assertContainedRealPath,
  assertContainedRunDir,
  assertSafeRunId,
  pathExists,
  processAppearsAlive,
  readJsonFile,
  runDirForRoot,
  runRoots,
  runs,
  writeJsonAtomic,
} from "./run-store-fs.js";
import {
  acquireWorkflowLock,
  cleanupLockPath,
  clearStaleRunLocks,
  readLifecycleRequests,
  runLocksForEntry,
} from "./run-store-locks.js";
import { attachSalvageCandidates, recoverySummary } from "./run-store-projections.js";
import { computeLastProgressAt } from "./run-store-state.js";
import { createWorktreeAdapter } from "./worktree-adapter.js";

async function readRunEntry(root, id, options = {}) {
  const dir = runDirForRoot(root, id);
  const statePath = path.join(dir, "state.json");
  const base = { id, root, dir };
  try {
    await assertContainedRunDir(root, dir);
    const raw = await fs.readFile(statePath, "utf8");
    const state = JSON.parse(raw);
    const runId = typeof state.id === "string" ? state.id : id;
    const entryBase = { ...base, id: runId, status: state.status ?? "partial", kind: "valid", state };
    const staleLocksCleared = options.clearStaleLocks === true ? await clearStaleRunLocks(entryBase) : [];
    const locks = await runLocksForEntry(entryBase);
    const lifecycleRequests = await readLifecycleRequests(dir);
    if (Object.keys(locks).length > 0) state.locks = locks;
    if (Object.keys(lifecycleRequests).length > 0) state.lifecycleRequests = lifecycleRequests;
    if (staleLocksCleared.length > 0) state.staleLocksCleared = staleLocksCleared;
    if (ACTIVE_STATUSES.has(state.status) && !runs.has(runId)) {
      if (await processAppearsAlive(state.process)) {
        state.status = "active-unknown";
        state.error = state.error ?? "Workflow appears active in another OpenCode process";
        return { ...base, id: runId, status: state.status, kind: "valid", state };
      }
      if (options.reconcile !== true) {
        state.status = "stale-active";
        state.error = state.error ?? "Workflow appears stale; run workflow_reconcile to persist interrupted state";
        return await attachSalvageCandidates({ ...base, id: runId, status: state.status, kind: "valid", state });
      }
      state.status = "interrupted";
      state.finishedAt = state.finishedAt ?? new Date().toISOString();
      state.error = state.error ?? "Workflow was active when no owning OpenCode process was found";
      state.recovery = await recoverySummary(dir, state);
      state.durability = {
        ...(state.durability ?? {}),
        stateVersion: state.stateVersion ?? DURABLE_STATE_VERSION,
        ledgers: state.recovery.ledgers,
        recovery: state.recovery,
      };
      try {
        await writeJsonAtomic(statePath, state);
        await writeJsonAtomic(path.join(dir, "closeout.json"), {
          runId,
          status: state.status,
          finishedAt: state.finishedAt,
          errorSummary: state.error,
          durability: state.durability,
        });
      } catch {
        // Status should still report the reconciliation even if persisting it fails.
      }
    }
    return await attachSalvageCandidates({ ...base, id: runId, status: state.status ?? "partial", kind: "valid", state });
  } catch (error) {
    if (error.code === "ENOENT") return { ...base, status: "partial", kind: "partial", error: "Missing state.json" };
    return { ...base, status: "corrupt", kind: "corrupt", error: extractTextFromError(error) };
  }
}

// Bounded operator next-step hints (opencode-workflows-ux.4). Derived purely from the run's
// status, a few safe booleans (presence of a result file / salvage candidates / apply hashes),
// bounded lane failure classes, and the already-validated run id. These strings intentionally
// NEVER interpolate prompts, tool output, raw lane results, meta, error text, or filesystem paths,
// so they cannot leak run evidence or secrets: they are static recommended-command templates.
// The redaction/bounds coverage (opencode-workflows-ux.6) governs the evidence fields;
// nextActions adds none.
const MAX_NEXT_ACTIONS = 5;
const MAX_DIAGNOSTIC_ITEMS = 50;

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function hasApplyableDiffPlan(state) {
  const plan = state?.editPlan;
  if (!plan || typeof plan !== "object") return false;
  if (!nonEmptyString(state.sourceHash)) return false;
  if (!nonEmptyString(plan.baseCommit)) return false;
  if (!nonEmptyString(plan.diffPlanHash)) return false;
  if (!nonEmptyString(plan.domainMutationHash)) return false;
  const patchCount = Number.isFinite(plan.patchCount)
    ? plan.patchCount
    : Array.isArray(plan.patches)
      ? plan.patches.length
      : null;
  return patchCount === null || patchCount > 0;
}

const STRUCTURED_LANE_FAILURE_PATTERN = /\b(structured|schema|json(?:\s+parse)?|OutputFormatJsonSchema)\b/i;

function failedRunRecoveryForState(state) {
  const failures = laneFailureSummaries(state);
  if (failures.length === 0) return { kind: "unknown", retryable: true };
  const retryableFailures = failures.filter((failure) => failure.retryable === true || failure.failureClass === "transient" || failure.failureClass === "transient_exhausted");
  const terminalFailures = failures.filter((failure) => failure.retryable === false || failure.failureClass === "terminal");
  const terminalStructured = terminalFailures.some((failure) => STRUCTURED_LANE_FAILURE_PATTERN.test(failure.errorSummary ?? ""));
  if (terminalStructured) return { kind: "terminal-structured-output", retryable: false };
  if (terminalFailures.length > 0 && retryableFailures.length === 0) return { kind: "terminal-lane", retryable: false };
  if (terminalFailures.length > 0 && retryableFailures.length > 0) return { kind: "mixed-lane", retryable: false };
  if (retryableFailures.length > 0) return { kind: "retryable-lane", retryable: true };
  return { kind: "unknown", retryable: true };
}

function boundedString(value) {
  if (value === undefined || value === null) return undefined;
  return truncateText(String(value), MAX_STATUS_STRING_CHARS);
}

function boundedPathRecords(paths = []) {
  return (Array.isArray(paths) ? paths : []).slice(0, MAX_DIAGNOSTIC_ITEMS).map((change) => ({
    path: boundedString(typeof change === "string" ? change : change?.path),
    status: boundedString(typeof change === "string" ? "M" : change?.status),
    supported: typeof change === "object" ? change.supported !== false : true,
  }));
}

function integrationDiagnosticsForState(state) {
  const result = state.integrationPlan?.integrationResult;
  if (!result || typeof result !== "object") return undefined;
  const lanes = Array.isArray(result.lanes) ? result.lanes : [];
  const conflicts = Array.isArray(result.conflicts) ? result.conflicts : [];
  const diagnostic = {
    status: boundedString(result.status),
    reason: boundedString(result.reason),
    culpritLane: boundedString(result.culpritLane),
    errorSummary: boundedString(result.error ?? result.validation?.error ?? result.validation?.reason),
    conflictCount: conflicts.length,
    conflicts: conflicts.slice(0, MAX_DIAGNOSTIC_ITEMS).map((conflict) => ({
      path: boundedString(conflict.path),
      lanes: (Array.isArray(conflict.lanes) ? conflict.lanes : []).slice(0, MAX_DIAGNOSTIC_ITEMS).map(boundedString),
    })),
    mergedLanes: (Array.isArray(result.mergedLanes) ? result.mergedLanes : []).slice(0, MAX_DIAGNOSTIC_ITEMS).map(boundedString),
    affectedLanes: lanes.slice(0, MAX_DIAGNOSTIC_ITEMS).map((lane) => ({
      callId: boundedString(lane.callId),
      branch: boundedString(lane.branch),
      paths: boundedPathRecords(lane.paths),
    })),
  };
  if (conflicts.length > MAX_DIAGNOSTIC_ITEMS) diagnostic.conflictsTruncated = conflicts.length - MAX_DIAGNOSTIC_ITEMS;
  if (lanes.length > MAX_DIAGNOSTIC_ITEMS) diagnostic.affectedLanesTruncated = lanes.length - MAX_DIAGNOSTIC_ITEMS;
  return diagnostic;
}

function redactedIntegrationPlan(state) {
  const plan = state.integrationPlan;
  if (!plan) return undefined;
  const result = plan.integrationResult && typeof plan.integrationResult === "object"
    ? { ...plan.integrationResult, patches: undefined }
    : plan.integrationResult;
  return redactValue({ ...plan, patches: undefined, integrationResult: result }, { maxString: MAX_STATUS_STRING_CHARS });
}

function nextActionsForEntry(entry) {
  if (entry.kind !== "valid") {
    const actions = entry.kind === "partial"
      ? [
          "Run is incomplete: state.json is missing or not yet written; inspect the run directory.",
          "workflow_cleanup dryRun=true — review whether this incomplete run is safe to prune.",
        ]
      : ["workflow_cleanup dryRun=true — review pruning this unreadable run; its state.json is corrupt."];
    return actions.slice(0, MAX_NEXT_ACTIONS);
  }
  const state = entry.state;
  const id = state.id;
  const status = state.status;
  const hasResult = Boolean(state.resultPath);
  const hasSalvage = Array.isArray(entry.salvageCandidates) && entry.salvageCandidates.length > 0;
  const actions = [];
  switch (status) {
    case "completed":
    case "applied":
    case "committed":
    case "integrated": {
      if (hasResult) actions.push(`workflow_status runId=${id} detail=result — read the redacted run result.`);
      actions.push(`workflow_status runId=${id} detail=full — review lane outcomes, usage, and diagnostics.`);
      break;
    }
    case "awaiting-diff-approval":
    case "failed-with-diff-plan": {
      actions.push(`workflow_status runId=${id} detail=full — review the proposed diff plan and its approval hashes.`);
      if (hasApplyableDiffPlan(state)) {
        actions.push(`workflow_apply runId=${id} approvalIntent=apply applyBundle=<applyBundle from detail=full> — apply after review (or the four individual hashes).`);
      } else {
        actions.push("No applyable diff plan hashes are present; inspect detail=full before choosing a recovery path.");
      }
      break;
    }
    case "review-required": {
      actions.push(`workflow_status runId=${id} detail=full — inspect review-required diagnostics before choosing a recovery path.`);
      actions.push("Review-required runs are not directly applyable; resolve the conflict or rerun with corrected workflow input.");
      break;
    }
    case "apply-failed": {
      actions.push(`workflow_status runId=${id} detail=full — inspect the apply failure and the staged diff plan.`);
      if (hasApplyableDiffPlan(state)) {
        actions.push(`workflow_apply runId=${id} approvalIntent=apply <hashes from detail=full> — retry apply after resolving the cause.`);
      } else {
        actions.push("No applyable diff plan hashes are present; inspect detail=full before retrying apply.");
      }
      break;
    }
    case "failed": {
      const recovery = failedRunRecoveryForState(state);
      actions.push(`workflow_status runId=${id} detail=full — inspect failure context (laneOutcomes, errorSummary, diagnostics).`);
      if (recovery.kind === "terminal-structured-output") {
        actions.push("Fix or inspect terminal structured-output/schema lane failures before rerunning; resume is not recommended.");
      } else if (recovery.kind === "terminal-lane") {
        actions.push("Fix terminal lane configuration or workflow source before rerunning; resume is not recommended.");
      } else if (recovery.kind === "mixed-lane") {
        actions.push("Fix terminal lane failures first; retryable lanes can resume only after the terminal cause is addressed.");
      } else {
        actions.push(`workflow_run resumeRunId=${id} — resume; completed lanes replay from cache at no new spend.`);
      }
      break;
    }
    case "timed-out": {
      const timeoutRecovery = timeoutResumeEligibilityForState(state);
      actions.push(`workflow_status runId=${id} detail=full — inspect timeout context (laneOutcomes, errorSummary, diagnostics).`);
      if (timeoutRecovery.eligible) {
        const nextDeadline = Number.isInteger(timeoutRecovery.requiredResumeArgs.maxRuntimeMsGreaterThan)
          ? `maxRuntimeMs>${timeoutRecovery.requiredResumeArgs.maxRuntimeMsGreaterThan}`
          : "maxRuntimeMs=<raised deadline>";
        actions.push(`workflow_run resumeRunId=${id} resumePolicy=extend-deadline ${nextDeadline} — resume eligible read-only timeout; completed lanes replay from cache.`);
      } else {
        actions.push(`Timed-out run is blocked from resume: ${timeoutRecovery.blockedReasons.slice(0, 3).join("; ") || "unknown reason"}.`);
      }
      break;
    }
    case "cancelled": {
      actions.push(`workflow_status runId=${id} detail=full — review what completed before cancellation.`);
      actions.push("Cancelled runs are non-resumable by design; start a fresh workflow_run if more work is needed.");
      break;
    }
    case "stale-active": {
      actions.push(`workflow_reconcile runId=${id} — persist interrupted recovery state and clear stale locks.`);
      break;
    }
    case "active-unknown": {
      actions.push("This run appears active in another OpenCode process; check that process before acting.");
      actions.push(`workflow_status runId=${id} detail=full — inspect last persisted progress.`);
      break;
    }
    case "interrupted":
    case "paused": {
      actions.push(`workflow_run resumeRunId=${id} — resume; completed lanes replay from cache at no new spend.`);
      break;
    }
    case "running":
    case "apply-running": {
      actions.push(`workflow_status runId=${id} detail=full — watch progress and lane activity.`);
      actions.push(`workflow_pause runId=${id} / workflow_cancel runId=${id} — pause (resumable) or cancel (abandon) the run.`);
      actions.push(`workflow_kill runId=${id} — force-terminate if a lane is wedged and cancel/pause do not return.`);
      break;
    }
    case "cancelling":
    case "pausing": {
      actions.push(`workflow_status runId=${id} detail=full — watch the run settle.`);
      actions.push(`workflow_kill runId=${id} — force-terminate if it does not settle because a lane is wedged.`);
      break;
    }
    case "pending-approval": {
      actions.push("Re-run workflow_run with approve=true and the matching approvalHash to launch this envelope.");
      break;
    }
    default: {
      actions.push(`workflow_status runId=${id} detail=full — inspect full run state.`);
      break;
    }
  }
  if (hasSalvage) {
    actions.push(`workflow_salvage runId=${id} — recover orphaned read-only lane results from child transcripts (preview first).`);
  }
  return actions.slice(0, MAX_NEXT_ACTIONS);
}

// No-progress staleness threshold (opencode-workflows-jbs3.8). An ACTIVE run whose lastProgressAt
// is older than this is reported `staleness.stale: true` in the COMPACT status so an agent can
// detect a wedged / no-heartbeat run from the default (compact) view alone — without pulling
// detail=full. Terminal / non-active runs are never "stale" (no further progress is expected), so
// `stale` is false for them regardless of age. The threshold is exported and echoed in the payload
// (staleness.thresholdMs) so the contract is self-documenting for the agent reading it.
const STALE_PROGRESS_THRESHOLD_MS = 10 * 60 * 1000;
// How long a permanently-unresumable interrupted run keeps its cleanup protection before
// it becomes eligible for reaping. Without this escape valve an interrupted run pins its
// run dir (and, via reconcile, its stranded worktree/branch) forever. Conservative default:
// a run idle this long is almost certainly never going to be salvaged. Overridable per call.
const INTERRUPTED_RUN_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function lastProgressAtForState(state) {
  if (typeof state.lastProgressAt === "string") return state.lastProgressAt;
  // Snapshots written before jbs3.8 (or by tests) lack the persisted field; derive it the same
  // way writeState does so the staleness signal still works on older / synthetic state.json.
  return computeLastProgressAt(state);
}

function stalenessSignal(state, lastProgressAt, now = Date.now()) {
  const parsed = lastProgressAt ? Date.parse(lastProgressAt) : Number.NaN;
  const ageMs = Number.isFinite(parsed) ? Math.max(0, now - parsed) : null;
  const active = ACTIVE_STATUSES.has(state.status);
  return {
    lastProgressAt: lastProgressAt ?? null,
    ageMs,
    thresholdMs: STALE_PROGRESS_THRESHOLD_MS,
    stale: active && ageMs !== null && ageMs > STALE_PROGRESS_THRESHOLD_MS,
  };
}

const LANE_FAILURE_OUTCOMES = new Set(["failure", "cancelled", "timeout", "budget_stopped"]);
const MAX_COMPACT_LANE_FAILURES = 25;
const ACTIVE_LANE_STATUSES = new Set(["worktree-created", "running", "committed"]);
const MAX_ACTIVE_LANES = 25;
const TIMEOUT_RETRYABLE_OUTCOMES = new Set(["timeout", "cancelled", "budget_stopped"]);
const WRITE_AUTHORITY_FLAGS = ["shell", "network", "mcp", "edit", "worktreeEdit", "integration"];

function activeLaneSummaries(state, now = Date.now()) {
  const records = Array.isArray(state.laneRecords) ? state.laneRecords : [];
  const active = [];
  for (const record of records) {
    if (!record || record.outcome || !ACTIVE_LANE_STATUSES.has(record.status)) continue;
    const startedAt = typeof record.startedAt === "string" ? record.startedAt : null;
    const lastActivityAt = record.lastActivityAt ?? record.updatedAt ?? record.completedAt ?? startedAt;
    const startedMs = startedAt ? Date.parse(startedAt) : Number.NaN;
    const activityMs = lastActivityAt ? Date.parse(lastActivityAt) : Number.NaN;
    active.push({
      callId: record.callId,
      status: record.status,
      title: record.title ? truncateText(redactFreeTextSecrets(record.title), 160) : null,
      taskSummary: record.taskSummary ? truncateText(redactFreeTextSecrets(record.taskSummary), 160) : null,
      childID: record.childID ?? null,
      role: record.role ?? null,
      model: record.model ?? null,
      startedAt,
      lastActivityAt: lastActivityAt ?? null,
      ageMs: Number.isFinite(startedMs) ? Math.max(0, now - startedMs) : null,
      idleMs: Number.isFinite(activityMs) ? Math.max(0, now - activityMs) : null,
      progressEmitted: Boolean(record.childID || (lastActivityAt && lastActivityAt !== startedAt)),
      ...(record.tokens ? { tokens: record.tokens } : {}),
    });
  }
  return active;
}

function ledgerSummaryRecordCount(state, key) {
  const summary = state?.durability?.ledgers?.[key];
  return Number.isFinite(summary?.records) ? summary.records : null;
}

function ledgerSummaryPhases(state, key) {
  const phases = state?.durability?.ledgers?.[key]?.phases;
  return phases && typeof phases === "object" && !Array.isArray(phases) ? phases : {};
}

function hasAnyPhase(phases, names) {
  return names.some((name) => Number.isFinite(phases[name]) && phases[name] > 0);
}

function preservedWorktreeReasons(state = {}) {
  const cleanup = state.worktreeCleanup;
  if (!cleanup || typeof cleanup !== "object" || Array.isArray(cleanup)) return [];
  const reasons = [];
  for (const [group, records] of Object.entries(cleanup)) {
    if (!Array.isArray(records)) continue;
    for (const record of records) {
      if (!record?.preserved) continue;
      const dirty = record.dirty === true || record.reason === "dirty";
      reasons.push(`preserved ${dirty ? "dirty " : ""}${group} worktree is present`);
    }
  }
  return reasons;
}

function timeoutResumeEligibilityForState(state = {}) {
  const blockedReasons = [];
  const records = Array.isArray(state.laneRecords) ? state.laneRecords : [];
  const completedLaneCount = records.filter((record) => record?.outcome === "success" || record?.status === "completed").length;
  const activeOrTimedOutLaneCount = records.filter((record) => {
    if (!record) return false;
    if (!record.outcome && ACTIVE_LANE_STATUSES.has(record.status)) return true;
    return record.outcome === "timeout" || record.outcome === "cancelled";
  }).length;
  const requiredResumeArgs = {
    resumePolicy: "extend-deadline",
    maxRuntimeMsGreaterThan: Number.isInteger(state.maxRuntimeMs) ? state.maxRuntimeMs : null,
  };

  if (state.status !== "timed-out") blockedReasons.push(`status is ${state.status ?? "unknown"}, not timed-out`);
  if (!Number.isInteger(state.maxRuntimeMs) || state.maxRuntimeMs <= 0) {
    blockedReasons.push("persisted maxRuntimeMs is missing, so a raised deadline cannot be proven");
  }

  const authority = state.authority && typeof state.authority === "object" ? state.authority : {};
  const hasWriteAuthority = WRITE_AUTHORITY_FLAGS.some((flag) => authority[flag] === true);
  if (authority.readOnly !== true || authority.mode !== "readOnly" || hasWriteAuthority) {
    blockedReasons.push("authority is not strictly read-only");
  }

  if (state.editPlan) {
    blockedReasons.push(state.editPlan.diffPlanHash || Number.isFinite(state.editPlan.patchCount) ? "diff plan is present" : "editPlan is present");
  }
  if (state.integrationPlan) {
    const partialIntegration = Array.isArray(state.integrationPlan.lanes) && state.integrationPlan.lanes.length > 0 && !state.integrationPlan.integrationResult;
    blockedReasons.push(partialIntegration ? "partial integration plan is present" : "integrationPlan is present");
  }
  if (Array.isArray(state.editWorktrees) && state.editWorktrees.length > 0) blockedReasons.push("edit worktrees are present");
  if (Array.isArray(state.integrationWorktrees) && state.integrationWorktrees.length > 0) blockedReasons.push("integration worktrees are present");
  blockedReasons.push(...preservedWorktreeReasons(state));

  const domainRecords = ledgerSummaryRecordCount(state, "domain-ledger");
  const applyRecords = ledgerSummaryRecordCount(state, "apply-ledger");
  if (domainRecords === null || applyRecords === null) {
    blockedReasons.push("durable ledger summary is missing");
  } else {
    if (domainRecords > 0) {
      const domainPhases = ledgerSummaryPhases(state, "domain-ledger");
      blockedReasons.push(hasAnyPhase(domainPhases, ["staged", "started", "executed"]) && !hasAnyPhase(domainPhases, ["completed", "failed"])
        ? "staged domain mutation ledger is present"
        : "domain mutation ledger is present");
    }
    if (applyRecords > 0) {
      const applyPhases = ledgerSummaryPhases(state, "apply-ledger");
      blockedReasons.push(hasAnyPhase(applyPhases, ["started", "before-write", "after-write"]) && !hasAnyPhase(applyPhases, ["completed", "failed"])
        ? "apply ledger is incomplete"
        : "apply ledger is present");
    }
  }

  const runLock = state.locks?.run;
  if (runLock) {
    const lockState = runLock.active ? "active" : runLock.stale ? "stale" : runLock.corrupt ? "corrupt" : runLock.unreadable ? "unreadable" : "present";
    blockedReasons.push(`run.lock is ${lockState}`);
  }

  for (const record of records) {
    if (!record) continue;
    if (record.outcome === "success") continue;
    if (!record.outcome && ACTIVE_LANE_STATUSES.has(record.status)) continue;
    if (TIMEOUT_RETRYABLE_OUTCOMES.has(record.outcome)) continue;
    if (record.outcome === "failure" && record.retryable !== false && record.failureClass !== "terminal") continue;
    blockedReasons.push(`lane ${record.callId ?? "unknown"} outcome is not safely retryable`);
  }

  return {
    eligible: blockedReasons.length === 0,
    blockedReasons,
    completedLaneCount,
    activeOrTimedOutLaneCount,
    requiredResumeArgs,
  };
}

// Trimmed per-lane failure summary promoted into the COMPACT status (opencode-workflows-jbs3.8) so
// an agent sees WHICH lane(s) failed and WHY at default detail — not only via detail=full's whole
// laneRecords array. Strictly allowlisted: callId/role/model identify the lane, outcome is the
// coarse LANE_OUTCOMES bucket, failureClass is the transient/transient_exhausted/terminal taxonomy
// (jbs3.2), and errorSummary was already redacted+bounded at projection-write time (re-bounded here
// defensively). It NEVER includes title/taskSummary/raw result, so it cannot leak prompts or lane
// output, and it is capped so a fan-out with hundreds of failed lanes cannot bloat the compact view.
function laneFailureSummaries(state) {
  const records = Array.isArray(state.laneRecords) ? state.laneRecords : [];
  const failures = [];
  for (const record of records) {
    if (!record || !LANE_FAILURE_OUTCOMES.has(record.outcome)) continue;
    failures.push({
      callId: record.callId,
      role: record.role ?? null,
      model: record.model ?? null,
      outcome: record.outcome,
      failureClass: record.failureClass ?? null,
      retryable: record.retryable ?? null,
      errorSummary: record.errorSummary ? truncateText(redactFreeTextSecrets(record.errorSummary), MAX_STATUS_STRING_CHARS) : null,
    });
  }
  return failures;
}

function durationMs(start, end) {
  const startMs = typeof start === "string" ? Date.parse(start) : Number.NaN;
  const endMs = typeof end === "string" ? Date.parse(end) : Number.NaN;
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return null;
  return Math.max(0, endMs - startMs);
}

function operatorMetricsForState(state = {}) {
  const approvalWait = state.approvalWait && typeof state.approvalWait === "object" ? state.approvalWait : {};
  return {
    firstResultAt: state.firstResultAt ?? state.operatorMetrics?.firstResultAt ?? null,
    timeToFirstResultMs: Number.isFinite(state.timeToFirstResultMs)
      ? state.timeToFirstResultMs
      : (Number.isFinite(state.operatorMetrics?.timeToFirstResultMs) ? state.operatorMetrics.timeToFirstResultMs : null),
    awaitingDiffApprovalAt: approvalWait.startedAt ?? state.operatorMetrics?.awaitingDiffApprovalAt ?? null,
    appliedAt: approvalWait.completedAt ?? state.operatorMetrics?.appliedAt ?? null,
    approvalWaitMs: Number.isFinite(approvalWait.durationMs)
      ? approvalWait.durationMs
      : (Number.isFinite(state.operatorMetrics?.approvalWaitMs) ? state.operatorMetrics.approvalWaitMs : null),
  };
}

// Compact/result status views carry an allowlisted meta projection. Status readbacks are
// polled repeatedly; the wholesale frontmatter dump (argsSchema, examples, notes) dominated
// their size. detail:"full" keeps the complete redacted meta for diagnostics.
function compactMetaProjection(meta) {
  const m = meta && typeof meta === "object" && !Array.isArray(meta) ? meta : {};
  const projected = {};
  for (const key of ["name", "description", "whenToUse", "category", "profile"]) {
    if (typeof m[key] === "string") projected[key] = truncateText(redactFreeTextSecrets(m[key]), MAX_STATUS_STRING_CHARS);
  }
  if (Array.isArray(m.phases)) projected.phases = redactValue(m.phases);
  if (Number.isInteger(m.maxAgents)) projected.maxAgents = m.maxAgents;
  if (Number.isInteger(m.concurrency)) projected.concurrency = m.concurrency;
  const argsSummary = summarizeArgsSchema(m.argsSchema);
  if (argsSummary) projected.argsSummary = argsSummary;
  return projected;
}

function compactStatusForEntry(entry) {
  if (entry.kind !== "valid") {
    return {
      id: entry.id,
      status: entry.status,
      errorSummary: truncateText(redactFreeTextSecrets(entry.error ?? ""), MAX_STATUS_STRING_CHARS),
      nextActions: nextActionsForEntry(entry),
    };
  }
  const state = entry.state;
  const effectiveAuthorityProfile = state.authority?.profile ?? AD_HOC_AUTHORITY_PROFILE;
  const compact = {
    id: state.id,
    status: state.status,
    meta: compactMetaProjection(state.meta),
    declaredProfile: declaredProfileForState(state),
    effectiveAuthorityProfile,
    startedAt: state.startedAt ?? null,
    finishedAt: state.finishedAt ?? null,
    currentPhase: state.currentPhase ?? null,
    agentsStarted: state.agentsStarted ?? 0,
    maxAgents: state.maxAgents ?? 0,
    concurrency: state.concurrency ?? 0,
    laneTimeoutMs: state.laneTimeoutMs ?? DEFAULT_CHILD_PROMPT_TIMEOUT_MS,
    maxRuntimeMs: state.maxRuntimeMs ?? null,
    activeAgents: state.activeAgents ?? 0,
    queuedAgents: state.queuedAgents ?? 0,
    tokens: state.tokens ?? zeroTokens(),
    replayedTokens: state.replayedTokens ?? zeroTokens(),
    cost: state.cost ?? 0,
    replayedCost: state.replayedCost ?? 0,
    ...(state.autoApproved ? { autoApproved: state.autoApproved } : {}),
    laneOutcomes: state.laneOutcomes ?? Object.fromEntries(LANE_OUTCOMES.map((outcome) => [outcome, 0])),
    droppedLaneCount: state.droppedLaneCount ?? 0,
    background: state.background === true,
    operatorMetrics: operatorMetricsForState(state),
    locks: state.locks,
    lifecycleRequests: state.lifecycleRequests,
    ...(state.resultPath ? { resultPath: state.resultPath } : {}),
    errorSummary: state.error ? truncateText(redactFreeTextSecrets(state.error), MAX_STATUS_STRING_CHARS) : null,
    nextActions: nextActionsForEntry(entry),
  };
  const lastProgressAt = lastProgressAtForState(state);
  compact.lastProgressAt = lastProgressAt;
  compact.staleness = stalenessSignal(state, lastProgressAt);
  const laneFailures = laneFailureSummaries(state);
  const activeLanes = activeLaneSummaries(state);
  if (activeLanes.length > 0) {
    compact.activeLanes = activeLanes.slice(0, MAX_ACTIVE_LANES);
    compact.activeLaneCount = activeLanes.length;
    if (activeLanes.length > MAX_ACTIVE_LANES) {
      compact.activeLanesTruncated = activeLanes.length - MAX_ACTIVE_LANES;
    }
  }
  if (laneFailures.length > 0) {
    compact.laneFailures = laneFailures.slice(0, MAX_COMPACT_LANE_FAILURES);
    if (laneFailures.length > MAX_COMPACT_LANE_FAILURES) {
      compact.laneFailuresTruncated = laneFailures.length - MAX_COMPACT_LANE_FAILURES;
    }
  }
  if (Array.isArray(entry.salvageCandidates) && entry.salvageCandidates.length > 0) {
    compact.salvageCandidates = entry.salvageCandidates;
  }
  if (state.status === "timed-out") compact.timeoutRecovery = timeoutResumeEligibilityForState(state);
  if (state.costTrackingUnreliable === true && Number.isFinite(state.budgetCeilings?.maxCost)) {
    compact.costTrackingWarning =
      "At least one lane reported tokens with cost=0 (provider did not report per-lane cost); the maxCost ceiling may not reliably bound this run — use maxTokens as a backstop.";
  }
  return compact;
}

function declaredProfileForState(state) { return state.meta?.profile ?? state.meta?.authorityProfile ?? state.meta?.authority?.profile ?? null; }

async function resultStatusForEntry(entry) {
  const resultStatus = compactStatusForEntry(entry);
  if (entry.kind !== "valid") return resultStatus;
  const resultPath = entry.state?.resultPath;
  resultStatus.resultPath = resultPath ?? null;
  if (!resultPath) return resultStatus;
  try {
    await assertContainedRealPath(entry.dir, resultPath, "Workflow result path");
    const stat = await fs.stat(resultPath);
    resultStatus.resultFileBytes = stat.size;
    if (stat.size > MAX_RESULT_READ_FILE_BYTES) {
      resultStatus.resultError = `Result file exceeds ${MAX_RESULT_READ_FILE_BYTES} byte readback ceiling`;
      return resultStatus;
    }
    Object.assign(resultStatus, resultReadbackProjection(JSON.parse(await fs.readFile(resultPath, "utf8"))));
  } catch (error) {
    resultStatus.resultError = truncateText(`Unable to read result file: ${extractTextFromError(error)}`, MAX_STATUS_STRING_CHARS);
  }
  return resultStatus;
}

function normalizeEventLimit(value) {
  if (Number.isInteger(value) && value > 0) return Math.min(value, MAX_WORKFLOW_EVENTS_LIMIT);
  return DEFAULT_WORKFLOW_EVENTS_LIMIT;
}

function normalizeEventOffset(value) {
  return Number.isInteger(value) && value >= 0 ? value : 0;
}

function eventTimestampInRange(event, { sinceTimestamp, beforeTimestamp } = {}) {
  const ts = typeof event?.ts === "string" ? Date.parse(event.ts) : Number.NaN;
  if (sinceTimestamp) {
    const since = Date.parse(sinceTimestamp);
    if (Number.isFinite(since) && Number.isFinite(ts) && ts < since) return false;
  }
  if (beforeTimestamp) {
    const before = Date.parse(beforeTimestamp);
    if (Number.isFinite(before) && Number.isFinite(ts) && ts >= before) return false;
  }
  return true;
}

function eventTypeMatches(event, typePrefix) {
  if (!typePrefix) return true;
  return typeof event?.type === "string" && event.type.startsWith(typePrefix);
}

async function readEventsFile(filePath) {
  const events = [];
  let invalidLineCount = 0;
  try {
    const content = await fs.readFile(filePath, "utf8");
    for (const line of content.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        events.push(JSON.parse(line));
      } catch {
        invalidLineCount += 1;
      }
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  return { events, invalidLineCount };
}

async function eventsForEntry(entry, args = {}) {
  if (entry.kind !== "valid") {
    return {
      runId: entry.id,
      status: entry.status,
      events: [],
      errorSummary: truncateText(redactFreeTextSecrets(entry.error ?? ""), MAX_STATUS_STRING_CHARS),
      totalEvents: 0,
      totalMatching: 0,
      returned: 0,
      invalidLineCount: 0,
      nextOffset: null,
    };
  }
  const limit = normalizeEventLimit(args.limit);
  const offset = normalizeEventOffset(args.offset);
  const order = args.order === "oldest" ? "oldest" : "newest";
  const { events, invalidLineCount } = await readEventsFile(path.join(entry.dir, "events.jsonl"));
  const matching = events
    .filter((event) => eventTypeMatches(event, args.typePrefix))
    .filter((event) => eventTimestampInRange(event, args));
  const ordered = order === "newest" ? [...matching].reverse() : matching;
  const page = ordered.slice(offset, offset + limit);
  return {
    runId: entry.id,
    status: entry.status,
    order,
    typePrefix: args.typePrefix ?? null,
    sinceTimestamp: args.sinceTimestamp ?? null,
    beforeTimestamp: args.beforeTimestamp ?? null,
    offset,
    limit,
    maxLimit: MAX_WORKFLOW_EVENTS_LIMIT,
    totalEvents: events.length,
    totalMatching: matching.length,
    returned: page.length,
    nextOffset: offset + page.length < ordered.length ? offset + page.length : null,
    invalidLineCount,
    events: redactValue(page, { maxString: MAX_STATUS_STRING_CHARS, maxArray: MAX_WORKFLOW_EVENTS_LIMIT }),
  };
}

async function eventsText(context, args = {}) {
  const runId = assertSafeRunId(String(args.runId ?? ""), "runId");
  const entries = [];
  for (const root of runRoots(context)) {
    const dir = runDirForRoot(root, runId);
    if (await pathExists(dir)) entries.push(await readRunEntry(root, runId));
  }
  if (entries.length === 0) throw new Error(`Workflow run not found: ${runId}`);
  const result = await eventsForEntry(entries[0], args);
  if (args.format === "summary") {
    const lines = [
      `Workflow ${result.runId} events (${result.returned}/${result.totalMatching}, order=${result.order}, offset=${result.offset}, limit=${result.limit})`,
      result.typePrefix ? `Filter: type starts with ${result.typePrefix}` : undefined,
      result.invalidLineCount > 0 ? `Skipped invalid/truncated lines: ${result.invalidLineCount}` : undefined,
      ...result.events.map((event) => `${event.ts ?? "-"} ${event.type ?? "event"}${event.callId ? ` callId=${event.callId}` : ""}`),
      result.nextOffset !== null ? `Next page: workflow_events({ runId: "${result.runId}", offset: ${result.nextOffset}, limit: ${result.limit} })` : undefined,
    ].filter(Boolean);
    return lines.join("\n");
  }
  return JSON.stringify(result, null, 2);
}

async function notificationStatusForEntry(entry, state) {
  const notificationPath = state.notification?.notificationPath ?? path.join(entry.dir, "notification.json");
  let notification;
  try {
    await assertContainedRealPath(entry.dir, notificationPath, "Workflow notification path");
    notification = await readJsonFile(notificationPath, undefined);
  } catch {
    // Missing or out-of-run notification file (e.g. tampered state.json redirecting the
    // read elsewhere): fall back to the persisted record rather than returning arbitrary contents.
    return state.notification;
  }
  const projected = notification ? redactValue(notification, { maxString: MAX_STATUS_STRING_CHARS }) : state.notification;
  if (projected && typeof projected === "object") {
    const lastAttemptAt = projected.delivery?.lastAttemptAt;
    const sentAt = projected.sentAt;
    projected.delivery = {
      ...(projected.delivery ?? {}),
      deliveryLatencyMs: durationMs(lastAttemptAt, sentAt),
      totalLatencyMs: durationMs(projected.createdAt, sentAt),
    };
  }
  return projected;
}

async function fullStatusForEntry(entry) {
  if (entry.kind !== "valid") return { id: entry.id, status: entry.status, root: entry.root, dir: entry.dir, error: truncateText(redactFreeTextSecrets(entry.error ?? ""), MAX_STATUS_STRING_CHARS), nextActions: nextActionsForEntry(entry) };
  const state = entry.state;
  const activeLanes = activeLaneSummaries(state);
  const effectiveAuthorityProfile = state.authority?.profile ?? AD_HOC_AUTHORITY_PROFILE;
  const tokens = state.tokens ?? zeroTokens();
  const replayedTokens = state.replayedTokens ?? zeroTokens();
  const cost = state.cost ?? 0;
  const replayedCost = state.replayedCost ?? 0;
  const integrationDiagnostics = integrationDiagnosticsForState(state);
  const redacted = {
    id: state.id,
    status: state.status,
    sourcePath: state.sourcePath,
    sourceHash: state.sourceHash,
    meta: redactValue(state.meta),
    declaredProfile: declaredProfileForState(state),
    effectiveAuthorityProfile,
    authority: state.authority,
    argsPreview: state.argsPreview,
    startedAt: state.startedAt,
    resumedAt: state.resumedAt,
    finishedAt: state.finishedAt,
    lastProgressAt: lastProgressAtForState(state),
    staleness: stalenessSignal(state, lastProgressAtForState(state)),
    lastEventAt: state.lastEventAt,
    lastEventType: state.lastEventType,
    currentPhase: state.currentPhase,
    agentsStarted: state.agentsStarted,
    maxAgents: state.maxAgents,
    concurrency: state.concurrency,
    laneTimeoutMs: state.laneTimeoutMs ?? DEFAULT_CHILD_PROMPT_TIMEOUT_MS,
    maxRuntimeMs: state.maxRuntimeMs ?? null,
    defaultChildModel: state.defaultChildModel,
    activeAgents: state.activeAgents,
    queuedAgents: state.queuedAgents,
    tokens,
    replayedTokens,
    cost,
    replayedCost,
    usage: {
      liveTokens: tokens,
      replayedTokens,
      totalTokens: addTokens(tokens, replayedTokens),
      liveCost: cost,
      replayedCost,
      totalCost: cost + replayedCost,
    },
    cacheStats: state.cacheStats,
    budgetCeilings: state.budgetCeilings,
    autoApproved: state.autoApproved,
    debugCapture: state.debugCapture,
    operatorMetrics: operatorMetricsForState(state),
    laneOutcomes: state.laneOutcomes,
    droppedLaneCount: state.droppedLaneCount,
    capabilities: state.capabilities,
    diagnostics: integrationDiagnostics ? { ...(state.diagnostics ?? {}), integration: integrationDiagnostics } : state.diagnostics,
    durability: state.durability,
    recovery: state.recovery,
    salvageCandidates: entry.salvageCandidates,
    activeLanes: activeLanes.slice(0, MAX_ACTIVE_LANES),
    activeLaneCount: activeLanes.length,
    ...(activeLanes.length > MAX_ACTIVE_LANES ? { activeLanesTruncated: activeLanes.length - MAX_ACTIVE_LANES } : {}),
    laneRecords: state.laneRecords,
    closeout: state.closeout,
    domainFinalization: state.domainFinalization,
    worktreeCleanup: state.worktreeCleanup,
    locks: state.locks,
    staleLocksCleared: state.staleLocksCleared,
    lifecycleRequests: state.lifecycleRequests,
    notification: await notificationStatusForEntry(entry, state),
    nestedSnapshots: state.nestedSnapshots,
    background: state.background,
    resultPath: state.resultPath,
    errorSummary: state.error ? truncateText(redactFreeTextSecrets(state.error), MAX_STATUS_STRING_CHARS) : undefined,
    timeoutRecovery: state.status === "timed-out" ? timeoutResumeEligibilityForState(state) : undefined,
    costTrackingWarning: state.costTrackingUnreliable === true && Number.isFinite(state.budgetCeilings?.maxCost)
      ? "At least one lane reported tokens with cost=0 (provider did not report per-lane cost); the maxCost ceiling may not reliably bound this run — use maxTokens as a backstop."
      : undefined,
    nextActions: nextActionsForEntry(entry),
    root: entry.root,
    dir: entry.dir,
  };
  if (state.editPlan) {
    redacted.editWorktrees = state.editWorktrees;
    redacted.editPlan = { ...state.editPlan, patches: undefined };
    // tfil.4: emit a single opaque applyBundle (encoded from the four review-binding hashes) so a
    // caller can workflow_apply with one field. Only present when the four hashes are all known.
    const bundleHashes = {
      approvedSourceHash: state.sourceHash,
      baseCommit: state.editPlan.baseCommit,
      diffPlanHash: state.editPlan.diffPlanHash,
      domainMutationHash: state.editPlan.domainMutationHash,
    };
    if (nonEmptyString(bundleHashes.approvedSourceHash) && nonEmptyString(bundleHashes.baseCommit)
      && nonEmptyString(bundleHashes.diffPlanHash) && nonEmptyString(bundleHashes.domainMutationHash)) {
      redacted.editPlan.applyBundle = encodeApplyBundle(bundleHashes);
    }
  }
  if (state.integrationPlan) {
    redacted.integrationWorktrees = state.integrationWorktrees;
    redacted.integrationPlan = redactedIntegrationPlan(state);
  }
  return redacted;
}

async function statusForEntry(entry, detail = "compact") {
  if (detail === "full") return await fullStatusForEntry(entry);
  if (detail === "result") return await resultStatusForEntry(entry);
  return compactStatusForEntry(entry);
}

async function listRunEntries(context, options = {}) {
  const entries = [];
  for (const root of runRoots(context)) {
    if (!(await pathExists(root))) continue;
    const dirents = await fs.readdir(root, { withFileTypes: true });
    for (const dirent of dirents) {
      if (!dirent.isDirectory() && !dirent.isSymbolicLink()) continue;
      try {
        entries.push(await readRunEntry(root, dirent.name, options));
      } catch (error) {
        entries.push({ id: dirent.name, root, dir: path.resolve(root, dirent.name), status: "malformed", kind: "corrupt", error: extractTextFromError(error) });
      }
    }
  }
  entries.sort((a, b) => {
    const aStarted = a.state?.startedAt ?? "";
    const bStarted = b.state?.startedAt ?? "";
    return String(bStarted).localeCompare(String(aStarted));
  });
  return entries;
}

function cleanupProtectionReason(entry, { now = Date.now(), interruptedTtlMs = INTERRUPTED_RUN_TTL_MS } = {}) {
  if (entry.kind !== "valid") return "corrupt-or-partial";
  const status = entry.state.status;
  if (Object.keys(entry.state.locks ?? {}).length > 0) return "locked";
  if (runs.has(entry.state.id)) return "active-in-process";
  if (entry.state.pinned === true) return "pinned";
  if (ACTIVE_STATUSES.has(status)) return "active-status";
  if (AMBIGUOUS_EDIT_STATUSES.has(status)) return "ambiguous-edit-status";
  if (status === "interrupted") {
    // Normally protected so a future process can salvage its completed-lane work. But a
    // permanently-unresumable interrupted run would otherwise pin its run dir forever, so
    // once it has been idle longer than the TTL we drop protection and let cleanup reap it.
    // Stay conservative: only release when we can PROVE it is old (a parseable, finite age
    // past the TTL); an unknown/unparseable last-progress timestamp keeps the protection.
    const lastProgressAt = lastProgressAtForState(entry.state);
    const parsed = lastProgressAt ? Date.parse(lastProgressAt) : Number.NaN;
    const ageMs = Number.isFinite(parsed) ? now - parsed : null;
    if (ageMs !== null && ageMs > interruptedTtlMs) return undefined;
    return "interrupted-recovery";
  }
  // A paused run is resumable: a concurrent OpenCode process can re-acquire its run dir
  // and run.lock at any time. It releases its run.lock and leaves the in-memory map while
  // paused, so neither the "locked" nor the "active-in-process" guard above catches it.
  // Deleting it mid-resume would destroy a live run, so protect it explicitly.
  if (status === "paused") return "paused-resumable";
  if (status === "failed" || status === "budget_stopped") return "resumable-run";
  if (status === "apply-failed") return "retryable-apply-failed";
  return undefined;
}

function summarizeEntries(entries) {
  if (entries.length === 0) return "No workflow runs found.";
  return entries.flatMap((entry) => {
    const nextLines = nextActionsForEntry(entry).map((action) => `  next: ${action}`);
    if (entry.kind !== "valid") return [`${entry.id} ${entry.status} ${entry.dir}: ${truncateText(redactFreeTextSecrets(entry.error ?? ""), 160)}`, ...nextLines];
    const state = entry.state;
    const outcomes = state.laneOutcomes ? Object.entries(state.laneOutcomes).map(([key, value]) => `${key}:${value}`).join(" ") : "outcomes:unknown";
    const cache = state.cacheStats ? `cache hit:${state.cacheStats.hits} miss:${state.cacheStats.misses} invalidated:${state.cacheStats.invalidated}` : "cache:unknown";
    const staleness = stalenessSignal(state, lastProgressAtForState(state));
    const line = [
      `${state.id} ${state.status}`,
      `effectiveProfile=${state.authority?.profile || AD_HOC_AUTHORITY_PROFILE}`,
      `phase=${state.currentPhase || "-"}`,
      `agents=${state.agentsStarted || 0}/${state.maxAgents || 0}`,
      `active=${state.activeAgents || 0}`,
      `dropped=${state.droppedLaneCount || 0}`,
      outcomes,
      cache,
      staleness.stale ? `STALE no-progress>${Math.round(staleness.ageMs / 1000)}s` : "",
      state.error ? `error=${truncateText(redactFreeTextSecrets(state.error), 160)}` : "",
    ].filter(Boolean).join(" ");
    // Name each failed lane + its error class in the human view so an operator sees WHICH lane
    // failed and WHY without expanding to detail=full — the text mirror of compact.laneFailures.
    const failureLines = laneFailureSummaries(state)
      .slice(0, MAX_COMPACT_LANE_FAILURES)
      .map((lane) => `  lane-failed ${lane.callId} [${lane.outcome}${lane.failureClass ? `/${lane.failureClass}` : ""}]${lane.role ? ` role=${lane.role}` : ""}${lane.errorSummary ? `: ${truncateText(redactFreeTextSecrets(lane.errorSummary), 160)}` : ""}`);
    const salvageLines = (entry.salvageCandidates ?? []).map((candidate) => `  salvage ${candidate.callId}: ${candidate.hint}`);
    return [line, ...failureLines, ...salvageLines, ...nextLines];
  }).join("\n");
}

async function statusText(context, args, optionsOverride = {}) {
  if (typeof args.runId === "string" && args.runId.trim() === "" && args.detail === "result") {
    throw new Error("workflow_status detail=result requires a concrete runId");
  }
  const runId = (typeof args.runId === "string" && args.runId.trim()) ? assertSafeRunId(args.runId.trim()) : undefined;
  const format = args.format || "summary";
  const detail = args.detail || "compact";
  if (!runId && detail === "result") throw new Error("workflow_status detail=result requires runId");
  if (args.reconcile === true && optionsOverride.allowReconcile !== true) {
    throw new WorkflowAuthorityError("workflow_status is read-only. For recovery, use workflow_reconcile.");
  }
  const reconcile = args.reconcile === true && optionsOverride.allowReconcile === true;
  const options = { reconcile, clearStaleLocks: reconcile };
  let entries;
  if (runId) {
    entries = [];
    for (const root of runRoots(context)) {
      const dir = runDirForRoot(root, runId);
      if (await pathExists(dir)) entries.push(await readRunEntry(root, runId, options));
    }
    if (entries.length === 0) throw new Error(`Workflow run not found: ${runId}`);
  } else {
    entries = await listRunEntries(context, options);
    if (args.includePendingApproval !== true) entries = entries.filter((entry) => entry.state?.status !== "pending-approval");
    entries = entries.slice(0, args.limit || 20);
  }
  // Crash-resource reclamation (opencode-workflows-jbs3.9): reconcile is the recovery pass that
  // confirms a dead run interrupted via PID-liveness. Once a run is confirmed interrupted, prune
  // the stranded git worktrees/branches it left behind so they do not accumulate unbounded across
  // autonomous-drain crashes. Read-only workflow_status never reaches this (reconcile is false).
  if (reconcile) await reclaimStrandedWorktrees(context, entries);
  const redacted = await Promise.all(entries.map((entry) => statusForEntry(entry, detail)));
  if (format === "json") return JSON.stringify(runId ? redacted[0] : redacted, null, 2);
  return summarizeEntries(entries);
}

// Best-effort reclamation of git worktrees/branches stranded by crashed runs. Only acts on runs
// confirmed interrupted (dead via PID-liveness in readRunEntry) that recorded worktrees. Builds a
// worktree adapter lazily — runs without worktree records (and non-git working dirs) never require
// a git repo. Conservative by construction: adapter.remove() refuses dirty/locked/main/out-of-root
// worktrees, so in-flight lane work is preserved, not destroyed. Successfully removed records are
// dropped from the persisted run so a later reconcile does not re-attempt them; preserved records
// (dirty/locked) are kept so a future reconcile can retry once they become clean.
async function reclaimStrandedWorktrees(context, entries) {
  const repoDir = context?.worktree || context?.directory;
  if (!repoDir) return;
  let adapter;
  for (const entry of entries) {
    if (entry.kind !== "valid" || entry.state?.status !== "interrupted") continue;
    const edit = Array.isArray(entry.state.editWorktrees) ? entry.state.editWorktrees : [];
    const integration = Array.isArray(entry.state.integrationWorktrees) ? entry.state.integrationWorktrees : [];
    if (edit.length === 0 && integration.length === 0) continue;
    if (adapter === undefined) {
      try { adapter = await createWorktreeAdapter({ directory: repoDir }); }
      catch { adapter = null; }
    }
    if (!adapter?.remove) continue;

    const reclaimed = [];
    const survivors = async (records) => {
      const kept = [];
      for (const record of records) {
        if (!record?.path) { kept.push(record); continue; }
        let summary;
        try {
          const result = await adapter.remove(record);
          summary = { role: record.role, callId: record.callId, laneId: record.laneId, path: result.path ?? record.path, branch: record.branch, removed: result.removed === true, preserved: result.preserved === true, reason: result.reason, branchDeleted: result.branchDeleted };
        } catch (error) {
          summary = { role: record.role, callId: record.callId, laneId: record.laneId, path: record.path, branch: record.branch, removed: false, preserved: true, reason: "reclaim-failed", error: truncateText(extractTextFromError(error), MAX_STATUS_STRING_CHARS) };
        }
        reclaimed.push(summary);
        if (!summary.removed) kept.push(record);
      }
      return kept;
    };

    const keptEdit = await survivors(edit);
    const keptIntegration = await survivors(integration);
    if (reclaimed.length === 0) continue;
    entry.state.editWorktrees = keptEdit;
    entry.state.integrationWorktrees = keptIntegration;
    entry.state.worktreeCleanup = {
      ...(entry.state.worktreeCleanup ?? {}),
      reclaimed: [...(entry.state.worktreeCleanup?.reclaimed ?? []), ...reclaimed],
    };
    try { await writeJsonAtomic(path.join(entry.dir, "state.json"), entry.state); } catch { /* best effort */ }
  }
}

async function reconcileRuns(context, args = {}) {
  assertWriteWorkflowAllowed(context, "workflow_reconcile");
  return await statusText(context, { ...args, reconcile: true }, { allowReconcile: true });
}

async function cleanupRuns(context, args = {}) {
  assertWriteWorkflowAllowed(context, "workflow_cleanup");
  const keep = Number.isInteger(args.keep) && args.keep >= 0 ? args.keep : DEFAULT_KEEP_RUNS;
  const dryRun = args.dryRun !== false;
  // Configurable interrupted-run TTL escape valve: any positive integer overrides the default.
  const interruptedTtlMs = Number.isInteger(args.interruptedTtlMs) && args.interruptedTtlMs > 0 ? args.interruptedTtlMs : INTERRUPTED_RUN_TTL_MS;
  // Snapshot "now" once so every protection decision in this pass uses a single clock.
  const now = Date.now();
  const protectionOpts = { now, interruptedTtlMs };
  const cleanupReleases = [];
  if (!dryRun) {
    for (const root of runRoots(context)) {
      if (await pathExists(root)) cleanupReleases.push(await acquireWorkflowLock(cleanupLockPath(root), { operation: "cleanup", root }));
    }
  }
  try {
    const entries = await listRunEntries(context, { reconcile: true });
    const deletable = [];
    let keptValid = 0;
    const protectedRuns = [];
    for (const entry of entries) {
      const reason = cleanupProtectionReason(entry, protectionOpts);
      if (reason) {
        protectedRuns.push({ id: entry.id, status: entry.status, dir: entry.dir, reason, ...(entry.state?.locks ? { locks: entry.state.locks } : {}), ...(entry.error ? { error: truncateText(redactFreeTextSecrets(entry.error), MAX_STATUS_STRING_CHARS) } : {}) });
        continue;
      }
      keptValid += 1;
      if (keptValid > keep) deletable.push(entry);
    }
    const protectedContainment = [];
    const protectedRevalidated = [];
    const deleted = [];
    if (!dryRun) {
      for (const entry of deletable) {
        try {
          await assertContainedRunDir(entry.root, entry.dir);
          // TOCTOU guard: cleanup.lock only serializes cleanup-vs-cleanup, not cleanup-vs-resume.
          // Between enumeration and this fs.rm a concurrent process can resume a paused/eligible
          // run — re-acquiring its run.lock and flipping status to running. Re-read the entry and
          // re-check protection immediately before delete; skip+report anything that became
          // protected (re-acquired a lock or changed status) so a live run is never deleted.
          const current = await readRunEntry(entry.root, entry.id, { reconcile: true });
          const reason = cleanupProtectionReason(current, protectionOpts);
          if (reason) {
            protectedRevalidated.push({ id: current.id, status: current.status, dir: current.dir, reason, ...(current.state?.locks ? { locks: current.state.locks } : {}) });
            continue;
          }
          await fs.rm(entry.dir, { recursive: true, force: true });
          deleted.push(entry);
        } catch (error) {
          protectedContainment.push({ id: entry.id, status: entry.status, dir: entry.dir, error: truncateText(extractTextFromError(error), MAX_STATUS_STRING_CHARS) });
        }
      }
    }
    const deletedDirs = dryRun ? deletable.map((entry) => entry.dir) : deleted.map((entry) => entry.dir);
    const payload = {
      dryRun,
      keep,
      deleteCount: deletedDirs.length,
      deleteDirs: deletedDirs,
      protectedRuns,
      protectedLocked: protectedRuns.filter((entry) => entry.reason === "locked"),
      protectedCorruptOrPartial: protectedRuns.filter((entry) => entry.reason === "corrupt-or-partial").map((entry) => ({ id: entry.id, status: entry.status, dir: entry.dir, error: entry.error })),
      protectedContainment,
      protectedRevalidated,
    };
    return JSON.stringify(payload, null, 2);
  } finally {
    for (const release of cleanupReleases.reverse()) await release();
  }
}

async function readRunById(context, runId) {
  assertSafeRunId(runId);
  for (const root of runRoots(context)) {
    const dir = runDirForRoot(root, runId);
    if (await pathExists(dir)) return await readRunEntry(root, runId);
  }
  throw new Error(`Workflow run not found: ${runId}`);
}

export {
  STALE_PROGRESS_THRESHOLD_MS,
  INTERRUPTED_RUN_TTL_MS,
  lastProgressAtForState,
  stalenessSignal,
  laneFailureSummaries,
  activeLaneSummaries,
  timeoutResumeEligibilityForState,
  readRunEntry,
  nextActionsForEntry,
  compactStatusForEntry,
  declaredProfileForState,
  resultStatusForEntry,
  eventsForEntry,
  eventsText,
  notificationStatusForEntry,
  fullStatusForEntry,
  statusForEntry,
  listRunEntries,
  cleanupProtectionReason,
  summarizeEntries,
  statusText,
  reconcileRuns,
  cleanupRuns,
  readRunById,
};
