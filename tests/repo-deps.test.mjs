// repo-deps bundled workflow regression suite.
//
// Zero-token: every child session.prompt is routed to a canned payload by the
// shared test harness (tests/helpers/repo-review-leaf-harness.mjs, which reuses
// tests/helpers/harness.mjs); no real model is ever called.
//
// Conforms to docs/repo-review-leaf-contract.md. Covers:
//   - lockfile/manifest findings: find -> verify (high-risk unused/undeclared) -> rank -> envelope
//   - upgradePlan top-level carve-out (safeBatch / breakingChanges split by `breaking`)
//   - no-network/no-install read-only POLICY (prompt-level + source-level) + reduced-confidence guidance
//   - depth profiles (thorough round-2 dedup + verify-all; quick verifies nothing)
//   - resilience (empty result -> empty envelope with empty upgradePlan)
//   - shared envelope compliance (assertLeafEnvelope/Counts/Findings + DOMAIN_TOP_LEVEL_EXTRAS)
//   - size-fit under the 256KB cap
//   - structured-text fallback (native structured output UNAVAILABLE)
//   - fingerprint determinism (sentinel extraction)

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  makeHarness,
  runApprovedRequest,
  resultOutput,
  runLeafEnvelope,
  structured,
  textStructured,
  makeLeafPromptRouter,
  assertLeafEnvelope,
  assertLeafCounts,
  assertLeafFindings,
  DOMAIN_TOP_LEVEL_EXTRAS,
} from "./helpers/repo-review-leaf-harness.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WF_PATH = path.join(HERE, "..", "workflows", "repo-deps.js");

// ---- mock finding factory ----
// breaking survivors (license, version-conflict, deprecated) populate breakingChanges;
// non-breaking survivors populate safeBatch. Severity is varied to exercise counts.
const BREAKING = { license: true, "version-conflict": true, deprecated: true };
const SEV = { outdated: "high", cve: "high", unused: "medium", undeclared: "medium", license: "medium", "version-conflict": "low", deprecated: "low" };

function mockFinding(cat) {
  const breaking = !!BREAKING[cat];
  return {
    category: cat, package: `pkg-${cat}`, file: `pkg/manifests/${cat}.json`, line: 5,
    severity: SEV[cat] || "medium", description: `${cat} dependency issue example`,
    currentVersion: "1.0.0", targetVersion: breaking ? "2.0.0" : "1.1.0", breaking,
    cve: cat === "cve" ? ["CVE-2024-1234"] : [], advisory: cat === "cve" ? "known advisory" : "",
    proposedChange: "bump the package", confidence: 80, effort: "small", docImpact: "",
  };
}

// ---- prompt router ----
// refuteUnused: the skeptic refutes the (high-risk) 'unused' finding only, proving the
// verify filter drops it while the other high-risk ('undeclared') survives.
function makeDepsRouter({ refuteUnused = true, perCat = null, shape = structured } = {}) {
  const captured = [];
  const route = async (text, sh) => {
    captured.push(text);
    if (text.includes("Profile this repository")) {
      return sh({ languages: ["javascript"], notes: "test repo" });
    }
    if (text.includes("dependency analyst")) {
      const m = text.match(/the "([a-z-]+)" dependency analyst/);
      const cat = m ? m[1] : "outdated";
      if (perCat) {
        const big = "x".repeat(1200); // large enough that the findings array ALONE exceeds the 230KB headroom
        const findings = [];
        for (let i = 0; i < perCat; i++) {
          findings.push({
            ...mockFinding(cat), package: `pkg-${cat}-${i}`, file: `pkg/manifests/${cat}-${i}.json`,
            line: i + 1, severity: "low", description: `${cat} issue ${i} ${big}`,
            proposedChange: big, confidence: 50, effort: "large",
          });
        }
        return sh({ findings });
      }
      return sh({ findings: [mockFinding(cat)] });
    }
    if (text.includes("You are a skeptic")) {
      const refuted = refuteUnused && text.includes("Finding (unused)");
      return sh({ refuted, reasoning: "test verdict", adjustedConfidence: refuted ? 10 : 75 });
    }
    return undefined;
  };
  const router = makeLeafPromptRouter(route, { fallbackShape: shape, defaultLane: () => ({ data: { parts: [], info: {} } }) });
  return { router, captured };
}

const EXPECTED_SURVIVORS = ["outdated", "cve", "undeclared", "license", "version-conflict", "deprecated"];

// ---- happy path: lockfile/manifest findings -> envelope + upgradePlan ----

