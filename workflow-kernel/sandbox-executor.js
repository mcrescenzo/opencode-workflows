// sandbox-executor.js — the QuickJS sandbox + host-op dispatch boundary extracted from the
// workflow orchestrator (opencode-workflows-96b, stage 2 of the staged RunContext split).
//
// Owns executeSandbox (the deterministic QuickJS VM lifecycle, the workflow prelude, the
// guest-deadline arming, and the host bridge) plus the host-op dispatch surface it routes
// to: runNestedWorkflow, runHostDrain (and its drain lane/integration plumbing), and
// cancelFanoutSiblings. The "agent" op delegates to runChildAgent (child-agent-runner.js).
//
// Coupling surface: each entry takes the shared mutable {@link RunContext} `run`. A `deps`
// bundle injects the orchestrator-resident primitives this boundary and runChildAgent need
// (concurrency slots, abort/cancel guards, durable-lifecycle polling, dirty-worktree
// salvage, lane-timeout alias resolution) so this module imports only leaf kernel modules
// plus child-agent-runner.js, never workflow-plugin.js. Import graph stays acyclic:
// workflow-plugin.js -> sandbox-executor.js -> child-agent-runner.js.
//
// @typedef {import("./run-context.js").RunContext} RunContext

import path from "node:path";
import fs from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { newQuickJSAsyncWASMModule } from "quickjs-emscripten";
import { shouldInterruptAfterDeadline } from "quickjs-emscripten-core";
import { drain as runDrainRuntime } from "./drain-runtime.js";
import {
  DEFAULT_GUEST_DEADLINE_MS,
  HOST_CALL_MARGIN,
  HOST_CALLS_PER_MAX_AGENT,
  MAX_EVENT_MESSAGE_CHARS,
  MAX_HOST_CALLS,
  MAX_PENDING_JOB_DRAIN_ITERATIONS,
  MAX_STATUS_STRING_CHARS,
} from "./constants.js";
import { NON_DRY_DRAIN_REQUIRED_GATES } from "./authority-policy.js";
import {
  extractTextFromError,
  hash,
  jsonPreview,
  stableStringify,
  truncateText,
} from "./text-json.js";
import { WorkflowCancelledError } from "./errors.js";
import { assertResultSize } from "./structured-output.js";
import { abortChild, rejectWaitingAgents } from "./lifecycle-control.js";
import {
  compactLiveGateStatus,
  liveGateProbeArgsForNames,
  liveGateReport,
  nonVerifiedGateSummaries,
} from "./capability-adapter.js";
import { budgetSnapshot, checkBudgetBeforeLaunch } from "./budget-accounting.js";
import {
  appendEvent,
  appendIntegrationLedger,
  appendValidationLedger,
} from "./event-journal.js";
import { recordRecentLog } from "./run-observability.js";
import {
  safeProjectionName,
  ensurePrivateDir,
  writeFilePrivate,
  writeLaneProjection,
  writeState,
} from "./run-store-status.js";
import { maybeShowWorkflowProgressToast } from "./notification-toast.js";
import {
  parseWorkflowSource,
  resolveWorkflowSource,
} from "./workflow-source.js";
import { pathContains } from "./path-policy.js";
import {
  findIntegrationLane,
  runChildAgent,
} from "./child-agent-runner.js";

const MAX_FANOUT_DIAGNOSTICS = 50;

const PENDING_HOST_OP_SETTLE_TIMEOUT_MS = 1_000;

let sandboxHostOpTestHook;
let quickJSAsyncModulePromise;

function maxHostCallsForRun(run) {
  const maxAgents = Number.isInteger(run?.maxAgents) && run.maxAgents > 0 ? run.maxAgents : 0;
  return Math.max(MAX_HOST_CALLS, maxAgents * HOST_CALLS_PER_MAX_AGENT + HOST_CALL_MARGIN);
}

function quickJSAsyncModule() {
  if (!quickJSAsyncModulePromise) {
    // Memoize the load Promise so a successful WASM module is instantiated once and reused. But
    // guard the rejection path: if this first load fails (transient resource/memory pressure, a
    // filesystem hiccup loading the .wasm asset, a one-off emscripten instantiation failure), a
    // memoized rejected Promise would permanently disable ALL workflow execution for the lifetime
    // of the long-running plugin host. Reset the cache in a .catch() before rethrowing so the next
    // call retries a fresh load, while a resolved module stays memoized.
    quickJSAsyncModulePromise = newQuickJSAsyncWASMModule();
    quickJSAsyncModulePromise.catch(() => {
      quickJSAsyncModulePromise = undefined;
    });
  }
  return quickJSAsyncModulePromise;
}

async function newSandboxContext() {
  const module = await quickJSAsyncModule();
  const runtime = module.newRuntime();
  return runtime.newContext();
}

function recordFanoutDroppedDiagnostic(run, payload) {
  const diagnostics = run.diagnostics ??= {};
  const existing = Array.isArray(diagnostics.fanoutDroppedFailures) ? diagnostics.fanoutDroppedFailures : [];
  const record = {
    scope: truncateText(String(payload?.scope ?? ""), MAX_STATUS_STRING_CHARS),
    errorSummary: truncateText(String(payload?.error ?? ""), MAX_STATUS_STRING_CHARS),
  };
  if (existing.length < MAX_FANOUT_DIAGNOSTICS) {
    diagnostics.fanoutDroppedFailures = [...existing, record];
  } else {
    diagnostics.fanoutDroppedFailures = existing;
    diagnostics.fanoutDroppedFailuresTruncated = (diagnostics.fanoutDroppedFailuresTruncated ?? 0) + 1;
  }
}

// --- nested workflow dispatch (host "workflow" op) ---

async function runNestedWorkflow(pluginContext, toolContext, run, payload, deps) {
  if (run.nestingDepth >= 1) throw new Error("Nested workflow recursion is rejected; only one nesting level is supported");
  const requested = payload?.source ? { source: payload.source } : { name: payload?.name };
  if (!requested.source && !requested.name) throw new Error("Nested workflow() requires a static workflow name or source");
  // Forward the trusted extension workflow dirs so a nested workflow resolves to the SAME path
  // here (runtime) as in buildNestedSnapshots (approval) — the snapshot match is keyed by sourcePath.
  const { source, sourcePath } = await resolveWorkflowSource(
    toolContext,
    requested,
    pluginContext.workflowExtensionRegistry?.assetDirs()?.workflows ?? [],
  );
  const sourceHash = hash(source);
  // Inline sources share the "<inline>" sentinel path, so the path lookup is ambiguous
  // across distinct inline workflows; resolve them purely by content hash.
  const snapshot = (sourcePath !== "<inline>" && run.nestedSnapshots.get(sourcePath)) || run.nestedSnapshots.get(sourceHash);
  if (snapshot && snapshot.sourceHash !== sourceHash) throw new Error(`Nested workflow source changed after approval: ${sourcePath}`);
  if (!snapshot) throw new Error(`Nested workflow was not part of approved static snapshot: ${sourcePath}`);
  const { body } = parseWorkflowSource(source);
  await appendEvent(run, { type: "workflow.nested.started", sourcePath, sourceHash });
  run.nestingDepth += 1;
  try {
    const output = await executeSandbox(pluginContext, toolContext, run, body, payload?.args ?? null, deps);
    await appendEvent(run, { type: "workflow.nested.completed", sourcePath, sourceHash });
    return output;
  } finally {
    run.nestingDepth -= 1;
  }
}

