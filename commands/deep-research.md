---
description: Deep multi-source research with adversarial fact-checking — runs the bundled deep-research workflow and writes a cited report.
---

# /deep-research

Run the bundled `deep-research` workflow end to end: check the question's fit, refine it,
launch with network authority, read back the run, persist a cited markdown report, and
summarize.

The user's request: $ARGUMENTS

## Protocol

Follow these steps in order. Do not skip the approval preview. This command applies no
repository changes beyond the one report file and, when in a git repository, a one-line
`.gitignore` entry keeping `.deep-research/` out of version control — it is otherwise
read-only research.

### 1. Clarify the question and check fit

`deep-research` is a **web** research harness (`websearch`/`webfetch` lanes — no shell, no
MCP, no edits). Before refining, check fit:

- **Poor fit** — the question is actually about this repository or private/internal code
  (e.g. "review our toast system", "why does our auth flow fail"): say plainly that
  `/deep-research` searches the public web and cannot see local/private code, suggest a
  local investigation as the right tool, and proceed only if the user confirms — e.g.
  because the real ask is public prior art, or they can supply `seedUrls` pointing at
  public docs about the underlying tech. The workflow itself will attach a `fitWarning`
  to the envelope and report when its scope lane detects this.
- **Underspecified** (e.g. "what car should I buy" with no budget, use-case, or region):
  ask 2-3 narrowing questions first and weave the answers into a single, specific
  research question.
- **Specific and web-researchable:** proceed without asking.

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
      background: true,
      format: "json",
    })

Invoking `/deep-research` is itself the user's consent to launch this run — treat it as
the "prior instruction that clearly covers this run" that `workflow-plan-review`'s
same-turn exception allows. Present the preview as narration, human-first: what it will
do, the model tiers, the lane estimate, and — the headline — that the run carries
**network authority** (`websearch`/`webfetch`) for its search, fetch, and verify lanes
while scope/synthesize lanes stay read-only. Quote the lane budget honestly: `thorough`
fans out roughly 1 scope + 5 search + 15-25 fetch + 75 verify + 1 synthesis lanes
(~100 expected; fetch can pass the 15-source floor because high-relevance results always
fetch), and `Max agents` (160) is the hard ceiling, not the expected count. Name the
knobs the user could have set instead — `depth`, `maxSources`, `seedUrls`,
`concurrency`, `background` — then, in the SAME turn, re-issue the call with
`approve: true`, `approvalHash: "<hash from the preview>"`, and the exact preview
envelope: the same `name`, `args`, `modelTiers`, and `background: true`. For example:

    workflow_run({
      name: "deep-research",
      args: { question: "<refined question>", depth: "<quick|normal|thorough>" },
      modelTiers: { fast: "<provider/model>", deep: "<provider/model>" },
      background: true,
      format: "json",
      approve: true,
      approvalHash: "<hash from the preview>",
    })

Close the launch message by telling the user how to
re-run with different knobs if the defaults weren't what they wanted.

Optional args: `depth` (default `thorough` — 3-vote verification; `quick`/`normal` use
single-vote panels, so individual refutations there are one verifier's judgment),
`maxSources` (3-30 — an explicit value is a HARD cap that seed URLs also consume),
`seedUrls` (known-good URLs; also the fallback when web search is unavailable). `args`
may also be a plain question string.

### 4. Read back

This workflow declares `recommendBackground`, so the approve call normally returns
immediately with a run id (`background: true`). Keep the run id, end the turn, and
wait for the best-effort completion notification to resume this session; **do not poll**.
When notified, read `workflow_status({ runId, format: "json", detail: "result" })`
exactly once. Poll `detail: "compact"` only if launch explicitly warns that completion
prompts are unavailable, or if the user asks for progress/control. If the user forced
`background: false`, the result is already inline in the approve response — do not
re-read it.

The workflow's envelope lives under the result's `output` field
(e.g. `result.output.reportMarkdown`), not flat on the result. The outer
`completed`/`failed` word reflects run execution; always read the envelope's own
`status`/`abortReason` for the research outcome. Then branch:

- `reportMarkdown` is a string → that is the rendered report.
- `reportMarkdown: null` with `artifacts.ok: true` → the report was dropped for envelope
  size; read `report.md` from `artifacts.dir`.
- `reportMarkdown: null` and (`artifacts` is null or `artifacts.ok` is false) → there is
  NO rendered report anywhere. For a `degraded` synthesis-salvage envelope (findings
  present), assemble the persisted report yourself from the envelope's `summary`,
  `findings`, `refuted`, `unverified`, and `caveats`. For failed aborts, skip step 5
  entirely and report the failure.

Failure guidance: `websearch-unavailable-or-empty` → web search appears unavailable in
this opencode install; offer a `seedUrls` retry. `verifiers-failed` → verification
infrastructure failed; offer a retry and do NOT present unverified claims as findings.
`no-central-claims` → claims were extracted but none rated central at this depth; offer a
re-run at `normal`/`thorough`. If the envelope carries a `fitWarning`, repeat it
prominently in your summary.

### 5. Persist exactly one report

Write the report to `.deep-research/runs/<run-id>-report.md` in the project root. Reuse
the report's own H1 (`# Deep Research: <title>`) — never invent a placeholder heading —
and insert a metadata block between the H1 and the body:

```markdown
# Deep Research: <the report's own title line>

- **Date:** <YYYY-MM-DD>
- **Question:** <verbatim research question>
- **Depth:** <quick|normal|thorough>
- **Model tiers:** fast=<provider/model>, deep=<provider/model>
- **Confirmed / refuted / unverified:** <n> / <n> / <n> (from `stats`; the envelope's
  top-level `refuted` array holds the refuted claims' details)

---

<reportMarkdown content from "## Executive summary" onward, unmodified>
```

Create the directory if needed. When in a git repository, ensure `.deep-research/` is
listed in `.gitignore` (append it if missing). Write no other files beyond the report and
that `.gitignore` entry.

### 6. Summarize in chat

Lead with the answer (the executive summary), then confidence spread, notable refuted
claims (transparency), any `fitWarning`, caveats, and the report path.

### 7. Offer follow-ups (do not run them unprompted)

- A deeper pass on one of the report's open questions.
- Re-verifying a specific claim the user doubts.
- Re-running at `thorough` depth if a cheaper depth was used.

End with: `Report-only — nothing applied.`
