# Release-Gate Validation - 2026-06-16

> Status: **Historical snapshot**. This document records the release-gate state
> observed on 2026-06-16. It is retained for audit context and should not be read
> as the current implementation contract; use the README and current Beads closeout
> notes for current behavior.

## Result

Autonomous-drain release gates do not pass in the active runtime. The no-token and scratch validation gates pass, but the required live runtime gates are not behaviorally verified and `worktreeApi` is blocked.

No autonomous-drain capability claim should be made from this validation run.

## Active Runtime Gate Evidence

`workflow_live_gates({ format: "summary" })` in the running OpenCode session reported:

```text
permissionEnforcement: available-unverified
structuredOutput: available-unverified
worktreeApi: blocked
directoryRooting: available-unverified
backgroundContinuation: available-unverified
cancellation: available-unverified
```

This fails the release-gate requirement for behaviorally verified command-scoped permission enforcement, worktree rooting/API, structured output, background continuation, and cancellation.

## Gate Checklist

| Gate | Status | Evidence |
| --- | --- | --- |
| Command-scoped permission enforcement live-verified | Blocked/failing | Active runtime reports `permissionEnforcement: available-unverified`; current tool surface in this session does not expose probe flags. |
| Worktree rooting live-verified | Blocked/failing | Active runtime reports `worktreeApi: blocked` and `directoryRooting: available-unverified`. |
| Integration mode tested in scratch repos | Passed | `npm run test:workflows` passed 90/90, including path-disjoint integration and conflict/reporting tests; `npm run test:parent-workflows` passed 56/56. |
| Domain mutation ledger implemented | Passed | `npm run test:beads-drain` passed 16/16 and `npm run test:workflow-kernel` passed 11/11, covering domain ledgers, readbacks, and idempotent mutation keys. |
| Restart/reconcile semantics tested | Passed | `npm run test:workflow-kernel` passed 11/11, including durable reconcile and incomplete ledger recovery tests. |
| Beads adapter proves dry state | Passed in scratch only | `npm run test:beads-drain` passed 16/16, including real scratch Beads close-to-dry and final dry-proof remaining-work detection. No real full-backlog dry proof is claimed. |
| Non-Beads drain proves generality | Passed | `npm run test:workflow-adapters` passed 10/10, including `test-fix` drain behavior. |
| Staged dogfood report reviewed | Completed with gated later stages | `docs/dogfood-rollout-2026-06-16.md` records stages 1-3 complete and stages 4-6 human-gated because live gates are not verified. |

## Blocker

Final release validation is blocked until the active OpenCode runtime can behaviorally verify the live gates. At minimum:

- Restart or reload OpenCode so the updated plugin code and tool schema are active.
- Run `workflow_live_gates` with explicit live probe flags for permission enforcement, command-scoped bash denial, secret read denial, structured output, worktree API, directory rooting, worktree edit isolation, background continuation, workflow completion notification, and cancellation.
- Resolve `worktreeApi: blocked` before any larger real Beads drain or full backlog drain.
- Re-run the no-token aggregate checks after the runtime gate issue is resolved.

## Commands Already Verified In This Session

```text
npm run test:workflow-kernel     # pass 11/11
npm run test:workflow-adapters   # pass 10/10
npm run test:beads-drain         # pass 16/16
npm run test:live-gates          # pass 3/3
npm run test:workflows           # pass 90/90
npm run test:parent-workflows    # pass 56/56
```
