---
name: repo-review-command-protocol
description: Use when running or maintaining the bundled /repo-bughunt and /repo-review commands. Provides the shared command wrapper protocol for JSON argument validation, workflow_run launch by name, workflow_status detail=result readback, .repo-review/runs report persistence, report-only mutation boundaries, and concise closeout.
---

# Repo-Review Command Protocol

This skill holds the shared command wrapper protocol for `/repo-bughunt` and
`/repo-review`. The command markdown supplies command-specific defaults,
workflow name, model-tier policy, result fields, and optional materialization
handling.

## Shared Steps

1. Parse `$ARGUMENTS` before touching `workflow_run`.
   - Empty arguments use the command's documented default object.
   - Non-empty arguments must parse as valid JSON and resolve to a plain object.
   - On parse failure or non-object input, STOP before `workflow_run`; report the
     offending value and expected object shape.

2. Resolve models before launch.
   - Follow `workflow-model-tiering` unless the command markdown declares a
     command-specific model policy.
   - Pass the final map as `modelTiers`.

3. Launch by bundled workflow name, never by path.
   - Use `workflow_run({ name, args, modelTiers, format: "json" })`.
   - If the call returns a preview, report `approvalHash`,
     `authority.profile`, and `modelPlan`, then launch with `approve: true` and
     the matching hash.
   - If configured `autoApprove` makes the first call execute immediately, report
     the returned `runId` and status instead of inventing a preview step.

4. Read the terminal result through
   `workflow_status({ runId, detail: "result" })`.
   - Use `.result.output` as the envelope.
   - Treat raw `.opencode/workflows/runs/` files as local-sensitive artifacts.

5. Persist exactly one report under `.repo-review/runs/`.
   - Create the directory if needed with `mkdir -p .repo-review/runs`.
   - Use the command-specific filename suffix.
   - Prefer the command-specific full report source. If the full markdown is
     absent or omitted for size, synthesize the documented fallback summary from
     returned `summary`, `counts`, and `findings` only.
   - Add a `Report-only - nothing applied.` footer.

6. Enforce the report-only boundary.
   - The ONLY allowed workspace write is the local report file.
   - The command itself must never run `materialize`, `beads-drain`,
     `workflow_apply`, any `git` write, or any `bd` create/update/close/claim.
   - Do not stage or commit the report; `.repo-review/` is gitignored.

7. Report back concisely.
   - Include validated args, model plan, approval hash when there was a preview,
     run id, terminal status, envelope status/summary/counts, report source or
     fallback mode, truncation flags, and the absolute report path.
