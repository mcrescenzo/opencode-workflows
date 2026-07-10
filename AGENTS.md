# AGENTS.md

**Contract version:** `@opencode-ai/plugin@1.17.13` (declared range: `^1.17.13`)
**Verified against runtime:** opencode 1.17.13

## Scope And Layout

- This is an independently publishable opencode plugin package (`@mcrescenzo/opencode-workflows`) that can also be developed inside a private parent monorepo checkout. Runtime package dependencies are declared in `package.json`; parent-tree integrations are optional test/dev conveniences, not required package metadata.
- Plugin entrypoint is `opencode-workflows.js`, which re-exports the plugin factory via the kernel barrel `workflow-kernel/index.js` (which in turn exports the default from `workflow-kernel/workflow-plugin.js`).
- Intentional source lives in `.github/`, `commands/`, `docs/`, `skills/`, `tests/`, `workflow-kernel/`, `workflows/`, `opencode-workflows.js`, `package.json`, `README.md`, and the other root package/community files. The plugin ships one domain-neutral bundled workflow (`deep-research`) and its `/deep-research` command.
- `.opencode/`, `.beads/`, `.remember/`, `node_modules/`, logs, and child runtime registries are local runtime state; do not commit or publish them.

## Verification Commands

- Run from this directory unless noted.
- Full no-token plugin matrix: `npm test`.
- Nested workflow regression wrapper for `workflow_run`, `workflow_apply`, and model-tiering behavior: `npm run test:workflows`.
- Focused suites: `npm run test:workflow-kernel`, `npm run test:workflow-adapters`, `npm run test:extension-seam`.
- Optional parent config regression from this directory: `npm run test:parent-integration`; equivalent from the parent tree: `npm --prefix ../.. run test:workflows`.
- Tests use Node’s built-in `node --test`; many tests create temporary Git repos and call `git` via `execFile`.

## OpenCode Plugin Testing

- OpenCode loads plugin code and config at startup. After changing `opencode-workflows.js`, `workflow-kernel/`, bundled commands, skills, or registration behavior, restart OpenCode or use a fresh/restarted `opencode-child`; parent TUI hot reload is not proof.
- For system-level checks, follow `docs/plugin-system-tests.md`: start a disposable child, inspect command/tool registries, run a deterministic workflow tool smoke, then stop the child and verify cleanup.
- Safe/pure child mode can hide config-hook command/tool registration even when explicit plugin loading works. If that happens, record it as a safe-mode registration limitation and use an inherited child for registration proof.

## Workflow Boundaries

- The plugin bundles one domain-neutral, read-only workflow (`deep-research`). The core kernel ships no domain drain workflow or domain extension; a drain workflow (`harness: "drain"`) is contributed by a configured trusted extension and invoked by name with `workflow_run({ name: "<drain-workflow>", ... })`, not by path. The generic drain mechanism is exercised in-tree by the synthetic `fixture-drain` extension under `tests/fixtures/drain-extension/`.
- Empty or omitted drain args default to safe dry-run behavior. Non-null args must be a JSON object; strings and arrays are rejected before approval preview.
- A non-dry drain (`mode: "autonomous-local"`) requires a one-time launch approval; the kernel verifies the server version floor (`GET /global/health`, minimum opencode 1.17.13) and asserts lane rooting/permissions deterministically at launch — there is no live-gate preflight step.
- Normal edit/integration workflows stop at the hash-gated `workflow_apply` boundary. The intentional exception is a successful non-dry drain workflow, whose launch approval authorizes in-run local primary-tree apply and domain-mutation finalization.
- Schema lanes under `permission-ruleset` mode require the `structured_output` permission key to be explicitly allowed. The deny-by-default `*` rule hides the StructuredOutput tool from child sessions, which prevents schema-constrained lanes from completing and causes 10-minute timeouts. `permissionRulesForAuthority()` includes an explicit allow for `structured_output` after the catch-all deny.
- Structured-output is text-only: there is no native `json_schema` output-format route and no capability probe for one. Schema lanes get a JSON-schema instruction appended to the system prompt; the reply text is parsed and Ajv-validated against the schema, with corrective retries on failure (`workflow-kernel/child-agent-runner.js`, `workflow-kernel/structured-output.js`).

## Runtime Trust Model And Sensitive State

- There is no LLM-probe live-gate subsystem, no `workflow_live_gates` tool, and no opt-in release-check command. Elevated (`edit`/`worktreeEdit`/`integration`/`shell`/`network`/`mcp`-granting) authority is checked once per server via a memoized `GET /global/health` fingerprint that refuses opencode servers older than `1.17.13`; lane rooting and worktree isolation are asserted from typed API fields at creation time; and each lane's deny-by-default permission ruleset is sent with the session and re-checked against the create echo. See README "Safety & privacy" and `docs/workflow-plugin.md` for the deep contract.
- Raw run files under `.opencode/workflows/runs/` can contain sensitive local evidence. Prefer `workflow_status({ detail: "result" })` for redacted result display and `workflow_events` for redacted lifecycle-event evidence.
- Background workflow execution is not durable across OpenCode process death; stale run dirs must be reconciled with `workflow_reconcile`.
