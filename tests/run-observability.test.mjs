import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { appendEvent } from "../workflow-kernel/event-journal.js";
import { recordRecentLog } from "../workflow-kernel/run-observability.js";
import { writeState } from "../workflow-kernel/run-store-state.js";

async function tempDir(name) {
  return await fs.mkdtemp(path.join(os.tmpdir(), `${name}-`));
}

function makeRun(dir, overrides = {}) {
  return {
    id: "observability-run",
    dir,
    eventCount: 0,
    journalRecords: 0,
    diagnostics: {},
    ...overrides,
  };
}

function makeStateRun(dir, overrides = {}) {
  return {
    id: "observability-state-run",
    dir,
    status: "running",
    sourcePath: "inline",
    sourceHash: "source-hash",
    meta: { name: "observability" },
    authority: {},
    argsPreview: "null",
    startedAt: "2026-07-07T00:00:00.000Z",
    currentPhase: "verify",
    agentsStarted: 0,
    maxAgents: 1,
    concurrency: 1,
    laneTimeoutMs: 1_000,
    maxRuntimeMs: undefined,
    defaultChildModel: "test/model",
    activeAgents: 0,
    waitingAgents: [],
    tokens: { input: 0, output: 0, reasoning: 0 },
    replayedTokens: { input: 0, output: 0, reasoning: 0 },
    cost: 0,
    replayedCost: 0,
    cacheStats: { hits: 0, misses: 0, invalidated: 0 },
    budgetCeilings: {},
    autoApproved: undefined,
    laneOutcomes: { success: 0, failure: 0, cancelled: 0, timeout: 0, budget_stopped: 0 },
    droppedLaneCount: 0,
    capabilities: {},
    diagnostics: {},
    laneRecords: new Map(),
    nestedSnapshots: new Map(),
    editWorktrees: [],
    integrationWorktrees: [],
    background: false,
    ...overrides,
  };
}

test("appendEvent invokes run.eventSink after durable append without changing events.jsonl", async () => {
  const dir = await tempDir("workflow-event-sink");
  let seen;
  const run = makeRun(dir, {
    eventSink(record, sinkRun) {
      seen = { record, sinkRun };
    },
  });

  await appendEvent(run, { type: "phase", phase: "verify" });

  const raw = await fs.readFile(path.join(dir, "events.jsonl"), "utf8");
  const lines = raw.trim().split("\n");
  assert.equal(lines.length, 1);
  const persisted = JSON.parse(lines[0]);
  assert.equal(persisted.type, "phase");
  assert.equal(persisted.phase, "verify");
  assert.deepEqual(seen.record, persisted);
  assert.equal(seen.sinkRun, run);
});

test("appendEvent swallows eventSink throw and absent sink paths", async () => {
  const dir = await tempDir("workflow-event-sink-errors");
  const run = makeRun(dir, {
    eventSink() {
      throw new Error("toast sink failed");
    },
  });

  await appendEvent(run, { type: "log", message: "one" });
  run.eventSink = undefined;
  await appendEvent(run, { type: "log", message: "two" });

  const raw = await fs.readFile(path.join(dir, "events.jsonl"), "utf8");
  assert.equal(raw.trim().split("\n").length, 2);
});

test("recordRecentLog keeps the newest three narrator messages in order", () => {
  const run = {};
  assert.deepEqual(recordRecentLog(run, ""), []);
  recordRecentLog(run, "one");
  recordRecentLog(run, "two");
  recordRecentLog(run, "three");
  recordRecentLog(run, "four");
  assert.deepEqual(run.recentLogs, ["two", "three", "four"]);
});

test("writeState persists recentLogs but never serializes eventSink", async () => {
  const dir = await tempDir("workflow-recent-logs-state");
  const run = makeStateRun(dir, {
    recentLogs: ["old", "one", "two", "three"],
    eventSink() {},
  });

  await writeState(run);

  const state = JSON.parse(await fs.readFile(path.join(dir, "state.json"), "utf8"));
  assert.deepEqual(state.recentLogs, ["one", "two", "three"]);
  assert.equal(Object.hasOwn(state, "eventSink"), false);
});
