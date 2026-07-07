# General-Purpose Workflow Harness Extraction Plan

> Status: **IMPLEMENTED (2026-06-30).** The generic-harness extraction shipped:
> drain modes/profiles/normalization are generic, beads logic (adapter + mutation
> finalizers) is an external trusted extension at `workflow-domains/beads/`
> (publish-excluded, config-loaded), and the kernel grep-gate is clean of
> beads-drain references. See [workflow-extensions.md](workflow-extensions.md) for
> the shipped architecture + how to write/register an extension. The
> `review_materialize` tool has also been externalized as a Beads extension tool
> now that extension-tool contribution support exists.
> The plan text below is retained for rationale/history.
>
> **Audited 2026-06-29** against committed source (11-lane verification + gap
> hunt). Most line/function citations were accurate; the audit corrected two
> factual errors about current behavior (Decisions 2 and 6), split one
> mislabeled citation, downgraded one "active" gate set to dead code, and added
> several missing implementation steps without which the refactor would silently
> no-op or fail its own success criteria. Audit-driven corrections are marked
> inline with **[audit]** and summarized in "Audit Corrections" below.

## Audit Corrections (2026-06-29)

These are the substantive changes the source audit forced. Each is applied
inline in the relevant section; this list is the index.

Critical (the refactor breaks without these):

- **No phase set `meta.harness="drain"`** on `workflows/beads-drain.js`, yet every
  Phase 2/6 generalization keys on `meta.harness === "drain"`. The current script
  has no `harness`/`adapter` field. Added as a Phase 2 task.
- **Phase 6 re-keyed auto-apply onto `run.mode`**, which is not persisted (the
  `writeState` allowlist omits it) and re-derives to `"dry-run"` on an
  args-omitted resume — silently disabling auto-apply on resumed live drains.
  Fixed by deriving from the persisted authority object (or persisting +
  rehydrating `run.harness`/`run.mode`).
- **No phase deletes `workflow-kernel/beads-drain-adapter.js`** (745 lines, 15
  exports). Phase 8's success grep and the Definition of Done cannot pass while
  it remains. Added an explicit move/delete task.

Factual corrections about current behavior:

- **Decision 6 was wrong:** `beads-autonomous-networked` *is* reachable via an
  explicit `profile` arg today. The function the plan cited as the blocker
  (`normalizeBeadsDrainWorkflowRunArgs`) is dead code — imported, never called.
- **Decision 2's mechanism was inverted:** authority (incl. profile) is persisted
  in `state.json` and read back verbatim on resume (`run-store-rehydrate.js:19`,
  `workflow-plugin.js:1345`); it is *not* re-derived. The conclusion (rename is
  safe for resume) still holds, but for the opposite reason.
- The profile/mode **conflict-rejection** the plan generalizes lives only in dead
  code, so it is net-new behavior to implement, not a port.
- `NON_DRY_BEADS_DRAIN_PERMISSION_GATES` is **dead code** (defined, no call site),
  not active pre-launch verification.
- Current State's consent-text citation (`~952`) was the **auto-apply exception**;
  the consent text is at `~604`. Split into two entries.

Design gaps to resolve before Phase 1 (now noted in their sections): approval-hash
canonical form, registry vs. double-instantiation, runtime options-delivery
verification, and the auto-apply trust boundary.

## Current State

The plugin already has the right conceptual pieces:

- Generic workflow runner: approval hashes, sandbox, status, lifecycle, background, cancellation, and resume.
- Generic-ish drain runtime: `workflow-kernel/drain-runtime.js`.
- Generic-ish integration and apply machinery: lane worktrees, integration plan, diff plan, and apply.
- Beads adapter: `workflow-kernel/beads-drain-adapter.js`.
- Thin workflow script: `workflows/beads-drain.js`.

The problem is that Beads-specific policy leaked into the generic kernel
(references verified against committed source at the time of writing):

- `authority-policy.js`:
  - Beads profiles (`beads-dry-run`, `beads-autonomous-local`, `beads-autonomous-networked`) and `NON_DRY_BEADS_DRAIN_REQUIRED_GATES`.
  - `resolveBeadsDrainMode` and `normalizeBeadsDrainWorkflowRunArgs` (Beads mode parsing).
  - `authorityArgsForWorkflow` (line 313): clamps authority to dry-run when `meta.name === "beads-drain"` and the runtime mode resolves to `"dry-run"`. This is a Beads-specific authority gate not named in the original plan. **[audit]** The dry-run clamp uses `profile: args.profile ?? "beads-dry-run"` (line 323) — null-coalescing, not forced assignment — so an explicit `args.profile` survives unchanged. For autonomous-local mode the function returns `args` untouched (line 320), so the profile passes straight through to `resolveRunAuthority`. The clamp is therefore *not* the airtight "only maps to beads-dry-run" gate the original Decision 6 assumed.
- `workflow-plugin.js`:
  - Beads command registration (`registerBundledCommand(cfg, "beads-drain", ...)` at line ~284).
  - `effectiveWorkflowBackground` (line ~371): defaults autonomous-local Beads drains to `background=true` via `isBundledBeadsDrainSource`.
  - `mutationDomainSummary` (line ~411): has a Beads-specific branch keyed on `run.meta?.name === "beads-drain"`.
  - **[audit]** Beads-specific approval **consent text** (line 604-606, inside `approvalPreviewEnvelope`) — keyed on `run.meta?.name === "beads-drain" && run.authority?.profile === "beads-autonomous-local"`. (The original plan cited this at `~952`; that line is the *auto-apply exception* below, a separate construct.)
  - Beads-specific **auto-apply exception** (line 952-956, inside `runWorkflowExecution`) — same `meta.name`/`profile` key; calls `runAutoApply` when status is `awaiting-diff-approval`.
  - Bundled Beads source checks (`isBundledBeadsDrainSource` at line ~1292, `assertBeadsDrainRuntimeArgsShape` at line ~1293).
  - `NON_DRY_BEADS_DRAIN_PERMISSION_GATES` (line 183): a second Beads-specific gate set (3 gates), distinct from `NON_DRY_BEADS_DRAIN_REQUIRED_GATES` in `authority-policy.js` (7 gates). **[audit]** This constant is **dead code** — defined at line 183 with **no call site anywhere** in the tree. The original plan's "used for pre-launch permission-gate verification" is not borne out by the source. It should simply be deleted in Phase 8, not generalized.
  - `beadsDrainDelegatesIntegrationGates` (line 1444): bypasses worktree capability verification (`worktree`, `directoryRooting`, `worktreeEditIsolation`) specifically for beads-drain (when `dryRun !== true`), because the drain runtime handles worktree isolation internally.
  - **[audit]** Beads-specific **laneTimeoutMs reconciliation** (line 1364-1368, in `planWorkflowEnvelope`): reads a `laneTimeoutMs` alias from `args.args` only when `bundledBeadsDrain` is true and throws if it conflicts with the top-level `workflow_run` value. Not in the original inventory; consumes `bundledBeadsDrain` (from `isBundledBeadsDrainSource`, line 1292) which Phase 8 removes — so removing `isBundledBeadsDrainSource` without addressing this branch breaks the build and silently drops the alias feature.
  - **[audit]** `normalizeBeadsDrainWorkflowRunArgs` (authority-policy.js:339) is **imported** at `workflow-plugin.js:120` but **never called** in the run path — dead code. The profile/mode conflict-rejection it contains is therefore not enforced today (see Generic Drain Authority Model and Decision 6).
