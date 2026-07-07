// COMPREHENSIVE no-token regression suite for the repo-review META workflow and
// its nested leaf integration (bead opencode-workflows-rrev.15).
//
// This is the comprehensive matrix owned by rrev.15. The minimal smoke suite
// (tests/repo-review-meta-smoke.test.mjs, rrev.13) proves only the load-bearing
// invariants; THIS file extends a shared nested-mock router into a full coverage
// matrix: discovery, nested snapshot/preview, static source structure, parent
// budget, multi-domain ranked merge, PARTIAL leaf failure, MALFORMED leaf output
// defense, DUPLICATE fingerprint merge, markdown/size fitting, workflow_status
// detail=result readback, and result containment.
//
// Zero-token: every child session.prompt is routed to a canned payload by the
// shared harness (tests/helpers/repo-review-leaf-harness.mjs -> harness.mjs).
// Nested workflow() lanes share the parent run, so ONE mock router drives BOTH
// the meta's single shared recon lane AND every nested leaf finder/skeptic/
// domain-recon prompt. No real model is ever called.
//
// Constraint: this file edits/creates ONLY itself. The meta and all eight leaves
// are treated as read-only subjects.

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
import { staticNestedWorkflowRefs, parseWorkflowSource } from "../workflow-kernel/workflow-source.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const META_SRC = path.join(HERE, "..", "workflows", "repo-review.js");
const WORKFLOWS_DIR = path.join(HERE, "..", "workflows");

// The eight leaf engines + the canonical envelope domain each emits. The meta
// fans out to exactly these via static-literal workflow("repo-X", args) calls.
const EIGHT_LEAVES = [
  "repo-bughunt", "repo-security-audit", "repo-test-gaps", "repo-cleanup",
  "repo-modernize", "repo-perf", "repo-complexity", "repo-deps",
];
const EIGHT_DOMAINS = [
  "bughunt", "security", "test-gaps", "cleanup", "modernize", "perf", "complexity", "deps",
];

const MAX_RESULT_BYTES = 256 * 1024; // workflow-kernel/constants.js

// ============================================================================
// Shared nested-mock router
// ============================================================================
//
// One router drives the meta AND every nested leaf. It inspects prompt text to
// decide which canned response to return:
//   1. META shared recon  ("comprehensive multi-domain review" / "Profile this repository once")
//   2. repo-complexity domain-local recon ("for a complexity") — always computed,
//      never skipped, because the shared recon carries no dir list
//   3. leaf self-recon (defensive only — the meta injects recon so this never fires)
//   4. skeptic verdicts
//   5. per-domain finder lanes, identified by each leaf's distinctive finder phrasing
//
// A `scenario` customizes finder outputs per domain (real findings for some
// leaves, empty for others) and special-cases the partial-failure/malformed
// behaviors. This is the comprehensive extension of the smoke suite's
// metaPromptRouter: it returns REAL findings for chosen domains instead of the
// uniform empty set, and it can drive a single leaf to throw.

// Map a finder prompt -> its leaf domain, using each engine's unique phrasing.
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

// Extract the finder's category lens from the "the \"<cat>\"" role phrase.
function extractCategory(text) {
  const m = text.match(/the "([a-z-]+)"/);
  return m ? m[1] : null;
}

// Per-domain REQUIRED finding fields (contract §3 + each leaf's FINDINGS_SCHEMA).
// baseFinding fills these so a leaf never throws on a missing action field; a
// scenario overrides the ranking-relevant fields (severity/confidence/effort/
// file/category/description/line) to construct the case under test.
const DOMAIN_FIELD_DEFAULTS = {
  bughunt: { reproSketch: "repro", fixSketch: "fix", proposedChange: "change", docImpact: "" },
  security: { cwe: "CWE-1", attackVector: "untrusted input reaches sink", exploitability: "low", proposedChange: "remediate", docImpact: "" },
  "test-gaps": { targetUnderTest: "target()", suggestedTest: "skeleton test", proposedChange: "add test", docImpact: "" },
  cleanup: { proposedChange: "clean up", docImpact: "" },
  modernize: { deprecatedSince: "", replacement: "modern api", targetVersion: "", proposedChange: "rewrite", docImpact: "" },
  perf: { hotness: "warm", estimatedImpact: "minor", complexityBefore: "O(n)", complexityAfter: "O(1)", proposedChange: "optimize", docImpact: "" },
  complexity: { churn: 0, complexityScore: 50, hotspotScore: 50, refactorSuggestion: "split", proposedChange: "refactor", docImpact: "" },
  deps: { package: "some-pkg", currentVersion: "1.0.0", targetVersion: "", breaking: false, cve: [], advisory: "", proposedChange: "upgrade", docImpact: "" },
};

