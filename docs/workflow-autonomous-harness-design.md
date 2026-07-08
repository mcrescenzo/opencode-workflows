# OpenCode Autonomous Workflow Harness Design

> Status: **Historical design snapshot**. This document captured the Phase 1 contract
> before the implementation was split into `workflow-kernel/` modules and bundled
> workflow assets. It remains useful for boundaries and terminology, but current
> operator behavior is documented in the README, skills, and tests. Several
> symbols below (`workflow_live_gates`, `promoteCapabilities`, `liveGateReport`)
> and the beads domain were subsequently removed (see CHANGELOG 0.2.0).

`docs/workflow-autonomous-harness-plan.md` is the roadmap. This document is
the Phase 1 implementation contract for the reusable autonomous harness and its
domain adapters. It freezes boundaries and schemas so later implementation
beads can extract modules, add integration mode, and build `beads-drain`
without moving domain behavior into the generic kernel.

## Purpose And Scope

The harness must support drain-style autonomous programs that discover work,
execute isolated implementation lanes, integrate verified changes, mutate the
domain only from trusted host code, and stop only after a fresh dry proof.

The same kernel must support both:

| Domain | Adapter Example | Dry Condition |
| --- | --- | --- |
| Beads backlog | `beads-drain` | No autonomous Beads work remains in scope after fresh readback. |
| Test repair | `test-fix-drain` | No discovered failing tests remain, or remaining failures are human-gated. |

## Current Architecture Baseline

The current implementation is intentionally still a single plugin file at
`opencode-workflows.js`. Phase 1 documents the target boundary; it does not change
runtime behavior.

Important current symbols to preserve through extraction:

| Area | Current Symbols |
| --- | --- |
| Plugin and tools | `WorkflowPlugin`, `workflow_run`, `workflow_status`, `workflow_apply`, `workflow_live_gates` |
| Start and execution | `startWorkflow`, `runWorkflowExecution`, `executeSandbox` |
| Child lanes and nesting | `runChildAgent`, `runNestedWorkflow` |
| Capabilities and live gates | `createCapabilityAdapter`, `promoteCapabilities`, `liveGateReport` |
| Authority | `resolveRunAuthority`, `resolveLanePolicy`, `permissionRulesForAuthority`, `approvalEnvelope`, `approvalHash` |
| Run state | `runRoot`, `runRoots`, `runDirForRoot`, `writeState`, `appendEvent`, `appendJournal`, `recordLaneOutcome` |
| Patch-plan edit mode | `createEditWorktree`, `cleanupWorktrees`, `applyWorkflow` |

Current edit mode is a patch-plan workflow. It creates temporary edit
worktrees, collects structured patches, removes the worktrees when sandbox
execution finishes, and applies patch plans through `workflow_apply` after hash
verification. Autonomous drains need durable lane and integration worktrees, so
integration mode must coexist with patch-plan mode instead of replacing it.

## Workflow Script API

Current guest workflow scripts run in the QuickJS sandbox owned by
`executeSandbox`. Existing globals and scoped helpers are:

| API | Responsibility |
| --- | --- |
| `args` | Runtime arguments bound into the approval envelope. |
| `agent(prompt, opts)` | Spawn one child lane through `runChildAgent`. |
| `parallel(thunks, options)` | Run scoped fan-out lanes with budget and outcome accounting. Each callback must declare the injected scope parameter for concurrency; zero-arg callbacks fail unless `{ sequential: true }` is explicit. |
| `pipeline(items, ...stages)` | Run staged scoped fan-out work. Each stage must declare a context parameter for concurrency; zero-arg stages fail unless `{ sequential: true }` is explicit. |
| `workflow(nameOrPath, args)` | Run an approved named or heuristic inline nested workflow through `runNestedWorkflow`. |
| `workflow({ source, args })` | Run an explicitly inline nested workflow source; `source` must be a static string literal so approval can snapshot it. |
| `workflow({ name, args })` | Run an explicitly named nested workflow; `name` must be a static string literal. |
| `phase(name)` | Update run phase and event state. |
| `log(message)` | Append a redacted run event. |
| `budget` | Read live and replayed token, cost, and agent budget state. |

The target drain API is a trusted host primitive exposed to saved workflows:

```js
return await drain({
  adapter: "beads",
  scope: args.scope ?? { mode: "all" },
  inProgressPolicy: "conservative",
  stop: { untilDry: true },
});
```

Workflow scripts configure the drain. They do not implement custom worktree,
merge, child-session, Beads shell, or closeout plumbing.

