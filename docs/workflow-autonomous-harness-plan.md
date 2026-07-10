# OpenCode Autonomous Workflow Harness Plan

> Status: **roadmap / planning**. Historical moonshot plan retained for context;
> current shipped behavior is defined by source, tests, README, and `docs/workflow-plugin.md`.
> Note: the beads domain (Phases 9–10) and the live-gate subsystem described below
> were implemented and later **removed** (see CHANGELOG 0.2.0); the plugin now
> ships zero bundled domain adapters or domain drain workflows, plus one
> domain-neutral bundled workflow and command (`deep-research`).

This plan describes the moonshot target for evolving the local OpenCode workflow system into a generic autonomous execution harness, then implementing `beads-drain` as the first serious domain adapter and reusable workflow.

The goal is not a bigger workflow script runner. The goal is a reusable kernel plus adapter platform that can drain Beads backlogs, fix failing tests, execute migrations, process issue queues, remediate audit findings, and run other autonomous programs with durable state, worktree isolation, central verification, and explicit stop conditions.

## Recommendation

Build the workflow plugin into a generic autonomous execution harness, then implement `beads-drain` as a thin domain adapter and workflow.

Target stack:

```text
workflow plugin/tool surface
workflow kernel
generic drain runtime
trusted domain adapter registry
beads adapter
beads-drain workflow/skill/command
optional /goal supervision
```

The kernel owns execution mechanics. Domain adapters own domain semantics. Privileged domain mutations, such as `bd close`, should be host-side adapter operations, not arbitrary workflow JavaScript with broad shell access.

## Current-State Evidence

The existing workflow plugin already has important primitives worth preserving:

| Area | Current Capability |
|---|---|
| Approval | Source and runtime-envelope approval hashes. |
| Sandbox | QuickJS workflow runtime with restricted globals. |
| Child lanes | OpenCode child sessions with structured output support. |
| State | Run state, event journal, lane outcome journal, status tools. |
| Roles | Explorer, skeptic, verifier, synthesizer, implementer role prompts. |
| Budgets | Agent count, concurrency, token, and cost ceilings. |
| Background | In-process background execution, status, cancellation, and idle-gated completion notifications. |
| Edit mode | Patch-plan edit/apply flow with hash-gated primary writes. |

The current plugin is still short of the moonshot autonomous harness:

| Gap | Why It Matters |
|---|---|
| Boolean shell authority | `shell: true` is too broad for autonomous child lanes. |
| Permission gates mostly unverified | Shape detection is not proof that denied actions are actually denied. |
| Worktree API blocked in current runtime | Edit isolation cannot be assumed available. |
| Patch-plan edit model | Drain-style work needs real Git worktree diffs, merges, rebases, and repair. |
| Disposable edit worktrees | Autonomous integration needs durable lane and integration worktrees. |
| One-shot run lifecycle | Drain programs need durable loop state, recovery, and domain ledgers. |
| No domain adapter layer | Beads semantics should not be hard-coded into generic workflow logic. |
| No generic drain primitive | Each drain workflow would otherwise reimplement scheduling, repair, and stop logic. |

## Architecture Boundaries

### Kernel Responsibilities

| Area | Kernel Owns |
|---|---|
| Run lifecycle | Start, pause, resume, cancel, recover, report, cleanup. |
| Child lanes | Spawn, monitor, timeout, abort, collect structured reports. |
| Permissions | Tool policy, command-scoped bash, secret denies, live gates. |
| Worktrees | Create, root, diff, commit, merge, rebase, cleanup, recover. |
| Integration | Lane commits, integration branch, conflict handling, validation. |
| Drain loop | Discover, classify, plan, execute, verify, repair, close, prove dry. |
| Durability | State files, event journal, lane ledger, integration ledger. |
| Status | Compact/full status, final reports, redaction. |

### Domain Adapter Responsibilities

| Area | Adapter Owns |
|---|---|
| Work discovery | What work items exist in the selected scope. |
| Classification | Ready, blocked, ambiguous, human-gated, stale, external. |
| Claiming | Domain-specific reservation or claim semantics. |
| Lane packet | Prompt/context for worker agents. |
| Validation | Item-specific acceptance checks. |
| Closeout | Mark item done or record blocked state. |
| Follow-ups | Create or link discovered work. |
| Dry proof | Prove no autonomous work remains in scope. |

### Beads Adapter Responsibilities

