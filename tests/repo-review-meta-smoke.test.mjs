// MINIMAL smoke test for the repo-review meta workflow (bead opencode-workflows-rrev.13).
//
// This is intentionally NOT the comprehensive meta regression matrix — that suite
// (tests/repo-review-meta.test.mjs) plus its focused npm script are owned by bead
// rrev.15, which depends on this one. Here we prove only the meta's load-bearing
// invariants: bundled discovery, the approval preview snapshots all eight literal
// leaf workflow() calls, static source structure (no dynamic names, one level,
// reportPath null), ONE minimal end-to-end run that returns a valid unified envelope,
// and parent-budget awareness.
//
// Zero-token: every child session.prompt is routed to a canned payload by the shared
// harness (tests/helpers/repo-review-leaf-harness.mjs -> harness.mjs); no real model
// is ever called. The router handles BOTH the meta's single shared recon prompt AND
// every nested leaf prompt (finders/skeptics + complexity's domain recon), because
// nested workflow() lanes share the parent run and route through the same mock.

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

// The eight leaf names the meta fans out to via static literals.
const EIGHT_LEAVES = [
  "repo-bughunt", "repo-security-audit", "repo-test-gaps", "repo-cleanup",
  "repo-modernize", "repo-perf", "repo-complexity", "repo-deps",
];
// The canonical DOMAIN each leaf emits in its envelope (note: repo-security-audit -> "security").
const EIGHT_DOMAINS = [
  "bughunt", "security", "test-gaps", "cleanup", "modernize", "perf", "complexity", "deps",
];

// One router drives both the meta and all nested leaves. The meta injects recon into
// every leaf, so leaf self-recon is skipped; only the META recon + complexity's domain
// recon + finders/skeptics ever fire. Finders return EMPTY findings so every leaf
// reaches a contract-valid "empty" envelope quickly (the merge contract is independent
// of whether findings are produced).
function metaRoute(text, shape) {
  // META shared recon (computed once).
  if (text.includes("comprehensive multi-domain review") || text.includes("Profile this repository once")) {
    return shape({ languages: ["javascript"], notes: "meta shared recon", frameworks: ["node"], packageManagers: ["npm"] });
  }
  // repo-complexity domain-local recon (always computed; shared recon lacks dirs).
  if (text.includes("for a complexity")) {
    return shape({ profile: "test repo", dirs: ["src"], gitAvailable: false });
  }
  // Defensive: a leaf self-recon (should NOT fire since recon is injected).
  if (text.includes("Profile this repository")) {
    return shape({ languages: ["javascript"], notes: "leaf self recon fallback" });
  }
  // Skeptic verdicts (not hit with empty findings, but kept for completeness).
  if (text.includes("You are a skeptic")) {
    return shape({ refuted: false, reasoning: "keep", adjustedConfidence: 80 });
  }
  // Coverage auditor (exhaustive mode only; returns a clean complete assessment by default).
  if (text.includes("coverage auditor")) {
    return shape({ coverageAssessment: "complete", confidence: "high", gaps: [], missedAreas: [] });
  }
  // Every finder lane: empty findings.
  return shape({ findings: [] });
}

function metaPromptRouter() {
  return makeLeafPromptRouter(metaRoute, { fallbackShape: structured });
}

// ---------------------------------------------------------------------------
// 1. workflow_list resolves repo-review as bundled
// ---------------------------------------------------------------------------

