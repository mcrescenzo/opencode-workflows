# Session-aware Model Tiering (Piece 1) Implementation Plan

> Status: **historical implementation plan**. Retained for provenance; current
> behavior is in `workflow_models`, model-tiering tests, and active docs.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make workflow model selection session-aware and provider-agnostic: lanes declare `tier: "fast" | "deep"` intent, the kernel resolves tier → concrete model (from a per-run `modelTiers` map, falling back to the *invoking session's* model), a read-only `workflow_models` tool lets the planning agent enumerate authenticated providers/models, and the model plan is surfaced + hash-covered in the approval gate.

**Architecture:** Four small kernel edits in `workflow-kernel/` (lane model resolver, session-model default, `modelTiers` plumbing + approval hash, approval-summary text), one new read-only tool (`workflow_models`), and one planning-agent skill. Implements the design in `docs/superpowers/specs/2026-06-23-session-aware-model-tiering-design.md`.

**Tech Stack:** OpenCode workflow plugin kernel (Node host side, NOT the QuickJS guest), `@opencode-ai/sdk` client (`config.providers()`, `config.get()`, `session.get()`), Node's built-in `node --test` with a mocked `client`.

## Global Constraints

- **All edits are host-side** (`workflow-kernel/*.js`), never the QuickJS guest. The host may use `new Date()`, `client.*`, fs, etc. (the determinism ban is guest-only).
- **Models are `provider/model` strings.** `resolveRequestedModel(model, label)` (`authority-policy.js:159-164`) requires exactly one `/`, both sides non-empty, else throws; `modelKey(parsed)` re-serializes to the canonical string. Reuse both — do not re-parse by hand.
- **Backward compatibility is mandatory.** A workflow with no `tier` and no `modelTiers` MUST behave exactly as today (lane model = `run.defaultChildModel`). beads-drain and all existing tests must stay green. The ONLY intended behavior change: when nothing specifies a model, the default now comes from the session instead of the hard-coded `DEFAULT_CHILD_MODEL = "openai/gpt-5.5"` (`constants.js:33`), which remains the last-resort fallback.
- **`tier` must stay in the lane resume signature.** `normalizeAgentOptions` (`authority-policy.js:166-171`) strips `label`/`phase` from the signature; do NOT add `tier` to that strip list — changing a lane's tier changes its model and must invalidate the resume cache.
- **Two tiers only:** `"fast"` and `"deep"`. Any other `tier` value is a hard error.
- **`workflow_models` is read-only:** no approval, no mutation, no run dir; just reads via the SDK client.
- **Test runner:** `node --test`; tests mock `pluginContext.client` (zero tokens, no network). Extend the existing `makeHarness` mock client with `config.providers`, `config.get`, and `session.get` stubs.
- **Approval-hash coverage:** `modelTiers` joins the approval envelope so a changed model plan re-triggers approval.

---

## File Structure

- **Modify:** `workflow-kernel/authority-policy.js` — add `resolveLaneModel(run, opts)` + `VALID_TIERS` (pure helpers; co-located with the existing model helpers `parseModel`/`resolveRequestedModel`/`modelKey`).
- **Modify:** `workflow-kernel/workflow-plugin.js` — use `resolveLaneModel` at the lane dispatch (`:662`); add `readActiveSessionModel`; resolve `modelTiers` + session default in `planWorkflowEnvelope` (`:1691`); thread `modelTiers` through the approval object, `startWorkflow` destructure, and the `run` object; add the `workflow_models` tool; add the Model-plan line to the approval summary.
- **Modify:** `workflow-kernel/approval-hashing.js` — add `modelTiers` to `approvalEnvelope`.
- **Modify:** `tests/workflows.test.mjs` — extend `makeHarness` mock client; add tier-resolution, session-default, approval-hash, and `workflow_models` tests. (This is the existing main suite; new tests live alongside the others.)
- **Create:** `skills/workflow-model-tiering/SKILL.md` — the planning-agent procedure (enumerate → map within family → deviation-confirm → run). Mirrors the existing `skills/beads-drain/` layout.
- **Modify:** `package.json` — extend `test:workflows` is unnecessary (it already runs `tests/workflows.test.mjs`); no script change required.

---

## Task 0: Spike — confirm the SDK paths (active session model, providers shape, variants)

**Why first:** Two design risks (R1 active-session-model read, R2 variant addressing) hinge on SDK behavior we have not observed live. This is a manual spike; `config.get().model` is a guaranteed fallback, so the worst case is still correct.

**Files:** none.

- [ ] **Step 1: Inspect the SDK client shape from a host context**

From a quick Node REPL or a throwaway tool call, capture the shapes (do not commit):
- `(await client.config.providers()).data` → confirm `{ providers: [...], default: {...} }`; note whether each `Provider.models[id]` carries cost/reasoning/`variants` metadata usable for fast-vs-deep ranking.
- `(await client.config.get()).data` → confirm a top-level `model` (and `small_model`) string.
- `(await client.session.get({ path: { id: "<the current sessionID>" } })).data` → does it expose the session's active model (e.g. a `model` field, or on the latest message)? Record the exact accessor that works.

- [ ] **Step 2: Decide the active-model accessor**

- If `session.get` exposes the active model: `readActiveSessionModel` uses it, falling back to `config.get().model`.
- If it does not: `readActiveSessionModel` uses `config.get().model` only (still correct; `source: "config-default"`). Record this so Task 2's helper matches reality.

- [ ] **Step 3: Decide variant addressing (R2)**

Confirm whether a max-reasoning variant (e.g. glm-5.2 `max`) is addressable as a distinct `provider/model` string. If yes, the skill can map `deep` to it. If no, single-model families collapse `fast == deep` (acceptable). Record the finding for Task 6's skill.

No commit (spike). Record outcomes in the task handoff.

---

## Task 1: Tier resolution core (`resolveLaneModel`)

**Files:**
- Modify: `workflow-kernel/authority-policy.js`
- Modify: `workflow-kernel/workflow-plugin.js` (lane dispatch `:662`)
- Modify: `tests/workflows.test.mjs`

**Interfaces:**
- Produces: `resolveLaneModel(run, opts) -> string` — the `provider/model` string for a lane, before `resolveRequestedModel` validation. Precedence: `opts.model` → `run.modelTiers[opts.tier]` → `run.defaultChildModel`. Throws on an invalid `tier`.
- Consumes: `run.modelTiers` (`{ fast?, deep? }`, may be undefined), `run.defaultChildModel` (string), `opts.model` (string|undefined), `opts.tier` (`"fast"|"deep"|undefined`).

- [ ] **Step 1: Write the failing unit test**

Append to `tests/workflows.test.mjs` (the file already imports `{ __test }` from the plugin and `assert`):

```js
test("resolveLaneModel: precedence, tier map, graceful fallback, validation", () => {
  const run = { defaultChildModel: "zai-coding-plan/glm-5.2", modelTiers: { fast: "zai-coding-plan/glm-5.2", deep: "zai-coding-plan/glm-5.2-max" } };
  // explicit model wins over everything
  assert.equal(__test.resolveLaneModel(run, { model: "openai/gpt-5.5", tier: "deep" }), "openai/gpt-5.5");
  // tier resolves from the map
  assert.equal(__test.resolveLaneModel(run, { tier: "fast" }), "zai-coding-plan/glm-5.2");
  assert.equal(__test.resolveLaneModel(run, { tier: "deep" }), "zai-coding-plan/glm-5.2-max");
  // tier with no map entry falls back to the default
  assert.equal(__test.resolveLaneModel({ defaultChildModel: "openai/gpt-5.5" }, { tier: "deep" }), "openai/gpt-5.5");
  // no tier, no model => default (unchanged legacy behavior)
  assert.equal(__test.resolveLaneModel(run, {}), "zai-coding-plan/glm-5.2");
  // invalid tier is a hard error
  assert.throws(() => __test.resolveLaneModel(run, { tier: "medium" }), /tier/);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test --test-name-pattern="resolveLaneModel" tests/workflows.test.mjs`
Expected: FAIL — `__test.resolveLaneModel` is not a function.

- [ ] **Step 3: Implement the helper in `authority-policy.js`**

Add near the existing model helpers (after `resolveRequestedModel`):

```js
export const VALID_TIERS = ["fast", "deep"];

// Resolve a lane's model string BEFORE provider/model validation.
// Precedence: explicit opts.model > run.modelTiers[tier] > run.defaultChildModel.
// A declared tier with no map entry degrades to the run default (the session model).
export function resolveLaneModel(run, opts = {}) {
  if (typeof opts.model === "string" && opts.model.length > 0) return opts.model;
  const tier = opts.tier;
  if (tier !== undefined) {
    if (!VALID_TIERS.includes(tier)) {
      throw new Error(`Invalid lane tier: ${String(tier)}. Expected one of ${VALID_TIERS.join(", ")}.`);
    }
    const mapped = run.modelTiers && run.modelTiers[tier];
    if (typeof mapped === "string" && mapped.length > 0) return mapped;
  }
  return run.defaultChildModel;
}
```

- [ ] **Step 4: Wire it into the lane dispatch in `workflow-plugin.js`**

At `workflow-plugin.js:662`, replace:

```js
    model = resolveRequestedModel(opts.model || run.defaultChildModel, "child");
```

with:

```js
    model = resolveRequestedModel(resolveLaneModel(run, opts), "child");
```

Add `resolveLaneModel` to the existing import from `authority-policy.js` (the same import block that already brings in `modelKey`, `resolveRequestedModel` near `workflow-plugin.js:137-141`).

- [ ] **Step 5: Export `resolveLaneModel` on the `__test` surface**

`__test` aggregates the kernel barrel (`opencode-workflows.js:8` does `Object.assign({}, kernel, ...)`, and `workflow-kernel/index.js` re-exports `authority-policy.js` via `export *`). Because `resolveLaneModel` is an `export` of `authority-policy.js`, it is automatically on `__test`. Confirm `workflow-kernel/index.js` contains `export * from "./authority-policy.js";` (it does). No extra wiring needed.

- [ ] **Step 6: Run to verify it passes**

Run: `node --test --test-name-pattern="resolveLaneModel" tests/workflows.test.mjs`
Expected: PASS.

- [ ] **Step 7: Run the full suite (no regressions)**

Run: `npm run test:workflows`
Expected: PASS — existing tests unaffected (legacy lanes hit the `opts.model`/default path identically).

- [ ] **Step 8: Commit**

```bash
git add workflow-kernel/authority-policy.js workflow-kernel/workflow-plugin.js tests/workflows.test.mjs
git commit -m "feat(opencode-workflows): resolve lane model from fast/deep tier with graceful fallback"
```

---

## Task 2: Session-model inheritance for the default

**Files:**
- Modify: `workflow-kernel/workflow-plugin.js` (`readActiveSessionModel` + `planWorkflowEnvelope:1704`)
- Modify: `tests/workflows.test.mjs` (extend mock client + test)

**Interfaces:**
- Produces: `readActiveSessionModel(pluginContext, toolContext) -> Promise<{ model: string|null, source: "active"|"config-default"|"none" }>`.
- Effect: `planWorkflowEnvelope` default becomes `args.childModel || meta.childModel || meta.defaultChildModel || <active session model> || DEFAULT_CHILD_MODEL`.

- [ ] **Step 1: Extend the `makeHarness` mock client**

In `tests/workflows.test.mjs`, in `makeHarness` (`:101-131`), add `config` and extend `session` on the mocked `client` (use the accessor confirmed in Task 0; this example uses `config.get().model` as the robust path):

```js
      config: {
        async get() { return { data: { model: options.sessionModel ?? "openai/gpt-5.5", small_model: "openai/gpt-5.5" } }; },
        async providers() { return { data: { providers: options.providers ?? [], default: options.providerDefault ?? {} } }; },
      },
```

(Place it as a sibling of `session`/`worktree`/`tui` inside the mocked `client`. `options.sessionModel` lets a test pin the inherited model.)

- [ ] **Step 2: Write the failing test**

Append to `tests/workflows.test.mjs`:

```js
test("default child model inherits the active session model", async () => {
  const { tools, context, directory } = await makeHarness(async () => { throw new Error("no model call"); }, { sessionModel: "zai-coding-plan/glm-5.2" });
  try {
    const source = `export const meta = { name: "model-inherit", profile: "read-only-review" };\nreturn { ok: true };`;
    const preview = await tools.workflow_run.execute({ source }, context);
    assert.match(preview, /Default child model: zai-coding-plan\/glm-5\.2/);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `node --test --test-name-pattern="inherits the active session" tests/workflows.test.mjs`
Expected: FAIL — preview shows `openai/gpt-5.5` (the hard-coded default), not the session model.

- [ ] **Step 4: Implement `readActiveSessionModel`**

Add to `workflow-plugin.js` (host scope, near other helpers). Use the Task-0 accessor; this implementation tries the session then falls back to config, and never throws:

```js
async function readActiveSessionModel(pluginContext, toolContext) {
  const client = pluginContext?.client;
  if (!client) return { model: null, source: "none" };
  // Best-effort: the live session's active model, if the SDK exposes it (confirmed in Task 0).
  try {
    if (toolContext?.sessionID && client.session?.get) {
      const got = await client.session.get({ path: { id: toolContext.sessionID } });
      const m = got?.data?.model;
      if (typeof m === "string" && m.includes("/")) return { model: m, source: "active" };
    }
  } catch { /* fall through to config default */ }
  try {
    const cfg = await client.config?.get?.();
    const m = cfg?.data?.model;
    if (typeof m === "string" && m.includes("/")) return { model: m, source: "config-default" };
  } catch { /* fall through */ }
  return { model: null, source: "none" };
}
```

- [ ] **Step 5: Use it in `planWorkflowEnvelope`**

In `planWorkflowEnvelope` (`workflow-plugin.js:1691`), before the `defaultChildModel` line (`:1704`), add:

```js
  const sessionModel = await readActiveSessionModel(pluginContext, toolContext);
```

Then change `:1704` from:

```js
  const defaultChildModel = modelKey(resolveRequestedModel(args.childModel || meta.childModel || meta.defaultChildModel || DEFAULT_CHILD_MODEL, "default child"));
```

to:

```js
  const defaultChildModel = modelKey(resolveRequestedModel(args.childModel || meta.childModel || meta.defaultChildModel || sessionModel.model || DEFAULT_CHILD_MODEL, "default child"));
```

(`pluginContext` and `toolContext` are already in scope as `planWorkflowEnvelope`'s params.)

- [ ] **Step 6: Run to verify it passes**

Run: `node --test --test-name-pattern="inherits the active session" tests/workflows.test.mjs`
Expected: PASS.

- [ ] **Step 7: Full suite + a fallback assertion**

Run: `npm run test:workflows`
Expected: PASS. Existing tests pass a mock client without `config.get` returning a non-`openai/gpt-5.5` model; since the default mock now returns `openai/gpt-5.5`, their behavior is unchanged. (If any existing test asserted the literal default model, update it to the mock's `sessionModel` default of `openai/gpt-5.5` — same value.)

- [ ] **Step 8: Commit**

```bash
git add workflow-kernel/workflow-plugin.js tests/workflows.test.mjs
git commit -m "feat(opencode-workflows): default child model inherits the invoking session model"
```

---

## Task 3: `modelTiers` plumbing + approval-hash coverage

**Files:**
- Modify: `workflow-kernel/workflow-plugin.js` (`planWorkflowEnvelope`, `startWorkflow`, `run` object, `workflow_run` tool args)
- Modify: `workflow-kernel/approval-hashing.js`
- Modify: `tests/workflows.test.mjs`

**Interfaces:**
- Produces: `run.modelTiers = { fast: string, deep: string }` (always populated; both default to `defaultChildModel`). Surfaced into the approval envelope and hashed.
- Consumes: `args.modelTiers` (`workflow_run` arg) and/or `meta.modelTiers`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/workflows.test.mjs`:

```js
test("modelTiers resolves lane models and is covered by the approval hash", async () => {
  // Prompt mock records the model each lane was dispatched with.
  const seen = [];
  const prompt = async (input) => {
    seen.push(input?.body?.model ? `${input.body.model.providerID}/${input.body.model.modelID}` : "none");
    return { data: { parts: [{ type: "text", text: "ok" }], info: { structured: { ok: true }, tokens: { input: 1, output: 1, reasoning: 0 }, cost: 0 } } };
  };
  const { tools, context, directory } = await makeHarness(prompt, { sessionModel: "zai-coding-plan/glm-5.2" });
  try {
    const source = [
      'export const meta = { name: "tier-smoke", profile: "read-only-review" };',
      'const f = await agent("fast lane", { tier: "fast", schema: { type: "object", additionalProperties: false, properties: { ok: { type: "boolean" } }, required: ["ok"] } });',
      'const d = await agent("deep lane", { tier: "deep", schema: { type: "object", additionalProperties: false, properties: { ok: { type: "boolean" } }, required: ["ok"] } });',
      'return { f, d };',
    ].join("\n");
    const tiers = { fast: "zai-coding-plan/glm-5.2", deep: "zai-coding-plan/glm-5.2-max" };

    // approvalHash must change when modelTiers change.
    const p1 = await tools.workflow_run.execute({ source, modelTiers: tiers }, context);
    const p2 = await tools.workflow_run.execute({ source, modelTiers: { fast: tiers.fast, deep: tiers.fast } }, context);
    const h1 = p1.match(/approvalHash: ([a-f0-9]{64})/)[1];
    const h2 = p2.match(/approvalHash: ([a-f0-9]{64})/)[1];
    assert.notEqual(h1, h2, "different modelTiers must yield different approvalHash");

    // run with the first plan; assert each lane used the mapped model.
    await tools.workflow_run.execute({ source, modelTiers: tiers, approve: true, approvalHash: h1 }, context);
    assert.ok(seen.includes("zai-coding-plan/glm-5.2"), `fast lane model missing: ${JSON.stringify(seen)}`);
    assert.ok(seen.includes("zai-coding-plan/glm-5.2-max"), `deep lane model missing: ${JSON.stringify(seen)}`);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test --test-name-pattern="modelTiers resolves" tests/workflows.test.mjs`
Expected: FAIL — `modelTiers` is not an accepted arg / not threaded, so the hashes match and the deep model is never used.

- [ ] **Step 3: Add the `modelTiers` arg to `workflow_run`**

In the `workflow_run` tool args (`workflow-plugin.js:2121`+, alongside `childModel`), add:

```js
        modelTiers: tool.schema.object({
          fast: tool.schema.string().optional(),
          deep: tool.schema.string().optional(),
        }).optional(),
```

- [ ] **Step 4: Resolve `modelTiers` in `planWorkflowEnvelope`**

In `planWorkflowEnvelope`, right after the `defaultChildModel` line (`:1704`), add a resolver that validates each tier as `provider/model` and defaults to `defaultChildModel`:

```js
  const tierSource = (args.modelTiers && typeof args.modelTiers === "object" && !Array.isArray(args.modelTiers))
    ? args.modelTiers
    : (meta.modelTiers && typeof meta.modelTiers === "object" && !Array.isArray(meta.modelTiers) ? meta.modelTiers : {});
  const modelTiers = {
    fast: modelKey(resolveRequestedModel(tierSource.fast || defaultChildModel, "fast tier")),
    deep: modelKey(resolveRequestedModel(tierSource.deep || defaultChildModel, "deep tier")),
  };
```

- [ ] **Step 5: Thread `modelTiers` through approval + run**

(a) Add `modelTiers` to the returned `approval` object in `planWorkflowEnvelope` (`:1737-1756`), next to `defaultChildModel`:

```js
      defaultChildModel,
      modelTiers,
```

(b) In `startWorkflow`, add `modelTiers` to the destructure of `approval` (`:1764-1778`):

```js
    defaultChildModel,
    modelTiers,
```

(c) Add `modelTiers` to the `run` object (`:1812-1840`), next to `defaultChildModel` (`:1831`):

```js
    defaultChildModel,
    modelTiers,
```

- [ ] **Step 6: Cover `modelTiers` in the approval hash**

In `approval-hashing.js`, add to `approvalEnvelope` (after `defaultChildModel`, `:17`):

```js
    defaultChildModel: approval.defaultChildModel,
    modelTiers: approval.modelTiers ?? null,
```

- [ ] **Step 7: Run to verify it passes**

Run: `node --test --test-name-pattern="modelTiers resolves" tests/workflows.test.mjs`
Expected: PASS.

- [ ] **Step 8: Full suite**

Run: `npm run test:workflows`
Expected: PASS. (Existing runs now carry `modelTiers` defaulting to `defaultChildModel`; the approval hash for those is stable because the value is deterministic from the unchanged default — but note any test that pins a literal `approvalHash` will change. If such a test exists, regenerate its expected hash from the new preview; do not special-case it.)

- [ ] **Step 9: Commit**

```bash
git add workflow-kernel/workflow-plugin.js workflow-kernel/approval-hashing.js tests/workflows.test.mjs
git commit -m "feat(opencode-workflows): thread modelTiers through run + approval hash"
```

---

## Task 4: Surface the model plan in the approval summary

**Files:**
- Modify: `workflow-kernel/workflow-plugin.js` (approval summary)
- Modify: `tests/workflows.test.mjs`

- [ ] **Step 1: Write the failing test**

Append to `tests/workflows.test.mjs`:

```js
test("approval preview shows the model plan", async () => {
  const { tools, context, directory } = await makeHarness(async () => ({ data: { parts: [], info: {} } }), { sessionModel: "zai-coding-plan/glm-5.2" });
  try {
    const source = `export const meta = { name: "plan-text", profile: "read-only-review" };\nreturn { ok: true };`;
    const preview = await tools.workflow_run.execute({ source, modelTiers: { fast: "zai-coding-plan/glm-5.2", deep: "zai-coding-plan/glm-5.2-max" } }, context);
    assert.match(preview, /Model plan: fast=zai-coding-plan\/glm-5\.2 deep=zai-coding-plan\/glm-5\.2-max/);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test --test-name-pattern="shows the model plan" tests/workflows.test.mjs`
Expected: FAIL — no Model-plan line in the preview.

- [ ] **Step 3: Add the Model-plan line to the approval summary**

Find the approval summary builder (`grep -n "Default child model:" workflow-kernel/workflow-plugin.js` — the line that renders `Default child model: ${approval.defaultChildModel}` inside `approvalSummary`). Immediately after that line in the summary's line array, add:

```js
    `Model plan: fast=${approval.modelTiers?.fast ?? approval.defaultChildModel} deep=${approval.modelTiers?.deep ?? approval.defaultChildModel}`,
```

(Use `approval.*` — the summary is built from the approval object, not a `run`.)

- [ ] **Step 4: Run to verify it passes**

Run: `node --test --test-name-pattern="shows the model plan" tests/workflows.test.mjs`
Expected: PASS.

- [ ] **Step 5: Full suite**

Run: `npm run test:workflows`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add workflow-kernel/workflow-plugin.js tests/workflows.test.mjs
git commit -m "feat(opencode-workflows): show fast/deep model plan in the approval summary"
```

---

## Task 5: `workflow_models` discovery tool

**Files:**
- Modify: `workflow-kernel/workflow-plugin.js` (new tool + a `buildWorkflowModels` helper)
- Modify: `tests/workflows.test.mjs`

**Interfaces:**
- Produces tool `workflow_models` → returns (as a JSON string when `format:"json"`, else a summary) `{ session: { model, providerID, modelID, family, source }, providers: [{ id, name, source, default, models: [{ id, name, variants? }] }], suggested: { fast, deep } }`.

- [ ] **Step 1: Write the failing test**

Append to `tests/workflows.test.mjs`:

```js
test("workflow_models returns session model + available providers", async () => {
  const providers = [{
    id: "zai-coding-plan", name: "Z.AI", source: "config",
    models: { "glm-5.2": { id: "glm-5.2", name: "GLM 5.2", variants: { high: {}, max: {} } } },
  }];
  const { tools, context, directory } = await makeHarness(async () => ({ data: { parts: [], info: {} } }), {
    sessionModel: "zai-coding-plan/glm-5.2", providers, providerDefault: { "zai-coding-plan": "glm-5.2" },
  });
  try {
    const out = JSON.parse(await tools.workflow_models.execute({ format: "json" }, context));
    assert.equal(out.session.model, "zai-coding-plan/glm-5.2");
    assert.equal(out.session.providerID, "zai-coding-plan");
    assert.equal(out.session.family, "zai-coding-plan");
    assert.ok(out.providers.some((p) => p.id === "zai-coding-plan" && p.models.some((m) => m.id === "glm-5.2")));
    assert.equal(out.suggested.fast, "zai-coding-plan/glm-5.2");
    assert.ok(typeof out.suggested.deep === "string");
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test --test-name-pattern="workflow_models returns" tests/workflows.test.mjs`
Expected: FAIL — `tools.workflow_models` is undefined.

- [ ] **Step 3: Implement `buildWorkflowModels`**

Add to `workflow-plugin.js` (host scope):

```js
async function buildWorkflowModels(pluginContext, toolContext) {
  const client = pluginContext?.client;
  const session = await readActiveSessionModel(pluginContext, toolContext);
  let providersRaw = [];
  let providerDefault = {};
  try {
    const res = await client?.config?.providers?.();
    providersRaw = Array.isArray(res?.data?.providers) ? res.data.providers : [];
    providerDefault = res?.data?.default ?? {};
  } catch { /* providers unavailable; return what we have */ }
  const providers = providersRaw.map((p) => ({
    id: p.id,
    name: p.name,
    source: p.source,
    default: providerDefault[p.id] ?? null,
    models: Object.values(p.models ?? {}).map((m) => ({
      id: m.id,
      name: m.name,
      ...(m.variants ? { variants: Object.keys(m.variants) } : {}),
    })),
  }));
  const sessionModel = session.model;
  const slash = typeof sessionModel === "string" ? sessionModel.indexOf("/") : -1;
  const providerID = slash > 0 ? sessionModel.slice(0, slash) : null;
  const modelID = slash > 0 ? sessionModel.slice(slash + 1) : null;
  // Default suggestion = stay in the session family at the same model (no deviation).
  const suggested = { fast: sessionModel ?? null, deep: sessionModel ?? null };
  return {
    session: { model: sessionModel, providerID, modelID, family: providerID, source: session.source },
    providers,
    suggested,
  };
}
```

- [ ] **Step 4: Register the `workflow_models` tool**

In the `tool: { ... }` map (alongside `workflow_list`/`workflow_roles`, `workflow-plugin.js:2207`+), add:

```js
    workflow_models: tool({
      description: "List the invoking session's model and all available/authenticated providers and models, with a no-deviation fast/deep suggestion. Read-only; no run is started.",
      args: {
        format: tool.schema.enum(["summary", "json"]).optional(),
      },
      async execute(args, context) {
        const models = await buildWorkflowModels(pluginContext, context);
        if (args.format === "json") return JSON.stringify(models);
        const lines = [
          `Session model: ${models.session.model ?? "unknown"} (source: ${models.session.source})`,
          `Suggested: fast=${models.suggested.fast ?? "?"} deep=${models.suggested.deep ?? "?"}`,
          "Providers:",
          ...models.providers.map((p) => `  ${p.id} [${p.source}] -> ${p.models.map((m) => m.id).join(", ")}`),
        ];
        return lines.join("\n");
      },
    }),
```

- [ ] **Step 5: Run to verify it passes**

Run: `node --test --test-name-pattern="workflow_models returns" tests/workflows.test.mjs`
Expected: PASS.

- [ ] **Step 6: Full suite**

Run: `npm run test:workflows`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add workflow-kernel/workflow-plugin.js tests/workflows.test.mjs
git commit -m "feat(opencode-workflows): add read-only workflow_models discovery tool"
```

---

## Task 6: Planning-agent skill

**Files:**
- Create: `skills/workflow-model-tiering/SKILL.md`

- [ ] **Step 1: Confirm the skill layout**

Run: `ls skills/beads-drain/`
Expected: a `SKILL.md` (the shipped-skill convention this mirrors).

- [ ] **Step 2: Write the skill**

Create `skills/workflow-model-tiering/SKILL.md`:

```markdown
---
name: workflow-model-tiering
description: Use BEFORE running any workflow whose lanes declare fast/deep tiers (e.g. repo-bughunt). Enumerate available models, map fast/deep to concrete models in the invoking session's family, and confirm with the user ONLY when the plan deviates.
---

# Workflow model tiering

Workflows declare lane intent as `tier: "fast"` (cheap/bulk) or `tier: "deep"` (subtle reasoning); pure-JS lanes use no model. The kernel resolves each tier to a concrete model from the run's `modelTiers` map, falling back to the invoking session's model. Your job before running such a workflow:

## Procedure

1. **Enumerate.** Call `workflow_models`. Note `session.model` / `session.family` and the available `providers[].models`.
2. **Map within the session family.** Choose concrete `fast`/`deep` models *inside the session family*:
   - `fast` = the session model (or the cheapest reasonable model in the family).
   - `deep` = a higher-reasoning model or reasoning variant in the same family if one exists (e.g. a `max` variant); if the family has only one model, `deep = fast`.
3. **Deviation check.** The plan is NON-deviating if both tiers stay in the session family at standard escalation. It DEVIATES if you pick a different provider family, a premium cross-family `deep`, or mix families.
   - **No deviation:** proceed. The `workflow_run` approval preview shows the model plan; the user approving it is the confirmation. Do not add a separate prompt.
   - **Deviation:** STOP and confirm explicitly with the user (state the models and why) BEFORE calling `workflow_run`.
4. **Run.** Call `workflow_run({ name: "<workflow>", args: {...}, modelTiers: { fast, deep } })`, then re-call with `approve: true` and the `approvalHash` from the preview. Never set `maxCost`/`maxTokens` casually — a budget ceiling forces concurrency to 1.

## Notes

- Omitting `modelTiers` is valid: every tier then resolves to the session model (a safe no-deviation default). Pass `modelTiers` only to differentiate `deep` from `fast`.
- An explicit per-lane `model` in a workflow's source overrides tiers; report-only review workflows should not use it.
```

- [ ] **Step 3: Wire a pointer into the repo-* command wrappers (when they exist)**

The repo-bughunt command wrapper (Piece 2, `commands/repo-bughunt.md`) should reference this skill: before `workflow_run`, follow `skills/workflow-model-tiering`. Add that sentence when implementing Piece 2's command (no change needed here if the command doesn't exist yet).

- [ ] **Step 4: Commit**

```bash
git add skills/workflow-model-tiering/SKILL.md
git commit -m "docs(opencode-workflows): add workflow-model-tiering planning-agent skill"
```

---

## Self-Review

**1. Spec coverage** (`2026-06-23-session-aware-model-tiering-design.md` → tasks):
- C1 discovery tool `workflow_models` — Task 5 ✅
- C2 session-model inheritance — Task 2 ✅
- C3 tier resolution (`tier` opt + `modelTiers` + precedence + graceful fallback) — Task 1 (resolver) + Task 3 (plumbing) ✅
- C4 approval surfacing + hash — Task 3 (hash) + Task 4 (summary) ✅
- C5 planning-agent skill (enumerate → map → deviation-confirm → run) — Task 6 ✅
- Risks R1/R2 — Task 0 spike ✅; R3 (structured output) lives in the Piece 2 plan ✅
- Backward compatibility — asserted in Tasks 1/2/3 full-suite steps ✅

**2. Placeholder scan:** No TBD/TODO. Every code step shows the exact edit. The two grep-located edits (Task 4 approval-summary line, Task 1 import block) name the search string and the surrounding anchor rather than a guessed line number, because earlier edits in the same file shift line numbers — this is precise, not a placeholder. ✅

**3. Type consistency:** `resolveLaneModel(run, opts)`, `VALID_TIERS`, `readActiveSessionModel(pluginContext, toolContext) -> { model, source }`, `buildWorkflowModels(...) -> { session, providers, suggested }`, `run.modelTiers = { fast, deep }`, and the `approval.modelTiers` field are named identically across the tasks and tests. The mock-client `config.get`/`config.providers`/`session.get` shapes match what `readActiveSessionModel`/`buildWorkflowModels` read. ✅

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-06-23-session-aware-model-tiering-plan.md`. Two execution options:

**1. Subagent-Driven (recommended)** — dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — execute tasks in this session with checkpoints.

Build order: **this plan (Piece 1) first**, then the revised `repo-bughunt` plan (Piece 2). Which execution approach?
