# Deep-Research Hardening Implementation Plan

> Status: Approved plan (2026-07-09) — implementation pending. Baseline: main @ 9b6d067, suite 709/709 green. Sources: first live /deep-research run transcript review + 4-lane audit + 5-lane feasibility/fresh-eyes review (both adversarially grounded, file:line-cited).

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix every confirmed issue from the first live deep-research run — question-fit blindness, self-approval ambiguity, foreground blocking, dead maxCost ceilings, twice-truncated result payloads, misleading laneCoverage/stats, and six workflow-level correctness/honesty gaps — across the workflow, the bundled command, and the kernel.

**Architecture:** Three surfaces. Kernel (Tasks 1–4): additive telemetry/display changes — `meta.recommendBackground`, sticky `costTrackingUnreliable`, truncation-resilient inline results, allowlisted status meta. Workflow `workflows/deep-research.js` (Tasks 5–12): scope fit-warning, verifier local-source branch, Fetch lane tally, claims-cap accounting, hard user `maxSources`, synthesis tightening + title, size-fit honesty, in-guest artifact masking. Command + meta wiring + docs (Tasks 13–15).

**Tech Stack:** Node 22+ / `node:test`, QuickJS guest workflow scripts, plain JSON Schema (shared Ajv, `strict:false`).

**User decisions already made (2026-07-09, Michael):** approval gate = **explicit auto-proceed** (invoking `/deep-research` is consent; narrate, approve same turn); background = **default on** via new `meta.recommendBackground`.

## Global Constraints

