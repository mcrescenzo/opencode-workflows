import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { drain, validateLaneReport, validateValidationReport } from "../workflow-kernel/drain-runtime.js";
import { createWorktreeAdapter } from "../workflow-kernel/worktree-adapter.js";

const execFileAsync = promisify(execFile);

function laneReport(itemId, overrides = {}) {
  return {
    itemId,
    outcome: "implemented",
    summary: `implemented ${itemId}`,
    readyForIntegration: true,
    filesChanged: [],
    commandsRun: [],
    acceptanceEvidence: [],
    residualRisks: [],
    followups: [],
    ...overrides,
  };
}

function validationReport(itemId, overrides = {}) {
  return {
    itemId,
    accepted: true,
    reason: `accepted ${itemId}`,
    diffScopeOk: true,
    followupsHandled: true,
    acceptanceChecklist: [],
    validationCommands: [],
    followups: [],
    ...overrides,
  };
}

function fakeAdapter(items, overrides = {}) {
  const state = {
    items: items.map((item) => ({ ...item })),
    calls: { discover: 0, classify: [], claim: [], buildLanePacket: [], validate: [], close: [], createFollowup: [], proveDry: 0 },
  };
  const adapter = {
    name: "fake",
    async discover() {
      state.calls.discover += 1;
      return state.items.filter((item) => item.status !== "closed");
    },
    async classify(item) {
      state.calls.classify.push(item.id);
      return item.classification || "ready";
    },
    async claim(item) {
      state.calls.claim.push(item.id);
      item.claimed = true;
      return { itemId: item.id, claimed: true };
    },
    async buildLanePacket(item, context) {
      state.calls.buildLanePacket.push({ itemId: item.id, attempt: context.attempt, priorValidation: context.priorValidation });
      return { itemId: item.id, attempt: context.attempt, priorValidation: context.priorValidation };
    },
    async validate(item, integrationState, context) {
      state.calls.validate.push({ itemId: item.id, attempt: context.attempt, integrationState });
      return validationReport(item.id);
    },
    async close(item, evidence) {
      state.calls.close.push({ itemId: item.id, evidence });
      item.status = "closed";
      return { itemId: item.id, closed: true };
    },
    async createFollowup(followup) {
      const created = { id: `followup-${state.calls.createFollowup.length + 1}`, ...followup };
      state.calls.createFollowup.push(created);
      return created;
    },
    async proveDry() {
      state.calls.proveDry += 1;
      return { dry: state.items.every((item) => item.status === "closed" || item.classification !== "ready") };
    },
    ...overrides,
  };
  return { adapter, state };
}

// --- Characterization tests pinning the exact phase-trace order before the
// drain() extraction refactor (bd opencode-workflows-zhgn). These assert the
// append-only report.phases sequence for each break level so the extraction of
// runWave/processReadyItem/runLaneAttempt cannot silently reorder or drop a phase.

test("phase trace: single ready item closes in one wave/attempt (exact order)", async () => {
  const { adapter } = fakeAdapter([{ id: "item-1", classification: "ready" }]);
  const report = await drain({ adapter, runLane: async (packet) => laneReport(packet.itemId) });
  assert.equal(report.status, "complete");
  assert.deepEqual(report.phases, [
    "preflight",
    "snapshot", "classify", "plan_wave", "claim",
    "spawn_lanes", "monitor", "collect_reports", "integrate", "validate", "close",
    // wave 2 re-snapshots, finds the now-closed item gone, and breaks (drained).
    "resnapshot", "classify",
    "final_audit", "complete",
  ]);
});

test("phase trace: validation-reject then accept inserts repair between attempts (exact order)", async () => {
  let validationCalls = 0;
  const { adapter } = fakeAdapter([{ id: "item-1", classification: "ready" }], {
    async validate(item) {
      validationCalls += 1;
      return validationReport(item.id, validationCalls === 1 ? { accepted: false, reason: "needs repair" } : {});
    },
  });
  const report = await drain({ adapter, maxAttempts: 2, runLane: async (packet) => laneReport(packet.itemId) });
  assert.equal(report.status, "complete");
  assert.deepEqual(report.phases, [
    "preflight",
    "snapshot", "classify", "plan_wave", "claim",
    "spawn_lanes", "monitor", "collect_reports", "integrate", "validate", "repair",
    "spawn_lanes", "monitor", "collect_reports", "integrate", "validate", "close",
    "resnapshot", "classify",
    "final_audit", "complete",
  ]);
});

