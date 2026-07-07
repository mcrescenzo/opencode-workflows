---
name: beads-drain
description: Use when running or interpreting the beads-drain workflow for autonomous local Beads backlog draining through the generic workflow harness.
---

# Beads Drain

Use `beads-drain` when the user explicitly wants the workflow harness to drain local Beads work, not when ordinary one-off Beads commands are enough.

## Scope

- Default to local-only Beads state.
- Pass explicit scope through workflow args, such as labels, issue types, parent, or limit.
- Exclude epics unless the user explicitly asks to include them.
- Treat externally owned in-progress work as human-gated.

## Safety

- Child implementation lanes must not run Beads mutation commands.
- Beads mutations are controller-owned, journaled, and followed by fresh readback.
- Final success requires a fresh dry proof from ready and in-progress scans.
- Report skipped, blocked, failed, human-gated, and non-dry outcomes separately.
- Dry-run is the default safe mode and must not claim Beads, spawn child edit lanes, create worktrees, apply patches, or mutate Beads.
- Empty or omitted workflow args preserve the conservative dry-run default. Non-empty args must be a JSON object; invalid JSON or a parsed string/array/number/boolean should stop with an argument error instead of silently dry-running.
- `mode: "dry-run"` maps to the `drain-dry-run` authority profile; `mode: "autonomous-local"` maps to `drain-autonomous-local`.
- Bundled `mode: "autonomous-local"` drains default to `background: true` when the caller omits `background`; pass `background: false` explicitly for a foreground non-dry run.
- Child lane prompts default to 10 minutes. Use top-level `laneTimeoutMs` or `childPromptTimeoutMs` up to `3600000` milliseconds for dogfood runs where lanes make progress but time out, and keep `maxAgents` low until closeout is proven.
- Authority is approved once before launch. Non-dry autonomous runs must not depend on mid-run interactive permission prompts.
- After approval, an autonomous-local launch runs required live-gate preflight probes before lane or Beads-mutation launch: each probe spawns a short-lived child session (model token use) and worktree/directory-rooting probes create and remove scratch worktrees.
- Non-dry Beads drain fails closed unless live gates are verified for permission enforcement, command-scoped bash denial, secret-read denial, structured output, directory rooting, local Git integration worktree isolation, and cancellation.
- `unsafeAcceptUnverifiedPermissions` is not a bypass for non-dry Beads drain; use dry-run or fix the reported live gates before retrying.
- The bundled workflow is a thin wrapper around the host-owned `drain({ adapter: "beads" })` primitive. The trusted kernel and Beads adapter own preflight, snapshots, claims, isolated implementation lanes, validation, mutation staging/finalization, and final dry proof instead of reimplementing those steps in script-body prompt plumbing. The workflow may be launched from any write-capable primary agent with explicit workflow permissions; Beads implementation child lanes still run as the `build` agent so orchestration-agent choice does not change lane behavior. It runs until dry, a legal stop (`queue_empty`, `stall`, `budget_exhausted`, `human_decision_required`), or bounded wave/attempt caps are exhausted; examples should omit `maxWaves`/`maxAttempts` unless deliberately bounding a test/debug run.
- In `mode: "autonomous-local"`, a verified successful diff plan is applied to the local primary tree in-run (accepted code changes land; staged Beads closes/followups finalized and read back); the run ends in `completed`/`not_dry`/legal-stop rather than `awaiting-diff-approval`. That in-run apply is the one intentional exception to the normal `workflow_apply` write boundary; the one-time launch approval is the consent for it. A failed drain surfaces as `failed-with-diff-plan` (review/apply via `workflow_apply`); apply errors enter retryable `apply-failed` with no silent Beads close. `remote_sync` is always `local-only`.
- Dirty timed-out or failed implementation lanes are salvaged conservatively: the controller records `salvaged` metadata, preserves the worktree, and writes the salvage path/changed files into the Beads cleanup note before reopening/unassigning. Salvage evidence is not enough to close or apply work without controller validation.
- Treat raw `result.json`, ledgers, diff plans, request files, and run state under `.opencode/workflows/runs/` as local sensitive artifacts. Prefer `workflow_status({ detail: "result" })` for redacted result display.
- Use `workflow_cancel`, `workflow_pause`, `workflow_reconcile`, and `workflow_cleanup` for lifecycle control. Cleanup preserves active, locked, malformed, corrupt, interrupted, paused, ambiguous edit, `apply-running`, and `apply-failed` runs and reports protected reasons.

## Invocation

Run the bundled workflow by name with `workflow_run({ name: "beads-drain", args: ... })`. Review the approval hash, gate status, effective authority profile, and dry-proof report. In autonomous-local the verified diff plan auto-applies; otherwise apply any diff plan through `workflow_apply`.

Use conservative arguments first:

```json
{
  "mode": "dry-run",
  "scope": { "issueTypes": ["task"], "limit": 5 },
  "repo": "<absolute path to a single concrete project repo>"
}
```

For non-dry local orchestration, pass a valid JSON object such as `{ "mode": "autonomous-local", "repo": "<project repo>" }`. It starts in the background by default unless `background: false` is explicitly set. For long dogfood lanes, set top-level `laneTimeoutMs: 3600000` rather than `guestDeadlineMs`; `guestDeadlineMs` only guards synchronous workflow script execution. In `workflow_status`, use `effectiveAuthorityProfile` as the approved runtime profile; source `meta.profile`/`declaredProfile` can differ for dry-run defaults.

For /goal supervision, the goal evaluator should rely on transcript-visible workflow status/report evidence. `/goal` should not own scheduling, worktree state, merging, or Beads mutations.

Use `/workflow-live-gates-release-check` only when the user explicitly approves active-runtime token, worktree, background, and notification side effects. Normal `npm` tests and dry-run drains remain no-token by default.
