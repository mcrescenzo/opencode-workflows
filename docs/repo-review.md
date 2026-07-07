# Repo Review Suite

> Status: **active operator reference**. Use `workflow_list({ format: "json" })`
> for machine-readable bundled workflow args/examples and this guide for human context.

> User-facing guide to the bundled `repo-*` review workflows and the `/repo-bughunt`
> and `/repo-review` commands.
>
> For the exact leaf envelope, finding fields, fingerprint algorithm, counts shape,
> size-fit semantics, and the meta-to-leaf arg contract, see the named technical
> contract: [`docs/repo-review-leaf-contract.md`](./repo-review-leaf-contract.md).
> This page does not duplicate that spec; it links to it.

The repo-review suite is a set of **read-only** review workflows ported from a Claude
Code suite into native OpenCode bundled workflows. Every domain is a report-only leaf
engine: it analyzes a repo via `agent()` lanes, adversarially verifies candidates,
ranks findings, and returns a structured envelope. **The workflow never writes files,
edits, commits, applies patches, or mutates Beads.** Report persistence is a
command-side concern, not a workflow concern.

## What ships

### Eight leaf workflows (under `workflows/`)

Every leaf is a QuickJS guest: no Bash/fs/git, no `import`, no `workflow()` calls
(leaves never nest). All declare `profile: "read-only-review"` and return the shared
envelope from contract §2.

| Leaf | One-line description |
| --- | --- |
| `repo-bughunt` | Correctness bugs (concurrency, error-handling, boundaries, null/empty, resource leaks, API misuse, bad state), adversarially verified. |
| `repo-security-audit` | Whole-repo security audit (injection, authz, secrets, unsafe deserialization, SSRF, crypto misuse, input validation, dependency CVEs, insecure defaults, sensitive logging). Secret-class findings surface location + masked snippet, never the raw value. |
| `repo-test-gaps` | Undertested code (uncovered public surfaces, untested error paths, missing edge cases, branches without assertions, weak critical paths, untested seams) with concrete proposed tests. |
| `repo-cleanup` | Dead code, unused deps, duplication, stale markers, simplification/best-practice issues, doc drift; high-risk "remove" findings adversarially verified. |
| `repo-modernize` | Modernization opportunities (deprecated APIs, outdated idioms, legacy patterns, unneeded polyfills, config upgrades), adversarially verified, with a sequenced `migrationPlan`. |
| `repo-perf` | Performance hotspots (N+1/repeated I/O, accidental quadratics, hot-path allocations, sync blocking, missing caching, inefficient structures, redundant compute). Static analysis only — no profiler/benchmark is run. |
| `repo-complexity` | Refactor hotspots ranked by complexity × churn (god-object, long-function, deep-nesting, tangled-module, high-churn-hotspot); one scorer per source directory. |
| `repo-deps` | Dependency health (outdated, CVEs from local-file analysis, unused/undeclared, license risk, version conflicts, deprecated) with a sequenced `upgradePlan`. Read-only lockfile/manifest inspection only. |

### One meta orchestrator

| Workflow | One-line description |
| --- | --- |
| `repo-review` | Comprehensive meta: computes shared recon ONCE, runs all eight leaf engines via static one-level `workflow()` calls, then conservatively merges and cross-domain-ranks their findings into a single report. Report-only; nothing is applied. |

### Two commands (under `commands/`)

| Command | Scope | Report artifact |
| --- | --- | --- |
| `/repo-bughunt` | Runs only the `repo-bughunt` leaf (the single-domain proof-of-concept command). | `.repo-review/runs/<run-id>-bughunt-report.md` |
| `/repo-review` | Runs the full-suite `repo-review` meta and persists the merged eight-domain report. | `.repo-review/runs/<run-id>-repo-review-report.md` |

Both commands are registered at OpenCode startup by the plugin config hook
(`configureWorkflowEntrypoints` in `workflow-kernel/workflow-plugin.js`).

## Running a leaf directly

Each leaf is discoverable through `workflow_list` and is invoked **by name**, never by
file path. A leaf accepts the shared arg object (contract §8):

```js
workflow_run({
  name: "repo-bughunt",
  args: { "depth": "thorough", "paths": ["src"] },
  modelTiers: { "fast": "<fast model>", "deep": "<deep model>" }
})
```

Recognized args (all optional, with safe defaults):

