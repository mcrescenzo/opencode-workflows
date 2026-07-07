---
name: workflow-model-tiering
description: Use BEFORE running any workflow whose lanes declare fast/deep tiers (e.g. repo-bughunt). Enumerate available models with workflow_models, map fast/deep to concrete models in the invoking session's family, and confirm with the user ONLY when the plan deviates from that family.
---

# Workflow model tiering

Workflows declare each lane's intent as `tier: "fast"` (cheap/bulk) or `tier: "deep"`
(subtle reasoning); pure-JS lanes declare no model. The kernel resolves each tier to a
concrete `provider/model` string from the run's `modelTiers` map, falling back to the
invoking session's model (and finally to `DEFAULT_CHILD_MODEL`). Your job before running
such a workflow is to pick the concrete fast/deep models and pass them as `modelTiers`.

## Procedure

1. **Enumerate.** Call `workflow_models`. Read `session.model` / `session.family` and the
   available `providers[].models` (each model may list reasoning `variants`, e.g. `max`).
   `suggested.fast` / `suggested.deep` both default to the session model — a safe
   no-deviation starting point.

2. **Map within the session family.** Choose concrete `fast`/`deep` models *inside the
   session family*:
   - `fast` = the session model (or the cheapest reasonable model in the family).
   - `deep` = a higher-reasoning model or reasoning variant in the same family if one
     exists (e.g. a `max` variant). If the family has only one model, `deep = fast`.

3. **Deviation check.** The plan is NON-deviating when both tiers stay in the session
   family at standard escalation. It DEVIATES when you pick a different provider family, a
   premium cross-family `deep`, or mix families.
   - **No deviation:** proceed. The `workflow_run` approval preview shows the model plan
     (`Model plan: fast=… deep=…`); the user approving that preview is the confirmation.
     Do NOT add a separate prompt.
   - **Deviation:** STOP and confirm explicitly with the user — state the chosen models and
     why — BEFORE calling `workflow_run`.

4. **Run.** Call `workflow_run({ name: "<workflow>", args: {...}, modelTiers: { fast, deep } })`,
   read the `approvalHash` from the returned preview, then call again with `approve: true`
   and that `approvalHash`. Never set `maxCost` / `maxTokens` casually; ceilings are
   part of the approved envelope, and workflow bodies should use `budget.remaining()`
   or `budget.ceilings()` when they need to self-scale.

## Notes

- Omitting `modelTiers` is valid: every tier then resolves to the session model (a safe
  no-deviation default). Pass `modelTiers` only to differentiate `deep` from `fast`.
- An explicit per-lane `model` in a workflow's source overrides tiers entirely;
  report-only review workflows should not use it.
- A per-lane `effort` hint is separate from tier selection. Use it only for lanes
  that resolve to an OpenAI provider, with `minimal`, `low`, `medium`, or `high`
  values, for example `agent(prompt, { tier: "deep", effort: "high" })`. The
  plugin applies it through OpenAI `chat.params` provider options. Do not assume
  provider variants or non-OpenAI providers support this knob; unsupported
  providers fail before child launch.
- `modelTiers` is covered by the approval hash, so changing the model plan re-triggers
  approval — you cannot silently swap models behind an already-approved hash.
- Models are `provider/model` strings (exactly one `/`). A malformed tier value is a hard
  error at planning time.
