# Agent-Surface Docs Accuracy Implementation Plan

> Status: Active plan (2026-07-08). Fixes all findings from the 2026-07-08 agent-surface review (groups A–D).

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every agent-facing instructional surface of the plugin (tool descriptions, arg schemas, bundled skills, shipped docs, runtime-injected strings) accurate and comprehensive, per the 2026-07-08 four-lane review.

**Architecture:** Almost entirely text-level edits to existing files, gated by the existing `node:test` suite. Three deliberate behavior-adjacent changes: (1) `workflow_status` drops its always-rejected `reconcile` schema arg, (2) `workflow_cleanup` gains an `interruptedTtlMs` schema arg (the handler already reads it), (3) child lanes gain a one-line authority disclosure in their system prompt via a new pure helper `laneAuthorityInstruction()`.

**Tech Stack:** Node ESM, `node --test`, no new dependencies.

## Global Constraints

- All work happens in `/home/hermes/code/opencode-config/plugins/opencode-workflows` on branch `agent-surface-docs-accuracy` (created off `main` in Task 1). **NEVER run `git add`/`git commit` in `/home/hermes/code/opencode-config` (the outer config repo) — it deliberately has no git history.**
- After every task: `node --test tests/*.test.mjs` must end with `# fail 0` (baseline: 653 passing; Tasks 3–5 add assertions/tests so the pass count grows).
- Every markdown file under `docs/` must either carry a `> Status:` banner near the top or be listed in README.md's Documentation Map — `tests/workflow-docs.test.mjs` enforces this.
- Tool `description` strings stay single-line; per-argument documentation uses `.describe("...")` (existing house style, see `workflow_apply` at `workflow-kernel/workflow-plugin.js:2851-2864`).
- Do not reword any text this plan does not name. Historical docs (CHANGELOG history, `docs/superpowers/` specs/plans other than the README map rows named in Task 7) are untouched.
- Commit messages use the repo's conventional style (`fix:`, `feat:`, `docs:`) and end with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

---

### Task 1: Salvage-candidate hint points at `workflow_salvage`, not the foreign `session_read` tool

The hint at `workflow-kernel/run-store-projections.js:388` tells agents to call `session_read(...)` — a tool this plugin does not ship (its own comment at `workflow-kernel/workflow-plugin.js:2130-2134` says so). The real in-plugin recovery tool is `workflow_salvage`.

**Files:**
- Modify: `workflow-kernel/run-store-projections.js:385-390`
- Test: `tests/run-store-status-salvage.test.mjs:80,167,244,253`

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: `salvageCandidates[].hint` string format `salvage via workflow_salvage runId=<runId> (preview first); raw child transcript childID=<childID>` — Task 8's grep sweep relies on `session_read` being gone.

- [ ] **Step 1: Create the branch**

```bash
cd /home/hermes/code/opencode-config/plugins/opencode-workflows
git checkout -b agent-surface-docs-accuracy main
```

- [ ] **Step 2: Update the four test pins to expect the new hint (failing first)**

In `tests/run-store-status-salvage.test.mjs`, the orphan fixture's childID is `child-session-orphan`. Replace the four assertions:

Line 80 (and the structurally identical line 167):
```js
// OLD
assert.match(candidates[0].hint, /session_read\(\{ sessionId: "child-session-orphan" \}\)/);
// NEW
assert.match(candidates[0].hint, /workflow_salvage runId=/);
assert.match(candidates[0].hint, /childID=child-session-orphan/);
```

Line 244:
```js
// OLD
assert.match(compact.salvageCandidates[0].hint, /session_read/);
// NEW
assert.match(compact.salvageCandidates[0].hint, /workflow_salvage/);
```

Line 253:
```js
// OLD
assert.match(summary, /session_read\(\{ sessionId: "child-session-orphan" \}\)/);
// NEW
assert.match(summary, /workflow_salvage runId=/);
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `node --test tests/run-store-status-salvage.test.mjs`
Expected: FAIL — the assertions matching `workflow_salvage` do not match the current `session_read` hint.

- [ ] **Step 4: Change the hint**

In `workflow-kernel/run-store-projections.js`, the candidate is built inside a function that has the run's id in scope — confirm the enclosing function's parameters (it receives the run dir/entry context; if the run id is not directly in scope, use the literal text `runId=<this run>` form below, which the tests above still match). Replace:

```js
// OLD
      hint: `possible transcript evidence: session_read({ sessionId: "${childID}" })`,
// NEW
      hint: `salvage via workflow_salvage runId=<this run> (preview first); raw child transcript childID=${childID}`,
```

If the enclosing scope has the actual run id available (check the signature of `computeSalvageCandidates` and its callers in `run-store-projections.js`), interpolate it instead of `<this run>`:
```js
      hint: `salvage via workflow_salvage runId=${runId} (preview first); raw child transcript childID=${childID}`,
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `node --test tests/run-store-status-salvage.test.mjs`
Expected: PASS, `# fail 0`.

- [ ] **Step 6: Full suite, then commit**

