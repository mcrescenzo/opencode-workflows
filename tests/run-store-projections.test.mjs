import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { DURABLE_STATE_VERSION } from "../workflow-kernel/constants.js";
import {
  appendIntegrationLedger,
  appendValidationLedger,
  appendLedger,
} from "../workflow-kernel/event-journal.js";
import { PRIVATE_DIR_MODE, PRIVATE_FILE_MODE, safeProjectionName, writeJsonAtomic } from "../workflow-kernel/run-store-fs.js";
import { acquireWorkflowLock, lockPathForRun } from "../workflow-kernel/run-store-locks.js";
import { writeState, __setWriteStateTestHook } from "../workflow-kernel/run-store-state.js";
import { writeLaneProjection } from "../workflow-kernel/run-store-projections.js";

// Durable state projection + persistence regressions split out of durable-state.test.mjs
// (opencode-workflows-fnop.9): writeState durable output and serialization, lane-projection
// concurrent-write and clean-rewrite behavior, and the atomic-write (writeJsonAtomic) + private
// file/directory mode contracts that back all run-store artifacts.

async function tempDir(name) {
  return await fs.mkdtemp(path.join(os.tmpdir(), `${name}-`));
}

function zeroTokens() {
  return { input: 0, output: 0, reasoning: 0 };
}

function makeRun(dir, overrides = {}) {
  return {
    id: "durable-run",
    dir,
    status: "running",
    sourcePath: "inline",
    sourceHash: "source-hash",
    meta: { name: "durable-test" },
    authority: {},
    argsPreview: "null",
    startedAt: "2026-06-15T00:00:00.000Z",
    resumedAt: undefined,
    finishedAt: undefined,
    currentPhase: "test-phase",
    agentsStarted: 1,
    maxAgents: 2,
    concurrency: 1,
    defaultChildModel: "test/model",
    activeAgents: 0,
    waitingAgents: [],
    tokens: zeroTokens(),
    replayedTokens: zeroTokens(),
    cost: 0,
    replayedCost: 0,
    cacheStats: { hits: 0, misses: 0, invalidated: 0 },
    budgetCeilings: {},
    laneOutcomes: { success: 0, failure: 0, cancelled: 0, timeout: 0, budget_stopped: 0 },
    droppedLaneCount: 0,
    capabilities: {},
    diagnostics: {},
    nestedSnapshots: new Map(),
    editWorktrees: [],
    integrationWorktrees: [],
    laneRecords: new Map(),
    background: false,
    ...overrides,
  };
}

test("durable run state writes ledgers and projection files", async () => {
  const dir = await tempDir("workflow-durable-state");
  const run = makeRun(dir, {
    status: "completed",
    finishedAt: "2026-06-15T00:01:00.000Z",
    editWorktrees: [{ callId: "edit:1", path: path.join(dir, "edit") }],
    integrationWorktrees: [{ role: "integration", path: path.join(dir, "integration"), branch: "workflow/integration" }],
    integrationPlan: {
      sourceHash: "source-hash",
      baseCommit: "abc123",
      lanes: [{ callId: "lane:1", laneId: "lane1", committed: true, paths: ["a.txt"] }],
      worktrees: [],
      integrationResult: { status: "merged" },
      patches: [],
    },
  });

  await appendIntegrationLedger(run, { phase: "lane-committed", callId: "lane:1" });
  await appendValidationLedger(run, { phase: "started", validationKey: "central" });
  await appendValidationLedger(run, { phase: "completed", validationKey: "central" });
  await writeLaneProjection(run, "lane:1", { status: "running", startedAt: "2026-06-15T00:00:10.000Z", taskSummary: "Implement lane one", tokens: { input: 1, output: 2, reasoning: 0 } });
  await writeLaneProjection(run, "lane:1", { status: "completed", outcome: "success", completedAt: "2026-06-15T00:00:20.000Z", tokens: { input: 3, output: 5, reasoning: 1 } });
  await writeState(run);

  const state = JSON.parse(await fs.readFile(path.join(dir, "state.json"), "utf8"));
  assert.equal(state.stateVersion, DURABLE_STATE_VERSION);
  assert.equal(state.durability.ledgers["integration-ledger"].records, 1);
  assert.equal(state.durability.ledgers["validation-ledger"].records, 2);
  assert.equal(state.laneRecords.length, 1);

  const worktrees = JSON.parse(await fs.readFile(path.join(dir, "worktrees.json"), "utf8"));
  assert.equal(worktrees.edit.length, 1);
  assert.equal(worktrees.integration.length, 1);
  assert.equal(worktrees.lanes.length, 1);

  const waves = JSON.parse(await fs.readFile(path.join(dir, "waves", "index.json"), "utf8"));
  assert.equal(waves.currentPhase, "test-phase");

  const lane = JSON.parse(await fs.readFile(path.join(dir, "lanes", "lane_1.json"), "utf8"));
  assert.equal(lane.status, "completed");
  assert.equal(lane.startedAt, "2026-06-15T00:00:10.000Z");
  assert.equal(lane.taskSummary, "Implement lane one");
  assert.deepEqual(lane.tokens, { input: 3, output: 5, reasoning: 1 });

  const closeout = JSON.parse(await fs.readFile(path.join(dir, "closeout.json"), "utf8"));
  assert.equal(closeout.status, "completed");
});

