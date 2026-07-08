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
- **Package manager / lockfile:** `bun.lock` is the canonical tracked lockfile (`bun install` reproduces it). All package scripts are thin `node` wrappers invoked via `npm run <script>` and work regardless of installer; `package-lock.json` is gitignored.
- **Dependency notes:** `@opencode-ai/plugin` currently pins the transitive `effect` package on its `4.0.0-beta` channel. This repo accepts that upstream coupling instead of overriding `effect` independently; keep `@opencode-ai/plugin` and `@opencode-ai/sdk` in lockstep and verify `bun.lock` with `npm run test:lockfile-sync` during release checks.
- **Alpine/musl install note:** `@opencode-ai/plugin` currently pulls `effect -> msgpackr -> msgpackr-extract` as an optional native speedup. `msgpackr-extract@3.0.4` has no musl prebuild, so `npm install` on Alpine can fall back to a local native rebuild and fail if `python3`/`make`/a compiler are absent. This plugin does not import `msgpackr`, and the extractor is optional; use `npm install --ignore-scripts` on musl hosts when native install scripts are not acceptable.
- **Apply platform note:** primary-tree patch writes verify the opened file descriptor's real path before writing. On platforms/filesystems where Node cannot resolve fd real paths (for example, no `/proc/self/fd` equivalent), `workflow_apply` and in-run auto-apply fail closed with a containment error rather than using a racy path fallback.
- **Live child system smoke** (separate, recommended before breaking or high-risk releases; not enforced by the automated release): needs the `opencode` binary + local config and is NOT part of `npm test` / `release:no-token`. See `CONTRIBUTING.md` and [docs/plugin-system-tests.md](https://github.com/mcrescenzo/opencode-workflows/blob/main/docs/plugin-system-tests.md) (GitHub only, not packaged).

See `CONTRIBUTING.md` for the full contributor prerequisites, lockfile policy, and release-readiness notes.

## Source Checkout Verification

The npm package ships the runtime plugin and skills — the plugin bundles zero
workflows and zero commands (see "Command And Skill Registration" below) —
plus the "Active operator references" / "Active technical contracts" docs listed
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

This wrapper covers the core `workflow_run` / `workflow_apply` paths. Kernel
drain, extension-seam, and durable state coverage live in the focused scripts
below and in the catch-all `npm test` matrix.

Run focused kernel and extension coverage from this directory:

```sh
npm run test:workflow-kernel
npm run test:workflow-adapters
npm run test:extension-seam
```

Run the full plugin test matrix (all workflow, adapter, runtime,
durable-state, and extension integration tests) from this directory:

```sh
npm test
```

The public CI workflow in `.github/workflows/ci.yml` provisions Node 22 and Bun,
installs dependencies from `bun.lock`, and runs
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
published npm tarball only when it is load-bearing for the kernel API a shipped
skill or extension directly depends on, not merely cited in a code comment or
this README's own prose. `docs/workflow-plugin.md` is the only doc that clears
that bar today: it is the canonical `workflow_*` tool reference
(`docs/workflow-plugin.md#workflow-tool-reference`) that every extension,
skill, or agent invoking `workflow_run`/`workflow_apply`/`workflow_status`
depends on — independent of any bundled command, since the plugin ships none.
Every other doc below lives in the GitHub repository only: read it from a
source checkout, or follow the GitHub links in the table.

| Category | Documents | Packaged? |
| --- | --- | --- |
| Ships with the npm package | `docs/workflow-plugin.md` | **Yes** |
| Active operator references (GitHub only) | `README.md`, `skills/*/SKILL.md`, [docs/workflow-recipes.md](https://github.com/mcrescenzo/opencode-workflows/blob/main/docs/workflow-recipes.md), [docs/plugin-system-tests.md](https://github.com/mcrescenzo/opencode-workflows/blob/main/docs/plugin-system-tests.md), [docs/run-audit-playbook.md](https://github.com/mcrescenzo/opencode-workflows/blob/main/docs/run-audit-playbook.md), [docs/goal-supervision-autonomous-drains.md](https://github.com/mcrescenzo/opencode-workflows/blob/main/docs/goal-supervision-autonomous-drains.md) | No (`README.md` itself ships) |
| Active technical contracts (GitHub only) | [docs/workflow-extensions.md](https://github.com/mcrescenzo/opencode-workflows/blob/main/docs/workflow-extensions.md) | No |
| Historical snapshots / audits (GitHub only) | `docs/release-gate-validation-2026-06-16.md`, `docs/dogfood-rollout-2026-06-16.md`, `docs/workflow-autonomous-harness-design.md`, `docs/review-2026-06-19-bug-robustness-remediation-plan.md`, `docs/superpowers/plans/2026-06-23-port-repo-bughunt-to-opencode.md`, `docs/superpowers/plans/2026-06-23-session-aware-model-tiering-plan.md`, `docs/general-purpose-harness-extraction-plan.md`, `docs/superpowers/plans/2026-07-07-design-c-gate-simplification.md`, `docs/superpowers/specs/2026-07-08-pure-architecture-extraction-design.md`, `docs/superpowers/plans/2026-07-08-pure-architecture-extraction.md` | No |
| Roadmap / planning (GitHub only) | `docs/workflow-autonomous-harness-plan.md`, `docs/claude-parity-roadmap.md`, `docs/superpowers/specs/2026-06-23-session-aware-model-tiering-design.md`, `docs/superpowers/specs/2026-07-07-toast-status-cards-design.md`, `docs/superpowers/plans/2026-07-08-agent-surface-docs-accuracy.md` | No |

Canonical safety references: apply authority and primary-tree writes are in
`Authority Profiles And Apply Boundary`; raw run artifacts, transcript fallback,
debug capture, and event access are in `Source Of Truth And Transcript Fallback`;
lifecycle recovery and cleanup are in `Durable Lifecycle And Cleanup`;
the deterministic launch-time trust checks are in `Runtime Trust Model`; and the
complete `workflow_*` tool table is in `docs/workflow-plugin.md#workflow-tool-reference`.

## Hooks

The plugin factory (`workflow-kernel/workflow-plugin.js`) returns exactly five
opencode plugin hooks:

| Hook | What it does |
| --- | --- |
| `config` | Configures workflow permission defaults and registers bundled/extension commands, skills, and other config-time entrypoints. Mutates the passed config object in place. |
| `event` | Fire-and-forget lifecycle listener. Tracks session idle state and delivers best-effort background workflow-completion notifications; failures are swallowed so a notification error can never destabilize the session. |
| `dispose` | Clears in-memory notification runtime state when the plugin instance is torn down. |
| `"chat.params"` | Applies lane-effort model-tiering parameters to outgoing chat requests. |
| `tool` | Registers the `workflow_*` tool family (`workflow_run`, `workflow_status`, `workflow_events`, `workflow_reconcile`, `workflow_cancel`, `workflow_pause`, `workflow_kill`, `workflow_save`, `workflow_list`, `workflow_cleanup`, `workflow_apply`, `workflow_salvage`, `workflow_roles`, `workflow_models`, `workflow_templates`, `workflow_template_save`), plus any NET-NEW tools contributed by a configured trusted extension. See `docs/workflow-plugin.md#workflow-tool-reference` for the full per-tool contract. |

## Command And Skill Registration

The plugin registers zero bundled commands of its own. At opencode startup the
plugin config hook registers only the commands contributed by configured
extensions (for example a drain command from a trusted extension) and by the
operator's own project/global opencode config, and adds this plugin's `skills`
directory — three authoring/operator skills (`opencode-workflow-authoring`,
`workflow-model-tiering`, `workflow-plan-review`) — plus any extension skill
dirs to `skills.paths`. Restart opencode after changing plugin commands,
skills, or config-time registration code; the running process keeps the
previously loaded config.

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
spawn processes, use network-capable APIs, and declare its own drain adapter
behavior. Only install extensions you would trust as local code.

## Source Versus Local State

Intentional source assets live in `.github/`, `docs/`, `skills/`, `tests/`
(including the synthetic `fixture-drain` reference extension under
`tests/fixtures/drain-extension/`), `workflow-kernel/`, `opencode-workflows.js`,
root package/community files, and this README. The plugin bundles zero
`workflows/` or `commands/`; those directories do not exist in this repo. The
local `.opencode/` directory is runtime/install state for this work area,
including goal state, workflow run records, package metadata, and
`node_modules`.

Those `.opencode/` artifacts are ignored rather than deleted so active workflow
or goal evidence remains available locally while staying out of source review.

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
Approved runs must not stop mid-run for interactive permission prompts. Elevated
authority (`edit`, `worktreeEdit`, `integration`, `shell`, `network`, or `mcp`)
additionally consults a memoized per-server `GET /global/health` fingerprint at
launch and refuses to start on an opencode server older than `1.17.13` (see "Runtime Trust
Model").

Approving an inline-source preview does not require re-transmitting the source:
an approve call may send only `approve: true` + `approvalHash`, and the
previewed bytes are reused from a bounded in-memory store (approve-by-reference).
A mismatched approve returns `changedFields` naming which envelope fields
re-keyed (null when the supplied hash no longer matches a recorded preview).

| Profile | Purpose | Auto-Approve Tier |
| --- | --- | --- |
| `read-only-review` | Read-only analysis lanes. | `readOnly` |
| `inspect-with-shell` | Read-only work plus a command-scoped, audited read-only shell (e.g. `git ls-files`, `git log --numstat`, `npm ls --depth=0`, `cargo tree`, `pip list`, `go list`). Shell chaining, redirection, filesystem mutation, network fetch, and package install/publish are denied at the permission-rule level. | `readOnly` |
| `drain-dry-run` | Safe drain preview. | `readOnly` |
| `drain-autonomous-local` | Non-dry local drain through integration worktrees. | `all` |
| `edit-plan-only` | Native isolated edit plans. | `worktree` |
| `apply-approved-plan` | Hash-gated primary-tree apply. | `worktree` |

Every profile's deny-by-default permission ruleset is sent with the child
session and re-checked against the session create echo; a mismatch fails that
lane closed. Profiles that create a worktree (`edit-plan-only`,
`apply-approved-plan`, `drain-autonomous-local`) additionally assert directory
rooting and worktree path-distinctness from the typed API fields returned at
creation time, not from model-reported text.

> **Network/MCP workflow authority is permission-rule enforced.** Ad-hoc `network`/`mcp`
> authority (via `args.authority` or `meta.authority`) launches after the normal approval
> handshake. The runtime emits `webfetch`/`websearch`/MCP permission rules from
> the resolved authority profile — network/mcp is granted by profile policy, coarse-gated by
> the lane tools map, and covered by the server version floor (network/mcp-granting authority
> refuses a sub-floor server, same as edit/shell). `mcpPolicy: { allow, deny }` can scope MCP
> server/tool patterns at the run or lane level without allowing lane escalation.

`workflow_apply` is the normal explicit primary-tree write boundary for edit or
integration runs. It requires `approvalIntent: "apply"`, approved source hash,
base commit, diff-plan hash, domain mutation hash, and clean primary dirty-state
proof before writing.
The single intentional in-run apply exception is an extension-trusted non-dry drain
workflow under the `drain-autonomous-local` profile: its one-time launch approval
authorizes in-run apply of a verified successful diff plan to the local primary
tree (accepted code changes land; staged domain mutations finalize) instead
of stopping at `awaiting-diff-approval`. Every other edit/integration run keeps
`workflow_apply` as the explicit, hash-gated write boundary; failed autonomous
drains keep `failed-with-diff-plan` for review through `workflow_apply`.
Elevated workflow launch consults the server-fingerprint version floor once per
server before any lane launches; unlike the deleted probe subsystem, this check
spends no model tokens and creates no scratch worktrees. The approval preview
itself never contacts the server; the fingerprint check runs only after the run
is approved, before mutation or lane launch.
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
   that may finalize domain mutations, apply diffs, or merge integration lanes.
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
  worktrees, or integration ledgers, and never finalizes domain mutations or applies a diff.
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

## Runtime Trust Model

Every workflow needs a one-time hashed human approval before it runs. Lanes
work inside real git worktrees; their edits land on your tree only through the
controller, after a clean-base check and a diff-plan hash match. Lane rooting
and worktree isolation are asserted from typed API fields at creation time, and
each lane's deny-by-default permission ruleset is sent with the session and
re-checked against the create echo. The kernel trusts opencode itself — the
plugin runs inside it — and verifies compatibility once per server via
`GET /global/health`, refusing edit-, worktreeEdit-, integration-, shell-,
network-, and mcp-granting ("elevated") profiles below opencode `1.17.13`.

There is no LLM-probe live-gate subsystem, no `workflow_live_gates` tool, and no
opt-in release-check command. None of the checks above spend model tokens,
spawn child sessions, or create/remove scratch worktrees to prove themselves —
they are ordinary deterministic checks that run at the moment each property is
actually used. A failed check (a too-old server, a permission-echo mismatch, a
dirty base, or a diff-plan hash mismatch) throws before the affected lane or
apply proceeds, so failure is loud rather than degrading to an unverified
middle state. Normal `npm test` and `npm run test:workflows` remain no-token by
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
and no filesystem or domain-mutation writes. Use it to validate the preview -> approve
handshake, the per-lane structured shape, and the
`workflow_status({ runId, detail: "result" })` readback before you widen the
fanout or nest workflows. The recipe documents `maxAgents` sizing (one slot per
`agent()` lane) and a failure-handling checklist (stale `approvalHash`, a lane
that fails its schema, evidence-free claims that land in
`droppedUnsupportedClaims`).

Two more starter templates ship alongside it: `scoped-parallel` demonstrates
the scoped-helper `parallel()` callback form over an `args.items` list, and
`edit-review` demonstrates the smallest schema-gated edit lane (an edit lane
must declare a schema returning `{ patches: [...] }`). List all three with
`workflow_templates`; save a copy with `workflow_template_save`.

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
