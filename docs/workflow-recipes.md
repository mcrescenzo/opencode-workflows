# Workflow Recipes

> Status: **active operator reference**. Recipes mirror shipped workflow behavior;
> `workflow_list({ format: "json" })` remains the machine-readable discovery surface.

Reusable, copy-adaptable shapes for common workflows. Each recipe is a starting
point, not a turnkey artifact: read the authority and sizing notes, then adjust
the lanes to your actual surface area. These recipes mirror shipped behavior
(`workflow_run`, `workflow_status`, the authority profiles in
`workflow-kernel/authority-policy.js`, and the model-tier resolution in
`workflow-kernel/workflow-plugin.js`); the README sections "Authority Profiles And
Apply Boundary", "Sizing `maxAgents`", and `docs/workflow-plugin.md` are the
deeper references.

## Recipe: first-run read-only slice

**Start here on any new workflow.** Before you build a wide fanout or a nested
workflow, validate one small read-only slice end to end: confirm the preview ->
approve handshake, confirm a lane returns the structured shape you expect, and
confirm you can read the result back. This recipe ships as a saved template named
`first-run-slice` (in `DEFAULT_TEMPLATES`, `workflow-kernel/role-template-loading.js`),
so you do not have to write it by hand.

It is the smallest safe shape by construction: `profile: "read-only-review"`, one
or two scoped parallel lanes, **pure-JavaScript synthesis** (no synthesis agent),
`maxAgents: 2` / `concurrency: 2`, and **no filesystem or Beads writes**. The
QuickJS guest has no filesystem, and read-only-review denies edit/shell/network/MCP,
so nothing a lane produces can land on the tree.

### Get the template

List it, then either save it as a named workflow or run its source inline:

```jsonc
workflow_templates({ format: "json" })   // includes { name: "first-run-slice", ... }

// Fetch the shipped body intentionally, without writing a saved workflow.
workflow_templates({ format: "json", template: "first-run-slice", includeSource: true })

// Option A: save a project-scoped copy you can edit, then run by name.
workflow_template_save({ template: "first-run-slice", scope: "project" })

// Option B: paste the template body as `source` into workflow_run (no save needed).
// For large bodies prefer Option A: run-by-name never re-transmits source bytes,
// and inline approve calls otherwise must be byte-identical (or approve-by-reference).
```

The shipped body (abbreviated — the lanes and synthesis are the parts you adapt):

```js
export const meta = {
  name: "first-run-slice",
  description:
    "Minimal read-only first-run slice: 1-2 scoped parallel lanes, pure-JS synthesis, no writes.",
  profile: "read-only-review",
  maxAgents: 2,
  concurrency: 2,
};

const question = (args && args.question) || "Summarize what this slice does";
const slices = ((args && args.slices) || ["primary"]).slice(0, 2); // hard cap at 2

// Per-lane contract: every claim must carry concrete evidence (file:line / exact text).
const findingSchema = {
  type: "object",
  required: ["slice", "claim", "evidence"],
  properties: { slice: { type: "string" }, claim: { type: "string" }, evidence: { type: "string" } },
};

// Fan-out callbacks must declare the injected scope/context parameter. Zero-arg
// callbacks fail fast unless you explicitly pass { sequential: true }.
const laneResults = await parallel(slices.map((slice) => async ({ agent }) =>
  agent("Read-only slice for: " + question + " ...", { role: "explorer", schema: findingSchema })));

// Pure-JS synthesis: no agent() call, zero extra slots. Drop evidence-free claims.
const grounded = [], dropped = [];
for (const r of laneResults) {
  if (r && typeof r.evidence === "string" && r.evidence.trim()) grounded.push(r);
  else if (r) dropped.push({ slice: r.slice, claim: r.claim, reason: "no evidence" });
}
return { question, slices, groundedFindings: grounded, droppedUnsupportedClaims: dropped,
  note: "First-run read-only slice. No edits, no Beads mutation, no files written." };
```

### Preview, then approve

`workflow_run` is two-phase by default. The first call (no `approve`) returns
the approval summary; it launches no lanes and runs no probes:

