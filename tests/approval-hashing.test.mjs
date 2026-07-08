import test from "node:test";
import assert from "node:assert/strict";

import {
  approvalEnvelope,
  approvalEnvelopeDiff,
  approvalHash,
  approvalSnapshotList,
} from "../workflow-kernel/approval-hashing.js";

function approval(overrides = {}) {
  return {
    sourcePath: "<inline>",
    sourceHash: "source-hash",
    runtimeArgs: null,
    maxAgents: 1,
    concurrency: 1,
    defaultChildModel: "test/model",
    authority: { profile: "read-only-review", readOnly: true },
    budgetCeilings: {},
    baseCommit: null,
    guestDeadlineMs: 1000,
    background: false,
    resumeRunId: null,
    capabilities: {},
    nestedSnapshots: new Map(),
    ...overrides,
  };
}

test("approvalEnvelope defaults modelTiers to null when absent", () => {
  // Legacy approvals that predate the model-tiering plumbing carry no modelTiers
  // field; the envelope must normalize that to a deterministic null so the hash
  // is stable rather than depending on `undefined` serialization.
  assert.equal(approvalEnvelope(approval()).modelTiers, null);
});

test("approvalHash covers modelTiers", () => {
  const base = approval({ modelTiers: { fast: "p/fast", deep: "p/deep" } });
  const changedDeep = approval({ modelTiers: { fast: "p/fast", deep: "p/fast" } });
  const changedFast = approval({ modelTiers: { fast: "p/other", deep: "p/deep" } });

  assert.deepEqual(approvalEnvelope(base).modelTiers, { fast: "p/fast", deep: "p/deep" });
  // A changed model plan must re-trigger approval (different hash) on either tier.
  assert.notEqual(approvalHash(base), approvalHash(changedDeep));
  assert.notEqual(approvalHash(base), approvalHash(changedFast));
  // Adding an explicit modelTiers must differ from the legacy (null) envelope.
  assert.notEqual(approvalHash(base), approvalHash(approval()));
});

test("approvalSnapshotList sorts snapshots and keeps the last entry per sourcePath", () => {
  const snapshots = new Map([
    ["b", { sourcePath: "nested-b.js", sourceHash: "hash-b" }],
    ["a-old", { sourcePath: "nested-a.js", sourceHash: "hash-a-old" }],
    ["a-new", { sourcePath: "nested-a.js", sourceHash: "hash-a-new" }],
  ]);

  assert.deepEqual(approvalSnapshotList(snapshots), [
    { sourcePath: "nested-a.js", sourceHash: "hash-a-new" },
    { sourcePath: "nested-b.js", sourceHash: "hash-b" },
  ]);
});

test("approvalHash is independent of nested snapshot insertion order", () => {
  const left = new Map([
    ["one", { sourcePath: "nested-a.js", sourceHash: "hash-a" }],
    ["two", { sourcePath: "nested-b.js", sourceHash: "hash-b" }],
  ]);
  const right = new Map([
    ["two", { sourcePath: "nested-b.js", sourceHash: "hash-b" }],
    ["one", { sourcePath: "nested-a.js", sourceHash: "hash-a" }],
  ]);

  assert.equal(approvalHash(approval({ nestedSnapshots: left })), approvalHash(approval({ nestedSnapshots: right })));
});

test("approvalHash covers laneTimeoutMs", () => {
  const shortTimeout = approval({ laneTimeoutMs: 30_000 });
  const longTimeout = approval({ laneTimeoutMs: 60_000 });

  assert.equal(approvalEnvelope(shortTimeout).laneTimeoutMs, 30_000);
  assert.equal(approvalEnvelope(approval()).laneTimeoutMs, null);
  assert.notEqual(approvalHash(shortTimeout), approvalHash(longTimeout));
});

test("approvalSnapshotList keeps two distinct inline nested snapshots", () => {
  const snapshots = new Map([
    ["hash-a", { sourcePath: "<inline>", sourceHash: "hash-a", source: "return 1;" }],
    ["hash-b", { sourcePath: "<inline>", sourceHash: "hash-b", source: "return 2;" }],
  ]);
  assert.deepEqual(approvalSnapshotList(snapshots), [
    { sourcePath: "<inline>", sourceHash: "hash-a" },
    { sourcePath: "<inline>", sourceHash: "hash-b" },
  ]);
});

test("approvalSnapshotList still dedups path-backed snapshots stored under both path and hash keys", () => {
  const snapshot = { sourcePath: "/abs/nested.js", sourceHash: "hash-c", source: "return 3;" };
  const snapshots = new Map([["/abs/nested.js", snapshot], ["hash-c", snapshot]]);
  assert.deepEqual(approvalSnapshotList(snapshots), [{ sourcePath: "/abs/nested.js", sourceHash: "hash-c" }]);
});

test("approvalEnvelope pins version 3", () => {
  assert.equal(approvalEnvelope(approval()).version, 3);
});

test("approvalHash changes when only sourceHash changes", () => {
  assert.notEqual(
    approvalHash(approval({ sourceHash: "hash-a" })),
    approvalHash(approval({ sourceHash: "hash-b" })),
  );
});

test("approvalEnvelopeDiff names exactly the changed fields, sorted", () => {
  const before = approvalEnvelope(approval({ sourceHash: "hash-a" }));
  const after = approvalEnvelope(approval({ sourceHash: "hash-b", maxAgents: 2 }));
  const diff = approvalEnvelopeDiff(before, after);
  assert.deepEqual(diff.map((entry) => entry.field), ["maxAgents", "sourceHash"]);
  const sourceEntry = diff.find((entry) => entry.field === "sourceHash");
  assert.equal(sourceEntry.before, '"hash-a"');
  assert.equal(sourceEntry.after, '"hash-b"');
});

test("approvalEnvelopeDiff returns [] for identical envelopes", () => {
  const envelope = approvalEnvelope(approval());
  assert.deepEqual(approvalEnvelopeDiff(envelope, approvalEnvelope(approval())), []);
});
