// Concern (3): lane outcome and projection recording. Records lane outcomes into the
// append-only journal + per-lane projection files, writes the durable worktrees/waves/
// closeout projections, captures/reads/removes per-lane request+result checkpoints,
// reconstructs lane projections from disk, and computes recovery/salvage summaries.
// Extracted from run-store-status.js (opencode-workflows-nbp).
//
// The RunContext properties this concern reads/writes are the lane/journal/projection
// surface: run.id, run.dir, run.laneRecords, run.laneOutcomes, run.droppedLaneCount,
// run.currentPhase/agentsStarted/maxAgents/concurrency (waves index), and the
// editWorktrees/integrationWorktrees/integrationPlan worktree records.
// See {@link import("./run-context.js").RunContext}.

import fs from "node:fs/promises";
import path from "node:path";
import {
  ACTIVE_STATUSES,
  MAX_STATUS_STRING_CHARS,
} from "./constants.js";
import { redactDurableValue, redactValue, truncateText } from "./text-json.js";
import {
  appendEvent,
  appendJournal,
  durableLedgerSummary,
  incompleteLedgerKeys,
  ledgerFilePath,
  loadJournal,
  readJsonlLedger,
} from "./event-journal.js";
import { ensurePrivateDir, readJsonFile, safeProjectionName, writeJsonAtomic } from "./run-store-fs.js";

const laneProjectionWriteChains = new WeakMap();
const cleanLaneProjectionRecords = new WeakMap();

function durationMs(start, end) {
  const startMs = typeof start === "string" ? Date.parse(start) : Number.NaN;
  const endMs = typeof end === "string" ? Date.parse(end) : Number.NaN;
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return undefined;
  return Math.max(0, endMs - startMs);
}

function cleanProjectionMap(run) {
  let records = cleanLaneProjectionRecords.get(run);
  if (!records) {
    records = new Map();
    cleanLaneProjectionRecords.set(run, records);
  }
  return records;
}

function markLaneProjectionClean(run, callId, record) {
  if (!run || typeof run !== "object" || !callId || !record) return;
  cleanProjectionMap(run).set(String(callId), { ref: record, updatedAt: record.updatedAt });
}

function laneProjectionNeedsFlush(run, callId, record) {
  if (!run || typeof run !== "object" || !callId || !record) return true;
  const clean = cleanLaneProjectionRecords.get(run)?.get(String(callId));
  return !clean || clean.ref !== record || clean.updatedAt !== record.updatedAt;
}

async function recordLaneOutcome(run, record) {
  const outcome = record.outcome ?? "failure";
  const completedAt = new Date().toISOString();
  const queueWaitMs = Number.isFinite(record.queueWaitMs)
    ? Math.max(0, record.queueWaitMs)
    : durationMs(record.enqueuedAt, record.startedAt);
  let firstResultForRun = false;
  if (outcome === "success" && !run.firstResultAt) {
    run.firstResultAt = completedAt;
    run.timeToFirstResultMs = durationMs(run.startedAt, completedAt);
    firstResultForRun = true;
  }
  if (!record.replayedOutcome && Object.hasOwn(run.laneOutcomes, outcome)) run.laneOutcomes[outcome] += 1;
  if (record.returnedNullDueToFailure) run.droppedLaneCount += 1;
  await appendJournal(run, {
    type: "agent",
    completedAt,
    ...record,
    ...(queueWaitMs !== undefined ? { queueWaitMs } : {}),
  });
  await writeLaneProjection(run, record.callId, {
    enqueuedAt: record.enqueuedAt,
    startedAt: record.startedAt,
    ...(queueWaitMs !== undefined ? { queueWaitMs } : {}),
    status: outcome === "success" ? "completed" : outcome,
    outcome,
    completedAt,
    childID: record.childID,
    title: record.title,
    taskSummary: record.taskSummary,
    model: record.model,
    agent: record.agent,
    role: record.role,
    timeoutMs: record.timeoutMs,
    worktreePath: record.worktreePath,
    integrationLane: record.integrationLane,
    salvage: record.salvage,
    recoveredFromCheckpoint: record.recoveredFromCheckpoint,
    checkpointSignatureHash: record.checkpointSignatureHash,
    checkpointCapturedAt: record.checkpointCapturedAt,
    matchedViaSignatureFallback: record.matchedViaSignatureFallback,
    originalCallId: record.originalCallId,
    errorSummary: record.errorSummary,
    // Failure-class taxonomy (transient/transient_exhausted/validation_exhausted/terminal) so workflow_status
    // can show WHY a lane failed and whether a retry/resume might help, distinct from the
    // coarse LANE_OUTCOMES bucket. Present only on failed lanes.
    failureClass: record.failureClass,
    retryable: record.retryable,
    correctiveAttempts: record.correctiveAttempts,
    tokens: record.tokens,
    cost: record.cost,
  });
  if (firstResultForRun && run.firstResultEventEmitted !== true) {
    run.firstResultEventEmitted = true;
    await appendEvent(run, {
      type: "run.first_result",
      callId: record.callId,
      firstResultAt: run.firstResultAt,
      timeToFirstResultMs: run.timeToFirstResultMs,
    });
  }
}

