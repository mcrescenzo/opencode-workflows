import test from "node:test";
import assert from "node:assert/strict";

import WorkflowPlugin from "../workflow-kernel/index.js";

const { __test } = WorkflowPlugin;

function interruptedEntry(lastProgressAt) {
  return {
    kind: "valid",
    id: "run-ttl",
    status: "interrupted",
    dir: "/tmp/run-ttl",
    state: { id: "run-ttl", status: "interrupted", locks: {}, lastProgressAt },
  };
}

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-06-26T00:00:00.000Z");

test("interrupted run within the TTL stays protected from cleanup", () => {
  const fresh = interruptedEntry("2026-06-25T23:00:00.000Z"); // 1h old
  assert.equal(
    __test.cleanupProtectionReason(fresh, { now: NOW, interruptedTtlMs: 7 * DAY_MS }),
    "interrupted-recovery",
  );
});

test("interrupted run older than the TTL becomes reapable by cleanup", () => {
  const stale = interruptedEntry("2026-06-18T00:00:00.000Z"); // 8 days old
  assert.equal(
    __test.cleanupProtectionReason(stale, { now: NOW, interruptedTtlMs: 7 * DAY_MS }),
    undefined,
  );
});

test("interrupted run with an unparseable progress timestamp stays protected (conservative)", () => {
  const entry = interruptedEntry("not-a-real-timestamp");
  assert.equal(
    __test.cleanupProtectionReason(entry, { now: NOW, interruptedTtlMs: 1 }),
    "interrupted-recovery",
  );
});

test("interrupted run is protected by default (no TTL options) — backward compatible", () => {
  const entry = interruptedEntry("2026-06-25T23:00:00.000Z");
  assert.equal(__test.cleanupProtectionReason(entry, { now: NOW }), "interrupted-recovery");
});
