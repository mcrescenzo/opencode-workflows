# Staged Dogfood Rollout - 2026-06-16

> Status: **Historical snapshot**. This report records the dogfood state observed
> on 2026-06-16. It is retained for audit context and should not be read as the
> current implementation contract; use the README and current Beads closeout notes
> for current behavior.

## Summary

Safe dogfood stages were executed through no-token, mocked, and scratch-repository verification. Real scoped Beads drains and the full backlog drain were not executed because the active runtime live gates are not behaviorally verified and `worktreeApi` is blocked.

This report does not claim autonomous-drain release readiness. It records the rollout evidence and the gates that must pass before larger real-drain stages are safe.

## Verification Evidence

| Check | Result |
| --- | --- |
| `npm run test:workflow-kernel` | Passed 11/11 |
| `npm run test:workflow-adapters` | Passed 10/10 |
| `npm run test:beads-drain` | Passed 16/16 |
| `npm run test:live-gates` | Passed 3/3 |
| `npm run test:workflows` | Passed 90/90 |
| `npm run test:parent-workflows` | Passed 56/56 |

Active runtime `workflow_live_gates({ format: "summary" })` in the running OpenCode session reported:

```text
permissionEnforcement: available-unverified
structuredOutput: available-unverified
worktreeApi: blocked
directoryRooting: available-unverified
backgroundContinuation: available-unverified
cancellation: available-unverified
```

## Stage Results

| Stage | Result | Evidence |
| --- | --- | --- |
| 1. Fake adapter drain | Completed | `tests/drain-runtime.test.mjs`; `npm run test:workflow-kernel` passed 11/11; aggregate suite passed 90/90. |
| 2. Test-fix drain on seeded scratch state | Completed | `tests/test-fix-drain-adapter.test.mjs`; `npm run test:workflow-adapters` passed 10/10; aggregate suite passed 90/90. |
| 3. Beads drain on scratch Beads repos | Completed | `tests/beads-drain-scratch.test.mjs`; `npm run test:beads-drain` passed 16/16. Covers close-to-dry, distinct ready items, actor-owned in-progress continuation, external in-progress human-gating, child mutation denial, follow-up linking, validation no-close, and final dry-proof remaining-work detection. |
| 4. Small scoped real Beads label with manual final apply | Human-gated, not executed | Requires behaviorally verified permission, worktree/rooting, structured output, background, and cancellation gates plus an explicit small scope. Active runtime gates are currently unverified/blocked. |
| 5. Larger scope with auto-after-verification authority | Human-gated, not executed | Requires stage 4 success and verified live gates. |
| 6. Full Beads backlog drain | Human-gated, not executed | The plan explicitly allows this only after all gates are verified. Active runtime does not satisfy that condition. |

## Domain Ledger, Dry Proof, And Cleanup

Scratch Beads dogfood uses temporary Git repositories and temporary Beads databases only. The adapter tests assert controller-only Beads mutations, mutation ledger readbacks, and final dry proof behavior in scratch state.

No real project Beads drain was run, no full-backlog dry proof is claimed, and no Dolt push, backup sync, JSONL import/export, git commit, or git push was performed.

Cleanup/status evidence from this session:

```text
git worktree list
~/.config/opencode/plugins/opencode-workflows  0000000 [master]
```

`git status --short` reports this plugin work area as untracked local project files, including the intentional files changed by this rollout. No additional workflow test worktrees were retained in this repo.

## Follow-Up Gate

The next release-gate validation must not claim autonomous-drain capability until the active runtime live probes verify permission enforcement, command-scoped bash denial, structured output, worktree API/rooting, edit isolation, background continuation, workflow completion notification, and cancellation.