test("repo-deps happy path: finds, verifies high-risk, ranks, returns envelope with upgradePlan", async () => {
  const { router } = makeDepsRouter();
  const { tools, context, directory } = await makeHarness(router);
  try {
    const env = await runLeafEnvelope(tools, context, { name: "repo-deps", args: { depth: "normal" } });

    assert.equal(env.domain, "deps");
    assert.equal(env.schemaVersion, 1);
    assert.equal(env.status, "ok");
    assert.equal(env.reportPath, null);
    // 7 tracks x 1 finding; the high-risk 'unused' is refuted -> 6 survive.
    assert.equal(env.counts.total, 6);
    assert.equal(env.counts.high, 2); // outdated, cve
    assert.equal(env.counts.medium, 2); // undeclared, license
    assert.equal(env.counts.low, 2); // version-conflict, deprecated
    assert.equal(env.counts.critical, 0); // deps is non-security
    assert.ok(!env.findings.some((f) => f.category === "unused"), "refuted 'unused' finding must be dropped");
    assert.ok(env.findings.every((f) => f.fingerprint.startsWith("deps-")));
    assert.ok(env.findings.every((f, i) => f.rank === i + 1));
    // preserved deps fields for upgrade planning
    for (const f of env.findings) {
      for (const field of ["package", "currentVersion", "targetVersion", "breaking", "cve", "advisory"]) {
        assert.ok(f[field] !== undefined, `finding missing deps field: ${field}`);
      }
    }
    assert.match(env.reportMarkdown, /# Dependency Audit Report/);
    assert.match(env.reportMarkdown, /## Upgrade plan/);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

// ---- upgradePlan carve-out fields ----

test("repo-deps upgradePlan splits survivors by breaking flag (safeBatch vs breakingChanges)", async () => {
  const { router } = makeDepsRouter();
  const { tools, context, directory } = await makeHarness(router);
  try {
    const env = await runLeafEnvelope(tools, context, { name: "repo-deps", args: { depth: "normal" } });

    assert.ok(env.upgradePlan && typeof env.upgradePlan === "object", "upgradePlan must be a top-level object");
    assert.ok(Array.isArray(env.upgradePlan.safeBatch));
    assert.ok(Array.isArray(env.upgradePlan.breakingChanges));
    // non-breaking survivors: outdated, cve, undeclared
    assert.equal(env.upgradePlan.safeBatch.length, 3);
    assert.ok(env.upgradePlan.safeBatch.every((s) => s.includes("->")), "safeBatch entries are package: cur -> tgt");
    assert.ok(env.upgradePlan.safeBatch.some((s) => s.startsWith("pkg-outdated:")));
    // breaking survivors: license, version-conflict, deprecated (all target 2.0.0)
    assert.equal(env.upgradePlan.breakingChanges.length, 3);
    assert.ok(env.upgradePlan.breakingChanges.every((s) => s.includes("2.0.0")), "breaking entries carry the major target");
    // consistency: safeBatch count + breakingChanges count == survivor count
    assert.equal(env.upgradePlan.safeBatch.length + env.upgradePlan.breakingChanges.length, env.counts.total);
    // report markdown renders the plan too
    assert.match(env.reportMarkdown, /### Safe batch \(non-breaking\)/);
    assert.match(env.reportMarkdown, /### Breaking changes/);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

// ---- no-network / no-install policy (prompt-level) ----

test("repo-deps injects the read-only no-network/no-install policy into every lane and never instructs a mutation command", async () => {
  const { router, captured } = makeDepsRouter();
  const { tools, context, directory } = await makeHarness(router);
  try {
    await runLeafEnvelope(tools, context, { name: "repo-deps", args: { depth: "normal" } });

    const finderPrompts = captured.filter((t) => t.includes("dependency analyst"));
    const reconPrompts = captured.filter((t) => t.includes("Profile this repository"));
    const skepticPrompts = captured.filter((t) => t.includes("You are a skeptic"));
    assert.ok(finderPrompts.length >= 7, `expected >=7 finder prompts, got ${finderPrompts.length}`);
    assert.ok(reconPrompts.length === 1);

    const allLanePrompts = [...finderPrompts, ...reconPrompts, ...skepticPrompts];
    for (const p of allLanePrompts) {
      // The read-only policy block is present in every lane.
      assert.ok(p.includes("DEPENDENCY INSPECTION POLICY (read-only):"), "policy header missing");
      assert.ok(p.includes("Never run installs"), "install prohibition missing");
      assert.ok(p.includes("Never fetch from the network"), "network prohibition missing");
      // No POSITIVE mutation/install/network command is ever instructed. The policy uses the
      // generic words "installs"/"mutation"/"network" deliberately, so a bare package-manager
      // command token can never appear as an instruction.
      assert.doesNotMatch(p, /\b(npm|yarn|pnpm|pip|cargo|bundle)\s+(install|i|add|outdated|audit)\b/i,
        "lane must not instruct a package-manager install/audit command");
      assert.doesNotMatch(p, /\b(run|execute|invoke)\s+(npm|yarn|pnpm|pip|cargo|bundle|osv)\b/i,
        "lane must not instruct running a package manager / scanner");
    }
    // Reduced-confidence guidance is present for the cve/outdated tracks specifically.
    const cvePrompt = finderPrompts.find((t) => /the "cve" dependency analyst/.test(t));
    const outdatedPrompt = finderPrompts.find((t) => /the "outdated" dependency analyst/.test(t));
    assert.ok(cvePrompt && outdatedPrompt, "cve/outdated finder prompts not captured");
    assert.match(cvePrompt, /reduced confidence/i);
    assert.match(outdatedPrompt, /reduced confidence/i);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

// ---- no-network / no-install policy (source-level) ----

test("repo-deps source ships read-only-review profile, no hard-coded models, and a shell-inspection deferral note", async () => {
  const src = await fs.readFile(WF_PATH, "utf8");
  assert.match(src, /profile:\s*"read-only-review"/, "must ship the read-only-review profile");
  assert.match(src, /DEPENDENCY INSPECTION POLICY/, "DEPS_POLICY constant present");
  assert.match(src, /SHELL-INSPECTION DEFERRAL/, "shell-inspection deferral must be documented in a comment");
  // tier-based model selection; never hard-coded provider models.
  assert.match(src, /tier:\s*TIER_/);
  assert.doesNotMatch(src, /\bmodel\s*:\s*['"](sonnet|opus|haiku|gpt|claude|gemini)/i, "no hard-coded provider models");
  // guest is a QuickJS leaf: no module imports.
  assert.doesNotMatch(src, /\b(import|require)\s*[(]/, "guest source must not import/require modules");
});

// ---- depth profiles ----

test("repo-deps thorough depth runs a second find round (deduped) and verifies all findings", async () => {
  const { router } = makeDepsRouter();
  const { tools, context, directory } = await makeHarness(router);
  try {
    const env = await runLeafEnvelope(tools, context, { name: "repo-deps", args: { depth: "thorough" } });
    // Round 2 returns identical findings -> dedup keeps one of each; 'unused' is refuted in
    // verify-all -> 6 survive (same as normal, proving round-2 dupes did not inflate the set).
    assert.equal(env.status, "ok");
    assert.equal(env.counts.total, 6);
    assert.ok(!env.findings.some((f) => f.category === "unused"));
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("repo-deps quick depth verifies nothing, so all 7 candidate findings survive", async () => {
  const { router } = makeDepsRouter();
  const { tools, context, directory } = await makeHarness(router);
  try {
    const env = await runLeafEnvelope(tools, context, { name: "repo-deps", args: { depth: "quick" } });
    // quick skips verification entirely -> the 'unused' finding is NOT refuted -> 7 survive.
    assert.equal(env.counts.total, 7);
    assert.ok(env.findings.some((f) => f.category === "unused"));
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

// ---- empty result ----

test("repo-deps returns an empty envelope (with empty upgradePlan) when no findings surface", async () => {
  const emptyRoute = async () => structured({ findings: [] });
  const router = makeLeafPromptRouter(emptyRoute, { fallbackShape: structured });
  const { tools, context, directory } = await makeHarness(router);
  try {
    const env = await runLeafEnvelope(tools, context, { name: "repo-deps", args: { depth: "normal" } });
    assert.equal(env.status, "empty");
    assert.equal(env.counts.total, 0);
    assert.equal(env.findings.length, 0);
    assert.equal(env.reportMarkdown, null);
    assert.equal(env.truncatedFindings, false);
    // upgradePlan carve-out is present even on empty.
    assert.deepEqual(env.upgradePlan, { safeBatch: [], breakingChanges: [] });
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

// ---- shared envelope compliance ----

test("repo-deps envelope conforms to the shared leaf contract (counts/findings/top-level extra)", async () => {
  const { router } = makeDepsRouter();
  const { tools, context, directory } = await makeHarness(router);
  try {
    const env = await runLeafEnvelope(tools, context, { name: "repo-deps", args: { depth: "normal" } });
    assertLeafEnvelope(env, "deps");
    assertLeafCounts(env.counts, "deps");
    assertLeafFindings(env.findings, "deps");
    // deps carries the upgradePlan top-level extra (contract §2 carve-out).
    for (const field of DOMAIN_TOP_LEVEL_EXTRAS.deps) {
      assert.ok(env[field] !== undefined, `deps envelope missing top-level extra: ${field}`);
    }
    assert.equal(env.counts.critical, 0);
    assert.ok(env.findings.every((f) => f.severity !== "critical"), "non-security domain must never emit critical severity");
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

// ---- size-fit under the 256KB cap ----

test("repo-deps size-fits a large finding set under the 256KB cap", async () => {
  const PER_CAT = 20; // 7 x 20 = 140 findings; normal verifies only the 2 high-risk tracks (40 skeptics)
  // refuteUnused=false keeps every candidate so counts.total reflects the full 140 (size-fit only).
  const { router } = makeDepsRouter({ perCat: PER_CAT, refuteUnused: false });
  const { tools, context, directory } = await makeHarness(router);
  try {
    const env = await runLeafEnvelope(tools, context, { name: "repo-deps", args: { depth: "normal", maxReturnFindings: 200 } });
    assert.equal(env.status, "ok");
    // counts reflect ALL findings; only the returned array is truncated to fit.
    assert.equal(env.counts.total, 7 * PER_CAT);
    assert.equal(env.truncatedFindings, true);
    assert.ok(JSON.stringify(env).length < 262144, "returned envelope must be under the host result cap");
    assert.ok(env.upgradePlan && Array.isArray(env.upgradePlan.safeBatch), "upgradePlan present even when truncated");
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

// ---- structured-text (the only schema-lane path, Design C) ----
//
// child-agent-runner.js never sends `format:` to session.prompt: every schema-bearing lane
// gets a structuredTextInstruction and its final text is parsed back via
// parseStructuredTextResult. This test drives that path with the textStructured shaper and
// asserts the same ranked envelope as the other repo-deps tests in this file.

test("repo-deps works under the structured-text response shape", async () => {
  const { router } = makeDepsRouter({ shape: textStructured });
  const { tools, context, directory } = await makeHarness(router, {
    capabilities: { childSession: "available", worktree: "available", toast: "available" },
  });
  try {
    const env = await runLeafEnvelope(tools, context, { name: "repo-deps", args: { depth: "normal" } });
    // Same ranked envelope as the native happy path: 'unused' refuted -> 6 survive.
    assert.equal(env.domain, "deps");
    assert.equal(env.status, "ok");
    assert.equal(env.counts.total, 6);
    assert.equal(env.counts.high, 2);
    assert.ok(!env.findings.some((f) => f.category === "unused"));
    assert.ok(env.findings.every((f) => f.fingerprint.startsWith("deps-")));
    assert.ok(env.findings.every((f, i) => f.rank === i + 1));
    assert.equal(env.upgradePlan.safeBatch.length, 3);
    assert.equal(env.upgradePlan.breakingChanges.length, 3);
    assert.match(env.reportMarkdown, /# Dependency Audit Report/);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

// ---- fingerprint determinism (sentinel extraction) ----

test("fingerprintOf is deterministic and line-independent", async () => {
  const src = await fs.readFile(WF_PATH, "utf8");
  const m = src.match(/\/\/ <suite:fingerprintOf>([\s\S]*?)\/\/ <\/suite:fingerprintOf>/);
  assert.ok(m, "fingerprintOf sentinel block not found");
  // Extract the pure function; supply DOMAIN that the function closes over.
  const fingerprintOf = new Function("DOMAIN", `${m[1]}; return fingerprintOf;`)("deps");

  const a = { file: "pkg/manifests/x.json", category: "outdated", description: "Package pinned at   old version", line: 10 };
  // NOTE: fingerprintOf normalizes case + whitespace and excludes `line` from the basis, but
  // does NOT strip path prefixes. Keep b on the SAME path as a so the collision proves
  // line-exclusion + description normalization (the stated intent), not a path-prefix difference.
  const b = { file: "pkg/manifests/x.json", category: "outdated", description: "package pinned at old version", line: 999 };
  assert.equal(fingerprintOf(a), fingerprintOf({ ...a }), "same input must hash identically");
  assert.match(fingerprintOf(a), /^deps-[0-9a-f]+$/);
  // line is excluded from the basis; whitespace/case normalized -> a and b collide by design.
  assert.equal(fingerprintOf(b), fingerprintOf({ file: "pkg/manifests/x.json", category: "outdated", description: "package pinned at old version" }));
});

// ---- bundled discovery / name resolution ----

test("repo-deps is discoverable as a bundled workflow and resolves by name under read-only-review", async () => {
  const { router } = makeDepsRouter();
  const { tools, context, directory } = await makeHarness(router);
  try {
    const listed = JSON.parse(await tools.workflow_list.execute({ format: "json" }, context));
    assert.ok(listed.some((e) => e.scope === "bundled" && e.name === "repo-deps"),
      `repo-deps not listed as bundled: ${JSON.stringify(listed)}`);

    const preview = await tools.workflow_run.execute({ name: "repo-deps", args: { depth: "quick" } }, context);
    assert.match(preview, /Authority profile: read-only-review/);
    assert.match(preview, /approvalHash: [a-f0-9]{64}/);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