## Kernel Responsibilities

The kernel owns execution mechanics that are independent of the work domain:

| Responsibility | Contract |
| --- | --- |
| Sandbox lifecycle | Parse workflow source, bind deterministic guest APIs, enforce host-call limits, and record result or failure state. |
| Approval and replay safety | Include source, runtime args, authority, budgets, model, capabilities, base commit, and nested snapshots in approval hashes. |
| Authority and permissions | Resolve workflow authority, lane authority, secret-deny rules, and later command-scoped shell allow/deny policy. |
| Capability gates | Detect capability shape, promote with live probes when required, and fail closed when required gates are unavailable or unverified. |
| Child lanes | Spawn, monitor, timeout, abort, retry, collect structured output, and record lane outcomes. |
| Budgets | Enforce max agents, concurrency, token ceiling, and cost ceiling. |
| Durable state | Maintain state files, events, journals, lane ledgers, integration ledgers, validation ledgers, domain ledgers, and closeout reports. |
| Worktrees | Create, root, diff, commit, merge, rebase, preserve, remove, and recover lane and integration worktrees. |
| Integration | Detect path overlap, merge path-disjoint lane commits, route conflicts to repair, run central validation, and hash-gate primary writes. |
| Repair orchestration | Spawn repair lanes or human-gate ambiguous conflicts, validation failures, and unsafe states. |
| Status and cleanup | Report active, completed, corrupt, ambiguous, and cancelled runs without losing recovery evidence. |

The kernel must not know Beads issue fields, test framework syntax, external
tracker semantics, or domain-specific closeout rules.

## Adapter Responsibilities

Adapters own domain semantics and expose a stable callback contract to the
kernel:

```ts
type DrainAdapter = {
  discover(scope): Promise<DomainSnapshot>;
  classify(item): Promise<"ready" | "blocked" | "human-gated" | "external" | "done">;
  claim(item): Promise<DomainMutationRecord>;
  buildLanePacket(item): Promise<LanePacket>;
  validate(item, integrationState): Promise<ValidationReport>;
  close(item, evidence): Promise<DomainMutationRecord>;
  createFollowup(finding): Promise<DomainMutationRecord>;
  proveDry(scope): Promise<DryProof>;
};
```

Adapter duties:

| Duty | Beads Adapter | Test-Fix Adapter |
| --- | --- | --- |
| Discover | Read `bd ready`, in-progress issues, dependency diagnostics, and scope filters. | Run or inspect failing-test discovery. |
| Classify | Apply LLM-ready, ownership, dependency, and human-gate policy. | Group deterministic failures, flaky/ambiguous failures, and environment failures. |
| Claim | Host-side `bd update <id> --claim` with readback. | Reserve a failure group in the run state. |
| Lane packet | Include issue context, acceptance, files, constraints, and validation commands. | Include failing tests, reproduction command, relevant files, and constraints. |
| Validate | Check issue acceptance evidence against integrated diff and commands. | Run central tests and verify the failure group is fixed. |
| Close | Host-side note and close with validation evidence. | Mark failure group fixed in run state. |
| Follow-up | Create/link Beads follow-up work. | Record a new failure group or human-gated repair item. |
| Prove dry | Fresh Beads readback proves no autonomous work remains. | Fresh failing-test discovery proves no autonomous failures remain. |

## Privileged Host-Side Adapter Operations

Domain mutations happen in trusted host-side adapter methods. Child lanes never
receive broad domain mutation authority. For Beads, child lanes may inspect
context but must not receive shell authority for `bd update`, `bd close`,
`bd create`, `bd dep add`, `bd dolt`, or destructive Git commands.

Beads host operations:

| Operation | Kind | Notes |
| --- | --- | --- |
| `bd where` | read | Proves active database scope. |
| `bd status --json` | read | Captures queue and in-progress summary. |
| `bd ready --json --limit 1000 --exclude-type epic` | read | Candidate discovery; host must filter out epics if CLI flags are unreliable. |
| `bd show <id> --json` | read | Full issue context and readback after mutation. |
| `bd dep cycles` | read | Graph safety diagnostic. |
| `bd lint` | read | Convention diagnostic. |
| `bd orphans` | read | Dependency diagnostic. |
| `bd find-duplicates` | read | Duplicate diagnostic. |
| `bd update <id> --claim` | mutate | Claim before spawning implementation. |
| `bd update <id> --append-notes ...` | mutate | Record validation, blocker, and closeout evidence. |
| `bd close <id> --reason ...` | mutate | Close only after central validation. |
| `bd create ...` | mutate | Create actionable follow-ups with context. |
| `bd dep add <issue> <depends-on>` | mutate | Link follow-ups or blockers with explicit direction. |

