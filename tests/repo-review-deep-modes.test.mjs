// Acceptance for bead opencode-workflows-iui1.7: the audited-shell command policy tables.
//
// Design C (2026-07-07) deleted the live-gate-probe subsystem, including resolveDeepMode/
// resolveShellCoverage/validateAuditedCommand and the gate-verified deep-mode plumbing they
// backed (repo-review's optional shell/network deep modes were never shipped past that policy
// layer). What survives — and what this file now covers — is the pure command-policy data that
// authority-policy.js's inspect-with-shell profile turns into the runtime permission ruleset:
// AUDITED_SHELL_ALLOWLIST, AUDITED_SHELL_DENY, SHELL_PERMISSION_DENY_PATTERNS, and
// auditedShellPermissionPatterns().

import test from "node:test";
import assert from "node:assert/strict";

import {
  AUDITED_SHELL_ALLOWLIST,
  AUDITED_SHELL_DENY,
  SHELL_PERMISSION_DENY_PATTERNS,
  auditedShellPermissionPatterns,
} from "../workflow-kernel/audited-shell-policy.js";

test("AUDITED_SHELL_ALLOWLIST is exactly the documented read-only command set", () => {
  assert.deepEqual(
    AUDITED_SHELL_ALLOWLIST.map((entry) => entry.id),
    ["git-ls-files", "git-log-numstat", "npm-ls", "cargo-tree", "pip-list", "go-list"],
  );
  for (const entry of AUDITED_SHELL_ALLOWLIST) {
    assert.ok(Array.isArray(entry.prefix) && entry.prefix.length > 0, `${entry.id} must declare a non-empty prefix`);
  }
});

test("AUDITED_SHELL_DENY rejects installs, mutations, network fetches, and shell chaining", () => {
  const findsMatch = (sample) => AUDITED_SHELL_DENY.some((entry) => entry.test.test(sample));
  const denied = [
    "npm install", "npm i lodash", "yarn add react", "npm install --save pkg",
    "pip install requests", "go get example.com/pkg", "go install example.com/tool", "cargo add serde", "cargo install ripgrep",
    "npm audit", "pip-audit",
    "git commit -am x", "git push", "git reset --hard", "git checkout main",
    "npm publish", "rm -rf node_modules", "mv a b", "touch x", "echo x > file",
    "curl https://evil.example", "wget https://x",
  ];
  for (const bad of denied) {
    assert.ok(findsMatch(bad), `expected an AUDITED_SHELL_DENY entry to match: ${bad}`);
  }
  // Allowlisted read-only commands (with or without safe args) never trip AUDITED_SHELL_DENY.
  for (const ok of ["git ls-files", "git log --numstat", "npm ls --depth=0", "cargo tree", "pip list", "go list", "git ls-files src/i.js"]) {
    assert.ok(!findsMatch(ok), `expected the allowlisted command NOT to match any deny entry: ${ok}`);
  }
});

test("SHELL_PERMISSION_DENY_PATTERNS covers chaining, substitution, mutation, network, and install patterns", () => {
  assert.ok(SHELL_PERMISSION_DENY_PATTERNS.includes("*|*"), "runtime deny patterns reject bare pipes");
  assert.ok(SHELL_PERMISSION_DENY_PATTERNS.includes("*$(*"), "runtime deny patterns reject command substitution");
  assert.ok(SHELL_PERMISSION_DENY_PATTERNS.includes("*`*"), "runtime deny patterns reject backtick command substitution");
  assert.ok(SHELL_PERMISSION_DENY_PATTERNS.includes("*<*"), "runtime deny patterns reject process substitution/input redirection");
  assert.equal(SHELL_PERMISSION_DENY_PATTERNS.includes("*install*"), false, "runtime deny patterns do not over-deny install-like path text");
});

test("auditedShellPermissionPatterns() derives allow/deny wildcard patterns from the allowlist and deny patterns", () => {
  const { allow, deny } = auditedShellPermissionPatterns();
  assert.deepEqual(deny, [...SHELL_PERMISSION_DENY_PATTERNS]);
  for (const entry of AUDITED_SHELL_ALLOWLIST) {
    const base = entry.prefix.join(" ");
    assert.ok(allow.includes(base), `allow patterns must include the bare prefix: ${base}`);
    assert.ok(allow.includes(`${base} *`), `allow patterns must include the args variant: ${base} *`);
  }
});
