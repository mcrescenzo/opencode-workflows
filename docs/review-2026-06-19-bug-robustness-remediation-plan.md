# opencode-workflows — Bug / Robustness Review & Remediation Plan (2026-06-19)

> Status: **historical snapshot**. Retained for remediation provenance; current
> behavior is defined by source, tests, README, and active technical contracts.

Exhaustive, adversarially-verified review of the `opencode-workflows` plugin and the
bundled `beads-drain` workflow. Primary lens: faithful, **fail-closed** parity with
Claude Code's multi-agent Workflow model (see `docs/claude-parity-roadmap.md`).

> **Remediation status — ADDRESSED (verified 2026-06-19).** All 40 confirmed findings
> below (`R1`–`R35`, `F1`–`F5`) have been fixed and landed, each with a fail-closed
> regression test where applicable. The bd program `ocw-review-0619` tracked them as 40
> blocking children of the gate `opencode-workflows-61r`; live readback confirms **all 40
> `blocks` dependencies are `status=closed`** (the only remaining edge is the `relates-to`
> epic `opencode-workflows-8rx`). The full plugin matrix (`npm test`) and the live-gate
> suite (`npm run test:live-gates`) both pass green. The four P0 fail-closed regressions are
> present and passing: `apply-approved-plan` gate rejection (F1); probe timeout / no-child-id
> → blocked (R1); nested + mixed-case `.git`/`.opencode` path rejection (R2/R3); path-less
> worktree probe → failed (R4). Individual table rows below remain as the original
> as-found defect/fix record; treat every row as **resolved** unless a follow-up review
> reopens it.

## Method

- Two multi-agent review workflows (find → adversarial verify → synthesize):
  - Main: 15 scoped finder lanes (12 plugin subsystems + 3 beads-drain) → per-finding
    adversarial verification (Opus for security/subtle, Sonnet otherwise) → Opus synthesis.
    **70 candidates → 43 confirmed → 35 distinct after dedup; 27 refuted.**
  - Follow-up: re-verified 5 candidates dropped by transient rate-limiting + 3 independent
    beads-drain candidates. **5 confirmed, 3 refuted.**
- Total: **40 confirmed defects, 30 refuted false positives.** Each confirmed item is
  pinned to `file:line` and was checked against the real code by an independent skeptic.

## Headline assessment

The architecture is sound and genuinely defense-in-depth (deterministic sandbox,
hash-gated single-writer apply path, per-run advisory locks, durable ledgers with
crash-recovery intent, live behavioral gates). **None of the defects indicate a broken
design** — they are implementation gaps *at the seams* of otherwise-correct boundaries.
The high-severity cluster is concentrated exactly where the design markets itself as
fail-closed: live authority gates, the apply path-policy, isolation proof, and the
beads-drain dry-proof. The four highest-ranked items are trivial-to-small fixes, so a
large risk reduction is available cheaply.

## Cross-cutting themes

1. **Fail-OPEN verification gates** — live probes report `verified` without observing
   enforcement: a timeout / missing-child-id is read as "denial observed"; a path-less
   worktree response passes isolation; a no-op probe returns verified; model text counts
   as proof. These gate the highest authorities, so latency / API-shape variation becomes
   silent authority escalation.
2. **Probe-label ↔ error-message keyword collision** — the denial regex matches the
   probe's own label text, so structural failures masquerade as observed denial.
3. **Path-policy canonicalization gaps** — the control-path guard checks only the first
   segment and is case-sensitive, while the sibling secret-glob check is whole-path and
   case-insensitive: two independent apply-boundary bypasses in one module.
4. **Required-gate ↔ granted-authority mismatch** — `apply-approved-plan` grants `edit`
   but doesn't require the isolation gates; the function that would derive them is dead.
5. **Dry-proof trust** — `proveDry` diverges from `discover` (unscoped + unpaginated):
   simultaneously capable of false `complete` (truncation) and permanent false `not_dry`.