```bash
node --test tests/*.test.mjs
git add workflow-kernel/run-store-projections.js tests/run-store-status-salvage.test.mjs
git commit -m "fix: salvage-candidate hint points at workflow_salvage, not the unshipped session_read

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: Toast inspect line uses the `runId=` convention

`workflow-kernel/notification-toast-cards.js:363` renders `inspect: workflow_status ${id}`; every other next-step string in the codebase uses `workflow_status runId=${id}` (see `run-store-status-format.js` nextActions).

**Files:**
- Modify: `workflow-kernel/notification-toast-cards.js:361-366`
- Test: `tests/notification-toast-cards.test.mjs:95,120,136`

**Interfaces:**
- Consumes: nothing. Produces: nothing other tasks rely on.
- Note: the regex assertions in `tests/workflow-run.test.mjs:137,4823,4847` use `/inspect: workflow_status/` which still matches — do not touch them.

- [ ] **Step 1: Update the three exact-string pins (failing first)**

In `tests/notification-toast-cards.test.mjs` lines 95, 120, 136, replace each:
```js
// OLD
    "inspect: workflow_status wf_x1",
// NEW
    "inspect: workflow_status runId=wf_x1",
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test tests/notification-toast-cards.test.mjs`
Expected: FAIL on the three updated pins.

- [ ] **Step 3: Change `inspectLines`**

In `workflow-kernel/notification-toast-cards.js:361-366`:
```js
// OLD
function inspectLines(snapshot) {
  const id = String(snapshot.id ?? "");
  const oneLine = `inspect: workflow_status ${id}`;
  if (oneLine.length <= CARD_LINE_MAX) return [oneLine];
  return ["inspect: workflow_status", `  ${id}`];
}
// NEW
function inspectLines(snapshot) {
  const id = String(snapshot.id ?? "");
  const oneLine = `inspect: workflow_status runId=${id}`;
  if (oneLine.length <= CARD_LINE_MAX) return [oneLine];
  return ["inspect: workflow_status", `  runId=${id}`];
}
```

If other pins in `tests/notification-toast-cards.test.mjs` assert the two-line overflow form (search the file for `"  wf_` and `inspect:`), update them to the `  runId=` form too.

- [ ] **Step 4: Run to verify pass, full suite, commit**

```bash
node --test tests/notification-toast-cards.test.mjs
node --test tests/*.test.mjs
git add workflow-kernel/notification-toast-cards.js tests/notification-toast-cards.test.mjs
git commit -m "fix: toast inspect line uses the runId= convention

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Tool-schema accuracy — `workflow_status` dead arg, `workflow_apply` fictional cross-reference, `workflow_cleanup` protection wording + `interruptedTtlMs`

Three verified accuracy defects in `workflow-kernel/workflow-plugin.js`:
1. `workflow_status` schema exposes `reconcile` (line 2751 area), but `statusText(context, args)` is called with no `optionsOverride`, so `run-store-status-format.js:962` unconditionally throws when it is set. The arg can never succeed.
2. `workflow_apply`'s description (line 2852) cites "workflow_run apply-preview" — no such thing exists; `workflow_run`'s terminal message surfaces only the diff plan hash.
3. `workflow_cleanup`'s description understates the protected set (`cleanupProtectionReason`, `run-store-status-format.js:893-921`, protects locked / active-in-process / pinned / active-status / ambiguous-edit / interrupted-within-TTL / paused-resumable / resumable failed+budget_stopped / retryable-apply-failed), and the handler reads `args.interruptedTtlMs` (`run-store-status-format.js:1053`, default `INTERRUPTED_RUN_TTL_MS = 7 * 24 * 60 * 60 * 1000` at line 339) that the schema never declares. A test already exercises it end-to-end (`tests/workflow-run.test.mjs:4587`).

**Files:**
- Modify: `workflow-kernel/workflow-plugin.js:2740-2753` (workflow_status), `:2841-2850` (workflow_cleanup), `:2851-2852` (workflow_apply description)
- Test: `tests/workflow-run.test.mjs:2141-2169` (test "public workflow tool schemas describe non-obvious arguments")

**Interfaces:**
- Consumes: nothing.
- Produces: `workflow_cleanup` schema field `interruptedTtlMs` (positive int, optional). Task 7's doc-table row mentions it.

- [ ] **Step 1: Extend the schema test (failing first)**

In `tests/workflow-run.test.mjs`, inside the test `"public workflow tool schemas describe non-obvious arguments"` (starts line 2141):

(a) Change the `workflow_cleanup` entry in the `Object.entries({...})` map:
```js
// OLD
      workflow_cleanup: ["dryRun", "keep"],
// NEW
      workflow_cleanup: ["dryRun", "keep", "interruptedTtlMs"],
```

(b) After the existing two `assert.match(tools.workflow_apply.description, ...)` lines (2146-2147), add:
```js
    assert.ok(
      !/apply-preview/.test(tools.workflow_apply.description),
      "workflow_apply must not cite the nonexistent workflow_run apply-preview",
    );
    assert.ok(
      !("reconcile" in tools.workflow_status.args),
      "workflow_status must not expose the always-rejected reconcile arg",
    );
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test tests/workflow-run.test.mjs 2>&1 | grep -A 3 "non-obvious"`
Expected: FAIL (missing `interruptedTtlMs` describe, `apply-preview` present, `reconcile` present).

- [ ] **Step 3: Apply the three edits in `workflow-kernel/workflow-plugin.js`**

(a) `workflow_status` (2740-2753) — new description and delete the `reconcile` schema line:
```js
// OLD description
      description: "Show recent workflow runs or one workflow run state.",
// NEW description
      description: "Show recent workflow runs or one workflow run state. Read-only; for stale-run recovery use workflow_reconcile.",
```
```js
// DELETE this line from the args object:
        reconcile: tool.schema.boolean().optional(),
