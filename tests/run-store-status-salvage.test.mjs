import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  activeLaneSummaries,
  compactStatusForEntry,
  fullStatusForEntry,
  readRunEntry,
  STALE_PROGRESS_THRESHOLD_MS,
  summarizeEntries,
} from "../workflow-kernel/run-store-status-format.js";
import { computeLastProgressAt, writeState as writeDurableState } from "../workflow-kernel/run-store-state.js";
import { computeSalvageCandidates, writeLaneProjection } from "../workflow-kernel/run-store-projections.js";
import { runDirForRoot, writeJsonAtomic } from "../workflow-kernel/run-store-fs.js";

async function tempDir(name) {
  return await fs.mkdtemp(path.join(os.tmpdir(), `${name}-`));
}

async function snapshotTree(dir) {
  const snap = {};
  async function walk(d, rel = "") {
    const dirents = await fs.readdir(d, { withFileTypes: true });
    for (const entry of dirents) {
      const full = path.join(d, entry.name);
      const relPath = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        await walk(full, relPath);
      } else {
        snap[relPath] = await fs.readFile(full, "utf8");
      }
    }
  }
  await walk(dir);
  return snap;
}

function writeState(dir, state) {
  return writeJsonAtomic(path.join(dir, "state.json"), state);
}

async function writeLane(dir, runId, callId, projection) {
  await writeLaneProjection({ id: runId, dir, laneRecords: new Map() }, callId, projection);
}

function appendJournalSuccess(dir, callId, overrides = {}) {
  return fs.appendFile(
    path.join(dir, "journal.jsonl"),
    `${JSON.stringify({ type: "agent", callId, outcome: "success", completedAt: "2026-06-24T00:01:00.000Z", ...overrides })}\n`,
  );
}

// A lane that died mid-flight: status "running" + childID, and no success journal entry.
const ORPHAN = { callId: "lane:orphan", childID: "child-session-orphan" };
// A lane that finished and was recorded: must NOT be flagged as salvage.
const DONE = { callId: "lane:done", childID: "child-session-done" };

test("computeSalvageCandidates flags only running lanes with a childID and no success journal entry", async () => {
  const root = await tempDir("salvage-compute");
  const runId = "salvage-compute-run";
  const dir = runDirForRoot(root, runId);
  await fs.mkdir(dir, { recursive: true });

  await writeLane(dir, runId, ORPHAN.callId, {
    status: "running",
    childID: ORPHAN.childID,
    title: "secret-title",
    taskSummary: "secret-summary",
    model: "secret-model",
  });
  await writeLane(dir, runId, DONE.callId, { status: "completed", childID: DONE.childID, outcome: "success" });
  await appendJournalSuccess(dir, DONE.callId);
  // Running lane without a childID: not salvageable (no transcript to inspect).
  await writeLane(dir, runId, "lane:nokid", { status: "running" });
  // A running lane that nonetheless recorded a success journal entry: not orphaned.
  await writeLane(dir, runId, "lane:running-but-done", { status: "running", childID: "child-redundant" });
  await appendJournalSuccess(dir, "lane:running-but-done");

  const candidates = await computeSalvageCandidates(dir, { laneRecords: [] });

  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].callId, ORPHAN.callId);
  assert.equal(candidates[0].childID, ORPHAN.childID);
  assert.match(candidates[0].hint, /workflow_salvage runId=/);
  assert.match(candidates[0].hint, /childID=child-session-orphan/);
  // Masking: expose only callId/childID/hint, never the lane's title/summary/model.
  assert.deepEqual(Object.keys(candidates[0]).sort(), ["callId", "childID", "hint"]);
});

