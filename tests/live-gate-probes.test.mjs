import test from "node:test";
import assert from "node:assert/strict";

import {
  denialProbeResult,
  deterministicToolProbeResult,
  isDenialEvidence,
  probeBackgroundContinuationGate,
  probeConcurrencyCapacityGate,
  probeCancellationGate,
  probeWorktreeGate,
} from "../workflow-kernel/live-gate-probes.js";

// These tests import directly from the extracted live-gate-probes.js module (rather than
// through capability-adapter.js / the kernel barrel) to lock the module boundary created by
// opencode-workflows-ufu: the probe functions and their probe-only helpers must remain
// self-contained and behavior-preserving after the split.

test("isDenialEvidence recognizes permission-denial text", () => {
  assert.equal(isDenialEvidence("permission denied"), true);
  assert.equal(isDenialEvidence("not allowed to run bash"), true);
  assert.equal(isDenialEvidence("everything is fine"), false);
});

test("denialProbeResult verifies a denial-evidence error but fails an unrelated error", () => {
  const denied = denialProbeResult(new Error("bash permission denied"), "blocked-bash live probe");
  assert.equal(denied.state, "verified");
  assert.equal(denied.verified, true);

  const unrelated = denialProbeResult(new Error("kaboom"), "blocked-bash live probe");
  assert.equal(unrelated.state, "failed-with-evidence");
  assert.equal(unrelated.verified, false);
});

test("deterministicToolProbeResult verifies a denied tool part", () => {
  const gate = deterministicToolProbeResult({
    label: "blocked-bash live probe",
    toolNames: ["bash"],
    directAllowed: false,
    toolParts: [{ tool: "bash", state: { status: "error", error: "permission denied" } }],
  });
  assert.equal(gate.state, "verified");
  assert.equal(gate.verified, true);
});

test("deterministicToolProbeResult fails when a tool ran without denial evidence", () => {
  const gate = deterministicToolProbeResult({
    label: "blocked-bash live probe",
    toolNames: ["bash"],
    directAllowed: false,
    toolParts: [{ tool: "bash", state: { status: "completed", content: "/tmp" } }],
  });
  assert.equal(gate.state, "failed-with-evidence");
  assert.equal(gate.verified, false);
});

test("probeBackgroundContinuationGate verifies with weak in-process-smoke evidence", async () => {
  const gate = await probeBackgroundContinuationGate();
  assert.equal(gate.state, "verified");
  assert.equal(gate.verified, true);
  assert.equal(gate.evidenceStrength, "in-process-smoke");
});

test("probeConcurrencyCapacityGate verifies only after N prompts are in flight", async () => {
  const limit = 4;
  const calls = { create: [], prompt: [], abort: [] };
  let inFlight = 0;
  let maxInFlight = 0;
  let releaseBarrier;
  const barrier = new Promise((resolve) => {
    releaseBarrier = resolve;
  });
  const pluginContext = {
    __workflowLiveProbeTimeoutMs: 500,
    client: {
      session: {
        async create(input) {
          calls.create.push(input);
          return { data: { id: `child-${calls.create.length}` } };
        },
        async prompt(input) {
          calls.prompt.push(input);
          inFlight += 1;
          maxInFlight = Math.max(maxInFlight, inFlight);
          if (calls.prompt.length === limit) releaseBarrier();
          await barrier;
          inFlight -= 1;
          return { data: { parts: [{ type: "text", text: "ok" }], info: { tokens: { input: 0, output: 0, reasoning: 0 }, cost: 0 } } };
        },
        async abort(input) {
          calls.abort.push(input);
          return { data: { ok: true } };
        },
      },
    },
  };

  const gate = await probeConcurrencyCapacityGate(pluginContext, {
    directory: "/tmp/workflow-concurrency-probe",
    sessionID: "parent-session",
  }, { limit });

  assert.equal(gate.state, "verified");
  assert.equal(gate.verified, true);
  assert.match(gate.evidence, /completed 4\/4 concurrent session\.prompt calls/);
  assert.equal(calls.create.length, limit);
  assert.equal(calls.prompt.length, limit);
  assert.equal(maxInFlight, limit);
  assert.equal(calls.abort.length, limit);
});

test("probeConcurrencyCapacityGate fails closed when the burst times out", async () => {
  const limit = 3;
  const calls = { create: [], prompt: [], abort: [] };
  const pluginContext = {
    __workflowLiveProbeTimeoutMs: 20,
    client: {
      session: {
        async create(input) {
          calls.create.push(input);
          return { data: { id: `child-timeout-${calls.create.length}` } };
        },
        async prompt(input) {
          calls.prompt.push(input);
          return await new Promise(() => {});
        },
        async abort(input) {
          calls.abort.push(input);
          return { data: { ok: true } };
        },
      },
    },
  };

  const gate = await probeConcurrencyCapacityGate(pluginContext, {
    directory: "/tmp/workflow-concurrency-timeout",
    sessionID: "parent-session",
  }, { limit });

  assert.equal(gate.state, "failed-with-evidence");
  assert.equal(gate.verified, false);
  assert.match(gate.evidence, /probe timed out/);
  assert.equal(calls.create.length, limit);
  assert.equal(calls.prompt.length, limit);
  assert.ok(calls.abort.length >= limit);
});

test("probeCancellationGate best-effort aborts the child when the abort probe fails", async () => {
  const abortInputs = [];
  const pluginContext = {
    __workflowLiveProbeTimeoutMs: 100,
    client: {
      session: {
        async create() {
          return { data: { id: "child-cancel" } };
        },
        async abort(input) {
          abortInputs.push(input);
          if (abortInputs.length === 1) throw new Error("abort transport failed");
          return { data: { ok: true } };
        },
      },
    },
  };

  const gate = await probeCancellationGate(pluginContext, {
    directory: "/tmp/workflow-cancel-probe",
    sessionID: "parent-session",
  });

  assert.equal(gate.state, "failed-with-evidence");
  assert.match(gate.evidence, /abort transport failed/);
  assert.equal(abortInputs.length, 2, "failed abort probe must be followed by best-effort cleanup abort");
});

test("probeWorktreeGate fails closed when probe worktree cleanup fails", async () => {
  const adapter = {
    async hasWorktreeClient() { return true; },
    async createWorktree() { return { id: "probe-1", path: "/tmp/workflow-probe-leak" }; },
    async removeWorktree() { throw new Error("remove failed"); },
  };

  const gate = await probeWorktreeGate({ directory: "/repo" }, adapter);

  assert.equal(gate.state, "failed-with-evidence");
  assert.equal(gate.verified, false);
  assert.match(gate.evidence, /cleanup failed: remove failed/);
  assert.match(gate.evidence, /\/tmp\/workflow-probe-leak/);
});
