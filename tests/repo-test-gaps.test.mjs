// repo-test-gaps bundled workflow regression suite.
//
// Zero-token: every child session.prompt is routed to a canned payload by the
// shared test harness (tests/helpers/harness.mjs); no real model is ever called.
//
// Covers (per opencode-workflows-rrev.6 acceptance):
//   - Task 1: gap discovery happy path (find -> verify -> rank -> envelope)
//   - Task 2: indirect-coverage refutation (skeptic refutes a gap already
//     covered indirectly; survivor kept)
//   - Task 3: priority ranking (severity * confidence * effort ordering)
//   - Task 4: empty result (all verified gaps refuted -> empty envelope)
//   - Task 5: unmeasured-coverage limitation wording (shellCoverage none +
//     coverageLimitations explaining coverage was NOT run/measured; no claimed %)
//   - Task 6: shared envelope compliance (assertLeafEnvelope/Findings + synthetic)
//   - Task 7: structured-text fallback (native structured output UNAVAILABLE ->
//     JSON-as-text still yields the correct ranked envelope)
//   - Task 8: fingerprint determinism (sentinel extraction, line-independent)
//   - Bonus: bundled discovery + read-only profile; guest imports nothing;
//     finder-lane failure resilience (onFailure returnNull + filter).

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
  runApprovedRequest,
  resultOutput,
  runLeafEnvelope,
  makeLeafPromptRouter,
  assertLeafEnvelope,
  assertLeafCounts,
  assertLeafFinding,
  assertLeafFindings,
} from "./helpers/repo-review-leaf-harness.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GUEST_SRC = path.join(HERE, "..", "workflows", "repo-test-gaps.js");

const ALL_CATEGORIES = [
  "uncovered-public", "untested-error-path", "missing-edge-case",
  "branch-no-assertion", "weak-critical-path", "untested-seam",
];
const HIGH_RISK = ["uncovered-public", "untested-error-path", "weak-critical-path"];

// ---- domain-specific prompt router ----
//
// `buildFindings(cat, overrides)` produces a single finding for a lens so tests
// can parametrize severity/confidence/effort to exercise ranking. The route is
// shape-agnostic (structured = native; textStructured = fallback) so the SAME
// route drives both paths via makeLeafPromptRouter's fallbackShape.
function buildFinding(cat, overrides = {}) {
  return {
    category: cat,
    file: `src/${cat}.js`,
    line: 10,
    severity: "high",
    description: `${cat} gap example`,
    targetUnderTest: `${cat}Target()`,
    suggestedTest: `should exercise ${cat} path`,
    proposedChange: "add a unit test in the matching test file",
    confidence: 80,
    effort: "small",
    docImpact: "",
    ...overrides,
  };
}

// `route(text, shape)` returns a canned response or undefined to fall through.
// `finderOverrides` maps category -> finding overrides; `refute` is a predicate
// over the skeptic prompt text deciding whether to refute (indirect coverage).
function makeRoute({ finderOverrides = {}, refute = () => false, recon = { languages: ["javascript"], notes: "test repo" } } = {}) {
  return function route(text, shape) {
    if (text.includes("Profile this repository for test-gap")) {
      return shape(recon);
    }
    if (text.includes("test-gap finder")) {
      const m = text.match(/the "([a-z-]+)" test-gap finder/);
      const cat = m ? m[1] : "uncovered-public";
      const f = buildFinding(cat, finderOverrides[cat]);
      return shape({ findings: [f] });
    }
    if (text.includes("You are a skeptic")) {
      const refuted = refute(text);
      return shape({ refuted, reasoning: refuted ? "already covered indirectly" : "real gap", adjustedConfidence: refuted ? 10 : 75 });
    }
    return undefined;
  };
}

function nativeRouter(route) {
  return makeLeafPromptRouter(route, { fallbackShape: structured });
}
function fallbackRouter(route) {
  return makeLeafPromptRouter(route, { fallbackShape: textStructured });
}

// ---- Task 1: happy path (gap discovery + envelope compliance + coverage wording) ----

