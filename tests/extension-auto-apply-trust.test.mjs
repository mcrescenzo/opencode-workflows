import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

import WorkflowPlugin from "../workflow-kernel/workflow-plugin.js";
import { GLOBAL_WORKFLOW_DIR, BUNDLED_WORKFLOW_DIR } from "../workflow-kernel/constants.js";
import { createExtensionRegistry } from "../workflow-kernel/extension-registry.js";
import { projectWorkflowDir } from "../workflow-kernel/workflow-source.js";

const { isTrustedAutoApplySource, shouldAutoApplyDrain } = WorkflowPlugin.__test;

const EXT_BASE = "/ext/fixture-drain-ext";
const EXT_WF_DIR = path.join(EXT_BASE, "workflows");

function ctxWithDrainExtension() {
  const reg = createExtensionRegistry();
  reg.register(
    {
      id: "fixture-drain-ext",
      drainAdapters: {
        fake: { createAdapter: () => ({}), supportsAutoApply: true, mutationOperations: ["fake.close"] },
      },
      assetDirs: { workflows: "./workflows" },
    },
    { baseDir: EXT_BASE },
  );
  return { workflowExtensionRegistry: reg };
}

// ---- Stage 3 unit: isTrustedAutoApplySource trusts bundled + configured extension dirs only ----

test("extension workflow dir is a trusted auto-apply source when registered", () => {
  const ctx = ctxWithDrainExtension();
  assert.equal(isTrustedAutoApplySource(path.join(EXT_WF_DIR, "fixture-drain.js"), ctx), true);
});

test("bundled workflow dir remains a trusted auto-apply source", () => {
  const ctx = ctxWithDrainExtension();
  assert.equal(isTrustedAutoApplySource(path.join(BUNDLED_WORKFLOW_DIR, "fixture-drain.js"), ctx), true);
});

test("global and project shadows are NOT trusted auto-apply sources", () => {
  const ctx = ctxWithDrainExtension();
  assert.equal(isTrustedAutoApplySource(path.join(GLOBAL_WORKFLOW_DIR, "fixture-drain.js"), ctx), false);
  const projDir = projectWorkflowDir({ directory: "/some/project", worktree: "/some/project" });
  assert.equal(isTrustedAutoApplySource(path.join(projDir, "fixture-drain.js"), ctx), false);
});

test("an extension path is NOT trusted when no registry is present (defensive)", () => {
  assert.equal(isTrustedAutoApplySource(path.join(EXT_WF_DIR, "fixture-drain.js"), {}), false);
  assert.equal(isTrustedAutoApplySource(path.join(EXT_WF_DIR, "fixture-drain.js"), undefined), false);
});

// ---- Stage 3 integration: the full auto-apply gate trusts the extension dir, denies a global shadow ----

function drainRun(sourcePath) {
  return {
    meta: { harness: "drain", adapter: "fake" },
    authority: { profile: "drain-autonomous-local" },
    sourcePath,
  };
}

test("autonomous-local drain from the extension dir passes the auto-apply gate", () => {
  const ctx = ctxWithDrainExtension();
  assert.equal(shouldAutoApplyDrain(drainRun(path.join(EXT_WF_DIR, "fixture-drain.js")), ctx), true);
});

test("autonomous-local drain from a GLOBAL shadow does NOT pass the auto-apply gate", () => {
  const ctx = ctxWithDrainExtension();
  assert.equal(shouldAutoApplyDrain(drainRun(path.join(GLOBAL_WORKFLOW_DIR, "fixture-drain.js")), ctx), false);
});