// Synthetic, explicit-opt-in journal entry for an orphaned lane whose result was recovered
// from a persisted child transcript (workflow_salvage). Mirrors recordLaneOutcome's journal +
// lane-projection shape but operates on a durable runDir (the owning run is interrupted, not
// in-memory), tags every record with salvagedFromTranscript: true, and never touches in-memory
// lane-outcome counters, state.json, integration ledgers, or worktrees. The result field is
// stored raw in journal.jsonl (consistent with normal lane results); it is intentionally NOT
// projected into lanes/<callId>.json (matching recordLaneOutcome, which keeps result out of the
// projection). salvageValidation records that the original AJV schema was unavailable, so the
// outcome was decided by conservative JSON-structural validation only.
async function writeSalvagedLaneOutcome(runDir, callId, record) {
  if (!runDir) throw new Error("writeSalvagedLaneOutcome requires runDir");
  if (!callId) throw new Error("writeSalvagedLaneOutcome requires callId");
  const syntheticRun = { id: record.runId, dir: runDir, laneRecords: new Map(), journalRecords: 0 };
  const completedAt = new Date().toISOString();
  const outcome = record.outcome === "success" ? "success" : "failure";
  await appendJournal(syntheticRun, {
    type: "agent",
    completedAt,
    salvagedFromTranscript: true,
    callId,
    signatureHash: record.signatureHash,
    outcome,
    childID: record.childID,
    title: record.title,
    taskSummary: record.taskSummary,
    startedAt: record.startedAt,
    model: record.model,
    agent: record.agent,
    role: record.role,
    timeoutMs: record.timeoutMs,
    permissionPolicy: record.permissionPolicy,
    result: record.result,
    errorSummary: record.errorSummary,
    salvageValidation: record.salvageValidation,
  });
  await writeLaneProjection(syntheticRun, callId, {
    status: outcome === "success" ? "completed" : outcome,
    outcome,
    completedAt,
    salvagedFromTranscript: true,
    childID: record.childID,
    title: record.title,
    taskSummary: record.taskSummary,
    model: record.model,
    agent: record.agent,
    role: record.role,
    timeoutMs: record.timeoutMs,
    permissionPolicy: record.permissionPolicy,
    salvage: record.salvage,
    errorSummary: record.errorSummary,
  });
  return { callId, outcome, completedAt };
}

async function recoverySummary(runDir, state = {}) {
  const domain = await readJsonlLedger(ledgerFilePath(runDir, "domain-ledger.jsonl"));
  const validation = await readJsonlLedger(ledgerFilePath(runDir, "validation-ledger.jsonl"));
  const apply = await readJsonlLedger(ledgerFilePath(runDir, "apply-ledger.jsonl"));
  const applyStarted = apply.some((record) => record.phase === "started" || record.phase === "before-write");
  const applyTerminal = apply.some((record) => record.phase === "completed" || record.phase === "failed");
  return {
    generatedAt: new Date().toISOString(),
    ledgers: await durableLedgerSummary(runDir),
    incompleteDomainMutations: incompleteLedgerKeys(domain, "mutationKey"),
    incompleteValidationKeys: incompleteLedgerKeys(validation, "validationKey"),
    incompleteApply: applyStarted && !applyTerminal,
    worktreeCounts: {
      edit: Array.isArray(state.editWorktrees) ? state.editWorktrees.length : 0,
      integration: Array.isArray(state.integrationWorktrees) ? state.integrationWorktrees.length : 0,
      lanes: Array.isArray(state.integrationPlan?.lanes) ? state.integrationPlan.lanes.length : 0,
    },
  };
}

async function doWriteLaneProjection(run, callId, update = {}) {
  if (!callId) return undefined;
  const lanesDir = path.join(run.dir, "lanes");
  await ensurePrivateDir(lanesDir);
  const filePath = path.join(lanesDir, `${safeProjectionName(callId)}.json`);
  const existing = run.laneRecords?.get(callId) ?? await readJsonFile(filePath, {});
  const record = {
    ...existing,
    runId: run.id,
    callId,
    ...redactValue(update, { maxString: MAX_STATUS_STRING_CHARS }),
    updatedAt: new Date().toISOString(),
  };
  await writeJsonAtomic(filePath, record);
  if (!run.laneRecords) run.laneRecords = new Map();
  run.laneRecords.set(callId, record);
  markLaneProjectionClean(run, callId, record);
  return record;
}