test("phase trace: not-ready retry repairs before integrate/validate (exact order)", async () => {
  let lanes = 0;
  const { adapter } = fakeAdapter([{ id: "item-1", classification: "ready" }]);
  const report = await drain({
    adapter,
    maxAttempts: 2,
    runLane: async (packet) => {
      lanes += 1;
      return lanes === 1
        ? laneReport(packet.itemId, { readyForIntegration: false, outcome: "no-op", summary: "not ready yet" })
        : laneReport(packet.itemId);
    },
  });
  assert.equal(report.status, "complete");
  assert.deepEqual(report.phases, [
    "preflight",
    "snapshot", "classify", "plan_wave", "claim",
    "spawn_lanes", "monitor", "collect_reports", "repair",
    "spawn_lanes", "monitor", "collect_reports", "integrate", "validate", "close",
    "resnapshot", "classify",
    "final_audit", "complete",
  ]);
});

test("opt-in repair backoff waits an exponential, injectable delay between repair attempts", async () => {
  let lanes = 0;
  const sleeps = [];
  const { adapter } = fakeAdapter([{ id: "item-1", classification: "ready" }]);
  const report = await drain({
    adapter,
    maxAttempts: 3,
    retryBackoffBaseMs: 10,
    sleep: async (ms) => { sleeps.push(ms); },
    runLane: async (packet) => {
      lanes += 1;
      // Fail (not-ready) on the first two attempts so two repairs occur, then succeed.
      return lanes < 3
        ? laneReport(packet.itemId, { readyForIntegration: false, outcome: "no-op", summary: `not ready ${lanes}` })
        : laneReport(packet.itemId);
    },
  });
  assert.equal(report.status, "complete");
  // Two repairs => two backoff sleeps with the deterministic exponential curve 10, 20.
  assert.deepEqual(sleeps, [10, 20]);
});

test("repair backoff is opt-in: with no retryBackoffBaseMs the injected sleep is never called", async () => {
  let lanes = 0;
  let sleepCalls = 0;
  const { adapter } = fakeAdapter([{ id: "item-1", classification: "ready" }]);
  const report = await drain({
    adapter,
    maxAttempts: 2,
    sleep: async () => { sleepCalls += 1; },
    runLane: async (packet) => {
      lanes += 1;
      return lanes === 1
        ? laneReport(packet.itemId, { readyForIntegration: false, outcome: "no-op", summary: "not ready yet" })
        : laneReport(packet.itemId);
    },
  });
  assert.equal(report.status, "complete");
  assert.equal(sleepCalls, 0, "default (unconfigured) backoff preserves the historical no-delay repair loop");
});

test("phase trace: lane fail at maxAttempts=1 stops before integrate (exact order)", async () => {
  const { adapter } = fakeAdapter([{ id: "item-1", classification: "ready" }]);
  const report = await drain({
    adapter,
    maxAttempts: 1,
    runLane: async (packet) => laneReport(packet.itemId, { readyForIntegration: false, outcome: "failed", summary: "boom" }),
  });
  assert.equal(report.status, "failed");
  assert.deepEqual(report.phases, [
    "preflight",
    "snapshot", "classify", "plan_wave", "claim",
    "spawn_lanes", "monitor", "collect_reports",
    "final_audit", "complete",
  ]);
});

test("phase trace: dryRun plans without claim/lane phases (exact order)", async () => {
  const { adapter } = fakeAdapter([{ id: "item-1", classification: "ready" }]);
  const report = await drain({ adapter, dryRun: true });
  assert.equal(report.status, "dry_run_complete");
  assert.deepEqual(report.phases, [
    "preflight", "snapshot", "classify", "plan_wave", "final_audit", "complete",
  ]);
});

test("phase trace: budget-exhausted before claim never reaches the claim phase (exact order)", async () => {
  const { adapter } = fakeAdapter([{ id: "item-1", classification: "ready" }]);
  const report = await drain({
    adapter,
    canLaunchLane: async (context) => context.phase !== "preclaim",
    runLane: async () => assert.fail("must not launch a lane"),
  });
  assert.equal(report.status, "budget_exhausted");
  assert.deepEqual(report.phases, [
    "preflight", "snapshot", "classify", "plan_wave", "final_audit", "complete",
  ]);
});

test("phase trace: no ready work in wave 1 skips plan_wave entirely (exact order)", async () => {
  const { adapter } = fakeAdapter([{ id: "blocked", classification: { status: "blocked", reason: "dep" } }], {
    async proveDry() { return { dry: false, reason: "still blocked work" }; },
  });
  const report = await drain({ adapter, runLane: async (packet) => laneReport(packet.itemId) });
  assert.equal(report.status, "not_dry");
  assert.deepEqual(report.phases, [
    "preflight", "snapshot", "classify", "final_audit", "complete",
  ]);
});

