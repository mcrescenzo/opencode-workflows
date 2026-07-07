# opencode-workflows

Reusable opencode workflow plugin and autonomous workflow harness work area.

The plugin entrypoint is `opencode-workflows.js`. Package installs load it via
`@mcrescenzo/opencode-workflows`; source checkouts can point opencode at the
checkout's `opencode-workflows.js` during local development.

## Install

```sh
bun add @mcrescenzo/opencode-workflows
# or
npm install @mcrescenzo/opencode-workflows
```

Register it in `opencode.json` (the singular `plugin` array key):

```json
{
  "plugin": ["@mcrescenzo/opencode-workflows"]
}
```

Restart opencode after changing plugin config.

### Configuration & prerequisites

- **`OPENCODE_WORKFLOWS_DIR`** (optional) — where global run state, roles, and templates live. Defaults to `$XDG_CONFIG_HOME/opencode/workflows` (`~/.config/opencode/workflows`). Role prompts are plain `.md` files; optional typed defaults live in sibling `roles.json`. Per-run state is also written project-locally under `<worktree>/.opencode/workflows/runs`.
- **`OPENCODE_WORKFLOWS_HARD_CONCURRENCY_LIMIT`** (optional) — raises or lowers the per-run `concurrency` schema/runtime ceiling. The default ceiling is `64`; `DEFAULT_CONCURRENCY` remains `4` until an active runtime is proven to sustain higher prompt fan-out. The same ceiling can be set per plugin entry with the `hardConcurrencyLimit` option.
- **`OPENCODE_WORKFLOWS_DEBUG_CAPTURE=1`** (optional, default off) — opt in to per-lane debug artifacts under each private run directory: rendered prompt, schema, and child transcript JSONL after secrets redaction and size caps. The same capture mode can be enabled per run with `workflow_run({ debugCapture: true })`. Leave it off for the default privacy/size posture.
- **Plugin `autoApprove` option** (optional, default off) — set to `"readOnly"`, `"worktree"`, or `"all"` to let eligible `workflow_run` calls launch on the first call when their resolved authority tier is within that ceiling. A per-call `autoApprove` argument may narrow the configured ceiling, never widen it; `workflow_apply` keeps its separate hash gate.
- **Node ≥ 20.11** (see `engines`); the test runner is Node's built-in `node --test`.
- **`git`** on `PATH` (worktree, apply, and integration tests shell out to `git`).
- **`bd` (Beads CLI)** is required only for the `beads-drain` adapter/scratch tests and the `beads-drain` workflow; all `repo-*` workflows and the rest of the no-token matrix run without it.
- **Package manager / lockfile:** `bun.lock` is the canonical tracked lockfile (`bun install` reproduces it). All package scripts are thin `node` wrappers invoked via `npm run <script>` and work regardless of installer; `package-lock.json` is gitignored.
- **Dependency notes:** `@opencode-ai/plugin` currently pins the transitive `effect` package on its `4.0.0-beta` channel. This repo accepts that upstream coupling instead of overriding `effect` independently; keep `@opencode-ai/plugin` and `@opencode-ai/sdk` in lockstep and verify `bun.lock` with `npm run test:lockfile-sync` during release checks.
- **Alpine/musl install note:** `@opencode-ai/plugin` currently pulls `effect -> msgpackr -> msgpackr-extract` as an optional native speedup. `msgpackr-extract@3.0.4` has no musl prebuild, so `npm install` on Alpine can fall back to a local native rebuild and fail if `python3`/`make`/a compiler are absent. This plugin does not import `msgpackr`, and the extractor is optional; use `npm install --ignore-scripts` on musl hosts when native install scripts are not acceptable.
- **Apply platform note:** primary-tree patch writes verify the opened file descriptor's real path before writing. On platforms/filesystems where Node cannot resolve fd real paths (for example, no `/proc/self/fd` equivalent), `workflow_apply` and in-run auto-apply fail closed with a containment error rather than using a racy path fallback.
- **Live child system smoke** (separate, required for public release): needs the `opencode` binary + local config and is NOT part of `npm test` / `release:no-token`. See `CONTRIBUTING.md` and [docs/plugin-system-tests.md](https://github.com/mcrescenzo/opencode-workflows/blob/main/docs/plugin-system-tests.md) (GitHub only, not packaged).

See `CONTRIBUTING.md` for the full contributor prerequisites, lockfile policy, and release-readiness notes.

## Source Checkout Verification

The npm package ships the runtime plugin, bundled workflows, commands, skills,
and the "Active operator references" / "Active technical contracts" docs listed
in the Documentation Map below (see `files` in `package.json` for the exact
list). It does not ship this repository's `tests/`, `scripts/`, or reference
extension source. It also does not ship the "Historical snapshots / audits" or
"Roadmap / planning" docs — those stay in git for contributors but are not part
of the published tarball. The `npm run ...` verification commands below are for
a source checkout or contributor clone, not for an installed package tarball.

Run the nested repo workflow regression wrapper from this directory:

```sh
npm run test:workflows
```

This wrapper covers the core `workflow_run` / `workflow_apply` paths and the
`repo-*` review workflows. Beads-drain, extension-seam, live-gate, and durable
state coverage live in the focused scripts below and in the catch-all `npm test`
matrix.

Run focused beads-drain and extension coverage from this directory:

```sh
npm run test:workflow-kernel
npm run test:beads-drain
npm run test:workflow-adapters
npm run test:extension-seam
```

Run mocked, no-token live-gate probe coverage from this directory:

```sh
npm run test:live-gates
```

Run the full plugin test matrix (all workflow, adapter, runtime, live-gate,
durable-state, and beads-drain integration tests) from this directory:

```sh
npm test
```

The public CI workflow in `.github/workflows/ci.yml` provisions Node 22, Bun, and
the Beads CLI, installs dependencies from `bun.lock`, and runs
`npm run release:no-token`. It intentionally does not run publishing, token-using
live probes, the private parent integration check, or the required live child
system smoke.

For system-level plugin startup checks, use [docs/plugin-system-tests.md](https://github.com/mcrescenzo/opencode-workflows/blob/main/docs/plugin-system-tests.md) (GitHub only, not packaged). Those
checks start disposable child opencode servers and verify startup health,
registries, and cleanup without restarting the parent TUI.

## Documentation Map

Use `workflow_list({ format: "json" })` as the machine-canonical discovery surface
for saved and bundled workflow names, args schemas, examples, authority profile,
model-tier hints, and safe readback steps. The docs below are operator guidance,
technical contracts, or historical context.

**Packaged vs GitHub-only.** Under the `files[]` policy, a doc ships inside the
published npm tarball only when a shipped command, skill, or workflow instructs
an *agent* to read it at runtime (a prompt/instruction string, not a code comment
or this README's own prose). `docs/workflow-plugin.md` is the only doc that
clears that bar today — three bundled commands point a running agent at
`docs/workflow-plugin.md#workflow-tool-reference`. Every other doc below lives in
the GitHub repository only: read it from a source checkout, or follow the
GitHub links in the table.

| Category | Documents | Packaged? |
| --- | --- | --- |
| Ships with the npm package | `docs/workflow-plugin.md` | **Yes** |
| Active operator references (GitHub only) | `README.md`, `commands/*.md`, `skills/*/SKILL.md`, [docs/workflow-recipes.md](https://github.com/mcrescenzo/opencode-workflows/blob/main/docs/workflow-recipes.md), [docs/plugin-system-tests.md](https://github.com/mcrescenzo/opencode-workflows/blob/main/docs/plugin-system-tests.md), [docs/repo-review.md](https://github.com/mcrescenzo/opencode-workflows/blob/main/docs/repo-review.md), [docs/run-audit-playbook.md](https://github.com/mcrescenzo/opencode-workflows/blob/main/docs/run-audit-playbook.md), [docs/goal-supervision-autonomous-drains.md](https://github.com/mcrescenzo/opencode-workflows/blob/main/docs/goal-supervision-autonomous-drains.md) | No (`README.md` itself ships) |
| Active technical contracts (GitHub only) | [docs/workflow-extensions.md](https://github.com/mcrescenzo/opencode-workflows/blob/main/docs/workflow-extensions.md), [docs/repo-review-leaf-contract.md](https://github.com/mcrescenzo/opencode-workflows/blob/main/docs/repo-review-leaf-contract.md), [docs/repo-review-parity-matrix.md](https://github.com/mcrescenzo/opencode-workflows/blob/main/docs/repo-review-parity-matrix.md) | No |
| Historical snapshots / audits (GitHub only) | `docs/release-gate-validation-2026-06-16.md`, `docs/dogfood-rollout-2026-06-16.md`, `docs/workflow-autonomous-harness-design.md`, `docs/review-2026-06-19-bug-robustness-remediation-plan.md`, `docs/superpowers/plans/2026-06-23-port-repo-bughunt-to-opencode.md`, `docs/superpowers/plans/2026-06-23-session-aware-model-tiering-plan.md` | No |
| Roadmap / planning (GitHub only) | `docs/workflow-autonomous-harness-plan.md`, `docs/general-purpose-harness-extraction-plan.md`, `docs/claude-parity-roadmap.md`, `docs/superpowers/specs/2026-06-23-session-aware-model-tiering-design.md` | No |

Canonical safety references: apply authority and primary-tree writes are in
`Authority Profiles And Apply Boundary`; raw run artifacts, transcript fallback,
debug capture, and event access are in `Source Of Truth And Transcript Fallback`;
lifecycle recovery and cleanup are in `Durable Lifecycle And Cleanup`;
live-gate behavior is in `Live Gates`; and the complete `workflow_*` tool table
is in `docs/workflow-plugin.md#workflow-tool-reference`.

## Hooks

The plugin factory (`workflow-kernel/workflow-plugin.js`) returns exactly five
opencode plugin hooks:

| Hook | What it does |
| --- | --- |
| `config` | Configures workflow permission defaults and registers bundled/extension commands, skills, and other config-time entrypoints. Mutates the passed config object in place. |
| `event` | Fire-and-forget lifecycle listener. Tracks session idle state and delivers best-effort background workflow-completion notifications; failures are swallowed so a notification error can never destabilize the session. |
| `dispose` | Clears in-memory notification runtime state when the plugin instance is torn down. |
| `"chat.params"` | Applies lane-effort model-tiering parameters to outgoing chat requests. |
| `tool` | Registers the `workflow_*` tool family (`workflow_run`, `workflow_status`, `workflow_events`, `workflow_reconcile`, `workflow_cancel`, `workflow_pause`, `workflow_kill`, `workflow_save`, `workflow_list`, `workflow_cleanup`, `workflow_apply`, `workflow_salvage`, `workflow_roles`, `workflow_models`, `workflow_templates`, `workflow_template_save`, `workflow_live_gates`), plus any NET-NEW tools contributed by a configured trusted extension. See `docs/workflow-plugin.md#workflow-tool-reference` for the full per-tool contract. |

## Command And Skill Registration

At opencode startup the plugin config hook registers the bundled commands —
`workflow-live-gates-release-check`, `repo-bughunt`, and `repo-review` — plus any
commands contributed by configured extensions (e.g. `beads-drain` from the beads
extension), and adds this plugin's `skills` directory (and extension skill dirs) to
`skills.paths`. Restart opencode after
changing plugin commands, skills, or config-time registration code; the running
process keeps the previously loaded config.

## Extension Trust Boundary

Configured workflow extensions are trusted Node modules, not sandboxed workflow
guests. When an extension path appears in opencode config, its module top-level
code and factory run in the host process with normal Node privileges before the
kernel can validate its exported shape. There is no built-in signature, hash pin,
or allowlist beyond the configured path.

The QuickJS sandbox, path policy, approval hashes, and workflow authority guards
protect guest workflow execution and core tool paths. They do not automatically
wrap extension-contributed tools, drain adapters, or mutation finalizers. An
extension can voluntarily call injected guard helpers, but a configured extension
must be treated as full-privilege host code that can read/write local files,
spawn processes, use network-capable APIs, and declare its own drain live-gate
requirements. Only install extensions you would trust as local code.

## Source Versus Local State

Intentional source assets live in `.github/`, `commands/`, `docs/`, `skills/`,
`tests/`, the source-checkout reference extension directory, `workflow-kernel/`,
`workflows/`, `opencode-workflows.js`, root package/community files, and this README. The local
`.opencode/` directory is runtime/install state for this work area, including
goal state, workflow run records, package metadata, and `node_modules`.

Those `.opencode/` artifacts are ignored rather than deleted so active workflow
or goal evidence remains available locally while staying out of source review.

## Beads Drain

`beads-drain` is not part of the published core package. It is contributed only
after a Beads extension is explicitly configured, and is then discoverable
through `workflow_list` with `scope: "extension"`. See
[docs/workflow-extensions.md#beads-is-the-reference-extension](https://github.com/mcrescenzo/opencode-workflows/blob/main/docs/workflow-extensions.md#beads-is-the-reference-extension)
(GitHub only, not packaged) for the source-checkout reference extension shape
and config pattern. Start it by name rather than by path:

```js
workflow_run({ name: "beads-drain", args: { mode: "dry-run", scope: { issueTypes: ["task"], limit: 5 } } })
```

Dry-run is the default safe path. It discovers and classifies scoped Beads work,
reports planned ready items, skipped/human-gated items, gate status, and final
dry proof without claiming Beads, spawning child edit lanes, creating worktrees,
applying patches, or mutating Beads.

Empty or omitted `args` keep that conservative dry-run default. The extension
`beads-drain` workflow rejects non-null args that are not JSON objects, including
strings and arrays, before approval preview so a mistyped scope cannot silently dry-run.
When `mode: "autonomous-local"` is requested and `background` is omitted, the
beads-drain workflow defaults to a background run so status can be inspected while it
is active. Pass `background: false` explicitly for a foreground non-dry run.
Child lane prompts default to a 10 minute timeout. For dogfood runs where lanes
are making progress but timing out, pass top-level `laneTimeoutMs` (or the alias
`childPromptTimeoutMs`) up to `3600000` milliseconds; keep `maxAgents` low until
successful lane closeout is proven.

Non-dry Beads drain fails closed before adapter discovery, Beads mutation, or
lane launch unless the required active-runtime live gates are verified:
permission enforcement, command-scoped bash denial, secret-read denial,
structured output, directory rooting, local Git integration worktree isolation,
and cancellation. `unsafeAcceptUnverifiedPermissions` is not a non-dry bypass;
run `mode: "dry-run"` or fix the reported live gates before retrying
`mode: "autonomous-local"`.
Use `/workflow-live-gates-release-check` only after explicit approval for
token/worktree/background/notification side effects.

The extension `beads-drain` script is a thin wrapper around the host-owned
`drain({ adapter: "beads" })` primitive. The trusted kernel and Beads adapter own
preflight, snapshots, claims, isolated implementation lanes, validation, mutation
staging/finalization, and final dry proof instead of reimplementing those steps in
script-body prompt plumbing. The drain runs until the scoped queue is dry, a legal
stop is reached, or bounded wave/attempt caps are exhausted. In
`mode: "autonomous-local"` a verified successful diff plan is applied to the local
primary tree in-run (accepted code changes land; staged Beads closes/followups
finalized and read back) and the run ends in `completed`/`not_dry`/legal-stop rather
than `awaiting-diff-approval`. A failed drain surfaces as `failed-with-diff-plan`,
preserved for review and applied through `workflow_apply`; apply errors enter the
retryable `apply-failed` state. `remote_sync` is always `local-only`.

If an implementation lane times out or fails after creating a dirty worktree, the
controller records dirty-timeout salvage metadata in the lane projection and drain
result (`salvaged`), preserves the worktree, and includes the salvage path and
changed files in the Beads cleanup note before reopening/unassigning the issue. It
does not auto-close or auto-apply salvaged dirty work without successful controller
validation.

## Repo Review Suite

The `repo-*` review suite is a set of read-only analysis workflows ported from a
Claude Code suite. It ships **eight leaf workflows** (`repo-bughunt`,
`repo-security-audit`, `repo-test-gaps`, `repo-cleanup`, `repo-modernize`,
`repo-perf`, `repo-complexity`, `repo-deps`), a **`repo-review` meta orchestrator**
that runs all eight with one shared recon pass and merges/ranks findings cross-domain,
and two commands: `/repo-bughunt` (single-domain) and `/repo-review` (full-suite).

Every leaf and the meta run under `profile: "read-only-review"` — no shell, edit, git,
network, or MCP, and no live-gate preflight. The QuickJS guest physically cannot write
files, so every envelope carries `reportPath: null`; **guests return data, they never
write**. Only the command wrapper persists a report under the gitignored
`.repo-review/runs/` directory (`<run-id>-bughunt-report.md` or
`<run-id>-repo-review-report.md`), and that report artifact is the only allowed
workspace write from a repo-review command.

Launch leaves/meta by name. Example leaf and meta runs (the operator resolves `fast`
(recon + finders) and `deep` (skeptics) model tiers via `workflow_models`; see
`workflow-model-tiering`):

```js
workflow_run({ name: "repo-bughunt", args: { "depth": "normal", "paths": ["src"] }, modelTiers: { "fast": "...", "deep": "..." } })
workflow_run({ name: "repo-review",  args: { "depth": "thorough", "domains": ["bughunt", "security"] }, modelTiers: { "fast": "...", "deep": "..." } })
```

Workflow source can additionally request OpenAI-only per-lane reasoning effort:
`agent(prompt, { tier: "deep", effort: "high" })`. Valid values are `minimal`,
`low`, `medium`, and `high`; the plugin applies them through OpenAI
`chat.params` provider options. A lane whose resolved model is not an OpenAI
provider fails before child launch rather than silently ignoring `effort`.

The meta uses **static one-level nesting only**: it calls each leaf via a literal
`workflow("repo-bughunt", args)` name, and a nested leaf's own declared
`maxAgents`/`concurrency` is **ignored at runtime** — the parent run's budget governs
the whole tree (see "Sizing `maxAgents`" below). Read the merged result via
`workflow_status({ runId, detail: "result" })`; treat raw
`.opencode/workflows/runs/` files as local sensitive artifacts and prefer the redacted
`workflow_status` readback.

**Nothing mutates automatically.** `review-materialize`, `beads-drain`,
`workflow_apply`, git writes, and Beads mutation are separate explicit follow-ups and
are never run by any repo-review workflow or command. The optional
`inspect-with-shell` carve-outs (the `repo-complexity` churn lens and `repo-deps`
manifest inspection) are deferred until the `permissionEnforcement` and
`commandScopedBash` live gates are verified; until then every `repo-*` lane stays plain
read-only-review. Note also that native structured output is currently unavailable in
this runtime, so the kernel's structured-text fallback is the production path.

The full user-facing guide, per-domain one-liners, the arg tables, the nested-restriction
and budgeting details, and the deferred-mutation boundary live in
[docs/repo-review.md](https://github.com/mcrescenzo/opencode-workflows/blob/main/docs/repo-review.md)
(GitHub only, not packaged). The exact leaf envelope, finding fields,
fingerprint, counts shape, size-fit semantics, and meta-to-leaf arg contract are the
named technical spec in [docs/repo-review-leaf-contract.md](https://github.com/mcrescenzo/opencode-workflows/blob/main/docs/repo-review-leaf-contract.md)
(GitHub only, not packaged).

## Sizing `maxAgents`

`maxAgents` caps the number of **child agent lanes a run launches**, counted as a
single `agentsStarted` tally. Each `agent()` call costs one slot, so a
`parallel()` of N lanes costs N and a `pipeline()` of N stages costs N. Combining,
ranking, deduping, or formatting lane results in plain JavaScript inside the
workflow body costs **zero** slots — the controller already holds those return
values in memory. A synthesis step costs a slot only when it is itself another
`agent()` lane (for example, an LLM that writes the final report); pure-JS
synthesis does not.

Size it to **(agent lanes you launch) + (1 per agent-based synthesis lane)**:

- Five research lanes with the results merged in JS: `maxAgents >= 5`.
- Five research lanes plus one agent-based synthesis lane: `maxAgents >= 6`.

Nested `workflow()` lanes **share the parent run's budget**: the nested body runs
against the same run context, so its `agent()` launches draw down the same
`maxAgents`, and a nested workflow's own `meta.maxAgents` is ignored at runtime.
Size the top-level `maxAgents` to cover the parent lanes plus every lane any
nested workflow will launch. See `docs/workflow-plugin.md` ("Sizing `maxAgents`:
child-agent accounting") for the full accounting and the code references.

## Authority Profiles And Apply Boundary

Workflow authority is approved once at launch. The approval hash covers the
source hash, runtime args, profile-expanded authority, budgets, concurrency,
child model, nested workflow snapshots, and base commit when edits are possible.
Approved runs must not stop mid-run for interactive permission prompts; they
fail closed before lane launch when required live gates are unavailable,
`available-unverified`, `blocked`, or `failed-with-evidence`.

| Profile | Purpose | Auto-Approve Tier | Required Gate Shape |
| --- | --- | --- | --- |
| `read-only-review` | Read-only analysis lanes. | `readOnly` | No elevated authority gates. Child-capable runs still preflight `permissionEnforcement` (read-only child lanes are contained by a deny-by-default permission ruleset). |
| `inspect-with-shell` | Read-only work plus a command-scoped, audited read-only shell (e.g. `git ls-files`, `git log --numstat`, `npm ls --depth=0`, `cargo tree`, `pip list`, `go list`). Shell chaining, redirection, filesystem mutation, network fetch, and package install/publish are denied at the permission-rule level. | `readOnly` | Permission enforcement and command-scoped bash denial. |
| `drain-dry-run` | Safe drain preview. | `readOnly` | No elevated authority gates. Child-capable runs still preflight `permissionEnforcement`. |
| `drain-autonomous-local` | Non-dry local drain through integration worktrees. | `all` | Permission enforcement, command-scoped bash denial, secret-read denial, structured output, directory rooting, integration worktree isolation, cancellation. |
| `edit-plan-only` | Native isolated edit plans. | `worktree` | Permission, native worktree API, directory rooting, worktree edit isolation. |
| `apply-approved-plan` | Hash-gated primary-tree apply. | `worktree` | Permission enforcement, native worktree API, directory rooting, worktree edit isolation. |

> **Network/MCP workflow authority is permission-rule enforced.** Ad-hoc `network`/`mcp`
> authority (via `args.authority` or `meta.authority`) launches after the normal approval and
> permission-enforcement gates. The runtime emits `webfetch`/`websearch`/MCP permission rules from
> the resolved authority profile. `networkAccess` remains an informational reserved diagnostic;
> `mcpAccess` has an opt-in behavioral probe, and `mcpPolicy: { allow, deny }` can scope MCP
> server/tool patterns at the run or lane level without allowing lane escalation.

`workflow_apply` is the normal explicit primary-tree write boundary for edit or
integration runs. It requires `approvalIntent: "apply"`, approved source hash,
base commit, diff-plan hash, domain mutation hash, and clean primary dirty-state
proof before writing.
The single intentional in-run apply exception is the extension-trusted non-dry `beads-drain`
under the `drain-autonomous-local` profile: its one-time launch approval
authorizes in-run apply of a verified successful diff plan to the local primary
tree (accepted code changes land; staged Beads closes/followups finalize) instead
of stopping at `awaiting-diff-approval`. Every other edit/integration run keeps
`workflow_apply` as the explicit, hash-gated write boundary; failed autonomous
drains keep `failed-with-diff-plan` for review through `workflow_apply`.
Elevated workflow launch may run required live-gate preflight probes after
approval and before mutation or lane launch. Permission, structured-output,
directory-rooting, integration-worktree-isolation, and cancellation probes each
spawn a short-lived child session (model token use), and the worktree/
directory-rooting probes create and remove scratch worktrees. The approval
preview itself never probes; these side effects begin only after the run is
approved.
Apply/finalization state is durable and retryable: `apply-running` and
`apply-failed` runs are protected from cleanup, and domain mutations finalize
only after the patch apply path succeeds.

Raw `result.json`, ledgers, diff plans, request files, and run state under
`.opencode/workflows/runs/` are local sensitive artifacts. `workflow_status
detail=result` redacts credential-like keys for display, but the raw files remain
local evidence and should not be published casually.

### Workflow Source Trust Boundary

`workflow_run` accepts a workflow by `name`, inline `source`, or explicit
`scriptPath`. Named workflows load from the trusted registries (project
`.opencode/workflows`, the global workflows directory, configured extension
workflow dirs, and the bundled plugin workflows — in that resolution order) and
inline `source` is self-contained, so neither is path-restricted.
An explicit `scriptPath` that resolves outside those trusted workflow roots
fails closed before the approval preview: absolute, out-of-root, and relative
paths with `..` traversal are rejected before the target file is even stat-ed.
Pass `allowExternalScriptPath: true` to opt in; the approval preview then shows
the resolved absolute `Source:` path, its `sourceHash`, and an `External source
(allowExternalScriptPath opt-in): true` line so the external path and hash are
visible for review before approval.

## Durable Lifecycle And Cleanup

`workflow_cancel` and `workflow_pause` write durable `cancel-request.json` and
`pause-request.json` files even when the active run is owned by another opencode
process. Active runs observe those requests before launching more child lanes.
In-process cancel/pause still aborts active child sessions best-effort.

`workflow_reconcile` is the explicit mutating recovery path for stale active runs
and stale workflow locks; `workflow_status` remains read-only. `workflow_cleanup` uses cleanup locks before deletion and preserves active,
locked, pinned, malformed, corrupt, interrupted, paused, ambiguous edit,
`apply-running`, and retryable `apply-failed` runs. Dry-run output includes
`protectedRuns` reason entries plus delete candidates so cleanup can be reviewed
before non-dry deletion.

## Source Of Truth And Transcript Fallback

Workflow state has a strict source-of-truth hierarchy. Stronger evidence always
wins; weaker evidence is recovery/diagnostic only and never finalizes work:

1. **Controller-owned run artifacts** (authoritative): the append-only
   `journal.jsonl`, the durable `result.json`, the domain/integration ledgers,
   and integration worktrees under `.opencode/workflows/runs/`. These are
   captured by the controller (the trusted kernel hub) and are the only evidence
   that may close Beads, apply diffs, or merge integration lanes.
2. **`workflow_status`** (persisted inspection): the authoritative read-only and
   recovery surface over those artifacts. Use `detail: "result"` for final
   output and `detail: "full"` only for diagnostics/apply internals. Foreground
   `workflow_run` includes the redacted return value inline when it fits the
   inline cap; larger foreground results point to the persisted
   `workflow_status({ detail: "result" })` readback. Result readback preserves
   full-fidelity non-secret strings/arrays while it fits the readback cap, then
   returns a partial projection with `resultReadback.truncated` metadata.
3. **Session transcripts** (diagnostic / fallback only): child-session message
   history persisted in opencode's session store. Transcript evidence is
   strictly weaker than a controller-captured structured result and is used only
   to surface and salvage orphaned lanes, never as the primary substrate.

Subagents never hand off directly to each other; the controller is always the
hub, and its captured return values are the primary substrate. Transcripts are a
fallback for a narrow crash window only.

`MAX_RESULT_BYTES` is still the guest return cap, not an invitation to raise
payload sizes freely. The source/result caps are coupled to the 32 MB QuickJS
heap; raising them should be reviewed alongside the sandbox heap limit.

### The crash window and `workflow_salvage`

A child lane can finish and persist its transcript while the owning opencode
process dies before the controller writes the authoritative journal entry. In
that window the result exists in the child transcript but is missing from
workflow state. `workflow_salvage` is the explicit, hash-gated recovery path for
those orphaned read-only lanes.

- **Preview/approve gate.** A preview call (no `approve`) lists each recoverable
  lane — `callId`, `childID`, JSON-parse verdict, final-message presence/length,
  a length-truncated, free-text-secret-masked `redactedSnippet`, and
  `resumeSignatureAvailable` — and
  writes nothing. It returns an `approvalHash`. Re-running with `approve: true`
  and that matching `approvalHash` (optionally narrowing with `callIds`) writes
  the recovered entries. A wrong or missing hash stays in preview and writes
  nothing. The tool is gated like `workflow_reconcile`
  (`assertWriteWorkflowAllowed`) and is denied in plan mode.
- **`salvagedFromTranscript` tag.** Every salvaged journal entry is tagged
  `salvagedFromTranscript: true` plus `salvageValidation: { kind: "json-parse",
  originalSchemaAvailable: false }`, so a recovered result is never mistaken for
  a normally-captured, schema-validated one. The original per-lane AJV schema is
  not durably persisted, so salvage validation is conservative JSON-parse only:
  outcome `success` requires the final assistant message to parse as JSON, else
  the entry is written with outcome `failure` and an error summary.
- **Read-only lane scope.** Salvage only writes entries for read-only/report
  lanes. Edit/integration lanes (those with a worktree path or integration-lane
  marker) are reported as `salvage-skipped: edit-lane-without-commit` and are
  never salvaged, because a salvaged lane has no worktree commit by
  construction. Unreadable transcripts are reported `transcript-unreadable:*`
  and skipped.
- **No auto-apply; never finalizes domain mutations or primary writes.** Salvage
  never calls `integrate()` or `runAutoApply`, never touches `state.json`,
  worktrees, or integration ledgers, and never closes Beads or applies a diff.
  It only appends a tagged synthetic journal entry and updates the lane
  projection on a durable interrupted run directory. Salvage is always explicit
  and approved — never automatic on resume.
- **Resume reuse, by code-enforced asymmetry.** On a later resume a salvaged
  read-only result is reused as a cache hit instead of re-running the lane, and
  emits a distinct `cache.salvaged_hit` event (separate from `cache.hit`) so its
  weaker provenance stays observable. The read-only-vs-edit asymmetry is enforced
  in code, not just documented: integration is filtered through `isLaneIntegrable`,
  which requires a real worktree commit and rejects any `salvagedFromTranscript`
  lane even if it somehow carried `committed: true`, so a salvaged claim can
  never reach `integrate()` or `runAutoApply`.
- **Signature fallback for shifted lanes.** If an edited workflow body inserts or
  reorders `agent()` calls, resume can claim-once reuse a prior successful
  journal entry with the same lane signature in the same fan-out scope. This
  emits `cache.signature_hit` with `originalCallId` and retags copied edit or
  integration plan entries to the new `callId` in place.

The controller reads these transcripts via the **raw SDK
`session.messages` API** (unredacted), not through the redacting
`session_read` wrapper from the separate, independently published
[`@mcrescenzo/opencode-sessions`](https://github.com/mcrescenzo/opencode-sessions)
plugin (not a dependency of this package — named here only as a point of
comparison). This is consistent with the journal already holding unredacted
lane results; salvage recovers that same class of content.

### Narrowing the crash window: lane checkpoints

Workflow-native lane checkpoints narrow the window so transcript salvage is
rarely needed. The controller writes a durable `lanes/<callId>.request.json`
before `session.prompt` and `lanes/<callId>.result.json` immediately after it
returns. On resume, a same-signature checkpoint result is reused before the
authoritative journal check and emits a distinct `cache.checkpoint_hit` event.
Checkpoint files are a narrower, earlier, transcript-independent capture; the
journal remains the source of truth and supersedes them (a superseded checkpoint
is removed). Unlike transcript salvage, checkpoint recovery needs no approval
because it is a controller-owned own-store capture, not weaker transcript
evidence.

### Background execution is not durable across process death

Transcript fallback recovers a completed child's result; it does **not** make
background execution durable. A background run dies with the owning opencode
process. There is no detached supervisor, no respawn, and no attach: the run
directory is left behind and surfaces as stale until `workflow_reconcile` marks
it interrupted, at which point `workflow_salvage` can recover orphaned read-only
lane results that completed before the crash. Completing the underlying workflow
work after process death remains out of scope until a supervisor exists.

## Background Completion Notifications

`workflow_run({ background: true })` returns a run id immediately and continues
execution in the current opencode process. When that process remains alive, the
plugin writes a compact completion notice after terminal run state is persisted
and delivers it to the invoking session after that session emits `session.idle`.
When `background` is omitted, large/long runs default to background if requested
fan-out or declared/requested duration trips the built-in heuristic: per-call
`maxAgents >= 8`, at least three serialized concurrency waves from per-call
`maxAgents` and `concurrency`, or `maxRuntimeMs >= 600000`. Declared/default
`maxAgents` ceilings are not treated as predictions of actual fan-out.
Explicit `background: true` and `background: false` always win, and resumed runs
keep their originally pinned mode. If the host lacks `session.promptAsync`, the
run still starts in background, but `workflow_run` warns that no completion
prompt can be delivered and callers must poll `workflow_status`.

Background runs expose three separate status surfaces:

| Surface | Purpose |
| --- | --- |
| `workflow_status` | Authoritative persisted inspection and recovery path. Use `detail: "result"` for final workflow output, and `detail: "full"` only for diagnostics/apply internals. |
| Toasts | Best-effort transient TUI hints for humans. They are not durable transcript context. |
| Idle notification | Best-effort `client.session.promptAsync` continuation to the original session, only after `session.idle` and only while the same opencode process is alive. |

Notifications are idempotent per run/session and include the run id, terminal
status, result path when available, a `workflow_status detail=result` hint, and
bounded error or diff-plan details.
`awaiting-diff-approval` and `review-required` notifications ask for follow-up;
they never apply changes automatically.

### Notification recovery is not durable execution

When the owning opencode process stays alive, unsent completion notifications are
recovered automatically across a plugin/module reload: on each `session.idle` the
plugin re-scans the active project/worktree run roots for persisted
`notification.json` records whose `sentAt` is still null and re-enqueues the
well-formed, session-matching ones before delivery. Already-sent, malformed, and
unrelated-session records are skipped safely. This is notification **recovery**
only — it surfaces a completion notice that was already persisted by a prior
in-process run.

It is **not** durable execution across opencode process death. A background run
dies with the owning process; its run directory is left behind and surfaces as
stale until `workflow_reconcile` marks it interrupted. There is no detached
supervisor, no respawn, and no attach. Completing the underlying workflow work
after process death is out of scope until a supervisor exists.

## Workflow Toast Status Cards

Workflow toasts are best-effort plain-text status cards for human visibility.
Persisted run state from `workflow_status` remains the authoritative source for
details, recovery, and automation.

Default toast behavior is tuned for long-running workflows:

| Setting | Default | Rationale |
| --- | --- | --- |
| Toast duration | 90 seconds | Keeps the current card visible without assuming a persistent dashboard. |
| Progress refresh interval | 45 seconds | Refreshes slower than the display duration to reduce stale stacking. |
| Forced refresh window | 75 seconds | Re-sends unchanged running state before the previous card expires. |
| Message cap | 1000 characters | Allows useful lane summaries while keeping prompts and secrets out of UI text. |
| Lane rows | 4 | Shows the longest-running active lanes and preserves idle lanes in the limited card space. |

Four card types are rendered in the same indented-outline style:

- **Heartbeat / phase**: workflow name, elapsed time, current phase `n/N`,
  active lanes, done/queued/fail counters, optional pipeline/parallel
  `items N/M`, optional budget percent, and the latest narrator `log()` line.
  Heartbeats fire every 45 seconds, force-refresh after 75 seconds even when the
  signature is unchanged, and fire immediately on `phase()` changes.
- **Problem**: lane failures/retries, stalls, and budget threshold crossings.
  Lane-failure storms are cooldown-batched; budget cards fire once at 80% and
  once at 100% for a run.
- **Terminal**: final phase breadcrumb, lane totals, recovered count, token/cost
  totals, optional budget percent, last log line, and an `inspect:
  workflow_status` hint.
- **Apply**: apply-running, applied, review-required, and apply-failed states
  with patch count, diff-plan hash, errors, and the same inspect hint.

Low-value fields are intentionally omitted from running heartbeat cards: no run
id body line, in-run dollar cost, replayed stats, concurrency/maxAgents, cache
stats, or `inspect:` hint. Problem, terminal, and apply cards keep the inspect
hint because those cards usually require follow-up.

The plugin only relies on the documented opencode toast fields: `title`,
`message`, `variant`, and `duration`. It does not assume toast replacement,
stable toast ids, markdown tables, or rich rendering. Toast delivery has a short
timeout and failures are ignored so UI behavior cannot affect workflow
correctness.

`workflowToastAscii: true` or `toastCards.ascii: true` switches all four card
types to a plain-ASCII variant for terminals or fonts that misrender box-drawing
glyphs. The default remains the outline style; the 2026-07-07 live TUI probe
rendered multiline box-drawing, warning/check, and arrow glyphs correctly in the
normal opencode TUI.

Recommended manual TUI check after changing toast timing or formatting:

1. Restart opencode so the plugin code is reloaded.
2. Start a small workflow with declared phases, at least one `phase()` change,
   and a narrator `log()` line.
3. Observe whether multiline cards stack reasonably, box-drawing glyphs align,
   long lane labels wrap readably, phase changes emit immediately, and terminal
   states are clear.
4. If glyphs misrender, enable the ASCII flag instead of changing the default
   renderer.

## Live Gates

`workflow_live_gates({ format: "json" })` is token-free by default. It reports
API shape and configuration as `available-unverified` until a behavioral probe is
run or a test injects forced gate evidence. Permission safety probes use the
child-session `session.prompt` path with tools enabled, matching workflow lanes;
direct `session.shell` behavior is diagnostic only and is not sufficient Beads
lane safety evidence.

Opt-in probe flags include:

```json
{
  "approvalIntent": "probe",
  "probePermissionEnforcement": true,
  "probeCommandScopedBash": true,
  "probeSecretReadDeny": true,
  "probeStructuredOutput": true,
  "probeWorktreeApi": true,
  "probeDirectoryRooting": true,
  "probeWorktreeEditIsolation": true,
  "probeIntegrationWorktreeIsolation": true,
  "probeBackgroundContinuation": true,
  "probeConcurrencyCapacity": true,
  "concurrencyProbeLimit": 16,
  "probeCancellation": true,
  "probeWorkflowNotification": true
}
```

Live probes require `approvalIntent: "probe"` and an active opencode server/client. Session probes can spend
model tokens; the concurrency-capacity probe launches `concurrencyProbeLimit`
child prompt calls at the same time and can expose provider or runtime rate
limits. Worktree probes can create and remove throwaway worktrees. Gate
states mean:

| State | Meaning |
| --- | --- |
| `blocked` | Required API shape or precondition is unavailable. |
| `available-unverified` | API shape exists, but behavior was not live-probed. |
| `verified` | Behavioral evidence was observed. |
| `failed-with-evidence` | A probe ran and did not prove the safety claim. |

Workflow features that depend on permissions, native worktrees, directory
rooting, local Git integration worktrees, or worktree edit isolation fail closed
when required capabilities are unavailable or `available-unverified`. Only
`verified` live-gate evidence, or explicit test capability evidence, is
sufficient for elevated workflow authority.

A verified gate's `evidenceStrength` distinguishes directly-observed target
behavior (`observed`) from weaker evidence: `no-attempt-fallback` (permission
fallback when the denied tool is hidden) and `in-process-smoke`
(`backgroundContinuation`, which only yields the event loop and does not
exercise the opencode background subsystem or imply restart survival).
Directory-rooting and integration-worktree rooting no longer verify from
model-reported cwd text alone; a text-only echo is reported as
`available-unverified` until a tool-anchored sentinel read proves the behavior.
`concurrencyCapacity` is diagnostic: it characterizes whether this active runtime
can complete an N-wide burst of trivial `session.prompt` calls. It is not required
for read-only or Beads safety gates, but it is the evidence to consult before
raising the hard concurrency ceiling for production runs.
See `/workflow-live-gates-release-check` for the weak-evidence release policy.

Non-dry Beads drain requires the local Git `integrationWorktreeIsolation` gate
instead of the native opencode `worktreeApi` and `worktreeEditIsolation` gates,
because integration lanes use the plugin-local Git worktree adapter. Native
worktree gates still report edit-mode readiness separately.

`unsafeAcceptUnverifiedPermissions` is intentionally not a bypass for non-dry
Beads drain. Permission gates (`permissionEnforcement`, `commandScopedBash`, and
`secretReadDeny`) must be verified alongside structured output, directory
rooting, local Git integration worktree isolation, and cancellation. If any gate
is unverified, blocked, or failed-with-evidence, use dry-run mode or fix the
reported live gates before retrying non-dry.

### Active Runtime Release Check

The opt-in slash command `/workflow-live-gates-release-check` runs every
behavioral `workflow_live_gates` probe in the active opencode runtime and
reports raw JSON evidence. Use it only after explicit approval for token,
worktree, background, and notification side effects.

Readiness is reported per capability tier, not as a single all-gates verdict:
non-dry `beads-drain` uses local Git `integrationWorktreeIsolation` and does
not require the native `worktreeApi` or `worktreeEditIsolation` gates, so a
blocked native worktree gate does not by itself block Beads. Each tier passes
only when `configured: true` and every gate in that tier's required subset is
`state: "verified"`; any `blocked`, `available-unverified`, or
`failed-with-evidence` gate in the relevant tier blocks that tier's release
claim. See `/workflow-live-gates-release-check` for the exact full-edit and
beads-non-dry subsets and the evidence-strength caveats. Normal `npm test`,
`npm run test:live-gates`, and `npm run test:workflows` remain no-token by
default.

## Workflow Recipes

[docs/workflow-recipes.md](https://github.com/mcrescenzo/opencode-workflows/blob/main/docs/workflow-recipes.md)
(GitHub only, not packaged) collects reusable, copy-adaptable workflow shapes so a
fresh agent does not have to rebuild a known-good run from scratch. Each recipe
ships with its authority tier, model tiering, `maxAgents`/`concurrency` sizing,
the two-phase preview/approve `workflow_run` shape, and the
`workflow_status({ runId, detail: "result" })` readback.

Start with the **first-run read-only slice** recipe when standing up any new
workflow. It ships as a saved template named `first-run-slice` (in
`DEFAULT_TEMPLATES`; list it with `workflow_templates`, save a copy with
`workflow_template_save({ template: "first-run-slice" })`, or paste its body as
`source`). It is the smallest safe shape: `profile: "read-only-review"`, one or
two scoped `parallel()` lanes, pure-JS synthesis, `maxAgents: 2`/`concurrency: 2`,
and no filesystem or Beads writes. Use it to validate the preview -> approve
handshake, the per-lane structured shape, and the
`workflow_status({ runId, detail: "result" })` readback before you widen the
fanout or nest workflows. The recipe documents `maxAgents` sizing (one slot per
`agent()` lane) and a failure-handling checklist (stale `approvalHash`, a lane
that fails its schema, evidence-free claims that land in
`droppedUnsupportedClaims`).

The next recipe is **generic read-only deep research**: scoped `parallel()`
inventory lanes that return claim + concrete evidence, with pure-JS synthesis
that drops any evidence-free claim instead of promoting it. It defaults to the
safest `read-only-review` profile and explicitly distinguishes three authority
tiers — read-only review (no shell, no network), `inspect-with-shell`
(command-scoped read-only bash), and network-authorized research (opt-in
`network`/`mcp`) — so you launch on the weakest tier the question actually needs
and never over-claim beyond what the lanes verified.

## Roadmap

The autonomous harness plan lives at `docs/workflow-autonomous-harness-plan.md`.
