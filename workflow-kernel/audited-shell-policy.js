// Audited-shell command policy for the kernel's "inspect-with-shell" authority profile.
//
// Most read-only workflows run under "read-only-review" (readOnly, no shell/network/mcp). The
// OPTIONAL "inspect-with-shell" profile (readOnly + shell) layers a STRICT read-only command
// allowlist on top (git ls-files, git log --numstat, npm ls --depth=0, cargo tree, pip list,
// go list). Installs, audit-network, and ANY mutation command are denied. This lets any
// workflow or extension that opts into the profile read real git-churn history and live
// dependency trees without shell-level mutation or network access.
//
// This module is PURE (no fs/shell/network) so the policy is fully unit-testable without a real
// repo. It supplies the allowlist and runtime deny patterns that resolveRunAuthority
// (authority-policy.js) turns into the permission ruleset for the inspect-with-shell profile.

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

// OpenCode permission-rule wildcard deny patterns for the audited-shell danger classes. These are
// positioned AFTER the allow patterns in the generated
// rules (last-match-wins), so a dangerous argument tacked onto an allowlisted command is still
// denied (e.g. `git ls-files && rm x` matches `*&&*`). Patterns use OpenCode simple wildcards:
// `*` = zero-or-more of any char, `?` = exactly one char, all else literal.
export const SHELL_PERMISSION_DENY_PATTERNS = Object.freeze([
  // Shell chaining / pipes / redirection — a read-only inspection shell never composes or redirects.
  "*&&*", "*||*", "*;*", "*|*", "*>*", "*<*",
  // Command/process substitution.
  "*$(*", "*`*",
  // Filesystem mutation.
  "*rm *", "*rmdir *", "*mv *", "*cp *", "*mkdir *", "*chmod *", "*chown *", "*touch *", "*tee *",
  // Network fetch belongs in network-advisory, not audited-shell.
  "*curl*", "*wget*", "*nc *", "*ssh *", "*scp *", "*rsync *",
  // Package install / add / publish.
  "npm install", "npm install *", "npm i", "npm i *", "npm add", "npm add *",
  "pnpm install", "pnpm install *", "pnpm add", "pnpm add *",
  "yarn install", "yarn install *", "yarn add", "yarn add *",
  "pip install", "pip install *", "pip3 install", "pip3 install *", "*install-packages*", "*pip-install*",
  "go get", "go get *", "go install", "go install *", "cargo add", "cargo add *", "cargo install", "cargo install *", "*publish*",
  // Networked audit tools.
  "*npm audit*", "*pip-audit*", "*pip audit*",
  // Git mutation.
  "*git commit*", "*git push*", "*git merge*", "*git rebase*", "*git reset*", "*git checkout*", "*git switch*", "*git stash*", "*git cherry-pick*", "*git tag*",
]);

// Translate the audited-shell allowlist and deny patterns into OpenCode permission-rule wildcard patterns
// ({ allow: [...], deny: [...] }). Each allowlisted command prefix becomes TWO patterns — the exact
// prefix (matches the bare command, e.g. `git ls-files`) and a trailing " *" variant (matches the
// command with arguments, e.g. `git ls-files path/to/dir`). The deny patterns (above) are returned
// as-is; the caller pushes allow THEN deny so last-match-wins keeps dangerous arguments denied.
//
// Pure + deterministic; reused by resolveRunAuthority for the inspect-with-shell profile so the
// runtime permission ruleset enforces the allowlist documented above.
export function auditedShellPermissionPatterns() {
  const allow = [];
  for (const entry of AUDITED_SHELL_ALLOWLIST) {
    const base = entry.prefix.join(" ");
    allow.push(base);
    allow.push(`${base} *`);
  }
  return { allow, deny: [...SHELL_PERMISSION_DENY_PATTERNS] };
}
