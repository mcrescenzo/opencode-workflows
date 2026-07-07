// Acceptance for bead opencode-workflows-iui1.1: maximal defaults + arg propagation.
//
// Proves the six acceptance criteria of iui1.1:
//  (1) meta forwards maxReturnFindings to all eight leaves
//  (2) meta forwards maxDirs to repo-complexity
//  (3) direct leaves default to thorough depth
//  (4) empty args run all domains at thorough
//  (5) unknown-only domains are rejected with a clear error
//  (6) batchSize default runs all leaves in one batch
//
// Wiring is pinned with source-grep (the suite's established pattern for load-bearing
// invariants — cf. repo-review-meta-smoke "source structure" and repo-review-materialization-gate
// "meta source declares"). Observable behavior (empty-args runs all eight; unknown-domain
// rejection at plan time) is proven end-to-end through the shared no-token harness.
//
// Zero-token: every child session.prompt is routed to a canned payload; no real model is called.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  makeHarness,
  runApprovedRequest,
  resultOutput,
  makeLeafPromptRouter,
  structured,
} from "./helpers/repo-review-leaf-harness.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const META_SRC = path.join(HERE, "..", "workflows", "repo-review.js");
const WORKFLOWS_DIR = path.join(HERE, "..", "workflows");
const PLUGIN_SRC = path.join(HERE, "..", "workflow-kernel", "workflow-plugin.js");

const EIGHT_LEAVES = [
  "repo-bughunt", "repo-security-audit", "repo-test-gaps", "repo-cleanup",
  "repo-modernize", "repo-perf", "repo-complexity", "repo-deps",
];

async function readSrc(rel) {
  return await fs.readFile(path.join(HERE, "..", rel), "utf8");
}

// Minimal router: empty findings everywhere + valid shared recon + complete coverage auditor,
// enough to run the meta end-to-end with empty args (exhaustive defaults) under mocked prompts.
function emptyFindingsRouter() {
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
    return shape({ findings: [] });
  }, { fallbackShape: structured });
}

