// Acceptance for bead opencode-workflows-iui1.2: lane coverage telemetry + meta degradation blockers.
//
// Proves the five acceptance criteria:
//  (1) a finder lane returning null produces laneCoverage.dropped > 0 in the leaf envelope
//  (2) the meta sees dropped lanes and sets partialCoverage=true
//  (3) materializationReady is false when any lane was dropped
//  (4) a malformed structured-output response is visible as a dropped lane
//  (5) a clean run with zero drops still has materializationReady=true
//
// repo-bughunt is the exemplar leaf (it has the canonical find+verify phases). The meta cases
// drop one finder lens inside one nested leaf to prove the drop is visible THROUGH the meta.
// Zero-token: canned prompt routing; no real model is called.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";

import {
  makeHarness,
  runApprovedRequest,
  resultOutput,
  runLeafEnvelope,
  makeLeafPromptRouter,
  structured,
} from "./helpers/repo-review-leaf-harness.mjs";

// ---- leaf-side router (repo-bughunt) ----
// dropCat + mode simulate a single dropped finder lane. mode "throw" crashes the lane;
// mode "malformed" keeps returning a structured payload that FAILS FINDINGS_SCHEMA
// through the corrective turn, so the lane drops after validation exhaustion.
function bughuntLaneRouter({ dropCat = null, mode = "throw" } = {}) {
  return makeLeafPromptRouter((text, shape) => {
    if (text.includes("Profile this repository")) {
      return shape({ languages: ["javascript"], notes: "lane-coverage recon" });
    }
    if (mode === "malformed" && text.includes("previous response failed validation")) {
      return shape({ notFindings: true }); // still fails FINDINGS_SCHEMA (missing `findings`)
    }
    if (text.includes("bug finder")) {
      const m = text.match(/the "([a-z-]+)" bug finder/);
      const cat = m ? m[1] : "concurrency";
      if (dropCat && cat === dropCat) {
        if (mode === "malformed") return shape({ notFindings: true }); // fails FINDINGS_SCHEMA (missing `findings`)
        throw new Error("simulated finder lane crash");
      }
      return shape({ findings: [{
        category: cat, file: `src/${cat}.js`, line: 10, severity: "low",
        description: `${cat} bug example`, reproSketch: "edge input", fixSketch: "guard",
        proposedChange: "add guard", confidence: 70, effort: "medium", docImpact: "",
      }] });
    }
    if (text.includes("You are a skeptic")) {
      return shape({ refuted: false, reasoning: "keep", adjustedConfidence: 75 });
    }
    return shape({ findings: [] });
  }, { fallbackShape: structured });
}

