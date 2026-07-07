// Reproducibility / determinism suite for the repo-review meta merge+rank (bead
// opencode-workflows-rrev.25).
//
// PROVES the meta's normalize -> conservative-merge -> rank -> sort -> counts -> relatesTo
// pipeline is deterministic: identical leaf findings ALWAYS produce a byte-identical unified
// envelope, independent of run instance and independent of the order findings arrive in.
//
// Zero-token: every child session.prompt is routed to a canned payload by the shared harness
// (tests/helpers/repo-review-leaf-harness.mjs -> harness.mjs); no real model is ever called.
// The router drives BOTH the meta's single shared recon prompt AND every nested leaf prompt
// (finders + skeptics + complexity's domain recon) because nested workflow() lanes share the
// parent run and route through the same mock.
//
// Why lane-arrival reorder is not directly driven here: the kernel's parallel() returns
// results in SUBMISSION (thunk-array) order via Promise.all (sandbox-executor.js __parallel),
// and buildUnified() traverses the fixed ALL_DOMAINS array — not object insertion order — so
// lane COMPLETION order is provably canonicalized away before it can reach the merge. The only
// reorderable dimension under the mocked harness is the WITHIN-LEAF finding order, which is
// what this suite permutes to prove the merge/rank is order-independent end to end.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";

import {
  makeHarness,
  runApprovedRequest,
  resultOutput,
  makeLeafPromptRouter,
  structured,
} from "./helpers/repo-review-leaf-harness.mjs";

// ---- engineered multi-domain finding set (fully deterministic) ----
//
// Two domains contribute findings (bughunt "concurrency" lens + security "injection" lens);
// the other six leaves return empty via the router fallback, exactly as the smoke suite does.
// The set is shaped to exercise every merge/rank/sort branch:
//   - A & B share fingerprint (same file/category/description, different line): different
//     severity => different weight => the higher-weight lead adopts (existing behavior).
//   - C & D share fingerprint with EQUAL weight but different proposedChange: this is the
//     insertion-order-sensitive branch of the conservative merge. A deterministic tie-break
//     must pick the lexicographically smaller proposedChange regardless of arrival order.
//   - F & G share file+category with lines within ±3 (distinct fingerprints): exercises the
//     relatesTo LINK rule (proximity is a link, never a merge).
//   - severities span critical/high/medium/low and efforts span small/medium/large so the
//     priorityScore sort and its tie-break chain (score -> severity -> sourceDomains ->
//     fingerprint) all fire.
//
// The skeptic lane returns a FIXED adjustedConfidence (80) for every candidate so the
// priorityScores are stable run-to-run; finder-declared confidence is intentionally varied
// only to keep the fixture realistic (it is overwritten by the skeptic verdict in the leaf).

const clone = (f) => JSON.parse(JSON.stringify(f));

const BUGHUNT_BASE = [
  { category: "concurrency", file: "src/a.js", line: 10, severity: "high",
    description: "shared counter race condition", reproSketch: "two callers increment",
    fixSketch: "atomicize", proposedChange: "use atomic increment", confidence: 80,
    effort: "medium", docImpact: "" }, // collides with B (different severity -> different weight)
  { category: "concurrency", file: "src/a.js", line: 14, severity: "medium",
    description: "shared counter race condition", reproSketch: "two callers increment",
    fixSketch: "lock", proposedChange: "wrap in mutex", confidence: 70,
    effort: "medium", docImpact: "" }, // collides with A
  { category: "concurrency", file: "src/b.js", line: 50, severity: "high",
    description: "unhandled promise rejection leak", reproSketch: "await without catch",
    fixSketch: "try/catch", proposedChange: "zzz-tail", confidence: 80,
    effort: "small", docImpact: "" }, // collides with D, EQUAL weight
  { category: "concurrency", file: "src/b.js", line: 52, severity: "high",
    description: "unhandled promise rejection leak", reproSketch: "await without catch",
    fixSketch: "try/catch", proposedChange: "aaa-head", confidence: 80,
    effort: "small", docImpact: "" }, // collides with C, EQUAL weight, lex-smaller proposedChange
  { category: "concurrency", file: "src/d.js", line: 1, severity: "low",
    description: "stale todo marker", reproSketch: "n/a",
    fixSketch: "remove", proposedChange: "delete the comment", confidence: 80,
    effort: "small", docImpact: "" }, // unique; lowest severity
  { category: "concurrency", file: "src/f.js", line: 10, severity: "medium",
    description: "deeply nested callback pyramid", reproSketch: "read the file",
    fixSketch: "flatten", proposedChange: "extract helpers", confidence: 80,
    effort: "large", docImpact: "" }, // relatesTo G (same file/category, lines within ±3)
  { category: "concurrency", file: "src/f.js", line: 12, severity: "medium",
    description: "long parameter list smell", reproSketch: "read the file",
    fixSketch: "group params", proposedChange: "bundle into options object", confidence: 80,
    effort: "large", docImpact: "" }, // relatesTo F (distinct fingerprint)
];