test("lifecycle check after discover stops before classify and final proof", async () => {
  const { adapter, state } = fakeAdapter([{ id: "item-1", classification: "ready" }]);
  const seen = [];
  const error = new Error("cancelled after discover");
  error.code = "WORKFLOW_CANCELLED";

  await assert.rejects(
    drain({
      adapter,
      runLane: async (packet) => laneReport(packet.itemId),
      checkLifecycle(context) {
        seen.push(`${context.phase}:${context.point}`);
        if (context.phase === "discover" && context.point === "after") throw error;
      },
    }),
    /cancelled after discover/,
  );

  assert.equal(state.calls.discover, 1);
  assert.deepEqual(state.calls.classify, []);
  assert.equal(state.calls.proveDry, 0);
  assert.ok(seen.includes("discover:after"));
});

test("lifecycle check after validation stops before close", async () => {
  const { adapter, state } = fakeAdapter([{ id: "item-1", classification: "ready" }]);
  const error = new Error("paused after validation");
  error.code = "WORKFLOW_CANCELLED";

  await assert.rejects(
    drain({
      adapter,
      runLane: async (packet) => laneReport(packet.itemId),
      checkLifecycle(context) {
        if (context.phase === "validate" && context.point === "after") throw error;
      },
    }),
    /paused after validation/,
  );

  assert.equal(state.calls.validate.length, 1);
  assert.deepEqual(state.calls.close, []);
  assert.equal(state.calls.proveDry, 0);
});

test("fake adapter drains ready item to dry completion", async () => {
  const { adapter, state } = fakeAdapter([{ id: "item-1", classification: "ready" }]);
  const integrations = [];
  const report = await drain({
    adapter,
    runLane: async (packet) => laneReport(packet.itemId, { acceptanceEvidence: ["local check passed"] }),
    integrate: async (laneReports) => {
      integrations.push(laneReports);
      return { status: "integrated", laneReports };
    },
  });

  assert.equal(report.status, "complete");
  assert.deepEqual(state.calls.claim, ["item-1"]);
  assert.equal(integrations.length, 1);
  assert.equal(state.calls.validate.length, 1);
  assert.equal(state.calls.close.length, 1);
  assert.equal(state.calls.proveDry, 1);
  assert.equal(report.closed[0].itemId, "item-1");
});

test("dryRun plans ready work without mutation or lane hooks", async () => {
  const { adapter, state } = fakeAdapter([
    { id: "item-1", classification: "ready" },
    { id: "blocked", classification: { status: "blocked", reason: "dependency" } },
  ]);

  const report = await drain({ adapter, dryRun: true, scope: { labels: ["ready-for-agent"] }, gateStatus: { permissions: "verified" } });

  assert.equal(report.status, "dry_run_complete");
  assert.equal(report.dryRun, true);
  assert.deepEqual(report.scope, { labels: ["ready-for-agent"] });
  assert.deepEqual(report.gateStatus, { permissions: "verified" });
  assert.deepEqual(report.planned.map((item) => item.itemId), ["item-1"]);
  assert.deepEqual(report.skipped.map((item) => item.itemId), ["blocked"]);
  assert.deepEqual(state.calls.claim, []);
  assert.deepEqual(state.calls.buildLanePacket, []);
  assert.deepEqual(state.calls.validate, []);
  assert.deepEqual(state.calls.close, []);
  assert.deepEqual(state.calls.createFollowup, []);
  assert.equal(state.calls.proveDry, 1);
  assert.equal(report.dryProof.dry, false);
});

test("runtime handles validation failure retry as repair", async () => {
  let validationCalls = 0;
  const { adapter, state } = fakeAdapter([{ id: "item-1", classification: "ready" }], {
    async validate(item) {
      validationCalls += 1;
      return validationReport(item.id, validationCalls === 1 ? { accepted: false, reason: "needs repair" } : {});
    },
  });

  const report = await drain({ adapter, maxAttempts: 2, runLane: async (packet) => laneReport(packet.itemId) });

  assert.equal(report.status, "complete");
  assert.equal(state.calls.buildLanePacket.length, 2);
  assert.equal(state.calls.buildLanePacket[1].priorValidation.reason, "needs repair");
  assert.equal(state.calls.close.length, 1);
  assert.ok(report.phases.includes("repair"));
});