6. **Self-report trust (validation theater)** — the central verifier meant to re-execute
   lane validation commands is opt-in/inert in the shipped config, and even when wired has
   an all-unable-to-run=pass hole and a silent 8-command truncation.
7. **Recovery ordering & resume accounting** — completion ledger written before the
   authoritative `state.json`; prior spend double-counted on resume.
8. **Missing cleanup on error paths** — tmp files, run-map entries, claimed items, slots,
   worktrees, and lane branches leaked when an awaited step throws.
9. **Evidence-strength contract not enforced** — gates carry `evidenceStrength`
   (in-process-smoke / model-text-only / observed) but every check looks only at
   `verified===true`, so weak evidence is treated as strong proof.

---

## Remediation plan

Effort: trivial (≤15 min) · small (≤1–2 h) · medium (½–1 day) · large (multi-day).
IDs `R#` = main review rank; `F#` = follow-up verification.

**Status: all rows below are ADDRESSED** — fixes landed and (where applicable)
fail-closed regression tests added; the corresponding bd children of `ocw-review-0619`
are closed. See the remediation-status note at the top of this document.

### P0 — Close fail-open security / authority gates (do first)

These convert latency, benign API-shape variation, or untrusted patch paths into silent
authority escalation or an apply-boundary bypass. All trivial-to-small; highest leverage.

| ID | Severity | Effort | Defect | Fix |
|----|----------|--------|--------|-----|
| R1 | high | small | Live denial probes (`denialProbeResult`) classify ANY caught error as "denial observed" via a regex that also matches the probe's own label; a `session.create/prompt` **timeout** or a **success-shaped response with no child id** returns `gateVerified`. Gates `permissionEnforcement`/`secretReadDeny` (shell/network/mcp/edit/secret isolation). `workflow-plugin.js:5028-5036,5144-5156,5259-5287` | Discriminate transport/structural failures BEFORE the regex: `WorkflowTimeoutError`/`WorkflowCancelledError` → `gateFailed`/`gateBlocked`; no-child-id → typed blocked, not plain Error. Rename probe labels so they don't contain the denial keywords. |
| R2 | high | trivial | `protectedPathReason` checks only `split('/')[0]`, so nested `vendor/.git/hooks/...` or `pkg/.opencode/plugin.js` writes pass the apply boundary → git-hook / opencode-plugin injection (RCE). `path-policy.js:54-61` | Test **every** segment: `normalized.split('/').some(seg => CONTROL_PATH_SEGMENTS.has(seg))`. |
| R3 | high | trivial | Control-path check is case-sensitive (`.GIT/config`, `.Git/config` slip through on macOS/Windows case-insensitive FS), while the secret-glob check is case-insensitive. `path-policy.js:57` | Lowercase each segment before the Set lookup (combine with R2). |
| R4 | high | trivial | `probeWorktreeEditIsolationGate` resolves `created.path||directory||dir||""`; if the worktree API omits all three, `resolve("")` → process cwd (truthy, ≠ primary) → falsely **verifies** isolation. `workflow-plugin.js:5370-5384` | Validate the raw path BEFORE resolving (mirror `normalizeCreatedWorktree`): no raw path → `gateFailed`. |
| F1 | high | trivial | `apply-approved-plan` authority profile grants `edit:true` but `requiredGates:["permissionEnforcement"]` only; `worktreeApi`/`directoryRooting`/`worktreeEditIsolation` are never probed (hard-enforcement block is `ad-hoc`-only; `legacyRequiredGatesForAuthority` is dead). Edit lanes run with isolation unproven. `workflow-plugin.js:~117-120,1311-1317,4151-4165` | Add the three isolation gates to the profile. Better: call `legacyRequiredGatesForAuthority(authority)` inside `resolveRunAuthority` and lift the isolation `requireCapability` block out of the `ad-hoc`-only guard so it covers every elevated profile. Add the missing `apply-approved-plan` fail-closed test. |