const SECURITY_BASE = [
  { category: "injection", file: "src/c.js", line: 5, severity: "critical",
    description: "sql injection via string concatenation", cwe: "CWE-89",
    attackVector: "user input reaches the query sink", exploitability: "high",
    proposedChange: "parameterize the query", confidence: 80, effort: "large", docImpact: "" },
  { category: "injection", file: "src/e.js", line: 2, severity: "high",
    description: "missing input length validation", cwe: "CWE-20",
    attackVector: "unbounded request body", exploitability: "medium",
    proposedChange: "enforce a size limit", confidence: 80, effort: "medium", docImpact: "" },
];

// A deliberately different within-leaf permutation. It reverses the equal-leaf-score pairs
// (C/D and F/G share leaf scores, so the leaf's stable sort preserves this order on the way
// to the meta) plus scrambles the rest. Same SET of findings, different arrival order.
const BUGHUNT_SHUFFLED = [BUGHUNT_BASE[3], BUGHUNT_BASE[2], BUGHUNT_BASE[1], BUGHUNT_BASE[0],
  BUGHUNT_BASE[6], BUGHUNT_BASE[5], BUGHUNT_BASE[4]];
const SECURITY_SHUFFLED = [SECURITY_BASE[1], SECURITY_BASE[0]];

// ---- router factory: same findings, caller-controlled within-leaf order ----

function determinismRouter({ bughunt = BUGHUNT_BASE, security = SECURITY_BASE } = {}) {
  function route(text, shape) {
    // META shared recon (computed once; every leaf skips self-profiling).
    if (text.includes("comprehensive multi-domain review") || text.includes("Profile this repository once")) {
      return shape({ languages: ["javascript"], notes: "meta shared recon", frameworks: ["node"], packageManagers: ["npm"] });
    }
    // repo-complexity domain-local recon (always computed; shared recon lacks dirs).
    if (text.includes("for a complexity")) {
      return shape({ profile: "test repo", dirs: ["src"], gitAvailable: false });
    }
    // Skeptic verdicts: KEEP every candidate with a FIXED adjusted confidence so the merged
    // priorityScores are identical run-to-run.
    if (text.includes("You are a skeptic")) {
      return shape({ refuted: false, reasoning: "keep", adjustedConfidence: 80 });
    }
    // bughunt finder: emit the engineered set only for the concurrency lens.
    const bm = text.match(/the "([a-z-]+)" bug finder/);
    if (bm) return shape({ findings: bm[1] === "concurrency" ? bughunt.map(clone) : [] });
    // security finder: emit the engineered set only for the injection lens.
    const sm = text.match(/the "([a-z-]+)" security finder/);
    if (sm) return shape({ findings: sm[1] === "injection" ? security.map(clone) : [] });
    // Defensive: a leaf self-recon (must NOT fire; recon is injected by the meta).
    if (text.includes("Profile this repository")) {
      return shape({ languages: ["javascript"], notes: "leaf self recon fallback" });
    }
    // Every other finder/scorer lane: empty.
    return shape({ findings: [] });
  }
  return makeLeafPromptRouter(route, { fallbackShape: structured });
}

