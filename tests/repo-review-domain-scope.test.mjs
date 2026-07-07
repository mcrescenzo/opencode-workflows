// Acceptance for bead opencode-workflows-iui1.3: domain-specific scope rules.
//
// Proves the four acceptance criteria:
//  (1) repo-deps sees lockfiles (yarn.lock, package-lock.json, pnpm-lock.yaml) by default
//  (2) repo-security-audit sees CI/config/Docker files by default
//  (3) *.lock is NOT in the default exclude for deps or security (nor the shared meta exclude)
//  (4) user-supplied excludes still win
//
// Combines prompt-capture behavioral proofs (what the agent is actually told is in scope) with
// source-grep wiring proofs (the default exclude lists). Zero-token: canned prompt routing.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  makeHarness,
  runLeafEnvelope,
  makeLeafPromptRouter,
  structured,
} from "./helpers/repo-review-leaf-harness.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORKFLOWS_DIR = path.join(HERE, "..", "workflows");

// A router that returns a valid recon + EMPTY findings for every lens so the leaf reaches a
// contract-valid empty envelope quickly, while still emitting every finder/recon prompt whose
// scope text we capture. `shape` is the structured-output shaper.
function emptyFindingsRoute(text, shape) {
  if (text.includes("Profile this repository")) {
    return shape({ languages: ["javascript"], notes: "scope-probe recon" });
  }
  if (text.includes("for a complexity")) {
    return shape({ profile: "test repo", dirs: ["src"], gitAvailable: false });
  }
  if (text.includes("You are a skeptic")) {
    return shape({ refuted: false, reasoning: "keep", adjustedConfidence: 80 });
  }
  return shape({ findings: [] });
}
function scopeProbeRouter() {
  return makeLeafPromptRouter(emptyFindingsRoute, { fallbackShape: structured });
}

async function runLeafAndCapture(name, args) {
  const { tools, context, directory, calls } = await makeHarness(scopeProbeRouter());
  try {
    await runLeafEnvelope(tools, context, { name, args });
    return calls.prompt.map((p) => String(p?.body?.parts?.[0]?.text ?? ""));
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

// Extract the "Scope: ... Exclude: ..." line from a prompt.
function scopeLine(prompts) {
  const line = prompts.find((t) => t.includes("Scope: paths ="));
  assert.ok(line, "expected at least one prompt to carry the scope line");
  return line;
}

// ===========================================================================
// (3) *.lock is NOT in the default exclude for deps, security, or the meta
// ===========================================================================

test("default exclude no longer drops *.lock anywhere (deps, security, meta, all leaves)", async () => {
  const leaves = [
    "repo-deps", "repo-security-audit", "repo-bughunt", "repo-test-gaps",
    "repo-cleanup", "repo-modernize", "repo-perf", "repo-complexity",
  ];
  for (const leaf of leaves) {
    const src = await fs.readFile(path.join(WORKFLOWS_DIR, `${leaf}.js`), "utf8");
    assert.ok(
      !/:\s*\["node_modules",\s*"dist",\s*"build",\s*"\.git",\s*"vendor",\s*"target",\s*"\*\.lock"/.test(src),
      `${leaf} default exclude must NOT contain *.lock`,
    );
  }
  const meta = await fs.readFile(path.join(WORKFLOWS_DIR, "repo-review.js"), "utf8");
  assert.ok(!/\*\.lock/.test(meta), "repo-review meta must not reference *.lock in its default exclude");
});

// ===========================================================================
// (1) repo-deps sees lockfiles by default
// ===========================================================================

test("repo-deps sees manifests AND lockfiles by default (scope discloses them, *.lock not excluded)", async () => {
  const prompts = await runLeafAndCapture("repo-deps", { depth: "normal" });
  const scope = scopeLine(prompts);

  // *.lock is not in the exclude portion of the deps scope.
  assert.ok(!/Exclude[^.]*\*\.lock/.test(scope), "deps scope must not list *.lock as excluded");

  // Lockfiles are explicitly disclosed as in-scope read targets.
  for (const lock of ["yarn.lock", "package-lock.json", "pnpm-lock.yaml"]) {
    assert.ok(scope.includes(lock), `deps scope must disclose ${lock} as in scope`);
  }
});

// ===========================================================================
// (2) repo-security-audit sees CI/config/Docker files by default
// ===========================================================================

test("repo-security-audit sees CI/config/Docker/deploy files by default", async () => {
  const prompts = await runLeafAndCapture("repo-security-audit", { depth: "normal" });
  const scope = scopeLine(prompts);

  assert.ok(!/Exclude[^.]*\*\.lock/.test(scope), "security scope must not list *.lock as excluded");
  // High-signal config/CI/infra surface is explicitly disclosed as in scope.
  for (const token of ["CI", "Docker", "config", "auth"]) {
    assert.ok(scope.includes(token), `security scope must disclose ${token} surface as in scope`);
  }
});

// ===========================================================================
// (4) user-supplied excludes still win
// ===========================================================================

test("user-supplied exclude wins over the domain default (deps still honors an explicit lockfile exclude)", async () => {
  const prompts = await runLeafAndCapture("repo-deps", { depth: "normal", exclude: ["yarn.lock", "secret-stuff"] });
  const scope = scopeLine(prompts);
  // The user's exclude reaches the agent verbatim and takes precedence.
  assert.ok(scope.includes("yarn.lock"), "user-supplied exclude entry must reach the scope");
  assert.ok(/Exclude[^.]*yarn\.lock/.test(scope), "yarn.lock must appear in the Exclude portion when the user supplies it");
  assert.ok(scope.includes("secret-stuff"), "the full user exclude list must be honored");
});