test("active lane summaries expose bounded progress without terminal lanes", () => {
  const startedAt = "2026-06-24T00:00:00.000Z";
  const updatedAt = "2026-06-24T00:02:00.000Z";
  const state = {
    id: "active-lane-run",
    status: "running",
    startedAt,
    activeAgents: 1,
    laneRecords: [
      {
        callId: "lane:active",
        status: "running",
        childID: "child-active",
        title: "Active lane",
        taskSummary: "Inspect bounded progress",
        model: "provider/model",
        role: "reviewer",
        startedAt,
        updatedAt,
      },
      { callId: "lane:done", status: "success", outcome: "success", startedAt, updatedAt },
    ],
  };

  const active = activeLaneSummaries(state, Date.parse("2026-06-24T00:05:00.000Z"));
  assert.equal(active.length, 1);
  assert.deepEqual(active[0], {
    callId: "lane:active",
    status: "running",
    title: "Active lane",
    taskSummary: "Inspect bounded progress",
    childID: "child-active",
    role: "reviewer",
    model: "provider/model",
    startedAt,
    lastActivityAt: updatedAt,
    ageMs: 5 * 60 * 1000,
    idleMs: 3 * 60 * 1000,
    progressEmitted: true,
  });

  const compact = compactStatusForEntry({ kind: "valid", id: state.id, status: state.status, state });
  assert.equal(compact.activeLaneCount, 1);
  assert.equal(compact.activeLanes[0].callId, "lane:active");
});

test("lastProgressAt considers durable event activity beyond lane state transitions", () => {
  const run = {
    startedAt: "2026-06-24T00:00:00.000Z",
    lastEventAt: "2026-06-24T00:03:00.000Z",
    laneRecords: [
      { callId: "lane:active", status: "running", startedAt: "2026-06-24T00:00:30.000Z", updatedAt: "2026-06-24T00:01:00.000Z" },
    ],
  };

  assert.equal(computeLastProgressAt(run), "2026-06-24T00:03:00.000Z");
});

test("reconciled interrupted run surfaces orphaned lane childIDs with a workflow_salvage hint", async () => {
  const root = await tempDir("salvage-interrupted");
  const runId = "salvage-interrupted-run";
  const dir = runDirForRoot(root, runId);
  await fs.mkdir(dir, { recursive: true });

  await writeState(dir, {
    id: runId,
    status: "running",
    startedAt: "2026-06-24T00:00:00.000Z",
    process: { pid: 999999999, startTime: 999999999 },
    laneRecords: [],
  });
  await writeLane(dir, runId, ORPHAN.callId, { status: "running", childID: ORPHAN.childID, title: "secret" });
  await writeLane(dir, runId, DONE.callId, { status: "completed", childID: DONE.childID, outcome: "success" });
  await appendJournalSuccess(dir, DONE.callId);

  const entry = await readRunEntry(root, runId, { reconcile: true });
  assert.equal(entry.status, "interrupted");

  const salvage = entry.salvageCandidates ?? [];
  assert.equal(salvage.length, 1);
  assert.equal(salvage[0].callId, ORPHAN.callId);
  assert.equal(salvage[0].childID, ORPHAN.childID);
  assert.match(salvage[0].hint, /workflow_salvage runId=/);
  assert.match(salvage[0].hint, /childID=child-session-orphan/);
  assert.deepEqual(Object.keys(salvage[0]).sort(), ["callId", "childID", "hint"]);
});

test("stale-active status is strictly read-only and still surfaces salvage candidates", async () => {
  const root = await tempDir("salvage-stale-active");
  const runId = "salvage-stale-run";
  const dir = runDirForRoot(root, runId);
  await fs.mkdir(dir, { recursive: true });

  await writeState(dir, {
    id: runId,
    status: "running",
    startedAt: "2026-06-24T00:00:00.000Z",
    process: { pid: 999999999, startTime: 999999999 },
    laneRecords: [],
  });
  await writeLane(dir, runId, ORPHAN.callId, { status: "running", childID: ORPHAN.childID });

  const before = await snapshotTree(dir);

  // No reconcile: the stale-active branch must not write anything.
  const entry = await readRunEntry(root, runId);
  assert.equal(entry.status, "stale-active");
  assert.equal(entry.salvageCandidates.length, 1);
  assert.equal(entry.salvageCandidates[0].childID, ORPHAN.childID);

  const after = await snapshotTree(dir);
  assert.deepEqual(after, before, "stale-active status must not mutate any run files");
});

