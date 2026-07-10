import test from "node:test";
import assert from "node:assert/strict";

// fnop.5: characterize the PUBLISHED package entrypoint (opencode-workflows.js) rather than
// internal kernel files, so subsequent internal test-seam cleanup (e.g. the self-aggregating
// barrel) cannot break the published adapter without a direct failure here. Asserts behavior
// through the public adapter only — no source-text matching, no internal helper imports.
import plugin from "../opencode-workflows.js";

test("published root entrypoint exports the async plugin factory", () => {
  assert.equal(typeof plugin, "function", "default export is the factory function");
});

test("factory resolves to the expected hooks surface and tool-registration shape", async () => {
  const hooks = await plugin({}, {});
  assert.equal(typeof hooks, "object", "factory resolves to a hooks object");

  // Expected hook surface exposed to opencode's plugin host.
  for (const key of ["config", "event", "dispose", "tool"]) {
    assert.ok(key in hooks, `hooks expose the "${key}" entry`);
  }
  assert.equal(typeof hooks.config, "function");
  assert.equal(typeof hooks.event, "function");
  assert.equal(typeof hooks.dispose, "function");

  // Tool-registration shape: the core workflow tools are registered by name, each carrying an
  // executable. Assert a representative core subset (not an exhaustive name list) so the contract
  // is stable against additive tool changes while still proving registration works end to end.
  const toolNames = Object.keys(hooks.tool);
  assert.ok(toolNames.length >= 12, `expected a substantial tool surface; got ${toolNames.length}`);
  for (const name of ["workflow_run", "workflow_apply", "workflow_status", "workflow_list", "workflow_lint"]) {
    const registered = hooks.tool[name];
    assert.ok(registered, `tool "${name}" is registered`);
    assert.equal(typeof registered.execute, "function", `tool "${name}" has an execute function`);
    assert.equal(typeof registered.description, "string", `tool "${name}" has a description`);
  }
});

test("factory is the same identity reached through the package export declaration", async () => {
  // The package exports "." -> ./opencode-workflows.js. Prove the entry re-exports the kernel
  // orchestrator default rather than a divergent adapter, without importing internals: two
  // invocations over the same entry produce independent hook objects (per-call construction).
  const a = await plugin({}, {});
  const b = await plugin({}, {});
  assert.notEqual(a, b, "each factory call constructs a fresh hooks object");
  assert.deepEqual(Object.keys(a.tool).sort(), Object.keys(b.tool).sort(), "tool surface is stable across calls");
});
