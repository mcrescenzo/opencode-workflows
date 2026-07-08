---
description: Run the beads-drain workflow with explicit scope and final dry proof
---

Mode: implementation. Edits are allowed only through the workflow harness and `workflow_apply` approval flow.

Invoke the bundled Beads drain workflow with `workflow_run` using `name: "beads-drain"`; prefer
`format: "json"` for the approval preview so the controller can read `.approvalHash`,
`.authority.profile`, `.modelPlan`, `.laneBudget`, and `.mutationDomains` without parsing prose.
Canonical references: tool mutability and hash requirements are in
`docs/workflow-plugin.md#workflow-tool-reference`; apply boundaries, raw run artifacts,
and durable lifecycle cleanup are in the matching README sections.

Use `$ARGUMENTS` as the workflow runtime args only if it is valid JSON object syntax. If `$ARGUMENTS` is empty, start conservatively with a no-mutation dry-run:

```json
{
  "mode": "dry-run",
  "scope": { "issueTypes": ["task"], "limit": 5 },
  "repo": "<absolute path to a single concrete project repo>"
}
```

Dry-run is the default proof path. It discovers, classifies, reports planned work, and proves current dry state without claiming Beads, spawning child lanes, creating worktrees, applying patches, or mutating domain state.

If `$ARGUMENTS` is non-empty but not valid JSON, or parses to a string/array/number/boolean instead of an object, stop and report the argument error. To request non-dry local orchestration, pass a valid object such as `{ "mode": "autonomous-local", "repo": "<project repo>" }`. Bundled non-dry `beads-drain` defaults to `background: true` when the caller omits `background`, so the active run can be inspected with `workflow_status`; pass `background: false` explicitly for a foreground run. Child lane prompts default to 10 minutes; when dogfooding larger Beads, pass top-level `laneTimeoutMs`/`childPromptTimeoutMs` up to `3600000` and keep `maxAgents` low until successful closeout is proven. The host-owned drain loop runs until the scoped queue is dry, a legal stop is reached (`queue_empty`, `stall`, `budget_exhausted`, `human_decision_required`), or bounded wave/attempt caps are exhausted; examples should omit `maxWaves`/`maxAttempts` unless deliberately bounding a test/debug run.

Authority is approved once before launch. `mode: "dry-run"` maps to the `drain-dry-run` profile. `mode: "autonomous-local"` maps to `drain-autonomous-local`; it must run without mid-run interactive permission prompts. Non-dry drain requires this one-time launch approval; the kernel verifies the server version floor (`GET /global/health`, minimum opencode 1.17.13) and asserts lane rooting/permissions deterministically at launch — there is no live-gate preflight step. A server below the minimum, or a failed rooting/permission assertion, refuses the launch instead of degrading silently.

The bundled workflow is a thin wrapper around the host-owned `drain({ adapter: "beads" })` primitive. The trusted kernel and Beads adapter own preflight, snapshots, claims, isolated implementation lanes, validation, mutation staging/finalization, and final dry proof instead of reimplementing those steps in script-body prompt plumbing. The command can be launched from any write-capable primary agent with explicit workflow permissions; Beads implementation child lanes still run as the `build` agent so orchestration-agent choice does not change lane behavior. In `mode: "autonomous-local"`, a verified successful diff plan is applied to the local primary tree IN-RUN (accepted code changes land, staged Beads closes/followups are finalized and read back) and the run ends in `completed`/`not_dry`/legal-stop rather than `awaiting-diff-approval`. That in-run apply is the one intentional exception to the normal `workflow_apply` write boundary; the one-time launch approval is the consent for it. A failed drain surfaces as `failed-with-diff-plan` (preserved for review through `workflow_apply`); apply errors enter the retryable `apply-failed` state with no silent Beads close. `remote_sync` is always `local-only`.

Treat raw run files as local sensitive artifacts: `result.json`, ledgers, diff plans, request files, and state under `.opencode/workflows/runs/` are evidence for local review, not publication. Prefer `workflow_status({ detail: "result" })` for redacted result display. In status output, treat `effectiveAuthorityProfile` as the runtime authority profile; `meta.profile`/`declaredProfile` describe the source-declared profile.

If cancellation, pause, reconcile, or cleanup is needed, use `workflow_cancel`, `workflow_pause`, `workflow_reconcile`, and `workflow_cleanup`. Cleanup preserves active, locked, malformed, corrupt, interrupted, paused, ambiguous edit, `apply-running`, and `apply-failed` runs and reports protected reasons in dry-run output.

Report the approval hash, run id, validation result, final dry proof, domain-ledger summary, `workflow_apply` result when applicable, and any human-gated or non-dry work. Do not push, publish, or run destructive git commands.
