---
description: Run the repo-bughunt read-only review workflow and persist a single-domain report
---

Mode: read-only review. This command runs only the bundled `repo-bughunt` leaf
workflow, reads back its result, and persists one report artifact under
`.repo-review/runs/`. Use the `repo-review-command-protocol` skill for the
shared wrapper steps; this file supplies the bughunt-specific args, workflow
name, result fields, and report filename.
Canonical references: `workflow_list({ format: "json" })` is the
machine-readable workflow discovery surface; tool mutability and safe readback
are in `docs/workflow-plugin.md#workflow-tool-reference`; raw run artifact
handling is in the README source-of-truth section.

## 1. Bughunt Args

Validate `$ARGUMENTS` before touching `workflow_run`.

- If `$ARGUMENTS` is empty, default to the engine's thorough read-only review:

  ```json
  {}
  ```

- If `$ARGUMENTS` is non-empty, it MUST parse as valid JSON and resolve to a
  plain object. If it fails to parse, or parses to a string, number, boolean,
  array, or null, STOP before `workflow_run` and report the argument error.
- If present, `depth` MUST be one of `quick`, `normal`, or `thorough`.
- Optional recognized keys: `paths`, `exclude`, `categories`,
  `maxReturnFindings`, `recon`. Pass through only what the user supplied.

Carry the validated object forward as `args`.

## 2. Models

Follow the `workflow-model-tiering` skill before invoking `workflow_run`: call
`workflow_models`, map `fast` (recon + finders) and `deep` (skeptics) to concrete
models inside the invoking session family, and confirm with the user only when
the plan deviates from that family. Pass `modelTiers: { fast, deep }`.

## 3. Run, Read, Persist

Invoke the bundled workflow by name only, never by file path:
`workflow_run({ name: "repo-bughunt", args, modelTiers, format: "json" })`.

```json
{
  "name": "repo-bughunt",
  "args": "<the validated args object from step 1>",
  "modelTiers": { "fast": "<fast model>", "deep": "<deep model>" },
  "format": "json"
}
```

Use `workflow_run` for launch. If it returns a preview, report `.approvalHash`,
`.authority.profile` (`read-only-review`), and `.modelPlan`, then re-run with
`approve: true` and the matching `approvalHash`. If configured autoApprove
launches immediately, report the `runId` and status from that first call.

After terminal status, read the redacted envelope with:

```json
{ "runId": "<the run id>", "detail": "result" }
```

That is `workflow_status({ runId, detail: "result" })`. The leaf envelope is at
`.result.output`: `status`, `summary`, `counts`, `findings`,
`truncatedFindings`, and `reportMarkdown`.

Persist exactly one report:

- Directory: `mkdir -p .repo-review/runs`
- File: `.repo-review/runs/<run-id>-bughunt-report.md`
- Preferred: write `.result.output.reportMarkdown` when present.
- Fallback: when `reportMarkdown` is null or omitted for size, synthesize a short
  fallback summary from returned `summary`, `counts`, and `findings` only. State
  that full `reportMarkdown` was omitted for size / 256 KiB cap and do not invent
  findings outside the returned subset.
- Footer: `Report-only - nothing applied.`

## 4. Boundary

This command is report-only. Avoid `materialize`, `beads-drain`,
`workflow_apply`, any `git` write, and any `bd` create/update/close/claim. The
ONLY allowed workspace write is the local
`.repo-review/runs/<run-id>-bughunt-report.md` report artifact. `.repo-review/`
is gitignored; do not stage or commit it.

## 5. Report Back

Report the validated args, model plan, `approvalHash` when a preview was shown,
`runId`, terminal status, envelope `status`/`summary`/`counts`, whether
`reportMarkdown` was present or the size-fallback summary was rendered,
`truncatedFindings`, and the absolute report path.
