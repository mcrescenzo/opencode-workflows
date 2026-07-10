---
name: opencode-workflow-authoring
description: Use when creating, editing, reviewing, debugging, or explaining OpenCode workflows run by the workflow_* plugin tools. Covers QuickJS sandbox limits, top-level return shape, agent/parallel/pipeline fan-out, the scoped-callback arity contract, phase-loop orchestration, model tiers and per-lane effort, budget self-scaling, sourceHash/approvalHash and autoApprove launch modes, inline result readback, edit/apply boundaries, static nested workflows, roles, schema lanes, and background runs.
---

# OpenCode Workflow Authoring

Use this skill for workflow source and behavior: writing a new workflow, editing
or reviewing an existing one, debugging a stalled or misleading run, or
explaining how approval, sandboxing, fan-out, edit/apply, background, or resume
works. For simple "run / status / cancel / save this workflow" operations, use
the relevant command or `workflow_*` tool directly.

## Phase Loop

The primary pattern is **author -> run -> read -> decide**:

1. Author a small workflow source or choose a saved workflow.
2. Run a narrow slice first. Prefer `profile: "read-only-review"` unless the
   question truly needs shell, network, MCP, or edit authority.
3. Read the result with `workflow_status({ runId, detail: "result" })`, or use
   the inline foreground result returned by `workflow_run` when it fits the safe
   display cap.
4. Decide whether to widen scope, add lanes, raise budget, switch authority, or
   stop. Do not build one giant workflow before proving the slice.

If the plugin owner configured `options.autoApprove`, eligible runs can launch on
the first `workflow_run` call when their resolved authority tier is within that
ceiling. Otherwise, use the preview plus `approvalHash` flow. `workflow_apply`
keeps its separate hash gate either way.

## Source Shape

A workflow body is top-level JavaScript statements ending in `return <result>`.
The only allowed export is `export const meta = { ... }`. Do not wrap the body
in a function and do not use `export default`.

```js
export const meta = {
  name: "review-slice",
  description: "One narrow read-only review slice",
  profile: "read-only-review",
  maxAgents: 2,
  concurrency: 2,
};

const notes = await parallel([
  async ({ agent }) => await agent("Inspect the entrypoints", { role: "explorer" }),
  async ({ agent }) => await agent("Inspect the tests", { role: "explorer" }),
]);

return { notes };
```

Injected globals are `agent`, `parallel`, `pipeline`, `workflow`, `drain`,
`phase`, `log`, `budget`, `persistArtifacts`, `inventoryFiles`, and `args`;
do not import them.

## Meta Fields

Beyond `name`/`description`, the kernel reads these `meta` fields:

- `profile` or `authority` — named authority preset or ad-hoc flags (see
  Authority Profiles below).
- `argsSchema` — a JSON Schema validated (Ajv) against runtime `args` before
  authority resolution; a mismatch rejects the call before any lane launches.
  Declare it whenever the workflow reads `args`.
- `maxAgents`, `concurrency`, `maxCost`, `maxTokens`, `maxRuntimeMs`,
  `guestDeadlineMs` — author-set default ceilings; `workflow_run` args
  override them per call.
- `childModel` / `defaultChildModel` — workflow-level model default: below
  `args.childModel`, above the invoking session's model.
- `harness: "drain"` — opts into the drain harness and its `drain-dry-run` /
  `drain-autonomous-local` profiles.
- `phases` — declared phase names surfaced in previews and `workflow_status`.
- `category`, `examples`, `notes`, `whenToUse` — cosmetic; surfaced by
  `workflow_list`. `whenToUse` is a one-line "reach for this when…" discovery
  hint for agents browsing the registry.

## Authority Profiles

`meta.profile` / `workflow_run({ profile })` accepts: `read-only-review`
(readOnly), `inspect-with-shell` (readOnly + audited shell), `drain-dry-run`
(readOnly; drain harness), `drain-autonomous-local` (integration, no
network/mcp; drain harness), `edit-plan-only` (worktreeEdit — isolated
worktree, stops at the diff plan), and `apply-approved-plan` (edit). Omitting
`profile` resolves to `ad-hoc`, which takes flags (`readOnly`, `shell`,
`edit`, `worktreeEdit`, `network`, `mcp`, `integration`) directly from
`meta.authority` / `args.authority`. Prefer `read-only-review` until the task
truly needs more.

