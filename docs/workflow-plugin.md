# Workflow Plugin: Source-Of-Truth Hierarchy And Transcript Fallback

> Status: **active technical contract**. This is the deep reference for the
> shipped workflow tool surface and recovery/source-of-truth behavior.

This document is the reference for how the opencode-workflows plugin decides what
to trust about a workflow run, and for the transcript-fallback / salvage
architecture that recovers orphaned lane results after a crash. It mirrors
shipped behavior; the README's "Source Of Truth And Transcript Fallback" section
is the operator-facing summary, and this file is the deeper architecture note.

## Workflow Tool Reference

| Tool | Mutability | Approval / Hash Requirements | Safe Next Readback |
| --- | --- | --- | --- |
| `workflow_run` | Preview is read-only; approved execution creates run state and may launch lanes or approved domain mutations. | Default path: first call returns `approvalHash`; execution requires `approve: true` plus the matching `approvalHash`. With configured `options.autoApprove`, eligible `readOnly` / `worktree` / `all` tier runs can launch on the first call; `args.autoApprove` can only narrow the configured ceiling. Resume preserves the approved envelope unless changed. | `workflow_status({ runId, detail: "compact" })`, then `workflow_status({ runId, detail: "result" })` at terminal state. |
| `workflow_status` | Read-only. | None; `detail: "result"` requires a `runId`. | This is the authoritative readback surface. |
| `workflow_events` | Read-only. | None; requires a `runId`. | Use this for redacted `events.jsonl` access with `typePrefix`, `limit`, `offset`, and timestamp filters. |
| `workflow_reconcile` | Mutating recovery; persists stale-run recovery state and clears stale locks. | No approval hash; write-permission gated. | `workflow_status({ runId, detail: "full" })`. |
| `workflow_cancel` | Mutating lifecycle request; asks active or durable runs to cancel. | No approval hash; write-permission gated. | `workflow_status({ runId, detail: "full" })`. |
| `workflow_pause` | Mutating lifecycle request; asks active or durable runs to pause. | No approval hash; write-permission gated. | `workflow_status({ runId, detail: "full" })`; resume with `workflow_run({ resumeRunId })`. |
| `workflow_kill` | Mutating force-interrupt request for wedged runs. | No approval hash; write-permission gated. | `workflow_status({ runId, detail: "full" })`; resume only after interrupted/stale-lock state is settled. |
| `workflow_save` | Writes saved workflow source. | No approval hash; write-permission gated. | `workflow_list({ format: "json" })`. |
| `workflow_list` | Read-only. | None. | This is the machine-canonical workflow discovery surface. |
| `workflow_cleanup` | Dry-run is read-only; non-dry deletes safe terminal run directories. | No approval hash; write-permission gated for deletion. | Run with `dryRun: true` first; then `workflow_status({ limit, detail: "compact" })`. |
| `workflow_apply` | Mutates the primary tree and finalizes staged domain mutations. | Requires `approvalIntent: "apply"`, `approvedSourceHash`, `baseCommit`, `diffPlanHash`, and `domainMutationHash` from the reviewed run status. | `workflow_status({ runId, detail: "full" })` or `workflow_status({ runId, detail: "result" })` after apply. |
| `workflow_salvage` | Preview is read-only; approved salvage writes tagged synthetic journal entries for recovered read-only lanes. | Preview returns `approvalHash`; write requires `approve: true` plus matching `approvalHash`. | `workflow_status({ runId, detail: "full" })`. |
| `workflow_roles` | Read-only. | None. | This is the role prompt/hash/defaults readback surface. |
| `workflow_models` | Read-only. | None. | This is the model availability readback surface. |
| `workflow_templates` | Read-only; source retrieval is explicit. | None. | This is the shipped-template readback surface. |
| `workflow_template_save` | Writes saved workflow source from a shipped template. | No approval hash; write-permission gated. | `workflow_list({ format: "json" })`. |

## Role Prompts And Defaults

Workflow roles keep prompt text in user-editable `.md` files. A sibling
`roles.json` file may declare typed defaults per role, including `model`,
`tier`, `tools`, `readOnly`, `retryCount`, `correctiveRetries`, `timeoutMs`,
`mcpPolicy`, `secretGlobs`, and `effort`. The defaults are merged before
explicit per-lane `agent()` opts, so explicit opts win, and the existing lane
authority policy still rejects any tool or policy escalation beyond the approved
run authority. `workflow_roles({ format: "json" })` reports each role's prompt
hash provenance and typed defaults.

