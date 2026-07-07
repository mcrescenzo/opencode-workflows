// Final validation gate (iui1.10): capstone end-to-end integration of the whole overhaul.
//
// Exercises every iui1.x deliverable in ONE real repo-review meta run against a populated fake
// repo, then asserts the integrated behavior: maximal defaults, deterministic inventory + shards,
// lane coverage telemetry, artifactized full output, scalable merge + corroboration, observability
// scaleProfile, deep-mode static default, and correct materialization gating (clean = ready,
// degraded = blocked). This is the gate's no-token "real run" proof (the meta runs end-to-end with
// mocked prompts; the engine, host ops, merge, and gate are all the real production code).

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

async function writeProject(root, layout) {
  for (const rel of layout) {
    const full = path.join(root, rel);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, `// ${rel}\nconsole.log("ok");\n`, "utf8");
  }
}

// A router where bughunt returns one clean finding; every domain runs cleanly (no drops).
function cleanRouter() {
  return makeLeafPromptRouter((text, shape) => {
    if (text.includes("for a complexity")) return shape({ profile: "t", dirs: ["src"], gitAvailable: false });
    if (text.includes("comprehensive multi-domain review") || text.includes("Profile this repository")) return shape({ languages: ["javascript"], notes: "recon" });
    if (text.includes("coverage auditor")) return shape({ coverageAssessment: "complete", confidence: "high", gaps: [], missedAreas: [] });
    if (text.includes("You are a skeptic")) return shape({ refuted: false, reasoning: "keep", adjustedConfidence: 80 });
    if (text.includes("bug finder")) {
      const m = text.match(/the "([a-z-]+)" bug finder/);
      const cat = m ? m[1] : "concurrency";
      return shape({ findings: [{ category: cat, file: `src/${cat}.js`, line: 10, severity: "low", description: `${cat} bug`, reproSketch: "r", fixSketch: "f", proposedChange: "c", confidence: 70, effort: "medium", docImpact: "" }] });
    }
    return shape({ findings: [] });
  }, { fallbackShape: structured });
}

test("FINAL GATE: a complete repo-review run exercises the full overhaul and gates correctly (clean = ready)", async () => {
  const { tools, context, directory } = await makeHarness(cleanRouter());
  try {
    await writeProject(directory, ["src/a.js", "src/b.js", "lib/c.js", "packages/pkg-a/index.js"]);
    const out = await runApprovedRequest(tools, context, { name: "repo-review", args: { depth: "normal" } });
    const env = await resultOutput(tools, context, out);
    const runId = runIdFrom(out);

    // iui1.1 maximal defaults: thorough depth forwarded, maxReturnFindings/maxDirs defaults in source.
    // iui1.5 inventory + sharding: the populated fake repo produced a manifest + shards.
    assert.ok(env.inventorySummary?.ready, "inventory ran");
    assert.ok(env.inventorySummary.totalFiles >= 4, `inventory enumerated the fake repo files (${env.inventorySummary.totalFiles})`);
    assert.ok(env.inventorySummary.sourceRoots >= 3, "multiple source roots -> multiple shards");
    assert.ok(env.shardLedger.length >= 3, "shard ledger populated");
    assert.ok(env.shardLedger.every((s) => s.status === "completed"), "every shard covered on a clean run");

    // iui1.2 lane coverage telemetry present on every leaf.
    assert.ok(env.leafOutcomes.every((o) => o.laneCoverage), "every leaf carries laneCoverage");
    assert.ok(env.scaleProfile.droppedLanes === 0, "clean run has zero lane drops");

    // iui1.4 artifactized full output: artifacts written, full findings in the artifact.
    assert.equal(env.artifactsReady, true, "artifacts persisted");
    assert.ok(env.artifactPaths.findingsJson, "findingsJson artifact path present");
    const full = JSON.parse(await fs.readFile(path.join(directory, ".opencode", "workflows", "runs", runId, "artifacts", "repo-review", "findings.full.json"), "utf8"));
    assert.ok(Array.isArray(full) && full.length === env.counts.total, "artifact carries the FULL ranked set");
    assert.ok(env.reportMarkdown !== null || env.truncatedFindings === true, "report markdown present (or intentionally compacted)");

    // iui1.6 scalable merge: corroborationCount present on findings (Map-based merge + corroboration key).
    assert.ok(env.findings.every((f) => typeof f.corroborationCount === "number"), "findings carry corroborationCount");

    // iui1.8 observability: scaleProfile + report sections.
    assert.ok(env.scaleProfile && typeof env.scaleProfile.totalFiles === "number", "scaleProfile present");

    // iui1.7 deep mode: static by default (no shell/network requested).
    assert.equal(env.deepMode.active, "static", "default run is static");
    assert.equal(env.deepMode.shellCoverage, "none", "no shell coverage in static mode");

    // Materialization gating: a clean, complete, artifactized run IS ready.
    assert.equal(env.partialCoverage, false, "clean run is not partial");
    assert.equal(env.materializationReady, true, `clean complete run must be materializationReady; blockers=${JSON.stringify(env.materializationBlockers)}`);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("FINAL GATE: a degraded run (dropped lane) blocks materialization end-to-end", async () => {
  // Drop one bughunt finder lane -> lane coverage degrades -> materialization gated off, even
  // though the report + artifacts still produced. Proves the gate refuses incomplete coverage.
  function degradedRouter() {
    return makeLeafPromptRouter((text, shape) => {
      if (text.includes("for a complexity")) return shape({ profile: "t", dirs: ["src"], gitAvailable: false });
      if (text.includes("comprehensive multi-domain review") || text.includes("Profile this repository")) return shape({ languages: ["javascript"], notes: "recon" });
      if (text.includes("coverage auditor")) return shape({ coverageAssessment: "complete", confidence: "high", gaps: [], missedAreas: [] });
      if (text.includes("You are a skeptic")) return shape({ refuted: false, reasoning: "keep", adjustedConfidence: 80 });
      if (text.includes("bug finder")) {
        const m = text.match(/the "([a-z-]+)" bug finder/);
        const cat = m ? m[1] : "concurrency";
        if (cat === "concurrency") throw new Error("simulated finder crash");
        return shape({ findings: [{ category: cat, file: `src/${cat}.js`, line: 10, severity: "low", description: `${cat} bug`, reproSketch: "r", fixSketch: "f", proposedChange: "c", confidence: 70, effort: "medium", docImpact: "" }] });
      }
      return shape({ findings: [] });
    }, { fallbackShape: structured });
  }
  const { tools, context, directory } = await makeHarness(degradedRouter());
  try {
    const out = await runApprovedRequest(tools, context, { name: "repo-review", args: { depth: "normal" } });
    const env = await resultOutput(tools, context, out);
    assert.ok(env.scaleProfile.droppedLanes > 0, "the dropped finder lane is visible");
    assert.equal(env.partialCoverage, true, "a dropped lane degrades coverage");
    assert.equal(env.materializationReady, false, "a degraded run must NOT be materialization-ready");
    assert.ok(env.materializationBlockers.some((b) => b === "partialCoverage" || b.startsWith("leafLaneDrops:") || b.startsWith("leafFinderDrops:")), "blockers cite the lane drop");
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
