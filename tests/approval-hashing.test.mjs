import test from "node:test";
import assert from "node:assert/strict";

import {
  approvalEnvelope,
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