test("runtime creates followups before close", async () => {
  const { adapter, state } = fakeAdapter([{ id: "item-1", classification: "ready" }]);
  const report = await drain({
    adapter,
    runLane: async (packet) => laneReport(packet.itemId, { followups: [{ title: "document finding", source: packet.itemId }] }),
  });

  assert.equal(report.status, "complete");
  assert.equal(state.calls.createFollowup.length, 1);
  assert.equal(state.calls.createFollowup[0].title, "document finding");
  assert.equal(state.calls.close.length, 1);
  assert.equal(state.calls.close[0].evidence.laneReport.followups.length, 1);
});

test("runtime skips non-ready classifications", async () => {
  const { adapter, state } = fakeAdapter([
    { id: "ready", classification: "ready" },
    { id: "blocked", classification: { status: "blocked", reason: "dependency" } },
    { id: "human", classification: "human-gated" },
    { id: "done", classification: "done" },
  ]);
  const report = await drain({ adapter, runLane: async (packet) => laneReport(packet.itemId) });

  assert.equal(report.status, "complete");
  assert.deepEqual(state.calls.claim, ["ready"]);
  assert.deepEqual(report.skipped.map((item) => item.itemId).sort(), ["blocked", "done", "human"]);
});

test("runtime does not complete when final dry proof fails", async () => {
  const { adapter } = fakeAdapter([{ id: "item-1", classification: "ready" }], {
    async proveDry() {
      return { dry: false, reason: "new work remains" };
    },
  });
  const report = await drain({ adapter, runLane: async (packet) => laneReport(packet.itemId) });

  assert.equal(report.status, "not_dry");
  assert.deepEqual(report.dryProof, { dry: false, reason: "new work remains" });
});

test("one-wave successful non-dry drain with dry proof reports complete, not max_waves_exceeded", async () => {
  const { adapter, state } = fakeAdapter([{ id: "x", classification: "ready" }], {
    async proveDry() {
      return { dry: true };
    },
  });
  const report = await drain({
    adapter,
    maxWaves: 1,
    runLane: async (packet) => laneReport(packet.itemId),
  });

  assert.equal(report.status, "complete");
  assert.deepEqual(report.dryProof, { dry: true });
  assert.deepEqual(report.closed.map((entry) => entry.itemId), ["x"]);
});

test("max_waves_exceeded reserved for remaining work after the last allowed wave", async () => {
  const { adapter } = fakeAdapter(
    [
      { id: "item-1", classification: "ready" },
      { id: "item-2", classification: "ready" },
    ],
    {
      async discover() {
        return [{ id: "item-1", classification: "ready" }, { id: "item-2", classification: "ready" }];
      },
      async proveDry() {
        return { dry: false, reason: "item-2 still ready" };
      },
    },
  );
  let closedCount = 0;
  const report = await drain({
    adapter,
    maxWaves: 1,
    integrate: async () => ({ status: "integrated", laneReports: [] }),
    runLane: async (packet) => {
      closedCount += 1;
      return laneReport(packet.itemId);
    },
  });

  assert.equal(report.failed.length, 0);
  assert.equal(report.dryProof.dry, false);
  assert.equal(report.status, "max_waves_exceeded");
});

test("runtime returns a failed partial report for invalid lane and validation reports", async () => {
  const { adapter: laneAdapter, state: laneState } = fakeAdapter([{ id: "item-1", classification: "ready" }]);
  const laneReportResult = await drain({ adapter: laneAdapter, runLane: async () => ({ itemId: "item-1", outcome: "implemented", summary: "missing fields" }) });
  assert.equal(laneReportResult.status, "failed");
  assert.match(laneReportResult.error, /readyForIntegration/);
  assert.match(laneReportResult.failed[0].reason, /readyForIntegration/);
  assert.equal(laneState.calls.proveDry, 1);

  const { adapter: validationAdapter, state: validationState } = fakeAdapter([{ id: "item-1", classification: "ready" }], {
    async validate(item) {
      const report = validationReport(item.id);
      delete report.diffScopeOk;
      return report;
    },
  });
  const validationReportResult = await drain({ adapter: validationAdapter, runLane: async (packet) => laneReport(packet.itemId) });
  assert.equal(validationReportResult.status, "failed");
  assert.match(validationReportResult.error, /diffScopeOk/);
  assert.match(validationReportResult.failed[0].reason, /diffScopeOk/);
  assert.equal(validationState.calls.proveDry, 1);

  assert.throws(() => validateLaneReport({ itemId: "x", outcome: "unknown", summary: "x", readyForIntegration: true, filesChanged: [], commandsRun: [], acceptanceEvidence: [], residualRisks: [], followups: [] }), /Invalid lane outcome/);
  assert.throws(() => validateValidationReport({ itemId: "x", accepted: true, reason: "x", diffScopeOk: true, acceptanceChecklist: [], validationCommands: [] }), /followupsHandled/);
});

