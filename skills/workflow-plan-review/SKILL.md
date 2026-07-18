---
name: workflow-plan-review
description: Use whenever you are about to run an OpenCode workflow via workflow_run, or have just called it without approve and are holding the approval summary. Covers presenting the workflow plan to the user human-first, offering structured refinement knobs plus free-text, choosing between configured autoApprove and manual approvalHash launch, and reading results back. Distinct from workflow-model-tiering and opencode-workflow-authoring.
---

# Workflow plan review (the run handoff)

Workflow authority is fixed **once at launch**. On the manual path, the approval
hash covers the whole envelope (source, args, authority, models, budgets,
concurrency, capabilities, nested snapshots). On the configured `autoApprove`
path, eligible runs can launch on the first call when their resolved authority
tier is within the configured ceiling. In both cases, treat the launch plan as
something to understand and refine, not a hash to echo back.

This skill is the **canonical owner** of the generic launch → approval →
background-handoff → completion-notification → result-readback contract. Other surfaces
(authoring skill, model-tiering skill, deep-research command, README, recipes)
point here for that flow and retain only their domain-specific guidance.

## Procedure

1. **Get the plan or run.** Prefer `workflow_run({ name: "...", args: {...}, background: true, format: "json", ... })`.
   For agent invocations, explicitly pass `background: true` unless the user requested foreground;
   preserve that value on the approval call because it is part of the approval envelope.
   If the plugin is not auto-approving this authority tier, the returned JSON is a typed
   `workflow_preview` envelope with `executed: false`, `approvalHash`, `workflow`, `source`,
   `runtimeArgsPreview`, `laneBudget`, `modelPlan`, `budgetCeilings`, `background`, `authority`,
   `mutationDomains`, `capabilities`, and `nestedSnapshots`. If configured `autoApprove` makes the
   call execute immediately, report the run id/status and move to result readback instead of
   inventing a preview step.

2. **Present human-first.** Summarize the plan to the user in your own words, leading with what
   they actually care about, in roughly this order:
   - **What it will do** — the Description and the scope in `Runtime args preview`.
   - **Models** — `Default child model` and `Model plan: fast=… deep=…`.
   - **Lane budget** — `Max agents` (the ceiling on child lanes) and `Concurrency` (peak parallel).
   - **Cost/time** — `Budget ceilings`, `Lane timeout`, and the run deadline if present.
   - **Authority** — `Authority profile`, `Isolation`, `Mutation domains`, `Capability note`. Call
     out anything that mutates state or stops at `awaiting-diff-approval` / in-run apply.
   - **Background** — `Background: true/false`, and the heuristic recommendation line if present.
   You may condense or omit the technical envelope (hashes/capabilities/consent) from what you
   show the user — it is there for accuracy, not for the headline.

3. **Offer refinement.** Give the user concrete knobs to tweak, plus a free-text channel. Surface
   the knobs that are relevant to *this* workflow.

   **Universal knobs** (every workflow accepts these as `workflow_run` args):
   - `modelTiers: { fast, deep }` — see the `workflow-model-tiering` skill for how to pick them.
   - `maxAgents` — ceiling on child lanes launched (one slot per `agent()` lane).
   - `concurrency` — peak parallel lanes.
   - `background: true/false` — agents default to `true` so they can yield for the completion
     notification and retain a control channel; use `false` only when foreground was explicitly
     requested or an immediate blocking result is materially necessary.
   - `maxCost` / `maxTokens` — budget ceilings are approval-envelope decisions; workflow bodies can
     self-scale with `budget.remaining()` and `budget.ceilings()`.
   - `laneTimeoutMs` (alias `childPromptTimeoutMs`) — per-lane prompt cap.

   **Per-workflow scope knobs** — read them from `runtimeArgsPreview` (or the text preview's
   `Runtime args preview` line) and the workflow's declared args (e.g. paths/depth/categories for a
   review leaf, domains/batchSize for a meta-orchestrator, mode/scope for a drain workflow). If you
   are unsure which scope args a named workflow accepts, check `workflow_list` or read its source
   before offering them.

4. **Re-plan on any change.** If the user refines anything, re-call `workflow_run` **without**
   `approve` with the new args/modelTiers/budget. You get a fresh preview and a fresh `approvalHash`
   (the old hash is now stale and `approve:true` with it returns `approval_mismatch` and
   `executed:false`). Present again. This loop is free — use it.

5. **Approve or continue.** For the manual path, once the user confirms the plan, re-call
   `workflow_run` with `approve: true` and the matching `approvalHash` from the most recent preview.
   Do not call `approve: true` in the same turn you presented the plan unless the user already said
   to run it. For an auto-approved run, skip this step and read back the result.

   For an inline-source preview, omit `source` on approval (approve-by-reference),
   but preserve the other approved inputs such as `args`, `modelTiers`, and
   `background: true`, alongside `approve: true` and the matching `approvalHash`.