Every mutating operation writes a `domain-ledger.jsonl` record containing the
run id, item id, command intent, redacted arguments, before snapshot, after
readback, result, and error if any. A mutation is not considered complete until
the adapter records the fresh readback.

## Lane And Validation Report Schemas

Implementation lanes return structured `LaneReport` objects:

```ts
type LaneReport = {
  itemId: string;
  outcome: "implemented" | "blocked" | "needs-research" | "failed" | "no-op";
  summary: string;
  filesChanged: string[];
  commandsRun: { command: string; result: "passed" | "failed" | "not-run"; summary: string }[];
  acceptanceEvidence: string[];
  residualRisks: string[];
  followups: { title: string; description: string; labels?: string[] }[];
  requestedHumanDecision?: string;
  readyForIntegration: boolean;
};
```

Central validation returns `ValidationReport` objects:

```ts
type ValidationReport = {
  itemId: string;
  accepted: boolean;
  reason: string;
  acceptanceChecklist: { item: string; satisfied: boolean; evidence: string }[];
  validationCommands: { command: string; result: "passed" | "failed"; summary: string }[];
  diffScopeOk: boolean;
  followupsHandled: boolean;
};
```

The kernel validates these schemas before integration or closeout. The adapter
interprets domain-specific acceptance evidence; the kernel only enforces shape,
lane outcome, integration readiness, and validation flow.

## Run State Files

Current run roots are resolved through `runRoot`, `runRoots`, and
`runDirForRoot`. Current run files include:

```text
.opencode/workflows/runs/<run-id>/state.json
.opencode/workflows/runs/<run-id>/events.jsonl
.opencode/workflows/runs/<run-id>/journal.jsonl
.opencode/workflows/runs/<run-id>/script.js
.opencode/workflows/runs/<run-id>/result.json
.opencode/workflows/runs/<run-id>/diff-plan.json
.opencode/workflows/runs/<run-id>/apply-ledger.jsonl
```

Autonomous drains add durable recovery files:

```text
.opencode/workflows/runs/<run-id>/worktrees.json
.opencode/workflows/runs/<run-id>/waves/
.opencode/workflows/runs/<run-id>/lanes/
.opencode/workflows/runs/<run-id>/integration-ledger.jsonl
.opencode/workflows/runs/<run-id>/validation-ledger.jsonl
.opencode/workflows/runs/<run-id>/domain-ledger.jsonl
.opencode/workflows/runs/<run-id>/closeout.json
```

State file ownership:

| File | Owner | Purpose |
| --- | --- | --- |
| `state.json` | Kernel | Run status, approval envelope summary, budgets, capabilities, active phase, and result paths. |
| `events.jsonl` | Kernel | User-visible progress and lifecycle events. |
| `journal.jsonl` | Kernel | Child lane calls, replay keys, outcomes, retries, and failures. |
| `worktrees.json` | Kernel | Lane and integration worktree paths, branches, commits, dirty state, and cleanup state. |
| `waves/` | Kernel | Wave plans, claim sets, lane assignments, and wave outcomes. |
| `lanes/` | Kernel | Lane packets, structured reports, stdout/stderr summaries, and repair links. |
| `integration-ledger.jsonl` | Kernel | Merge, cherry-pick, conflict, repair, validation, and primary-write records. |
| `validation-ledger.jsonl` | Kernel plus adapter | Validation commands, reports, failures, and retry decisions. |
| `domain-ledger.jsonl` | Adapter | Claims, notes, closes, follow-ups, dry checks, and domain readbacks. |
| `closeout.json` | Kernel plus adapter | Final report, dry proof, validation summary, residual risks, and cleanup state. |

## Worktree Lifecycle

Patch-plan edit mode keeps its current lifecycle:

```text
approve workflow -> create temporary edit worktree -> collect patch plan ->
cleanup temporary worktree -> await workflow_apply -> hash-gated primary write
```

Integration mode uses durable worktrees:

```text
preflight Git repo -> create lane branch/worktree -> run lane -> commit lane
diff -> merge or cherry-pick into integration branch/worktree -> validate ->
apply or merge to primary after proof -> cleanup only safe completed worktrees
```

Recommended paths:

```text
.opencode/workflows/worktrees/<run-id>/<lane-id>/
.opencode/workflows/integration/<run-id>/
```

Recommended branches:

