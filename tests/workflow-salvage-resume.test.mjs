import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import WorkflowPlugin from "../workflow-kernel/index.js";
import { makeHarness } from "./helpers/harness.mjs";

// __test aggregates the kernel barrel (loadJournal, writeSalvagedLaneOutcome,
// runDirForRoot, writeLaneProjection, ...) plus the orchestrator symbols added in
// workflow-plugin.js (classifyResumeCacheHit, isLaneIntegrable).
const { __test } = WorkflowPlugin;
const classifyResumeCacheHit = __test.classifyResumeCacheHit;
const isLaneIntegrable = __test.isLaneIntegrable;

async function tempDir(name) {
  return await fs.mkdtemp(path.join(os.tmpdir(), `${name}-`));
}

const SALVAGED_RESULT = { findings: ["alpha", "beta"] };

// --- classifyResumeCacheHit: the resume cache-hit discriminator ---------------------------

test("classifyResumeCacheHit routes a matching salvaged success entry to cache.salvaged_hit", () => {
  const cached = {
    signatureHash: "sig-A",
    outcome: "success",
    salvagedFromTranscript: true,
    result: SALVAGED_RESULT,
  };
  const hit = classifyResumeCacheHit(cached, "sig-A");
  assert.deepEqual(hit, { kind: "salvaged-hit", eventType: "cache.salvaged_hit" });
  assert.notEqual(hit.eventType, "cache.hit", "salvaged hits must emit a DISTINCT event");
});

test("classifyResumeCacheHit routes a matching normal success entry to cache.hit (regression guard)", () => {
  const cached = {
    signatureHash: "sig-B",
    outcome: "success",
    salvagedFromTranscript: false,
    result: { ok: true },
  };
  const hit = classifyResumeCacheHit(cached, "sig-B");
  assert.deepEqual(hit, { kind: "hit", eventType: "cache.hit" });
  // An entry that omits salvagedFromTranscript entirely is a normal capture too.
  const legacy = { signatureHash: "sig-B", outcome: "success", result: { ok: true } };
  assert.deepEqual(classifyResumeCacheHit(legacy, "sig-B"), { kind: "hit", eventType: "cache.hit" });
});

test("classifyResumeCacheHit returns null for signature mismatch, non-success outcome, or no entry", () => {
  const ok = { signatureHash: "sig-C", outcome: "success", result: {} };
  assert.equal(classifyResumeCacheHit(ok, "wrong-signature"), null, "signature mismatch must not cache-hit");
  assert.equal(classifyResumeCacheHit(ok, undefined), null, "undefined signature must not cache-hit");
  const failed = { signatureHash: "sig-C", outcome: "failure", result: undefined };
  assert.equal(classifyResumeCacheHit(failed, "sig-C"), null, "non-success outcome must not cache-hit");
  // A salvaged entry whose outcome is failure (schema-mismatch salvage) must not be reused.
  const salvagedFailed = { signatureHash: "sig-C", outcome: "failure", salvagedFromTranscript: true };
  assert.equal(classifyResumeCacheHit(salvagedFailed, "sig-C"), null);
  assert.equal(classifyResumeCacheHit(undefined, "sig-C"), null, "missing cached entry must not cache-hit");
  assert.equal(classifyResumeCacheHit(null, "sig-C"), null);
});

test("signature fallback index is scope-bound and claim-once", () => {
  const topA = { callId: "root/agent:0", signatureHash: "sig-top", outcome: "success", result: "A" };
  const topB = { callId: "root/agent:1", signatureHash: "sig-top", outcome: "success", result: "B" };
  const fanout = { callId: "root/parallel:0/item:0/agent:0", signatureHash: "sig-fanout", outcome: "success", result: "F" };
  const failed = { callId: "root/agent:2", signatureHash: "sig-top", outcome: "failure", result: "bad" };
  const resumeJournal = new Map([
    [topA.callId, topA],
    [topB.callId, topB],
    [fanout.callId, fanout],
    [failed.callId, failed],
  ]);
  const run = {
    resumeSignatureIndex: __test.buildResumeSignatureIndex(resumeJournal),
    resumeSignatureClaims: new Set(),
  };

  __test.markResumeSignatureClaimed(run, topA.callId);
  assert.equal(__test.claimResumeSignatureFallback(run, "root/agent:3", "sig-top"), topB);
  assert.equal(__test.claimResumeSignatureFallback(run, "root/agent:4", "sig-top"), null, "claimed and failed entries must not be reused");
  assert.equal(__test.claimResumeSignatureFallback(run, "root/parallel:0/item:1/agent:0", "sig-fanout"), fanout, "fanout items in the same group can recover by signature");
  assert.equal(__test.claimResumeSignatureFallback(run, "root/parallel:1/item:0/agent:0", "sig-fanout"), null, "different fanout groups must not cross-claim");
});