test("repo-test-gaps happy path: finds, verifies, ranks, returns envelope", async () => {
  // 6 lenses x 1 high finding. normal depth verifies HIGH_RISK (3 lenses); refute
  // weak-critical-path (indirect coverage). The other 3 lenses pass through.
  const route = makeRoute({ refute: (t) => t.includes("weak-critical-path") });
  const { tools, context, directory } = await makeHarness(nativeRouter(route));
  try {
    const env = await runLeafEnvelope(tools, context, { name: "repo-test-gaps", args: { depth: "normal" } });

    assert.equal(env.domain, "test-gaps");
    assert.equal(env.schemaVersion, 1);
    assert.equal(env.status, "ok");
    // 6 candidates - 1 refuted (weak-critical-path) = 5 survive.
    assert.equal(env.counts.total, 5);
    assert.equal(env.counts.high, 5);
    assert.equal(env.counts.critical, 0);
    assert.ok(!env.findings.some((f) => f.category === "weak-critical-path"), "refuted weak-critical-path must be dropped");

    // Shared contract compliance (envelope + contiguous ranks + unique fingerprints).
    assertLeafEnvelope(env, "test-gaps");
    assertLeafFindings(env.findings, "test-gaps");
    assert.ok(env.findings.every((f) => f.fingerprint.startsWith("test-gaps-")));

    // Domain action fields preserved.
    for (const f of env.findings) {
      assert.equal(typeof f.targetUnderTest, "string");
      assert.ok(f.targetUnderTest.length > 0);
      assert.equal(typeof f.suggestedTest, "string");
      assert.ok(f.suggestedTest.length > 0);
      assert.equal(typeof f.proposedChange, "string");
    }
    assert.match(env.reportMarkdown, /# Test Gaps Report/);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

// ---- Task 2: indirect-coverage refutation ----

test("repo-test-gaps skeptic refutes a gap already covered indirectly while a real gap survives", async () => {
  // Restrict to two HIGH_RISK lenses (both get verified in normal depth). Refute
  // uncovered-public (claim indirect coverage) and keep untested-error-path.
  const route = makeRoute({ refute: (t) => t.includes("uncovered-public") });
  const { tools, context, directory } = await makeHarness(nativeRouter(route));
  try {
    const env = await runLeafEnvelope(tools, context, {
      name: "repo-test-gaps",
      args: { depth: "normal", categories: ["uncovered-public", "untested-error-path"] },
    });
    assert.equal(env.status, "ok");
    assert.equal(env.counts.total, 1);
    assert.equal(env.findings[0].category, "untested-error-path");
    assert.ok(!env.findings.some((f) => f.category === "uncovered-public"), "indirectly-covered gap must be refuted/dropped");
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

// ---- Task 3: priority ranking (severity * confidence * effort) ----

test("repo-test-gaps ranks findings by severity*confidence*effort (quick depth, no verification)", async () => {
  // quick depth => toVerify=[] => all findings pass through with ORIGINAL
  // confidence, so the pure-JS ranking is deterministic on the route values.
  // Expected scores (SEVW: high3/med2/low1; EFFD: small1/med0.8/large0.6):
  //   uncovered-public      high/90/small  -> 3*0.9*1   = 2.70  (rank 1)
  //   missing-edge-case     medium/90/small-> 2*0.9*1   = 1.80  (rank 2)
  //   weak-critical-path    high/80/large  -> 3*0.8*0.6 = 1.44  (rank 3)
  //   untested-seam         medium/80/med  -> 2*0.8*0.8 = 1.28  (rank 4)
  //   untested-error-path   high/50/medium -> 3*0.5*0.8 = 1.20  (rank 5)
  //   branch-no-assertion   low/100/small  -> 1*1.0*1   = 1.00  (rank 6)
  const route = makeRoute({
    finderOverrides: {
      "uncovered-public": { severity: "high", confidence: 90, effort: "small" },
      "untested-error-path": { severity: "high", confidence: 50, effort: "medium" },
      "missing-edge-case": { severity: "medium", confidence: 90, effort: "small" },
      "branch-no-assertion": { severity: "low", confidence: 100, effort: "small" },
      "weak-critical-path": { severity: "high", confidence: 80, effort: "large" },
      "untested-seam": { severity: "medium", confidence: 80, effort: "medium" },
    },
  });
  const { tools, context, directory } = await makeHarness(nativeRouter(route));
  try {
    const env = await runLeafEnvelope(tools, context, { name: "repo-test-gaps", args: { depth: "quick" } });
    assert.equal(env.status, "ok");
    assert.equal(env.counts.total, 6);
    const order = env.findings.map((f) => f.category);
    assert.deepEqual(order, [
      "uncovered-public", "missing-edge-case", "weak-critical-path",
      "untested-seam", "untested-error-path", "branch-no-assertion",
    ]);
    // ranks are contiguous 1..N and align with the sorted order.
    assert.ok(env.findings.every((f, i) => f.rank === i + 1));
    // counts reflect severity tiers (critical always 0 for this non-security domain).
    assert.equal(env.counts.critical, 0);
    assert.equal(env.counts.high, 3);
    assert.equal(env.counts.medium, 2);
    assert.equal(env.counts.low, 1);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

// ---- Task 4: empty result (all verified gaps refuted) ----

test("repo-test-gaps returns empty envelope when every verified gap is refuted", async () => {
  // All HIGH_RISK lenses get verified in normal depth; refute them all.
  const route = makeRoute({ refute: () => true });
  const { tools, context, directory } = await makeHarness(nativeRouter(route));
  try {
    const env = await runLeafEnvelope(tools, context, {
      name: "repo-test-gaps",
      args: { depth: "normal", categories: HIGH_RISK },
    });
    assert.equal(env.status, "empty");
    assert.equal(env.counts.total, 0);
    assert.equal(env.findings.length, 0);
    assert.equal(env.reportMarkdown, null);
    assert.equal(env.truncatedFindings, false);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("repo-test-gaps returns empty envelope when finders find nothing", async () => {
  const route = makeRoute({});
  // Override the finder branch to return zero findings.
  const router = makeLeafPromptRouter((text, shape) => {
    if (text.includes("test-gap finder")) return shape({ findings: [] });
    return route(text, shape);
  }, { fallbackShape: structured });
  const { tools, context, directory } = await makeHarness(router);
  try {
    const env = await runLeafEnvelope(tools, context, { name: "repo-test-gaps", args: { depth: "normal" } });
    assert.equal(env.status, "empty");
    assert.equal(env.findings.length, 0);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

// ---- Task 5: unmeasured-coverage limitation wording ----

test("repo-test-gaps reports shellCoverage=none and a coverageLimitations string that does NOT claim measured coverage", async () => {
  const route = makeRoute({ refute: (t) => t.includes("weak-critical-path") });
  const { tools, context, directory } = await makeHarness(nativeRouter(route));
  try {
    const env = await runLeafEnvelope(tools, context, { name: "repo-test-gaps", args: { depth: "normal" } });

    // shellCoverage vocabulary (docs/repo-review-leaf-contract.md §2): {none,partial,full}.
    assert.equal(env.shellCoverage, "none");
    // coverageLimitations is a non-empty string explaining coverage was NOT run.
    assert.equal(typeof env.coverageLimitations, "string");
    assert.ok(env.coverageLimitations.length > 0);
    // Wording must state coverage was NOT measured/run (the whole point of the field).
    assert.match(env.coverageLimitations, /not.*measured|was not.*run|not.*run/i, "coverageLimitations must state coverage was not measured/run");
    // It must NOT claim a coverage metric/percentage (no "NN%" style assertions).
    assert.ok(!/\d+\s*%/.test(env.coverageLimitations), "coverageLimitations must not claim a coverage percentage");
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("repo-test-gaps empty envelope still carries the unmeasured-coverage limitation fields", async () => {
  const route = makeRoute({ refute: () => true });
  const { tools, context, directory } = await makeHarness(nativeRouter(route));
  try {
    const env = await runLeafEnvelope(tools, context, {
      name: "repo-test-gaps",
      args: { depth: "normal", categories: HIGH_RISK },
    });
    assert.equal(env.status, "empty");
    assert.equal(env.shellCoverage, "none");
    assert.equal(typeof env.coverageLimitations, "string");
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

// ---- Task 6: shared envelope compliance (synthetic + field assertion) ----

test("SYNTHETIC test-gaps envelope (critical:0 + action fields) conforms to the leaf contract", () => {
  const env = {
    domain: "test-gaps", schemaVersion: 1, status: "ok", abortReason: null, reportPath: null,
    summary: "Found 1 test gap.",
    counts: { total: 1, critical: 0, high: 1, medium: 0, low: 0 },
    findings: [{
      id: "uncovered-public-1", fingerprint: "test-gaps-1a2b3c", rank: 1, category: "uncovered-public",
      file: "src/auth.js", line: 42, severity: "high",
      description: "login() has no test", targetUnderTest: "login()", suggestedTest: "should log in",
      proposedChange: "add auth.test.js", confidence: 80, effort: "small",
    }],
    truncatedFindings: false,
    reportMarkdown: "# Test Gaps Report",
    shellCoverage: "none",
    coverageLimitations: "Coverage was not run.",
  };
  assertLeafEnvelope(env, "test-gaps");
  assertLeafCounts(env.counts, "test-gaps");
  assertLeafFindings(env.findings, "test-gaps");
  assert.equal(env.counts.critical, 0); // non-security critical:0 rule
});

test("CONTRACT ENFORCEMENT: test-gaps with critical severity FAILS the assertion", () => {
  const bad = {
    id: "x-1", fingerprint: "test-gaps-bad", rank: 1, category: "uncovered-public", file: "src/x.js",
    line: 1, severity: "critical", description: "gap", confidence: 50, effort: "large",
  };
  assert.throws(() => assertLeafFinding(bad, "test-gaps"), /must not emit critical severity/);
});

// ---- Task 7: structured-text fallback (native structured output UNAVAILABLE) ----
//
// Reconciliation of the stale plan doc (docs/repo-review-leaf-contract.md §9):
// schema lanes do NOT fail closed when native structured output is unavailable.
// The kernel injects a structured-text instruction and parses the model's JSON
// text back. This test forces that path and asserts the same ranked envelope.
test("repo-test-gaps works under the structured-text fallback when native structured output is unavailable", async () => {
  const route = makeRoute({ refute: (t) => t.includes("weak-critical-path") });
  const { tools, context, directory } = await makeHarness(fallbackRouter(route), {
    capabilities: { ...DEFAULT_CAPABILITIES, structuredOutput: "unavailable" },
  });
  try {
    const env = await runLeafEnvelope(tools, context, { name: "repo-test-gaps", args: { depth: "normal" } });

    assert.equal(env.domain, "test-gaps");
    assert.equal(env.status, "ok");
    // Same as native happy path: 6 candidates - 1 refuted = 5 survive.
    assert.equal(env.counts.total, 5);
    assert.equal(env.counts.high, 5);
    assert.equal(env.counts.critical, 0);
    assert.ok(!env.findings.some((f) => f.category === "weak-critical-path"));
    assert.ok(env.findings.every((f) => f.fingerprint.startsWith("test-gaps-")));
    assertLeafFindings(env.findings, "test-gaps");
    assert.match(env.reportMarkdown, /# Test Gaps Report/);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

// ---- Task 8: fingerprint determinism (sentinel extraction) ----

test("fingerprintOf is deterministic, line-independent, and domain-prefixed", async () => {
  const src = await fs.readFile(GUEST_SRC, "utf8");
  const m = src.match(/\/\/ <suite:fingerprintOf>([\s\S]*?)\/\/ <\/suite:fingerprintOf>/);
  assert.ok(m, "fingerprintOf sentinel block not found in repo-test-gaps.js");
  // Extract the pure function; supply DOMAIN that the function closes over.
  const fingerprintOf = new Function("DOMAIN", `${m[1]}; return fingerprintOf;`)("test-gaps");

  const a = { file: "src/x.js", category: "uncovered-public", description: "Login has NO   test", line: 10 };
  const b = { file: "src/x.js", category: "uncovered-public", description: "login has no test", line: 999 };

  // Same input -> identical hash.
  assert.equal(fingerprintOf(a), fingerprintOf({ ...a }), "same input must hash identically");
  // Format: <domain>-<hex>.
  assert.match(fingerprintOf(a), /^test-gaps-[0-9a-f]+$/);
  // Line is EXCLUDED from the basis; whitespace/case normalized -> a and b collide by design.
  assert.equal(
    fingerprintOf({ file: "src/x.js", category: "uncovered-public", description: "login has no test" }),
    fingerprintOf(b),
    "fingerprint must be line-independent (no line number in the basis)",
  );
  // Different description -> different fingerprint.
  assert.notEqual(
    fingerprintOf({ file: "src/x.js", category: "uncovered-public", description: "something else" }),
    fingerprintOf(b),
  );
});

test("CONTRACT: the fingerprint BASIS in source does not reference the line number", async () => {
  const src = await fs.readFile(GUEST_SRC, "utf8");
  const m = src.match(/\/\/ <suite:fingerprintOf>([\s\S]*?)\/\/ <\/suite:fingerprintOf>/);
  assert.ok(m, "fingerprintOf sentinel block not found");
  const block = m[1];
  assert.ok(!/f\.line/.test(block), "fingerprint function must not reference f.line (line drifts)");
  assert.match(block, /DOMAIN/);
  assert.match(block, /norm\(f\.file\)/);
  assert.match(block, /norm\(f\.category\)/);
  assert.match(block, /norm\(f\.description\)\.slice\(0,\s*160\)/);
});

// ---- Bonus: bundled discovery + read-only profile; guest imports nothing; resilience ----

test("repo-test-gaps is discoverable as a bundled workflow and resolves by name with the read-only profile", async () => {
  const route = makeRoute({});
  const { tools, context, directory } = await makeHarness(nativeRouter(route));
  try {
    const listed = JSON.parse(await tools.workflow_list.execute({ format: "json" }, context));
    assert.ok(listed.some((e) => e.scope === "bundled" && e.name === "repo-test-gaps"),
      `repo-test-gaps not listed as bundled: ${JSON.stringify(listed)}`);

    const preview = await tools.workflow_run.execute({ name: "repo-test-gaps", args: { depth: "quick" } }, context);
    assert.match(preview, /Authority profile: read-only-review/);
    assert.match(preview, /approvalHash: [a-f0-9]{64}/);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("GUEST PROOF: repo-test-gaps.js imports/requires nothing and is a self-contained leaf", async () => {
  const src = await fs.readFile(GUEST_SRC, "utf8");
  assert.ok(!/^\s*import\b/m.test(src), "guest source must not contain ES import statements");
  assert.ok(!/\brequire\s*\(/.test(src), "guest source must not call require()");
  assert.ok(!src.includes("tests/helpers"), "guest source must not reference tests/helpers");
  assert.ok(!/import[\s\S]*?from\s+["'][^"']*\.mjs["']/.test(src), "guest source must not import .mjs modules");
  // Leaf: never CALLS workflow() at runtime (the meta calls leaves; nesting is one level only).
  // Strip comments first so the prose header (which legitimately mentions workflow()) does not match.
  const codeOnly = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  assert.ok(!/\bworkflow\s*\(/.test(codeOnly), "guest source must not call workflow() (leaf-only)");
  // Contract identity header.
  assert.match(src, /const DOMAIN = "test-gaps";/);
  assert.match(src, /const SCHEMA_VERSION = 1;/);
});

test("repo-test-gaps survives a finder lane failure (onFailure returnNull + filter)", async () => {
  // The uncovered-public finder crashes; its lane returns null and is dropped.
  // The remaining 5 lenses produce findings; weak-critical-path is refuted -> 4 survive.
  const route = makeRoute({ refute: (t) => t.includes("weak-critical-path") });
  const router = makeLeafPromptRouter((text, shape) => {
    if (text.includes('the "uncovered-public" test-gap finder')) throw new Error("simulated lane crash");
    return route(text, shape);
  }, { fallbackShape: structured });
  const { tools, context, directory } = await makeHarness(router);
  try {
    const env = await runLeafEnvelope(tools, context, { name: "repo-test-gaps", args: { depth: "normal" } });
    assert.equal(env.status, "ok");
    assert.equal(env.counts.total, 4);
    assert.ok(!env.findings.some((f) => f.category === "uncovered-public"));
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
