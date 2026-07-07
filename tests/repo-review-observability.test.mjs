// Acceptance for bead opencode-workflows-iui1.8: observability — scale/coverage telemetry.
//
// Proves the four acceptance criteria:
//  (1) the meta envelope includes scaleProfile
//  (2) the report markdown includes coverage and scale sections
//  (3) dropped lanes and missed shards are named (in scaleProfile + the report)
//  (4) a clean run reports zero drops and complete coverage
//
// Zero-token: canned prompt routing; no real model is called.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";

import {
  makeHarness,
  runApprovedRequest,
  resultOutput,
  runIdFrom,
  makeLeafPromptRouter,
  structured,
} from "./helpers/repo-review-leaf-harness.mjs";

function detectDomain(text) {
  if (text.includes("bug finder")) return "bughunt";
  return null;
}

// router(opts): bughunt returns one clean finding by default; {dropFinder} throws for the
// concurrency finder to produce a dropped lane.
function router({ dropFinder = false } = {}) {
  return makeLeafPromptRouter((text, shape) => {
    // Domain-local recon first (its prompt starts with "Profile this repository for a complexity"
    // and would otherwise be caught by the meta-recon "Profile this repository" branch).
    if (text.includes("for a complexity")) return shape({ profile: "t", dirs: ["src"], gitAvailable: false });
    if (text.includes("comprehensive multi-domain review") || text.includes("Profile this repository")) {
      return shape({ languages: ["javascript"], notes: "recon" });
    }
    if (text.includes("coverage auditor")) return shape({ coverageAssessment: "complete", confidence: "high", gaps: [], missedAreas: [] });
    if (text.includes("You are a skeptic")) return shape({ refuted: false, reasoning: "keep", adjustedConfidence: 80 });
    if (text.includes("bug finder")) {
      const m = text.match(/the "([a-z-]+)" bug finder/);
      const cat = m ? m[1] : "concurrency";
      if (dropFinder && cat === "concurrency") throw new Error("simulated finder crash");
      return shape({ findings: [{ category: cat, file: `src/${cat}.js`, line: 10, severity: "low", description: `${cat} bug`, reproSketch: "r", fixSketch: "f", proposedChange: "c", confidence: 70, effort: "medium", docImpact: "" }] });
    }
    return shape({ findings: [] });
  }, { fallbackShape: structured });
}

async function runMeta(r, requestArgs = {}) {
  const { tools, context, directory } = await makeHarness(r);
  const out = await runApprovedRequest(tools, context, { name: "repo-review", args: requestArgs });
  const env = await resultOutput(tools, context, out);
  return { env, directory, runId: runIdFrom(out) };
}

// The full report markdown lives in the report-markdown.md artifact (workflow_status truncates
// string fields to MAX_STATUS_STRING_CHARS=600 for display, so the envelope's reportMarkdown is a
// preview; the artifact holds the complete report with all sections).
async function readReportArtifact(directory, runId) {
  return await fs.readFile(path.join(directory, ".opencode", "workflows", "runs", runId, "artifacts", "repo-review", "report-markdown.md"), "utf8");
}

// ===========================================================================
// (1) + (4) envelope scaleProfile; clean run = zero drops + complete coverage
// ===========================================================================

test("observability: envelope includes scaleProfile; a clean run reports zero drops and complete coverage", async () => {
  const { env, directory } = await runMeta(router(), { mode: "bounded", depth: "normal" });
  try {
    // (1) scaleProfile present with the documented fields.
    assert.ok(env.scaleProfile && typeof env.scaleProfile === "object", "envelope must carry scaleProfile");
    for (const k of ["shards", "totalFiles", "reviewedFiles", "skippedFiles", "totalLanes", "droppedLanes", "droppedLaneLabels", "failedDomains"]) {
      assert.ok(k in env.scaleProfile, `scaleProfile must include ${k}`);
    }
    // (4) clean run: zero drops, no failed domains, materialization-ready.
    assert.equal(env.scaleProfile.droppedLanes, 0, "clean run has zero dropped lanes");
    assert.deepEqual(env.scaleProfile.droppedLaneLabels, [], "clean run names no dropped lanes");
    assert.deepEqual(env.scaleProfile.failedDomains, [], "clean run has no failed domains");
    assert.equal(env.materializationReady, true, "clean run is materialization-ready");
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

// ===========================================================================
// (2) report markdown includes coverage + scale sections
// ===========================================================================

test("observability: report markdown includes scope, inventory, lane coverage, artifact status, and a 'did not do' disclosure", async () => {
  const { env, directory, runId } = await runMeta(router(), { mode: "bounded", depth: "normal" });
  try {
    // The full report is in the artifact (the envelope's reportMarkdown is a truncated preview).
    const md = await readReportArtifact(directory, runId);
    assert.ok(typeof md === "string" && md.length > 0, "report markdown artifact must be present");
    for (const section of ["## Scope summary", "## Inventory summary", "## Lane coverage", "## Artifact status", "## What this review did not do"]) {
      assert.ok(md.includes(section), `report markdown must include a "${section}" section`);
    }
    // The "did not do" disclosure names the static-only limitation.
    assert.match(md, /Static, read-only analysis/, "the disclosure must name the static-only limitation");
    // The envelope's compact preview still carries the scope heading within the truncation budget.
    assert.match(env.reportMarkdown, /## Scope summary/, "the envelope preview carries the scope heading");
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

// ===========================================================================
// (3) dropped lanes are named in scaleProfile + the report
// ===========================================================================

test("observability: a dropped finder lane is named in scaleProfile and surfaced in the report", async () => {
  const { env, directory, runId } = await runMeta(router({ dropFinder: true }), { mode: "bounded", depth: "normal" });
  try {
    // The dropped lane is visible in telemetry.
    assert.ok(env.scaleProfile.droppedLanes > 0, "a dropped finder must increment scaleProfile.droppedLanes");
    assert.ok(
      env.scaleProfile.droppedLaneLabels.some((l) => l.includes("bughunt") && l.includes("concurrency")),
      `dropped lane must be named, got ${JSON.stringify(env.scaleProfile.droppedLaneLabels)}`,
    );
    // The full report names the dropped lane explicitly.
    const md = await readReportArtifact(directory, runId);
    assert.match(md, /Dropped \/ failed lanes/, "report must include a dropped-lanes section when lanes dropped");
    assert.match(md, /bughunt:.*concurrency/, "report must name the dropped bughunt:concurrency lane");
    // And materialization is blocked (the dropped lane degrades coverage).
    assert.equal(env.materializationReady, false, "a dropped lane must block materialization");
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