- Suite must be green after every task: `node --test tests/*.test.mjs` (baseline 709 tests). Never commit red.
- Prompt-marker headers are a stable test contract and MUST remain the literal first line of each prompt: `## Deep-Research Scope`, `## Web Searcher:`, `## Source Extractor`, `## Adversarial Claim Verifier`, `## Synthesis: research report` (routed on by `tests/deep-research-workflow.test.mjs:64-93`).
- `workflows/deep-research.js` runs in the QuickJS guest: NO `Date.now()`, `Math.random()`, `new Date()`, timers, `URL`, or `crypto`. Match the file's manual-for-loop house style.
- Error-injection test fixtures must avoid TRANSIENT_ERROR_PATTERNS wording (`rate limit`, `429`, `timeout`, `ECONNRESET` — `workflow-kernel/errors.js:82-98`); transient-classed errors retry once and break call-count assertions. Use "crashed"/"exploded".
- Every file under `docs/*.md` (including this plan's edits) must carry a `> Status:` banner (`tests/workflow-docs.test.mjs:41`).
- `meta.whenToUse` must stay a single-line string ≤ 240 chars (`truncateText(meta.whenToUse, 240)`, `workflow-kernel/role-template-loading.js:499`).
- `commands/deep-research.md` frontmatter `description:` must stay on one line (`parseCommandMarkdown` regex, `workflow-kernel/workflow-plugin.js:277-284`).
- All new envelope/state/status fields are strictly ADDITIVE — no removals or renames of existing keys.
- The envelope contract doc (`docs/superpowers/specs/2026-07-08-deep-research-bundled-workflow-design.md` §4.10 and schema snippets) must be updated in the same batch as any envelope/schema field addition (Task 15).
- Never hard-code model IDs.
- Version: bump to **0.4.0** (Task 15). The deep-research background-default flip and the compact-status meta allowlist are logged under **Changed** in CHANGELOG.md, not buried in Added.

## Explicitly deferred (recorded, NOT in this batch)

- `workflow_status detail:"digest"` mode (feasibility confirmed; value is marginal once Tasks 3/4/14 land).
- Synthesis Option B (`sourceClaimIndices` + deterministic source/vote resolver) — breaks `DEFAULT_REPORT` fixture; follow-up if prompt-only tightening (Task 10) proves insufficient.
- FETCH_PROMPT/EXTRACT_SCHEMA local-source handling and a `local` sourceQuality bucket (extractor-side asymmetry noted in review).
- Kernel-side artifact redaction in `persistRunArtifacts` (would corrupt diff-shaped artifacts of apply workflows; deep-research masks in-guest instead, Task 12).
- A "cost-untracked" toast problem card (workflow_status surfacing covers the background case).
- `MAX_INLINE_RESULT_BYTES` recalibration (no reliable display-budget source; Task 3's important-lines-first ordering is budget-agnostic).
- Per-(run, session) result-delivery tracking to suppress duplicate readbacks (disproportionate; command-level fix in Task 14).
- Coupling `sourceQuality` to topical relevance (by-design orthogonality; `importance` already ranks relevance).

---

### Task 1: Kernel — `meta.recommendBackground`

**Files:**
- Modify: `workflow-kernel/workflow-plugin.js` (`workflowBackgroundDecision` ~line 460-476; `backgroundDefaultLine` ~line 498-505)
- Test: `tests/workflow-run.test.mjs` (new cases adjacent to the mfv9.6 block, ~line 5078-5137)

**Interfaces:**
- Consumes: `workflowBackgroundDecision(meta, sourcePath, args, priorState, sizing)` — `meta` is already the first parameter; no signature change.
- Produces: new decision `{ enabled: true, source: "meta-recommend" }`; new preview `defaultReason` string beginning `Background defaulted (workflow-declared):`. Task 13 sets the field on deep-research.

- [ ] **Step 1: Write the failing tests** (append near the existing mfv9.6 tests; mirror that block's harness usage — inline `source:` fixture, `tools.workflow_run.execute` preview call):

```js
test("mfv9.7: meta.recommendBackground defaults the run to background; explicit background:false wins", async () => {
  const src = `export const meta = { name: "bg-meta", description: "d", recommendBackground: true, maxAgents: 4, concurrency: 2 };
return { ok: true };`;
  // Preview with no background arg → defaulted on, workflow-declared reason line present.
  {
    const { tools, context, directory } = await makeHarness(async () => jsonResponse({}), { pluginContext: { __workflowServerHealth: OK_HEALTH, serverUrl: nextServerUrl() } });
    try {
      const preview = await tools.workflow_run.execute({ source: src, format: "text" }, context);
      assert.match(preview, /Background: true/);
      assert.match(preview, /Background defaulted \(workflow-declared\)/);
    } finally { await fs.rm(directory, { recursive: true, force: true }); }
  }
  // Explicit background:false overrides the meta recommendation.
  {
    const { tools, context, directory } = await makeHarness(async () => jsonResponse({}), { pluginContext: { __workflowServerHealth: OK_HEALTH, serverUrl: nextServerUrl() } });
    try {
      const preview = await tools.workflow_run.execute({ source: src, background: false, format: "text" }, context);
      assert.match(preview, /Background: false/);
      assert.doesNotMatch(preview, /Background defaulted \(workflow-declared\)/);
    } finally { await fs.rm(directory, { recursive: true, force: true }); }
  }
});
```

Adapt helper names (`jsonResponse`, `nextServerUrl`/serverSeq, harness options) to the file's local conventions in that block — copy from the adjacent mfv9.6 test verbatim.

- [ ] **Step 2: Run to verify failure** — `node --test tests/workflow-run.test.mjs` → new test FAILS (`Background: false` on first case).

- [ ] **Step 3: Implement.** In `workflowBackgroundDecision`, after the `meta.harness === "drain"` branch and before `const heuristic = backgroundHeuristic(sizing);`:

```js
  // An author-declared "this workflow typically runs wide/long" signal. Distinct from
  // meta.maxAgents (a ceiling, deliberately excluded from the sizing heuristic because bundled
  // workflows over-provision it): recommendBackground is an intent, not a bound. Explicit
  // args.background and resume pins above always win.
  if (meta.recommendBackground === true) {
    return { enabled: true, source: "meta-recommend" };
  }
```

In `backgroundDefaultLine`, add before the existing `source !== "heuristic"` early return:

```js
  if (approval?.backgroundDecision?.source === "meta-recommend") {
    return [
      "Background defaulted (workflow-declared): this workflow declares meta.recommendBackground — it is authored to fan out wide/long by design.",
      "The run starts in background so the calling agent keeps a control channel for workflow_status, workflow_pause, and workflow_cancel.",
    ].join(" ");
  }
```

- [ ] **Step 4: Run tests** — new cases PASS; the whole mfv9.6 block and `tests/workflow-run.test.mjs` stay green.
- [ ] **Step 5: Commit** — `feat(kernel): meta.recommendBackground defaults runs to background (explicit background always wins)`

---

### Task 2: Kernel — sticky `costTrackingUnreliable` warning

**Files:**
- Modify: `workflow-kernel/child-agent-runner.js` (~line 1089, after `run.cost += cost;`)
- Modify: `workflow-kernel/run-store-state.js` (~line 99, beside `cost: run.cost,`)
- Modify: `workflow-kernel/run-store-rehydrate.js` (~line 26, beside the `droppedLaneCount` carry)
- Modify: `workflow-kernel/run-store-status-format.js` (`compactStatusForEntry` AND `fullStatusForEntry` — mirror each one's `timeoutRecovery` conditional pattern; the full view must carry the caveat too, since it surfaces `cost`/`liveCost`/`totalCost` most prominently)
- Modify: `workflow-kernel/workflow-plugin.js` (`approvalSummary` after the `Budget ceilings:` line ~790; terminal success return array ~1304-1311)
- Test: `tests/child-agent-runner.test.mjs`, `tests/durable-state.test.mjs`, `tests/workflow-run.test.mjs`

**Interfaces:**
- Produces: `run.costTrackingUnreliable: boolean` (sticky, never reset), persisted in state.json, rehydrated on resume; `compact.costTrackingWarning: string` AND `full.costTrackingWarning: string` (both only when maxCost is set — parity: a `detail:"full"` reader must not see cost numbers with no caveat); one preview caveat line; one terminal-return warning line. Task 3 preserves the terminal line's position ahead of the JSON body.

- [ ] **Step 1: Write the failing tests.**

In `tests/child-agent-runner.test.mjs` (model on the existing lane-budget fixture at ~1220-1269, which returns `info: { cost: 0.25, tokens: {...} }`):

```js
test("costTrackingUnreliable: sticky when a lane reports tokens with cost=0; never resets", async () => {
  // First lane: tokens>0, cost=0 → flag set. Second lane: real cost → flag STAYS set.
  // Build two sequential child completions using this file's existing runner harness;
  // assert run.costTrackingUnreliable === true after lane 1 and still true after lane 2,
  // and run.cost === 0.25 after lane 2 (accrual unaffected).
});
```

In `tests/durable-state.test.mjs`, extend the resume-rehydration test (~446-491): add `costTrackingUnreliable: true` to the prior-state fixture and assert it survives `rehydrateRunFromPriorState`. Also add: `checkBudgetBeforeLaunch` does NOT throw merely because the flag is set.

In `tests/workflow-run.test.mjs`, beside the `Budget ceilings: maxCost=1.5, maxTokens=12` preview assertion (~1167-1174): assert the caveat line `Cost-ceiling caveat:` is present when `maxCost` is set and absent when it is not. Also assert that a `workflow_status` `detail:"full"` view of a run with `costTrackingUnreliable:true` and a `maxCost` ceiling includes `costTrackingWarning` (mirroring the compact/`detail:"compact"` assertion) — and is absent when `maxCost` is not set.

- [ ] **Step 2: Run to verify failures.**
- [ ] **Step 3: Implement.**

`child-agent-runner.js`, immediately after `run.cost += cost;`:

```js
        // Sticky: a lane reporting tokens with cost=0 means the provider gave no per-lane
        // pricing, so budget-accounting's maxCost comparison (which reads run.cost) cannot be
        // trusted to bound this run. Never reset — later priced lanes must not hide that
        // earlier spend evaded the ceiling.
        if (cost === 0 && (tokens.input + tokens.output + tokens.reasoning) > 0) {
          run.costTrackingUnreliable = true;
        }
```

`run-store-state.js` (state serialization object): `costTrackingUnreliable: run.costTrackingUnreliable === true,`

`run-store-rehydrate.js`: `if (prior.costTrackingUnreliable === true) run.costTrackingUnreliable = true;`

`run-store-status-format.js`, in `compactStatusForEntry` after the compact object is built (same conditional-field pattern as `timeoutRecovery`):

```js
  if (state.costTrackingUnreliable === true && Number.isFinite(state.budgetCeilings?.maxCost)) {
    compact.costTrackingWarning =
      "At least one lane reported tokens with cost=0 (provider did not report per-lane cost); the maxCost ceiling may not reliably bound this run — use maxTokens as a backstop.";
  }
```

`run-store-status-format.js`, in `fullStatusForEntry`'s `redacted` object, mirror the `timeoutRecovery` conditional field (~line 849) so the full view carries the same honesty caveat where cost is most prominent (`cost` ~812, `usage.liveCost`/`usage.totalCost` ~818-820) — otherwise a `detail:"full"` caller sees cost with no unreliability warning, the opposite of the goal:

```js
    costTrackingWarning: state.costTrackingUnreliable === true && Number.isFinite(state.budgetCeilings?.maxCost)
      ? "At least one lane reported tokens with cost=0 (provider did not report per-lane cost); the maxCost ceiling may not reliably bound this run — use maxTokens as a backstop."
      : undefined,
```

`workflow-plugin.js` `approvalSummary`, directly after the `Budget ceilings:` line:

```js
    ...(preview.budgetCeilings.maxCost !== null ? [
      "Cost-ceiling caveat: maxCost enforcement depends on the provider reporting per-lane cost; an unpriced/custom/free provider may report cost=0 while tokens accrue, in which case maxCost will not stop the run — set maxTokens as a backstop.",
    ] : []),
```

`workflow-plugin.js` terminal success return array (~1304-1311), add before the `Drain status:` line:

```js
      run.costTrackingUnreliable === true && Number.isFinite(run.budgetCeilings?.maxCost)
        ? "Cost tracking warning: at least one lane reported tokens with cost=0 — maxCost may not have reliably bounded this run."
        : undefined,
```

Do NOT add any behavior to `checkBudgetBeforeLaunch` — warning-only by design (free/local providers legitimately report cost 0).

- [ ] **Step 4: Run** `node --test tests/child-agent-runner.test.mjs tests/durable-state.test.mjs tests/workflow-run.test.mjs` → green.
- [ ] **Step 5: Commit** — `feat(kernel): sticky costTrackingUnreliable flag — surface dead-maxCost risk in preview, status, and terminal output`

---

### Task 3: Kernel — truncation-resilient inline result ordering

**Files:**
- Modify: `workflow-kernel/result-readback.js` (`inlineResultProjection` ~line 50-56)
- Modify: `workflow-kernel/workflow-plugin.js` (`workflowInlineResultLines` ~921-933; both return blocks ~1241-1248 and ~1304-1315)
- Test: `tests/workflow-run.test.mjs` (~3614 redaction test, ~3639 oversized-inline test, plus new order assertions)

**Interfaces:**
- Consumes: `inlineResultProjection` already returns `result` (the redacted value) in the INLINE branch; the omitted branch discards it.
- Produces: `inlineResultProjection` returns `result` in BOTH branches (additive). `workflowInlineResultLines(run, output)` now returns `{ lifted: string[], body: string[] }`. Final message order at both call sites: status line → lifted fields → `Result file:` → readback lines → per-branch trailers (Reason/Culprit/Diff plan hash/Drain status/cost warning) → JSON body LAST.

- [ ] **Step 1: Write the failing tests.** Extend the test at ~3639 ("foreground workflow_run omits oversized inline results…") and the small-result path with order assertions:

```js
  // Truncation resilience: every load-bearing line precedes the JSON body, so client-side
  // display truncation (which cuts the tail) can only ever cost the raw JSON dump.
  const jsonIdx = output.indexOf("Result (redacted JSON");
  for (const marker of ["Result file:", "Read redacted result:", "Output status:"]) {
    const idx = output.indexOf(marker);
    assert.ok(idx !== -1, `missing ${marker}`);
    assert.ok(jsonIdx === -1 || idx < jsonIdx, `${marker} must precede the JSON body`);
  }
```

Add a new small-workflow case whose output is `{ status: "ok", summary: "hello", stats: { a: 1 }, artifacts: { dir: "/tmp/x", files: ["r.md"] } }` and assert `Output status: ok`, `Summary: hello`, `Stats: a:1`, `Artifacts: /tmp/x (r.md)` all appear before the JSON body.

- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement.**

`result-readback.js` — omitted branch returns the redacted value too:

```js
  if (bytes > maxBytes) return { inline: false, bytes, maxBytes, result };
```

`workflow-plugin.js` — add the lifter and restructure (import `truncateText` and `MAX_STATUS_STRING_CHARS` from `./text-json.js` if not already imported in this module):

```js
// Lift the most load-bearing envelope fields into short plain lines that survive client-side
// display truncation (which cuts the tail). Duck-typed and fully defensive: workflow outputs
// are author-defined (string/array/number are all legal), so absent fields are skipped.
// Reads ONLY the redacted projection — lifting raw output would bypass secret redaction.
function liftImportantResultLines(redacted) {
  if (!redacted || typeof redacted !== "object" || Array.isArray(redacted)) return [];
  const lines = [];
  if (typeof redacted.status === "string") lines.push(`Output status: ${redacted.status}`);
  if (redacted.abortReason != null) lines.push(`Abort reason: ${redacted.abortReason}`);
  if (typeof redacted.summary === "string" && redacted.summary.trim()) {
    lines.push(`Summary: ${truncateText(redacted.summary, MAX_STATUS_STRING_CHARS)}`);
  }
  if (redacted.stats && typeof redacted.stats === "object" && !Array.isArray(redacted.stats)) {
    const statsLine = Object.entries(redacted.stats)
      .filter(([, v]) => ["string", "number", "boolean"].includes(typeof v))
      .slice(0, 24).map(([k, v]) => `${k}:${v}`).join(" ");
    if (statsLine) lines.push(`Stats: ${statsLine}`);
  }
  const artifacts = redacted.artifacts;
  if (artifacts && typeof artifacts === "object" && typeof artifacts.dir === "string") {
    const files = Array.isArray(artifacts.files) ? artifacts.files.slice(0, 8).join(", ") : "";
    lines.push(`Artifacts: ${artifacts.dir}${files ? ` (${files})` : ""}`);
  }
  return lines;
}

function workflowInlineResultLines(run, output) {
  const projection = inlineResultProjection(output);
  const lifted = liftImportantResultLines(projection.result);
  const body = projection.inline
    ? [`Result (redacted JSON, ${projection.bytes} bytes):`, projection.text]
    : [`Result omitted from workflow_run: redacted JSON is ${projection.bytes} bytes, above inline cap ${projection.maxBytes}.`];
  return { lifted, body };
}
```

(The omitted branch's old `Read full/partial result:` line is dropped — `workflowResultReadbackLines` already emits the identical command at both call sites; verify the ~3639 test's readback-command assertion still matches `Read redacted result:`.)

Review-required block (~1241-1248) becomes:

```js
        const inline = workflowInlineResultLines(run, output);
        return [
          `Workflow ${run.id} review-required.`,
          ...inline.lifted,
          `Result file: ${run.resultPath}`,
          ...workflowResultReadbackLines(run),
          result.reason ? `Reason: ${result.reason}` : undefined,
          result.culpritLane ? `Culprit lane: ${result.culpritLane}` : undefined,
          ...inline.body,
        ].filter((line) => line !== undefined).join("\n");
```

Terminal block (~1304-1315) becomes (keeping Task 2's cost-warning line among the trailers):

```js
    const inline = workflowInlineResultLines(run, output);
    return [
      `Workflow ${run.id} ${run.status === "awaiting-diff-approval" ? "awaiting diff approval" : run.status === "failed-with-diff-plan" ? "failed with diff plan for review" : run.status === "apply-failed" ? "auto-apply failed" : run.status === "failed" ? "failed" : "completed"}.`,
      ...inline.lifted,
      `Result file: ${run.resultPath}`,
      ...workflowResultReadbackLines(run),
      run.editPlan?.diffPlanHash ? `Diff plan hash: ${run.editPlan.diffPlanHash}` : undefined,
      drainFailed && typeof output === "object" && output ? `Drain status: ${output.status}` : undefined,
      run.costTrackingUnreliable === true && Number.isFinite(run.budgetCeilings?.maxCost)
        ? "Cost tracking warning: at least one lane reported tokens with cost=0 — maxCost may not have reliably bounded this run."
        : undefined,
      ...inline.body,
    ].filter((line) => line !== undefined).join("\n");
```

- [ ] **Step 4: Run** `node --test tests/workflow-run.test.mjs tests/deep-research-workflow.test.mjs` → green (the deep-research E2E regex `Workflow <id> (?:completed|failed)` matches the unchanged first line).
- [ ] **Step 5: Commit** — `feat(kernel): important-lines-first workflow_run output — status/summary/stats/artifacts survive display truncation`

---

### Task 4: Kernel — allowlisted meta in `workflow_status` compact/result views

**Files:**
- Modify: `workflow-kernel/text-json.js` (receive `summarizeArgsSchema` — moved, verbatim, from role-template-loading.js:457-477)
- Modify: `workflow-kernel/role-template-loading.js` (delete local definition; import from `./text-json.js`)
- Modify: `workflow-kernel/run-store-status-format.js` (`compactStatusForEntry` meta line ~564; new `compactMetaProjection`; import `summarizeArgsSchema`)
- Test: `tests/workflow-run.test.mjs` (rewrite ux.6 at ~3660; detail=full test at ~3741 unchanged)

**Interfaces:**
- Produces: `compact.meta` (and therefore `detail:"result"`'s meta, which reuses compact) becomes `{ name?, description?, whenToUse?, category?, profile?, phases?, maxAgents?, concurrency?, argsSummary? }`. `detail:"full"` keeps the wholesale redacted meta. `summarizeArgsSchema` exported from text-json.js (leaf module — avoids the role-template-loading → run-store-status re-export cycle).

- [ ] **Step 1: Write the failing test.** Rewrite ux.6 (~3660): keep its synthetic sensitive meta fixture, but assert the new contract:

```js
  // Compact meta is an allowlisted projection: sensitive/free-form keys are DROPPED (not
  // merely redacted); the full frontmatter remains on detail:"full" (see the 3741 test).
  assert.equal(compact.meta.apiKey, undefined);
  assert.equal(compact.meta.nested, undefined);
  assert.equal(compact.meta.prompt, undefined);
  assert.equal(compact.meta.name, "sensitive-meta-workflow");   // allowlisted key survives
  assert.match(compact.meta.argsSummary ?? "", /\{ .*\*.*\}|declared|type=/); // one-line args summary when argsSchema declared
  assert.equal(compact.meta.argsSchema, undefined);
  assert.equal(compact.meta.examples, undefined);
```

- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement.** Move `summarizeArgsSchema` (with its jbs3.10 comment) into `text-json.js` as an export; update role-template-loading.js's import (it already imports from text-json.js at line 11) and delete the local copy. In run-store-status-format.js (already imports from text-json.js at line 26 — add `summarizeArgsSchema`):

```js
// Compact/result status views carry an allowlisted meta projection. Status readbacks are
// polled repeatedly; the wholesale frontmatter dump (argsSchema, examples, notes) dominated
// their size. detail:"full" keeps the complete redacted meta for diagnostics.
function compactMetaProjection(meta) {
  const m = meta && typeof meta === "object" && !Array.isArray(meta) ? meta : {};
  const projected = {};
  for (const key of ["name", "description", "whenToUse", "category", "profile"]) {
    if (typeof m[key] === "string") projected[key] = truncateText(redactFreeTextSecrets(m[key]), MAX_STATUS_STRING_CHARS);
  }
  if (Array.isArray(m.phases)) projected.phases = redactValue(m.phases);
  if (Number.isInteger(m.maxAgents)) projected.maxAgents = m.maxAgents;
  if (Number.isInteger(m.concurrency)) projected.concurrency = m.concurrency;
  const argsSummary = summarizeArgsSchema(m.argsSchema);
  if (argsSummary) projected.argsSummary = argsSummary;
  return projected;
}
```

Replace `meta: redactValue(state.meta ?? {}),` with `meta: compactMetaProjection(state.meta),` in `compactStatusForEntry` ONLY. `declaredProfileForState` reads `state.meta` directly and is unaffected — verify, don't touch. `fullStatusForEntry`'s `meta: redactValue(state.meta)` is untouched.

- [ ] **Step 4: Run** the full suite — grep first for any other test asserting compact meta contents (`grep -n "meta\." tests/workflow-run.test.mjs | grep -i compact`) and adjudicate each hit; the feasibility review found only ux.6.
- [ ] **Step 5: Commit** — `feat(kernel): allowlist workflow_status compact/result meta (name/description/whenToUse/… + argsSummary); full view unchanged`

---

### Task 5: Workflow — scope fit-warning + `whenToUse` rescope

**Files:**
- Modify: `workflows/deep-research.js` (meta line 4; SCOPE_SCHEMA 131-144; SCOPE_PROMPT 207-218; envelope() 96-102; post-scope 278-279; renderMarkdown caveats line 509)
- Test: `tests/deep-research-workflow.test.mjs`, `tests/deep-research-contract.test.mjs` (whenToUse assertion is type-only — unaffected)

**Interfaces:**
- Produces: envelope gains first-class `fitWarning: string|null` on EVERY return path; when set it is also prefixed onto `caveats` and rendered in the report's `## Caveats`. `SCOPE_SCHEMA` gains optional `fitWarning` (NOT in `required` — `DEFAULT_SCOPE` fixture stays valid).

- [ ] **Step 1: Write the failing tests:**

```js
test("scope fitWarning surfaces in envelope, caveats, and report", async () => {
  const warn = "This question targets the local repository; public web search cannot see it.";
  const { result } = await runDeepResearch(scriptedResponder({ scope: { ...DEFAULT_SCOPE, fitWarning: warn } }));
  assert.equal(result.fitWarning, warn);
  assert.ok(result.caveats.startsWith(warn), "fitWarning must prefix caveats");
  assert.match(result.reportMarkdown, /## Caveats/);
  assert.ok(result.reportMarkdown.includes(warn));
});

test("fitWarning defaults to null and does not disturb caveats", async () => {
  const { result } = await runDeepResearch(scriptedResponder());
  assert.equal(result.fitWarning, null);
  assert.equal(result.caveats, "none"); // DEFAULT_REPORT.caveats untouched
});
```

- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement.**

meta line 4 (must be ≤240 chars, one line — verify with `node -e 'console.log("<string>".length)'`):

```js
  whenToUse: "When the user wants a deep, multi-source, fact-checked WEB research report on an externally-researchable topic — not this repo/private code (use a local investigation instead). Refine underspecified questions first; pass as args.question.",
```

SCOPE_SCHEMA properties (after `summary`): `fitWarning: { type: ["string", "null"] },`

SCOPE_PROMPT — replace the final two lines (from `"Make queries specific…"`) with:

```js
  "Make queries specific enough to surface high-signal results. Avoid redundancy.\n\n" +
  "### Fit check\n" +
  "This harness researches the PUBLIC WEB. If the question is primarily about a local/private codebase, an internal system, or anything public web search cannot see, set `fitWarning` to a 1-2 sentence explanation — the run still proceeds, but the warning rides the report — and angle the queries toward the PUBLIC aspects of the topic. Otherwise set `fitWarning` to null.\n\n" +
  "Return: the question (verbatim or lightly normalized), a 1-2 sentence decomposition strategy as `summary`, the angles, and `fitWarning`.";
```

envelope() — centralized field + caveats prefix (module-level `let fitWarning = null;` declared directly above it, so the two pre-scope failure paths correctly carry null):

```js
let fitWarning = null;
function envelope(status, extra) {
  const out = {
    domain: DOMAIN, schemaVersion: SCHEMA_VERSION, status, abortReason: null,
    question: QUESTION, reportPath: null, laneCoverage, fitWarning, ...extra,
  };
  if (fitWarning && typeof out.caveats === "string") {
    out.caveats = out.caveats ? fitWarning + "\n\n" + out.caveats : fitWarning;
  }
  return out;
}
```

After the `const angles = scope.angles.slice(0, P.angles);` line:

```js
fitWarning = typeof scope.fitWarning === "string" && scope.fitWarning.trim() ? scope.fitWarning.trim() : null;
if (fitWarning) await log("fit warning: " + fitWarning.slice(0, 160));
```

renderMarkdown caveats line (509) becomes:

```js
  const caveatsText = [fitWarning, rep.caveats].filter(Boolean).join("\n\n");
  if (caveatsText) lines.push("## Caveats", "", caveatsText, "");
```

- [ ] **Step 4: Run** `node --test tests/deep-research-workflow.test.mjs tests/deep-research-contract.test.mjs` → green (all 14 existing tests: `scope.fitWarning` is undefined in `DEFAULT_SCOPE` → stays null).
- [ ] **Step 5: Commit** — `feat(deep-research): scope-level question-fit warning rides envelope+caveats+report; whenToUse scoped to web-researchable topics`

---

### Task 6: Workflow — verifier local-source branch

**Files:**
- Modify: `workflows/deep-research.js` (VERIFY_PROMPT 245-260)
- Test: `tests/deep-research-workflow.test.mjs`

**Interfaces:**
- Consumes: child lanes already hold unconditional Read/Grep/Glob (kernel `authority-policy.js:498-502`, bounded by `external_directory: deny`) — this is a prompt-only change; NO authority change.
- Produces: `VERIFY_PROMPT` branches on whether `claim.sourceUrl` is URL-shaped. The `## Adversarial Claim Verifier` header stays the literal first line in both branches.

- [ ] **Step 1: Write the failing test:**

```js
test("verifier prompt: local-file sources get read-directly guidance, not websearch default-refute", async () => {
  const prompts = [];
  const { result } = await runDeepResearch(scriptedResponder({
    search: () => ({ results: [] }),
    verdict: (text) => { prompts.push(text); return DEFAULT_VERDICT; },
  }), { args: { question: "test question", seedUrls: ["workflow-kernel/notification-toast.js"] } });
  assert.equal(result.status, "ok");
  assert.ok(prompts.length > 0);
  for (const p of prompts) {
    assert.match(p, /^## Adversarial Claim Verifier/);
    assert.match(p, /Local source — read it directly/);
    assert.match(p, /Use the Read or Grep tool/);
    assert.doesNotMatch(p, /Use the websearch tool to look for contradicting evidence/);
    assert.match(p, /absence of public web-search results.*NOT grounds for refuting/s);
  }
});

test("verifier prompt: web sources keep the websearch cross-check", async () => {
  const prompts = [];
  await runDeepResearch(scriptedResponder({ verdict: (text) => { prompts.push(text); return DEFAULT_VERDICT; } }));
  for (const p of prompts) {
    assert.match(p, /Use the websearch tool to look for contradicting evidence/);
    assert.doesNotMatch(p, /Local source — read it directly/);
  }
});
```

- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement.** Replace VERIFY_PROMPT wholesale:

```js
// URL detection mirrors normURL's scheme-strip regex (line 118) so the two never drift;
// bare "www." hosts count as web. Anything else (repo paths like workflow-kernel/x.js)
// is a local source — verifier lanes hold unconditional Read/Grep (authority-policy.js:498-502,
// bounded to the run's directory), so direct inspection is the correct check there.
const isWebSource = (u) => {
  const s = String(u ?? "").trim();
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(s) || /^www\./i.test(s);
};
const VERIFY_PROMPT = (claim, v) => {
  const local = !isWebSource(claim.sourceUrl);
  return (
    "## Adversarial Claim Verifier (voter " + (v + 1) + "/" + P.votes + ")\n\n" +
    "Be SKEPTICAL. Try to REFUTE this claim. " + P.refutesRequired + "/" + P.votes + " refutations kill it.\n\n" +
    "### Research question\n" + QUESTION + "\n\n" +
    "### Claim under review\n\"" + claim.claim + "\"\n\n" +
    "**Source:** " + claim.sourceUrl + " (" + claim.sourceQuality + ")\n" +
    "**Supporting quote:** \"" + claim.quote + "\"\n\n" +
    (local
      ? "### Local source — read it directly\n" +
        "This source is a local file path, not a URL. Use the Read or Grep tool to open it and check the quote and claim against the file's actual content. Do NOT rely on websearch for this claim — public web search cannot see private/local code, and the absence of public web-search results is NOT grounds for refuting it.\n\n"
      : "") +
    "### Checklist\n" +
    "1. Is the claim actually supported by the quote, or is it an overreach or misread?\n" +
    "2. " + (local
      ? "Re-read the local source file directly — does it actually contain and support the quote?"
      : "Use the websearch tool to look for contradicting evidence — does any credible source dispute or heavily qualify this?") + "\n" +
    "3. Is the source quality sufficient for the claim's strength? (extraordinary claims need primary sources)\n" +
    "4. Is the claim outdated? (check dates — old claims about fast-moving fields are suspect)\n" +
    "5. Is this a marketing claim, press release, cherry-picked benchmark, or forum speculation?\n\n" +
    "**refuted=true** if: unsupported by quote / contradicted / low-quality source for a strong claim / outdated / marketing fluff" +
    (local ? " / the local file itself does not contain or support the quote" : "") + ".\n" +
    "**refuted=false** ONLY if: the claim is well-supported, current, and source quality matches claim strength.\n" +
    (local
      ? "Default to refuted=true only when the file's ACTUAL CONTENT leaves you uncertain — never because websearch found nothing. Evidence MUST be specific.\n"
      : "Default to refuted=true if uncertain. Evidence MUST be specific.\n")
  );
};
```

- [ ] **Step 4: Run** `node --test tests/deep-research-workflow.test.mjs` → green (responder routes on the unchanged header substring).
- [ ] **Step 5: Commit** — `fix(deep-research): verifier reads local-file sources directly; empty websearch is not refutation`

---

### Task 7: Workflow — Fetch lane tally in laneCoverage

**Files:**
- Modify: `workflows/deep-research.js` (insert after the `tallyPhase("Search", …)` call at 352, before the `allSources` loop; comment above the Verify tally at 421)
- Test: `tests/deep-research-workflow.test.mjs`

**Interfaces:**
- Produces: `laneCoverage.byPhase.Fetch` (one entry per fetch lane; `fetchFailed` records count as drops). BEHAVIOR CHANGE (deliberate, honesty-gate): a run with any crashed fetch lane now reports `status: "degraded"` instead of `"ok"` (finalStatus at 591 reads `laneCoverage.dropped`). Logged under Changed in Task 15.

- [ ] **Step 1: Write the failing test:**

```js
test("a crashed fetch lane registers as a Fetch drop and degrades the run", async () => {
  const { result } = await runDeepResearch(scriptedResponder({
    extract: (text) => text.includes("site-alpha.example/a") ? new Error("extract lane crashed") : DEFAULT_EXTRACT,
  }));
  assert.equal(result.status, "degraded");
  assert.equal(result.laneCoverage.byPhase.Fetch.dropped, 1);
  assert.ok(result.laneCoverage.byPhase.Fetch.expected >= 2);
  assert.equal(result.stats.fetchFailures, 1);
  assert.ok(result.laneCoverage.droppedLabels.some((l) => l.startsWith("fetch:")));
});
```

- [ ] **Step 2: Run to verify failure** (today: `status: "ok"`, no `byPhase.Fetch`).
- [ ] **Step 3: Implement.** Insert directly after the Search tally (line 352):

```js
// Fetch-phase coverage: each surviving perAngle item is an array of per-source fetch results
// (from the nested parallel()). A fetch lane's own error is caught INSIDE the stage and
// returned as a fetchFailed record (never a pipeline null), so remap those to null here so
// tallyPhase registers them as drops. Deliberate consequence: any crashed fetch lane degrades
// the run status — matching the honesty gate below and the spec's partial-drop rule.
const fetchLabels = [];
const fetchResults = [];
for (const item of perAngle) {
  if (!Array.isArray(item)) continue; // dropped search lane — already tallied under "Search"
  for (const s of item) {
    fetchLabels.push(s ? "fetch:" + (s.url ?? "unknown") : "fetch:unknown");
    fetchResults.push(s && s.fetchFailed ? null : s);
  }
}
tallyPhase("Fetch", fetchResults, (i) => fetchLabels[i]);
```

Above the Verify tally (421) add:

```js
// Granularity: Search tallies per pipeline LANE (angle/seed item); Fetch (above) per fetch
// lane (novel source); Verify per CLAIM — each votedRaw entry aggregates its P.votes votes,
// so an individual errored vote surfaces via erroredVotes/unverified, not as a lane drop here.
```

- [ ] **Step 4: Run** the deep-research suite → green (happy path: no fetch failures → `dropped` stays 0 → `status: "ok"` preserved, line 136's assertion holds).
- [ ] **Step 5: Commit** — `fix(deep-research): tally Fetch lanes in laneCoverage; crashed fetch lanes degrade the run honestly`

---

### Task 8: Workflow — claims-cap accounting + centralOnly abort fix

**Files:**
- Modify: `workflows/deep-research.js` (rank/cap block 378-383; the `rankedClaims.length === 0` branch 388-397; the websearch-unavailable stats object 373; `statsBase()` 431-437; findings.full.json 576; renderMarkdown Method 525-529)
- Test: `tests/deep-research-workflow.test.mjs`

**Interfaces:**
- Produces: `stats.claimsDroppedByCap` (all stats objects); artifact `findings.full.json` gains `droppedByCap: [{claim, sourceUrl, importance, quality}]`; NEW abortReason literal `"no-central-claims"` (claims existed but the depth's centralOnly filter dropped them all — `claimsExtracted` now honest in that branch). Task 14 documents both.

- [ ] **Step 1: Write the failing tests:**

```js
test("quick depth with zero central claims aborts as no-central-claims, not no-claims-extracted", async () => {
  const supportingOnly = {
    ...DEFAULT_EXTRACT,
    claims: [
      { claim: "widgets frobnicate", quote: "q1", importance: "supporting" },
      { claim: "gadgets rotate", quote: "q2", importance: "tangential" },
    ],
  };
  const { result } = await runDeepResearch(scriptedResponder({ extract: () => supportingOnly }), {
    args: { question: "test question", depth: "quick" },
  });
  assert.equal(result.status, "failed");
  assert.equal(result.abortReason, "no-central-claims");
  assert.ok(result.stats.claimsExtracted > 0, "extracted claims must be counted honestly");
  assert.match(result.summary, /central/);
  assert.doesNotMatch(result.summary, /all empty/);
});

test("claims beyond the verify cap are counted and spilled to artifacts", async () => {
  const fiveClaims = {
    ...DEFAULT_EXTRACT,
    claims: [1, 2, 3, 4, 5].map((i) => ({ claim: `claim ${i}`, quote: `quote ${i}`, importance: "central" })),
  };
  // 3 angles × 2 sources × 5 claims = 30 extracted; quick verifyCap=8 → 22 dropped by cap.
  const { result } = await runDeepResearch(scriptedResponder({ extract: () => fiveClaims }), {
    args: { question: "test question", depth: "quick" },
  });
  assert.equal(result.stats.claimsDroppedByCap, 22);
  assert.match(result.reportMarkdown, /lower-priority claim\(s\) were extracted but not verified/);
});
```

- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement.** Replace lines 380-383:

```js
let rankedClaims = [...allClaims].sort((a, b) =>
  (impRank[a.importance] - impRank[b.importance]) || (qualRank[a.sourceQuality] - qualRank[b.sourceQuality]));
if (P.centralOnly) rankedClaims = rankedClaims.filter((c) => c.importance === "central");
const claimsDroppedByCap = rankedClaims.length > P.verifyCap ? rankedClaims.slice(P.verifyCap) : [];
rankedClaims = rankedClaims.slice(0, P.verifyCap);
```

Replace the abort branch (388-397):

```js
if (rankedClaims.length === 0) {
  // Distinguish "sources yielded nothing" from "claims existed but this depth's centralOnly
  // filter dropped them all" — the latter misread as a websearch problem in the first live run.
  const centralFiltered = allClaims.length > 0;
  return envelope("failed", {
    abortReason: centralFiltered ? "no-central-claims" : "no-claims-extracted",
    summary: centralFiltered
      ? allClaims.length + " claim(s) extracted but none rated central; depth \"" + DEPTH + "\" verifies central claims only. Re-run at depth normal or thorough to verify supporting claims."
      : "No claims extracted. " + allSources.length + " source(s) fetched (" + fetchFailures + " failed), all empty. " +
        dupes.length + " URL dupes, " + budgetDropped.length + " budget-dropped.",
    findings: [], refuted: [], unverified: [], sources: sourcesSummary, openQuestions: [], caveats: "",
    stats: { depth: DEPTH, angles: angles.length, sourcesFetched: allSources.length, claimsExtracted: allClaims.length, claimsVerified: 0, confirmed: 0, killed: 0, unverified: 0, claimsDroppedByCap: claimsDroppedByCap.length, afterSynthesis: 0, urlDupes: dupes.length, budgetDropped: budgetDropped.length, fetchFailures, agentCalls: 1 + searchAgentLanes + fetchLaneCount },
    reportMarkdown: null, truncatedFindings: false, artifacts: null,
  });
}
```

`statsBase()`: add `claimsDroppedByCap: claimsDroppedByCap.length,` after `unverified:`. The websearch-unavailable stats object (373): add `claimsDroppedByCap: 0,` (it precedes the cap computation).

findings.full.json (576): add `droppedByCap: claimsDroppedByCap.map((c) => ({ claim: c.claim, sourceUrl: c.sourceUrl, importance: c.importance, quality: c.sourceQuality })),` alongside the existing keys. (Size: worst case ≈150 claims × ~400 B ≈ 60 KB against the 16 MiB artifact cap — no envelope impact; the list deliberately stays OUT of the envelope.)

renderMarkdown Method section (after the existing Method line):

```js
  if (st.claimsDroppedByCap > 0) {
    lines.push("", st.claimsDroppedByCap + " lower-priority claim(s) were extracted but not verified (verify cap " + P.verifyCap + "); see findings.full.json → droppedByCap in artifacts for the full list.");
  }
```

- [ ] **Step 4: Run** the deep-research suite → green.
- [ ] **Step 5: Commit** — `fix(deep-research): honest claims accounting — claimsDroppedByCap stat + artifact spill; no-central-claims abort stops misdiagnosing centralOnly filtering`

---

### Task 9: Workflow — explicit `maxSources` is a hard cap

**Files:**
- Modify: `workflows/deep-research.js` (MAX_FETCH 65-67; dedup gate 322-323)
- Test: `tests/deep-research-workflow.test.mjs` (tighten the existing fetch-budget test at ~179)

**Interfaces:**
- Produces: an explicitly-passed `args.maxSources` bounds ALL fetches (high-relevance and seeds included); preset defaults keep the CC-faithful high-relevance soft bypass. Task 14 documents that seedUrls consume the budget.

- [ ] **Step 1: Tighten the existing test** ("fetch budget: medium/low results beyond maxSources are dropped and counted") — add:

```js
  assert.ok(result.stats.sourcesFetched <= 3, `explicit maxSources must be a hard cap, got ${result.stats.sourcesFetched}`);
```

(Fixture: 3 angles × 2 high each = 6 high-relevance URLs; today all 6 fetch — the assertion fails, proving the bug.)

- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement.** Lines 65-67 become:

```js
const USER_MAX_SOURCES = Number.isInteger(RT.maxSources) && RT.maxSources >= 3 && RT.maxSources <= 30
  ? RT.maxSources
  : null;
const MAX_FETCH = USER_MAX_SOURCES ?? P.maxFetch;
```

Dedup gate (322-323) becomes:

```js
      // Preset budgets are soft (CC-faithful: high-relevance results fetch past the budget;
      // medium/low are dropped). An EXPLICIT user maxSources is a hard cap — high-relevance
      // results and seed URLs consume and respect it like everything else.
      if (fetchSlots <= 0 && (USER_MAX_SOURCES !== null || relRank[r.relevance] >= 1)) {
        budgetDropped.push({ url: r.url, angle: searchResult.angle });
        continue;
      }
```

- [ ] **Step 4: Run** the deep-research suite → green (the seedUrls test passes no maxSources → unaffected).
- [ ] **Step 5: Commit** — `fix(deep-research): explicit maxSources is a hard fetch cap (presets keep the CC-faithful high-relevance bypass)`

---

### Task 10: Workflow — synthesis tightening + report title

**Files:**
- Modify: `workflows/deep-research.js` (REPORT_SCHEMA 185-204; synthesis Instructions 489-495; renderMarkdown H1 500-501 and Method line)
- Test: `tests/deep-research-workflow.test.mjs`

**Interfaces:**
- Produces: REPORT_SCHEMA gains optional `title: { type: "string", maxLength: 80 }` (NOT required — `DEFAULT_REPORT` stays valid); H1 renders `# Deep Research: <title, else question>`, truncated to 80 chars (77 + `…`). Byte-identical to today ONLY for questions ≤ 80 chars (existing `/# Deep Research: test question/` assertion at line 133 keeps passing); a title-absent question LONGER than 80 chars is now bounded to 80 — a deliberate, tested change from today's untruncated H1 (`QUESTION` is unbounded user input, `deep-research.js:51`; the full question still appears verbatim in the command's persisted metadata block, so nothing is lost). Prompt now pins `vote`/`sources` semantics (prompt-only — Option A; Option B deferred). Method line annotates single-vote depths.

- [ ] **Step 1: Write the failing tests:**

```js
test("synthesis title drives the report H1; long titles truncate", async () => {
  const { result } = await runDeepResearch(scriptedResponder({
    report: { ...DEFAULT_REPORT, title: "Widget Frobnication Works" },
  }));
  assert.match(result.reportMarkdown, /# Deep Research: Widget Frobnication Works/);
  const { result: longRun } = await runDeepResearch(scriptedResponder({
    report: { ...DEFAULT_REPORT, title: "x".repeat(80) },  // maxLength-valid, render still bounds it
  }));
  assert.match(longRun.reportMarkdown, /# Deep Research: x{77}…|# Deep Research: x{80}/);
});

test("title-absent long question is bounded to 80 chars in the H1 (not byte-identical to today)", async () => {
  // Regression for the corrected Interfaces claim: with no title the fallback is QUESTION,
  // which today is emitted untruncated; the new render bounds it to 80 chars (77 + ellipsis).
  const longQ = "z".repeat(200);
  const { result } = await runDeepResearch(scriptedResponder(), { args: { question: longQ } });
  assert.match(result.reportMarkdown, /# Deep Research: z{77}…/);
  assert.ok(!result.reportMarkdown.includes("z".repeat(90)), "the H1 must not carry the full over-long question");
});

test("single-vote depths annotate the Method section", async () => {
  const { result } = await runDeepResearch(scriptedResponder(), { args: { question: "test question", depth: "normal" } });
  assert.match(result.reportMarkdown, /single-vote verification/);
});
```

- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement.**

REPORT_SCHEMA properties (beside `summary`): `title: { type: "string", maxLength: 80 },`

Synthesis Instructions — append after item 6:

```js
  "7. `vote` per finding: copy EXACTLY the vote tally shown above for the underlying claim (e.g. \"3-0\"). When merging claims with different tallies, OMIT `vote` — never write prose there.\n" +
  "8. Every `sources` entry MUST be copied verbatim from a Source: line above (a real URL or file path). Never cite this prompt's own structure — no \"refuted claim list\", no bracket indices.\n" +
  "9. Optionally set `title`: a short (<= 80 chars) headline distilling the answer. Omit it if the question itself already reads as a title.",
```

renderMarkdown H1 (line 500-501):

```js
  const rawTitle = typeof rep.title === "string" && rep.title.trim() ? rep.title.trim() : QUESTION;
  const title = rawTitle.length > 80 ? rawTitle.slice(0, 77) + "…" : rawTitle;
  const lines = ["# Deep Research: " + title, "", "## Executive summary", "", rep.summary, "", "## Findings", ""];
```

Method line — append inside the existing push (after `st.unverified + " unverified."`):

```js
    + (P.votes === 1 ? " Note: this depth uses single-vote verification — each refutation is a single verifier's judgment; re-run at thorough for 3-vote panels." : "")
```

- [ ] **Step 4: Run** the deep-research suite → green.
- [ ] **Step 5: Commit** — `feat(deep-research): synthesis vote/sources semantics pinned; optional model-authored report title; single-vote depth annotation`

---

### Task 11: Workflow — size-fit honesty (refuted/unverified trim + truthful flag)

**Files:**
- Modify: `workflows/deep-research.js` (`fitWithinBudget` 592-610)
- Test: `tests/deep-research-workflow.test.mjs`

**Interfaces:**
- Produces: over-budget envelopes now also trim `refuted`/`unverified` (floor 5 each) after the findings-halving loop, and `truncatedFindings` is set truthfully whenever ANY trim happened or the envelope still exceeds the limit (kernel backstop will cut it).

- [ ] **Step 1: Write the failing test.** The size pressure MUST live in a field the budgeted arrays actually carry: `toRefuted`/`toUnverified` (`deep-research.js:429-430`) emit `{ claim, vote, source }` / `{ claim, erroredVotes, validVotes, source }` — they DROP `quote`. So inflating `quote` (as an earlier draft did) never reaches `refutedOut`/`unverifiedOut`; inflate `claim` instead. And enough DISTINCT central claims must reach the verify cap that MORE THAN 5 land refuted (the trim loop's floor is 5), while ≥ 1 stays confirmed (else the `confirmed.length === 0` early return at `:439` fires before `fitWithinBudget` is ever reached):

```js
test("oversized refuted set is trimmed and sets truncatedFindings=true", async () => {
  // ~40 distinct central claims, each ~6 KB in `claim` → the refuted array alone (~40 × 6 KB
  // ≈ 240 KB) exceeds fitWithinBudget's 230000 LIMIT even after findings hit their floor of 5.
  const bigClaims = {
    ...DEFAULT_EXTRACT,
    claims: Array.from({ length: 40 }, (_, i) => ({ claim: `claim ${i} ` + "y".repeat(6000), quote: "q", importance: "central" })),
  };
  const { result } = await runDeepResearch(scriptedResponder({
    extract: () => bigClaims,
    // Refute everything EXCEPT the "claim 0" text → ≥1 confirmed survives, the rest kill.
    verdict: (text) => text.includes("claim 0 ") ? DEFAULT_VERDICT : { refuted: true, evidence: "contradicted by primary source", confidence: "high" },
  }), { args: { question: "test question", depth: "thorough" } }); // thorough → high verifyCap so > 5 claims reach verify
  assert.equal(result.truncatedFindings, true, "trimming the refuted array must set truncatedFindings");
  assert.ok(result.refuted.length >= 5, "the floor of 5 refuted must be respected");
  assert.ok(JSON.stringify(result).length < 262144, "the envelope must fit under MAX_RESULT_BYTES after trimming");
});
```

Add a sibling `unverified`-path case: force the verifier lanes to ERROR so their votes count as `erroredVotes` and the claims land in `unverifiedClaims` (not `killed`) — e.g. a `verdict` that throws for most claims (`() => { throw new Error("verifier lane crashed"); }`) while a non-throwing branch keeps ≥ 1 confirmed (so neither the `confirmed.length === 0` nor the all-errored `verifiers-failed` branch returns first) — then assert `result.truncatedFindings === true` with `result.unverified.length >= 5`. Both arrays share the same trim loop, so one strong case per array is sufficient. If the chosen `depth`'s `verifyCap` proves too small to leave > 5 in either array, raise the claim count or the depth until it does — making that adjustment is the point of the red step.

- [ ] **Step 2: Run to verify failure** (today: refuted list untrimmed, `truncatedFindings` false, kernel backstop silently truncates).
- [ ] **Step 3: Implement.** Replace `fitWithinBudget`:

```js
function fitWithinBudget() {
  const LIMIT = 230000; // headroom under MAX_RESULT_BYTES (262144) for the host result wrapper
  let findingsOut = report.findings;
  let refutedFit = refutedOut;
  let unverifiedFit = unverifiedOut;
  let truncated = false;
  let md = reportMarkdown;
  const build = () => envelope(finalStatus, {
    summary: report.summary, findings: findingsOut,
    refuted: refutedFit, unverified: unverifiedFit, sources: sourcesSummary,
    openQuestions: report.openQuestions ?? [], caveats: report.caveats ?? "",
    stats: { ...statsBase(), afterSynthesis: report.findings.length },
    reportMarkdown: md, truncatedFindings: truncated, artifacts,
  });
  if (jsonUtf8ByteLength(build()) > LIMIT) md = null;
  while (jsonUtf8ByteLength(build()) > LIMIT && findingsOut.length > 5) {
    findingsOut = findingsOut.slice(0, Math.ceil(findingsOut.length / 2));
    truncated = true;
  }
  // The refuted/unverified arrays were previously un-budgeted growth vectors: a large killed
  // set could blow past LIMIT after findings hit their floor, silently relying on the kernel's
  // partial-readback backstop while truncatedFindings stayed false.
  while (jsonUtf8ByteLength(build()) > LIMIT && (refutedFit.length > 5 || unverifiedFit.length > 5)) {
    if (refutedFit.length > 5) refutedFit = refutedFit.slice(0, Math.ceil(refutedFit.length / 2));
    if (unverifiedFit.length > 5) unverifiedFit = unverifiedFit.slice(0, Math.ceil(unverifiedFit.length / 2));
    truncated = true;
  }
  if (jsonUtf8ByteLength(build()) > LIMIT) truncated = true; // kernel backstop will engage — say so
  return build();
}
```

- [ ] **Step 4: Run** the deep-research suite → green.
- [ ] **Step 5: Commit** — `fix(deep-research): size-fit trims refuted/unverified and reports truncation truthfully`

---

### Task 12: Workflow — in-guest artifact secret masking

**Files:**
- Modify: `workflows/deep-research.js` (new masker above the artifactPayload block ~573; apply to all three artifact files)
- Test: `tests/deep-research-workflow.test.mjs`

**Interfaces:**
- Produces: artifact contents (`report.md`, `findings.full.json`, `sources.json`) pass through an in-guest secret masker, closing the asymmetry where the envelope is kernel-redacted at readback but `persistRunArtifacts` writes verbatim (`sandbox-executor.js:452-463`). The free-text-redactor header already assigns domain workflows this responsibility.

- [ ] **Step 1: Write the failing test:**

```js
test("artifact files mask token-shaped strings from fetched content", async () => {
  const leaky = {
    ...DEFAULT_EXTRACT,
    claims: [{ claim: "keys leak", quote: "creds AKIAABCDEFGHIJKLMNOP and sk-abcdefghijklmnopqrstuv", importance: "central" }],
  };
  const { result } = await runDeepResearch(scriptedResponder({ extract: () => leaky }));
  assert.equal(result.artifacts?.ok, true, "artifacts must persist in the harness");
  const reportMd = await fs.readFile(path.join(result.artifacts.dir, "report.md"), "utf8");
  const fullJson = await fs.readFile(path.join(result.artifacts.dir, "findings.full.json"), "utf8");
  for (const content of [reportMd, fullJson]) {
    assert.doesNotMatch(content, /AKIAABCDEFGHIJKLMNOP/);
    assert.doesNotMatch(content, /sk-abcdefghijklmnopqrstuv/);
    assert.match(content, /\[redacted\]/);
  }
});
```

- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement.** Above the artifactPayload block:

```js
// In-guest secret masking for artifacts. The returned envelope is redacted by the kernel at
// the readback boundary (result-readback → redactFreeTextSecrets), but persistArtifacts
// writes file content VERBATIM — without this pass, a token-shaped string quoted from a
// fetched page would be masked in reportMarkdown yet land in the clear in report.md.
// Patterns mirror the kernel redactor's high-signal shapes; keep them in sync by eye.
const SECRET_PATTERNS = [
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bsk-[A-Za-z0-9_-]{16,}\b/g,
  /\bghp_[A-Za-z0-9]{20,}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\b(?:Bearer|Basic)\s+[A-Za-z0-9+/=_.-]{16,}/g,
];
function maskSecrets(text) {
  let out = String(text ?? "");
  for (const re of SECRET_PATTERNS) out = out.replace(re, "[redacted]");
  return out;
}
```

artifactPayload files become:

```js
    { name: "findings.full.json", content: maskSecrets(JSON.stringify({ question: QUESTION, depth: DEPTH, report, confirmed, refuted: refutedOut, unverified: unverifiedOut, droppedByCap: claimsDroppedByCap.map((c) => ({ claim: c.claim, sourceUrl: c.sourceUrl, importance: c.importance, quality: c.sourceQuality })), sources: sourcesSummary, stats: statsBase() }, null, 2)) },
    { name: "sources.json", content: maskSecrets(JSON.stringify(sourcesSummary, null, 2)) },
    { name: "report.md", content: maskSecrets(reportMarkdown) },
```

(Verify Task 8 already added `droppedByCap` here; do not duplicate the key.)

- [ ] **Step 4: Run** the deep-research suite → green.
- [ ] **Step 5: Commit** — `fix(deep-research): mask token-shaped secrets in persisted artifacts (envelope/artifact redaction parity)`

---

### Task 13: Workflow meta — `recommendBackground: true` + E2E co-change

**Files:**
- Modify: `workflows/deep-research.js` (meta, after `concurrency: 8,`)
- Modify: `tests/deep-research-workflow.test.mjs` (line 103, the `base` object)
- Modify: `tests/deep-research-contract.test.mjs` (meta assertions)

**Interfaces:**
- Consumes: Task 1's kernel branch. **CRITICAL co-change:** without `background: false` in the E2E helper, all 15+ `runDeepResearch` tests flip to background and fail their `Workflow <id> (?:completed|failed)` regex.

- [ ] **Step 1: Make the E2E helper explicit FIRST** (keeps tests deterministic and synchronous regardless of meta):

```js
    const base = { name: "deep-research", args, background: false, ...request };
```

- [ ] **Step 2: Add the meta field** in `workflows/deep-research.js`:

```js
  maxAgents: 160,
  concurrency: 8,
  recommendBackground: true,
```

- [ ] **Step 3: Extend the contract test** (`tests/deep-research-contract.test.mjs`, beside the maxAgents assertion): `assert.equal(meta.recommendBackground, true);`

- [ ] **Step 4: Add a preview-level default test** in `tests/deep-research-workflow.test.mjs` (no approve — preview only, and deliberately NOT passing `background`):

```js
test("deep-research defaults to background via meta.recommendBackground", async () => {
  __resetFingerprintCacheForTests();
  const { tools, context, directory } = await makeHarness(scriptedResponder(), {
    pluginContext: { __workflowServerHealth: OK_HEALTH, serverUrl: `http://deep-research-${serverSeq++}.test` },
  });
  try {
    const preview = await tools.workflow_run.execute({ name: "deep-research", args: { question: "test question" } }, context);
    assert.match(preview, /Background: true/);
    assert.match(preview, /Background defaulted \(workflow-declared\)/);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
```

- [ ] **Step 5: Run** `node --test tests/deep-research-workflow.test.mjs tests/deep-research-contract.test.mjs` → green.
- [ ] **Step 6: Commit** — `feat(deep-research): default to background (meta.recommendBackground); E2E pins foreground explicitly`

---

### Task 14: Command rewrite — `/deep-research` protocol

**Files:**
- Modify: `commands/deep-research.md` (full-body rewrite; frontmatter description UNCHANGED and single-line)
- Test: `tests/extension-command-skill-registration.test.mjs:85-87` only pins `description` matching `/research/i`, `template` matching `/workflow_run/` and a `name: "deep-research"` pattern — preserved below. No other test reads this file; a careful human re-read is the real gate.

Replace everything below the frontmatter with:

````markdown
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
`approve: true, approvalHash: "<hash from the preview>"` (a name-resolved approval must
re-send the same `name` and `args`). Close the launch message by telling the user how to
re-run with different knobs if the defaults weren't what they wanted.

Optional args: `depth` (default `thorough` — 3-vote verification; `quick`/`normal` use
single-vote panels, so individual refutations there are one verifier's judgment),
`maxSources` (3-30 — an explicit value is a HARD cap that seed URLs also consume),
`seedUrls` (known-good URLs; also the fallback when web search is unavailable). `args`
may also be a plain question string.

### 4. Read back

This workflow declares `recommendBackground`, so the approve call normally returns
immediately with a run id (`background: true`). Poll
`workflow_status({ runId, detail: "compact" })` until the status is terminal, then read
`workflow_status({ runId, format: "json", detail: "result" })` exactly once. If the user
forced `background: false`, the approve response itself already contains the completed
result inline (`Result (redacted JSON, N bytes):`) or an omitted-for-size notice naming
that same one `detail: "result"` call — do not poll, and do not re-read a result you
already have inline.

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
````

- [ ] **Step 1: Apply the rewrite** (one edit; keep frontmatter byte-identical).
- [ ] **Step 2: Run** `node --test tests/extension-command-skill-registration.test.mjs tests/publish-completeness.test.mjs` → green.
- [ ] **Step 3: Manual re-read** against the checklist: auto-proceed sentence present; background readback first; all three `reportMarkdown` branches; `no-central-claims`; hard `maxSources`; header template; reconciled read-only framing; single-vote caveat.
- [ ] **Step 4: Commit** — `docs(command): /deep-research protocol v2 — fit check, explicit auto-proceed consent, background readback, null-report branches, header template`

---

### Task 15: Docs, CHANGELOG, version 0.4.0

**Files:**
- Modify: `docs/superpowers/specs/2026-07-08-deep-research-bundled-workflow-design.md` (append an "Amended 2026-07-09" subsection: envelope adds `fitWarning`, `stats.claimsDroppedByCap`, `title` in REPORT_SCHEMA, `droppedByCap` artifact key, abortReason `no-central-claims`, background default, hard-maxSources semantics, Fetch tally + any-fetch-crash→degraded, artifact masking; do NOT rewrite the original decisions)
- Modify: `docs/workflow-plugin.md` (meta table: `recommendBackground`; workflow_status: compact/result meta allowlist + `costTrackingWarning`; workflow_run: important-lines-first output shape + cost caveat line)
- Modify: `docs/workflow-recipes.md` (readback guidance: only call `detail:"result"` for background runs or when the foreground response said the result was omitted)
- Modify: `CHANGELOG.md`, `package.json` (0.4.0)

- [ ] **Step 1: Spec + docs edits.** Every touched docs file keeps/gets its `> Status:` banner; cross-references verified (no dangling anchors).
- [ ] **Step 2: CHANGELOG** — new `## [0.4.0]` entry:
  - **Added:** `meta.recommendBackground`; sticky cost-tracking warning (preview caveat, `costTrackingWarning` status field, terminal line); deep-research `fitWarning`, `stats.claimsDroppedByCap` + `droppedByCap` artifact, optional report `title`, Fetch-phase laneCoverage, in-guest artifact secret masking; important-lines-first `workflow_run` output; `argsSummary` in status meta.
  - **Changed:** deep-research runs default to background (explicit `background: false` restores foreground); `workflow_status` compact/result meta is now an allowlisted projection (full frontmatter remains on `detail:"full"`) — external consumers reading dropped keys from compact must switch to `detail:"full"`; a crashed fetch lane now degrades deep-research run status; an explicit `maxSources` is a hard cap; new abortReason `no-central-claims` replaces a misdiagnosed `no-claims-extracted` at centralOnly depths.
  - **Fixed:** centralOnly abort misreporting `claimsExtracted: 0`; `truncatedFindings` staying false when refuted/unverified overflow relied on the kernel backstop; verifier default-refute on locally-sourced claims.
- [ ] **Step 3: `package.json`** version → `0.4.0`.
- [ ] **Step 4: Full suite** — `node --test tests/*.test.mjs` → green; `git status` clean of strays.
- [ ] **Step 5: Commit** — `docs+release: 0.4.0 — deep-research hardening batch (spec amendments, plugin/recipes docs, changelog)`

---

## Task dependencies

- Task 13 requires Task 1 (kernel branch) — run Task 1 first.
- Task 3 rewrites the terminal return array that Task 2 adds a line to — run Task 2 before Task 3 (Task 3's code block already includes Task 2's line).
- Task 12's findings.full.json edit assumes Task 8's `droppedByCap` key exists.
- Tasks 5-12 all edit `workflows/deep-research.js` — execute in numeric order; insertion points are distinct but adjacent (Tasks 7/8 share the 352-437 region).
- Task 14 references literals introduced by Tasks 5 (`fitWarning`), 8 (`no-central-claims`), 9 (hard cap), 13 (background default) — run after them.
- Task 15 is last.

## Plan self-review (performed 2026-07-09)

- **Spec coverage:** every confirmed finding from the two review workflows maps to a task or the Deferred list. Checked one-by-one against the audit outputs.
- **Placeholder scan:** Task 2 Step 1's first test is intentionally a specification of intent with harness details delegated to the adjacent fixture (the file's harness is bespoke); all other steps carry complete code. No TBDs.
- **Type consistency:** `fitWarning` (string|null), `claimsDroppedByCap` (integer ≥0), `title` (string ≤80), `recommendBackground` (boolean), `costTrackingUnreliable` (boolean), `costTrackingWarning` (string) — names used identically across tasks 1-15.
- **Test-contract audit:** prompt markers preserved (Tasks 6, 10); `DEFAULT_SCOPE`/`DEFAULT_REPORT` remain schema-valid (optional fields only); E2E foreground pin lands in the same commit as the meta flip (Task 13); ux.6 rewrite is scoped to compact (full-view test at 3741 untouched).

## Amended 2026-07-09 (post-review, epic `opencode-workflows-mnfx`)

A code-ground review of the materialized backlog surfaced three correctness/honesty gaps in this plan; all three are now fixed above:

- **Task 2:** the sticky cost warning was added to `compactStatusForEntry` only. `fullStatusForEntry` surfaces `cost`/`liveCost`/`totalCost` most prominently, so a `detail:"full"` reader would see cost numbers with no caveat — the opposite of the honesty goal. Task 2 now also mirrors the caveat onto `fullStatusForEntry` (Files list + implement step + test assertion).
- **Task 10:** the Interfaces "byte-identical to today when `title` absent" claim was false — `QUESTION` is unbounded (`deep-research.js:51`) and today's H1 is untruncated, whereas the new render bounds it to 80. Claim corrected (byte-identical only for questions ≤ 80 chars; longer questions are a deliberate, tested change) and a covering `title`-absent + long-question test added.
- **Task 11:** the Step-1 fixture could not exercise the trim it targets — `toRefuted`/`toUnverified` drop the inflated `quote`, and 5 claims with ≥ 1 surviving leaves ≤ 4 refuted (below the > 5 floor), so the assertion failed red→red. Fixture rewritten to inflate `claim` across ~40 distinct claims at `thorough` depth, plus an `unverified`-path sibling case. (Task 3's `MAX_STATUS_STRING_CHARS` import source and assorted test-count/PEM-regex nits remain as noted in the review but are low-impact and self-correcting under TDD.)
