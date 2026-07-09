# opencode-workflows

**An OpenCode plugin for running durable, resumable, multi-agent workflows.**

`@mcrescenzo/opencode-workflows` adds a `workflow_*` tool family to OpenCode that
lets you (or an agent) fan work out across multiple agent lanes, approve an exact
plan before anything runs, inspect persisted status, resume after an
interruption, and apply edits to your repo only through a reviewed, hash-gated
boundary.

It is the **engine and harness** — you bring the workflows.

## Why use it

OpenCode chats are great for one-off tasks, but some jobs are bigger or riskier
than a single unstructured prompt: a whole-repo review, a multi-step research
fan-out, a staged edit plan, a long-running background sweep. This plugin gives
those jobs a structure:

- **Plan, then approve.** Every run is previewed first — authority, models,
  budgets, lanes, and a source hash — and only starts after a hashed approval.
- **Fan out safely.** Work runs in isolated lanes (including git worktrees for
  edits), inside a deterministic QuickJS sandbox, with deny-by-default
  permissions per lane.
- **Survive interruptions.** Runs are durable and resumable: pause, cancel,
  reconcile, and resume re-run only what's needed.
- **Apply, don't assume.** Edits land on your real tree only through
  `workflow_apply`, after source/base/diff/domain hashes and a clean git base
  are checked.

## What you get

- A `workflow_*` tool family: `workflow_run`, `workflow_status`, `workflow_events`,
  `workflow_apply`, `workflow_save`, `workflow_list`, `workflow_templates`, plus
  lifecycle tools (`workflow_cancel`, `workflow_pause`, `workflow_kill`,
  `workflow_reconcile`, `workflow_cleanup`, `workflow_salvage`) and references
  (`workflow_roles`, `workflow_models`, `workflow_template_save`).
- Workflow primitives in the sandbox body: `agent`, `parallel`, `pipeline`,
  nested `workflow`, phases, budgets, structured-output schemas, and background
  runs with completion notifications.
- Authority profiles that scope what a run can do — from read-only review up to
  hash-gated primary-tree apply and (via a trusted extension) autonomous local
  drains.
- Starter templates (`first-run-slice`, `scoped-parallel`, `edit-review`) to
  copy and adapt.
- One bundled flagship workflow — `deep-research` — plus its `/deep-research`
  command: deep multi-source web research with adversarial fact-checking. It
  doubles as the living gold-standard example of every convention below.
- Three bundled skills: `opencode-workflow-authoring`, `workflow-model-tiering`,
  and `workflow-plan-review`.
- A trusted-extension seam so operators can contribute their own workflows,
  commands, skills, tools, and drain adapters.

## What it is *not*

- **It is an engine, not a pack of automations.** It ships exactly one bundled
  workflow (`deep-research`, with its `/deep-research` command) as the flagship
  exemplar; everything else you write yourself (or install via a trusted
  extension) and run with `workflow_run`.
- It is **not a daemon.** Background runs live inside the OpenCode process and
  stop if that process exits; use `workflow_reconcile` to recover stale runs.
- It does **not** silently write to your working tree. Normal edit runs stop at
  an approval boundary; you apply explicitly.
- Trusted extensions are **not** sandboxed — they run as normal Node code in
  your process. Only install extensions you'd trust as local code.

## Install

Requires OpenCode, Node ≥ 20.11, and `git` on your `PATH`.

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

Restart OpenCode after changing plugin config.

## Bundled workflow: deep-research

Deep multi-source research with adversarial fact-checking: Scope → parallel web
search per angle → URL-dedup + fetch budget → falsifiable-claim extraction →
per-claim adversarial vote panels (3 votes at `thorough`; verifier infrastructure
errors are reported as *unverified*, never as refutations) → cited synthesis.

```
workflow_run({ name: "deep-research", args: "is fish oil effective for ADHD?" })
```

Or with options: `args: { question, depth: "quick" | "normal" | "thorough",
maxSources, seedUrls }`. Depth `thorough` (default) is full 3-vote verification.

The run asks for **network authority** (`websearch`/`webfetch`) at its one-time
approval — search, fetch, and verify lanes use the web; scope and synthesize
lanes narrow themselves to read-only. No shell, no MCP, no edits. The
`/deep-research` command wraps the full flow: clarify → model tiers → approval →
report persisted to `.deep-research/runs/`.

## Quick start

A workflow run is two phases: **preview**, then **approve**.

1. Save or write a workflow, then preview it (runs nothing, returns an
   `approvalHash`):
   ```
   workflow_run({ name: "my-workflow", args: {...} })
   ```
2. Review the preview (authority, models, budgets, lanes, hashes), then run it:
   ```
   workflow_run({ name: "my-workflow", args: {...}, approve: true, approvalHash: "<hash>" })
   ```
3. Read progress and the final result:
   ```
   workflow_status({ runId, detail: "result" })
   ```

Approving an **inline-source** preview doesn't require re-transmitting the
source: the approve call may send only `approve: true` + `approvalHash` (plus
the same `args`), and the previewed bytes are reused from a bounded in-memory
store (approve-by-reference). A mismatched approve returns `changedFields`
naming which envelope fields re-keyed — `null` when the supplied hash no
longer matches a recorded preview.

New to workflows? Save a copy of the smallest safe shape and run it read-only:

```
workflow_template_save({ template: "first-run-slice" })
workflow_run({ name: "first-run-slice" })
```

## Configuration (optional)

- **`OPENCODE_WORKFLOWS_DIR`** — where global run state, roles, and templates
  live. Defaults to `$XDG_CONFIG_HOME/opencode/workflows`.