## QuickJS Sandbox

The body runs in a deterministic QuickJS sandbox, not Node. Filesystem, process,
network, clocks, timers, randomness, `crypto`, and imports are unavailable.
`Date`, `Date.now`, and `Math.random` are stubbed to throw on any call;
`performance`, `crypto`, `setTimeout`, `setInterval`, `clearTimeout`, and
`clearInterval` are `undefined`, so any use fails immediately. Use
`workflow_status` run artifacts for timing and diagnostics instead of in-guest
clocks.

## Fan-Out And Arity

Use the scoped-helper callback form for `parallel()` and `pipeline()`:

```js
await parallel([
  async ({ agent }) => await agent("first task"),
  async ({ agent }) => await agent("second task"),
]);

await pipeline(items,
  async (previous, { agent, item, itemIndex, stageIndex }) => await agent(`inspect ${item}`),
  async (finding, { agent, item }) => await agent(`review ${item}: ${finding}`),
);
```

Callback functions must declare the expected parameters. The kernel hard-errors
ambiguous arity instead of guessing whether a zero-arg thunk should be scoped or
legacy sequential behavior. Keep call order deterministic so lane signatures and
resume replay stay stable.

Guard every wave's outcome. A wave that silently drops most lanes can feed empty
data into synthesis and produce a false "nothing found" result. Use `failFast`
or explicit result-count checks when missing lanes invalidate the next phase.

## Models, Effort, And Roles

Set `modelTiers: { fast, deep }` on `workflow_run` and tag lanes with
`tier: "fast"` or `tier: "deep"` when a workflow needs different model strength.
Run `workflow_models` first and keep tiers inside the session family unless the
user approves a deviation.

OpenAI lanes may additionally request `effort: "minimal" | "low" | "medium" |
"high"`. This is applied through OpenAI `chat.params` provider options and fails
before child launch for unsupported providers.

Pass `role: "explorer" | "skeptic" | "verifier" | "synthesizer" |
"implementer"` to prepend a specialist prompt. Role `.md` files stay pure prompt
text; optional sibling `roles.json` defaults can set model/tier, tools/readOnly,
retry/timeout, and narrow policy knobs before explicit lane opts override them.
Use `workflow_roles` to inspect available role files, hashes, and defaults.

## Budgets And Scaling

`maxAgents` caps total child lanes launched. `concurrency` caps in-flight lanes.
Each `agent()` call consumes one slot; pure-JavaScript synthesis consumes none.

Use `budget.remainingAgents()`, `budget.remaining()`, and `budget.ceilings()` to
self-scale loops. Budget headroom includes live spend, replayed spend, and
in-flight reservations, so a loop can stop before launching the next child.
Setting `maxCost` or `maxTokens` is an approval-envelope decision, not a casual
throttle.

## Artifacts, Inventory, And Drain

A workflow's return value is size-capped. Spill large findings with
`persistArtifacts({ namespace, files: [{ name, content }] })` — `.json`,
`.jsonl`, or `.md` file names only, 16 MiB per file — and return a summary
that references them; artifacts land under the run's private
`artifacts/<namespace>/` directory. Use `inventoryFiles(...)` for a deterministic, sorted file
inventory with bounded shards instead of spending an agent lane on "explore
the repo with tools." `drain(...)` is the host-owned primitive behind
autonomous drain harnesses (`meta.harness: "drain"` with the drain
profiles); the drain loop's lane execution is host-controlled and cannot be
redefined from workflow source.

## Schema Lanes

Use `schema` when a lane result must be structured. Schema output is text-only:
the kernel appends a JSON-schema instruction to the system prompt, parses the
reply text as JSON, and validates it with Ajv. Correctable parse or validation
failures can retry in the same child session according to `correctiveRetries`,
and exhausted validation failures are journaled distinctly from transient
provider errors.

