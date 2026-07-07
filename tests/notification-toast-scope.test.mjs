import test from "node:test";
import assert from "node:assert/strict";

import {
  deriveScopeItemProgress,
  parseScopePath,
} from "../workflow-kernel/notification-toast-scope.js";

test("parseScopePath extracts pipeline item and stage from scoped call ids", () => {
  assert.deepEqual(parseScopePath("scope/pipeline:0/item:3/stage:1/agent:verify"), {
    containerPath: "scope/pipeline:0",
    itemIndex: 3,
    itemKey: "scope/pipeline:0/item:3",
    stageIndex: 1,
  });
  assert.equal(parseScopePath("legacy:fanout:0"), null);
});

test("deriveScopeItemProgress returns null for non-scoped legacy lanes", () => {
  assert.equal(deriveScopeItemProgress([
    { callId: "agent:one", status: "completed" },
    { callId: "fanout:two", status: "running" },
  ]), null);
});

test("deriveScopeItemProgress summarizes pipeline and nested parallel items", () => {
  const progress = deriveScopeItemProgress([
    { callId: "scope/pipeline:0/item:0/stage:0/agent:a", status: "completed" },
    { callId: "scope/pipeline:0/item:1/stage:0/agent:b", status: "completed" },
    { callId: "scope/pipeline:0/item:1/stage:1/agent:c", status: "completed" },
    { callId: "scope/pipeline:0/item:2/stage:1/agent:d", status: "running" },
    { callId: "scope/parallel:1/item:0/agent:e", outcome: "failure" },
  ]);

  assert.equal(progress.done, 2);
  assert.equal(progress.total, 4);
  assert.equal(progress.failed, 1);
  assert.equal(progress.currentStage, 2);
  assert.equal(progress.totalStages, 2);
  assert.deepEqual(progress.items.map((item) => item.key), [
    "scope/parallel:1/item:0",
    "scope/pipeline:0/item:0",
    "scope/pipeline:0/item:1",
    "scope/pipeline:0/item:2",
  ]);
});