// --- fanout cancellation (host "fanoutCancel" op) ---

async function cancelFanoutSiblings(pluginContext, run, scope, reason = "failFast sibling cancellation") {
  const prefix = `${scope}/`;
  run.cancelledFanoutScopes.add(scope);
  const error = new WorkflowCancelledError(reason);
  rejectWaitingAgents(run, error, (waiter) => waiter.callId === scope || String(waiter.callId ?? "").startsWith(prefix));
  const aborts = [];
  for (const [callId, lane] of run.activeLaneAbortControllers ?? []) {
    if (callId !== scope && !callId.startsWith(prefix)) continue;
    lane.abortController.abort();
    if (lane.childID && lane.childAbortRequested !== true) {
      lane.childAbortRequested = true;
      aborts.push(abortChild(pluginContext, lane.childID, lane.directory));
    }
  }
  await Promise.allSettled(aborts);
  await appendEvent(run, { type: "fanout.cancel_siblings", scope, reason, activeAbortCount: aborts.length });
  await writeState(run);
}

// --- drain host primitive (host "drain" op) ---

async function createDrainAdapter(pluginContext, toolContext, run, options) {
  const adapterName = options.adapter;
  // Test seam (per-pluginContext): the proof-of-concept resolution path the registry generalizes.
  const testAdapterFactory = pluginContext.__workflowDrainAdapters?.[adapterName];
  if (testAdapterFactory) return await testAdapterFactory({ pluginContext, toolContext, run, options });
  // Production: resolve the adapter through the trusted extension registry. Domain adapters are host
  // code registered by an explicitly-configured extension — the core kernel ships none itself.
  const registration = pluginContext.workflowExtensionRegistry?.drainAdapter(adapterName);
  if (!registration || typeof registration.createAdapter !== "function") {
    throw new Error(`Unsupported drain adapter: ${String(adapterName)} (no extension registered this adapter)`);
  }
  return await registration.createAdapter({ pluginContext, toolContext, run, options });
}

function drainLaneItemId(packet, attemptContext = {}) {
  return String(attemptContext.itemId ?? packet?.itemId ?? packet?.item?.id ?? "");
}

function drainLaneCallId(packet, attemptContext = {}) {
  const id = drainLaneItemId(packet, attemptContext) || "item";
  const attempt = Number.isInteger(attemptContext.attempt) ? attemptContext.attempt : 1;
  return `drain:${safeProjectionName(id)}:${hash(id).slice(0, 8)}:attempt:${attempt}`;
}

const DRAIN_LANE_REPORT_SCHEMA = {
  type: "object",
  additionalProperties: true,
  required: ["itemId", "outcome", "summary", "readyForIntegration", "filesChanged", "commandsRun", "acceptanceEvidence", "residualRisks", "followups"],
  properties: {
    itemId: { type: "string", minLength: 1 },
    outcome: { enum: ["implemented", "blocked", "needs-research", "failed", "no-op"] },
    summary: { type: "string" },
    readyForIntegration: { type: "boolean" },
    filesChanged: { type: "array", items: { type: "string" } },
    commandsRun: { type: "array", items: { type: "string" } },
    acceptanceEvidence: { type: "array", items: { type: "string" } },
    residualRisks: { type: "array", items: { type: "string" } },
    followups: { type: "array", items: { type: "object" } },
  },
};

function drainLanePrompt(packet, attemptContext = {}) {
  const item = packet?.item ?? attemptContext.item;
  const instructions = Array.isArray(packet?.instructions) ? packet.instructions : [];
  return [
    "You are implementing one item for a host-owned drain workflow.",
    "Implement only the assigned item. Edit files only in your assigned worktree.",
    "Make the smallest plausible edit batch, then stop and return the structured LaneReport immediately.",
    "Do not keep exploring or polishing after the first coherent fix. If unsure, blocked, or only partially done, return outcome 'failed' or 'needs-research' with readyForIntegration false and concrete next steps.",
    "Do not run tests; the controller owns bounded validation after your report.",
    "Do not mutate domain state directly; the controller owns all domain reads/writes. (The adapter instructions below list any domain-specific command prohibitions.)",
    "Return exactly the requested structured LaneReport. Set readyForIntegration true only when your changes are complete and safe to merge.",
    instructions.length ? `Adapter instructions:\n${instructions.map((item) => `- ${item}`).join("\n")}` : undefined,
    attemptContext.priorValidation ? `Previous validation:\n${jsonPreview(attemptContext.priorValidation)}` : undefined,
    `Assigned item:\n${jsonPreview(item, 6_000)}`,
  ].filter(Boolean).join("\n\n");
}

function failedDrainLaneReport(packet, attemptContext = {}, reason = "drain lane failed", salvage = undefined) {
  const itemId = drainLaneItemId(packet, attemptContext) || "unknown";
  const summary = truncateText(reason, MAX_STATUS_STRING_CHARS);
  const changedFiles = Array.isArray(salvage?.changedFiles) ? salvage.changedFiles.map((entry) => entry.path).filter(Boolean) : [];
  return {
    itemId,
    outcome: "failed",
    summary,
    readyForIntegration: false,
    filesChanged: changedFiles,
    commandsRun: [],
    acceptanceEvidence: [],
    residualRisks: [summary, salvage?.dirty ? "Dirty worktree was preserved for salvage; no structured child report was received." : undefined].filter(Boolean),
    followups: [],
    salvage,
  };
}

function drainLaneReadyForIntegration(laneReport) {
  return laneReport?.readyForIntegration === true && laneReport.outcome === "implemented";
}

function nonVerifiedDrainBlockers(gateStatus) {
  return Object.entries(gateStatus).filter(([, gate]) => gate?.verified !== true)
    .map(([name, gate]) => `${name}=${gate?.state ?? "missing"}`);
}

async function drainGateStatus(pluginContext, toolContext, options = {}) {
  // Probe only the gates this run actually requires (the resolved authority floor); a drain whose
  // authority requires no gates needs no probing. Gate-union/floor model (invariant #5).
  const requiredGates = Array.isArray(options.requiredGates) && options.requiredGates.length
    ? options.requiredGates
    : NON_DRY_DRAIN_REQUIRED_GATES;
  const probeRequired = options.probeRequired === true;
  const probeOptions = liveGateProbeArgsForNames(requiredGates);
  for (const key of Object.keys(probeOptions)) {
    if (key !== "format") probeOptions[key] = probeRequired;
  }
  const report = JSON.parse(await liveGateReport(pluginContext, toolContext, probeOptions));
  return compactLiveGateStatus(report, requiredGates);
}

