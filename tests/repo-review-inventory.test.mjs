// Acceptance for bead opencode-workflows-iui1.5: deterministic file inventory + sharding.
//
// Proves the five acceptance criteria:
//  (1) inventory produces a structured manifest
//  (2) a large fake repo produces multiple shards
//  (3) every shard has a ledger entry
//  (4) a missed/failed shard blocks materialization
//  (5) sharding is transparent to the deterministic merge (no duplication/corruption)
//
// The QuickJS guest has no fs, so inventory is a kernel host op (inventoryFiles) that walks the
// project root deterministically. Tests use REAL files in the harness temp dir for (1)-(3),(5)
// and a kernel test hook for the failure path (4). Zero-token: canned prompt routing.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";

import {
  makeHarness,
  runApprovedRequest,
  resultOutput,
  makeLeafPromptRouter,
  structured,
} from "./helpers/repo-review-leaf-harness.mjs";

// Empty-findings router: valid shared recon + complete coverage auditor + empty findings for every
// leaf lens, so all eight leaves reach a contract-valid empty envelope (ran) and the inventory is
// the variable under test.
function emptyRouter() {
  return makeLeafPromptRouter((text, shape) => {
    if (text.includes("comprehensive multi-domain review") || text.includes("Profile this repository")) {
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
    return shape({ findings: [] });
  }, { fallbackShape: structured });
}

async function writeProject(root, layout) {
  for (const rel of layout) {
    const full = path.join(root, rel);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, `// ${rel}\n`, "utf8");
  }
}

async function runInPopulatedProject(layout, opts = {}, requestArgs = {}) {
  const { tools, context, directory } = await makeHarness(emptyRouter(), opts);
  await writeProject(directory, layout);
  const out = await runApprovedRequest(tools, context, { name: "repo-review", args: requestArgs });
  const env = await resultOutput(tools, context, out);
  return { env, directory };
}

// ===========================================================================
// (1) + (2) + (3) Inventory manifest, multiple shards, complete ledger
// ===========================================================================

