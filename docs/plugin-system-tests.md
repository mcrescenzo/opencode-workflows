# Plugin System Tests

> Status: **active operator reference**. Use this runbook for disposable child
> OpenCode plugin startup and registry checks after local no-token tests.

This runbook covers system-level checks for the `opencode-workflows` plugin.
Use these checks after local unit/regression tests when release readiness depends
on real OpenCode startup, child-server behavior, permissions, or workflow tool
registration.

## Baseline Regression

Run the complete no-token release gate first from this source checkout:

```sh
npm run release:no-token
```

That script runs `npm run test:lockfile-sync`, the full `npm test` matrix, and
`npm pack --dry-run --json` without model-token prompts. `npm test` includes the
workflow-kernel, live-gate, beads-drain, workflow, adapter, extension-seam,
docs/package, permission, redaction, and release-script regression suites.

For narrower iteration before the full release gate, use:

```sh
npm run test:live-gates
npm run test:workflow-kernel
npm run test:beads-drain
npm run test:workflows
```

Optional live child-system evidence is env-gated so CI and local no-token
release checks do not start OpenCode child servers accidentally:

```sh
npm run release:child-system-smoke
OPENCODE_WORKFLOWS_CHILD_SMOKE=1 npm run release:child-system-smoke
```

`release:child-system-smoke` is a **developer convenience only**. Without
`OPENCODE_WORKFLOWS_CHILD_SMOKE=1` (or with the helper/opencode binary absent)
it prints a clear `skipped` message stating the evidence is INCOMPLETE (not
verified) and exits `0` so local iteration is not blocked. **A skip is never
release proof**: "skipped" must never be treated as "verified".

## Required System-Smoke Release Gate

Public release requires live child-system smoke evidence that OpenCode startup,
plugin registry, command/tool loading, restart semantics, and child cleanup
actually work. The required gate is:

```sh
npm run release:system-smoke-required
```

This runs `scripts/child-system-smoke.mjs --required`, which **fails closed**
(non-zero exit, clear `REQUIRED GATE FAILED` message) when live smoke evidence
is absent — so the release gate can never silently equate "skipped" with
"verified". It is deliberately NOT part of `npm run release:no-token`, because
the live smoke needs the `opencode` binary and local config and is not
token-free; `release:no-token` prints a clear note that this is a separate
required step.

To satisfy the required gate, set `OPENCODE_WORKFLOWS_CHILD_SMOKE=1` plus
`OPENCODE_WORKFLOWS_CHILD_SMOKE_HELPER` to a local helper command (and
optionally `OPENCODE_WORKFLOWS_CHILD_SMOKE_HELPER_ARGS` to a JSON array of
string args), or complete the manual MCP `oc_plugin_smoke_test` / `oc_child_*`
procedure below and record the evidence fields. When enabled and a helper
returns non-zero, the required gate also fails closed.

The required smoke must exercise and capture evidence for, at minimum:

- child ID, PID, port, and trust mode
- project directory and explicit plugin path (`opencode-workflows.js`)
- startup health and OpenCode version
- command registry entries (at least `repo-bughunt`, `repo-review`, and
  `workflow-live-gates-release-check`; `beads-drain` only when the Beads
  extension is configured)
- tool registry entries (at least `workflow_run`, `workflow_status`,
  `workflow_live_gates`)
- a deterministic workflow tool execution (the child-session tool smoke below)
- restart/reload evidence (`oc_child_restart` or a fresh child, per the Restart
  And Plugin Reload Check section)
- cleanup result with `processAlive: false`

## Safe-Mode Startup Smoke

OpenCode loads plugins at startup. Do not rely on parent TUI hot reload when
testing plugin load behavior. Start a disposable child OpenCode server in safe
mode with the plugin under test loaded explicitly, then inspect startup evidence
before exercising workflow behavior.

Scripted/assisted smoke path:

