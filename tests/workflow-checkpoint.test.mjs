import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import WorkflowPlugin from "../workflow-kernel/index.js";

// __test aggregates the kernel barrel (writeLaneCheckpoint, readLaneResultCheckpoint,
// removeLaneCheckpoint, readLaneProjections, computeSalvageCandidates, loadJournal,
// runDirForRoot, ...) plus the orchestrator symbols added in workflow-plugin.js
// (classifyResumeCacheHit, checkpointHitForSignature).
const { __test } = WorkflowPlugin;
const checkpointHitForSignature = __test.checkpointHitForSignature;
const classifyResumeCacheHit = __test.classifyResumeCacheHit;

async function tempDir(name) {
  return await fs.mkdtemp(path.join(os.tmpdir(), `${name}-`));
}

async function makeRunDir(name) {
  const root = await tempDir(name);
  const runId = `${name}-run`;
  const dir = __test.runDirForRoot(root, runId);
  await fs.mkdir(path.join(dir, "lanes"), { recursive: true });
  return { root, runId, dir };
}

const CAPTURED_RESULT = { findings: ["alpha", "beta"] };

// --- checkpointHitForSignature: the resume checkpoint discriminator -----------------------

test("checkpointHitForSignature routes a same-signature checkpoint to cache.checkpoint_hit", () => {
  const checkpoint = { callId: "lane:a", signatureHash: "sig-A", result: CAPTURED_RESULT };
  const hit = checkpointHitForSignature(checkpoint, "sig-A");
  assert.deepEqual(hit, { kind: "checkpoint-hit", eventType: "cache.checkpoint_hit", result: CAPTURED_RESULT });
});

test("cache.checkpoint_hit is distinct from cache.hit and cache.salvaged_hit (provenance stays observable)", () => {
  // The three resume provenances must route to three DISTINCT event types so observers can tell
  // own-store checkpoint recovery apart from journal replay and transcript salvage.
  const checkpointHit = checkpointHitForSignature(
    { callId: "lane:a", signatureHash: "sig", result: { ok: 1 } },
    "sig",
  );
  const journalHit = classifyResumeCacheHit(
    { signatureHash: "sig", outcome: "success", result: { ok: 1 } },
    "sig",
  );
  const salvagedHit = classifyResumeCacheHit(
    { signatureHash: "sig", outcome: "success", salvagedFromTranscript: true, result: { ok: 1 } },
    "sig",
  );
  assert.equal(checkpointHit.eventType, "cache.checkpoint_hit");
  assert.equal(journalHit.eventType, "cache.hit");
  assert.equal(salvagedHit.eventType, "cache.salvaged_hit");
  assert.equal(new Set([checkpointHit.eventType, journalHit.eventType, salvagedHit.eventType]).size, 3, "all three events must be distinct");
});

test("checkpointHitForSignature returns null for signature mismatch, missing checkpoint, or missing signature", () => {
  const checkpoint = { callId: "lane:a", signatureHash: "sig-A", result: CAPTURED_RESULT };
  assert.equal(checkpointHitForSignature(checkpoint, "wrong-signature"), null, "signature mismatch must not checkpoint-hit");
  assert.equal(checkpointHitForSignature(checkpoint, undefined), null, "undefined expected signature must not checkpoint-hit");
  assert.equal(checkpointHitForSignature(null, "sig-A"), null, "missing checkpoint must not checkpoint-hit");
  assert.equal(checkpointHitForSignature(undefined, "sig-A"), null);
  // A checkpoint lacking a signatureHash cannot be trusted (legacy/forensic artifact).
  assert.equal(checkpointHitForSignature({ callId: "lane:a", result: CAPTURED_RESULT }, "sig-A"), null);
});

test("checkpointHitForSignature preserves falsy but valid results (empty-string text lane)", () => {
  // A text lane may legitimately return an empty string; it is still a completed capture.
  const hit = checkpointHitForSignature({ callId: "lane:text", signatureHash: "sig", result: "" }, "sig");
  assert.equal(hit.kind, "checkpoint-hit");
  assert.equal(hit.result, "");
});

