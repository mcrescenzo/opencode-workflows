---
description: Materialize repo-review findings into a duplicate-aware Beads epic (dry-run preview first, explicit approval before any writes)
---

Mode: Beads mutation (local-only). This command bridges a completed `/repo-review` run's
findings into a Beads backlog: one epic, one child bead per unique finding, and a final
verification gate. It is the SEPARATE, EXPLICITLY-APPROVED counterpart to `/repo-review` —
`/repo-review` never runs this automatically. It defaults to DRY-RUN (no writes) and requires
explicit user approval before creating anything.

Canonical references: the adapter is
`workflow-domains/beads/review-materialize-adapter.js`; the plugin tool is
`review_materialize`; the repo-review gate is `materializationReady` on the review envelope.

## 1. Gather inputs

Parse `$ARGUMENTS`:
- `runId` (required): the run id of a completed `/repo-review` run whose findings you want to
  materialize.
- `repo` (optional): absolute path to the target repo. Default: the current workspace root.
- `programLabel` (optional): a label for this materialization program. Default:
  `review-<baselineHead>` when the completed run recorded a review-time baseline, otherwise a
  run-id-derived label. Do not derive the default from current `HEAD`.
- `verifyOnly` (optional, default false): set to `true` to re-run readback verification for
  an existing materialization graph after a post-write verifier failure. This makes no Beads
  writes and does not require findings input.
- `crosswalkPath` (optional): explicit crosswalk JSON path for verify-only recovery. Default:
  `.repo-review/crosswalk/<programLabel>.json` under the target repo.
- `acceptPartial` (optional, default false): set to `true` ONLY if you understand the risk of
  materializing from an incomplete report.

If `$ARGUMENTS` is empty, STOP and ask the user for the `runId` from their completed
`/repo-review` run, unless they are asking for `verifyOnly` recovery and provide a
`programLabel` or `crosswalkPath`.

## Verify-only recovery path

If a previous non-dry call returned `materialized_verify_failed`, do NOT re-run non-dry
materialization as the first recovery action. Re-run verification only:

```json
{
  "repo": "<absolute repo path>",
  "programLabel": "<review-<head>>",
  "verifyOnly": true,
  "crosswalkPath": "<optional explicit crosswalk path>",
  "format": "json"
}
```

Interpret the status:
- `verified`: the existing graph now passes readback; continue to scoped post-materialization
  review before drain.
- `invalid`: the graph is genuinely missing blockers or has graph/cycle problems; repair the
  graph and retry verify-only.
- `inconclusive`: a verifier/tool readback failed; inspect failed check names and retry
  verify-only before creating more beads.

Verify-only output includes `epicId`, `finalGateId`, `childCount`, failed check names, bounded
problems, and a suggested safe next action. The normalized verifier result shape is
`verify.{ok,verdict,failureClass,retryable,recoverable,checks,problems,warnings,failedChecks,suggestedRecovery}`:
`verdict=pass` means objective checks passed, `verdict=hard_fail` means the graph/check result is
invalid, and `verdict=tool_error` means verification was inconclusive because readback/tooling
failed. Verify-only must not call `bd create`, `bd update`, `bd dep add`, or write the crosswalk.

## 2. Read back the repo-review result

Call `workflow_status({ runId, detail: "result" })` to inspect the completed review envelope
before asking for materialization. The `review_materialize` tool will independently read and
validate the same run/result envelope from `runId`; do not pass caller-supplied `findingsPath`
or `materializationReady` alongside `runId`.

Expect `.result.output` to include:
- `findings` — the ranked cross-domain finding array.
- `artifactPaths.findingsJson` — the preferred full finding artifact. The tool consumes this
  artifact itself when present so materialization receives the complete, size-uncapped set with
  preserved `domainDetails`.
- `materializationReady` — the gate.
- `materializationBlockers` — why readiness might be false.
- `coverageGrade` and `coverageAudit`.

If the run result is not `domain: "repo-review"`, stop. The tool refuses non-repo-review
envelopes.

## 3. Check the materialization gate

- If `materializationReady` is `false` and `acceptPartial` is NOT explicitly set: STOP. Report
  every blocker to the user and recommend re-running the review to fix them. Do NOT proceed to
  materialization. Explain that materializing from an incomplete/truncated report would silently
  drop issues.