| Arg | Default | Meaning |
| --- | --- | --- |
| `paths` | `["."]` | Repo-relative paths to review. |
| `exclude` | `["node_modules","dist","build",".git","vendor","target","*.min.*","*.map"]` | Paths not scanned/reported. Lockfiles are not excluded by default so dependency/security domains can inspect them. |
| `depth` | `thorough` | `quick` / `normal` / `thorough` verification profile (quick = high-severity only, 1 skeptic; normal = all, 1 skeptic; thorough = second find round, 3-skeptic majority). |
| `categories` | domain's full set | Subset of the domain's known categories (unknown categories dropped). |
| `maxReturnFindings` | `1000000` | Cap on the returned findings array (`counts.total` still reflects the full ranked set). |
| `recon` | (absent) | Injected repo profile; when present the leaf **skips self-profiling**. |

## Running the meta

The meta accepts the same scope/depth args plus a `domains` filter and a meta-only
`mode`, and computes recon once for the whole suite:

```js
workflow_run({
  name: "repo-review",
  args: { "depth": "thorough", "domains": ["bughunt", "security"] },
  modelTiers: { "fast": "<fast model>", "deep": "<deep model>" }
})
```

- `domains` accepts either the bare domain (`"bughunt"`, `"security"`, `"test-gaps"`,
  `"cleanup"`, `"modernize"`, `"perf"`, `"complexity"`, `"deps"`) or the leaf name
  (`"repo-bughunt"`, …). Omitting it runs all eight.
- `mode` accepts `"exhaustive"` (default) or `"bounded"`. Exhaustive mode selects
  `depth: "thorough"`, `maxReturnFindings: 1000000`, and a coverage-auditor lane;
  bounded mode preserves the legacy normal-depth pass without the auditor.
- The meta injects the **same** recon + `paths`/`exclude`/`depth` into every leaf so
  all eight domains analyze one coherent file inventory and cross-domain dedupe stays
  consistent (contract §14).
- The merged meta envelope adds cross-domain fields the leaves do not carry:
  `leafOutcomes` (per-domain coverage ledger), `domainExtras` (per-domain carve-outs
  such as `staleDocs`, `migrationPlan`, `upgradePlan`), `partialCoverage` (true when a
  leaf failed or was budget-stopped), and unified findings with `priorityScore`,
  `sourceDomains`, `relatesTo` rank links, and curated `domainDetails` used by
  `/review-materialize` to populate Beads design/acceptance fields.

Prefer the commands (`/repo-bughunt`, `/repo-review`) for interactive runs: they parse
and validate args, resolve model tiers, launch by name, read back the result, and
persist the report. The raw `workflow_run` form above is for scripting or when you want
the envelope in-memory without writing a report file.

## Nested workflow restrictions and budgeting

The suite uses **static one-level nesting only** (contract §14.3):

- The `repo-review` meta calls each leaf via a **static literal** name —
  `workflow("repo-bughunt", args)`, `workflow("repo-security-audit", args)`, …
  Dynamic/computed workflow names are rejected by the kernel and are a contract
  violation, not just a runtime check.
- Leaves are leaves: they never call `workflow()`. Nesting is exactly one level deep,
  and the meta must never itself be invoked via `workflow()` by another workflow.

**Nested lanes share the parent run's budget** (contract §14.4; see the README's
"Sizing `maxAgents`" section and `docs/workflow-plugin.md`). The nested body runs
against the same `RunContext` as the parent, so:

- A nested leaf's own declared `meta.maxAgents` / `concurrency` is **ignored at
  runtime**. Only the parent run's `maxAgents` (fixed at approval) governs the combined
  launch count.
- Size the **parent** `maxAgents` to cover one shared recon lane plus the cumulative
  fan-out of every leaf it will run (each leaf is itself a fan-out of finder + skeptic
  lanes). The shipped meta declares `maxAgents: 100000`, `concurrency: 16` to
  over-provision thorough-depth exhaustive runs plus the coverage auditor while
  keeping peak child-session fan-out at 16; an operator-supplied smaller budget
  may still budget-stop gracefully (see below).

**Graceful budget stop.** Every lane is declared with `onFailure: "returnNull"`, so a
cost/token ceiling stops lanes as `null` rather than crashing the run. The meta drops
stopped/failed leaves via `.filter(Boolean)` and surfaces them as `partialCoverage:
true` in the envelope — a coherent partial report, not a failure.

## Model tiering (`fast` / `deep`)

Workflow sources carry **no hard-coded provider or model strings**. Every lane declares
a tier intent, and the kernel resolves `tier -> concrete model` from
`run.modelTiers`:

