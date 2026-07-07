import test from "node:test";
import assert from "node:assert/strict";

import { probeCancellationGate } from "../workflow-kernel/capability-adapter.js";

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
  assert.deepEqual(abortInputs.map((input) => input.path.id), ["child-cancel", "child-cancel"]);
});

test("capability probe reads a declared dep's version from the plugin's own install", async () => {
  const { readInstalledVersion } = await import("../workflow-kernel/capability-adapter.js");
  assert.match(readInstalledVersion("@opencode-ai/plugin"), /^\d+\.\d+\.\d+$/);
  assert.match(readInstalledVersion("@opencode-ai/sdk"), /^\d+\.\d+\.\d+$/); // direct declared dependency
  assert.equal(readInstalledVersion("definitely-not-installed-xyz"), "unavailable");
});