## When you may skip the confirmation step

- The plugin is configured with `options.autoApprove` and the resolved authority tier is covered by
  that ceiling; the first `workflow_run` call may execute immediately.
- The user explicitly said to just run it ("go ahead", "run it", "approve") in this turn or a prior
  instruction that clearly covers this run.
- You are **resuming** an already-approved envelope via `resumeRunId` (the user already approved
  that envelope; resume replays/re-runs under the same hash). A *cold* plan is always confirmed.

If unsure whether the user pre-authorized, ask. A confirmation question is always cheaper than an
unwanted multi-lane run.

## Graceful degradation

Not every workflow has a static lane count you can quote up front:

- **Static fan-out** (review leaves and meta-orchestrators): the structure is knowable
  (e.g. recon → N finders → skeptics → pure-JS synth), but some counts depend on results (number
  of skeptics depends on number of findings). Present the *structure* and flag counts that are
  data-dependent rather than implying a fixed number.
- **Discovery-driven** (a drain workflow): the lane count depends on the live backlog/queue. For a
  drain workflow specifically, the dry-run (`mode: "dry-run"`) **is** the plan — it reports the
  ready items that would be worked. Offer a dry-run as the preview for non-dry intent.
- **Dynamic/inline**: if you cannot determine the structure, say so plainly and lean on the
  envelope (authority, models, budget, background) plus `Max agents` as the ceiling.

In all cases, present what you know and label what is uncertain. Never invent a precise lane count.

## Background runs and completion notification

Agent callers should explicitly pass `background: true` by default. The kernel's
omission behavior remains a compatibility fallback: it defaults only wide, deep,
or long runs to background using a heuristic. Explicit `background: true` or
`false` always wins, and resume keeps the pinned mode.

- **Foreground** (`background: false`): the `approve` call blocks until the run
  finishes and returns the terminal result inline (see Result readback below).
- **Background** (`background: true`): the `approve` call returns immediately
  with a run id while execution continues in the current OpenCode process. Keep
  the run id, then **yield the turn; do not poll**. When the workflow reaches a
  terminal state, its best-effort completion prompt normally resumes the invoking
  session. Read the result once at that point and summarize it for the user.

Use `workflow_status({ runId, detail: "compact" })` before notification only when
the launch warning says completion prompts are unavailable, the user explicitly
asks for progress, you need pause/cancel control, or you are diagnosing/recovering
a stale or failed delivery. Continuous polling keeps the session active and can
delay the idle-gated completion prompt.

Completion delivery is best-effort. A failed prompt remains persisted for retry
on a later idle event; use compact status only when diagnosing that recovery case.

Background execution is not durable across OpenCode process death; use
`workflow_reconcile` to recover stale runs after a restart. Lifecycle tools:
`workflow_cancel` (cooperative stop), `workflow_pause` (stop and preserve for
resume), `workflow_kill` (force-terminate a wedged run when cancel/pause do not
return), `workflow_events` (redacted lifecycle event log), and `workflow_salvage`
(recover orphaned read-only lane results from an interrupted run — preview first,
then approve).

## Result readback

A **completed foreground** `workflow_run` returns a terminal summary inline — the
result is already in the approve response. **Do not re-read it** with
`workflow_status`; that is redundant.

`workflow_status({ runId, detail: "result" })` is the redacted, full-fidelity
readback. Use it when:

- A **background completion notification** resumed the session — read
  `detail: "result"` exactly once, then report the outcome.
- A background launch explicitly warned that completion prompts are unavailable
  — poll `detail: "compact"` as the fallback, then read `detail: "result"` once.
- The foreground response said the result was **omitted for size** — the inline
  return exceeded the display cap; the response points you at the persisted
  result. `detail: "result"` then returns the full data, or a partial readback
  with `resultReadback.truncated` when even that is too large.

Never read raw run files under `.opencode/workflows/runs/` for results; they can
contain sensitive, unredacted local evidence. `workflow_status detail=result` and
`workflow_events` are both redacted.

## Edit boundary and in-run auto-apply

Normal edit-capable runs stop at `awaiting-diff-approval`. Primary-tree writes
happen only through `workflow_apply`, after source/base/diff/domain hashes and a
clean Git base are checked. This hash gate is independent of the launch approval.

The one exception is an autonomous-local drain. It may apply its verified diff
plan in-run — right after its one-time launch approval — **only when auto-apply is
actually eligible**: the workflow source is a trusted extension-registered
workflow (not a project/global shadow) **and** its registered drain adapter
declares `supportsAutoApply: true`. A drain that does not meet both conditions
stops at `awaiting-diff-approval` like any other edit run. The bundled
`deep-research` workflow is read-only and stages no writes.
