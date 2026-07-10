import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { budgetSnapshot, checkBudgetBeforeLaunch } from "../workflow-kernel/budget-accounting.js";
import { appendLedger } from "../workflow-kernel/event-journal.js";
import { processAppearsAlive, runDirForRoot, writeJsonAtomic } from "../workflow-kernel/run-store-fs.js";
import { readRunEntry } from "../workflow-kernel/run-store-status-format.js";
import { rehydrateRunFromPriorState } from "../workflow-kernel/run-store-rehydrate.js";

// Recovery regressions split out of durable-state.test.mjs (opencode-workflows-fnop.9): prior-state
// rehydration (including the R9 no-double-count budget contract), reconcile recovery of durable
// ledgers into an interrupted/ambiguous state, and the processAppearsAlive liveness-distrust rules
// (R23) that govern stale-lock/reconcile decisions.

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

test("rehydrateRunFromPriorState ignores invalid prior field types", async () => {
  const dir = await tempDir("workflow-rehydrate-invalid-types");
  const run = makeRun(dir, {
    agentsStarted: 2,
    maxAgents: 4,
    currentPhase: "snapshot",
    editWorktrees: [{ callId: "edit:1", path: "/tmp/edit" }],
    laneRecords: new Map([["lane:1", { callId: "lane:1", status: "completed" }]]),
  });

  rehydrateRunFromPriorState(run, {
    agentsStarted: "3",
    maxAgents: 0,
    currentPhase: 42,
    editWorktrees: { callId: "bad" },
    integrationWorktrees: { path: "/tmp/bad" },
    laneRecords: { callId: "bad" },
  });

  assert.equal(run.agentsStarted, 2);
  assert.equal(run.maxAgents, 4);
  assert.equal(run.currentPhase, "snapshot");
  assert.deepEqual(run.editWorktrees, [{ callId: "edit:1", path: "/tmp/edit" }]);
  assert.equal(run.laneRecords.get("lane:1").status, "completed");
});

test("resume rehydrates worktree, integration, lane, and budget state", async () => {
  const dir = await tempDir("workflow-rehydrate-state");
  const run = makeRun(dir, { agentsStarted: 0, editWorktrees: [], integrationWorktrees: [], laneRecords: new Map() });
  rehydrateRunFromPriorState(run, {
    startedAt: "2026-06-14T23:00:00.000Z",
    currentPhase: "integrate",
    agentsStarted: 3,
    maxAgents: 5,
    budgetCeilings: { maxCost: 3, maxTokens: 20 },
    authority: { profile: "read-only-review", readOnly: true },
    tokens: { input: 10, output: 2, reasoning: 1 },
    replayedTokens: { input: 4, output: 1, reasoning: 0 },
    cost: 1.25,
    replayedCost: 0.5,
    cacheStats: { hits: 2, misses: 1, invalidated: 1 },
    editWorktrees: [{ callId: "edit:1", path: "/tmp/edit" }],
    integrationWorktrees: [{ role: "integration", path: "/tmp/integration" }],
    editPlan: { sourceHash: "source-hash", patches: [{ path: "a.txt", content: "a" }] },
    integrationPlan: { sourceHash: "source-hash", lanes: [{ callId: "lane:1" }] },
    laneRecords: [{ callId: "lane:1", status: "completed" }],
    costTrackingUnreliable: true,
  });

  assert.equal(run.startedAt, "2026-06-14T23:00:00.000Z");
  assert.equal(run.currentPhase, "integrate");
  assert.equal(run.agentsStarted, 3);
  assert.equal(run.maxAgents, 5);
  assert.deepEqual(run.budgetCeilings, { maxCost: 3, maxTokens: 20 });
  assert.equal(run.authority.profile, "read-only-review");
  assert.equal(budgetSnapshot(run).remainingAgents, 2);
  // R9: prior historical spend (prior live + prior replayed) is folded into the replayed
  // counters and the live counters reset to zero for this segment, so total spend equals
  // the real prior spend (not doubled). Live tokens/cost: 10/2/1 and 1.25; prior replayed:
  // 4/1/0 and 0.5 => total 14/3/1 tokens and 1.75 cost, all in the replayed bucket.
  assert.deepEqual(run.tokens, { input: 0, output: 0, reasoning: 0 });
  assert.equal(run.cost, 0);
  assert.deepEqual(run.replayedTokens, { input: 14, output: 3, reasoning: 1 });
  assert.equal(run.replayedCost, 1.75);
  const snapshot = budgetSnapshot(run);
  assert.deepEqual(snapshot.total.tokens, { input: 14, output: 3, reasoning: 1 });
  assert.equal(snapshot.total.cost, 1.75);
  assert.equal(run.cacheStats.hits, 2);
  assert.equal(run.editWorktrees.length, 1);
  assert.equal(run.integrationWorktrees.length, 1);
  assert.equal(run.integrationPlan.lanes.length, 1);
  assert.equal(run.laneRecords.get("lane:1").status, "completed");
  // mnfx.2: costTrackingUnreliable is sticky durable state — survives rehydrate so a resumed run
  // keeps the dead-maxCost honesty caveat. And it is warning-only: checkBudgetBeforeLaunch must
  // not throw merely because the flag is set (free/local providers legitimately report cost 0).
  assert.equal(run.costTrackingUnreliable, true);
  assert.doesNotThrow(() => checkBudgetBeforeLaunch(run));
});

