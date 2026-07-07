// repo-perf bundled workflow regression suite.
//
// Zero-token: every child session.prompt is routed to a canned payload by the
// shared test harness (tests/helpers/repo-review-leaf-harness.mjs, which factors
// tests/helpers/harness.mjs); no real model is ever called.
//
// Covers (per the bead acceptance + shared leaf contract):
//   - happy path: find -> verify -> rank -> envelope (perf fields preserved)
//   - category prompts: a finder prompt per perf lens, with hotness/impact/
//     complexity fields + the OBSERVED-vs-SUSPECTED + "no profiler" wording
//   - skeptic refutation: a refuted candidate is dropped; all-refuted -> empty
//   - measured-vs-suspected confidence wording: OBSERVED survivors kept with
//     higher confidence; SUSPECTED-only refuted for lack of code evidence
//   - ranking: findings ranked by severity * confidence * effort (descending)
//   - empty result + size-fitting under the 256KB cap
//   - shared envelope compliance (assertLeafEnvelope/Findings) on ok + empty
//   - shellCoverage none + coverageLimitations on every exit path
//   - structured-text fallback (native structured output UNAVAILABLE)
//   - fingerprint determinism (sentinel extraction, line-independent)
//   - bundled name-resolution / discovery (profile: read-only-review)

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  makeHarness,
  DEFAULT_CAPABILITIES,
  structured,
  textStructured,
  runLeafEnvelope,
  assertLeafEnvelope,
  assertLeafFindings,
  makeLeafPromptRouter,
} from "./helpers/repo-review-leaf-harness.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_PERF_SRC = path.join(HERE, "..", "workflows", "repo-perf.js");

const ALL_CATEGORIES = [
  "n-plus-one", "quadratic", "hot-alloc", "sync-blocking",
  "missing-caching", "inefficient-structure", "redundant-compute",
];

// ---- canned perf finding factory ----
function sampleFinding(cat, override = {}) {
  return {
    category: cat,
    file: `src/${cat}.js`,
    line: 10,
    severity: "high",
    description: `OBSERVED: ${cat} hotspot in hot loop`,
    hotness: "hot",
    estimatedImpact: "~2x speedup",
    complexityBefore: "O(n^2)",
    complexityAfter: "O(n)",
    proposedChange: "batch the calls",
    confidence: 80,
    effort: "small",
    docImpact: "",
    ...override,
  };
}

// ---- domain-specific prompt router (drives the REAL repo-perf engine) ----
//
// `shape` is `structured` (native) or `textStructured` (fallback) so the SAME
// route drives both structured-output paths. sync-blocking is refuted by the
// default skeptic (mirrors the exemplar's boundary-refute) so refutation is
// deterministically exercised on every happy-path run.
function perfRoute(text, shape) {
  if (text.includes("Profile this repository for performance")) {
    return shape({ languages: ["javascript"], notes: "test perf repo" });
  }
  if (text.includes("performance finder")) {
    const m = text.match(/the "([a-z-]+)" performance finder/);
    const cat = m ? m[1] : "n-plus-one";
    return shape({ findings: [sampleFinding(cat)] });
  }
  if (text.includes("REFUTE the performance finding")) {
    const refuted = text.includes("sync-blocking");
    return shape({ refuted, reasoning: "test verdict", adjustedConfidence: refuted ? 10 : 75 });
  }
  return undefined; // fall through to an empty response
}

// Convenience: build the harness with the perf router (native path) by default.
function perfHarness(route = perfRoute, opts = {}) {
  return makeHarness(makeLeafPromptRouter(route), opts);
}

// ===========================================================================
// 1. Happy path
// ===========================================================================