test("inventory: a multi-root fake repo produces a structured manifest with multiple shards and a complete ledger", async () => {
  const { env, directory } = await runInPopulatedProject(
    ["src/a.js", "src/b.js", "src/c.js", "lib/util.js", "packages/pkg-a/index.js", "packages/pkg-a/lib/m.js"],
    {},
    { mode: "bounded", depth: "normal" },
  );
  try {
    // (1) structured manifest reached the envelope as a compact summary.
    assert.ok(env.inventorySummary, "envelope must carry inventorySummary");
    assert.equal(env.inventorySummary.ready, true, "inventory must succeed for a real project");
    assert.ok(env.inventorySummary.totalFiles >= 6, `expected >=6 files enumerated, got ${env.inventorySummary.totalFiles}`);
    // (2) multiple source roots -> multiple shards.
    assert.ok(env.inventorySummary.sourceRoots >= 3, `expected >=3 source roots, got ${env.inventorySummary.sourceRoots}`);
    assert.ok(env.inventorySummary.shards >= 3, `expected >=3 shards (one per root), got ${env.inventorySummary.shards}`);
    // (3) every shard has a ledger entry with a completed status (clean run -> all shards covered).
    assert.equal(env.shardLedger.length, env.inventorySummary.shards, "ledger length must match shard count");
    for (const s of env.shardLedger) {
      assert.ok(s.id && typeof s.fileCount === "number" && Array.isArray(s.languages), `shard ledger entry malformed: ${JSON.stringify(s)}`);
      assert.equal(s.status, "completed", `shard ${s.id} must be completed after a clean run, got ${s.status}`);
    }
    // The full manifest + per-shard file lists are spilled to an artifact.
    assert.ok(env.artifactPaths && env.artifactPaths.shardLedgerJson, "shard-ledger.json artifact must be persisted");
    const artifact = JSON.parse(await fs.readFile(env.artifactPaths.shardLedgerJson, "utf8"));
    assert.ok(artifact.inventory && artifact.inventory.totalFiles >= 6, "artifact must carry the full manifest");
    assert.ok(Array.isArray(artifact.shards) && artifact.shards.length >= 3, "artifact must carry every shard with its file list");
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("inventory: requested paths outside the project root are skipped and never enter shards", async () => {
  const { tools, context, directory } = await makeHarness(emptyRouter());
  const outside = path.join(path.dirname(directory), `${path.basename(directory)}-outside.txt`);
  try {
    await writeProject(directory, ["src/inside.js"]);
    await fs.writeFile(outside, "// outside\n", "utf8");

    const out = await runApprovedRequest(tools, context, {
      name: "repo-review",
      args: { mode: "bounded", depth: "normal", paths: ["src", outside, "../outside.txt"] },
    });
    const env = await resultOutput(tools, context, out);
    assert.ok(env.inventorySummary, "inventory summary must be present");
    assert.equal(env.inventorySummary.ready, true, "valid in-root paths still inventory successfully");

    const artifact = JSON.parse(await fs.readFile(env.artifactPaths.shardLedgerJson, "utf8"));
    const shardPaths = artifact.shards.flatMap((shard) => shard.paths ?? []);
    assert.ok(shardPaths.includes("src/inside.js"), "in-root file remains inventoried");
    assert.equal(shardPaths.some((p) => p.includes("outside") || p.startsWith("..") || path.isAbsolute(p)), false);
  } finally {
    await fs.rm(outside, { force: true });
    await fs.rm(directory, { recursive: true, force: true });
  }
});

// ===========================================================================
// (4) A failed or partial inventory blocks materialization
// ===========================================================================

test("inventory: a failed inventory blocks materialization (inventoryFailed)", async () => {
  const { env, directory } = await runInPopulatedProject(
    ["src/a.js"],
    { pluginContext: { __workflowInventoryFail: true } },
    { mode: "bounded", depth: "normal" },
  );
  try {
    assert.equal(env.inventorySummary.ready, false, "inventory must report not-ready");
    assert.equal(env.materializationReady, false, "a failed inventory must block materialization");
    assert.ok(env.materializationBlockers.includes("inventoryFailed"), `expected inventoryFailed blocker, got ${JSON.stringify(env.materializationBlockers)}`);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("inventory: a partial inventory (hit file cap) blocks materialization (inventoryPartial)", async () => {
  // Inject a deterministic partial inventory via the kernel test seam (no real fs needed).
  const injected = {
    ok: true,
    partial: true,
    manifest: { totalFiles: 200000, byLanguage: { javascript: 200000 }, byRole: { source: 200000 }, sourceRoots: ["src"], paths: ["."], exclude: [], partial: true },
    shards: [{ id: "src-1", root: "src", fileCount: 2000, languages: ["javascript"], paths: ["src/a.js"] }],
  };
  const { tools, context, directory } = await makeHarness(emptyRouter(), { pluginContext: { __workflowInventory: () => injected } });
  try {
    const out = await runApprovedRequest(tools, context, { name: "repo-review", args: { mode: "bounded", depth: "normal" } });
    const env = await resultOutput(tools, context, out);
    assert.equal(env.inventorySummary.partial, true, "a partial inventory must surface in the summary");
    assert.equal(env.materializationReady, false, "a partial inventory must block materialization (coverage gap)");
    assert.ok(env.materializationBlockers.includes("inventoryPartial"), `expected inventoryPartial blocker, got ${JSON.stringify(env.materializationBlockers)}`);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

// ===========================================================================
// (5) Sharding is transparent to the deterministic merge (no duplication/corruption)
// ===========================================================================

test("inventory: sharding does not corrupt the merge — distinct findings stay distinct and the run is deterministic", async () => {
  // Inject a 2-shard inventory so sharding is active, and have bughunt emit TWO distinct findings.
  // The merge must keep both (no duplication, no shard-induced collapse) and the run stays stable.
  const injected = {
    ok: true, partial: false,
    manifest: { totalFiles: 2, byLanguage: { javascript: 2 }, byRole: { source: 2 }, sourceRoots: ["src", "lib"], paths: ["."], exclude: [], partial: false },
    shards: [
      { id: "src-1", root: "src", fileCount: 1, languages: ["javascript"], paths: ["src/a.js"] },
      { id: "lib-1", root: "lib", fileCount: 1, languages: ["javascript"], paths: ["lib/b.js"] },
    ],
  };
  function twoFindingsRouter() {
    return makeLeafPromptRouter((text, shape) => {
      if (text.includes("comprehensive multi-domain review") || text.includes("Profile this repository")) {
        return shape({ languages: ["javascript"], notes: "recon" });
      }
      if (text.includes("for a complexity")) return shape({ profile: "t", dirs: ["src"], gitAvailable: false });
      if (text.includes("coverage auditor")) return shape({ coverageAssessment: "complete", confidence: "high", gaps: [], missedAreas: [] });
      if (text.includes("You are a skeptic")) return shape({ refuted: false, reasoning: "keep", adjustedConfidence: 80 });
      // bughunt's first finder category returns two DISTINCT findings (different files -> distinct fingerprints).
      if (text.includes("bug finder")) {
        const m = text.match(/the "([a-z-]+)" bug finder/);
        const cat = m ? m[1] : "concurrency";
        if (cat === "concurrency") {
          return shape({ findings: [
            { category: cat, file: "src/shardA.js", line: 10, severity: "low", description: "finding from shard A", reproSketch: "r", fixSketch: "f", proposedChange: "c", confidence: 70, effort: "medium", docImpact: "" },
            { category: cat, file: "lib/shardB.js", line: 20, severity: "low", description: "finding from shard B", reproSketch: "r", fixSketch: "f", proposedChange: "c", confidence: 70, effort: "medium", docImpact: "" },
          ] });
        }
      }
      return shape({ findings: [] });
    }, { fallbackShape: structured });
  }
  const makeRun = async () => {
    const { tools, context, directory } = await makeHarness(twoFindingsRouter(), { pluginContext: { __workflowInventory: () => injected } });
    try {
      const out = await runApprovedRequest(tools, context, { name: "repo-review", args: { mode: "bounded", depth: "normal" } });
      return await resultOutput(tools, context, out);
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  };
  const [a, b] = await Promise.all([makeRun(), makeRun()]);
  assert.equal(a.inventorySummary.shards, 2, "sharding is active (2 shards)");
  // Both distinct findings survive (sharding did not collapse or duplicate them).
  assert.equal(a.counts.total, 2, "the two distinct findings must both survive the merge");
  assert.equal(a.status, "ok");
  // Deterministic: same inputs -> byte-identical ranked fingerprints (modulo runId-bearing artifactPaths).
  const sig = (env) => env.findings.map((f) => [f.fingerprint, f.rank, f.file]);
  assert.deepEqual(sig(a), sig(b), "sharded runs must be deterministic");
});
