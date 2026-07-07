// Concern (1): durable state writes. Serializes the live RunContext into the authoritative
// state.json snapshot (plus the diff/integration-plan envelope) and fans the matching
// durable projections out via writeDurableProjections. Extracted from run-store-status.js
// (opencode-workflows-nbp).
//
// writeState reads the broadest slice of RunContext of any run-store concern — effectively
// the whole serializable surface (identity, lifecycle, budget/tokens, lane outcomes,
// capabilities/diagnostics, edit/integration plans, lifecycle/notification/background) —
// and writes state.json. See {@link import("./run-context.js").RunContext}.

import path from "node:path";
import {
  DURABLE_STATE_VERSION,
  MAX_STATUS_STRING_CHARS,
} from "./constants.js";
import { truncateText } from "./text-json.js";
import { durableLedgerSummary } from "./event-journal.js";
import { computeDiffPlanHash } from "./approval-hashing.js";
import { selfProcessStartTime, writeJsonAtomic } from "./run-store-fs.js";
import { writeDurableProjections } from "./run-store-projections.js";
import { normalizeRecentLogs } from "./run-observability.js";

const stateWriteChains = new WeakMap();
let writeStateTestHook;

// lastProgressAt (opencode-workflows-jbs3.8): the most recent moment any lane demonstrably
// changed state. Agents read this from the compact status to detect a wedged/no-progress run
// (now - lastProgressAt > a documented threshold) WITHOUT pulling detail=full. Derived from the
// per-lane records' updatedAt/completedAt/startedAt timestamps — writeLaneProjection stamps
// updatedAt on every lane state change, so any lane transition advances this clock — with the
// run's own resume/start time as the floor so a freshly launched (or just-resumed) run that has
// no lane activity yet still reports a meaningful baseline instead of null. All timestamps are
// ISO-8601 UTC ("…Z"), which sort correctly lexicographically, so a string max is sufficient.
function laneRecordsArray(run) {
  if (run.laneRecords instanceof Map) return [...run.laneRecords.values()];
  if (Array.isArray(run.laneRecords)) return run.laneRecords;
  return [];
}

function computeLastProgressAt(run) {
  let latest = null;
  const consider = (ts) => {
    if (typeof ts === "string" && (latest === null || ts > latest)) latest = ts;
  };
  consider(run.startedAt);
  consider(run.resumedAt);
  consider(run.lastEventAt);
  for (const record of laneRecordsArray(run)) {
    consider(record?.lastActivityAt ?? record?.updatedAt ?? record?.completedAt ?? record?.startedAt);
  }
  return latest;
}

async function doWriteState(run) {
  const durability = {
    stateVersion: DURABLE_STATE_VERSION,
    ledgers: await durableLedgerSummary(run.dir),
    projections: ["state.json", "events.jsonl", "journal.jsonl", "worktrees.json", "waves/index.json", "lanes/"],
    recovery: run.recovery,
  };
  const state = {
    stateVersion: DURABLE_STATE_VERSION,
    id: run.id,
    status: run.status,
    sourcePath: run.sourcePath,
    sourceHash: run.sourceHash,
    meta: run.meta,
    authority: run.authority,
    argsPreview: run.argsPreview,
    startedAt: run.startedAt,
    resumedAt: run.resumedAt,
    finishedAt: run.finishedAt,
    lastEventAt: run.lastEventAt,
    lastEventType: run.lastEventType,
    lastProgressAt: computeLastProgressAt(run),
    debugCapture: run.debugCapture,
    firstResultAt: run.firstResultAt,
    timeToFirstResultMs: run.timeToFirstResultMs,
    approvalWait: run.approvalWait,
    recentLogs: normalizeRecentLogs(run.recentLogs),
    operatorMetrics: {
      timeToFirstResultMs: Number.isFinite(run.timeToFirstResultMs) ? run.timeToFirstResultMs : null,
      firstResultAt: run.firstResultAt ?? null,
      approvalWaitMs: Number.isFinite(run.approvalWait?.durationMs) ? run.approvalWait.durationMs : null,
      awaitingDiffApprovalAt: run.approvalWait?.startedAt ?? null,
      appliedAt: run.approvalWait?.completedAt ?? null,
    },
    currentPhase: run.currentPhase,
    agentsStarted: run.agentsStarted,
    maxAgents: run.maxAgents,
    concurrency: run.concurrency,
    laneTimeoutMs: run.laneTimeoutMs,
    maxRuntimeMs: run.maxRuntimeMs,
    defaultChildModel: run.defaultChildModel,
    activeAgents: run.activeAgents,
    queuedAgents: run.waitingAgents?.length ?? 0,
    tokens: run.tokens,
    replayedTokens: run.replayedTokens,
    cost: run.cost,
    replayedCost: run.replayedCost,
    cacheStats: run.cacheStats,
    budgetCeilings: run.budgetCeilings,
    autoApproved: run.autoApproved,
    laneOutcomes: run.laneOutcomes,
    droppedLaneCount: run.droppedLaneCount,
    capabilities: run.capabilities,
    diagnostics: run.diagnostics,
    durability,
    laneRecords: run.laneRecords instanceof Map ? [...run.laneRecords.values()] : [],
    closeout: run.closeout,
    worktreeCleanup: run.worktreeCleanup,
    lifecycleRequests: run.lifecycleRequests,
    notification: run.notification,
    background: run.background,
    nestedSnapshots: run.nestedSnapshots ? [...new Map([...run.nestedSnapshots.values()].map((item) => [item.sourcePath, item])).values()].map(({ source, ...item }) => item) : [],
    resultPath: run.resultPath,
    error: run.error ? truncateText(run.error, MAX_STATUS_STRING_CHARS) : undefined,
    process: { pid: process.pid, startTime: await selfProcessStartTime() },
  };
  if (run.editPlan) {
    state.editWorktrees = run.editWorktrees;
    state.editPlan = { ...run.editPlan, diffPlanHash: computeDiffPlanHash(run.editPlan), patchCount: run.editPlan.patches?.length ?? 0 };
  }
  if (run.integrationPlan) {
    state.integrationWorktrees = run.integrationWorktrees;
    state.integrationPlan = {
      ...run.integrationPlan,
      patchCount: run.integrationPlan.patches?.length ?? 0,
    };
  }
  await writeStateTestHook?.({ phase: "beforeStateWrite", run, state });
  await writeJsonAtomic(path.join(run.dir, "state.json"), state);
  await writeDurableProjections(run, state);
}

async function writeState(run) {
  const previous = stateWriteChains.get(run) ?? Promise.resolve();
  const current = previous.catch(() => {}).then(() => doWriteState(run));
  stateWriteChains.set(run, current.catch(() => {}));
  return await current;
}

function __setWriteStateTestHook(hook) {
  writeStateTestHook = typeof hook === "function" ? hook : undefined;
}

export { writeState, computeLastProgressAt, __setWriteStateTestHook };