test("runtime returns a failed partial report for lane and validation reports for the wrong item", async () => {
  const { adapter: laneAdapter, state: laneState } = fakeAdapter([{ id: "item-1", classification: "ready" }]);
  const laneReportResult = await drain({ adapter: laneAdapter, runLane: async () => laneReport("other-item") });
  assert.equal(laneReportResult.status, "failed");
  assert.match(laneReportResult.error, /Lane report itemId mismatch: other-item !== item-1/);
  assert.equal(laneState.calls.proveDry, 1);

  const { adapter: validationAdapter, state: validationState } = fakeAdapter([{ id: "item-1", classification: "ready" }], {
    async validate() {
      return validationReport("other-item");
    },
  });
  const validationReportResult = await drain({ adapter: validationAdapter, runLane: async (packet) => laneReport(packet.itemId) });
  assert.equal(validationReportResult.status, "failed");
  assert.match(validationReportResult.error, /Validation report itemId mismatch: other-item !== item-1/);
  assert.equal(validationState.calls.proveDry, 1);
});

test("runtime releases the claim via adapter.releaseClaim when a lane fails", async () => {
  const released = [];
  const { adapter } = fakeAdapter([{ id: "item-1", classification: "ready" }], {
    async releaseClaim(item, context) {
      released.push({ id: item.id, reason: context.reason, outcome: context.outcome });
      return { id: item.id, status: "released" };
    },
  });

  const report = await drain({
    adapter,
    maxAttempts: 1,
    runLane: async (packet) => laneReport(packet.itemId, { readyForIntegration: false, outcome: "failed", summary: "lane blew up" }),
  });

  assert.equal(report.status, "failed");
  assert.deepEqual(report.failed.map((failure) => failure.itemId), ["item-1"]);
  assert.deepEqual(report.released, [{ itemId: "item-1", reason: "lane blew up", outcome: { id: "item-1", status: "released" } }]);
  assert.deepEqual(released, [{ id: "item-1", reason: "lane blew up", outcome: "failed" }]);
});

test("runtime records dirty lane salvage and passes it to releaseClaim", async () => {
  const salvage = {
    dirty: true,
    worktreePath: "/tmp/worktree",
    changedFiles: [{ path: "src/app.py", status: "M" }],
    changedFileCount: 1,
  };
  const released = [];
  const { adapter } = fakeAdapter([{ id: "item-1", classification: "ready" }], {
    async releaseClaim(item, context) {
      released.push({ id: item.id, reason: context.reason, salvage: context.salvage });
      return { id: item.id, status: "released" };
    },
  });

  const report = await drain({
    adapter,
    maxAttempts: 1,
    runLane: async (packet) => laneReport(packet.itemId, { readyForIntegration: false, outcome: "failed", summary: "timed out with dirty worktree", salvage }),
  });

  assert.equal(report.status, "failed");
  assert.deepEqual(report.salvaged, [{ itemId: "item-1", attempt: 1, salvage }]);
  assert.deepEqual(released, [{ id: "item-1", reason: "timed out with dirty worktree", salvage }]);
});

test("runtime skips releaseClaim cleanly when the adapter does not implement it", async () => {
  const { adapter } = fakeAdapter([{ id: "item-1", classification: "ready" }]);
  assert.equal(typeof adapter.releaseClaim, "undefined");

  const report = await drain({
    adapter,
    maxAttempts: 1,
    runLane: async (packet) => laneReport(packet.itemId, { readyForIntegration: false, outcome: "failed", summary: "no hook" }),
  });

  assert.equal(report.status, "failed");
  assert.deepEqual(report.released, []);
});

test("runtime releases claimed item and returns partial report when a lane throws mid-drain", async () => {
  const released = [];
  const { adapter, state } = fakeAdapter([{ id: "item-1", classification: "ready" }], {
    async releaseClaim(item, context) {
      released.push({ id: item.id, reason: context.reason, outcome: context.outcome });
      return { id: item.id, status: "released" };
    },
  });
  const error = new Error("child runner crashed");

  const report = await drain({
    adapter,
    runLane: async () => {
      throw error;
    },
  });

  assert.equal(report.status, "failed");
  assert.equal(report.error, "child runner crashed");
  assert.deepEqual(state.calls.claim, ["item-1"]);
  assert.equal(state.calls.proveDry, 1, "final proof still runs after a mid-drain infrastructure error");
  assert.equal(report.failed[0].itemId, "item-1");
  assert.match(report.failed[0].reason, /child runner crashed/);
  assert.deepEqual(released, [{ id: "item-1", reason: "drain exception: child runner crashed", outcome: "failed" }]);
  assert.deepEqual(report.released.map((entry) => entry.itemId), ["item-1"]);
  assert.ok(report.phases.includes("final_audit"));
  assert.equal(report.phases.at(-1), "complete");
});