test("already-interrupted re-read surfaces salvage candidates read-only", async () => {
  const root = await tempDir("salvage-reread");
  const runId = "salvage-reread-run";
  const dir = runDirForRoot(root, runId);
  await fs.mkdir(dir, { recursive: true });

  // Status already interrupted from a prior reconcile (not an active status), so the
  // active-status branch is skipped entirely and the final return path is used.
  await writeState(dir, {
    id: runId,
    status: "interrupted",
    startedAt: "2026-06-24T00:00:00.000Z",
    finishedAt: "2026-06-24T00:02:00.000Z",
    laneRecords: [],
  });
  await writeLane(dir, runId, ORPHAN.callId, { status: "running", childID: ORPHAN.childID });

  const before = await snapshotTree(dir);
  const entry = await readRunEntry(root, runId);
  assert.equal(entry.status, "interrupted");
  assert.equal(entry.salvageCandidates.length, 1);
  assert.equal(entry.salvageCandidates[0].callId, ORPHAN.callId);
  const after = await snapshotTree(dir);
  assert.deepEqual(after, before, "re-reading an interrupted run must not mutate any run files");
});

test("compact, full, and summary status each surface the salvage hint", async () => {
  const root = await tempDir("salvage-surfaces");
  const runId = "salvage-surfaces-run";
  const dir = runDirForRoot(root, runId);
  await fs.mkdir(dir, { recursive: true });

  await writeState(dir, {
    id: runId,
    status: "interrupted",
    startedAt: "2026-06-24T00:00:00.000Z",
    laneRecords: [],
  });
  await writeLane(dir, runId, ORPHAN.callId, { status: "running", childID: ORPHAN.childID });

  const entry = await readRunEntry(root, runId);

  const compact = compactStatusForEntry(entry);
  assert.equal(compact.status, "interrupted");
  assert.equal(compact.salvageCandidates.length, 1);
  assert.equal(compact.salvageCandidates[0].childID, ORPHAN.childID);
  assert.match(compact.salvageCandidates[0].hint, /workflow_salvage/);

  const full = await fullStatusForEntry(entry);
  assert.equal(full.status, "interrupted");
  assert.equal(full.salvageCandidates.length, 1);
  assert.equal(full.salvageCandidates[0].callId, ORPHAN.callId);

  const summary = summarizeEntries([entry]);
  assert.match(summary, /salvage lane:orphan/);
  assert.match(summary, /workflow_salvage runId=/);
});

