// Audited-shell + network-advisory deep-mode policy for repo-review (iui1.7).
//
// repo-review ships static + read-only by default (profile "read-only-review": readOnly, no
// shell/network/mcp). Two OPTIONAL deep modes are available behind verified gates:
//   - audited-shell:   the inspect-with-shell profile (readOnly + shell) with a STRICT read-only
//                      command allowlist (git ls-files, git log --numstat, npm ls --depth=0,
//                      cargo tree, pip list, go list). Installs, audit-network, and ANY mutation
//                      command are denied. Enables real git-churn for complexity + live dep lists.
//   - network-advisory: a network:true profile for advisory API lookups (npm advisory, OSV,
//                       GitHub advisories). No mutation.
//
// Both modes are EXPLICITLY opt-in (args.deepMode or args.profile). Static mode never requests
// shell or network. When a deep mode is requested but the required gates are UNVERIFIED, the mode
// FAILS CLOSED: it degrades to static and records the limitation (shellCoverage stays "none").
//
// This module is PURE (no fs/shell/network) so the policy is fully unit-testable without verified
// gates or a real repo. The QuickJS repo-review guest cannot import it; the guest stays static and
// surfaces the requested mode + coverage limitation, while the command wrapper / kernel rely on
// this policy when a caller opts in via workflow_run({ profile }) — the kernel enforces the
// profile's requiredGates at plan time.

export const AUDITED_SHELL_ALLOWLIST = Object.freeze([
  // Read-only manifest/tree/listing commands only. Each entry is a command-prefix (program + the
  // fixed leading args) that a shell lens may run. Anything else is denied.
  { id: "git-ls-files", prefix: ["git", "ls-files"], note: "tracked file inventory" },
  { id: "git-log-numstat", prefix: ["git", "log", "--numstat"], note: "per-file churn history" },
  { id: "npm-ls", prefix: ["npm", "ls", "--depth=0"], note: "installed dependency tree (local)" },
  { id: "cargo-tree", prefix: ["cargo", "tree"], note: "cargo dependency tree (local)" },
  { id: "pip-list", prefix: ["pip", "list"], note: "installed python packages (local)" },
  { id: "go-list", prefix: ["go", "list"], note: "go module list (local)" },
]);