For Beads, the adapter maps domain operations to controlled host-side `bd` operations:

```text
bd where
bd status --json
bd ready --json --limit 1000 --exclude-type epic
bd show <id> --json
bd update <id> --claim
bd update <id> --append-notes ...
bd close <id> --reason ...
bd create ...
bd dep add ...
bd dep cycles
bd lint
bd orphans
bd find-duplicates
```

Beads adapter policy:

```text
local-only by default
controller-only Beads writes
conservative in-progress continuation
LLM-ready classification
human-gate unclear ownership
central verification before close
fresh Beads readback after every mutation
fresh dry proof before completion
```

## Proposed Module Layout

```text
opencode-workflows.js
workflow-kernel/capabilities.js
workflow-kernel/authority.js
workflow-kernel/runs.js
workflow-kernel/journal.js
workflow-kernel/children.js
workflow-kernel/structured-output.js
workflow-kernel/worktrees.js
workflow-kernel/integration.js
workflow-kernel/drain.js
workflow-kernel/adapters.js
workflow-adapters/beads.js
workflow-adapters/test-fix.js
workflows/beads-drain.js
commands/beads-drain.md
skills/beads-drain/SKILL.md
```

`opencode-workflows.js` remains the plugin/tool surface and compatibility wrapper. The autonomous harness logic moves behind kernel module boundaries.

## Workflow API Target

A future `beads-drain` workflow should be small because it delegates execution mechanics to the harness:

```js
export const meta = {
  name: "beads-drain",
  description: "Drain autonomous Beads work in scope.",
  harness: "drain",
  adapter: "beads",
  authority: {
    worktreeEdit: true,
    domainMutation: ["beads"],
    primaryWrite: "auto-after-verification"
  },
  maxImplementationLanes: 4,
  maxResearchLanes: 12
};

return await drain({
  adapter: "beads",
  scope: args.scope ?? { mode: "all" },
  inProgressPolicy: "conservative",
  stop: { untilDry: true }
});
```

The workflow source should not include custom worktree, merge, child-session, or Beads shell plumbing.

## Authority Model

Replace boolean shell authority with command-scoped policy.

Example:

```json
{
  "shell": {
    "allow": [
      "git status*",
      "git diff*",
      "git rev-parse*",
      "npm test*",
      "bd ready *",
      "bd show *",
      "bd status *"
    ],
    "deny": [
      "git push*",
      "git reset --hard*",
      "bd close *",
      "bd update *",
      "bd create *",
      "bd dolt *"
    ]
  }
}
```

Required wiring:

```text
approval summary
approval hash
lane signature
journal record
status detail
live gate report
tests
```

For Beads, controller mutations should use trusted host-side adapter methods. Child lanes should not receive Beads mutation authority.

## Worktree And Integration Model

Keep current patch-plan mode for small review workflows. Add integration mode for autonomous drains.

Integration mode uses:

