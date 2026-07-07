// Acceptance for bead opencode-workflows-iui1.9: documentation cleanup.
//
// Proves the docs match actual source/behavior (the bead's acceptance): the parity matrix's
// per-leaf maxAgents/concurrency matches the shipped leaf source; the meta maxAgents matches;
// no stale test counts remain; the cross-domain behavior is described as ranking/linking (not
// merging); and the command doc's budget wording + new args are correct.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parseWorkflowSource } from "../workflow-kernel/workflow-source.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");
const MATRIX = path.join(ROOT, "docs", "repo-review-parity-matrix.md");
const COMMAND = path.join(ROOT, "commands", "repo-review.md");
const GUIDE = path.join(ROOT, "docs", "repo-review.md");
const CONTRACT = path.join(ROOT, "docs", "repo-review-leaf-contract.md");
const META_SRC = path.join(ROOT, "workflows", "repo-review.js");

const LEAVES = [
  "repo-bughunt", "repo-security-audit", "repo-test-gaps", "repo-cleanup",
  "repo-modernize", "repo-perf", "repo-complexity", "repo-deps",
];

async function leafMeta(name) {
  const src = await fs.readFile(path.join(ROOT, "workflows", `${name}.js`), "utf8");
  return parseWorkflowSource(src).meta;
}

// ===========================================================================
// Parity matrix matches shipped source (no drift)
// ===========================================================================

test("docs: parity matrix per-leaf maxAgents/concurrency matches the shipped leaf source", async () => {
  const matrix = await fs.readFile(MATRIX, "utf8");
  for (const leaf of LEAVES) {
    const meta = await leafMeta(leaf);
    // The matrix row for this leaf must cite its actual maxAgents and concurrency.
    assert.ok(matrix.includes(`workflows/${leaf}.js`), `matrix must have a row for ${leaf}`);
    assert.ok(
      matrix.includes(`${meta.maxAgents} / ${meta.concurrency}`),
      `matrix must cite the actual ${leaf} maxAgents/concurrency = ${meta.maxAgents}/${meta.concurrency}`,
    );
  }
});

test("docs: parity matrix cites the actual meta maxAgents (100000) and no stale leaf budgets", async () => {
  const matrix = await fs.readFile(MATRIX, "utf8");
  const meta = parseWorkflowSource(await fs.readFile(META_SRC, "utf8")).meta;
  assert.equal(meta.maxAgents, 100000, "meta maxAgents is 100000");
  assert.ok(matrix.includes(`maxAgents:${meta.maxAgents}`), `matrix must cite the meta maxAgents (${meta.maxAgents})`);
  // Stale per-leaf budgets from the pre-overhaul matrix must be gone.
  for (const stale of ["maxAgents:160", "maxAgents:128", "maxAgents:64", "128 / 6", "160 / 8", "64 / 6"]) {
    assert.ok(!matrix.includes(stale), `matrix must not contain stale value: ${stale}`);
  }
});

test("docs: no stale test counts remain in the parity matrix", async () => {
  const matrix = await fs.readFile(MATRIX, "utf8");
  // The pre-overhaul count was 319; the current count is much higher. The doc must not cite 319.
  assert.ok(!/319/.test(matrix), "matrix must not cite the stale 319 test count");
  assert.ok(/497|tests 4[0-9][0-9]|tests 5[0-9][0-9]/.test(matrix), "matrix must cite a current (>=400) test count");
});

test("docs: cross-domain behavior is described as ranking/linking, not merging", async () => {
  const matrix = await fs.readFile(MATRIX, "utf8");
  // Cross-domain findings are RANKED + LINKED (relatesTo via a corroboration key); only intra-
  // domain identical fingerprints merge. The matrix must describe this accurately.
  assert.match(matrix, /RANKED/i, "matrix must describe cross-domain findings as ranked");
  assert.match(matrix, /LINKED|relatesTo|corroboration/i, "matrix must describe cross-domain linking");
});

// ===========================================================================
// Command doc: budget wording + new args + artifact handoff
// ===========================================================================

test("docs: command budget wording is correct (each leaf's own declared maxAgents is ignored; parent governs)", async () => {
  const command = await fs.readFile(COMMAND, "utf8");
  // The CORRECT wording: each LEAF's own declared maxAgents is ignored (the meta's is the parent
  // budget that governs). The old wording ("the meta's own declared maxAgents is ignored") was
  // inverted and is gone.
  assert.match(command, /leaf's OWN declared|each leaf's own declared/i, "command must say each LEAF's own declared maxAgents is ignored");
  assert.match(command, /100000/, "command must cite the meta parent maxAgents (100000)");
});

test("docs: command documents the new args (maxDirs, deepMode) and the artifact handoff", async () => {
  const command = await fs.readFile(COMMAND, "utf8");
  assert.match(command, /maxDirs/, "command must document the maxDirs arg");
  assert.match(command, /deepMode/, "command must document the deepMode arg");
  assert.match(command, /audited-shell/, "command must document the audited-shell deep mode");
  // The artifact handoff for materialization (findingsJson / findingsPath).
  assert.match(command, /artifactPaths/, "command must reference the engine artifactPaths");
  assert.match(command, /findingsJson|findings\.full\.json/, "command must name the findingsJson artifact");
  assert.match(command, /findingsPath/, "command must hand the full findings to review-materialize via findingsPath");
});

test("docs: repo-review guide and leaf contract match shipped exhaustive defaults", async () => {
  const guide = await fs.readFile(GUIDE, "utf8");
  const contract = await fs.readFile(CONTRACT, "utf8");
  const meta = parseWorkflowSource(await fs.readFile(META_SRC, "utf8")).meta;

  assert.equal(meta.maxAgents, 100000, "meta maxAgents is 100000");
  for (const [label, doc] of [["guide", guide], ["contract", contract]]) {
    assert.match(doc, /thorough/, `${label} must document thorough depth`);
    assert.match(doc, /1000000/, `${label} must document maxReturnFindings 1000000`);
    assert.doesNotMatch(doc, /vendor","target","\*\.lock"/, `${label} must not document *.lock in default excludes`);
  }
  assert.match(guide, /mode.*exhaustive/is, "guide must document meta exhaustive mode");
  assert.match(guide, /coverage-auditor/i, "guide must document the coverage-auditor lane");
  assert.match(contract, /mode.*exhaustive/is, "contract must document meta exhaustive mode");
  assert.match(contract, /coverage-auditor/i, "contract must document the coverage-auditor lane");
  assert.match(guide, /maxAgents: 100000/, "guide must cite meta maxAgents 100000");
  assert.match(contract, /maxAgents: 100000/, "contract must cite meta maxAgents 100000");
  assert.match(guide, /domainDetails/, "guide must document domainDetails materialization handoff");
  assert.match(contract, /domainDetails/, "contract must document domainDetails preservation");
});