test("R9: resume does not double-count prior spend; ceiling reflects real spend", async () => {
  const dir = await tempDir("workflow-budget-double-count");
  const run = makeRun(dir, { agentsStarted: 0 });

  // Prior segment(s) spent: 800 input + 100 output + 100 reasoning = 1000 tokens live,
  // plus 50/30/20 = 100 tokens already replayed from an even earlier segment, and
  // 4.0 + 1.0 = 5.0 cost. Real historical total spend = 1100 tokens / 5.0 cost.
  rehydrateRunFromPriorState(run, {
    agentsStarted: 5,
    maxAgents: 50,
    budgetCeilings: { maxCost: 6, maxTokens: 1200 },
    tokens: { input: 800, output: 100, reasoning: 100 },
    replayedTokens: { input: 50, output: 30, reasoning: 20 },
    cost: 4.0,
    replayedCost: 1.0,
  });

  // Before the fix, rehydrate copied prior live spend into run.tokens AND replay re-added
  // it into replayedTokens, so total would read 2100 tokens / 9.0 cost (~2x) and trip the
  // 1200-token / 6.0-cost ceiling even though real spend (1100 / 5.0) is well under it.
  const snapshotAfterResume = budgetSnapshot(run);
  assert.deepEqual(snapshotAfterResume.total.tokens, { input: 850, output: 130, reasoning: 120 });
  assert.equal(
    snapshotAfterResume.total.tokens.input + snapshotAfterResume.total.tokens.output + snapshotAfterResume.total.tokens.reasoning,
    1100,
  );
  assert.equal(snapshotAfterResume.total.cost, 5.0);
  // Live counters start fresh for this segment; all historical spend lives in replayed.
  assert.deepEqual(run.tokens, { input: 0, output: 0, reasoning: 0 });
  assert.equal(run.cost, 0);

  // Replaying the prior lanes as cache hits must NOT re-accumulate their spend: the
  // carried-forward replayed counters already represent the full historical total. The
  // production cache-hit path returns the cached result without touching the counters, so
  // total spend is stable across replay and the ceiling (above real spend) does not trip.
  assert.doesNotThrow(() => checkBudgetBeforeLaunch(run));
  const snapshotAfterReplay = budgetSnapshot(run);
  assert.deepEqual(snapshotAfterReplay.total.tokens, snapshotAfterResume.total.tokens);
  assert.equal(snapshotAfterReplay.total.cost, snapshotAfterResume.total.cost);

  // A fresh live lane in this segment accumulates only its own spend on top of the real
  // historical total — pushing total to 1100 + 150 = 1250 tokens, now over the 1200
  // ceiling, which correctly trips. This proves the ceiling reflects REAL spend, not a
  // doubled phantom that would have tripped at ~600 tokens of real work.
  run.tokens.input += 100;
  run.tokens.output += 50;
  run.cost += 0.4;
  const snapshotWithLive = budgetSnapshot(run);
  assert.equal(
    snapshotWithLive.total.tokens.input + snapshotWithLive.total.tokens.output + snapshotWithLive.total.tokens.reasoning,
    1250,
  );
  assert.equal(snapshotWithLive.total.cost, 5.4);
  const budgetError = (() => {
    try {
      checkBudgetBeforeLaunch(run);
      return null;
    } catch (error) {
      return error;
    }
  })();
  assert.ok(budgetError, "expected the token ceiling to trip once real spend exceeds it");
  assert.equal(budgetError.name, "WorkflowBudgetStoppedError");
});

