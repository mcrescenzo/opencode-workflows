# Pure-Architecture Extraction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The plugin ships zero pre-built workflows, commands, or domain logic (pure workflow architecture); the nine repo-* workflows move to the user's global workflow registry; the beads domain is deleted.

**Architecture:** Two nested-but-independent git repos change in lockstep: the plugin repo (`/home/hermes/code/opencode-config/plugins/opencode-workflows`, branch `pure-architecture-extraction`) loses all domain content, and the config repo (`/home/hermes/code/opencode-config`, its own `.git`, commits to its current branch) adopts the repo-* suite. Kernel discovery is already directory-driven and ENOENT-tolerant, so no kernel logic changes — only tests, docs, and manifests. Every commit leaves both repos green.

**Tech Stack:** Node ≥ 20.11, `node --test` (`.test.mjs`), npm pack, opencode plugin API.

**Spec:** `docs/superpowers/specs/2026-07-08-pure-architecture-extraction-design.md`

## Global Constraints

- Plugin repo work happens on branch `pure-architecture-extraction` (already created; spec committed).
- Config repo (`/home/hermes/code/opencode-config`) commits go to its currently checked-out branch — it is the *live* opencode config; keep it loadable at every commit.
- Run the FULL plugin suite after every plugin-repo task: `cd /home/hermes/code/opencode-config/plugins/opencode-workflows && npm test`. Expected: 0 failures (test count shrinks as files are deleted; baseline ≈ 1056 passing).
- The kernel mechanism stays: `BUNDLED_WORKFLOW_DIR`, `BUNDLED_COMMAND_DIR`, `BUNDLED_SKILL_DIR`, `registerCommandsFromDir`, `extension-registry.js`, `drain-runtime.js`. Verified ENOENT-tolerant: `registerCommandsFromDir` catches readdir errors (`workflow-plugin.js:288-300`); `listWorkflows` skips missing dirs via `pathExists` (`role-template-loading.js:523-533`); `resolveWorkflowSource` probes candidates in try/catch (`workflow-source.js:358-366`). Do NOT add missing-dir guards — they exist.
- Kernel keeps: `INVENTORY_ALWAYS_EXCLUDE`'s `".repo-review"` entry (`sandbox-executor.js:484`) and `.gitignore`'s `.repo-review/` line — the relocated commands still write `.repo-review/runs/` in target repos.
- `CHANGELOG.md` historical entries are never edited; a new entry is added (Task 8).
- Commit messages end with: `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`

---

### Task 1: Config repo adopts the suite (additive)

**Files:**
- Create: `/home/hermes/code/opencode-config/workflows/repo-{bughunt,cleanup,complexity,deps,modernize,perf,review,security-audit,test-gaps}.js` (copies)
- Create: `/home/hermes/code/opencode-config/commands/repo-bughunt.md`, `/home/hermes/code/opencode-config/commands/repo-review.md` (edited copies)
- Create: `/home/hermes/code/opencode-config/skills/repo-review-command-protocol/SKILL.md` (copy)

**Interfaces:**
- Produces: the nine workflows resolvable by `workflow_run({name})` at the `global` tier (`GLOBAL_WORKFLOW_DIR` = `/home/hermes/code/opencode-config/workflows` on this machine via the legacy-monorepo branch of `resolveGlobalWorkflowDir`); `/repo-bughunt` and `/repo-review` registered from config-root `commands/`; the `repo-review-command-protocol` skill resolvable from config-root `skills/`.
- Consumes: nothing. While both copies exist (until Task 6), the global tier shadows the bundled tier — same content, harmless.

- [ ] **Step 1: Copy the nine workflows verbatim**

```bash
PLUGIN=/home/hermes/code/opencode-config/plugins/opencode-workflows
CFG=/home/hermes/code/opencode-config
cp "$PLUGIN"/workflows/repo-*.js "$CFG/workflows/"
for f in "$PLUGIN"/workflows/repo-*.js; do diff -q "$f" "$CFG/workflows/$(basename "$f")"; done
```
Expected: no diff output (9 identical copies).

- [ ] **Step 2: Copy the two commands and strip beads references**

```bash
cp "$PLUGIN"/commands/repo-bughunt.md "$PLUGIN"/commands/repo-review.md "$CFG/commands/"
```

Edit `$CFG/commands/repo-bughunt.md` — in `## 4. Boundary` (source lines 81-87), replace:

```
This command is report-only. Avoid `materialize`, `beads-drain`,
`workflow_apply`, any `git` write, and any `bd` create/update/close/claim. The
```
with:
```
This command is report-only. Avoid `workflow_apply`, any `git` write, and any
issue-tracker mutation. The
```

Edit `$CFG/commands/repo-review.md`:
1. Replace the entire `## 4. Coverage And Materialization` section (source lines 111-129) with:

```markdown
## 4. Coverage

Report `leafOutcomes` and `partialCoverage` so the user sees which domains
completed or failed. Report `materializationReady`, `materializationBlockers`,
`coverageGrade`, `coverageAdvisories`, and `coverageAudit` as informational
coverage signals. This command offers no follow-up mutation of any kind.
```