// opencode-workflows-jbs3.8: per-lane failure visibility + no-progress staleness signal in the
// DEFAULT (compact) status, so an agent need not pull detail=full to see which lane failed/why
// or to detect a wedged run.
test("compact status on a completed-with-failed-lanes run names the failing lanes and error class", async () => {
  const root = await tempDir("compact-lane-failures");
  const runId = "compact-lane-failures-run";
  const dir = runDirForRoot(root, runId);
  await fs.mkdir(dir, { recursive: true });

  await writeState(dir, {
    id: runId,
    status: "completed",
    startedAt: "2026-06-24T00:00:00.000Z",
    finishedAt: "2026-06-24T00:05:00.000Z",
    laneOutcomes: { success: 1, failure: 1, timeout: 1, cancelled: 0, budget_stopped: 0 },
    laneRecords: [
      { callId: "lane:ok", status: "completed", outcome: "success", role: "worker", model: "anthropic/claude", updatedAt: "2026-06-24T00:02:00.000Z" },
      {
        callId: "lane:bad-model",
        status: "failure",
        outcome: "failure",
        role: "finder",
        model: "bogus/model-id",
        failureClass: "terminal",
        retryable: false,
        errorSummary: "model not found: bogus/model-id",
        updatedAt: "2026-06-24T00:03:00.000Z",
      },
      {
        callId: "lane:slow",
        status: "timeout",
        outcome: "timeout",
        role: "verifier",
        model: "anthropic/claude",
        failureClass: "transient_exhausted",
        retryable: true,
        errorSummary: "lane exceeded timeout",
        updatedAt: "2026-06-24T00:04:30.000Z",
      },
    ],
  });

  const entry = await readRunEntry(root, runId);
  const compact = compactStatusForEntry(entry);

  assert.ok(Array.isArray(compact.laneFailures), "compact must carry a laneFailures array");
  assert.equal(compact.laneFailures.length, 2, "only failed lanes appear; the success lane is excluded");
  const byCallId = Object.fromEntries(compact.laneFailures.map((lane) => [lane.callId, lane]));
  assert.equal(byCallId["lane:bad-model"].failureClass, "terminal");
  assert.equal(byCallId["lane:bad-model"].role, "finder");
  assert.equal(byCallId["lane:bad-model"].model, "bogus/model-id");
  assert.equal(byCallId["lane:bad-model"].outcome, "failure");
  assert.match(byCallId["lane:bad-model"].errorSummary, /model not found/);
  assert.equal(byCallId["lane:slow"].failureClass, "transient_exhausted");
  assert.equal(byCallId["lane:slow"].outcome, "timeout");
  // The trimmed projection must never carry raw lane title/summary/result.
  for (const lane of compact.laneFailures) {
    assert.deepEqual(
      Object.keys(lane).sort(),
      ["callId", "errorSummary", "failureClass", "model", "outcome", "retryable", "role"],
    );
  }

  // Human text view mirrors it without expanding to detail=full.
  const summary = summarizeEntries([entry]);
  assert.match(summary, /lane-failed lane:bad-model \[failure\/terminal\]/);
  assert.match(summary, /lane-failed lane:slow \[timeout\/transient_exhausted\]/);
});

test("compact status exposes lastProgressAt + a documented staleness threshold for stall detection", async () => {
  const root = await tempDir("compact-staleness");
  const dir = (id) => runDirForRoot(root, id);

  // An ACTIVE (running) run whose last lane progress is far in the past => stale.
  const stalledId = "compact-staleness-stalled";
  await fs.mkdir(dir(stalledId), { recursive: true });
  await writeState(dir(stalledId), {
    id: stalledId,
    status: "running",
    startedAt: "2026-06-24T00:00:00.000Z",
    laneRecords: [{ callId: "lane:1", status: "running", childID: "c1", updatedAt: "2000-01-01T00:00:00.000Z", startedAt: "2000-01-01T00:00:00.000Z" }],
  });
  const stalledEntry = await readRunEntry(root, stalledId);
  const stalledCompact = compactStatusForEntry(stalledEntry);
  assert.equal(stalledCompact.lastProgressAt, "2026-06-24T00:00:00.000Z", "lastProgressAt is the most recent lane/run timestamp");
  assert.equal(stalledCompact.staleness.thresholdMs, STALE_PROGRESS_THRESHOLD_MS, "the staleness threshold is documented in the payload");
  assert.ok(stalledCompact.staleness.ageMs > STALE_PROGRESS_THRESHOLD_MS, "ageMs must exceed the threshold for a long-idle run");
  assert.equal(stalledCompact.staleness.stale, true, "an active run idle past the threshold is reported stale");
  assert.match(summarizeEntries([stalledEntry]), /STALE no-progress>/);

  // A run with very recent lane progress is NOT stale even though it is active.
  const freshId = "compact-staleness-fresh";
  await fs.mkdir(dir(freshId), { recursive: true });
  const now = new Date().toISOString();
  await writeState(dir(freshId), {
    id: freshId,
    status: "running",
    startedAt: now,
    laneRecords: [{ callId: "lane:1", status: "running", childID: "c1", updatedAt: now }],
  });
  const freshCompact = compactStatusForEntry(await readRunEntry(root, freshId));
  assert.equal(freshCompact.staleness.stale, false, "a run with recent progress is not stale");

  // A terminal (completed) run is never "stale" regardless of how old its progress is.
  const doneId = "compact-staleness-done";
  await fs.mkdir(dir(doneId), { recursive: true });
  await writeState(dir(doneId), {
    id: doneId,
    status: "completed",
    startedAt: "2000-01-01T00:00:00.000Z",
    finishedAt: "2000-01-01T00:10:00.000Z",
    laneRecords: [{ callId: "lane:1", status: "completed", outcome: "success", updatedAt: "2000-01-01T00:09:00.000Z" }],
  });
  const doneCompact = compactStatusForEntry(await readRunEntry(root, doneId));
  assert.equal(doneCompact.staleness.stale, false, "terminal runs are never reported stale");
  assert.equal(doneCompact.staleness.lastProgressAt, "2000-01-01T00:09:00.000Z");
});