```
Do NOT touch the throw in `run-store-status-format.js:962` — it stays as defense-in-depth (a test at `tests/workflow-run.test.mjs:4674` calls `execute({ ..., reconcile: true })` directly and asserts the rejection; direct execute bypasses the schema, so that test still passes).

(b) `workflow_apply` description (2852):
```js
// NEW (single line)
      description: "Apply an awaiting workflow diff plan to the primary tree after explicit hash-gated approval. Use hash fields copied from a prior workflow_status({detail:\"full\"}) for the same run — workflow_run's own terminal message surfaces only the diff plan hash, not the full apply hash set; stale or missing hashes fail closed with a structured workflow_apply_approval_mismatch payload.",
```

(c) `workflow_cleanup` (2841-2850) — new description plus new schema field:
```js
// NEW description (single line)
      description: "Dry-run or apply workflow run retention cleanup. Always preserves locked, active, pinned, corrupt/ambiguous-edit, and resumable runs (paused, failed, budget_stopped, retryable apply-failed); interrupted runs are preserved until a recovery TTL elapses.",
```
```js
// ADD after the existing keep field:
        interruptedTtlMs: tool.schema.number().int().positive().optional().describe("Override the interrupted-run protection TTL in milliseconds (default 604800000 = 7 days); interrupted runs older than this become eligible for deletion."),