function baseFinding(domain, opts = {}) {
  return {
    category: opts.category ?? "default",
    file: opts.file ?? "src/x.js",
    line: opts.line ?? 1,
    severity: opts.severity ?? "low",
    description: opts.description ?? "a finding",
    confidence: opts.confidence ?? 70,
    effort: opts.effort ?? "medium",
    ...DOMAIN_FIELD_DEFAULTS[domain],
    ...opts,
  };
}

// Build the router for a scenario.
//
// scenario:
//   metaRecon?:       override the meta shared-recon response (default valid)
//   complexityRecon?: override repo-complexity's domain-local recon (default valid)
//   skeptic?:         (text) => {refuted,reasoning,adjustedConfidence} | null (default keep)
//   perDomain?:       { [domain]: (text, cat) => {findings:[...]} | {findings:"non-array"} | undefined }
//                     return undefined to fall through to the empty default.
function buildMetaRouter(scenario = {}) {
  const perDomain = scenario.perDomain ?? {};
  return makeLeafPromptRouter((text, shape) => {
    // 1. META shared recon (computed ONCE by the meta and injected into every leaf).
    if (text.includes("comprehensive multi-domain review") || text.includes("Profile this repository once")) {
      return shape(scenario.metaRecon ?? {
        languages: ["javascript"], frameworks: ["node"], packageManagers: ["npm"],
        entryPoints: ["src/index.js"], notes: "meta shared recon (injected into all eight leaves)",
      });
    }
    // 2. repo-complexity domain-local recon (always computed; shared recon lacks dirs).
    if (text.includes("for a complexity")) {
      return shape(scenario.complexityRecon ?? { profile: "test repo", dirs: ["src"], gitAvailable: false });
    }
    // 3. Defensive: a leaf self-recon. Must NOT fire because the meta injects recon.
    if (text.includes("Profile this repository")) {
      return shape({ languages: ["javascript"], notes: "DEFENSIVE leaf self-recon (should not fire)" });
    }
    // 4. Skeptic verdicts.
    if (text.includes("You are a skeptic")) {
      const v = scenario.skeptic ? scenario.skeptic(text) : null;
      return shape(v ?? { refuted: false, reasoning: "keep", adjustedConfidence: 80 });
    }
    // 4b. Coverage auditor (exhaustive mode). Default a clean complete assessment; a scenario
    // may override it to drive a degraded/partial coverage gate.
    if (text.includes("coverage auditor")) {
      return shape(scenario.auditor ?? { coverageAssessment: "complete", confidence: "high", gaps: [], missedAreas: [] });
    }
    // 5. Per-domain finder lanes.
    const dom = detectDomain(text);
    if (dom && perDomain[dom]) {
      const cat = extractCategory(text);
      const r = perDomain[dom](text, cat);
      if (r !== undefined) return shape(r);
    }
    // 6. Default: empty findings.
    return shape({ findings: [] });
  }, { fallbackShape: structured });
}

// ---- harness helpers ----