```text
workflow/<run-id>/<lane-id>
workflow/<run-id>/integration
```

Dirty, ambiguous, missing, or externally modified worktrees are preserved and
reported. Cleanup never force-removes ambiguous worktrees by default.

## Integration Lifecycle

Integration mode state machine:

```text
preflight
snapshot
classify
plan_wave
claim
spawn_lanes
monitor
collect_reports
integrate
validate
repair
close
discover_followups
resnapshot
final_audit
complete
```

Integration rules:

| Step | Contract |
| --- | --- |
| Path analysis | Detect overlapping paths before automatic merge. |
| Lane commit | Only `readyForIntegration` lanes with acceptable reports produce lane commits. |
| Merge order | Path-disjoint lanes can merge automatically; ordered or overlapping lanes need explicit policy. |
| Conflict | Conflict records enter repair or review state and preserve worktrees. |
| Validation | Central validation runs in the integration worktree after each wave. |
| Bisection | Failed central validation identifies a culprit lane or wave before closeout. |
| Primary write | Final primary mutation is hash-gated and ledgered, using `workflow_apply` as the current safety precedent. |

## Repair Lifecycle

Repair is orchestration, not a separate domain. The kernel decides when repair
is needed; adapters decide whether the domain item remains autonomous.

Repair cases:

| Case | Kernel Behavior | Adapter Behavior |
| --- | --- | --- |
| Merge conflict | Preserve lane and integration state, spawn conflict repair lane or mark review-required. | Include domain context and acceptance constraints in repair packet. |
| Validation failure | Record failed command, bisect wave when possible, spawn repair lane. | Decide if failure still belongs to the item or requires follow-up. |
| Lane failed | Record lane failure and retry within budget or mark failed. | Decide whether to append blocker notes, create follow-up, or leave item open. |
| Human decision requested | Stop auto-close and report `requestedHumanDecision`. | Mark item human-gated when domain policy requires it. |

Recovery cases the durable state must support:

```text
active lane child missing
lane worktree exists with uncommitted changes
lane branch committed but not integrated
integration merge started but not completed
validation started but not completed
domain claim made but lane failed
domain close started but readback missing
primary apply started but not completed
```

Recovery is conservative: do not duplicate domain mutations, do not discard
unmerged work, and do not declare dry state from stale snapshots.

## Final Dry-Proof Semantics

A drain is complete only after a fresh domain snapshot proves no autonomous work
remains in the requested scope. Dry proof is never inferred from the absence of
work launched in the last wave.

Beads dry proof requires:

| Requirement | Evidence |
| --- | --- |
| Correct database | Fresh `bd where` readback. |
| Queue state | Fresh `bd ready --json --limit 1000 --exclude-type epic` readback plus host-side epic filtering when needed. |
| In-progress state | Fresh in-progress scan and readbacks for any claimed issues in scope. |
| Graph health | `bd dep cycles`, `bd lint`, `bd orphans`, and duplicate checks when configured by the adapter. |
| Mutation consistency | `domain-ledger.jsonl` has completed readbacks for each claim, note, close, follow-up, and dry check. |
| Human-gated remainder | Any remaining work is explicitly classified as blocked, external, non-LLM-ready, or `needs-human`. |

`test-fix-drain` dry proof requires a fresh failure-discovery run in the
integration or primary verification context. Remaining failures must be either
outside scope, non-deterministic/environmental with evidence, or explicitly
human-gated.

## Adapter Genericity Check

| Kernel Concept | Beads Adapter | Test-Fix Adapter |
| --- | --- | --- |
| Item id | Beads issue id | Test failure group id |
| Snapshot | Ready/in-progress issue sets | Current failing-test set |
| Claim | `bd update --claim` | Reserve failure group in run state |
| Lane packet | Issue context and acceptance | Failing test output and reproduction command |
| Integration | Merge issue implementation diff | Merge repair diff |
| Validation | Issue-specific commands and acceptance evidence | Central test command |
| Closeout | Notes plus `bd close` | Mark group fixed in closeout report |
| Dry proof | Fresh no-ready/no-autonomous Beads readback | Fresh no-failing-tests or human-gated remainder |

If a proposed kernel API needs a Beads field name or a test framework field
name, it belongs in an adapter instead.

## Non-Goals For This Phase

This document does not implement code extraction, command-scoped authority,
live gate probes, durable worktrees, integration mode, the generic drain
runtime, the Beads adapter, the `test-fix-drain` adapter, workflow commands,
skills, or CLI user experience. Those are later beads. This phase only defines
the contracts they must follow.
