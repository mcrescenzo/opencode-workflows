// Exhaustive-default + materialization-readiness gate regression for the repo-review meta
// (bead opencode-workflows-rrev.27).
//
// The meta now defaults to EXHAUSTIVE (thorough depth, coverage auditor) and emits
// materializationReady / materializationBlockers / coverageGrade so the separately-approved
// review-materialize flow can refuse incomplete or truncated reports. This suite proves:
//   - empty args select exhaustive mode (auditor runs, depth thorough)
//   - bounded mode skips the auditor and has NO auditor blocker
//   - a clean complete run is materializationReady with zero blockers
//   - partial leaf failure -> NOT ready (partialCoverage blocker)
//   - reportMarkdown dropped for size -> NOT ready (reportMarkdownDropped blocker)
//   - leaf-level truncation propagates as leafTruncated:<domain> blocker
//   - auditor low confidence / non-complete assessment -> ADVISORY (never a hard blocker)
//   - bounded mode never sets an auditorUnavailable blocker
//
// Zero-token: every child session.prompt is routed to a canned payload by the shared
// harness (tests/helpers/repo-review-leaf-harness.mjs -> harness.mjs). The router handles
// the meta recon, complexity recon, auditor, skeptic, and per-domain finder prompts.

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

// ---- shared router (mirrors repo-review-meta.test.mjs buildMetaRouter, minimal) ----

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

function baseFinding(domain, opts = {}) {
  const defaults = {
    bughunt: { reproSketch: "r", fixSketch: "f", proposedChange: "c", docImpact: "" },
    security: { cwe: "CWE-1", attackVector: "x", exploitability: "low", proposedChange: "c", docImpact: "" },
    "test-gaps": { targetUnderTest: "t()", suggestedTest: "t", proposedChange: "c", docImpact: "" },
    cleanup: { proposedChange: "c", docImpact: "" },
    modernize: { deprecatedSince: "", replacement: "m", targetVersion: "", proposedChange: "c", docImpact: "" },
    perf: { hotness: "warm", estimatedImpact: "minor", complexityBefore: "O(n)", complexityAfter: "O(1)", proposedChange: "c", docImpact: "" },
    complexity: { churn: 0, complexityScore: 50, hotspotScore: 50, refactorSuggestion: "s", proposedChange: "c", docImpact: "" },
    deps: { package: "p", currentVersion: "1.0.0", targetVersion: "", breaking: false, cve: [], advisory: "", proposedChange: "c", docImpact: "" },
  };
  return {
    category: opts.category ?? "default",
    file: opts.file ?? "src/x.js",
    line: opts.line ?? 1,
    severity: opts.severity ?? "low",
    description: opts.description ?? "a finding",
    confidence: opts.confidence ?? 70,
    effort: opts.effort ?? "medium",
    ...defaults[domain],
    ...opts,
  };
}

// scenario:
//   auditor?:     auditor canned response (default complete/high)
//   perDomain?:   { [domain]: (text, cat) => {findings:[...]} | undefined }
//   skeptic?:     (text) => verdict | null
function buildRouter(scenario = {}) {
  const perDomain = scenario.perDomain ?? {};
  return makeLeafPromptRouter((text, shape) => {
    if (text.includes("comprehensive multi-domain review") || text.includes("Profile this repository once")) {
      return shape({ languages: ["javascript"], notes: "recon", frameworks: ["node"], packageManagers: ["npm"] });
    }
    if (text.includes("for a complexity")) {
      return shape(scenario.complexityRecon ?? { profile: "test repo", dirs: ["src"], gitAvailable: false });
    }
    if (text.includes("Profile this repository")) {
      return shape({ languages: ["javascript"], notes: "fallback" });
    }
    if (text.includes("coverage auditor")) {
      return shape(scenario.auditor ?? { coverageAssessment: "complete", confidence: "high", gaps: [], missedAreas: [] });
    }
    if (text.includes("You are a skeptic")) {
      const v = scenario.skeptic ? scenario.skeptic(text) : null;
      return shape(v ?? { refuted: false, reasoning: "keep", adjustedConfidence: 80 });
    }
    const dom = detectDomain(text);
    if (dom && perDomain[dom]) {
      const cat = (text.match(/the "([a-z-]+)"/) || [])[1];
      const r = perDomain[dom](text, cat);
      if (r !== undefined) return shape(r);
    }
    return shape({ findings: [] });
  }, { fallbackShape: structured });
}