### P1 — beads-drain core: dry-proof correctness + self-report trust

The dry-proof and central verifier are beads-drain's completion and safety guarantees.
Fix these before relying on `autonomous-local` (which auto-applies to the primary tree).

| ID | Severity | Effort | Defect | Fix |
|----|----------|--------|--------|-----|
| R7 | high | trivial | `proveDry` runs `bd list --status in_progress` with **no `--limit`** (bd default 50) while `discover` uses `--limit 0` (unlimited). >50 in-progress → truncated scan → `dry:true` while work exists → drain-runtime sets `complete`. `beads-drain-adapter.js:421` | Add `--limit 0` to the `proveDry` in_progress query. |
| R6 | high | small | `proveDry`'s in_progress derivatives (`unsafeInProgress`/`controllerOwnedIncomplete`) are computed from an **unscoped** list while `discover` applies `filterReadyIssues(scope)`; out-of-scope in-progress (e.g. a human-owned epic) makes a scoped drain permanently `not_dry`. `beads-drain-adapter.js:418-445` | Apply `filterReadyIssues(inProgress, scoped, {statuses:["in_progress"]})` before computing the derivatives, matching `discover`. |
| R11 | medium | medium | Central verifier (re-run lane validation commands) requires `options.runValidationCommand`, which the production factory `createDrainAdapter` never passes → `verifierPassed=true`, acceptance collapses to `evidenceCount>0`; fabricated lane evidence is accepted and auto-applied. `beads-drain-adapter.js:220-242,303-343` | Make the verifier non-optional for `autonomous-local` (absent runner + non-empty `commandsRun` → `unable-to-verify`, `accepted=false`), or wire a real `runValidationCommand`. At minimum surface `verifierEnabled:false` in gate diagnostics. |
| F5 | medium | small | When a runner IS wired, only the first `MAX_VERIFIER_COMMANDS=8` of `commandsRun` are re-run; a failing command at index ≥8 is never executed yet the lane is accepted, and the truncation is silent. `beads-drain-adapter.js:223,231,338` | On truncation, append a synthetic `unable-to-run` evidence entry (flips classification off `pass`); make the cap configurable; record full-attempted vs actually-run in the closeout. |
| F4 | medium | small | `claim()` fetches a fresh readback via `mutate()` but never asserts it (unlike `releaseClaim`, which asserts open+unassigned). A no-op or foreign claim is treated as success; the controller dispatches a lane for an item it may not own. `beads-drain-adapter.js:278-288` | After `mutate()`, assert `readback.status==="in_progress"` and (if actor) `readback.assignee===actor`; throw otherwise. Add a no-op-claim test. |
| R12 | low | trivial | Verifier `verifierPassed = !failed`; if every command is `unable-to-run`, classification is `unable-to-run` but `verifierPassed` stays true → accepted with zero real verification (for opt-in hosts). `beads-drain-adapter.js:313-324` | Require `verifierEvidence` empty OR some entry `result==="pass"`. |

### P2 — Durable-state recovery & concurrency correctness

Fail-safe (stuck / over-restrictive / deadlock, not corruption) but they break the
recovery and resource guarantees the design promises. Need careful ordering/state changes.