async function markDrainLaneIntegration(run, callId, laneReport, acceptedForIntegration, reason) {
  const lane = findIntegrationLane(run, callId);
  if (!lane) return undefined;
  lane.itemId = laneReport.itemId;
  lane.acceptedForIntegration = acceptedForIntegration;
  lane.acceptanceReason = reason;
  await appendIntegrationLedger(run, {
    phase: acceptedForIntegration ? "lane-accepted" : "lane-rejected",
    callId,
    itemId: laneReport.itemId,
    reason,
  });
  await writeLaneProjection(run, callId, { integrationLane: lane });
  await writeState(run);
  return lane;
}

// Backing implementation for globalThis.drain. Thin drain workflows call this host
// primitive so domain reads/mutations, validation, and dry proof
// stay in trusted controller code rather than script-body prompt plumbing.
async function runHostDrain(pluginContext, toolContext, run, payload, deps) {
  const throwIfAborted = typeof deps?.throwIfAborted === "function" ? deps.throwIfAborted : () => {};
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("drain() requires an options object");
  if (typeof payload.adapter !== "string" || payload.adapter === "") throw new Error("drain() requires a trusted adapter name");
  const {
    adapter: adapterName,
    runLane,
    integrate,
    gateStatus: _guestGateStatus,
    gates: _guestGates,
    ...runtimeOptions
  } = payload;
  if (runLane !== undefined || integrate !== undefined) throw new Error("drain() lane execution is host-owned and cannot be supplied by workflow source");
  const drainLaneTimeoutMs = deps.laneTimeoutAliasValue(runtimeOptions, "drain") ?? run.laneTimeoutMs;
  const dryRun = payload.dryRun === true;
  const rawAdapter = await createDrainAdapter(pluginContext, toolContext, run, { ...runtimeOptions, adapter: adapterName });
  // Live-gate enforcement is generic to every drain and keyed on the ADAPTER's declared required
  // gates (the gate-union floor). Guest workflow source cannot supply gateStatus/gates: those fields
  // are host-only evidence and are stripped before adapter construction and runtime execution. Non-dry
  // drains must have all required gates verified before any domain mutation or lane launch. An adapter
  // that declares no gates (a pure test double) needs no probing.
  const requiredGates = Array.isArray(rawAdapter.requiredGates) ? rawAdapter.requiredGates : [];
  const gateStatus = requiredGates.length ? await drainGateStatus(pluginContext, toolContext, { probeRequired: !dryRun, requiredGates }) : undefined;
  if (gateStatus) {
    run.diagnostics.drainLiveGates = gateStatus;
    const nonVerified = nonVerifiedGateSummaries(gateStatus);
    const blockers = nonVerifiedDrainBlockers(gateStatus);
    await appendEvent(run, {
      type: "drain.live_gates",
      adapter: adapterName,
      dryRun,
      gateStatus,
      verified: nonVerified.length === 0,
      blockers,
    });
    await writeState(run);
    if (!dryRun && blockers.length > 0) {
      throw new Error(`Non-dry drain requires verified live gates before domain mutation or lane launch: ${blockers.join(", ")}. Run a dry-run or fix the reported live gates before retrying.`);
    }
  }
  await appendEvent(run, { type: "drain.started", adapter: adapterName, dryRun });
  const adapter = {
    ...rawAdapter,
    async validate(item, integrationState, context = {}) {
      const laneReport = context.laneReport;
      // R11-followup-2 (opencode-workflows-qga): hand the adapter the CONTROLLER ground truth for
      // doc-vs-code scope — the integrated diff's git name-only paths the lane cannot spoof — instead
      // of letting it derive scope from the lane's self-reported filesChanged. A lane that mislabels a
      // real code file as .md / under a docs/ segment / omits the manifest therefore cannot reach the
      // prose-only accept path. The integration lane's `paths` are computed by the controller via
      // changedPathsSinceBase at commit time (see runChildAgent integration branch).
      let controllerChangedPaths;
      if (laneReport?.itemId) {
        const lookupCallId = drainLaneCallId(undefined, { ...context, itemId: laneReport.itemId });
        const integrationLane = findIntegrationLane(run, lookupCallId);
        if (Array.isArray(integrationLane?.paths)) controllerChangedPaths = integrationLane.paths;
      }
      const validationReport = await rawAdapter.validate(item, integrationState, { ...context, controllerChangedPaths });
      if (laneReport?.itemId) {
        const callId = drainLaneCallId(undefined, { ...context, itemId: laneReport.itemId });
        const accepted = validationReport.accepted === true
          && validationReport.diffScopeOk === true
          && validationReport.followupsHandled === true
          && drainLaneReadyForIntegration(laneReport);
        await markDrainLaneIntegration(run, callId, laneReport, accepted, accepted ? "accepted by drain adapter validation" : validationReport.reason || "drain adapter validation rejected lane");
      }
      return validationReport;
    },
  };
  const report = await runDrainRuntime({
    ...runtimeOptions,
    adapter,
    gateStatus,
    checkLifecycle: () => {
      throwIfAborted(run, toolContext);
    },
    canLaunchLane: () => {
      checkBudgetBeforeLaunch(run);
      throwIfAborted(run, toolContext);
      return run.agentsStarted < run.maxAgents;
    },
    runLane: async (packet, attemptContext) => {
      const callId = drainLaneCallId(packet, attemptContext);
      const childResult = await runChildAgent(pluginContext, toolContext, run, {
        callId,
        prompt: drainLanePrompt(packet, attemptContext),
        opts: {
          worktreeEdit: true,
          timeoutMs: drainLaneTimeoutMs,
          schema: DRAIN_LANE_REPORT_SCHEMA,
          onFailure: "returnNull",
          label: `${adapterName} drain ${drainLaneItemId(packet, attemptContext) || "item"}`,
          // Keep implementation-lane behavior stable when the drain is orchestrated from a
          // coordinating primary agent such as proxy.
          agent: "build",
        },
      }, deps);
      const failedRecord = run.laneRecords?.get(callId);
      const laneReport = childResult ?? failedDrainLaneReport(packet, attemptContext, failedRecord?.errorSummary || "lane failed or returned invalid structured output", failedRecord?.salvage);
      if (laneReport.salvage?.dirty) {
        await appendValidationLedger(run, {
          phase: "salvage-validation-skipped",
          callId,
          itemId: laneReport.itemId,
          reason: "dirty timed-out lane did not return a structured report; controller preserved salvage evidence but did not validate or apply it",
          worktreePath: laneReport.salvage.worktreePath,
          changedFiles: laneReport.salvage.changedFiles,
        });
      }
      await markDrainLaneIntegration(run, callId, laneReport, false, drainLaneReadyForIntegration(laneReport) ? "pending drain adapter validation" : laneReport.summary || "lane not ready for integration");
      return laneReport;
    },
    integrate: async (laneReports, attemptContext) => {
      const committedLanes = [];
      const missing = [];
      for (const laneReport of laneReports) {
        const callId = drainLaneCallId(undefined, { ...attemptContext, itemId: laneReport.itemId });
        const lane = findIntegrationLane(run, callId);
        // Defense-in-depth for the read-only-vs-edit asymmetry: a salvaged lane (result recovered
        // from a transcript) has no worktree commit by construction and can never integrate, even
        // if malformed state carried both committed and salvagedFromTranscript. The distinct
        // reason keeps salvage provenance out of the merge path for the right cause.
        const rejectReason = !drainLaneReadyForIntegration(laneReport)
          ? "lane-report-not-accepted"
          : lane?.salvagedFromTranscript === true
            ? "lane-salvaged-from-transcript"
            : lane?.committed !== true
              ? "lane-not-committed"
              : undefined;
        if (rejectReason) {
          missing.push({ itemId: laneReport.itemId, callId, reason: rejectReason });
          if (lane) await markDrainLaneIntegration(run, callId, laneReport, false, rejectReason);
          continue;
        }
        committedLanes.push(lane);
      }
      if (missing.length > 0) return { status: "review-required", reason: "lane-not-accepted-for-integration", laneReports, committedLanes: committedLanes.filter(Boolean), missing };
      return { status: "integrated", laneReports, committedLanes: committedLanes.filter(Boolean) };
    },
  });
  await appendEvent(run, { type: "drain.completed", adapter: adapterName, status: report.status });
  return report;
}