## Nested Workflows

Use direct static literals only: `workflow("saved-name", args)` or
`workflow({ source: "return 1;", args })`. Dynamic or aliased nested workflow
calls are rejected before approval because the source cannot be snapshotted into
the hash. Only one nesting level is supported, and nested lanes share the parent
run's `maxAgents`, concurrency, and budget ceilings.

## Launch And Readback

Default launch is two-phase: call `workflow_run` for a preview, then call again
with `approve: true` and the matching `approvalHash`. With configured
`options.autoApprove`, eligible readOnly/worktree/all-tier runs can launch on
the first call; a per-call `autoApprove` argument may narrow that ceiling.

Approving an inline-source preview does not require re-sending the source:
present only `approve: true` + the `approvalHash` and the previewed bytes are
reused (approve-by-reference). Re-sending the source works too but must be
byte-identical — any drift re-keys `sourceHash`/`approvalHash`, and the
mismatch response's `changedFields` will name the drifted field. Either way,
the retry must still re-send the same `args` (and any other envelope-affecting
params, e.g. `childModel`/`modelTiers`/`maxAgents`) used at preview —
approve-by-reference only retains the source, so a changed envelope still
re-keys and mismatches. For bodies you run more than once, `workflow_save` +
run-by-`name` avoids the issue entirely.

Foreground runs return a size-capped, secrets-redacted inline result when it
fits. Always prefer `workflow_status({ runId, detail: "result" })` for the final
answer path, especially for large results where inline output is omitted or
partial.

Resuming with `resumeRunId` re-validates the persisted run's `sourceHash`; a
changed body is rejected unless `editAndResume: true` is set, which re-keys
`sourceHash` and `approvalHash` (fresh approval required) while unchanged
lanes still replay as zero-spend cache hits.

## Background Runs

Explicit `background: true` returns quickly with a run id while execution
continues in the current OpenCode process. When `background` is omitted, the
kernel defaults wide, deep, or long runs to background using the
wide/deep/long heuristic; explicit `background: true` or `false` wins, and
resume keeps the pinned mode. Background execution is not durable across process
death; use `workflow_status`, `workflow_cancel`, `workflow_pause`, and
`workflow_reconcile` for inspection and lifecycle control.

`workflow_kill` force-terminates a wedged run when cancel/pause do not
return; `workflow_events` pages the redacted lifecycle event log; and
`workflow_salvage` recovers orphaned read-only lane results from an
interrupted run's child transcripts (preview first, then approve).

## Edit And Apply

Edit authority is only a cap. A lane receives edit tools only when it explicitly
requests edit/worktree behavior. Edit-capable lanes run in isolated workflow
worktrees or directories. Primary-tree writes happen through `workflow_apply`
after source/base/diff/domain hashes and Git state are checked. The one path
that can finalize in-run after its launch approval is a successful non-dry
drain workflow from a trusted source: a host-configured extension workflow
directory whose registered drain adapter declares `supportsAutoApply: true`.
The plugin ships one bundled workflow (`deep-research`), which is read-only and
stages no writes. Edit-producing project- and global-saved workflows stop at
`awaiting-diff-approval` and finalize through `workflow_apply`.

## Review Checklist

- Top-level body ends in `return`; only `export const meta` is exported.
- No Node, imports, clocks, timers, randomness, or filesystem assumptions.
- `parallel()` / `pipeline()` callbacks use explicit scoped-helper arity.
- Fan-out waves check dropped/null lane outcomes before synthesis.
- `maxAgents`, `concurrency`, timeouts, and budget ceilings match expected
  lane count and cost risk.
- Model tiers, per-lane `effort`, roles, and schemas are deliberate.
- Nested workflow calls are static and one level deep.
- Readbacks use inline result only when it fits; otherwise use
  `workflow_status({ detail: "result" })`.
- Edit lanes stop at `workflow_apply` unless using a trusted autonomous drain.
- After changing workflow source, commands, skills, plugin code, or registration
  behavior, restart OpenCode or use a fresh child process.