```jsonc
// 1) Preview: inspect the authority line, maxAgents/concurrency, and approvalHash.
workflow_run({
  source: "<first-run-slice body>",            // or name: "first-run-slice" if saved
  args: { question: "How does X work?", slices: ["entrypoint", "error path"] },
  format: "json",                             // structured preview with byte/line counts
  includeSourceSnippet: true,                  // optional bounded snippet; omitted by default
  sourceSnippetMaxChars: 600,
})
```

Inline previews always include source hash, byte count, and line count. They do
not include the source body by default because prompts can contain sensitive
context; request `includeSourceSnippet` only when you need bounded authoring
diagnostics.

Confirm the authority line says `profile=read-only-review` with
`readOnly=true` and `network=false`/`mcp=false`, and that `maxAgents`/`concurrency`
read `2`/`2`. Then approve the **exact** envelope — same `source`/`name` and the
same `args` — by echoing the `approvalHash`:

```jsonc
// 2) Approve: identical args + approve:true + the approvalHash from step 1.
workflow_run({
  source: "<first-run-slice body>",
  args: { question: "How does X work?", slices: ["entrypoint", "error path"] },
  approve: true,
  approvalHash: "<approvalHash from the preview>",
})
```

For inline `source`, "exact" means byte-identical — re-typing the body drifts
the hash. Prefer approving with only `approve: true` + the `approvalHash`
(the previewed source is retained in-memory), or save once and run by `name`.

The hash covers the source, args, authority, models, and budgets, so any edit
between preview and approve invalidates it and forces a fresh preview. A read-only
run completes directly and never enters `awaiting diff approval`; there is no
`workflow_apply` step because no writes are staged.

If the plugin owner configured `options.autoApprove`, eligible runs can launch on
the first call when the resolved authority tier is within the configured ceiling:
`readOnly` for read-only and audited-shell inspection profiles, `worktree` for
edit/worktree-edit planning, and `all` for integration, network, or MCP
authority. A call-level `autoApprove` argument may narrow that ceiling for one
run, but cannot widen it. `workflow_apply` still requires its separate reviewed
hash fields before primary-tree writes.

### Size `maxAgents`

`maxAgents` is a hard cap on lanes launched — **one slot per `agent()` call**.
This recipe launches one lane per slice (capped at two) and its synthesis is pure
JS (zero slots), so `maxAgents: 2` exactly fits the two-slice default. Keep it
small on a first run: the point is to validate the shape cheaply, not to fan out.
When you later widen the fanout, raise `maxAgents` to **(number of `agent()`
lanes)** and add one more slot only if you replace the JS synthesis with a report
*agent*. Nested `workflow()` lanes share the parent's `maxAgents` (a nested
workflow's own `meta.maxAgents` is ignored at runtime), so size the top-level cap
to cover every lane any nested workflow will launch. See README "Sizing
`maxAgents`".

### Read the result back

After the run completes, read the final structured return value:

```jsonc
workflow_status({ runId: "<runId>", detail: "result" })
```

`detail: "result"` returns the workflow's `return` value — here `groundedFindings`,
`droppedUnsupportedClaims`, and the `note` — with credential-like keys redacted for
display. Foreground `workflow_run` includes the same redacted return value inline
when it fits the inline cap; larger returns should be consumed through this
status readback, which returns partial data plus `resultReadback.truncated` when
the full readback is too large. `workflow_status` never mutates state. Treat
`groundedFindings` as the
answer and `droppedUnsupportedClaims` as an honesty ledger: if a slice landed
there, the lane did not actually prove its claim, so the fix is another scoped
lane (or stronger evidence), not a louder assertion. Use `detail: "compact"` to
poll progress and `detail: "full"` only for diagnostics.

### Failure handling

A first-run slice is the cheapest place to discover problems. The common ones and
what to do:

- **Preview rejected at parse/authority time.** If `workflow_run` errors during
  preview (malformed source, an `import`, an `export default`, or a request for
  `edit`/`shell`/`network` the profile forbids), nothing launched and no slot was
  spent. Fix the source or pick the right profile and preview again — read-only
  runs cannot request `allowEdits` (it throws), so keep the slice read-only.