// --- QuickJS sandbox lifecycle ---

function readVmErrorMessage(vm, errorHandle) {
  // dump() of a QuickJS Error drops its non-enumerable .message; prefer reading it
  // directly from the handle. Anything reaching here already escaped the body try/catch,
  // so this only covers prelude/wrapper-construction or other VM-internal rejections.
  try {
    const msgHandle = errorHandle.getProp("message");
    const msg = vm.dump(msgHandle);
    msgHandle.dispose();
    if (typeof msg === "string" && msg.length > 0) return msg;
  } catch {}
  const dumped = vm.dump(errorHandle);
  if (typeof dumped === "string" && dumped.length > 0) return dumped;
  if (dumped && typeof dumped === "object" && typeof dumped.message === "string" && dumped.message.length > 0) return dumped.message;
  try { return JSON.stringify(dumped); } catch { return "[object Object]"; }
}

// Host-owned artifact persistence (iui1.4). A read-only workflow guest cannot write files, and the
// workflow return value is capped at MAX_RESULT_BYTES, so a large finding set can only survive if it
// is spilled to disk DURING execution. This host op lets the guest pass LOGICAL filenames only
// (content as a string or JSON-able object/array); the host roots them under the controller-owned,
// gitignored run store (run.dir/artifacts/<namespace>/) and writes each atomically (temp + rename).
//
// It returns {ok, dir, files} on success and {ok:false, error, dir, files} on a write/validation
// failure — it does NOT throw — so a read-only review can complete with materializationReady:false
// (blocker: artifactPersistenceFailed) instead of crashing the whole workflow. This preserves the
// read-only-review contract: the workflow performs no workspace/source writes, only controller-owned
// runtime artifacts under the run directory (the kernel already persists state/events/result there).
const ARTIFACT_MAX_BYTES = 16 * 1024 * 1024; // generous — the bead exists because output can exceed 256 KiB
async function persistRunArtifacts(pluginContext, run, payload) {
  if (pluginContext?.__workflowArtifactFail) {
    return { ok: false, error: "artifact persistence disabled by test hook", dir: null, files: [] };
  }
  const namespace = safeProjectionName(String(payload?.namespace ?? "workflow")) || "workflow";
  const files = Array.isArray(payload?.files) ? payload.files : Array.isArray(payload) ? payload : [];
  if (!files.length) return { ok: false, error: "persistArtifacts requires a non-empty files array", dir: null, files: [] };
  const root = path.join(run.dir, "artifacts", namespace);
  try {
    await ensurePrivateDir(root);
  } catch (error) {
    return { ok: false, error: `artifact root mkdir failed: ${extractTextFromError(error)}`, dir: null, files: [] };
  }
  const out = [];
  for (const f of files) {
    if (!f || typeof f !== "object") continue;
    const rawName = String(f.name ?? f.filename ?? "").trim();
    if (!rawName) return { ok: false, error: "artifact missing name", dir: root, files: out };
    // Sanitize: basename only, safe charset, not dot-prefixed (blocks ".." traversal), restricted
    // extensions. The charset already forbids "/" and "\" so no path traversal is possible.
    const base = path.basename(rawName);
    if (!/^[A-Za-z0-9._-]+$/.test(base) || base.startsWith(".")) {
      return { ok: false, error: `artifact name rejected: ${rawName}`, dir: root, files: out };
    }
    if (!/\.(json|jsonl|md)$/i.test(base)) {
      return { ok: false, error: `artifact name must end in .json/.jsonl/.md: ${rawName}`, dir: root, files: out };
    }
    let content = f.content;
    if (content === null || content === undefined) content = "";
    if (typeof content === "object") content = stableStringify(content);
    const str = String(content);
    const bytes = Buffer.byteLength(str, "utf8");
    if (bytes > ARTIFACT_MAX_BYTES) {
      return { ok: false, error: `artifact ${base} exceeds ${ARTIFACT_MAX_BYTES} bytes`, dir: root, files: out };
    }
    const dest = path.join(root, base);
    const tmp = path.join(root, `.${base}.${randomBytes(6).toString("hex")}.tmp`);
    try {
      await writeFilePrivate(tmp, str, "utf8");
      await fs.rename(tmp, dest);
    } catch (error) {
      // A write/rename failure (EACCES/ENOSPC) can otherwise orphan a tmp file on disk.
      await fs.rm(tmp, { force: true }).catch(() => {});
      return { ok: false, error: `artifact write failed for ${base}: ${extractTextFromError(error)}`, dir: root, files: out };
    }
    out.push({ name: base, path: dest, bytes });
  }
  await appendEvent(run, { type: "artifacts.persisted", namespace, count: out.length });
  return { ok: true, dir: root, files: out };
}

