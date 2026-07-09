---
description: Deep multi-source research with adversarial fact-checking — runs the bundled deep-research workflow and writes a cited report.
---

# /deep-research

Run the bundled `deep-research` workflow end to end: refine the question, launch with
network authority, wait for the run, persist a cited markdown report, and summarize.

The user's request: $ARGUMENTS

## Protocol

Follow these steps in order. Do not skip the approval preview and do not apply any
repository changes — this command is read-only research plus exactly one report file.

### 1. Clarify the question

If the request is underspecified (e.g. "what car should I buy" with no budget, use-case,
or region), ask 2-3 narrowing questions first and weave the answers into a single,
specific research question. If it is already specific, proceed without asking.

### 2. Resolve model tiers

Use the `workflow-model-tiering` skill: call `workflow_models`, then map `fast` to a
cheap same-family model (search/extract lanes) and `deep` to the session family's
strongest reasoning model (scope/verify/synthesize lanes). Only confirm with the user if
you deviate from the session's model family.

### 3. Launch by name

Preview first (two-phase approval):

    workflow_run({
      name: "deep-research",
      args: { question: "<refined question>", depth: "<quick|normal|thorough>" },
      modelTiers: { fast: "<provider/model>", deep: "<provider/model>" },
      format: "json",
    })

Present the approval preview human-first (per the `workflow-plan-review` skill): what it
will do, the model tiers, the lane budget (~97 lanes at thorough), and — the headline —
that the run carries **network authority** (`websearch`/`webfetch`) for its search, fetch,
and verify lanes while scope/synthesize lanes stay read-only. Offer the depth /
`maxSources` / `concurrency` knobs. Then approve by re-issuing the SAME call plus
`approve: true, approvalHash: "<hash from the preview>"` (a name-resolved approval must
re-send the same `name` and `args`).

Optional args: `depth` (default `thorough` — Claude Code parity, 3-vote verification),
`maxSources` (3-30), `seedUrls` (array of known-good URLs; also the fallback when web
search is unavailable). `args` may also be a plain question string.

### 4. Read back

Poll `workflow_status({ runId, detail: "compact" })` while the run progresses. On
completion, read `workflow_status({ runId, detail: "result" })`. The workflow's envelope lives under the result's `output` field (e.g. `result.output.reportMarkdown`), not flat on the result. The envelope's
`reportMarkdown` holds the rendered report; if it was dropped for size
(`reportMarkdown: null` with `artifacts.ok: true`), read the full `report.md` from the
run's artifacts directory (`artifacts.dir`).

If `status` is `"failed"` with `abortReason: "websearch-unavailable-or-empty"`, tell the
user web search appears unavailable in this opencode install and offer a `seedUrls` retry.
If `abortReason` is `"verifiers-failed"`, tell the user verification infrastructure failed
and offer a retry — do NOT present unverified claims as findings.

### 5. Persist exactly one report

Write the report to `.deep-research/runs/<run-id>-report.md` in the project root,
prefixed with a header: date, question, depth, model tiers, and the
confirmed/killed/unverified counts from `stats` (the envelope's top-level `refuted` array holds the refuted claims' details). Create the directory if needed. When in
a git repository, ensure `.deep-research/` is listed in `.gitignore` (append it if
missing). Write no other files.

### 6. Summarize in chat

Lead with the answer (the executive summary), then confidence spread, notable refuted
claims (transparency), caveats, and the report path.

### 7. Offer follow-ups (do not run them unprompted)

- A deeper pass on one of the report's open questions.
- Re-verifying a specific claim the user doubts.
- Re-running at `thorough` depth if a cheaper depth was used.

End with: `Report-only — nothing applied.`
