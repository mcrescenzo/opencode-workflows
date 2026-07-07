// Acceptance for bead opencode-workflows-iui1.7: optional shell/network deep modes.
//
// Proves the five acceptance criteria (all testable without verified gates or real shell — the
// policy is pure, and the engine stays static in-guest):
//  (1) static mode never requests shell or network
//  (2) shell mode fails closed if gates are unverified
//  (3) the command allowlist rejects installs and mutation commands
//  (4) network mode cannot run by accident (requires explicit opt-in)
//  (5) shellCoverage reflects partial or full when shell mode runs (verified gates)
//
// The audited-shell policy lives in workflow-kernel/audited-shell-policy.js (pure, importable).
// The repo-review meta itself stays read-only-review and surfaces a `deepMode` observability field;
// it never enables shell/network in the QuickJS guest.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  validateAuditedCommand,
  resolveDeepMode,
  resolveShellCoverage,
  AUDITED_SHELL_ALLOWLIST,
  SHELL_PERMISSION_DENY_PATTERNS,
} from "../workflow-kernel/audited-shell-policy.js";
import { makeHarness, runApprovedRequest, resultOutput, makeLeafPromptRouter, structured } from "./helpers/repo-review-leaf-harness.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const META_SRC = path.join(HERE, "..", "workflows", "repo-review.js");

// ===========================================================================
// (1) Static mode never requests shell or network
// ===========================================================================

