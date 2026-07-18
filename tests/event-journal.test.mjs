import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { MAX_EVENTS, MAX_JOURNAL_RECORDS } from "../workflow-kernel/constants.js";
import {
  appendApplyLedger,
  appendDomainLedger,
  appendEvent,
  appendJournal,
  appendLedger,
  applyLedgerHasCompleted,
  compactJournal,
  domainMutationIdempotencyKey,
  finalizeStagedDomainMutations,
  laneSignature,
  loadJournal,
  readJsonlLedger,
  runDomainMutation,
  stageDomainMutation,
} from "../workflow-kernel/event-journal.js";

// Event-journal durability regressions split out of durable-state.test.mjs
// (opencode-workflows-fnop.9): ledger naming/validation, journal and event caps with
// truncated-line skipping, compaction of corrupt trailing data, domain-mutation idempotency
// and the R16 crash-window replay contract, and lane-signature content addressing.

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

test("appendLedger accepts canonical lowercase ledgers and rejects unsafe names", async () => {
  const dir = await tempDir("workflow-ledger-file-name");
  try {
    await appendLedger(dir, "domain-ledger.jsonl", { phase: "started", mutationKey: "domain:1" });
    await appendLedger(dir, "custom-ledger.jsonl", { phase: "started", key: "custom:1" });

    assert.match(await fs.readFile(path.join(dir, "domain-ledger.jsonl"), "utf8"), /"mutationKey":"domain:1"/);
    assert.match(await fs.readFile(path.join(dir, "custom-ledger.jsonl"), "utf8"), /"key":"custom:1"/);

    for (const fileName of ["../../etc/passwd.jsonl", "nested/domain-ledger.jsonl", "", "custom-ledger.JSONL"]) {
      await assert.rejects(
        () => appendLedger(dir, fileName, { phase: "started" }),
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
    () => appendLedger(undefined, "domain-ledger.jsonl", { phase: "started" }),
    /appendLedger requires a run directory/,
  );
  await assert.rejects(
    () => appendLedger({}, "domain-ledger.jsonl", { phase: "started" }),
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

  assert.equal(await applyLedgerHasCompleted(dir, "plan-a"), true);
  assert.equal(await applyLedgerHasCompleted(dir, "missing-plan"), false);
  assert.equal(await applyLedgerHasCompleted(path.join(dir, "missing"), "plan-a"), false);

  await appendApplyLedger(dir, { phase: "completed", diffPlanHash: "plan-c" });
  assert.equal(await applyLedgerHasCompleted(dir, "plan-c"), true);
});

test("domain mutation ledger is idempotent by mutation key", async () => {
  const dir = await tempDir("workflow-domain-ledger");
  const run = makeRun(dir);
  let calls = 0;
  const execute = async () => ({ call: ++calls });
  const readback = async (result) => ({ observed: result.call });

  const first = await runDomainMutation(run, { mutationKey: "bd-close:1", operation: "close", execute, readback });
  const second = await runDomainMutation(run, { mutationKey: "bd-close:1", operation: "close", execute, readback });

  assert.equal(first.replayed, false);
  assert.equal(second.replayed, true);
  assert.equal(calls, 1);
  assert.deepEqual(second.readback, { observed: 1 });
  const records = await readJsonlLedger(path.join(dir, "domain-ledger.jsonl"));
  assert.equal(records.filter((record) => record.phase === "completed").length, 1);
});

test("domain mutation readback failure does not fail or rethrow a successful mutation", async () => {
  const dir = await tempDir("workflow-domain-readback-failure");
  const run = makeRun(dir);
  const error = Object.assign(new Error("observation unavailable"), { code: "READBACK_DOWN" });

  const result = await runDomainMutation(run, {
    mutationKey: "domain:fresh-readback-failure",
    operation: "update",
    execute: async () => ({ updated: true }),
    readback: async () => { throw error; },
  });

  assert.equal(result.replayed, false);
  assert.deepEqual(result.result, { updated: true });
  assert.equal(result.readback, undefined);
  assert.deepEqual(result.readbackError, { name: "Error", message: "observation unavailable", code: "READBACK_DOWN" });
  const records = await readJsonlLedger(path.join(dir, "domain-ledger.jsonl"));
  assert.deepEqual(records.map((record) => record.phase), ["started", "executed", "completed"]);
  assert.deepEqual(records.at(-1).readbackError, result.readbackError);
});

test("executed domain mutation replay handles readback failure without re-executing or recording failure", async () => {
  const dir = await tempDir("workflow-domain-replay-readback-failure");
  const run = makeRun(dir);
  await appendDomainLedger(run, {
    phase: "executed",
    mutationKey: "domain:replay-readback-failure",
    operation: "update",
    result: { updated: true },
  });
  let executeCalls = 0;

  const result = await runDomainMutation(run, {
    mutationKey: "domain:replay-readback-failure",
    operation: "update",
    execute: async () => { executeCalls += 1; },
    readback: async () => { throw new TypeError("readback parse failed"); },
  });

  assert.equal(result.replayed, true);
  assert.equal(executeCalls, 0);
  assert.equal(result.readback, undefined);
  assert.deepEqual(result.readbackError, { name: "TypeError", message: "readback parse failed" });
  const records = await readJsonlLedger(path.join(dir, "domain-ledger.jsonl"));
  assert.deepEqual(records.map((record) => record.phase), ["executed", "completed"]);
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

  const expectedKey = domainMutationIdempotencyKey("bd-create:abc");
  assert.match(expectedKey, /^ocw-idem-[0-9a-f]+$/);
  assert.equal(domainMutationIdempotencyKey("bd-create:abc"), expectedKey, "key derivation must be deterministic");

  const result = await runDomainMutation(run, { mutationKey: "bd-create:abc", operation: "create", execute });
  assert.equal(result.replayed, false);
  assert.deepEqual(seenKeys, [expectedKey], "execute must receive the deterministic idempotency key");

  const records = await readJsonlLedger(path.join(dir, "domain-ledger.jsonl"));
  const started = records.find((record) => record.phase === "started");
  assert.equal(started.idempotencyKey, expectedKey, "started record must persist the idempotency key before execute runs");
});

test("journal cap throws, event cap drops, and truncated journal lines are skipped", async () => {
  const dir = await tempDir("workflow-journal-cap");
  const run = makeRun(dir, {
    journalRecords: MAX_JOURNAL_RECORDS,
    eventCount: MAX_EVENTS,
  });

  await assert.rejects(
    () => appendJournal(run, { callId: "too-many", outcome: "success" }),
    new RegExp(`Workflow journal exceeded ${MAX_JOURNAL_RECORDS} records`),
  );
  assert.equal(run.journalRecords, MAX_JOURNAL_RECORDS);

  await appendEvent(run, { type: "dropped-at-cap" });
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
  const loaded = await loadJournal(dir);
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

  const loaded = await loadJournal(dir);
  assert.equal(loaded.size, 2);
  assert.equal(loaded.get("lane:1").attempt, 2);

  const compacted = await compactJournal(dir, loaded);
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
  const crashKey = domainMutationIdempotencyKey("bd-create:crash");
  await appendDomainLedger(run, { phase: "started", mutationKey: "bd-create:crash", operation: "create", idempotencyKey: crashKey });

  let executeCalls = 0;
  let observedKey;
  const execute = async (idempotencyKey) => {
    executeCalls += 1;
    observedKey = idempotencyKey;
    return { ok: true };
  };

  const result = await runDomainMutation(run, { mutationKey: "bd-create:crash", operation: "create", execute });
  assert.equal(executeCalls, 1, "resume after a started-only crash must run execute exactly once");
  assert.equal(observedKey, crashKey, "the resumed execute must reuse the key from the started record's mutationKey");
  assert.equal(result.replayed, false);

  const records = await readJsonlLedger(path.join(dir, "domain-ledger.jsonl"));
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
  const signature = (runOverrides = {}, resolvedOverrides = {}, prompt = "Implement the lane") => laneSignature(
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
  await stageDomainMutation(run, {
    mutationKey: "custom:1",
    operation: "custom.operation",
    payload: { id: "custom-1" },
  });

  await assert.rejects(
    () => finalizeStagedDomainMutations(dir, { id: run.id }),
    /Unsupported staged domain mutation operation: custom\.operation/,
  );

  const records = await readJsonlLedger(path.join(dir, "domain-ledger.jsonl"));
  assert.equal(records.some((record) => record.phase === "failed" && record.operation === "custom.operation"), true);
});