1. Run `npm run release:child-system-smoke` for local developer convenience. A
   skip is expected unless `OPENCODE_WORKFLOWS_CHILD_SMOKE=1` and a local child
   helper are available; a skip is NOT release evidence. For an actual release
   decision, run `npm run release:system-smoke-required` instead, which fails
   closed when smoke evidence is missing.
2. When MCP child tools are available in the active OpenCode session, run
   `oc_plugin_smoke_test` for this repository and record the evidence fields
   below. This is the preferred authoritative child-system smoke because npm
   scripts cannot invoke MCP tools directly.

Manual fallback path:

1. Start a disposable child with `trustMode: "safe"`, this repository as
   `projectDir`, and `cleanupPolicy: "delete-on-stop"`.
2. Load `opencode-workflows.js` through explicit child config instead of inherited
   discovery when startup import/lifecycle is the behavior under test.
3. Inspect child health, PID, port, trust mode, startup logs, command registry,
   tool registry, and plugin command entries.
4. Verify the bundled commands include `repo-bughunt`, `repo-review`, and
   `workflow-live-gates-release-check`. Verify `beads-drain` only when the
   Beads extension is configured for this child.
5. Stop the child and verify cleanup evidence shows the process is gone, such as
   `processAlive: false` or an equivalent disposed-child status.

Current OpenCode child safe/pure mode can hide config-hook command/tool
registration even when the explicit plugin path is present. If the safe child is
healthy but the workflow commands or tools are absent, record that as a
safe-mode registration limitation, not as release evidence. Use an inherited
child for the actual plugin registration proof, then verify that `/command`
contains `workflow-live-gates-release-check` plus the repo-review commands
(`beads-drain` when the Beads extension is configured) and that
`/experimental/tool/ids` contains workflow tools such as `workflow_run`,
`workflow_status`, and `workflow_live_gates`.

The `oc_plugin_smoke_test` helper is acceptable for this layer when it reports:
child ID, PID, port, `trustMode: "safe"`, healthy startup, registry samples, and
cleanup/disposal evidence. If the helper output is insufficient for a release
decision, use `oc_child_start`, `oc_child_status`, and `oc_child_stop` directly.

## Evidence Format

Record these fields for the safe-mode startup smoke result:

- child ID
- PID
- port
- trust mode
- project directory
- plugin path or explicit config path
- startup health and OpenCode version
- relevant command registry entries
- relevant tool registry entries
- startup errors or warnings, if any
- cleanup result, including process liveness after stop

Registry presence proves startup registration only. Follow-up system tests must
execute workflow tools and permission paths before claiming behavior readiness.

## Deterministic Workflow Tool Smoke

Run the no-token regression that executes representative workflow tools directly
through the plugin tool APIs:

```sh
npm run test:workflows
```

The regression named `representative workflow tools execute without model
prompts` calls `workflow_list`, `workflow_roles`, `workflow_templates`,
`workflow_live_gates` without probes, `workflow_run` approval and execution,
`workflow_status`, and `workflow_cleanup`. Its prompt callback throws, so any
unexpected LLM-backed prompt fails the test.

When release evidence must include a real child OpenCode process, use this
child-session smoke after the safe-mode startup smoke succeeds:

1. Start a disposable child with `trustMode: "safe"`, this repository as
   `projectDir`, explicit plugin config pointing at `opencode-workflows.js`, and
   `cleanupPolicy: "delete-on-stop"`.
2. Inspect child status or routes and record `/experimental/tool/ids` evidence
   for `workflow_list`, `workflow_status`, `workflow_run`, and
   `workflow_live_gates`.
3. Create a child session with `oc_session_create`.
4. Run a bounded `oc_shell` Node smoke from the repository directory that imports
   `./opencode-workflows.js`, creates a temporary execution directory, calls the plugin
   tool APIs for `workflow_list`, `workflow_live_gates` without probes,
   `workflow_run`, and `workflow_status`, prints JSON evidence, and removes the
   temporary directory.