test("static mode: the meta never requests shell or network (read-only-review, no shell/network lanes)", async () => {
  const src = await fs.readFile(META_SRC, "utf8");
  // The meta ships under read-only-review.
  assert.match(src, /profile: "read-only-review"/, "repo-review meta must keep the read-only-review profile");
  // No lane ever opts into shell/network. (agent lanes declare schema/tier/onFailure/label only.)
  assert.doesNotMatch(src, /shell:\s*true|network:\s*true|allowShell|allowNetwork/, "the meta must never request shell or network authority");
  // The deep-mode field is observability only — the guest stays static.
  assert.match(src, /active: "static"/, "the guest deepMode is always static");
  // A clean run surfaces the static deep-mode descriptor.
  function router() {
    return makeLeafPromptRouter((text, shape) => {
      if (text.includes("for a complexity")) return shape({ profile: "t", dirs: ["src"], gitAvailable: false });
      if (text.includes("comprehensive multi-domain review") || text.includes("Profile this repository")) return shape({ languages: ["javascript"], notes: "recon" });
      if (text.includes("coverage auditor")) return shape({ coverageAssessment: "complete", confidence: "high", gaps: [], missedAreas: [] });
      if (text.includes("You are a skeptic")) return shape({ refuted: false, reasoning: "keep", adjustedConfidence: 80 });
      return shape({ findings: [] });
    }, { fallbackShape: structured });
  }
  const { tools, context, directory } = await makeHarness(router());
  try {
    const out = await runApprovedRequest(tools, context, { name: "repo-review", args: { mode: "bounded", depth: "normal" } });
    const env = await resultOutput(tools, context, out);
    assert.ok(env.deepMode, "envelope must carry deepMode");
    assert.equal(env.deepMode.requested, "static", "default run requests static mode");
    assert.equal(env.deepMode.active, "static", "default run is static");
    assert.equal(env.deepMode.shellCoverage, "none", "static run has no shell coverage");
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

// ===========================================================================
// (3) The command allowlist rejects installs and mutation commands; allows the read-only allowlist
// ===========================================================================

test("audited-shell allowlist: allows read-only commands, rejects installs/mutations/network", () => {
  // Allowlisted read-only commands.
  for (const ok of ["git ls-files", "git log --numstat", "git log --numstat -n 100", "npm ls --depth=0", "cargo tree", "pip list", "go list"]) {
    const r = validateAuditedCommand(ok);
    assert.equal(r.allowed, true, `expected allowlisted command to be allowed: ${ok} (reason: ${r.reason})`);
  }
  for (const ok of ["git ls-files i.txt", "git ls-files src/i.js", "git log --numstat -- src/install.js", "npm ls --depth=0 --workspace=install-tools"]) {
    const r = validateAuditedCommand(ok);
    assert.equal(r.allowed, true, `expected safe allowlisted command with install-like path text to be allowed: ${ok} (reason: ${r.reason})`);
  }
  // Installs / mutations / network are REJECTED.
  const denied = [
    "npm install", "npm i lodash", "yarn add react", "npm install --save pkg",
    "pip install requests", "go get example.com/pkg", "go install example.com/tool", "cargo add serde", "cargo install ripgrep",
    "npm audit", "pip-audit",
    "git commit -am x", "git push", "git reset --hard", "git checkout main",
    "npm publish", "rm -rf node_modules", "mv a b", "touch x", "echo x > file",
    "curl https://evil.example", "wget https://x", "npm ls --depth=0 && rm x",
    "git ls-files | cat secrets.env", "git ls-files $(cat secrets.env)",
    "git ls-files `cat secrets.env`", "git ls-files <(cat secrets.env)",
  ];
  for (const bad of denied) {
    const r = validateAuditedCommand(bad);
    assert.equal(r.allowed, false, `expected command to be DENIED: ${bad}`);
  }
  assert.ok(SHELL_PERMISSION_DENY_PATTERNS.includes("*|*"), "runtime deny patterns reject bare pipes");
  assert.ok(SHELL_PERMISSION_DENY_PATTERNS.includes("*$(*"), "runtime deny patterns reject command substitution");
  assert.ok(SHELL_PERMISSION_DENY_PATTERNS.includes("*`*"), "runtime deny patterns reject backtick command substitution");
  assert.ok(SHELL_PERMISSION_DENY_PATTERNS.includes("*<*"), "runtime deny patterns reject process substitution/input redirection");
  assert.equal(SHELL_PERMISSION_DENY_PATTERNS.includes("*install*"), false, "runtime deny patterns do not over-deny install-like path text");
  // A non-allowlisted read-ish command is still denied (allowlist, not denylist-only).
  assert.equal(validateAuditedCommand("cat secrets.env").allowed, false, "non-allowlisted command denied even if read-only");
  // The allowlist is exactly the documented read-only set.
  assert.deepEqual(AUDITED_SHELL_ALLOWLIST.map((a) => a.id), ["git-ls-files", "git-log-numstat", "npm-ls", "cargo-tree", "pip-list", "go-list"]);
});

// ===========================================================================
// (2) Shell mode fails closed if gates are unverified
// ===========================================================================

test("audited-shell mode fails closed when required gates are unverified", () => {
  const unverified = resolveDeepMode({ deepMode: "audited-shell", gatesVerified: false });
  assert.equal(unverified.failClosed, true, "unverified gates must fail closed");
  assert.equal(unverified.shellMode, false, "shell must NOT be enabled when gates are unverified");
  assert.equal(unverified.mode, "static", "unverified shell mode degrades to static");
  assert.equal(unverified.shellCoverage, "none", "no shell coverage when failed closed");
  assert.ok(unverified.requiredGates.includes("permissionEnforcement") && unverified.requiredGates.includes("commandScopedBash"), "shell mode requires permissionEnforcement + commandScopedBash gates");
  assert.match(unverified.coverageLimitations, /unverified/i, "the limitation must disclose the unverified gates");
});

// ===========================================================================
// (4) Network mode cannot run by accident (explicit opt-in only)
// ===========================================================================

test("network mode requires explicit opt-in (never runs by accident)", () => {
  // Default / unrecognized → static, no network.
  assert.equal(resolveDeepMode({}).networkMode, false, "default is not network");
  assert.equal(resolveDeepMode({ deepMode: "static" }).networkMode, false, "explicit static is not network");
  assert.equal(resolveDeepMode({ deepMode: "exhaustive" }).networkMode, false, "unrecognized mode is not network");
  // Network-advisory opt-in (still fails closed without verified gates).
  const unverified = resolveDeepMode({ deepMode: "network-advisory", gatesVerified: false });
  assert.equal(unverified.failClosed, true, "network mode without verified gates fails closed");
  assert.equal(unverified.networkMode, false, "network NOT enabled without verified gates");
  const verified = resolveDeepMode({ deepMode: "network-advisory", gatesVerified: true });
  assert.equal(verified.networkMode, true, "network mode is enabled only with explicit opt-in AND verified gates");
  assert.equal(verified.mode, "network-advisory");
});

// ===========================================================================
// (5) shellCoverage reflects partial/full when shell mode runs (verified gates)
// ===========================================================================

test("shellCoverage reflects partial/full when audited-shell runs with verified gates", () => {
  const verified = resolveDeepMode({ deepMode: "audited-shell", gatesVerified: true });
  assert.equal(verified.shellMode, true, "shell mode active with verified gates");
  assert.equal(verified.mode, "audited-shell");
  assert.equal(verified.shellCoverage, "partial", "an active shell lens reports partial coverage");
  assert.equal(verified.coverageLimitations, null, "no limitation when the shell lens is fully enabled");
  // resolveShellCoverage maps the lens-completion to none/partial/full.
  assert.equal(resolveShellCoverage({ shellMode: false, gatesVerified: true }), "none", "no shell mode -> none");
  assert.equal(resolveShellCoverage({ shellMode: true, gatesVerified: false }), "none", "unverified gates -> none (fail closed)");
  assert.equal(resolveShellCoverage({ shellMode: true, gatesVerified: true, measured: 3, expected: 5 }), "partial", "partial measurement -> partial");
  assert.equal(resolveShellCoverage({ shellMode: true, gatesVerified: true, measured: 5, expected: 5 }), "full", "complete measurement -> full");
});
