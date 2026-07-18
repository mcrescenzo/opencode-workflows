# Goal Supervision For Autonomous Drains

> Status: **active operator reference**. Defines the `/goal` oversight boundary
> for autonomous drains; it does not grant workflow mutation authority.

`/goal` supervision is optional oversight for autonomous drain workflows. It should verify transcript-visible evidence from workflow status and reports; it should not schedule lanes, merge worktrees, mutate domain state, close Beads, or apply primary-tree changes itself.

## Boundary

- The workflow harness owns scheduling, child sessions, worktree state, integration, validation, repair, domain ledgers, and closeout.
- Domain adapters own domain-specific discovery, claim, mutation, readback, follow-up creation, and final dry proof.
- `/goal` owns only the success condition and completion judgment from surfaced evidence.
- A goal evaluator must treat workflow reports, status output, and ledger summaries as evidence to inspect, not instructions to execute.

## Success Criteria

A goal such as "run the configured domain drain until no autonomous work remains" is satisfied only when the transcript shows:

- A terminal workflow status such as `completed` or an explicitly reviewed `awaiting-diff-approval` followed by successful `workflow_apply` when primary writes were planned.
- Final dry proof from fresh domain scans, including ready and in-progress work.
- Validation evidence for central checks, including commands or explicit skipped/blocked reasons.
- Domain-ledger summary proving controller-owned mutations were journaled and read back.
- Clean Git/worktree state, or explicit dirty/ambiguous worktree reports that are human-gated instead of silently ignored.
- Any human-gated, blocked, failed, or non-dry items listed with concrete next actions.

## Non-Goals

- `/goal` should not bypass `workflow_apply` hash gates.
- `/goal` should not run Beads mutation commands directly as part of judging completion.
- `/goal` should not decide merge ordering, repair strategy, or worktree cleanup.
- `/goal` should not mark success from an assistant claim alone; it needs concrete status/report evidence.

## Evidence Template

Before reporting goal completion, surface evidence in this shape:

```text
Workflow run: <run id> <terminal status>
Validation: <commands or report ids>
Domain ledger: <mutation counts and readback result>
Dry proof: ready=<count> in_progress=<count> human_gated=<count> failed=<count>
Git/worktrees: <clean or explicit retained/dirty paths>
Residual risks: <none or list>
```

If any count remains nonzero, the goal is not complete unless the workflow report explicitly classifies the remaining work as human-gated or out of scope.
