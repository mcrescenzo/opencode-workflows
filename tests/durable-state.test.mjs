import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import WorkflowPlugin from "../workflow-kernel/index.js";

const { __test } = WorkflowPlugin;

async function tempDir(name) {
  return await fs.mkdtemp(path.join(os.tmpdir(), `${name}-`));
}

function zeroTokens() {
  return { input: 0, output: 0, reasoning: 0 };
}

function accessDeniedError() {
  const error = new Error("permission denied");
  error.code = "EACCES";
  return error;
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

  await __test.appendIntegrationLedger(run, { phase: "lane-committed", callId: "lane:1" });
  await __test.appendValidationLedger(run, { phase: "started", validationKey: "central" });
  await __test.appendValidationLedger(run, { phase: "completed", validationKey: "central" });
  await __test.writeLaneProjection(run, "lane:1", { status: "running", startedAt: "2026-06-15T00:00:10.000Z", taskSummary: "Implement lane one", tokens: { input: 1, output: 2, reasoning: 0 } });
  await __test.writeLaneProjection(run, "lane:1", { status: "completed", outcome: "success", completedAt: "2026-06-15T00:00:20.000Z", tokens: { input: 3, output: 5, reasoning: 1 } });
  await __test.writeState(run);

  const state = JSON.parse(await fs.readFile(path.join(dir, "state.json"), "utf8"));
  assert.equal(state.stateVersion, __test.DURABLE_STATE_VERSION);
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
    __test.__setWriteStateTestHook(async ({ state }) => {
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
    const first = __test.writeState(run);
    await firstPaused;

    run.status = "completed";
    run.finishedAt = "2026-06-15T00:01:00.000Z";
    run.laneRecords.set("lane:complete", {
      callId: "lane:complete",
      status: "completed",
      outcome: "success",
      completedAt: "2026-06-15T00:00:30.000Z",
    });
    const second = __test.writeState(run);

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
    __test.__setWriteStateTestHook(undefined);
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("cleanupWorktrees ignores ledger and event append failures", async () => {
  const dir = await tempDir("workflow-cleanup-ledger-failure");
  const realAppendFile = fs.appendFile;
  const run = makeRun(dir, {
    eventCount: 0,
    journalRecords: 0,
    integrationWorktrees: [{ role: "lane", callId: "lane:1", laneId: "lane1", path: path.join(dir, "lane-1"), branch: "workflow/lane-1" }],
    worktreeAdapter: {
      async remove(record) {
        return { ...record, removed: false, preserved: true, reason: "dirty" };
      },
    },
  });
  fs.appendFile = async (filePath, ...rest) => {
    if (String(filePath).endsWith("integration-ledger.jsonl") || String(filePath).endsWith("events.jsonl")) {
      throw new Error("injected append failure");
    }
    return await realAppendFile.call(fs, filePath, ...rest);
  };
  try {
    assert.equal(await __test.cleanupWorktrees(run), true);
    assert.equal(run.worktreeCleanup.integration[0].preserved, true);
    assert.equal(run.worktreeCleanup.integration[0].reason, "dirty");
  } finally {
    fs.appendFile = realAppendFile;
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("ensureRunRoot reports when all candidate roots are unwritable", async (t) => {
  const dir = await tempDir("workflow-unwritable-roots");
  const attemptedRoots = [];
  t.mock.method(fs, "mkdir", async (root) => {
    attemptedRoots.push(root);
    throw accessDeniedError();
  });

  await assert.rejects(
    () => __test.ensureRunRoot({ directory: dir, worktree: dir }),
    /Could not create a writable workflow run directory/,
  );
  assert.deepEqual(attemptedRoots, __test.runRoots({ directory: dir, worktree: dir }));
});

test("appendLedger accepts canonical lowercase ledgers and rejects unsafe names", async () => {
  const dir = await tempDir("workflow-ledger-file-name");
  try {
    await __test.appendLedger(dir, "domain-ledger.jsonl", { phase: "started", mutationKey: "domain:1" });
    await __test.appendLedger(dir, "custom-ledger.jsonl", { phase: "started", key: "custom:1" });

    assert.match(await fs.readFile(path.join(dir, "domain-ledger.jsonl"), "utf8"), /"mutationKey":"domain:1"/);
    assert.match(await fs.readFile(path.join(dir, "custom-ledger.jsonl"), "utf8"), /"key":"custom:1"/);

    for (const fileName of ["../../etc/passwd.jsonl", "nested/domain-ledger.jsonl", "", "custom-ledger.JSONL"]) {
      await assert.rejects(
        () => __test.appendLedger(dir, fileName, { phase: "started" }),
        /Invalid ledger file name/,
        `${fileName || "empty filename"} should be rejected`,
      );
    }
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("appendLedger rejects missing run directories", async () => {
  await assert.rejects(
    () => __test.appendLedger(undefined, "domain-ledger.jsonl", { phase: "started" }),
    /appendLedger requires a run directory/,
  );
  await assert.rejects(
    () => __test.appendLedger({}, "domain-ledger.jsonl", { phase: "started" }),
    /appendLedger requires a run directory/,
  );
});

test("applyLedgerHasCompleted detects matching completed records and skips corrupt lines", async () => {
  const dir = await tempDir("workflow-apply-ledger-completed");
  await fs.writeFile(
    path.join(dir, "apply-ledger.jsonl"),
    [
      JSON.stringify({ phase: "started", diffPlanHash: "plan-a" }),
      "{truncated",
      JSON.stringify({ phase: "completed", diffPlanHash: "plan-b" }),
      JSON.stringify({ phase: "completed", diffPlanHash: "plan-a" }),
      "",
    ].join("\n"),
    "utf8",
  );

  assert.equal(await __test.applyLedgerHasCompleted(dir, "plan-a"), true);
  assert.equal(await __test.applyLedgerHasCompleted(dir, "missing-plan"), false);
  assert.equal(await __test.applyLedgerHasCompleted(path.join(dir, "missing"), "plan-a"), false);

  await __test.appendApplyLedger(dir, { phase: "completed", diffPlanHash: "plan-c" });
  assert.equal(await __test.applyLedgerHasCompleted(dir, "plan-c"), true);
});

test("truncateText preserves exact max length and truncates max+1", () => {
  const exact = "x".repeat(40);
  assert.equal(__test.truncateText(exact, 40), exact);

  const truncated = __test.truncateText(`${exact}y`, 40);
  assert.equal(truncated.length, 40);
  // 41-char input at max=40: the "...[truncated 24 chars]" suffix (23 chars) is carved out
  // of the budget, leaving a 17-char head — so 41 - 17 = 24 chars are actually dropped.
  assert.match(truncated, /\.\.\.\[truncated 24 chars\]$/);

  const surrogate = __test.truncateText(`prefix ${"x".repeat(20)}😀 suffix`, 40);
  assert.notEqual(surrogate.charCodeAt(surrogate.indexOf("...[truncated") - 1), 0xd83d);
  assert.doesNotMatch(surrogate, /\ud83d(?![\udc00-\udfff])/u);
});

test("parseModel and normalizePatternList cover split and validation edges", () => {
  assert.deepEqual(__test.parseModel("openai/gpt/4.1"), { providerID: "openai", modelID: "gpt/4.1" });
  assert.deepEqual(__test.parseModel("a/b"), { providerID: "a", modelID: "b" });
  assert.equal(__test.parseModel("/model"), undefined);
  assert.equal(__test.parseModel("provider/"), undefined);
  assert.equal(__test.parseModel(42), undefined);

  assert.deepEqual(__test.normalizePatternList([" bd status ", "bd status"], "shell.allow"), ["bd status"]);
  assert.deepEqual(
    __test.normalizePatternList(Array.from({ length: 1000 }, () => " bd status "), "shell.allow"),
    ["bd status"],
  );
  assert.throws(() => __test.normalizePatternList("   ", "shell.allow"), /shell\.allow entries must be non-empty strings/);
  assert.throws(() => __test.normalizePatternList(["bd status", 1], "shell.allow"), /shell\.allow entries must be non-empty strings/);
});

test("workflow source helpers reject missing source and invalid names", async () => {
  await assert.rejects(
    () => __test.resolveWorkflowSource({ directory: process.cwd(), worktree: process.cwd() }, {}),
    /Provide `source`, `scriptPath`, or `name`/,
  );

  assert.equal(__test.workflowFileName("valid-name"), "valid-name.js");
  assert.throws(() => __test.workflowFileName("has spaces"), /Workflow name must be a simple slug/);
  assert.throws(() => __test.workflowFileName("a".repeat(64)), /Workflow name must be a simple slug/);
});

test("assertSafeRunId covers traversal, dot names, and length boundaries", () => {
  assert.equal(__test.assertSafeRunId("a"), "a");
  assert.equal(__test.assertSafeRunId("a".repeat(128)), "a".repeat(128));

  for (const runId of [".", "..", "run/../../secret", "../secret", "/absolute", "", "a".repeat(129)]) {
    assert.throws(
      () => __test.assertSafeRunId(runId),
      /runId must be a simple run id without path separators/,
      `${runId || "empty run id"} should be rejected`,
    );
  }

  assert.throws(
    () => __test.runDirForRoot("/tmp/workflow-root", "../secret"),
    /runId must be a simple run id without path separators/,
  );
});

test("safeProjectionName sanitizes, caps, and falls back for punctuation-only ids", () => {
  assert.equal(__test.safeProjectionName(" lane:/one "), "lane_one");
  assert.equal(__test.safeProjectionName("a".repeat(140)).length, 120);
  assert.match(__test.safeProjectionName("!!!"), /^[0-9a-f]{16}$/);
});

test("rehydrateRunFromPriorState ignores invalid prior field types", async () => {
  const dir = await tempDir("workflow-rehydrate-invalid-types");
  const run = makeRun(dir, {
    agentsStarted: 2,
    maxAgents: 4,
    currentPhase: "snapshot",
    editWorktrees: [{ callId: "edit:1", path: "/tmp/edit" }],
    laneRecords: new Map([["lane:1", { callId: "lane:1", status: "completed" }]]),
  });

  __test.rehydrateRunFromPriorState(run, {
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

test("withTimeout rejects immediately for pre-aborted signals and preserves timeout errors", async () => {
  const controller = new AbortController();
  controller.abort();
  let called = false;
  let abortCleanupCalled = false;

  await assert.rejects(
    () => __test.withTimeout(() => {
      called = true;
      return "done";
    }, { timeoutMs: 100, signal: controller.signal, label: "pre-aborted", onTimeout: () => { abortCleanupCalled = true; } }),
    (error) => error?.code === "WORKFLOW_CANCELLED",
  );
  assert.equal(called, false);
  await sleep(0);
  assert.equal(abortCleanupCalled, true, "pre-aborted signals must still run timeout/abort cleanup");

  const abortDuringWait = new AbortController();
  let signalAbortCleanupCalled = false;
  const pending = __test.withTimeout(() => new Promise(() => {}), {
    timeoutMs: 1000,
    signal: abortDuringWait.signal,
    label: "abort-during-wait",
    onTimeout: () => { signalAbortCleanupCalled = true; },
  });
  abortDuringWait.abort();
  await assert.rejects(pending, (error) => error?.code === "WORKFLOW_CANCELLED");
  await sleep(0);
  assert.equal(signalAbortCleanupCalled, true, "signal-abort branch must run timeout/abort cleanup");

  await assert.rejects(
    () => __test.withTimeout(() => new Promise(() => {}), {
      timeoutMs: 0,
      label: "tiny timeout",
      onTimeout: async () => {
        throw new Error("cleanup failed");
      },
    }),
    (error) => error?.code === "WORKFLOW_TIMEOUT" && /tiny timeout timed out after 0ms/.test(error.message),
  );

  const started = Date.now();
  await assert.rejects(
    () => __test.withTimeout(() => new Promise(() => {}), {
      timeoutMs: 1,
      label: "hung cleanup",
      onTimeout: async () => await new Promise(() => {}),
    }),
    (error) => error?.code === "WORKFLOW_TIMEOUT" && /hung cleanup timed out after 1ms/.test(error.message),
  );
  assert.ok(Date.now() - started < 250, "timeout rejection must not wait for hung onTimeout cleanup");
});

test("checkBudgetBeforeLaunch enforces equality boundaries across live and replayed spend", () => {
  const run = makeRun("/tmp/budget-boundary", {
    tokens: { input: 4, output: 3, reasoning: 2 },
    replayedTokens: zeroTokens(),
    cost: 0.99,
    replayedCost: 0,
    budgetCeilings: { maxCost: 1, maxTokens: 10 },
  });

  assert.doesNotThrow(() => __test.checkBudgetBeforeLaunch(run));

  run.replayedCost = 0.01;
  assert.throws(() => __test.checkBudgetBeforeLaunch(run), (error) => error?.code === "WORKFLOW_BUDGET_STOPPED");

  run.cost = 0;
  run.replayedCost = 0;
  run.tokens.reasoning = 3;
  assert.throws(() => __test.checkBudgetBeforeLaunch(run), (error) => error?.code === "WORKFLOW_BUDGET_STOPPED");

  run.tokens = { input: NaN, output: 1, reasoning: 1 };
  run.replayedTokens = zeroTokens();
  assert.doesNotThrow(() => __test.checkBudgetBeforeLaunch(run));
  assert.deepEqual(__test.normalizeBudgetCeilings({ maxCost: 0, maxTokens: 1.5 }), { maxCost: 0, maxTokens: undefined });
});

test("redaction preserves numeric usage tokens but redacts credential tokens", () => {
  const redacted = __test.redactValue({
    tokens: { input: 10, output: 2, reasoning: 1 },
    accessToken: "secret-token",
    nested: { idToken: "secret-id-token", tokenUsage: { input: 1, output: 1 } },
  });

  assert.deepEqual(redacted.tokens, { input: 10, output: 2, reasoning: 1 });
  assert.equal(redacted.accessToken, "[redacted]");
  assert.equal(redacted.nested.idToken, "[redacted]");
  assert.deepEqual(redacted.nested.tokenUsage, { input: 1, output: 1 });
});

test("resume rehydrates worktree, integration, lane, and budget state", async () => {
  const dir = await tempDir("workflow-rehydrate-state");
  const run = makeRun(dir, { agentsStarted: 0, editWorktrees: [], integrationWorktrees: [], laneRecords: new Map() });
  __test.rehydrateRunFromPriorState(run, {
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
  });

  assert.equal(run.startedAt, "2026-06-14T23:00:00.000Z");
  assert.equal(run.currentPhase, "integrate");
  assert.equal(run.agentsStarted, 3);
  assert.equal(run.maxAgents, 5);
  assert.deepEqual(run.budgetCeilings, { maxCost: 3, maxTokens: 20 });
  assert.equal(run.authority.profile, "read-only-review");
  assert.equal(__test.budgetSnapshot(run).remainingAgents, 2);
  // R9: prior historical spend (prior live + prior replayed) is folded into the replayed
  // counters and the live counters reset to zero for this segment, so total spend equals
  // the real prior spend (not doubled). Live tokens/cost: 10/2/1 and 1.25; prior replayed:
  // 4/1/0 and 0.5 => total 14/3/1 tokens and 1.75 cost, all in the replayed bucket.
  assert.deepEqual(run.tokens, { input: 0, output: 0, reasoning: 0 });
  assert.equal(run.cost, 0);
  assert.deepEqual(run.replayedTokens, { input: 14, output: 3, reasoning: 1 });
  assert.equal(run.replayedCost, 1.75);
  const snapshot = __test.budgetSnapshot(run);
  assert.deepEqual(snapshot.total.tokens, { input: 14, output: 3, reasoning: 1 });
  assert.equal(snapshot.total.cost, 1.75);
  assert.equal(run.cacheStats.hits, 2);
  assert.equal(run.editWorktrees.length, 1);
  assert.equal(run.integrationWorktrees.length, 1);
  assert.equal(run.integrationPlan.lanes.length, 1);
  assert.equal(run.laneRecords.get("lane:1").status, "completed");
});

test("R9: resume does not double-count prior spend; ceiling reflects real spend", async () => {
  const dir = await tempDir("workflow-budget-double-count");
  const run = makeRun(dir, { agentsStarted: 0 });

  // Prior segment(s) spent: 800 input + 100 output + 100 reasoning = 1000 tokens live,
  // plus 50/30/20 = 100 tokens already replayed from an even earlier segment, and
  // 4.0 + 1.0 = 5.0 cost. Real historical total spend = 1100 tokens / 5.0 cost.
  __test.rehydrateRunFromPriorState(run, {
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
  const snapshotAfterResume = __test.budgetSnapshot(run);
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
  assert.doesNotThrow(() => __test.checkBudgetBeforeLaunch(run));
  const snapshotAfterReplay = __test.budgetSnapshot(run);
  assert.deepEqual(snapshotAfterReplay.total.tokens, snapshotAfterResume.total.tokens);
  assert.equal(snapshotAfterReplay.total.cost, snapshotAfterResume.total.cost);

  // A fresh live lane in this segment accumulates only its own spend on top of the real
  // historical total — pushing total to 1100 + 150 = 1250 tokens, now over the 1200
  // ceiling, which correctly trips. This proves the ceiling reflects REAL spend, not a
  // doubled phantom that would have tripped at ~600 tokens of real work.
  run.tokens.input += 100;
  run.tokens.output += 50;
  run.cost += 0.4;
  const snapshotWithLive = __test.budgetSnapshot(run);
  assert.equal(
    snapshotWithLive.total.tokens.input + snapshotWithLive.total.tokens.output + snapshotWithLive.total.tokens.reasoning,
    1250,
  );
  assert.equal(snapshotWithLive.total.cost, 5.4);
  const budgetError = (() => {
    try {
      __test.checkBudgetBeforeLaunch(run);
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
  const dir = __test.runDirForRoot(root, runId);
  await fs.mkdir(dir, { recursive: true });
  await __test.writeJsonAtomic(path.join(dir, "state.json"), {
    id: runId,
    status: "running",
    startedAt: "2026-06-15T00:00:00.000Z",
    process: { pid: 999999999, startTime: "not-alive" },
    editWorktrees: [{ path: "/tmp/edit" }],
    integrationWorktrees: [{ path: "/tmp/integration" }],
    integrationPlan: { lanes: [{ callId: "lane:1" }] },
  });
  await __test.appendLedger(dir, "domain-ledger.jsonl", { phase: "started", mutationKey: "close:1" });
  await __test.appendLedger(dir, "validation-ledger.jsonl", { phase: "started", validationKey: "central" });
  await __test.appendLedger(dir, "apply-ledger.jsonl", { phase: "started", diffPlanHash: "plan" });
  await __test.appendLedger(dir, "apply-ledger.jsonl", { phase: "before-write", diffPlanHash: "plan", path: "a.txt" });

  const entry = await __test.readRunEntry(root, runId, { reconcile: true });
  assert.equal(entry.status, "interrupted");
  assert.equal(entry.state.recovery.incompleteApply, true);
  assert.deepEqual(entry.state.recovery.incompleteDomainMutations, ["close:1"]);
  assert.deepEqual(entry.state.recovery.incompleteValidationKeys, ["central"]);
  assert.equal(entry.state.recovery.worktreeCounts.integration, 1);

  const closeout = JSON.parse(await fs.readFile(path.join(dir, "closeout.json"), "utf8"));
  assert.equal(closeout.status, "interrupted");
});

test("domain mutation ledger is idempotent by mutation key", async () => {
  const dir = await tempDir("workflow-domain-ledger");
  const run = makeRun(dir);
  let calls = 0;
  const execute = async () => ({ call: ++calls });
  const readback = async (result) => ({ observed: result.call });

  const first = await __test.runDomainMutation(run, { mutationKey: "bd-close:1", operation: "close", execute, readback });
  const second = await __test.runDomainMutation(run, { mutationKey: "bd-close:1", operation: "close", execute, readback });

  assert.equal(first.replayed, false);
  assert.equal(second.replayed, true);
  assert.equal(calls, 1);
  assert.deepEqual(second.readback, { observed: 1 });
  const records = await __test.readJsonlLedger(path.join(dir, "domain-ledger.jsonl"));
  assert.equal(__test.ledgerHasCompleted(records, "bd-close:1"), true);
  assert.equal(records.filter((record) => record.phase === "completed").length, 1);
});

test("domain mutation passes a deterministic idempotency key to execute and records it before running", async () => {
  // R16: the crash window is between execute() completing its (non-idempotent) bd side-effect and the
  // durable "executed" ledger record being written. To survive a replay, execute must be handed a
  // stable client-side idempotency key, and that key must be persisted in the "started" record BEFORE
  // execute runs so a resume re-derives the same key. Assert both here.
  const dir = await tempDir("workflow-domain-idem");
  const run = makeRun(dir);
  const seenKeys = [];
  const execute = async (idempotencyKey) => {
    seenKeys.push(idempotencyKey);
    return { ok: true };
  };

  const expectedKey = __test.domainMutationIdempotencyKey("bd-create:abc");
  assert.match(expectedKey, /^ocw-idem-[0-9a-f]+$/);
  assert.equal(__test.domainMutationIdempotencyKey("bd-create:abc"), expectedKey, "key derivation must be deterministic");

  const result = await __test.runDomainMutation(run, { mutationKey: "bd-create:abc", operation: "create", execute });
  assert.equal(result.replayed, false);
  assert.deepEqual(seenKeys, [expectedKey], "execute must receive the deterministic idempotency key");

  const records = await __test.readJsonlLedger(path.join(dir, "domain-ledger.jsonl"));
  const started = records.find((record) => record.phase === "started");
  assert.equal(started.idempotencyKey, expectedKey, "started record must persist the idempotency key before execute runs");
});

test("journal cap throws, event cap drops, and truncated journal lines are skipped", async () => {
  const dir = await tempDir("workflow-journal-cap");
  const run = makeRun(dir, {
    journalRecords: __test.MAX_JOURNAL_RECORDS,
    eventCount: __test.MAX_EVENTS,
  });

  await assert.rejects(
    () => __test.appendJournal(run, { callId: "too-many", outcome: "success" }),
    new RegExp(`Workflow journal exceeded ${__test.MAX_JOURNAL_RECORDS} records`),
  );
  assert.equal(run.journalRecords, __test.MAX_JOURNAL_RECORDS);

  await __test.appendEvent(run, { type: "dropped-at-cap" });
  const events = await fs.readFile(path.join(dir, "events.jsonl"), "utf8").catch((error) => {
    if (error.code === "ENOENT") return "";
    throw error;
  });
  assert.equal(events, "", "appendEvent silently drops records once MAX_EVENTS is reached");

  await fs.writeFile(
    path.join(dir, "journal.jsonl"),
    `${JSON.stringify({ callId: "kept", outcome: "success" })}\n{"callId":"truncated`,
    "utf8",
  );
  const loaded = await __test.loadJournal(dir);
  assert.equal(loaded.size, 1);
  assert.equal(loaded.get("kept").outcome, "success");
});

test("compactJournal rewrites the latest entry per callId and removes corrupt trailing data", async () => {
  const dir = await tempDir("workflow-journal-compact");
  await fs.writeFile(
    path.join(dir, "journal.jsonl"),
    [
      JSON.stringify({ callId: "lane:1", outcome: "failure", attempt: 1 }),
      JSON.stringify({ callId: "lane:2", outcome: "success", attempt: 1 }),
      JSON.stringify({ callId: "lane:1", outcome: "success", attempt: 2 }),
      '{"callId":"truncated"',
    ].join("\n"),
    "utf8",
  );

  const loaded = await __test.loadJournal(dir);
  assert.equal(loaded.size, 2);
  assert.equal(loaded.get("lane:1").attempt, 2);

  const compacted = await __test.compactJournal(dir, loaded);
  assert.equal(compacted, 2);
  const lines = (await fs.readFile(path.join(dir, "journal.jsonl"), "utf8")).trim().split(/\r?\n/);
  assert.equal(lines.length, 2);
  const parsed = lines.map((line) => JSON.parse(line));
  assert.equal(parsed.find((entry) => entry.callId === "lane:1").outcome, "success");
  assert.equal(parsed.find((entry) => entry.callId === "lane:1").attempt, 2);
  assert.equal(parsed.find((entry) => entry.callId === "lane:2").outcome, "success");
});

test("domain mutation crash between execute and executed-record replays execute with the SAME idempotency key", async () => {
  // R16 core regression: simulate a crash where only the "started" record was persisted (execute's bd
  // mutation already happened, but the "executed" record was lost). On resume runDomainMutation re-runs
  // execute. The re-run MUST receive the identical idempotency key the first attempt used, so the bd
  // adapter can recognize the already-applied resource (external-ref / note marker) and NOT duplicate it.
  const dir = await tempDir("workflow-domain-crash");
  const run = makeRun(dir);

  // Pre-seed the ledger to mimic a crash: a "started" record with a key, no "executed"/"completed".
  const crashKey = __test.domainMutationIdempotencyKey("bd-create:crash");
  await __test.appendDomainLedger(run, { phase: "started", mutationKey: "bd-create:crash", operation: "create", idempotencyKey: crashKey });

  let executeCalls = 0;
  let observedKey;
  const execute = async (idempotencyKey) => {
    executeCalls += 1;
    observedKey = idempotencyKey;
    return { ok: true };
  };

  const result = await __test.runDomainMutation(run, { mutationKey: "bd-create:crash", operation: "create", execute });
  assert.equal(executeCalls, 1, "resume after a started-only crash must run execute exactly once");
  assert.equal(observedKey, crashKey, "the resumed execute must reuse the key from the started record's mutationKey");
  assert.equal(result.replayed, false);

  const records = await __test.readJsonlLedger(path.join(dir, "domain-ledger.jsonl"));
  assert.equal(records.filter((record) => record.phase === "completed").length, 1);
});

test("laneSignature is stable and changes for lane-defining inputs", () => {
  const baseResolved = {
    modelKey: "openai/gpt-5.5",
    agent: "build",
    role: "implementation",
    system: "system prompt",
    outputFormat: { type: "text" },
    schema: null,
    policy: { bash: "deny" },
    opts: { tools: { read: true }, retryCount: 1 },
  };
  const signature = (runOverrides = {}, resolvedOverrides = {}, prompt = "Implement the lane") => __test.laneSignature(
    makeRun("/tmp/workflow-lane-signature", {
      sourceHash: "source-a",
      runtimeArgs: { issue: "opencode-workflows-ct3" },
      capabilities: { permissions: "verified", structuredOutput: true, structuredOutputField: "output" },
      ...runOverrides,
    }),
    prompt,
    { ...baseResolved, ...resolvedOverrides },
  );

  const base = signature();
  assert.match(base, /^[0-9a-f]{64}$/);
  assert.equal(signature(), base);
  assert.notEqual(signature({}, {}, "Implement a different lane"), base);
  // jbs3.3 (edit-and-resume / prefix reuse): the lane signature is content-addressed PER LANE and
  // deliberately does NOT mix in the whole-file run.sourceHash — editing an unrelated part of the
  // body must not invalidate this lane's cached result. A lane's own resolved inputs (prompt, model,
  // role, schema, policy, runtimeArgs, signatureVersion) still fully determine its signature.
  assert.equal(signature({ sourceHash: "source-b" }), base, "sourceHash alone must NOT change a lane signature (per-lane content addressing)");
  assert.notEqual(signature({ runtimeArgs: { issue: "other" } }), base);
  assert.notEqual(signature({}, { modelKey: "anthropic/claude-sonnet" }), base);
  assert.notEqual(signature({}, { policy: { bash: "allow" } }), base);
  assert.notEqual(signature({}, { schema: { type: "object", required: ["ok"], properties: { ok: { type: "boolean" } } } }), base);
  // Design C: capability probes are gone from the lane signature — laneSignature now embeds a
  // constant `signatureVersion: 2` instead of the old capabilityMode object, so varying run.capabilities
  // must NOT change the signature (this is precisely how the version bump invalidates every pre-C
  // resume cache ONCE, deliberately, rather than keying resume on capability values forever).
  assert.equal(
    signature({ capabilities: { permissions: "shape-only", structuredOutput: false, structuredOutputField: "something-else" } }),
    base,
    "capabilities must not affect the lane signature (Design C: signatureVersion replaces capabilityMode)",
  );
});

test("finalizeStagedDomainMutations rejects unsupported staged operations", async () => {
  const dir = await tempDir("workflow-domain-unsupported");
  const run = makeRun(dir);
  await __test.stageDomainMutation(run, {
    mutationKey: "custom:1",
    operation: "custom.operation",
    payload: { id: "custom-1" },
  });

  await assert.rejects(
    () => __test.finalizeStagedDomainMutations(dir, { id: run.id }),
    /Unsupported staged domain mutation operation: custom\.operation/,
  );

  const records = await __test.readJsonlLedger(path.join(dir, "domain-ledger.jsonl"));
  assert.equal(records.some((record) => record.phase === "failed" && record.operation === "custom.operation"), true);
});

test("finalizeBeadsDomainMutation create-followup is idempotent across a crash-resume by external-ref", async () => {
  // R16: directly exercise the bd adapter with the deterministic key. The first call creates the
  // follow-up stamped with the key as its external-ref; a crash-resume re-run with the SAME key must
  // find the existing issue via external-ref and adopt it instead of issuing a second bd create.
  const { finalizeBeadsDomainMutation } = await import("../workflow-domains/beads/beads-drain-adapter.js");
  const issues = new Map();
  const calls = { create: 0, list: 0 };
  let nextId = 1;
  const runBd = async (args) => {
    const command = args[0];
    if (command === "create") {
      calls.create += 1;
      const id = `created-${nextId++}`;
      const externalRefIdx = args.indexOf("--external-ref");
      const issue = {
        id,
        title: args[args.indexOf("--title") + 1],
        status: "open",
        issue_type: "task",
        external_ref: externalRefIdx >= 0 ? args[externalRefIdx + 1] : undefined,
      };
      issues.set(id, issue);
      return { stdout: JSON.stringify(issue) };
    }
    if (command === "list") {
      calls.list += 1;
      return { stdout: JSON.stringify([...issues.values()]) };
    }
    if (command === "show") {
      const id = args[args.indexOf("--id") + 1];
      return { stdout: JSON.stringify([issues.get(id)]) };
    }
    throw new Error(`unexpected bd command: ${args.join(" ")}`);
  };

  const idempotencyKey = __test.domainMutationIdempotencyKey("bd-create:followup-1");
  const payload = { operation: "beads.create-followup", title: "Follow-up", idempotencyKey };

  const first = await finalizeBeadsDomainMutation(payload, { runBd });
  const second = await finalizeBeadsDomainMutation(payload, { runBd });

  assert.equal(calls.create, 1, "a crash-resume re-run must NOT create a second follow-up");
  assert.equal(first.id, second.id, "the re-run must return the originally created follow-up");
  assert.equal(issues.size, 1);
  assert.equal(first.external_ref, idempotencyKey);
});

test("finalizeBeadsDomainMutation append-notes is idempotent across a crash-resume by marker", async () => {
  // R16: appending the same note twice doubles it. The deterministic key is woven into the note as a
  // hidden marker and checked first, so a crash-resume re-run is a no-op rather than a doubled note.
  const { finalizeBeadsDomainMutation } = await import("../workflow-domains/beads/beads-drain-adapter.js");
  const issue = { id: "issue-1", status: "open", issue_type: "task", notes: "" };
  let appendCount = 0;
  const runBd = async (args) => {
    const command = args[0];
    if (command === "update" && args.includes("--append-notes")) {
      appendCount += 1;
      const note = args[args.indexOf("--append-notes") + 1];
      issue.notes = `${issue.notes}\n${note}`.trim();
      return { stdout: "updated\n" };
    }
    if (command === "show") return { stdout: JSON.stringify([issue]) };
    throw new Error(`unexpected bd command: ${args.join(" ")}`);
  };

  const idempotencyKey = __test.domainMutationIdempotencyKey("bd-note:issue-1");
  const payload = { operation: "beads.append-notes", issueId: "issue-1", note: "VALIDATION note body", idempotencyKey };

  await finalizeBeadsDomainMutation(payload, { runBd });
  await finalizeBeadsDomainMutation(payload, { runBd });

  assert.equal(appendCount, 1, "a crash-resume re-run must NOT append the note a second time");
  assert.equal((issue.notes.match(/VALIDATION note body/g) ?? []).length, 1, "the note body must appear exactly once");
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
    __test.writeJsonAtomic(target, { ok: true }),
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
    () => __test.writeJsonAtomic(target, { ok: true }),
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

  await __test.writeJsonAtomic(path.join(dir, "state.json"), { ok: true });
  await __test.appendLedger(dir, "domain-ledger.jsonl", { phase: "started", mutationKey: "m1" });
  await __test.writeLaneProjection(run, "lane:private", { status: "running" });
  const release = await __test.acquireWorkflowLock(__test.lockPathForRun(dir, "run"), { operation: "run", runId: run.id });

  assert.equal(await mode(dir), __test.PRIVATE_DIR_MODE);
  assert.equal(await mode(path.join(dir, "state.json")), __test.PRIVATE_FILE_MODE);
  assert.equal(await mode(path.join(dir, "domain-ledger.jsonl")), __test.PRIVATE_FILE_MODE);
  assert.equal(await mode(path.join(dir, "lanes")), __test.PRIVATE_DIR_MODE);
  assert.equal(await mode(path.join(dir, "lanes", `${__test.safeProjectionName("lane:private")}.json`)), __test.PRIVATE_FILE_MODE);
  assert.equal(await mode(__test.lockPathForRun(dir, "run")), __test.PRIVATE_FILE_MODE);

  await release();
});

test("writeLaneProjection serializes concurrent updates for the same lane", async () => {
  const dir = await tempDir("workflow-lane-projection-serialized");
  const run = makeRun(dir, { id: "serialized-projection-run" });

  await Promise.all([
    __test.writeLaneProjection(run, "lane:race", { status: "running", startedAt: "2026-06-15T00:00:00.000Z" }),
    __test.writeLaneProjection(run, "lane:race", { outcome: "success", completedAt: "2026-06-15T00:00:01.000Z" }),
  ]);

  const projected = JSON.parse(await fs.readFile(path.join(dir, "lanes", `${__test.safeProjectionName("lane:race")}.json`), "utf8"));
  assert.equal(projected.status, "running");
  assert.equal(projected.outcome, "success");
  assert.equal(projected.startedAt, "2026-06-15T00:00:00.000Z");
  assert.equal(projected.completedAt, "2026-06-15T00:00:01.000Z");
  assert.equal(run.laneRecords.get("lane:race").outcome, "success");
});

test("writeState does not rewrite clean lane projection files", async () => {
  const dir = await tempDir("workflow-lane-projection-clean");
  const run = makeRun(dir, { id: "clean-projection-run" });

  await __test.writeLaneProjection(run, "lane:clean", { status: "completed", outcome: "success" });
  const cleanPath = path.join(dir, "lanes", `${__test.safeProjectionName("lane:clean")}.json`);
  const before = await fs.readFile(cleanPath, "utf8");

  await __test.writeState(run);
  const after = await fs.readFile(cleanPath, "utf8");
  assert.equal(after, before, "writeState must not re-stamp a clean lane projection");

  run.laneRecords.set("lane:manual", { callId: "lane:manual", status: "completed", outcome: "success" });
  await __test.writeState(run);
  const manual = JSON.parse(await fs.readFile(path.join(dir, "lanes", `${__test.safeProjectionName("lane:manual")}.json`), "utf8"));
  assert.equal(manual.callId, "lane:manual", "writeState still backfills records not written through writeLaneProjection");
});

test("workflow pause is permissioned as a mutating durable lifecycle tool", () => {
  assert.equal(__test.ACTIVE_STATUSES.has("pausing"), true);
  assert.equal(__test.WORKFLOW_MUTATING_TOOLS.includes("workflow_pause"), true);
});

test("fanout-cancel of a just-handed-off waiter releases its slot (no activeAgents leak)", async () => {
  // R5 regression: releaseAgentSlot hands a slot to a queued waiter WITHOUT
  // decrementing activeAgents. If that waiter's lane is fanout-cancelled in the
  // microtask window after the hand-off, acquireAgentSlot must release the slot
  // before throwing — otherwise runChildAgent's finally (acquired=false) skips
  // releaseAgentSlot and activeAgents permanently inflates -> deadlock.
  const run = {
    concurrency: 1,
    // Slot is fully held by a prior lane, so the new lane queues as a waiter.
    activeAgents: 1,
    waitingAgents: [],
    cancelledFanoutScopes: new Set(),
    abortController: new AbortController(),
  };

  // Queue the waiter; the slot is occupied so this awaits inside acquireAgentSlot.
  const waiterCallId = "fanout-scope/lane:1";
  const acquire = __test.acquireAgentSlot(run, waiterCallId);
  assert.equal(run.waitingAgents.length, 1, "waiter should be queued behind the held slot");

  // Hand the slot off to the waiter (resolve without decrementing activeAgents),
  // then — synchronously, before the resolved continuation runs — fanout-cancel
  // the waiter's scope. This is exactly the leak window from the finding.
  __test.releaseAgentSlot(run);
  assert.equal(run.activeAgents, 1, "hand-off must not decrement activeAgents");
  run.cancelledFanoutScopes.add("fanout-scope");

  await assert.rejects(acquire, (error) => error?.code === "WORKFLOW_CANCELLED");

  // The fix releases the handed-off slot before throwing, so it returns to 0.
  assert.equal(run.activeAgents, 0, "fanout-cancel after hand-off must not leak the slot");
});

test("corrupt/partial lock file is detected as corrupt and not stale", async () => {
  const dir = await tempDir("workflow-corrupt-lock");
  const lockPath = __test.lockPathForRun(dir, "run");
  // A crash mid-write leaves an unparseable (partial) lock on disk.
  await fs.writeFile(lockPath, '{"acquiredAt":"2026-06-15T00:00:00.000Z","proc', "utf8");

  const lock = await __test.readLock(lockPath);
  assert.equal(lock.corrupt, true, "unparseable lock must be flagged corrupt");
  assert.equal(lock.stale, false, "corrupt lock has no process so it is not classified stale");
  assert.equal(lock.active, false);
});

test("corrupt lock blocks acquisition with a reconcile recovery hint", async () => {
  const dir = await tempDir("workflow-corrupt-lock-acquire");
  const lockPath = __test.lockPathForRun(dir, "run");
  await fs.writeFile(lockPath, "not-json-at-all", "utf8");

  await assert.rejects(
    __test.acquireWorkflowLock(lockPath, { operation: "run" }),
    (error) => /already held \(corrupt\)/.test(error.message)
      && /workflow_reconcile/.test(error.message),
    "corrupt lock must surface a corrupt state + reconcile recovery hint",
  );
});

test("clearStaleRunLocks clears a corrupt lock so the run is acquirable again", async () => {
  const root = await tempDir("workflow-corrupt-lock-clear");
  const runId = "corrupt-lock-run";
  const dir = __test.runDirForRoot(root, runId);
  await fs.mkdir(dir, { recursive: true });
  await __test.writeJsonAtomic(path.join(dir, "state.json"), {
    id: runId,
    status: "completed",
    startedAt: "2026-06-15T00:00:00.000Z",
  });
  // Simulate a partial-write run.lock left behind by a crash.
  const lockPath = __test.lockPathForRun(dir, "run");
  await fs.writeFile(lockPath, '{"operation":"run","acquir', "utf8");

  // Before reconcile, the corrupt lock surfaces in state.locks (wedging cleanup)
  // and blocks acquisition.
  const before = await __test.runLocksForEntry({ kind: "valid", dir });
  assert.equal(before.run.corrupt, true, "corrupt lock should appear in run locks");
  await assert.rejects(
    __test.acquireWorkflowLock(lockPath, { operation: "run" }),
    /already held \(corrupt\)/,
  );

  // Reconcile (clearStaleLocks) must clear the corrupt lock like a stale one.
  const cleared = await __test.clearStaleRunLocks({ kind: "valid", dir });
  assert.deepEqual(
    cleared.map((entry) => ({ operation: entry.operation, reason: entry.reason })),
    [{ operation: "run", reason: "corrupt" }],
    "corrupt run lock must be cleared with reason=corrupt",
  );
  assert.equal(await fs.access(lockPath).then(() => true, () => false), false, "lock file removed");

  // The run is acquirable again, and the lock is now a fully-written record.
  const release = await __test.acquireWorkflowLock(lockPath, { operation: "run" });
  const reacquired = await __test.readLock(lockPath);
  assert.equal(reacquired.corrupt ?? false, false, "reacquired lock must be parseable");
  assert.equal(reacquired.operation, "run");
  await release();
  assert.equal(await fs.access(lockPath).then(() => true, () => false), false, "release removes the lock");
});

test("readLock classifies a transient non-ENOENT read error as unreadable, not corrupt (pi0w)", async (t) => {
  // pi0w regression: a failed READ (EACCES/EMFILE/EIO) tells us nothing about whether the
  // lock's owner is alive. It must be classified `unreadable`, never `corrupt`, so reconcile
  // does not delete a possibly-live lock on a filesystem hiccup. Only JSON.parse failure is corrupt.
  const dir = await tempDir("workflow-unreadable-lock");
  const lockPath = __test.lockPathForRun(dir, "run");
  // A fully-written, parseable lock exists on disk; the failure is purely at the read step.
  const release = await __test.acquireWorkflowLock(lockPath, { operation: "run", runId: "live-owner" });
  try {
    const originalReadFile = fs.readFile;
    const mock = t.mock.method(fs, "readFile", async (filePath, ...rest) => {
      if (String(filePath) === lockPath) {
        const error = new Error("too many open files");
        error.code = "EMFILE";
        throw error;
      }
      return await originalReadFile.call(fs, filePath, ...rest);
    });

    const lock = await __test.readLock(lockPath);
    assert.equal(lock.unreadable, true, "a transient read error must be classified unreadable");
    assert.notEqual(lock.corrupt, true, "a transient read error must NOT be classified corrupt");
    assert.equal(lock.stale, false, "an unreadable lock is not stale");
    assert.equal(lock.active, false);
    mock.mock.restore();
  } finally {
    await release();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("clearStaleRunLocks does not delete an actively-held lock on a transient read error (pi0w)", async (t) => {
  // pi0w core regression: while a run.lock is held by a live process, a single transient read
  // failure on that lock path must not let clearStaleRunLocks (invoked from killRun on a foreign
  // run, and from workflow_reconcile) remove it — that would let a second process resume the run
  // concurrently, the exact corruption this lock prevents.
  const root = await tempDir("workflow-unreadable-lock-clear");
  const runId = "unreadable-lock-run";
  const dir = __test.runDirForRoot(root, runId);
  await fs.mkdir(dir, { recursive: true });
  const lockPath = __test.lockPathForRun(dir, "run");
  const release = await __test.acquireWorkflowLock(lockPath, { operation: "run", runId });
  try {
    const originalReadFile = fs.readFile;
    const mock = t.mock.method(fs, "readFile", async (filePath, ...rest) => {
      if (String(filePath) === lockPath) {
        const error = new Error("permission denied");
        error.code = "EACCES";
        throw error;
      }
      return await originalReadFile.call(fs, filePath, ...rest);
    });

    const cleared = await __test.clearStaleRunLocks({ kind: "valid", dir });
    assert.deepEqual(cleared, [], "a transiently-unreadable, actively-held lock must NOT be cleared");

    mock.mock.restore();
    assert.equal(await fs.access(lockPath).then(() => true, () => false), true, "the live lock file must remain on disk");
    const reread = await __test.readLock(lockPath);
    assert.equal(reread.active, true, "the still-held lock reads back as active once the read succeeds again");
  } finally {
    await release();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("readLock ages out live-PID locks that lack a recorded process start time", async () => {
  const dir = await tempDir("workflow-startless-lock-ttl");
  const lockPath = __test.lockPathForRun(dir, "run");
  await __test.writeJsonAtomic(lockPath, {
    operation: "run",
    runId: "startless-lock",
    acquiredAt: "1970-01-01T00:00:00.000Z",
    process: { pid: process.pid },
  });

  const lock = await __test.readLock(lockPath);

  assert.equal(lock.active, false);
  assert.equal(lock.stale, true);
});

test("workflow lock release does not unlink a reclaimed lock with a different process start time", async () => {
  const dir = await tempDir("workflow-lock-release-reclaimed");
  const lockPath = __test.lockPathForRun(dir, "run");
  const releaseStaleOwner = await __test.acquireWorkflowLock(lockPath, { operation: "run", runId: "first-owner" });
  const first = await __test.readLock(lockPath);
  assert.equal(first.process.pid, process.pid);

  await __test.writeJsonAtomic(lockPath, {
    stateVersion: __test.DURABLE_STATE_VERSION,
    acquiredAt: new Date().toISOString(),
    operation: "run",
    runId: "reclaimed-owner",
    process: {
      pid: process.pid,
      startTime: (first.process.startTime ?? 0) + 1,
    },
  });

  await releaseStaleOwner();

  const after = await __test.readLock(lockPath);
  assert.equal(after.runId, "reclaimed-owner", "stale release must leave the reclaimed lock in place");
  assert.notEqual(after.process.startTime, first.process.startTime);
});

test("readRunEntry reconcile clears a corrupt lock out of state.locks", async () => {
  const root = await tempDir("workflow-corrupt-lock-reconcile");
  const runId = "corrupt-lock-reconcile-run";
  const dir = __test.runDirForRoot(root, runId);
  await fs.mkdir(dir, { recursive: true });
  await __test.writeJsonAtomic(path.join(dir, "state.json"), {
    id: runId,
    status: "completed",
    startedAt: "2026-06-15T00:00:00.000Z",
  });
  await fs.writeFile(__test.lockPathForRun(dir, "run"), "{partial", "utf8");

  const reconciled = await __test.readRunEntry(root, runId, { reconcile: true, clearStaleLocks: true });
  assert.equal(reconciled.state.locks, undefined, "corrupt lock must be gone after reconcile");
  assert.deepEqual(
    (reconciled.state.staleLocksCleared ?? []).map((entry) => entry.reason),
    ["corrupt"],
    "reconcile must report the corrupt lock it cleared",
  );
});

test("processAppearsAlive distrusts a recorded-start PID when the live start time is unreadable (R23)", async () => {
  // R23 regression: the owner recorded a finite process start time, the PID is still alive
  // (process.pid is this very process), but the live start time cannot be read (/proc
  // unreadable, hidepid/EPERM, TOCTOU). A non-finite liveStart MUST be treated as distrust
  // — otherwise a reused PID is pinned as active and reconcile/cleanup is blocked.
  const processInfo = { pid: process.pid, startTime: 12345 };

  for (const unreadable of [undefined, NaN, Infinity, -Infinity, null]) {
    const result = await __test.processAppearsAlive(processInfo, {
      readStartTime: async () => unreadable,
    });
    assert.equal(
      result,
      false,
      `non-finite live start (${String(unreadable)}) with a recorded start must yield not-alive`,
    );
  }

  // Control: an alive PID whose readable live start matches the recorded start is alive.
  const matching = await __test.processAppearsAlive(processInfo, {
    readStartTime: async () => 12345,
  });
  assert.equal(matching, true, "a readable matching live start must remain alive");

  // Control: a readable live start that differs (classic PID reuse) is not-alive.
  const mismatched = await __test.processAppearsAlive(processInfo, {
    readStartTime: async () => 99999,
  });
  assert.equal(mismatched, false, "a readable mismatched live start must yield not-alive");

  // Control: with NO recorded start there is nothing to confirm, so the bare liveness check
  // governs and an unreadable live start does NOT flip a live PID to not-alive.
  const noRecord = await __test.processAppearsAlive(
    { pid: process.pid },
    { readStartTime: async () => undefined },
  );
  assert.equal(noRecord, true, "no recorded start falls back to bare liveness (stays alive)");

  const freshStartlessLock = await __test.processAppearsAlive(
    { process: { pid: process.pid }, acquiredAt: "2026-06-15T00:00:00.000Z" },
    { now: Date.parse("2026-06-15T00:00:10.000Z"), lockTtlMs: 60_000 },
  );
  assert.equal(freshStartlessLock, true, "a fresh startless lock may use bare liveness before the TTL");

  const expiredStartlessLock = await __test.processAppearsAlive(
    { process: { pid: process.pid }, acquiredAt: "2026-06-15T00:00:00.000Z" },
    { now: Date.parse("2026-06-15T00:02:00.000Z"), lockTtlMs: 60_000 },
  );
  assert.equal(expiredStartlessLock, false, "a startless lock must age out by TTL to avoid PID-reuse wedges");
});

// The event hook is fire-and-forget and must never throw (AGENTS.md). rehydratePendingNotifications
// scans run roots with fs.readdir, which can reject with EPERM/EACCES (permission-restricted root,
// hidepid, sandbox). Such an error must be swallowed rather than propagated out of the event hook.
test("event hook returns normally when readdir rejects with EPERM", async (t) => {
  const dir = await tempDir("workflow-event-eperm");
  const savedPending = new Set(__test.pendingNotificationPaths);
  __test.pendingNotificationPaths.clear();
  const readdirMock = t.mock.method(fs, "readdir", async () => {
    const error = new Error("operation not permitted");
    error.code = "EPERM";
    throw error;
  });
  try {
    const pluginContext = {
      directory: dir,
      worktree: dir,
      client: { session: { promptAsync: async () => ({}) } },
    };
    const hooks = await WorkflowPlugin(pluginContext);
    // The session.idle event drives deliverWorkflowNotifications -> rehydratePendingNotifications,
    // which calls fs.readdir on each run root. The mock makes every root reject with EPERM.
    await assert.doesNotReject(() =>
      hooks.event({ event: { type: "session.idle", properties: { sessionID: "eperm-session" } } }),
    );
  } finally {
    // Restore readdir before cleanup so the recursive rm is not affected by the EPERM mock.
    readdirMock.mock.restore();
    __test.pendingNotificationPaths.clear();
    for (const value of savedPending) __test.pendingNotificationPaths.add(value);
    await fs.rm(dir, { recursive: true, force: true });
  }
});
