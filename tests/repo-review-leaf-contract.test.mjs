// repo-* review LEAF CONTRACT tests.
//
// Zero-token: every child session.prompt is routed to a canned payload by the
// shared harness (tests/helpers/harness.mjs); no real model is ever called.
//
// Validates docs/repo-review-leaf-contract.md against:
//   1. a REAL repo-bughunt run (the canonical exemplar) — envelope/finding/
//      counts/fingerprint shapes conform to the contract.
//   2. SYNTHETIC leaf envelopes (minimal fakes) — including the security
//      critical carve-out, non-security critical:0 rule, empty/aborted paths,
//      and a top-level per-domain extra (cleanup -> staleDocs).
//   3. PROOF that guest workflow sources import nothing — repo-bughunt.js must
//      not reference tests/helpers/ or any .mjs module, and must contain no
//      import/require (QuickJS guests are self-contained).
//   4. the fingerprint function is deterministic and line-independent
//      (sentinel extraction, reused from the exemplar approach).

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import WorkflowPlugin from "../workflow-kernel/index.js";
import {
  makeHarness,
  DEFAULT_CAPABILITIES,
  structured,
  textStructured,
  runApprovedRequest,
  resultOutput,
  runIdFrom,
  assertLeafEnvelope,
  assertLeafCounts,
  assertLeafFinding,
  assertLeafFindings,
} from "./helpers/repo-review-leaf-harness.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_BUGHUNT_SRC = path.join(HERE, "..", "workflows", "repo-bughunt.js");
const REVIEW_WORKFLOW_SOURCES = [
  "repo-bughunt.js",
  "repo-cleanup.js",
  "repo-complexity.js",
  "repo-deps.js",
  "repo-modernize.js",
  "repo-perf.js",
  "repo-security-audit.js",
  "repo-test-gaps.js",
  "repo-review.js",
].map((file) => path.join(HERE, "..", "workflows", file));
const { executeSandbox, parseWorkflowSource } = WorkflowPlugin.__test;

function minimalSandboxRun(overrides = {}) {
  return {
    id: "repo-review-leaf-contract-invalid-category",
    sourcePath: REPO_BUGHUNT_SRC,
    hostCalls: 0,
    tokens: { input: 0, output: 0, reasoning: 0 },
    cost: 0,
    replayedTokens: { input: 0, output: 0, reasoning: 0 },
    replayedCost: 0,
    budgetCeilings: {},
    maxAgents: 1,
    agentsStarted: 0,
    ...overrides,
  };
}

// ---- minimal repo-bughunt prompt router (drives the REAL exemplar) ----
//
// Domain-specific routing lives in the test (not the harness). The harness
// supplies the response shapers (structured/textStructured) and the plumbing;
// each leaf test authors its own route over the exemplar's prompt vocabulary.
function bughuntRoute(text, shape) {
  if (text.includes("Profile this repository")) {
    return shape({ languages: ["javascript"], notes: "test repo" });
  }
  if (text.includes("bug finder")) {
    const m = text.match(/the "([a-z-]+)" bug finder/);
    const cat = m ? m[1] : "concurrency";
    return shape({
      findings: [{
        category: cat, file: `src/${cat}.js`, line: 10, severity: "high",
        description: `${cat} bug example`, reproSketch: "call it with edge input",
        fixSketch: "guard the path", proposedChange: "add a guard",
        confidence: 80, effort: "small", docImpact: "",
      }],
    });
  }
  if (text.includes("You are a skeptic")) {
    const refuted = text.includes("boundary"); // refute exactly the boundary finding
    return shape({ refuted, reasoning: "test verdict", adjustedConfidence: refuted ? 10 : 75 });
  }
  return undefined; // fall through to empty
}

// ---- 1. REAL repo-bughunt run conforms to the contract ----

