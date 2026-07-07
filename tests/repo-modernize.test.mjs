// repo-modernize bundled workflow regression suite.
//
// Zero-token: every child session.prompt is routed to a canned payload by the
// shared test harness (tests/helpers/repo-review-leaf-harness.mjs); no real
// model is ever called.
//
// Covers (per bead opencode-workflows-rrev.8 acceptance):
//   - migrationPlan presence (ok AND empty envelopes)
//   - optional-vs-defect wording in the migration plan
//   - verification/refutation (HIGH_RISK refuted -> dropped from findings + plan)
//   - severity normalization (critical tier never populated for non-security)
//   - empty result (no findings; and all-refuted -> empty)
//   - shared envelope compliance (assertLeafEnvelope/Counts/Findings)
//   - structured-text fallback (native structured output UNAVAILABLE)
//   - fingerprint determinism (sentinel extraction)
//   - depth profiles (quick skips verify; thorough verifies ALL incl. optional)
//   - bundled name-resolution / discovery

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  makeHarness, DEFAULT_CAPABILITIES,
  runApprovedRequest, resultOutput, runLeafEnvelope,
  structured, textStructured, makeLeafPromptRouter,
  assertLeafEnvelope, assertLeafCounts, assertLeafFindings,
} from "./helpers/repo-review-leaf-harness.mjs";

const DOMAIN = "modernize";
const HERE = path.dirname(fileURLToPath(import.meta.url));
const WF_PATH = path.join(HERE, "..", "workflows", "repo-modernize.js");

// Modernize-specific action fields (beyond the common required set). The shared
// harness DOMAIN_ACTION_FIELDS map only carries bughunt today, so these are
// asserted directly here per docs/repo-review-leaf-contract.md §3.
const MODERNIZE_ACTION_FIELDS = ["deprecatedSince", "replacement", "targetVersion", "proposedChange", "docImpact"];
const HIGH_RISK_CATEGORIES = new Set(["deprecated-api", "legacy-pattern"]);

// ---- canned finding factory ----
function findingFor(cat, overrides = {}) {
  const repl = `new${cat.replace(/-([a-z])/g, (_, c) => c.toUpperCase())}()`;
  return {
    category: cat,
    file: `src/${cat}.js`,
    line: 10,
    severity: "high",
    description: `${cat} example`,
    deprecatedSince: "v3.0",
    replacement: repl,
    targetVersion: "v5.0",
    proposedChange: "rewrite to the modern API",
    confidence: 80,
    effort: "small",
    docImpact: "",
    ...overrides,
  };
}

// ---- default lane router (drives BOTH native + fallback via `shape`) ----
function defaultLane(text, shape) {
  if (text.includes("Profile this repository")) {
    return shape({ languages: ["javascript"], notes: "test repo" });
  }
  if (text.includes("modernization finder")) {
    const m = text.match(/the "([a-z-]+)" modernization finder/);
    const cat = m ? m[1] : "deprecated-api";
    return shape({ findings: [findingFor(cat)] });
  }
  if (text.includes("You are a skeptic")) {
    // Refute exactly the legacy-pattern item (a HIGH_RISK category) so normal-depth
    // verification demonstrably drops it; keep every other skeptic claim.
    const refuted = text.includes("legacy-pattern");
    return shape({ refuted, reasoning: "test verdict", adjustedConfidence: refuted ? 10 : 75 });
  }
  return { data: { parts: [], info: {} } };
}

// Build a prompt router. `override(text)` may return a canned response to
// customize a specific lane (used in native-structured tests). `fallbackShape`
// selects native (structured) vs structured-text-fallback (textStructured).
function modernizeRouter(override, fallbackShape = structured) {
  return makeLeafPromptRouter(async (text) => {
    if (override) {
      const r = override(text);
      if (r !== undefined) return r;
    }
    return undefined; // fall through to defaultLane (called with fallbackShape by the builder)
  }, { fallbackShape, defaultLane });
}

function assertModernizeActionFields(env) {
  for (const f of env.findings) {
    for (const field of MODERNIZE_ACTION_FIELDS) {
      assert.ok(f[field] !== undefined, `finding missing modernize action field: ${field} (category=${f.category})`);
    }
  }
}

