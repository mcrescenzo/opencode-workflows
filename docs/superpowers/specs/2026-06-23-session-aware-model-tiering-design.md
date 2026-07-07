# Session-aware model tiering for the workflow system — Design

> Status: **historical design snapshot**. Approved on 2026-06-23 and retained for
> provenance; current behavior is in `workflow_models`, model-tiering tests, and active docs.

**Goal:** Make workflow model selection intelligent and provider-agnostic: every lane inherits the *invoking session's* model by default, workflows express model *intent* as `fast`/`deep` tiers (not hard-coded model ids), the planning agent can enumerate the actually-available/authenticated models and propose a concrete mapping, and a surprising/expensive choice is confirmed with the user before the run executes.

**Why:** Today the kernel hard-codes `DEFAULT_CHILD_MODEL = "openai/gpt-5.5"` (`constants.js:33`) and every workflow that wants tiering must bake in concrete `provider/model` strings. That is wrong in two ways: (1) it ignores what the user actually launched the session with (e.g. `glm-5.2`), and (2) it makes workflows non-portable across providers. The ported `repo-bughunt` engine would have to choose models blindly. This feature fixes both generically, so all workflows benefit.

## Decisions (resolved during brainstorming)

1. **Architecture: hybrid.** The kernel guarantees a sane default (session-model inheritance) and resolves tiers; the planning agent adds intelligence (reads available models, proposes a concrete mapping) and confirms with the user on deviation. Neither side alone.
2. **Intent vocabulary: two tiers — `fast` and `deep`.** `fast` = cheap/high-throughput bulk work; `deep` = reserve for subtle reasoning. Pure-JS lanes declare no model. Resolves per family (cheaper-vs-premium model, or standard-vs-higher reasoning variant; single-model families collapse `fast == deep`).
3. **"Session model" = the active/launched model**, with its provider family inferred, falling back to the configured default only if the active model can't be read. (Driven by the user's example: launching with `glm-5.2` must pick glm, even though `opencode.json` defaults to `openai/gpt-5.5`.)
4. **Confirmation: confirm only on deviation.** A plan that stays in the session family at standard tiers is shown in the existing approval preview and approved as normal — no extra prompt. The agent explicitly stops to confirm ONLY when it deviates: a different provider family, a premium cross-family `deep`, or mixed families.

## Scope & decomposition

Two pieces, built in order:

- **Piece 1 (this spec):** the generic kernel capability + one planning-agent skill. Built and tested standalone.
- **Piece 2:** the existing `repo-bughunt` port (`docs/superpowers/plans/2026-06-23-port-repo-bughunt-to-opencode.md`), revised to *consume* this — its lanes declare tiers instead of hard-coding `openai/gpt-5.5`.

Piece 1 is a prerequisite for Piece 2's revised model handling.

## Architecture

Clean separation of responsibility:

```
PLANNING AGENT (host turn, has SDK + reasoning)
  └─ workflow_models  ──► sees session model + available providers/models
  └─ maps fast/deep ──► concrete provider/model within the session family
  └─ deviation? ─────► AskUserQuestion (explicit) | else proceed
  └─ workflow_run({ ..., modelTiers: { fast, deep } })

KERNEL (host)
  └─ run setup: defaultChildModel = …args/meta… || activeSessionModel || DEFAULT_CHILD_MODEL
  └─ stores run.modelTiers
  └─ approval preview shows the model plan; approvalHash covers modelTiers
  └─ runChildAgent: laneModel = opts.model || run.modelTiers[opts.tier] || run.defaultChildModel

GUEST (QuickJS workflow body — deterministic, no SDK)
  └─ agent(prompt, { tier: "fast" | "deep", schema, ... })   // intent only; no model strings
```

The guest never sees the model list; the agent resolves intent → concrete models *before* the run, and the kernel maps a lane's declared tier to those concrete models at dispatch time.

## Components

### C1. Discovery tool: `workflow_models` (new, read-only)

A new tool alongside the other `workflow_*` tools. No approval, no mutation. Returns:

```jsonc
{
  "session": { "model": "zai-coding-plan/glm-5.2", "providerID": "zai-coding-plan", "modelID": "glm-5.2", "family": "zai-coding-plan", "source": "active" | "config-default" },
  "providers": [
    { "id": "zai-coding-plan", "name": "...", "source": "config",
      "models": [ { "id": "glm-5.2", "name": "...", "variants": ["high","max"] } ],
      "default": "glm-5.2" }
    // ... every provider client.config.providers() returns (i.e. available/authenticated)
  ],
  "suggested": { "fast": "zai-coding-plan/glm-5.2", "deep": "zai-coding-plan/glm-5.2" }
}
```

- `providers` comes straight from `client.config.providers()` (`{ providers: Provider[], default: {providerID: modelId} }`; `Provider` = `{ id, name, source: "env"|"config"|"custom"|"api", models, ... }`). OpenCode only returns usable providers, so this *is* the authenticated/available list.
- `session` is the active model (best-effort; see Risk R1), with `source` flagging whether it came from the live session or the configured default fallback.
- `suggested` is the kernel's no-deviation default mapping for the session family — the agent may accept it verbatim (then there is nothing to confirm).

### C2. Session-model inheritance (kernel)

At run setup (`workflow-plugin.js:1883`), change the default resolution from:

```
args.childModel || meta.childModel || meta.defaultChildModel || DEFAULT_CHILD_MODEL
```

to insert the active session model just before the hard-coded constant:

```
args.childModel || meta.childModel || meta.defaultChildModel || activeSessionModel || DEFAULT_CHILD_MODEL
```

`activeSessionModel` is fetched once per run (best-effort, cached on the run). `DEFAULT_CHILD_MODEL` remains the last-resort fallback only. This alone changes tier-less workflows (e.g. beads-drain) from always-gpt-5.5 to session-model — a desirable, backward-safe behavior change.

### C3. Tier resolution (kernel)

- New run-level arg + meta field `modelTiers: { fast?: string, deep?: string }` (concrete `provider/model` ids). Validated as `provider/model` via `resolveRequestedModel`. Defaults to `{ fast: defaultChildModel, deep: defaultChildModel }` when absent.
- Guest `agent()` accepts `tier: "fast" | "deep"`. Validated; any other value is an error.
- Lane model resolution (`workflow-plugin.js:840`): `opts.model || run.modelTiers[opts.tier] || run.defaultChildModel`.
  - Explicit `opts.model` always wins (escape hatch).
  - A declared tier with no `modelTiers` entry degrades gracefully to `defaultChildModel` (= session model).
  - No tier and no model → `defaultChildModel`, exactly as today.

### C4. Approval surfacing + hash (kernel)

- `approvalSummary` (`workflow-plugin.js:584`+) gains a **Model plan** block: `default → …`, `fast → …`, `deep → …`. (Per-lane tiers are dynamic/guest-decided, so the summary shows the *map*, not every lane.)
- `modelTiers` is added to the approval envelope (`approval-hashing.js`) so changing the model plan re-triggers approval — a user can't silently swap in a premium model post-approval.

### C5. Planning-agent skill (new)

A skill the orchestrating agent follows before running any tiered workflow:
1. Call `workflow_models`.
2. Infer the session family; map `fast`/`deep` to concrete models **within that family** using model metadata (cost / reasoning / variants). Prefer the cheapest-reasonable for `fast`; a higher-reasoning model or variant for `deep`. If the family has one model, `fast == deep`.
3. **Deviation check** (precise): non-deviation = both tiers in the session family at standard escalation. Deviation = a different provider family, a premium cross-family `deep`, or mixed families across tiers. On deviation → `AskUserQuestion` to confirm before proceeding.
4. Pass `modelTiers` as a `workflow_run` arg and run. The approval preview lists the plan; approving it is the confirmation for the non-deviation case.

## Data flow (end-to-end, repo-bughunt example)

1. User launches OpenCode with `glm-5.2`; asks to run `repo-bughunt`.
2. Agent calls `workflow_models` → session family `zai-coding-plan`; `suggested = { fast: glm-5.2, deep: glm-5.2(max?) }`.
3. No deviation (stays in family) → agent calls `workflow_run({ name: "repo-bughunt", args: { ... }, modelTiers: { fast: "zai-coding-plan/glm-5.2", deep: "..." } })`.
4. Approval preview shows the model plan; user approves.
5. Guest fans out: finders `tier:"fast"` → glm-5.2; skeptics `tier:"deep"` → deep model; synth pure JS. Kernel resolves each lane's model from `run.modelTiers`.

## Testing

All `node --test`, mocked client (zero tokens):
- **Session default:** mock `config.get()`/session read → assert `run.defaultChildModel` inherits it; assert fallback to `DEFAULT_CHILD_MODEL` when unreadable.
- **Tier resolution:** a workflow with `tier:"fast"`/`tier:"deep"` lanes + `modelTiers` arg → assert each lane's resolved model (inspect the mocked `session.prompt` body's model); assert `opts.model` escape hatch wins; assert graceful degradation to default when a tier has no map entry; assert no-tier behavior unchanged.
- **`workflow_models`:** mock `client.config.providers()` → assert output shape (`session`, `providers`, `suggested`).
- **Approval hash:** assert two runs differing only in `modelTiers` produce different `approvalHash`; assert the preview text contains the Model plan block.
- **Backward compat:** beads-drain and tier-less workflows still run; only the default model source changed.

## Risks / open spikes

- **R1 — active session model read.** The exact SDK path (`session.get()` vs the last message's model on `session.messages`) is unconfirmed. Spike during implementation; `config.get().model` is a guaranteed fallback, and `source` records which was used. Worst case: default = configured model (still correct on this install, and the agent can always override via `modelTiers`).
- **R2 — variant addressing.** `glm-5.2` exposes `variants: { high, max }`. Whether a max-reasoning variant is addressable as a distinct `provider/model` string (so `deep` differs from `fast`) or whether single-model families collapse `fast == deep` needs confirming. Graceful degradation (collapse) is the safe fallback and is acceptable.
- **R3 — structured output** (inherited by Piece 2, unchanged): schema lanes fail closed unless the runtime promotes `structuredOutput` to `available`. Tracked in the repo-bughunt plan's Task 0.

## Out of scope

- Cost/budget-aware automatic downshifting (a future enhancement; this feature only resolves intent → model, it does not meter spend).
- More than two tiers (`balanced` etc.) — rejected as frequently non-resolving on small families.
- Per-lane model UI in the approval preview (the map is shown, not every dynamic lane).
