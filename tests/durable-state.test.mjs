import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import WorkflowPlugin from "../workflow-kernel/index.js";
import { ACTIVE_STATUSES } from "../workflow-kernel/constants.js";
import { assertSafeRunId, ensureRunRoot, runDirForRoot, runRoots, safeProjectionName } from "../workflow-kernel/run-store-fs.js";
import { checkBudgetBeforeLaunch, normalizeBudgetCeilings } from "../workflow-kernel/budget-accounting.js";
import { cleanupWorktrees } from "../workflow-kernel/workflow-plugin.js";
import { redactValue, truncateText } from "../workflow-kernel/text-json.js";
import { normalizePatternList, parseModel, WORKFLOW_MUTATING_TOOLS } from "../workflow-kernel/authority-policy.js";
import { resolveWorkflowSource, workflowFileName } from "../workflow-kernel/workflow-source.js";
import { withTimeout } from "../workflow-kernel/async-util.js";

const { __test } = WorkflowPlugin;

// Residual helper-contract regressions. opencode-workflows-fnop.9 split the durability and
// error-state contracts out of this file into behavior-owned suites:
//   locks -> run-store-locks.test.mjs
//   journals -> event-journal.test.mjs
//   notifications -> lifecycle-notifications.test.mjs
//   projections -> run-store-projections.test.mjs
//   recovery -> run-store-recovery.test.mjs
//   roles -> role-template-loading.test.mjs
//   toast -> notification-toast-card-phase.test.mjs
//   structured-output -> structured-output-registry.test.mjs
// What remains here are misc kernel/run-store helper unit tests that do not belong to any of
// those eight contracts (worktree-cleanup robustness, fs path-safety helpers, text redaction,
// model/pattern parsing, source-name validation, async timeout, budget-boundary math, lifecycle
// permission classification, and agent-slot concurrency). They are intentionally retained rather
// than forced into a durability bucket.

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
    assert.equal(await cleanupWorktrees(run), true);
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
    () => ensureRunRoot({ directory: dir, worktree: dir }),
    /Could not create a writable workflow run directory/,
  );
  assert.deepEqual(attemptedRoots, runRoots({ directory: dir, worktree: dir }));
});

test("truncateText preserves exact max length and truncates max+1", () => {
  const exact = "x".repeat(40);
  assert.equal(truncateText(exact, 40), exact);

  const truncated = truncateText(`${exact}y`, 40);
  assert.equal(truncated.length, 40);
  // 41-char input at max=40: the "...[truncated 24 chars]" suffix (23 chars) is carved out
  // of the budget, leaving a 17-char head — so 41 - 17 = 24 chars are actually dropped.
  assert.match(truncated, /\.\.\.\[truncated 24 chars\]$/);

  const surrogate = truncateText(`prefix ${"x".repeat(20)}😀 suffix`, 40);
  assert.notEqual(surrogate.charCodeAt(surrogate.indexOf("...[truncated") - 1), 0xd83d);
  assert.doesNotMatch(surrogate, /\ud83d(?![\udc00-\udfff])/u);
});

test("parseModel and normalizePatternList cover split and validation edges", () => {
  assert.deepEqual(parseModel("openai/gpt/4.1"), { providerID: "openai", modelID: "gpt/4.1" });
  assert.deepEqual(parseModel("a/b"), { providerID: "a", modelID: "b" });
  assert.equal(parseModel("/model"), undefined);
  assert.equal(parseModel("provider/"), undefined);
  assert.equal(parseModel(42), undefined);

  assert.deepEqual(normalizePatternList([" bd status ", "bd status"], "shell.allow"), ["bd status"]);
  assert.deepEqual(
    normalizePatternList(Array.from({ length: 1000 }, () => " bd status "), "shell.allow"),
    ["bd status"],
  );
  assert.throws(() => normalizePatternList("   ", "shell.allow"), /shell\.allow entries must be non-empty strings/);
  assert.throws(() => normalizePatternList(["bd status", 1], "shell.allow"), /shell\.allow entries must be non-empty strings/);
});

