// repo-cleanup bundled workflow regression suite.
//
// Zero-token: every child session.prompt is routed to a canned payload by the
// shared test harness (tests/helpers/repo-review-leaf-harness.mjs, which factors
// tests/helpers/harness.mjs); no real model is ever called.
//
// Conforms to docs/repo-review-leaf-contract.md. Covers:
//   - happy path: multiple category findings (dead-code/unused-deps/duplication)
//     -> verify -> rank -> envelope, with staleDocs populated from doc-drift
//   - false-positive refutation: a high-risk "remove this" finding refuted & dropped
//   - depth profiles: quick skips verify; thorough verifies all + 2nd round
//   - empty result; ranking order by score; shared envelope compliance
//   - size-fitting a large finding set under the 256KB cap
//   - bundled discovery + read-only-review profile
//   - Structured-text fallback (native structured output UNAVAILABLE) still yields
//     the correct ranked envelope (reconciliation of the stale plan doc).
//   - fingerprint determinism (sentinel extraction).

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
const REPO_CLEANUP_SRC = path.join(HERE, "..", "workflows", "repo-cleanup.js");

const ALL_CATEGORIES = ["dead-code", "unused-deps", "duplication", "stale-markers", "simplification", "best-practice", "doc-drift"];

// ---- domain-specific prompt router ----
//
// `override(text, shape)` may return a canned response (or undefined to fall
// through). `defaultCleanupLane` emits one finding per category lens, a recon
// object, and a "keep" verdict. `shape` is `structured` (native) or
// `textStructured` (fallback) so the SAME route drives both paths.
function cleanupPrompt(override, shape = structured) {
  // Pass `shape` as makeLeafPromptRouter's fallbackShape so the SAME route drives
  // both paths: native (structured) and fallback (textStructured). Without this,
  // the router defaults to `structured` and a fallback run gets native-shaped
  // responses that the text parser cannot read -> empty.
  return makeLeafPromptRouter((text, sh) => {
    const use = sh || shape;
    if (override) {
      const r = override(text, use);
      if (r !== undefined) return r;
    }
    return defaultCleanupLane(text, use);
  }, { fallbackShape: shape });
}

function defaultCleanupLane(text, shape) {
  if (text.includes("Profile this repository")) {
    return shape({ languages: ["javascript"], notes: "test repo" });
  }
  if (text.includes("finder")) {
    const m = text.match(/the "([a-z-]+)" finder/);
    const cat = m ? m[1] : "dead-code";
    return shape({ findings: [{
      category: cat, file: `src/${cat}.js`, line: 10, severity: "medium",
      description: `${cat} cleanup example`, proposedChange: `clean up the ${cat}`,
      confidence: 70, effort: "small", docImpact: "",
    }] });
  }
  if (text.includes("You are a skeptic")) {
    return shape({ refuted: false, reasoning: "keep", adjustedConfidence: 65 });
  }
  return undefined;
}

// ---- happy path: multiple category findings + staleDocs + envelope compliance ----