async function writeLaneProjection(run, callId, update = {}) {
  if (!callId) return undefined;
  if (!run || typeof run !== "object") return await doWriteLaneProjection(run, callId, update);
  let chains = laneProjectionWriteChains.get(run);
  if (!chains) {
    chains = new Map();
    laneProjectionWriteChains.set(run, chains);
  }
  const key = String(callId);
  const previous = chains.get(key) ?? Promise.resolve();
  const current = previous.catch(() => {}).then(() => doWriteLaneProjection(run, callId, update));
  chains.set(key, current.catch(() => {}));
  return await current;
}

async function writeDurableProjections(run, state) {
  const worktrees = {
    runId: run.id,
    updatedAt: new Date().toISOString(),
    edit: run.editWorktrees ?? [],
    integration: run.integrationWorktrees ?? [],
    lanes: run.integrationPlan?.lanes ?? [],
  };
  await writeJsonAtomic(path.join(run.dir, "worktrees.json"), worktrees);
  await ensurePrivateDir(path.join(run.dir, "waves"));
  await writeJsonAtomic(path.join(run.dir, "waves", "index.json"), {
    runId: run.id,
    updatedAt: new Date().toISOString(),
    currentPhase: run.currentPhase,
    agentsStarted: run.agentsStarted,
    maxAgents: run.maxAgents,
    concurrency: run.concurrency,
    laneOutcomes: run.laneOutcomes,
    droppedLaneCount: run.droppedLaneCount,
  });
  if (run.laneRecords instanceof Map) {
    for (const [callId, record] of run.laneRecords) {
      if (laneProjectionNeedsFlush(run, callId, record)) await writeLaneProjection(run, callId, record);
    }
  }
  if (!ACTIVE_STATUSES.has(state.status) || state.status === "awaiting-diff-approval" || state.status === "review-required") {
    const closeout = {
      runId: run.id,
      status: state.status,
      finishedAt: state.finishedAt,
      resultPath: state.resultPath,
      errorSummary: state.error ? truncateText(state.error, MAX_STATUS_STRING_CHARS) : undefined,
      operatorMetrics: state.operatorMetrics,
      durability: state.durability,
    };
    await writeJsonAtomic(path.join(run.dir, "closeout.json"), closeout);
  }
}

async function readLaneProjections(runDir, state = {}) {
  const fallback = Array.isArray(state?.laneRecords) ? state.laneRecords.filter((record) => record && record.callId) : [];
  try {
    const lanesDir = path.join(runDir, "lanes");
    const dirents = await fs.readdir(lanesDir, { withFileTypes: true });
    const records = [];
    for (const dirent of dirents) {
      if (!dirent.isFile() || !dirent.name.endsWith(".json")) continue;
      // Skip durable per-lane checkpoint files (lanes/<callId>.request.json /
      // lanes/<callId>.result.json, 234m.1). They share the .json suffix but are crash-window
      // captures, not lane projections: including them would duplicate callIds and pollute the
      // salvage-candidate scan + status lane list.
      if (dirent.name.endsWith(".request.json") || dirent.name.endsWith(".result.json")) continue;
      const record = await readJsonFile(path.join(lanesDir, dirent.name), null);
      if (record && record.callId) records.push(record);
    }
    if (records.length === 0) return fallback;
    const seen = new Set(records.map((record) => record.callId));
    for (const record of fallback) if (!seen.has(record.callId)) records.push(record);
    return records;
  } catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw error;
  }
}

