import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { resolveRole } from "../workflow-kernel/role-template-loading.js";
import { renderWorkflowTerminalCard, workflowToastCardSnapshot } from "../workflow-kernel/notification-toast-cards.js";
import { ajv, compileSchemaWithIdentity } from "../workflow-kernel/structured-output.js";

// Regression suite for three repo-bughunt findings (2026-07-08):
//   error-handling-4: resolveRole() leaked a raw fs ENOENT (with absolute path) instead of a
//     clear domain error when a role slug had no file on disk.
//   null-empty-7: phaseBreadcrumb() mislabeled a run whose current phase name is absent from
//     meta.phases by substituting `phases.length - 1` (the last declared phase) for the
//     "not found" index, instead of falling back to the bare phase name.
//   bad-state-13: compileSchemaWithIdentity() registered every $id-bearing schema into the
//     shared module-level ajv instance, but the bounded bookkeeping cache
//     (registeredSchemaIdHashes) never told ajv to forget an evicted id, so ajv's own registry
//     grew unbounded even though the wrapping cache claimed to be bounded.

test("resolveRole throws a clear domain error (not a raw ENOENT) for a role slug with no file", async () => {
  const roleDir = await fs.mkdtemp(path.join(os.tmpdir(), "wf-role-"));
  try {
    await assert.rejects(
      () => resolveRole("totally-made-up-role-name", roleDir),
      (error) => {
        assert.match(error.message, /Workflow role "totally-made-up-role-name" was not found/);
        assert.ok(
          error.message.includes(path.join(roleDir, "totally-made-up-role-name.md")),
          `expected the resolved path in the error message, got: ${error.message}`,
        );
        assert.notEqual(error.code, "ENOENT", "domain error must not carry the raw fs error code");
        assert.doesNotMatch(error.message, /ENOENT/, "raw ENOENT text must not leak into the domain error");
        return true;
      },
    );
  } finally {
    await fs.rm(roleDir, { recursive: true, force: true });
  }
});

test("resolveRole still resolves a real role file normally (no regression on the happy path)", async () => {
  const roleDir = await fs.mkdtemp(path.join(os.tmpdir(), "wf-role-"));
  try {
    const role = await resolveRole("explorer", roleDir);
    assert.equal(role.name, "explorer");
    assert.match(role.content, /Explore the assigned surface area/);
  } finally {
    await fs.rm(roleDir, { recursive: true, force: true });
  }
});

test("terminal card falls back to the bare phase name when the current phase isn't in meta.phases", () => {
  const run = {
    id: "wf_phase_drift",
    meta: { name: "fixture-phase-drift", phases: ["scan", "verify", "fix"] },
    // "cleanup" was never declared in meta.phases (typo, ad-hoc phase(), or capitalization
    // drift) -- phaseSnapshot() resolves this to index: undefined.
    currentPhase: "cleanup",
    status: "failed",
    startedAt: "2026-07-07T12:00:00Z",
    finishedAt: "2026-07-07T12:01:00Z",
  };
  const snapshot = workflowToastCardSnapshot(run, { now: Date.parse("2026-07-07T12:01:00Z") });
  assert.equal(snapshot.phase.index, undefined);

  const card = renderWorkflowTerminalCard(snapshot);
  const firstLine = card.message.split("\n")[0];
  // Must render just the phase name (mirroring the `!phases.length` early-return branch), never
  // guess "current == last declared phase" and mark scan/verify as falsely done.
  assert.equal(firstLine, "▸ cleanup");
});

test("terminal card still renders the normal done/failed breadcrumb when the phase IS declared", () => {
  const run = {
    id: "wf_phase_ok",
    meta: { name: "fixture-phase-ok", phases: ["scan", "verify", "fix"] },
    currentPhase: "verify",
    status: "failed",
    startedAt: "2026-07-07T12:00:00Z",
    finishedAt: "2026-07-07T12:01:00Z",
  };
  const snapshot = workflowToastCardSnapshot(run, { now: Date.parse("2026-07-07T12:01:00Z") });
  assert.equal(snapshot.phase.index, 1);

  const card = renderWorkflowTerminalCard(snapshot);
  const firstLine = card.message.split("\n")[0];
  assert.equal(firstLine, "✓ scan ✗ verify ⧗ fix");
});

test("compileSchemaWithIdentity evicts ajv's own registry in lockstep with the bounded id-hash cache", () => {
  // Mirrors VALIDATOR_HASH_CACHE_MAX (256) in structured-output.js, which bounds
  // registeredSchemaIdHashes. Not exported, so pinned here as a literal.
  const BOUND = 256;
  const prefix = "https://example.test/opencode-workflows/bughunt-bound/schema-";
  const total = BOUND + 40;

  for (let i = 0; i < total; i++) {
    compileSchemaWithIdentity({
      $id: `${prefix}${i}`,
      type: "object",
      properties: { i: { type: "integer" } },
      required: ["i"],
    });
  }

  // The earliest ids must be gone from ajv itself, not just forgotten by the bookkeeping map
  // while lingering in ajv's registry forever (the bug: eviction only touched our own Map).
  for (let i = 0; i < total - BOUND; i++) {
    assert.equal(ajv.getSchema(`${prefix}${i}`), undefined, `schema ${i} should have been evicted from ajv`);
  }
  // The most recently compiled BOUND ids remain resolvable.
  for (let i = total - BOUND; i < total; i++) {
    assert.ok(ajv.getSchema(`${prefix}${i}`), `schema ${i} should still be registered`);
  }

  const registeredForPrefix = Object.keys(ajv.refs).filter((key) => key.startsWith(prefix));
  assert.equal(
    registeredForPrefix.length,
    BOUND,
    "ajv's internal registry must stay bounded in lockstep with registeredSchemaIdHashes, not grow unboundedly",
  );
});