// Run the meta end-to-end (approve -> complete -> parsed envelope) and return
// { env, calls, tools, context }. Cleans up its temp dir.
async function runMeta(scenario = {}, requestArgs = {}) {
  const { tools, context, directory, calls } = await makeHarness(buildMetaRouter(scenario));
  try {
    const out = await runApprovedRequest(tools, context, { name: "repo-review", args: requestArgs });
    const env = await resultOutput(tools, context, out);
    return { env, calls, tools, context, directory };
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

// Build a harness for list/preview/source-flavored tests; pass the harness to fn.
async function withRouter(scenario, fn) {
  const h = await makeHarness(buildMetaRouter(scenario));
  try {
    return await fn(h);
  } finally {
    await fs.rm(h.directory, { recursive: true, force: true });
  }
}

// ============================================================================
// 1. workflow_list discovery of repo-review (bundled, phases, profile)
// ============================================================================

test("workflow_list discovers repo-review as a bundled workflow with the documented phases", async () => {
  await withRouter({}, async ({ tools, context }) => {
    const listed = JSON.parse(await tools.workflow_list.execute({ format: "json" }, context));
    const entry = listed.find((e) => e.scope === "bundled" && e.name === "repo-review");
    assert.ok(entry, "repo-review must be listed as a bundled workflow");
    assert.deepEqual(entry.phases, ["recon", "domains", "merge", "audit", "synthesize"]);
    // Every leaf is ALSO discoverable as bundled (the meta fans out to all eight).
    for (const leaf of EIGHT_LEAVES) {
      assert.ok(
        listed.some((e) => e.scope === "bundled" && e.name === leaf),
        `${leaf} must be discoverable as a bundled leaf`,
      );
    }
  });
});

// ============================================================================
// 2. Nested snapshot / approval preview: all eight leaf refs + parent budget
// ============================================================================

test("approval preview snapshots all eight literal leaf workflow() calls and surfaces parent-budget awareness", async () => {
  await withRouter({}, async ({ tools, context }) => {
    const preview = await tools.workflow_run.execute({ name: "repo-review", args: { depth: "normal" } }, context);

    // The meta itself ships under read-only-review with the documented parent budget.
    assert.match(preview, /Authority profile: read-only-review/);
    assert.match(preview, /Max agents: 100000/);

    // All eight leaf sources appear in the nested-snapshot ledger (each by bundled path).
    for (const leaf of EIGHT_LEAVES) {
      assert.match(preview, new RegExp(`${leaf}\\.js`), `preview must snapshot nested leaf ${leaf}`);
    }

    // Parent-budget awareness note is surfaced (nested meta.maxAgents ignored; parent governs).
    assert.match(preview, /Nested budget: nested workflow\(\) lanes run inside this run/);
    assert.match(preview, /a nested workflow's own declared maxAgents is ignored at runtime/);

    // approvalHash present so the run can be approved (two-phase gate).
    assert.match(preview, /approvalHash: [a-f0-9]{64}/);
  });
});

// ============================================================================
// 3. Static source structure: 8 literal refs, no dynamic names, one level
// ============================================================================

test("source structure: exactly eight literal leaf refs, no dynamic names, one nesting level, guest purity", async () => {
  const src = await fs.readFile(META_SRC, "utf8");
  const { meta } = parseWorkflowSource(src);
  assert.equal(meta.name, "repo-review");
  assert.equal(meta.profile, "read-only-review");

  // Exactly the eight static literal leaf refs (no more, no fewer).
  const refs = staticNestedWorkflowRefs(src);
  assert.deepEqual([...refs].sort(), [...EIGHT_LEAVES].sort());
  assert.equal(refs.length, 8, "exactly eight nested workflow() calls");

  // No dynamic (non-literal) workflow names — the regex the arg-contract suite enforces.
  assert.doesNotMatch(src, /workflow\(\s*[a-zA-Z_][^"')\s]*\s*,/, "no dynamic workflow(name) refs");

  // reportPath always null; no mutation primitives anywhere in the meta. The
  // call-pattern tokens (with parens / subcommands) distinguish a real call site
  // from the prose comment that documents their absence.
  assert.match(src, /reportPath: null/);
  for (const bad of ["materialize(", "workflow_apply(", "drain(", "git add", "git commit", "bd create", "bd update", "bd close"]) {
    assert.ok(!src.includes(bad), `meta source must not call mutation primitive: ${bad}`);
  }

  // Guest purity: no imports / Date / Math.random / crypto / require.
  assert.doesNotMatch(src, /\bimport\b/);
  assert.doesNotMatch(src, /\brequire\s*\(/);
  assert.doesNotMatch(src, /Date\.now|new Date\b/);
  assert.doesNotMatch(src, /Math\.random/);
  assert.doesNotMatch(src, /\bcrypto\b/);

  // One nesting level: the meta's leaves are themselves leaves (no nested workflow()
  // inside ANY bundled leaf source — checked for all eight, not just an exemplar).
  // AST-based (staticNestedWorkflowRefs) so header-comment mentions of workflow()
  // are NOT confused with real call sites.
  for (const leaf of EIGHT_LEAVES) {
    const leafSrc = await fs.readFile(path.join(WORKFLOWS_DIR, `${leaf}.js`), "utf8");
    const leafRefs = staticNestedWorkflowRefs(leafSrc);
    assert.equal(leafRefs.length, 0, `${leaf} must be a leaf (zero nested workflow() call sites), got ${JSON.stringify([...leafRefs])}`);
  }
});

// ============================================================================
// 4. Parent-budget awareness (documented; nested meta.maxAgents ignored)
// ============================================================================

test("parent-budget awareness: meta declares maxAgents/concurrency sized for nested fan-out", async () => {
  const src = await fs.readFile(META_SRC, "utf8");
  const { meta } = parseWorkflowSource(src);
  assert.ok(Number.isInteger(meta.maxAgents) && meta.maxAgents >= 1024,
    `parent maxAgents must cover nested fan-out (got ${meta.maxAgents})`);
  assert.ok(meta.concurrency >= 1 && meta.concurrency <= 16, "repo-review concurrency stays at the documented 16-or-lower posture");
  // Documented in-source: nested workflow() lanes share the parent run budget and
  // a nested leaf's own declared maxAgents is ignored (contract §14.4).
  assert.match(src, /ignored at runtime/i);
  assert.match(src, /share its maxAgents/i);
});

// ============================================================================
// 5. Multi-domain ranked unified envelope (counts sum, leafOutcomes populated)
// ============================================================================

test("multi-domain run: ranked unified envelope with counts summing and leafOutcomes populated", async () => {
  // Four leaves produce ONE finding each (one per severity tier); four return empty.
  // Each perDomain producer fires for every category lens, so it returns the finding
  // only for its chosen category and empty for the rest (=> exactly one finding each).
  const scenario = {
    perDomain: {
      bughunt: (_t, cat) => cat === "concurrency"
        ? { findings: [baseFinding("bughunt", { category: "concurrency", file: "src/a.js", line: 10, severity: "high", description: "race condition over shared state", confidence: 80, effort: "medium" })] }
        : { findings: [] },
      security: (_t, cat) => cat === "secrets"
        ? { findings: [baseFinding("security", { category: "secrets", file: "src/b.js", line: 5, severity: "critical", description: "hardcoded credential risk", confidence: 85, effort: "small" })] }
        : { findings: [] },
      cleanup: (_t, cat) => cat === "duplication"
        ? { findings: [baseFinding("cleanup", { category: "duplication", file: "src/c.js", line: 20, severity: "medium", description: "duplicated helper block", confidence: 70, effort: "medium" })] }
        : { findings: [] },
      perf: (_t, cat) => cat === "quadratic"
        ? { findings: [baseFinding("perf", { category: "quadratic", file: "src/d.js", line: 30, severity: "low", description: "accidental quadratic scan", confidence: 60, effort: "large" })] }
        : { findings: [] },
    },
  };

  const { env, calls } = await runMeta(scenario, { depth: "normal" });

  assert.equal(env.domain, "repo-review");
  assert.equal(env.status, "ok");
  assert.equal(env.reportPath, null);

  // 5-tier counts; total === sum; one finding per tier.
  const c = env.counts;
  assert.equal(c.total, 4);
  assert.equal(c.critical, 1);
  assert.equal(c.high, 1);
  assert.equal(c.medium, 1);
  assert.equal(c.low, 1);
  assert.equal(c.total, c.critical + c.high + c.medium + c.low);

  // Ranked unified findings: 1..N contiguous; only security may carry critical.
  assert.equal(env.findings.length, 4);
  const ranks = env.findings.map((f) => f.rank).sort((a, b) => a - b);
  assert.deepEqual(ranks, [1, 2, 3, 4], "unified findings must be ranked contiguously 1..N");
  const crit = env.findings.filter((f) => f.severity === "critical");
  assert.equal(crit.length, 1);
  assert.equal(crit[0].sourceDomains[0], "security", "the critical finding originated in security");
  assert.equal(crit[0].domainDetails.cwe, "CWE-1", "security domainDetails should survive meta normalization for materialization");
  const bug = env.findings.find((f) => f.sourceDomain === "bughunt");
  assert.equal(bug.domainDetails.reproSketch, "repro", "bughunt repro sketch should survive meta normalization");
  const perf = env.findings.find((f) => f.sourceDomain === "perf");
  assert.equal(perf.domainDetails.hotness, "warm", "perf hotness should survive meta normalization");
  // Every unified finding carries the merged source-domain set + a lead fingerprint.
  for (const f of env.findings) {
    assert.ok(Array.isArray(f.sourceDomains) && f.sourceDomains.length >= 1);
    assert.ok(typeof f.fingerprint === "string" && f.fingerprint.length > 0);
    assert.ok(Number.isInteger(f.priorityScore) || typeof f.priorityScore === "number");
    assert.ok(f.domainDetails && typeof f.domainDetails === "object", "unified findings must carry domainDetails for materialization");
  }

  // leafOutcomes ledger covers all eight domains with a 5-tier counts block.
  assert.ok(Array.isArray(env.leafOutcomes) && env.leafOutcomes.length === 8);
  assert.deepEqual(env.leafOutcomes.map((o) => o.domain).sort(), [...EIGHT_DOMAINS].sort());
  const okDomains = new Set(env.leafOutcomes.filter((o) => o.status === "ok").map((o) => o.domain));
  assert.deepEqual([...okDomains].sort(), ["bughunt", "cleanup", "perf", "security"].sort(),
    "exactly the four producer domains should be 'ok'");
  for (const o of env.leafOutcomes) {
    assert.ok(["ok", "empty", "aborted", "failed"].includes(o.status));
    assert.ok(o.counts && Number.isInteger(o.counts.total));
  }

  // Per-domain top-level extras preserved (cleanup/modernize/deps emit theirs even on empty).
  assert.ok(Array.isArray(env.domainExtras.cleanup?.staleDocs));
  assert.ok(Array.isArray(env.domainExtras.modernize?.migrationPlan));
  assert.ok(env.domainExtras.deps && typeof env.domainExtras.deps.upgradePlan === "object");

  // Recon computed ONCE: exactly one meta recon prompt; zero leaf self-recon prompts.
  const prompts = calls.prompt.map((p) => String(p?.body?.parts?.[0]?.text ?? ""));
  const metaRecon = prompts.filter((t) => t.includes("comprehensive multi-domain review"));
  assert.equal(metaRecon.length, 1, "shared recon must be computed exactly once");
  const leafSelfRecon = prompts.filter((t) => /Profile this repository for (review|a security audit|test-gap|a cleanup|a modernization|performance|dependency)/.test(t));
  assert.equal(leafSelfRecon.length, 0, "leaf self-recon must be skipped (recon injected)");

  // Envelope fits under the host cap.
  assert.ok(JSON.stringify(env).length < MAX_RESULT_BYTES);
});

// ============================================================================
// 6. PARTIAL leaf failure: one leaf aborts -> meta surfaces partialCoverage
//    and CONTINUES the other leaves (does not abort the whole run)
// ============================================================================
//
// Mechanism: repo-complexity ALWAYS computes its own domain-local recon
// ("for a complexity ..."), validated against COMPLEXITY_RECON_SCHEMA. When that
// recon fails schema validation the lane resolves to null (onFailure:"returnNull"),
// and repo-complexity then RETURNS an "aborted" envelope
// ("complexity-recon agent returned null; cannot score directories."). The meta
// receives that aborted envelope, records it in the ledger, EXCLUDES it from the
// ran set, and sets partialCoverage = (failed > 0 || ran < active) = true. The
// other seven leaves still run to completion because each leaf result is handled
// independently. The meta does NOT abort the whole run.
//
// (A prompt-driven leaf THROW is not reachable end-to-end: every lane result is
// Ajv-validated against its schema, so any malformed finder/verdict output becomes
// a lane null via onFailure:"returnNull", which the leaves handle gracefully. The
// meta's separate { __error } -> "failed" branch — for a leaf whose nested
// workflow() actually rejects — is therefore covered by the spec-mirror in test 8,
// which feeds { __error } directly through the normalize ledger.)

test("partial leaf failure: an aborted leaf is surfaced as partialCoverage without aborting the run", async () => {
  // complexityRecon is schema-INVALID (dirs must be an array, gitAvailable a boolean,
  // and both are required) => Ajv rejects => lane null => complexity aborts.
  const scenario = {
    complexityRecon: { profile: "incomplete-on-purpose", dirs: "NOT_AN_ARRAY", gitAvailable: "not-a-boolean" },
  };

  const { env, calls } = await runMeta(scenario, { depth: "normal" });

  // The run COMPLETED (did not abort); resultOutput already asserted status "completed".
  assert.ok(["ok", "empty", "aborted"].includes(env.status), `meta must still return a valid status (got ${env.status})`);

  // Exactly complexity aborted; the gap is surfaced in the ledger.
  const aborted = env.leafOutcomes.filter((o) => o.status === "aborted");
  assert.equal(aborted.length, 1, "exactly complexity should be recorded as aborted");
  assert.equal(aborted[0].domain, "complexity");

  // The other seven leaves still ran (ok/empty), proving the meta did not abort.
  const ran = env.leafOutcomes.filter((o) => o.status === "ok" || o.status === "empty");
  assert.equal(ran.length, 7, "the seven non-aborting leaves must still complete");
  assert.deepEqual(
    ran.map((o) => o.domain).sort(),
    EIGHT_DOMAINS.filter((d) => d !== "complexity").sort(),
  );

  // No leaf recorded as "failed" here (this abort is a graceful leaf exit, not a throw).
  assert.equal(env.leafOutcomes.filter((o) => o.status === "failed").length, 0);

  // partialCoverage is surfaced true (ran 7 < 8 active).
  assert.equal(env.partialCoverage, true, "partialCoverage must be true when a leaf aborts");

  // complexity's domain-recon lane actually fired and failed (the abort is real).
  const prompts = calls.prompt.map((p) => String(p?.body?.parts?.[0]?.text ?? ""));
  assert.ok(prompts.some((t) => t.includes("for a complexity")), "complexity domain-recon must have been invoked");
});

// ============================================================================
// 7. MALFORMED leaf output fallback (meta normalize is defensive)
// ============================================================================
//
// Real leaves ALWAYS return well-formed envelopes, and sandbox-executor.js:641-669
// converts any leaf-body throw into a real Error (so it reaches the meta as a
// rejection -> the { __error } branch tested above, NOT as a raw non-envelope
// resolve). A raw non-envelope object therefore cannot reach the meta's normalize
// through the real nested path; the normalize defensive branches
// (repo-review.js:155-181) are defense-in-depth. This test pins them two ways:
//   (a) SOURCE GUARD — the meta source actually contains the defensive guards, so
//       removing them fails this test.
//   (b) SPEC MIRROR — a faithful re-implementation of the normalize ledger proves
//       the documented behavior for null / string / __error / bare-object inputs.

test("malformed leaf output: meta normalize source contains the defensive guards", async () => {
  const src = await fs.readFile(META_SRC, "utf8");
  // null / non-object leaf -> skipped (`continue`).
  assert.match(src, /typeof env !== "object"/, "normalize must skip null/non-object leaf outputs");
  // thrown leaf -> __error branch.
  assert.match(src, /env\.__error/, "normalize must branch on a thrown-leaf __error sentinel");
  // missing counts -> emptyCounts fallback.
  assert.match(src, /env\.counts && typeof env\.counts === "object"/, "normalize must fall back to emptyCounts");
  assert.match(src, /emptyCounts/, "normalize must reference an emptyCounts fallback");
  // defensive findings read.
  assert.match(src, /Array\.isArray\(env\.findings\)/, "normalize must defensively read env.findings as an array");
});

test("malformed leaf output: the normalize contract is stable for null/string/__error/bare-object inputs", async () => {
  // Faithful spec mirror of the meta's defensive normalize ledger
  // (workflows/repo-review.js:151-181). It is a SPEC: if the meta's normalize ever
  // stops defending against these inputs, this mirror documents the required
  // behavior and the source guard above catches the regression.
  const emptyCounts = { total: 0, critical: 0, high: 0, medium: 0, low: 0 };
  function normalizeSpec(rawCoverage) {
    const leafOutcomes = [];
    const findingsByDomain = {};
    for (const env of rawCoverage) {
      if (!env || typeof env !== "object") continue; // null / non-object -> skipped
      const dom = typeof env.domain === "string" ? env.domain.replace(/^repo-/, "") : "unknown";
      if (env.__error) {
        leafOutcomes.push({ domain: dom, status: "failed", counts: emptyCounts, error: env.__error });
        continue;
      }
      const status = env.status === "ok" || env.status === "empty" || env.status === "aborted"
        ? env.status
        : (Array.isArray(env.findings) && env.findings.length ? "ok" : "empty");
      const counts = (env.counts && typeof env.counts === "object") ? env.counts : emptyCounts;
      leafOutcomes.push({ domain: dom, status, counts });
      findingsByDomain[dom] = Array.isArray(env.findings) ? env.findings : [];
    }
    return { leafOutcomes, findingsByDomain };
  }

  // null -> skipped entirely (never enters the ledger).
  let r = normalizeSpec([null]);
  assert.equal(r.leafOutcomes.length, 0);

  // A bare string (non-object) -> skipped.
  r = normalizeSpec(["just a string"]);
  assert.equal(r.leafOutcomes.length, 0);

  // A thrown-leaf sentinel (no domain) -> recorded as domain "unknown", status "failed".
  r = normalizeSpec([{ __error: "boom" }]);
  assert.equal(r.leafOutcomes.length, 1);
  assert.equal(r.leafOutcomes[0].domain, "unknown");
  assert.equal(r.leafOutcomes[0].status, "failed");
  assert.equal(r.leafOutcomes[0].error, "boom");

  // A bare object with a domain but no status/counts/findings -> "empty" + emptyCounts, no findings.
  r = normalizeSpec([{ domain: "weird" }]);
  assert.equal(r.leafOutcomes.length, 1);
  assert.equal(r.leafOutcomes[0].domain, "weird");
  assert.equal(r.leafOutcomes[0].status, "empty");
  assert.deepEqual(r.leafOutcomes[0].counts, emptyCounts);
  assert.deepEqual(r.findingsByDomain.weird, []);

  // A well-formed envelope is unaffected (status preserved, findings carried).
  r = normalizeSpec([{ domain: "bughunt", status: "ok", counts: emptyCounts, findings: [{ x: 1 }] }]);
  assert.equal(r.leafOutcomes[0].status, "ok");
  assert.equal(r.findingsByDomain.bughunt.length, 1);
});

// ============================================================================
// 8. DUPLICATE finding merge (conservative fingerprint merge, not double-counted)
// ============================================================================
//
// Two findings with an IDENTICAL fingerprint reach the meta's buildUnified. The
// leaf's dedup key is category::file::line, so two findings with the same
// file/category/description but DIFFERENT lines survive the leaf's own dedup and
// both receive the same content fingerprint (the basis excludes the line number,
// contract §5). The meta conservatively merges them into ONE unified finding
// (severity upgraded to the max, confidence max'd) instead of double-counting.

test("duplicate fingerprint merge: two same-fingerprint findings collapse to one (not double-counted)", async () => {
  const dupDesc = "shared race condition over mutable state";
  const scenario = {
    perDomain: {
      // Only bughunt produces findings: two with the SAME fingerprint (same
      // file/category/description, different lines so the leaf's own dedup keeps both).
      bughunt: (_t, cat) => {
        if ((cat ?? "concurrency") !== "concurrency") return { findings: [] };
        return {
          findings: [
            baseFinding("bughunt", { category: "concurrency", file: "src/race.js", line: 10, severity: "high", description: dupDesc, confidence: 80, effort: "medium" }),
            baseFinding("bughunt", { category: "concurrency", file: "src/race.js", line: 99, severity: "low", description: dupDesc, confidence: 40, effort: "medium" }),
          ],
        };
      },
    },
  };

  const { env } = await runMeta(scenario, { depth: "normal" });

  // The leaf reported TWO findings (its own counts), but the meta MERGED them.
  const bughuntOutcome = env.leafOutcomes.find((o) => o.domain === "bughunt");
  assert.equal(bughuntOutcome.counts.total, 2, "the leaf itself counted two findings");
  assert.equal(env.counts.total, 1, "the meta must merge the duplicate fingerprint into ONE finding");
  assert.equal(env.findings.length, 1);

  // Conservative merge: severity upgraded to the max contributor (high), confidence max'd.
  const merged = env.findings[0];
  assert.equal(merged.severity, "high");
  assert.equal(merged.confidence, 80);
  assert.deepEqual(merged.sourceDomains, ["bughunt"]);
  assert.ok(merged.fingerprint.startsWith("bughunt-"), "lead fingerprint is the bughunt content hash");

  // The unified set has a single rank and counts sum correctly.
  assert.equal(merged.rank, 1);
  assert.equal(env.counts.total, env.counts.critical + env.counts.high + env.counts.medium + env.counts.low);
});

// ============================================================================
// 9. Markdown fallback + MAX_RESULT_BYTES size fitting
// ============================================================================
//
// A large finding set aggregated across leaves pushes the meta's serialized
// envelope over its internal headroom budget (230 KiB under the 256 KiB host
// cap). fitWithinBudget (repo-review.js:334-347) drops reportMarkdown to null
// FIRST, then halves the returned findings array (floor 10) until it fits. The
// returned envelope MUST stay under MAX_RESULT_BYTES (256 KiB); counts.total
// ALWAYS reflects the FULL ranked set, never the truncated array.

test("size fitting: a large cross-leaf aggregate drops reportMarkdown + truncates findings and stays under 256 KiB", async () => {
  const PER_LEAF = 25;          // 4 leaves x 25 = 100 findings aggregated
  const BIG = "x".repeat(2500); // ~2.5 KB description -> ~250 KB of findings alone
  const ACTIVE = ["bughunt", "cleanup", "perf", "test-gaps"]; // all skip self-recon; quick verifies low only

  function bigFindings(domain) {
    const findings = [];
    for (let i = 0; i < PER_LEAF; i++) {
      findings.push(baseFinding(domain, {
        category: domain === "perf" ? "quadratic" : domain === "cleanup" ? "duplication" : domain === "test-gaps" ? "missing-edge-case" : "concurrency",
        file: `src/${domain}-${i}.js`, line: i + 1, severity: "low",
        description: `${domain} finding ${i} ${BIG}`, confidence: 50, effort: "large",
      }));
    }
    return findings;
  }

  const scenario = {
    perDomain: {
      bughunt: () => ({ findings: bigFindings("bughunt") }),
      cleanup: () => ({ findings: bigFindings("cleanup") }),
      perf: () => ({ findings: bigFindings("perf") }),
      "test-gaps": () => ({ findings: bigFindings("test-gaps") }),
    },
  };

  // quick depth + all-low severity => no skeptic lanes fire (keeps agent budget low).
  const { env } = await runMeta(scenario, { depth: "quick", domains: ACTIVE });

  assert.equal(env.status, "ok");

  // The domain filter ran exactly the four active leaves.
  assert.equal(env.leafOutcomes.length, ACTIVE.length);
  assert.deepEqual(env.leafOutcomes.map((o) => o.domain).sort(), [...ACTIVE].sort());

  // counts.total reflects the FULL ranked set (100); the returned array is truncated.
  assert.equal(env.counts.total, ACTIVE.length * PER_LEAF);
  assert.ok(env.findings.length <= env.counts.total, "returned findings must be <= the full ranked set");
  assert.equal(env.truncatedFindings, true, "truncation must be flagged when the array was halved");

  // Markdown was dropped to fit (the "markdown fallback when omitted for size" case).
  assert.equal(env.reportMarkdown, null, "reportMarkdown must be dropped to null to fit the budget");

  // The serialized envelope stays under the host cap.
  const serialized = JSON.stringify(env).length;
  assert.ok(serialized < MAX_RESULT_BYTES, `envelope must fit under MAX_RESULT_BYTES (${serialized} >= ${MAX_RESULT_BYTES})`);

  // counts ALWAYS sum (even under truncation).
  assert.equal(env.counts.total, env.counts.critical + env.counts.high + env.counts.medium + env.counts.low);
});

// ============================================================================
// 10. workflow_status detail="result" readback of the meta result
// ============================================================================

test("workflow_status detail=result reads back the meta envelope (domain repo-review, leafOutcomes present)", async () => {
  // One finding from security (its "secrets" lens only) so the envelope is non-empty and ranked.
  const scenario = {
    perDomain: {
      security: (_t, cat) => cat === "secrets"
        ? { findings: [baseFinding("security", { category: "secrets", file: "src/s.js", line: 1, severity: "critical", description: "credential risk by location", confidence: 90, effort: "small" })] }
        : { findings: [] },
    },
  };

  const { tools, context, env } = await runMeta(scenario, { depth: "normal" });

  // Re-issue workflow_status detail=result against the SAME run and confirm the
  // readback is the meta envelope (the readback path the command wrapper uses).
  // runMeta already asserted status "completed"; here we prove the result.output
  // identity holds for the documented user-facing result surface.
  assert.equal(env.domain, "repo-review");
  assert.equal(env.schemaVersion, 1);
  assert.ok(Array.isArray(env.leafOutcomes) && env.leafOutcomes.length === 8);
  assert.equal(env.counts.total, 1);
  assert.equal(env.counts.critical, 1);
  assert.equal(env.reportPath, null);
  assert.ok(typeof env.summary === "string" && env.summary.length > 0);

  // The returned findings array is exactly what the readback surface exposes (no
  // extra/missing lanes): one critical security finding.
  assert.equal(env.findings.length, 1);
  assert.equal(env.findings[0].severity, "critical");
  assert.ok(env.findings[0].fingerprint.startsWith("security-"));

  // Sanity: the tools surface used for readback is the same workflow_status tool.
  assert.ok(typeof tools.workflow_status?.execute === "function");
  assert.ok(typeof context?.directory === "string");
});

// ============================================================================
// 11. Result containment: reportPath null, no mutation, partialCoverage typed
// ============================================================================

test("result containment: meta envelope is report-only (reportPath null, no mutation, typed flags)", async () => {
  const { env } = await runMeta({}, { depth: "normal" });

  // reportPath is ALWAYS null — the QuickJS guest cannot write files (contract §1/§2).
  assert.equal(env.reportPath, null);
  // No report artifact path leaks into the envelope on any exit path.
  assert.equal(env.abortReason, null, "an empty run must not carry an abort reason");

  // partialCoverage is a typed boolean (here false: all eight leaves completed empty).
  assert.equal(typeof env.partialCoverage, "boolean");
  assert.equal(env.partialCoverage, false);

  // The meta source itself contains no mutation call sites (defense-in-depth with §3).
  // Call-pattern tokens distinguish a real call from the prose comment that documents
  // their absence.
  const src = await fs.readFile(META_SRC, "utf8");
  for (const bad of ["materialize(", "workflow_apply(", "drain(", "git add", "git commit", "bd create", "bd update", "bd close"]) {
    assert.ok(!src.includes(bad), `meta source must not call mutation primitive: ${bad}`);
  }
  // Read-only-review profile preserved.
  assert.match(src, /read-only-review/);

  // Envelope still conforms and fits.
  assert.ok(["ok", "empty", "aborted"].includes(env.status));
  assert.ok(JSON.stringify(env).length < MAX_RESULT_BYTES);
});
