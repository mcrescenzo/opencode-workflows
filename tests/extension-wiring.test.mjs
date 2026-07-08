import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import WorkflowPlugin from "../workflow-kernel/workflow-plugin.js";

// Integration: the factory receives per-plugin `options` (verified delivered by opencode 1.17.11),
// creates a per-pluginContext extension registry, and loads configured extension modules from disk.

test("WorkflowPlugin loads a configured extension and exposes it via pluginContext.workflowExtensionRegistry", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "wf-ext-"));
  const extPath = path.join(dir, "fake-extension.js");
  await writeFile(
    extPath,
    [
      "export default {",
      '  id: "fake",',
      "  drainAdapters: {",
      "    fake: { createAdapter: () => ({}), supportsAutoApply: true, mutationOperations: [\"fake.close\"] },",
      "  },",
      '  mutationHandlers: { "fake.close": () => ({ ok: true }) },',
      "};",
      "",
    ].join("\n"),
  );
  const pluginContext = { directory: dir, worktree: dir, client: {} };
  // Extensions load in the FACTORY BODY (so the static tool map can include extension tools);
  // the registry must be populated immediately after the factory resolves, BEFORE hooks.config.
  await WorkflowPlugin(pluginContext, { extensions: [extPath] });
  const reg = pluginContext.workflowExtensionRegistry;
  assert.ok(reg, "registry attached to pluginContext");
  assert.equal(reg.drainAdapter("fake").supportsAutoApply, true, "extension loaded before config hook");
  assert.equal(typeof reg.mutationHandler("fake.close"), "function");
  await rm(dir, { recursive: true, force: true });
});

test("WorkflowPlugin attaches an empty registry when no extensions are configured", async () => {
  const pluginContext = { directory: tmpdir(), worktree: tmpdir(), client: {} };
  const hooks = await WorkflowPlugin(pluginContext); // no options
  await hooks.config({});
  assert.ok(pluginContext.workflowExtensionRegistry, "registry present");
  assert.equal(pluginContext.workflowExtensionRegistry.drainAdapter("fake"), undefined);
});

test("WorkflowPlugin fails loud when a configured extension cannot load", async () => {
  const pluginContext = { directory: tmpdir(), worktree: tmpdir(), client: {} };
  // Loading moved into the factory body, so an unloadable extension rejects the FACTORY promise.
  await assert.rejects(
    WorkflowPlugin(pluginContext, { extensions: ["/nonexistent/ext-xyz.js"] }),
    /\/nonexistent\/ext-xyz\.js|failed to load/i,
  );
});