async function runMeta(requestArgs) {
  const { tools, context, directory } = await makeHarness(emptyFindingsRouter());
  try {
    const out = await runApprovedRequest(tools, context, { name: "repo-review", args: requestArgs });
    return { env: await resultOutput(tools, context, out), tools, context };
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

// ===========================================================================
// (1) + (2) Meta forwards maxReturnFindings + maxDirs into the shared leafArgs
// ===========================================================================

test("meta forwards maxReturnFindings + maxDirs into the ONE shared leafArgs object", async () => {
  const src = await fs.readFile(META_SRC, "utf8");
  // The shared leafArgs reference is injected into every literal workflow("repo-X", leafArgs)
  // call; both ceilings must be present so the meta's scale decisions reach the leaves.
  assert.match(
    src,
    /leafArgs = \{ recon, paths, exclude, depth, maxReturnFindings, maxDirs \}/,
    "meta leafArgs must carry maxReturnFindings and maxDirs (forwarded to all eight leaves)",
  );
  // maxReturnFindings and maxDirs are both declared as effectively-unlimited meta defaults.
  assert.match(src, /const maxReturnFindings = .* : 1000000/, "meta must default maxReturnFindings to 1000000");
  assert.match(src, /const maxDirs = .* : 1000000/, "meta must default maxDirs to 1000000");
  // maxDirs is an accepted meta arg (forwarded to repo-complexity).
  assert.match(src, /maxDirs: \{ type: "integer", minimum: 1 \}/, "meta argsSchema must accept maxDirs");
});

// ===========================================================================
// (3) All eight leaves default to thorough depth
// ===========================================================================

test("all eight leaves default depth to thorough", async () => {
  for (const leaf of EIGHT_LEAVES) {
    const src = await fs.readFile(path.join(WORKFLOWS_DIR, `${leaf}.js`), "utf8");
    assert.match(
      src,
      /\? RT\.depth : "thorough"/,
      `${leaf} must default depth to "thorough" (direct invocation)`,
    );
  }
});

test("all eight leaves default MAX_RETURN_FINDINGS to the effectively-unlimited 1000000 ceiling", async () => {
  for (const leaf of EIGHT_LEAVES) {
    const src = await fs.readFile(path.join(WORKFLOWS_DIR, `${leaf}.js`), "utf8");
    assert.match(
      src,
      /const MAX_RETURN_FINDINGS = .* : 1000000/,
      `${leaf} must default MAX_RETURN_FINDINGS to 1000000`,
    );
  }
});

test("repo-complexity defaults maxDirs to the effectively-unlimited 1000000 ceiling", async () => {
  const src = await fs.readFile(path.join(WORKFLOWS_DIR, "repo-complexity.js"), "utf8");
  assert.match(src, /const maxDirs = .* : 1000000/, "repo-complexity must default maxDirs to 1000000");
});

// ===========================================================================
// (6) batchSize default runs all leaves in one batch
// ===========================================================================

test("meta batchSize defaults to activeDomains.length (all leaves in ONE batch)", async () => {
  const src = await fs.readFile(META_SRC, "utf8");
  // Default = activeDomains.length, so the default eight-domain run executes a single batched
  // parallel() call instead of four batches of two.
  assert.match(
    src,
    /const batchSize = Number\.isInteger\(RT\.batchSize\) && RT\.batchSize > 0 \? RT\.batchSize : activeDomains\.length/,
    "batchSize must default to activeDomains.length so all leaves run in one batch",
  );
});

test("meta maxAgents is raised to 100000 and the workflow_run maxAgents cap allows it", async () => {
  const src = await fs.readFile(META_SRC, "utf8");
  assert.match(src, /maxAgents: 100000/, "meta must declare maxAgents: 100000");
  const plugin = await fs.readFile(PLUGIN_SRC, "utf8");
  assert.match(
    plugin,
    /maxAgents: tool\.schema\.number\(\)\.int\(\)\.positive\(\)\.max\(100000\)\.optional\(\)/,
    "workflow_run schema must allow maxAgents up to 100000",
  );
});

// ===========================================================================
// (4) Empty args run all eight domains (exhaustive defaults)
// ===========================================================================

test("empty args run all eight domains under the exhaustive defaults (no silent domain loss)", async () => {
  const { env } = await runMeta({});
  // The meta completed with a valid envelope (empty is valid: the mock returns no findings).
  assert.ok(env.status === "ok" || env.status === "empty", `unexpected status: ${env.status}`);
  // All eight leaf domains ran — empty args never drops a domain.
  assert.ok(Array.isArray(env.leafOutcomes), "leafOutcomes must be present");
  assert.equal(env.leafOutcomes.length, 8, "empty args must fan out to all eight domains");
  assert.deepEqual(
    env.leafOutcomes.map((o) => o.domain).sort(),
    ["bughunt", "cleanup", "complexity", "deps", "modernize", "perf", "security", "test-gaps"],
    "the eight active domains are exactly the canonical set",
  );
  // Exhaustive mode ran the coverage auditor (the empty-args default).
  assert.ok(env.coverageAudit && typeof env.coverageAudit === "object", "exhaustive mode must run the coverage auditor");
  // The meta's exhaustive default selects thorough depth; leafArgs threads it (wiring proof above).
  const src = await fs.readFile(META_SRC, "utf8");
  assert.match(src, /exhaustive \? "thorough"/, "exhaustive mode must default to thorough depth");
});

// ===========================================================================
// (5) Unknown-only domains are rejected with a clear error
// ===========================================================================

test("unknown-only domains are rejected at plan time with a clear args-schema error", async () => {
  const { tools, context, directory } = await makeHarness(emptyFindingsRouter());
  try {
    // A domain that is not in the canonical eight is rejected BEFORE approval/execution.
    await assert.rejects(
      tools.workflow_run.execute({ name: "repo-review", args: { domains: ["definitely-not-a-domain"] } }, context),
      /args do not match meta\.argsSchema|definitely-not-a-domain|enum/i,
      "an all-unknown domains request must be rejected with a clear error, not silently fall back",
    );
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("meta source rejects all-unknown domains at runtime as defense-in-depth", async () => {
  // The schema enum is the first gate (plan time). The meta ALSO rejects explicitly at runtime
  // so a silent fall-back to ALL_DOMAINS can never recur even if the schema is bypassed.
  const src = await fs.readFile(META_SRC, "utf8");
  assert.match(
    src,
    /all requested domains are unknown/,
    "meta must throw a clear error when every supplied domain is unknown (defense-in-depth)",
  );
});