test("runtime does not re-release when an internal releaseClaim throws mid-mutation", async () => {
  // Regression for opencode-workflows-5rzm: runLaneAttempt releases the claim on
  // final-attempt failure; if adapter.releaseClaim partially applies its real
  // mutation and then throws (e.g. a readback assertion), the exception unwinds
  // into processReadyItem's catch. The catch must NOT issue a second release with
  // a fresh "drain exception: ..." reason (a different mutationKey defeats the
  // adapter's release dedup and double-applies against the git-synced issue).
  const releaseCalls = [];
  const { adapter } = fakeAdapter([{ id: "item-1", classification: "ready" }], {
    async releaseClaim(item, context) {
      releaseCalls.push({ id: item.id, reason: context.reason });
      // Simulate: bd mutation succeeds, then the subsequent readback throws.
      throw new Error("readback assertion failed after bd update");
    },
  });

  const report = await drain({
    adapter,
    maxAttempts: 1,
    runLane: async (packet) => laneReport(packet.itemId, { readyForIntegration: false, outcome: "failed", summary: "lane failed on final attempt" }),
  });

  assert.equal(report.status, "failed");
  assert.match(report.error, /readback assertion failed after bd update/);
  assert.equal(releaseCalls.length, 1, "releaseClaim must be invoked exactly once, not re-issued by the catch");
  assert.equal(releaseCalls[0].reason, "lane failed on final attempt");
  assert.ok(!releaseCalls.some((call) => call.reason.startsWith("drain exception")), "catch must not re-release with a fresh reason");
});

test("runtime still releases via the catch when the failure precedes any internal release", async () => {
  // Complement to the regression above: when the lane throws BEFORE any internal
  // release site is reached (releaseState.attempted stays false), the catch is
  // the sole releaser and must still run exactly once with the drain-exception reason.
  const releaseCalls = [];
  const { adapter } = fakeAdapter([{ id: "item-1", classification: "ready" }], {
    async releaseClaim(item, context) {
      releaseCalls.push({ id: item.id, reason: context.reason });
      return { id: item.id, status: "released" };
    },
  });

  const report = await drain({
    adapter,
    runLane: async () => {
      throw new Error("lane crashed before release");
    },
  });

  assert.equal(report.status, "failed");
  assert.equal(releaseCalls.length, 1);
  assert.equal(releaseCalls[0].reason, "drain exception: lane crashed before release");
});

test("runtime stops before claim when lane launch budget is exhausted", async () => {
  const { adapter, state } = fakeAdapter([{ id: "item-1", classification: "ready" }]);

  const report = await drain({
    adapter,
    canLaunchLane: async (context) => context.phase === "preclaim" ? false : assert.fail(`unexpected budget check phase ${context.phase}`),
    runLane: async () => assert.fail("budget-exhausted drain must not launch a lane"),
  });

  assert.equal(report.status, "budget_exhausted");
  assert.equal(report.budgetExhausted, true);
  assert.deepEqual(state.calls.claim, []);
  assert.deepEqual(state.calls.buildLanePacket, []);
  assert.deepEqual(report.failed, []);
  assert.equal(report.waves[0].budgetExhausted.phase, "preclaim");
});

test("runtime treats thrown budget-stop errors as exhausted launch budget", async () => {
  const { adapter, state } = fakeAdapter([{ id: "item-1", classification: "ready" }]);
  const budgetError = new Error("token ceiling reached");
  budgetError.code = "WORKFLOW_BUDGET_STOPPED";

  const report = await drain({
    adapter,
    canLaunchLane: async (context) => {
      assert.equal(context.phase, "preclaim");
      throw budgetError;
    },
    runLane: async () => assert.fail("budget-stopped drain must not launch a lane"),
  });

  assert.equal(report.status, "budget_exhausted");
  assert.equal(report.budgetExhausted, true);
  assert.deepEqual(state.calls.claim, []);
  assert.equal(report.waves[0].budgetExhausted.phase, "preclaim");
});