// Durable per-lane checkpoint files written around session.prompt (workflow-native lane
// checkpointing, 234m.1). `lanes/<callId>.request.json` captures prompt-time intent
// (callId/signatureHash/prompt+schema hashes/childID) before the prompt is issued;
// `lanes/<callId>.result.json` captures the controller's validated result immediately after the
// prompt returns and before integration/journal append. On resume, a same-signature result
// checkpoint lets runChildAgent recover a completed result from its OWN store without re-running
// the lane or reading any transcript -- the transcript-independent recovery path that makes
// salvage (234m.3) rarely necessary. journal.jsonl remains authoritative; these files are an
// earlier, narrower durable capture that narrows the crash window between prompt-return and
// recordLaneOutcome, and they are removed once the journal entry supersedes them. Checkpoint
// writes are best-effort (callers try/catch): a checkpoint failure must never break a run.
//
// File naming mirrors writeLaneProjection: the callId is passed through safeProjectionName so a
// callId containing "/" or ":" (parallel/*, drain:...) becomes a safe single filename rather
// than a nested path. The `<kind>` suffix (request|result) keeps checkpoints distinct from the
// authoritative `lanes/<callId>.json` projection; readLaneProjections explicitly skips these
// suffixes so checkpoints never pollute the lane-projection list or salvage-candidate scan.
async function writeLaneCheckpoint(runDir, callId, kind, value) {
  if (!runDir || !callId) throw new Error("writeLaneCheckpoint requires runDir and callId");
  if (kind !== "request" && kind !== "result") {
    throw new Error(`writeLaneCheckpoint kind must be "request" or "result", got ${String(kind)}`);
  }
  const lanesDir = path.join(runDir, "lanes");
  await ensurePrivateDir(lanesDir);
  const filePath = path.join(lanesDir, `${safeProjectionName(callId)}.${kind}.json`);
  await writeJsonAtomic(filePath, redactDurableValue(value));
  return filePath;
}

// Reads the resume-relevant result checkpoint. Returns the parsed record when the file exists and
// carries the expected callId, otherwise null (ENOENT / unparseable / callId mismatch). Never
// throws: the resume branch consults this in the hot path, so any read failure is treated as
// "no checkpoint" and the lane falls through to the authoritative journal check / re-run. Does
// NOT validate the signature; the resume branch compares checkpoint.signatureHash to the lane's
// expected signature so a stale/mismatched checkpoint is ignored rather than trusted.
async function readLaneResultCheckpoint(runDir, callId) {
  try {
    if (!runDir || !callId) return null;
    const filePath = path.join(runDir, "lanes", `${safeProjectionName(callId)}.result.json`);
    const record = await readJsonFile(filePath, null);
    return record && record.callId === callId ? record : null;
  } catch {
    return null;
  }
}

async function readLaneRequestCheckpoint(runDir, callId) {
  try {
    if (!runDir || !callId) return null;
    const filePath = path.join(runDir, "lanes", `${safeProjectionName(callId)}.request.json`);
    const record = await readJsonFile(filePath, null);
    return record && record.callId === callId ? record : null;
  } catch {
    return null;
  }
}

// Best-effort removal of a checkpoint file once the journal entry has superseded it (the journal
// is authoritative). Swallows ENOENT and all other errors: a lingering checkpoint is a benign
// degradation (on the next resume it would emit cache.checkpoint_hit instead of cache.hit for that
// one lane), so a removal failure must never break a run.
async function removeLaneCheckpoint(runDir, callId, kind) {
  try {
    if (!runDir || !callId) return;
    if (kind !== "request" && kind !== "result") return;
    const filePath = path.join(runDir, "lanes", `${safeProjectionName(callId)}.${kind}.json`);
    await fs.rm(filePath, { force: true });
  } catch {
    // Best-effort: a removal failure leaves a narrow-window artifact that the resume path ignores.
  }
}

// Salvage candidates are mid-flight lanes (status "running" with a childID) whose owning
// process died before recording a success journal entry. The child transcript may still
// hold the lane result, so read-only status names each orphan and emits a workflow_salvage
// hint. Computed purely from durable projections + journal; no mutation, no resume effect.
async function computeSalvageCandidates(runDir, state = {}) {
  const lanes = await readLaneProjections(runDir, state);
  if (lanes.length === 0) return [];
  const journal = await loadJournal(runDir);
  const candidates = [];
  const runId = state?.id || "<this run>";
  for (const lane of lanes) {
    const callId = lane?.callId;
    const childID = lane?.childID;
    if (!callId || !childID || lane.status !== "running") continue;
    const completed = journal.get(callId);
    if (completed && completed.outcome === "success") continue;
    candidates.push({
      callId,
      childID,
      hint: `salvage via workflow_salvage runId=${runId} (preview first); raw child transcript childID=${childID}`,
    });
  }
  return candidates;
}

// Strictly read-only: attaches a best-effort salvageCandidates array to interrupted/stale-active
// entries only. Never mutates files or run state; never changes resume behavior.
async function attachSalvageCandidates(entry) {
  if (entry?.kind !== "valid") return entry;
  const status = entry.state?.status;
  if (status !== "interrupted" && status !== "stale-active") return entry;
  try {
    entry.salvageCandidates = await computeSalvageCandidates(entry.dir, entry.state);
  } catch {
    entry.salvageCandidates = [];
  }
  return entry;
}

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
};
