// Acceptance for bead opencode-workflows-iui1.4: artifactized full output.
//
// Proves the five acceptance criteria:
//  (1) a large synthetic run writes findings.jsonl and findings.full.json
//  (2) the envelope stays under MAX_RESULT_BYTES with artifactPaths
//  (3) counts.total in the envelope matches the artifact finding count
//  (4) review-materialize consumes the full artifact (findingsPath handoff)
//  (5) if the artifact write fails, materializationReady is false
//
// The full findings only exist INSIDE the workflow execution (the QuickJS guest cannot write files
// and the return value is capped at MAX_RESULT_BYTES). A new kernel host op `persistArtifacts`
// spills the full set to run.dir/artifacts/repo-review/ so nothing is lost to size fitting.
// Zero-token: canned prompt routing; no real model is called.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";

import {
  makeHarness,
  runApprovedRequest,
  resultOutput,
  runIdFrom,
  makeLeafPromptRouter,
  structured,
} from "./helpers/repo-review-leaf-harness.mjs";
import { createReviewMaterializeAdapter } from "../workflow-domains/beads/review-materialize-adapter.js";

const MAX_RESULT_BYTES = 256 * 1024;

// Per-domain required action fields so a leaf never throws on a missing FINDINGS_SCHEMA field.
const DOMAIN_FIELDS = {
  bughunt: { reproSketch: "r", fixSketch: "f", proposedChange: "c", docImpact: "" },
  cleanup: { proposedChange: "c", docImpact: "" },
  perf: { hotness: "warm", estimatedImpact: "minor", complexityBefore: "O(n)", complexityAfter: "O(1)", proposedChange: "c", docImpact: "" },
  "test-gaps": { targetUnderTest: "t()", suggestedTest: "s", proposedChange: "c", docImpact: "" },
};
const PER_DOMAIN = ["bughunt", "cleanup", "perf", "test-gaps"];
const PER_LEAF = 30; // 4 domains x 30 findings x ~2.5KB > 256 KiB -> would truncate without artifacts

// A router that returns many LARGE findings across 4 domains so the merged set exceeds the host
// result cap. Empty everywhere else + a complete coverage auditor + valid shared recon.
function largeFindingsRouter() {
  const BIG = "x".repeat(2500);
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
    // Per-domain finders: detect the domain and return PER_LEAF large findings.
    let dom = null;
    if (text.includes("bug finder")) dom = "bughunt";
    else if (text.includes("repo cleanup")) dom = "cleanup";
    else if (text.includes("performance finder")) dom = "perf";
    else if (text.includes("test-gap finder")) dom = "test-gaps";
    if (dom && PER_DOMAIN.includes(dom)) {
      const findings = [];
      for (let i = 0; i < PER_LEAF; i++) {
        findings.push({
          category: "default", file: `src/${dom}-${i}.js`, line: i + 1, severity: "low",
          description: `${dom} finding ${i} ${BIG}`, confidence: 60, effort: "large",
          ...DOMAIN_FIELDS[dom],
        });
      }
      return shape({ findings });
    }
    return shape({ findings: [] });
  }, { fallbackShape: structured });
}

async function runMetaLarge(opts = {}) {
  const { tools, context, directory } = await makeHarness(largeFindingsRouter(), opts);
  const out = await runApprovedRequest(tools, context, { name: "repo-review", args: { depth: "normal" } });
  const env = await resultOutput(tools, context, out);
  const runId = runIdFrom(out);
  return { env, tools, context, directory, runId };
}

// ===========================================================================
// (1) + (2) + (3) Large run writes full artifacts, envelope stays under cap, counts match
// ===========================================================================

