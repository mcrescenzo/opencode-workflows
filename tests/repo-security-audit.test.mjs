// repo-security-audit bundled workflow regression suite.
//
// Zero-token: every child session.prompt is routed to a canned payload by the
// shared test harness (tests/helpers/repo-review-leaf-harness.mjs, which factors
// tests/helpers/harness.mjs); no real model is ever called.
//
// Conforms to docs/repo-review-leaf-contract.md. Covers:
//   - happy path: critical + high + medium + low findings -> verify -> rank ->
//     envelope, with counts.critical normalized from real surviving findings
//   - skeptic refutation: a high finding (ssrf) AND a critical finding (secrets)
//     are each adversarially refutable (criticals are NOT exempt from verification)
//   - empty result (every candidate refuted)
//   - no-secret-content prompt/read expectations: finder prompts forbid embedding
//     raw secret values + mark credential files OFF-LIMITS, and the guest source
//     structurally cannot read files (no fs/require/import)
//   - result-size fitting a large finding set under the 256KB cap
//   - shared envelope compliance (assertLeafEnvelope/assertLeafFindings)
//   - bundled discovery + read-only-review profile
//   - Structured-text fallback (native structured output UNAVAILABLE) still yields
//     the correct ranked envelope via parseStructuredTextResult
//   - fingerprint determinism + line-independence (sentinel extraction)

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
const REPO_SECURITY_SRC = path.join(HERE, "..", "workflows", "repo-security-audit.js");

const ALL_CATEGORIES = [
  "injection", "authz", "secrets", "unsafe-deserialization", "ssrf",
  "crypto-misuse", "input-validation", "dep-cve", "insecure-default", "sensitive-logging",
];

// severity by category for the happy path: one critical (secrets), a mix of
// high/medium/low elsewhere, and ssrf is the skeptic-refuted high.
function sevFor(cat) {
  if (cat === "secrets") return "critical";
  if (cat === "crypto-misuse" || cat === "input-validation") return "medium";
  if (cat === "dep-cve" || cat === "insecure-default") return "low";
  return "high"; // injection, authz, unsafe-deserialization, ssrf, sensitive-logging
}
function exploitFor(sev) {
  if (sev === "critical" || sev === "high") return "high";
  if (sev === "medium") return "medium";
  return "low";
}

// ---- domain-specific prompt router ----
//
// `override(text, shape)` may return a canned response (or undefined to fall
// through). `defaultSecurityLane` emits one finding per category lens, a recon
// object, and a skeptic verdict that refutes exactly ssrf. `shape` is
// `structured` (native) or `textStructured` (fallback) so the SAME route drives
// both paths.
function securityPrompt(override, shape = structured) {
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
    return defaultSecurityLane(text, use);
  }, { fallbackShape: shape });
}

function defaultSecurityLane(text, shape) {
  if (text.includes("Profile this repository")) {
    return shape({ languages: ["javascript"], notes: "test repo" });
  }
  if (text.includes("security finder")) {
    const m = text.match(/the "([a-z-]+)" security finder/);
    const cat = m ? m[1] : "injection";
    const sev = sevFor(cat);
    return shape({ findings: [{
      category: cat, file: `src/${cat}.js`, line: 10, severity: sev,
      description: `${cat} vulnerability example`, cwe: "CWE-000",
      attackVector: `untrusted input reaches ${cat} sink`, exploitability: exploitFor(sev),
      proposedChange: `remediate ${cat}`, confidence: 80, effort: "small", docImpact: "",
    }] });
  }
  if (text.includes("You are a skeptic")) {
    // refute exactly the ssrf finding (default); everything else is kept.
    const refuted = text.includes("Finding (ssrf)");
    return shape({ refuted, reasoning: "test verdict", adjustedConfidence: refuted ? 10 : 80 });
  }
  return undefined;
}

// ---- happy path: critical + high + medium + low, verify, rank, envelope ----