| ID | Severity | Effort | Defect | Fix |
|----|----------|--------|--------|-----|
| R5 | **high** | small | Agent slot leaked: `releaseAgentSlot` hands a slot to a waiter without decrementing `activeAgents`; the abort branch releases before throwing but the **lane-fanout-cancel branch throws without releasing**. Leaked count accumulates → concurrency gate deadlocks; survives resume. `workflow-plugin.js:2005-2022,3219,3246-3260` | Call `releaseAgentSlot(run)` before throwing in the fanout-cancel branch (mirror the abort branch). Add a queued-failFast-waiter-cancelled-at-handoff test asserting `activeAgents→0`. |
| R8 | medium | small | `appendApplyLedger(completed)` is written BEFORE `state.json=applied`; a crash in that window reconciles the run to `interrupted`, which the `workflow_apply` status gate rejects before the idempotent already-completed path → run permanently stuck, staged domain mutations never finalized. `workflow-plugin.js:4852,4943,4953,4303-4314` | Reorder: write `state.json=applied` before the completed-ledger append (lands on a retryable status); OR admit `interrupted` into the apply gate when a matching completed ledger record exists. |
| R9 | medium | small | On resume, `rehydrateRunFromPriorState` copies prior live spend into `run.tokens/cost`, and replay cache-hits ALSO accumulate into `replayedTokens/cost`; budget = live+replayed double-counts prior spend (up to 2× per resume) → `WorkflowBudgetStoppedError` well below the ceiling. `workflow-plugin.js:4036-4039,3025-3033,2750-2780` | Keep all historical spend only in the replayed counters (fold prior live spend into replayed, or zero the live counters on resume), mirroring the correct `agentsStarted` model. Add a resume+cache-hit+budget test. |
| R10 | medium | small | `resolveLanePolicy` zeroes `shell/network/mcp/edit` when `opts.readOnly`, but the requested-accumulation loop re-checks the ORIGINAL `run.authority` dimension and re-enables network/mcp/edit. `agent(p,{readOnly:true,network:true})` gets network back. `workflow-plugin.js:1482-1518` | Check the locally-restricted dimension (not `run.authority`), or reject `readOnly` combined with shell/network/mcp/edit as contradictory. |
| R13 | medium | small | `buildNestedSnapshots` stores inline snapshots under a shared `sourcePath="inline"` key; two distinct inline nested workflows collide → all but the last fail with a misleading "source changed after approval". `workflow-plugin.js:684-696,3229-3233` | For inline sources rely purely on the hash key; skip the path-based lookup for inline in `runNestedWorkflow`. |
| F2 | medium | small | A corrupt/partial lock file (crash mid-write; lock creation isn't atomic) has `stale:false,corrupt:true`; `clearStaleRunLocks` only clears `stale`, `acquireWorkflowLock` throws "unreadable", and `cleanup` is blocked by the lock — the run slot is permanently wedged, no escape hatch. `workflow-plugin.js:748-757,759-788,800-812` | Treat `corrupt` like `stale` in `clearStaleRunLocks`; make lock creation atomic (tmp+rename); add a "corrupt" state + reconcile recovery hint. |
| F3 | medium | small | `cleanupRuns` checks lock/status at enumeration, then `fs.rm` later with no re-check. `paused` runs aren't protected by `cleanupProtectionReason`, release their `run.lock`, and leave the in-memory map — a concurrent resume can be deleted mid-flight. `workflow-plugin.js:4520-4531,4721-4743` | Protect `paused` in `cleanupProtectionReason`; re-validate (status + lock) immediately before `fs.rm`, optionally holding the per-run lock. Add a paused-then-concurrent-resume test. |
| R16 | low | medium | `runDomainMutation` re-runs `execute` on resume when only a `started` record exists; a crash before the (non-fsynced) `executed` append re-runs non-idempotent bd mutations (`bd create` dup issue, doubled note). `workflow-plugin.js:2181-2207` | Add a deterministic client-side idempotency/external-id key to `bd create` (stored in the started record) so a re-run is a no-op; or pre-log intent checked on replay. |

### P3 — Robustness, resource leaks, hardening

Lower blast radius; batch them. Each is small.

| ID | Severity | Effort | Defect (file) | Fix |
|----|----------|--------|--------|-----|
| R14 | low | small | `capabilityProbes` module cache has no TTL/invalidation → one transient probe failure blocks all elevated workflows for the process lifetime. `workflow-plugin.js:1155,1244-1263` | Only cache verified results; short TTL / no-cache for blocked; expose a re-probe entry. |
| R15 | low | small | `worktreeRoot` is `path.resolve`d (not realpathed) but git returns realpaths → on a symlinked ancestor (macOS) remove/recover containment fails and worktrees leak. `worktree-adapter.js:170,197,265-310` | Realpath the containment basis and the remove record match. |
| R18 | low | medium | TOCTOU between symlink validation and write in `workflow_apply` (no `O_NOFOLLOW`); a local actor can swap a validated dir for a symlink between check and write. `workflow-plugin.js:4779-4797,4939-4940` | Open final path with `O_NOFOLLOW|O_CREAT|O_WRONLY`, or re-lstat each ancestor+target immediately before each write (prefer `openat`/`fstatat`). |
| R19 | low | small | Concurrent `deliverWorkflowNotifications` (background + `session.idle`) read/write `sendingAt` with no in-memory mutex → duplicate completion prompt. `workflow-plugin.js:1834-1897` | Add a process-local `deliveringNotificationPaths` Set as a synchronous mutex; keep the disk guard for cross-process. |
| R20 | low | trivial | `notificationStatusForEntry`/`rehydratePendingNotifications` read `notificationPath` from persisted state with NO containment check (sibling `resultPath` has one) → arbitrary JSON read via `workflow_status`. `workflow-plugin.js:4411-4414,1934-1952` | `assertContainedRealPath(entry.dir, notificationPath)` before read. |
| R21 | low | trivial | `lsp` granted `allow *` but excluded from the secret-glob deny loop (read/grep/glob/list only) → potential secret-fragment leak via LSP. `workflow-plugin.js:1434-1464` | Add `lsp` to the secret-glob deny loop. |
| R31 | low | small | `probeDirectoryRootingGate` returns `gateVerified` with `evidenceStrength:"model-text-only"` when any text part contains the cwd; no consumer down-ranks weak evidence. `workflow-plugin.js:5346-5352` | Treat model-text-only as `available-unverified`, or require the deterministic sentinel read. |
| R32 | low | small | `probeBackgroundContinuationGate` does no behavioral test (awaits a 0ms timeout) and unconditionally returns `gateVerified`. `workflow-plugin.js:5485-5491` | Return `gateAvailableUnverified` for the no-op; have `verifyRequiredAuthorityGates` down-rank weak `evidenceStrength` unless explicitly accepted. |
| R23 | low | trivial | `processAppearsAlive` returns true (alive) when a recorded startTime exists but the live startTime is unreadable → reused PID pinned active, blocking reconcile. `workflow-plugin.js:330-351` | Treat unreadable live start as distrust (return false) when a recorded start exists. |
| R24 | low | trivial | `idleNotificationSessions` cleared only by `session.status` events → a session reactivated via another event stays falsely idle. `workflow-plugin.js:1790-1798` | Clear on any non-idle event carrying the sessionID. |
| R28 | low | trivial | `startWorkflow` `runs.set` then `appendEvent/writeState`; if either throws, the catch never `runs.delete` → phantom `running` entry. `workflow-plugin.js:4255-4273` | Add `runs.delete(run.id)` to the catch. |
| R30 | low | trivial | `writeJsonAtomic` leaves the tmp file if `fs.rename` throws. `workflow-plugin.js:1664-1668` | try/catch around rename that removes tmp before rethrow. |
| R33 | low | trivial | Non-native worktree remove (always used for integration lanes) doesn't delete the lane branch → orphaned branches accumulate unbounded. `worktree-adapter.js:277` | `git branch -D record.branch` after a successful remove (swallow already-gone). |

### P4 — Parity gaps, dead code, input-validation cleanup

No functional/security impact in the shipped flow; correctness-of-intent and maintainability
(prevents future refactors from re-introducing higher-severity bugs).

| ID | Severity | Effort | Defect (file) | Fix |
|----|----------|--------|--------|-----|
| R22 | low | trivial | `authorityArgsForWorkflow` calls `resolveBeadsDrainMode` UNCONDITIONALLY → any non-beads workflow with a custom `args.mode` throws at startup. `workflow-plugin.js:1356-1370` | Hoist the `meta.name!=="beads-drain"` early return before `resolveBeadsDrainMode`. |
| R25 | low | trivial | `scope` spread without a plain-object guard → a string/array scope silently runs an UNFILTERED drain. `workflows/beads-drain.js:21` | Reject non-plain-object `scope` (mirror the top-level args guard). |
| R29 | low | trivial | `stableStringify` serializes `undefined` as the literal sentinel string; in-memory hash can diverge from the file-recomputed hash → spurious `diffPlanHash` mismatch on manual apply of a no-worktree-lane patch. `workflow-plugin.js:239-248` | Serialize `undefined` as `null`, or skip undefined-valued keys (match `JSON.stringify`). |
| R17 | low | trivial | `patch.mode` is normalized + hashed but never read; all patches `write-replace` regardless (e.g. `append` silently replaces). `workflow-plugin.js:2889,3847,4940` | Reject non-`replace` modes in `normalizePatches` (make the schema honest), or implement `append`. |
| R26 | low | trivial | `releaseClaim` redundantly re-adds id to `claimedIds` (dead, misleading). `beads-drain-adapter.js:396-398` | Remove the redundant `add`. (Do NOT add releasedClaimIds to the `controllerOwnedIncomplete` filter — verifier showed that would suppress legitimate stranded-work signals.) |
| R27 | low | trivial | `probePermissions` has identical ternary branches, never returns `available`, never checks `createdSessionRetainedPermission`; exported but unused. `workflow-plugin.js:1187-1201` | Remove/deprecate it (document `probeDeniedBash` as canonical), or make it meaningfully check retention. |
| R34 | low | trivial | `expectedPrimaryDirtyState` schema permits only `clean`, so the dirty-throw is dead (real guard is `assertGitCleanAtBase`); risk is a future reader trusting it. `workflow-plugin.js:4864-4865,5770` | Remove the param, or widen the enum and actually gate on it. |
| R35 | low | trivial | Two consecutive `runs.delete` with overlapping conditions; the `cancelling`-preserve intent is dead code. `workflow-plugin.js:3984-3985` | Remove the redundant line (or fix the predicate if preserving cancelling background runs is desired). |

---

## Recommended follow-up review passes (coverage gaps)

The review was thorough but explicitly did **not** fully cover:

- A dedicated **QuickJS sandbox-escape** pass (Date/Math.random/setTimeout disablement,
  `__workflowHost` bridge integrity, VM escape) — only touched tangentially.
- A systematic **fsync/durability-ordering** audit of every ledger/state write barrier.
- Full **hash-canonicalization** enumeration (all fields into `computeDiffPlanHash` /
  `sourceHash` / `stableStringify`; other type ambiguities).
- A broad **concurrency interleaving** audit (pause/resume/cancel vs lane completion,
  journal append ordering under concurrent lanes, lock fairness).
- Items inferred from in-repo evidence but not confirmed against the live OpenCode SDK:
  whether the LSP permission engine path-matches like `read` (R21), the idle event taxonomy
  (R24), and whether the v2 worktree client can return a path-less response (R4).

## Suggested sequencing

1. **P0** in one PR (all trivial-small; ~half a day incl. tests). Add the missing
   fail-closed tests (`apply-approved-plan` gate rejection; probe timeout/no-id → blocked;
   nested/mixed-case path rejection).
2. **P1** before any further reliance on `autonomous-local` auto-apply.
3. **P2** as a focused recovery/concurrency PR (R5 first — it's the one HIGH here and the
   fix is small).
4. **P3 / P4** batched as hardening / cleanup.
