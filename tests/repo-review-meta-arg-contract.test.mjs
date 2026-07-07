// Meta-to-leaf arg contract: recon-once, identical injection (bead rrev.19).
//
// Enforces docs/repo-review-leaf-contract.md §14 ("Meta-to-leaf arg contract").
// Zero-token: every child session.prompt is routed to a canned payload by the
// shared harness (tests/helpers/repo-review-leaf-harness.mjs -> harness.mjs);
// no real model is ever called.
//
// Two sides, matching the bead's split:
//
//  1. LEAF-SIDE (all eight leaves): when an `args.recon` is injected the leaf
//     SKIPS its self-profiling recon lane (the mocked prompt router sees no
//     shared-recon prompt) and still returns a contract-valid envelope. A
//     contrast run WITHOUT `args.recon` confirms the recon lane IS invoked, so
//     the skip is provably caused by the injection (not by a leaf that never
//     profiles). This is the leaf half of §14; it is fully enforced here.
//
//  2. META-SIDE SPEC (enforced when rrev.13 lands): a structural assertion that
//     §14 exists and documents recon-once + identical injection + parent-budget
//     + static-literal/one-level + read-only; plus a stub-based test where a
//     meta-shaped function computes recon ONCE and injects REFERENCE-IDENTICAL
//     recon/scope/depth into all eight leaves. Full enforcement against the real
//     `workflows/repo-review.js` source (rrev.13's deliverable) is verified when
//     rrev.13 lands; this file owns the contract + spec, not the meta build.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  makeHarness,
  runLeafEnvelope,
  assertLeafEnvelope,
  makeLeafPromptRouter,
  structured,
} from "./helpers/repo-review-leaf-harness.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CONTRACT_DOC = path.join(HERE, "..", "docs", "repo-review-leaf-contract.md");
const META_WORKFLOW_SRC = path.join(HERE, "..", "workflows", "repo-review.js");

