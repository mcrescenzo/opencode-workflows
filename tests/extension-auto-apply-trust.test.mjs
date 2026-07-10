import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

import WorkflowPlugin from "../workflow-kernel/workflow-plugin.js";
import { GLOBAL_WORKFLOW_DIR, BUNDLED_WORKFLOW_DIR } from "../workflow-kernel/constants.js";
import { createExtensionRegistry } from "../workflow-kernel/extension-registry.js";
import { projectWorkflowDir } from "../workflow-kernel/workflow-source.js";

const { isTrustedAutoApplySource, shouldAutoApplyDrain, applyGateClass } = WorkflowPlugin.__test;

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

// ---- fnop.4: preview consequence classification agrees with runtime eligibility ----

function ctxWithDisabledAdapter() {
  const reg = createExtensionRegistry();
  reg.register(
    {
      id: "fixture-drain-ext",
      drainAdapters: {
        fake: { createAdapter: () => ({}), supportsAutoApply: false, mutationOperations: ["fake.close"] },
      },
      assetDirs: { workflows: "./workflows" },
    },
    { baseDir: EXT_BASE },
  );
  return { workflowExtensionRegistry: reg };
}

// Preview classification and runtime eligibility must agree. applyGateClass consumes the
// autoApplyEligible fact that shouldAutoApplyDrain resolves, so the two cannot diverge.
function gateFor(run, ctx) {
  return applyGateClass({ ...run, autoApplyEligible: shouldAutoApplyDrain(run, ctx) });
}

test("fnop.4 trusted enabled adapter: preview in-run-apply and runtime eligible agree", () => {
  const ctx = ctxWithDrainExtension();
  const run = drainRun(path.join(EXT_WF_DIR, "fixture-drain.js"));
  assert.equal(shouldAutoApplyDrain(run, ctx), true);
  assert.equal(gateFor(run, ctx), "in-run-apply");
});

test("fnop.4 trusted adapter that disables auto-apply: preview apply-gated, runtime not eligible", () => {
  const ctx = ctxWithDisabledAdapter();
  const run = drainRun(path.join(EXT_WF_DIR, "fixture-drain.js"));
  assert.equal(shouldAutoApplyDrain(run, ctx), false);
  assert.equal(gateFor(run, ctx), "apply-gated");
});

test("fnop.4 unregistered adapter: preview and runtime agree (current behavior leaves it eligible)", () => {
  // Runtime only rejects an adapter that explicitly disables auto-apply; an unknown adapter name
  // is not a disable signal, so runtime treats it as eligible. fnop.4 only corrects preview/runtime
  // divergence, so the preview must agree with runtime here (both in-run-apply).
  const ctx = ctxWithDrainExtension();
  const run = { ...drainRun(path.join(EXT_WF_DIR, "fixture-drain.js")), meta: { harness: "drain", adapter: "missing" } };
  assert.equal(shouldAutoApplyDrain(run, ctx), true);
  assert.equal(gateFor(run, ctx), "in-run-apply");
});

test("fnop.4 untrusted/shadowed source: preview apply-gated and runtime not eligible", () => {
  const ctx = ctxWithDrainExtension();
  const run = drainRun(path.join(GLOBAL_WORKFLOW_DIR, "fixture-drain.js"));
  assert.equal(shouldAutoApplyDrain(run, ctx), false);
  assert.equal(gateFor(run, ctx), "apply-gated");
});