// --- isLaneIntegrable: the hard-enforced read-only-vs-edit asymmetry ---------------------

test("isLaneIntegrable accepts only committed, non-salvaged, non-rejected lanes", () => {
  assert.equal(isLaneIntegrable({ committed: true }), true);
  assert.equal(isLaneIntegrable({ committed: true, acceptedForIntegration: true }), true);
  assert.equal(isLaneIntegrable({ committed: true, acceptedForIntegration: undefined }), true);
  assert.equal(isLaneIntegrable({ committed: false }), false, "uncommitted lane must not integrate");
  assert.equal(isLaneIntegrable({ committed: true, acceptedForIntegration: false }), false, "rejected lane must not integrate");
  assert.equal(isLaneIntegrable({}), false);
  assert.equal(isLaneIntegrable(undefined), false);
  assert.equal(isLaneIntegrable(null), false);
});

test("isLaneIntegrable rejects a salvaged edit claim even when committed is true (asymmetry is code-enforced)", () => {
  // The worst-case malformed/synthetic state: a salvaged lane that somehow carries committed.
  // The read-only-vs-edit asymmetry must hold in code, not just docs, so it is rejected here
  // and therefore can never reach integrateLaneCommits() or runAutoApply().
  const salvagedCommittedClaim = { committed: true, salvagedFromTranscript: true };
  assert.equal(isLaneIntegrable(salvagedCommittedClaim), false, "salvaged lane must never integrate even if committed");
  // A lane whose provenance is explicitly NOT salvaged still integrates normally.
  assert.equal(isLaneIntegrable({ committed: true, salvagedFromTranscript: false }), true);
});

test("the integration lane filter excludes a salvaged edit claim from the runAutoApply gateway", () => {
  // Mirrors runWorkflowExecution: run.integrationPlan.lanes.filter(isLaneIntegrable). Only the
  // real committed lane survives; the salvaged-committed claim (which would otherwise reach
  // integrateLaneCommits and downstream runAutoApply) is filtered out.
  const lanes = [
    { callId: "lane:normal", committed: true },
    { callId: "lane:salvaged-claim", committed: true, salvagedFromTranscript: true },
    { callId: "lane:uncommitted", committed: false },
    { callId: "lane:rejected", committed: true, acceptedForIntegration: false },
  ];
  const integrable = lanes.filter(isLaneIntegrable);
  assert.deepEqual(integrable.map((lane) => lane.callId), ["lane:normal"]);
});

// --- Durable wiring: salvage write -> journal -> resume map -> discriminator -------------

test("a salvaged journal entry survives loadJournal and classifies as a salvaged cache hit on resume", async () => {
  const root = await tempDir("salvage-resume-wiring");
  const runId = "salvage-resume-wiring-run";
  const dir = __test.runDirForRoot(root, runId);
  await fs.mkdir(dir, { recursive: true });
  const callId = "lane:salvaged-ro";
  const signatureHash = "sig-salvaged-ro";

  // Write a synthetic salvaged entry exactly as workflow_salvage's approve path does.
  await __test.writeSalvagedLaneOutcome(dir, callId, {
    runId,
    signatureHash,
    outcome: "success",
    childID: "child-salvaged-ro",
    title: "read-only orphan",
    taskSummary: "research",
    model: "p/m",
    result: SALVAGED_RESULT,
    salvageValidation: { kind: "json-parse", originalSchemaAvailable: false },
  });

  // The resume path builds its cache map via loadJournal(dir); a salvaged entry must round-trip
  // with its salvagedFromTranscript tag and signatureHash intact so the discriminator can route it.
  const journal = await __test.loadJournal(dir);
  const cached = journal.get(callId);
  assert.equal(cached.salvagedFromTranscript, true);
  assert.equal(cached.signatureHash, signatureHash);
  assert.equal(cached.outcome, "success");
  assert.deepEqual(cached.result, SALVAGED_RESULT);

  // The resume cache-hit branch keys on exactly this: classifyResumeCacheHit(cached, sig). A
  // salvaged success entry with a matching signature routes to cache.salvaged_hit (not cache.hit)
  // and is reused without re-running the lane.
  const hit = classifyResumeCacheHit(cached, signatureHash);
  assert.deepEqual(hit, { kind: "salvaged-hit", eventType: "cache.salvaged_hit" });
});