```text
primary worktree
integration worktree per run
lane worktree per implementation item
lane branch per item
local commit per successful lane
merge/cherry-pick into integration
central validation in integration
repair/bisect if validation fails
hash-gated final apply/merge to primary
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

## Durable Run State

Autonomous runs need more than the current one-shot workflow result state.

Run directory:

```text
.opencode/workflows/runs/<run-id>/state.json
.opencode/workflows/runs/<run-id>/events.jsonl
.opencode/workflows/runs/<run-id>/journal.jsonl
.opencode/workflows/runs/<run-id>/worktrees.json
.opencode/workflows/runs/<run-id>/waves/
.opencode/workflows/runs/<run-id>/lanes/
.opencode/workflows/runs/<run-id>/integration-ledger.jsonl
.opencode/workflows/runs/<run-id>/validation-ledger.jsonl
.opencode/workflows/runs/<run-id>/domain-ledger.jsonl
.opencode/workflows/runs/<run-id>/closeout.json
```

The `domain-ledger.jsonl` is essential. For Beads it records claims, notes, closes, created follow-ups, dry checks, and readbacks. Other adapters record their equivalent mutations.

## Generic Drain Runtime

Add a trusted `drain()` primitive.

State machine:

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

Adapter callback contract:

```ts
discover(scope)
classify(item)
claim(item)
buildLanePacket(item)
validate(item, integrationState)
close(item, evidence)
createFollowup(finding)
proveDry(scope)
```

Lane report schema:

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

Validation report schema:

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

## Implementation Plan

### Phase 1: Architecture Spec

Create a design document that locks the kernel and adapter boundaries.

Include:

```text
workflow script API
kernel-owned responsibilities
domain adapter responsibilities
host-side privileged adapter operations
lane report schemas
run state files
worktree lifecycle
integration lifecycle
repair lifecycle
final dry-proof semantics
```

Acceptance:

```text
The design can describe beads-drain and test-fix-drain without adding domain concepts to the kernel.
```

### Phase 2: Extract Kernel Modules

Refactor current `opencode-workflows.js` into reusable internals without changing behavior.

Extract:

```text
capability adapter
authority/policy resolution
approval hashing
run store/status
event/journal helpers
child session runner
structured output helpers
budget accounting
background/cancel logic
worktree/apply helpers
role/template loading
```

Acceptance:

```text
npm run test:workflows passes with no intended behavior change.
```

### Phase 3: Command-Scoped Authority

Replace boolean shell authority with scoped command policy.

Required wiring:

```text
approval summary
approval hash
lane signature
journal record
status detail
live gate report
tests
```

Acceptance:

```text
Mock tests prove resolved policy contains expected allow/deny rules.
Live gate proves denied bash command is actually denied.
```

### Phase 4: Behavioral Live Gates

Upgrade `workflow_live_gates` from shape checks to behavioral proof.

Required gates:

| Gate | Must Prove |
|---|---|
| permissionEnforcement | Denied tools fail. |
| commandScopedBash | Allow/deny patterns work. |
| secretReadDeny | Secret globs cannot be read. |
| structuredOutput | Native structured result appears and validates. |
| worktreeApi | Worktree create/list/remove works. |
| directoryRooting | Child runs inside assigned directory. |
| worktreeIsolation | Child edit stays in lane worktree. |
| backgroundContinuation | Background run continues after tool return. |
| workflowCompletionNotification | Completion notice is delivered to the invoking session after `session.idle`. |
| cancellation | Abort stops active child or reports inability. |

Acceptance:

```text
workflow_live_gates({ format: "json" }) reports verified evidence, not just available-unverified.
```

### Phase 5: Worktree Adapter

Build first-class worktree operations.

Support native OpenCode worktree API first. Add raw `git worktree` fallback because the current runtime may not expose the native API.

Generic operations:

```text
createLaneWorktree
createIntegrationWorktree
status
diff
commit
merge
cherryPick
rebase
remove
recover
```

Acceptance:

```text
Scratch repo test creates two lane worktrees and one integration worktree, commits lane changes, merges them, validates final state, and cleans up safely.
```

### Phase 6: Integration Mode

Keep patch-plan mode for small workflows. Add integration mode for autonomous drains.

Integration mode supports:

```text
branch per lane
commit per successful lane
integration branch/worktree
path overlap detection
merge ordering
conflict repair lanes
central validation
failed-wave bisection
hash-gated primary apply or auto-apply after verification
integration ledger
```

Acceptance:

```text
Path-disjoint lanes merge automatically.
Conflicting lanes enter repair/review.
Validation failure identifies culprit lane or wave.
Primary writes are hash-gated and ledgered.
```

### Phase 7: Durable Autonomous Runs

Extend run state for long-lived autonomous execution.

Recovery cases to support:

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

Acceptance:

```text
A run can be paused, resumed, cancelled, reconciled after restart, and reported without losing lane/worktree/domain mutation state.
```

### Phase 8: Generic Drain Runtime

Implement the `drain()` primitive and adapter contract.

Acceptance:

```text
A fake in-memory adapter drains a seeded queue with success, failure, retry, follow-up, and dry proof under mocked tests.
```

### Phase 9: Beads Adapter

Implement trusted host-side Beads operations and Beads-specific policies.

Acceptance:

```text
Child lanes cannot mutate Beads.
Every Beads mutation is journaled.
Closed beads have validation evidence.
Final dry proof includes fresh ready and in-progress scans.
```

### Phase 10: Beads-Drain Workflow, Skill, And Command

Add:

```text
workflows/beads-drain.js
skills/beads-drain/SKILL.md
commands/beads-drain.md
```

The workflow should only configure the generic drain runtime.

The skill should explain:

```text
when to use beads-drain
scope options
local-only default
in-progress policy
what final dry proof means
how /goal can supervise it
how to interpret reports
```

Acceptance:

```text
The workflow source contains no custom worktree, merge, child-session, or Beads shell plumbing.
```

### Phase 11: Non-Beads Proof Adapter

Implement one non-Beads adapter to prove the harness is generic.

Recommended first adapter: `test-fix-drain`.

It should:

```text
discover failing tests
group failures
spawn repair lanes
merge repairs
run central suite
repair validation failures
stop when green or human-gated
```

Acceptance:

```text
The same drain kernel supports Beads and test-fix drains without Beads-specific branches.
```

### Phase 12: Goal Integration

Use `/goal` as outer supervision only.

Example:

```text
/goal "Run beads-drain until its report proves no autonomous Beads work remains"
```

`/goal` should verify transcript-visible evidence, but it should not own scheduling, merging, Beads mutation, or worktree state.

## Testing Plan

### No-Token Tests

Add or expand local test commands:

```text
npm run test:workflows
npm run test:workflow-kernel
npm run test:workflow-adapters
npm run test:beads-drain
```

(`test:beads-drain` shipped with the beads domain and was removed with it; see
CHANGELOG 0.2.0.)

Coverage:

| Category | Examples |
|---|---|
| Authority | Command allow/deny, secret denies, unknown tools denied. |
| Live gate formatting | Verified vs unverified vs blocked. |
| Worktree adapter | Create, status, diff, commit, merge, recover. |
| Integration | Disjoint merge, conflict, validation failure, bisection. |
| Drain runtime | Fake queue, retries, follow-ups, dry proof. |
| Beads adapter | Parse JSON, classify, claim/close journal, dry proof. |
| Status | Compact/full redaction, domain ledgers, run recovery. |
| Cleanup | Preserve ambiguous worktrees and failed runs. |

### Scratch Repo Tests

Use temporary Git repos.

Scenarios:

```text
single lane commit merges
two disjoint lane commits merge
two conflicting lane commits require repair
central validation fails then repair succeeds
primary dirty state rejects unsafe apply
restart recovers integration worktree state
cleanup refuses dirty/ambiguous worktrees
```

### Scratch Beads Tests

Use temporary repos with temporary Beads databases.

Scenarios:

```text
one ready bead drains and closes
two path-disjoint beads run in parallel
stale in-progress continues under policy
externally owned in-progress becomes human-gated
child attempts bd close and is denied
follow-up bead is created and linked
validation failure prevents close
final dry proof catches remaining ready work
```

### Live OpenCode Tests

These spend tokens or need an active server. Keep them opt-in.

Required live gates:

```text
child permission denial
command-scoped bash denial
structured output round trip
worktree create/remove/rooting
child edit isolation
background continuation
workflow completion notification
cancellation
```

### Dogfood Sequence

1. Run fake adapter drain.
2. Run test-fix drain on a seeded scratch repo.
3. Run Beads drain on a scratch Beads repo.
4. Run Beads drain on a small scoped real label with manual final apply.
5. Run Beads drain on a larger scope with auto-after-verification authority.
6. Run full Beads backlog drain only after all gates are verified.

## Definition Of Working

The system is working when all of these are true:

```text
workflow_live_gates reports verified permission, command-scoped bash, structured output, worktree rooting, background, and cancellation evidence
background notifications remain process-local, idle-gated, and recoverable through workflow_status
generic drain fake adapter passes no-token tests
test-fix drain proves non-Beads generality
beads adapter drains scratch Beads backlog to dry
child lanes cannot mutate Beads
parallel lane worktrees do not collide
integration repair handles conflicts or reports review-required
central validation gates closeout
final dry audit catches remaining autonomous work
restart/reconcile preserves run state without duplicate domain mutations
cleanup preserves ambiguous worktrees and removes only safe artifacts
```

## Release Gates

Do not call the system autonomous-drain capable until all of these pass:

```text
command-scoped permission enforcement live-verified
worktree rooting live-verified
integration mode tested in scratch repos
domain mutation ledger implemented
restart/reconcile semantics tested
beads adapter proves dry state
non-Beads drain proves generality
```

## Implementation Order

1. Design spec and module boundaries.
2. Mechanical extraction from `opencode-workflows.js`.
3. Command-scoped authority.
4. Behavioral live gates.
5. Worktree adapter with raw-git fallback.
6. Integration mode.
7. Durable autonomous run state.
8. Generic `drain()` runtime.
9. Beads adapter.
10. `beads-drain` workflow/skill/command.
11. Non-Beads proof adapter.
12. Live and dogfood verification.
13. Documentation updates.
