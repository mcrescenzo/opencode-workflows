# 2026-06-19 review remediation — finding → bead crosswalk

> Status: **historical snapshot**. Retained for audit provenance; not the current
> implementation contract.

Program label: `ocw-review-0619`  |  Epic: `opencode-workflows-8rx`  |  Final gate: `opencode-workflows-61r`
Plan: `docs/review-2026-06-19-bug-robustness-remediation-plan.md`

Membership: relation-only from the epic; the gate is blocked by all 40 children (children block the gate). Beads state is local (not committed/pushed).

| Finding | Phase | Sev | Bead ID | Title |
|---|---|---|---|---|
| F1 | P0 | high | `opencode-workflows-5qs` | apply-approved-plan authority profile grants edit but never requires worktree-isolation gates |
| R1 | P0 | high | `opencode-workflows-8zk` | Live denial probes fail-OPEN on timeout / missing child id |
| R2 | P0 | high | `opencode-workflows-ccv` | protectedPathReason checks only first path segment -> nested .git/.opencode writes bypass apply boundary |
| R3 | P0 | high | `opencode-workflows-3hi` | Control-path segment check is case-sensitive -> mixed-case .GIT/.Opencode bypass on case-insensitive FS |
| R4 | P0 | high | `opencode-workflows-dm1` | probeWorktreeEditIsolationGate falsely verifies isolation when createWorktree returns no path |
| F4 | P1 | medium | `opencode-workflows-b57` | beads claim() does not assert its readback (unlike releaseClaim) -> no-op/foreign claim treated as success |
| F5 | P1 | medium | `opencode-workflows-a1k` | Central verifier MAX_VERIFIER_COMMANDS=8 silently truncates -> failing command past index 8 never run |
| R11 | P1 | medium | `opencode-workflows-1nx` | Central verifier is opt-in and inert in shipped beads-drain -> fabricated lane evidence auto-applied |
| R12 | P1 | low | `opencode-workflows-asv` | Central verifier treats all-unable-to-run identically to pass |
| R6 | P1 | high | `opencode-workflows-818` | proveDry in_progress derivatives ignore drain scope -> scoped drains can never report dry |
| R7 | P1 | high | `opencode-workflows-bmu` | proveDry in_progress query omits --limit -> 50-row truncation -> false dry=true |
| F2 | P2 | medium | `opencode-workflows-8c4` | Corrupt/partial lock file wedges all future lock acquisitions for the run |
| F3 | P2 | medium | `opencode-workflows-gf4` | cleanupRuns TOCTOU can delete a concurrently-resumed paused run |
| R10 | P2 | medium | `opencode-workflows-tw8` | opts.readOnly lane restriction silently overridden for network/mcp/edit |
| R13 | P2 | medium | `opencode-workflows-5c6` | Multiple inline workflow sources collide on the shared inline nestedSnapshots key |
| R16 | P2 | low | `opencode-workflows-uy6` | Domain mutation execute can run twice on crash -> duplicate bd followup/note |
| R5 | P2 | high | `opencode-workflows-xrh` | Agent concurrency slot leaked on fanout-cancel branch -> eventual deadlock |
| R8 | P2 | medium | `opencode-workflows-i6u` | Crash during apply-running finalization wedges run permanently out of workflow_apply |
| R9 | P2 | medium | `opencode-workflows-9pj` | Token/cost budget double-counted on resume -> ceilings trip at a fraction of the limit |
| R14 | P3 | low | `opencode-workflows-bzm` | capabilityProbes module cache locks in transient probe failures for the process lifetime |
| R15 | P3 | low | `opencode-workflows-mam` | Worktree remove/recover use un-realpathed root -> leak when an ancestor is a symlink |
| R18 | P3 | low | `opencode-workflows-994` | TOCTOU between symlink validation and write in workflow_apply (no O_NOFOLLOW) |
| R19 | P3 | low | `opencode-workflows-2gy` | Concurrent deliverWorkflowNotifications can double-send a completion notification |
| R20 | P3 | low | `opencode-workflows-aio` | notificationPath read from persisted state without containment validation |
| R21 | P3 | low | `opencode-workflows-wgh` | lsp permission granted broad allow but excluded from secret-glob deny rules |
| R23 | P3 | low | `opencode-workflows-64y` | processAppearsAlive returns false-alive when live startTime is unreadable |
| R24 | P3 | low | `opencode-workflows-vq0` | idleNotificationSessions only cleared by session.status events |
| R28 | P3 | low | `opencode-workflows-9as` | Run-map leak when appendEvent/writeState throws after runs.set in startWorkflow |
| R30 | P3 | low | `opencode-workflows-7qb` | writeJsonAtomic leaves tmp file on disk if fs.rename throws |
| R31 | P3 | low | `opencode-workflows-8w8` | probeDirectoryRootingGate accepts model-reported text as full verification |
| R32 | P3 | low | `opencode-workflows-6ti` | probeBackgroundContinuationGate unconditionally verifies via a trivial event-loop yield |
| R33 | P3 | low | `opencode-workflows-5vs` | git worktree remove fallback does not delete the lane branch -> orphaned branches accumulate |
| R17 | P4 | low | `opencode-workflows-f41` | patch.mode is normalized and hashed but silently ignored (append replaces) |
| R22 | P4 | low | `opencode-workflows-k1z` | authorityArgsForWorkflow validates beads-drain mode for ALL workflows |
| R25 | P4 | low | `opencode-workflows-8jh` | scope arg degrades to an unfiltered drain when passed as a string/array |
| R26 | P4 | low | `opencode-workflows-u26` | releaseClaim redundantly re-adds id to claimedIds (dead/misleading) |
| R27 | P4 | low | `opencode-workflows-k54` | probePermissions is a dead/no-op exported probe |
| R29 | P4 | low | `opencode-workflows-497` | stableStringify undefined sentinel causes in-memory vs file hash inconsistency |
| R34 | P4 | low | `opencode-workflows-0b7` | expectedPrimaryDirtyState dead-code check (schema permits only clean) |
| R35 | P4 | low | `opencode-workflows-0wg` | Redundant dual runs.delete with a dead 'cancelling' guard |

| GATE | — | — | `opencode-workflows-61r` | [GATE] Verify ... remediation complete |
| EPIC | — | — | `opencode-workflows-8rx` | opencode-workflows bug/robustness remediation (2026-06-19 review) |