- `sandbox-executor.js`:
  - Imports the Beads adapter directly (`adapterName !== "beads"` at line ~136, `import("./beads-drain-adapter.js")` at line ~137).
  - Builds Beads-specific lane prompt text (line ~178: "host-owned Beads drain workflow"; line ~183: "Do not run Beads mutation commands").
  - `beadsDrainGateStatus` function (line ~218): hardcodes the Beads gate probe set.
  - `runHostDrain` has Beads-specific gate enforcement and error text (lines ~261-278).
  - Beads-specific lane label `beads drain ${...}` (line ~333).
  - `__workflowDrainAdapters` test injection seam (line ~134): a primitive, test-only adapter registry on `pluginContext`. This is an existing proof-of-concept for the production extension registry proposed below.
- `event-journal.js` dispatches `beads.*` mutations by importing the Beads adapter (`executeStagedDomainMutation`, line ~328).
- `workflow-source.js` has `isBundledBeadsDrainSource` (line ~262) and `assertBeadsDrainRuntimeArgsShape` (line ~266).
- `role-template-loading.js` has Beads invocation hints in `CURATED_INVOCATION_HINTS` (line ~225).
- `constants.js` has `BEADS_DRAIN_COMMAND_PATH` (line ~36).
- `index.js` exports the Beads adapter through the generic kernel barrel (line ~35).

Positive: the drain runtime itself (`drain-runtime.js`) is already domain-neutral and adapter-driven — its only "beads" reference is in a comment. A non-Beads test adapter (`test-fix-drain-adapter.js`, exercised by `test:workflow-adapters`) already proves the adapter contract works generically and should stay in core as a test fixture.

For open source, the goal should be:

- Core plugin has no Beads-specific workflow logic.
- Beads drain is implemented as an external/trusted drain adapter plus normal workflow assets.
- The core harness still supports the same class of autonomous drain behavior generically.

## Guiding Principles

### 1. The Workflow Plugin Is A Generic Harness

It should provide execution mechanics:

- workflow loading and approval
- sandbox execution
- child lanes
- structured output
- budgets
- live gates
- worktree isolation
- integration
- diff plans
- durable state
- pause, cancel, resume, and status
- generic drain loop
- generic domain mutation ledger and finalizer mechanism

### 2. Domain Adapters Own Domain Semantics

A Beads adapter should own:

- `bd` reads and writes
- issue discovery
- readiness classification
- claim semantics
- lane packet content
- Beads-specific child instructions
- validation against Beads acceptance
- closeout notes
- follow-up creation
- final dry proof

### 3. Workflow Source Remains Thin

`workflows/beads-drain.js` should not implement worktree, permission, Beads mutation, auto-apply, or finalizer logic.

It should configure the generic drain harness:

```js
export const meta = {
  name: "beads-drain",
  harness: "drain",
  adapter: "beads",
};

const mode = args?.mode ?? "dry-run";

return await drain({
  adapter: "beads",
  mode,
  dryRun: mode === "dry-run",
  scope: args?.scope ?? {},
});
```

**[audit]** This is the *target* shape. The **current** `workflows/beads-drain.js`
already calls `drain()` as a host primitive, but its `meta` has **no `harness`
and no `adapter` field** (it carries `name`, `description`, `profile:
"beads-autonomous-local"`, etc.). Adding `meta.harness === "drain"` is the
trigger every generic generalization in Phases 2 and 6 keys on, so it must be an
explicit Phase 2 task (see Phase 2). The current `drain()` call shape is
`drain({ adapter, dryRun, scope, maxWaves, maxAttempts, actor? })` — it passes the
boolean `dryRun`, not `mode`; the target above adds `mode` and the harness must
keep accepting `maxWaves`/`maxAttempts`/`actor`.

### 4. External Adapters Are Trusted Host Code, Not Arbitrary Workflow Code

Do not let a workflow script register adapters, mutation finalizers, live-gate rules, or auto-apply authority.

Adapters should be loaded as trusted plugin/domain modules, equivalent in trust level to OpenCode plugins.

### 5. Autonomous Drain Should Become Generic

The current Beads-only live mode should become a generic drain mode:

- `dry-run`: read-only plan/proof, no child lanes, no mutations.
- `autonomous-local`: local child lanes, integration worktrees, trusted domain mutations, verified auto-apply after successful central validation.

The names should not include Beads.

## Target Architecture

Core repo:

```text
opencode-workflows/
  opencode-workflows.js

  workflow-kernel/
    workflow-plugin.js
    sandbox-executor.js
    authority-policy.js
    drain-runtime.js
    integration-mode.js
    event-journal.js
    run-store-*.js
    workflow-source.js
    extension-registry.js
    drain-adapter-contract.js
    domain-mutation-registry.js

  workflows/
    generic example workflows only, or no domain-specific workflows

  commands/
    generic workflow commands only

  skills/
    generic workflow skills only
```

External or local Beads repo/module:

```text
opencode-workflows-beads/
  beads-domain.js
  beads-drain-adapter.js
  workflows/beads-drain.js
  commands/beads-drain.md
  skills/beads-drain/SKILL.md
  tests/
```

Temporary intermediate layout if keeping one repo during migration:

```text
workflow-kernel/               generic
workflow-domains/beads/        Beads adapter/domain module
workflows/beads-drain.js       still removable later
commands/beads-drain.md        still removable later
skills/beads-drain/SKILL.md    still removable later
```

Final success criterion: `grep` for `beads` in `workflow-kernel/` should return no core logic references. At most, it may show generic test fixtures or adapter-registry examples outside the production kernel.

## Core Extension API

Add a trusted extension registry.

The core plugin should accept extension module paths through plugin options.
The OpenCode SDK delivers options as the second parameter to the plugin factory
(`Plugin = (input, options?) => Promise<Hooks>`, verified in
`@opencode-ai/plugin/dist/index.d.ts:51`). Each `plugin` array element is either
a bare path string or a `[path, PluginOptions]` tuple:

```json
[
  ["./plugins/opencode-workflows/opencode-workflows.js", {
    "extensions": [
      "./plugins/opencode-workflows-beads/beads-domain.js"
    ]
  }]
]
```

This requires changing the current factory signature from
`async function WorkflowPlugin(pluginContext)` (one parameter) to
`async function WorkflowPlugin(pluginContext, options)` so the `extensions`
array reaches the plugin.

The core plugin dynamically imports those modules at startup.

Each extension exports a plain object or function returning a domain definition:

```js
export default {
  id: "beads",

  drainAdapters: {
    beads: {
      createAdapter,
      laneInstructions,
      requiredGates,
      supportsAutoApply: true,
      mutationOperations: ["beads.close", "beads.append-notes", "beads.create-followup"],
    },
  },

  authorityProfileAliases: {
    "beads-dry-run": "drain-dry-run",
    "beads-autonomous-local": "drain-autonomous-local",
  },

  workflows: [
    { name: "beads-drain", path: "./workflows/beads-drain.js" },
  ],

  commands: [
    { name: "beads-drain", path: "./commands/beads-drain.md" },
  ],

  mutationHandlers: {
    "beads.close": finalizeClose,
    "beads.append-notes": finalizeAppendNotes,
    "beads.create-followup": finalizeCreateFollowup,
  },
};
```

Core registry responsibilities:

- Load extension modules.
- Validate extension shape.
- Freeze registered definitions.
- Reject duplicate adapter names unless explicitly overridden.
- Reject duplicate mutation operation handlers.
- Resolve extension-relative asset paths.
- Provide lookup functions:
  - `registry.drainAdapter(name)`
  - `registry.workflowAsset(name)`
  - `registry.commandAsset(name)`
  - `registry.authorityProfile(name)`
  - `registry.mutationHandler(operation)`

## Generic Drain Authority Model

Replace Beads-specific profiles with generic drain profiles.

Core profiles should include:

```text
read-only-review
inspect-with-shell
edit-plan-only
apply-approved-plan
```

`drain-dry-run`:

- read-only
- no edit
- no integration
- no domain mutation
- no child implementation lanes

`drain-autonomous-local`:

- integration worktrees allowed
- local only
- no network by default
- no MCP by default
- child lanes allowed
- trusted domain mutations allowed through registered adapter only
- auto-apply allowed only after successful verified drain result
- required gates:
  - permission enforcement
  - command-scoped bash denial
  - secret-read denial
  - structured output
  - directory rooting
  - integration worktree isolation
  - cancellation

This makes the current Beads gate set generic to autonomous local drain.

Runtime mode normalization should also be generic for workflows with:

```js
meta.harness === "drain"
```

Generic behavior:

```text
args.mode omitted -> dry-run
args.mode = "dry-run" -> drain-dry-run
args.mode = "autonomous-local" -> drain-autonomous-local
conflicting profile/mode -> reject
```

**[audit] Two constraints the original plan left implicit:**

1. **Conflict-rejection is net-new, not a port.** The only profile/mode
   conflict-rejection that exists today lives inside
   `normalizeBeadsDrainWorkflowRunArgs` (authority-policy.js:349/358/364), which
   is **never called** (dead code). So a conflicting `profile`/`mode` today
   produces a silent authority/mode mismatch, not a clean reject. Implementing
   "conflicting profile/mode -> reject" is new behavior — budget and test it as
   such.

2. **Normalization must be a single bidirectional canonical form, consumed by
   every site, or approval hashes diverge.** The approval hash covers
   `runtimeArgs` (raw `args.args`), the full `authority` object (incl.
   `profile` + `requiredGates`), and `background` (`approval-hashing.js`). `mode`
   is read independently by ≥5 sites (the runtimeArgs hash field, authority
   resolution, `effectiveWorkflowBackground`, `mutationDomainSummary`, and the
   sandbox body). If profile->mode injection touches only some of them, or if the
   inverse (mode->implied profile) is left unspecified, then the two equivalent
   invocations `workflow_run({ profile: "drain-autonomous-local" })` and
   `workflow_run({ args: { mode: "autonomous-local" } })` produce different
   envelopes and different hashes — reviving the "re-hash / triple-launch" churn
   class. Define one canonical normalization (profile <-> mode, plus the
   `background` auto-default) applied once, feeding all consumers, and add a
   hash-equality test asserting the two forms yield the same `approvalHash`.

The Beads extension can optionally provide compatibility aliases:

```text
beads-dry-run -> drain-dry-run
beads-autonomous-local -> drain-autonomous-local
```

Those aliases should live outside the generic core.

## Generic Drain API

Keep `drain()` as a host primitive, but make it adapter-registered.

**[audit]** Two parts of this are already implemented today and are
preserve-existing, not build-new: `drain()` is exposed to workflow scripts as
`globalThis.drain` (`sandbox-executor.js:706`) backed by `runHostDrain`
(`sandbox-executor.js:253`) and the domain-neutral `drain-runtime.js`; and the
host primitive **already rejects guest-supplied `runLane`/`integrate`**
(`sandbox-executor.js:258`: `drain() lane execution is host-owned and cannot be
supplied by workflow source`). Item 2 below should be framed as "keep the
existing rejection," not new work.

Current direction:

```js
return await drain({
  adapter: "beads",
  dryRun,
  scope,
  maxWaves,
  maxAttempts,
});
```

Target generic behavior:

1. Validate payload is object.
2. Reject guest-supplied `runLane` and `integrate`.
3. Resolve adapter through registry.
4. Resolve mode from payload/runtime args.
5. Enforce required live gates for non-dry modes.
6. Create adapter instance.
7. Run generic drain runtime.
8. Use adapter methods for domain semantics.
9. Use generic lane/integration machinery for execution.
10. Use generic domain mutation ledger/finalizer for trusted mutations.

The generic drain adapter contract should be explicit. This matches the method
set already validated by `drain-runtime.js:validateAdapter()` (which requires
`discover`, `classify`, `claim`, `buildLanePacket`, `validate`, `close`,
`createFollowup`, `proveDry`) plus `releaseClaim` (optional, called by
`drain-runtime.js` for failed/cancelled lanes):

```ts
type DrainAdapter = {
  name: string;

  discover(scope): Promise<Item[]>;
  classify(item, context): Promise<Classification>;
  claim(item, context): Promise<ClaimResult>;

  buildLanePacket(item, context): Promise<{
    item: object;
    instructions: string[];
    acceptance?: string[];
    constraints?: string[];
    expectedReport?: string;
  }>;

  validate(item, integrationState, context): Promise<ValidationReport>;

  // Stage mutations through the durable domain ledger (two-phase: stage now,
  // finalize after successful apply). Does NOT execute the domain write directly.
  close(item, validation, context): Promise<StagedMutationRef>;
  createFollowup(followup, context): Promise<StagedMutationRef>;

  // Optional: release a failed/cancelled claim so the item is not left
  // stranded. Called by drain-runtime's releaseClaimedItem().
  releaseClaim?(item, context): Promise<ReleaseResult>;

  proveDry(scope, context): Promise<DryProof>;
};
```

Domain mutation finalization (executing the staged writes) is a **separate**
function registered as a mutation handler, not a method on the adapter instance.
See the Generic Domain Mutation Finalization section below.

Core should not know what a Beads issue looks like.

## Generic Lane Prompt

Move Beads wording out of `sandbox-executor.js`.

Core prompt should be domain-neutral:

```text
You are implementing one item for a host-owned drain workflow.

The controller owns domain discovery, claims, validation, closeout, and final dry proof.
Do not mutate domain state directly unless the assigned instructions explicitly allow it.
Work only on the implementation change requested by the assigned item.

Assigned item:
...
Domain instructions:
...
```

The Beads adapter's `buildLanePacket()` should include:

```text
Do not run Beads mutation commands such as bd update, bd create, bd close, or bd dep add.
```

This preserves behavior without hard-coding Beads in core.

## Generic Domain Mutation Finalization

Replace `event-journal.js` logic like:

```js
if (operation.startsWith("beads.")) {
  import("./beads-drain-adapter.js");
}
```

with registry dispatch:

```js
const handler = registry.mutationHandler(record.operation);
if (!handler) throw new Error(`Unsupported domain mutation operation: ${record.operation}`);
return await handler(record, idempotencyKey);
```

The ledger machinery remains core:

- staging
- idempotency key
- durable append
- readback requirement
- failure record
- retry behavior
- status rendering

The mutation semantics move to the extension.

## Generic Auto-Apply

Turn the Beads-only auto-apply exception into a generic autonomous drain policy.

Core rule:

A run may auto-apply only if all are true:

- workflow harness is `drain`
- runtime mode is `autonomous-local`
- **[audit]** the resolved workflow source is host/extension-trusted (a core
  bundled or extension-registered source), **not** a project/global shadow (see
  below)