## How work moves between agents

The plugin passes work between subagents via **controller-owned, in-memory
return values** (`agent()`, `parallel()`, `pipeline()`), validated structured
outputs, and durable run artifacts. Subagents never hand off directly to each
other; the controller — the trusted kernel — is always the hub. Transcripts are
not the handoff substrate; they are a fallback for a narrow crash window only.

## Source-of-truth hierarchy

Stronger evidence always wins. Weaker evidence is recovery/diagnostic only and
may never finalize work (close Beads, apply diffs, merge integration lanes):

1. **Controller-owned run artifacts (authoritative).**
   The append-only `journal.jsonl`, the durable `result.json`, the domain and
   integration ledgers, and integration worktrees under
   `.opencode/workflows/runs/<runId>/`. These are captured directly by the
   controller and are the only evidence that may finalize domain mutations or
   primary-tree writes. `journal.jsonl` is the authoritative resume cache.
2. **`workflow_status` (persisted inspection).**
   The authoritative read-only inspection and recovery surface over those
   artifacts. `detail: "result"` returns final workflow output; `detail: "full"`
   is for diagnostics/apply internals. `workflow_status` never mutates state.
   Foreground `workflow_run` also includes the redacted workflow return value
   inline when it fits `MAX_INLINE_RESULT_BYTES`; larger inline payloads fall back
   to the persisted result readback command. `detail: "result"` uses
   full-fidelity, secrets-only redaction while the readback fits
   `MAX_RESULT_READBACK_BYTES`; above that it returns a partial projection plus
   `resultReadback.truncated` metadata instead of refusing the result file.
   `workflow_events` is the matching sanctioned event-level reader for
   redacted lifecycle evidence from `events.jsonl`; use it instead of raw file
   reads when you need cache, retry, fanout, debug-capture, or lifecycle events.
3. **Session transcripts (diagnostic / fallback only).**
   Child-session message history persisted in OpenCode's session store.
   Transcript evidence is strictly weaker than a controller-captured structured
   result. It is used only to surface and salvage orphaned lanes — never as the
   primary substrate, never to finalize work.

Summarized: `journal / result / ledgers / worktrees` > `workflow_status` >
`workflow_events` > `session transcripts (diagnostic only)`.

## Debug capture mode

Debug capture is off by default. Enable it for one run with
`workflow_run({ debugCapture: true })` or for the process with
`OPENCODE_WORKFLOWS_DEBUG_CAPTURE=1`.

When enabled, each completed child lane writes private artifacts under
`.opencode/workflows/runs/<runId>/debug/<lane>/`:

- `prompt.md`: rendered system prompt plus task prompt after free-text secret
  redaction.
- `schema.json`: the lane schema after durable secret redaction.
- `transcript.jsonl`: child-session messages fetched via the SDK
  `session.messages` path after durable secret redaction.

Each file is written with private file mode and a bounded size. Capture failures
are recorded as `debug_capture.*` events and do not fail the lane. This mode
increases local sensitive evidence and disk usage, so the default flag-off
behavior creates no `debug/` directory and makes no extra `session.messages`
calls.

`MAX_RESULT_BYTES` remains the guest return cap enforced before persistence.
It is intentionally coupled to the 32 MB QuickJS heap in
`workflow-kernel/sandbox-executor.js`; raising `MAX_RESULT_BYTES` or
`MAX_SOURCE_BYTES` should be reviewed with that heap limit, otherwise clean size
errors can become guest out-of-memory failures.

## The crash window

`runChildAgent` persists the running lane projection (`lanes/<callId>.json`,
including `childID` and `signatureHash`) before `session.prompt`, but the
authoritative journal entry is written by `recordLaneOutcome` only after the
prompt returns, structured-output validation, and integration steps. If the
owning OpenCode process dies in that window, a completed child lane's result is
absent from workflow state even though the child's transcript still contains it.

A Phase 0 spike verified that child-session transcripts (including assistant
final replies) persist to OpenCode's session store and are readable via the SDK
by a fresh process pointing at the same data dir after the creating process has
died. That makes transcript salvage technically viable, but the recovered
evidence is still weaker than a controller-captured result, so salvage is opt-in,
schema-checked, tagged, and never auto-applies.

## `workflow_salvage` (preview/approve, read-only scope)

