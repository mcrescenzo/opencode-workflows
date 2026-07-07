import test from "node:test";
import assert from "node:assert/strict";

import {
  createWorkflowToastPolicyState,
  evaluateWorkflowHeartbeatPolicy,
  evaluateWorkflowToastEventPolicy,
  evaluateWorkflowToastTickPolicy,
} from "../workflow-kernel/notification-toast-policy.js";

function snapshot(overrides = {}) {
  return {
    id: "wf_x1",
    name: "repo-bughunt",
    phase: { name: "Verify", label: "Verify (2/3)" },
    activeAgents: 3,
    queuedAgents: 5,
    activeLanes: [],
    done: 14,
    budgetPercent: undefined,
    staleness: { stale: false, ageMs: 0 },
    ...overrides,
  };
}

test("heartbeat policy preserves signature dedup and force refresh", () => {
  const state = createWorkflowToastPolicyState();
  assert.throws(() => evaluateWorkflowHeartbeatPolicy(state, snapshot(), { signature: "a" }), /requires an injected numeric now/);

  assert.deepEqual(evaluateWorkflowHeartbeatPolicy(state, snapshot(), { now: 0, signature: "a", forceMs: 75_000 }), {
    card: "heartbeat",
    snapshot: snapshot(),
  });
  assert.equal(evaluateWorkflowHeartbeatPolicy(state, snapshot(), { now: 10_000, signature: "a", forceMs: 75_000 }), null);
  assert.equal(evaluateWorkflowHeartbeatPolicy(state, snapshot(), { now: 20_000, signature: "b", forceMs: 75_000 })?.card, "heartbeat");
  assert.equal(evaluateWorkflowHeartbeatPolicy(state, snapshot(), { now: 95_001, signature: "b", forceMs: 75_000 })?.card, "heartbeat");
});

test("failure policy cools down and batches failure storms", () => {
  const state = createWorkflowToastPolicyState();
  const snap = snapshot();
  const first = evaluateWorkflowToastEventPolicy(state, { type: "agent.failure", callId: "lane:a", error: "timeout" }, snap, { now: 1_000, problemCooldownMs: 30_000 });
  assert.equal(first.length, 1);
  assert.equal(first[0].problem.count, 1);

  assert.deepEqual(evaluateWorkflowToastEventPolicy(state, { type: "agent.failure", callId: "lane:b", error: "timeout" }, snap, { now: 2_000, problemCooldownMs: 30_000 }), []);
  assert.deepEqual(evaluateWorkflowToastEventPolicy(state, { type: "agent.timeout", callId: "lane:c", error: "timeout" }, snap, { now: 3_000, problemCooldownMs: 30_000 }), []);

  const tick = evaluateWorkflowToastTickPolicy(state, snap, { now: 32_000, signature: "same", problemCooldownMs: 30_000 });
  assert.equal(tick[0].card, "problem");
  assert.equal(tick[0].problem.count, 2);
  assert.equal(tick[0].problem.label, "2 lanes failed in Verify");
});

test("budget thresholds emit once per threshold per run", () => {
  const state = createWorkflowToastPolicyState();
  const warn = evaluateWorkflowToastTickPolicy(state, snapshot({ budgetPercent: 81 }), { now: 0, signature: "a" });
  assert.equal(warn[0].problem.kind, "budget-80");
  assert.deepEqual(evaluateWorkflowToastTickPolicy(state, snapshot({ budgetPercent: 90 }), { now: 1_000, signature: "a" }), []);
  const error = evaluateWorkflowToastTickPolicy(state, snapshot({ budgetPercent: 101 }), { now: 2_000, signature: "a" });
  assert.equal(error[0].problem.kind, "budget-100");
  assert.equal(error[0].problem.variant, "error");
});

test("stall trigger emits problem cards on cooldown", () => {
  const state = createWorkflowToastPolicyState();
  const stalled = snapshot({
    staleness: { stale: true, ageMs: 700_000 },
    activeLanes: [{ idle: true }, { idle: false }],
  });
  const first = evaluateWorkflowToastTickPolicy(state, stalled, { now: 0, signature: "stalled", problemCooldownMs: 30_000 });
  assert.equal(first[0].problem.kind, "stall");
  assert.equal(first[0].problem.idleLaneCount, 1);
  assert.deepEqual(evaluateWorkflowToastTickPolicy(state, stalled, { now: 10_000, signature: "stalled", problemCooldownMs: 30_000 }), []);
  assert.equal(evaluateWorkflowToastTickPolicy(state, stalled, { now: 31_000, signature: "stalled", problemCooldownMs: 30_000 })[0].problem.kind, "stall");
});

test("events below policy do not emit unless heartbeat phase change applies", () => {
  const state = createWorkflowToastPolicyState();
  assert.deepEqual(evaluateWorkflowToastEventPolicy(state, { type: "agent.started" }, snapshot(), { now: 0, signature: "a" }), []);
  const phase = evaluateWorkflowToastEventPolicy(state, { type: "phase" }, snapshot(), { now: 1_000, signature: "a" });
  assert.equal(phase.at(-1).card, "heartbeat");
});
