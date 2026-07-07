---
description: Run the opt-in active-runtime workflow live-gate release check
---

Run the active-runtime workflow live-gate release check only because the user explicitly invoked this command or otherwise approved token/worktree side effects.
Canonical references: live-gate behavior is summarized in the README live-gates
section, and `workflow_live_gates` mutability/approval requirements are listed in
`docs/workflow-plugin.md#workflow-tool-reference`.

Before running probes, state these side effects briefly:

- Session probes can spend model tokens.
- The concurrency-capacity probe launches `concurrencyProbeLimit` child prompts at once; keep the limit modest unless the user approved a larger burst.
- Worktree probes can create and remove throwaway worktrees.
- Background and notification probes can schedule asynchronous OpenCode work.
- Plugin or command changes require restarting OpenCode before this check reflects them.

Then call `workflow_live_gates` with every behavioral probe enabled and `format: "json"`:

```json
{
  "format": "json",
  "approvalIntent": "probe",
  "probePermissionEnforcement": true,
  "probeDeniedBash": true,
  "probeCommandScopedBash": true,
  "probeSecretReadDeny": true,
  "probeStructuredOutput": true,
  "probeWorktreeApi": true,
  "probeDirectoryRooting": true,
  "probeWorktreeEditIsolation": true,
  "probeIntegrationWorktreeIsolation": true,
  "probeBackgroundContinuation": true,
  "probeConcurrencyCapacity": true,
  "concurrencyProbeLimit": 16,
  "probeCancellation": true,
  "probeWorkflowNotification": true
}
```

Report the raw JSON evidence in the transcript or point to the exact saved evidence location if the output is too large.

Readiness is reported per capability tier, not as a single all-gates verdict,
because the non-dry `beads-drain` profile (`drain-autonomous-local`) uses
integration-worktree isolation and does not require the native edit-mode
worktree gates. Conflating the tiers overblocks valid Beads readiness.

## Full / native edit-mode readiness

All gates verified. Required for `edit-plan-only` and any workflow that edits through the
native worktree API.

Pass criteria:

- `configured` is `true`.
- `verified` is `true`.
- Every entry in `gates` has `state: "verified"` and `verified: true`, including
  `worktreeApi` and `worktreeEditIsolation`.

If any gate is `blocked`, `available-unverified`, or `failed-with-evidence`, do not claim
full/native edit-mode release readiness. Report `[release-gate:blocked]` with the tier
(`full-edit`), the non-verified gate names, and evidence.

## Non-dry beads-drain readiness

Only the Beads-required gate subset must be verified. This subset mirrors
`NON_DRY_DRAIN_REQUIRED_GATES` in `workflow-kernel/authority-policy.js`:

- `permissionEnforcement`
- `commandScopedBash`
- `secretReadDeny`
- `structuredOutput`
- `directoryRooting`
- `integrationWorktreeIsolation`
- `cancellation`

The native worktree gates `worktreeApi` and `worktreeEditIsolation` are NOT required for
non-dry Beads readiness, because Beads profiles use integration-worktree isolation instead.
`backgroundContinuation` and `workflowNotification` are also not in the Beads subset.

Pass criteria for non-dry Beads readiness:

- `configured` is `true`.
- Every gate listed in the Beads subset above has `state: "verified"` and `verified: true`.

If a Beads-subset gate is `blocked`, `available-unverified`, or `failed-with-evidence`, do
not claim non-dry beads-drain release readiness. Report `[release-gate:blocked]` with the
tier (`beads-non-dry`), only the non-verified Beads-subset gate names, and evidence. Do not
include native worktree gates in the Beads blocked message.

A `[release-gate:blocked]` for `full-edit` does NOT imply Beads is blocked, and a
`[release-gate:blocked]` for `beads-non-dry` does NOT imply full/native edit is blocked.

## Evidence-strength caveat (do not overclaim permission or rooting gates)

A verified gate is not always equivalent to directly-observed target behavior. Each
verified gate carries an `evidenceStrength` field:

- `observed` — the probe directly observed the target behavior (a denied tool part,
  denial text, a thrown denial, a successful create/remove, a completed sentinel read,
  etc.). Strong evidence.
- `no-attempt-fallback` — the probe observed no tool attempt at all (the denied tool
  appears hidden/unavailable) and verified only that retained deny rules held and no
  successful tool call occurred. This is a compatibility path for runtimes that hide
  fully-denied tools, not behavioral enforcement proof. Used only by
  `permissionEnforcement`.
- `model-text-only` — the probe observed only model-reported text matching the expected
  value, without a deterministic tool result. Historically used by `directoryRooting` when
  the child echoed the assigned directory but did not perform (or did not expose) the
  sentinel read tool call. The model can echo a directory without being rooted there, so
  this is not equivalent to an observed tool-anchored rooting proof. As of the R31 fix
  (`directoryRooting`) and the integration-worktree rooting hardening
  (`integrationWorktreeIsolation`), neither gate PRODUCES this strength anymore: a text-only
  echo is reported as `available-unverified` (verified=false), so the required rooting
  authority cannot be satisfied without a completed `read` tool part returning unique
  on-disk sentinel content. The strength is retained for the down-ranker's scope lock.
- `in-process-smoke` — the probe verified only in-process event-loop yield and did not
  exercise the OpenCode background subsystem. Used by `backgroundContinuation`. Restart
  survival is not implied; production background continuation across OpenCode restart is
  out of scope for this gate.

`commandScopedBash` and `secretReadDeny` stay strict: they do not use the
`no-attempt-fallback` and report `blocked` when no tool attempt is observable.

Before claiming non-dry readiness, inspect each verified gate's `evidenceStrength`:

- If every required gate is `observed`, the readiness verdict above holds as-is.
- If `permissionEnforcement` is `no-attempt-fallback`, do NOT claim equivalence to an
  observed denial. Report `[release-gate:weak-evidence]` with the gate name and state
  that the hidden/no-attempt fallback was accepted only if an explicit policy/operator
  decision confirms this runtime hides fully-denied tools by design. Without that
  explicit acceptance, treat the gate as not-yet-proven and do not advance to a non-dry
  release verdict.
- If `directoryRooting` or `integrationWorktreeIsolation` is `available-unverified` with
  "model-reported cwd text" evidence, do NOT claim deterministic runtime/tool rooting
  evidence. The child echoed the target directory without a completed sentinel `read`, so
  rooting is unproven. Report `[release-gate:weak-evidence]` and request a runtime/tool-
  anchored sentinel read before advancing to a non-dry release verdict. (Pre-fix these
  gates could return `verified` with `evidenceStrength:"model-text-only"`; both now
  downgrade a text-only echo to `available-unverified`.)
- `backgroundContinuation` is always `in-process-smoke` in this build. Treat its
  `verified` state as proof of in-process continuation only and never as restart
  survival. Restart-surviving background execution is out of scope.