- approval envelope explicitly included auto-apply consent
- authority profile is `drain-autonomous-local`
- adapter registration has `supportsAutoApply: true`
- drain result is successful
- central validation accepted all integrated lanes
- diff plan exists and hashes cleanly
- base commit is unchanged or safely validated
- domain mutations are staged, not finalized before apply
- generic apply succeeds
- then domain finalizers run and fresh readback completes

**[audit] Three things the original auto-apply design must pin down:**

1. **Trust boundary moves from a name to a predicate — close the shadow hole.**
   Today auto-apply is gated on `run.meta?.name === "beads-drain"`, a bundled
   host-controlled source name. The generic predicate
   (`harness === "drain" && mode === "autonomous-local" && adapter.supportsAutoApply`)
   combined with the resolution order (project > global > extension > core) lets
   *any approved* project-level workflow that shadows the name, declares
   `harness: "drain"` + `drain-autonomous-local`, and calls
   `drain({ adapter: "beads", dryRun: false })` trigger trusted-adapter domain
   mutation + in-run apply on a single launch approval. Guiding Principle 4
   governs adapter *registration*, not *invocation*. Require the resolved source
   to be host/extension-trusted before auto-apply is permitted (or have the
   adapter registration declare which source scopes it will auto-apply for).

2. **Derive the runtime mode for this gate from the PERSISTED authority, not
   re-derived args.** `run.authority` (incl. `profile`) is persisted and read
   back verbatim on resume (`run-store-rehydrate.js:19`,
   `workflow-plugin.js:1345`), but `run.mode`/`run.harness` are net-new fields
   that the `writeState` allowlist does not serialize, so on an args-omitted
   `resumeRunId` resume `run.mode` re-derives to `"dry-run"`. Gating auto-apply on
   the re-derived `run.mode` would silently disable auto-apply on a resumed live
   drain. Either (a) gate on the persisted authority (e.g.
   `authority.profile === "drain-autonomous-local"`), or (b) add `run.harness`
   and `run.mode` to the `writeState` allowlist **and** `rehydrateRunFromPriorState`.

3. **The auto-apply "policy" added to the approval envelope is display/consent
   text only — do not add a new hashed field.** Auto-apply enablement is already
   bound through the hashed `authority.profile` + `runtimeArgs.mode`. Adding a new
   field to the hashed `approvalEnvelope` (currently `version: 2`) would force a
   version bump to 3 and invalidate every persisted/in-flight approval hash on
   upgrade. If a hashed field is genuinely required, call out the bump and the
   one-time invalidation explicitly.

If any part fails:

- do not silently close domain work
- preserve diff plan
- leave run as `failed-with-diff-plan` or `apply-failed`
- allow recovery through generic status/apply/resume tools

This makes “live drain actually drains” a generic harness capability, not a Beads special case.

## Workflow Assets Outside Core

Move these out of core registration:

- `workflows/beads-drain.js`
- `commands/beads-drain.md`
- `skills/beads-drain/SKILL.md`

Core should support extension-provided assets.

Extension-provided workflows should appear in `workflow_list` with a scope like:

```text
extension:beads
```

`workflow_run({ name: "beads-drain" })` should resolve in this order (preserves
user control — user-authored workflows always win over bundled/extension
defaults):

1. project workflow (`.opencode/workflows/`)
2. global workflow (`GLOBAL_WORKFLOW_DIR`)
3. extension workflows (registered by extensions)
4. core bundled workflows (`BUNDLED_WORKFLOW_DIR`)

Rejected alternative (extension before core) because it would let a
shipped-example override silently shadow the user's own core example of the
same name. The order above matches the existing `resolveWorkflowSource()`
candidate list, with extension workflows inserted before the bundled fallback.

Command registration should likewise be extension-driven:

- Core registers generic workflow commands.
- Beads extension registers `/beads-drain`.

Skills can live in OpenCode config or extension assets. If the plugin cannot register skills directly, keep Beads skills outside the core plugin repo in the global config source tree.

## Implementation Phases

### Phase 0: Baseline And Cleanup

Goal: start from a known state.

Tasks:

1. Run current focused tests before changes:
   - `npm run test:beads-drain`
   - `npm run test:workflow-kernel`
   - `npm run test:workflows`
2. Capture current `grep` inventory for Beads references in `workflow-kernel/`.
3. Mark current Beads behavior as migration baseline:
   - omitted args dry-run
   - explicit `mode: "autonomous-local"` live
   - top-level live profile currently footguns to dry-run unless args mode set
   - non-dry requires verified gates
   - unsafe permission bypass is rejected
   - in-run apply finalizes accepted Beads changes
4. **[audit]** Runtime spike for the extension seam: register this plugin with the
   tuple form `["./.../opencode-workflows.js", { extensions: [] }]` plus a trivial
   probe, and confirm at runtime that `options` actually reaches the factory's
   second parameter under the installed opencode (1.17.7). The
   `@opencode-ai/plugin` types declare this, but the generated server schema
   (`@opencode-ai/sdk/.../types.gen.d.ts:1067`) declares `plugin?: Array<string>`
   (no tuple), and the loader lives in the opencode binary (not inspectable here).
   If `options` is not delivered, the entire extension mechanism is non-viable as
   designed — resolve this before Phase 1 (see Phase 1).
5. **[audit]** Drain or terminate any in-flight/paused runs before extraction.
   Editing then moving `workflows/beads-drain.js` (Phases 2/4/7) changes its
   `sourceHash`, which invalidates the resume-replay cache for runs started under
   the old source; after Phase 7 a paused run only resolves `name: "beads-drain"`
   if the Beads extension is loaded. Document that cross-upgrade resume of a
   pre-extraction run may re-run uncached lanes.

Deliverable:

- No behavior change yet.
- Baseline tests documented.
- Extension options delivery confirmed (or the seam redesigned).

### Phase 1: Add Generic Extension Registry

Goal: create the host-owned extension seam without changing behavior.

Tasks:

1. Add `workflow-kernel/extension-registry.js`.
2. Define extension shape validation.
3. Support plugin option `extensions: string[]`.
4. Dynamically import extension modules from configured paths.
5. Register:
   - drain adapters
   - authority profile aliases
   - workflow assets
   - command assets
   - mutation handlers
6. Thread registry into places that need lookup, without moving Beads yet.
7. Add test-only fake extension.
8. **[audit]** Reconcile the registry with the documented double-instantiation
   invariant (AGENTS.md: factories are double-instantiated; shared state must be
   module-level keyed by a runtime value). A module-level singleton that "rejects
   duplicate adapter names" would **throw on the second factory instantiation**.
   Either key the registry per-`pluginContext` (like the existing
   `pluginContext.__workflowDrainAdapters` POC seam, `sandbox-executor.js:134`) so
   each instantiation gets its own frozen registry, or make registration
   idempotent (same module path + identical definition is a no-op; only a
   *conflicting* redefinition rejects). Add a test that instantiates the factory
   twice with the same extensions and asserts no duplicate-name throw.
9. **[audit]** Keep `extension-registry.js` a strict **import-leaf**: it imports
   only from leaf modules (`errors`/`constants`/`text-json`), holds function
   references, and loads extension modules via dynamic `import()` at startup.
   `sandbox-executor.js` and `event-journal.js` obtain the registry by parameter
   or a leaf accessor — never by importing the adapter. Done right, this *removes*
   the existing lazy-import cycle (`event-journal.js` <-> `beads-drain-adapter.js`,
   today broken only by a dynamic `import()` at the finalize site). Add a require-
   graph / cycle assertion to the test suite.
