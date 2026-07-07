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

## Procedure

1. **Get the plan or run.** Prefer `workflow_run({ name: "...", args: {...}, format: "json", ... })`.
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
   - **Authority** — `Authority profile`, `Required gates`, `Isolation`, `Mutation domains`. Call
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
   - `background: true/false` — keep a control channel for pause/cancel on long runs.
   - `maxCost` / `maxTokens` — budget ceilings are approval-envelope decisions; workflow bodies can
     self-scale with `budget.remaining()` and `budget.ceilings()`.
   - `laneTimeoutMs` (alias `childPromptTimeoutMs`) — per-lane prompt cap.

   **Per-workflow scope knobs** — read them from `runtimeArgsPreview` (or the text preview's
   `Runtime args preview` line) and the workflow's declared args (e.g. `paths`/`depth`/
   `categories` for repo-bughunt, `domains`/
   `batchSize` for repo-review, `mode`/`scope` for beads-drain). If you are unsure which scope args
   a named workflow accepts, check `workflow_list` or read its source before offering them.

4. **Re-plan on any change.** If the user refines anything, re-call `workflow_run` **without**
   `approve` with the new args/modelTiers/budget. You get a fresh preview and a fresh `approvalHash`
   (the old hash is now stale and `approve:true` with it returns `approval_mismatch` and
   `executed:false`). Present again. This loop is free — use it.

5. **Approve or continue.** For the manual path, once the user confirms the plan, re-call
   `workflow_run` with `approve: true` and the matching `approvalHash` from the most recent preview.
   Do not call `approve: true` in the same turn you presented the plan unless the user already said
   to run it. For an auto-approved run, skip this step and read back the result.

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

- **Static fan-out** (repo-bughunt, repo-* leaves, repo-review): the structure is knowable
  (e.g. recon → N finders → skeptics → pure-JS synth), but some counts depend on results (number
  of skeptics depends on number of findings). Present the *structure* and flag counts that are
  data-dependent rather than implying a fixed number.
- **Discovery-driven** (beads-drain): the lane count depends on the live backlog. For beads-drain
  specifically, the dry-run (`mode: "dry-run"`) **is** the plan — it reports the ready items that
  would be worked. Offer a dry-run as the preview for non-dry intent.
- **Dynamic/inline**: if you cannot determine the structure, say so plainly and lean on the
  envelope (authority, models, budget, background) plus `Max agents` as the ceiling.

In all cases, present what you know and label what is uncertain. Never invent a precise lane count.