// Deterministic file inventory + sharding (iui1.5). Coverage was previously agent-discovered
// ("Explore with your tools"); on very large repos agents sample, overfocus, or hit context
// limits. This host op does a deterministic, sorted fs walk of the project root, applies the
// paths/exclude scope, classifies files by language/role, and partitions the manifest into
// bounded shards (by source root, capped at shardSize files each). The manifest grounds recon
// and the leaf prompts in the REAL file set, and a shard ledger tracks coverage so a missed/
// failed shard blocks materialization. Bounded (INVENTORY_MAX_FILES) and cycle-safe (symlinks
// + visited-set skipped); returns {ok, manifest, shards, partial} or {ok:false, error}.
const INVENTORY_ALWAYS_EXCLUDE = new Set([".git", ".opencode", ".beads", ".repo-review", "node_modules", "dist", "build", "target", "vendor"]);
const INVENTORY_MAX_FILES = 200000;
const INVENTORY_SHARD_DEFAULT = 2000;
const INVENTORY_LANG_BY_EXT = {
  ".js": "javascript", ".mjs": "javascript", ".cjs": "javascript", ".jsx": "javascript",
  ".ts": "typescript", ".tsx": "typescript", ".py": "python", ".rb": "ruby", ".go": "go",
  ".rs": "rust", ".java": "java", ".kt": "kotlin", ".php": "php", ".cs": "csharp",
  ".c": "c", ".h": "c", ".cpp": "cpp", ".cc": "cpp", ".swift": "swift", ".scala": "scala",
  ".sh": "shell", ".bash": "shell", ".json": "json", ".yaml": "yaml", ".yml": "yaml",
  ".toml": "toml", ".xml": "xml", ".md": "markdown", ".css": "css", ".scss": "css", ".html": "html",
};
function __globToRegex(pattern) {
  let re = "";
  for (const ch of String(pattern)) {
    if (ch === "*") re += "[^/]*";
    else if (ch === "?") re += "[^/]";
    else re += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}
function __compileExcludeGlobs(excludes) {
  const literals = new Set();
  const globs = [];
  for (const raw of excludes) {
    const ex = String(raw);
    if (!ex.includes("*") && !ex.includes("?")) literals.add(ex);
    else globs.push({ source: ex, regex: __globToRegex(ex) });
  }
  return { literals, globs };
}
function __isPathExcluded(segments, basename, excludes) {
  for (const ex of excludes.literals) {
    if (segments.includes(ex) || basename === ex) return true;
  }
  for (const ex of excludes.globs) {
    if (ex.regex.test(basename)) return true;
  }
  return false;
}
function __langOf(basename) {
  const ext = path.extname(basename).toLowerCase();
  return INVENTORY_LANG_BY_EXT[ext] || (ext ? ext.slice(1) : "other");
}
function __roleOf(rel, basename) {
  const b = (rel + "/" + basename).toLowerCase();
  if (/(^|\/)tests?\/|\.test\.|\.spec\.|_test\.|\/test\//.test(b)) return "test";
  if (/\.lock$|lock\.(json|yaml)$/.test(b)) return "lockfile";
  if (/(^|\/)(package\.json|requirements\.txt|pyproject\.toml|go\.mod|cargo\.toml|gemfile|pom\.xml|composer\.json)$/i.test(b)) return "manifest";
  if (/(^|\/)(dockerfile|docker-compose|containerfile)/i.test(b) || /\.(dockerfile|containerfile)$/i.test(b)) return "container";
  if (/(^|\/)\.github\/workflows\//.test(b) || /\.gitlab-ci\.|\.circleci/.test(b)) return "ci";
  return "source";
}
async function inventoryRunFiles(pluginContext, toolContext, run, payload) {
  if (pluginContext?.__workflowInventoryFail) {
    return { ok: false, error: "inventory disabled by test hook", manifest: null, shards: [], partial: false };
  }
  if (typeof pluginContext?.__workflowInventory === "function") {
    try { return await pluginContext.__workflowInventory(payload); }
    catch (error) { return { ok: false, error: extractTextFromError(error), manifest: null, shards: [], partial: false }; }
  }
  const projectRoot = path.resolve(toolContext?.worktree || toolContext?.directory || ".");
  const paths = Array.isArray(payload?.paths) && payload.paths.length ? payload.paths : ["."];
  const excludeGlobs = Array.isArray(payload?.exclude) ? payload.exclude : [];
  const excludeRules = __compileExcludeGlobs(excludeGlobs);
  const shardSize = Number.isInteger(payload?.shardSize) && payload.shardSize > 0 ? payload.shardSize : INVENTORY_SHARD_DEFAULT;
  try {
    const files = [];
    let partial = false;
    const visited = new Set();
    async function walk(dir, depth) {
      if (depth > 32) return;
      let entries;
      try { entries = await fs.readdir(dir, { withFileTypes: true }); }
      catch { return; }
      entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      for (const ent of entries) {
        if (ent.isSymbolicLink()) continue;
        if (INVENTORY_ALWAYS_EXCLUDE.has(ent.name)) continue;
        const rel = path.relative(projectRoot, path.join(dir, ent.name)).split(path.sep).join("/");
        const segs = rel.split("/");
        if (__isPathExcluded(segs, ent.name, excludeRules)) continue;
        if (ent.isDirectory()) {
          const key = path.resolve(dir, ent.name);
          if (visited.has(key)) continue;
          visited.add(key);
          await walk(key, depth + 1);
        } else if (ent.isFile()) {
          if (files.length >= INVENTORY_MAX_FILES) { partial = true; return; }
          files.push({ path: rel, lang: __langOf(ent.name), role: __roleOf(rel, ent.name) });
        }
      }
    }
    for (const p of paths) {
      const start = path.resolve(projectRoot, String(p));
      if (!pathContains(projectRoot, start)) {
        partial = true;
        continue;
      }
      try {
        const st = await fs.stat(start);
        if (st.isDirectory()) {
          if (!visited.has(start)) { visited.add(start); await walk(start, 0); }
        } else if (st.isFile()) {
          if (files.length < INVENTORY_MAX_FILES) {
            const rel = path.relative(projectRoot, start).split(path.sep).join("/");
            files.push({ path: rel, lang: __langOf(path.basename(start)), role: __roleOf(rel, path.basename(start)) });
          } else { partial = true; }
        }
      } catch { /* missing path — skip */ }
    }
    const byLanguage = {}, byRole = {};
    const byRoot = {};
    for (const f of files) {
      byLanguage[f.lang] = (byLanguage[f.lang] || 0) + 1;
      byRole[f.role] = (byRole[f.role] || 0) + 1;
      const root = f.path.split("/")[0] || "<root>";
      (byRoot[root] = byRoot[root] || []).push(f);
    }
    const shards = [];
    const rootNames = Object.keys(byRoot).sort();
    for (const root of rootNames) {
      const group = byRoot[root];
      for (let i = 0; i < group.length; i += shardSize) {
        const slice = group.slice(i, i + shardSize);
        shards.push({
          id: `${root}-${Math.floor(i / shardSize) + 1}`,
          root, fileCount: slice.length,
          languages: [...new Set(slice.map((f) => f.lang))],
          paths: slice.map((f) => f.path),
        });
      }
    }
    const manifest = { totalFiles: files.length, byLanguage, byRole, sourceRoots: rootNames, paths, exclude: excludeGlobs, partial };
    await appendEvent(run, { type: "inventory.completed", files: files.length, shards: shards.length, partial });
    return { ok: true, manifest, shards, partial };
  } catch (error) {
    return { ok: false, error: `inventory failed: ${extractTextFromError(error)}`, manifest: null, shards: [], partial: false };
  }
}

/**
 * Execute a workflow body inside a deterministic QuickJS sandbox, bridging guest host-ops
 * (agent/log/phase/budget/workflow/drain/fanout helpers/persistArtifacts) to the trusted controller.
 *
 * @param {object} pluginContext OpenCode plugin context.
 * @param {object} toolContext Tool-call context.
 * @param {RunContext} run Shared mutable run state.
 * @param {string} body Workflow body source (executed inside the VM).
 * @param {*} args Runtime args injected as globalThis.args.
 * @param {object} deps Orchestrator-resident primitives forwarded to runChildAgent and host dispatch.
 * @returns {Promise<*>} The workflow body's return value.
 */
async function executeSandbox(pluginContext, toolContext, run, body, args, deps) {
  const throwIfAborted = typeof deps?.throwIfAborted === "function" ? deps.throwIfAborted : () => {};
  const vm = await newSandboxContext();
  const runtime = vm.runtime;
  const guestDeadlineMs = run.guestDeadlineMs || DEFAULT_GUEST_DEADLINE_MS;
  // The interrupt deadline guards against runaway *synchronous* guest code; it is NOT a
  // workflow wall-clock budget. It must be re-armed before every guest-execution burst:
  // the guest is Asyncify-suspended for the entire duration of each host await (a child
  // agent can run for minutes), so an absolute deadline armed once at sandbox entry would
  // fire the instant the guest resumes after the first slow agent and kill the whole run.
  const armDeadline = () => vm.runtime?.setInterruptHandler?.(shouldInterruptAfterDeadline(Date.now() + guestDeadlineMs));
  armDeadline();
  vm.runtime?.setMemoryLimit?.(32 * 1024 * 1024);
  const deferreds = [];
  const handles = [];
  const pendingHostOps = new Map();

  function executePendingJobs() {
    for (let i = 0; i < MAX_PENDING_JOB_DRAIN_ITERATIONS; i += 1) {
      const result = runtime.executePendingJobs();
      try {
        if (result?.error) throw vm.unwrapResult(result);
        if (!Number.isFinite(result?.value) || result.value <= 0) return;
      } finally {
        result?.dispose?.();
      }
    }
    throw new Error(`QuickJS pending job drain exceeded ${MAX_PENDING_JOB_DRAIN_ITERATIONS} iterations`);
  }

  async function settlePendingHostOps() {
    if (pendingHostOps.size === 0) return;
    for (const lane of run.activeLaneAbortControllers?.values?.() ?? []) {
      try { lane.abortController?.abort?.(); } catch {}
      if (lane.childID) {
        try {
          if (lane.childAbortRequested !== true) {
            lane.childAbortRequested = true;
            await abortChild(pluginContext, lane.childID, lane.directory ?? toolContext.directory);
          }
        } catch {}
      }
    }
    try { rejectWaitingAgents(run, new WorkflowCancelledError("Workflow host operation was not awaited")); } catch {}
    const settleTimeoutMs = Number.isFinite(pluginContext?.__workflowPendingHostOpSettleTimeoutMs) && pluginContext.__workflowPendingHostOpSettleTimeoutMs > 0
      ? pluginContext.__workflowPendingHostOpSettleTimeoutMs
      : PENDING_HOST_OP_SETTLE_TIMEOUT_MS;
    await Promise.race([
      Promise.allSettled([...pendingHostOps.values()]),
      sleep(settleTimeoutMs),
    ]);
  }

  async function rejectFloatingHostOpsIfAny() {
    if (pendingHostOps.size === 0) return;
    const count = pendingHostOps.size;
    await settlePendingHostOps();
    throw new Error(`Workflow host operation${count === 1 ? "" : "s"} must be awaited before returning (${count} pending)`);
  }

  function hostReturn(value) {
    return vm.newString(JSON.stringify(value ?? null));
  }

  const host = vm.newFunction("__workflowHost", (opHandle, payloadHandle) => {
    const op = vm.getString(opHandle);
    const payload = vm.dump(payloadHandle);
    const deferred = vm.newPromise();
    deferreds.push(deferred);

    const pendingToken = {};
    let hostOpRejected = false;
    const hostOp = (async () => {
      try {
        throwIfAborted(run, toolContext);
        run.hostCalls += 1;
        const maxHostCalls = maxHostCallsForRun(run);
        if (run.hostCalls > maxHostCalls) throw new Error(`Workflow exceeded max host calls (${maxHostCalls})`);
        await sandboxHostOpTestHook?.({ op, payload, run });
        let value;
        if (op === "agent") value = await runChildAgent(pluginContext, toolContext, run, payload, deps);
        else if (op === "noop") value = null;
        else if (op === "log") {
          const message = truncateText(String(payload.message ?? ""), MAX_EVENT_MESSAGE_CHARS);
          recordRecentLog(run, message);
          await appendEvent(run, { type: "log", message });
          value = null;
        } else if (op === "phase") {
          run.currentPhase = String(payload.name ?? "");
          await appendEvent(run, { type: "phase", phase: run.currentPhase });
          await writeState(run);
          await maybeShowWorkflowProgressToast(pluginContext, run);
          value = null;
        } else if (op === "budget") {
          value = budgetSnapshot(run);
        } else if (op === "workflow") {
          value = await runNestedWorkflow(pluginContext, toolContext, run, payload, deps);
        } else if (op === "drain") {
          value = await runHostDrain(pluginContext, toolContext, run, payload, deps);
        } else if (op === "persistArtifacts") {
          value = await persistRunArtifacts(pluginContext, run, payload);
        } else if (op === "inventoryFiles") {
          value = await inventoryRunFiles(pluginContext, toolContext, run, payload);
      } else if (op === "fanoutFailure") {
          run.droppedLaneCount += 1;
          recordFanoutDroppedDiagnostic(run, payload);
          await appendEvent(run, { type: "fanout.lane_dropped", scope: payload.scope, error: truncateText(payload.error ?? "", MAX_STATUS_STRING_CHARS) });
          await writeState(run);
          value = null;
        } else if (op === "fanoutCancel") {
          await cancelFanoutSiblings(pluginContext, run, String(payload.scope ?? ""), String(payload.reason ?? "failFast sibling cancellation"));
          value = null;
        } else if (op === "sequentialFanout") {
          await appendEvent(run, { type: "fanout.sequential", scope: payload.scope, helper: payload.helper });
          value = null;
        } else {
          throw new Error(`Unsupported workflow host operation: ${op}`);
        }
        throwIfAborted(run, toolContext);
        const handle = hostReturn(value);
        deferred.resolve(handle);
        handle.dispose();
      } catch (error) {
        hostOpRejected = true;
        const handle = vm.newError(extractTextFromError(error));
        deferred.reject(handle);
        handle.dispose();
      } finally {
        pendingHostOps.delete(pendingToken);
        armDeadline();
        executePendingJobs();
        // Free the settled deferred's Promise handle as soon as the guest can no
        // longer need it, instead of letting every settled host op stay rooted in
        // the 32MB-capped QuickJS heap until the whole run ends (a host-call-heavy
        // loop would otherwise accumulate thousands of dead handles). The guest is
        // asyncify-suspended at its `await` when this finally runs, so only the
        // RESOLVE path is safe to drop here: quickjs-emscripten has already
        // delivered the resolved value into the asyncify resume buffer, making our
        // Promise handle dead weight. A REJECTED deferred must survive until the
        // guest resumes and reads the rejection reason from the handle — disposing
        // it early corrupts that read into "Lifetime not alive" — so leave rejected
        // handles for the outer finally-loop (an uncaught rejection is terminal and
        // does not accumulate). Removing disposed handles from `deferreds` keeps the
        // outer loop from double-freeing and leaves only genuinely-live handles.
        if (!hostOpRejected) {
          try { deferred.dispose(); } catch {}
          const deferredIndex = deferreds.indexOf(deferred);
          if (deferredIndex !== -1) deferreds.splice(deferredIndex, 1);
        }
      }
    })();
    pendingHostOps.set(pendingToken, hostOp);
    hostOp.catch(() => {
      pendingHostOps.delete(pendingToken);
    });

    return deferred.handle;
  });
  handles.push(host);
  vm.setProp(vm.global, "__workflowHost", host);

  const prelude = `
    globalThis.Date = function Date() { throw new Error("Date is disabled in deterministic workflows"); };
    globalThis.Date.now = function () { throw new Error("Date.now is disabled in deterministic workflows"); };
    globalThis.Math.random = function () { throw new Error("Math.random is disabled in deterministic workflows"); };
    globalThis.performance = undefined;
    globalThis.crypto = undefined;
    globalThis.setTimeout = undefined;
    globalThis.setInterval = undefined;
    globalThis.clearTimeout = undefined;
    globalThis.clearInterval = undefined;
    const __workflowArgs = ${JSON.stringify(args ?? null)};
    function __makeScope(path) { return { path, next: 0 }; }
    function __nextIn(scope, kind) { return scope.path + "/" + kind + ":" + (scope.next++); }
    async function __host(op, payload) { return JSON.parse(await globalThis.__workflowHost(op, payload)); }

    const __rootScope = __makeScope("root");
    let __activeScope = __rootScope;
    async function __withActiveScope(scope, fn) {
      const previous = __activeScope;
      __activeScope = scope;
      try { return await fn(); }
      finally { __activeScope = previous; }
    }

    const __sharedApi = {
      phase: async (name) => await __host("phase", { name }),
      log: async (message) => await __host("log", { message }),
      budget: {
        spent: async () => (await __host("budget", {})).total.tokens,
        live: async () => (await __host("budget", {})).live,
        replayed: async () => (await __host("budget", {})).replayed,
        cost: async () => (await __host("budget", {})).total.cost,
        ceilings: async () => (await __host("budget", {})).ceilings,
        remaining: async () => (await __host("budget", {})).remaining,
        remainingAgents: async () => (await __host("budget", {})).remainingAgents,
      },
    };

    function __makeApi(scope) {
      const api = {
        agent: async (prompt, opts = {}) => await __host("agent", { callId: __nextIn(scope, "agent"), prompt, opts }),
        phase: __sharedApi.phase,
        log: __sharedApi.log,
        budget: __sharedApi.budget,
        parallel: async (thunks, options = {}) => await __parallel(scope, thunks, options),
        pipeline: async (items, ...stagesAndOptions) => await __pipeline(scope, items, ...stagesAndOptions),
      };
      return Object.freeze(api);
    }

    globalThis.args = __workflowArgs;
    globalThis.agent = async function agent(prompt, opts = {}) {
      return await __host("agent", { callId: __nextIn(__activeScope, "agent"), prompt, opts });
    };
    globalThis.phase = __sharedApi.phase;
    globalThis.log = __sharedApi.log;
    globalThis.budget = __sharedApi.budget;
    // iui1.4: host-owned artifact spill so a large finding set survives the MAX_RESULT_BYTES return
    // cap. The guest passes logical filenames only; the host roots them under run.dir/artifacts/.
    globalThis.persistArtifacts = async function persistArtifacts(payload) {
      return await __host("persistArtifacts", payload);
    };
    // iui1.5: deterministic file inventory + sharding. The guest passes scope (paths/exclude) and
    // shardSize; the host walks the project root and returns a structured manifest + shards.
    globalThis.inventoryFiles = async function inventoryFiles(payload) {
      return await __host("inventoryFiles", payload);
    };

    function __splitOptions(values) {
      if (!values.length) return { values, options: {} };
      const last = values[values.length - 1];
      if (last && typeof last === "object" && typeof last !== "function" && !Array.isArray(last)) {
        return { values: values.slice(0, -1), options: last };
      }
      return { values, options: {} };
    }

    function __isScopedCallback(fn) {
      return typeof fn === "function" && fn.length > 0;
    }

    function __zeroParamCallbackIndexes(callbacks) {
      const indexes = [];
      for (let index = 0; index < callbacks.length; index += 1) {
        if (!__isScopedCallback(callbacks[index])) indexes.push(index);
      }
      return indexes;
    }

    function __fanoutArityError(helper, indexes) {
      return new Error(helper + "() requires every callback to declare a scope parameter for concurrent, resume-safe execution (for example, (api) => api.agent(...)). Callback(s) at index " + indexes.join(", ") + " declare 0 parameters. Default/rest parameters also have function.length === 0, so patterns like (api = {}) => ... or (...args) => ... do not count as scoped. Add a parameter and use the injected api/context (api.agent/api.parallel/api.pipeline), or pass { sequential: true } to intentionally run these item(s) one at a time.");
    }

    async function __handleFanoutError(scope, error, options) {
      if (options.failFast === true) throw error;
      await __host("fanoutFailure", { scope, error: String(error && error.message ? error.message : error) });
      return null;
    }

    async function __failFastAll(group, tasks) {
      let firstError;
      let cancelling = false;
      const settled = await Promise.allSettled(tasks.map((task) => (async () => {
        try { return await task(); }
        catch (error) {
          if (!firstError) firstError = error;
          if (!cancelling) {
            cancelling = true;
            await __host("fanoutCancel", { scope: group, reason: String(error && error.message ? error.message : error) });
          }
          throw error;
        }
      })()));
      if (firstError) throw firstError;
      return settled.map((entry) => entry.value);
    }

    async function __parallel(parentScope, thunks, options = {}) {
      const group = __nextIn(parentScope, "parallel");
      const sequential = options.sequential === true;
      const scoped = !sequential && (options.scoped === true || thunks.every(__isScopedCallback));
      if (scoped) {
        const tasks = thunks.map((thunk, index) => async () => {
          const scope = __makeScope(group + "/item:" + index);
          try { return await thunk(__makeApi(scope), index); }
          catch (error) { return await __handleFanoutError(scope.path, error, options); }
        });
        return options.failFast === true ? await __failFastAll(group, tasks) : await Promise.all(tasks.map((task) => task()));
      }
      if (!sequential) throw __fanoutArityError("parallel", __zeroParamCallbackIndexes(thunks));

      await __host("sequentialFanout", { scope: group, helper: "parallel" });
      const results = [];
      for (let index = 0; index < thunks.length; index += 1) {
        const scope = __makeScope(group + "/item:" + index);
        try { results.push(await __withActiveScope(scope, () => thunks[index]())); }
        catch (error) { results.push(await __handleFanoutError(scope.path, error, options)); }
      }
      return results;
    }

    async function __pipeline(parentScope, items, ...stagesAndOptions) {
      const split = __splitOptions(stagesAndOptions);
      const stages = split.values;
      const options = split.options;
      const group = __nextIn(parentScope, "pipeline");
      const sequential = options.sequential === true;
      const scoped = !sequential && (options.scoped === true || stages.every(__isScopedCallback));
      if (scoped) {
        const tasks = items.map((item, itemIndex) => async () => {
          let value = item;
          for (let stageIndex = 0; stageIndex < stages.length; stageIndex += 1) {
            const scope = __makeScope(group + "/item:" + itemIndex + "/stage:" + stageIndex);
            const api = __makeApi(scope);
            const context = Object.freeze({ ...api, previous: value, item, itemIndex, stageIndex });
            try { value = await stages[stageIndex](value, context, item, itemIndex, stageIndex); }
            catch (error) { return await __handleFanoutError(scope.path, error, options); }
          }
          return value;
        });
        return options.failFast === true ? await __failFastAll(group, tasks) : await Promise.all(tasks.map((task) => task()));
      }
      if (!sequential) throw __fanoutArityError("pipeline", __zeroParamCallbackIndexes(stages));

      await __host("sequentialFanout", { scope: group, helper: "pipeline" });
      const results = [];
      for (let itemIndex = 0; itemIndex < items.length; itemIndex += 1) {
        const item = items[itemIndex];
        let value = item;
        let dropped = false;
        for (let stageIndex = 0; stageIndex < stages.length; stageIndex += 1) {
          const scope = __makeScope(group + "/item:" + itemIndex + "/stage:" + stageIndex);
          try { value = await __withActiveScope(scope, () => stages[stageIndex](value, item, itemIndex, stageIndex)); }
          catch (error) { value = await __handleFanoutError(scope.path, error, options); dropped = true; }
          if (dropped) break;
        }
        results.push(value);
      }
      return results;
    }

    globalThis.parallel = async function parallel(thunks, options = {}) { return await __parallel(__activeScope, thunks, options); };
    globalThis.pipeline = async function pipeline(items, ...stagesAndOptions) { return await __pipeline(__activeScope, items, ...stagesAndOptions); };
    globalThis.workflow = async function workflow(nameOrSource, nestedArgs = null) {
      let payload;
      if (typeof nameOrSource === "string") {
        payload = nameOrSource.includes("\\n") || nameOrSource.includes("export const meta")
          ? { source: nameOrSource, args: nestedArgs }
          : { name: nameOrSource, args: nestedArgs };
      } else if (nameOrSource && typeof nameOrSource === "object") {
        const hasSource = typeof nameOrSource.source === "string" && nameOrSource.source.length > 0;
        const hasName = typeof nameOrSource.name === "string" && nameOrSource.name.length > 0;
        if (hasSource === hasName) throw new Error("workflow() object form requires exactly one source or name string");
        payload = hasSource
          ? { source: nameOrSource.source, args: nameOrSource.args ?? nestedArgs }
          : { name: nameOrSource.name, args: nameOrSource.args ?? nestedArgs };
      } else {
        throw new Error("workflow() requires a static string name/source or workflow({ source, args })");
      }
      return await __host("workflow", payload);
    };
    // Supported host primitive for trusted autonomous drain adapters. The thin drain
    // workflow wrapper is intentionally thin and delegates domain control here.
    globalThis.drain = async function drain(options = {}) {
      return await __host("drain", options);
    };
    await __host("noop", {});
  `;

  // Workflow bodies execute inside QuickJS. vm.dump() of a thrown Error yields {} because
  // Error.message is non-enumerable and is dropped by JSON-based marshaling, so a body
  // runtime error would otherwise surface as "[object Object]". Wrap the body so any thrown
  // value is captured HERE (where .message is intact) and returned as a plain sentinel
  // object whose enumerable string properties survive dump(). The host unwraps it below
  // and re-throws a real Error carrying the original message.
  const wrapped = `(async () => {\n"use strict";\n${prelude}\ntry {\n${body}\n} catch (__wfErr) {\n  let __wfMsg = "";\n  let __wfName = "Error";\n  try {\n    if (__wfErr && typeof __wfErr === "object") {\n      if (typeof __wfErr.message === "string" && __wfErr.message.length > 0) __wfMsg = __wfErr.message;\n      if (typeof __wfErr.name === "string" && __wfErr.name.length > 0) __wfName = __wfErr.name;\n    } else if (typeof __wfErr === "string") {\n      __wfMsg = __wfErr;\n    }\n  } catch {}\n  if (!__wfMsg) {\n    try { __wfMsg = String(__wfErr); } catch { __wfMsg = "[non-serializable workflow error]"; }\n  }\n  return { __workflowRuntimeError: true, message: __wfMsg, name: __wfName };\n}\n})()`;
  let promiseHandle;
  let valueHandle;
  try {
    armDeadline();
    const result = await vm.evalCodeAsync(wrapped, `${run.sourcePath}#workflow`);
    promiseHandle = vm.unwrapResult(result);
    armDeadline();
    executePendingJobs();
    const state = vm.getPromiseState(promiseHandle);
    if (state.type === "fulfilled") {
      valueHandle = state.value;
    } else if (state.type === "rejected") {
      valueHandle = state.error;
      // Defensive fallback for a top-level rejection that escaped the body try/catch
      // (e.g. a prelude failure). dump() drops Error.message, so recover it via the
      // handle before the boundary crossing degrades it to "[object Object]".
      throw new Error(readVmErrorMessage(vm, valueHandle));
    } else {
      armDeadline();
      const resolved = await vm.resolvePromise(promiseHandle);
      valueHandle = vm.unwrapResult(resolved);
    }
    const output = vm.dump(valueHandle);
    if (output !== null && typeof output === "object" && output.__workflowRuntimeError === true) {
      const msg = typeof output.message === "string" && output.message.length > 0 ? output.message : "[workflow runtime error]";
      const err = new Error(msg);
      if (typeof output.name === "string" && output.name.length > 0) err.name = output.name;
      throw err;
    }
    await rejectFloatingHostOpsIfAny();
    assertResultSize(output);
    return output;
  } finally {
    await settlePendingHostOps();
    valueHandle?.dispose();
    promiseHandle?.dispose();
    try {
      if (vm.alive) vm.setProp(vm.global, "__workflowHost", vm.undefined);
    } catch {}
    for (const handle of handles) handle.dispose();
    for (const deferred of deferreds) deferred.dispose();
    try {
      if (runtime?.alive) executePendingJobs();
    } catch {}
    try {
      if (vm.alive) vm.dispose();
      // executePendingJobs() can materialize additional async contexts; make sure none
      // remain rooted before freeing the per-run runtime.
      for (const context of runtime?.contextMap?.values?.() ?? []) {
        if (context?.alive) context.dispose();
      }
    } finally {
      if (runtime?.alive) runtime.dispose();
    }
  }
}

function __setSandboxHostOpTestHook(hook) {
  sandboxHostOpTestHook = typeof hook === "function" ? hook : undefined;
}

export {
  executeSandbox,
  runNestedWorkflow,
  drainGateStatus,
  maxHostCallsForRun,
  persistRunArtifacts,
  quickJSAsyncModule,
  newSandboxContext,
  __setSandboxHostOpTestHook,
};