`workflow_salvage` is the explicit, hash-gated recovery path for orphaned
read-only lanes. It is a mutating tool gated like `workflow_reconcile`
(`assertWriteWorkflowAllowed`) and is denied in plan mode.

Tool arguments:

| Arg | Meaning |
| --- | --- |
| `runId` (required) | The interrupted run to salvage from. |
| `callIds` (optional) | Narrow salvage to specific lane call ids. |
| `approve` (optional) | `true` to write; otherwise preview only. |
| `approvalHash` (optional) | Must match the preview's recomputed hash to write. |

### Preview mode

A call without `approve` (or with a non-matching `approvalHash`) returns
`mode: "preview"` and writes nothing. For each candidate lane it reports:

- `callId`, `childID`
- `parseVerdict` (`valid` / `invalid`) and `validationKind: "json-parse"` with
  `originalSchemaAvailable: false`
- `finalMessageFound`, `finalMessageLength`
- `resumeSignatureAvailable` (whether the running projection captured a
  `signatureHash` that the resume path can match)
- a length-truncated `redactedSnippet` of the final assistant message, with
  free-text secret masking (`redactFreeTextSecrets`) applied before truncation so a
  credential pasted into the assistant reply is masked out of the preview (the raw
  transcript under the run directory remains local-sensitive)
- `skipped` reason for non-salvageable lanes

It also returns an `approvalHash` computed over the per-candidate preview state,
so the operator approves exactly the transcript state they previewed.

### Approve mode

Re-running with `approve: true` and the matching `approvalHash` writes a
synthetic journal entry for each non-skipped read-only lane, via
`writeSalvagedLaneOutcome` (a journal append plus lane-projection update on a
durable interrupted run directory). It never touches in-memory counters,
`state.json`, worktrees, or integration ledgers.

Validation is conservative JSON-parse only. The original per-lane AJV schema is
not durably persisted (it lives only in the in-memory resolved lane context
derived from the workflow script at runtime), so it cannot be reconstructed for
an existing orphan. Outcome is `success` only when the final assistant message
parses as JSON; otherwise the entry is written with outcome `failure` and an
error summary, and carries no `result`.

## The `salvagedFromTranscript` tag

Every salvaged journal entry is tagged:

- `salvagedFromTranscript: true`
- `salvageValidation: { kind: "json-parse", originalSchemaAvailable: false }`

so a transcript-recovered result is never mistaken for a normally-captured,
schema-validated result. The tag is the provenance marker the resume path and the
integration gates read.

## Read-only scope and the no-auto-apply rule

- **Read-only/report lanes only.** Edit/integration lanes (those carrying a
  worktree path or integration-lane marker) are reported as
  `salvage-skipped: edit-lane-without-commit` and are never salvaged. A salvaged
  lane has no worktree commit by construction, and `integrate()` already requires
  `lane.committed`. Unreadable transcripts are reported `transcript-unreadable:*`
  and skipped.
- **Never finalizes domain mutations or primary writes.** Salvage never calls
  `integrate()` or `runAutoApply`, never closes Beads, and never applies a diff.
  It only appends a tagged synthetic journal entry and updates a lane projection.
- **No auto-apply / always explicit.** Salvage is never automatic on resume. It
  requires an explicit preview, then an explicit approve with a matching hash.

## Resume reuse and the code-enforced read-only-vs-edit asymmetry

On a later resume:

- A salvaged read-only result is reused as a cache hit (no re-run, no spend
  re-accumulation) and emits a distinct `cache.salvaged_hit` event — separate
  from `cache.hit` (normal journal replay) and `cache.checkpoint_hit` (lane
  checkpoint replay) — so the weaker provenance stays observable. This works
  because the running lane projection persists `signatureHash` and the salvaged
  entry copies it, so the existing signature-based cache-hit predicate
  (`classifyResumeCacheHit`) fires naturally. Legacy orphans interrupted before
  the signature was persisted report `resumeSignatureAvailable: false` and are
  re-run rather than trusted.
- If an edited workflow body inserts or reorders `agent()` calls, the new
  positional `callId` may no longer match the prior journal entry. When the
  lane's content signature still matches a prior successful journal entry in the
  same fan-out scope, resume claim-once reuses that entry and emits
  `cache.signature_hit` with `originalCallId`. Edit and integration plan entries
  copied from the prior state are retagged in place to the new `callId`, avoiding
  duplicate patch or lane entries.