```
Also update `keep`'s existing `.describe()` to state the default:
```js
// OLD
.describe("Number of newest completed terminal runs to preserve; active, corrupt, ambiguous edit, and pinned runs are always preserved.")
// NEW
.describe("Number of newest completed terminal runs to preserve (default 30); active, corrupt, ambiguous edit, and pinned runs are always preserved.")
```
Before committing, verify the default: `grep -n "DEFAULT_KEEP_RUNS" workflow-kernel/*.js` — if the constant's value is not 30, use the actual value in the describe text.

- [ ] **Step 4: Run to verify pass, full suite, commit**

```bash
node --test tests/workflow-run.test.mjs
node --test tests/*.test.mjs
git add workflow-kernel/workflow-plugin.js tests/workflow-run.test.mjs
git commit -m "fix: tool-schema accuracy — drop dead workflow_status reconcile arg, correct workflow_apply hash-source claim, real workflow_cleanup protection set + interruptedTtlMs

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: Tool-schema comprehensiveness — `workflow_run`/`workflow_save` per-arg docs, save contract, drop "v2" jargon

`workflow_run` (~30 args) and `workflow_save` carry zero `.describe()` calls; `workflow_save`'s description omits the script contract; "v2" template jargon is defined nowhere.

**Files:**
- Modify: `workflow-kernel/workflow-plugin.js:2692-2739` (workflow_run), `:2740-2752` (workflow_status `detail`), `:2810-2818` (workflow_save), `:2904` and `:2915` (template tool descriptions)
- Modify: `workflow-kernel/role-template-loading.js:105-106` (template meta descriptions)
- Test: `tests/workflow-run.test.mjs:2141-2169`

**Interfaces:**
- Consumes: Task 3's edits to the same test (apply Task 4 after Task 3 to avoid merge friction).
- Produces: nothing downstream.

- [ ] **Step 1: Extend the schema test (failing first)**

In the same `"public workflow tool schemas describe non-obvious arguments"` test, add two entries to the `Object.entries({...})` map:
```js
      workflow_run: ["profile", "authority", "autoApprove", "background", "maxCost", "maxTokens", "maxRuntimeMs", "resumeRunId", "resumePolicy", "editAndResume"],
      workflow_save: ["name", "source", "scope", "globalScopeIntent", "overwrite"],
```
And after the loop, add:
```js
    assert.ok(
      !/\bv2\b/i.test(tools.workflow_templates.description) && !/\bv2\b/i.test(tools.workflow_template_save.description),
      "template tool descriptions must not use undefined v2 jargon",
    );
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test tests/workflow-run.test.mjs 2>&1 | grep -B 1 -A 3 "non-obvious"`
Expected: FAIL (workflow_run/workflow_save fields lack descriptions; "v2" present).

- [ ] **Step 3: Verify semantics before writing describe text**

The describe strings below make behavioral claims. Verify each against code before applying; adjust wording ONLY if the code contradicts it, and note any adjustment in the task report:
- `resumePolicy`: `grep -n "extend-deadline\|resumePolicy" workflow-kernel/workflow-plugin.js` — confirm it extends/refreshes the run deadline on resume.
- `editAndResume`: confirm at `workflow-plugin.js:397-428` (`assertResumableState` area) that it permits changed source on resume and re-keys the approval envelope.
- `background` heuristic: confirm the wide/deep/long default-to-background behavior (grep `wide` / `background` near `startWorkflow`).
- `budget_stopped`: `grep -n "budget_stopped" workflow-kernel/*.js` — confirm it is the status used when `maxCost`/`maxTokens` ceilings trip.

- [ ] **Step 4: Add `.describe()` to `workflow_run` args (workflow-plugin.js:2695-2735)**

Append `.describe(...)` to each of these existing schema lines (keep every zod chain otherwise identical; the inline comments above `args:` and `authority:` stay):

```js
        name: tool.schema.string().optional().describe("Saved workflow name, resolved project > global > extension > bundled."),
        source: tool.schema.string().optional().describe("Inline workflow source: export const meta = {...} plus top-level statements ending in return."),
        approve: tool.schema.boolean().optional().describe("Omit or false to get the approval preview; true executes when approvalHash matches the preview."),
        approvalHash: tool.schema.string().optional().describe("Hash returned by the immediately prior preview for this exact envelope; any envelope change re-keys it."),
        autoApprove: tool.schema.enum(["readOnly", "worktree", "all"]).optional().describe("Narrow the plugin-configured autoApprove ceiling for this call (readOnly < worktree < all); it can never widen the configured ceiling."),
        resumeRunId: tool.schema.string().optional().describe("Resume a prior resumable run by id; unchanged lanes replay as zero-spend cache hits from the persisted journal."),
        resumePolicy: tool.schema.enum(["extend-deadline"]).optional().describe("Resume-only: extend-deadline grants the resumed run a fresh runtime deadline instead of keeping the original."),
        editAndResume: tool.schema.boolean().optional().describe("Resume-only opt-in to resume with changed workflow source; re-keys sourceHash/approvalHash so a fresh approval is required, while unchanged lanes still cache-hit."),
        profile: tool.schema.enum(Object.keys(WORKFLOW_AUTHORITY_PROFILES)).optional().describe("Named authority preset: read-only-review, inspect-with-shell, drain-dry-run, drain-autonomous-local, edit-plan-only, or apply-approved-plan. Omitted resolves to the ad-hoc profile driven by meta/args authority flags."),
        background: tool.schema.boolean().optional().describe("true returns a runId immediately while execution continues in-process; false forces foreground; omitted defers to the wide/deep/long heuristic."),
        authority: tool.schema.object({}).passthrough().optional().describe("Ad-hoc authority flag object (readOnly, shell, edit, worktreeEdit, network, mcp, integration); the resolved authority is shown in the approval preview."),
        maxCost: tool.schema.number().nonnegative().optional().describe("Run-level cost ceiling in USD across all lanes; exceeding it stops the run resumably as budget_stopped. Part of the approved envelope."),
        maxTokens: tool.schema.number().int().nonnegative().optional().describe("Run-level token ceiling across all lanes; exceeding it stops the run resumably as budget_stopped. Part of the approved envelope."),
        maxRuntimeMs: tool.schema.number().int().positive().max(24 * 60 * 60 * 1000).optional().describe("Run-level wall-clock deadline; distinct from laneTimeoutMs, which bounds one child prompt."),
```
Leave `scriptPath`, `allowExternalScriptPath`, `includeSourceSnippet`, `sourceSnippetMaxChars`, `args`, `maxAgents`, `concurrency`, `laneTimeoutMs`, `childPromptTimeoutMs`, `childModel`, `modelTiers`, `debugCapture`, `baseCommit`, `guestDeadlineMs` bare — they are either self-evident or covered by the main description; do not invent semantics for them.

- [ ] **Step 5: `workflow_status` `detail` describe**

```js
        detail: tool.schema.enum(["compact", "full", "result"]).optional().describe("compact (default) for summaries; full for complete state including the workflow_apply hash fields; result for the final result payload (requires runId)."),
```

- [ ] **Step 6: `workflow_save` description + arg describes (2810-2818)**

```js
// NEW description (single line)
      description: "Save a reusable workflow script (export const meta = {...} plus top-level statements ending in return; no imports, no export default) to the project workflow directory by default, or globally with the explicit globalScopeIntent opt-in. See the opencode-workflow-authoring skill for the full authoring contract.",
```
```js
        name: tool.schema.string().describe("Saved workflow slug; becomes <name>.js in the destination workflow directory."),
        source: tool.schema.string().describe("Full workflow source; parsed and validated before writing — invalid shape fails the save."),
        scope: tool.schema.enum(["global", "project"]).optional().describe("Destination workflow directory; omitted defaults to project (<root>/.opencode/workflows)."),
        globalScopeIntent: tool.schema.literal("save-global-workflow").optional().describe("Required with scope:\"global\": the literal string confirms writing into the shared global workflow directory."),
        overwrite: tool.schema.boolean().optional().describe("Set true to replace an existing saved workflow with the same name."),
```

- [ ] **Step 7: Drop "v2" jargon**

`workflow-kernel/workflow-plugin.js`:
```js
// 2904 OLD
      description: "List shipped v2 workflow templates without writing files; pass includeSource=true to retrieve source bodies explicitly.",
// 2904 NEW
      description: "List shipped starter workflow templates without writing files; pass includeSource=true to retrieve source bodies explicitly.",
// 2915 OLD
      description: "Save a shipped v2 workflow template to project or global workflows.",
// 2915 NEW
      description: "Save a shipped starter workflow template to project or global workflows.",
```
`workflow-kernel/role-template-loading.js` (inside the template source strings at lines 105-106):
```js
// OLD: description: \"V2 scoped-helper parallel template\"
// NEW: description: \"Scoped-helper parallel starter template\"
// OLD: description: "V2 edit/apply template"
// NEW: description: "Schema-gated edit/apply starter template"
```
(Keep the rest of both template bodies byte-identical.)

- [ ] **Step 8: Run to verify pass, full suite, commit**

```bash
node --test tests/workflow-run.test.mjs
node --test tests/*.test.mjs
git add workflow-kernel/workflow-plugin.js workflow-kernel/role-template-loading.js tests/workflow-run.test.mjs
git commit -m "docs: per-arg schema docs for workflow_run/workflow_save/workflow_status, save contract in description, drop undefined v2 jargon

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: Child lanes learn their authority ceiling in their system prompt

Today the lane system prompt (`workflow-kernel/child-agent-runner.js:646-655`) never mentions authority; a read-only lane discovers it cannot edit or run shell only via platform permission denial. The lane policy is already computed in the same function (`resolveLanePolicy` at line 656, exposed as `policy.authority` at line 672) — it is just resolved AFTER the prompt is built. Add a pure helper and reorder.

**Known side effect:** `baseSystem` feeds `resolved.system`, which feeds `laneSignature` (line 680). Changing the prompt changes lane signatures, so resumed runs created BEFORE this change will not cache-hit their old lanes. That is acceptable (signatures are recomputed consistently within any one binary version) — but verify no test pins a hard-coded signature: `grep -rn "laneSignature" tests/*.mjs` and inspect any literal-hash assertions.

**Files:**
- Modify: `workflow-kernel/authority-policy.js` (new exported helper, add near `authorityAutoApproveTier` ~line 40)
- Modify: `workflow-kernel/child-agent-runner.js:646-656` (reorder + inject line), import block ending line 86
- Test: `tests/child-agent-runner.test.mjs`

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: `laneAuthorityInstruction(authority?: object): string` exported from `workflow-kernel/authority-policy.js`. Signature: takes the lane's resolved `policy.authority` flag object; returns a single-line instruction starting `Lane authority: `.

- [ ] **Step 1: Write failing unit tests**

Append to `tests/child-agent-runner.test.mjs` (it already imports from the kernel; add `laneAuthorityInstruction` to an import from `../workflow-kernel/authority-policy.js`, creating that import if absent):

```js
test("laneAuthorityInstruction renders grants and denials from authority flags", () => {
  assert.equal(
    laneAuthorityInstruction({ readOnly: true }),
    "Lane authority: read/search only. Not permitted: edit, shell, network, mcp — such tool calls are denied by policy; do not retry them.",
  );
  assert.match(
    laneAuthorityInstruction({ edit: true, shell: true, network: true, mcp: true, integration: true }),
    /read\/search plus edit, shell, network, mcp, integration/,
  );
  assert.match(laneAuthorityInstruction({ worktreeEdit: true }), /worktree edit \(isolated worktree only\)/);
  assert.match(laneAuthorityInstruction(undefined), /read\/search only/);
});

test("child lane system prompt discloses the lane's resolved authority ceiling", async () => {
  const { root, dir } = await tempRunDir("child-agent-authority-line");
  const calls = { create: [], prompt: [], abort: [] };
  const pluginContext = directPluginContext(async () => ({
    data: {
      parts: [{ type: "text", text: "ok" }],
      info: { tokens: { input: 1, output: 1, reasoning: 0 }, cost: 0 },
    },
  }), calls);
  const toolContext = { directory: root, sessionID: "parent-session", abort: new AbortController().signal };
  const run = minimalChildRun(dir);
  try {
    await runChildAgent(pluginContext, toolContext, run, {
      callId: "lane:authority-line",
      prompt: "inspect",
      opts: {},
    }, directDeps());
    assert.match(calls.prompt[0].body.system, /Lane authority: read\/search only\./);
    assert.match(calls.prompt[0].body.system, /Not permitted: edit, shell, network, mcp/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
```
(Model the harness usage on the existing test "runChildAgent applies roles.json defaults before model, timeout, prompt, and policy resolution" at `tests/child-agent-runner.test.mjs:338` — same `tempRunDir`/`directPluginContext`/`minimalChildRun`/`directDeps` helpers.)

- [ ] **Step 2: Run to verify failure**

Run: `node --test tests/child-agent-runner.test.mjs`
Expected: FAIL — `laneAuthorityInstruction` is not exported.

- [ ] **Step 3: Implement the helper in `workflow-kernel/authority-policy.js`**

```js
// Rendered into every child lane's system prompt so a lane knows its tool
// ceiling up front instead of discovering it through permission denials.
export function laneAuthorityInstruction(authority = {}) {
  const granted = [];
  const denied = [];
  if (authority.edit) granted.push("edit");
  else if (authority.worktreeEdit) granted.push("worktree edit (isolated worktree only)");
  else denied.push("edit");
  if (authority.shell) granted.push("shell");
  else denied.push("shell");
  if (authority.network) granted.push("network");
  else denied.push("network");
  if (authority.mcp) granted.push("mcp");
  else denied.push("mcp");
  if (authority.integration) granted.push("integration");
  const grantText = granted.length ? `read/search plus ${granted.join(", ")}` : "read/search only";
  const denyText = denied.length
    ? ` Not permitted: ${denied.join(", ")} — such tool calls are denied by policy; do not retry them.`
    : "";
  return `Lane authority: ${grantText}.${denyText}`;
}
```

- [ ] **Step 4: Wire it into the lane prompt in `workflow-kernel/child-agent-runner.js`**

(a) Add `laneAuthorityInstruction` to the existing `from "./authority-policy.js"` import list (ends at line 86).

(b) Move the policy resolution ABOVE the prompt construction and inject the line. The block at lines 645-656 becomes:
```js
    const useStructuredTextFallback = Boolean(schema);
    policy = resolveLanePolicy(run, opts);
    baseSystem = [
      "You are a child worker for an OpenCode workflow.",
      "Your final response is consumed as the workflow return value.",
      "Be concise and return raw findings/results, not a conversational status update.",
      laneAuthorityInstruction(policy.authority),
      roleInfo ? `Role ${roleInfo.name}:\n${roleInfo.content}` : "",
      opts.system || "",
      useStructuredTextFallback ? structuredTextInstruction(schema) : "",
    ]
      .filter(Boolean)
      .join("\n\n");
    outputFormat = { type: "text" };
```
(i.e., delete the old standalone `policy = resolveLanePolicy(run, opts);` line that sat between `baseSystem` and `outputFormat`; nothing between the old and new positions reads `policy`.)

- [ ] **Step 5: Run to verify pass**

Run: `node --test tests/child-agent-runner.test.mjs`
Expected: PASS. If the integration assertion fails because `policy.authority` for the minimal run carries different flags than expected, inspect `resolveLanePolicy`'s return for the minimal run and fix the TEST expectation (not the helper) to the actual resolved flags — then confirm the rendered line is still truthful.

- [ ] **Step 6: Full suite (watch for lane-signature-sensitive tests), commit**

```bash
node --test tests/*.test.mjs
```
Expected: `# fail 0`. If a resume/cache test fails on signature mismatch, it means the test pinned a pre-change signature constant — update that fixture, noting it in the report.

```bash
git add workflow-kernel/authority-policy.js workflow-kernel/child-agent-runner.js tests/child-agent-runner.test.mjs
git commit -m "feat: child lane system prompt discloses the lane's resolved authority ceiling

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: Bundled skills — accuracy fixes and authoring-contract completeness

All edits are to the three `skills/*/SKILL.md` files. No unit test pins this prose; the gate is the full suite (skill-registration and credential-scanner tests read these files) plus careful diff review.

**Files:**
- Modify: `skills/opencode-workflow-authoring/SKILL.md`
- Modify: `skills/workflow-model-tiering/SKILL.md`

**Interfaces:** none.

- [ ] **Step 1: `skills/workflow-model-tiering/SKILL.md` — two accuracy fixes**

(a) Lines 10-12 — delete the fabricated constant (no `DEFAULT_CHILD_MODEL` exists anywhere in the kernel; the real chain at `workflow-plugin.js:1688` is `args.childModel || meta.childModel || meta.defaultChildModel || sessionModel.model`):
```markdown
<!-- OLD -->
concrete `provider/model` string from the run's `modelTiers` map, falling back to the
invoking session's model (and finally to `DEFAULT_CHILD_MODEL`). Your job before running
<!-- NEW -->
concrete `provider/model` string from the run's `modelTiers` map, falling back to the
workflow's `meta.childModel` / `meta.defaultChildModel` and finally to the invoking
session's model. Your job before running
```

(b) Lines 56-57 — the validator (`authority-policy.js:112-113`) splits on the FIRST slash and only rejects missing/leading/trailing slashes:
```markdown
<!-- OLD -->
- Models are `provider/model` strings (exactly one `/`). A malformed tier value is a hard
  error at planning time.
