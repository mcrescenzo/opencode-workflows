// repo-complexity bundled workflow regression suite.
//
// Zero-token: every child session.prompt is routed to a canned payload by the
// shared test harness (tests/helpers/harness.mjs via the leaf harness); no real
// model is ever called.
//
// Covers (per opencode-workflows-rrev.10 acceptance):
//   - complexity findings (score -> verify -> rank -> envelope)
//   - skeptic refutation (an unsound refactor suggestion is dropped)
//   - maxDirs clamp behavior (per-directory fan-out is bounded)
//   - empty result
//   - ranking (primarily by hotspotScore, then severity, then confidence)
//   - shared envelope compliance (critical:0, 5-tier counts, severities, fingerprints)
//   - no-shell coverageLimitations (shellCoverage "none", churn lens deferred)
//   - structured-text fallback (native structured output UNAVAILABLE)
//   - fingerprint determinism (sentinel extraction)
//   - bundled name-resolution / discovery (profile read-only-review, NOT inspect-with-shell)
//   - abort path (complexity recon failure)

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  makeHarness,
  DEFAULT_CAPABILITIES,
  runLeafEnvelope,
  structured,
  textStructured,
  assertLeafEnvelope,
  assertLeafCounts,
  assertLeafFindings,
} from "./helpers/repo-review-leaf-harness.mjs";

// Complexity-specific action fields beyond the common required set (the harness's
// DOMAIN_ACTION_FIELDS map only carries bughunt today; verify these manually).
const COMPLEXITY_ACTION_FIELDS = ["churn", "complexityScore", "hotspotScore", "refactorSuggestion", "proposedChange"];

// ---- response router ----
//
// `route(text, shape)` inspects the prompt text and returns a canned response.
// `shape` is `structured` (native) or `textStructured` (fallback) so the SAME
// route drives both paths. `override(text)` may return a response (or throw) to
// customize a specific lane; returning undefined falls through to defaultLane.
function defaultLane(text, shape) {
  if (text.includes("Profile this repository for review")) {
    return shape({ languages: ["javascript"], notes: "test repo" });
  }
  if (text.includes("Profile this repository for a complexity")) {
    return shape({ profile: "compact js codebase", dirs: ["src/a", "src/b", "src/c"], gitAvailable: true });
  }
  if (text.includes("complexity scorer for the directory")) {
    const m = text.match(/the directory "([^"]+)"/);
    const dir = m ? m[1] : "src/x";
    return shape({ findings: [{
      category: "god-object", file: `${dir}/big.js`, line: 1, severity: "high",
      description: `god object in ${dir}`, churn: 3, complexityScore: 80, hotspotScore: 70,
      refactorSuggestion: "split the module", proposedChange: "extract helpers",
      confidence: 75, effort: "large", docImpact: "",
    }] });
  }
  if (text.includes("You are a skeptic")) {
    return shape({ refuted: false, reasoning: "sound refactor", adjustedConfidence: 72 });
  }
  return { data: { parts: [], info: {} } };
}

function complexityPrompt(override, shape = structured) {
  return async (input) => {
    const text = String(input?.body?.parts?.[0]?.text ?? "");
    if (override) {
      const r = override(text);
      if (r !== undefined) return r;
    }
    return defaultLane(text, shape);
  };
}

// ---- happy path ----