| Lane role | Tier | Why |
| --- | --- | --- |
| recon (repo profiler; meta's shared recon) | `fast` | Bulk read-only profiling; breadth. |
| finder / scorer (candidate generation) | `fast` | High-volume fan-out; breadth. |
| skeptic / verify / judge (adversarial verdict) | `deep` | Subtle correctness reasoning; narrow, high-stakes. |

Synthesis/ranking/rendering is pure JavaScript inside the workflow body and uses **no**
model and **no** agent slot.

Before launching, follow the `workflow-model-tiering` skill:

1. Call `workflow_models` (token-free) to enumerate the invoking session's model family.
2. Map `fast` and `deep` to concrete models inside that family. The no-deviation
   suggestion keeps both tiers on the session model; deviate to map `fast` to a
   cheaper/faster model and `deep` to a stronger one. Confirm with the user only when
   the plan deviates from the session family — otherwise the approval preview's
   `Model plan: fast=… deep=…` is the confirmation.
3. Pass the resolved tiers to `workflow_run({ modelTiers: { fast, deep } })`.

If `modelTiers` is omitted, every tier degrades to the session-inherited default model
(both tiers identical) — the explicit no-deviation default, not a contract violation.

## Authority profile: read-only by default

Every shipped `repo-*` leaf and the meta declare **`profile: "read-only-review"`**:
read-only authority, **no elevated live-gate preflight** (`requiredGates: []`). Each
lane is contained by a deny-by-default permission ruleset — no shell, no edit, no git,
no network, no MCP. The QuickJS guest also physically cannot write files or import
modules. The suite performs pure read-only analysis and returns an in-memory envelope.

### `inspect-with-shell` exceptions are deferred

The contract reserves an optional `inspect-with-shell` profile (read-only plus
command-scoped shell) for two documented parity gaps only:

- `repo-complexity` — a git-history/churn lens that benefits from `git log` style data.
- `repo-deps` — deeper lockfile/manifest inspection.

These exceptions are **deferred**. `inspect-with-shell` requires the
`permissionEnforcement` and `commandScopedBash` live gates to be **verified**; under
the current runtime those gates are still `available-unverified`, so no shipped leaf
opts into shell mode. Until those gates are verified, every `repo-*` lane runs under
plain `read-only-review` (complexity derives churn from read-only file reads; deps does
read-only manifest/lockfile parsing). Do not assume shell access is available when
sizing or reviewing a run.

## Reading the result: `workflow_status detail:"result"`

The user-facing result surface is:

```js
workflow_status({ runId: "<run id>", detail: "result" })
```

The envelope sits at `.result.output` on the returned status object (`.result.output.status`,
`.result.output.summary`, `.result.output.counts`, `.result.output.findings`,
`.result.output.reportMarkdown` as a bounded returned preview/fallback,
`.result.output.artifactPaths.reportMarkdownPath` as the preferred full markdown source,
`.result.output.truncatedFindings`, plus the meta-only
`leafOutcomes`, `domainExtras`, and `partialCoverage` under `.result.output`). `detail: "result"` is the redacted, persisted display surface;
`detail: "full"` is for diagnostics only.

**Raw run files under `.opencode/workflows/runs/` are local sensitive artifacts.**
`result.json`, the append-only journal, ledgers, request files, and run state can
contain local evidence. Kernel durable/display boundaries apply key-based and
free-text secret masking as defense-in-depth, but raw run directories remain local
evidence. **Prefer `workflow_status detail:"result"` over reading raw run files**,
and do not publish raw run directories casually.

## Report persistence is command-side only

The QuickJS guest cannot write files, so every leaf/meta envelope carries
`reportPath: null`. **Guests return data; they never write.** Only the **command
wrapper** persists a report:

- `/repo-bughunt` writes `.repo-review/runs/<run-id>-bughunt-report.md`
- `/repo-review` writes `.repo-review/runs/<run-id>-repo-review-report.md`

`.repo-review/` is gitignored; it is local-only command-side output. The report body is
rendered from the read-back envelope — preferably by reading the exact
`artifactPaths.reportMarkdownPath` returned by `workflow_status`, then falling back to the
bounded returned `reportMarkdown` preview, then to a synthesized fallback summary from the fields
that fit when `reportMarkdown` was dropped to fit the 256 KiB host result cap.
**The report artifact is the ONLY allowed workspace
write from a repo-review command.** If you run a leaf/meta directly via `workflow_run`
instead of the command, no report file is written at all — you read the result from
`workflow_status`.

## Restart OpenCode after plugin/command changes

OpenCode loads plugin code and config (commands, skills, registration) at **startup**.
After changing plugin commands, the config-time registration code, or any bundled
workflow source, **restart OpenCode** (or use a fresh/restarted child) for the change
to take effect — a running session keeps its already-loaded config, so a hot change in
the checkout is not proof it loaded. The commands `/repo-bughunt` and `/repo-review`
and all eight leaves are registered at startup; a new leaf or command will not appear
in `workflow_list` / the command registry until restart.

## Deferred boundary: nothing mutates automatically

Repo-review is read-only analysis. The following are **separate, explicit follow-ups**
and are **never run automatically** by any `repo-*` leaf, the `repo-review` meta, or
the `/repo-bughunt` / `/repo-review` commands:

- `review-materialize` (turning findings into applied fixes),
- `beads-drain`,
- `workflow_apply` (the hash-gated primary-tree write boundary),
- any `git` write (commit, push, branch, add),
- any `bd` create/update/close/claim or other Beads mutation.

The only allowed workspace write from a repo-review command is the local
`.repo-review/runs/` report artifact, and that file is gitignored and never staged or
committed. Materialization and Beads mutation remain explicitly out of scope; they
require their own approval and authority.

## Beads materialization contract

`/review-materialize` is contributed by the explicitly configured Beads extension; it is
not bundled with the published core package. When that command is present and separately
approved with a repo-review `runId`, it validates the persisted repo-review envelope,
consumes `artifactPaths.findingsJson` internally as the full findings source, and creates
a duplicate-aware Beads graph:

- one epic for the review program,
- one child task per new finding,
- one final verification gate,
- a crosswalk under `.repo-review/crosswalk/<programLabel>.json`.

The materializer uses native Beads `description`, `design`, and `acceptance` fields. Child
tasks are labeled for review/implementation/domain/size and `needs-tests`, but are **not**
marked `ready-for-agent` at creation time. A scoped `/beads-review post-materialization ...`
pass must review/remediate the graph before `ready-for-agent` promotion or `beads-drain`.

The final gate is parented to the epic and depends on the active materialized children (plus safe
exact existing duplicates). It should close only after the children are closed/deferred with
rationale, skipped/existing/ambiguous findings are reconciled, graph checks pass, and the scoped
post-materialization review has no unresolved high/medium defects.

## Structured-text fallback is the production path

Leaves declare schema lanes via `agent(prompt, { schema, tier, onFailure:
"returnNull" })`. Two structured-output paths are supported by the kernel
(`workflow-kernel/child-agent-runner.js`, contract §9):

1. **Native structured output** — when `run.capabilities.structuredOutput === "available"`:
   the kernel sets `outputFormat: { type: "json_schema", schema }`.
2. **Structured-text fallback** — otherwise: the kernel injects a JSON-schema
   instruction into the system prompt, sets `outputFormat: { type: "text" }`, and parses
   the model's JSON text back.

**Production reality:** native structured output is currently **unavailable** in this
runtime (the live-gate probe reports `structuredOutput: failed-with-evidence`), so the
**structured-text fallback is the production path**. The guest source is identical for
both paths; the operator-visible difference is that malformed JSON from the model gets
one same-session corrective turn by default before an exhausted validation failure is
converted by `onFailure: "returnNull"` into a dropped (not crashing) result. Leaves
author schemas that are text-JSON-parse-friendly (plain object/array/string/integer/
boolean + enums; no regex/`oneOf`-heavy constructs).

## Verification

The suite is covered by no-token regression tests (run from this directory):

```sh
npm run test:repo-review-contract    # leaf contract (envelope/finding/fingerprint)
npm run test:repo-review-meta        # meta orchestration + nested integration
npm run test:repo-review-meta-args   # meta-to-leaf arg contract (recon-once)
npm run test:repo-review-no-mutation # no auto-mutation boundary
npm run test:repo-review-secret-containment
npm run test:repo-review-merge-determinism
npm run test:workflows               # full nested workflow matrix (all repo-* suites)
```

`workflow_list` shows `repo-review`, `repo-bughunt`, `repo-security-audit`,
`repo-test-gaps`, `repo-cleanup`, `repo-modernize`, `repo-perf`, `repo-complexity`, and
`repo-deps` as bundled workflows.