10. **[audit]** Define a fallback config channel for `extensions` and fail loud on
    missing options. If the Phase 0 spike shows opencode does not deliver
    per-plugin `options`, read extension paths from an env/XDG marker (mirroring
    `GLOBAL_WORKFLOW_DIR` resolution in `constants.js`) instead. A
    missing/undefined options object with configured extensions must surface a
    startup diagnostic, never silently load zero extensions.
11. **[audit]** Add `export * from "./extension-registry.js"` to
    `workflow-kernel/index.js` so the new module's symbols are reachable via the
    barrel/`__test` surface the test suites use.

Tests:

- Loads fake extension from path.
- Rejects invalid extension shape.
- Rejects duplicate adapter names (without tripping on the second instantiation).
- Rejects duplicate mutation operation names.
- Double-instantiating the factory with the same extensions does not throw.
- `workflow_list` can include extension workflow assets.
- Core behavior unchanged when no extensions are configured.
- No new import cycle is introduced through the registry.

### Phase 2: Generic Drain Modes And Profiles

Goal: remove Beads-specific authority concepts from the core.

Tasks:

0. **[audit] Set `meta.harness = "drain"` and `meta.adapter = "beads"` on
   `workflows/beads-drain.js`** — and update `tests/beads-drain-assets.test.mjs`
   accordingly. **This is the trigger every task below keys on.** The current
   script has no `harness`/`adapter` field, so without this step tasks 2/8/9/10/11
   and all of Phase 6 silently no-op for the only real drain workflow.
   `meta.harness` is set in the workflow script (it is *not* injected by the
   registry). Do this before the resolver/generalization tasks.
1. Add generic profiles:
   - `drain-dry-run`
   - `drain-autonomous-local`
2. Add generic drain mode resolver for `meta.harness === "drain"`.
3. Normalize top-level profile into runtime `args.mode` **via the single
   bidirectional canonical form** (see Generic Drain Authority Model audit note) —
   one normalization feeding the runtimeArgs hash field, authority resolution,
   `effectiveWorkflowBackground`, `mutationDomainSummary`, and the body.
4. Reject profile/mode conflicts. **[audit] This is net-new behavior** — the only
   existing conflict-rejection is in the never-called
   `normalizeBeadsDrainWorkflowRunArgs`, so nothing enforces it today.
5. Move Beads aliases into Beads extension or temporary compatibility module.
6. Remove `beads-dry-run`, `beads-autonomous-local`, and `beads-autonomous-networked` from core profile table. **[audit] Sequence this LAST** — only after
   tasks 0, 1, 8, 8a, and 8b land. `resolveAuthorityProfile` **throws** on an
   unknown profile name (`authority-policy.js:280`), and today autonomous-local
   gets its integration authority solely from `meta.profile =
   "beads-autonomous-local"`. Removing the profiles before the replacement mapping
   exists makes every live run hard-throw (if `meta.profile` remains) or fall back
   to read-only ad-hoc with integration silently disabled (if it is dropped).
7. Update approval summary to say generic drain mode/profile.
8. Generalize `authorityArgsForWorkflow` (authority-policy.js:313): replace the `meta.name !== "beads-drain"` gate with `meta.harness !== "drain"`, so the dry-run authority clamping applies to any drain workflow.
   - **[audit]** In the same function, change the dry-run clamp literal from `args.profile ?? "beads-dry-run"` (line 323) to `?? "drain-dry-run"`.
   - **[audit]** Add the **mode -> authority-profile mapping** that replaces the dropped `meta.profile` mechanism: when `mode === "autonomous-local"`, the resolver must inject authority profile `drain-autonomous-local` (the reverse of what `meta.profile` supplies today). Migrate/remove `meta.profile: "beads-autonomous-local"` from `workflows/beads-drain.js` as part of this change so authority comes from mode, not a hard-coded profile.
9. Generalize `effectiveWorkflowBackground` (workflow-plugin.js:371): replace `isBundledBeadsDrainSource` with a `meta.harness === "drain"` check, so autonomous-local drain defaults to background regardless of adapter.
10. Generalize `mutationDomainSummary`'s drain branch (workflow-plugin.js:411): replace `run.meta?.name === "beads-drain"` with `run.harness === "drain"` and delegate the domain description to the adapter or a generic drain-mode label.
11. Populate `run.harness` (from `meta.harness`) and `run.mode` (the normalized drain mode) on the run object in `planWorkflowEnvelope` / `startWorkflow`. **[audit] Also persist and rehydrate them**: add `harness` and `mode` to the
    `doWriteState` field allowlist (`run-store-state.js` — it serializes an
    explicit allowlist, it does not spread `run`) **and** restore them in
    `rehydrateRunFromPriorState` (`run-store-rehydrate.js`). Otherwise these fields
    do not round-trip across resume and Phase 6's auto-apply gate breaks on
    resumed runs (see Phase 6 / Generic Auto-Apply audit note). Alternatively, gate
    Phase 6 on the *persisted authority* instead and treat `run.mode`/`run.harness`
    as in-memory-only convenience fields.

Mode semantics:

```text
workflow_run({ name: "beads-drain" }) -> dry-run
workflow_run({ name: "beads-drain", args: {} }) -> dry-run
workflow_run({ name: "beads-drain", args: { mode: "autonomous-local" } }) -> live
workflow_run({ name: "beads-drain", profile: "drain-autonomous-local" }) -> live
profile/mode conflict -> reject
```

Tests:

- Generic drain workflow omitted args uses `drain-dry-run`.
- Generic drain workflow live mode uses `drain-autonomous-local`.
- Top-level profile injects mode before approval hash.
- **[audit]** `workflow_run({ profile: "drain-autonomous-local" })` and
  `workflow_run({ args: { mode: "autonomous-local" } })` produce the **same**
  `approvalHash` (canonical-form convergence).
- Approval preview shows normalized runtime args.
- Conflicting profile/mode rejects.
- Non-drain workflows with `args.mode` are not interpreted as drain modes.
- **[audit]** A drain workflow with `meta.harness === "drain"` actually triggers
  the generic mode/background/auto-apply paths (guards against the missing-trigger
  regression).
- **[audit]** `run.harness`/`run.mode` survive a resume round-trip (write state ->
  rehydrate) — or, under the persisted-authority alternative, the auto-apply gate
  reads the same value before and after resume.
- Beads alias behavior works only when Beads extension is loaded, if aliases are kept.

### Phase 3: Move Beads Adapter Behind Registry

Goal: remove direct Beads adapter imports from `sandbox-executor.js`.

Tasks:

1. Create Beads extension module.
2. Move `createBeadsDrainAdapter` registration into the Beads extension.
   - **[audit] Physically move `workflow-kernel/beads-drain-adapter.js`** (745 lines, 15 exports incl. `createBeadsDrainAdapter` @250 and `finalizeBeadsDomainMutation` @665) into the Beads extension module. Tasks 2 and Phase 5#4 only relocate the *registration* and *one function*; the file itself is the bulk of the Beads logic in the kernel and no other task removes it. (Without this, Phase 8's grep criterion and the Definition of Done cannot pass.) Also drop its barrel export (`index.js:35`) — already listed as Phase 8#15.