// Run the meta once with the given router and return the parsed unified envelope. Uses a fresh
// temp-dir harness per run so dir-independence is exercised alongside determinism.
async function runMetaOnce(router) {
  const { tools, context, directory } = await makeHarness(router);
  try {
    const out = await runApprovedRequest(tools, context, { name: "repo-review", args: { depth: "normal" } });
    const env = await resultOutput(tools, context, out);
    assert.equal(env.status, "ok", `meta should reach ok status; got ${env.status}`);
    return env;
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

// A stable projection of a unified finding: the fields the merge/rank/sort/relatesTo logic can
// ever make order-sensitive. Comparing these (in order) across runs is the determinism proof.
function findingSignature(f) {
  return {
    rank: f.rank,
    fingerprint: f.fingerprint,
    priorityScore: f.priorityScore,
    severity: f.severity,
    sourceDomains: f.sourceDomains,
    domain: f.domain,
    sourceDomain: f.sourceDomain,
    file: f.file,
    line: f.line,
    category: f.category,
    confidence: f.confidence,
    effort: f.effort,
    description: f.description,
    proposedChange: f.proposedChange,
    relatesTo: [...(f.relatesTo || [])].sort((a, b) => a - b),
  };
}

// Strip run-specific fields before byte-identical comparison. artifactPaths encode the runId and
// an absolute temp-dir path (iui1.4 host-owned artifacts live under the run directory), so they
// legitimately differ across runs and are NOT part of merge/rank determinism.
function deterministicEnv(env) {
  const { artifactPaths, ...rest } = env;
  return rest;
}

// The meta's exact sort comparator, re-implemented here only as a total-order REGRESSION PIN
// (see the "total order" test). Source of truth: workflows/repo-review.js buildUnified().
const SEVW = { critical: 4, high: 3, medium: 2, low: 1 };
function metaComparator(a, b) {
  if (b.priorityScore !== a.priorityScore) return b.priorityScore - a.priorityScore;
  if (SEVW[b.severity] !== SEVW[a.severity]) return SEVW[b.severity] - SEVW[a.severity];
  const da = a.sourceDomains.slice().sort().join(",") || a.domain;
  const db = b.sourceDomains.slice().sort().join(",") || b.domain;
  if (da !== db) return da < db ? -1 : 1;
  const fa = a.fingerprint || "";
  const fb = b.fingerprint || "";
  return fa < fb ? -1 : fa > fb ? 1 : 0;
}

// ---------------------------------------------------------------------------
// Sanity: the engineered fixture actually reaches the merge/rank with the expected shape
// (2 intra-domain fingerprint collisions collapse 9 leaf findings -> 7 unified; the security
// critical survives; a relatesTo link forms). This keeps the determinism assertions honest.
// ---------------------------------------------------------------------------

test("fixture sanity: engineered findings reach merge/rank, collide, link, and span tiers", async () => {
  const env = await runMetaOnce(determinismRouter());
  // 7 bughunt + 2 security leaf findings; A+B and C+D merge -> 7 unified.
  assert.equal(env.counts.total, 7, `expected 7 unified findings after 2 merges; got ${env.counts.total}`);
  // critical only from security.
  assert.equal(env.counts.critical, 1);
  assert.equal(env.counts.high, 3);
  assert.equal(env.counts.medium, 2);
  assert.equal(env.counts.low, 1);
  // Fingerprints unique post-merge (the merge collapses the two colliding pairs).
  const fps = env.findings.map((f) => f.fingerprint);
  assert.equal(new Set(fps).size, fps.length, "unified fingerprints must be unique after merge");
  // A relatesTo link exists (F<->G share file/category within ±3 lines).
  assert.ok(env.findings.some((f) => f.relatesTo && f.relatesTo.length > 0), "expected at least one relatesTo link");
});

// ---------------------------------------------------------------------------
// 1. REPRODUCIBILITY: identical inputs -> byte-identical envelopes across repeated runs
// ---------------------------------------------------------------------------

test("reproducibility: identical mocked inputs produce byte-identical unified envelopes across runs", async () => {
  const router = determinismRouter();
  const runs = await Promise.all([runMetaOnce(router), runMetaOnce(router), runMetaOnce(router)]);

  // Structural deep-equality (findings order, ranks, fingerprints, counts, leafOutcomes order,
  // domainExtras, relatesTo, reportMarkdown — everything run-deterministic).
  const d0 = deterministicEnv(runs[0]);
  const d1 = deterministicEnv(runs[1]);
  const d2 = deterministicEnv(runs[2]);
  assert.deepStrictEqual(d0, d1, "run 1 !== run 2");
  assert.deepStrictEqual(d1, d2, "run 2 !== run 3");

  // Byte-identical (catches any key-order / hidden-field drift that deepEqual treats loosely).
  const s0 = JSON.stringify(d0);
  const s1 = JSON.stringify(d1);
  const s2 = JSON.stringify(d2);
  assert.equal(s0, s1, "run 1 JSON !== run 2 JSON");
  assert.equal(s1, s2, "run 2 JSON !== run 3 JSON");

  // leafOutcomes order is the canonical ALL_DOMAINS ledger order, stable across runs.
  const order = runs[0].leafOutcomes.map((o) => o.domain);
  assert.deepEqual(order, ["bughunt", "security", "test-gaps", "cleanup", "modernize", "perf", "complexity", "deps"]);

  // Artifacts ARE persisted on each run (iui1.4), and the envelope carries the pointers — only
  // the runId-bearing absolute path differs across runs.
  for (const env of runs) {
    assert.ok(env.artifactPaths && env.artifactPaths.findingsJson, "each run must persist a findings.full.json artifact (findingsJson)");
    assert.equal(env.artifactsReady, true);
  }
});

// ---------------------------------------------------------------------------
// 2. ORDER-INDEPENDENCE: same findings, different within-leaf arrival order -> identical output
//    (the merge adoption + line + the total-order sort must canonicalize away the permutation)
// ---------------------------------------------------------------------------

test("order-independence: permuted within-leaf arrival yields identical merge/rank output", async () => {
  const base = await runMetaOnce(determinismRouter({ bughunt: BUGHUNT_BASE, security: SECURITY_BASE }));
  const perm = await runMetaOnce(determinismRouter({ bughunt: BUGHUNT_SHUFFLED, security: SECURITY_SHUFFLED }));

  // Counts are a commutative reduction -> identical.
  assert.deepEqual(base.counts, perm.counts, "counts diverged under permutation");

  // The ranked finding sequence (rank, fingerprint, score, severity, lead fields, line,
  // relatesTo) must be identical. This is where an insertion-order-dependent merge adoption
  // or an unstable tie-break would surface (e.g. the equal-weight C/D collision).
  const baseSig = base.findings.map(findingSignature);
  const permSig = perm.findings.map(findingSignature);
  assert.deepEqual(baseSig, permSig, "ranked findings diverged under permutation (merge/rank is order-dependent)");

  // leafOutcomes ledger is lane-order canonicalized -> identical order + content.
  assert.deepEqual(base.leafOutcomes, perm.leafOutcomes, "leafOutcomes diverged under permutation");

  // Full envelopes byte-identical (reportMarkdown, domainExtras, summary, ... everything
  // run-deterministic). artifactPaths are stripped (runId-bearing absolute paths — iui1.4).
  assert.equal(JSON.stringify(deterministicEnv(base)), JSON.stringify(deterministicEnv(perm)), "full envelope JSON diverged under permutation");
});

// ---------------------------------------------------------------------------
// 3. TOTAL ORDER: the sort comparator canonicalizes any permutation and never ties distinct
//    findings (no swaps on already-sorted; unique fingerprints => strict total order on output)
// ---------------------------------------------------------------------------

test("total order: comparator is a strict total order on the ranked output (no swaps, unique keys)", async () => {
  const env = await runMetaOnce(determinismRouter());
  const rows = env.findings;

  // (a) Every finding carries a non-empty, UNIQUE fingerprint. Because the merge collapses
  //     identical fingerprints, this means the comparator's final tie-break fully distinguishes
  //     every distinct unified finding -> it can never return 0 for two different rows.
  for (const f of rows) {
    assert.ok(typeof f.fingerprint === "string" && f.fingerprint.length > 0, "finding must have a non-empty fingerprint");
  }
  const fpSet = new Set(rows.map((f) => f.fingerprint));
  assert.equal(fpSet.size, rows.length, "output fingerprints must be unique (comparator never ties distinct rows)");

  // (b) Ranks are contiguous 1..N (the comparator produces a single canonical sequence).
  const ranks = rows.map((f) => f.rank).sort((a, b) => a - b);
  ranks.forEach((r, i) => assert.equal(r, i + 1, `ranks must be contiguous 1..N (break at index ${i})`));

  // (c) No adjacent pair is out of order: the meta's own output is already canonical.
  for (let i = 0; i < rows.length - 1; i++) {
    assert.ok(metaComparator(rows[i], rows[i + 1]) <= 0,
      `adjacent pair out of order at index ${i}: rank ${rows[i].rank} should precede rank ${rows[i + 1].rank}`);
  }

  // (d) Canonicalization: sorting a REVERSED copy of the output with the comparator must
  //     reproduce the exact same sequence (total order => one canonical permutation).
  const reversed = [...rows].reverse();
  const resorted = reversed.slice().sort(metaComparator);
  assert.deepEqual(resorted.map((f) => f.fingerprint), rows.map((f) => f.fingerprint),
    "sorting a reversed copy must reproduce the canonical order");

  // (e) Antisymmetry sanity on the fixture set: cmp(a,b) === -cmp(b,a) for all pairs.
  for (let i = 0; i < rows.length; i++) {
    for (let j = i + 1; j < rows.length; j++) {
      const fwd = metaComparator(rows[i], rows[j]);
      const rev = metaComparator(rows[j], rows[i]);
      assert.equal(fwd, -rev, `comparator not antisymmetric for ranks ${rows[i].rank}/${rows[j].rank}`);
    }
  }
});