async function runBughunt({ dropCat, mode } = {}) {
  const { tools, context, directory } = await makeHarness(bughuntLaneRouter({ dropCat, mode }));
  try {
    return await runLeafEnvelope(tools, context, { name: "repo-bughunt", args: { depth: "normal" } });
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

// ===========================================================================
// (1) A dropped finder lane produces laneCoverage.dropped > 0 in the leaf envelope
// ===========================================================================

test("leaf: a finder lane returning null produces laneCoverage.dropped > 0", async () => {
  const env = await runBughunt({ dropCat: "concurrency", mode: "throw" });
  assert.ok(env.laneCoverage && typeof env.laneCoverage === "object", "leaf envelope must carry laneCoverage");
  assert.ok(env.laneCoverage.dropped > 0, `expected dropped > 0, got ${env.laneCoverage.dropped}`);
  assert.ok(env.laneCoverage.byPhase.find && env.laneCoverage.byPhase.find.dropped >= 1, "find phase must record the dropped finder");
  assert.ok(
    env.laneCoverage.droppedLabels.some((l) => l.includes("concurrency")),
    `droppedLabels must name the dropped finder lens, got ${JSON.stringify(env.laneCoverage.droppedLabels)}`,
  );
  // The envelope is still contract-valid (the leaf survived the drop).
  assert.ok(env.status === "ok" || env.status === "empty");
});

// ===========================================================================
// (4) A malformed structured-output response is visible as a dropped lane
// ===========================================================================

test("leaf: a malformed structured-output response is visible as a dropped lane", async () => {
  const env = await runBughunt({ dropCat: "concurrency", mode: "malformed" });
  assert.ok(env.laneCoverage.dropped > 0, `malformed structured output must count as a dropped lane, got ${env.laneCoverage.dropped}`);
  assert.ok(env.laneCoverage.byPhase.find.dropped >= 1, "the malformed finder must be recorded in the find phase");
});

// ===========================================================================
// (5-leaf) A clean leaf run records zero drops
// ===========================================================================

test("leaf: a clean run records zero dropped lanes", async () => {
  const env = await runBughunt();
  assert.equal(env.laneCoverage.dropped, 0);
  assert.equal(env.laneCoverage.expected > 0, true, "a non-empty run must have recorded expected lanes");
  assert.equal(env.laneCoverage.completed, env.laneCoverage.expected);
  assert.deepEqual(env.laneCoverage.droppedLabels, []);
});

// ---- meta-side router ----
// Drops one finder lens inside the nested repo-bughunt leaf so the drop is visible THROUGH
// the meta. All other domains return empty findings (no verify phase, no drops). The bughunt
// domain returns one clean finding from its other lenses so the report is non-empty and the
// ONLY materialization blocker is the lane drop.
function detectDomain(text) {
  if (text.includes("bug finder")) return "bughunt";
  if (text.includes("security finder")) return "security";
  if (text.includes("test-gap finder")) return "test-gaps";
  if (text.includes("modernization finder")) return "modernize";
  if (text.includes("performance finder")) return "perf";
  if (text.includes("complexity scorer")) return "complexity";
  if (text.includes("dependency analyst")) return "deps";
  if (text.includes("repo cleanup")) return "cleanup";
  return null;
}

function metaLaneRouter({ dropBughuntFinder = false, bughuntFindings = false } = {}) {
  return makeLeafPromptRouter((text, shape) => {
    if (text.includes("comprehensive multi-domain review") || text.includes("Profile this repository once")) {
      return shape({ languages: ["javascript"], notes: "meta shared recon" });
    }
    if (text.includes("for a complexity")) {
      return shape({ profile: "test repo", dirs: ["src"], gitAvailable: false });
    }
    if (text.includes("coverage auditor")) {
      return shape({ coverageAssessment: "complete", confidence: "high", gaps: [], missedAreas: [] });
    }
    if (text.includes("You are a skeptic")) {
      return shape({ refuted: false, reasoning: "keep", adjustedConfidence: 80 });
    }
    const dom = detectDomain(text);
    if (dom === "bughunt") {
      const m = text.match(/the "([a-z-]+)" bug finder/);
      const cat = m ? m[1] : "concurrency";
      if (dropBughuntFinder && cat === "concurrency") throw new Error("simulated meta finder lane crash");
      if (bughuntFindings) {
        return shape({ findings: [{
          category: cat, file: `src/${cat}.js`, line: 10, severity: "low",
          description: `${cat} bug`, reproSketch: "r", fixSketch: "f", proposedChange: "c", confidence: 70, effort: "medium", docImpact: "",
        }] });
      }
      return shape({ findings: [] });
    }
    return shape({ findings: [] });
  }, { fallbackShape: structured });
}

async function runMeta(routerOpts, requestArgs = {}) {
  const { tools, context, directory } = await makeHarness(metaLaneRouter(routerOpts));
  try {
    const out = await runApprovedRequest(tools, context, { name: "repo-review", args: requestArgs });
    return await resultOutput(tools, context, out);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

// ===========================================================================
// (2) + (3) The meta sees a dropped lane and blocks materialization
// ===========================================================================

test("meta: a dropped finder lane in a nested leaf sets partialCoverage=true and blocks materialization", async () => {
  const env = await runMeta({ dropBughuntFinder: true, bughuntFindings: true }, { depth: "normal" });
  // The bughunt leaf outcome carries the lane drop.
  const bughuntOutcome = env.leafOutcomes.find((o) => o.domain === "bughunt");
  assert.ok(bughuntOutcome, "bughunt leaf outcome must be present");
  assert.ok(bughuntOutcome.laneCoverage && bughuntOutcome.laneCoverage.dropped > 0, "the nested leaf's lane drop must propagate to the meta ledger");
  // (2) partialCoverage is true because a lane dropped.
  assert.equal(env.partialCoverage, true, "a dropped lane must set partialCoverage=true");
  // (3) materialization is blocked, and the blocker cites the lane drop.
  assert.equal(env.materializationReady, false, "materialization must be blocked when a lane dropped");
  assert.ok(
    env.materializationBlockers.some((b) => b.startsWith("leafLaneDrops:") || b === "partialCoverage"),
    `expected a lane-drop materialization blocker, got ${JSON.stringify(env.materializationBlockers)}`,
  );
  assert.ok(
    env.materializationBlockers.includes("leafFinderDrops:bughunt"),
    "a dropped finder lens must produce a leafFinderDrops:<domain> blocker",
  );
});

// ===========================================================================
// (5-meta) A clean run with zero drops is materializationReady
// ===========================================================================

test("meta: a clean run with zero lane drops is materializationReady=true", async () => {
  const env = await runMeta({ dropBughuntFinder: false, bughuntFindings: true }, { depth: "normal" });
  // No lane dropped anywhere.
  for (const o of env.leafOutcomes) {
    assert.ok(!o.laneDropped, `${o.domain} must have zero lane drops`);
  }
  assert.equal(env.partialCoverage, false, "a clean run must not be partial");
  assert.equal(env.materializationReady, true, `a clean non-empty run must be materializationReady, blockers=${JSON.stringify(env.materializationBlockers)}`);
});
