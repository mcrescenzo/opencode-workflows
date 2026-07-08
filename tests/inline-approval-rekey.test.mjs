import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";

import { makeHarness } from "./helpers/harness.mjs";

// Regression suite for the 2026-07-08 bug report: "inline-source workflow_run approvals kept
// re-keying between two hashes and couldn't lock; running by name worked immediately."
// Root cause: the stateless approve call must re-send the inline source byte-identically; any
// re-emission drift re-keys sourceHash -> approvalHash, and each mismatch advertises the hash of
// the just-sent variant, so two alternating emissions bounce between exactly two hashes.

const SOURCE = `export const meta = { name: "rekey-repro", profile: "read-only-review", maxAgents: 0 };
return 1;`;

function approvalHashFromJsonPreview(previewOutput) {
  const parsed = JSON.parse(previewOutput);
  assert.equal(parsed.type, "workflow_preview");
  assert.equal(parsed.status, "approval_required");
  assert.match(parsed.approvalHash, /^[a-f0-9]{64}$/);
  return parsed.approvalHash;
}

function assertNotMismatch(result) {
  let parsed = null;
  try {
    parsed = JSON.parse(result);
  } catch {
    return; // prose output means real execution happened
  }
  assert.notEqual(parsed.type, "workflow_approval_mismatch", `unexpected mismatch: ${result}`);
}

test("byte-identical inline source across separately-constructed args hashes identically", async () => {
  const { tools, context, directory } = await makeHarness(async () => ({ data: { parts: [], info: {} } }));
  try {
    const baseArgs = { source: SOURCE, format: "json" };
    const hash1 = approvalHashFromJsonPreview(await tools.workflow_run.execute(JSON.parse(JSON.stringify(baseArgs)), context));
    const hash2 = approvalHashFromJsonPreview(await tools.workflow_run.execute(JSON.parse(JSON.stringify(baseArgs)), context));
    assert.equal(hash1, hash2);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("approve:true with the matching hash and identical source executes", async () => {
  const { tools, context, directory } = await makeHarness(async () => ({ data: { parts: [], info: {} } }));
  try {
    const hash = approvalHashFromJsonPreview(await tools.workflow_run.execute({ source: SOURCE, format: "json" }, context));
    const result = await tools.workflow_run.execute({ source: SOURCE, format: "json", approve: true, approvalHash: hash }, context);
    assertNotMismatch(result);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("one-byte source drift between calls reproduces the two-hash oscillation", async () => {
  const { tools, context, directory } = await makeHarness(async () => ({ data: { parts: [], info: {} } }));
  try {
    const hashA = approvalHashFromJsonPreview(await tools.workflow_run.execute({ source: SOURCE, format: "json" }, context));

    // Drifted re-emission (trailing newline), supplying the hash the preview advertised.
    const mismatch1 = JSON.parse(await tools.workflow_run.execute(
      { source: `${SOURCE}\n`, format: "json", approve: true, approvalHash: hashA },
      context,
    ));
    assert.equal(mismatch1.type, "workflow_approval_mismatch");
    assert.equal(mismatch1.reason, "approval_hash_mismatch");
    assert.equal(mismatch1.executed, false);
    assert.equal(mismatch1.suppliedApprovalHash, hashA);
    const hashB = mismatch1.freshApprovalHash;
    assert.notEqual(hashB, hashA);

    // Retry with the advertised fresh hash but the ORIGINAL bytes: the bounce flips back to hashA.
    const mismatch2 = JSON.parse(await tools.workflow_run.execute(
      { source: SOURCE, format: "json", approve: true, approvalHash: hashB },
      context,
    ));
    assert.equal(mismatch2.type, "workflow_approval_mismatch");
    assert.equal(mismatch2.suppliedApprovalHash, hashB);
    assert.equal(mismatch2.freshApprovalHash, hashA);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