<!-- NEW -->
- Models are `provider/model` strings — at least one `/`, not leading or trailing (the
  first `/` splits provider from model id). A malformed tier value is a hard error at
  planning time.
```

- [ ] **Step 2: `skills/opencode-workflow-authoring/SKILL.md` — complete the globals list (lines 55-56)**

```markdown
<!-- OLD -->
Injected globals are `agent`, `parallel`, `pipeline`, `workflow`, `phase`,
`log`, `budget`, and `args`; do not import them.
<!-- NEW -->
Injected globals are `agent`, `parallel`, `pipeline`, `workflow`, `drain`,
`phase`, `log`, `budget`, `persistArtifacts`, `inventoryFiles`, and `args`;
do not import them.
```

- [ ] **Step 3: Fix the sandbox stub wording (lines 60-64)**

Only `Date`/`Date.now`/`Math.random` are throwing stubs; `performance`, `crypto`, and the timer functions are plain `undefined` (`sandbox-executor.js:798-806`):
```markdown
<!-- OLD -->
The body runs in a deterministic QuickJS sandbox, not Node. Filesystem, process,
network, clocks, timers, randomness, `crypto`, and imports are unavailable.
`Date`, `Date.now`, `Math.random`, `performance`, `setTimeout`, `setInterval`,
`clearTimeout`, and `clearInterval` throw if called. Use `workflow_status` run
artifacts for timing and diagnostics instead of in-guest clocks.
<!-- NEW -->
The body runs in a deterministic QuickJS sandbox, not Node. Filesystem, process,
network, clocks, timers, randomness, `crypto`, and imports are unavailable.
`Date`, `Date.now`, and `Math.random` are stubbed to throw on any call;
`performance`, `crypto`, `setTimeout`, `setInterval`, `clearTimeout`, and
`clearInterval` are `undefined`, so any use fails immediately. Use
`workflow_status` run artifacts for timing and diagnostics instead of in-guest
clocks.
```

- [ ] **Step 4: Add "Meta Fields" and "Authority Profiles" sections**

Insert BOTH sections immediately after the "Source Shape" section (i.e., after the globals paragraph edited in Step 2, before "## QuickJS Sandbox"). Before writing, verify the two starred claims with the greps given inline; adjust only if the code contradicts them.

```markdown
## Meta Fields