test("workflow source helpers reject missing source and invalid names", async () => {
  await assert.rejects(
    () => resolveWorkflowSource({ directory: process.cwd(), worktree: process.cwd() }, {}),
    /Provide `source`, `scriptPath`, or `name`/,
  );

  assert.equal(workflowFileName("valid-name"), "valid-name.js");
  assert.throws(() => workflowFileName("has spaces"), /Workflow name must be a simple slug/);
  assert.throws(() => workflowFileName("a".repeat(64)), /Workflow name must be a simple slug/);
});

test("assertSafeRunId covers traversal, dot names, and length boundaries", () => {
  assert.equal(assertSafeRunId("a"), "a");
  assert.equal(assertSafeRunId("a".repeat(128)), "a".repeat(128));

  for (const runId of [".", "..", "run/../../secret", "../secret", "/absolute", "", "a".repeat(129)]) {
    assert.throws(
      () => assertSafeRunId(runId),
      /runId must be a simple run id without path separators/,
      `${runId || "empty run id"} should be rejected`,
    );
  }

  assert.throws(
    () => runDirForRoot("/tmp/workflow-root", "../secret"),
    /runId must be a simple run id without path separators/,
  );
});

test("safeProjectionName sanitizes, caps, and falls back for punctuation-only ids", () => {
  assert.equal(safeProjectionName(" lane:/one "), "lane_one");
  assert.equal(safeProjectionName("a".repeat(140)).length, 120);
  assert.match(safeProjectionName("!!!"), /^[0-9a-f]{16}$/);
});

test("withTimeout rejects immediately for pre-aborted signals and preserves timeout errors", async () => {
  const controller = new AbortController();
  controller.abort();
  let called = false;
  let abortCleanupCalled = false;

  await assert.rejects(
    () => withTimeout(() => {
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
  const pending = withTimeout(() => new Promise(() => {}), {
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
    () => withTimeout(() => new Promise(() => {}), {
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
    () => withTimeout(() => new Promise(() => {}), {
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

  assert.doesNotThrow(() => checkBudgetBeforeLaunch(run));

  run.replayedCost = 0.01;
  assert.throws(() => checkBudgetBeforeLaunch(run), (error) => error?.code === "WORKFLOW_BUDGET_STOPPED");

  run.cost = 0;
  run.replayedCost = 0;
  run.tokens.reasoning = 3;
  assert.throws(() => checkBudgetBeforeLaunch(run), (error) => error?.code === "WORKFLOW_BUDGET_STOPPED");

  run.tokens = { input: NaN, output: 1, reasoning: 1 };
  run.replayedTokens = zeroTokens();
  assert.doesNotThrow(() => checkBudgetBeforeLaunch(run));
  assert.deepEqual(normalizeBudgetCeilings({ maxCost: 0, maxTokens: 1.5 }), { maxCost: 0, maxTokens: undefined });
});

test("redaction preserves numeric usage tokens but redacts credential tokens", () => {
  const redacted = redactValue({
    tokens: { input: 10, output: 2, reasoning: 1 },
    accessToken: "secret-token",
    nested: { idToken: "secret-id-token", tokenUsage: { input: 1, output: 1 } },
  });

  assert.deepEqual(redacted.tokens, { input: 10, output: 2, reasoning: 1 });
  assert.equal(redacted.accessToken, "[redacted]");
  assert.equal(redacted.nested.idToken, "[redacted]");
  assert.deepEqual(redacted.nested.tokenUsage, { input: 1, output: 1 });
});

test("workflow pause is permissioned as a mutating durable lifecycle tool", () => {
  assert.equal(ACTIVE_STATUSES.has("pausing"), true);
  assert.equal(WORKFLOW_MUTATING_TOOLS.includes("workflow_pause"), true);
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