- **Stale `approvalHash`.** If approve fails with a hash mismatch, your `source`
  or `args` changed after the preview — the mismatch response's `changedFields`
  names exactly which envelope field re-keyed. For inline `source` the usual
  cause is re-transmission drift (a single re-typed byte re-keys the hash): do
  not re-send the source on the retry — approve with only `approve: true` and
  the `freshApprovalHash` (approve-by-reference), or `workflow_save` the body
  once and run it by `name`, which re-reads byte-stable bytes from disk. Either
  way, the retry must still re-send the same `args` (and any other
  envelope-affecting params, e.g. `childModel`/`modelTiers`/`maxAgents`) used at
  preview — approve-by-reference only retains the source, so a changed `args`
  bag still re-keys the envelope and mismatches. Never hand-edit a hash.
- **A lane fails or returns the wrong shape.** A lane that throws or returns
  output that fails its `schema` surfaces in `workflow_status detail: "full"` with
  the lane error; the run records it rather than silently dropping it. Because the
  cap is two lanes, a failed first run is cheap to diagnose and re-run. A
  failed/interrupted run is resumable: completed lanes replay from cache at zero
  re-spend, so fix the offending lane and re-run without repaying for the lanes
  that already succeeded.
- **A lane returns a claim with no evidence.** That is not a crash — the pure-JS
  synthesis moves it into `droppedUnsupportedClaims`. Surfacing it (instead of
  promoting it) is the point; tighten the lane prompt or add evidence, do not
  loosen the schema.

Once this slice runs clean — preview matches, lanes return evidence, and
`detail: "result"` reads back what you expect — widen it: add slices (raise
`maxAgents`), introduce model tiers, or graduate to the deep-research recipe
below.

## Recipe: generic read-only deep research

Use this when you want a multi-lane, evidence-grounded investigation — comparing
options, mapping how a subsystem works, or answering a "how does X actually
behave here" question — **without writing to the tree or to Beads**. The
controller fans out scoped read-only lanes, holds their structured results in
memory, and synthesizes the answer in plain JavaScript. No lane may finalize
anything; the output is a report, not a mutation.

### Choose the authority tier first (read this before sizing or models)

The single most important decision is *how much authority the lanes get*. Pick
the **least** powerful tier that the question actually requires. The three tiers
below are genuinely different trust boundaries, not cosmetic labels:

| Tier | Profile / authority | What lanes can do | What they cannot do |
| --- | --- | --- | --- |
| Read-only review (default) | `profile: "read-only-review"` (`{ readOnly: true }`) | Read files, glob, grep, list, LSP. Reason over in-repo evidence only. | No shell, no `webfetch`/`websearch`, no MCP. Cannot run commands or reach the network. |
| Inspect-with-shell | `profile: "inspect-with-shell"` (`{ readOnly: true, shell: true }`) | Everything above **plus** an audited, command-scoped read-only shell. The runtime permission ruleset allows only documented inspection commands (`git ls-files`, `git log --numstat`, `npm ls --depth=0`, `cargo tree`, `pip list`, `go list`) and denies shell chaining, redirection, filesystem mutation, network fetch, and package install/publish at the rule level. | Network and MCP still denied. Shell is scoped to the audited allowlist; an explicit `authority.shell = { allow, deny }` override is still respected. |
| Network-authorized research | `profile: "read-only-review"` with declared `authority: { readOnly: true, network: true }` (add `mcp: true` or a scoped `mcpPolicy` only for MCP doc lookups) | Everything in read-only review **plus** `webfetch`/`websearch` permission rules, and MCP permission rules when MCP authority is declared. Launch still follows the normal one-time approval handshake — there is no separate permission probe. | No shell, edit, or worktree mutation unless separately declared. Network/MCP authority is granted by profile policy and coarse-gated by the lane tools map; the permission ruleset and the server version floor (network/mcp-granting authority now refuses a sub-floor server, same as edit/shell) cover the rest. |

Notes that keep this safe:

- `read-only-review` requires **no elevated authority** — it is the cheapest,
  safest default and is what you should reach for unless you have a concrete
  reason not to. Child-capable runs still send a deny-by-default permission
  ruleset with every session, so read-only child lanes stay contained with no
  separate preflight step.