Beyond `name`/`description`, the kernel reads these `meta` fields:

- `profile` or `authority` — named authority preset or ad-hoc flags (see
  Authority Profiles below).
- `argsSchema` — a JSON Schema validated (Ajv) against runtime `args` before
  authority resolution; a mismatch rejects the call before any lane launches.
  Declare it whenever the workflow reads `args`.
- `maxAgents`, `concurrency`, `maxCost`, `maxTokens`, `maxRuntimeMs`,
  `guestDeadlineMs` — author-set default ceilings; `workflow_run` args
  override them per call.
- `childModel` / `defaultChildModel` — workflow-level model default: below
  `args.childModel`, above the invoking session's model.
- `harness: "drain"` — opts into the drain harness and its `drain-dry-run` /
  `drain-autonomous-local` profiles.
- `phases` — declared phase names surfaced in previews and `workflow_status`.
- `category`, `examples`, `notes` — cosmetic; surfaced by `workflow_list`.

## Authority Profiles

`meta.profile` / `workflow_run({ profile })` accepts: `read-only-review`
(readOnly), `inspect-with-shell` (readOnly + audited shell), `drain-dry-run`
(readOnly; drain harness), `drain-autonomous-local` (integration, no
network/mcp; drain harness), `edit-plan-only` (worktreeEdit — isolated
worktree, stops at the diff plan), and `apply-approved-plan` (edit). Omitting
`profile` resolves to `ad-hoc`, which takes flags (`readOnly`, `shell`,
`edit`, `worktreeEdit`, `network`, `mcp`, `integration`) directly from
`meta.authority` / `args.authority`. Prefer `read-only-review` until the task
truly needs more.
```
Verification greps: (*) `argsSchema` enforcement — `grep -n "argsSchema" workflow-kernel/workflow-plugin.js` (expect Ajv validation near line 1611 rejecting before authority resolution); (*) `phases` surfacing — `grep -n "phasesText\|meta.phases" workflow-kernel/*.js`.

- [ ] **Step 5: Add "Artifacts, Inventory, And Drain" section**

Insert immediately after the "## Budgets And Scaling" section. Verify payload keys first: `sed -n '425,470p' workflow-kernel/sandbox-executor.js` for `persistArtifacts` and the `inventoryFiles` host handler near `sandbox-executor.js:737` — adjust key names below only if the code differs.

```markdown
## Artifacts, Inventory, And Drain

A workflow's return value is size-capped. Spill large findings with
`persistArtifacts({ namespace, files: [{ name, content }] })` — `.json`,
`.jsonl`, or `.md` file names only — and return a summary that references
them; artifacts land under the run's private `artifacts/<namespace>/`
directory. Use `inventoryFiles(...)` for a deterministic, sorted file
inventory with bounded shards instead of spending an agent lane on "explore
the repo with tools." `drain(...)` is the host-owned primitive behind
autonomous drain harnesses (`meta.harness: "drain"` with the drain
profiles); the drain loop's lane execution is host-controlled and cannot be
redefined from workflow source.
```

- [ ] **Step 6: Rewrite the stale trusted-source sentence (lines 162-165)**

`BUNDLED_WORKFLOW_DIR` no longer exists on disk (zero bundled workflows ship), so "core-bundled" is a dead trust path:
```markdown
<!-- OLD -->
Primary-tree writes happen through `workflow_apply`
after source/base/diff/domain hashes and Git state are checked. A successful
non-dry drain workflow from a trusted source (core-bundled or
extension-registered, with `supportsAutoApply: true`) is the one path that can
finalize in-run after its launch approval.
<!-- NEW -->
Primary-tree writes happen through `workflow_apply`
after source/base/diff/domain hashes and Git state are checked. The one path
that can finalize in-run after its launch approval is a successful non-dry
drain workflow from a trusted source: a host-configured extension workflow
directory whose registered drain adapter declares `supportsAutoApply: true`.
The plugin ships zero bundled workflows, so project- and global-saved
workflows always stop at `awaiting-diff-approval` and finalize through
`workflow_apply`.
```

- [ ] **Step 7: Cover resume and the recovery tools**

(a) Append to the "## Launch And Readback" section:
```markdown
Resuming with `resumeRunId` re-validates the persisted run's `sourceHash`; a
changed body is rejected unless `editAndResume: true` is set, which re-keys
`sourceHash` and `approvalHash` (fresh approval required) while unchanged
lanes still replay as zero-spend cache hits.
```

(b) Append to the "## Background Runs" section (after the sentence ending "...for inspection and lifecycle control."):
```markdown
`workflow_kill` force-terminates a wedged run when cancel/pause do not
return; `workflow_events` pages the redacted lifecycle event log; and
`workflow_salvage` recovers orphaned read-only lane results from an
interrupted run's child transcripts (preview first, then approve).
```

- [ ] **Step 8: Full suite, commit**

```bash
node --test tests/*.test.mjs
git add skills/
git commit -m "docs: skill accuracy — real globals list, live trust path, sandbox stub precision, meta/authority-profile reference, drop fabricated DEFAULT_CHILD_MODEL

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 7: Shipped doc + README — workflow_save contract, cleanup TTL, doc map, scoped-parallel

**Files:**
- Modify: `docs/workflow-plugin.md:23,25` (tool-table rows)
- Modify: `README.md:108-114` (Documentation Map), `README.md:~553` (template prose)

**Interfaces:**
- Consumes: Task 3's `interruptedTtlMs` schema field (documenting it), Task 4's save-contract wording (staying consistent with it).

- [ ] **Step 1: Expand the `workflow_save` row in `docs/workflow-plugin.md:23`**

```markdown
<!-- OLD -->
| `workflow_save` | Writes saved workflow source. | No approval hash; write-permission gated. | `workflow_list({ format: "json" })`. |
<!-- NEW -->
| `workflow_save` | Writes saved workflow source (`export const meta = {...}` plus top-level statements ending in `return`). | No approval hash; write-permission gated. `scope` defaults to `project`; `scope: "global"` additionally requires the literal `globalScopeIntent: "save-global-workflow"`; `overwrite: true` replaces an existing name. | `workflow_list({ format: "json" })`. |
```

- [ ] **Step 2: Note the TTL override in the `workflow_cleanup` row (`docs/workflow-plugin.md:25`)**

```markdown
<!-- OLD -->
| `workflow_cleanup` | Dry-run is read-only; non-dry deletes safe terminal run directories. | No approval hash; write-permission gated for deletion. | Run with `dryRun: true` first; then `workflow_status({ limit, detail: "compact" })`. |
<!-- NEW -->
| `workflow_cleanup` | Dry-run is read-only; non-dry deletes safe terminal run directories. Locked, active, pinned, ambiguous-edit, and resumable runs are always preserved; interrupted runs are protected until a TTL (override with `interruptedTtlMs`). | No approval hash; write-permission gated for deletion. | Run with `dryRun: true` first; then `workflow_status({ limit, detail: "compact" })`. |
```

- [ ] **Step 3: Fix the README Documentation Map (lines 108-114)**

(a) In the "Historical snapshots / audits (GitHub only)" row, append these four paths to the document list:
`docs/general-purpose-harness-extraction-plan.md`, `docs/superpowers/plans/2026-07-07-design-c-gate-simplification.md`, `docs/superpowers/specs/2026-07-08-pure-architecture-extraction-design.md`, `docs/superpowers/plans/2026-07-08-pure-architecture-extraction.md`

(b) In the "Roadmap / planning (GitHub only)" row: REMOVE `docs/general-purpose-harness-extraction-plan.md` (its own header says "Status: SUPERSEDED... IMPLEMENTED (2026-06-30)"), and ADD `docs/superpowers/specs/2026-07-07-toast-status-cards-design.md` and `docs/superpowers/plans/2026-07-08-agent-surface-docs-accuracy.md` (this plan).

(c) Sanity-check every path added: `ls docs/superpowers/specs docs/superpowers/plans` and confirm each named file exists exactly as written.

- [ ] **Step 4: Document the other two starter templates in README (~line 553, after the first-run-slice paragraph)**

Insert as a new paragraph:
```markdown
Two more starter templates ship alongside it: `scoped-parallel` demonstrates
the scoped-helper `parallel()` callback form over an `args.items` list, and
`edit-review` demonstrates the smallest schema-gated edit lane (an edit lane
must declare a schema returning `{ patches: [...] }`). List all three with
`workflow_templates`; save a copy with `workflow_template_save`.
```

- [ ] **Step 5: Docs lint + full suite, commit**

```bash
node --test tests/workflow-docs.test.mjs
node --test tests/*.test.mjs
git add docs/workflow-plugin.md README.md docs/superpowers/plans/2026-07-08-agent-surface-docs-accuracy.md
git commit -m "docs: workflow_save contract and cleanup TTL in shipped doc; README doc-map recategorization; document scoped-parallel and edit-review starters

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```
(The plan file itself is committed here if not already committed at plan-writing time.)

---

### Task 8: CHANGELOG, grep sweep, final verification

**Files:**
- Modify: `CHANGELOG.md` ([Unreleased] section)

**Interfaces:** consumes all prior tasks.

- [ ] **Step 1: CHANGELOG entries**

Under the existing `## [Unreleased]` heading, add to the existing `### Changed` list (create the subsection if a prior release cut emptied it):
```markdown
- Tool-surface accuracy and completeness pass (2026-07-08 agent-surface review):
  per-argument schema docs for `workflow_run`, `workflow_save`, and
  `workflow_status`; `workflow_apply` no longer cites a nonexistent
  "workflow_run apply-preview"; `workflow_cleanup` documents its real
  protection set and exposes `interruptedTtlMs`; `workflow_status` drops its
  always-rejected `reconcile` arg; salvage hints point at `workflow_salvage`
  instead of the unshipped `session_read`; toast inspect lines use `runId=`;
  "v2" template jargon renamed to "starter".
- Bundled skills corrected and extended: full injected-globals list
  (`drain`, `persistArtifacts`, `inventoryFiles`), live extension-only
  trusted-source wording, precise sandbox stub semantics, new Meta Fields /
  Authority Profiles / Artifacts-Inventory-Drain reference sections, and the
  fabricated `DEFAULT_CHILD_MODEL` fallback removed from model tiering.
```
And under `### Added`:
```markdown
- Child lanes now receive a one-line authority disclosure in their system
  prompt (`laneAuthorityInstruction`), so a lane knows its tool ceiling up
  front instead of discovering it through permission denials.
```

- [ ] **Step 2: Stale-reference grep sweep**

```bash
grep -rn "session_read" workflow-kernel/ tests/ | grep -v "workflow-plugin.js:21[0-9][0-9]"   # only the explanatory comment block near line 2130 may remain
grep -rn "apply-preview" workflow-kernel/
grep -rni "\bv2\b" workflow-kernel/workflow-plugin.js workflow-kernel/role-template-loading.js
grep -rn "DEFAULT_CHILD_MODEL\|core-bundled" skills/
```
Expected: first command shows only the retained comment; the rest print nothing.

- [ ] **Step 3: Full suite + pack check**

```bash
node --test tests/*.test.mjs        # expect: # fail 0
npm pack --dry-run                  # expect: kernel-only tarball, no workflows/ or commands/
```

- [ ] **Step 4: Commit**

```bash
git add CHANGELOG.md
git commit -m "docs: changelog for the agent-surface accuracy pass

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

Merge back to main is a separate, user-approved step (finishing-a-development-branch), as with prior epics.
