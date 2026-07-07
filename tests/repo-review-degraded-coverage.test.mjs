// Partial-failure / degraded-coverage disclosure (bead opencode-workflows-rrev.24).
//
// Proves that degraded review output is ALWAYS disclosed so a user never mistakes
// incomplete coverage for a clean / exhaustive result (contract §17):
//   1. The META envelope discloses partial coverage when a nested leaf aborts
//      (partialCoverage: true + a non-ok leafOutcomes entry). A contrast run with all
//      leaves completing asserts partialCoverage: false, proving the flag is caused by
//      the degradation, not unconditionally set.
//   2. Coverage-aware leaves (test-gaps, perf, security, complexity) emit
//      shellCoverage: "none" + a non-empty coverageLimitations on every exit path.
//   3. Size truncation sets truncatedFindings: true while counts.total reflects the
//      FULL ranked set.
//   4. The disclosure rule is documented in the contract (source-scan).
//
// Zero-token: every child session.prompt is routed to a canned payload by the shared
// harness (tests/helpers/repo-review-leaf-harness.mjs -> harness.mjs); no real model is
// ever called. The meta router handles BOTH the meta's single shared recon prompt AND
// every nested leaf prompt (finders / skeptics + complexity's domain recon), because
// nested workflow() lanes share the parent run and route through the same mock.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  makeHarness,
  runLeafEnvelope,
  runApprovedRequest,
  resultOutput,
  makeLeafPromptRouter,
  structured,
} from "./helpers/repo-review-leaf-harness.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CONTRACT = path.join(HERE, "..", "docs", "repo-review-leaf-contract.md");

// Shared injected recon so a leaf skips self-profiling (contract §8/§14.2).
const INJECTED_RECON = { languages: ["javascript"], notes: "injected shared recon" };

// ---------------------------------------------------------------------------
// Routers
// ---------------------------------------------------------------------------

// META router: drives the meta's single shared recon + every nested leaf prompt.
//
// `forceComplexityAbort` starves repo-complexity's domain-local recon (returns no
// structured payload), so the recon lane resolves to null and complexity returns
// status:"aborted" — a realistic partial-failure injected at the meta level. This is
// the nested-mock-router pattern from the meta smoke test, extended to force one leaf
// to abort rather than complete.
function metaRoute({ forceComplexityAbort = false } = {}) {
  return function route(text, shape) {
    // META shared recon (computed exactly once).
    if (text.includes("comprehensive multi-domain review") || text.includes("Profile this repository once")) {
      return shape({ languages: ["javascript"], notes: "meta shared recon", frameworks: ["node"], packageManagers: ["npm"] });
    }
    // repo-complexity domain-local recon (always computed locally; shared recon lacks dirs).
    if (text.includes("for a complexity")) {
      // No structured payload -> getStructured returns a non-object -> schema validation
      // fails -> onFailure returnNull -> complexityRecon is null -> leaf aborts.
      if (forceComplexityAbort) return { data: { parts: [], info: {} } };
      return shape({ profile: "test repo", dirs: ["src"], gitAvailable: false });
    }
    // Skeptic verdicts (not hit with empty findings; kept for completeness).
    if (text.includes("You are a skeptic")) {
      return shape({ refuted: false, reasoning: "keep", adjustedConfidence: 80 });
    }
    // Every finder / scorer lane: empty findings.
    return shape({ findings: [] });
  };
}

// Generic leaf router for the coverage-aware domains: injected recon skips
// self-profiling, complexity's domain recon is satisfied, and every finder returns
// empty findings -> each leaf reaches its "empty" exit carrying shellCoverage +
// coverageLimitations.
function emptyCoverageRoute(text, shape) {
  if (text.includes("for a complexity")) {
    return shape({ profile: "test repo", dirs: ["src"], gitAvailable: false });
  }
  return shape({ findings: [] });
}

// repo-bughunt router for the truncation probe: each category finder returns ONE
// medium-severity finding. Quick depth verifies HIGH only, so medium findings pass
// through untouched; 7 categories -> 7 ranked findings. maxReturnFindings:1 then
// truncates the returned array while counts.total keeps the full count.
function bughuntTruncRoute(text, shape) {
  const catMatch = text.match(/You are the "([^"]+)" bug finder/);
  if (catMatch) {
    const cat = catMatch[1];
    return shape({
      findings: [{
        category: cat, file: `src/${cat}.js`, line: 10, severity: "medium",
        description: `${cat} medium bug example for truncation`,
        reproSketch: "trigger path", fixSketch: "fix sketch", proposedChange: "apply fix",
        confidence: 70, effort: "medium", docImpact: "",
      }],
    });
  }
  if (text.includes("You are a skeptic")) {
    return shape({ refuted: false, reasoning: "keep", adjustedConfidence: 70 });
  }
  return shape({ findings: [] });
}

// ---------------------------------------------------------------------------
// 1. META discloses partial coverage when a nested leaf aborts
// ---------------------------------------------------------------------------