test("large run writes findings.full.json + findings.jsonl; envelope stays under cap; counts match the artifact", async () => {
  const { env, directory } = await runMetaLarge();
  try {
    assert.equal(env.status, "ok");
    // (1) Artifacts persisted, with stable logical keys pointing at real files.
    assert.ok(env.artifactPaths, "envelope must carry artifactPaths");
    const findingsJsonPath = env.artifactPaths.findingsJson;
    const findingsJsonlPath = env.artifactPaths.findingsJsonl;
    assert.ok(findingsJsonPath, "findingsJson (findings.full.json) path must be present");
    assert.ok(findingsJsonlPath, "findingsJsonl path must be present");
    assert.equal(env.artifactsReady, true);

    // The full JSON artifact is the COMPLETE ranked set (not the truncated preview).
    const fullJson = JSON.parse(await fs.readFile(findingsJsonPath, "utf8"));
    assert.ok(Array.isArray(fullJson), "findings.full.json must be a JSON array");
    assert.equal(fullJson.length, env.counts.total, "(3) artifact finding count must equal envelope counts.total");
    assert.ok(fullJson.every((f) => f.domainDetails && typeof f.domainDetails === "object"), "full artifact findings must preserve domainDetails for Beads materialization");
    const bughuntFinding = fullJson.find((f) => f.sourceDomain === "bughunt");
    assert.equal(bughuntFinding?.domainDetails.reproSketch, "r", "bughunt reproSketch must survive into the full artifact");

    // The JSONL artifact has one line per finding.
    const jsonl = await fs.readFile(findingsJsonlPath, "utf8");
    const jsonlLines = jsonl.split("\n").filter((l) => l.length);
    assert.equal(jsonlLines.length, env.counts.total, "findings.jsonl must have one line per finding");
    assert.deepEqual(JSON.parse(jsonlLines[0]).fingerprint, fullJson[0].fingerprint, "jsonl line 1 must match full json element 1");

    // (2) The returned envelope stays well under the host cap despite the large merged set.
    const serialized = JSON.stringify(env).length;
    assert.ok(serialized < MAX_RESULT_BYTES, `envelope must fit under MAX_RESULT_BYTES (${serialized} >= ${MAX_RESULT_BYTES})`);

    // The returned preview is intentionally compact (truncated relative to the full artifact), and
    // the envelope discloses the artifact path for the full set.
    assert.ok(env.findings.length <= env.counts.total, "returned preview must be <= the full ranked set");
    assert.ok(env.findings.length < fullJson.length || env.findings.length === env.counts.total, "preview is a compact subset when the set is large");

    // Because the full set was artifactized, truncation of the preview is NOT a materialization blocker.
    assert.equal(env.materializationReady, true, `a large run with persisted artifacts must be materializationReady; blockers=${JSON.stringify(env.materializationBlockers)}`);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

// ===========================================================================
// (4) review-materialize consumes the full artifact
// ===========================================================================

test("review-materialize consumes the full artifact (adapter reads findings.full.json and plans all findings)", async () => {
  const { env, directory } = await runMetaLarge();
  try {
    const fullJson = JSON.parse(await fs.readFile(env.artifactPaths.findingsJson, "utf8"));

    // A mock bd that reports NO existing beads (a fresh materialization). The dry-run path only
    // reads (list); it never writes, so this is sufficient to prove the full artifact is consumed.
    const bdCalls = [];
    const runBd = async (args) => {
      bdCalls.push(args);
      if (args[0] === "list") return [];
      return [];
    };
    const adapter = createReviewMaterializeAdapter({ cwd: directory, runBd });
    const result = await adapter.materialize({
      findings: fullJson,
      programLabel: "iui1-artifact-consume",
      dryRun: true,
      materializationReady: true,
    });

    assert.notEqual(result.status, "aborted", "the artifact findings must be accepted (not aborted on format/content)");
    assert.equal(result.stats.total, fullJson.length, "materialization must see ALL artifact findings");
    assert.equal(result.stats.create + result.stats.skip + result.stats.ambiguous, fullJson.length, "every finding is classified");
    assert.equal(result.stats.create, fullJson.length, "a fresh materialization plans to create every finding (no existing duplicates)");
    assert.ok(result.plannedCreates.length === fullJson.length, "plannedCreates must cover the full artifact set");
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

// ===========================================================================
// (5) If the artifact write fails, materializationReady is false
// ===========================================================================

test("if the artifact write fails, materializationReady is false (artifactPersistenceFailed blocker)", async () => {
  // Inject the kernel test hook that makes persistArtifacts return {ok:false}.
  const { env, directory } = await runMetaLarge({ pluginContext: { __workflowArtifactFail: true } });
  try {
    assert.equal(env.artifactsReady, false, "artifact persistence must report not-ready");
    assert.equal(env.materializationReady, false, "a failed artifact write must block materialization");
    assert.ok(
      env.materializationBlockers.includes("artifactPersistenceFailed"),
      `expected artifactPersistenceFailed blocker, got ${JSON.stringify(env.materializationBlockers)}`,
    );
    // counts.total still reflects the full merged set (it is computed before size fitting).
    assert.ok(env.counts.total > 0);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