test("a normally-captured journal entry still classifies as a plain cache hit (no salvage regression)", async () => {
  const root = await tempDir("salvage-resume-normal");
  const runId = "salvage-resume-normal-run";
  const dir = __test.runDirForRoot(root, runId);
  await fs.mkdir(dir, { recursive: true });
  const callId = "lane:normal-capture";
  const signatureHash = "sig-normal";
  // A normal controller-captured journal entry has no salvagedFromTranscript tag.
  await fs.appendFile(
    path.join(dir, "journal.jsonl"),
    `${JSON.stringify({ type: "agent", callId, signatureHash, outcome: "success", result: { ok: 1 } })}\n`,
    "utf8",
  );

  const journal = await __test.loadJournal(dir);
  const cached = journal.get(callId);
  assert.equal(cached.salvagedFromTranscript, undefined);
  assert.deepEqual(classifyResumeCacheHit(cached, signatureHash), { kind: "hit", eventType: "cache.hit" });
});

// --- jbs3.1: terminal-failure resumability over the REAL runChildAgent path ----------------
//
// These drive the live workflow_run -> executeSandbox -> runChildAgent path (no injected fakes
// for the orchestrator) to prove the acceptance contract: a run that fails on a later lane with
// earlier lanes complete can be resumed; the completed lanes replay from cache at zero re-spend
// (replayedCost > 0, liveCost only for the re-run lane), and a budget-stopped run resumes after
// RAISING maxCost.

function approvalHashFrom(preview) {
  const match = preview.match(/approvalHash: ([a-f0-9]{64})/);
  assert.ok(match, `missing approvalHash in preview: ${preview}`);
  return match[1];
}

async function runApproved(tools, context, runArgs) {
  const preview = await tools.workflow_run.execute({ ...runArgs }, context);
  return await tools.workflow_run.execute({ ...runArgs, approve: true, approvalHash: approvalHashFrom(preview) }, context);
}

function laneCostPrompt(state) {
  // A lane succeeds with a fixed live cost so completed-lane spend is observable; lane-C throws a
  // generic (terminal-classed) error while state.failC is set so it can be cleared before resume.
  return async (input) => {
    const text = input.body.parts.map((part) => part.text).join("\n");
    if (state.failC && text.includes("lane-C")) {
      throw new Error("lane-C boom (deliberate terminal lane failure)");
    }
    return { data: { parts: [{ type: "text", text: "ok" }], info: { tokens: { input: 1, output: 1, reasoning: 0 }, cost: 0.01 } } };
  };
}

const THREE_LANE_SOURCE = (name) => `export const meta = { name: ${JSON.stringify(name)}, profile: "read-only-review", maxAgents: 5 };
const a = await agent("compute lane-A");
const b = await agent("compute lane-B");
const c = await agent("compute lane-C");
return { a, b, c };`;

async function statusByName(tools, context, name) {
  const list = JSON.parse(await tools.workflow_status.execute({ format: "json", detail: "compact", limit: 50 }, context));
  const entry = list.find((item) => item.meta?.name === name);
  assert.ok(entry, `run ${name} should be listed`);
  return entry.id;
}

async function fullStatus(tools, context, runId) {
  return JSON.parse(await tools.workflow_status.execute({ runId, format: "json", detail: "full" }, context));
}