test("meta: all leaves complete -> partialCoverage is false (contrast baseline)", async () => {
  const { tools, context, directory } = await makeHarness(
    makeLeafPromptRouter(metaRoute({ forceComplexityAbort: false }), { fallbackShape: structured }),
  );
  try {
    const out = await runApprovedRequest(tools, context, { name: "repo-review", args: { depth: "normal" } });
    const env = await resultOutput(tools, context, out);

    // No degradation -> the flag is honestly false (not unconditionally set).
    assert.equal(env.partialCoverage, false, "no degradation -> partialCoverage must be false");
    // Every domain reached an ok/empty state.
    assert.ok(Array.isArray(env.leafOutcomes) && env.leafOutcomes.length === 8, "all eight domains report");
    for (const o of env.leafOutcomes) {
      assert.ok(["ok", "empty"].includes(o.status), `baseline: leaf ${o.domain} must be ok/empty, got ${o.status}`);
    }
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("meta: a nested leaf aborts -> partialCoverage true + non-ok leafOutcome", async () => {
  const { tools, context, directory } = await makeHarness(
    makeLeafPromptRouter(metaRoute({ forceComplexityAbort: true }), { fallbackShape: structured }),
  );
  try {
    const out = await runApprovedRequest(tools, context, { name: "repo-review", args: { depth: "normal" } });
    const env = await resultOutput(tools, context, out);

    // The meta envelope carries the partial-coverage flag (the disclosure).
    assert.equal(env.partialCoverage, true, "a leaf aborted -> partialCoverage must be true");

    // The aborted domain (complexity) appears in the ledger with a NON-ok status.
    const complexity = env.leafOutcomes.find((o) => o.domain === "complexity");
    assert.ok(complexity, "complexity must appear in leafOutcomes");
    assert.notEqual(complexity.status, "ok", "aborted leaf must have a non-ok status");
    assert.ok(
      ["aborted", "failed"].includes(complexity.status),
      `expected aborted|failed, got ${complexity.status}`,
    );

    // The other seven domains still completed (ok/empty) — only complexity degraded.
    const others = env.leafOutcomes.filter((o) => o.domain !== "complexity");
    assert.equal(others.length, 7, "the other seven domains must still report");
    for (const o of others) {
      assert.ok(
        ["ok", "empty"].includes(o.status),
        `non-complexity leaf ${o.domain} should have completed, got ${o.status}`,
      );
    }
    // The run still COMPLETED (graceful partial result, not a crash); resultOutput
    // already asserted status === "completed".
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 2. Coverage-aware leaves emit shellCoverage none + non-empty coverageLimitations
// ---------------------------------------------------------------------------

const COVERAGE_AWARE_LEAVES = [
  { name: "repo-test-gaps", domain: "test-gaps" },
  { name: "repo-perf", domain: "perf" },
  { name: "repo-security-audit", domain: "security" },
  { name: "repo-complexity", domain: "complexity" },
];

for (const leaf of COVERAGE_AWARE_LEAVES) {
  test(`coverage-aware leaf ${leaf.name} emits shellCoverage "none" + non-empty coverageLimitations`, async () => {
    const { tools, context, directory } = await makeHarness(
      makeLeafPromptRouter(emptyCoverageRoute, { fallbackShape: structured }),
    );
    try {
      const env = await runLeafEnvelope(tools, context, {
        name: leaf.name,
        args: { recon: INJECTED_RECON, depth: "normal" },
      });

      assert.equal(env.shellCoverage, "none", `${leaf.name} must declare shellCoverage "none"`);
      assert.ok(
        typeof env.coverageLimitations === "string" && env.coverageLimitations.length > 0,
        `${leaf.name} must carry a non-empty coverageLimitations string`,
      );
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });
}

// ---------------------------------------------------------------------------
// 3. Size truncation sets truncatedFindings true
// ---------------------------------------------------------------------------

test("size truncation: more findings than maxReturnFindings -> truncatedFindings true, counts.total reflects full set", async () => {
  const { tools, context, directory } = await makeHarness(
    makeLeafPromptRouter(bughuntTruncRoute, { fallbackShape: structured }),
  );
  try {
    const env = await runLeafEnvelope(tools, context, {
      name: "repo-bughunt",
      args: { recon: INJECTED_RECON, depth: "quick", maxReturnFindings: 1 },
    });

    assert.equal(env.status, "ok");
    assert.equal(env.truncatedFindings, true, "findings were capped -> truncatedFindings must be true");
    assert.ok(
      env.counts.total > env.findings.length,
      "counts.total must reflect the FULL ranked set, not the truncated array",
    );
    assert.equal(env.findings.length, 1, "returned findings array is capped to maxReturnFindings");
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 4. Contract documents the degraded-coverage disclosure rule (source-scan)
// ---------------------------------------------------------------------------

test("contract: the partial-failure / degraded-coverage disclosure section exists", async () => {
  const src = await fs.readFile(CONTRACT, "utf8");
  assert.match(src, /Partial-failure \/ degraded-coverage disclosure/i, "contract must have the disclosure section heading");
  // The three degradation signals are each named as disclosure requirements.
  assert.match(src, /partialCoverage/, "contract must name the meta partialCoverage flag");
  assert.match(src, /shellCoverage/, "contract must name the leaf shellCoverage field");
  assert.match(src, /coverageLimitations/, "contract must name the leaf coverageLimitations field");
  assert.match(src, /truncatedFindings/, "contract must name the truncation flag");
  // The "never mistake for exhaustive coverage" rule.
  assert.match(src, /never be mistaken for exhaustive coverage/i, "contract must state the no-mistake rule");
});