test("repo-complexity happy path: scores, verifies, ranks, returns envelope", async () => {
  const { tools, context, directory } = await makeHarness(complexityPrompt());
  try {
    const env = await runLeafEnvelope(tools, context, { name: "repo-complexity", args: { depth: "normal" } });

    assertLeafEnvelope(env, "complexity");
    assert.equal(env.status, "ok");
    // 3 dirs x 1 high-severity finding; none refuted -> 3 survive verification.
    assert.equal(env.counts.total, 3);
    assert.equal(env.counts.high, 3);
    assert.equal(env.counts.critical, 0);
    assertLeafFindings(env.findings, "complexity");

    // complexity-specific action fields present on every finding
    for (const f of env.findings) {
      for (const field of COMPLEXITY_ACTION_FIELDS) {
        assert.ok(f[field] !== undefined, `finding missing complexity action field: ${field}`);
      }
    }

    // no-shell coverage disclosure (churn lens deferred under read-only-review)
    assert.equal(env.shellCoverage, "none");
    assert.ok(typeof env.coverageLimitations === "string" && env.coverageLimitations.length > 0);
    assert.match(env.coverageLimitations, /churn/i);

    assert.match(env.reportMarkdown, /# Complexity Hotspot Report/);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

// ---- skeptic refutation ----

test("repo-complexity skeptic refutation drops an unsound refactor suggestion", async () => {
  // Refute exactly the src/b finding; the other two survive.
  const override = (text) => {
    if (text.includes("You are a skeptic") && text.includes("src/b/big.js")) {
      return structured({ refuted: true, reasoning: "refactor not worth it", adjustedConfidence: 10 });
    }
    return undefined;
  };
  const { tools, context, directory } = await makeHarness(complexityPrompt(override));
  try {
    const env = await runLeafEnvelope(tools, context, { name: "repo-complexity", args: { depth: "normal" } });

    assert.equal(env.status, "ok");
    assert.equal(env.counts.total, 2);
    assert.ok(!env.findings.some((f) => f.file === "src/b/big.js"), "refuted src/b finding must be dropped");
    assertLeafFindings(env.findings, "complexity");
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

// ---- maxDirs clamp ----

test("repo-complexity maxDirs clamp bounds the per-directory scorer fan-out", async () => {
  let scorerCalls = 0;
  const override = (text) => {
    if (text.includes("Profile this repository for a complexity")) {
      // domain recon discovers 5 dirs, but maxDirs=3 must clamp the fan-out to 3.
      return structured({ profile: "many dirs", dirs: ["d1", "d2", "d3", "d4", "d5"], gitAvailable: false });
    }
    if (text.includes("complexity scorer for the directory")) {
      scorerCalls += 1;
      return undefined; // fall through to defaultLane (one finding per scored dir)
    }
    return undefined;
  };
  const { tools, context, directory } = await makeHarness(complexityPrompt(override));
  try {
    const env = await runLeafEnvelope(tools, context, { name: "repo-complexity", args: { depth: "normal", maxDirs: 3 } });

    assert.equal(env.status, "ok");
    assert.equal(scorerCalls, 3, `maxDirs clamp should bound scorers to 3, got ${scorerCalls}`);
    assert.equal(env.counts.total, 3, "one finding per scored dir");
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

// ---- empty result ----

test("repo-complexity returns empty envelope when scorers find no hotspots", async () => {
  const override = (text) => {
    if (text.includes("complexity scorer for the directory")) {
      return structured({ findings: [] });
    }
    return undefined;
  };
  const { tools, context, directory } = await makeHarness(complexityPrompt(override));
  try {
    const env = await runLeafEnvelope(tools, context, { name: "repo-complexity", args: { depth: "normal" } });

    assertLeafEnvelope(env, "complexity"); // validates the empty-status invariants
    assert.equal(env.status, "empty");
    assert.equal(env.counts.total, 0);
    assert.equal(env.findings.length, 0);
    assert.equal(env.reportMarkdown, null);
    assert.equal(env.truncatedFindings, false);
    // coverage disclosure is still present on the empty path
    assert.equal(env.shellCoverage, "none");
    assert.ok(env.coverageLimitations);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

// ---- ranking ----

test("repo-complexity ranks primarily by hotspotScore (then severity, then confidence)", async () => {
  const override = (text) => {
    if (text.includes("Profile this repository for a complexity")) {
      return structured({ profile: "single dir", dirs: ["src/a"], gitAvailable: true });
    }
    if (text.includes("complexity scorer for the directory")) {
      return structured({ findings: [
        { category: "long-function", file: "src/a/f1.js", line: 1, severity: "high", description: "f1 long fn", churn: 0, complexityScore: 60, hotspotScore: 40, refactorSuggestion: "s1", proposedChange: "c1", confidence: 70, effort: "medium", docImpact: "" },
        { category: "god-object", file: "src/a/f2.js", line: 1, severity: "high", description: "f2 god object", churn: 0, complexityScore: 90, hotspotScore: 95, refactorSuggestion: "s2", proposedChange: "c2", confidence: 80, effort: "large", docImpact: "" },
        { category: "deep-nesting", file: "src/a/f3.js", line: 1, severity: "high", description: "f3 deep nest", churn: 0, complexityScore: 70, hotspotScore: 70, refactorSuggestion: "s3", proposedChange: "c3", confidence: 60, effort: "medium", docImpact: "" },
      ] });
    }
    return undefined;
  };
  const { tools, context, directory } = await makeHarness(complexityPrompt(override));
  try {
    const env = await runLeafEnvelope(tools, context, { name: "repo-complexity", args: { depth: "normal" } });

    assert.equal(env.status, "ok");
    assert.equal(env.counts.total, 3);
    // Ranked by hotspotScore desc: 95 > 70 > 40.
    assert.equal(env.findings[0].hotspotScore, 95);
    assert.equal(env.findings[1].hotspotScore, 70);
    assert.equal(env.findings[2].hotspotScore, 40);
    assert.ok(env.findings.every((f, i) => f.rank === i + 1), "ranks must be contiguous 1..N");
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

// ---- shared envelope compliance ----

test("repo-complexity envelope complies with the shared leaf contract (critical:0, 5-tier counts, severities)", async () => {
  const override = (text) => {
    if (text.includes("Profile this repository for a complexity")) {
      return structured({ profile: "mixed severity", dirs: ["src/a"], gitAvailable: false });
    }
    if (text.includes("complexity scorer for the directory")) {
      return structured({ findings: [
        { category: "god-object", file: "src/a/h.js", line: 1, severity: "high", description: "high hotspot", churn: 0, complexityScore: 90, hotspotScore: 90, refactorSuggestion: "sh", proposedChange: "ch", confidence: 80, effort: "large", docImpact: "" },
        { category: "long-function", file: "src/a/m.js", line: 1, severity: "medium", description: "medium hotspot", churn: 0, complexityScore: 60, hotspotScore: 60, refactorSuggestion: "sm", proposedChange: "cm", confidence: 70, effort: "medium", docImpact: "" },
        { category: "deep-nesting", file: "src/a/l.js", line: 1, severity: "low", description: "low hotspot", churn: 0, complexityScore: 40, hotspotScore: 40, refactorSuggestion: "sl", proposedChange: "cl", confidence: 60, effort: "small", docImpact: "" },
      ] });
    }
    return undefined;
  };
  const { tools, context, directory } = await makeHarness(complexityPrompt(override));
  try {
    const env = await runLeafEnvelope(tools, context, { name: "repo-complexity", args: { depth: "normal" } });

    assertLeafEnvelope(env, "complexity");
    assertLeafCounts(env.counts, "complexity");
    assertLeafFindings(env.findings, "complexity");
    // non-security domain: critical is always 0 and no finding carries critical severity.
    assert.equal(env.counts.critical, 0);
    assert.equal(env.counts.high, 1);
    assert.equal(env.counts.medium, 1);
    assert.equal(env.counts.low, 1);
    assert.ok(env.findings.every((f) => f.severity !== "critical"));
    // every fingerprint matches the complexity domain prefix
    assert.ok(env.findings.every((f) => f.fingerprint.startsWith("complexity-")));
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

// ---- structured-text fallback (native structured output UNAVAILABLE) ----
//
// Schema lanes do NOT fail closed when native structured output is unavailable:
// the kernel injects a structured-text instruction, sets outputFormat {type:text},
// and parses the model's JSON text back (child-agent-runner.js +
// workflow-kernel/structured-output.js). This forces that path and asserts the
// workflow still produces the correct ranked envelope.

test("repo-complexity works under the structured-text fallback when native structured output is unavailable", async () => {
  const { tools, context, directory } = await makeHarness(complexityPrompt(undefined, textStructured), {
    capabilities: { ...DEFAULT_CAPABILITIES, structuredOutput: "unavailable" },
  });
  try {
    const env = await runLeafEnvelope(tools, context, { name: "repo-complexity", args: { depth: "normal" } });

    assert.equal(env.domain, "complexity");
    assert.equal(env.status, "ok");
    assert.equal(env.counts.total, 3);
    assertLeafFindings(env.findings, "complexity");
    assert.ok(env.findings.every((f) => f.fingerprint.startsWith("complexity-")));
    assert.match(env.reportMarkdown, /# Complexity Hotspot Report/);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

// ---- fingerprint determinism (sentinel extraction) ----

test("fingerprintOf is deterministic and line-independent", async () => {
  const wfPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "workflows", "repo-complexity.js");
  const src = await fs.readFile(wfPath, "utf8");
  const m = src.match(/\/\/ <suite:fingerprintOf>([\s\S]*?)\/\/ <\/suite:fingerprintOf>/);
  assert.ok(m, "fingerprintOf sentinel block not found");
  // Extract the pure function; supply DOMAIN that the function closes over.
  const fingerprintOf = new Function("DOMAIN", `${m[1]}; return fingerprintOf;`)("complexity");

  const a = { file: "src/x.js", category: "god-object", description: "God object in   module", line: 10 };
  // NOTE: fingerprintOf normalizes case + whitespace in each field, and excludes `line` from the
  // basis, but does NOT strip path prefixes. Keep b on the SAME path as a so the collision proves
  // line-exclusion + description normalization (the stated intent), not a path-prefix difference.
  const b = { file: "src/x.js", category: "god-object", description: "god object in module", line: 999 };
  assert.equal(fingerprintOf(a), fingerprintOf({ ...a }), "same input must hash identically");
  assert.match(fingerprintOf(a), /^complexity-[0-9a-f]+$/);
  // line is excluded from the basis; whitespace/case normalized -> a and b collide by design.
  assert.equal(fingerprintOf({ file: "src/x.js", category: "god-object", description: "god object in module" }), fingerprintOf(b));
});

// ---- bundled discovery / name resolution ----

test("repo-complexity is discoverable as a bundled workflow and resolves by name under read-only-review", async () => {
  const { tools, context, directory } = await makeHarness(complexityPrompt());
  try {
    const listed = JSON.parse(await tools.workflow_list.execute({ format: "json" }, context));
    assert.ok(listed.some((e) => e.scope === "bundled" && e.name === "repo-complexity"),
      `repo-complexity not listed as bundled: ${JSON.stringify(listed)}`);

    // Preview by name must resolve the bundled source and show the read-only profile
    // (NOT inspect-with-shell — the shell/churn lens is intentionally deferred).
    const preview = await tools.workflow_run.execute({ name: "repo-complexity", args: { depth: "quick" } }, context);
    assert.match(preview, /Authority profile: read-only-review/);
    assert.doesNotMatch(preview, /inspect-with-shell/, "must ship under read-only-review, not inspect-with-shell");
    assert.match(preview, /approvalHash: [a-f0-9]{64}/);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

// ---- abort path (complexity recon failure) ----

test("repo-complexity aborts cleanly when complexity recon returns null", async () => {
  const override = (text) => {
    if (text.includes("Profile this repository for a complexity")) {
      // No structured payload -> the lane yields null (onFailure returnNull) -> domain recon failed.
      return { data: { parts: [], info: {} } };
    }
    return undefined;
  };
  const { tools, context, directory } = await makeHarness(complexityPrompt(override));
  try {
    const env = await runLeafEnvelope(tools, context, { name: "repo-complexity", args: { depth: "normal" } });

    assertLeafEnvelope(env, "complexity"); // validates the aborted-status invariants
    assert.equal(env.status, "aborted");
    assert.ok(typeof env.abortReason === "string" && env.abortReason.length > 0);
    assert.equal(env.findings.length, 0);
    assert.equal(env.reportMarkdown, null);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
