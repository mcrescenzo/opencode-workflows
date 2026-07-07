---
description: Run the repo-review exhaustive read-only review workflow and persist the merged eight-domain report
---

Mode: read-only review. This command runs the bundled `repo-review` META
workflow over the eight repo-* leaf domains, reads back the unified result, and
persists one merged report artifact under `.repo-review/runs/`. Use the
`repo-review-command-protocol` skill for the shared wrapper steps; this file
supplies the meta-specific args, no-fast-model policy, merged-result fields, and
materialization offer rule. It is distinct from `/repo-bughunt`, which runs only
the bughunt leaf.
Canonical references: `workflow_list({ format: "json" })` is the
machine-readable workflow discovery surface; tool mutability and safe readback
are in `docs/workflow-plugin.md#workflow-tool-reference`; raw run artifact
handling is in the README source-of-truth section.

## 1. Meta Args

Validate `$ARGUMENTS` before touching `workflow_run`.

- If `$ARGUMENTS` is empty, default to an exhaustive full-suite review:

  ```json
  { "mode": "exhaustive" }
  ```

- If `$ARGUMENTS` is non-empty, it MUST parse as valid JSON and resolve to a
  plain object. If it fails to parse, or parses to a string, number, boolean,
  array, or null, STOP before `workflow_run` and report the argument error.
- `mode` is `exhaustive` (default) or `bounded`. Exhaustive uses `depth:
  "thorough"`, high `maxReturnFindings`, and the coverage auditor lane. Bounded
  uses the legacy normal-depth pass.
- `depth` is `quick`, `normal`, or `thorough` when supplied.
- Optional recognized keys: `domains`, `paths`, `exclude`, `maxReturnFindings`,
  `batchSize`, `recon`, `maxDirs`, `deepMode`.
- `deepMode` may select `audited-shell` when the caller explicitly wants the
  command-scoped shell inspection mode and the required gates are verified.
- `domains` may name any subset of `bughunt`, `security`, `test-gaps`,
  `cleanup`, `modernize`, `perf`, `complexity`, `deps`, or their `repo-*` leaf
  names. Unknown domains are rejected rather than falling back to all domains.

Carry the validated object forward as `args`.

## 2. Resolve Model Tiers - NO FAST MODELS

Follow `workflow-model-tiering` to enumerate available models, but this command
NEVER selects a fast model. The meta's `fast` and `deep` labels are lane intent
markers, not permission to pick a low-quality model. Resolve one high-quality
deep model inside the session family and map both tiers to the same deep model:

```json
{
  "modelTiers": {
    "fast": "<the deep model>",
    "deep": "<the deep model>"
  }
}
```

If the selected model deviates from the session family, confirm explicitly before
launch. Do NOT set `maxCost` or `maxTokens`; exhaustive mode spares no expense.

## 3. Run, Read, Persist

Invoke the bundled workflow by name only, never by file path:
`workflow_run({ name: "repo-review", args, modelTiers, format: "json" })`.

```json
{
  "name": "repo-review",
  "args": "<the validated args object from step 1>",
  "modelTiers": { "fast": "<deep model>", "deep": "<deep model>" },
  "format": "json"
}
```

Use `workflow_run` for launch. If it returns a preview, report `.approvalHash`,
`.authority.profile` (`read-only-review`), and `.modelPlan`, then re-run with
`approve: true` and the matching `approvalHash`. If configured autoApprove
launches immediately, report the `runId` and status from that first call. The
meta never edits, commits, or writes files; nested leaves share the parent
`maxAgents:100000, concurrency:16` budget. Each leaf's OWN declared `maxAgents`
and `concurrency` are ignored at runtime under the meta run.

After terminal status, read the redacted envelope with:

```json
{ "runId": "<the run id>", "detail": "result" }
```

That is `workflow_status({ runId, detail: "result" })`. The merged envelope is
at `.result.output` and includes `domain: "repo-review"`, `status`, `summary`,
`counts`, ranked `findings`, `truncatedFindings`, `reportMarkdown`,
`leafOutcomes`, `partialCoverage`, `artifactPaths.reportMarkdownPath`,
`materializationReady`, `materializationBlockers`, `coverageGrade`,
`coverageAdvisories`, `coverageAudit`, and `artifactPaths.findingsJson`.

Persist exactly one report:

- Directory: `mkdir -p .repo-review/runs`
- File: `.repo-review/runs/<run-id>-repo-review-report.md`
- Preferred: read `artifactPaths.reportMarkdownPath` and use that full ranked cross-domain markdown report.
- Fallback: if `reportMarkdown` is non-null, treat it as a bounded
  preview/fallback body.
- Fallback: when `reportMarkdown` is null or omitted for size, synthesize a short
  fallback summary from returned `summary`, `counts`, `leafOutcomes`, and
  `findings` only. State that full `reportMarkdown` was omitted for size /
  256 KiB cap and do not invent findings outside the returned subset.
- Footer: `Report-only - nothing applied.`

## 4. Coverage And Materialization

Report `leafOutcomes` and `partialCoverage` so the user sees which domains
completed or failed. Report materialization readiness separately:
`materializationReady`, `materializationBlockers`, `coverageGrade`,
`coverageAdvisories`, and `coverageAudit`.

If `materializationReady` is true and there is at least one finding, first
confirm the Beads extension has contributed `/review-materialize` in the command
registry. If that command is absent, report that the command is unavailable and
do not offer an unavailable action. If available, offer the user the option of
creating a duplicate-aware Beads epic via separately approved
`/review-materialize` with the completed review's `runId`. The materialization
tool validates `domain: "repo-review"`, consumes `artifactPaths.findingsJson`,
passes the full findings through its `findingsPath` handoff, and derives its
default program label from review-time provenance rather than current `HEAD`.

If `materializationReady` is false, list every blocker and state that
materialization is blocked. Do not proceed.

## 5. Boundary

This command is report-only. It must never run `materialize`, `beads-drain`,
`workflow_apply`, any `git` write, or any `bd` create/update/close/claim. The
ONLY allowed workspace write is the local
`.repo-review/runs/<run-id>-repo-review-report.md` report artifact. The
materialization item above is a question to the user, not a mutation from this
command. `.repo-review/` is gitignored; do not stage or commit it.

## 6. Report Back

Report the validated args including `mode`, model plan confirming both tiers
resolved to the same deep model - no fast model, `approvalHash` when a preview
was shown, `runId`, terminal status, envelope `status`/`summary`/`counts`,
`leafOutcomes`, `partialCoverage`, `materializationReady`,
`materializationBlockers`, `coverageGrade`, `coverageAudit`, whether the full
artifact, bounded `reportMarkdown` preview/fallback, or size-fallback summary
was used, `truncatedFindings`, and the absolute report path.
