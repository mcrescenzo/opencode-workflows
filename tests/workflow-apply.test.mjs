// applyWorkflow / workflow_apply finalization + patch-target safety suite.
//
// Split out of the former tests/workflows.test.mjs monolith (bd opencode-workflows-9pv).
// startWorkflow / run / status / drain / notification tests live in workflow-run.test.mjs.

import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { encodeApplyBundle, decodeApplyBundle, computeDiffPlanHash } from "../workflow-kernel/approval-hashing.js";
import { appendLedger, computeDomainMutationHash, stagedDomainMutationManifest, stageDomainMutation } from "../workflow-kernel/event-journal.js";
import { acquireWorkflowLock, lockPathForRun } from "../workflow-kernel/run-store-locks.js";
import { normalizePatches } from "../workflow-kernel/child-agent-runner.js";
import { stableStringify } from "../workflow-kernel/text-json.js";
import { writeJsonAtomic } from "../workflow-kernel/run-store-fs.js";
import { rollbackPatches, validatePatchTargets } from "../workflow-kernel/workflow-plugin.js";
import { makeHarness } from "./helpers/harness.mjs";
const execFileAsync = promisify(execFile);

async function tempDir() {
  return await fs.mkdtemp(path.join(os.tmpdir(), "workflow-apply-security-"));
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function initGitRepo(directory) {
  await execFileAsync("git", ["init"], { cwd: directory });
  await execFileAsync("git", ["config", "user.email", "workflow-test@example.com"], { cwd: directory });
  await execFileAsync("git", ["config", "user.name", "Workflow Test"], { cwd: directory });
  await fs.writeFile(path.join(directory, "README.md"), "initial\n", "utf8");
  await execFileAsync("git", ["add", "README.md"], { cwd: directory });
  await execFileAsync("git", ["commit", "-m", "initial"], { cwd: directory });
}

// Fixture domain-mutation store: a neutral in-memory stand-in for a trusted extension's domain
// finalizer (the reference domain finalizer was deleted with its extension). It keeps the GENERIC workflow_apply
// staged-mutation finalization mechanism fully covered — staging, hash gating, finalize, idempotency,
// finalization-failure -> apply-failed — without shelling out to any real domain CLI. Tests inject
// `handlers` via pluginContext.__workflowDomainMutationHandlers; the finalizer records appended
// notes / closes into the store so assertions read the effect from `noteText(issueId)`.
function makeFixtureDomainStore() {
  const notes = new Map(); // issueId -> [note, ...]
  const closed = new Set();
  const known = new Set(); // issues that exist; fixture.close of an unknown id throws (readback fail)
  const handlers = {
    "fixture.append-notes": async ({ issueId, note }) => {
      const list = notes.get(issueId) ?? [];
      list.push(note);
      notes.set(issueId, list);
      return { id: issueId, notes: list.join("\n") };
    },
    "fixture.close": async ({ issueId }) => {
      if (!known.has(issueId)) throw new Error(`fixture close readback failed: ${issueId} not found`);
      closed.add(issueId);
      return { id: issueId, status: "closed" };
    },
  };
  const noteText = (issueId) => (notes.get(issueId) ?? []).join("\n");
  return { handlers, notes, closed, known, noteText };
}

async function approvalArgs(tools, context, source) {
  const preview = await tools.workflow_run.execute({ source }, context);
  const match = preview.match(/approvalHash: ([a-f0-9]{64})/);
  assert.ok(match, `missing approvalHash in preview: ${preview}`);
  return { source, approve: true, approvalHash: match[1] };
}

async function runApproved(tools, context, source) {
  return await tools.workflow_run.execute(await approvalArgs(tools, context, source), context);
}

function runIdFrom(output) {
  const match = output.match(/Workflow ([0-9a-f-]{36}) (?:completed|started|awaiting diff approval)/);
  assert.ok(match, `missing run id in output: ${output}`);
  return match[1];
}

async function rejectJson(promise) {
  try {
    await promise;
  } catch (error) {
    return JSON.parse(error.message);
  }
  assert.fail("expected promise to reject with JSON error payload");
}

async function refreshDomainManifest(status) {
  const planPath = path.join(status.dir, "diff-plan.json");
  const plan = JSON.parse(await fs.readFile(planPath, "utf8"));
  plan.domainMutationManifest = await stagedDomainMutationManifest(status.dir);
  plan.domainMutationHash = computeDomainMutationHash(plan.domainMutationManifest);
  plan.diffPlanHash = computeDiffPlanHash(plan);
  await writeJsonAtomic(planPath, plan);
  status.editPlan = { ...status.editPlan, domainMutationManifest: plan.domainMutationManifest, domainMutationHash: plan.domainMutationHash, diffPlanHash: plan.diffPlanHash };
  return status;
}

test("workflow_apply finalizes staged domain mutations after patch apply", async () => {
  const toastCalls = [];
  const store = makeFixtureDomainStore();
  const issueId = "fixture-1";
  store.known.add(issueId);
  const { tools, context, directory } = await makeHarness(async () => ({
    data: {
      parts: [{ type: "text", text: JSON.stringify({ patches: [{ path: "applied.txt", content: "applied\n" }] }) }],
      info: {
        structured: { patches: [{ path: "applied.txt", content: "applied\n" }] },
        tokens: { input: 1, output: 1, reasoning: 0 },
        cost: 0,
      },
    },
  }), {
    tui: {
      async showToast(input) {
        toastCalls.push(input.body);
        return { data: true };
      },
    },
    pluginContext: { __workflowDomainMutationHandlers: store.handlers },
  });
  try {
    await initGitRepo(directory);
    const source = `export const meta = { name: "apply-domain", authority: { edit: true }, maxAgents: 1 };
return await agent("edit", { edit: true, schema: { type: "object", properties: { patches: { type: "array" } }, required: ["patches"] } });`;

    const output = await runApproved(tools, context, source);
    const runId = runIdFrom(output);
    const status = JSON.parse(await tools.workflow_status.execute({ runId, format: "json", detail: "full" }, context));
    await stageDomainMutation({ id: runId, dir: status.dir }, {
      mutationKey: `note:${issueId}:apply-finalized`,
      operation: "fixture.append-notes",
      payload: { issueId, note: "finalized after apply" },
    });
    await refreshDomainManifest(status);

    const applied = await tools.workflow_apply.execute({
      runId,
      approvedSourceHash: status.sourceHash,
      baseCommit: status.editPlan.baseCommit,
      diffPlanHash: status.editPlan.diffPlanHash,
      domainMutationHash: status.editPlan.domainMutationHash,
      approvalIntent: "apply",
      expectedPrimaryDirtyState: "clean",
    }, context);

    assert.match(applied, /applied 1 patches and finalized 1 domain mutations/);
    assert.equal(await fs.readFile(path.join(context.directory, "applied.txt"), "utf8"), "applied\n");
    assert.match(store.noteText(issueId), /finalized after apply/);
    const finalStatus = JSON.parse(await tools.workflow_status.execute({ runId, format: "json", detail: "full" }, context));
    assert.equal(finalStatus.status, "applied");
    assert.equal(finalStatus.domainFinalization.finalized, 1);
    assert.ok(toastCalls.some((body) => body.variant === "info" && /^▶ apply-domain · apply running/.test(body.title) && /└ apply running/.test(body.message)), "missing apply-running toast card");
    assert.ok(toastCalls.some((body) => body.variant === "success" && /^▶ apply-domain · applied/.test(body.title) && /└ applied/.test(body.message)), "missing applied toast card");
    assert.ok(toastCalls.every((body) => !/status:|cache|concurrency/.test(body.message)), "legacy apply toast body leaked");

    const reapplied = await tools.workflow_apply.execute({
      runId,
      approvedSourceHash: status.sourceHash,
      baseCommit: status.editPlan.baseCommit,
      diffPlanHash: status.editPlan.diffPlanHash,
      domainMutationHash: status.editPlan.domainMutationHash,
      approvalIntent: "apply",
      expectedPrimaryDirtyState: "clean",
    }, context);
    assert.match(reapplied, /already applied/);

    await stageDomainMutation({ id: runId, dir: status.dir }, {
      mutationKey: `note:${issueId}:invalid-approval-not-finalized`,
      operation: "fixture.append-notes",
      payload: { issueId, note: "invalid approval finalized" },
    });
    await assert.rejects(tools.workflow_apply.execute({
      runId,
      approvedSourceHash: "bad-source-hash",
      baseCommit: status.editPlan.baseCommit,
      diffPlanHash: status.editPlan.diffPlanHash,
      domainMutationHash: status.editPlan.domainMutationHash,
      approvalIntent: "apply",
      expectedPrimaryDirtyState: "clean",
    }, context), /approvedSourceHash mismatch/);
    assert.doesNotMatch(store.noteText(issueId), /invalid approval finalized/);

    await fs.writeFile(path.join(status.dir, "diff-plan.json"), "{not json", "utf8");
    await assert.rejects(tools.workflow_apply.execute({
      runId,
      approvedSourceHash: status.sourceHash,
      baseCommit: status.editPlan.baseCommit,
      diffPlanHash: status.editPlan.diffPlanHash,
      domainMutationHash: status.editPlan.domainMutationHash,
      approvalIntent: "apply",
      expectedPrimaryDirtyState: "clean",
    }, context), /Unexpected token|Expected property name|JSON/);
    assert.doesNotMatch(store.noteText(issueId), /invalid approval finalized/);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("workflow_apply rejects staged domain mutations changed after diff approval", async () => {
  const store = makeFixtureDomainStore();
  const issueId = "fixture-1";
  store.known.add(issueId);
  const { tools, context, directory } = await makeHarness(async () => ({
    data: {
      parts: [{ type: "text", text: JSON.stringify({ patches: [{ path: "domain-hash.txt", content: "safe patch\n" }] }) }],
      info: {
        structured: { patches: [{ path: "domain-hash.txt", content: "safe patch\n" }] },
        tokens: { input: 1, output: 1, reasoning: 0 },
        cost: 0,
      },
    },
  }), { pluginContext: { __workflowDomainMutationHandlers: store.handlers } });
  try {
    await initGitRepo(directory);
    const source = `export const meta = { name: "domain-hash", authority: { edit: true }, maxAgents: 1 };
return await agent("edit", { edit: true, schema: { type: "object", properties: { patches: { type: "array" } }, required: ["patches"] } });`;

    const output = await runApproved(tools, context, source);
    const runId = runIdFrom(output);
    const status = JSON.parse(await tools.workflow_status.execute({ runId, format: "json", detail: "full" }, context));
    await stageDomainMutation({ id: runId, dir: status.dir }, {
      mutationKey: `note:${issueId}:post-approval`,
      operation: "fixture.append-notes",
      payload: { issueId, note: "not approved" },
    });

    await assert.rejects(tools.workflow_apply.execute({
      runId,
      approvedSourceHash: status.sourceHash,
      baseCommit: status.editPlan.baseCommit,
      diffPlanHash: status.editPlan.diffPlanHash,
      domainMutationHash: status.editPlan.domainMutationHash,
      approvalIntent: "apply",
      expectedPrimaryDirtyState: "clean",
    }, context), /staged domain mutations changed/);
    assert.equal(await fileExists(path.join(context.directory, "domain-hash.txt")), false);
    assert.doesNotMatch(store.noteText(issueId), /not approved/);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("workflow_apply leaves retryable apply-failed state when domain finalization fails", async () => {
  // The fixture close finalizer throws for an unknown issueId (readback failure), standing in for a
  // domain mutation that cannot be finalized.
  const store = makeFixtureDomainStore();
  const { tools, context, directory } = await makeHarness(async () => ({
    data: {
      parts: [{ type: "text", text: JSON.stringify({ patches: [{ path: "finalization-failed.txt", content: "patch applied\n" }] }) }],
      info: {
        structured: { patches: [{ path: "finalization-failed.txt", content: "patch applied\n" }] },
        tokens: { input: 1, output: 1, reasoning: 0 },
        cost: 0,
      },
    },
  }), { pluginContext: { __workflowDomainMutationHandlers: store.handlers } });
  try {
    await initGitRepo(directory);
    const source = `export const meta = { name: "apply-domain-fail", authority: { edit: true }, maxAgents: 1 };
return await agent("edit", { edit: true, schema: { type: "object", properties: { patches: { type: "array" } }, required: ["patches"] } });`;

    const output = await runApproved(tools, context, source);
    const runId = runIdFrom(output);
    const status = JSON.parse(await tools.workflow_status.execute({ runId, format: "json", detail: "full" }, context));
    await stageDomainMutation({ id: runId, dir: status.dir }, {
      mutationKey: "close:missing:apply-finalization-fails",
      operation: "fixture.close",
      payload: { issueId: "missing-issue", reason: "should fail" },
    });
    await refreshDomainManifest(status);

    const applyArgs = {
      runId,
      approvedSourceHash: status.sourceHash,
      baseCommit: status.editPlan.baseCommit,
      diffPlanHash: status.editPlan.diffPlanHash,
      domainMutationHash: status.editPlan.domainMutationHash,
      approvalIntent: "apply",
      expectedPrimaryDirtyState: "clean",
    };
    await assert.rejects(tools.workflow_apply.execute(applyArgs, context), /missing-issue|not found|close readback/i);
    assert.equal(await fs.readFile(path.join(context.directory, "finalization-failed.txt"), "utf8"), "patch applied\n");
    const failedStatus = JSON.parse(await tools.workflow_status.execute({ runId, format: "json", detail: "full" }, context));
    assert.equal(failedStatus.status, "apply-failed");
    assert.match(failedStatus.errorSummary, /Domain finalization failed after apply/);

    await assert.rejects(tools.workflow_apply.execute({ ...applyArgs, diffPlanHash: "0".repeat(64) }, context), /diffPlanHash mismatch/);
    const rejectedStatus = JSON.parse(await tools.workflow_status.execute({ runId, format: "json", detail: "full" }, context));
    assert.equal(rejectedStatus.status, "apply-failed");
    assert.match(rejectedStatus.errorSummary, /Domain finalization failed after apply/);

    await assert.rejects(tools.workflow_apply.execute(applyArgs, context), /missing-issue|not found|close readback/i);
    const retriedStatus = JSON.parse(await tools.workflow_status.execute({ runId, format: "json", detail: "full" }, context));
    assert.equal(retriedStatus.status, "apply-failed");
    assert.doesNotMatch(retriedStatus.errorSummary, /dirty/i);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("workflow_apply recovers a crash between completed-ledger and applied state write", async () => {
  const store = makeFixtureDomainStore();
  const issueId = "fixture-1";
  store.known.add(issueId);
  const { tools, context, directory } = await makeHarness(async () => ({
    data: {
      parts: [{ type: "text", text: JSON.stringify({ patches: [{ path: "crash-recovered.txt", content: "applied\n" }] }) }],
      info: {
        structured: { patches: [{ path: "crash-recovered.txt", content: "applied\n" }] },
        tokens: { input: 1, output: 1, reasoning: 0 },
        cost: 0,
      },
    },
  }), { pluginContext: { __workflowDomainMutationHandlers: store.handlers } });
  try {
    await initGitRepo(directory);
    const source = `export const meta = { name: "apply-crash-recovery", authority: { edit: true }, maxAgents: 1 };
return await agent("edit", { edit: true, schema: { type: "object", properties: { patches: { type: "array" } }, required: ["patches"] } });`;

    const output = await runApproved(tools, context, source);
    const runId = runIdFrom(output);
    const status = JSON.parse(await tools.workflow_status.execute({ runId, format: "json", detail: "full" }, context));
    await stageDomainMutation({ id: runId, dir: status.dir }, {
      mutationKey: `note:${issueId}:crash-recovery`,
      operation: "fixture.append-notes",
      payload: { issueId, note: "finalized during crash recovery" },
    });
    await refreshDomainManifest(status);

    // Simulate a crash in the window between the completed-ledger append and the
    // state.json=applied write: the patch was written to the primary tree, the apply ledger
    // reached "completed", but state.json is still apply-running -> reconcile rewrites it to
    // interrupted, and the domain mutation was never finalized.
    const planHash = status.editPlan.diffPlanHash;
    await fs.writeFile(path.join(directory, "crash-recovered.txt"), "applied\n", "utf8");
    await appendLedger(status.dir, "apply-ledger.jsonl", { phase: "started", diffPlanHash: planHash, patchCount: 1 });
    await appendLedger(status.dir, "apply-ledger.jsonl", { phase: "before-write", diffPlanHash: planHash, path: "crash-recovered.txt" });
    await appendLedger(status.dir, "apply-ledger.jsonl", { phase: "after-write", diffPlanHash: planHash, path: "crash-recovered.txt" });
    await appendLedger(status.dir, "apply-ledger.jsonl", { phase: "completed", diffPlanHash: planHash });
    const crashedState = JSON.parse(await fs.readFile(path.join(status.dir, "state.json"), "utf8"));
    crashedState.status = "interrupted";
    crashedState.error = "Workflow was active when no owning OpenCode process was found";
    await writeJsonAtomic(path.join(status.dir, "state.json"), crashedState);

    const interruptedStatus = JSON.parse(await tools.workflow_status.execute({ runId, format: "json", detail: "full" }, context));
    assert.equal(interruptedStatus.status, "interrupted");

    const applyArgs = {
      runId,
      approvedSourceHash: status.sourceHash,
      baseCommit: status.editPlan.baseCommit,
      diffPlanHash: status.editPlan.diffPlanHash,
      domainMutationHash: status.editPlan.domainMutationHash,
      approvalIntent: "apply",
      expectedPrimaryDirtyState: "clean",
    };

    const recovered = await tools.workflow_apply.execute(applyArgs, context);
    assert.match(recovered, /already applied; finalized 1 domain mutations/);
    const recoveredStatus = JSON.parse(await tools.workflow_status.execute({ runId, format: "json", detail: "full" }, context));
    assert.equal(recoveredStatus.status, "applied");
    assert.match(store.noteText(issueId), /finalized during crash recovery/);

    // Idempotent: a second apply on the now-applied run does not re-finalize or error.
    const reRecovered = await tools.workflow_apply.execute(applyArgs, context);
    assert.match(reRecovered, /already applied/);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("workflow_apply recovery refuses domain finalization when applied patch content drifted", async () => {
  const store = makeFixtureDomainStore();
  const issueId = "fixture-1";
  store.known.add(issueId);
  const { tools, context, directory } = await makeHarness(async () => ({
    data: {
      parts: [{ type: "text", text: JSON.stringify({ patches: [{ path: "drifted-after-apply.txt", content: "approved\n" }] }) }],
      info: {
        structured: { patches: [{ path: "drifted-after-apply.txt", content: "approved\n" }] },
        tokens: { input: 1, output: 1, reasoning: 0 },
        cost: 0,
      },
    },
  }), { pluginContext: { __workflowDomainMutationHandlers: store.handlers } });
  try {
    await initGitRepo(directory);
    const source = `export const meta = { name: "apply-crash-drift", authority: { edit: true }, maxAgents: 1 };
return await agent("edit", { edit: true, schema: { type: "object", properties: { patches: { type: "array" } }, required: ["patches"] } });`;

    const output = await runApproved(tools, context, source);
    const runId = runIdFrom(output);
    const status = JSON.parse(await tools.workflow_status.execute({ runId, format: "json", detail: "full" }, context));
    await stageDomainMutation({ id: runId, dir: status.dir }, {
      mutationKey: `note:${issueId}:drift-recovery`,
      operation: "fixture.append-notes",
      payload: { issueId, note: "must not finalize drifted tree" },
    });
    await refreshDomainManifest(status);

    const planHash = status.editPlan.diffPlanHash;
    await fs.writeFile(path.join(directory, "drifted-after-apply.txt"), "tampered\n", "utf8");
    await appendLedger(status.dir, "apply-ledger.jsonl", { phase: "started", diffPlanHash: planHash, patchCount: 1 });
    await appendLedger(status.dir, "apply-ledger.jsonl", { phase: "before-write", diffPlanHash: planHash, path: "drifted-after-apply.txt" });
    await appendLedger(status.dir, "apply-ledger.jsonl", { phase: "after-write", diffPlanHash: planHash, path: "drifted-after-apply.txt" });
    await appendLedger(status.dir, "apply-ledger.jsonl", { phase: "completed", diffPlanHash: planHash });
    const crashedState = JSON.parse(await fs.readFile(path.join(status.dir, "state.json"), "utf8"));
    crashedState.status = "interrupted";
    crashedState.error = "Workflow was active when no owning OpenCode process was found";
    await writeJsonAtomic(path.join(status.dir, "state.json"), crashedState);

    await assert.rejects(tools.workflow_apply.execute({
      runId,
      approvedSourceHash: status.sourceHash,
      baseCommit: status.editPlan.baseCommit,
      diffPlanHash: status.editPlan.diffPlanHash,
      domainMutationHash: status.editPlan.domainMutationHash,
      approvalIntent: "apply",
      expectedPrimaryDirtyState: "clean",
    }, context), /Applied patch content no longer matches approved diff plan/);

    const failedStatus = JSON.parse(await tools.workflow_status.execute({ runId, format: "json", detail: "full" }, context));
    assert.equal(failedStatus.status, "apply-failed");
    assert.match(failedStatus.errorSummary, /Applied patch content no longer matches/);
    assert.doesNotMatch(store.noteText(issueId), /must not finalize drifted tree/);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("workflow_apply rejects an interrupted run with no matching completed ledger record", async () => {
  const { tools, context, directory } = await makeHarness(async () => ({
    data: {
      parts: [{ type: "text", text: JSON.stringify({ patches: [{ path: "no-completed.txt", content: "applied\n" }] }) }],
      info: {
        structured: { patches: [{ path: "no-completed.txt", content: "applied\n" }] },
        tokens: { input: 1, output: 1, reasoning: 0 },
        cost: 0,
      },
    },
  }));
  try {
    await initGitRepo(directory);
    const source = `export const meta = { name: "apply-no-completed", authority: { edit: true }, maxAgents: 1 };
return await agent("edit", { edit: true, schema: { type: "object", properties: { patches: { type: "array" } }, required: ["patches"] } });`;

    const output = await runApproved(tools, context, source);
    const runId = runIdFrom(output);
    const status = JSON.parse(await tools.workflow_status.execute({ runId, format: "json", detail: "full" }, context));

    // A crash before the patch writes completed: the apply ledger never reached "completed",
    // so finalizing idempotently is unsafe. Only a "started" record exists.
    await appendLedger(status.dir, "apply-ledger.jsonl", { phase: "started", diffPlanHash: status.editPlan.diffPlanHash, patchCount: 1 });
    const crashedState = JSON.parse(await fs.readFile(path.join(status.dir, "state.json"), "utf8"));
    crashedState.status = "interrupted";
    await writeJsonAtomic(path.join(status.dir, "state.json"), crashedState);

    await assert.rejects(tools.workflow_apply.execute({
      runId,
      approvedSourceHash: status.sourceHash,
      baseCommit: status.editPlan.baseCommit,
      diffPlanHash: status.editPlan.diffPlanHash,
      domainMutationHash: status.editPlan.domainMutationHash,
      approvalIntent: "apply",
      expectedPrimaryDirtyState: "clean",
    }, context), /is not awaiting diff approval; status=interrupted/);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("normalizePatches rejects unsupported (non-replace) patch modes (R17)", () => {
  // Regression for R17: a patch carrying mode:"append" used to be normalized and
  // committed to computeDiffPlanHash, then silently full-replaced at apply because
  // every apply site does an unconditional whole-file write. The schema must now
  // reject any non-replace mode instead of approving a plan it cannot honor.
  assert.throws(
    () => normalizePatches({ patches: [{ path: "log.txt", content: "more\n", mode: "append" }] }),
    /Unsupported edit patch mode for log\.txt: append/,
  );
  assert.throws(
    () => normalizePatches([{ path: "log.txt", content: "more\n", mode: "prepend" }]),
    /Unsupported edit patch mode/,
  );

  // A bare patch and an explicit mode:"replace" are both accepted, and the
  // (now-constant) mode field is no longer carried into the patch object, so it
  // can no longer be silently committed to computeDiffPlanHash while ignored at
  // apply. The diff-plan hash for both forms must therefore match.
  const fromBare = normalizePatches([{ path: "a.txt", content: "x" }]);
  const fromReplace = normalizePatches([{ path: "a.txt", content: "x", mode: "replace" }]);
  assert.deepEqual(fromBare, [{ path: "a.txt", content: "x" }]);
  assert.deepEqual(fromReplace, [{ path: "a.txt", content: "x" }]);
  assert.equal(
    computeDiffPlanHash({ patches: fromBare }),
    computeDiffPlanHash({ patches: fromReplace }),
  );
});

test("stableStringify mirrors JSON.stringify for undefined so in-memory and file-recomputed diffPlanHash match (R29)", async () => {
  // Regression for R29: a no-worktree-lane patch carries worktreePath:undefined.
  // writeJsonAtomic (JSON.stringify) drops undefined-valued keys, but stableStringify
  // used to serialize the key with an "[undefined]" sentinel — so the in-memory hash
  // and the hash recomputed from the persisted file diverged, producing a spurious
  // fail-closed diffPlanHash mismatch on manual apply.
  const plan = {
    patches: [{ path: "a.txt", content: "x", callId: "agent:0", worktreePath: undefined }],
    sourceHash: "abc",
    baseCommit: undefined,
    domainMutationHash: undefined,
  };
  const inMemory = computeDiffPlanHash(plan);

  const directory = await tempDir();
  try {
    const file = path.join(directory, "diff-plan.json");
    await writeJsonAtomic(file, plan);
    const fromFile = JSON.parse(await fs.readFile(file, "utf8"));
    assert.equal(
      computeDiffPlanHash(fromFile),
      inMemory,
      "file-recomputed diffPlanHash must match the in-memory hash for an undefined worktreePath",
    );
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }

  // The undefined key must mirror JSON.stringify exactly: object keys are dropped, not
  // sentinel-serialized, so an absent worktreePath hashes identically to undefined.
  assert.equal(
    inMemory,
    computeDiffPlanHash({
      patches: [{ path: "a.txt", content: "x", callId: "agent:0" }],
      sourceHash: "abc",
    }),
    "an absent and an undefined worktreePath key must hash identically",
  );
  // A real worktreePath must still change the hash — the fix must not collapse distinct plans.
  assert.notEqual(
    inMemory,
    computeDiffPlanHash({
      patches: [{ path: "a.txt", content: "x", callId: "agent:0", worktreePath: "/wt/lane" }],
      sourceHash: "abc",
    }),
    "a present worktreePath must produce a distinct diffPlanHash",
  );
  // Array undefined elements must coerce to null, matching JSON.stringify of an array.
  assert.equal(stableStringify([1, undefined, 3]), "[1,null,3]");
});

test("workflow_apply rejects symlink ancestor patch targets before writing", async () => {
  const escapeRoot = await tempDir();
  const { tools, context, directory } = await makeHarness(async () => ({
    data: {
      parts: [{ type: "text", text: JSON.stringify({ patches: [{ path: "link/newdir/file.txt", content: "escape\n" }] }) }],
      info: {
        structured: { patches: [{ path: "link/newdir/file.txt", content: "escape\n" }] },
        tokens: { input: 1, output: 1, reasoning: 0 },
        cost: 0,
      },
    },
  }));
  try {
    await initGitRepo(directory);
    await fs.symlink(escapeRoot, path.join(directory, "link"), "dir");
    await execFileAsync("git", ["add", "link"], { cwd: directory });
    await execFileAsync("git", ["commit", "-m", "add symlink"], { cwd: directory });
    const source = `export const meta = { name: "symlink-apply", authority: { edit: true }, maxAgents: 1 };
return await agent("edit", { edit: true, schema: { type: "object" } });`;

    const output = await runApproved(tools, context, source);
    const runId = runIdFrom(output);
    const status = JSON.parse(await tools.workflow_status.execute({ runId, format: "json", detail: "full" }, context));

    await assert.rejects(tools.workflow_apply.execute({
      runId,
      approvedSourceHash: status.sourceHash,
      baseCommit: status.editPlan.baseCommit,
      diffPlanHash: status.editPlan.diffPlanHash,
      domainMutationHash: status.editPlan.domainMutationHash,
      approvalIntent: "apply",
      expectedPrimaryDirtyState: "clean",
    }, context), /Patch ancestor is a symlink: link\/newdir\/file\.txt/);
    assert.equal(await fileExists(path.join(escapeRoot, "newdir", "file.txt")), false);
    const after = JSON.parse(await tools.workflow_status.execute({ runId, format: "json" }, context));
    assert.equal(after.status, "apply-failed");
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
    await fs.rm(escapeRoot, { recursive: true, force: true });
  }
});

test("rollbackPatches returns rollback failures instead of swallowing them", async () => {
  const directory = await tempDir();
  const escapeRoot = await tempDir();
  try {
    const target = path.join(directory, "restore.txt");
    const outside = path.join(escapeRoot, "outside.txt");
    await fs.writeFile(target, "patched\n", "utf8");
    await fs.writeFile(outside, "outside\n", "utf8");
    await fs.rm(target);
    await fs.symlink(outside, target);

    const failures = await rollbackPatches([
      { patch: { path: "restore.txt" }, target, existed: true, previousContent: "original\n" },
    ], directory);

    assert.equal(failures.length, 1);
    assert.equal(failures[0].path, "restore.txt");
    assert.match(failures[0].error, /symlink|ELOOP|refuses|outside/i);
    assert.equal(await fs.readFile(outside, "utf8"), "outside\n", "rollback must not follow the swapped symlink");
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
    await fs.rm(escapeRoot, { recursive: true, force: true });
  }
});

test("workflow_apply rejects control and secret-like patch targets", async () => {
  const controlSecretPatches = {
    patches: [
      { path: ".git/hooks/post-commit", content: "#!/bin/sh\n" },
      { path: ".env", content: "TOKEN=secret\n" },
    ],
  };
  const { tools, context, directory } = await makeHarness(async () => ({
    data: { parts: [{ type: "text", text: JSON.stringify(controlSecretPatches) }], info: { structured: controlSecretPatches } },
  }));
  try {
    await initGitRepo(directory);
    const source = `export const meta = { name: "protected-paths", authority: { edit: true }, maxAgents: 1 };
return await agent("edit", { edit: true, schema: { type: "object" } });`;
    const output = await runApproved(tools, context, source);
    const runId = runIdFrom(output);
    const status = JSON.parse(await tools.workflow_status.execute({ runId, format: "json", detail: "full" }, context));

    await assert.rejects(tools.workflow_apply.execute({
      runId,
      approvedSourceHash: status.sourceHash,
      baseCommit: status.editPlan.baseCommit,
      diffPlanHash: status.editPlan.diffPlanHash,
      domainMutationHash: status.editPlan.domainMutationHash,
      approvalIntent: "apply",
      expectedPrimaryDirtyState: "clean",
    }, context), /protected \(control-path\)|protected \(secret-path\)/);
    assert.equal(await fileExists(path.join(directory, ".git", "hooks", "post-commit")), false);
    assert.equal(await fileExists(path.join(directory, ".env")), false);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("workflow_apply fails clearly when an active apply lock exists", async () => {
  const { tools, context, directory } = await makeHarness(async () => ({
    data: { parts: [{ type: "text", text: JSON.stringify({ patches: [{ path: "locked-apply.txt", content: "locked\n" }] }) }], info: { structured: { patches: [{ path: "locked-apply.txt", content: "locked\n" }] } } },
  }));
  try {
    await initGitRepo(directory);
    const source = `export const meta = { name: "locked-apply", authority: { edit: true }, maxAgents: 1 };
return await agent("edit", { edit: true, schema: { type: "object" } });`;
    const output = await runApproved(tools, context, source);
    const runId = runIdFrom(output);
    const status = JSON.parse(await tools.workflow_status.execute({ runId, format: "json", detail: "full" }, context));
    await writeJsonAtomic(path.join(status.dir, "apply.lock"), { operation: "apply", runId, process: { pid: process.pid } });

    await assert.rejects(tools.workflow_apply.execute({
      runId,
      approvedSourceHash: status.sourceHash,
      baseCommit: status.editPlan.baseCommit,
      diffPlanHash: status.editPlan.diffPlanHash,
      domainMutationHash: status.editPlan.domainMutationHash,
      approvalIntent: "apply",
      expectedPrimaryDirtyState: "clean",
    }, context), /Workflow apply lock is already held \(active\)/);
    assert.equal(await fileExists(path.join(directory, "locked-apply.txt")), false);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

// Regression guard (opencode-workflows-public-apply-lock-race). apply.lock serializes two
// concurrent applies, but it did NOT serialize apply-vs-active-run. A backgrounded run writes
// awaiting-diff-approval to state.json and only releases run.lock afterward in its finally block
// (runWorkflowExecution). Applying in that window races the owner's own writeState() in its
// finally, which would clobber apply-running/applied back to the pre-apply status (a lost update
// on state.json). The on-disk status alone is not proof of settlement, so workflow_apply now fails
// closed while run.lock is ACTIVELY held by a live owner. The foreground path releases run.lock
// before the caller can call apply, and interrupted/stale-active recovery has a dead owner, so
// only a LIVE owner blocks.
test("workflow_apply fails closed while an active run lock is held by the owning run", async () => {
  const { tools, context, directory } = await makeHarness(async () => ({
    data: {
      parts: [{ type: "text", text: JSON.stringify({ patches: [{ path: "active-run-lock.txt", content: "applied\n" }] }) }],
      info: {
        structured: { patches: [{ path: "active-run-lock.txt", content: "applied\n" }] },
        tokens: { input: 1, output: 1, reasoning: 0 },
        cost: 0,
      },
    },
  }));
  try {
    await initGitRepo(directory);
    const source = `export const meta = { name: "active-run-lock", authority: { edit: true }, maxAgents: 1 };
return await agent("edit", { edit: true, schema: { type: "object", properties: { patches: { type: "array" } }, required: ["patches"] } });`;

    const output = await runApproved(tools, context, source);
    const runId = runIdFrom(output);
    const status = JSON.parse(await tools.workflow_status.execute({ runId, format: "json", detail: "full" }, context));
    assert.equal(status.status, "awaiting-diff-approval");

    const applyArgs = {
      runId,
      approvedSourceHash: status.sourceHash,
      baseCommit: status.editPlan.baseCommit,
      diffPlanHash: status.editPlan.diffPlanHash,
      domainMutationHash: status.editPlan.domainMutationHash,
      approvalIntent: "apply",
      expectedPrimaryDirtyState: "clean",
    };

    // Simulate the owning background run still holding run.lock after it wrote
    // awaiting-diff-approval to state.json but before its finally released run.lock.
    const runLockPath = lockPathForRun(status.dir, "run");
    const releaseRunLock = await acquireWorkflowLock(runLockPath, { operation: "run", runId });
    try {
      await assert.rejects(tools.workflow_apply.execute(applyArgs, context), /active run lock|still holds an active run lock/);
      // The patch must NOT land while an active owner could still writeState over it.
      assert.equal(await fileExists(path.join(directory, "active-run-lock.txt")), false);
      const blockedStatus = JSON.parse(await tools.workflow_status.execute({ runId, format: "json", detail: "full" }, context));
      assert.equal(blockedStatus.status, "awaiting-diff-approval");
    } finally {
      await releaseRunLock();
    }

    // Once the owning run settles (releases run.lock), the same apply proceeds normally.
    const applied = await tools.workflow_apply.execute(applyArgs, context);
    assert.match(applied, /applied 1 patches/);
    assert.equal(await fs.readFile(path.join(directory, "active-run-lock.txt"), "utf8"), "applied\n");
    const finalStatus = JSON.parse(await tools.workflow_status.execute({ runId, format: "json", detail: "full" }, context));
    assert.equal(finalStatus.status, "applied");
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("workflow_apply hash mismatches return structured retry payloads and do not apply", async () => {
  const { tools, context, directory } = await makeHarness(async () => ({
    data: {
      parts: [{ type: "text", text: JSON.stringify({ patches: [{ path: "hash-mismatch.txt", content: "applied\n" }] }) }],
      info: {
        structured: { patches: [{ path: "hash-mismatch.txt", content: "applied\n" }] },
        tokens: { input: 1, output: 1, reasoning: 0 },
        cost: 0,
      },
    },
  }));
  try {
    await initGitRepo(directory);
    const source = `export const meta = { name: "hash-mismatch", authority: { edit: true }, maxAgents: 1 };
return await agent("edit", { edit: true, schema: { type: "object", properties: { patches: { type: "array" } }, required: ["patches"] } });`;

    const output = await runApproved(tools, context, source);
    const runId = runIdFrom(output);
    const status = JSON.parse(await tools.workflow_status.execute({ runId, format: "json", detail: "full" }, context));
    assert.equal(status.status, "awaiting-diff-approval");

    const applyArgs = {
      runId,
      approvedSourceHash: status.sourceHash,
      baseCommit: status.editPlan.baseCommit,
      diffPlanHash: status.editPlan.diffPlanHash,
      domainMutationHash: status.editPlan.domainMutationHash,
      approvalIntent: "apply",
    };

    for (const [field, badValue, reason] of [
      ["approvedSourceHash", "bad-source-hash", "approved_source_hash_mismatch"],
      ["diffPlanHash", "bad-diff-plan-hash", "diff_plan_hash_mismatch"],
      ["baseCommit", "bad-base-commit", "base_commit_mismatch"],
      ["domainMutationHash", "bad-domain-mutation-hash", "domain_mutation_hash_mismatch"],
    ]) {
      const payload = await rejectJson(tools.workflow_apply.execute({ ...applyArgs, [field]: badValue }, context));
      assert.equal(payload.type, "workflow_apply_approval_mismatch");
      assert.equal(payload.status, "approval_mismatch");
      assert.equal(payload.executed, false);
      assert.equal(payload.reason, reason);
      assert.equal(payload.field, field);
      assert.equal(payload.supplied, badValue);
      assert.match(payload.freshStatusCommand, new RegExp(`workflow_status\\(\\{ runId: "${runId}"`));
      assert.equal(payload.freshApplyApproval.runId, runId);
      assert.equal(payload.freshApplyApproval.approvedSourceHash, status.sourceHash);
      assert.equal(await fileExists(path.join(directory, "hash-mismatch.txt")), false);
      const after = JSON.parse(await tools.workflow_status.execute({ runId, format: "json", detail: "full" }, context));
      assert.equal(after.status, "awaiting-diff-approval");
    }

    const applied = await tools.workflow_apply.execute(applyArgs, context);
    assert.match(applied, /applied 1 patches/);
    assert.equal(await fs.readFile(path.join(directory, "hash-mismatch.txt"), "utf8"), "applied\n");
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("validatePatchTargets distinguishes tracked and untracked existing patch targets", async () => {
  const directory = await tempDir();
  try {
    await initGitRepo(directory);

    const tracked = await validatePatchTargets(directory, [
      { path: "README.md", content: "updated\n" },
    ]);
    assert.equal(tracked.length, 1);
    assert.equal(tracked[0].existed, true);
    assert.equal(tracked[0].previousContent, "initial\n");

    await fs.writeFile(path.join(directory, "untracked.txt"), "local\n", "utf8");
    await assert.rejects(
      () => validatePatchTargets(directory, [{ path: "untracked.txt", content: "updated\n" }]),
      /Patch target exists but is untracked: untracked\.txt/,
    );

    const allowed = await validatePatchTargets(
      directory,
      [{ path: "untracked.txt", content: "updated\n" }],
      { requireTracked: false },
    );
    assert.equal(allowed[0].existed, true);
    assert.equal(allowed[0].previousContent, "local\n");
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("validatePatchTargets treats ENOENT during content read as not-existing", async (t) => {
  const directory = await tempDir();
  try {
    await initGitRepo(directory);
    await fs.writeFile(path.join(directory, "vanish.txt"), "gone\n", "utf8");
    await fs.writeFile(path.join(directory, "denied.txt"), "blocked\n", "utf8");
    const readFile = fs.readFile;
    t.mock.method(fs, "readFile", async (file, ...args) => {
      const name = path.basename(String(file));
      if (name === "vanish.txt") {
        const error = new Error("file vanished after lstat");
        error.code = "ENOENT";
        throw error;
      }
      if (name === "denied.txt") {
        const error = new Error("read denied after lstat");
        error.code = "EACCES";
        throw error;
      }
      return await readFile(file, ...args);
    });

    const planned = await validatePatchTargets(directory, [
      { path: "vanish.txt", content: "replacement\n" },
    ]);
    assert.equal(planned[0].existed, false);
    assert.equal(planned[0].previousContent, undefined);

    await assert.rejects(
      () => validatePatchTargets(directory, [{ path: "denied.txt", content: "replacement\n" }]),
      /read denied after lstat/,
    );
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("workflow_apply proceeds past a stale (dead-owner) run lock for interrupted recovery", async () => {
  // Complement to the active-lock guard: a stale run.lock has no live owner
  // (processAppearsAlive=false), so it must NOT block apply. This covers the
  // interrupted/stale-active recovery path where the owning process died before
  // releasing run.lock — apply must still reach the patch/finalization path.
  const { tools, context, directory } = await makeHarness(async () => ({
    data: {
      parts: [{ type: "text", text: JSON.stringify({ patches: [{ path: "stale-run-lock.txt", content: "applied\n" }] }) }],
      info: {
        structured: { patches: [{ path: "stale-run-lock.txt", content: "applied\n" }] },
        tokens: { input: 1, output: 1, reasoning: 0 },
        cost: 0,
      },
    },
  }));
  try {
    await initGitRepo(directory);
    const source = `export const meta = { name: "stale-run-lock", authority: { edit: true }, maxAgents: 1 };
return await agent("edit", { edit: true, schema: { type: "object", properties: { patches: { type: "array" } }, required: ["patches"] } });`;

    const output = await runApproved(tools, context, source);
    const runId = runIdFrom(output);
    const status = JSON.parse(await tools.workflow_status.execute({ runId, format: "json", detail: "full" }, context));

    // Write a run.lock owned by a PID that does not exist (dead owner => stale).
    await writeJsonAtomic(lockPathForRun(status.dir, "run"), {
      operation: "run",
      runId,
      acquiredAt: new Date().toISOString(),
      process: { pid: 999999, startTime: 1 },
    });

    const applied = await tools.workflow_apply.execute({
      runId,
      approvedSourceHash: status.sourceHash,
      baseCommit: status.editPlan.baseCommit,
      diffPlanHash: status.editPlan.diffPlanHash,
      domainMutationHash: status.editPlan.domainMutationHash,
      approvalIntent: "apply",
      expectedPrimaryDirtyState: "clean",
    }, context);
    assert.match(applied, /applied 1 patches/);
    assert.equal(await fs.readFile(path.join(directory, "stale-run-lock.txt"), "utf8"), "applied\n");
    const finalStatus = JSON.parse(await tools.workflow_status.execute({ runId, format: "json", detail: "full" }, context));
    assert.equal(finalStatus.status, "applied");
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

// --- tfil.4: single opaque applyBundle token ---

test("tfil.4 applyBundle encode/decode round-trips the four review-binding hashes", () => {
  const hashes = {
    approvedSourceHash: "a".repeat(64),
    baseCommit: "b".repeat(40),
    diffPlanHash: "c".repeat(64),
    domainMutationHash: "d".repeat(64),
  };
  const bundle = encodeApplyBundle(hashes);
  assert.ok(bundle.startsWith("wfapply1."), "bundle is version-prefixed");
  assert.deepEqual(decodeApplyBundle(bundle), hashes);
});

test("tfil.4 decodeApplyBundle rejects malformed bundles", () => {
  assert.throws(() => decodeApplyBundle("not-a-bundle"), /wfapply1/);
  assert.throws(() => decodeApplyBundle("wfapply1.!!!not-base64!!!"), /could not be decoded/);
});

test("tfil.4 workflow_status detail=full emits editPlan.applyBundle; workflow_apply accepts it (round-trip)", async () => {
  const directory = await tempDir();
  const issueId = "bundle-1";
  const store = makeFixtureDomainStore();
  store.known.add(issueId);
  const { tools, context } = await makeHarness(async () => ({
    data: {
      parts: [{ type: "text", text: JSON.stringify({ patches: [{ path: "applied.txt", content: "applied\n" }] }) }],
      info: {
        structured: { patches: [{ path: "applied.txt", content: "applied\n" }] },
        tokens: { input: 1, output: 1, reasoning: 0 },
        cost: 0,
      },
    },
  }), {
    directory,
    pluginContext: { __workflowDomainMutationHandlers: store.handlers },
  });
  try {
    await initGitRepo(directory);
    const source = `export const meta = { name: "apply-bundle", authority: { edit: true }, maxAgents: 1 };
return await agent("edit", { edit: true, schema: { type: "object", properties: { patches: { type: "array" } }, required: ["patches"] } });`;
    const output = await runApproved(tools, context, source);
    const runId = runIdFrom(output);
    const status = JSON.parse(await tools.workflow_status.execute({ runId, format: "json", detail: "full" }, context));
    // detail=full emits applyBundle while state.json and diff-plan.json are in sync (pre-staging).
    assert.ok(status.editPlan.applyBundle, "detail=full emits editPlan.applyBundle");
    assert.equal(status.editPlan.applyBundle.startsWith("wfapply1."), true);
    await stageDomainMutation({ id: runId, dir: status.dir }, {
      mutationKey: `note:${issueId}:bundle`, operation: "fixture.append-notes",
      payload: { issueId, note: "bundle finalized" },
    });
    await refreshDomainManifest(status);
    // Build the bundle from the in-memory refreshed status (refreshDomainManifest syncs the in-memory
    // editPlan hashes with diff-plan.json on disk; this is what the tool would emit if state.json
    // were rewritten too). Mirrors how the existing happy-path test passes explicit fields.
    const bundle = encodeApplyBundle({
      approvedSourceHash: status.sourceHash,
      baseCommit: status.editPlan.baseCommit,
      diffPlanHash: status.editPlan.diffPlanHash,
      domainMutationHash: status.editPlan.domainMutationHash,
    });
    const applied = await tools.workflow_apply.execute({
      runId, applyBundle: bundle, approvalIntent: "apply", expectedPrimaryDirtyState: "clean",
    }, context);
    assert.match(applied, /applied 1 patches and finalized 1 domain mutations/);
    assert.match(store.noteText(issueId), /bundle finalized/);
    const finalStatus = JSON.parse(await tools.workflow_status.execute({ runId, format: "json", detail: "full" }, context));
    assert.equal(finalStatus.status, "applied");
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("tfil.4 workflow_apply with a stale applyBundle reports mismatch (review-binding preserved)", async () => {
  const directory = await tempDir();
  const issueId = "bundle-stale";
  const store = makeFixtureDomainStore();
  store.known.add(issueId);
  const { tools, context } = await makeHarness(async () => ({
    data: {
      parts: [{ type: "text", text: JSON.stringify({ patches: [{ path: "applied.txt", content: "applied\n" }] }) }],
      info: {
        structured: { patches: [{ path: "applied.txt", content: "applied\n" }] },
        tokens: { input: 1, output: 1, reasoning: 0 },
        cost: 0,
      },
    },
  }), {
    directory,
    pluginContext: { __workflowDomainMutationHandlers: store.handlers },
  });
  try {
    await initGitRepo(directory);
    const source = `export const meta = { name: "apply-bundle-stale", authority: { edit: true }, maxAgents: 1 };
return await agent("edit", { edit: true, schema: { type: "object", properties: { patches: { type: "array" } }, required: ["patches"] } });`;
    const output = await runApproved(tools, context, source);
    const runId = runIdFrom(output);
    const status = JSON.parse(await tools.workflow_status.execute({ runId, format: "json", detail: "full" }, context));
    // A bundle with a wrong approvedSourceHash: encode a bundle from good base/diff/domain but a bad source hash.
    const badBundle = encodeApplyBundle({
      approvedSourceHash: "0".repeat(64),
      baseCommit: status.editPlan.baseCommit,
      diffPlanHash: status.editPlan.diffPlanHash,
      domainMutationHash: status.editPlan.domainMutationHash,
    });
    await assert.rejects(tools.workflow_apply.execute({
      runId, applyBundle: badBundle, approvalIntent: "apply", expectedPrimaryDirtyState: "clean",
    }, context), /approvedSourceHash mismatch/);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

// --- tfil.5: collect-all mismatch reporting ---

async function rejectedMismatchJson(promise) {
  try {
    await promise;
  } catch (error) {
    return JSON.parse(error.message);
  }
  assert.fail("expected promise to reject with JSON error payload");
}

test("tfil.5 workflow_apply reports all drifted caller hashes at once (collect-all)", async () => {
  const directory = await tempDir();
  const { tools, context } = await makeHarness(async () => ({
    data: {
      parts: [{ type: "text", text: JSON.stringify({ patches: [{ path: "applied.txt", content: "applied\n" }] }) }],
      info: { structured: { patches: [{ path: "applied.txt", content: "applied\n" }] }, tokens: { input: 1, output: 1, reasoning: 0 }, cost: 0 },
    },
  }), { directory });
  try {
    await initGitRepo(directory);
    const source = `export const meta = { name: "collect-all", authority: { edit: true }, maxAgents: 1 };
return await agent("edit", { edit: true, schema: { type: "object", properties: { patches: { type: "array" } }, required: ["patches"] } });`;
    const output = await runApproved(tools, context, source);
    const runId = runIdFrom(output);
    const status = JSON.parse(await tools.workflow_status.execute({ runId, format: "json", detail: "full" }, context));
    // TWO drifted caller dimensions at once: bad sourceHash AND bad baseCommit.
    const payload = await rejectedMismatchJson(tools.workflow_apply.execute({
      runId,
      approvedSourceHash: "0".repeat(64),
      baseCommit: "1".repeat(40),
      diffPlanHash: status.editPlan.diffPlanHash,
      domainMutationHash: status.editPlan.domainMutationHash,
      approvalIntent: "apply",
      expectedPrimaryDirtyState: "clean",
    }, context));
    assert.equal(payload.type, "workflow_apply_approval_mismatch");
    assert.equal(payload.reason, "approved_source_hash_mismatch", "primary reason is the first/worst dimension");
    const fields = payload.allMismatches.map((m) => m.field);
    assert.ok(fields.includes("approvedSourceHash"), "approvedSourceHash drift collected");
    assert.ok(fields.includes("baseCommit"), "baseCommit drift collected");
    assert.ok(payload.allMismatches.length >= 2, "multiple dimensions reported at once");
    assert.ok(payload.freshApplyApproval.applyBundle, "fresh applyBundle included for one-round-trip retry");
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("tfil.5 collect-all includes the server-derived staged-domain mutation drift", async () => {
  const directory = await tempDir();
  const issueId = "collect-domain";
  const store = makeFixtureDomainStore();
  store.known.add(issueId);
  const { tools, context } = await makeHarness(async () => ({
    data: {
      parts: [{ type: "text", text: JSON.stringify({ patches: [{ path: "applied.txt", content: "applied\n" }] }) }],
      info: { structured: { patches: [{ path: "applied.txt", content: "applied\n" }] }, tokens: { input: 1, output: 1, reasoning: 0 }, cost: 0 },
    },
  }), { directory, pluginContext: { __workflowDomainMutationHandlers: store.handlers } });
  try {
    await initGitRepo(directory);
    const source = `export const meta = { name: "collect-domain", authority: { edit: true }, maxAgents: 1 };
return await agent("edit", { edit: true, schema: { type: "object", properties: { patches: { type: "array" } }, required: ["patches"] } });`;
    const output = await runApproved(tools, context, source);
    const runId = runIdFrom(output);
    const status = JSON.parse(await tools.workflow_status.execute({ runId, format: "json", detail: "full" }, context));
    // Stage a domain mutation AFTER diff approval WITHOUT refreshing the caller's hashes, so the
    // server-derived staged-domain drift is the (sole) mismatch dimension.
    await stageDomainMutation({ id: runId, dir: status.dir }, {
      mutationKey: `note:${issueId}:drift`, operation: "fixture.append-notes",
      payload: { issueId, note: "drifted" },
    });
    const payload = await rejectedMismatchJson(tools.workflow_apply.execute({
      runId,
      approvedSourceHash: status.sourceHash,
      baseCommit: status.editPlan.baseCommit,
      diffPlanHash: status.editPlan.diffPlanHash,
      domainMutationHash: status.editPlan.domainMutationHash,
      approvalIntent: "apply",
      expectedPrimaryDirtyState: "clean",
    }, context));
    const reasons = payload.allMismatches.map((m) => m.reason);
    assert.ok(reasons.includes("staged_domain_mutations_changed"), "server-derived staged drift collected");
    assert.ok(payload.allMismatches.every((m) => m.field === "domainMutationHash"), "drift is on the domain-mutation dimension");
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
