# AGENTS.md

**Contract version:** `@opencode-ai/plugin@1.17.13` (declared range: `^1.17.13`)
**Verified against runtime:** opencode 1.17.11

## Scope And Layout

- This is an independently publishable opencode plugin package (`@mcrescenzo/opencode-workflows`) that can also be developed inside a private parent monorepo checkout. Runtime package dependencies are declared in `package.json`; parent-tree integrations are optional test/dev conveniences, not required package metadata.
- Plugin entrypoint is `opencode-workflows.js`, which exports `workflow-kernel/workflow-plugin.js`.
- Intentional source lives in `.github/`, `commands/`, `docs/`, `skills/`, `tests/`, `workflow-domains/`, `workflow-kernel/`, `workflows/`, `opencode-workflows.js`, `package.json`, `README.md`, and the other root package/community files.
- `.opencode/`, `.beads/`, `.remember/`, `node_modules/`, logs, and child runtime registries are local runtime state; do not commit or publish them.

## Verification Commands

- Run from this directory unless noted.
- Full no-token plugin matrix: `npm test`.
- Nested workflow regression wrapper for `workflow_run`, `workflow_apply`, and repo-review workflows: `npm run test:workflows`.
- Focused suites: `npm run test:workflow-kernel`, `npm run test:workflow-adapters`, `npm run test:beads-drain`, `npm run test:extension-seam`, `npm run test:live-gates`.
- Optional parent config regression from this directory: `npm run test:parent-integration`; equivalent from the parent tree: `npm --prefix ../.. run test:workflows`.
- Tests use Node’s built-in `node --test`; many tests create temporary Git/Beads repos and call `git`/`bd` via `execFile`.

## OpenCode Plugin Testing

- OpenCode loads plugin code and config at startup. After changing `opencode-workflows.js`, `workflow-kernel/`, bundled commands, skills, or registration behavior, restart OpenCode or use a fresh/restarted `opencode-child`; parent TUI hot reload is not proof.
- For system-level checks, follow `docs/plugin-system-tests.md`: start a disposable child, inspect command/tool registries, run a deterministic workflow tool smoke, then stop the child and verify cleanup.
- Safe/pure child mode can hide config-hook command/tool registration even when explicit plugin loading works. If that happens, record it as a safe-mode registration limitation and use an inherited child for registration proof.

## Workflow Boundaries

- Bundled core workflow source is under `workflows/`. In source checkouts, the reference Beads extension contributes trusted host extension code for `beads-drain` from `workflow-domains/beads/workflows/beads-drain.js`; invoke it by name with `workflow_run({ name: "beads-drain", ... })`, not by path.
- Empty or omitted `beads-drain` args default to safe dry-run behavior. Non-null args must be a JSON object; strings and arrays are rejected before approval preview.
- Non-dry `beads-drain` (`mode: "autonomous-local"`) requires verified live gates for permission enforcement, command-scoped bash denial, secret-read denial, structured output, directory rooting, local Git integration worktree isolation, and cancellation.
- `unsafeAcceptUnverifiedPermissions` is not a bypass for non-dry `beads-drain`; use dry-run or fix gates when any required gate is unverified, blocked, or failed.
- Normal edit/integration workflows stop at the hash-gated `workflow_apply` boundary. The intentional exception is successful non-dry `beads-drain`, whose launch approval authorizes in-run local primary-tree apply and Beads finalization.
- Schema lanes under `permission-ruleset` mode require the `structured_output` permission key to be explicitly allowed. The deny-by-default `*` rule hides the StructuredOutput tool from child sessions, which prevents schema-constrained lanes from completing and causes 10-minute timeouts. `permissionRulesForAuthority()` includes an explicit allow for `structured_output` after the catch-all deny.
- The structured-output capability probe tests StructuredOutput under the SAME deny-by-default permission rules that workflow lanes use (not in an unrestricted session), preventing false-positive capability detection.
- `structuredFormat()` omits `retryCount` because the OpenCode server adds its own internally; including it in the plugin's format object was redundant and contributed to a `getSessionMessages` readback rejection (`Expected OutputFormatJsonSchema`).

## Live Gates And Sensitive State

- `workflow_live_gates({ format: "json" })` is token-free by default and reports API/config shape as `available-unverified`; behavioral probes require `approvalIntent: "probe"` plus explicit probe flags.
- `/workflow-live-gates-release-check` runs all live probes and can spend model tokens, create/remove scratch worktrees, and schedule background/notification work. Use it only with explicit approval for those side effects.
- Raw run files under `.opencode/workflows/runs/` can contain sensitive local evidence. Prefer `workflow_status({ detail: "result" })` for redacted result display and `workflow_events` for redacted lifecycle-event evidence.
- Background workflow execution is not durable across OpenCode process death; stale run dirs must be reconciled with `workflow_reconcile`.