test("runtime releases an already-claimed item when retry budget is exhausted", async () => {
  const released = [];
  const { adapter, state } = fakeAdapter([{ id: "item-1", classification: "ready" }], {
    async releaseClaim(item, context) {
      released.push({ id: item.id, reason: context.reason, outcome: context.outcome });
      return { id: item.id, status: "released" };
    },
  });
  let preattempts = 0;

  const report = await drain({
    adapter,
    maxAttempts: 2,
    canLaunchLane: async (context) => {
      if (context.phase === "preclaim") return true;
      if (context.phase === "preattempt") {
        preattempts += 1;
        return preattempts === 1;
      }
      return true;
    },
    runLane: async (packet) => laneReport(packet.itemId, { readyForIntegration: false, outcome: "failed", summary: "needs retry" }),
  });

  assert.equal(report.status, "budget_exhausted");
  assert.deepEqual(state.calls.claim, ["item-1"]);
  assert.equal(state.calls.buildLanePacket.length, 1);
  assert.deepEqual(report.failed, [{ itemId: "item-1", reason: "lane launch budget exhausted" }]);
  assert.deepEqual(report.released, [{ itemId: "item-1", reason: "lane launch budget exhausted", outcome: { id: "item-1", status: "released" } }]);
  assert.deepEqual(released, [{ id: "item-1", reason: "lane launch budget exhausted", outcome: "failed" }]);
  assert.equal(report.waves[0].attempts[1].stopped, "budget_exhausted");
});

test("runtime enters a second wave and records the resnapshot phase", async () => {
  let state;
  const result = fakeAdapter([
    { id: "item-1", classification: "ready" },
    { id: "item-2", classification: "ready" },
  ], {
    async discover(scope, context) {
      state.calls.discover += 1;
      return context.waveNumber === 1 ? [state.items[0]] : [state.items[1]];
    },
    async proveDry(scope, context) {
      return { dry: context.report.closed.length === 2 };
    },
  });
  state = result.state;

  const report = await drain({
    adapter: result.adapter,
    maxWaves: 2,
    runLane: async (packet) => laneReport(packet.itemId),
  });

  assert.equal(report.status, "complete");
  assert.deepEqual(report.closed.map((entry) => entry.itemId), ["item-1", "item-2"]);
  assert.deepEqual(report.waves.map((wave) => wave.waveNumber), [1, 2]);
  assert.ok(report.phases.includes("snapshot"));
  assert.ok(report.phases.includes("resnapshot"));
});

test("runtime fails final rejected validation and releases with validation context", async () => {
  const released = [];
  const rejected = validationReport("item-1", {
    accepted: false,
    diffScopeOk: false,
    reason: "central validation still rejected the change",
  });
  const { adapter } = fakeAdapter([{ id: "item-1", classification: "ready" }], {
    async validate() {
      return rejected;
    },
    async releaseClaim(item, context) {
      released.push({ id: item.id, reason: context.reason, laneReport: context.laneReport, validationReport: context.validationReport });
      return { id: item.id, status: "released" };
    },
  });

  const report = await drain({
    adapter,
    maxAttempts: 1,
    runLane: async (packet) => laneReport(packet.itemId),
  });

  assert.equal(report.status, "failed");
  assert.equal(report.failed[0].itemId, "item-1");
  assert.equal(report.failed[0].reason, rejected.reason);
  assert.deepEqual(report.failed[0].validationReport, rejected);
  assert.equal(report.released[0].reason, rejected.reason);
  assert.equal(released[0].reason, rejected.reason);
  assert.equal(released[0].laneReport.itemId, "item-1");
  assert.deepEqual(released[0].validationReport, rejected);
});