test("writeState serializes concurrent writes so a delayed stale snapshot cannot overwrite a newer state", async () => {
  const dir = await tempDir("workflow-state-write-serial");
  const run = makeRun(dir, { laneRecords: new Map() });
  let hookCalls = 0;
  let releaseFirst;
  const firstPaused = new Promise((resolve) => {
    __setWriteStateTestHook(async ({ state }) => {
      hookCalls += 1;
      if (hookCalls === 1) {
        assert.equal(state.status, "running");
        await new Promise((release) => {
          releaseFirst = release;
          resolve();
        });
      }
    });
  });

  try {
    const first = writeState(run);
    await firstPaused;

    run.status = "completed";
    run.finishedAt = "2026-06-15T00:01:00.000Z";
    run.laneRecords.set("lane:complete", {
      callId: "lane:complete",
      status: "completed",
      outcome: "success",
      completedAt: "2026-06-15T00:00:30.000Z",
    });
    const second = writeState(run);

    const earlySecondResult = await Promise.race([
      second.then(() => "completed"),
      sleep(30).then(() => "blocked"),
    ]);
    assert.equal(earlySecondResult, "blocked", "the newer write must wait for the older write slot");

    releaseFirst();
    await Promise.all([first, second]);

    const state = JSON.parse(await fs.readFile(path.join(dir, "state.json"), "utf8"));
    assert.equal(state.status, "completed");
    assert.equal(state.finishedAt, "2026-06-15T00:01:00.000Z");
    assert.deepEqual(state.laneRecords.map((record) => record.callId), ["lane:complete"]);
    assert.equal(hookCalls, 2);
  } finally {
    __setWriteStateTestHook(undefined);
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("R30: writeJsonAtomic removes the tmp file when fs.rename fails, then rethrows", async () => {
  // R30 regression: the write-then-rename helper must not orphan its tmp file if the
  // final rename throws (EACCES/ENOSPC in production). Force a deterministic rename
  // failure by making the destination a non-empty directory (rename of a file onto it
  // throws EISDIR/ENOTEMPTY), then assert the error propagates AND no *.tmp leaks behind.
  const dir = await tempDir("workflow-write-atomic-rename-fail");
  const target = path.join(dir, "state.json");
  await fs.mkdir(target);
  await fs.writeFile(path.join(target, "child"), "x", "utf8");

  await assert.rejects(
    writeJsonAtomic(target, { ok: true }),
    (error) => error instanceof Error && typeof error.code === "string",
    "a rename failure must propagate the original error",
  );

  const leftovers = (await fs.readdir(dir)).filter((name) => name.endsWith(".tmp"));
  assert.deepEqual(leftovers, [], "the tmp file must be removed before the error is rethrown");
});

test("writeJsonAtomic removes the tmp file when fs.writeFile fails after a partial write", async (t) => {
  const dir = await tempDir("workflow-write-atomic-write-fail");
  const target = path.join(dir, "state.json");
  const originalWriteFile = fs.writeFile;

  t.mock.method(fs, "writeFile", async (filePath, ...args) => {
    if (String(filePath).startsWith(`${target}.`) && String(filePath).endsWith(".tmp")) {
      await originalWriteFile(filePath, "partial", "utf8");
      const error = new Error("no space left on device");
      error.code = "ENOSPC";
      throw error;
    }
    return await originalWriteFile(filePath, ...args);
  });

  await assert.rejects(
    () => writeJsonAtomic(target, { ok: true }),
    (error) => error?.code === "ENOSPC",
  );

  const leftovers = (await fs.readdir(dir)).filter((name) => name.endsWith(".tmp"));
  assert.deepEqual(leftovers, [], "the tmp file must be removed before the write error is rethrown");
});

test("run-store artifacts are created with private file and directory modes", async () => {
  if (process.platform === "win32") return;
  const dir = await tempDir("workflow-private-artifacts");
  const run = makeRun(dir);
  const mode = async (filePath) => (await fs.stat(filePath)).mode & 0o777;

  await writeJsonAtomic(path.join(dir, "state.json"), { ok: true });
  await appendLedger(dir, "domain-ledger.jsonl", { phase: "started", mutationKey: "m1" });
  await writeLaneProjection(run, "lane:private", { status: "running" });
  const release = await acquireWorkflowLock(lockPathForRun(dir, "run"), { operation: "run", runId: run.id });

  assert.equal(await mode(dir), PRIVATE_DIR_MODE);
  assert.equal(await mode(path.join(dir, "state.json")), PRIVATE_FILE_MODE);
  assert.equal(await mode(path.join(dir, "domain-ledger.jsonl")), PRIVATE_FILE_MODE);
  assert.equal(await mode(path.join(dir, "lanes")), PRIVATE_DIR_MODE);
  assert.equal(await mode(path.join(dir, "lanes", `${safeProjectionName("lane:private")}.json`)), PRIVATE_FILE_MODE);
  assert.equal(await mode(lockPathForRun(dir, "run")), PRIVATE_FILE_MODE);

  await release();
});

test("writeLaneProjection serializes concurrent updates for the same lane", async () => {
  const dir = await tempDir("workflow-lane-projection-serialized");
  const run = makeRun(dir, { id: "serialized-projection-run" });

  await Promise.all([
    writeLaneProjection(run, "lane:race", { status: "running", startedAt: "2026-06-15T00:00:00.000Z" }),
    writeLaneProjection(run, "lane:race", { outcome: "success", completedAt: "2026-06-15T00:00:01.000Z" }),
  ]);

  const projected = JSON.parse(await fs.readFile(path.join(dir, "lanes", `${safeProjectionName("lane:race")}.json`), "utf8"));
  assert.equal(projected.status, "running");
  assert.equal(projected.outcome, "success");
  assert.equal(projected.startedAt, "2026-06-15T00:00:00.000Z");
  assert.equal(projected.completedAt, "2026-06-15T00:00:01.000Z");
  assert.equal(run.laneRecords.get("lane:race").outcome, "success");
});

test("writeState does not rewrite clean lane projection files", async () => {
  const dir = await tempDir("workflow-lane-projection-clean");
  const run = makeRun(dir, { id: "clean-projection-run" });

  await writeLaneProjection(run, "lane:clean", { status: "completed", outcome: "success" });
  const cleanPath = path.join(dir, "lanes", `${safeProjectionName("lane:clean")}.json`);
  const before = await fs.readFile(cleanPath, "utf8");

  await writeState(run);
  const after = await fs.readFile(cleanPath, "utf8");
  assert.equal(after, before, "writeState must not re-stamp a clean lane projection");

  run.laneRecords.set("lane:manual", { callId: "lane:manual", status: "completed", outcome: "success" });
  await writeState(run);
  const manual = JSON.parse(await fs.readFile(path.join(dir, "lanes", `${safeProjectionName("lane:manual")}.json`), "utf8"));
  assert.equal(manual.callId, "lane:manual", "writeState still backfills records not written through writeLaneProjection");
});