5. Capture `oc_shell` output, `oc_inspect` or `oc_events` entries that identify
   the session path exercised, and `oc_child_stop` cleanup evidence showing the
   child process is no longer alive.

Classify failures this way:

- child startup failure or missing plugin path: startup/config problem
- workflow tool IDs absent from the child registry: registration problem
- tool IDs present but the Node smoke fails: workflow tool execution problem
- `oc_shell` denied or timed out before Node runs: child shell/permission problem
- slash command failure while direct tool smoke passes: command/prompt-contract
  problem, not raw workflow tool execution

Record these fields for child-session tool smoke evidence:

- child ID, PID, port, trust mode, project directory, and plugin path
- workflow tool IDs observed in the child registry
- Node smoke JSON showing `gatesConfigured`, run ID, final status/result, and
  extension workflow discovery when an extension is configured
- relevant child session events or logs
- cleanup result, including `processAlive: false`

## Restart And Plugin Reload Check

OpenCode loads plugin code and config at child startup. Target-plugin iteration
must use `oc_child_restart` or a fresh child OpenCode server; do not automate or
restart the parent TUI to prove plugin reload behavior.

Preferred restart path:

1. Start a disposable safe child with explicit plugin config for `opencode-workflows.js`.
2. Record before-restart child status: child ID, PID, port, trust mode, plugin
   path, startup health, relevant workflow tool IDs, and command registry
   entries.
3. If testing a controlled fixture change, change only the disposable fixture
   plugin/config file. Existing sessions should not be treated as reload proof.
4. Call `oc_child_restart` for the same child, or start a fresh child with the
   updated fixture.
5. Record after-restart child status: new PID, startup health, registry evidence,
   logs/errors, and the plugin/config path observed at startup.
6. Rerun the narrow deterministic smoke that proves behavior after restart, such
   as the child-session tool smoke above or a focused command/tool check.
7. Stop the child with `oc_child_stop` and record cleanup evidence including
   `processAlive: false`.

Classify restart failures this way:

- restart fails or process remains alive unexpectedly: child lifecycle problem
- after-restart tool IDs or commands are missing: plugin registration problem
- registry is present but the narrow smoke fails after restart: plugin behavior
  or fixture-change problem
- behavior only appears after a fresh child, not `oc_child_restart`: restart
  reload-path problem to capture as a follow-up

## Permission Gate Diagnostics

Run focused permission diagnostics when `workflow_live_gates` reports failed or
blocked permission gates. Prefer deterministic child/session endpoints and raw
tool JSON over model prose.

Primary evidence path:

1. Start an inherited child only when the failure depends on normal user or
   project config.
2. Run `/workflow-live-gates-release-check` with `oc_command` to prove the child
   command can reach `workflow_live_gates`.
3. Capture the command result and classify `permissionEnforcement`,
   `commandScopedBash`, and `secretReadDeny` as `verified`, `blocked`, or
   `failed-with-evidence`.
4. If the command output is too compact, run a focused `workflow_live_gates` call
   with only permission probe flags enabled and record the raw JSON.
5. Use `oc_inspect` and `oc_events` to capture permission sessions, tool events,
   and logs when they clarify whether a denial was enforced, bypassed, or not
   observable.

Record these permission-specific fields:

- denied-bash probe result and whether the command completed
- command-scoped bash probe result and whether the denied pattern completed
- secret-read probe result and whether a read attempt was denied, allowed, or not
  observable
- child/session permission rules, when available
- relevant `oc_shell`, `oc_permission`, `oc_events`, or `oc_inspect` evidence
- whether the issue appears to be plugin logic, OpenCode runtime behavior, or
  configuration/trust posture

If a permission gate fails with evidence, do not claim autonomous non-dry release
readiness. Create or update a durable Beads blocker unless an existing epic
already tracks the runtime gate failure.