- Integration lanes are filtered through `isLaneIntegrable`, which requires a
  real worktree commit and rejects any `salvagedFromTranscript` lane even if it
  somehow carried `committed: true`. The host-owned integrate closure adds
  defense-in-depth, rejecting salvaged lanes with reason
  `lane-salvaged-from-transcript`. So a salvaged claim can never reach
  `integrate()` or `runAutoApply` — the asymmetry is enforced in code, not just
  documented.

## Raw SDK transcript reads

The controller reads child transcripts via the **raw SDK `session.messages`
API** (`sessionApi(pluginContext).messages({ sessionID })`), unredacted. It does
**not** route through the redacting `session_read` wrapper from the separate,
independently published [`@mcrescenzo/opencode-sessions`](https://github.com/mcrescenzo/opencode-sessions)
plugin (not a dependency of this package — named here only as a point of
comparison). This is intentional and consistent with the journal already storing
unredacted lane results; salvage recovers that same class of content. The preview
`redactedSnippet` is free-text secret-masked (`redactFreeTextSecrets`, detecting
Bearer/provider-token/AWS-key and common `key=value` secret assignments) and then
length-truncated for operator diagnosis. The masking governs only what is rendered
back to the operator at this display boundary; the raw transcript under the run
directory and the approval/source hashes (computed from `finalMessageHash`, never
from the masked snippet) remain local-sensitive and unaffected.

## Narrowing the crash window: lane checkpoints

Workflow-native lane checkpointing narrows the crash window so transcript salvage
is rarely needed. The controller writes:

- `lanes/<callId>.request.json` before `session.prompt` (prompt-time intent), and
- `lanes/<callId>.result.json` immediately after the prompt returns.

On resume, a same-signature `result.json` checkpoint is consulted **before** the
authoritative journal check and reused without re-running the lane, emitting a
distinct `cache.checkpoint_hit` event. Checkpoint files are a narrower, earlier,
transcript-independent own-store capture; `journal.jsonl` remains the source of
truth and supersedes them (a superseded checkpoint is removed). Unlike transcript
salvage, checkpoint recovery is not approval-gated, because it is a
controller-owned own-store capture rather than weaker transcript evidence. A
failed checkpoint write degrades to re-running or to ordinary journal replay on
the next resume.

## Background execution is not durable across process death

Transcript fallback recovers a completed child's result; it does **not** make
background execution durable.

A background run (`workflow_run({ background: true })`) executes inside the
owning OpenCode process and dies with it. When `background` is omitted, the
kernel defaults wide/deep/long runs to background when requested fan-out or
declared/requested duration trips the heuristic (per-call `maxAgents >= 8`, at
least three serialized concurrency waves from per-call `maxAgents` and
`concurrency`, or `maxRuntimeMs >= 600000`). Declared/default `maxAgents`
ceilings are not treated as predictions of actual fan-out. Explicit
`background: true` / `background: false` always wins, and resume keeps the
original pinned mode. If the host lacks `session.promptAsync`, background launch
still works but `workflow_run` warns that no completion prompt can be delivered;
use `workflow_status` polling for completion and final result readback.

There is no detached supervisor, no respawn, and no attach. After process death
the run directory is left behind and surfaces as stale until `workflow_reconcile`
marks it interrupted. Only then can `workflow_salvage` recover orphaned
read-only lane results that completed in the crash window. Completing the
underlying workflow work after process death remains out of scope until a
supervisor exists (tracked separately in `docs/claude-parity-roadmap.md`).

Notification recovery (re-enqueuing an already-persisted completion notice on
`session.idle`) is likewise only in-process recovery, not durable execution; see
the README's "Notification recovery is not durable execution" section.

## Sizing `maxAgents`: child-agent accounting

`maxAgents` is a hard cap on the number of **child agent lanes a run launches**,
not on phases, on `parallel()` calls, or on JavaScript work in the workflow body.
The kernel tracks one counter, `agentsStarted`, and every `agent()` launch
increments it; a launch is refused with `WorkflowBudgetStoppedError` once
`agentsStarted >= maxAgents` (`workflow-kernel/child-agent-runner.js`:
`run.agentsStarted >= run.maxAgents`). The remaining slots are visible to the
workflow body as `await budget.remainingAgents()`
(`maxAgents - agentsStarted`, floored at 0).

**What counts as one agent:**

- Each `agent()` call counts **once**. A `parallel()` of five lanes is five
  `agent()` launches and consumes five slots; a `pipeline()` of three stages is
  three launches and consumes three slots.
- A lane that **replaces a prior lane on resume** (a cache-hit replay) does
  **not** re-increment `agentsStarted` — only genuinely new launches consume
  budget — so a resumed run does not double-count work it already paid for.

**What does NOT count:**

- **Pure-JavaScript aggregation / synthesis inside the workflow body.** Reducing,
  merging, ranking, deduping, or formatting the structured return values of
  lanes in plain JS (no `agent()` call) consumes **zero** agent slots. The
  controller already owns those return values in memory; combining them is host
  code, not a child lane.
- Phases, `log()`, `phase()`, and `budget` reads. These are control-flow and
  bookkeeping, not child launches.

`budget.ceilings()` returns the approved `{ maxCost, maxTokens }` object, with
unset ceilings omitted. `budget.remaining()` returns
`{ cost: number|null, tokens: number|null }`; `null` means that ceiling is unset,
and numeric values include live spend, replayed spend, and in-flight
reservations. Use it with `budget.remainingAgents()` for loop-until-budget
workflows that should stop before launching another lane.

### Synthesis: pure-JS versus agent-based

Whether a synthesis/aggregation step consumes a slot depends entirely on **how it
is implemented**, not on what it is called:

- **Pure-JS synthesis** (combine lane outputs in the workflow body): does not
  call `agent()`, so it needs **no extra slot**.
- **Agent-based synthesis** (hand the lane outputs to one more `agent()` lane —
  e.g. an LLM that writes a narrative report): that lane is a child launch and
  needs **one more slot**.

### Worked examples

| Topology | Agent lanes | `maxAgents` needed |
| --- | --- | --- |
| Five research lanes, results merged in JS | 5 | `>= 5` |
| Five research lanes + one agent-based synthesis lane | 6 | `>= 6` |
| Three pipeline stages, JS post-processing | 3 | `>= 3` |

Size `maxAgents` to **(number of `agent()` lanes you will launch) + (1 per
agent-based synthesis/aggregation lane)**. Pure-JS synthesis adds nothing.

### Nested workflows share the parent budget

A `workflow()` call (nested workflow) does **not** get its own agent budget. The
nested body executes against the **same `RunContext`** as the parent
(`workflow-kernel/sandbox-executor.js`: `runNestedWorkflow` → `executeSandbox`
with the parent `run`), so every `agent()` launched inside the nested workflow
increments the **parent run's** `agentsStarted` and draws down the same
`maxAgents` ceiling. The nested workflow's own declared `meta.maxAgents` is
**ignored at runtime** — only the parent run's `maxAgents` (fixed at approval)
governs the combined launch count. Only one level of nesting is permitted, so the
budget you approve at the top is the budget for the whole tree: size it to cover
the parent lanes **plus** every lane any nested workflow will launch.

Nested workflow references must be statically visible at approval time. Use
`workflow("saved-name", args)` for saved workflows, or the explicit inline form
`workflow({ source: "return 1;", args })` for inline sources. The legacy string
source shorthand remains compatible for source strings containing a newline or
`export const meta`, but tiny inline sources should use the object form so they
are not mistaken for workflow names. Dynamic nested workflow names or sources are
rejected before approval because they cannot be snapshotted safely.

## Per-lane model effort

Workflow lanes may request an OpenAI reasoning-effort hint with
`agent(prompt, { effort: "minimal" | "low" | "medium" | "high" })`. The kernel
validates the option before child-session creation, includes the resolved effort
policy in the lane signature, registers the live child session in a bounded
childID map, and applies the setting through the plugin `chat.params` hook as:

```js
output.options.providerOptions.openai.reasoningEffort = "<effort>";
```

The hook merge preserves any existing `output.options` and provider option bags.
The childID mapping is cleared on retry teardown and final lane cleanup, so it is
bounded to active child sessions.

This is deliberately provider-specific. Today `effort` is supported only when
the resolved lane model provider is `openai`; requesting it for another provider
fails before launching the child instead of silently ignoring the option. Extend
the provider table only after verifying the provider's concrete `chat.params`
option key.

The native variant-selector path was inspected but is not a shipped contract for
this plugin. The pinned v1 `session.prompt` type used by the wrapper does not
expose `variant`, while the v2 generated type does; without a behavioral probe
proving `session.prompt` accepts a variant selector in this lane path, effort is
implemented only through the proven `chat.params` provider-options mechanism.