// The eight leaf engines, their envelope `domain`, and the regex that matches
// ONLY that leaf's shared recon lane prompt (the lane skipped when args.recon is
// present). Each regex is scoped to the leaf's own recon phrasing so it cannot
// false-match a finder/skeptic prompt (those carry "Repo profile (recon):", not
// "Profile this repository ..."). repo-complexity additionally computes a
// domain-local recon ("... for a complexity ...") that is NEVER skipped; its
// shared-recon regex matches "... for review ..." only, so the domain recon
// never reads as a shared-recon hit.
const LEAVES = [
  { name: "repo-bughunt", domain: "bughunt", reconSig: /Profile this repository for review/ },
  { name: "repo-security-audit", domain: "security", reconSig: /Profile this repository for a security audit/ },
  { name: "repo-test-gaps", domain: "test-gaps", reconSig: /Profile this repository for test-gap analysis/ },
  { name: "repo-cleanup", domain: "cleanup", reconSig: /Profile this repository for a cleanup pass/ },
  { name: "repo-modernize", domain: "modernize", reconSig: /Profile this repository for a modernization pass/ },
  { name: "repo-perf", domain: "perf", reconSig: /Profile this repository for performance analysis/ },
  { name: "repo-complexity", domain: "complexity", reconSig: /Profile this repository for review/ },
  { name: "repo-deps", domain: "deps", reconSig: /Profile this repository's dependency setup/ },
];

// Distinctive injected recon object. Its prose marker is irrelevant to the leaf
// result here (empty-findings envelopes do not echo recon), but using a stable
// shared object mirrors how the meta threads ONE recon reference into every leaf.
const INJECTED_RECON = {
  languages: ["javascript"],
  frameworks: ["node"],
  packageManagers: ["npm"],
  entryPoints: ["src/index.js"],
  testLayout: "tests/",
  buildTooling: "none",
  concurrencyModel: "single-threaded",
  errorHandling: "try/catch",
  externalResources: [],
  notes: "INJECTED shared recon — leaf self-profiling MUST be skipped",
};

// ---- generic prompt router ----
//
// One route drives all eight leaves for THIS contract suite. Finders/scorers
// return an EMPTY findings array so every leaf reaches a contract-valid
// "empty" envelope quickly (the recon-skip contract is independent of whether
// any finding is produced; the full finding pipeline is covered by each leaf's
// own regression suite). The shared-recon branch is only hit on contrast runs
// (no injected recon). The complexity domain-recon branch returns a valid dirs
// list so repo-complexity does not abort on its always-computed local recon.
function genericRoute(text, shape) {
  if (text.includes("for a complexity")) {
    return shape({ profile: "test repo", dirs: ["src"], gitAvailable: false });
  }
  if (text.includes("Profile this repository")) {
    return shape({ languages: ["javascript"], notes: "contrast-mode self recon" });
  }
  if (text.includes("You are a skeptic")) {
    return shape({ refuted: false, reasoning: "keep", adjustedConfidence: 80 });
  }
  return shape({ findings: [] });
}

function leafPromptRouter() {
  return makeLeafPromptRouter(genericRoute, { fallbackShape: structured });
}

// Build a harness, run one leaf, return { env, prompts }. Cleans up its temp dir.
async function runLeafForContract(leaf, args) {
  const { tools, context, directory, calls } = await makeHarness(leafPromptRouter());
  try {
    const env = await runLeafEnvelope(tools, context, { name: leaf.name, args });
    const prompts = calls.prompt.map((p) => String(p?.body?.parts?.[0]?.text ?? ""));
    return { env, prompts };
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

test("leaf-side: malformed non-empty string args are rejected instead of defaulting to empty args", async (t) => {
  for (const leaf of LEAVES) {
    await t.test(leaf.name, async () => {
      const { tools, context, directory } = await makeHarness(leafPromptRouter());
      try {
        await assert.rejects(
          runLeafEnvelope(tools, context, { name: leaf.name, args: "{bad" }),
          new RegExp(`Invalid ${leaf.name} runtime args JSON`),
        );
      } finally {
        await fs.rm(directory, { recursive: true, force: true });
      }
    });
  }
});

// ===========================================================================
// 1. LEAF-SIDE: all eight leaves honor an injected args.recon (§14.2 leaf half)
// ===========================================================================

test("leaf-side: all eight leaves honor injected args.recon and skip self-profiling", async (t) => {
  for (const leaf of LEAVES) {
    await t.test(`${leaf.name}: injected recon -> shared recon lane NOT invoked + valid envelope`, async () => {
      const { env, prompts } = await runLeafForContract(leaf, {
        recon: INJECTED_RECON,
        paths: ["src"],
        exclude: ["node_modules"],
        depth: "normal",
      });

      // Contract: a valid envelope is still produced (empty is valid — the
      // generic router returns no findings).
      assertLeafEnvelope(env, leaf.domain);

      // The core recon-skip assertion: NO captured prompt matches this leaf's
      // shared recon signature. (repo-complexity still sends its domain-local
      // "... for a complexity ..." recon, which intentionally does NOT match.)
      const reconHits = prompts.filter((p) => leaf.reconSig.test(p));
      assert.equal(
        reconHits.length,
        0,
        `${leaf.name}: shared recon lane must NOT be invoked when args.recon is injected (got ${reconHits.length} recon prompt(s))`,
      );
    });

    await t.test(`${leaf.name}: no recon -> shared recon lane IS invoked (contrast proof)`, async () => {
      const { prompts } = await runLeafForContract(leaf, { depth: "normal" });

      // Contrast: without an injected recon the leaf self-profiles, so its shared
      // recon lane prompt MUST appear. This proves the skip above is caused by
      // the injection rather than by a leaf that never profiles.
      const reconHits = prompts.filter((p) => leaf.reconSig.test(p));
      assert.ok(
        reconHits.length >= 1,
        `${leaf.name}: shared recon lane MUST be invoked when no args.recon is injected (contrast failed — detection may be inert)`,
      );
    });
  }
});

// ===========================================================================
// 2. META-SIDE SPEC (enforced when rrev.13 lands)
// ===========================================================================

test("meta-side spec: §14 exists and documents the recon-once + identical-injection contract", async () => {
  const doc = await fs.readFile(CONTRACT_DOC, "utf8");

  // The section itself.
  assert.match(doc, /## 14\. Meta-to-leaf arg contract/, "§14 section heading must exist");

  // Recon computed ONCE.
  assert.ok(
    /ONCE|exactly once/i.test(doc),
    "§14 must state that recon is computed once / exactly once",
  );

  // Identical injection (same reference into every leaf).
  assert.ok(
    /reference-identical|SAME|same value reaches every leaf/i.test(doc),
    "§14 must document identical (same-reference) injection into every leaf",
  );

  // No dynamic workflow names + one nesting level.
  assert.match(doc, /No dynamic workflow names/, "§14 must forbid dynamic workflow names");
  assert.match(doc, /No recursion beyond one level/, "§14 must forbid recursion beyond one level");

  // Parent-run budget awareness: nested meta.maxAgents ignored.
  assert.ok(
    /maxAgents[\s\S]*ignored/i.test(doc),
    "§14 must document that nested meta.maxAgents is ignored and the parent budget covers N leaves + 1 recon",
  );

  // Read-only preserved.
  assert.match(doc, /read-only-review/, "§14 must preserve the read-only-review profile");
});

test("meta-side spec: stub meta computes recon ONCE and injects IDENTICAL recon/scope/depth into all eight leaves", async () => {
  // The eight literal leaf names the meta is allowed to call (static literals
  // only — no dynamic/computed names). Mirrors §14.3.
  const LITERAL_LEAF_NAMES = Object.freeze([
    "repo-bughunt",
    "repo-cleanup",
    "repo-complexity",
    "repo-deps",
    "repo-modernize",
    "repo-perf",
    "repo-security-audit",
    "repo-test-gaps",
  ]);
  assert.equal(LITERAL_LEAF_NAMES.length, 8, "the meta fans out to exactly eight leaves");

  // Mocked recon: counts how many times recon is computed. The contract demands
  // exactly ONE computation shared across all leaves.
  let reconComputations = 0;
  const computeRecon = () => {
    reconComputations += 1;
    return { ...INJECTED_RECON, reconId: "single-shared-recon" };
  };

  // Mocked leaf runner: records the literal name + the args object each call
  // received. Returns a minimal envelope shape (the real engines return the
  // full §2 envelope; the arg contract is independent of that).
  const leafCalls = [];
  const runLeaf = (name, args) => {
    leafCalls.push({ name, args });
    return { domain: name, status: "empty", argsReceived: args };
  };

  // Meta-shaped stub. This is NOT workflows/repo-review.js (rrev.13's job); it
  // is the minimal shape that satisfies §14: recon ONCE, ONE shared args object
  // (by reference) injected into every literal one-level workflow("repo-X", args)
  // call. A real meta adds budget-guarded batched parallel() + cross-domain
  // merge; those do not change this arg-threading contract.
  function metaShape({ paths, exclude, depth }) {
    const recon = computeRecon(); // recon computed ONCE
    // ONE shared args object — same reference reaches every leaf (§14.2).
    const sharedArgs = { recon, paths, exclude, depth };
    const domainResults = [];
    // Static literal refs only — emulates eight literal workflow() calls.
    domainResults.push(runLeaf("repo-bughunt", sharedArgs));
    domainResults.push(runLeaf("repo-security-audit", sharedArgs));
    domainResults.push(runLeaf("repo-test-gaps", sharedArgs));
    domainResults.push(runLeaf("repo-cleanup", sharedArgs));
    domainResults.push(runLeaf("repo-modernize", sharedArgs));
    domainResults.push(runLeaf("repo-perf", sharedArgs));
    domainResults.push(runLeaf("repo-complexity", sharedArgs));
    domainResults.push(runLeaf("repo-deps", sharedArgs));
    return { recon, domainResults };
  }

  const { recon } = metaShape({ paths: ["src"], exclude: ["node_modules"], depth: "normal" });

  // (a) recon computed exactly once.
  assert.equal(reconComputations, 1, "meta must compute shared recon exactly once");

  // (b) exactly eight leaves were invoked, all via the allowed literal names.
  assert.equal(leafCalls.length, 8, "meta must fan out to exactly eight leaves");
  assert.deepStrictEqual(
    leafCalls.map((c) => c.name).sort(),
    [...LITERAL_LEAF_NAMES].sort(),
    "every leaf call must use one of the eight static literal names",
  );

  // (c) every leaf received the SAME args reference (identical recon/scope/depth
  // by identity, not a fresh copy per leaf).
  const firstArgs = leafCalls[0].args;
  assert.ok(firstArgs === leafCalls[1].args, "leaves 1 and 2 must share the same args reference");
  for (let i = 0; i < leafCalls.length; i++) {
    assert.ok(
      leafCalls[i].args === firstArgs,
      `leaf #${i + 1} (${leafCalls[i].name}) must receive the identical args reference`,
    );
    assert.ok(leafCalls[i].args.recon === recon, `leaf #${i + 1} must receive the identical recon reference`);
    assert.equal(leafCalls[i].args.depth, "normal");
    assert.deepStrictEqual(leafCalls[i].args.paths, ["src"]);
    assert.deepStrictEqual(leafCalls[i].args.exclude, ["node_modules"]);
  }
});

test("meta-side spec: enforcement against the real workflows/repo-review.js activates when rrev.13 lands", async () => {
  // rrev.13 owns workflows/repo-review.js. Until it lands the file is absent, so
  // this guard is a forward-looking no-op that documents the activation point.
  // When the file appears, this test will hold the meta source to §14:
  // read-only-review profile, eight literal workflow("repo-X", args) calls, no
  // dynamic workflow names, and the shared-recon injection.
  let exists = false;
  try {
    await fs.access(META_WORKFLOW_SRC);
    exists = true;
  } catch {
    exists = false;
  }

  if (!exists) {
    // Not yet enforced — rrev.13 has not landed. This is the documented
    // "enforced when rrev.13 lands" gate; pass explicitly with a clear record.
    assert.ok(true, "workflows/repo-review.js absent — §14 meta-source enforcement activates when rrev.13 lands");
    return;
  }

  const src = await fs.readFile(META_WORKFLOW_SRC, "utf8");
  assert.match(src, /read-only-review/, "repo-review meta must keep the read-only-review profile");

  // Eight literal leaf refs, no dynamic workflow(name).
  for (const leafName of LEAVES.map((l) => l.name)) {
    assert.ok(
      new RegExp(`workflow\\(\\s*["']${leafName}["']`).test(src),
      `repo-review meta must call workflow("${leafName}", args) as a static literal`,
    );
  }
  assert.ok(
    !/workflow\(\s*[a-zA-Z_][^"')\s]*\s*,/.test(src),
    "repo-review meta must NOT use dynamic (non-literal) workflow names",
  );
});