2. In `## 5. Boundary` (source lines 131-138), replace:
```
This command is report-only. It must never run `materialize`, `beads-drain`,
`workflow_apply`, any `git` write, or any `bd` create/update/close/claim. The
```
with:
```
This command is report-only. It must never run `workflow_apply`, any `git`
write, or any issue-tracker mutation. The
```
3. In `## 6. Report Back` (source lines 140-148): delete the `materializationReady`/`materializationBlockers` mentions if they instruct offering an action; keep them if purely reported fields (they are — leave the list as-is).
4. Grep the two copied files: `grep -n "review-materialize\|beads" "$CFG"/commands/repo-*.md` — Expected: no matches.

- [ ] **Step 3: Copy the skill**

```bash
mkdir -p "$CFG/skills/repo-review-command-protocol"
cp "$PLUGIN"/skills/repo-review-command-protocol/SKILL.md "$CFG/skills/repo-review-command-protocol/"
```

- [ ] **Step 4: Commit (config repo)**

```bash
cd "$CFG" && git status --short   # confirm only the 12 new files
git add workflows/repo-*.js commands/repo-bughunt.md commands/repo-review.md skills/repo-review-command-protocol
git commit -m "feat(workflows): adopt repo-* review suite as global workflows + commands

Nine repo-* workflows from the opencode-workflows plugin now live at the
global tier; /repo-bughunt and /repo-review move to config-root commands
(materialization offers stripped — the beads extension is being deprecated).

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: Rewire workflow-run tests off beads/bundled fixtures (presence-agnostic)

**Files:**
- Modify: `tests/workflow-run.test.mjs:1609-1641` (two tests), `:1675-1739` (two ux.1 tests), `:2358-2378` (one test)

All rewritten tests must pass BOTH before and after the deletions (they reference only their own fake-extension fixtures). They use the existing helpers `makeExtensionDir`, `writeFakeExtension`, `defaultWorkflowBody` from `tests/helpers/fake-extension.mjs` — add the import if the file lacks it:

```js
import { makeExtensionDir, writeFakeExtension } from "./helpers/fake-extension.mjs";
```

**Interfaces:**
- Consumes: `makeHarness(promptFn, options)` supports `options.extensions` (array of extension module paths; currently defaults to `[BEADS_EXT_PATH]` — the default flips in Task 5). `writeFakeExtension(dir, {id, assetDirs, workflows})` writes `<dir>/extension.js` + asset dirs.
- Produces: a shared rich-meta fixture constant `RICH_META_WORKFLOW` used by the ux.1 rewrite; the pattern `extensions: [extPath]` for fixture-scoped listing tests.

- [ ] **Step 1: Add the rich-meta fixture workflow body near the top of `tests/workflow-run.test.mjs`** (module scope, after imports). Its meta mirrors the field surface of the deleted `workflows/repo-bughunt.js` meta (description, profile, phases, category, notes, examples, argsSchema):

```js
// Fixture workflow with a fully-populated meta: the invocation-metadata contract
// (ux.1) is now asserted against this fixture instead of any bundled workflow.
const RICH_META_WORKFLOW = `export const meta = {
  name: "fixture-rich",
  description: "Fixture workflow with complete invocation metadata.",
  profile: "read-only-review",
  maxAgents: 4,
  concurrency: 2,
  phases: ["recon", "find"],
  category: "fixture",
  notes: "Read-only fixture. Finder lanes use fast tier, verification lanes use deep tier.",
  examples: [
    { label: "default scan", args: { depth: "normal", paths: ["src"] } },
  ],
  argsSchema: {
    type: ["object", "null"],
    properties: {
      paths: { type: "array", items: { type: "string" } },
      depth: { type: "string", enum: ["quick", "normal"] },
      categories: { type: "array", items: { type: "string", enum: ["concurrency"] } },
    },
  },
};
return "ok";
`;
```

- [ ] **Step 2: Rewrite `workflow_list includes bundled workflows with source metadata` (line 1609)** — rename and fixture-drive it:

```js
test("workflow_list includes extension workflows with source metadata", async () => {
  const extDir = await makeExtensionDir();
  const extPath = await writeFakeExtension(extDir, {
    id: "list-meta",
    assetDirs: { workflows: "./workflows" },
    workflows: { "fixture-rich": RICH_META_WORKFLOW },
  });
  const { tools, context, directory } = await makeHarness(async () => ({ data: { parts: [], info: {} } }), {
    extensions: [extPath],
  });
  try {
    const listed = JSON.parse(await tools.workflow_list.execute({ format: "json" }, context));
    const entry = listed.find((e) => e.scope === "extension" && e.name === "fixture-rich");
    const srcPath = path.join(extDir, "workflows", "fixture-rich.js");
    const src = await fs.readFile(srcPath, "utf8");

    assert.ok(entry, "missing extension fixture-rich workflow");
    assert.equal(entry.sourcePath, srcPath);
    assert.equal(entry.sourceHash, __test.hash(src));
    assert.deepEqual(entry.phases, ["recon", "find"]);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
    await fs.rm(extDir, { recursive: true, force: true });
  }
});
```
(The `authority.integration` assertion was beads-drain-specific — dropped.)

- [ ] **Step 3: Rewrite the summary-format regression test (line 1627)** — same fixture pattern; keep the regression intent (non-json format must not throw):

```js
test("workflow_list summary format renders authority= without throwing (regression: authoritySummary/truncateText imports)", async () => {
  const extDir = await makeExtensionDir();
  const extPath = await writeFakeExtension(extDir, {
    id: "list-summary",
    assetDirs: { workflows: "./workflows" },
    workflows: { "fixture-rich": RICH_META_WORKFLOW },
  });
  const { tools, context, directory } = await makeHarness(async () => ({ data: { parts: [], info: {} } }), {
    extensions: [extPath],
  });
  try {
    const summary = await tools.workflow_list.execute({}, context);
    assert.equal(typeof summary, "string");
    assert.match(summary, /extension\/fixture-rich/, "summary should list the extension fixture workflow");
    assert.match(summary, /authority=/, "summary must render authority= via authoritySummary");
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
    await fs.rm(extDir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 4: Rewrite `ux.1: all bundled workflows expose machine-readable invocation metadata` (line 1675)** — the invocation-metadata contract, asserted against the fixture (the exact ten-name list assertion is deleted; a zero-bundled assertion is added later, in Task 6 Step 5):

```js
test("ux.1: extension workflows expose machine-readable invocation metadata", async () => {
  const extDir = await makeExtensionDir();
  const extPath = await writeFakeExtension(extDir, {
    id: "ux1-meta",
    assetDirs: { workflows: "./workflows" },
    workflows: { "fixture-rich": RICH_META_WORKFLOW },
  });
  const { tools, context, directory } = await makeHarness(async () => {
    throw new Error("workflow_list metadata must not prompt a model");
  }, { extensions: [extPath] });
  try {
    const listed = JSON.parse(await tools.workflow_list.execute({ format: "json" }, context));
    const entries = listed.filter((e) => e.scope === "extension" && e.name === "fixture-rich");
    assert.equal(entries.length, 1, "fixture workflow must be listed exactly once");
    for (const entry of entries) {
      assert.ok(entry.argsSchema, `${entry.name} must expose argsSchema`);
      assert.ok(entry.invocation?.argsShape, `${entry.name} must expose a summarized args shape`);
      assert.ok(entry.invocation?.category, `${entry.name} must expose a category`);
      assert.ok(entry.invocation?.notes, `${entry.name} must expose operator/agent notes`);
      assert.ok(entry.invocation?.profile, `${entry.name} must expose authority profile`);
      assert.ok(entry.invocation?.runExamples?.some((line) => line.includes(`name="${entry.name}"`)), `${entry.name} must expose runnable examples`);
      assert.ok(entry.invocation?.argsExamples?.length > 0, `${entry.name} must expose structured args examples`);
      assert.ok(entry.invocation?.nextSteps?.some((step) => /workflow_status detail=result/.test(step)), `${entry.name} must expose safe readback next step`);
    }
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
    await fs.rm(extDir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 5: Delete `ux.1: repo-review bundled metadata exposes selection args and read-only authority hints` (lines 1711-1739)** — its subject leaves the repo; the generic metadata surface is covered by Step 4.

- [ ] **Step 6: Rewrite `workflow_run resolves extension workflows by name and project overrides win` (line 2358)** — same mechanism, fixture extension instead of beads:

```js
test("workflow_run resolves extension workflows by name and project overrides win", async () => {
  const extDir = await makeExtensionDir();
  const extPath = await writeFakeExtension(extDir, {
    id: "resolve-order",
    assetDirs: { workflows: "./workflows" },
    workflows: { "fixture-rich": RICH_META_WORKFLOW },
  });
  const { tools, context, directory } = await makeHarness(async () => ({ data: { parts: [], info: {} } }), {
    extensions: [extPath],
  });
  try {
    await initGitRepo(directory);

    const extWorkflowPath = path.join(extDir, "workflows", "fixture-rich.js");
    const extPreview = await tools.workflow_run.execute({ name: "fixture-rich" }, context);
    assert.match(extPreview, new RegExp(`Source: ${extWorkflowPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));

    const projectPath = path.join(__test.projectWorkflowDir(context), "fixture-rich.js");
    await fs.mkdir(path.dirname(projectPath), { recursive: true });
    await fs.writeFile(projectPath, `export const meta = { name: "fixture-rich", description: "project override" };
return true;`, "utf8");
    const projectPreview = await tools.workflow_run.execute({ name: "fixture-rich" }, context);
    assert.match(projectPreview, new RegExp(`Source: ${projectPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    assert.match(projectPreview, /Description: project override/);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
    await fs.rm(extDir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 7: Run the file, then the full suite**

```bash
node --test tests/workflow-run.test.mjs
npm test
```
Expected: PASS (0 fail). The rewritten tests no longer mention `beads` or `workflow-domains`: `grep -n "workflow-domains\|beads" tests/workflow-run.test.mjs` → no matches.

- [ ] **Step 8: Commit**

```bash
git add tests/workflow-run.test.mjs
git commit -m "test: fixture-drive workflow-list/run resolution tests off the beads extension

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Presence-agnostic rewrite of the command-precedence test

**Files:**
- Modify: `tests/extension-command-skill-registration.test.mjs:30-51`

**Interfaces:**
- Consumes: `configureWorkflowEntrypoints(cfg, extensionAssetDirs)` from `WorkflowPlugin.__test`; `writeFakeExtension`.
- Produces: precedence coverage that no longer needs a bundled command. (The two remaining bundled-asset tests in this file are rewritten in Task 6 — they assert current on-disk state and must flip in the same commit as the deletion.)

- [ ] **Step 1: Rewrite `a bundled command name wins over a same-named extension command (bundled > extension)` (lines 30-51)** as a first-registration-wins test over two extensions (the same `registerBundledCommand` guard):

```js
test("the first-registered command name wins on a collision (registration order precedence)", async () => {
  const dirA = await makeExtensionDir();
  await writeFakeExtension(dirA, {
    id: "ext-a",
    assetDirs: { commands: "./commands" },
    commands: { dupe: "FIRST REGISTRATION — must win.\n" },
  });
  const dirB = await makeExtensionDir();
  await writeFakeExtension(dirB, {
    id: "ext-b",
    assetDirs: { commands: "./commands" },
    commands: { dupe: "SECOND REGISTRATION — must not win.\n" },
  });

  const cfg = {};
  await configureWorkflowEntrypoints(cfg, {
    workflows: [],
    commands: [path.join(dirA, "commands"), path.join(dirB, "commands")],
    skills: [],
  });

  assert.match(cfg.command.dupe.template ?? JSON.stringify(cfg.command.dupe), /FIRST REGISTRATION/);
  assert.doesNotMatch(cfg.command.dupe.template ?? JSON.stringify(cfg.command.dupe), /SECOND REGISTRATION/);
});
```
Note: check how `registerBundledCommand` stores the command body (read `workflow-plugin.js` around line 260-300 for the exact `cfg.command[name]` shape — `template`/`description` fields) and assert on the actual field rather than the JSON.stringify fallback; the two-assertion structure stays.

- [ ] **Step 2: Run and commit**

```bash
node --test tests/extension-command-skill-registration.test.mjs && npm test
git add tests/extension-command-skill-registration.test.mjs
git commit -m "test: command-name precedence asserted via two fixture extensions, not the bundled repo-review command

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```
Expected: PASS both runs (the other tests in the file still reference bundled assets — they still exist until Task 6).

---

### Task 4: Relocate the test-fix drain adapter out of the published kernel

**Files:**
- Move: `workflow-kernel/test-fix-drain-adapter.js` → `tests/fixtures/test-fix-drain-adapter.js`
- Modify: `workflow-kernel/index.js:61` (delete the re-export line), `tests/test-fix-drain-adapter.test.mjs:5` (import path)

**Interfaces:**
- Consumes: grep-verified — the ONLY importers are `workflow-kernel/index.js:61` (`export * from "./test-fix-drain-adapter.js";`) and `tests/test-fix-drain-adapter.test.mjs:5`.
- Produces: `tests/fixtures/` directory (fixture home for later tasks); a published `workflow-kernel/` with no test fixtures inside.

- [ ] **Step 1: Move the file and update the two references**

```bash
mkdir -p tests/fixtures
git mv workflow-kernel/test-fix-drain-adapter.js tests/fixtures/test-fix-drain-adapter.js
```
In `workflow-kernel/index.js`, delete line 61: `export * from "./test-fix-drain-adapter.js";`
In `tests/test-fix-drain-adapter.test.mjs`, change line 5 to:
```js
import { createTestFixDrainAdapter, defaultRunCommand, groupTestFailures } from "./fixtures/test-fix-drain-adapter.js";
```
No `package.json` change in this task — `test:workflow-adapters` lists the `.test.mjs` file (whose path is unchanged), not the adapter module; the beads entry in that script is removed in Task 5.

- [ ] **Step 2: Check the moved file's internal imports** — Read `tests/fixtures/test-fix-drain-adapter.js`; if it imports sibling kernel modules via `./`, rewrite them to `../../workflow-kernel/<module>.js`.

- [ ] **Step 3: Run and commit**

```bash
npm test
git add -A
git commit -m "refactor: test-fix drain adapter is a test fixture, not published kernel code

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```
Expected: PASS.

---

### Task 5: Delete the beads domain (both repos, coordinated)

**Files:**
- Modify (config repo): `/home/hermes/code/opencode-config/opencode.json:20-24`
- Delete (plugin): `workflow-domains/` (entire tree), `tests/beads-bd-util.test.mjs`, `tests/beads-drain-adapter.test.mjs`, `tests/beads-drain-assets.test.mjs`, `tests/beads-drain-scratch.test.mjs`, `tests/beads-drain-workflow.test.mjs`, `tests/review-materialize-adapter.test.mjs`, `tests/review-materialize-command-assets.test.mjs`, `docs/beads-tool-asset-externalization-plan.md`
- Modify (plugin): `tests/helpers/harness.mjs:5-23,204,215`, `tests/durable-state.test.mjs:783-828,830-~870`, `tests/extension-tool-contribution.test.mjs` (six real-beads tests), `tests/publish-completeness.test.mjs:122-159`, `tests/workflow-docs.test.mjs:75`, `package.json:48-49`, `README.md:146-231` (Extension Trust Boundary rewording + Beads Drain deletion)

**Interfaces:**
- Consumes: `fakeDrainAdapter`/`emptyDrainAdapter` from `tests/helpers/fake-drain-adapter.mjs` (existing); `writeFakeExtension` `source:` mode.
- Produces: `makeHarness` default `extensions: []` and default `__workflowDomainMutationHandlers: {}` — any test needing a domain-mutation finalizer must pass one explicitly via `options.pluginContext.__workflowDomainMutationHandlers`.

- [ ] **Step 1 (config repo FIRST — keep live opencode loadable): unwire the extension**

In `/home/hermes/code/opencode-config/opencode.json`, replace the array-form plugin entry (lines 20-24):
```json
    [
      "./plugins/opencode-workflows/opencode-workflows.js",
      { "extensions": ["./plugins/opencode-workflows/workflow-domains/beads/beads-extension.js"] }
    ],
```
with the plain string:
```json
    "./plugins/opencode-workflows/opencode-workflows.js",
```
Commit (config repo):
```bash
cd /home/hermes/code/opencode-config && git add opencode.json
git commit -m "chore: unwire the beads extension (deprecated; workflow-domains is being deleted)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

- [ ] **Step 2: Rewire `tests/helpers/harness.mjs` off beads.** Delete line 6 (`import { finalizeBeadsDomainMutation } ...`), lines 8-13 (the comment + `REPO_ROOT`/`BEADS_EXT_PATH` consts — keep `REPO_ROOT` only if used elsewhere in the file; grep first), and replace lines 15-23 with:
```js
// Domain-mutation finalization is owned by trusted extensions. The kernel harness wires none by
// default; tests that exercise staged domain mutations pass explicit handlers via
// options.pluginContext.__workflowDomainMutationHandlers.
const DEFAULT_DOMAIN_MUTATION_HANDLERS = {};
```
At line 215, change `const extensions = options.extensions ?? [BEADS_EXT_PATH];` to:
```js
const extensions = options.extensions ?? [];
```

- [ ] **Step 3: Delete the two beads-idempotency tests in `tests/durable-state.test.mjs`** (the `test(...)` blocks starting at lines 783 and 830 — both dynamically import `../workflow-domains/beads/beads-drain-adapter.js` and test beads adapter behavior). Also check lines around them: `grep -n "workflow-domains" tests/durable-state.test.mjs` must return nothing after.

- [ ] **Step 4: Delete the six real-beads tests in `tests/extension-tool-contribution.test.mjs`** (test blocks starting at lines 164, 180, 204, 276, 297, 328) and the import at lines 7-10 (`formatReviewMaterializeResult`, `resolveRepoReviewRunMaterializationInput` from `../workflow-domains/beads/beads-extension.js`). The mechanism tests using `PROBE_EXT`/`writeFakeExtension` (lines 89-162, 387-399) remain — the extension-tool seam stays covered.

- [ ] **Step 5: Flip the beads assertions in `tests/publish-completeness.test.mjs`.** Replace the two tests at lines 122-141 with one:
```js
test("no domain extension assets exist in the repo (pure-architecture invariant)", () => {
  assert.equal(existsSync(new URL("workflow-domains/", root)), false);
  assert.equal((pkg.files ?? []).includes("workflow-domains/"), false);
});
```
In the tarball test (lines 143-159), the `offenders` filter keeps `p.startsWith("workflow-domains/")` and drops the four beads-name lines (they're subsumed; the workflows/commands lines are generalized in Task 6).

- [ ] **Step 6: `tests/workflow-docs.test.mjs:75`** — delete the `"workflow-domains/beads/commands/beads-drain.md"` reference (and the assertion consuming it; read the surrounding block and remove the beads-drain entry from whatever list it sits in).

- [ ] **Step 7: Delete the beads domain + tests + doc; trim scripts**

```bash
git rm -r workflow-domains
git rm tests/beads-bd-util.test.mjs tests/beads-drain-adapter.test.mjs tests/beads-drain-assets.test.mjs \
       tests/beads-drain-scratch.test.mjs tests/beads-drain-workflow.test.mjs \
       tests/review-materialize-adapter.test.mjs tests/review-materialize-command-assets.test.mjs
# These two SUITE tests import from workflow-domains/, so they must die with beads
# (not in Task 6): repo-review-artifacts imports review-materialize-adapter.js;
# repo-review-no-mutation path-joins workflow-domains/beads/workflows.
git rm tests/repo-review-artifacts.test.mjs tests/repo-review-no-mutation.test.mjs
git rm docs/beads-tool-asset-externalization-plan.md
```
In `package.json`: delete the `test:beads-drain` script (line 49); change `test:workflow-adapters` (line 48) to:
```json
"test:workflow-adapters": "node --test tests/test-fix-drain-adapter.test.mjs",
```

- [ ] **Step 8: README beads sweep.** Delete the `## Beads Drain` section (lines 173-231, everything from the heading up to but excluding `## Repo Review Suite` at line 232). Then `grep -n "beads\|workflow-domains" README.md` and rewrite every remaining hit generically — known sites: the `## Extension Trust Boundary` section (line 146; replace the beads-drain example with "a trusted extension's drain adapter"), the `## Command And Skill Registration` sentence naming beads-drain (line ~140), and the apply-boundary sentence (~line 352: "The single intentional in-run apply exception is the extension-trusted non-dry `beads-drain`..." → "The single intentional in-run apply exception is an extension-trusted non-dry drain workflow..."). Expected after: `grep -c "beads" README.md` → 0.

- [ ] **Step 9: Run the full suite and fix stragglers**

```bash
npm test 2>&1 | tail -20
grep -rn "workflow-domains" tests/ workflow-kernel/ package.json README.md AGENTS.md || echo CLEAN
```
Expected: 0 failures; `CLEAN`. If a kernel test fails because it relied on the harness's default beads mutation handlers, pass an explicit local fake via `options.pluginContext.__workflowDomainMutationHandlers = { "beads.close": async () => ({}) }` — but prefer renaming the op to a neutral `fixture.close` if the test is mechanism-level.

- [ ] **Step 10: Commit (plugin repo)**

```bash
git add -A
git commit -m "feat!: deprecate and delete the beads domain (workflow-domains/)

The beads workflows are unused. The extension mechanism (extension-registry,
drain-runtime, tool/command/skill contribution seams) stays and is now tested
exclusively against synthetic fixtures.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: Delete the bundled suite (workflows, commands, skill, tests, docs)

**Files:**
- Delete: `workflows/` (9 files, dir), `commands/` (2 files, dir), `skills/repo-review-command-protocol/`, the 30 suite tests (`tests/repo-bughunt.test.mjs`, `tests/repo-bughunt-command-assets.test.mjs`, `tests/repo-{cleanup,complexity,deps,modernize,perf,security-audit,test-gaps}.test.mjs`, all 21 `tests/repo-review-*.test.mjs`), `tests/helpers/repo-review-leaf-harness.mjs`, `docs/repo-review.md`, `docs/repo-review-leaf-contract.md`, `docs/repo-review-parity-matrix.md`
- Modify: `tests/publish-completeness.test.mjs`, `tests/workflow-docs.test.mjs`, `tests/fake-credential-scanner-safety.test.mjs`, `tests/extension-command-skill-registration.test.mjs:53-82`, `tests/workflow-run.test.mjs` (ux.1 zero-bundled assertion), `package.json` (description, files[], 19 scripts + `test:workflows`), `AGENTS.md:17`

**Interfaces:**
- Consumes: Task 1's config-repo copies (the suite survives there); Task 2's fixture-driven tests (unaffected by this deletion).
- Produces: a plugin repo with zero bundled workflows/commands; `pkg.files = ["opencode-workflows.js", "workflow-kernel/", "skills/", "docs/workflow-plugin.md", "README.md", "CONTRIBUTING.md", "CODE_OF_CONDUCT.md", "CHANGELOG.md", "SECURITY.md"]`.

- [ ] **Step 1: Delete the assets and suite tests**

```bash
git rm -r workflows commands skills/repo-review-command-protocol
git rm tests/repo-bughunt.test.mjs tests/repo-bughunt-command-assets.test.mjs \
       tests/repo-cleanup.test.mjs tests/repo-complexity.test.mjs tests/repo-deps.test.mjs \
       tests/repo-modernize.test.mjs tests/repo-perf.test.mjs tests/repo-security-audit.test.mjs \
       tests/repo-test-gaps.test.mjs tests/repo-review-*.test.mjs tests/helpers/repo-review-leaf-harness.mjs
git rm docs/repo-review.md docs/repo-review-leaf-contract.md docs/repo-review-parity-matrix.md
```

- [ ] **Step 2: `package.json`.** Set the description:
```json
"description": "opencode plugin providing durable, resumable multi-agent workflow orchestration: the architecture for building, running, and supervising workflows (no bundled workflows).",
```
Remove `"workflows/"` (line 18) and `"commands/"` (line 19) from `files[]`. Delete the 19 suite scripts (`test:repo-bughunt` … `test:repo-deps`, i.e. every `test:repo-*` key). Replace `test:workflows` (line 71) with:
```json
"test:workflows": "node --test tests/workflow-run.test.mjs tests/workflow-apply.test.mjs tests/model-tiering.test.mjs",
```

- [ ] **Step 3: Rewrite the bundled-asset tests in `tests/publish-completeness.test.mjs`.** Replace the command-existence test (lines 116-120) with:
```js
test("the plugin ships zero bundled workflows and zero bundled commands", () => {
  assert.equal(existsSync(new URL("workflows/", root)), false);
  assert.equal(existsSync(new URL("commands/", root)), false);
  assert.equal((pkg.files ?? []).includes("workflows/"), false);
  assert.equal((pkg.files ?? []).includes("commands/"), false);
});
```
In the tarball test, replace the `offenders` filter with:
```js
  const offenders = files.filter(
    (p) =>
      p.startsWith("workflow-domains/") ||
      p.startsWith("workflows/") ||
      p.startsWith("commands/") ||
      p.startsWith("skills/repo-review-command-protocol") ||
      p.startsWith("skills/beads-drain"),
  );
```
In the packed-docs test (line 166), change `const docs = ["README.md", "commands/repo-bughunt.md", "commands/repo-review.md"];` to `const docs = ["README.md"];`.

- [ ] **Step 4: Remaining surgical test edits.**
- `tests/workflow-docs.test.mjs`: remove `"commands/repo-bughunt.md"` and `"commands/repo-review.md"` from the `commandFiles` list (and any assertions that require a non-empty list — an empty command set is now correct).
- `tests/fake-credential-scanner-safety.test.mjs`: remove `tests/repo-review-secret-containment.test.mjs` and `docs/repo-review-leaf-contract.md` from `SCAN_TARGETS`.
- `tests/extension-command-skill-registration.test.mjs` lines 53-58, rewrite:
```js
test("no-extension call registers no commands but still pushes the bundled skill dir", async () => {
  const cfg = {};
  await configureWorkflowEntrypoints(cfg); // no second arg
  assert.equal(Object.keys(cfg.command ?? {}).length, 0, "pure-architecture plugin bundles no commands");
  assert.ok(Array.isArray(cfg.skills.paths) && cfg.skills.paths.length >= 1, "bundled skill dir still pushed");
});
```
Lines 60-82 (bundled skills test): delete the `repo-review-command-protocol` half (the `const protocol = ...` block and its five asserts); keep the `opencode-workflow-authoring` half; rename the test `"bundled workflow authoring skill ships in the skill dir"`.

- [ ] **Step 5: Add the zero-bundled invariant to the ux.1 test** rewritten in Task 2 (in `tests/workflow-run.test.mjs`, inside the try block after `const listed = ...`):
```js
    assert.deepEqual(listed.filter((e) => e.scope === "bundled"), [], "pure-architecture plugin bundles zero workflows");
```

- [ ] **Step 6: `AGENTS.md:17`** — replace:
```
- Nested workflow regression wrapper for `workflow_run`, `workflow_apply`, and repo-review workflows: `npm run test:workflows`.
```
with:
```
- Nested workflow regression wrapper for `workflow_run` and `workflow_apply`: `npm run test:workflows`.
```

- [ ] **Step 7: Run everything**

```bash
npm test 2>&1 | tail -5
grep -rln "repo-bughunt\|repo-review" tests/ workflow-kernel/ package.json AGENTS.md || echo CLEAN
```
Expected: 0 failures. Grep may still hit `README.md`/skills (handled in Task 7) and cosmetic toast fixtures — anything else must be fixed now.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat!: ship zero bundled workflows/commands — the plugin is pure architecture

The repo-* review suite now lives in the operator's global workflow registry
(adopted by the opencode-config repo). Discovery mechanisms (bundled tier,
command/skill registration) remain and tolerate the empty state.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 7: README and skills sweep

**Files:**
- Modify: `README.md` (§ Repo Review Suite lines 232-289 deleted; § Command And Skill Registration line ~136-145 reworded; § Documentation Map rows), `skills/workflow-model-tiering/SKILL.md:3`, `skills/workflow-plan-review/SKILL.md:49-53,81`, `workflow-kernel/audited-shell-policy.js:1-3`

- [ ] **Step 1: README.** Delete `## Repo Review Suite` (line 232 through the line before `## Sizing maxAgents` at ~line 290). Reword `## Command And Skill Registration`: the plugin registers no bundled commands; extensions and the operator's config contribute commands; the plugin's `skills/` dir (three authoring/operator skills) is registered. Documentation Map: drop the rows for `docs/repo-review.md`, `docs/repo-review-leaf-contract.md`, `docs/repo-review-parity-matrix.md`, and the `commands/*.md` reference in the operator-references row. Then sweep: `grep -n "repo-bughunt\|repo-review\|repo-\*" README.md` — rewrite or delete every remaining hit (e.g. `.repo-review/runs` mentions in Source-of-Truth sections become generic artifact-dir wording only if they name the deleted commands; the `.repo-review/` artifact convention itself may stay where it describes runtime behavior).
- [ ] **Step 2: Skills.** `workflow-model-tiering/SKILL.md:3`: change `(e.g. repo-bughunt)` to `(e.g. a review workflow whose finder lanes are fast-tier and verifier lanes deep-tier)`. `workflow-plan-review/SKILL.md:51-52`: replace the three named examples with `(e.g. paths/depth/categories for a review leaf, domains/batchSize for a meta-orchestrator, mode/scope for a drain workflow)`; line 81: `**Static fan-out** (repo-bughunt, repo-* leaves, repo-review)` → `**Static fan-out** (review leaves and meta-orchestrators)`.
- [ ] **Step 3: `workflow-kernel/audited-shell-policy.js:1-3`** — reword the header comment to describe the generic audited-shell policy without naming repo-review as its owner.
- [ ] **Step 3b (optional hygiene): toast test fixtures.** `tests/notification-toast.test.mjs`, `notification-toast-cards.test.mjs`, `notification-toast-policy.test.mjs` use `"repo-bughunt"` purely as an example `meta.name` string in synthetic fixtures (no file dependency). Rename the fixture strings to `"fixture-review"` so the final grep sweep runs clean.
- [ ] **Step 4: Run docs-parity + full suite, commit**

```bash
node --test tests/workflow-docs.test.mjs tests/publish-completeness.test.mjs && npm test 2>&1 | tail -3
git add -A && git commit -m "docs: purge suite references; kernel docs describe architecture only

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```
Expected: PASS.

---

### Task 8: CHANGELOG + final verification

**Files:**
- Modify: `CHANGELOG.md` (new entry at top; historical entries untouched)

- [ ] **Step 1: CHANGELOG entry** (below the header, above `[0.1.0]`):

```markdown
## [Unreleased]

### Changed
- **BREAKING:** the plugin ships zero bundled workflows and commands. The
  repo-* review suite (eight leaves + the repo-review meta, plus the
  /repo-bughunt and /repo-review commands and the repo-review-command-protocol
  skill) moved to the operator's global workflow registry. The bundled-tier
  discovery mechanism remains for downstream packagers.

### Removed
- The deprecated beads domain (`workflow-domains/`): beads-drain workflow,
  host drain adapter, review-materialize tool/command, beads-drain skill.
  The trusted-extension mechanism itself is unchanged and now tested against
  synthetic fixtures only.
```

- [ ] **Step 2: Full plugin verification**

```bash
npm test 2>&1 | tail -5                 # expect 0 fail
npm run release:no-token                # expect success end-to-end
npm pack --dry-run 2>&1 | tail -40      # expect ONLY: opencode-workflows.js, workflow-kernel/*, skills/{opencode-workflow-authoring,workflow-model-tiering,workflow-plan-review}/*, docs/workflow-plugin.md, README.md, CONTRIBUTING.md, CODE_OF_CONDUCT.md, CHANGELOG.md, SECURITY.md, LICENSE, package.json, .editorconfig, .github templates
grep -rn "beads\|workflow-domains\|repo-bughunt\|repo-review" --include="*.js" --include="*.mjs" --include="*.json" . --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=.opencode --exclude-dir=.beads --exclude-dir=.repo-review --exclude-dir=.remember --exclude-dir=.hermes-bughunt | grep -v "docs/superpowers" | grep -v CHANGELOG
```
Expected: the grep returns nothing (or only deliberate generic wording — judge each hit; `.repo-review` artifact-dir strings in `sandbox-executor.js`/`.gitignore` are intentional keepers).

- [ ] **Step 3: Commit + config-repo live smoke**

```bash
git add CHANGELOG.md && git commit -m "docs: changelog for the pure-architecture extraction

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```
Live smoke (needs an opencode restart to reload plugin config — coordinate with the user):
1. `workflow_list({format:"json"})` → the nine repo-* entries appear with `scope: "global"`; zero `scope: "bundled"` entries; no `beads-drain`.
2. `/repo-review` and `/repo-bughunt` appear in the command registry (from config-root `commands/`).
3. `workflow_run({name:"repo-bughunt"})` returns an approval preview whose `Source:` is `/home/hermes/code/opencode-config/workflows/repo-bughunt.js` and authority profile `read-only-review`. Do NOT approve the run — the preview is the zero-token proof.

- [ ] **Step 4: Follow-ups (record, do not execute here):** update the `opencode-workflows-harness-extraction` memory (superseded: repo-* is not a product; beads deleted, not externalized); triage pre-OSS epic 5uqd for mooted beads/ext-trust beads; consider `superpowers:finishing-a-development-branch` for the plugin branch merge.

---

## Task-order rationale (for reviewers)

1. Config repo adopts first (additive, zero risk) → the suite is never homeless.
2. Fixture rewires (Tasks 2-4) are presence-agnostic — green before AND after deletions.
3. Beads deletion (Task 5) precedes suite deletion (Task 6). Two suite tests (`repo-review-artifacts`, `repo-review-no-mutation`) import from `workflow-domains/`, so they are deleted early, in Task 5 Step 7 (Task 6's `tests/repo-review-*.test.mjs` glob then simply matches two fewer files).
4. Docs last: parity tests were already retargeted, so pure-prose edits can't break the build.