// --- Durable wiring: writeLaneCheckpoint -> readLaneResultCheckpoint -> discriminator --------

test("writeLaneCheckpoint then readLaneResultCheckpoint round-trips a result checkpoint", async () => {
  const { dir } = await makeRunDir("checkpoint-roundtrip");
  const callId = "lane:roundtrip";
  const sig = "sig-roundtrip";
  await __test.writeLaneCheckpoint(dir, callId, "result", {
    runId: "checkpoint-roundtrip-run",
    callId,
    signatureHash: sig,
    result: CAPTURED_RESULT,
    capturedAt: "2026-06-24T00:00:00.000Z",
  });

  const loaded = await __test.readLaneResultCheckpoint(dir, callId);
  assert.equal(loaded.callId, callId);
  assert.equal(loaded.signatureHash, sig);
  assert.deepEqual(loaded.result, CAPTURED_RESULT);
  assert.deepEqual(checkpointHitForSignature(loaded, sig), { kind: "checkpoint-hit", eventType: "cache.checkpoint_hit", result: CAPTURED_RESULT });
});

test("request checkpoints round-trip bounded schema snapshots", async () => {
  const { root, dir } = await makeRunDir("schema-request-checkpoint");
  try {
    const callId = "lane:schema";
    const schema = {
      type: "object",
      required: ["findings"],
      properties: { findings: { type: "array", items: { type: "string" } } },
    };
    const snapshot = __test.boundedSchemaSnapshot(schema);
    await __test.writeLaneCheckpoint(dir, callId, "request", { callId, schemaHash: snapshot.hash, schemaSnapshot: snapshot });

    const loaded = await __test.readLaneRequestCheckpoint(dir, callId);

    assert.equal(loaded.schemaSnapshot.status, "present");
    assert.equal(loaded.schemaSnapshot.hash, snapshot.hash);
    assert.deepEqual(loaded.schemaSnapshot.schema, schema);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("schema snapshots omit oversized schema bodies", () => {
  const schema = { type: "object", description: "x".repeat(100) };
  const snapshot = __test.boundedSchemaSnapshot(schema, 50);

  assert.equal(snapshot.status, "oversized");
  assert.equal(typeof snapshot.hash, "string");
  assert.equal(typeof snapshot.bytes, "number");
  assert.equal(snapshot.schema, undefined);
});

test("readLaneResultCheckpoint returns null when absent (never throws)", async () => {
  const { dir } = await makeRunDir("checkpoint-absent");
  assert.equal(await __test.readLaneResultCheckpoint(dir, "lane:missing"), null);
  // A totally missing lanes dir does not throw either.
  const bare = await tempDir("checkpoint-bare");
  assert.equal(await __test.readLaneResultCheckpoint(bare, "lane:missing"), null);
});

test("readLaneResultCheckpoint returns null for an unparseable or callId-mismatched file", async () => {
  const { dir } = await makeRunDir("checkpoint-corrupt");
  const file = path.join(dir, "lanes", `${__test.safeProjectionName("lane:corrupt")}.result.json`);
  // Truncated / non-JSON content (a crash mid-write before the atomic rename would not leave
  // this, but defend against it anyway): treated as "no checkpoint".
  await fs.writeFile(file, '{"callId":"lane:corrupt","signatureHash":"x","result":', "utf8");
  assert.equal(await __test.readLaneResultCheckpoint(dir, "lane:corrupt"), null, "unparseable checkpoint must yield null");
  // A result.json whose embedded callId does not match is ignored (stale/mismatched artifact).
  await __test.writeLaneCheckpoint(dir, "lane:other", "result", { callId: "lane:other", signatureHash: "sig", result: { ok: 1 } });
  assert.equal(await __test.readLaneResultCheckpoint(dir, "lane:mismatch"), null, "callId mismatch must yield null");
});

// --- The crash window: result.json present, journal entry absent ---------------------------

test("crash window recovery: result.json survives a crash before journal append and is reused on resume", async () => {
  // Simulate the exact crash window: session.prompt returned, the controller captured + wrote
  // lanes/<callId>.result.json, but the owning process died BEFORE recordLaneOutcome appended
  // journal.jsonl. On resume there is NO journal entry for this callId, yet the result is
  // recoverable from the run's OWN store without re-running the lane or reading any transcript.
  const { dir } = await makeRunDir("checkpoint-crash-window");
  const callId = "lane:crash-window";
  const sig = "sig-crash-window";

  // A running lane projection exists (written pre-prompt) but no success journal entry.
  await __test.writeLaneProjection({ id: "checkpoint-crash-window-run", dir, laneRecords: new Map() }, callId, {
    status: "running",
    childID: "child-crash-window",
    signatureHash: sig,
  });
  // The controller captured + checkpointed the result, then died before journaling.
  await __test.writeLaneCheckpoint(dir, callId, "result", {
    runId: "checkpoint-crash-window-run",
    callId,
    signatureHash: sig,
    result: CAPTURED_RESULT,
    capturedAt: "2026-06-24T00:00:00.000Z",
  });

  // The authoritative journal has NO entry for this lane (the crash window).
  const journal = await __test.loadJournal(dir);
  assert.equal(journal.has(callId), false, "journal must be empty for this callId (crash before recordLaneOutcome)");

  // The journal-based resume predicate therefore CANNOT recover it (would re-run)...
  assert.equal(classifyResumeCacheHit(journal.get(callId), sig), null, "journal check must miss in the crash window");

  // ...but the checkpoint check (consulted BEFORE the journal check in runChildAgent) recovers it
  // as a cache.checkpoint_hit, returning the captured result without re-running the lane.
  const checkpoint = await __test.readLaneResultCheckpoint(dir, callId);
  const hit = checkpointHitForSignature(checkpoint, sig);
  assert.equal(hit.eventType, "cache.checkpoint_hit");
  assert.deepEqual(hit.result, CAPTURED_RESULT);
});

test("crash window: checkpoint files do not pollute projections before resume promotion", async () => {
  // The checkpoint is the transcript-independent path. Before resume consumes it, the checkpoint
  // file itself must not masquerade as a lane projection; the lane remains the original running
  // projection until the checkpoint hit is promoted into the authoritative journal/projection.
  const { dir } = await makeRunDir("checkpoint-vs-salvage");
  const callId = "lane:checkpoint-vs-salvage";
  const sig = "sig-cvs";
  const state = { laneRecords: [] };
  await __test.writeLaneProjection({ id: "checkpoint-vs-salvage-run", dir, laneRecords: new Map() }, callId, {
    status: "running",
    childID: "child-cvs",
    signatureHash: sig,
  });
  await __test.writeLaneCheckpoint(dir, callId, "result", { runId: "checkpoint-vs-salvage-run", callId, signatureHash: sig, result: { ok: 1 } });

  // readLaneProjections must NOT include the checkpoint file (no duplicate callId / pollution).
  const projections = await __test.readLaneProjections(dir, state);
  const byCallId = projections.filter((lane) => lane.callId === callId);
  assert.equal(byCallId.length, 1, "checkpoint file must not create a duplicate lane projection");
  assert.equal(byCallId[0].status, "running");
});

test("crash window: promoted checkpoint recovery is authoritative and suppresses salvage candidates", async () => {
  const { dir, runId } = await makeRunDir("checkpoint-authoritative");
  const callId = "lane:checkpoint-authoritative";
  const sig = "sig-ca";
  const state = { laneRecords: [] };
  const run = { id: runId, dir, laneRecords: new Map(), laneOutcomes: { success: 0, failure: 0 }, droppedLaneCount: 0, journalRecords: 0 };
  await __test.writeLaneProjection(run, callId, {
    status: "running",
    childID: "child-ca",
    title: "Checkpoint Authoritative",
    model: "openai/gpt-5.5",
    agent: "general",
    signatureHash: sig,
  });
  await __test.writeLaneCheckpoint(dir, callId, "result", {
    runId,
    callId,
    childID: "child-ca",
    signatureHash: sig,
    model: "openai/gpt-5.5",
    agent: "general",
    result: { ok: 1 },
    capturedAt: "2026-06-24T00:00:00.000Z",
  });

  const checkpoint = await __test.readLaneResultCheckpoint(dir, callId);
  const hit = checkpointHitForSignature(checkpoint, sig);
  await __test.recordLaneOutcome(run, {
    callId,
    signatureHash: sig,
    outcome: "success",
    childID: checkpoint.childID,
    title: "Checkpoint Authoritative",
    model: checkpoint.model,
    agent: checkpoint.agent,
    result: hit.result,
    recoveredFromCheckpoint: true,
    checkpointSignatureHash: checkpoint.signatureHash,
    checkpointCapturedAt: checkpoint.capturedAt,
  });

  const projections = await __test.readLaneProjections(dir, state);
  const recovered = projections.find((lane) => lane.callId === callId);
  assert.equal(recovered.status, "completed");
  assert.equal(recovered.outcome, "success");
  assert.equal(recovered.recoveredFromCheckpoint, true);
  assert.equal(recovered.checkpointSignatureHash, sig);
  assert.equal(recovered.checkpointCapturedAt, "2026-06-24T00:00:00.000Z");
  const journal = await __test.loadJournal(dir);
  assert.equal(journal.get(callId).recoveredFromCheckpoint, true);
  assert.deepEqual(journal.get(callId).result, { ok: 1 });
  const candidates = await __test.computeSalvageCandidates(dir, state);
  assert.equal(candidates.some((c) => c.callId === callId), false, "authoritatively recovered lanes must not remain salvage candidates");
});

// --- Signature mismatch / checkpoint absent: fall through to current behavior --------------

test("signature mismatch: a result.json whose signatureHash differs is ignored and the lane falls through", async () => {
  const { dir } = await makeRunDir("checkpoint-sig-mismatch");
  const callId = "lane:sig-mismatch";
  // A checkpoint captured under an OLD lane signature (e.g. the workflow source / prompt changed
  // before resume). It must NOT be trusted: the lane must re-run or fall through to the journal.
  await __test.writeLaneCheckpoint(dir, callId, "result", { callId, signatureHash: "old-signature", result: { stale: true } });

  const checkpoint = await __test.readLaneResultCheckpoint(dir, callId);
  assert.equal(checkpointHitForSignature(checkpoint, "new-signature"), null, "mismatched checkpoint must not hit");
  // The journal check (consulted next) also has nothing for this lane -> lane re-runs.
  const journal = await __test.loadJournal(dir);
  assert.equal(classifyResumeCacheHit(journal.get(callId), "new-signature"), null);
});

test("checkpoint absent: behavior is unchanged (regression guard for the resume fallthrough)", async () => {
  const { dir } = await makeRunDir("checkpoint-none");
  const callId = "lane:no-checkpoint";
  // No result.json on disk.
  assert.equal(await __test.readLaneResultCheckpoint(dir, callId), null);
  assert.equal(checkpointHitForSignature(null, "sig"), null);
  // The journal check is the next thing runChildAgent consults; with no entry it also misses,
  // preserving the pre-checkpoint behavior (lane re-runs).
  const journal = await __test.loadJournal(dir);
  assert.equal(classifyResumeCacheHit(journal.get(callId), "sig"), null);
});

// --- request.json written before prompt + projection interplay + safe naming ---------------

test("writeLaneCheckpoint writes request/result files that readLaneProjections skips (projection interplay)", async () => {
  const { dir } = await makeRunDir("checkpoint-projection-interplay");
  const callId = "lane:interplay";
  await __test.writeLaneProjection({ id: "checkpoint-projection-interplay-run", dir, laneRecords: new Map() }, callId, {
    status: "running",
    childID: "child-interplay",
  });
  await __test.writeLaneCheckpoint(dir, callId, "request", { callId, signatureHash: "sig", promptHash: "p", schemaHash: "s", childID: "child-interplay" });
  await __test.writeLaneCheckpoint(dir, callId, "result", { callId, signatureHash: "sig", result: { ok: 1 } });

  // Exactly one projection for the callId (the .json file), never the .request.json/.result.json.
  const projections = await __test.readLaneProjections(dir, {});
  const matched = projections.filter((lane) => lane.callId === callId);
  assert.equal(matched.length, 1);
  assert.equal(matched[0].status, "running");
});

test("writeLaneCheckpoint safe-names callIds containing '/' or ':' into single files", async () => {
  // parallel/* and drain:... callIds must not become nested paths; safeProjectionName flattens
  // them exactly as writeLaneProjection does, so write and read share one naming convention.
  const { dir } = await makeRunDir("checkpoint-safe-name");
  const tricky = "parallel/0:drain:item";
  await __test.writeLaneCheckpoint(dir, tricky, "result", { callId: tricky, signatureHash: "sig", result: { ok: 1 } });
  const expected = path.join(dir, "lanes", `${__test.safeProjectionName(tricky)}.result.json`);
  const entries = (await fs.readdir(path.join(dir, "lanes"))).filter((name) => name.endsWith(".json"));
  assert.ok(entries.includes(path.basename(expected)), `expected safe-named file ${path.basename(expected)} in ${JSON.stringify(entries)}`);
  // readLaneResultCheckpoint finds it back by callId (matched on the embedded field, not filename).
  const loaded = await __test.readLaneResultCheckpoint(dir, tricky);
  assert.equal(loaded.callId, tricky);
  assert.deepEqual(checkpointHitForSignature(loaded, "sig").result, { ok: 1 });
});

// --- Journal-authoritative interplay: removeLaneCheckpoint retires a superseded checkpoint --

test("removeLaneCheckpoint retires the result checkpoint so a normally-journaled lane resumes via cache.hit", async () => {
  // After recordLaneOutcome succeeds, the journal is authoritative and runChildAgent removes the
  // narrow-window checkpoint. On the next resume the checkpoint is absent, so the resume branch
  // falls through to the journal check and emits the canonical cache.hit (not checkpoint_hit).
  const { dir } = await makeRunDir("checkpoint-retire");
  const callId = "lane:retire";
  const sig = "sig-retire";
  await __test.writeLaneCheckpoint(dir, callId, "result", { callId, signatureHash: sig, result: { ok: 1 } });
  assert.ok(await __test.readLaneResultCheckpoint(dir, callId), "checkpoint exists before retirement");

  await __test.removeLaneCheckpoint(dir, callId, "result");
  await __test.removeLaneCheckpoint(dir, callId, "request");
  assert.equal(await __test.readLaneResultCheckpoint(dir, callId), null, "checkpoint retired after journaling");

  // The journal entry (written by recordLaneOutcome) now drives the resume decision.
  await fs.appendFile(path.join(dir, "journal.jsonl"), `${JSON.stringify({ type: "agent", callId, signatureHash: sig, outcome: "success", result: { ok: 1 } })}\n`, "utf8");
  const journal = await __test.loadJournal(dir);
  assert.deepEqual(classifyResumeCacheHit(journal.get(callId), sig), { kind: "hit", eventType: "cache.hit" }, "journal-resumed lane emits cache.hit once the checkpoint is retired");
});

test("removeLaneCheckpoint is best-effort: never throws, idempotent on a missing file", async () => {
  const { dir } = await makeRunDir("checkpoint-remove-best-effort");
  // Removing a checkpoint that was never written must not throw.
  await __test.removeLaneCheckpoint(dir, "lane:never", "result");
  await __test.removeLaneCheckpoint(dir, "lane:never", "request");
  // Removing twice is idempotent.
  await __test.writeLaneCheckpoint(dir, "lane:once", "result", { callId: "lane:once", signatureHash: "sig", result: { ok: 1 } });
  await __test.removeLaneCheckpoint(dir, "lane:once", "result");
  await __test.removeLaneCheckpoint(dir, "lane:once", "result");
  assert.equal(await __test.readLaneResultCheckpoint(dir, "lane:once"), null);
});