// ---- happy path: find -> verify -> rank -> envelope + migrationPlan ----

test("repo-modernize happy path: verifies HIGH_RISK, sequences migrationPlan, returns envelope", async () => {
  const { tools, context, directory } = await makeHarness(modernizeRouter());
  try {
    const env = await runLeafEnvelope(tools, context, { name: "repo-modernize", args: { depth: "normal" } });

    assert.equal(env.domain, DOMAIN);
    assert.equal(env.schemaVersion, 1);
    assert.equal(env.status, "ok");
    assertLeafEnvelope(env, DOMAIN);
    assertLeafCounts(env.counts, DOMAIN);
    assertLeafFindings(env.findings, DOMAIN, { requireActionFields: false });
    assertModernizeActionFields(env);

    // 5 lenses x 1 finding; legacy-pattern (HIGH_RISK) refuted -> dropped; deprecated-api kept;
    // 3 optional categories pass through unverified. => 4 survive.
    assert.equal(env.counts.total, 4);
    assert.equal(env.counts.critical, 0);
    assert.ok(!env.findings.some((f) => f.category === "legacy-pattern"), "refuted legacy-pattern must be dropped");
    assert.ok(env.findings.some((f) => f.category === "deprecated-api"), "non-refuted HIGH_RISK item must survive");
    assert.ok(env.findings.every((f) => typeof f.fingerprint === "string" && f.fingerprint.startsWith(`${DOMAIN}-`)));
    assert.ok(env.findings.every((f, i) => f.rank === i + 1));

    // migrationPlan: present, non-empty, separates Defect (deprecated-api) from Optional (3 others).
    assert.ok(Array.isArray(env.migrationPlan), "migrationPlan must be an array");
    assert.ok(env.migrationPlan.length > 0, "ok status must carry a non-empty migrationPlan");
    assert.ok(env.migrationPlan.some((s) => /^Defect — /.test(s)), "plan must label defects");
    assert.ok(env.migrationPlan.some((s) => /^Optional modernization — /.test(s)), "plan must label optional items");
    assert.equal(env.migrationPlan.filter((s) => /^Defect — /.test(s)).length, 1, "one defect (deprecated-api) survived");
    assert.equal(env.migrationPlan.filter((s) => /^Optional modernization — /.test(s)).length, 3, "three optional items survived");
    // Refuted defect must NOT appear in the plan.
    assert.ok(!env.migrationPlan.some((s) => s.includes("legacy-pattern")), "refuted item must be absent from the plan");

    assert.match(env.reportMarkdown, /# Modernization Report/);
    assert.match(env.reportMarkdown, /## Migration plan/);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

// ---- depth: quick skips verification entirely ----

test("repo-modernize quick depth skips verification (legacy-pattern passes through)", async () => {
  const { tools, context, directory } = await makeHarness(modernizeRouter());
  try {
    const env = await runLeafEnvelope(tools, context, { name: "repo-modernize", args: { depth: "quick" } });
    // quick verifies nothing -> all 5 lenses survive, including legacy-pattern.
    assert.equal(env.status, "ok");
    assert.equal(env.counts.total, 5);
    assert.ok(env.findings.some((f) => f.category === "legacy-pattern"), "quick must not refute any item");
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

// ---- depth: thorough verifies ALL (incl. optional categories) ----

test("repo-modernize thorough depth verifies optional categories too (outdated-idiom refuted)", async () => {
  // thorough verifies ALL findings with a single skeptic. Refute legacy-pattern AND outdated-idiom;
  // both must be dropped. outdated-idiom is an OPTIONAL category that normal depth never verifies,
  // so its dropping here proves thorough reaches the optional set.
  const override = (text) => {
    if (text.includes("You are a skeptic") && (text.includes("legacy-pattern") || text.includes("outdated-idiom"))) {
      return structured({ refuted: true, reasoning: "not equivalent in target version", adjustedConfidence: 10 });
    }
    return undefined;
  };
  const { tools, context, directory } = await makeHarness(modernizeRouter(override));
  try {
    const env = await runLeafEnvelope(tools, context, { name: "repo-modernize", args: { depth: "thorough" } });
    assert.equal(env.status, "ok");
    // deprecated-api, unneeded-polyfill, config-upgrade survive (3); legacy-pattern + outdated-idiom dropped.
    assert.equal(env.counts.total, 3);
    assert.ok(!env.findings.some((f) => f.category === "legacy-pattern"));
    assert.ok(!env.findings.some((f) => f.category === "outdated-idiom"), "thorough must verify optional categories");
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

// ---- verification / refutation: refuted item leaves both findings and plan ----

test("repo-modernize drops a refuted HIGH_RISK item from findings AND the migration plan", async () => {
  // Refute deprecated-api (HIGH_RISK) in addition to the default legacy-pattern refutation.
  const override = (text) => {
    if (text.includes("You are a skeptic") && text.includes("deprecated-api")) {
      return structured({ refuted: true, reasoning: "replacement not available", adjustedConfidence: 5 });
    }
    return undefined;
  };
  const { tools, context, directory } = await makeHarness(modernizeRouter(override));
  try {
    const env = await runLeafEnvelope(tools, context, { name: "repo-modernize", args: { depth: "normal" } });
    assert.equal(env.status, "ok");
    // Both HIGH_RISK items refuted -> only 3 optional survive. No defect steps remain.
    assert.equal(env.counts.total, 3);
    assert.ok(!env.findings.some((f) => HIGH_RISK_CATEGORIES.has(f.category)));
    assert.equal(env.migrationPlan.filter((s) => /^Defect — /.test(s)).length, 0, "no defect steps when all defects refuted");
    assert.equal(env.migrationPlan.filter((s) => /^Optional modernization — /.test(s)).length, 3);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

// ---- severity normalization: critical tier never populated ----

test("repo-modernize normalizes severity and never emits critical (non-security domain)", async () => {
  // Finder returns mixed severities, including an (invalid) critical that must be downgraded by the
  // enum schema; counts must still sum and critical must stay 0.
  const sev = { "deprecated-api": "high", "outdated-idiom": "medium", "legacy-pattern": "high", "unneeded-polyfill": "low", "config-upgrade": "medium" };
  const override = (text) => {
    if (text.includes("modernization finder")) {
      const m = text.match(/the "([a-z-]+)" modernization finder/);
      const cat = m ? m[1] : "deprecated-api";
      return structured({ findings: [findingFor(cat, { severity: sev[cat] || "medium" })] });
    }
    return undefined;
  };
  const { tools, context, directory } = await makeHarness(modernizeRouter(override));
  try {
    const env = await runLeafEnvelope(tools, context, { name: "repo-modernize", args: { depth: "quick" } });
    assert.equal(env.status, "ok");
    assert.equal(env.counts.critical, 0);
    assert.ok(!env.findings.some((f) => f.severity === "critical"), "no finding may carry critical severity");
    assert.equal(env.counts.total, env.counts.high + env.counts.medium + env.counts.low);
    assert.equal(env.counts.total, 5);
    assert.ok(env.counts.high === 2 && env.counts.medium === 2 && env.counts.low === 1);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

// ---- empty result (no findings) ----

test("repo-modernize returns an empty envelope with an empty migrationPlan when nothing is found", async () => {
  const override = (text) => {
    if (text.includes("modernization finder")) return structured({ findings: [] });
    return undefined;
  };
  const { tools, context, directory } = await makeHarness(modernizeRouter(override));
  try {
    const env = await runLeafEnvelope(tools, context, { name: "repo-modernize", args: { depth: "normal" } });
    assert.equal(env.status, "empty");
    assert.equal(env.counts.total, 0);
    assert.equal(env.findings.length, 0);
    assert.equal(env.reportMarkdown, null);
    assert.ok(Array.isArray(env.migrationPlan) && env.migrationPlan.length === 0, "empty status must carry migrationPlan: []");
    assertLeafEnvelope(env, DOMAIN);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

// ---- empty result via all-refuted (second empty branch) ----

test("repo-modernize returns empty when every verified item is refuted (thorough)", async () => {
  const override = (text) => {
    if (text.includes("You are a skeptic")) return structured({ refuted: true, reasoning: "not available", adjustedConfidence: 5 });
    return undefined;
  };
  const { tools, context, directory } = await makeHarness(modernizeRouter(override));
  try {
    const env = await runLeafEnvelope(tools, context, { name: "repo-modernize", args: { depth: "thorough" } });
    assert.equal(env.status, "empty");
    assert.equal(env.counts.total, 0);
    assert.ok(Array.isArray(env.migrationPlan) && env.migrationPlan.length === 0);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

// ---- structured-text fallback (native structured output UNAVAILABLE) ----
//
// Production reality (docs/repo-review-leaf-contract.md §9): native structured
// output is unavailable under the deny-by-default permission ruleset, so the
// kernel injects a structured-text instruction and parses the model's JSON text
// back (child-agent-runner.js -> parseStructuredTextResult). This forces that
// path and asserts the same ranked envelope + migrationPlan is produced.

test("repo-modernize works under the structured-text fallback when native structured output is unavailable", async () => {
  const { tools, context, directory } = await makeHarness(modernizeRouter(undefined, textStructured), {
    capabilities: { ...DEFAULT_CAPABILITIES, structuredOutput: "unavailable" },
  });
  try {
    const env = await runLeafEnvelope(tools, context, { name: "repo-modernize", args: { depth: "normal" } });

    assert.equal(env.domain, DOMAIN);
    assert.equal(env.status, "ok");
    assertLeafEnvelope(env, DOMAIN);
    // Same outcome as the native happy path: legacy-pattern refuted -> 4 survive.
    assert.equal(env.counts.total, 4);
    assert.equal(env.counts.critical, 0);
    assert.ok(!env.findings.some((f) => f.category === "legacy-pattern"));
    assert.ok(env.findings.every((f) => f.fingerprint.startsWith(`${DOMAIN}-`)));
    assert.ok(env.findings.every((f, i) => f.rank === i + 1));
    assert.ok(env.migrationPlan.some((s) => /^Defect — /.test(s)));
    assert.ok(env.migrationPlan.some((s) => /^Optional modernization — /.test(s)));
    assert.match(env.reportMarkdown, /# Modernization Report/);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

// ---- fingerprint determinism (sentinel extraction) ----

test("fingerprintOf is deterministic, line-independent, and domain-prefixed", async () => {
  const src = await fs.readFile(WF_PATH, "utf8");
  const m = src.match(/\/\/ <suite:fingerprintOf>([\s\S]*?)\/\/ <\/suite:fingerprintOf>/);
  assert.ok(m, "fingerprintOf sentinel block not found in repo-modernize.js");
  const fingerprintOf = new Function("DOMAIN", `${m[1]}; return fingerprintOf;`)(DOMAIN);

  const a = { file: "src/x.js", category: "deprecated-api", description: "Uses oldFoo() which is   deprecated", line: 10 };
  const b = { file: "src/x.js", category: "deprecated-api", description: "uses oldfoo() which is deprecated", line: 999 };
  assert.equal(fingerprintOf(a), fingerprintOf({ ...a }), "same input must hash identically");
  assert.match(fingerprintOf(a), /^modernize-[0-9a-f]+$/, "fingerprint must be domain-prefixed hex");
  // line is excluded from the basis; whitespace/case normalized -> a and b collide by design.
  assert.equal(fingerprintOf(a), fingerprintOf(b), "fingerprint must be line-independent + case/whitespace-normalized");
  // Different file/category/description must NOT collide trivially.
  assert.notEqual(fingerprintOf(a), fingerprintOf({ file: "src/y.js", category: "deprecated-api", description: a.description }));
});

// ---- bundled discovery / name resolution ----

test("repo-modernize is discoverable as a bundled workflow and resolves by name", async () => {
  const { tools, context, directory } = await makeHarness(modernizeRouter());
  try {
    const listed = JSON.parse(await tools.workflow_list.execute({ format: "json" }, context));
    assert.ok(listed.some((e) => e.scope === "bundled" && e.name === "repo-modernize"),
      `repo-modernize not listed as bundled: ${JSON.stringify(listed)}`);

    const preview = await tools.workflow_run.execute({ name: "repo-modernize", args: { depth: "quick" } }, context);
    assert.match(preview, /Authority profile: read-only-review/);
    assert.match(preview, /approvalHash: [a-f0-9]{64}/);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
