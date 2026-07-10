import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import WorkflowPlugin from "../workflow-kernel/index.js";
import { acquireWorkflowLock, lockPathForRun } from "../workflow-kernel/run-store-locks.js";
import { boundedSchemaSnapshot } from "../workflow-kernel/structured-output.js";
import { readLaneProjections, writeLaneCheckpoint, writeLaneProjection } from "../workflow-kernel/run-store-projections.js";
import { runDirForRoot, writeJsonAtomic } from "../workflow-kernel/run-store-fs.js";
import { loadJournal } from "../workflow-kernel/event-journal.js";

const { __test } = WorkflowPlugin;
const salvageRun = __test.salvageRun;

async function tempDir(name) {
  return await fs.mkdtemp(path.join(os.tmpdir(), `${name}-`));
}

// readRunById(context, runId) resolves runs under <worktree>/.opencode/workflows/runs/.
function runRootFor(tempDir) {
  return path.join(tempDir, ".opencode", "workflows", "runs");
}

function runDirFor(tempDir, runId) {
  return runDirForRoot(runRootFor(tempDir), runId);
}

function contextFor(tempDir) {
  return { worktree: tempDir };
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

async function writeRequestCheckpoint(dir, lane, schemaSnapshot) {
  await writeLaneCheckpoint(dir, lane.callId, "request", {
    callId: lane.callId,
    childID: lane.childID,
    signatureHash: lane.signatureHash,
    schemaHash: schemaSnapshot?.hash,
    schemaSnapshot,
  });
}

async function readJournal(dir) {
  try {
    const content = await fs.readFile(path.join(dir, "journal.jsonl"), "utf8");
    return content.split(/\r?\n/).filter((line) => line.trim()).map((line) => JSON.parse(line));
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

async function readFileText(filePath) {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

// Mock SDK client whose session.messages returns canned transcripts keyed by childID. Handles
// both the v1 ({ path: { id } }) and v2 ({ sessionID }) transport shapes that sessionApi emits.
function mockPluginContext(transcripts) {
  return {
    client: {
      session: {
        messages: async (arg) => {
          const id = arg?.sessionID ?? arg?.path?.id;
          return transcripts[id] ?? { data: [] };
        },
      },
    },
  };
}

function assistantMessage(text) {
  return { role: "assistant", parts: [{ type: "text", text }] };
}

function userMessage(text) {
  return { role: "user", parts: [{ type: "text", text }] };
}

// A read-only orphan lane with a final assistant reply that is valid JSON.
const VALID = { callId: "lane:valid", childID: "child-valid", signatureHash: "sig-valid" };
const VALID_RESULT = { findings: ["alpha", "beta"] };

function validTranscript() {
  return { data: [userMessage("inspect"), assistantMessage(JSON.stringify(VALID_RESULT))] };
}

async function setupInterruptedRun(tempDirName, lanes) {
  const root = await tempDir(tempDirName);
  const runId = `${tempDirName}-run`;
  const dir = runDirFor(root, runId);
  await fs.mkdir(dir, { recursive: true });
  await writeState(dir, {
    id: runId,
    status: "interrupted",
    startedAt: "2026-06-24T00:00:00.000Z",
    finishedAt: "2026-06-24T00:02:00.000Z",
    laneRecords: [],
  });
  for (const lane of lanes) {
    await writeLane(dir, runId, lane.callId, {
      status: "running",
      childID: lane.childID,
      ...(lane.signatureHash ? { signatureHash: lane.signatureHash } : {}),
      ...(lane.worktreePath ? { worktreePath: lane.worktreePath } : {}),
      ...(lane.integrationLane ? { integrationLane: lane.integrationLane } : {}),
      title: lane.title ?? "orphan",
      model: "p/m",
    });
  }
  return { root, runId, dir };
}

test("preview-only call returns recoverable lanes and writes nothing", async () => {
  const { root, runId, dir } = await setupInterruptedRun("salvage-preview", [
    { callId: VALID.callId, childID: VALID.childID, signatureHash: VALID.signatureHash },
  ]);
  const pluginContext = mockPluginContext({ [VALID.childID]: validTranscript() });

  const before = await snapshotTree(dir);

  const out = JSON.parse(await salvageRun(pluginContext, contextFor(root), { runId }));
  assert.equal(out.mode, "preview");
  assert.equal(out.candidates.length, 1);
  assert.equal(out.candidates[0].callId, VALID.callId);
  assert.equal(out.candidates[0].childID, VALID.childID);
  assert.equal(out.candidates[0].parseVerdict, "valid");
  assert.equal(out.candidates[0].validationKind, "json-parse");
  assert.equal(out.candidates[0].originalSchemaAvailable, false);
  assert.equal(out.candidates[0].schemaSnapshotStatus, "absent");
  assert.equal(out.candidates[0].schemaVerdict, "not-checked");
  assert.equal(out.candidates[0].finalMessageFound, true);
  assert.ok(out.candidates[0].finalMessageLength > 0);
  assert.equal(out.candidates[0].resumeSignatureAvailable, true);
  assert.ok(typeof out.approvalHash === "string" && out.approvalHash.length > 0);

  const after = await snapshotTree(dir);
  assert.deepEqual(after, before, "preview must not mutate any run files");
});

test("salvage rejects a run that still holds an active run lock", async () => {
  const { root, runId, dir } = await setupInterruptedRun("salvage-live-lock", [
    { callId: VALID.callId, childID: VALID.childID, signatureHash: VALID.signatureHash },
  ]);
  await writeState(dir, {
    id: runId,
    status: "running",
    startedAt: "2026-06-24T00:00:00.000Z",
    laneRecords: [],
  });
  const release = await acquireWorkflowLock(lockPathForRun(dir, "run"), { operation: "run", runId });
  try {
    await assert.rejects(
      salvageRun(mockPluginContext({ [VALID.childID]: validTranscript() }), contextFor(root), { runId }),
      /still holds an active run lock.*workflow_salvage/,
    );
    assert.deepEqual(await readJournal(dir), [], "live-run rejection must not write synthetic journal entries");
  } finally {
    await release();
  }
});

test("approve with a wrong approvalHash does not write (still preview)", async () => {
  const { root, runId, dir } = await setupInterruptedRun("salvage-wronghash", [
    { callId: VALID.callId, childID: VALID.childID, signatureHash: VALID.signatureHash },
  ]);
  const pluginContext = mockPluginContext({ [VALID.childID]: validTranscript() });

  const before = await snapshotTree(dir);
  const out = JSON.parse(await salvageRun(pluginContext, contextFor(root), { runId, approve: true, approvalHash: "deadbeef" }));
  assert.equal(out.mode, "preview");
  const after = await snapshotTree(dir);
  assert.deepEqual(after, before, "mismatched approvalHash must not mutate any run files");
});

test("approve with matching hash writes tagged synthetic journal entries for schema-valid read-only lanes", async () => {
  const { root, runId, dir } = await setupInterruptedRun("salvage-approve", [
    { callId: VALID.callId, childID: VALID.childID, signatureHash: VALID.signatureHash },
  ]);
  const pluginContext = mockPluginContext({ [VALID.childID]: validTranscript() });

  const preview = JSON.parse(await salvageRun(pluginContext, contextFor(root), { runId }));
  const out = JSON.parse(await salvageRun(pluginContext, contextFor(root), { runId, approve: true, approvalHash: preview.approvalHash }));

  assert.equal(out.mode, "approve");
  assert.equal(out.salvaged.length, 1);
  assert.equal(out.salvaged[0].callId, VALID.callId);
  assert.equal(out.salvaged[0].outcome, "success");
  assert.equal(out.salvaged[0].resumeSignatureAvailable, true);

  const journal = await readJournal(dir);
  assert.equal(journal.length, 1);
  const entry = journal[0];
  assert.equal(entry.type, "agent");
  assert.equal(entry.salvagedFromTranscript, true);
  assert.equal(entry.callId, VALID.callId);
  assert.equal(entry.childID, VALID.childID);
  assert.equal(entry.outcome, "success");
  assert.equal(entry.signatureHash, VALID.signatureHash);
  assert.deepEqual(entry.result, VALID_RESULT);
  assert.equal(entry.salvageValidation.kind, "json-parse");
  assert.equal(entry.salvageValidation.originalSchemaAvailable, false);
  assert.equal(entry.salvageValidation.schemaSnapshotStatus, "absent");
  assert.equal(entry.salvageValidation.schemaVerdict, "not-checked");

  const lanes = await readLaneProjections(dir, { laneRecords: [] });
  const lane = lanes.find((record) => record.callId === VALID.callId);
  assert.equal(lane.status, "completed");
  assert.equal(lane.outcome, "success");
  assert.equal(lane.salvagedFromTranscript, true);
});

test("schema-present salvage validates recovered JSON against stored schema", async () => {
  const { root, runId, dir } = await setupInterruptedRun("salvage-schema-valid", [VALID]);
  const schema = {
    type: "object",
    required: ["findings"],
    properties: { findings: { type: "array", items: { type: "string" } } },
  };
  const snapshot = boundedSchemaSnapshot(schema);
  await writeRequestCheckpoint(dir, VALID, snapshot);
  const pluginContext = mockPluginContext({ [VALID.childID]: validTranscript() });

  const preview = JSON.parse(await salvageRun(pluginContext, contextFor(root), { runId }));
  assert.equal(preview.candidates[0].validationKind, "json-schema");
  assert.equal(preview.candidates[0].originalSchemaAvailable, true);
  assert.equal(preview.candidates[0].schemaSnapshotStatus, "present");
  assert.equal(preview.candidates[0].schemaHash, snapshot.hash);
  assert.equal(preview.candidates[0].schemaVerdict, "valid");

  const out = JSON.parse(await salvageRun(pluginContext, contextFor(root), { runId, approve: true, approvalHash: preview.approvalHash }));
  assert.equal(out.salvaged[0].outcome, "success");
  assert.equal(out.salvaged[0].validationKind, "json-schema");

  const journal = await readJournal(dir);
  assert.equal(journal[0].salvageValidation.kind, "json-schema");
  assert.equal(journal[0].salvageValidation.schemaVerdict, "valid");
  assert.deepEqual(journal[0].result, VALID_RESULT);
});

test("schema-present salvage rejects JSON that does not match stored schema", async () => {
  const lane = { callId: "lane:schema-invalid", childID: "child-schema-invalid", signatureHash: "sig-schema-invalid" };
  const { root, runId, dir } = await setupInterruptedRun("salvage-schema-invalid", [lane]);
  const schema = {
    type: "object",
    required: ["findings"],
    properties: { findings: { type: "array", items: { type: "string" } } },
  };
  const snapshot = boundedSchemaSnapshot(schema);
  await writeRequestCheckpoint(dir, lane, snapshot);
  const pluginContext = mockPluginContext({ [lane.childID]: { data: [assistantMessage(JSON.stringify({ findings: "not-array" }))] } });

  const preview = JSON.parse(await salvageRun(pluginContext, contextFor(root), { runId }));
  assert.equal(preview.candidates[0].parseVerdict, "valid");
  assert.equal(preview.candidates[0].validationKind, "json-schema");
  assert.equal(preview.candidates[0].schemaVerdict, "invalid");
  assert.match(preview.candidates[0].validationError, /result\/findings/);

  const out = JSON.parse(await salvageRun(pluginContext, contextFor(root), { runId, approve: true, approvalHash: preview.approvalHash }));
  assert.equal(out.salvaged[0].outcome, "failure");

  const journal = await readJournal(dir);
  assert.equal(journal[0].outcome, "failure");
  assert.equal(journal[0].result, undefined);
  assert.equal(journal[0].salvageValidation.schemaVerdict, "invalid");
  assert.match(journal[0].errorSummary, /did not match stored JSON schema/);
});

test("oversized schema snapshots salvage as explicit JSON-only recovery", async () => {
  const { root, runId, dir } = await setupInterruptedRun("salvage-schema-oversized", [VALID]);
  const snapshot = boundedSchemaSnapshot({ type: "object", description: "x".repeat(100) }, 50);
  await writeRequestCheckpoint(dir, VALID, snapshot);
  const pluginContext = mockPluginContext({ [VALID.childID]: validTranscript() });

  const preview = JSON.parse(await salvageRun(pluginContext, contextFor(root), { runId }));
  assert.equal(preview.candidates[0].validationKind, "json-parse");
  assert.equal(preview.candidates[0].originalSchemaAvailable, false);
  assert.equal(preview.candidates[0].schemaSnapshotStatus, "oversized");
  assert.equal(preview.candidates[0].schemaVerdict, "not-checked");
  assert.doesNotMatch(JSON.stringify(preview), /"schema":/);

  const out = JSON.parse(await salvageRun(pluginContext, contextFor(root), { runId, approve: true, approvalHash: preview.approvalHash }));
  assert.equal(out.salvaged[0].outcome, "success");
  const journal = await readJournal(dir);
  assert.equal(journal[0].salvageValidation.schemaSnapshotStatus, "oversized");
  assert.equal(journal[0].salvageValidation.originalSchemaAvailable, false);
});

test("edit/integration lanes are reported as salvage-skipped and never salvaged", async () => {
  const editLane = { callId: "lane:edit", childID: "child-edit", worktreePath: "/tmp/wt-edit" };
  const integLane = { callId: "lane:integ", childID: "child-integ", integrationLane: { laneId: "L1", committed: false } };
  const { root, runId, dir } = await setupInterruptedRun("salvage-edit-skip", [
    editLane,
    integLane,
    { callId: VALID.callId, childID: VALID.childID, signatureHash: VALID.signatureHash },
  ]);
  const pluginContext = mockPluginContext({
    [VALID.childID]: validTranscript(),
    [editLane.childID]: { data: [assistantMessage('{"patches":[]}')] },
    [integLane.childID]: { data: [assistantMessage('{"patches":[]}')] },
  });

  const preview = JSON.parse(await salvageRun(pluginContext, contextFor(root), { runId }));
  const byCallId = Object.fromEntries(preview.candidates.map((c) => [c.callId, c]));
  assert.equal(byCallId[editLane.callId].skipped, "edit-lane-without-commit");
  assert.equal(byCallId[integLane.callId].skipped, "edit-lane-without-commit");
  assert.equal(byCallId[VALID.callId].skipped, undefined);
  assert.equal(byCallId[VALID.callId].parseVerdict, "valid");

  const out = JSON.parse(await salvageRun(pluginContext, contextFor(root), { runId, approve: true, approvalHash: preview.approvalHash }));
  const skippedIds = new Set(out.skipped.map((s) => s.callId));
  assert.ok(skippedIds.has(editLane.callId));
  assert.ok(skippedIds.has(integLane.callId));
  assert.equal(out.salvaged.length, 1);
  assert.equal(out.salvaged[0].callId, VALID.callId);

  // Only the read-only lane was journaled; edit/integration lanes left no synthetic entry.
  const journal = await readJournal(dir);
  assert.equal(journal.length, 1);
  assert.equal(journal[0].callId, VALID.callId);
});

test("schema-mismatch (non-JSON final message) yields outcome failure", async () => {
  const lane = { callId: "lane:prose", childID: "child-prose", signatureHash: "sig-prose" };
  const { root, runId, dir } = await setupInterruptedRun("salvage-mismatch", [lane]);
  const pluginContext = mockPluginContext({
    [lane.childID]: { data: [userMessage("go"), assistantMessage("I could not finish the analysis.")] },
  });

  const preview = JSON.parse(await salvageRun(pluginContext, contextFor(root), { runId }));
  assert.equal(preview.candidates[0].parseVerdict, "invalid");

  const out = JSON.parse(await salvageRun(pluginContext, contextFor(root), { runId, approve: true, approvalHash: preview.approvalHash }));
  assert.equal(out.salvaged[0].outcome, "failure");

  const journal = await readJournal(dir);
  assert.equal(journal.length, 1);
  const entry = journal[0];
  assert.equal(entry.salvagedFromTranscript, true);
  assert.equal(entry.outcome, "failure");
  assert.equal(entry.result, undefined);
  assert.ok(typeof entry.errorSummary === "string" && entry.errorSummary.length > 0);

  const lanes = await readLaneProjections(dir, { laneRecords: [] });
  const proj = lanes.find((record) => record.callId === lane.callId);
  assert.equal(proj.outcome, "failure");
});

test("salvage never calls integrate/runAutoApply: state.json, worktrees, and integration ledger are untouched", async () => {
  const { root, runId, dir } = await setupInterruptedRun("salvage-no-integrate", [
    { callId: VALID.callId, childID: VALID.childID, signatureHash: VALID.signatureHash },
  ]);
  // Seed durable artifacts that integration/apply would mutate, so we can prove salvage leaves
  // them byte-identical.
  const statePath = path.join(dir, "state.json");
  const worktreesPath = path.join(dir, "worktrees.json");
  const integLedgerPath = path.join(dir, "integration-ledger.jsonl");
  await writeJsonAtomic(worktreesPath, { runId, edit: [], integration: [], lanes: [] });
  await fs.writeFile(integLedgerPath, '{"phase":"lane-committed","callId":"unrelated"}\n', "utf8");

  const stateBefore = await readFileText(statePath);
  const worktreesBefore = await readFileText(worktreesPath);
  const integBefore = await readFileText(integLedgerPath);

  const pluginContext = mockPluginContext({ [VALID.childID]: validTranscript() });
  const preview = JSON.parse(await salvageRun(pluginContext, contextFor(root), { runId }));
  await salvageRun(pluginContext, contextFor(root), { runId, approve: true, approvalHash: preview.approvalHash });

  assert.equal(await readFileText(statePath), stateBefore, "salvage must not rewrite state.json");
  assert.equal(await readFileText(worktreesPath), worktreesBefore, "salvage must not touch worktrees.json");
  assert.equal(await readFileText(integLedgerPath), integBefore, "salvage must not append to the integration ledger");
});

test("resumed run cache-hits salvaged entries when a signature is available; legacy orphans report resumeSignatureAvailable false", async () => {
  const legacy = { callId: "lane:legacy", childID: "child-legacy" };
  const { root, runId, dir } = await setupInterruptedRun("salvage-resume", [
    { callId: VALID.callId, childID: VALID.childID, signatureHash: VALID.signatureHash },
    legacy,
  ]);
  const pluginContext = mockPluginContext({
    [VALID.childID]: validTranscript(),
    [legacy.childID]: { data: [assistantMessage(JSON.stringify({ ok: 1 }))] },
  });

  const preview = JSON.parse(await salvageRun(pluginContext, contextFor(root), { runId }));
  const byCallId = Object.fromEntries(preview.candidates.map((c) => [c.callId, c]));
  assert.equal(byCallId[VALID.callId].resumeSignatureAvailable, true);
  assert.equal(byCallId[legacy.callId].resumeSignatureAvailable, false, "legacy orphan without persisted signatureHash is not cache-reusable");

  await salvageRun(pluginContext, contextFor(root), { runId, approve: true, approvalHash: preview.approvalHash });

  // The existing runChildAgent resume cache-hit predicate is:
  //   cached?.signatureHash === sig && cached.outcome === "success"  -> return cached.result
  // A salvaged entry with a persisted signatureHash satisfies it exactly; a legacy entry (no
  // signatureHash) does not, so resume would re-run it rather than trust the salvage.
  const journal = await loadJournal(dir);
  const cachedValid = journal.get(VALID.callId);
  const sig = VALID.signatureHash;
  assert.equal(cachedValid.salvagedFromTranscript, true);
  assert.equal(cachedValid.signatureHash, sig);
  assert.equal(cachedValid.outcome, "success");
  assert.deepEqual(cachedValid.result, VALID_RESULT);
  assert.equal(cachedValid?.signatureHash === sig && cachedValid.outcome === "success", true, "resume cache-hit predicate must be satisfiable for the signed salvaged entry");

  const cachedLegacy = journal.get(legacy.callId);
  assert.equal(cachedLegacy.outcome, "success");
  assert.equal(cachedLegacy.signatureHash, undefined);
  assert.equal(cachedLegacy?.signatureHash === "any-recomputed-sig" && cachedLegacy.outcome === "success", false, "legacy salvaged entry must not satisfy the signature-gated cache predicate");
});

test("extractFinalAssistantText finds the last assistant message text and tolerates shapes", async () => {
  const extract = __test.extractFinalAssistantText;
  assert.equal(extract({ data: [userMessage("x"), assistantMessage("hello")] }).text, "hello");
  assert.equal(extract({ data: [assistantMessage("first"), userMessage("mid"), assistantMessage("last")] }).text, "last");
  assert.equal(extract({ data: [{ role: "assistant", parts: [{ type: "text", text: "a" }, { type: "text", text: "b" }] }] }).text, "a\nb");
  // content-style parts also collected
  assert.equal(extract({ data: [{ role: "assistant", content: [{ type: "text", text: "deep" }] }] }).text, "deep");
  // no assistant message
  assert.equal(extract({ data: [userMessage("only")] }).found, false);
  assert.equal(extract({ data: [] }).found, false);
  assert.equal(extract(undefined).found, false);
});

test("tryParseJson returns ok/value for JSON and ok=false otherwise", async () => {
  const parse = __test.tryParseJson;
  assert.deepEqual(parse('{"a":1}'), { ok: true, value: { a: 1 } });
  assert.equal(parse("[1,2]").ok, true);
  assert.equal(parse("not json").ok, false);
  assert.equal(parse("").ok, false);
});

test("computeSalvageApprovalHash is deterministic and reflects transcript/verdict changes", async () => {
  const hashOf = __test.computeSalvageApprovalHash;
  const payload = (callId, verdict, len) => [{ callId, childID: "c", skipped: null, finalMessageFound: true, finalMessageLength: len, parseVerdict: verdict, finalMessageHash: "h", resumeSignatureAvailable: true }];
  const a = hashOf("run-1", payload("lane:x", "valid", 10));
  const b = hashOf("run-1", payload("lane:x", "valid", 10));
  assert.equal(a, b, "same payload -> same hash");
  const c = hashOf("run-1", payload("lane:x", "invalid", 10));
  assert.notEqual(a, c, "verdict change -> different hash");
  const d = hashOf("run-2", payload("lane:x", "valid", 10));
  assert.notEqual(a, d, "runId change -> different hash");
});
