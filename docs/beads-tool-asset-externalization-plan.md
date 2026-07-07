# Beads Tool + Asset Externalization Plan (review_materialize tool + beads-drain assets)

> Status: **IMPLEMENTED (2026-06-30).** Shipped as two stacked branches
> (`work/externalize-beads-assets-fu2` → `work/externalize-review-materialize-fu1`):
> FU2 (Stages 2,3,5,5d) moved the beads-drain workflow/command/skill into the beads
> extension via the now-wired `assetDirs()` merge + extension-trusted auto-apply; FU1
> (Stages 1,4,6,6b,6d) added the factory-body extension load + tool-contribution seam
> and externalized the `review_materialize` tool + adapter + crosswalk doc. The kernel
> is grep-clean of beads (`grep -rin beads workflow-kernel/` → comments only); full
> suite green; `npm pack --dry-run` ships no beads/`workflow-domains/` assets (gated by
> a test). Follow-up to the IMPLEMENTED general-purpose
> harness extraction (`docs/general-purpose-harness-extraction-plan.md`). That
> effort shipped the drain adapter + mutation finalizers into the trusted
> `workflow-domains/beads/beads-extension.js`, loaded by explicit config via the
> opencode.json tuple form `["<path>", { extensions: [...] }]`. This plan
> completes the two named follow-ups it deferred:
>
> 1. **FOLLOW-UP 1 — externalize the `review_materialize` TOOL** into the trusted
>    beads extension (requires a NEW extension-*tool* contribution seam —
>    opencode's `Hooks.tool` is a static map built at factory-return time).
> 2. **FOLLOW-UP 2 — move the thin beads-drain workflow/command/skill** into the
>    extension dir (requires WIRING the currently-unconsumed `assetDirs()` merge +
>    extending `isTrustedAutoApplySource` to trust extension workflow dirs).
>
> Grounded against committed source 2026-06-30 (line cites inline). All three
> critique passes were reconciled; see "Findings Corrected During Grounding".

## Context

Two beads-coupled features remain in the published core kernel:

- **`review_materialize` tool** — defined inline in the kernel tool map at
  `workflow-plugin.js` (the `review_materialize: tool({...})` literal, ≈`:2390-2452`).
  It is a thin wrapper: it calls `assertWriteWorkflowAllowed(context, "review_materialize")`
  (plan-mode guard only, `authority-policy.js:151`), dynamically imports
  `./review-materialize-adapter.js`, resolves findings inline or from
  `findingsPath` (no run-store access), and delegates to
  `createReviewMaterializeAdapter({ cwd: args.repo })`. The adapter is 100%
  beads-specific (all `bd` CLI calls + a `.repo-review/crosswalk/<programLabel>.json`;
  `review-materialize-adapter.js:280`). The tool has NO kernel
  two-phase/approval-hash/auto-apply machinery — the dry-run-first approval is
  pure command prose. Its command markdown `commands/review-materialize.md` is
  auto-registered by the generic `BUNDLED_COMMAND_DIR` readdir scan
  (`workflow-plugin.js:270-287`) and ships in the published tarball via the
  `"commands/"` glob (`package.json:14`). There is NO `skills/review-materialize`
  (only `beads-drain`, `workflow-model-tiering`, `workflow-plan-review` exist —
  verified `ls skills/`).
- **beads-drain assets** — `workflows/beads-drain.js`, `commands/beads-drain.md`,
  `skills/beads-drain/` are still bundled in the published dirs but
  publish-EXCLUDED by three `!` negations (`package.json:17-19`). They resolve the
  drain adapter + finalizers through the already-externalized extension.
  `workflows/beads-drain.js` declares `meta.harness:"drain"` and
  `meta.adapter:"beads"` (verified), so `shouldAutoApplyDrain`'s registry lookup
  resolves post-move.

The blockers (all verified):

- **No extension-tool seam.** `Hooks.tool` is typed `{ [key: string]: ToolDefinition }`
  and is built as a static object literal returned by the factory
  (`workflow-plugin.js:2160` opens `tool: { ... }`). The registry has `drainAdapters`,
  `mutationHandlers`, `assetDirs` but NO `tools` concept
  (`extension-registry.js:14` `ASSET_KINDS = ["workflows","commands","skills"]`; the
  Maps are `adapters` + `handlers` only). Extensions cannot inject a tool name.
- **`assetDirs()` is unconsumed.** Defined at `extension-registry.js:109-113`; ZERO
  production callers (grep confirms only test callers). Moving beads-drain assets
  to the extension dir makes them unreachable: `resolveWorkflowSource` candidates
  are hardcoded `[project, GLOBAL, BUNDLED]` (`workflow-source.js:194-198`);
  `trustedWorkflowRoots` same (`:266`); `listWorkflows` dirs same
  (`role-template-loading.js:325-329`); `configureWorkflowEntrypoints` scans only
  `BUNDLED_COMMAND_DIR` / pushes only `BUNDLED_SKILL_DIR`
  (`workflow-plugin.js:270-287`).
- **`isTrustedAutoApplySource` trusts only bundled.** Signature today is
  `isTrustedAutoApplySource(sourcePath)` — ONE arg — and returns true only for
  `BUNDLED_WORKFLOW_DIR` (`workflow-plugin.js:786-789`); `shouldAutoApplyDrain` calls
  it as `isTrustedAutoApplySource(run.sourcePath)` at `:796` and early-returns false
  otherwise. Moving beads-drain to an extension dir silently downgrades
  autonomous-local auto-apply to the manual `workflow_apply` flow.

## Architecture: Three-Tier Trust (unchanged, extended at two seams)

This plan extends — does not alter — the shipped 3-tier model:

1. **Untrusted sandboxed guest workflows** (QuickJS; no fs/bd/shell). Resolved by
   name/source; approval-bound; cannot register adapters, finalizers, or tools.
2. **Trusted host extensions** loaded by EXPLICIT config
   (`opencode.json` tuple `["<path>", { extensions: [...] }]`). They register
   drain adapters, mutation finalizers, auto-apply authority, asset dirs — and,
   NEW in this plan, **plugin tools**. The two governing principles hold:
   - *Auto-discovery is safe only for sandboxed artifacts; trusted host code
     (adapters, finalizers, AND now tools) must be explicitly configured.* The
     tool seam confers no new discovery surface: extension tools are merged ONLY
     from the same explicitly-configured registry.
   - *The extension seam confers trust, it does not distribute files.* `assetDirs`
     just MERGE into the existing resolution search; the kernel ships no beads
     files (`workflow-domains/` is absent from `package.json` files[]).
3. **The core kernel** — generic harness; no beads logic; ships no real adapter
   (only the `test-fix-drain-adapter.js` fixture).

The two new seams sit entirely in tier 2: the tool-contribution path and the
asset-dir merge. Neither widens tier-1 (guest) authority. The auto-apply
trusted-origin invariant is preserved by deriving extension trust from the SAME
registry that confers adapter trust (INV-7).

### How resolution order works after this plan (precisely)

- **Workflow FILE resolution / trust / listing**: `project > global > extension > bundled`.
  Extension dirs are inserted BEFORE bundled in `resolveWorkflowSource` candidates,
  `trustedWorkflowRoots`, `listWorkflows`, and `buildNestedSnapshots` (INV-8).
- **`cfg.command` registration**: `bundled > extension` (INTENTIONAL INVERSION,
  documented). `configureWorkflowEntrypoints` registers bundled commands first via
  the readdir scan, then extension commands; `registerBundledCommand`'s guard
  `if (cfg.command[name]) return` (`workflow-plugin.js:261`) means an extension can
  only contribute NET-NEW command names, never override a bundled one. This is
  acceptable because (a) no current extension command collides with a bundled name,
  and (b) command markdown is non-executing prose, so the precedence inversion has
  no trust consequence. This inversion is called out in `docs/workflow-extensions.md`
  (Stage 7). **RESOLVED (DECISION 3): accept bundled > extension** — extensions
  contribute net-new command names only; no guard rewrite.

Trust (INV-7) is a SEPARATE predicate on the RESOLVED path, not derived from order
— so extension-before-bundled is safe: a project/global shadow that WINS resolution
still lands on a project/global path and is denied auto-apply.

## Target End-State Tree

```text
opencode-workflows/                         (published core; no beads logic)
  opencode-workflows.js                     export default only (INV-1)
  workflow-kernel/
    workflow-plugin.js                       loadExtensions in factory body; tool map = {...core, ...registry.tools(toolKit, coreNames)}; review_materialize REMOVED; isTrustedAutoApplySource(sourcePath, pluginContext)
    extension-registry.js                    + toolFactories Map + tools(toolKit, reserved) + register() tools validation/collision
    workflow-source.js                       resolveWorkflowSource/buildNestedSnapshots/resolveWorkflowSourceForStart/trustedWorkflowRoots/isTrustedWorkflowPath accept extensionWorkflowDirs=[]
    role-template-loading.js                 listWorkflows accepts extensionWorkflowDirs=[]; scope:'extension'
    sandbox-executor.js                      runNestedWorkflow forwards extension workflow dirs to resolveWorkflowSource
    constants.js                             REVIEW_MATERIALIZE_COMMAND_PATH removed (also leaves the barrel)
    review-materialize-adapter.js            >>> MOVED OUT (FU1)
    workflows/                               generic + repo-* only (no beads-drain)
    commands/                                generic + repo-* only (no beads-drain.md, no review-materialize.md)
    skills/                                  generic only (no beads-drain)
  tests/
    helpers/fake-extension.mjs               NEW shared fixture helper
    extension-tool-contribution.test.mjs     NEW (FU1 seam)
    extension-dir-resolution.test.mjs        NEW (asset merge + INV-8 order + scriptPath admission + nested symmetry)
    extension-auto-apply-trust.test.mjs      NEW (FU2 trust)
    extension-command-skill-registration.test.mjs  NEW (asset merge, bundled>extension command precedence)
    ...beads/review-materialize tests rewritten to extension paths + harness extension-forwarding
  package.json                               negations dropped; keyword/desc cleaned; scripts reorganized
  scripts/release-no-token.mjs               suites array: drop test:beads-drain, add test:extension-seam
  README.md                                  beads-drain 'bundled' -> 'extension' wording (FU2)

  workflow-domains/beads/                    (trusted host extension; NOT published)
    beads-extension.js                        + assetDirs + tools:(toolKit)=>({review_materialize}); comment :7-9 corrected
    beads-drain-adapter.js                    (already here)
    review-materialize-adapter.js             >>> MOVED IN (FU1)
    workflows/beads-drain.js                   >>> MOVED IN (FU2)
    commands/beads-drain.md                    >>> MOVED IN (FU2)
    commands/review-materialize.md             >>> MOVED IN (FU1)
    skills/beads-drain/                        >>> MOVED IN (FU2)
```

Parent `opencode.json` is UNCHANGED: it already loads the single
`workflow-domains/beads/beads-extension.js`. Both follow-ups extend that one
extension's manifest — no second extension entry. **RESOLVED (DECISION 1):
review_materialize lives in the SAME `beads-extension.js` as the drain adapter +
finalizers + assets; parent `opencode.json` stays unchanged.**

## Invariants (non-negotiable; each tied to a verified code fact)

1. **Export exactly one factory.** `opencode-workflows.js` re-exports only
   `default`. The tool seam must add NO named export to the entry, or opencode
   double-instantiates extra factories (AGENTS.md).
2. **`config` hook mutates `cfg` in place.** `workflow-plugin.js:2138-2146`;
   `configureWorkflowEntrypoints` pushes into `cfg.skills.paths` (`:272`) and assigns
   keys on `cfg.command` (`registerBundledCommand:263`). Extension asset wiring must
   keep mutating, never reassign `cfg`.
3. **Per-`pluginContext` registry; double-instantiation safe.**
   `createExtensionRegistry()` per factory call (`workflow-plugin.js:2135`);
   `register()` idempotent by `id` (`extension-registry.js:35`). Moving
   `loadExtensions` into the factory body must remain safe: dynamic imports are
   engine-cached and re-register is a no-op, so two instantiations yield two
   independent, identically-populated registries.
4. **Import-leaf registry; one zod instance.** `extension-registry.js:1-2` imports
   only `node:path`/`node:url`. The new `tools(toolKit)` method must NOT import
   `@opencode-ai/plugin`; the `tool`/`schema` helpers are INJECTED via `toolKit`
   from `workflow-plugin.js` (the kernel's single plugin import). This pins one zod
   instance for all extension tool arg schemas, eliminating cross-install
   zod-version mismatch.
5. **Declare every runtime dep; never hardcode model ids.** `@opencode-ai/plugin`
   stays a regular dep pinned `1.17.7`. Extension tools must not add a
   `@opencode-ai/plugin` dep of their own. `review_materialize`/`beads-drain` use no
   literal model ids (verified).
6. **Fail loud on extension load failure.** `workflow-plugin.js:2143-2144` +
   `extension-registry.js` (`failed to load…` / `invalid workflow extension…`
   throws) reject on unloadable/invalid extensions. Moving load into the factory
   body changes the error surface from config-hook rejection to factory-promise
   rejection — it must remain a hard throw, never a silent zero-extension load.
   Because tool-map availability now waits on extension import at factory-resolve
   time, extension modules MUST be import-cheap (top-level side-effect-free); the
   fail-loud behavior ensures a hang/failure surfaces rather than silently
   zero-loading (see Risks).
7. **Auto-apply trusted-origin.** `isTrustedAutoApplySource` (`workflow-plugin.js:786`,
   becoming `(sourcePath, pluginContext)`) must trust ONLY bundled +
   explicitly-configured extension workflow dirs — NEVER a project/global path.
   Extension trust is read from `pluginContext.workflowExtensionRegistry.assetDirs().workflows`
   (the SAME registry that confers adapter trust), so a project/global shadow that
   WINS resolution still lands on a project/global path and is denied auto-apply.
8. **Resolution order project > global > extension > bundled for workflow files.**
   Extension dirs are inserted BEFORE bundled in `resolveWorkflowSource` candidates
   (`:194-198`), the internal scriptPath-admission `isTrustedWorkflowPath` call
   (`:213`), `trustedWorkflowRoots` (`:266`), `isTrustedWorkflowPath` standalone
   export (`:270`), `listWorkflows` (`role-template-loading.js:325-329`), and
   `buildNestedSnapshots` (`workflow-source.js:159`). Trust (INV-7) is a separate
   path predicate, so extension-before-bundled is safe. (Command registration is
   the documented exception — bundled > extension; see Architecture.)
9. **Nested-snapshot resolution symmetry.** A nested `workflow()` is matched at
   runtime against the snapshot captured at approval time, keyed by resolved
   `sourcePath` (`sandbox-executor.js:96-98` throws "was not part of approved static
   snapshot" / "source changed after approval"). The extensionWorkflowDirs threading
   into `buildNestedSnapshots` (approval, `workflow-plugin.js:1314`) and into
   `runNestedWorkflow`'s `resolveWorkflowSource` (runtime, `sandbox-executor.js:93`)
   MUST land as ONE atomic change so an extension-resident workflow that nests
   another extension workflow resolves to the IDENTICAL path on both sides. (beads-
   drain has zero nested `workflow()` refs — verified — so it is unaffected; this is
   a generic-seam invariant guarded by a dedicated test.)
10. **Resume safety.** `run.sourcePath` is persisted and restored verbatim on resume
    (`workflow-source.js:258`); `assertResumeEnvelopeUnchanged` does NOT check
    sourcePath; `run.authority` (incl. `profile`) is persisted + rehydrated.
    `shouldAutoApplyDrain` keys on `run.meta?.harness`, `run.authority?.profile`,
    `run.sourcePath` (`:793-799`) — all resume-stable. An in-flight pre-move run
    resumes with the OLD bundled sourcePath (still trusted); a post-move run resumes
    with the extension sourcePath (trusted via INV-7).
11. **Approval-hash stability.** `approvalEnvelope` includes `sourcePath`. Moving
    `beads-drain.js` changes its resolved path, invalidating PRE-MOVE cold-start
    approval hashes (fresh two-phase required — correct, must be communicated).
    In-flight resumes are unaffected (INV-10). `review_materialize` externalization
    touches NO approval-hash machinery (the tool has none). beads-drain has zero
    nested refs so its `nestedSnapshots` is empty — no nested-hash drift.
12. **No new hashed envelope fields.** `review_materialize` adds no hashed fields
    today; the extension tool must not either (avoids an `approvalEnvelope` version
    bump).
13. **Tool-name uniqueness, fail-closed.** Extension tool names must not collide
    with core tool names or across extensions (mirrors the drain-adapter /
    mutation-op collision throws at `extension-registry.js:41-43, 49-51`). No
    override of core tools.
14. **Plugin-contributed tools are invokable under default tool permissions.**
    `review_materialize` is NOT in `WORKFLOW_TOOLS`/`WORKFLOW_MUTATING_TOOLS`
    (`authority-policy.js`); its invokability already relies on opencode's default
    tool-permission handling, not a kernel-populated `cfg.permission` allowlist
    (its only kernel guard is the in-`execute` `assertWriteWorkflowAllowed`
    plan-mode check). An extension-contributed tool inherits the identical default
    handling — verify this holds end-to-end (Verification step E1).

## Single Source of Truth for `assetDirs` reads

Every runtime read of extension asset dirs MUST go through
`pluginContext.workflowExtensionRegistry?.assetDirs()` — NOT the factory-closure
`extensionRegistry` variable — at all sites: `planWorkflowEnvelope`, `workflow_list`
execute, `configureWorkflowEntrypoints`, `shouldAutoApplyDrain`/`isTrustedAutoApplySource`,
and `runNestedWorkflow`. Rationale: under double-instantiation the factory-closure
variable belongs to one instantiation while `pluginContext.workflowExtensionRegistry`
is overwritten to point at the last one; reading uniformly from `pluginContext`
guarantees a single source of truth regardless of which instantiation's hooks object
opencode ultimately uses. (Both registries are identically populated, so this is a
consistency/footgun fix, not a correctness bug today — but it is mandatory so future
extension tools that capture `toolKit.pluginContext` stay consistent.) The factory
sets `pluginContext.workflowExtensionRegistry = extensionRegistry` at `:2136`, so the
reference is available everywhere `pluginContext` is in scope.

## Execution Stages

Each stage is TDD: write RED tests first, implement to GREEN, verify the whole suite
stays green before the next stage.

### Ship structure: TWO PRs, FU2 first (DECISION 4)

The two follow-ups ship as **two independent PRs**, FU2 first. Critically, FU2 does
**not** depend on the factory-body load (S1): `loadExtensions` already runs inside the
`config` hook BEFORE `configureWorkflowEntrypoints` (`workflow-plugin.js:2143-2146`), so
the asset-dir merge and the runtime `assetDirs()` reads both see a fully-populated
registry under the EXISTING config-hook timing. S1 is required ONLY by FU1 (the tool
map must be complete at factory-RETURN time). So S1 moves into PR2, where it is actually
needed — PR1 makes no factory-timing change and stays lower-risk.

- **PR1 — FU2 (move beads-drain assets):** Stage 0 → **Stage 2** (asset-dir merge) →
  **Stage 3** (auto-apply trust) → **Stage 5** (move beads assets) → **Stage 5d**
  (externalize beads-drain docs) → PR1 portion of Stage 7 (verify, package.json,
  release-no-token, docs). No S1, no tool seam.
  Dependency: **S2 → S5; S3 → S5.**
- **PR2 — FU1 (externalize review_materialize tool):** **Stage 1** (factory-body load)
  → **Stage 4** (tool-contribution seam) → **Stage 6** (externalize the tool) →
  **Stage 6b** (shared `beads-bd-util.js` extraction, DECISION 5) → **Stage 6d**
  (externalize review-materialize/crosswalk docs) → final Stage 7 (test:extension-seam,
  npm pack gate, docs). Builds on PR1's merged asset-dir merge (it reuses Stage 2's
  command-dir merge to register the moved `review-materialize.md`).
  Dependency: **S1 → S4; S4 → S6; S2(merged in PR1) → S6(command); S6 → S6b.**

Each PR keeps the whole suite green at every stage. The stage bodies below retain their
original S0–S7 numbering; the PR mapping above is authoritative for ordering. (The
original "Shared infra Stages 1-4 built once" framing is superseded: S1 is FU1-only.)

### Stage 0 — Baseline

- Run and record green: `npm test`, `npm run test:workflow-kernel`,
  `npm run test:workflows`, `npm run test:beads-drain`,
  `npm run test:workflow-adapters`, `npm run test:repo-review-no-mutation`,
  `npm run release:no-token`.
- Capture `grep -rin beads workflow-kernel/` inventory (should already be clean of
  production logic; confirms the move doesn't reintroduce coupling).
- Confirm `review-materialize-adapter.js` is the only remaining beads-coupled file
  inside `workflow-kernel/`.

Deliverable: documented baseline; no behavior change.

### Stage 1 — SHARED: load extensions in the factory body + fixture helper

**TDD framing (named explicitly):** `tests/extension-wiring.test.mjs` currently
PASSES (factory succeeds; the "fails loud" assertion is on `hooks.config({})`).
Rewriting it to assert the rejection on the `WorkflowPlugin(...)` call FIRST makes
the suite RED (the factory does not yet reject). Confirm that bounded RED, then
implement GREEN.

RED:
- Update `tests/extension-wiring.test.mjs`: assert
  `pluginContext.workflowExtensionRegistry.drainAdapter("fake")` is populated
  IMMEDIATELY after `await WorkflowPlugin(ctx, {extensions:[extPath]})` resolves —
  BEFORE `hooks.config({})` is called. The "fails loud" test must `assert.rejects`
  on the `WorkflowPlugin(...)` call, not on `hooks.config`.
- Add `tests/helpers/fake-extension.mjs` with `createFakeExtensionDef(opts)` and
  `writeFakeExtensionFile(dir, def)` (mirrors `tests/helpers/fake-drain-adapter.mjs`;
  serializes an ESM `export default` to a temp `.js`). Add a smoke test.

GREEN (`workflow-plugin.js:2130-2147`):
- Move the `await extensionRegistry.loadExtensions(...)` call OUT of the `config`
  hook and INTO the async factory body, after
  `pluginContext.workflowExtensionRegistry = extensionRegistry;` and reading
  `extensionPaths`, BEFORE `return {`. Keep `resolveOpencodeConfigDir()` as the
  `configDir`.
- The `config` hook keeps `configureWorkflowPermissions(cfg)` +
  `await configureWorkflowEntrypoints(cfg, ...)` (Stage 2 adds the arg) and DROPS
  its `loadExtensions` call.
- Preserve fail-loud (INV-6): a configured-but-unloadable extension now rejects the
  factory promise.

Verify: `node --test tests/extension-wiring.test.mjs tests/extension-registry.test.mjs`
green; full suite green (the factory is already async and opencode already awaits it,
so existing tests that `await` the factory are unaffected).

### Stage 2 — SHARED: wire `assetDirs()` into all resolution/registration sites

This is the asset-dir merge seam. Both follow-ups depend on it. No files move yet —
tests use the fixture helper to create a temp extension with `assetDirs`. Read ext
dirs uniformly from `pluginContext.workflowExtensionRegistry.assetDirs()` (Single
Source of Truth section).

RED — `tests/extension-dir-resolution.test.mjs`:
- Load an extension whose `assetDirs.workflows` points to a temp dir containing
  `fake-wf.js`. Assert `workflow_list` returns an entry `scope:"extension"`,
  `name:"fake-wf"`.
- Assert `workflow_run({ name:"fake-wf" })` resolves source from the extension dir
  (reaches the approval-preview path).
- **Order (INV-8):** a project `.opencode/workflows/fake-wf.js` shadow WINS over the
  extension (project>extension); an extension `fake-wf` WINS over a bundled same-name
  (extension>bundled).
- **scriptPath admission (INV-8, internal call):** `workflow_run` with an explicit
  `scriptPath` pointing INTO the extension workflow dir is ADMITTED (not rejected as
  "resolves outside trusted workflow roots"), proving the internal
  `isTrustedWorkflowPath` call at `:213` forwards the extension dirs.
- **Nested symmetry (INV-9):** an extension-resident workflow whose body statically
  nests a SECOND extension-resident workflow resolves to the identical path at
  plan-time (`buildNestedSnapshots`) and run-time (`runNestedWorkflow`) — i.e. it
  runs without the "was not part of approved static snapshot" throw.

RED — `tests/extension-command-skill-registration.test.mjs`:
- `configureWorkflowEntrypoints(cfg, registry.assetDirs())` with an extension
  declaring `assetDirs.commands='./cmds'` registers each `.md` into `cfg.command`.
- `assetDirs.skills='./skills'` is pushed into `cfg.skills.paths`.
- **Precedence (documented inversion):** a bundled command name takes precedence over
  a same-named extension command (bundled registered first; extension blocked by the
  `if (cfg.command[name]) return` guard at `:261`); a NET-NEW extension command name
  IS registered.
- Regression: no-extension call still registers all bundled commands.

GREEN — thread `extensionWorkflowDirs`/`extensionAssetDirs` with safe `[]`/empty
defaults (backward compatible for existing direct test callers):
- `workflow-source.js`:
  - `resolveWorkflowSource(context, args, extensionWorkflowDirs = [])`: candidates
    `[ project, GLOBAL, ...extensionWorkflowDirs, BUNDLED ]` (`:194-198`); **and update
    the internal scriptPath-admission call at `:213` from
    `isTrustedWorkflowPath(absolute, context)` to
    `isTrustedWorkflowPath(absolute, context, extensionWorkflowDirs)`** (closes the
    INV-8 internal trust asymmetry).
  - `trustedWorkflowRoots(context, extensionWorkflowDirs = [])`:
    `[ project, GLOBAL, ...extensionWorkflowDirs, BUNDLED ]` (`:266`);
    `isTrustedWorkflowPath(filePath, context, extensionWorkflowDirs = [])` (`:270`).
  - `buildNestedSnapshots(context, source, extensionWorkflowDirs = [])` (`:159`)
    forwards to BOTH its `resolveWorkflowSource` calls (`:163-165`).
  - `resolveWorkflowSourceForStart(context, args, resumeEntry, extensionWorkflowDirs = [])`
    forwards to `resolveWorkflowSource` (`:229`).
- `role-template-loading.js:324`: `listWorkflows(context, args, sessionModel, extensionWorkflowDirs = [])`;
  splice `extensionWorkflowDirs.map(d => ({ scope:"extension", directory:d }))`
  between the `global` and `bundled` entries in `dirs` (`:325-329`).
- `sandbox-executor.js:93`: `resolveWorkflowSource(toolContext, requested, pluginContext.workflowExtensionRegistry?.assetDirs()?.workflows ?? [])`
  (pluginContext is `runNestedWorkflow`'s first arg, `:89`). Treat this and the
  `buildNestedSnapshots` edit as one atomic change (INV-9).
- `workflow-plugin.js`:
  - `planWorkflowEnvelope` computes
    `const extWfDirs = pluginContext.workflowExtensionRegistry?.assetDirs()?.workflows ?? [];`
    and passes it to `resolveWorkflowSourceForStart` (`:1306`),
    `buildNestedSnapshots` (`:1314`), and `isTrustedWorkflowPath(sourcePath, toolContext, extWfDirs)` (`:1402`).
  - `workflow_list` execute (`:2275`): pass
    `pluginContext.workflowExtensionRegistry?.assetDirs()?.workflows ?? []` as the
    4th arg to `listWorkflows`.
  - `configureWorkflowEntrypoints(cfg, extensionAssetDirs = { workflows:[], commands:[], skills:[] })`
    (`:270`): push each `extensionAssetDirs.skills` dir into `cfg.skills.paths` (guarded
    by the existing `includes` check); after the bundled command scan, iterate each
    `extensionAssetDirs.commands` dir, readdir `.md`, and `registerBundledCommand`
    (guarded — bundled wins). Call at `:2146`:
    `await configureWorkflowEntrypoints(cfg, pluginContext.workflowExtensionRegistry.assetDirs())`.
    The `__test` (`:2456`) and named (`:2481`) exports of `configureWorkflowEntrypoints`
    stay valid via the empty-object default (backward compatible).

Verify: new tests green; `tests/workflow-run.test.mjs`, workflow-list/docs tests, and
nested-workflow tests green.

### Stage 3 — SHARED (FU2 trust): extend `isTrustedAutoApplySource`

**Test-access decision (resolved):** `isTrustedAutoApplySource` and
`shouldAutoApplyDrain` are private closures NOT in `WorkflowPlugin.__test` (verified
the `__test` key list). Stage 3 GREEN ADDS `isTrustedAutoApplySource` to
`WorkflowPlugin.__test` (and to the Critical Files table) so the trust predicate has a
direct unit test, AND ships the integration test. **RESOLVED (DECISION 2): unit +
integration** — add `isTrustedAutoApplySource` to `WorkflowPlugin.__test` for the
direct shadow-denied unit test AND ship the end-to-end test.

RED — `tests/extension-auto-apply-trust.test.mjs`:
- Unit (via `__test.isTrustedAutoApplySource`): `(extWorkflowDirPath, pluginContext)`
  true when the extension is registered; `(globalDirPath, ctx)` false;
  `(projectDirPath, ctx)` false; `(bundledDirPath, ctx)` true; `(extPath, ctxWithNoRegistry)`
  false (defensive).
- Integration: an autonomous-local drain sourced from the extension dir with
  `supportsAutoApply:true` auto-applies; a same-name GLOBAL-shadow drain does NOT
  (stops at `awaiting-diff-approval`).

GREEN (`workflow-plugin.js:786-799`):
- `isTrustedAutoApplySource(sourcePath, pluginContext)`: after the bundled check,
  `const extDirs = pluginContext?.workflowExtensionRegistry?.assetDirs()?.workflows ?? [];`
  return true if `resolved` equals or is under any `path.resolve(dir)`.
- `shouldAutoApplyDrain` call at `:796` becomes
  `isTrustedAutoApplySource(run.sourcePath, pluginContext)` (pluginContext already a
  param). Update the `:783-785` comment (which already says "extension-contributed
  dirs would be added here") to state they ARE now trusted via the registry.
- Add `isTrustedAutoApplySource` to `WorkflowPlugin.__test`.

Verify: new test green; existing beads-drain auto-apply paths unaffected (bundled
still trusted while files are pre-move).

### Stage 4 — SHARED (FU1 seam): extension tool contribution

RED — `tests/extension-tool-contribution.test.mjs`:
- Extension with `tools: { my_ext_tool: { description, args, execute } }` →
  `(await WorkflowPlugin(ctx, {extensions:[ext]})).tool.my_ext_tool` exists.
- Factory form `tools: (toolKit) => ({ my_ext_tool: toolKit.tool({...}) })` →
  same; assert `toolKit.tool`, `toolKit.schema`, and `toolKit.pluginContext` were
  provided (build args with `toolKit.schema.string()`), and
  `toolKit.assertWriteWorkflowAllowed` is callable.
- `execute(args, context)` forwards args + ToolContext correctly.
- Collision (INV-13): two extensions claiming `my_ext_tool` throws; an extension
  claiming a CORE name (e.g. `workflow_run`) throws.
- Add to `tests/extension-registry.test.mjs`: `register()` validates `tools` is an
  object or function; `tools(toolKit, reserved)` merges; cross-extension and
  reserved-name collision detection.

GREEN:
- `extension-registry.js`:
  - Add `const toolFactories = new Map(); // id -> object | (toolKit)=>object`.
  - In `register()`: if `def.tools` present, require `typeof def.tools === "function"`
    or a plain object (via `asPlainObject`); store under `id`. (Per-id idempotency at
    `:35` already short-circuits a re-register.)
  - Expose `tools(toolKit, reservedNames = [])`: iterate `toolFactories`, resolve each
    entry to an object (call if function), merge into `out`; throw on a name already
    in `out` (cross-extension) or in `reservedNames` (core). Keep this method an
    import-leaf (no `@opencode-ai/plugin`) — INV-4.
- `workflow-plugin.js` factory body (after Stage-1 load):
  - Build `const toolKit = { tool, schema: tool.schema, assertWriteWorkflowAllowed, pluginContext };`.
  - Compute the core tool name set, then in the returned object:
    `tool: { ...<existing core literal>, ...extensionRegistry.tools(toolKit, coreToolNames) }`.
    (In Stage 6, `review_materialize` is removed from the core literal and arrives via
    the extension instead.)

Verify: new tests green. `tests/workflow-docs.test.mjs` STAYS green at 16 — its regex
`/^\s+(workflow_\w+): tool\(/gm` matches only `workflow_*` source literals and never
extension-contributed tools (verified by two critique passes).

### Stage 5 — APPLY FU2: move beads-drain assets into the extension

Depends on S1, S2, S3.

File move map (`git mv`; create `workflow-domains/beads/{workflows,commands,skills}/` first):
```text
workflows/beads-drain.js      -> workflow-domains/beads/workflows/beads-drain.js
commands/beads-drain.md       -> workflow-domains/beads/commands/beads-drain.md
skills/beads-drain/           -> workflow-domains/beads/skills/beads-drain/
```

Manifest delta — `workflow-domains/beads/beads-extension.js`, add to the default export:
```js
assetDirs: { workflows: "./workflows", commands: "./commands", skills: "./skills" },
```
(Resolves relative to the extension module dir per `extension-registry.js:73`.)
Also **correct the stale comment at `beads-extension.js:7-9`** ("The thin beads-drain
workflow/command/skill remain bundled in the core package (publish-excluded)…") to
state the assets now live in `workflow-domains/beads/{workflows,commands,skills}/` and
are merged as extension asset dirs.

RED-first test rewrites (write new-path / new-scope assertions, watch them fail, then
move + wire):
- `tests/beads-drain-assets.test.mjs`:
  - `:11` — read from `workflow-domains/beads/workflows/beads-drain.js`.
  - `:32` — read from `workflow-domains/beads/skills/beads-drain/SKILL.md`.
  - `:64` — read from `workflow-domains/beads/commands/beads-drain.md`; update the
    test title at `:63` ("invokes the bundled workflow name") to "extension workflow
    name".
  - `:95` — change README regex `/workflow_list.*scope: "bundled"/s` to
    `/workflow_list.*scope: "extension"/s`.
  - `:115` — change README regex `intentional in-run apply exception is bundled
    non-dry \`beads-drain\`` to drop "bundled" (match the updated README wording, e.g.
    "intentional in-run apply exception is the extension-trusted non-dry `beads-drain`").
  - `:204-216` (the registration test) — call
    `configureWorkflowEntrypoints(cfg, registry.assetDirs())` after loading the beads
    extension into a registry (instead of the no-arg call) so
    `cfg.command["beads-drain"]` resolves; keep the description/template assertions.
    Consider splitting into an assets-only test (no plugin) + a registration test
    (loads the extension).
- `tests/beads-drain-workflow.test.mjs`:
  - Update the inline `makeHarness` (`:64`): change `await workflowPlugin(pluginContext)`
    to `await workflowPlugin(pluginContext, { extensions: options.extensions ?? [] })`
    and accept an `options.extensions` passthrough. Each affected test then passes the
    REAL `workflow-domains/beads/beads-extension.js` path (resolved from the repo
    root) so the workflow resolves from the extension dir.
  - `:195` — change `entry.scope === "bundled"` to `entry.scope === "extension"`.
  - The legacy `__workflowDrainAdapters` seam (`sandbox-executor.js:135`) still drives
    adapter behavior for these integration tests — KEEP it; this test only changes the
    source LOCATION/scope, not the adapter wiring.
- `README.md` (NEW change site — gated by the assertions above):
  - `:36`, `:38` — "imports the bundled `beads-drain`…" / "regression in bundled
    beads-drain" → "extension `beads-drain`".
  - `:81` — bundled-commands registration sentence: note extension commands are also
    registered when configured.
  - `:99-100` — "`beads-drain` is a bundled workflow source under
    `workflows/beads-drain.js` and is discoverable through `workflow_list` with
    `scope: "bundled"`" → extension source under
    `workflow-domains/beads/workflows/beads-drain.js`, `scope: "extension"`.
  - `:116`, `:133` — "bundled workflow"/"bundled `beads-drain` script" → "extension".
  - `:248` — "intentional in-run apply exception is bundled non-dry `beads-drain`" →
    drop "bundled"; describe it as the extension-trusted source (matches the
    beads-drain-assets `:115` regex).
  - Leave `:275` ("the bundled plugin" workflows dir) as-is if it refers to the generic
    bundled dir; otherwise adjust for accuracy.
- `tests/repo-review-no-mutation.test.mjs:388-391` — assert `beads-drain.js` is NOT in
  `BUNDLED_WORKFLOW_DIR` and IS in `workflow-domains/beads/workflows/`; keep the
  repo-* coexistence assertion for the remaining bundled workflows.
- `tests/publish-completeness.test.mjs:24-25` — REMOVE `beads-drain.md` from the
  expected-in-`commands/` list; ADD a negative assertion that `commands/beads-drain.md`
  does NOT exist.

package.json delta (FU2):
- Remove `"!workflows/beads-drain.js"`, `"!commands/beads-drain.md"`,
  `"!skills/beads-drain"` (now inert — files are gone). Do NOT add `workflow-domains/`
  to files[] (load-bearing absence keeps it unpublished).
- Remove `"beads"` from `keywords` (`:34`).
- Rewrite `description` (`:4`) to drop the beads-drain parenthetical, e.g.
  `"...orchestration (repo-review, a generic drain harness, and related workflows)."`.
- `scripts`: drop `test:beads-drain` (`:43`). Adapter coverage stays in
  `test:workflow-adapters` (`beads-drain-adapter.test.mjs` already imports from
  `workflow-domains/beads/`). The thin beads tests (`beads-drain-assets`,
  `beads-drain-scratch`, `beads-drain-workflow`) stay in `tests/` and are still picked
  up by the global `test` target (and reorganized under `test:extension-seam` is
  optional — keep them globally covered).
- **`scripts/release-no-token.mjs` (SAME STAGE):** its `suites` array (`:3-9`) lists
  `"test:beads-drain"` (`:6`) and RUNS each entry via `spawnSync("npm",["run",suite])`,
  exiting non-zero on failure (it does NOT pre-check existence). Remove `"test:beads-drain"`
  from `suites` in THIS stage so `npm run release:no-token` passes after Stage 5
  (deferring it to Stage 7 would break the release check between stages). Add
  `"test:extension-seam"` to `suites` in Stage 7 when that script is created.

Parent `opencode.json`: no change.

Verify: `npm test`; `npm run release:no-token`; new/updated beads tests green;
`grep -rin beads workflow-kernel/` still shows no production logic (only
`review-materialize-adapter.js` until Stage 6).

### Stage 5d — PR1: externalize the beads-drain-specific docs (DECISION 5)

Part of PR1. Move beads-drain-specific docs out of the published-core `docs/` into the
extension. Each candidate must be confirmed beads/drain-SPECIFIC (not generic-harness)
before moving — generic-harness docs (`workflow-autonomous-harness-*.md`,
`workflow-extensions.md`, `general-purpose-harness-extraction-plan.md`) STAY in core.

File move map (`git mv`; create `workflow-domains/beads/docs/` first):
```text
docs/goal-supervision-autonomous-drains.md -> workflow-domains/beads/docs/   (beads-drain supervision)
docs/dogfood-rollout-2026-06-16.md          -> workflow-domains/beads/docs/   (IF confirmed a beads dogfood snapshot; else leave)
```
- Grep each file first (`grep -il beads <file>`) and read its scope; move only the
  ones whose subject IS beads-drain. If a doc is mixed (some generic harness content),
  leave it in core and note the beads section instead — do not split unless trivial.
- Update any in-repo links/refs to the moved docs (grep `docs/goal-supervision` etc.
  across `README.md`, other docs, and skills/commands prose).
- `package.json` does not list `docs/` in `files[]` (verify), so these were never
  published — the move is about repo cleanliness + co-location, not packaging. If
  `docs/` IS published, the move also removes them from the tarball (desirable).

Verify: links resolve; `npm test` green (no test reads these doc paths — confirm via
grep of `tests/` for the filenames before moving).

### Stage 6 — APPLY FU1: externalize the review_materialize tool

Depends on S1, S2 (command merge), S4.

File move map:
```text
workflow-kernel/review-materialize-adapter.js -> workflow-domains/beads/review-materialize-adapter.js
commands/review-materialize.md                 -> workflow-domains/beads/commands/review-materialize.md
```
(The command lands in the SAME `workflow-domains/beads/commands/` dir already wired by
FU2's `assetDirs.commands`, so no manifest change for the command.)

Manifest delta — `beads-extension.js`, add a `tools` factory:
```js
tools: (toolKit) => ({
  review_materialize: toolKit.tool({
    description: "Materialize repo-review findings into a duplicate-aware Beads epic ...",
    args: {
      repo: toolKit.schema.string(),
      programLabel: toolKit.schema.string().optional(),
      baselineHead: toolKit.schema.string().optional(),
      dryRun: toolKit.schema.boolean().optional(),
      acceptPartial: toolKit.schema.boolean().optional(),
      materializationReady: toolKit.schema.boolean().optional(),
      findings: toolKit.schema.any().optional(),
      findingsPath: toolKit.schema.string().optional(),
      format: toolKit.schema.enum(["summary", "json"]).optional(),
    },
    async execute(args, context) {
      toolKit.assertWriteWorkflowAllowed(context, "review_materialize");
      const { createReviewMaterializeAdapter } = await import("./review-materialize-adapter.js");
      const fs = await import("node:fs/promises");
      // ...identical body to the current workflow-plugin.js review_materialize execute...
    },
  }),
}),
```
The crosswalk file path is unchanged: it defaults to
`args.repo/.repo-review/crosswalk/<programLabel>.json` (`review-materialize-adapter.js:280`)
— runtime data in the TARGET repo, not a packaged asset, so the move does not affect it.

Kernel deletion:
- Remove the `review_materialize: tool({...})` block from `workflow-plugin.js`
  (≈`:2390-2452`).
- Remove `REVIEW_MATERIALIZE_COMMAND_PATH` from `constants.js:50`. NOTE: this constant
  is re-exported via the barrel (`index.js` `export * from "./constants.js"`), so its
  removal is a public-barrel API change. Acceptable at `0.1.0` (pre-1.0) but called out
  here as intentional. Verified zero in-plugin call sites/imports.

RED-first test rewrites:
- `tests/review-materialize-adapter.test.mjs:27` — import from
  `../workflow-domains/beads/review-materialize-adapter.js`.
- `tests/review-materialize-command-assets.test.mjs`:
  - `:10` — command path = `workflow-domains/beads/commands/review-materialize.md`.
  - `:24-31` (the registration test) — load the beads extension into a registry and
    call `configureWorkflowEntrypoints(cfg, registry.assetDirs())` so both
    `cfg.command["review-materialize"]` AND `cfg.command["beads-drain"]` (asserted at
    `:31`) resolve. (Both now arrive via the extension; the no-arg call cannot register
    them.) Keep the `cfg.command["repo-review"]` assertion (still bundled).
- `tests/extension-tool-contribution.test.mjs` — add a concrete case: loading the REAL
  beads extension exposes `.tool.review_materialize`, and a dry-run materialize with a
  mock `bd` (reuse `tests/helpers/mock-bd.mjs`) returns a plan.
- `tests/publish-completeness.test.mjs` — assert `commands/review-materialize.md` does
  NOT exist and `workflow-kernel/review-materialize-adapter.js` does NOT exist in the
  published layout. Add a negative assertion (here or in a barrel test) that
  `REVIEW_MATERIALIZE_COMMAND_PATH` is no longer exported from the kernel barrel.

package.json delta (FU1):
- No new negations needed: both files LEAVE published dirs
  (`workflow-kernel/review-materialize-adapter.js` exits the `workflow-kernel/`
  positive glob; `commands/review-materialize.md` exits `commands/`). Their new home
  under `workflow-domains/` (unpublished) excludes them automatically.

Verify: `npm test`; `tests/workflow-docs.test.mjs` still 16; `grep -rin beads
workflow-kernel/` returns only reworded comments / the `test-fix-drain-adapter.js`
fixture — NO production beads logic.

### Stage 6b — PR2: extract shared `beads-bd-util.js` (DECISION 5)

Runs AFTER Stage 6, once `review-materialize-adapter.js` and `beads-drain-adapter.js`
are co-located in `workflow-domains/beads/`. Both currently DUPLICATE bd helpers
(verified): `parseBdJson` (`beads-drain-adapter.js:28`, `review-materialize-adapter.js:47`)
and `normalizeIssue` (`beads-drain-adapter.js:38`, `review-materialize-adapter.js:59`).
`review-materialize-adapter.js` also has `defaultRunBd`/`stdoutText` — compare both
files' `bd` wrappers and extract only the GENUINELY-identical helpers (do not force-merge
behaviorally-divergent ones).

RED-first:
- Add `tests/beads-bd-util.test.mjs` (lives with the extension tests; pure-function unit
  tests for `parseBdJson` (valid JSON, empty stdout → null, invalid → throws with the
  command label) and `normalizeIssue` (labels-as-string vs array, id/external_ref
  aliases)). Import from the new `workflow-domains/beads/beads-bd-util.js` — RED until it
  exists.

GREEN:
- Create `workflow-domains/beads/beads-bd-util.js` exporting the confirmed-shared
  helpers (candidates: `parseBdJson`, `normalizeIssue`, `stdoutText`).
- Replace the duplicated definitions in BOTH adapters with imports from `./beads-bd-util.js`.
  Keep each adapter's adapter-SPECIFIC bits in place (e.g. `findingExternalRef`,
  `findingSignature` stay in `review-materialize-adapter.js`).
- Update existing adapter tests if they import these helpers from the adapter module
  directly (grep `tests/beads-drain-adapter.test.mjs` and
  `tests/review-materialize-adapter.test.mjs` for `parseBdJson`/`normalizeIssue` imports;
  re-point to the util or keep a re-export shim — prefer re-pointing).

Verify: `npm run test:workflow-adapters` + the new util test + the moved
review-materialize test all green; behavior of both adapters unchanged (the extraction
is a pure refactor — diff the pre/post helper bodies to confirm).

### Stage 6d — PR2: externalize the review-materialize/crosswalk docs (DECISION 5)

Move review-materialize-specific docs into the extension (same beads-specific test as
Stage 5d):
```text
docs/review-2026-06-19-beads-crosswalk.md -> workflow-domains/beads/docs/
```
Confirm it is review-materialize/crosswalk-specific (it is — verify by reading), update
any in-repo links, and confirm no test reads the path. Generic docs stay in core.

### Stage 7 — Verification, script reorg, docs

- npm scripts: add
  `"test:extension-seam": "node --test tests/extension-registry.test.mjs tests/extension-wiring.test.mjs tests/extension-tool-contribution.test.mjs tests/extension-dir-resolution.test.mjs tests/extension-auto-apply-trust.test.mjs tests/extension-command-skill-registration.test.mjs"`.
  Add `"test:extension-seam"` to the `suites` array in `scripts/release-no-token.mjs`
  (the `test:beads-drain` removal already happened in Stage 5).
- **`npm pack --dry-run` GATE (mandatory):** add a Stage-7 assertion (test or shell)
  that parses `npm pack --dry-run --json` and confirms the tarball file list contains
  NO `workflow-domains/` entry, NO `commands/beads-drain.md`, and NO
  `commands/review-materialize.md`. This guards against an accidental files[] match
  re-including the extension dir after the three negations were dropped.
- Docs: update `docs/general-purpose-harness-extraction-plan.md` Status banner (the
  follow-up is now shipped) and `docs/workflow-extensions.md` to document: the
  `tools:(toolKit)=>({...})` manifest field (and the injected
  `tool`/`schema`/`assertWriteWorkflowAllowed`/`pluginContext`); the `assetDirs` merge
  order (extension>bundled for workflow files, bundled>extension for commands — with
  rationale); and the extension-trusted auto-apply. Note migration: pre-move
  beads-drain cold-start approval hashes are invalidated (fresh two-phase), in-flight
  resumes are safe, restart opencode after config/plugin changes.

## Critical Files

| File | Change | Stage |
|---|---|---|
| `workflow-kernel/workflow-plugin.js` | loadExtensions→factory body (`:2143-2146`); `toolKit` + `...registry.tools(toolKit, coreNames)` in tool map (`:2160`); thread extWfDirs into source resolution (`:1306,1314,1402,2275`) + `configureWorkflowEntrypoints` (`:270,2146`); `isTrustedAutoApplySource(sourcePath, pluginContext)` + add to `__test` (`:786,2453`); call update at `:796`; DELETE `review_materialize` (`:2390-2452`) | 1,2,3,4,6 |
| `workflow-kernel/extension-registry.js` | `toolFactories` Map; `register()` tools validation; `tools(toolKit, reserved)` method (import-leaf) | 4 |
| `workflow-kernel/workflow-source.js` | `extensionWorkflowDirs=[]` on `resolveWorkflowSource` (`:184`, candidates `:194-198`, internal `isTrustedWorkflowPath` `:213`), `buildNestedSnapshots` (`:159`), `resolveWorkflowSourceForStart` (`:229`), `trustedWorkflowRoots` (`:266`), `isTrustedWorkflowPath` (`:270`) | 2 |
| `workflow-kernel/role-template-loading.js` | `listWorkflows` extensionWorkflowDirs param; `scope:"extension"` (`:324-329`) | 2 |
| `workflow-kernel/sandbox-executor.js` | `runNestedWorkflow` forwards ext workflow dirs to `resolveWorkflowSource` (`:93`) — atomic with buildNestedSnapshots (INV-9) | 2 |
| `workflow-kernel/constants.js` | remove `REVIEW_MATERIALIZE_COMMAND_PATH` (`:50`) — also leaves the barrel | 6 |
| `workflow-kernel/review-materialize-adapter.js` | MOVE to `workflow-domains/beads/` | 6 |
| `workflow-domains/beads/beads-extension.js` | add `assetDirs` (FU2) + `tools:(toolKit)=>` (FU1); fix `:7-9` comment | 5,6 |
| `workflows/beads-drain.js`, `commands/beads-drain.md`, `skills/beads-drain/` | MOVE to `workflow-domains/beads/{workflows,commands,skills}/` | 5 |
| `commands/review-materialize.md` | MOVE to `workflow-domains/beads/commands/` | 6 |
| `README.md` | beads-drain "bundled" → "extension" at `:36,38,81,99-100,116,133,248` | 5 |
| `package.json` | drop 3 negations, `beads` keyword, desc cleanup, drop `test:beads-drain`, add `test:extension-seam` | 5,7 |
| `scripts/release-no-token.mjs` | `suites` array: remove `test:beads-drain` (Stage 5), add `test:extension-seam` (Stage 7) | 5,7 |
| `tests/helpers/fake-extension.mjs` | NEW fixture helper | 1 |

## Reuse

- The extension registry, `loadExtensions`, idempotency, and asset-dir collection
  (`extension-registry.js`) already exist — reuse; only ADD the `tools` concept and
  CONSUME `assetDirs()`.
- `registerBundledCommand` (`workflow-plugin.js:260-268`) is reused verbatim for
  extension command registration (its `if (cfg.command[name]) return` guard gives the
  documented bundled>extension precedence).
- `tool()` is identity (`@opencode-ai/plugin/dist/tool.js`), so extension tool objects
  ARE valid ToolDefinitions — the toolKit injection costs nothing at runtime but pins
  one zod instance (INV-4).
- `assertWriteWorkflowAllowed` (`authority-policy.js:151`) and the `review_materialize`
  execute body move verbatim; no logic rewrite.
- `tests/helpers/mock-bd.mjs` and `fake-drain-adapter.mjs` are reused by the new
  extension-seam tests.
- The legacy `__workflowDrainAdapters` seam (`sandbox-executor.js:135`) stays for the
  existing beads-drain-workflow integration tests; NEW tests use the real
  extension-registry path.

## Verification

Automated targets:
- `npm run test:extension-seam` (NEW) — the 6 seam tests.
- `npm run test:workflow-kernel`, `npm run test:workflows`,
  `npm run test:workflow-adapters`, `npm run test:repo-review-no-mutation`.
- `npm run release:no-token` (passes after BOTH Stage 5 and Stage 7).
- `npm test` (global) — picks up moved/rewritten beads + review-materialize tests.
- `tests/publish-completeness.test.mjs` — beads-drain.md, review-materialize.md, and
  review-materialize-adapter.js absent from the published layout; barrel no longer
  exports `REVIEW_MATERIALIZE_COMMAND_PATH`.
- `grep -rin beads workflow-kernel/` — only reworded comments + the non-beads
  `test-fix-drain-adapter.js` fixture.
- `npm pack --dry-run --json` GATE — tarball excludes `workflow-domains/`,
  `commands/beads-drain.md`, `commands/review-materialize.md`.

End-to-end (manual, opencode restart required):
- **E1.** With the beads extension configured: `review_materialize` appears as a tool
  and is INVOKABLE under opencode's default tool permission (confirming INV-14);
  `/review-materialize` command registered; dry-run materialize works.
- **E2.** `workflow_run({ name:"beads-drain" })` resolves from the extension dir, lists
  as `scope:"extension"`, and an autonomous-local run AUTO-APPLIES (INV-7).
- **E3.** Without the extension: `review_materialize` absent, `/beads-drain` absent,
  `workflow_run({ name:"beads-drain" })` fails to resolve — no kernel beads logic.
- **E4.** Resume an in-flight pre-move autonomous-local drain: still auto-applies (old
  bundled sourcePath still trusted; INV-10).

## Gates / Risks / Out-of-scope

Gates (must hold before merge):
- INV-7 verified by `extension-auto-apply-trust.test.mjs` (project/global shadow denied
  auto-apply; bundled + extension trusted).
- INV-8 internal scriptPath admission verified (extension-dir scriptPath admitted).
- INV-9 nested-snapshot symmetry verified (extension workflow nesting an extension
  workflow runs without the snapshot-mismatch throw).
- INV-13 verified (core-name and cross-extension tool collisions throw).
- INV-14 verified end-to-end (E1).
- Full suite green; grep-gate clean; `npm pack --dry-run` gate clean;
  `npm run release:no-token` green.

Risks:
- Moving `loadExtensions` into the factory body changes the failure surface (factory
  rejection vs config-hook rejection) AND puts extension import on the
  factory-resolution critical path. Mitigated: keep fail-loud (INV-6); require
  import-cheap extension modules; `extension-wiring.test.mjs` asserts the new surface.
- `configureWorkflowEntrypoints` and the `workflow-source.js`/`role-template-loading.js`
  signature changes ripple to direct test callers — mitigated by empty `[]`/`{}`
  defaults (backward compatible).
- `scripts/release-no-token.mjs` runs each `suites` entry via `npm run` and fails on a
  non-zero exit (no pre-run existence check); dropping `test:beads-drain` from
  package.json without removing it from `suites` in the SAME stage breaks the release
  check — handled in Stage 5.
- Command precedence is intentionally bundled>extension while workflow-file resolution
  is extension>bundled. Mitigated by explicit docs (Stage 7) and a regression test.
- The `beads-bd-util.js` extraction (Stage 6b) is a pure refactor across two
  co-located adapters; risk is low but real (a behavioral divergence between the two
  `parseBdJson`/`normalizeIssue` copies could surface). Mitigated by diffing pre/post
  helper bodies and the new `beads-bd-util.test.mjs` + unchanged adapter suites.

Out-of-scope (explicitly deferred):
- Extracting the pure `classifyFinding`/`planMaterialization` into a generic OSS-core
  "finding dedup" utility.
- Enforcing dry-run-unless-`approve` inside the extension tool (today it is command
  prose; no kernel approval-hash).
- Snapshotting trusted extension dirs at run-start for resume (current
  re-evaluate-at-resume posture matches "explicitly configured = trusted").
- Auto-materialize from inside a repo-review run.

Now IN-SCOPE (per resolved decisions, previously deferred):
- Shared `beads-bd-util.js` extraction → Stage 6b (DECISION 5).
- Beads/review-materialize doc externalization → Stages 5d + 6d (DECISION 5).
- (DECISION 1 resolved: ONE `beads-extension.js` carries drain + review-materialize; a
  second `beads-review-extension.js` is explicitly NOT pursued.)

## Findings Corrected During Grounding

- `release-no-token.mjs` has a `suites` array (`:3-9`), NOT a "TEST_SCRIPTS array that
  asserts each exists." It RUNS each via `spawnSync("npm",["run",suite])` and exits
  non-zero on failure — no existence assertion. Conclusion (drop `test:beads-drain` /
  add `test:extension-seam`) stands; mechanism corrected.
- "Resolution order project>global>extension>bundled at EVERY site" is WRONG for
  `cfg.command` registration, which is bundled>extension (`workflow-plugin.js:261,280-287`).
  Qualified: extension>bundled for workflow FILE resolution; bundled>extension for
  command registration.
- `isTrustedAutoApplySource` takes ONE arg today (`workflow-plugin.js:786`) and is a
  PRIVATE closure NOT in `WorkflowPlugin.__test` — Stage 3 must add it to `__test`
  (chosen) or test integration-only. The draft's "call it directly" was unverifiable as
  written.
- The internal `isTrustedWorkflowPath(absolute, context)` call at
  `workflow-source.js:213` (scriptPath admission) must also receive `extensionWorkflowDirs`
  — otherwise extension dirs are trusted for name resolution/listing/auto-apply but not
  for scriptPath admission (latent asymmetry on the generic seam).
- `buildNestedSnapshots` (approval) and `runNestedWorkflow` (runtime,
  `sandbox-executor.js:93`) must be threaded as ONE atomic change; the
  snapshot-by-sourcePath match (`:96-98`) would otherwise throw for an extension
  workflow that nests another extension workflow. beads-drain has zero nested refs, so
  this is a generic-seam invariant needing a dedicated test, not a beads behavior.
- `beads-drain-assets.test.mjs` rewrite list extended beyond the draft's `:12,32,64`:
  also `:63` (test title), `:95` (README `scope:"bundled"`), `:115` (README "bundled
  non-dry beads-drain"), and the registration test (`:204-216`) must load the extension
  and pass `assetDirs()`.
- `README.md` is a required FU2 change site (`:36,38,81,99-100,116,133,248`) — the
  beads-drain-assets README test keys on `:95`/`:115` wording.
- `beads-drain-workflow.test.mjs:64` inline `makeHarness` calls `workflowPlugin(pluginContext)`
  with no second arg — it MUST be updated to forward `{ extensions: [...] }` (real
  beads-extension path) so the workflow resolves from the extension dir and lists as
  `scope:"extension"`.
- `review-materialize-command-assets.test.mjs:31` asserts `cfg.command["beads-drain"]`
  resolves via the no-arg `configureWorkflowEntrypoints(cfg)` — this MUST switch to
  loading the extension and passing `assetDirs()` (Stage 6) or it breaks.
- `beads-extension.js:7-9` comment ("remain bundled in the core package") is factually
  wrong after FU2 and must be corrected.
- VERIFIED TRUE (unchanged from draft): `workflow-docs.test.mjs` stays at 16
  (regex matches only `workflow_*` literals); `index.js` does not re-export
  `review-materialize-adapter`; only `tests/review-materialize-adapter.test.mjs` and the
  kernel literal import it; `durable-state.test.mjs` does not; there is no
  `skills/review-materialize`; in-flight pre-move resumes are approval-hash-stable while
  cold starts invalidate; trust is a separate predicate from resolution order.

## Resolved Decisions (2026-06-30, baked into the stages above)

1. **DECISION 1 — extension placement: SAME extension.** `review_materialize` lives in
   the existing `workflow-domains/beads/beads-extension.js` alongside the drain adapter,
   finalizers, and assets. Parent `opencode.json` stays unchanged (one explicit entry).
2. **DECISION 2 — auto-apply trust test: UNIT + INTEGRATION.** Stage 3 adds
   `isTrustedAutoApplySource` to `WorkflowPlugin.__test` for a direct shadow-denied unit
   test AND ships the end-to-end test.
3. **DECISION 3 — command precedence: BUNDLED > EXTENSION.** Extensions contribute
   net-new command names only (matching the existing `registerBundledCommand` guard); no
   guard rewrite. Documented as an intentional inversion vs the extension>bundled
   workflow-file order.
4. **DECISION 4 — sequencing: TWO PRs, FU2 FIRST.** PR1 = Stages 2,3,5,5d (move beads
   assets; NO factory-timing change). PR2 = Stages 1,4,6,6b,6d (tool seam + externalize
   review_materialize + bd-util + docs). See "Ship structure" under Execution Stages —
   S1 was moved into PR2 because FU2 does not need it.
5. **DECISION 5 — scope: FOLD IN the cleanups.** The shared `beads-bd-util.js`
   extraction (Stage 6b) and the beads/review-materialize doc externalization
   (Stages 5d + 6d) are now in-scope.

## Residual Risks

- The npm pack --dry-run gate depends on files[] globs behaving as expected after the three negations are dropped; if a future positive glob is broadened, workflow-domains/ could be re-included. The gate test mitigates but must be kept in CI.
- INV-9 (nested-snapshot symmetry) has no production exerciser today (beads-drain has zero nested workflow() refs); the new generic-seam test is the only guard. If a future extension workflow uses nesting and the two threading edits drift apart, the test must catch it — it is not exercised by any real workflow.
- Stage 3 adds isTrustedAutoApplySource to WorkflowPlugin.__test, growing the test surface (accepted per DECISION 2 — the security-critical trust predicate gets direct unit coverage).
- Command precedence is intentionally bundled>extension while workflow-file resolution is extension>bundled; extension authors who assume uniform precedence could be surprised despite the documentation. No code enforces a warning on a shadowed extension command name.
- Pre-move beads-drain cold-start approval hashes are invalidated by the sourcePath change (INV-11); any operator mid-approval (preview obtained, not yet executed) at deploy time must re-preview. In-flight executing resumes are safe.