test("REAL repo-bughunt run: envelope/findings/counts/fingerprint conform to the leaf contract", async () => {
  const { tools, context, directory } = await makeHarness(async (input) => {
    const text = String(input?.body?.parts?.[0]?.text ?? "");
    return (bughuntRoute(text, structured) ?? { data: { parts: [], info: {} } });
  });
  try {
    const out = await runApprovedRequest(tools, context, { name: "repo-bughunt", args: { depth: "normal" } });
    const env = await resultOutput(tools, context, out);

    // Envelope contract.
    assertLeafEnvelope(env, "bughunt");
    // 7 lenses x 1 finding = 7 candidates; boundary refuted -> 6 survive.
    assert.equal(env.counts.total, 6);
    assert.equal(env.counts.high, 6);
    assert.equal(env.counts.critical, 0); // non-security critical:0 rule
    assert.equal(env.truncatedFindings, false);
    assert.equal(typeof env.reportMarkdown, "string");

    // Finding-level contract (includes contiguous ranks + unique fingerprints).
    assertLeafFindings(env.findings, "bughunt");
    assert.ok(env.findings.every((f) => f.fingerprint.startsWith("bughunt-")));
    assert.ok(!env.findings.some((f) => f.category === "boundary"), "refuted boundary finding must be dropped");
    // bughunt action fields are present.
    assert.ok(env.findings.every((f) => typeof f.reproSketch === "string" && typeof f.fixSketch === "string"));
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("REAL repo-bughunt run conforms under the structured-text fallback path too", async () => {
  const { tools, context, directory } = await makeHarness(async (input) => {
    const text = String(input?.body?.parts?.[0]?.text ?? "");
    return (bughuntRoute(text, textStructured) ?? { data: { parts: [], info: {} } });
  }, { capabilities: { ...DEFAULT_CAPABILITIES, structuredOutput: "unavailable" } });
  try {
    const out = await runApprovedRequest(tools, context, { name: "repo-bughunt", args: { depth: "normal" } });
    const env = await resultOutput(tools, context, out);
    // Same envelope shape via the fallback path (the production default).
    assertLeafEnvelope(env, "bughunt");
    assertLeafFindings(env.findings, "bughunt");
    assert.equal(env.counts.total, 6);
    assert.equal(env.counts.critical, 0);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("repo-bughunt leaf body rejects a non-empty categories list when every category is invalid", async () => {
  const source = await fs.readFile(REPO_BUGHUNT_SRC, "utf8");
  const { body } = parseWorkflowSource(source);

  await assert.rejects(
    executeSandbox(
      {},
      {},
      minimalSandboxRun(),
      body,
      { depth: "quick", categories: ["not-a-category"] },
      {},
    ),
    /No valid repo-bughunt categories supplied/,
  );
});

// ---- 2. SYNTHETIC leaf envelopes conform ----

test("SYNTHETIC cleanup envelope (non-security + staleDocs extra + critical:0) conforms", () => {
  const env = {
    domain: "cleanup",
    schemaVersion: 1,
    status: "ok",
    abortReason: null,
    reportPath: null,
    summary: "Found 1 stale doc.",
    counts: { total: 1, critical: 0, high: 0, medium: 1, low: 0 },
    findings: [{
      id: "stale-docs-1", fingerprint: "cleanup-1a2b3c", rank: 1, category: "stale-docs",
      file: "docs/old.md", line: 1, severity: "medium",
      description: "Document references a removed API.", confidence: 70, effort: "small",
    }],
    truncatedFindings: false,
    reportMarkdown: "# Cleanup Report",
    staleDocs: ["docs/old.md"], // top-level per-domain extra (SUITE-CONTRACT carve-out)
  };
  assertLeafEnvelope(env, "cleanup");
  assertLeafCounts(env.counts, "cleanup");
  assertLeafFindings(env.findings, "cleanup");
  // top-level extra survived alongside the standard fields
  assert.deepEqual(env.staleDocs, ["docs/old.md"]);
});

test("SYNTHETIC security envelope IS allowed critical severity (the security carve-out)", () => {
  const env = {
    domain: "security",
    schemaVersion: 1,
    status: "ok",
    abortReason: null,
    reportPath: null,
    summary: "Found 1 critical vuln.",
    counts: { total: 1, critical: 1, high: 0, medium: 0, low: 0 },
    findings: [{
      id: "injection-1", fingerprint: "security-deadbeef", rank: 1, category: "injection",
      file: "src/api.js", line: 42, severity: "critical",
      description: "Unsanitized SQL concat.", confidence: 90, effort: "medium",
    }],
    truncatedFindings: false,
    reportMarkdown: "# Security Report",
  };
  assertLeafEnvelope(env, "security");
  assertLeafCounts(env.counts, "security");
  assertLeafFinding(env.findings[0], "security");
  assert.equal(env.counts.critical, 1); // security populates critical
});

test("SYNTHETIC empty + aborted envelopes conform", () => {
  const emptyEnv = {
    domain: "test-gaps", schemaVersion: 1, status: "empty", abortReason: null, reportPath: null,
    summary: "No test gaps found.",
    counts: { total: 0, critical: 0, high: 0, medium: 0, low: 0 },
    findings: [], truncatedFindings: false, reportMarkdown: null,
  };
  assertLeafEnvelope(emptyEnv, "test-gaps");

  const abortedEnv = {
    domain: "perf", schemaVersion: 1, status: "aborted", abortReason: "Profiler unavailable.",
    reportPath: null, summary: "Aborted: profiler unavailable.",
    counts: { total: 0, critical: 0, high: 0, medium: 0, low: 0 },
    findings: [], truncatedFindings: false, reportMarkdown: null,
  };
  assertLeafEnvelope(abortedEnv, "perf");
});

test("CONTRACT ENFORCEMENT: non-security domain with critical severity FAILS the assertion", () => {
  const badFinding = {
    id: "x-1", fingerprint: "deps-bad", rank: 1, category: "outdated", file: "pkg.json", line: 1,
    severity: "critical", description: "ancient dep", confidence: 50, effort: "large",
  };
  // deps is non-security -> critical severity must be rejected.
  assert.throws(() => assertLeafFinding(badFinding, "deps"), /must not emit critical severity/);
  // and counts.critical > 0 for a non-security domain is rejected.
  assert.throws(
    () => assertLeafCounts({ total: 1, critical: 1, high: 0, medium: 0, low: 0 }, "deps"),
    /must keep counts\.critical === 0/,
  );
});

// ---- 3. PROOF guest workflow sources import nothing ----

test("GUEST PROOF: repo-bughunt.js imports/requires nothing and references no shared helper module", async () => {
  const src = await fs.readFile(REPO_BUGHUNT_SRC, "utf8");

  // Guests are QuickJS-injected and self-contained: no module imports at all.
  assert.ok(!/^\s*import\b/m.test(src), "guest source must not contain ES import statements");
  assert.ok(!/\brequire\s*\(/.test(src), "guest source must not call require()");
  // Specifically must not reference the test helpers or any .mjs module.
  assert.ok(!src.includes("tests/helpers"), "guest source must not reference tests/helpers");
  assert.ok(!/import[\s\S]*?from\s+["'][^"']*\.mjs["']/.test(src), "guest source must not import .mjs modules");
  // Sanity: it DOES declare the contract identity header.
  assert.match(src, /const DOMAIN = "bughunt";/);
  assert.match(src, /const SCHEMA_VERSION = 1;/);
});

test("GUEST PROOF: review workflow budget checks use UTF-8 byte accounting", async () => {
  for (const sourcePath of REVIEW_WORKFLOW_SOURCES) {
    const src = await fs.readFile(sourcePath, "utf8");
    assert.match(src, /function jsonUtf8ByteLength/, `${path.basename(sourcePath)} must define byte-length budget helper`);
    assert.doesNotMatch(src, /JSON\.stringify\([^;\n]+?\)\.length/, `${path.basename(sourcePath)} must not budget JSON by UTF-16 length`);
  }
});

// ---- 4. Fingerprint is deterministic and line-independent ----

test("CONTRACT: fingerprintOf is deterministic, line-independent, and domain-prefixed", async () => {
  const src = await fs.readFile(REPO_BUGHUNT_SRC, "utf8");
  const m = src.match(/\/\/ <suite:fingerprintOf>([\s\S]*?)\/\/ <\/suite:fingerprintOf>/);
  assert.ok(m, "fingerprintOf sentinel block not found in repo-bughunt.js");
  // Extract the pure function; supply DOMAIN that the function closes over.
  const fingerprintOf = new Function("DOMAIN", `${m[1]}; return fingerprintOf;`)("bughunt");

  const a = { file: "src/x.js", category: "boundary", description: "Off by one in   loop", line: 10 };
  const b = { file: "src/x.js", category: "boundary", description: "off by one in loop", line: 999 };

  // Same input -> identical hash.
  assert.equal(fingerprintOf(a), fingerprintOf({ ...a }), "same input must hash identically");
  // Format: <domain>-<hex>.
  assert.match(fingerprintOf(a), /^bughunt-[0-9a-f]+$/);
  // Line is EXCLUDED from the basis; whitespace/case normalized -> a and b collide by design.
  assert.equal(
    fingerprintOf({ file: "src/x.js", category: "boundary", description: "off by one in loop" }),
    fingerprintOf(b),
    "fingerprint must be line-independent (no line number in the basis)",
  );
  // Different description -> different fingerprint.
  assert.notEqual(
    fingerprintOf({ file: "src/x.js", category: "boundary", description: "something else" }),
    fingerprintOf(b),
  );
});

test("CONTRACT: the fingerprint BASIS in source does not reference the line number", async () => {
  // Strong static guarantee: the canonical basis must be DOMAIN|file|category|desc[:160]
  // and must NOT mention f.line anywhere in the function (line drifts between runs).
  const src = await fs.readFile(REPO_BUGHUNT_SRC, "utf8");
  const m = src.match(/\/\/ <suite:fingerprintOf>([\s\S]*?)\/\/ <\/suite:fingerprintOf>/);
  assert.ok(m, "fingerprintOf sentinel block not found");
  const block = m[1];
  assert.ok(!/f\.line/.test(block), "fingerprint function must not reference f.line (line drifts)");
  // The four basis components, in order, separated by pipes (template-literal tolerant).
  assert.match(block, /DOMAIN/, "basis must include DOMAIN");
  assert.match(block, /norm\(f\.file\)/, "basis must include file");
  assert.match(block, /norm\(f\.category\)/, "basis must include category");
  assert.match(block, /norm\(f\.description\)\.slice\(0,\s*160\)/, "basis must truncate description to 160 chars");
});