test("reconcile preserves durable ledgers and reports ambiguous recovery state", async () => {
  const root = await tempDir("workflow-reconcile-root");
  const runId = "reconcile-run";
  const dir = runDirForRoot(root, runId);
  await fs.mkdir(dir, { recursive: true });
  await writeJsonAtomic(path.join(dir, "state.json"), {
    id: runId,
    status: "running",
    startedAt: "2026-06-15T00:00:00.000Z",
    process: { pid: 999999999, startTime: "not-alive" },
    editWorktrees: [{ path: "/tmp/edit" }],
    integrationWorktrees: [{ path: "/tmp/integration" }],
    integrationPlan: { lanes: [{ callId: "lane:1" }] },
  });
  await appendLedger(dir, "domain-ledger.jsonl", { phase: "started", mutationKey: "close:1" });
  await appendLedger(dir, "validation-ledger.jsonl", { phase: "started", validationKey: "central" });
  await appendLedger(dir, "apply-ledger.jsonl", { phase: "started", diffPlanHash: "plan" });
  await appendLedger(dir, "apply-ledger.jsonl", { phase: "before-write", diffPlanHash: "plan", path: "a.txt" });

  const entry = await readRunEntry(root, runId, { reconcile: true });
  assert.equal(entry.status, "interrupted");
  assert.equal(entry.state.recovery.incompleteApply, true);
  assert.deepEqual(entry.state.recovery.incompleteDomainMutations, ["close:1"]);
  assert.deepEqual(entry.state.recovery.incompleteValidationKeys, ["central"]);
  assert.equal(entry.state.recovery.worktreeCounts.integration, 1);

  const closeout = JSON.parse(await fs.readFile(path.join(dir, "closeout.json"), "utf8"));
  assert.equal(closeout.status, "interrupted");
});

test("processAppearsAlive distrusts a recorded-start PID when the live start time is unreadable (R23)", async () => {
  // R23 regression: the owner recorded a finite process start time, the PID is still alive
  // (process.pid is this very process), but the live start time cannot be read (/proc
  // unreadable, hidepid/EPERM, TOCTOU). A non-finite liveStart MUST be treated as distrust
  // — otherwise a reused PID is pinned as active and reconcile/cleanup is blocked.
  const processInfo = { pid: process.pid, startTime: 12345 };

  for (const unreadable of [undefined, NaN, Infinity, -Infinity, null]) {
    const result = await processAppearsAlive(processInfo, {
      readStartTime: async () => unreadable,
    });
    assert.equal(
      result,
      false,
      `non-finite live start (${String(unreadable)}) with a recorded start must yield not-alive`,
    );
  }

  // Control: an alive PID whose readable live start matches the recorded start is alive.
  const matching = await processAppearsAlive(processInfo, {
    readStartTime: async () => 12345,
  });
  assert.equal(matching, true, "a readable matching live start must remain alive");

  // Control: a readable live start that differs (classic PID reuse) is not-alive.
  const mismatched = await processAppearsAlive(processInfo, {
    readStartTime: async () => 99999,
  });
  assert.equal(mismatched, false, "a readable mismatched live start must yield not-alive");

  // Control: with NO recorded start there is nothing to confirm, so the bare liveness check
  // governs and an unreadable live start does NOT flip a live PID to not-alive.
  const noRecord = await processAppearsAlive(
    { pid: process.pid },
    { readStartTime: async () => undefined },
  );
  assert.equal(noRecord, true, "no recorded start falls back to bare liveness (stays alive)");

  const freshStartlessLock = await processAppearsAlive(
    { process: { pid: process.pid }, acquiredAt: "2026-06-15T00:00:00.000Z" },
    { now: Date.parse("2026-06-15T00:00:10.000Z"), lockTtlMs: 60_000 },
  );
  assert.equal(freshStartlessLock, true, "a fresh startless lock may use bare liveness before the TTL");

  const expiredStartlessLock = await processAppearsAlive(
    { process: { pid: process.pid }, acquiredAt: "2026-06-15T00:00:00.000Z" },
    { now: Date.parse("2026-06-15T00:02:00.000Z"), lockTtlMs: 60_000 },
  );
  assert.equal(expiredStartlessLock, false, "a startless lock must age out by TTL to avoid PID-reuse wedges");
});