test("a workflow that fails on a later lane resumes, replaying completed lanes from cache with zero re-spend", async () => {
  const state = { failC: true };
  const { tools, context, directory, calls } = await makeHarness(laneCostPrompt(state));
  try {
    const name = "resume-failed-lane";
    const source = THREE_LANE_SOURCE(name);

    // First run: lanes A and B complete; lane C throws -> run lands in the (now resumable) "failed"
    // status with A/B journaled and a partial result.json on disk.
    await assert.rejects(runApproved(tools, context, { source }), /lane-C boom/);
    const runId = await statusByName(tools, context, name);
    const failedStatus = await fullStatus(tools, context, runId);
    assert.equal(failedStatus.status, "failed");
    assert.equal(failedStatus.laneOutcomes.success, 2, "A and B should have completed before C failed");
    assert.equal(failedStatus.laneOutcomes.failure, 1);
    // Partial result.json written on the failed path so completed-lane work is observable.
    const partial = JSON.parse(await fs.readFile(path.join(failedStatus.dir, "result.json"), "utf8"));
    assert.equal(partial.status, "failed");
    assert.equal(partial.partial, true);
    assert.equal(partial.resumable, true);

    const promptsBeforeResume = calls.prompt.length; // A, B, and the failed C attempt = 3

    // Resume: clear the failure so C succeeds. A and B must replay from cache (no new prompt, no
    // new live spend); only C re-runs.
    state.failC = false;
    const resumeOutput = await runApproved(tools, context, { resumeRunId: runId });
    assert.match(resumeOutput, /completed/, "the resumed run must complete");

    const resumed = await fullStatus(tools, context, runId);
    assert.equal(resumed.status, "completed");
    // Completed lanes replayed at zero re-spend: 2 cache hits, exactly one new prompt (lane C).
    assert.equal(resumed.cacheStats.hits, 2, "A and B should both be served from cache on resume");
    assert.equal(calls.prompt.length - promptsBeforeResume, 1, "only the failed lane C re-runs");
    // replayedCost > 0 (prior A+B spend folded forward) and the live cost is only lane C's spend.
    assert.ok(resumed.usage.replayedCost > 0, `replayedCost should be > 0, got ${resumed.usage.replayedCost}`);
    assert.equal(resumed.usage.liveCost, 0.01, "live cost is only the single re-run lane (A and B re-spend 0)");
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("a budget-stopped run resumes after raising maxCost, replaying completed lanes at zero re-spend", async () => {
  const state = { failC: false }; // no lane failure; the stop is purely the cost ceiling
  const { tools, context, directory, calls } = await makeHarness(laneCostPrompt(state));
  try {
    const name = "resume-budget-stop";
    const source = THREE_LANE_SOURCE(name);

    // First run: maxCost=0.015. A (->0.01) and B (->0.02) launch; before C the total (0.02) has
    // reached the ceiling, so the run lands in the (now resumable) "budget_stopped" status.
    await assert.rejects(runApproved(tools, context, { source, maxCost: 0.015 }), /ceiling reached/);
    const runId = await statusByName(tools, context, name);
    const stopped = await fullStatus(tools, context, runId);
    assert.equal(stopped.status, "budget_stopped");
    assert.equal(stopped.laneOutcomes.success, 2, "A and B complete before the ceiling stops C");
    const partial = JSON.parse(await fs.readFile(path.join(stopped.dir, "result.json"), "utf8"));
    assert.equal(partial.status, "budget_stopped");
    assert.equal(partial.resumable, true);

    // Lowering the ceiling on a budget-stopped resume is rejected; only a raise is allowed.
    await assert.rejects(
      tools.workflow_run.execute({ resumeRunId: runId, maxCost: 0.005 }, context),
      /cannot lower maxCost/,
    );

    const promptsBeforeResume = calls.prompt.length; // A, B (C never prompted) = 2

    // Resume with a RAISED ceiling: A and B replay from cache; C now has headroom and completes.
    const resumeOutput = await runApproved(tools, context, { resumeRunId: runId, maxCost: 0.05 });
    assert.match(resumeOutput, /completed/, "the resumed run must complete after raising maxCost");

    const resumed = await fullStatus(tools, context, runId);
    assert.equal(resumed.status, "completed");
    assert.equal(resumed.budgetCeilings.maxCost, 0.05, "the raised ceiling must take effect on resume");
    assert.equal(resumed.cacheStats.hits, 2, "A and B should both be served from cache on resume");
    assert.equal(calls.prompt.length - promptsBeforeResume, 1, "only the budget-stopped lane C re-runs");
    assert.ok(resumed.usage.replayedCost > 0, `replayedCost should be > 0, got ${resumed.usage.replayedCost}`);
    assert.equal(resumed.usage.liveCost, 0.01, "live cost is only the single re-run lane (A and B re-spend 0)");
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