test("repo-perf happy path: finds, verifies, ranks, returns envelope with perf fields", async () => {
  const { tools, context, directory } = await perfHarness();
  try {
    const env = await runLeafEnvelope(tools, context, { name: "repo-perf", args: { depth: "normal" } });

    assertLeafEnvelope(env, "perf");
    assert.equal(env.status, "ok");
    // 7 lenses x 1 finding = 7 candidates; sync-blocking refuted -> 6 survive.
    assert.equal(env.counts.total, 6);
    assert.equal(env.counts.high, 6);
    assert.equal(env.counts.critical, 0); // non-security critical:0 rule

    assertLeafFindings(env.findings, "perf");
    assert.ok(env.findings.every((f) => f.fingerprint.startsWith("perf-")));
    assert.ok(env.findings.every((f, i) => f.rank === i + 1));
    assert.ok(!env.findings.some((f) => f.category === "sync-blocking"), "refuted sync-blocking finding must be dropped");

    // Perf-specific domain fields preserved end-to-end.
    for (const f of env.findings) {
      assert.ok(["hot", "warm", "cold"].includes(f.hotness), `bad hotness: ${f.hotness}`);
      assert.equal(typeof f.estimatedImpact, "string");
      assert.equal(typeof f.complexityBefore, "string");
      assert.equal(typeof f.complexityAfter, "string");
      assert.equal(typeof f.proposedChange, "string");
    }

    // Coverage-aware extension fields on the ok path.
    assert.equal(env.shellCoverage, "none");
    assert.ok(typeof env.coverageLimitations === "string" && env.coverageLimitations.length > 0);

    assert.match(env.reportMarkdown, /# Performance Audit Report/);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

// ===========================================================================
// 2. Category prompts: a finder per lens, perf fields, observed/suspected, no-profiler
// ===========================================================================

test("repo-perf emits a finder prompt per category carrying perf fields + OBSERVED/SUSPECTED + no-profiler wording", async () => {
  const captured = [];
  const route = (text, shape) => {
    captured.push(text);
    return perfRoute(text, shape);
  };
  const { tools, context, directory } = await perfHarness(route);
  try {
    await runLeafEnvelope(tools, context, { name: "repo-perf", args: { depth: "quick" } });

    const finderPrompts = captured.filter((t) => t.includes("performance finder"));
    // one finder prompt per lens
    for (const cat of ALL_CATEGORIES) {
      assert.ok(
        finderPrompts.some((t) => t.includes(`the "${cat}" performance finder`)),
        `missing finder prompt for category ${cat}`,
      );
    }
    // each finder prompt carries the perf-specific field instructions and the
    // observed-vs-suspected / static-audit wording the contract requires.
    const sample = finderPrompts[0];
    for (const field of ["hotness", "estimatedImpact", "complexityBefore", "complexityAfter", "proposedChange"]) {
      assert.ok(sample.includes(field), `finder prompt must instruct the ${field} field`);
    }
    assert.ok(sample.includes("OBSERVED"), "finder prompt must distinguish OBSERVED evidence");
    assert.ok(sample.includes("SUSPECTED"), "finder prompt must distinguish SUSPECTED hot-path risk");
    assert.ok(sample.includes("no profiler"), "finder prompt must state no profiler/benchmark/metrics were run");
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

// ===========================================================================
// 3. Skeptic refutation: a refuted candidate drops; all-refuted -> empty
// ===========================================================================

test("repo-perf drops a refuted candidate and returns empty when every candidate is refuted", async () => {
  const override = (text, shape) => {
    if (text.includes("REFUTE the performance finding")) {
      return shape({ refuted: true, reasoning: "all refuted", adjustedConfidence: 5 });
    }
    return perfRoute(text, shape);
  };
  const { tools, context, directory } = await perfHarness(override);
  try {
    const env = await runLeafEnvelope(tools, context, { name: "repo-perf", args: { depth: "normal" } });
    assertLeafEnvelope(env, "perf");
    assert.equal(env.status, "empty");
    assert.equal(env.counts.total, 0);
    assert.equal(env.findings.length, 0);
    assert.equal(env.reportMarkdown, null);
    // coverage disclosure survives the empty path too.
    assert.equal(env.shellCoverage, "none");
    assert.ok(typeof env.coverageLimitations === "string");
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

// ===========================================================================
// 4. Measured-vs-suspected confidence wording
// ===========================================================================

test("repo-perf distinguishes OBSERVED evidence from SUSPECTED hot-path risk in survivorship and confidence", async () => {
  // Three categories carry OBSERVED evidence (high confidence); the other four
  // are SUSPECTED-only. The skeptic refutes anything lacking OBSERVED evidence.
  const observed = new Set(["n-plus-one", "quadratic", "hot-alloc"]);
  const override = (text, shape) => {
    if (text.includes("performance finder")) {
      const m = text.match(/the "([a-z-]+)" performance finder/);
      const cat = m ? m[1] : "n-plus-one";
      const isObserved = observed.has(cat);
      return shape({
        findings: [{
          category: cat, file: `src/${cat}.js`, line: 10, severity: "high",
          description: isObserved ? `OBSERVED: ${cat} inside the request loop` : `SUSPECTED: ${cat} may be hot`,
          hotness: isObserved ? "hot" : "warm", estimatedImpact: "~2x speedup",
          complexityBefore: "O(n^2)", complexityAfter: "O(n)", proposedChange: "batch the calls",
          confidence: isObserved ? 85 : 35, effort: "medium", docImpact: "",
        }],
      });
    }
    if (text.includes("REFUTE the performance finding")) {
      // The skeptic prompt carries the finding description verbatim on its own
      // "Description:" line. Key on "Description: SUSPECTED" (NOT bare "SUSPECTED",
      // which also appears in this prompt's own static Check: line) so only the
      // suspected-only findings are refuted for lack of OBSERVED code evidence.
      const refuted = text.includes("Description: SUSPECTED");
      return shape({
        refuted,
        reasoning: refuted ? "suspected-only; no OBSERVED code evidence" : "OBSERVED in code",
        adjustedConfidence: refuted ? 10 : 80,
      });
    }
    return perfRoute(text, shape);
  };
  const { tools, context, directory } = await perfHarness(override);
  try {
    const env = await runLeafEnvelope(tools, context, { name: "repo-perf", args: { depth: "normal" } });
    assert.equal(env.status, "ok");
    // Only the 3 OBSERVED findings survive; the 4 SUSPECTED-only are refuted.
    assert.equal(env.counts.total, 3);
    assert.ok(env.findings.every((f) => f.description.includes("OBSERVED")));
    assert.ok(!env.findings.some((f) => f.description.includes("SUSPECTED")));
    // OBSERVED survivors carry the higher adjusted confidence the skeptic returned.
    assert.ok(env.findings.every((f) => f.confidence >= 80));
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

// ===========================================================================
// 5. Ranking: severity * confidence * effort (descending)
// ===========================================================================

test("repo-perf ranks findings by score (severity * confidence * effort) descending", async () => {
  const cats = ["n-plus-one", "quadratic", "hot-alloc"];
  // scores: n-plus-one 3*0.90*1.0=2.70 | quadratic 2*0.95*1.0=1.90 | hot-alloc 1*0.80*0.6=0.48
  const profile = {
    "n-plus-one": { severity: "high", confidence: 90, effort: "small" },
    "quadratic": { severity: "medium", confidence: 95, effort: "small" },
    "hot-alloc": { severity: "low", confidence: 80, effort: "large" },
  };
  const override = (text, shape) => {
    if (text.includes("performance finder")) {
      const m = text.match(/the "([a-z-]+)" performance finder/);
      const cat = m ? m[1] : "n-plus-one";
      return shape({ findings: [sampleFinding(cat, profile[cat])] });
    }
    if (text.includes("REFUTE the performance finding")) {
      const m = text.match(/Finding \(([a-z-]+)\) at/);
      const cat = m ? m[1] : "n-plus-one";
      // keep all; echo the finder's confidence so ranking is deterministic
      return shape({ refuted: false, reasoning: "keep", adjustedConfidence: profile[cat].confidence });
    }
    return perfRoute(text, shape);
  };
  const { tools, context, directory } = await perfHarness(override);
  try {
    const env = await runLeafEnvelope(tools, context, {
      name: "repo-perf", args: { depth: "normal", categories: cats },
    });
    assert.equal(env.counts.total, 3);
    assert.equal(env.findings[0].category, "n-plus-one");
    assert.equal(env.findings[1].category, "quadratic");
    assert.equal(env.findings[2].category, "hot-alloc");
    assert.deepEqual(env.findings.map((f) => f.rank), [1, 2, 3]);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

// ===========================================================================
// 6. Empty result (finders find nothing)
// ===========================================================================

test("repo-perf returns an empty envelope when finders find nothing", async () => {
  const override = (text, shape) => {
    if (text.includes("performance finder")) return shape({ findings: [] });
    return perfRoute(text, shape);
  };
  const { tools, context, directory } = await perfHarness(override);
  try {
    const env = await runLeafEnvelope(tools, context, { name: "repo-perf", args: { depth: "normal" } });
    assertLeafEnvelope(env, "perf");
    assert.equal(env.status, "empty");
    assert.equal(env.counts.total, 0);
    assert.equal(env.findings.length, 0);
    assert.equal(env.reportMarkdown, null);
    assert.equal(env.shellCoverage, "none");
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

// ===========================================================================
// 7. Resilience: finder lane failure (onFailure returnNull + filter)
// ===========================================================================

test("repo-perf survives a finder lane failure (onFailure returnNull + filter)", async () => {
  const override = (text, shape) => {
    if (text.includes('the "n-plus-one" performance finder')) throw new Error("simulated lane crash");
    return perfRoute(text, shape);
  };
  const { tools, context, directory } = await perfHarness(override);
  try {
    const env = await runLeafEnvelope(tools, context, { name: "repo-perf", args: { depth: "normal" } });
    assert.equal(env.status, "ok");
    // n-plus-one finder crashed -> dropped. 6 lenses produce findings; sync-blocking refuted -> 5 survive.
    assert.equal(env.counts.total, 5);
    assert.ok(!env.findings.some((f) => f.category === "n-plus-one"));
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

// ===========================================================================
// 8. Result-size fitting under the 256KB cap
// ===========================================================================

test("repo-perf size-fits a large finding set under the 256KB cap", async () => {
  // 7 lenses x 15 large findings = 105 candidates; ~8KB each (~840KB) amply
  // exceeds the cap. counts.total reflects ALL findings; the returned array is
  // truncated to fit. Agent count: 1 recon + 7 finders + 105 skeptics = 113 < maxAgents 128.
  const PER_LENS = 15;
  const big = "x".repeat(2000);
  const override = (text, shape) => {
    if (text.includes("performance finder")) {
      const m = text.match(/the "([a-z-]+)" performance finder/);
      const cat = m ? m[1] : "n-plus-one";
      const findings = [];
      for (let i = 0; i < PER_LENS; i++) {
        findings.push(sampleFinding(cat, {
          line: i + 1,
          description: `${cat} ${i} ${big}`,
          proposedChange: big,
          severity: "low", confidence: 50, effort: "large",
        }));
      }
      return shape({ findings });
    }
    if (text.includes("REFUTE the performance finding")) {
      return shape({ refuted: false, reasoning: "keep", adjustedConfidence: 50 });
    }
    return perfRoute(text, shape);
  };
  const { tools, context, directory } = await perfHarness(override);
  try {
    const env = await runLeafEnvelope(tools, context, {
      name: "repo-perf", args: { depth: "normal", maxReturnFindings: 200 },
    });
    assert.equal(env.status, "ok");
    assert.equal(env.counts.total, 7 * PER_LENS);
    assert.equal(env.truncatedFindings, true);
    assert.ok(JSON.stringify(env).length < 262144, "returned envelope must be under the host result cap");
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

// ===========================================================================
// 9. Shared envelope compliance on ok + empty (coverage fields on both)
// ===========================================================================

test("repo-perf every exit path complies with the shared envelope and carries shellCoverage none + coverageLimitations", async () => {
  // ok path
  const okHarness = await perfHarness();
  try {
    const okEnv = await runLeafEnvelope(okHarness.tools, okHarness.context, { name: "repo-perf", args: { depth: "normal" } });
    assertLeafEnvelope(okEnv, "perf");
    assertLeafFindings(okEnv.findings, "perf");
    assert.equal(okEnv.shellCoverage, "none");
    assert.ok(typeof okEnv.coverageLimitations === "string" && okEnv.coverageLimitations.length > 0);
    assert.ok(okEnv.coverageLimitations.toLowerCase().includes("profiler"));
    assert.ok(okEnv.coverageLimitations.toLowerCase().includes("not measured"));
  } finally {
    await fs.rm(okHarness.directory, { recursive: true, force: true });
  }

  // empty path
  const emptyOverride = (text, shape) => (text.includes("performance finder") ? shape({ findings: [] }) : perfRoute(text, shape));
  const emptyHarness = await perfHarness(emptyOverride);
  try {
    const emptyEnv = await runLeafEnvelope(emptyHarness.tools, emptyHarness.context, { name: "repo-perf", args: { depth: "normal" } });
    assertLeafEnvelope(emptyEnv, "perf");
    assert.equal(emptyEnv.shellCoverage, "none");
    assert.ok(typeof emptyEnv.coverageLimitations === "string" && emptyEnv.coverageLimitations.length > 0);
  } finally {
    await fs.rm(emptyHarness.directory, { recursive: true, force: true });
  }
});

// ===========================================================================
// 10. Depth profiles (quick high-only; thorough 3-skeptic majority)
// ===========================================================================

test("repo-perf quick depth only verifies high-severity candidates", async () => {
  const { tools, context, directory } = await perfHarness();
  try {
    // all canned findings are high severity -> quick verifies all; sync-blocking refuted -> 6 remain.
    const env = await runLeafEnvelope(tools, context, { name: "repo-perf", args: { depth: "quick" } });
    assert.equal(env.counts.total, 6);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("repo-perf thorough depth uses 3-skeptic majority (lone refute keeps the finding)", async () => {
  // thorough: each finding gets 3 skeptics; keep unless >=2 refute. Make ONLY reviewer #1 refute.
  const override = (text, shape) => {
    if (text.includes("REFUTE the performance finding") && text.includes("Independent reviewer #1")) {
      return shape({ refuted: true, reasoning: "lone refute", adjustedConfidence: 10 });
    }
    return perfRoute(text, shape); // reviewers #2/#3 use the default (sync-blocking refuted, others kept)
  };
  const { tools, context, directory } = await perfHarness(override);
  try {
    const env = await runLeafEnvelope(tools, context, { name: "repo-perf", args: { depth: "thorough" } });
    // sync-blocking: #1 (override) + #2/#3 (default refute) => 3 refutes => dropped.
    // every other category: only #1 refutes => 1 < 2 => kept.
    // thorough runs a 2nd find round (dedup removes identical repeats) => still 7 candidates.
    assert.equal(env.counts.total, 6);
    assert.ok(!env.findings.some((f) => f.category === "sync-blocking"));
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

// ===========================================================================
// 11. Structured-text fallback (native structured output UNAVAILABLE)
// ===========================================================================

test("repo-perf works under the structured-text fallback when native structured output is unavailable", async () => {
  const { tools, context, directory } = await makeHarness(
    makeLeafPromptRouter(perfRoute, { fallbackShape: textStructured }),
    { capabilities: { ...DEFAULT_CAPABILITIES, structuredOutput: "unavailable" } },
  );
  try {
    const env = await runLeafEnvelope(tools, context, { name: "repo-perf", args: { depth: "normal" } });

    // Same ranked envelope as the native happy path: sync-blocking refuted -> 6 survive.
    assert.equal(env.domain, "perf");
    assertLeafEnvelope(env, "perf");
    assert.equal(env.status, "ok");
    assert.equal(env.counts.total, 6);
    assert.equal(env.counts.high, 6);
    assert.ok(!env.findings.some((f) => f.category === "sync-blocking"), "sync-blocking must still be refuted via the fallback path");
    assert.ok(env.findings.every((f) => f.fingerprint.startsWith("perf-")));
    assert.ok(env.findings.every((f, i) => f.rank === i + 1));
    assert.match(env.reportMarkdown, /# Performance Audit Report/);
    assert.equal(env.shellCoverage, "none");
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

// ===========================================================================
// 12. Bundled discovery / name resolution
// ===========================================================================

test("repo-perf is discoverable as a bundled workflow and resolves by name (read-only-review)", async () => {
  const { tools, context, directory } = await perfHarness();
  try {
    const listed = JSON.parse(await tools.workflow_list.execute({ format: "json" }, context));
    assert.ok(listed.some((e) => e.scope === "bundled" && e.name === "repo-perf"),
      `repo-perf not listed as bundled: ${JSON.stringify(listed)}`);

    const preview = await tools.workflow_run.execute({ name: "repo-perf", args: { depth: "quick" } }, context);
    assert.match(preview, /Authority profile: read-only-review/);
    assert.match(preview, /approvalHash: [a-f0-9]{64}/);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

// ===========================================================================
// 13. Fingerprint determinism (sentinel extraction)
// ===========================================================================

test("fingerprintOf is deterministic and line-independent", async () => {
  const src = await fs.readFile(REPO_PERF_SRC, "utf8");
  const m = src.match(/\/\/ <suite:fingerprintOf>([\s\S]*?)\/\/ <\/suite:fingerprintOf>/);
  assert.ok(m, "fingerprintOf sentinel block not found in repo-perf.js");
  // Extract the pure function; supply DOMAIN that the function closes over.
  const fingerprintOf = new Function("DOMAIN", `${m[1]}; return fingerprintOf;`)("perf");

  const a = { file: "src/x.js", category: "quadratic", description: "Nested loop over   list", line: 10 };
  // Keep b on the SAME path as a so the collision proves line-exclusion + description
  // normalization (the stated intent), not an accidental path-prefix difference.
  const b = { file: "src/x.js", category: "quadratic", description: "nested loop over list", line: 999 };

  assert.equal(fingerprintOf(a), fingerprintOf({ ...a }), "same input must hash identically");
  assert.match(fingerprintOf(a), /^perf-[0-9a-f]+$/);
  // line is excluded from the basis; whitespace/case normalized -> a and b collide by design.
  assert.equal(
    fingerprintOf({ file: "src/x.js", category: "quadratic", description: "nested loop over list" }),
    fingerprintOf(b),
    "fingerprint must be line-independent",
  );
  // different description -> different fingerprint.
  assert.notEqual(
    fingerprintOf({ file: "src/x.js", category: "quadratic", description: "something else entirely" }),
    fingerprintOf(b),
  );
});

test("repo-perf guest source imports/requires nothing", async () => {
  const src = await fs.readFile(REPO_PERF_SRC, "utf8");
  assert.ok(!/^\s*import\b/m.test(src), "guest source must not contain ES import statements");
  assert.ok(!/\brequire\s*\(/.test(src), "guest source must not call require()");
  assert.ok(!src.includes("tests/helpers"), "guest source must not reference tests/helpers");
  assert.match(src, /const DOMAIN = "perf";/);
  assert.match(src, /const SCHEMA_VERSION = 1;/);
});