- `inspect-with-shell` enforces a command-scoped, audited read-only allowlist at
  the permission-rule level (not just an unrestricted `bash` allow) — the
  ruleset itself is the enforcement, not a separate gate check. Only use it
  when running a command *is the evidence* (you need the actual output, not a
  file's contents). An explicit `authority.shell = { allow, deny }` override
  still wins over the audited list for a deliberate per-run scope.
- Network/MCP workflow authority is granted by profile policy (or ad-hoc
  `authority: { network: true }` / `mcp: true`), enforced by generated
  permission rules, and coarse-gated by the lane tools map; launch follows the
  normal one-time approval handshake, not a separate permission probe. Nothing
  reports `networkAccess`/`mcpAccess` as a diagnostic — there is no separate
  probe for either. `mcpPolicy: { allow, deny }` can scope MCP server/tool
  patterns at the run or lane level without allowing lane escalation; the
  permission ruleset and the server version floor (network/mcp-granting
  authority refuses a sub-floor server, same as edit/shell) cover the rest.

### Safe `workflow_run` shape (source)

This source defaults to the safest tier and only adds an external-docs lane when
the caller opts in **and** the run is launched with network authority. Save it as
a named workflow or pass it inline as `source`.

```js
export const meta = {
  name: "deep-research",
  description:
    "Read-only deep research. Scoped parallel inventory lanes return claim+evidence; synthesis is pure JS. No edits, no Beads mutation.",
  profile: "read-only-review",
  // Sizing: one slot per agent() lane. See "Size maxAgents and concurrency" below.
  maxAgents: 6,
  concurrency: 4,
  // Model tiering: cheap/fast lanes for inventory, a deep model only where the
  // reasoning is genuinely hard. Both tiers always resolve (default to the
  // session/child model) so the envelope hash is deterministic.
  modelTiers: { fast: "anthropic/claude-haiku-4-5", deep: "anthropic/claude-sonnet-4-5" },
};

// Per-lane structured contract: every finding must carry its own evidence.
const findingSchema = {
  type: "object",
  required: ["area", "findings"],
  properties: {
    area: { type: "string" },
    findings: {
      type: "array",
      items: {
        type: "object",
        required: ["claim", "evidence", "confidence"],
        properties: {
          claim: { type: "string" },
          // evidence MUST be a concrete file path + line, a command + its output,
          // or a cited URL. A claim with no evidence is not a finding.
          evidence: { type: "string" },
          confidence: { type: "string", enum: ["high", "medium", "low"] },
        },
      },
    },
  },
};

const question = args?.question ?? "How does the subsystem work?";
const areas = args?.areas ?? ["entrypoints", "data model", "error handling", "tests"];
const allowExternalDocs = args?.allowExternalDocs === true; // only effective with network authority

// Scoped local-inventory lanes run on the fast tier and stay read-only. Keep the
// injected { agent } parameter; zero-arg fan-out callbacks fail fast unless the
// call explicitly passes { sequential: true }.
const localLanes = areas.map((area) => async ({ agent }) =>
  agent(
    `Research area "${area}" for the question: ${question}. ` +
      `Use only read tools (read/glob/grep/list). Return claim + concrete evidence ` +
      `(file:line or exact text) per finding. Say "unknown" rather than guessing.`,
    { role: "explorer", tier: "fast", schema: findingSchema, label: `local:${area}` },
  ),
);

// Optional external-docs lane: included ONLY when the caller opted in. It still
// no-ops unless the run was launched with network authority, in which case the
// lane's webfetch/websearch tools are permitted.
const externalLanes = allowExternalDocs
  ? [
      async ({ agent }) =>
        agent(
          `Find authoritative external documentation relevant to: ${question}. ` +
            `Cite each claim with a source URL. Distinguish vendor docs from forum/blog claims. ` +
            `Do not assert anything you cannot cite.`,
          { role: "explorer", tier: "deep", schema: findingSchema, label: "external:docs" },
        ),
    ]
  : [];

const laneResults = await parallel([...localLanes, ...externalLanes]);

// Synthesis is PURE JS — no agent() call, so it costs zero agent slots. The
// controller already holds every lane's validated result in memory. We only
// carry forward findings that came back with evidence; evidence-free claims are
// dropped, not promoted.
const grounded = [];
const dropped = [];
for (const result of laneResults) {
  for (const finding of result?.findings ?? []) {
    const hasEvidence = typeof finding.evidence === "string" && finding.evidence.trim().length > 0;
    if (hasEvidence) grounded.push({ area: result.area, ...finding });
    else dropped.push({ area: result.area, claim: finding.claim, reason: "no evidence" });
  }
}

return {
  question,
  authorityTier: allowExternalDocs ? "network-or-local (per launch authority)" : "read-only-local",
  groundedFindings: grounded,
  droppedUnsupportedClaims: dropped, // surfaced, not hidden: these were NOT used in conclusions
  note: "Read-only research. No edits, no Beads mutation. Conclusions are limited to grounded findings.",
};
```

What keeps this recipe honest:

- **Every conclusion is tied to evidence.** The per-lane `schema` forces
  `claim` + `evidence`, and the JS synthesis drops any finding whose evidence is
  empty into `droppedUnsupportedClaims` instead of letting it reach the report.
  Do not let a synthesis *agent* paper over gaps — pure-JS synthesis cannot
  invent evidence the lanes did not return.
- **Do not over-claim beyond verified evidence.** A read-only-review run only
  proves what is in the repo at the read commit; an inspect-with-shell run only
  proves what a command actually printed; a network run only proves what a cited
  source actually says. Phrase conclusions to match the tier — say "the repo at
  `<file:line>` does X", not "the system always does X", unless you verified it.
- **Read-only-review ≠ inspect-with-shell ≠ network research.** They are
  different authority boundaries (see the table above). Launching on a stronger
  tier than the question needs is an unnecessary escalation; pick the weakest one
  that works.

### Size `maxAgents` and concurrency

- `maxAgents` is a hard cap on agent **lanes launched**, one slot per `agent()`
  call. The recipe above launches `areas.length` local lanes (default 4) plus an
  optional external lane, and its synthesis is pure JS (zero slots). With the
  default four areas plus the optional docs lane that is five lanes, so
  `maxAgents: 6` leaves headroom; size it to **(local areas) + (1 if the docs
  lane is enabled)**. If you replace the JS synthesis with an `agent()` report
  writer, add one more slot.
- Nested `workflow()` lanes share the parent run's `maxAgents`; a nested
  workflow's own `meta.maxAgents` is ignored at runtime. Size the top-level cap
  to cover every lane any nested workflow will launch. See README "Sizing
  `maxAgents`" and `docs/workflow-plugin.md` for the full accounting.
- `concurrency` bounds how many lanes run at once (independent of the total
  `maxAgents` budget). For research, 3-4 is a good default: enough parallelism to
  finish quickly, low enough to keep token spend and provider rate-limit pressure
  manageable. Raise it only if lanes are cheap and independent.
- `DEFAULT_CONCURRENCY` stays at 4 because a 2026-06-22 runtime observed a
  12-lane `session.prompt` wave stall with 0-token timeouts. Explicit
  `meta.concurrency` / `workflow_run({ concurrency })` can go higher, up to the
  configured hard ceiling (default 64; set
  `OPENCODE_WORKFLOWS_HARD_CONCURRENCY_LIMIT` or plugin option
  `hardConcurrencyLimit`). There is no built-in concurrency-capacity probe;
  before relying on higher fan-out in production, raise it incrementally
  against a representative workload and watch for stalls/timeouts rather than
  trusting a single synthetic number.

### Loop until budget

Workflow scripts can inspect the approved budget envelope without duplicating
host-side accounting:

```js
while ((await budget.remainingAgents()) > 0) {
  const remaining = await budget.remaining();
  if (remaining.cost !== null && remaining.cost <= 0) break;
  if (remaining.tokens !== null && remaining.tokens < 500) break;
  await agent("Investigate the next slice", { tier: "fast", onFailure: "returnNull" });
}
```

`budget.ceilings()` returns `{ maxCost, maxTokens }` with omitted fields when a
ceiling was not configured. `budget.remaining()` returns
`{ cost: number|null, tokens: number|null }`; `null` means that ceiling is
unset. Remaining headroom includes live spend, replayed spend from resume, and
in-flight reservations for concurrent lanes, so a loop sees the same budget math
the host uses before launching the next child.

### Model tiering

Assign each lane a model deliberately instead of letting every lane inherit the
session model. Declare `modelTiers: { fast, deep }` (in `meta` or as a
`workflow_run` arg) and tag each lane with `tier: "fast"` or `tier: "deep"`:

- **fast** — cheap, high-throughput model for the inventory lanes (grep/read,
  summarize-what-you-found). Most research lanes belong here.
- **deep** — a stronger model reserved for lanes whose reasoning is genuinely
  hard (reconciling conflicting sources, the external-docs synthesis lane, or a
  final adversarial cross-check). Use it sparingly; it is the expensive tier.

Both tiers always resolve to a concrete model (each defaults to the run's child
model) so the approval hash is deterministic. A lane with no `tier` stays on the
default child model. Run `workflow_models` first to see the session model and the
available provider/model list before you pin tier strings, so you do not approve
an envelope that names an unavailable model.

OpenAI lanes may also request a per-lane effort hint:

```js
await agent("Skeptical pass over the conflicting evidence", {
  tier: "deep",
  effort: "high",
  schema: findingSchema,
});
```

`effort` accepts `minimal`, `low`, `medium`, or `high` and is applied through
OpenAI `chat.params` provider options. It is not a portable model-tier alias and
does not select native provider variants; if the resolved lane model is not an
OpenAI provider, the run fails before launching that child instead of silently
dropping the request.

### Preview and approval

`workflow_run` is two-phase by default. The first call (no `approve`) returns
the approval summary — it never launches lanes and never probes:

```jsonc
// 1) Preview: inspect authority, model plan, maxAgents, concurrency, sourceHash.
workflow_run({
  name: "deep-research",
  args: { question: "...", areas: ["..."], allowExternalDocs: false },
  profile: "read-only-review",
  maxAgents: 6,
  concurrency: 4,
})
```

Read the returned `approvalHash`, the authority line (confirm
`network=false`/`mcp=false` unless you intend a networked run), the model plan
(`fast=… deep=…`), and the `maxAgents`/`concurrency` values. Then approve the
**exact** envelope:

```jsonc
// 2) Approve: same args, plus approve:true and the approvalHash from step 1.
workflow_run({
  name: "deep-research",
  args: { question: "...", areas: ["..."], allowExternalDocs: false },
  profile: "read-only-review",
  maxAgents: 6,
  concurrency: 4,
  approve: true,
  approvalHash: "<approvalHash from the preview>",
})
```

The hash covers the source, runtime args, authority, models, budgets, and
concurrency, so any change between preview and approve invalidates it and forces
a fresh preview. To escalate to inspect-with-shell or networked research, change
`profile`/`authority` in the preview, re-read the new authority line, and approve
the new hash — never reuse a read-only hash for a more-authorized run.

When `options.autoApprove` is configured, a run can skip the preview call only if
its resolved authority tier is covered by that configured ceiling. A per-call
`autoApprove` value may narrow the ceiling for one run, but it cannot widen the
plugin configuration; primary-tree writes still stop at the independent
`workflow_apply` hash gate.

### Read the result back

After the run completes, read the final structured output with
`workflow_status`:

```jsonc
workflow_status({ runId: "<runId>", detail: "result" })
```

`detail: "result"` returns the workflow's final return value (here:
`groundedFindings`, `droppedUnsupportedClaims`, and the authority-tier note),
with credential-like keys redacted for display. `workflow_status` never mutates
state. Use `detail: "full"` only for diagnostics/apply internals. Treat
`groundedFindings` as the answer and `droppedUnsupportedClaims` as an honesty
ledger — if something important landed there, the lanes did not actually prove
it, and the right move is another scoped lane (or a stronger tier), not a louder
claim.
```