- **`OPENCODE_WORKFLOWS_DEBUG_CAPTURE=1`** — write per-lane debug artifacts
  (prompt/schema/transcript) under each private run directory. Off by default.
- **Plugin `autoApprove` option** — set to `"readOnly"`, `"worktree"`, or
  `"all"` to let eligible `workflow_run` calls launch on the first call when
  within that tier. A per-call `autoApprove` arg can narrow, never widen, the
  ceiling. `workflow_apply` always keeps its separate hash gate.
- **`OPENCODE_WORKFLOWS_HARD_CONCURRENCY_LIMIT`** — raises/lowers the per-run
  concurrency ceiling (default `64`; effective default remains `4`).

## Safety & privacy

- Every run needs a one-time hashed approval before it starts; elevated
  authority additionally requires a compatible OpenCode server (≥ `1.17.13`).
- Lane permissions are deny-by-default and re-checked against the session at
  launch; edit-capable lanes run in isolated git worktrees.
- Raw run artifacts under `.opencode/workflows/runs/` can contain sensitive
  local evidence. Prefer `workflow_status({ detail: "result" })` and
  `workflow_events` (both redacted) over reading raw files.

The deep contracts — full trust model, source-of-truth hierarchy, salvage/crash
recovery, apply internals — live in the docs linked below, not here.

## For agents

Agents install and use this plugin exactly like users: add
`@mcrescenzo/opencode-workflows` to the `plugin` array in `opencode.json` and
restart OpenCode. Then drive it through tools:

- **Author** a workflow body (`export const meta = {...}` + top-level statements
  ending in `return`; no imports) and save it with `workflow_save`, or run it
  inline. The body runs in a QuickJS sandbox with injected globals: `agent`,
  `parallel`, `pipeline`, `workflow`, `phase`, `log`, `budget`, `args`,
  `persistArtifacts`, `inventoryFiles`, `drain`.
- **Launch** with `workflow_run` (preview → `approve: true` + `approvalHash`;
  inline-source approves may omit `source` — approve-by-reference). Use
  `profile: "read-only-review"` until a task truly needs more.
- **Read back** with `workflow_status({ runId, detail: "result" })`; for edit
  runs, review the diff plan and apply with `workflow_apply` plus the required
  hashes.
- See the bundled `opencode-workflow-authoring` skill and the tool reference
  below for the full contract (sandbox limits, fan-out arity, schemas, model
  tiers, edit/apply boundaries).

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
depends on — independent of any bundled command beyond the one flagship workflow and command pair (`deep-research`).
Every other doc below lives in the GitHub repository only: read it from a
source checkout, or follow the GitHub links in the table.

| Category | Documents | Packaged? |
| --- | --- | --- |
| Ships with the npm package | `docs/workflow-plugin.md` | **Yes** |
| Active operator references (GitHub only) | `README.md`, `skills/*/SKILL.md`, [docs/workflow-recipes.md](https://github.com/mcrescenzo/opencode-workflows/blob/main/docs/workflow-recipes.md), [docs/plugin-system-tests.md](https://github.com/mcrescenzo/opencode-workflows/blob/main/docs/plugin-system-tests.md), [docs/run-audit-playbook.md](https://github.com/mcrescenzo/opencode-workflows/blob/main/docs/run-audit-playbook.md), [docs/goal-supervision-autonomous-drains.md](https://github.com/mcrescenzo/opencode-workflows/blob/main/docs/goal-supervision-autonomous-drains.md) | No (`README.md` itself ships) |
| Active technical contracts (GitHub only) | [docs/workflow-extensions.md](https://github.com/mcrescenzo/opencode-workflows/blob/main/docs/workflow-extensions.md) | No |
| Historical snapshots / audits (GitHub only) | `docs/release-gate-validation-2026-06-16.md`, `docs/dogfood-rollout-2026-06-16.md`, `docs/workflow-autonomous-harness-design.md`, `docs/review-2026-06-19-bug-robustness-remediation-plan.md`, `docs/superpowers/plans/2026-06-23-port-repo-bughunt-to-opencode.md`, `docs/superpowers/plans/2026-06-23-session-aware-model-tiering-plan.md`, `docs/general-purpose-harness-extraction-plan.md`, `docs/superpowers/plans/2026-07-07-design-c-gate-simplification.md`, `docs/superpowers/specs/2026-07-08-pure-architecture-extraction-design.md`, `docs/superpowers/plans/2026-07-08-pure-architecture-extraction.md` | No |
| Roadmap / planning (GitHub only) | `docs/workflow-autonomous-harness-plan.md`, `docs/claude-parity-roadmap.md`, `docs/superpowers/specs/2026-06-23-session-aware-model-tiering-design.md`, `docs/superpowers/specs/2026-07-07-toast-status-cards-design.md`, `docs/superpowers/plans/2026-07-08-agent-surface-docs-accuracy.md` | No |

Canonical safety references — apply authority and primary-tree writes, the
raw-artifact source-of-truth hierarchy, lifecycle recovery and cleanup, and the
deterministic launch-time trust checks — live in `docs/workflow-plugin.md`; the
complete `workflow_*` tool table is in
`docs/workflow-plugin.md#workflow-tool-reference`.

## Source Checkout Verification

The npm package ships the runtime plugin and skills — the plugin bundles exactly one workflow and one command (`deep-research` — see "What it is *not*" above) — plus the "Active
operator references" / "Active technical contracts" docs listed in the
Documentation Map above (see `files` in `package.json` for the exact
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

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for contributor prerequisites, lockfile
policy, and release-readiness notes. Verification matrix: `npm test`;
`workflow_run`/`workflow_apply` wrapper: `npm run test:workflows`.

## Roadmap

The autonomous-harness plan lives in `docs/workflow-autonomous-harness-plan.md`.