test("repo-cleanup happy path: dead-code/unused-deps/duplication findings, verify, rank, staleDocs", async () => {
  const { tools, context, directory } = await makeHarness(cleanupPrompt());
  try {
    const env = await runLeafEnvelope(tools, context, { name: "repo-cleanup", args: { depth: "normal" } });

    assertLeafEnvelope(env, "cleanup");
    // 7 lenses x 1 finding = 7; in 'normal' dead-code + unused-deps are verified and kept.
    assert.equal(env.counts.total, 7);
    assert.equal(env.counts.critical, 0); // non-security critical:0 rule
    assert.equal(env.truncatedFindings, false);
    assertLeafFindings(env.findings, "cleanup");
    assert.ok(env.findings.every((f) => f.fingerprint.startsWith("cleanup-")));
    assert.ok(env.findings.every((f, i) => f.rank === i + 1));
    // The cleanup-specific action fields survive synthesis.
    assert.ok(env.findings.every((f) => typeof f.proposedChange === "string" && typeof f.docImpact === "string"));
    // dead-code / unused-deps / duplication categories are all present.
    for (const cat of ["dead-code", "unused-deps", "duplication"]) {
      assert.ok(env.findings.some((f) => f.category === cat), `expected a ${cat} finding`);
    }
    // Per-domain carve-out: doc-drift finding survived -> staleDocs populated with its path.
    assert.ok(Array.isArray(env.staleDocs), "staleDocs must be an array (per-domain carve-out)");
    assert.deepEqual(env.staleDocs, ["src/doc-drift.js"]);
    assert.match(env.reportMarkdown, /# Cleanup Report/);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

// ---- false-positive refutation (the high-risk "remove this" categories) ----

test("repo-cleanup refutes a dead-code false positive (normal verifies HIGH_RISK)", async () => {
  // In 'normal' only dead-code + unused-deps are verified. Refute exactly dead-code:
  // it must be dropped while unused-deps (also verified, kept) survives. Match on the
  // `Finding (dead-code)` header — the skeptic prompt always mentions "dead-code" in its
  // instructions ("For dead-code / unused-deps especially"), so a bare includes() would
  // refute every skeptic.
  const override = (text, shape) => {
    if (text.includes("You are a skeptic") && text.includes("Finding (dead-code)")) {
      return shape({ refuted: true, reasoning: "used via dynamic dispatch", adjustedConfidence: 10 });
    }
    return undefined;
  };
  const { tools, context, directory } = await makeHarness(cleanupPrompt(override));
  try {
    const env = await runLeafEnvelope(tools, context, { name: "repo-cleanup", args: { depth: "normal" } });

    assertLeafEnvelope(env, "cleanup");
    assert.equal(env.counts.total, 6); // 7 - 1 refuted dead-code
    assert.ok(!env.findings.some((f) => f.category === "dead-code"), "refuted dead-code finding must be dropped");
    assert.ok(env.findings.some((f) => f.category === "unused-deps"), "unused-deps (verified, kept) must survive");
    // doc-drift still survived -> staleDocs still populated.
    assert.deepEqual(env.staleDocs, ["src/doc-drift.js"]);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

// ---- depth profiles ----

test("repo-cleanup quick depth skips verification (a refuted dead-code still survives)", async () => {
  // quick verifies NOTHING, so even an all-refute skeptic cannot drop anything.
  const override = (text, shape) => {
    if (text.includes("You are a skeptic")) return shape({ refuted: true, reasoning: "all refuted", adjustedConfidence: 5 });
    return undefined;
  };
  const { tools, context, directory } = await makeHarness(cleanupPrompt(override));
  try {
    const env = await runLeafEnvelope(tools, context, { name: "repo-cleanup", args: { depth: "quick" } });
    assert.equal(env.status, "ok");
    assert.equal(env.counts.total, 7); // none verified -> all pass through
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("repo-cleanup thorough depth verifies ALL categories + runs a 2nd find round", async () => {
  // thorough verifies every category. Refute dead-code -> dropped; the other 6 kept.
  // The 2nd find round returns the same per-lens findings, which dedup away.
  const override = (text, shape) => {
    if (text.includes("You are a skeptic") && text.includes("Finding (dead-code)")) {
      return shape({ refuted: true, reasoning: "false positive", adjustedConfidence: 10 });
    }
    return undefined;
  };
  const { tools, context, directory } = await makeHarness(cleanupPrompt(override));
  try {
    const env = await runLeafEnvelope(tools, context, { name: "repo-cleanup", args: { depth: "thorough" } });
    assertLeafEnvelope(env, "cleanup");
    assert.equal(env.counts.total, 6); // dead-code refuted; round-2 duplicates deduped
    assert.ok(!env.findings.some((f) => f.category === "dead-code"));
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

// ---- empty result ----

test("repo-cleanup returns an empty envelope (with empty staleDocs) when nothing is found", async () => {
  const override = (text, shape) => {
    if (text.includes("finder")) return shape({ findings: [] });
    return undefined;
  };
  const { tools, context, directory } = await makeHarness(cleanupPrompt(override));
  try {
    const env = await runLeafEnvelope(tools, context, { name: "repo-cleanup", args: { depth: "normal" } });

    assertLeafEnvelope(env, "cleanup");
    assert.equal(env.status, "empty");
    assert.equal(env.counts.total, 0);
    assert.equal(env.findings.length, 0);
    assert.equal(env.reportMarkdown, null);
    assert.equal(env.truncatedFindings, false);
    assert.deepEqual(env.staleDocs, []); // no doc-drift finding survived -> empty carve-out
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

// ---- ranking by score (severity * confidence * effort) ----

test("repo-cleanup ranks findings by severity*confidence*effort descending", async () => {
  // Three lenses with deliberately distinct scores. Use 'quick' depth so NO finding is
  // verified — verification would overwrite confidence with the skeptic's adjustedConfidence
  // and disturb the asserted order. With confidence preserved:
  //   dead-code   high/90/small   3 * 0.90 * 1.0 = 2.70
  //   duplication low/80/medium   1 * 0.80 * 0.8 = 0.64
  //   unused-deps medium/50/large 2 * 0.50 * 0.6 = 0.60
  const sevs = {
    "dead-code": { severity: "high", confidence: 90, effort: "small" },
    "unused-deps": { severity: "medium", confidence: 50, effort: "large" },
    "duplication": { severity: "low", confidence: 80, effort: "medium" },
  };
  const override = (text, shape) => {
    if (text.includes("finder")) {
      const m = text.match(/the "([a-z-]+)" finder/);
      const cat = m ? m[1] : "dead-code";
      const s = sevs[cat] || { severity: "medium", confidence: 50, effort: "medium" };
      return shape({ findings: [{
        category: cat, file: `src/${cat}.js`, line: 5,
        description: `${cat} ranked example`, proposedChange: `fix ${cat}`,
        confidence: s.confidence, effort: s.effort, severity: s.severity, docImpact: "",
      }] });
    }
    return undefined;
  };
  const { tools, context, directory } = await makeHarness(cleanupPrompt(override));
  try {
    const env = await runLeafEnvelope(tools, context, {
      name: "repo-cleanup", args: { depth: "quick", categories: ["dead-code", "unused-deps", "duplication"] },
    });
    assertLeafEnvelope(env, "cleanup");
    assert.equal(env.counts.total, 3);
    // Expected descending order: dead-code (2.70) > duplication (0.64) > unused-deps (0.60).
    assert.equal(env.findings[0].category, "dead-code");
    assert.equal(env.findings[1].category, "duplication");
    assert.equal(env.findings[2].category, "unused-deps");
    assert.ok(env.findings.every((f, i) => f.rank === i + 1));
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

// ---- size-fitting under the 256KB host cap ----

test("repo-cleanup size-fits a large finding set under the 256KB cap", async () => {
  const PER_LENS = 15;
  const big = "x".repeat(2000);
  const override = (text, shape) => {
    if (text.includes("finder")) {
      const m = text.match(/the "([a-z-]+)" finder/);
      const cat = m ? m[1] : "dead-code";
      const findings = [];
      for (let i = 0; i < PER_LENS; i++) {
        findings.push({
          category: cat, file: `src/${cat}-${i}.js`, line: i + 1, severity: "low",
          description: `${cat} ${i} ${big}`, proposedChange: big,
          confidence: 50, effort: "large", docImpact: "",
        });
      }
      return shape({ findings });
    }
    if (text.includes("You are a skeptic")) return shape({ refuted: false, reasoning: "keep", adjustedConfidence: 50 });
    return undefined;
  };
  const { tools, context, directory } = await makeHarness(cleanupPrompt(override));
  try {
    const env = await runLeafEnvelope(tools, context, { name: "repo-cleanup", args: { depth: "normal", maxReturnFindings: 200 } });
    assert.equal(env.status, "ok");
    // counts reflect ALL findings (7 lenses x 15 = 105); returned array is truncated to fit.
    assert.equal(env.counts.total, ALL_CATEGORIES.length * PER_LENS);
    assert.equal(env.truncatedFindings, true);
    assert.ok(JSON.stringify(env).length < 262144, "returned envelope must be under the host result cap");
    assert.ok(Array.isArray(env.staleDocs));
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

// ---- bundled discovery + read-only-review profile ----

test("repo-cleanup is discoverable as a bundled workflow with the read-only-review profile", async () => {
  const { tools, context, directory } = await makeHarness(cleanupPrompt());
  try {
    const listed = JSON.parse(await tools.workflow_list.execute({ format: "json" }, context));
    assert.ok(listed.some((e) => e.scope === "bundled" && e.name === "repo-cleanup"),
      `repo-cleanup not listed as bundled: ${JSON.stringify(listed)}`);

    const preview = await tools.workflow_run.execute({ name: "repo-cleanup", args: { depth: "quick" } }, context);
    assert.match(preview, /Authority profile: read-only-review/);
    assert.match(preview, /approvalHash: [a-f0-9]{64}/);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

// ---- Structured-text fallback (native structured output UNAVAILABLE) ----
//
// Reconciliation of the stale plan doc: schema lanes do NOT fail closed when
// native structured output is unavailable. The kernel injects a structured-text
// instruction and parses the model's JSON text back (child-agent-runner.js:
// structuredTextInstruction -> outputFormat text -> parseStructuredTextResult).
// This test forces that path and asserts the workflow still produces the
// correct ranked envelope with staleDocs intact.

test("repo-cleanup works under the structured-text fallback when native structured output is unavailable", async () => {
  const { tools, context, directory } = await makeHarness(cleanupPrompt(null, textStructured), {
    capabilities: { ...DEFAULT_CAPABILITIES, structuredOutput: "unavailable" },
  });
  try {
    const env = await runLeafEnvelope(tools, context, { name: "repo-cleanup", args: { depth: "normal" } });

    // Same ranked envelope as the native happy path.
    assertLeafEnvelope(env, "cleanup");
    assert.equal(env.status, "ok");
    assert.equal(env.counts.total, 7);
    assert.equal(env.counts.critical, 0);
    assertLeafFindings(env.findings, "cleanup");
    assert.ok(env.findings.every((f) => f.fingerprint.startsWith("cleanup-")));
    // Per-domain carve-out survives the fallback path too.
    assert.deepEqual(env.staleDocs, ["src/doc-drift.js"]);
    assert.match(env.reportMarkdown, /# Cleanup Report/);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

// ---- fingerprint determinism (sentinel extraction) ----

test("fingerprintOf is deterministic, line-independent, and cleanup-prefixed", async () => {
  const src = await fs.readFile(REPO_CLEANUP_SRC, "utf8");
  const m = src.match(/\/\/ <suite:fingerprintOf>([\s\S]*?)\/\/ <\/suite:fingerprintOf>/);
  assert.ok(m, "fingerprintOf sentinel block not found in repo-cleanup.js");
  // Extract the pure function; supply DOMAIN that the function closes over.
  const fingerprintOf = new Function("DOMAIN", `${m[1]}; return fingerprintOf;`)("cleanup");

  const a = { file: "src/x.js", category: "dead-code", description: "Unused export foo   here", line: 10 };
  const b = { file: "src/x.js", category: "dead-code", description: "unused export foo here", line: 999 };

  // Same input -> identical hash.
  assert.equal(fingerprintOf(a), fingerprintOf({ ...a }), "same input must hash identically");
  // Format: <domain>-<hex>.
  assert.match(fingerprintOf(a), /^cleanup-[0-9a-f]+$/);
  // Line is EXCLUDED from the basis; whitespace/case normalized -> a and b collide by design.
  assert.equal(
    fingerprintOf({ file: "src/x.js", category: "dead-code", description: "unused export foo here" }),
    fingerprintOf(b),
    "fingerprint must be line-independent (no line number in the basis)",
  );
  // Different description -> different fingerprint.
  assert.notEqual(
    fingerprintOf({ file: "src/x.js", category: "dead-code", description: "something else entirely" }),
    fingerprintOf(b),
  );
});

test("the fingerprint BASIS in repo-cleanup source does not reference the line number", async () => {
  const src = await fs.readFile(REPO_CLEANUP_SRC, "utf8");
  const m = src.match(/\/\/ <suite:fingerprintOf>([\s\S]*?)\/\/ <\/suite:fingerprintOf>/);
  assert.ok(m, "fingerprintOf sentinel block not found");
  const block = m[1];
  assert.ok(!/f\.line/.test(block), "fingerprint function must not reference f.line (line drifts)");
  assert.match(block, /DOMAIN/, "basis must include DOMAIN");
  assert.match(block, /norm\(f\.file\)/, "basis must include file");
  assert.match(block, /norm\(f\.category\)/, "basis must include category");
  assert.match(block, /norm\(f\.description\)\.slice\(0,\s*160\)/, "basis must truncate description to 160 chars");
});
