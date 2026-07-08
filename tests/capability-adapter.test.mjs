import test from "node:test";
import assert from "node:assert/strict";

import { createCapabilityAdapter, readInstalledVersion } from "../workflow-kernel/capability-adapter.js";

// Design C (2026-07-07): capabilities are shape-only ({childSession, worktree, toast} as
// "available"/"unavailable") — there is no probe layer promoting them to a verified state.
// probeCancellationGate and the rest of the live-gate-probe surface were deleted with the
// probe subsystem; this file now only covers the surviving createCapabilityAdapter/
// readInstalledVersion exports.

test("capability probe reads a declared dep's version from the plugin's own install", () => {
  assert.match(readInstalledVersion("@opencode-ai/plugin"), /^\d+\.\d+\.\d+$/);
  assert.match(readInstalledVersion("@opencode-ai/sdk"), /^\d+\.\d+\.\d+$/); // direct declared dependency
  assert.equal(readInstalledVersion("definitely-not-installed-xyz"), "unavailable");
});

test("createCapabilityAdapter derives shape-only capabilities from the injected client surface", async () => {
  const adapter = await createCapabilityAdapter({
    client: {
      session: {
        async create() {},
        async prompt() {},
      },
      worktree: {
        async create() {},
        async remove() {},
      },
    },
  });

  assert.deepEqual(adapter.capabilities, {
    childSession: "available",
    worktree: "available",
    toast: "unavailable",
  });
  assert.equal(adapter.diagnostics.clientShape.sessionCreate, true);
  assert.equal(adapter.diagnostics.clientShape.worktreeCreate, true);
});

test("createCapabilityAdapter reports unavailable capabilities when the client surface is missing", async () => {
  const adapter = await createCapabilityAdapter({ client: {} });

  assert.deepEqual(adapter.capabilities, {
    childSession: "unavailable",
    worktree: "unavailable",
    toast: "unavailable",
  });
});

test("createCapabilityAdapter honors __workflowCapabilities forcing over the derived client shape", async () => {
  const adapter = await createCapabilityAdapter({
    client: {},
    __workflowCapabilities: { childSession: "available", worktree: "available", toast: "available" },
  });

  assert.deepEqual(adapter.capabilities, {
    childSession: "available",
    worktree: "available",
    toast: "available",
  });
});