3. Change `createDrainAdapter()` (sandbox-executor.js:132) / `runHostDrain()` (sandbox-executor.js:253) to resolve adapters through the production registry instead of the hardcoded `adapterName !== "beads"` import. The existing test-only seam `pluginContext.__workflowDrainAdapters` (line 134) is a proof-of-concept for this resolution path; the production registry replaces it.
4. Remove direct `adapterName === "beads"` adapter import and gate enforcement branches (sandbox-executor.js lines 136-137, 261-279).
5. Generalize `beadsDrainGateStatus` (sandbox-executor.js:218): rename to a generic drain-gate probe that uses the adapter registration's `requiredGates` list instead of the hardcoded `NON_DRY_BEADS_DRAIN_REQUIRED_GATES`.
6. **[audit] Delete** `NON_DRY_BEADS_DRAIN_PERMISSION_GATES` (workflow-plugin.js:183). It is dead code (no call site), so there is nothing to "generalize" — remove it outright. The pre-launch permission gates that actually run come from the resolved profile's `requiredGates`.
7. Allow an adapter to **add** extra required gates — never remove. **[audit] The
   profile's `requiredGates` is the authoritative floor**: the enforced set (at both
   pre-launch verification and the in-drain `runHostDrain` probe) must be the
   *union* of profile gates and adapter-declared gates, computed from one resolved
   list. An adapter that declares fewer gates than the profile must still have the
   full profile set enforced before any mutation (otherwise a live drain fails
   open). Add a test for this.
8. Keep guest-supplied `runLane` and `integrate` rejected. **[audit] Already
   implemented** at `sandbox-executor.js:258` — this task is "do not regress," not
   new work.

Tests:

- `drain({ adapter: "fake" })` works with fake registered adapter.
- Unsupported adapter rejects.
- Guest-supplied `runLane` rejects.
- Guest-supplied `integrate` rejects.
- Beads drain works only when Beads extension is loaded.
- Without Beads extension, `adapter: "beads"` rejects cleanly.

### Phase 4: Generalize Drain Lane Prompt And Lane Spec

Goal: remove Beads language from core child-lane execution.

Tasks:

1. Replace Beads-specific lane prompt text with generic drain wording.
2. Ensure adapter `buildLanePacket()` supplies domain-specific instructions.
3. Move Beads command prohibitions into Beads adapter packet instructions.
4. Generalize lane labels:
   - from `beads drain <id>`
   - to `<adapter> drain <id>` or `drain <id>`