// Regression for finding R15: when the worktree root sits behind a symlinked
// ancestor, git reports realpath-canonical worktree paths while the adapter
// previously kept the un-realpathed (symlinked) path. The mismatch made
// remove() return "not-linked-worktree" and recover() classify a managed
// worktree as "outside-worktree-root" / "missing", leaking it. The adapter now
// realpaths its containment/match basis so cleanup succeeds.
test("worktree remove/recover succeed when an ancestor of the worktree root is a symlink (R15)", async () => {
  const realBase = await fs.mkdtemp(path.join(os.tmpdir(), "wt-symlink-ancestor-"));
  try {
    const repoDir = path.join(realBase, "repo");
    await fs.mkdir(repoDir);
    await execFileAsync("git", ["init"], { cwd: repoDir });
    await execFileAsync("git", ["config", "user.email", "workflow-test@example.com"], { cwd: repoDir });
    await execFileAsync("git", ["config", "user.name", "Workflow Test"], { cwd: repoDir });
    await fs.writeFile(path.join(repoDir, "README.md"), "initial\n", "utf8");
    await execFileAsync("git", ["add", "-A"], { cwd: repoDir });
    await execFileAsync("git", ["commit", "-m", "initial"], { cwd: repoDir });

    // Real worktree storage plus a symlink that points at it. Hand the adapter the
    // SYMLINKED worktree root, mimicking a symlinked ancestor (macOS /home -> /Users,
    // bind mounts). git will still record the realpath of any worktree under it.
    const realWorktrees = path.join(realBase, "real-worktrees");
    await fs.mkdir(realWorktrees);
    const linkedWorktrees = path.join(realBase, "linked-worktrees");
    await fs.symlink(realWorktrees, linkedWorktrees);

    const adapter = await createWorktreeAdapter({ directory: repoDir, worktreeRoot: linkedWorktrees });
    const lane = await adapter.createLaneWorktree({ runId: "run1", laneId: "lane1" });

    // Caller still holds the symlinked path it asked for.
    const symlinkedLanePath = path.join(linkedWorktrees, "run1", "lanes", "lane1");

    // recover() must see exactly one managed worktree as removable ("clean"),
    // not a duplicated "missing" + "outside-worktree-root" pair.
    const recovered = await adapter.recover({ records: [{ path: symlinkedLanePath }] });
    const lanes = recovered.worktrees.filter((entry) => entry.state !== "main-worktree");
    assert.equal(lanes.length, 1, "managed worktree must not be split/duplicated by symlink");
    assert.equal(lanes[0].state, "clean");
    assert.equal(lanes[0].preserved, false);

    // remove() via the symlinked path must actually remove the worktree.
    const removed = await adapter.remove({ path: symlinkedLanePath });
    assert.equal(removed.removed, true, "symlinked-ancestor worktree must be removable, not leaked");
    assert.equal(await pathExistsForTest(lane.path), false, "worktree directory must be gone");

    // After removal recover() degrades gracefully to "missing" without throwing.
    const afterRemoval = await adapter.recover({ records: [{ path: symlinkedLanePath }] });
    const stillManaged = afterRemoval.worktrees.filter((entry) => entry.state !== "main-worktree");
    assert.deepEqual(stillManaged.map((entry) => entry.state), ["missing"]);
  } finally {
    await fs.rm(realBase, { recursive: true, force: true });
  }
});

// Regression for finding R33: the non-native remove path ran `git worktree
// remove`, which deletes the worktree directory + admin record but leaves the
// lane branch behind. Across many autonomous-drain runs those orphaned branches
// accumulated unbounded. remove() now deletes the lane branch after a successful
// non-native worktree removal.
test("non-native worktree remove also deletes the lane branch (R33)", async () => {
  const realBase = await fs.mkdtemp(path.join(os.tmpdir(), "wt-branch-cleanup-"));
  try {
    const repoDir = path.join(realBase, "repo");
    await fs.mkdir(repoDir);
    await execFileAsync("git", ["init"], { cwd: repoDir });
    await execFileAsync("git", ["config", "user.email", "workflow-test@example.com"], { cwd: repoDir });
    await execFileAsync("git", ["config", "user.name", "Workflow Test"], { cwd: repoDir });
    await fs.writeFile(path.join(repoDir, "README.md"), "initial\n", "utf8");
    await execFileAsync("git", ["add", "-A"], { cwd: repoDir });
    await execFileAsync("git", ["commit", "-m", "initial"], { cwd: repoDir });

    const worktreeRoot = path.join(realBase, "worktrees");
    const adapter = await createWorktreeAdapter({ directory: repoDir, worktreeRoot });
    const lane = await adapter.createLaneWorktree({ runId: "run1", laneId: "lane1" });

    // The lane branch exists before removal.
    const branchesBefore = await execFileAsync("git", ["branch", "--list", lane.branch], { cwd: repoDir });
    assert.ok(branchesBefore.stdout.includes(lane.branch), "lane branch must exist before removal");

    const removed = await adapter.remove({ path: lane.path });
    assert.equal(removed.removed, true);
    assert.equal(removed.branch, lane.branch, "remove() reports the deleted lane branch");
    assert.equal(removed.branchDeleted, true, "lane branch must be deleted, not orphaned");
    assert.equal(await pathExistsForTest(lane.path), false, "worktree directory must be gone");

    // The lane branch must no longer exist — no orphan accumulation.
    const branchesAfter = await execFileAsync("git", ["branch", "--list"], { cwd: repoDir });
    assert.ok(!branchesAfter.stdout.includes(lane.branch), "lane branch must be gone after removal");
  } finally {
    await fs.rm(realBase, { recursive: true, force: true });
  }
});

async function pathExistsForTest(target) {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}