test("workflow_list resolves repo-review as a bundled workflow", async () => {
  const { tools, context, directory } = await makeHarness(metaPromptRouter());
  try {
    const listed = JSON.parse(await tools.workflow_list.execute({ format: "json" }, context));
    const entry = listed.find((e) => e.scope === "bundled" && e.name === "repo-review");
    assert.ok(entry, "repo-review must be discoverable as a bundled workflow");
    assert.equal(entry.name, "repo-review");
    assert.deepEqual(entry.phases, ["recon", "domains", "merge", "audit", "synthesize"]);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 2. Approval preview snapshots all eight literal leaf workflow() calls + read-only-review
// ---------------------------------------------------------------------------

test("approval preview snapshots all eight literal leaf workflow() calls and read-only-review", async () => {
  const { tools, context, directory } = await makeHarness(metaPromptRouter());
  try {
    const preview = await tools.workflow_run.execute({ name: "repo-review", args: { depth: "normal" } }, context);

    // The meta itself ships under read-only-review with the documented parent budget.
    assert.match(preview, /Authority profile: read-only-review/);
    assert.match(preview, /Max agents: 100000/);

    // All eight leaf sources appear in the nested-snapshot ledger (each by bundled path).
    for (const leaf of EIGHT_LEAVES) {
      assert.match(preview, new RegExp(`${leaf}\\.js`), `preview must snapshot nested leaf ${leaf}`);
    }
    // Parent-budget awareness note is surfaced (nested meta.maxAgents ignored, parent governs).
    assert.match(preview, /Nested budget: nested workflow\(\) lanes run inside this run/);
    assert.match(preview, /a nested workflow's own declared maxAgents is ignored at runtime/);
    // approvalHash present so the run can be approved.
    assert.match(preview, /approvalHash: [a-f0-9]{64}/);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 3. Source-structure assertions: 8 literal calls, no dynamic names, one level, reportPath null
// ---------------------------------------------------------------------------

test("source structure: exactly eight literal workflow(\"repo-...\", ...) calls, no dynamic names, one level, reportPath null", async () => {
  const src = await fs.readFile(META_SRC, "utf8");

  // Parsed: meta is well-formed.
  const { meta } = parseWorkflowSource(src);
  assert.equal(meta.name, "repo-review");
  assert.equal(meta.profile, "read-only-review");
  assert.equal(meta.maxAgents, 100000);

  // Exactly the eight static literal leaf refs (no more, no fewer).
  const refs = staticNestedWorkflowRefs(src);
  assert.deepEqual([...refs].sort(), [...EIGHT_LEAVES].sort());
  assert.equal(refs.length, 8, "exactly eight nested workflow() calls");

  // No dynamic (non-literal) workflow names — the same regex the activated
  // repo-review-meta-arg-contract suite enforces against this file.
  assert.doesNotMatch(src, /workflow\(\s*[a-zA-Z_][^"')\s]*\s*,/, "no dynamic workflow(name) refs");

  // reportPath always null; no mutation primitives.
  assert.match(src, /reportPath: null/);
  assert.doesNotMatch(src, /materialize\(|workflow_apply\(|drain\(/);

  // Guest purity: no imports / Date / Math.random / crypto.
  assert.doesNotMatch(src, /\bimport\b/);
  assert.doesNotMatch(src, /Date\.now|new Date\b/);
  assert.doesNotMatch(src, /Math\.random/);
  assert.doesNotMatch(src, /\bcrypto\b/);

  // One nesting level: the meta's leaves are themselves leaves (no workflow() inside the
  // bundled leaf sources). Spot-check the exemplar + one other.
  for (const leaf of ["repo-bughunt", "repo-deps"]) {
    const leafSrc = await fs.readFile(path.join(HERE, "..", "workflows", `${leaf}.js`), "utf8");
    assert.doesNotMatch(leafSrc, /\bworkflow\(/, `${leaf} must be a leaf (no nested workflow() calls)`);
  }
});

// ---------------------------------------------------------------------------
// 4. ONE minimal end-to-end run -> valid unified envelope
// ---------------------------------------------------------------------------

test("end-to-end: empty-leaf run completes and returns a valid unified envelope", async () => {
  const { tools, context, directory, calls } = await makeHarness(metaPromptRouter());
  try {
    const out = await runApprovedRequest(tools, context, { name: "repo-review", args: { depth: "normal" } });
    const env = await resultOutput(tools, context, out);

    // Valid unified envelope shape (contract §2 meta extension).
    assert.ok(env && typeof env === "object", "envelope must be an object");
    assert.equal(env.domain, "repo-review");
    assert.equal(env.schemaVersion, 1);
    assert.ok(["ok", "empty", "aborted"].includes(env.status), `unexpected status: ${env.status}`);
    assert.equal(env.reportPath, null, "reportPath must be null (QuickJS guest cannot write)");

    // 5-tier counts; total === sum.
    const c = env.counts;
    for (const k of ["total", "critical", "high", "medium", "low"]) {
      assert.ok(Number.isInteger(c[k]) && c[k] >= 0, `counts.${k} must be a non-negative integer`);
    }
    assert.equal(c.total, c.critical + c.high + c.medium + c.low, "counts.total must equal the tier sum");

    // leafOutcomes ledger covers the domains that actually ran (all eight, no filter).
    assert.ok(Array.isArray(env.leafOutcomes) && env.leafOutcomes.length === 8, "leafOutcomes must cover all eight domains");
    const outcomeDomains = env.leafOutcomes.map((o) => o.domain).sort();
    assert.deepEqual(outcomeDomains, [...EIGHT_DOMAINS].sort());

    // Every leaf reached a contract status with a 5-tier counts block.
    for (const o of env.leafOutcomes) {
      assert.ok(["ok", "empty", "aborted", "failed"].includes(o.status), `leaf ${o.domain} status: ${o.status}`);
      assert.ok(o.counts && Number.isInteger(o.counts.total), `leaf ${o.domain} must carry counts.total`);
    }

    // Per-domain top-level extras preserved (cleanup/modernize/deps emit theirs even on empty).
    assert.ok(env.domainExtras && typeof env.domainExtras === "object", "domainExtras map must exist");
    assert.ok(Array.isArray(env.domainExtras.cleanup?.staleDocs), "cleanup.staleDocs preserved");
    assert.ok(Array.isArray(env.domainExtras.modernize?.migrationPlan), "modernize.migrationPlan preserved");
    assert.ok(env.domainExtras.deps && typeof env.domainExtras.deps.upgradePlan === "object", "deps.upgradePlan preserved");

    // Recon computed ONCE: exactly one meta recon prompt routed (the "comprehensive
    // multi-domain review" lane). Leaf self-recon prompts must NOT appear because recon
    // is injected into every leaf.
    const prompts = calls.prompt.map((p) => String(p?.body?.parts?.[0]?.text ?? ""));
    const metaRecon = prompts.filter((t) => t.includes("comprehensive multi-domain review"));
    assert.equal(metaRecon.length, 1, "shared recon must be computed exactly once");
    const leafSelfRecon = prompts.filter((t) => /Profile this repository for (review|a security audit|test-gap|a cleanup|a modernization|performance|dependency)/.test(t));
    assert.equal(leafSelfRecon.length, 0, "leaf self-recon must be skipped (recon injected)");

    // Size-fit: the serialized envelope is under the 256 KiB host cap.
    assert.ok(JSON.stringify(env).length < 256 * 1024, "envelope must fit under MAX_RESULT_BYTES (256 KiB)");
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 5. Parent-budget awareness (documented; nested meta.maxAgents ignored, parent governs)
// ---------------------------------------------------------------------------

test("parent-budget awareness: meta declares maxAgents covering nested fan-out; nested meta.maxAgents is ignored at runtime", async () => {
  const src = await fs.readFile(META_SRC, "utf8");
  const { meta } = parseWorkflowSource(src);

  // The parent meta sets a maxAgents budget (the value that actually governs nested lanes).
  assert.ok(Number.isInteger(meta.maxAgents) && meta.maxAgents >= 64,
    `parent maxAgents must be set and sized for nested fan-out (got ${meta.maxAgents})`);
  assert.ok(meta.concurrency <= 16, "parent concurrency must stay within the documented repo-review posture");

  // Documented in-source: nested workflow() lanes share the parent run budget and a nested
  // leaf's own declared maxAgents is ignored. (Contract §14.4.)
  assert.match(src, /ignored at runtime/i);
  assert.match(src, /share its maxAgents/i);
});