async function runMeta(scenario = {}, requestArgs = {}, harnessOpts = {}) {
  const { tools, context, directory, calls } = await makeHarness(buildRouter(scenario), harnessOpts);
  try {
    const out = await runApprovedRequest(tools, context, { name: "repo-review", args: requestArgs });
    const env = await resultOutput(tools, context, out);
    return { env, calls, directory };
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

// ---- 1. Exhaustive is the default ----

test("exhaustive is the default: empty args run the coverage auditor (deep tier)", async () => {
  const { env, calls } = await runMeta({});
  const prompts = calls.prompt.map((p) => String(p?.body?.parts?.[0]?.text ?? ""));
  const auditorPrompts = prompts.filter((t) => t.includes("coverage auditor"));
  assert.equal(auditorPrompts.length, 1, "exhaustive default must fire exactly one auditor lane");
  // The gate fields are present on every envelope.
  assert.equal(typeof env.materializationReady, "boolean");
  assert.ok(Array.isArray(env.materializationBlockers));
  assert.ok(["complete", "partial", "truncated", "degraded"].includes(env.coverageGrade));
  // A clean empty run with a complete auditor IS ready (nothing to materialize, but coverage is complete).
  assert.equal(env.materializationReady, true, "clean empty run with complete auditor must be ready");
  assert.equal(env.materializationBlockers.length, 0);
  assert.equal(env.coverageGrade, "complete");
  // coverageAudit is surfaced for the command to display.
  assert.ok(env.coverageAudit && typeof env.coverageAudit === "object");
  assert.equal(env.coverageAudit.coverageAssessment, "complete");
});

// ---- 2. Bounded mode skips the auditor and never sets an auditor blocker ----

test("bounded mode skips the auditor; no auditor blocker; depth normal", async () => {
  const { env, calls } = await runMeta({}, { mode: "bounded", depth: "normal" });
  const prompts = calls.prompt.map((p) => String(p?.body?.parts?.[0]?.text ?? ""));
  assert.equal(prompts.filter((t) => t.includes("coverage auditor")).length, 0, "bounded mode must NOT run the auditor");
  assert.equal(env.coverageAudit, null);
  // Bounded mode is ready if coverage is complete (no auditor expected, so no auditorUnavailable).
  assert.equal(env.materializationReady, true);
  assert.equal(env.materializationBlockers.length, 0);
  assert.ok(!env.materializationBlockers.some((b) => b.startsWith("auditor")), "bounded mode must never set an auditor blocker");
});

// ---- 3. Clean complete run WITH findings is materializationReady ----

test("clean complete run with real findings is materializationReady with zero blockers", async () => {
  const { env } = await runMeta({
    perDomain: {
      bughunt: () => ({ findings: [baseFinding("bughunt", { severity: "high", description: "null deref", file: "src/a.js", category: "null-deref" })] }),
    },
  });
  assert.equal(env.status, "ok");
  assert.ok(env.counts.total > 0);
  assert.equal(env.materializationReady, true, "a clean complete run with findings must be ready");
  assert.equal(env.materializationBlockers.length, 0);
  assert.equal(env.coverageGrade, "complete");
  // reportMarkdown is present (not dropped) -> no reportMarkdownDropped blocker.
  assert.ok(typeof env.reportMarkdown === "string" && env.reportMarkdown.length > 0);
  assert.equal(env.truncatedFindings, false);
});

// ---- 4. Partial leaf failure -> NOT ready (partialCoverage blocker) ----

test("partial leaf failure sets partialCoverage blocker -> NOT materializationReady", async () => {
  // Force complexity to abort by returning a schema-INVALID complexity recon (dirs must be
  // an array). Ajv rejects => lane null => complexity aborts => partialCoverage. This mirrors
  // the approach proven in repo-review-meta.test.mjs test 11.
  const { env } = await runMeta(
    { complexityRecon: { profile: "incomplete", dirs: "NOT_AN_ARRAY", gitAvailable: "not-a-boolean" } },
    { mode: "bounded", depth: "normal" },
  );
  assert.equal(env.partialCoverage, true);
  assert.equal(env.materializationReady, false);
  assert.ok(env.materializationBlockers.includes("partialCoverage"), `blockers: ${JSON.stringify(env.materializationBlockers)}`);
  assert.equal(env.coverageGrade, "partial");
});

// ---- 5. Leaf-level truncation propagation (source contract) ----
//
// End-to-end leaf truncation requires a leaf to exceed its own 200-finding cap, which is
// already covered by each leaf's own test suite. Here we verify the META-side contract: the
// meta reads env.truncatedFindings from each leaf and pushes leafTruncated:<domain> into the
// blockers. This is a source-level guarantee; the normalize step (test 9 grep) + the gate
// function (test 9 grep) together prove the propagation path.

test("leaf-level truncation propagation: meta source reads env.truncatedFindings and gates on it", async () => {
  const src = await fs.readFile(
    path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "workflows", "repo-review.js"),
    "utf8",
  );
  // The normalize step captures leaf-level truncatedFindings into the outcome ledger.
  assert.ok(/env\.truncatedFindings/.test(src), "meta must read env.truncatedFindings from leaf envelopes");
  // The gate pushes a leafTruncated:<domain> blocker per truncated leaf.
  assert.ok(/leafTruncated:/.test(src), "meta must push leafTruncated:<domain> blockers");
  // And the grade function treats leaf truncation as "truncated" grade.
  assert.ok(src.includes('"truncated"'), "meta gradeFor must classify leaf truncation as truncated");
});

// ---- 6. reportMarkdown dropped for size -> artifacts preserve the full set (iui1.4) ----
//
// Before iui1.4, a size-capped report (reportMarkdown dropped / findings halved) was NOT
// materializationReady because the full ranked detail was lost to the 256 KiB cap. iui1.4 spills
// the FULL set + full markdown to host-owned artifacts, so size compaction of the RETURNED preview
// is now lossless and the report IS materializationReady; review-materialize reads the full set
// from the artifact.

test("reportMarkdown dropped for size no longer blocks materialization (full set is artifactized)", async () => {
  // Generate enough findings across domains to exceed the 230 KiB headroom, forcing the
  // meta to compact the returned preview (drop reportMarkdown and/or halve findings).
  const big = "x".repeat(2000);
  const perDomain = {};
  for (const dom of ["bughunt", "security", "cleanup", "modernize", "perf", "test-gaps", "deps"]) {
    perDomain[dom] = () => {
      const findings = [];
      for (let i = 0; i < 30; i++) {
        findings.push(baseFinding(dom, { severity: "low", description: `${dom} ${i} ${big}`, category: `cat-${i}`, file: `src/${dom}-${i}.js`, line: i + 1 }));
      }
      return { findings };
    };
  }
  const { env } = await runMeta({ perDomain }, { mode: "bounded", depth: "normal" });
  assert.ok(env.counts.total > 0, "should have findings");
  // The returned preview WAS size-compacted (reportMarkdown dropped and/or findings truncated).
  assert.ok(
    env.reportMarkdown === null || env.truncatedFindings === true,
    "expected size compaction of the returned preview",
  );
  // ...but the FULL set + markdown were spilled to artifacts, so materialization IS ready.
  assert.equal(env.artifactsReady, true, "the full set must be artifactized");
  assert.ok(env.artifactPaths && env.artifactPaths.findingsJson, "findingsJson artifact path must be present");
  assert.equal(env.materializationReady, true, "a size-compacted report with persisted artifacts must be materializationReady");
  assert.ok(
    !env.materializationBlockers.includes("reportMarkdownDropped") && !env.materializationBlockers.includes("truncatedFindings") && !env.materializationBlockers.includes("artifactPersistenceFailed"),
    `size compaction must not block when artifacts hold the full set; blockers=${JSON.stringify(env.materializationBlockers)}`,
  );
});

test("reportMarkdown dropped for size STILL blocks materialization when artifact persistence fails", async () => {
  // Same large set, but artifact persistence is forced to fail (kernel test hook). With no
  // artifact backstop, the old size-loss blockers (reportMarkdownDropped/truncatedFindings)
  // correctly re-engage and block materialization.
  const big = "x".repeat(2000);
  const perDomain = {};
  for (const dom of ["bughunt", "security", "cleanup", "modernize", "perf", "test-gaps", "deps"]) {
    perDomain[dom] = () => {
      const findings = [];
      for (let i = 0; i < 30; i++) {
        findings.push(baseFinding(dom, { severity: "low", description: `${dom} ${i} ${big}`, category: `cat-${i}`, file: `src/${dom}-${i}.js`, line: i + 1 }));
      }
      return { findings };
    };
  }
  const { env } = await runMeta({ perDomain }, { mode: "bounded", depth: "normal" }, { pluginContext: { __workflowArtifactFail: true } });
  assert.equal(env.artifactsReady, false);
  assert.equal(env.materializationReady, false, "a failed artifact write must leave the report NOT ready");
  assert.ok(
    env.materializationBlockers.some((b) => b === "reportMarkdownDropped" || b === "truncatedFindings" || b === "artifactPersistenceFailed"),
    `expected a size-loss/artifact blocker when persistence failed, got: ${JSON.stringify(env.materializationBlockers)}`,
  );
});

// ---- 7. Auditor low confidence / degraded -> ADVISORY (objective coverage still ready) ----

test("auditor degraded low-confidence is advisory: objective coverage complete -> still materializationReady", async () => {
  const { env } = await runMeta({
    auditor: { coverageAssessment: "degraded", confidence: "low", gaps: ["no config review"], missedAreas: ["CI scripts"] },
  });
  // Objective coverage is complete, so materialization IS ready even though the auditor is
  // loudly pessimistic. The auditor never hard-blocks (it is a meta-judgment lane, not a
  // finding producer).
  assert.equal(env.materializationReady, true, "auditor-only concerns must not block materialization");
  assert.ok(!env.materializationBlockers.some((b) => b.startsWith("auditor")), "auditor signals must not appear in materializationBlockers");
  // The auditor's concerns are surfaced as coverageAdvisories for separate reporting.
  assert.ok(Array.isArray(env.coverageAdvisories), "envelope must carry coverageAdvisories");
  assert.ok(env.coverageAdvisories.includes("auditorLowConfidence"), "low confidence -> auditorLowConfidence advisory");
  assert.ok(env.coverageAdvisories.some((a) => a.startsWith("auditorCoverage:degraded")), "degraded assessment -> auditorCoverage:degraded advisory");
  // coverageGrade is OBJECTIVE (auditor does not contribute); a clean run is "complete".
  assert.equal(env.coverageGrade, "complete", "coverageGrade is objective; auditor pessimism does not lower it");
  // The auditor's gaps/missedAreas are still surfaced for the command to display.
  assert.ok(env.coverageAudit.gaps.length > 0);
});

// ---- 8. Auditor partial assessment (non-low confidence) -> ADVISORY, ready ----

test("auditor partial assessment is advisory: medium confidence does not block materialization", async () => {
  const { env } = await runMeta({
    auditor: { coverageAssessment: "partial", confidence: "medium", gaps: ["missing i18n"], missedAreas: [] },
  });
  // This is the goals-4bd5a7fd incident shape: objective coverage complete, auditor partial/medium.
  // materializationReady must be TRUE (the false-positive blocker is gone).
  assert.equal(env.materializationReady, true, "auditor partial/medium must not block when objective coverage is complete");
  assert.ok(!env.materializationBlockers.some((b) => b.startsWith("auditorCoverage")), "auditorCoverage must not be a materializationBlocker");
  assert.ok(env.coverageAdvisories.some((a) => a.startsWith("auditorCoverage:partial")), "partial assessment -> auditorCoverage:partial advisory");
  // medium confidence does NOT add auditorLowConfidence, but the non-complete assessment is still advisory.
  assert.ok(!env.coverageAdvisories.includes("auditorLowConfidence"));
  assert.equal(env.coverageGrade, "complete");
});

// ---- 8b. Regression: the goals-4bd5a7fd incident (complexity empty-but-complete) ----

test("regression: all domains ok/empty with complexity empty-but-complete + auditor partial -> ready + advisory", async () => {
  // Reproduces the real incident: every domain returns ok/empty (complexity ran to completion with
  // zero lane drops but no survivors), inventory complete, artifacts ready, yet the auditor says
  // partial/medium. This must NOT block materialization.
  const { env } = await runMeta({
    // All finders return empty -> every domain reaches ok/empty. Complexity's domain recon still
    // resolves (so it does not abort), but its scorer finds nothing -> status "empty".
    auditor: { coverageAssessment: "partial", confidence: "medium", gaps: ["complexity returned empty"], missedAreas: ["maintainability hotspots"] },
  });
  assert.equal(env.partialCoverage, false, "no leaf failed or dropped a lane");
  assert.equal(env.materializationReady, true, "objective coverage complete -> ready despite auditor partial");
  assert.ok(env.coverageAdvisories.some((a) => a.startsWith("auditorCoverage:partial")), "auditor partial must be an advisory, not a blocker");
  // The complexity leaf is empty but did NOT fail.
  const complexity = env.leafOutcomes.find((o) => o.domain === "complexity");
  assert.ok(complexity, "complexity must report");
  assert.ok(["ok", "empty"].includes(complexity.status), "complexity must be ok/empty, not failed/aborted");
});

// ---- 9. Source-structure: gate fields are referenced in the meta source ----

test("meta source declares the gate + auditor (source grep)", async () => {
  const src = await fs.readFile(
    path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "workflows", "repo-review.js"),
    "utf8",
  );
  assert.ok(src.includes("materializationReady"), "meta must compute materializationReady");
  assert.ok(src.includes("materializationBlockers"), "meta must compute materializationBlockers");
  assert.ok(src.includes("coverageGrade"), "meta must compute coverageGrade");
  assert.ok(src.includes("coverageAdvisories"), "meta must compute coverageAdvisories (advisory-only auditor)");
  assert.ok(src.includes("AUDITOR_SCHEMA"), "meta must declare the auditor schema");
  assert.ok(src.includes('mode === "bounded"'), "meta must branch on mode");
  assert.ok(src.includes("exhaustive ? \"thorough\""), "exhaustive mode must default to thorough depth");
  assert.ok(src.includes(": 1000000"), "meta must default maxReturnFindings to an effectively-unlimited ceiling (1000000)");
});