test("writeState persists lastProgressAt advancing on each lane state change", async () => {
  const root = await tempDir("laststate-progress");
  const runId = "laststate-progress-run";
  const dir = runDirForRoot(root, runId);
  await fs.mkdir(dir, { recursive: true });

  const run = {
    id: runId,
    dir,
    status: "running",
    startedAt: "2026-06-24T00:00:00.000Z",
    laneRecords: new Map(),
    laneOutcomes: { success: 0, failure: 0, cancelled: 0, timeout: 0, budget_stopped: 0 },
    droppedLaneCount: 0,
    tokens: { input: 0, output: 0, reasoning: 0 },
    replayedTokens: { input: 0, output: 0, reasoning: 0 },
    cost: 0,
    replayedCost: 0,
  };

  await writeDurableState(run);
  let persisted = JSON.parse(await fs.readFile(path.join(dir, "state.json"), "utf8"));
  assert.equal(persisted.lastProgressAt, "2026-06-24T00:00:00.000Z", "with no lanes the run start is the baseline");

  run.laneRecords.set("lane:1", { callId: "lane:1", status: "completed", outcome: "success", updatedAt: "2026-06-24T00:04:00.000Z" });
  await writeDurableState(run);
  persisted = JSON.parse(await fs.readFile(path.join(dir, "state.json"), "utf8"));
  assert.equal(persisted.lastProgressAt, "2026-06-24T00:04:00.000Z", "a lane state change advances lastProgressAt");

  // computeLastProgressAt takes the latest of run start/resume and any lane timestamp; resume
  // counts as progress, and a later lane update wins over both.
  assert.equal(
    computeLastProgressAt({
      startedAt: "2026-06-24T00:00:00.000Z",
      resumedAt: "2026-06-24T00:02:00.000Z",
      laneRecords: [{ callId: "lane:1", updatedAt: "2026-06-24T00:06:00.000Z" }],
    }),
    "2026-06-24T00:06:00.000Z",
  );
});

test("a fully completed run surfaces no salvage candidates", async () => {
  const root = await tempDir("salvage-none");
  const runId = "salvage-none-run";
  const dir = runDirForRoot(root, runId);
  await fs.mkdir(dir, { recursive: true });

  await writeState(dir, { id: runId, status: "completed", startedAt: "2026-06-24T00:00:00.000Z" });
  await writeLane(dir, runId, DONE.callId, { status: "completed", childID: DONE.childID, outcome: "success" });
  await appendJournalSuccess(dir, DONE.callId);

  const entry = await readRunEntry(root, runId);
  assert.equal(entry.status, "completed");
  assert.equal(entry.salvageCandidates, undefined, "non-interrupted runs carry no salvage candidates");

  const compact = compactStatusForEntry(entry);
  assert.equal(compact.salvageCandidates, undefined);
  const full = await fullStatusForEntry(entry);
  assert.equal(full.salvageCandidates, undefined);
});