test("repo-security-audit happy path: critical+high+medium+low findings, verify, rank, counts normalized", async () => {
  const { tools, context, directory } = await makeHarness(securityPrompt());
  try {
    const env = await runLeafEnvelope(tools, context, { name: "repo-security-audit", args: { depth: "normal" } });

    assertLeafEnvelope(env, "security");
    // 10 lenses x 1 finding = 10 candidates; ssrf (high) refuted -> 9 survive.
    assert.equal(env.counts.total, 9);
    // security is the ONE domain allowed to populate critical (the secrets finding).
    assert.equal(env.counts.critical, 1);
    assert.equal(env.counts.high, 4); // injection, authz, unsafe-deserialization, sensitive-logging
    assert.equal(env.counts.medium, 2); // crypto-misuse, input-validation
    assert.equal(env.counts.low, 2); // dep-cve, insecure-default
    assert.equal(env.truncatedFindings, false);
    // critical-count normalization: counts.critical is the REAL count of critical
    // findings (engine-normalized from survivors, never trusted from an agent).
    assert.equal(env.counts.critical, env.findings.filter((f) => f.severity === "critical").length);
    assert.ok(env.findings.some((f) => f.severity === "critical" && f.category === "secrets"));
    assert.ok(!env.findings.some((f) => f.category === "ssrf"), "refuted ssrf finding must be dropped");

    assertLeafFindings(env.findings, "security");
    assert.ok(env.findings.every((f) => f.fingerprint.startsWith("security-")));
    assert.ok(env.findings.every((f, i) => f.rank === i + 1));
    // Security-specific action fields survive synthesis.
    assert.ok(env.findings.every((f) => typeof f.cwe === "string"));
    assert.ok(env.findings.every((f) => typeof f.attackVector === "string" && f.attackVector.length > 0));
    assert.ok(env.findings.every((f) => ["high", "medium", "low"].includes(f.exploitability)));
    assert.ok(env.findings.every((f) => typeof f.proposedChange === "string"));
    // Coverage disclosure (per-bead): no scanners run in-guest.
    assert.equal(env.shellCoverage, "none");
    assert.ok(typeof env.coverageLimitations === "string" && env.coverageLimitations.length > 0);
    assert.match(env.reportMarkdown, /# Security Audit Report/);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

// ---- skeptic refutation: a CRITICAL finding is also refutable (not exempt) ----

test("repo-security-audit refutes a CRITICAL secrets finding (criticals are verified too)", async () => {
  const override = (text, shape) => {
    if (text.includes("You are a skeptic") && text.includes("Finding (secrets)")) {
      return shape({ refuted: true, reasoning: "not reachable: input is bound and parameterized upstream", adjustedConfidence: 8 });
    }
    return undefined;
  };
  const { tools, context, directory } = await makeHarness(securityPrompt(override));
  try {
    const env = await runLeafEnvelope(tools, context, { name: "repo-security-audit", args: { depth: "normal" } });
    assertLeafEnvelope(env, "security");
    // secrets (critical) + ssrf (high) both refuted -> 8 survive, and critical
    // normalizes to 0 because no critical finding survived verification.
    assert.equal(env.counts.total, 8);
    assert.equal(env.counts.critical, 0);
    assert.ok(!env.findings.some((f) => f.category === "secrets"), "refuted critical secrets finding must be dropped");
    assert.ok(!env.findings.some((f) => f.category === "ssrf"));
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

// ---- empty result (every candidate refuted) ----

test("repo-security-audit returns an empty envelope when every candidate is refuted", async () => {
  const override = (text, shape) => {
    if (text.includes("You are a skeptic")) return shape({ refuted: true, reasoning: "all refuted", adjustedConfidence: 5 });
    return undefined;
  };
  const { tools, context, directory } = await makeHarness(securityPrompt(override));
  try {
    const env = await runLeafEnvelope(tools, context, { name: "repo-security-audit", args: { depth: "normal" } });
    assertLeafEnvelope(env, "security");
    assert.equal(env.status, "empty");
    assert.equal(env.counts.total, 0);
    assert.equal(env.counts.critical, 0);
    assert.equal(env.findings.length, 0);
    assert.equal(env.reportMarkdown, null);
    assert.equal(env.truncatedFindings, false);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

// ---- no-secret-content prompt/read expectations ----
//
// Security must find credential/secret RISKS without surfacing raw secret values
// and without directing lanes to read credential files. This is enforced at the
// PROMPT layer here (the SAFETY directive) and structurally by the guest sandbox
// (the engine cannot fs/require/import). In-guest value masking of model prose is
// owned by the follow-up secret-containment bead; this test covers the rrev.5
// prompt/read-expectation surface.

test("repo-security-audit prompts forbid raw secret values and mark credential files OFF-LIMITS", async () => {
  const { tools, context, directory, calls } = await makeHarness(securityPrompt());
  try {
    await runLeafEnvelope(tools, context, { name: "repo-security-audit", args: { depth: "normal" } });
    const prompts = calls.prompt.map((p) => String(p?.body?.parts?.[0]?.text ?? ""));
    assert.ok(prompts.length > 0, "expected child prompts to be captured");

    // Every finder prompt carries the no-raw-secret directive.
    const finderPrompts = prompts.filter((t) => t.includes("security finder"));
    assert.equal(finderPrompts.length, ALL_CATEGORIES.length, "one finder prompt per category lens");
    assert.ok(
      finderPrompts.every((t) => /NEVER paste or embed raw secret values/.test(t)),
      "every finder prompt must forbid embedding raw secret values",
    );

    // Credential files may be MENTIONED only as OFF-LIMITS, never as a read target.
    // (The SAFETY directive references them inside its "OFF-LIMITS for reading" line.)
    const credToken = /\.env\b|id_rsa|\*\.pem\b|\*\.key\b|~\/\.ssh/i;
    for (const t of prompts) {
      if (credToken.test(t)) {
        assert.ok(
          /OFF-LIMITS/i.test(t),
          "credential files may only appear in a prompt as OFF-LIMITS, never as a read target",
        );
      }
    }
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("repo-security-audit guest source structurally cannot read files (no fs/require/import)", async () => {
  const src = await fs.readFile(REPO_SECURITY_SRC, "utf8");
  assert.ok(!/^\s*import\b/m.test(src), "guest source must not contain ES import statements");
  assert.ok(!/\brequire\s*\(/.test(src), "guest source must not call require()");
  assert.ok(!/\b(?:readFile|readFileSync|writeFile|writeFileSync|readdir)\b/.test(src), "guest source must not touch the filesystem");
  assert.ok(!src.includes("tests/helpers"), "guest source must not reference tests/helpers");
});

// ---- result-size fitting under the 256KB host cap ----

test("repo-security-audit size-fits a large finding set under the 256KB cap", async () => {
  const PER_LENS = 10; // 10 lenses x 10 = 100 findings; 1 recon + 10 finders + 100 skeptics = 111 agents (< maxAgents 128)
  const big = "x".repeat(2000);
  const override = (text, shape) => {
    if (text.includes("security finder")) {
      const m = text.match(/the "([a-z-]+)" security finder/);
      const cat = m ? m[1] : "injection";
      const findings = [];
      for (let i = 0; i < PER_LENS; i++) {
        findings.push({
          category: cat, file: `src/${cat}-${i}.js`, line: i + 1, severity: "low",
          description: `${cat} ${i} ${big}`, cwe: "CWE-1", attackVector: big,
          exploitability: "low", proposedChange: big, confidence: 50, effort: "large", docImpact: "",
        });
      }
      return shape({ findings });
    }
    if (text.includes("You are a skeptic")) return shape({ refuted: false, reasoning: "keep", adjustedConfidence: 50 });
    return undefined;
  };
  const { tools, context, directory } = await makeHarness(securityPrompt(override));
  try {
    const env = await runLeafEnvelope(tools, context, { name: "repo-security-audit", args: { depth: "normal", maxReturnFindings: 200 } });
    assert.equal(env.status, "ok");
    // counts reflect ALL findings (10 lenses x 10 = 100); returned array is truncated to fit.
    assert.equal(env.counts.total, ALL_CATEGORIES.length * PER_LENS);
    assert.equal(env.truncatedFindings, true);
    assert.ok(JSON.stringify(env).length < 262144, "returned envelope must be under the host result cap");
    // Even truncated, the envelope still conforms + critical stays normalized (all low here).
    assertLeafCountsSafe(env);
    assert.equal(env.shellCoverage, "none");
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

// Local helper: counts invariants for a truncated ok envelope (security domain).
function assertLeafCountsSafe(env) {
  assert.equal(env.domain, "security");
  const sum = env.counts.critical + env.counts.high + env.counts.medium + env.counts.low;
  assert.equal(env.counts.total, sum, "counts.total must equal critical+high+medium+low even when truncated");
  assert.ok(env.counts.critical >= 0);
}

// ---- depth profiles: quick verifies critical+high only; thorough uses 3-skeptic majority + 2nd round ----

test("repo-security-audit quick depth verifies only critical+high (a refuted medium still survives)", async () => {
  // quick does NOT verify medium/low, so refuting every skeptic cannot drop them.
  // The critical (secrets) and high (non-ssrf) ARE verified; ssrf (high) is refuted.
  const override = (text, shape) => {
    if (text.includes("You are a skeptic")) return shape({ refuted: true, reasoning: "refuted", adjustedConfidence: 5 });
    return undefined;
  };
  const { tools, context, directory } = await makeHarness(securityPrompt(override));
  try {
    const env = await runLeafEnvelope(tools, context, { name: "repo-security-audit", args: { depth: "quick" } });
    assertLeafEnvelope(env, "security");
    assert.equal(env.status, "ok");
    // quick verifies critical+high only. critical (secrets) + all highs refuted -> dropped.
    // medium (2) + low (2) pass through unverified -> 4 survive.
    assert.equal(env.counts.total, 4);
    assert.equal(env.counts.critical, 0); // the only critical was verified-and-refuted
    assert.equal(env.counts.medium, 2);
    assert.equal(env.counts.low, 2);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("repo-security-audit thorough depth uses 3-skeptic majority + a 2nd find round", async () => {
  // thorough: 3 skeptics per finding, keep unless >=2 refute; plus a 2nd find round
  // (dedup removes identical repeats -> no net new). Refute secrets with ONLY
  // reviewer #1 -> 1 < 2 -> the critical secrets finding SURVIVES.
  const override = (text, shape) => {
    if (text.includes("You are a skeptic") && text.includes("Finding (secrets)") && text.includes("Independent reviewer #1")) {
      return shape({ refuted: true, reasoning: "lone refute", adjustedConfidence: 10 });
    }
    return undefined; // reviewers #2/#3 + the default ssrf-refute path apply
  };
  const { tools, context, directory } = await makeHarness(securityPrompt(override));
  try {
    const env = await runLeafEnvelope(tools, context, { name: "repo-security-audit", args: { depth: "thorough" } });
    assertLeafEnvelope(env, "security");
    // secrets: 1 refute < 2 -> kept. ssrf: all 3 reviewers refute (default lane) -> dropped.
    // 2nd round returns the same per-lens findings -> deduped away. 10 - 1 (ssrf) = 9.
    assert.equal(env.counts.total, 9);
    assert.equal(env.counts.critical, 1); // secrets survived the majority vote
    assert.ok(env.findings.some((f) => f.category === "secrets"));
    assert.ok(!env.findings.some((f) => f.category === "ssrf"));
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

// ---- bundled discovery + read-only-review profile ----

test("repo-security-audit is discoverable as a bundled workflow with the read-only-review profile", async () => {
  const { tools, context, directory } = await makeHarness(securityPrompt());
  try {
    const listed = JSON.parse(await tools.workflow_list.execute({ format: "json" }, context));
    assert.ok(listed.some((e) => e.scope === "bundled" && e.name === "repo-security-audit"),
      `repo-security-audit not listed as bundled: ${JSON.stringify(listed)}`);

    const preview = await tools.workflow_run.execute({ name: "repo-security-audit", args: { depth: "quick" } }, context);
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
// This test forces that path and asserts the workflow still produces the correct
// ranked envelope (including the critical tier + security action fields).

test("repo-security-audit works under the structured-text fallback when native structured output is unavailable", async () => {
  const { tools, context, directory } = await makeHarness(securityPrompt(null, textStructured), {
    capabilities: { ...DEFAULT_CAPABILITIES, structuredOutput: "unavailable" },
  });
  try {
    const env = await runLeafEnvelope(tools, context, { name: "repo-security-audit", args: { depth: "normal" } });

    // Same ranked envelope as the native happy path: ssrf refuted -> 9 survive.
    assertLeafEnvelope(env, "security");
    assert.equal(env.status, "ok");
    assert.equal(env.counts.total, 9);
    assert.equal(env.counts.critical, 1);
    assert.ok(!env.findings.some((f) => f.category === "ssrf"), "ssrf must still be refuted via the fallback path");
    assertLeafFindings(env.findings, "security");
    assert.ok(env.findings.every((f) => f.fingerprint.startsWith("security-")));
    // Security action fields survive the text-parse path.
    assert.ok(env.findings.every((f) => typeof f.attackVector === "string" && typeof f.cwe === "string"));
    assert.match(env.reportMarkdown, /# Security Audit Report/);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

// ---- fingerprint determinism (sentinel extraction) ----

test("fingerprintOf is deterministic, line-independent, and security-prefixed", async () => {
  const src = await fs.readFile(REPO_SECURITY_SRC, "utf8");
  const m = src.match(/\/\/ <suite:fingerprintOf>([\s\S]*?)\/\/ <\/suite:fingerprintOf>/);
  assert.ok(m, "fingerprintOf sentinel block not found in repo-security-audit.js");
  // Extract the pure function; supply DOMAIN that the function closes over.
  const fingerprintOf = new Function("DOMAIN", `${m[1]}; return fingerprintOf;`)("security");

  const a = { file: "src/x.js", category: "injection", description: "SQL injection in   query", line: 10 };
  const b = { file: "src/x.js", category: "injection", description: "sql injection in query", line: 999 };

  // Same input -> identical hash.
  assert.equal(fingerprintOf(a), fingerprintOf({ ...a }), "same input must hash identically");
  // Format: <domain>-<hex>.
  assert.match(fingerprintOf(a), /^security-[0-9a-f]+$/);
  // Line is EXCLUDED from the basis; whitespace/case normalized -> a and b collide by design.
  assert.equal(
    fingerprintOf({ file: "src/x.js", category: "injection", description: "sql injection in query" }),
    fingerprintOf(b),
    "fingerprint must be line-independent (no line number in the basis)",
  );
  // Different description -> different fingerprint.
  assert.notEqual(
    fingerprintOf({ file: "src/x.js", category: "injection", description: "something else entirely" }),
    fingerprintOf(b),
  );
});

test("the fingerprint BASIS in repo-security-audit source does not reference the line number", async () => {
  const src = await fs.readFile(REPO_SECURITY_SRC, "utf8");
  const m = src.match(/\/\/ <suite:fingerprintOf>([\s\S]*?)\/\/ <\/suite:fingerprintOf>/);
  assert.ok(m, "fingerprintOf sentinel block not found");
  const block = m[1];
  assert.ok(!/f\.line/.test(block), "fingerprint function must not reference f.line (line drifts)");
  assert.match(block, /DOMAIN/, "basis must include DOMAIN");
  assert.match(block, /norm\(f\.file\)/, "basis must include file");
  assert.match(block, /norm\(f\.category\)/, "basis must include category");
  assert.match(block, /norm\(f\.description\)\.slice\(0,\s*160\)/, "basis must truncate description to 160 chars");
});