- If `materializationReady` is `true`: proceed.
- If `materializationReady` is `false` but `acceptPartial` was explicitly set: warn the user
  loudly that the report is incomplete, list the blockers, and proceed only after confirming.

## 4. Resolve provenance

Do not run `git rev-parse HEAD` to derive the default label. Current `HEAD` may have moved since
the review. Let `review_materialize` derive the default program label from review-time provenance
recorded in the run state/result when available; if no baseline is recorded, it uses a run-id-based
fallback. If the user supplied `programLabel` explicitly, use that instead.

## 5. DRY-RUN preview (ALWAYS first)

Call `review_materialize` with `dryRun: true` to get a no-write preview:

```json
{
  "repo": "<absolute repo path>",
  "runId": "<completed repo-review run id>",
  "programLabel": "<optional explicit label>",
  "dryRun": true,
  "acceptPartial": <from step 1>
}
```

Do not pass `findings`, `findingsPath`, or `materializationReady` with `runId`; the tool refuses
mixed caller-supplied provenance. If no full findings artifact is available, the tool falls back
to the in-envelope `findings` only when the envelope says they are not truncated/lossy.

Report the dry-run result to the user:
- How many findings would be CREATED (new beads).
- How many would be SKIPPED (exact duplicates via crosswalk or external-ref).
- How many are AMBIGUOUS (semantic duplicates needing human review — show the candidate bead IDs).
- The planned epic title and final-gate title.
- The planned child labels/readiness status. Children are intentionally **not** marked
  `ready-for-agent` during materialization; a post-materialization review/remediation pass is
  still recommended before autonomous drain to catch materialization defects, but beads-drain no
  longer enforces the `ready-for-agent` label as a drain prerequisite.
- Any `lossyFindings` warning.

## 6. Explicit approval gate

Ask the user:

> The dry-run preview shows N new beads to create, M duplicates to skip, and K ambiguous items.
> Shall I proceed with creating the epic and children? This makes local Beads writes only (no
> git push, no dolt push).

Do NOT proceed unless the user explicitly says yes. If they say no, stop. If they want to
resolve ambiguous items first, suggest they review the candidate beads and re-run after.

## 7. Execute materialization (ONLY after approval)

Call `review_materialize` with `dryRun: false`:

```json
{
  "repo": "<absolute repo path>",
  "runId": "<completed repo-review run id>",
  "programLabel": "<optional explicit label>",
  "dryRun": false,
  "acceptPartial": <from step 1>
}
```

The adapter creates native Beads fields, not just markdown descriptions:

- Epic: `description`, `design`, and `acceptance` summarize the program, crosswalk, and success
  criteria.
- Children: one task per new finding, parented to the epic, with `description`, `design`, native
  `acceptance`, `implementation`/domain/size/`needs-tests` labels, and no automatic
  `ready-for-agent` label (the label is optional for drain; see the readiness note above).
- Final gate: parented to the epic, blocked by created children and safe exact existing duplicates,
  with acceptance requiring graph checks, duplicate/ambiguous reconciliation, and a clean scoped
  post-materialization review before close.

## 8. Report back

Report to the user:
- The `status` (`materialized` or `materialized_verify_failed`).
- The `epicId`, `finalGateId`, and the `created` / `skipped` / `ambiguous` lists.
- The `crosswalkPath` (`.repo-review/crosswalk/<programLabel>.json`).
- The verify result (dependency add, cycle check, graph check, and final-gate dependency readback).
- If the status is `materialized_verify_failed`, report `failedChecks` and
  `suggestedNextAction`, then run verify-only recovery before attempting another non-dry pass.
- That this was local-only (no git push, no dolt push).
- Recommend a scoped `/beads-review post-materialization parent=<epicId> gate=<finalGateId> ids=<created-child-ids> crosswalk=<crosswalkPath>` before `/beads-drain`. Do not suggest autonomous drain until the post-materialization review is clean enough and its findings have been reconciled or honestly blocked.

## 9. Boundary

This command creates LOCAL Beads writes only (`bd create`, `bd dep add`). It must NEVER:
`git push`, `git commit`, `bd dolt push`, `bd backup sync`, run `workflow_apply`, or mutate
source files. The crosswalk file under `.repo-review/` is the only file-system write outside
`.beads/`. Re-runs are idempotent: the same programLabel + findings produce no new beads (the
crosswalk + external-refs prevent double-creates).