5. Keep structured lane report schema generic.
6. Move result-shaping logic out of the workflow script. The current `workflows/beads-drain.js` (lines ~65-82) computes `stop_reason`, `planned_ids`, `closed_ids`, `failed_ids`, and `remote_sync` from the raw drain report. This post-processing is common to any drain workflow and should move into the generic drain harness (or the drain runtime's return shape), not stay in each adapter's workflow script.

Tests:

- Beads lane prompt still includes “Do not run Beads mutation commands” via adapter instructions.
- Core prompt has no literal Beads wording.
- Fake adapter prompt includes fake domain instructions.
- Lane reports still validate.

### Phase 5: Generic Domain Mutation Registry

Goal: remove `beads.*` dispatch from `event-journal.js`.

Tasks:

1. Add `workflow-kernel/domain-mutation-registry.js` or fold into `extension-registry.js`. **[audit]** If it is a new module, add `export * from "./domain-mutation-registry.js"` to `index.js` (same as Phase 1#11) so its symbols reach the barrel/`__test` surface.
2. Register mutation handlers by exact operation name.
3. Change staged mutation finalization to use registry lookup.
4. Move `finalizeBeadsDomainMutation` into Beads extension/adapter module.
5. Reject unsupported operations fail-closed.

Tests:

- Fake mutation handler finalizes through registry.
- Unsupported operation rejects.
- Beads close/append/follow-up finalizers still work with extension loaded.
- Idempotency key is preserved.
- Failed finalization does not silently mark domain work done.

### Phase 6: Generic Auto-Apply For Autonomous Drain

Goal: remove Beads-specific in-run apply exception.

Tasks:

1. Add generic `primaryWrite` / `autoApply` policy for drain workflows. **[audit]
   Keep this display/consent-only** — auto-apply enablement is already bound via
   the hashed `authority.profile` + `runtimeArgs.mode`. Do **not** add a new field
   to the hashed `approvalEnvelope` (`version: 2`) unless you also bump the version
   to 3 and accept the one-time invalidation of all persisted approval hashes
   (call it out explicitly if so).
2. Approval summary must explicitly state:
   - live autonomous local drain
   - verified successful diff plan will auto-apply in-run
   - domain mutations finalize only after successful apply
3. Replace the Beads-only condition in `runWorkflowExecution()` (`workflow-plugin.js:954`, keyed on `run.meta?.name === "beads-drain" && run.authority?.profile === "beads-autonomous-local"`) with a generic predicate:
   - `run.harness === "drain"`
   - autonomous-local mode — **[audit] read from the PERSISTED authority** (e.g.
     `run.authority?.profile === "drain-autonomous-local"`), or from
     `run.mode`/`run.harness` *only if* Phase 2#11 persists and rehydrates them.
     Do not key on a re-derived `run.mode`, which defaults to `"dry-run"` on an
     args-omitted `resumeRunId` resume and would silently disable auto-apply on a
     resumed live drain.
   - **[audit]** the resolved workflow source is host/extension-trusted (core
     bundled or extension-registered), not a project/global shadow — see the
     Generic Auto-Apply trust-boundary note.
   - adapter supports auto-apply
   - output is successful drain output
4. Let adapter optionally define `isSuccessfulDrainResult(output)`, but keep generic default based on drain status.
5. Keep `workflow_apply` as normal path for non-drain workflows and failed drains.

Tests:

- Fake autonomous drain auto-applies after successful validation.
- Fake failed drain does not auto-apply.
- Beads successful live drain still auto-applies.
- **[audit]** Resuming an interrupted autonomous-local drain with `resumeRunId`
  only (no `args`) still auto-applies (or fails closed loudly) — it does not
  silently degrade to dry-run.
- **[audit]** A project/global-shadow workflow that names a `supportsAutoApply`
  adapter and declares `drain-autonomous-local` does NOT auto-apply (stops at
  `awaiting-diff-approval`) unless the source is host/extension-trusted.
- Beads failed lane produces failed result and no closeout.
- Apply failure leaves `apply-failed`.
- Domain finalizers do not run before successful primary apply.

### Phase 7: Move Beads Workflow, Command, Skill Assets Out Of Core

Goal: core plugin no longer bundles Beads assets.

Tasks:

1. Move `workflows/beads-drain.js` to Beads extension package/module.
2. Move `commands/beads-drain.md` to Beads extension package/module.
3. Move `skills/beads-drain/SKILL.md` outside the core plugin repo or into Beads extension assets.
4. Remove `BEADS_DRAIN_COMMAND_PATH` from core constants.
5. Remove direct Beads command registration from `configureWorkflowEntrypoints()`.
6. Add extension command registration.
7. Update `workflow_list` to show extension workflows.
8. Update docs to say Beads drain is an example/extension, not core.
9. **[audit] Update core `package.json` test scripts.** After the Beads tests
   move out, the core scripts reference files that no longer exist: drop
   `test:beads-drain` (4 beads test files) and reduce `test:workflow-adapters` to
   just `tests/test-fix-drain-adapter.test.mjs` (it currently also lists
   `tests/beads-drain-adapter.test.mjs`). Relocate the beads test scripts and test
   files into the Beads extension's own `package.json`/`tests/`. (The Testing
   Matrix already lists `test:beads-drain` under the *extension*, post-extraction.)

Tests:

- Core plugin starts without Beads assets.
- **[audit]** `npm test` and the core test scripts pass with **no** dangling
  references to moved beads test files.
- Generic command registry does not include `beads-drain` unless Beads extension loaded.
- With Beads extension loaded, command exists.
- With Beads extension loaded, workflow exists.
- `workflow_run({ name: "beads-drain" })` resolves extension workflow source (and
  **[audit]** fails to resolve when the extension is not loaded — relevant for
  resuming pre-extraction runs).
- Beads skill validation moves to Beads extension tests or global config tests.

### Phase 8: Clean Generic Kernel References

Goal: remove Beads-specific names from production kernel.

Tasks:

1. Remove `isBundledBeadsDrainSource` (workflow-source.js). **[audit] First handle
   its consumer:** the laneTimeoutMs reconciliation at `workflow-plugin.js:1364-1368`
   reads `bundledBeadsDrain` (set from this function at line 1292). Generalize that
   branch to any `meta.harness === "drain"` workflow (and reword its error string)
   or drop it, before/with this removal — otherwise the build breaks on a dangling
   reference and the args `laneTimeoutMs` alias silently disappears.
2. Remove `assertBeadsDrainRuntimeArgsShape` (workflow-source.js).
3. Remove `resolveBeadsDrainMode` (authority-policy.js).
4. Remove `normalizeBeadsDrainWorkflowRunArgs` (authority-policy.js). **[audit]
   Already dead code (imported, never called).**
5. Remove `NON_DRY_BEADS_DRAIN_REQUIRED_GATES` (authority-policy.js).
6. Remove `NON_DRY_BEADS_DRAIN_PERMISSION_GATES` (workflow-plugin.js:183 — a second Beads gate set distinct from #5). **[audit] Dead code; just delete.**
7. Remove `beadsDrainGateStatus` (sandbox-executor.js:218 — replaced by generic drain-gate probe in Phase 3).
8. Remove Beads-specific approval consent text (workflow-plugin.js:604-606 — **[audit]** the original `~603`/`~952` cites were off; the consent text is in the `consent: [...]` array at 604-606, generalized in Phase 6#2).
9. Remove `mutationDomainSummary`'s Beads branch (workflow-plugin.js:411 — replaced by generic drain-mode label in Phase 2).
10. Remove `effectiveWorkflowBackground`'s Beads dependency (workflow-plugin.js:371 — replaced by generic drain check in Phase 2).
11. Remove `authorityArgsForWorkflow`'s Beads-specific clamping (authority-policy.js:313 — generalized in Phase 2).
12. Remove `beadsDrainDelegatesIntegrationGates` Beads-specific bypass (workflow-plugin.js:1444 — must be generalized so the generic drain mode handles its own worktree-isolation delegation).
13. Remove Beads command registration from `configureWorkflowEntrypoints()` (workflow-plugin.js:284).
14. Remove Beads curated invocation hints from `CURATED_INVOCATION_HINTS` (role-template-loading.js:225). **[audit]** Also reword the Beads-naming strings in the same file at lines 28 (comment) and 81 (`note:` template string) to generic drain wording.
15. Remove Beads adapter export from generic kernel barrel (index.js:35).
16. **[audit] Confirm `workflow-kernel/beads-drain-adapter.js` is gone** (moved out under Phase 3 task 2). The whole-file removal is what makes the success grep below pass; verify it is no longer in the kernel.
17. **[audit] Remove the now-dangling import statements** in `workflow-plugin.js`
    whose source definitions were deleted: `BEADS_DRAIN_COMMAND_PATH` (line 10),
    `normalizeBeadsDrainWorkflowRunArgs` (120), `resolveBeadsDrainMode` (121),
    `assertBeadsDrainRuntimeArgsShape` (127), `isBundledBeadsDrainSource` (130).
    Re-run a lint/compile check.
18. **[audit] Reword the remaining Beads-naming comments** so the success grep has
    a known, complete whitelist: `sandbox-executor.js` lines 6, 130, 250-251, 705;
    `workflow-plugin.js` lines 783, 786, 952-953; `event-journal.js` line 249;
    plus `drain-runtime.js:2` (already noted below).

Note: `test-fix-drain-adapter.js` is a non-Beads test fixture and should stay in core. The `drain-runtime.js` comment mentioning "beads-drain wrapper" (line 2) should be reworded to "drain workflow wrapper" but is not logic.

Tests:

- **[audit]** `grep -rin "beads" workflow-kernel/` (recursive — the original `*.js`
  glob skips subdirectories, and the intermediate Target Architecture introduces
  `workflow-domains/beads/`) returns no production logic coupling. Residual matches
  are acceptable only in: (a) `test-fix-drain-adapter.js` (non-Beads test fixture,
  no match expected), and (b) the reworded comments enumerated in task 18. Verify
  each residual match by inspection.
- Full test suite passes.
- Beads extension tests cover all Beads behavior.

### Phase 9: Documentation And OSS Packaging

Goal: document the harness as generic.

Core docs should cover:

- What the workflow harness does.
- How approval hashes work.
- How drain adapters work.
- How to write a drain adapter.
- How domain mutations are staged/finalized.
- How autonomous-local auto-apply works.
- How to register extensions.
- How to package external workflow assets.
- Security model:
  - workflow source is untrusted/approval-bound
  - extension modules are trusted host code
  - child lanes do not get domain mutation authority by default
  - live gates fail closed
  - domain finalization happens after successful apply

Beads docs should move to Beads extension:

- Beads drain usage
- dry-run vs autonomous-local
- gate requirements
- live drain examples
- failure recovery
- Beads mutation ledger behavior

Migration notes should tell local users:

- old `beads-autonomous-local` profile is replaced by `drain-autonomous-local`, or kept as an extension alias temporarily
- explicit live drain should use `args: { "mode": "autonomous-local" }`
- omitted args remain dry-run
- restart OpenCode after plugin/config changes

## Testing Matrix

Core tests:

- extension registry tests
- generic drain runtime tests
- generic authority/mode tests
- generic workflow approval/hash tests
- generic auto-apply tests with fake adapter
- generic domain mutation registry tests
- sandbox host-op tests
- workflow list/source resolution tests
- no Beads references test

Beads extension tests:

- Beads adapter unit tests
- Beads dry-run tests
- Beads live gate fail-closed tests
- Beads successful autonomous-local drain tests
- Beads failed lane tests
- Beads mutation finalizer tests
- Beads command/skill asset tests
- Beads workflow asset tests

Regression commands before extraction:

```text
npm run test:workflow-kernel
npm run test:workflow-adapters
npm run test:beads-drain
npm run test:workflows
npm test
```

Regression commands after Beads moves out:

Core:

```text
npm test
npm run test:workflow-kernel
npm run test:workflows
```

Beads extension:

```text
npm test
npm run test:beads-drain
```

## Resolved Decisions

### 1. Beads Packaging: Defer To Implementation Time

**Decision:** the intermediate-first direction (`workflow-domains/beads/` inside this repo, then extract to a separate package) remains the recommended default, but the final choice is deferred to implementation time. The plugin is already a standalone npm package (`@mcrescenzo/opencode-workflows`, MIT, `publishConfig.access=public`, GitHub repo URL set), and there are zero references to `workflow-domains/` or `opencode-workflows-beads` anywhere in the tree, so either path is viable.

### 2. Old Profile Names: No Aliases Needed

**Decision:** no backward-compatibility aliases. Clean break.

**Evidence:** `beads-dry-run`, `beads-autonomous-local`, and `beads-autonomous-networked` are referenced only inside this plugin's own code, tests, docs, and commands — never in a parent `opencode.json`, parent `AGENTS.md`, or any other plugin (verified by exhaustive `rg` of the entire parent monorepo tree). Users invoke via `workflow_run({ name: "beads-drain", args: { mode: "..." } })`; the profile name is an internal implementation detail that no user ever passes directly. Renaming `beads-dry-run` to `drain-dry-run` changes nothing in any user invocation.

**[audit] Corrected resume mechanism:** the original wording ("resume re-derives
the profile from args/mode") is **inverted**. On resume, the whole `authority`
object — which *contains* the profile name and the frozen `requiredGates` — is
restored verbatim from the persisted `state.json`
(`run-store-rehydrate.js:19`: `run.authority = prior.authority`;
`workflow-plugin.js:1345` takes `priorState.authority` and only calls
`resolveRunAuthority` on a cold start). Persisted runs survive the rename
**because the profile is never re-validated against the profile table on the
resume path**, not because it is re-derived. The conclusion (no aliases needed)
still holds. But the corollary matters for Phase 6: any field that *is*
re-derived from args on resume (e.g. a naive `run.mode`) does **not** behave like
`authority` and can silently change — which is exactly the auto-apply hazard the
Phase 6 audit note addresses.

### 3. Workflow Resolution Order: Project > Global > Extension > Core

**Decision:**

1. project workflows override everything
2. global workflows override extension workflows
3. extension workflows override core examples

This preserves user control. See the Workflow Assets Outside Core section for the full rationale.

### 4. Autonomous Auto-Apply: Generic, Through `drain-autonomous-local` Only

**Decision:** yes, but only through the generic `drain-autonomous-local` profile, with explicit approval text, and only if the registered adapter declares `supportsAutoApply: true`. No Beads-specific auto-apply path survives extraction.

### 5. Core Ships No Real Adapter

**Decision:** ship only `test-fix-drain-adapter.js` as a test fixture. Beads is not bundled as a core example. Maximum OSS cleanliness — the core harness demonstrates the drain contract through tests, not through a shipped production adapter.

### 6. Networked Drain Mode: Drop — But It IS Reachable Today

**Decision:** drop `beads-autonomous-networked` from core with no replacement. Do not add `drain-autonomous-networked` now.

**[audit] Corrected rationale.** The original claim that this profile is "never
reachable through any user invocation path" is **wrong** — it is reachable today:

- The `workflow_run` `profile` argument is `tool.schema.enum(Object.keys(WORKFLOW_AUTHORITY_PROFILES))` (`workflow-plugin.js:2150`), so the schema **accepts** `"beads-autonomous-networked"`.
- `authorityArgsForWorkflow` returns `args` **unchanged** for autonomous-local mode (`authority-policy.js:320`) and uses `args.profile ?? "beads-dry-run"` for dry-run (`:323`) — an explicit profile passes straight through either way.
- `resolveRunAuthority` -> `resolveAuthorityProfile` (`authority-policy.js:277`) then resolves the profile from the table to full `network: true` / `mcp: true` authority.
- The function the original plan cited as the blocker, `normalizeBeadsDrainWorkflowRunArgs` (`:348`), is **dead code** — imported at `workflow-plugin.js:120`, never called. So none of its restrictions apply on the live path.
- `tests/workflow-run.test.mjs:237-244` directly asserts the profile resolves.

So `workflow_run({ name: "beads-drain", profile: "beads-autonomous-networked", args: { mode: "autonomous-local" } })` reaches a network/MCP-capable drain **right now**. We still drop it — shipping a network/MCP drain profile is undesirable — but acknowledge this **removes a currently-reachable (if obscure) profile override**, a minor breaking change, rather than deleting unreachable dead config. If networked drain is needed later, add `drain-autonomous-networked` as a generic profile with the `networkAccess` and `mcpAccess` gates restored.

## Estimated Lift

Minimal core cleanup without extraction: 1-2 days.

Clean generic registry plus Beads module inside same repo: 3-5 days.

Full external Beads extension/package with docs and tests: 5-8 days.

The riskiest pieces are not the adapter code itself. The riskiest pieces are
(**[audit]** each now has a design pointer; the original list named them without
mitigations):

- **Keeping approval hashes stable after arg normalization** — requires one
  bidirectional canonical form (profile <-> mode + `background` default) feeding
  all hash/authority/background/summary/body consumers, with a hash-equality test
  for the two invocation forms (see Generic Drain Authority Model).
- **Preserving resume behavior** — `authority` is persisted and read back verbatim;
  any new field Phase 6 depends on (`run.mode`/`run.harness`) must either be
  persisted+rehydrated or the gate must read the persisted authority instead
  (see Phase 2#11 / Phase 6). Editing+moving the workflow source changes its
  `sourceHash`, so drain in-flight runs before extraction (see Phase 0#5).
- **Ensuring auto-apply remains safe and explicit** — keep auto-apply enablement
  bound through the already-hashed `authority.profile`/`runtimeArgs.mode`; do not
  add a new hashed envelope field without a version bump (see Phase 6#1).
- **Preventing unregistered/untrusted workflows from gaining domain-mutation
  authority** — Principle 4 covers registration, not invocation; the generic
  auto-apply predicate must additionally require a host/extension-trusted source so
  a project/global shadow cannot trigger trusted-adapter mutation + auto-apply (see
  Generic Auto-Apply trust-boundary note).
- **Avoiding import cycles** — make the registry a strict import-leaf holding
  function references, loaded via dynamic `import()`; this *removes* the existing
  `event-journal <-> beads-drain-adapter` lazy-import cycle (see Phase 1#9).
- **[audit] Confirming opencode actually delivers per-plugin `options` at runtime**
  — the entire extension seam depends on it; the SDK *type* declares it but the
  generated server schema does not, and no plugin uses the tuple form today. Spike
  it in Phase 0 and define a fallback channel that fails loud (see Phase 0#4,
  Phase 1#10).
- **[audit] Reconciling the registry with double-instantiation** — a module-level
  "reject duplicate adapters" singleton throws on the second factory call; key it
  per-`pluginContext` or make registration idempotent (see Phase 1#8).

## Definition Of Done

Core plugin is done when:

- no production `workflow-kernel` module contains Beads-specific logic
- **[audit]** `workflow-kernel/beads-drain-adapter.js` no longer exists in the kernel (the whole 745-line file moved to the Beads extension)
- core supports registered drain adapters
- core supports generic autonomous local drain
- **[audit]** the drain trigger (`meta.harness === "drain"`) is set on the drain workflow and the generic mode/background/auto-apply paths actually fire for it
- core supports registered domain mutation finalizers
- core supports extension-provided workflow/command assets
- all approval, status, background, cancellation, apply, and resume behavior works with a fake generic adapter
- **[audit]** resuming an autonomous-local drain with `resumeRunId` only still auto-applies (no silent downgrade to dry-run)
- **[audit]** the two equivalent invocation forms (top-level profile vs `args.mode`) produce identical approval hashes
- Beads behavior works only through the Beads extension
- **[audit]** core `package.json` test scripts have no dangling references to moved Beads test files
- omitted Beads args still dry-run
- explicit autonomous-local Beads mode actually drains live
- docs describe the generic harness first and Beads only as an extension/example