// Forbidden substrings/tokens — any command matching one of these is REJECTED even if its prefix is
// allowlisted. These are the install / audit-network / mutation / shell-meta dangers.
export const AUDITED_SHELL_DENY = Object.freeze([
  { id: "install", test: /\b(npm|yarn|pnpm)\s+(install|i|add)\b|\bpip3?\s+install\b|\binstall-packages\b|\bpip-install\b/i, reason: "package installation is a mutation" },
  { id: "yarn-add", test: /\byarn\s+add\b/i, reason: "yarn add is a mutation" },
  { id: "npm-audit", test: /\bnpm\s+audit\b/i, reason: "npm audit reaches the network; use network-advisory mode for advisories" },
  { id: "pip-audit", test: /\bpip-?audit\b/i, reason: "pip-audit reaches the network" },
  { id: "npm-publish", test: /\b(npm\s+publish|publish)\b/i, reason: "publishing is a mutation" },
  { id: "git-mutation", test: /\bgit\s+(commit|push|merge|rebase|reset|checkout|switch|stash|cherry-pick|tag)\b/i, reason: "git mutation" },
  { id: "go-get", test: /\bgo\s+get\b/i, reason: "go get mutates modules / reaches the network" },
  { id: "go-install", test: /\bgo\s+install\b/i, reason: "go install mutates the local toolchain/module cache" },
  { id: "cargo-add", test: /\bcargo\s+add\b/i, reason: "cargo add is a mutation" },
  { id: "cargo-install", test: /\bcargo\s+install\b/i, reason: "cargo install mutates the local toolchain cache" },
  { id: "redirect", test: /(^|\s)(>|>>|\||&&|;|\|\|)\s*/, reason: "shell redirection/chaining is forbidden" },
  { id: "substitution", test: /(\$\(|`|<\()/, reason: "shell command/process substitution is forbidden" },
  { id: "rm-mutation", test: /\b(rm|mv|cp|mkdir|rmdir|chmod|chown|touch|tee)\b/i, reason: "filesystem mutation" },
  { id: "curl-wget", test: /\b(curl|wget|nc|ssh|scp|rsync)\b/i, reason: "network fetch belongs in network-advisory mode, not audited-shell" },
]);

// Validate a single shell command against the audited-shell policy. Returns {allowed, reason}.
// `command` is a string (the full command line) or an argv array.
export function validateAuditedCommand(command) {
  const argv = Array.isArray(command)
    ? command.map(String)
    : String(command ?? "").trim().split(/\s+/).filter(Boolean);
  if (argv.length === 0) return { allowed: false, reason: "empty command" };
  // Denylist first (defense-in-depth): an allowlisted prefix with a forbidden token is still rejected.
  const joined = argv.join(" ");
  for (const rule of AUDITED_SHELL_DENY) {
    if (rule.test.test(joined)) return { allowed: false, reason: `denied (${rule.id}): ${rule.reason}` };
  }
  // Allowlist: the command's leading tokens must EXACTLY match one allowlisted prefix.
  const match = AUDITED_SHELL_ALLOWLIST.find((entry) => {
    if (argv.length < entry.prefix.length) return false;
    return entry.prefix.every((tok, i) => argv[i] === tok);
  });
  if (!match) {
    return { allowed: false, reason: `command not in the audited-shell allowlist (allowed: ${AUDITED_SHELL_ALLOWLIST.map((a) => a.prefix.join(" ")).join("; ")})` };
  }
  return { allowed: true, reason: `allowlisted:${match.id}`, matched: match };
}

// OpenCode permission-rule wildcard deny patterns that translate the AUDITED_SHELL_DENY concerns into
// the runtime permission ruleset. These are positioned AFTER the allow patterns in the generated
// rules (last-match-wins), so a dangerous argument tacked onto an allowlisted command is still
// denied (e.g. `git ls-files && rm x` matches `*&&*`). Patterns use OpenCode simple wildcards:
// `*` = zero-or-more of any char, `?` = exactly one char, all else literal.
//
// Kept in lock-step with AUDITED_SHELL_DENY above so validateAuditedCommand (the pure unit-testable
// validator) and the runtime permission ruleset enforce the SAME dangerous classes.
export const SHELL_PERMISSION_DENY_PATTERNS = Object.freeze([
  // Shell chaining / pipes / redirection — a read-only inspection shell never composes or redirects.
  "*&&*", "*||*", "*;*", "*|*", "*>*", "*<*",
  // Command/process substitution (AUDITED_SHELL_DENY "substitution").
  "*$(*", "*`*",
  // Filesystem mutation (AUDITED_SHELL_DENY "rm-mutation").
  "*rm *", "*rmdir *", "*mv *", "*cp *", "*mkdir *", "*chmod *", "*chown *", "*touch *", "*tee *",
  // Network fetch (AUDITED_SHELL_DENY "curl-wget") — belongs in network-advisory, not audited-shell.
  "*curl*", "*wget*", "*nc *", "*ssh *", "*scp *", "*rsync *",
  // Package install / add / publish (AUDITED_SHELL_DENY "install"/"yarn-add"/"cargo-add"/"go-get"/"go-install"/"npm-publish").
  "npm install", "npm install *", "npm i", "npm i *", "npm add", "npm add *",
  "pnpm install", "pnpm install *", "pnpm add", "pnpm add *",
  "yarn install", "yarn install *", "yarn add", "yarn add *",
  "pip install", "pip install *", "pip3 install", "pip3 install *", "*install-packages*", "*pip-install*",
  "go get", "go get *", "go install", "go install *", "cargo add", "cargo add *", "cargo install", "cargo install *", "*publish*",
  // Networked audit tools (AUDITED_SHELL_DENY "npm-audit"/"pip-audit").
  "*npm audit*", "*pip-audit*", "*pip audit*",
  // Git mutation (AUDITED_SHELL_DENY "git-mutation").
  "*git commit*", "*git push*", "*git merge*", "*git rebase*", "*git reset*", "*git checkout*", "*git switch*", "*git stash*", "*git cherry-pick*", "*git tag*",
]);

// Translate the audited-shell allowlist + denylist into OpenCode permission-rule wildcard patterns
// ({ allow: [...], deny: [...] }). Each allowlisted command prefix becomes TWO patterns — the exact
// prefix (matches the bare command, e.g. `git ls-files`) and a trailing " *" variant (matches the
// command with arguments, e.g. `git ls-files path/to/dir`). The deny patterns (above) are returned
// as-is; the caller pushes allow THEN deny so last-match-wins keeps dangerous arguments denied.
//
// Pure + deterministic; reused by resolveRunAuthority for the inspect-with-shell profile so the
// runtime permission ruleset enforces the SAME allowlist that validateAuditedCommand and the docs
// describe — the lists are never duplicated.
export function auditedShellPermissionPatterns() {
  const allow = [];
  for (const entry of AUDITED_SHELL_ALLOWLIST) {
    const base = entry.prefix.join(" ");
    allow.push(base);
    allow.push(`${base} *`);
  }
  return { allow, deny: [...SHELL_PERMISSION_DENY_PATTERNS] };
}

// The required gates per deep mode. audited-shell reuses inspect-with-shell; network-advisory adds
// network + the permissionEnforcement gate.
export const DEEP_MODE_REQUIRED_GATES = Object.freeze({
  "audited-shell": Object.freeze(["permissionEnforcement", "commandScopedBash"]),
  "network-advisory": Object.freeze(["permissionEnforcement", "networkAccess"]),
});

// Map a run's shell-lens state to a shellCoverage grade. "none" unless shell mode is active AND the
// gates are verified (fail-closed). "partial" when the shell lens is enabled (churn measured for
// some dirs); "full" when every dir's churn was measured.
export function resolveShellCoverage({ shellMode, gatesVerified, measured = 0, expected = 0 } = {}) {
  if (!shellMode || !gatesVerified) return "none";
  if (expected > 0 && measured >= expected) return "full";
  return "partial";
}

// Resolve the effective deep mode from runtime args. Pure + deterministic; the fail-closed rule
// means an unverified-gate request degrades to static (the guest/command never actually enables
// shell/network without verified gates). Returns a structured descriptor for the envelope + report.
export function resolveDeepMode({ deepMode, profile, gatesVerified = false } = {}) {
  const requested = String(deepMode ?? profile ?? "static");
  const isShell = requested === "audited-shell" || requested === "inspect-with-shell";
  const isNetwork = requested === "network-advisory" || requested === "network";
  if (!isShell && !isNetwork) {
    return {
      mode: "static",
      requested: "static",
      authorityProfile: "read-only-review",
      requiredGates: [],
      shellMode: false,
      networkMode: false,
      shellCoverage: "none",
      coverageLimitations: "Static, read-only analysis. Git churn is not measured (no shell); dependency/network advisories are not fetched (no network). Enable audited-shell or network-advisory (verified gates) for deeper coverage.",
      failClosed: false,
    };
  }
  const requiredGates = isShell ? DEEP_MODE_REQUIRED_GATES["audited-shell"] : DEEP_MODE_REQUIRED_GATES["network-advisory"];
  // FAIL CLOSED: a requested deep mode that cannot verify its gates degrades to static. The mode is
  // NEVER enabled by accident — shell/network require explicit opt-in AND verified gates.
  if (!gatesVerified) {
    return {
      mode: "static",
      requested,
      authorityProfile: "read-only-review",
      requiredGates,
      shellMode: false,
      networkMode: false,
      shellCoverage: "none",
      coverageLimitations: `${requested} was requested but required gates (${requiredGates.join(", ")}) are unverified; degraded to static read-only review. Verify the gates and re-run to enable the deep mode.`,
      failClosed: true,
    };
  }
  // Gates verified → the deep mode is active.
  if (isShell) {
    return {
      mode: "audited-shell",
      requested,
      authorityProfile: "inspect-with-shell",
      requiredGates,
      shellMode: true,
      networkMode: false,
      shellCoverage: "partial",
      coverageLimitations: null,
      failClosed: false,
    };
  }
  return {
    mode: "network-advisory",
    requested,
    authorityProfile: "network-advisory",
    requiredGates,
    shellMode: false,
    networkMode: true,
    shellCoverage: "none",
    coverageLimitations: null,
    failClosed: false,
  };
}
