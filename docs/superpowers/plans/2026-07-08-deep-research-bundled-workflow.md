# Deep-Research Bundled Workflow Implementation Plan

> Status: Ready to execute (verified by adversarial claim-grounding pass, 2026-07-08).

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the plugin's first bundled workflow — `deep-research`, a faithful port of Claude Code's bundled deep-research harness — plus a bundled `/deep-research` command and a small kernel enhancement (`meta.whenToUse`), reversing the zero-bundled stance deliberately and visibly.

**Architecture:** A single guest workflow file (`workflows/deep-research.js`) implementing Scope → pipeline(Search → URL-dedup → Fetch+Extract) → adversarial Verify → Synthesize with salvage paths at every stage, house envelope/coverage/size-fit machinery, and per-lane authority narrowing; a bundled command markdown auto-registered by the existing config hook; E2E tests through the real kernel with scripted child sessions.

**Tech Stack:** opencode-workflows kernel (QuickJS guest, `node:test`, Ajv), no new dependencies.

**Spec:** `docs/superpowers/specs/2026-07-08-deep-research-bundled-workflow-design.md` (approved 2026-07-08).

## Global Constraints

- Suite baseline: `node --test tests/*.test.mjs` reports **686 tests, all green** (the spec and this plan carry the `> Status:` banners that `tests/workflow-docs.test.mjs:41` requires on every `docs/` markdown file — any NEW doc this work adds needs one too). Every commit keeps the suite green.
- No new npm dependencies. Guest code is pure ES for QuickJS: **no** `Date`, `Math.random`, timers, `crypto`, `URL`, imports, or filesystem (`workflow-kernel/sandbox-executor.js:798-807`).
- Workflow source rules: top-level statements ending in `return`; the ONLY export is `export const meta = {...}` of pure JSON literals (`workflow-kernel/workflow-source.js:205-252`).
- `agent()` option keys must come from the allowlist — unknown keys throw `WorkflowAuthorityError` (`workflow-kernel/authority-policy.js:218-238`). This plan uses only: `label`, `tier`, `schema`, `phase`, `readOnly`, `onFailure`.
- Fan-out callbacks must declare a scope parameter (`function.length > 0`) or the kernel throws (`sandbox-executor.js:875-889`).
- Workflow file name must satisfy the slug regex `^[a-z0-9][a-z0-9-]{0,62}$` (`workflow-source.js:439-444`): `deep-research.js` ✓.
- Bundled discovery is path-convention only: `BUNDLED_WORKFLOW_DIR = <plugin-root>/workflows`, `BUNDLED_COMMAND_DIR = <plugin-root>/commands` (`workflow-kernel/constants.js:44-46`). No registration code is needed beyond creating the files.
- Network-granting authority requires opencode server ≥ 1.17.13 at runtime (`workflow-kernel/server-fingerprint.js`, `MIN_OPENCODE_SERVER_VERSION`, `constants.js:107`); tests satisfy it via the `__workflowServerHealth` seam (pattern: `tests/workflow-run.test.mjs:279-317`).
- Result cap: `MAX_RESULT_BYTES` = 262144 (`constants.js:53`); the workflow size-fits to 230,000 bytes with artifact spill.
- Commit style: repo convention `feat:`/`fix:`/`docs:`/`test:` prefixes, imperative subject.

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `workflow-kernel/role-template-loading.js` | Modify (~L484-523) | Surface `meta.whenToUse` in invocation metadata |
| `workflow-kernel/workflow-plugin.js` | Modify (L1711-1713) | Plain-string args passthrough (D11) |
| `tests/workflow-list-whentouse.test.mjs` | Create | `whenToUse` surfacing tests |
| `tests/plain-string-args.test.mjs` | Create | String-args passthrough/normalization tests |
| `workflows/deep-research.js` | Create | The bundled workflow (guest source) |
| `tests/deep-research-contract.test.mjs` | Create | Parse/meta/argsSchema/name-resolution contract tests |
| `tests/deep-research-workflow.test.mjs` | Create | E2E behavior suite (scripted child sessions) |
| `commands/deep-research.md` | Create | Bundled command (auto-registered) |
| `tests/publish-completeness.test.mjs` | Modify (L35-39, L113-118, L125-141) | Invert zero-bundled invariants |
| `tests/extension-command-skill-registration.test.mjs` | Modify (append) | Bundled command registration test |
| `package.json` | Modify | `files[]` += `workflows/`, `commands/`; version 0.3.0 |
| `README.md`, `CHANGELOG.md`, `docs/workflow-plugin.md`, `docs/workflow-recipes.md`, `skills/opencode-workflow-authoring/SKILL.md` | Modify | Stance reframe + docs |

---

### Task 1: Kernel enhancements — `meta.whenToUse` surfacing + plain-string args passthrough

**Files:**
- Modify: `workflow-kernel/role-template-loading.js:484-523` (`buildInvocationMetadata`)
- Modify: `workflow-kernel/workflow-plugin.js:1711-1713` (string-args normalization call site)
- Create: `tests/workflow-list-whentouse.test.mjs`
- Create: `tests/plain-string-args.test.mjs`
- Modify: `skills/opencode-workflow-authoring/SKILL.md` (Meta Fields list, ~L77)
- Modify: `docs/workflow-plugin.md` (add a new "Workflow meta fields" subsection — see Step 5; the file currently documents NO meta fields, so this is a new section, not an extension of an existing one)

**Interfaces:**
- Produces: (a) `invocation.whenToUse` (string, ≤240 chars) in `workflow_list` entries when `meta.whenToUse` is a string; curated fallback `CURATED_INVOCATION_HINTS[name].whenToUse` for bundled scope. Task 2's workflow declares `meta.whenToUse` and Task 2's contract test asserts it surfaces. (b) Plain-string `args` (not starting with `{`/`[` after trim) reach the guest verbatim; JSON-looking strings still normalize to the object they encode; `meta.argsSchema` remains the gate. Task 2's workflow and Task 3's plain-string E2E test depend on (b).

- [ ] **Step 1: Write the failing test**

Create `tests/workflow-list-whentouse.test.mjs`. Before writing assertions, open an existing `workflow_list` consumer (`grep -n "workflow_list" tests/extension-dir-resolution.test.mjs tests/workflow-docs.test.mjs`) and mirror its exact JSON parsing of the tool output (entry array location and field names); the assertions below assume entries expose `name` and `invocation`.

```js
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { makeHarness } from "./helpers/harness.mjs";

const WORKFLOW_WITH_WHENTOUSE = `export const meta = {
  name: "wt-probe",
  description: "probe",
  whenToUse: "When the user wants a whenToUse surfacing probe. ${"x".repeat(300)}",
};
return { ok: true };
`;

test("workflow_list surfaces meta.whenToUse, truncated to 240 chars", async () => {
  const { tools, context, directory } = await makeHarness(async () => ({ data: { parts: [], info: {} } }));
  try {
    const projDir = path.join(directory, ".opencode", "workflows");
    await fs.mkdir(projDir, { recursive: true });
    await fs.writeFile(path.join(projDir, "wt-probe.js"), WORKFLOW_WITH_WHENTOUSE, "utf8");

    const listing = JSON.parse(await tools.workflow_list.execute({ format: "json" }, context));
    const entries = Array.isArray(listing) ? listing : listing.workflows ?? listing.entries;
    const probe = entries.find((e) => e.name === "wt-probe");
    assert.ok(probe, "wt-probe must be listed");
    assert.ok(probe.invocation.whenToUse.startsWith("When the user wants a whenToUse surfacing probe."));
    assert.ok(probe.invocation.whenToUse.length <= 240, "whenToUse must truncate to 240 chars");
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("workflow_list omits whenToUse when the meta does not declare it", async () => {
  const { tools, context, directory } = await makeHarness(async () => ({ data: { parts: [], info: {} } }));
  try {
    const projDir = path.join(directory, ".opencode", "workflows");
    await fs.mkdir(projDir, { recursive: true });
    await fs.writeFile(path.join(projDir, "no-wt.js"), `export const meta = { name: "no-wt" };\nreturn 1;\n`, "utf8");

    const listing = JSON.parse(await tools.workflow_list.execute({ format: "json" }, context));
    const entries = Array.isArray(listing) ? listing : listing.workflows ?? listing.entries;
    const probe = entries.find((e) => e.name === "no-wt");
    assert.ok(probe, "no-wt must be listed");
    assert.equal(Object.hasOwn(probe.invocation, "whenToUse"), false);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/workflow-list-whentouse.test.mjs`
Expected: FAIL — `whenToUse` is undefined on `invocation` (unknown meta keys are currently ignored).

- [ ] **Step 3: Implement the kernel change**

In `workflow-kernel/role-template-loading.js`, inside `buildInvocationMetadata` (current body at L487-523):

After the existing `notes` line

```js
  const notes = typeof meta.notes === "string" ? truncateText(meta.notes, 240) : curated?.notes;
```

add:

```js
  // whenToUse mirrors Claude Code's bundled-workflow discovery hint: an author-owned, one-line
  // "reach for this when…" surfaced by workflow_list (curated fallback for bundled scope only).
  const whenToUse = typeof meta.whenToUse === "string" ? truncateText(meta.whenToUse, 240) : curated?.whenToUse;
```

and after the existing

```js
  if (notes) invocation.notes = notes;
```

add:

```js
  if (whenToUse) invocation.whenToUse = whenToUse;
```

Also update the function's leading comment (L484-486) from `(examples/category/notes/modelTiers)` to `(examples/category/notes/whenToUse/modelTiers)`, and the `CURATED_INVOCATION_HINTS` comment block (~L425-432) to mention that curated entries may carry `whenToUse` and that the bundled deep-research workflow demonstrates the preferred author-owned path (meta-declared fields win — L489-493 semantics unchanged).

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/workflow-list-whentouse.test.mjs`
Expected: PASS (2 tests).

- [ ] **Step 5: Write the failing plain-string args tests**

Today `workflow-plugin.js:1711-1713` JSON-parses EVERY string args bag via `parseRuntimeArgsString` (`authority-policy.js:448-462`), which throws `WorkflowAuthorityError` on a non-JSON string — so `args: "why is the sky blue?"` dies at preview time. The passthrough keeps the hash-drift normalization for JSON-looking strings and lets genuine plain strings through to `argsSchema` + the guest.

Create `tests/plain-string-args.test.mjs`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { makeHarness } from "./helpers/harness.mjs";

const STRING_OK_SOURCE = `export const meta = {
  name: "string-args-probe",
  argsSchema: { type: ["object", "string", "null"], properties: { a: { type: "integer" } } },
};
return { gotType: typeof args, value: args };
`;
const OBJECT_ONLY_SOURCE = `export const meta = {
  name: "object-args-probe",
  argsSchema: { type: "object", properties: { a: { type: "integer" } } },
};
return { value: args };
`;

async function runApproved(tools, context, request) {
  const preview = await tools.workflow_run.execute(request, context);
  const match = preview.match(/approvalHash: ([a-f0-9]{64})/);
  assert.ok(match, `missing approvalHash in preview: ${preview}`);
  const output = await tools.workflow_run.execute({ ...request, approve: true, approvalHash: match[1] }, context);
  const runId = output.match(/Workflow ([0-9a-f-]{36}) (?:completed|failed)/);
  assert.ok(runId, `run did not finish: ${output}`);
  const status = JSON.parse(await tools.workflow_status.execute({ runId: runId[1], format: "json", detail: "result" }, context));
  return status.result?.output ?? status.result;
}

test("a plain (non-JSON) string args passes through to the guest verbatim when argsSchema allows strings", async () => {
  const { tools, context, directory } = await makeHarness(async () => ({ data: { parts: [], info: {} } }));
  try {
    const result = await runApproved(tools, context, { source: STRING_OK_SOURCE, args: "why is the sky blue?" });
    assert.equal(result.gotType, "string");
    assert.equal(result.value, "why is the sky blue?");
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("a JSON-object string args is still normalized to the object it encodes (hash-drift fix preserved)", async () => {
  const { tools, context, directory } = await makeHarness(async () => ({ data: { parts: [], info: {} } }));
  try {
    const result = await runApproved(tools, context, { source: STRING_OK_SOURCE, args: '{"a": 1}' });
    assert.equal(result.gotType, "object");
    assert.deepEqual(result.value, { a: 1 });
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("a JSON-looking but invalid string args still fails loudly at plan time", async () => {
  const { tools, context, directory } = await makeHarness(async () => ({ data: { parts: [], info: {} } }));
  try {
    await assert.rejects(
      tools.workflow_run.execute({ source: STRING_OK_SOURCE, args: "{oops" }, context),
      /not valid JSON/,
    );
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("a plain string args is rejected by an object-only argsSchema (argsSchema stays the gate)", async () => {
  const { tools, context, directory } = await makeHarness(async () => ({ data: { parts: [], info: {} } }));
  try {
    await assert.rejects(
      tools.workflow_run.execute({ source: OBJECT_ONLY_SOURCE, args: "not an object" }, context),
      (err) => /args/i.test(err.message),
    );
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
```

- [ ] **Step 6: Run to verify the passthrough tests fail**

Run: `node --test tests/plain-string-args.test.mjs`
Expected: tests 1 FAILS (`WorkflowAuthorityError: workflow args must be a JSON object…`); tests 2-4 already pass (current behavior). Only the passthrough is new.

- [ ] **Step 7: Implement the passthrough**

In `workflow-kernel/workflow-plugin.js:1711-1713`, replace:

```js
  if (meta.harness !== "drain" && typeof args.args === "string") {
    args = { ...args, args: parseRuntimeArgsString(args.args) };
  }
```

with:

```js
  if (meta.harness !== "drain" && typeof args.args === "string") {
    const trimmedArgs = args.args.trim();
    // JSON-looking strings must still normalize to the object they encode, so string and
    // object emissions of one payload hash to the same approvalHash (the original drift fix).
    // A genuine plain string passes through verbatim: argsSchema is the per-workflow gate
    // (e.g. the bundled deep-research accepts a bare question string).
    if (trimmedArgs.startsWith("{") || trimmedArgs.startsWith("[")) {
      args = { ...args, args: parseRuntimeArgsString(args.args) };
    }
  }
```

(`parseRuntimeArgsString` still rejects arrays and non-object JSON — unchanged. Both the preview and the approve call receive the identical raw string, so the approval envelope hashes consistently.)

- [ ] **Step 8: Run to verify all passthrough tests pass**

Run: `node --test tests/plain-string-args.test.mjs`
Expected: PASS (4 tests).

- [ ] **Step 9: Update the two doc surfaces**

In `skills/opencode-workflow-authoring/SKILL.md`, the Meta Fields bullet (currently reading `- \`category\`, \`examples\`, \`notes\` — cosmetic; surfaced by \`workflow_list\`.`) becomes:

```markdown
- `category`, `examples`, `notes`, `whenToUse` — cosmetic; surfaced by
  `workflow_list`. `whenToUse` is a one-line "reach for this when…" discovery
  hint for agents browsing the registry.
```

`docs/workflow-plugin.md` currently documents **no** meta fields (verified: `grep -n "category" docs/workflow-plugin.md` is empty). Add a new short subsection immediately after the first `export const meta` mention (~L23):

```markdown
### Workflow meta fields

Beyond `name`/`description`, the kernel reads: `profile`/`authority`,
`argsSchema` (Ajv-validated against runtime `args` before launch; string args
that don't look like JSON pass through verbatim and are gated by this schema),
`maxAgents`, `concurrency`, `maxCost`, `maxTokens`, `maxRuntimeMs`,
`guestDeadlineMs`, `childModel`/`defaultChildModel`, `modelTiers`,
`harness: "drain"`, and `phases`. Cosmetic fields surfaced by `workflow_list`:
`category`, `examples`, `notes`, and `whenToUse` (a one-line "reach for this
when…" discovery hint). See the `opencode-workflow-authoring` skill for the
full authoring contract.
```

- [ ] **Step 10: Full suite + commit**

Run: `node --test tests/*.test.mjs`
Expected: all pass (686 baseline + 6 new).

```bash
git add workflow-kernel/role-template-loading.js workflow-kernel/workflow-plugin.js tests/workflow-list-whentouse.test.mjs tests/plain-string-args.test.mjs skills/opencode-workflow-authoring/SKILL.md docs/workflow-plugin.md
git commit -m "feat: meta.whenToUse surfacing + plain-string args passthrough"
```

---

### Task 2: The bundled workflow `workflows/deep-research.js` + packaging

**Files:**
- Create: `workflows/deep-research.js`
- Create: `tests/deep-research-contract.test.mjs`
- Modify: `package.json` (`files[]` — add `"workflows/"`)
- Modify: `tests/publish-completeness.test.mjs:35-39` and `:113-118` and `:125-141` (workflow half of the inversion)

**Interfaces:**
- Consumes: Task 1's `invocation.whenToUse` (contract test asserts it surfaces for the bundled entry).
- Produces: bundled workflow resolvable as `workflow_run({ name: "deep-research" })`; envelope contract `{ domain: "deep-research", schemaVersion: 1, status, abortReason, question, summary, findings, refuted, unverified, sources, openQuestions, caveats, stats, laneCoverage, reportPath: null, reportMarkdown, truncatedFindings, artifacts }` consumed by Task 3 tests and the Task 4 command. Prompt marker headers (used by Task 3's scripted responder): `## Deep-Research Scope`, `## Web Searcher:`, `## Source Extractor`, `## Adversarial Claim Verifier`, `## Synthesis: research report`.

- [ ] **Step 1: Write the failing contract test**

Create `tests/deep-research-contract.test.mjs`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import WorkflowPlugin from "../workflow-kernel/workflow-plugin.js";
import { parseWorkflowSource, resolveWorkflowSource } from "../workflow-kernel/workflow-source.js";
import { BUNDLED_WORKFLOW_DIR } from "../workflow-kernel/constants.js";
import { ajv } from "../workflow-kernel/structured-output.js";

const bundledPath = path.join(BUNDLED_WORKFLOW_DIR, "deep-research.js");

test("bundled deep-research.js exists, parses, and declares the expected meta contract", async () => {
  const source = await fs.readFile(bundledPath, "utf8");
  const { meta } = parseWorkflowSource(source);
  assert.equal(meta.name, "deep-research");
  assert.equal(meta.profile, "read-only-review");
  assert.deepEqual(meta.authority, { readOnly: true, network: true });
  assert.deepEqual(meta.phases, ["Scope", "Search", "Fetch", "Verify", "Synthesize"]);
  assert.equal(meta.maxAgents, 160);
  assert.equal(meta.concurrency, 8);
  assert.equal(typeof meta.whenToUse, "string");
  assert.equal(meta.category, "research");
  assert.ok(Array.isArray(meta.examples) && meta.examples.length >= 2);
  // argsSchema must compile under the same shared Ajv the kernel uses.
  assert.equal(typeof ajv.compile(meta.argsSchema), "function");
});

test("deep-research resolves by NAME at bundled scope from an empty project", async () => {
  const tmp = await fs.mkdtemp(path.join((await import("node:os")).tmpdir(), "dr-resolve-"));
  try {
    const context = { directory: tmp, worktree: tmp };
    const resolved = await resolveWorkflowSource(context, { name: "deep-research" }, []);
    assert.equal(resolved.sourcePath, bundledPath);
    assert.match(resolved.source, /export const meta/);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});
```

Note for the implementer: confirm the export names `parseWorkflowSource` / `resolveWorkflowSource` and the `resolveWorkflowSource(context, args, extensionWorkflowDirs)` signature against `workflow-kernel/workflow-source.js:333-373` before running; adjust the import to match the actual export style (named vs default `__test`) used by existing tests (`grep -rn "resolveWorkflowSource" tests/`).

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/deep-research-contract.test.mjs`
Expected: FAIL — `ENOENT` reading `workflows/deep-research.js`.

- [ ] **Step 3: Create `workflows/deep-research.js`**

Complete source (this is the deliverable — port of the CC architecture per spec §3-4, house conventions per `repo-bughunt.js`):

```js
export const meta = {
  name: "deep-research",
  description: "Deep research harness — fan-out web searches, fetch sources, adversarially verify claims, synthesize a cited report.",
  whenToUse: "When the user wants a deep, multi-source, fact-checked research report on any topic. Refine an underspecified question first; pass it as args.question (or args as a plain string).",
  category: "research",
  notes: "Network-authorized read-only research: search/fetch/verify lanes use websearch/webfetch; scope/synthesize lanes are narrowed to read-only. No shell, no MCP, no edits.",
  examples: [
    { label: "default thorough run", args: { question: "What are current best practices for passkey rollout in consumer apps?" } },
    { label: "quick pass", args: { question: "Is fish oil supplementation effective for ADHD?", depth: "quick" } },
    { label: "seeded", args: { question: "How does QuickJS handle async?", seedUrls: ["https://bellard.org/quickjs/"] } },
  ],
  profile: "read-only-review",
  authority: { readOnly: true, network: true },
  argsSchema: {
    type: ["object", "string", "null"],
    properties: {
      question: { type: "string" },
      depth: { type: "string", enum: ["quick", "normal", "thorough"] },
      maxSources: { type: "integer", minimum: 3, maximum: 30 },
      seedUrls: { type: "array", maxItems: 10, items: { type: "string" } },
    },
  },
  phases: ["Scope", "Search", "Fetch", "Verify", "Synthesize"],
  maxAgents: 160,
  concurrency: 8,
};

// deep-research: Scope → pipeline(Search → URL-dedup → Fetch+Extract) → adversarial Verify → Synthesize.
// A faithful port of the Claude Code bundled deep-research architecture onto this kernel
// (spec: docs/superpowers/specs/2026-07-08-deep-research-bundled-workflow-design.md).
// Prompt section headers ("## Deep-Research Scope", "## Web Searcher:", "## Source Extractor",
// "## Adversarial Claim Verifier", "## Synthesis: research report") are a stable contract —
// tests/deep-research-workflow.test.mjs routes scripted child responses on them.

const DOMAIN = "deep-research";
const SCHEMA_VERSION = 1;

// ---- args: plain string question | object bag | defensively a JSON string of the bag ----
let RT = args;
if (typeof RT === "string") {
  const trimmed = RT.trim();
  if (trimmed.startsWith("{")) {
    try { RT = JSON.parse(trimmed); } catch { RT = { question: trimmed }; }
  } else {
    RT = { question: trimmed };
  }
}
if (!RT || typeof RT !== "object" || Array.isArray(RT)) RT = {};

const QUESTION = typeof RT.question === "string" ? RT.question.trim() : "";
const DEPTH = ["quick", "normal", "thorough"].includes(RT.depth) ? RT.depth : "thorough";
const SEED_URLS = Array.isArray(RT.seedUrls)
  ? RT.seedUrls.filter((u) => typeof u === "string" && u.trim()).slice(0, 10)
  : [];

// Depth presets. `thorough` is Claude Code parity: 5 angles, 15-source fetch budget,
// 25-claim verify cap, 3-vote panels with 2 refutations required to kill a claim.
const PRESETS = {
  quick:    { angles: 3, maxFetch: 6,  verifyCap: 8,  votes: 1, refutesRequired: 1, centralOnly: true },
  normal:   { angles: 4, maxFetch: 10, verifyCap: 15, votes: 1, refutesRequired: 1, centralOnly: false },
  thorough: { angles: 5, maxFetch: 15, verifyCap: 25, votes: 3, refutesRequired: 2, centralOnly: false },
};
const P = PRESETS[DEPTH];
const MAX_FETCH = Number.isInteger(RT.maxSources) && RT.maxSources >= 3 && RT.maxSources <= 30
  ? RT.maxSources
  : P.maxFetch;

// Model tiers are lane-intent constants (workflow-model-tiering skill): the single scope lane
// feeds the whole funnel and verification is subtle adversarial judgment (deep); search and
// extraction are bulk work (fast). Dedup/rank/render are pure JS — zero agent cost.
const TIER_SCOPE = "deep";
const TIER_SEARCH = "fast";
const TIER_EXTRACT = "fast";
const TIER_VERIFY = "deep";
const TIER_SYNTH = "deep";

// ---- lane coverage telemetry (house pattern: repo-bughunt) ----
const laneCoverage = { expected: 0, completed: 0, dropped: 0, byPhase: {}, droppedLabels: [] };
function tallyPhase(name, results, labelOf) {
  const expected = results.length;
  let completed = 0;
  for (let i = 0; i < results.length; i++) {
    if (results[i] === null || results[i] === undefined) laneCoverage.droppedLabels.push(labelOf ? labelOf(i) : `${name}:${i + 1}`);
    else completed++;
  }
  const dropped = expected - completed;
  laneCoverage.expected += expected;
  laneCoverage.completed += completed;
  laneCoverage.dropped += dropped;
  const prev = laneCoverage.byPhase[name] || { expected: 0, completed: 0, dropped: 0 };
  laneCoverage.byPhase[name] = { expected: prev.expected + expected, completed: prev.completed + completed, dropped: prev.dropped + dropped };
  return results;
}

// ---- standardized return envelope ----
function envelope(status, extra) {
  return {
    domain: DOMAIN, schemaVersion: SCHEMA_VERSION, status, abortReason: null,
    question: QUESTION, reportPath: null, laneCoverage, ...extra,
  };
}

if (!QUESTION) {
  return envelope("failed", {
    abortReason: "no-question",
    summary: "No research question provided. Pass args as a plain question string or { question: \"…\" }.",
    findings: [], refuted: [], unverified: [], sources: [], openQuestions: [], caveats: "",
    stats: null, reportMarkdown: null, truncatedFindings: false, artifacts: null,
  });
}

// ---- URL normalization (QuickJS has no URL global; pure-string, CC-equivalent) ----
// Lowercase; strip scheme and leading www.; keep host+path; drop query/fragment; strip
// trailing slashes. Invalid/empty input normalizes to "" (callers skip those).
function normURL(u) {
  let s = String(u ?? "").trim().toLowerCase();
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, "");
  s = s.split(/[?#]/)[0];
  s = s.replace(/^www\./, "");
  s = s.replace(/\/+$/, "");
  return s;
}
function hostOf(u) {
  const n = normURL(u);
  const slash = n.indexOf("/");
  return slash === -1 ? n : n.slice(0, slash);
}

// ---- schemas (ported; plain JSON Schema, shared-Ajv strict:false compatible) ----
const SCOPE_SCHEMA = {
  type: "object", required: ["question", "angles", "summary"],
  properties: {
    question: { type: "string" },
    summary: { type: "string" },
    angles: {
      type: "array", minItems: 3, maxItems: 6,
      items: {
        type: "object", required: ["label", "query"],
        properties: { label: { type: "string" }, query: { type: "string" }, rationale: { type: "string" } },
      },
    },
  },
};
const SEARCH_SCHEMA = {
  type: "object", required: ["results"],
  properties: {
    results: {
      type: "array", maxItems: 6,
      items: {
        type: "object", required: ["url", "title", "relevance"],
        properties: {
          url: { type: "string" }, title: { type: "string" }, snippet: { type: "string" },
          relevance: { type: "string", enum: ["high", "medium", "low"] },
        },
      },
    },
  },
};
const EXTRACT_SCHEMA = {
  type: "object", required: ["claims", "sourceQuality"],
  properties: {
    sourceQuality: { type: "string", enum: ["primary", "secondary", "blog", "forum", "unreliable"] },
    publishDate: { type: "string" },
    claims: {
      type: "array", maxItems: 5,
      items: {
        type: "object", required: ["claim", "quote", "importance"],
        properties: {
          claim: { type: "string" }, quote: { type: "string" },
          importance: { type: "string", enum: ["central", "supporting", "tangential"] },
        },
      },
    },
  },
};
const VERDICT_SCHEMA = {
  type: "object", required: ["refuted", "evidence", "confidence"],
  properties: {
    refuted: { type: "boolean" }, evidence: { type: "string" },
    confidence: { type: "string", enum: ["high", "medium", "low"] },
    counterSource: { type: "string" },
  },
};
const REPORT_SCHEMA = {
  type: "object", required: ["summary", "findings", "caveats"],
  properties: {
    summary: { type: "string" },
    findings: {
      type: "array",
      items: {
        type: "object", required: ["claim", "confidence", "sources", "evidence"],
        properties: {
          claim: { type: "string" },
          confidence: { type: "string", enum: ["high", "medium", "low"] },
          sources: { type: "array", items: { type: "string" } },
          evidence: { type: "string" }, vote: { type: "string" },
        },
      },
    },
    caveats: { type: "string" },
    openQuestions: { type: "array", items: { type: "string" } },
  },
};

// ---- prompts ----
const SCOPE_PROMPT =
  "## Deep-Research Scope\n\n" +
  "Decompose this research question into complementary web-search angles.\n\n" +
  "### Question\n" + QUESTION + "\n\n" +
  "### Task\n" +
  "Generate " + P.angles + " distinct web search queries that together cover the question from different angles. " +
  "Pick angles that suit the question's domain. Examples:\n" +
  "- broad/primary · academic/technical · recent news · contrarian/skeptical · practitioner/implementation\n" +
  "- For medical: anatomy · common causes · serious differentials · authoritative refs · red flags\n" +
  "- For tech: state-of-art · benchmarks · limitations · industry adoption · cost/tradeoffs\n\n" +
  "Make queries specific enough to surface high-signal results. Avoid redundancy.\n" +
  "Return: the question (verbatim or lightly normalized), a 1-2 sentence decomposition strategy as `summary`, and the angles.";

const SEARCH_PROMPT = (angle) =>
  "## Web Searcher: " + angle.label + "\n\n" +
  "Research question: \"" + QUESTION + "\"\n\n" +
  "Your angle: **" + angle.label + "** — " + (angle.rationale || "") + "\n" +
  "Search query: `" + angle.query + "`\n\n" +
  "### Task\n" +
  "Use the websearch tool with the query above (or a refined version). Return the top 4-6 most relevant results.\n" +
  "Rank by relevance to the ORIGINAL question, not just the search query. Skip obvious SEO spam and content farms.\n" +
  "Include a short snippet capturing why each result is relevant. If search returns nothing usable, return an empty results array.";

const FETCH_PROMPT = (source, angle) =>
  "## Source Extractor\n\n" +
  "Research question: \"" + QUESTION + "\"\n\n" +
  "Fetch and extract key claims from this source:\n" +
  "**URL:** " + source.url + "\n**Title:** " + (source.title || source.url) + "\n**Found via:** " + angle + " search\n\n" +
  "### Task\n" +
  "1. Use the webfetch tool to retrieve the page content.\n" +
  "2. Assess source quality: primary research/institution? secondary reporting? blog/opinion? forum? unreliable?\n" +
  "3. Extract 2-5 FALSIFIABLE claims that bear on the research question. Each claim must:\n" +
  "   - be a concrete, checkable statement (not vague generalities)\n" +
  "   - include a direct quote from the source as support\n" +
  "   - be rated central/supporting/tangential to the research question\n" +
  "4. Note the publish date if available.\n\n" +
  "If the fetch fails or the page is irrelevant or paywalled, return claims: [] and sourceQuality: \"unreliable\".";

const VERIFY_PROMPT = (claim, v) =>
  "## Adversarial Claim Verifier (voter " + (v + 1) + "/" + P.votes + ")\n\n" +
  "Be SKEPTICAL. Try to REFUTE this claim. " + P.refutesRequired + "/" + P.votes + " refutations kill it.\n\n" +
  "### Research question\n" + QUESTION + "\n\n" +
  "### Claim under review\n\"" + claim.claim + "\"\n\n" +
  "**Source:** " + claim.sourceUrl + " (" + claim.sourceQuality + ")\n" +
  "**Supporting quote:** \"" + claim.quote + "\"\n\n" +
  "### Checklist\n" +
  "1. Is the claim actually supported by the quote, or is it an overreach or misread?\n" +
  "2. Use the websearch tool to look for contradicting evidence — does any credible source dispute or heavily qualify this?\n" +
  "3. Is the source quality sufficient for the claim's strength? (extraordinary claims need primary sources)\n" +
  "4. Is the claim outdated? (check dates — old claims about fast-moving fields are suspect)\n" +
  "5. Is this a marketing claim, press release, cherry-picked benchmark, or forum speculation?\n\n" +
  "**refuted=true** if: unsupported by quote / contradicted / low-quality source for a strong claim / outdated / marketing fluff.\n" +
  "**refuted=false** ONLY if: the claim is well-supported, current, and source quality matches claim strength.\n" +
  "Default to refuted=true if uncertain. Evidence MUST be specific.";

// ---- Phase 0: Scope ----
await phase("Scope");
const scope = await agent(SCOPE_PROMPT, {
  label: "scope", phase: "Scope", tier: TIER_SCOPE, schema: SCOPE_SCHEMA,
  readOnly: true,               // scope needs no web access — narrow below run authority
  onFailure: "returnNull",      // preserve the explicit salvage path below
});
if (!scope) {
  return envelope("failed", {
    abortReason: "scope-failed",
    summary: "Scope agent returned no result — cannot decompose the research question.",
    findings: [], refuted: [], unverified: [], sources: [], openQuestions: [], caveats: "",
    stats: null, reportMarkdown: null, truncatedFindings: false, artifacts: null,
  });
}
await log("Q: " + QUESTION.slice(0, 80) + (QUESTION.length > 80 ? "…" : ""));
const angles = scope.angles.slice(0, P.angles);
await log("Decomposed into " + angles.length + " angles: " + angles.map((a) => a.label).join(", "));

// ---- dedup state — accumulates across searchers as they complete (no barrier) ----
const seen = new Map();
const dupes = [];
const budgetDropped = [];
const relRank = { high: 0, medium: 1, low: 2 };
let fetchSlots = MAX_FETCH;
let fetchPhaseMarked = false;
let searchAgentLanes = 0;
let searchResultCount = 0;
let fetchLaneCount = 0;
let fetchFailures = 0;

// Seed URLs enter the same pipeline as a synthetic "seeds" item: no search agent, straight to
// dedup+fetch, always treated as high relevance (explicit user input).
const pipelineItems = [];
if (SEED_URLS.length > 0) {
  pipelineItems.push({ seed: true, label: "seeds", results: SEED_URLS.map((url) => ({ url, title: url, relevance: "high" })) });
}
for (const a of angles) pipelineItems.push(a);

// ---- Search → dedup → Fetch+Extract (pipeline; item A can fetch while item B still searches) ----
await phase("Search");
const perAngle = await pipeline(
  pipelineItems,
  async (item, { agent }) => {
    if (item.seed) return { angle: "seeds", results: item.results };
    searchAgentLanes++;
    const r = await agent(SEARCH_PROMPT(item), {
      label: "search:" + item.label, phase: "Search", tier: TIER_SEARCH, schema: SEARCH_SCHEMA,
    });
    searchResultCount += r.results.length;
    await log(item.label + ": " + r.results.length + " results");
    return { angle: item.label, results: r.results };
  },
  async (searchResult, { parallel }) => {
    const sorted = [...searchResult.results].sort((a, b) => relRank[a.relevance] - relRank[b.relevance]);
    const novel = [];
    for (const r of sorted) {
      const key = normURL(r.url);
      if (!key) continue;
      if (seen.has(key)) { dupes.push({ url: r.url, angle: searchResult.angle, dupOf: seen.get(key) }); continue; }
      // High-relevance results still fetch past the budget (CC-faithful); medium/low are dropped.
      if (fetchSlots <= 0 && relRank[r.relevance] >= 1) { budgetDropped.push({ url: r.url, angle: searchResult.angle }); continue; }
      seen.set(key, { angle: searchResult.angle, title: r.title });
      fetchSlots--;
      novel.push(r);
    }
    if (novel.length < searchResult.results.length) {
      await log(searchResult.angle + ": " + novel.length + " novel (" + (searchResult.results.length - novel.length) + " filtered)");
    }
    if (novel.length > 0 && !fetchPhaseMarked) { fetchPhaseMarked = true; await phase("Fetch"); }
    return await parallel(novel.map((source) => async ({ agent }) => {
      fetchLaneCount++;
      const host = hostOf(source.url) || "unknown";
      try {
        const ext = await agent(FETCH_PROMPT(source, searchResult.angle), {
          label: "fetch:" + host, phase: "Fetch", tier: TIER_EXTRACT, schema: EXTRACT_SCHEMA,
        });
        return {
          url: source.url, title: source.title, angle: searchResult.angle,
          sourceQuality: ext.sourceQuality, publishDate: ext.publishDate,
          claims: ext.claims.map((c) => ({ ...c, sourceUrl: source.url, sourceQuality: ext.sourceQuality })),
        };
      } catch (error) {
        fetchFailures++;
        await log("fetch failed: " + source.url + " — " + (error && error.message ? error.message : String(error)));
        return { url: source.url, title: source.title, angle: searchResult.angle, sourceQuality: "unreliable", publishDate: undefined, claims: [], fetchFailed: true };
      }
    }));
  },
);
tallyPhase("Search", perAngle, (i) => "search:" + (pipelineItems[i] && pipelineItems[i].label ? pipelineItems[i].label : i + 1));

const allSources = [];
for (const item of perAngle) {
  if (!Array.isArray(item)) continue;           // dropped search lane (already tallied)
  for (const s of item) if (s) allSources.push(s);
}
const allClaims = [];
for (const s of allSources) for (const c of s.claims) allClaims.push(c);

// Honesty gate: nothing to research from. Distinguish "web search unavailable/empty" from a
// plausible-but-empty report.
if (allSources.length === 0) {
  return envelope("failed", {
    abortReason: "websearch-unavailable-or-empty",
    summary: "No sources could be gathered: " + searchAgentLanes + " search lane(s) ran, " +
      searchResultCount + " results returned, " + laneCoverage.dropped + " lane(s) dropped. " +
      "Web search may be unavailable in this opencode install (websearch/webfetch are native tools " +
      "but need a working search provider). Retry, or pass seedUrls to research from known sources.",
    findings: [], refuted: [], unverified: [],
    sources: [], openQuestions: [], caveats: "",
    stats: { depth: DEPTH, angles: angles.length, sourcesFetched: 0, claimsExtracted: 0, claimsVerified: 0, confirmed: 0, killed: 0, unverified: 0, afterSynthesis: 0, urlDupes: dupes.length, budgetDropped: budgetDropped.length, fetchFailures, agentCalls: 1 + searchAgentLanes },
    reportMarkdown: null, truncatedFindings: false, artifacts: null,
  });
}

const impRank = { central: 0, supporting: 1, tangential: 2 };
const qualRank = { primary: 0, secondary: 1, blog: 2, forum: 3, unreliable: 4 };
let rankedClaims = [...allClaims].sort((a, b) =>
  (impRank[a.importance] - impRank[b.importance]) || (qualRank[a.sourceQuality] - qualRank[b.sourceQuality]));
if (P.centralOnly) rankedClaims = rankedClaims.filter((c) => c.importance === "central");
rankedClaims = rankedClaims.slice(0, P.verifyCap);
await log("Fetched " + allSources.length + " sources → " + allClaims.length + " claims → verifying top " + rankedClaims.length);

const sourcesSummary = allSources.map((s) => ({ url: s.url, quality: s.sourceQuality, angle: s.angle, claimCount: s.claims.length }));

if (rankedClaims.length === 0) {
  return envelope("failed", {
    abortReason: "no-claims-extracted",
    summary: "No claims extracted. " + allSources.length + " source(s) fetched (" + fetchFailures + " failed), all empty. " +
      dupes.length + " URL dupes, " + budgetDropped.length + " budget-dropped.",
    findings: [], refuted: [], unverified: [], sources: sourcesSummary, openQuestions: [], caveats: "",
    stats: { depth: DEPTH, angles: angles.length, sourcesFetched: allSources.length, claimsExtracted: 0, claimsVerified: 0, confirmed: 0, killed: 0, unverified: 0, afterSynthesis: 0, urlDupes: dupes.length, budgetDropped: budgetDropped.length, fetchFailures, agentCalls: 1 + searchAgentLanes + fetchLaneCount },
    reportMarkdown: null, truncatedFindings: false, artifacts: null,
  });
}

// ---- Verify: adversarial vote panels (barrier intentional: claim pool fully assembled) ----
await phase("Verify");
const votedRaw = await parallel(rankedClaims.map((claim) => async ({ parallel }) => {
  const verdicts = await parallel(Array.from({ length: P.votes }, (_, v) => async ({ agent }) =>
    agent(VERIFY_PROMPT(claim, v), {
      label: "v" + (v + 1) + ":" + claim.claim.slice(0, 40), phase: "Verify",
      tier: TIER_VERIFY, schema: VERDICT_SCHEMA,
    })));
  // A vote can be null (lane dropped) — treat as no vote cast. Three outcomes; an infra failure
  // must never read as "refuted":
  //   survives  — quorum of valid votes AND fewer than refutesRequired refuting
  //   isRefuted — ≥ refutesRequired refute votes (adjudicated against on merit)
  //   otherwise — unverified: too few valid votes to adjudicate (verifier lanes errored)
  const valid = verdicts.filter(Boolean);
  const refuted = valid.filter((x) => x.refuted).length;
  const errored = P.votes - valid.length;
  const survives = valid.length >= P.refutesRequired && refuted < P.refutesRequired;
  const isRefuted = refuted >= P.refutesRequired;
  const mark = survives ? "✓" : isRefuted ? "✗" : "?";
  await log("\"" + claim.claim.slice(0, 50) + "…\": " + (valid.length - refuted) + "-" + refuted + (errored > 0 ? " (" + errored + " errored)" : "") + " " + mark);
  return { ...claim, verdicts: valid, refutedVotes: refuted, erroredVotes: errored, survives, isRefuted };
}));
tallyPhase("Verify", votedRaw, (i) => "verify:" + (rankedClaims[i] ? rankedClaims[i].claim.slice(0, 30) : i + 1));
const voted = votedRaw.filter(Boolean);

const confirmed = voted.filter((c) => c.survives);
const killed = voted.filter((c) => c.isRefuted);
const unverifiedClaims = voted.filter((c) => !c.survives && !c.isRefuted);
await log("Verify done: " + voted.length + " claims → " + confirmed.length + " confirmed, " + killed.length + " refuted, " + unverifiedClaims.length + " unverified");

const toRefuted = (c) => ({ claim: c.claim, vote: (c.verdicts.length - c.refutedVotes) + "-" + c.refutedVotes, source: c.sourceUrl });
const toUnverified = (c) => ({ claim: c.claim, erroredVotes: c.erroredVotes, validVotes: c.verdicts.length, source: c.sourceUrl });
const statsBase = () => ({
  depth: DEPTH, angles: angles.length, sourcesFetched: allSources.length,
  claimsExtracted: allClaims.length, claimsVerified: voted.length,
  confirmed: confirmed.length, killed: killed.length, unverified: unverifiedClaims.length,
  urlDupes: dupes.length, budgetDropped: budgetDropped.length, fetchFailures,
  agentCalls: 1 + searchAgentLanes + fetchLaneCount + voted.length * P.votes + 1,
});

if (confirmed.length === 0) {
  // Distinguish "refuted on merit" (a legitimate inconclusive research outcome) from "could not
  // verify" (verifier infrastructure failure — the user should retry, not conclude).
  let summary;
  let status;
  let abortReason = null;
  if (killed.length === 0 && unverifiedClaims.length > 0) {
    status = "failed";
    abortReason = "verifiers-failed";
    summary = "Could not verify any claims — all " + unverifiedClaims.length + " verifier panels failed (likely rate-limiting or lane errors). This is an infrastructure failure, not a research finding. Raw extracted claims are preserved in artifacts; retry or verify manually.";
  } else if (unverifiedClaims.length > 0) {
    status = "degraded";
    summary = killed.length + " claim(s) refuted by adversarial verification; " + unverifiedClaims.length + " could not be verified (verifier lanes failed). No claims survived. Research inconclusive.";
  } else {
    status = "ok";
    summary = "All " + killed.length + " claim(s) refuted by adversarial verification. Research inconclusive — sources may be low-quality or claims overstated.";
  }
  return envelope(status, {
    abortReason, summary, findings: [],
    refuted: killed.map(toRefuted), unverified: unverifiedClaims.map(toUnverified),
    sources: sourcesSummary, openQuestions: [], caveats: "",
    stats: { ...statsBase(), afterSynthesis: 0, agentCalls: 1 + searchAgentLanes + fetchLaneCount + voted.length * P.votes },
    reportMarkdown: null, truncatedFindings: false, artifacts: null,
  });
}

// ---- Synthesize ----
await phase("Synthesize");
const confRank = { high: 0, medium: 1, low: 2 };
const confirmedBlock = confirmed.map((c, i) => {
  const best = c.verdicts.filter((v) => !v.refuted).sort((a, b) => confRank[a.confidence] - confRank[b.confidence])[0];
  return "### [" + i + "] " + c.claim + "\n" +
    "Vote: " + (c.verdicts.length - c.refutedVotes) + "-" + c.refutedVotes + " · Source: " + c.sourceUrl + " (" + c.sourceQuality + ")\n" +
    "Quote: \"" + c.quote + "\"\n" +
    "Verifier evidence (" + (best ? best.confidence : "n/a") + "): " + (best ? best.evidence : "none") + "\n";
}).join("\n");
const killedBlock = killed.length > 0
  ? "\n### Refuted claims (for transparency)\n" + killed.map((c) => "- \"" + c.claim + "\" (" + c.sourceUrl + ", vote " + (c.verdicts.length - c.refutedVotes) + "-" + c.refutedVotes + ")").join("\n")
  : "";
const unverifiedBlock = unverifiedClaims.length > 0
  ? "\n### Unverified claims (" + unverifiedClaims.length + " — verifier lanes failed; neither confirmed nor refuted)\n" +
    unverifiedClaims.map((c) => "- \"" + c.claim + "\" (" + c.sourceUrl + ", " + c.erroredVotes + "/" + P.votes + " votes errored)").join("\n") +
    "\n\nMention in caveats that " + unverifiedClaims.length + " claim(s) could not be verified due to infrastructure errors."
  : "";

const report = await agent(
  "## Synthesis: research report\n\n" +
  "**Question:** " + QUESTION + "\n\n" +
  confirmed.length + " claims survived " + P.votes + "-vote adversarial verification. Merge semantic duplicates and synthesize.\n\n" +
  "### Confirmed claims\n" + confirmedBlock + "\n" + killedBlock + unverifiedBlock + "\n\n" +
  "### Instructions\n" +
  "1. Identify claims that say the same thing — merge them, combine their sources.\n" +
  "2. Group related claims into coherent findings. Each finding should directly address the research question.\n" +
  "3. Assign confidence per finding: high (multiple primary sources, unanimous votes), medium (secondary sources or split votes), low (single source or blog-quality).\n" +
  "4. Write a 3-5 sentence executive summary answering the research question.\n" +
  "5. Note caveats: what's uncertain, which sources were weak, what time-sensitivity applies.\n" +
  "6. List 2-4 open questions that emerged but weren't answered.",
  { label: "synthesize", phase: "Synthesize", tier: TIER_SYNTH, schema: REPORT_SCHEMA, readOnly: true, onFailure: "returnNull" },
);

// ---- report rendering (pure JS; no Date — the command stamps the persisted file) ----
function renderMarkdown(rep, refutedList, unverifiedList) {
  const lines = ["# Deep Research: " + QUESTION, "", "## Executive summary", "", rep.summary, "", "## Findings", ""];
  for (const f of rep.findings) {
    lines.push("### " + f.claim);
    lines.push("- **Confidence:** " + f.confidence + (f.vote ? " (vote " + f.vote + ")" : ""));
    lines.push("- **Evidence:** " + f.evidence);
    lines.push("- **Sources:** " + f.sources.join(", "));
    lines.push("");
  }
  if (rep.caveats) lines.push("## Caveats", "", rep.caveats, "");
  if (Array.isArray(rep.openQuestions) && rep.openQuestions.length) {
    lines.push("## Open questions", "");
    for (const q of rep.openQuestions) lines.push("- " + q);
    lines.push("");
  }
  if (refutedList.length) {
    lines.push("## Refuted claims (transparency)", "");
    for (const r of refutedList) lines.push("- \"" + r.claim + "\" — " + r.source + " (vote " + r.vote + ")");
    lines.push("");
  }
  if (unverifiedList.length) {
    lines.push("## Unverified claims (verifier infrastructure errors)", "");
    for (const u of unverifiedList) lines.push("- \"" + u.claim + "\" — " + u.source + " (" + u.validVotes + " valid votes)");
    lines.push("");
  }
  const st = statsBase();
  lines.push("## Method", "",
    "Depth **" + DEPTH + "**: " + st.angles + " search angles, " + st.sourcesFetched + " sources fetched, " +
    st.claimsExtracted + " claims extracted, " + st.claimsVerified + " adversarially verified (" +
    P.votes + " vote(s)/claim), " + st.confirmed + " confirmed / " + st.killed + " refuted / " + st.unverified + " unverified.");
  return lines.join("\n");
}

// ---- size-fit + artifact spill (house pattern: repo-bughunt fitWithinBudget) ----
function utf8ByteLength(value) {
  const s = String(value ?? "");
  let bytes = 0;
  for (let i = 0; i < s.length; i += 1) {
    const code = s.charCodeAt(i);
    if (code <= 0x7f) bytes += 1;
    else if (code <= 0x7ff) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && i + 1 < s.length) {
      const next = s.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) { bytes += 4; i += 1; } else bytes += 3;
    } else bytes += 3;
  }
  return bytes;
}
const jsonUtf8ByteLength = (value) => utf8ByteLength(JSON.stringify(value));

const refutedOut = killed.map(toRefuted);
const unverifiedOut = unverifiedClaims.map(toUnverified);

if (!report) {
  // Synthesis skipped/failed — salvage the verified claims raw rather than discarding the run.
  const salvage = {
    abortReason: "synthesis-failed",
    summary: "Synthesis lane failed — returning " + confirmed.length + " verified claim(s) unmerged.",
    findings: confirmed.map((c) => ({
      claim: c.claim, confidence: "medium", sources: [c.sourceUrl],
      evidence: "Survived " + P.votes + "-vote adversarial verification (vote " + (c.verdicts.length - c.refutedVotes) + "-" + c.refutedVotes + "). Quote: \"" + c.quote + "\"",
      vote: (c.verdicts.length - c.refutedVotes) + "-" + c.refutedVotes,
    })),
    refuted: refutedOut, unverified: unverifiedOut, sources: sourcesSummary,
    openQuestions: [], caveats: "Synthesis failed; findings are unmerged verified claims.",
    stats: { ...statsBase(), afterSynthesis: 0 },
    reportMarkdown: null, truncatedFindings: false, artifacts: null,
  };
  return envelope("degraded", salvage);
}

const reportMarkdown = renderMarkdown(report, refutedOut, unverifiedOut);

const artifactPayload = {
  namespace: "deep-research",
  files: [
    { name: "findings.full.json", content: JSON.stringify({ question: QUESTION, depth: DEPTH, report, confirmed, refuted: refutedOut, unverified: unverifiedOut, sources: sourcesSummary, stats: statsBase() }, null, 2) },
    { name: "sources.json", content: JSON.stringify(sourcesSummary, null, 2) },
    { name: "report.md", content: reportMarkdown },
  ],
};
let artifacts = null;
try {
  const persisted = await persistArtifacts(artifactPayload);
  artifacts = { ok: persisted.ok === true, dir: persisted.dir ?? null, files: (persisted.files ?? []).map((f) => f.name ?? f) };
  if (!artifacts.ok) await log("artifact persistence failed: " + (persisted.error ?? "unknown"));
} catch (error) {
  artifacts = { ok: false, dir: null, files: [] };
  await log("artifact persistence failed: " + (error && error.message ? error.message : String(error)));
}

const finalStatus = laneCoverage.dropped > 0 ? "degraded" : "ok";
function fitWithinBudget() {
  const LIMIT = 230000; // headroom under MAX_RESULT_BYTES (262144) for the host result wrapper
  let findingsOut = report.findings;
  let truncated = false;
  let md = reportMarkdown;
  const build = () => envelope(finalStatus, {
    summary: report.summary, findings: findingsOut,
    refuted: refutedOut, unverified: unverifiedOut, sources: sourcesSummary,
    openQuestions: report.openQuestions ?? [], caveats: report.caveats ?? "",
    stats: { ...statsBase(), afterSynthesis: report.findings.length },
    reportMarkdown: md, truncatedFindings: truncated, artifacts,
  });
  if (jsonUtf8ByteLength(build()) > LIMIT) md = null;
  while (jsonUtf8ByteLength(build()) > LIMIT && findingsOut.length > 5) {
    findingsOut = findingsOut.slice(0, Math.ceil(findingsOut.length / 2));
    truncated = true;
  }
  return build();
}
return fitWithinBudget();
```

- [ ] **Step 4: Run the contract test to verify it passes**

Run: `node --test tests/deep-research-contract.test.mjs`
Expected: PASS (2 tests).

- [ ] **Step 5: Update packaging + publish-completeness (workflow half) — keep the suite green**

`package.json` `files[]` (currently `opencode-workflows.js`, `workflow-kernel/`, `skills/`, `docs/workflow-plugin.md`, README/community files): add `"workflows/",` after `"workflow-kernel/",`.

`tests/publish-completeness.test.mjs`:

(a) L35-39 — the runtime-asset-dirs test now covers workflows:

```js
test("files[] ships every runtime-loaded asset dir", () => {
  for (const dir of ["skills/", "workflows/"]) {
    assert.ok(pkg.files.includes(dir), `files[] must include ${dir}`);
  }
});
```

(b) L113-118 — replace the zero-bundled test:

```js
test("the plugin ships exactly one bundled workflow (deep-research) and no bundled commands yet", () => {
  // 0.3.0 deliberately reverses the 0.2.0 zero-bundled stance for exactly one flagship
  // workflow (see CHANGELOG). Task 4 of the same release adds the bundled command; this
  // test's command half flips there.
  assert.equal(existsSync(new URL("workflows/", root)), true);
  assert.deepEqual(
    readdirSync(fileURLToPath(new URL("workflows/", root))).sort(),
    ["deep-research.js"],
  );
  assert.ok((pkg.files ?? []).includes("workflows/"), "files[] must ship workflows/");
  assert.equal(existsSync(new URL("commands/", root)), false);
  assert.equal((pkg.files ?? []).includes("commands/"), false);
});
```

Add `readdirSync` to the existing `node:fs` import at L3.

(c) L125-141 — the npm-pack offenders test: remove `p.startsWith("workflows/")` from the offenders filter and instead assert inclusion:

```js
  const offenders = files.filter(
    (p) =>
      p.startsWith("workflow-domains/") ||
      p.startsWith("commands/") ||
      p.startsWith("skills/repo-review-command-protocol") ||
      p.startsWith("skills/beads-drain"),
  );
  assert.deepEqual(offenders, [], `tarball must not ship domain extension assets, found: ${offenders.join(", ")}`);
  assert.ok(files.includes("workflows/deep-research.js"), "tarball must ship the bundled deep-research workflow");
  assert.ok(files.includes("SECURITY.md"), "tarball must ship SECURITY.md");
```

- [ ] **Step 6: Full suite + commit**

Run: `node --test tests/*.test.mjs`
Expected: all pass.

```bash
git add workflows/deep-research.js tests/deep-research-contract.test.mjs package.json tests/publish-completeness.test.mjs
git commit -m "feat: bundle the deep-research workflow (first bundled workflow)"
```

---

### Task 3: E2E behavior suite

**Files:**
- Create: `tests/deep-research-workflow.test.mjs`

**Interfaces:**
- Consumes: Task 2's bundled file (resolved by name), prompt marker headers, envelope contract; harness `makeHarness(promptFn, options)` returning `{ tools, context, directory, calls }` (`tests/helpers/harness.mjs:118-199`); fingerprint seam `pluginContext.__workflowServerHealth` (`tests/workflow-run.test.mjs:279-317`); approval dance `preview.match(/approvalHash: ([a-f0-9]{64})/)` then re-execute with `{ ...request, approve: true, approvalHash }` (`tests/model-tiering.test.mjs:92-96`); completion `output.match(/Workflow ([0-9a-f-]{36}) completed/)` (`tests/sandbox-executor.test.mjs:243`).

**Global-shadowing guard:** name resolution searches project → global → extension → bundled. To keep the suite hermetic on machines whose *global* registry might contain a `deep-research.js`, the test file must pin the global dir to an empty temp dir **before** the kernel loads. Check how `GLOBAL_WORKFLOW_DIR` is computed (`workflow-kernel/constants.js:26-43`, env `OPENCODE_WORKFLOWS_DIR`): it is read at module import, so set the env var at the very top of the test file and use **dynamic imports** for the harness/kernel below it. If an existing test already solves this differently (`grep -rn "OPENCODE_WORKFLOWS_DIR" tests/`), mirror that pattern instead.

- [ ] **Step 1: Write the test file**

```js
// Env pin MUST precede any kernel import (GLOBAL_WORKFLOW_DIR is computed at module load).
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
process.env.OPENCODE_WORKFLOWS_DIR = await fs.mkdtemp(path.join(os.tmpdir(), "dr-empty-global-"));

const test = (await import("node:test")).default;
const assert = (await import("node:assert/strict")).default;
const { makeHarness } = await import("./helpers/harness.mjs");
const { __resetFingerprintCacheForTests } = await import("../workflow-kernel/server-fingerprint.js");

const OK_HEALTH = { data: { healthy: true, version: "1.17.13" } };
let serverSeq = 0;

// ---- scripted child-session responder ----
function textOf(input) {
  const parts = input?.body?.parts ?? [];
  return parts.map((p) => (typeof p?.text === "string" ? p.text : "")).join("\n");
}
function jsonResponse(value) {
  return { data: { parts: [{ type: "text", text: JSON.stringify(value) }], info: {} } };
}

const DEFAULT_SCOPE = {
  question: "test question",
  summary: "two angles",
  angles: [
    { label: "alpha", query: "alpha query", rationale: "broad" },
    { label: "beta", query: "beta query", rationale: "skeptical" },
    { label: "gamma", query: "gamma query", rationale: "technical" },
  ],
};
const DEFAULT_SEARCH = (text) => {
  const angle = /## Web Searcher: (\w+)/.exec(text)?.[1] ?? "x";
  return {
    results: [
      { url: `https://site-${angle}.example/a`, title: `${angle} A`, snippet: "s", relevance: "high" },
      { url: `https://site-${angle}.example/b`, title: `${angle} B`, snippet: "s", relevance: "medium" },
    ],
  };
};
const DEFAULT_EXTRACT = {
  sourceQuality: "secondary",
  publishDate: "2026-01-01",
  claims: [
    { claim: "widgets frobnicate", quote: "widgets frobnicate daily", importance: "central" },
    { claim: "gadgets rotate", quote: "gadgets rotate weekly", importance: "supporting" },
  ],
};
const DEFAULT_VERDICT = { refuted: false, evidence: "independently corroborated", confidence: "high" };
const DEFAULT_REPORT = {
  summary: "Widgets frobnicate.",
  findings: [{ claim: "widgets frobnicate", confidence: "high", sources: ["https://site-alpha.example/a"], evidence: "verified", vote: "3-0" }],
  caveats: "none",
  openQuestions: ["why do gadgets rotate?"],
};

// Error-injection fixtures MUST avoid wording that matches TRANSIENT_ERROR_PATTERNS
// (workflow-kernel/errors.js:82-98 — "rate limit", "429", "timeout", "ECONNRESET", …):
// a transient-classed lane error is retried (DEFAULT_RETRY_COUNT = 1, constants.js:99),
// which doubles child-session counts and breaks call-count assertions. "crashed"/"exploded"
// are safely terminal.
function scriptedResponder(overrides = {}) {
  return async (input) => {
    const text = textOf(input);
    if (text.includes("## Deep-Research Scope")) {
      const v = overrides.scope ?? DEFAULT_SCOPE;
      if (v instanceof Error) throw v;
      return jsonResponse(v);
    }
    if (text.includes("## Web Searcher:")) {
      const v = (overrides.search ?? DEFAULT_SEARCH)(text);
      if (v instanceof Error) throw v;
      return jsonResponse(v);
    }
    if (text.includes("## Source Extractor")) {
      const v = overrides.extract ? overrides.extract(text) : DEFAULT_EXTRACT;
      if (v instanceof Error) throw v;
      return jsonResponse(v);
    }
    if (text.includes("## Adversarial Claim Verifier")) {
      const v = overrides.verdict ? overrides.verdict(text) : DEFAULT_VERDICT;
      if (v instanceof Error) throw v;
      return jsonResponse(v);
    }
    if (text.includes("## Synthesis: research report")) {
      const v = overrides.report ?? DEFAULT_REPORT;
      if (v instanceof Error) throw v;
      return jsonResponse(v);
    }
    throw new Error("unexpected child prompt: " + text.slice(0, 160));
  };
}

async function runDeepResearch(responder, { args = { question: "test question" }, request = {} } = {}) {
  __resetFingerprintCacheForTests();
  const serverUrl = `http://deep-research-${serverSeq++}.test`;
  const { tools, context, directory, calls } = await makeHarness(responder, {
    pluginContext: { __workflowServerHealth: OK_HEALTH, serverUrl },
  });
  try {
    const base = { name: "deep-research", args, ...request };
    const preview = await tools.workflow_run.execute(base, context);
    const hash = preview.match(/approvalHash: ([a-f0-9]{64})/);
    assert.ok(hash, `missing approvalHash in preview: ${preview}`);
    const output = await tools.workflow_run.execute({ ...base, approve: true, approvalHash: hash[1] }, context);
    // The kernel generically marks a run FAILED when the returned object carries top-level
    // status:"failed" (DRAIN_FAILURE_STATUSES check, workflow-plugin.js:1068-1071, applied to
    // every workflow at :1279) — deliberate for our honest failure envelopes. Accept both
    // terminal words; the result is readable either way.
    const runId = output.match(/Workflow ([0-9a-f-]{36}) (?:completed|failed)/);
    assert.ok(runId, `run did not finish: ${output}`);
    const status = JSON.parse(await tools.workflow_status.execute({ runId: runId[1], format: "json", detail: "result" }, context));
    // The envelope is the workflow's return value; align the exact field path with an existing
    // detail:"result" consumer (grep -n 'detail: "result"' tests/*.test.mjs) — assumed status.result.output here.
    const result = status.result?.output ?? status.result;
    return { result, calls, preview };
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

test("happy path: envelope, findings, stats, dedupe-free markdown", async () => {
  const { result } = await runDeepResearch(scriptedResponder());
  assert.equal(result.domain, "deep-research");
  assert.equal(result.schemaVersion, 1);
  assert.equal(result.status, "ok");
  assert.equal(result.abortReason, null);
  assert.equal(result.findings.length, 1);
  assert.equal(result.stats.angles, 3);
  assert.equal(result.stats.confirmed > 0, true);
  assert.match(result.reportMarkdown, /# Deep Research: test question/);
  assert.match(result.reportMarkdown, /## Method/);
  assert.equal(result.reportPath, null);
  assert.equal(result.laneCoverage.dropped, 0);
});

test("plain-string args become the question (CC-faithful; requires Task 1's passthrough)", async () => {
  const { result } = await runDeepResearch(scriptedResponder(), { args: "why is the sky blue?" });
  assert.equal(result.question, "why is the sky blue?");
  assert.equal(result.status, "ok");
});

test("JSON-string args are defensively parsed", async () => {
  const { result } = await runDeepResearch(scriptedResponder(), { args: JSON.stringify({ question: "test question", depth: "quick" }) });
  assert.equal(result.stats.depth, "quick");
});

test("missing question returns an explicit failed envelope without spawning lanes", async () => {
  const { result, calls } = await runDeepResearch(scriptedResponder(), { args: {} });
  assert.equal(result.status, "failed");
  assert.equal(result.abortReason, "no-question");
  assert.equal(calls.create.length, 0, "no child session may be created");
});

test("scope failure salvages to an explicit failed envelope", async () => {
  const { result } = await runDeepResearch(scriptedResponder({ scope: new Error("scope lane exploded") }));
  assert.equal(result.status, "failed");
  assert.equal(result.abortReason, "scope-failed");
});

test("all searchers empty → websearch-unavailable failed envelope, not an empty report", async () => {
  const { result } = await runDeepResearch(scriptedResponder({ search: () => ({ results: [] }) }));
  assert.equal(result.status, "failed");
  assert.equal(result.abortReason, "websearch-unavailable-or-empty");
  assert.match(result.summary, /seedUrls/);
});

test("URL dedup: identical URL across angles fetches once; dupes counted", async () => {
  const { result } = await runDeepResearch(scriptedResponder({
    search: () => ({ results: [{ url: "https://www.same.example/page/", title: "same", snippet: "s", relevance: "high" }] }),
  }));
  // 3 angles all return the same URL (www + trailing slash variants must also collapse).
  assert.equal(result.stats.sourcesFetched, 1);
  assert.equal(result.stats.urlDupes, 2);
});

test("fetch budget: medium/low results beyond maxSources are dropped and counted", async () => {
  const manyResults = (text) => {
    const angle = /## Web Searcher: (\w+)/.exec(text)?.[1] ?? "x";
    return {
      results: [1, 2, 3, 4, 5, 6].map((i) => ({
        url: `https://bulk-${angle}.example/${i}`, title: `${angle}-${i}`, snippet: "s",
        relevance: i <= 2 ? "high" : "medium",
      })),
    };
  };
  const { result } = await runDeepResearch(scriptedResponder({ search: manyResults }), {
    args: { question: "test question", maxSources: 3 },
  });
  assert.ok(result.stats.budgetDropped > 0, "must count budget-dropped results");
});

test("quick depth verifies only central claims with 1-vote panels", async () => {
  let verifierCalls = 0;
  const { result } = await runDeepResearch(scriptedResponder({
    verdict: () => { verifierCalls++; return DEFAULT_VERDICT; },
  }), { args: { question: "test question", depth: "quick" } });
  assert.equal(result.stats.depth, "quick");
  // Each fetched source contributes 1 central + 1 supporting claim; quick verifies central only, 1 vote each.
  assert.equal(verifierCalls, result.stats.claimsVerified);
});

test("all claims refuted → ok envelope, zero findings, refuted list (inconclusive on merit)", async () => {
  const { result } = await runDeepResearch(scriptedResponder({
    verdict: () => ({ refuted: true, evidence: "contradicted by primary source", confidence: "high" }),
  }));
  assert.equal(result.status, "ok");
  assert.equal(result.findings.length, 0);
  assert.ok(result.refuted.length > 0);
  assert.match(result.summary, /refuted/);
});

test("verifier infra failure → failed envelope flagged as infrastructure, not refutation", async () => {
  const { result } = await runDeepResearch(scriptedResponder({
    verdict: () => new Error("verifier lane crashed"),
  }));
  assert.equal(result.status, "failed");
  assert.equal(result.abortReason, "verifiers-failed");
  assert.ok(result.unverified.length > 0);
  assert.match(result.summary, /infrastructure/);
});

test("synthesis failure salvages confirmed claims unmerged (degraded)", async () => {
  const { result } = await runDeepResearch(scriptedResponder({ report: new Error("synth exploded") }));
  assert.equal(result.status, "degraded");
  assert.equal(result.abortReason, "synthesis-failed");
  assert.ok(result.findings.length > 0, "verified claims must be salvaged as findings");
});

test("seedUrls are fetched without search lanes when search is empty", async () => {
  const { result } = await runDeepResearch(scriptedResponder({ search: () => ({ results: [] }) }), {
    args: { question: "test question", seedUrls: ["https://seed.example/doc"] },
  });
  assert.equal(result.status, "ok");
  assert.equal(result.stats.sourcesFetched, 1);
});

test("authority narrowing: scope lane denies webfetch/websearch; search lanes allow them", async () => {
  const { calls } = await runDeepResearch(scriptedResponder());
  assert.ok(calls.create.length >= 2, "expected multiple child sessions");
  const ruleAction = (createCall, permission) => {
    const rules = JSON.stringify(createCall);
    const m = new RegExp(`"permission":"${permission}"[^}]*"action":"(allow|deny)"`).exec(rules);
    return m?.[1];
  };
  // The scope lane is the first child created (sequential await before the pipeline).
  assert.equal(ruleAction(calls.create[0], "webfetch"), "deny", "scope lane must be narrowed read-only");
  assert.equal(ruleAction(calls.create[1], "webfetch"), "allow", "search/fetch lanes must carry network authority");
});
```

- [ ] **Step 2: Run the suite**

Run: `node --test tests/deep-research-workflow.test.mjs`
Expected: all 14 tests pass. Any failure here is a bug in Task 2's workflow source or in a test assumption (e.g. the `detail: "result"` field path or permission-rule serialization) — fix the workflow or align the noted assumption with the real shape, keeping the workflow's spec'd behavior fixed.

- [ ] **Step 3: Full suite + commit**

Run: `node --test tests/*.test.mjs`
Expected: all pass.

```bash
git add tests/deep-research-workflow.test.mjs workflows/deep-research.js
git commit -m "test: deep-research E2E behavior suite (scripted child sessions)"
```

---

### Task 4: Bundled command `commands/deep-research.md` + packaging

**Files:**
- Create: `commands/deep-research.md`
- Modify: `tests/extension-command-skill-registration.test.mjs` (append one test)
- Modify: `package.json` (`files[]` — add `"commands/"`)
- Modify: `tests/publish-completeness.test.mjs` (command half of the inversion)

**Interfaces:**
- Consumes: `configureWorkflowEntrypoints(cfg, extensionAssetDirs)` auto-registers `commands/*.md` from `BUNDLED_COMMAND_DIR` with `parseCommandMarkdown` frontmatter description (`workflow-kernel/workflow-plugin.js:277-324`); Task 2's envelope contract and args.
- Produces: `/deep-research` command available in any session with the plugin installed.

- [ ] **Step 1: Write the failing registration test**

Append to `tests/extension-command-skill-registration.test.mjs` (it already imports `configureWorkflowEntrypoints` via `WorkflowPlugin.__test`):

```js
test("the bundled deep-research command registers from BUNDLED_COMMAND_DIR with its frontmatter description", async () => {
  const cfg = {};
  await configureWorkflowEntrypoints(cfg, { workflows: [], commands: [], skills: [] });
  assert.ok(cfg.command["deep-research"], "bundled deep-research command must register");
  assert.match(cfg.command["deep-research"].description, /research/i);
  assert.match(cfg.command["deep-research"].template, /workflow_run/);
  assert.match(cfg.command["deep-research"].template, /name: "deep-research"|name: 'deep-research'|"deep-research"/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/extension-command-skill-registration.test.mjs`
Expected: the new test FAILS (`cfg.command["deep-research"]` undefined — no `commands/` dir yet); pre-existing tests still pass.

- [ ] **Step 3: Create `commands/deep-research.md`**

```markdown
---
description: Deep multi-source research with adversarial fact-checking — runs the bundled deep-research workflow and writes a cited report.
---

# /deep-research

Run the bundled `deep-research` workflow end to end: refine the question, launch with
network authority, wait for the run, persist a cited markdown report, and summarize.

The user's request: $ARGUMENTS

## Protocol

Follow these steps in order. Do not skip the approval preview and do not apply any
repository changes — this command is read-only research plus exactly one report file.

### 1. Clarify the question

If the request is underspecified (e.g. "what car should I buy" with no budget, use-case,
or region), ask 2-3 narrowing questions first and weave the answers into a single,
specific research question. If it is already specific, proceed without asking.

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

Present the approval preview human-first (per the `workflow-plan-review` skill): what it
will do, the model tiers, the lane budget (~97 lanes at thorough), and — the headline —
that the run carries **network authority** (`websearch`/`webfetch`) for its search, fetch,
and verify lanes while scope/synthesize lanes stay read-only. Offer the depth /
`maxSources` / `concurrency` knobs. Then approve by re-issuing the SAME call plus
`approve: true, approvalHash: "<hash from the preview>"` (a name-resolved approval must
re-send the same `name` and `args`).

Optional args: `depth` (default `thorough` — Claude Code parity, 3-vote verification),
`maxSources` (3-30), `seedUrls` (array of known-good URLs; also the fallback when web
search is unavailable). `args` may also be a plain question string.

### 4. Read back

Poll `workflow_status({ runId, detail: "compact" })` while the run progresses. On
completion, read `workflow_status({ runId, detail: "result" })`. The envelope's
`reportMarkdown` holds the rendered report; if it was dropped for size
(`reportMarkdown: null` with `artifacts.ok: true`), read the full `report.md` from the
run's artifacts directory (`artifacts.dir`).

If `status` is `"failed"` with `abortReason: "websearch-unavailable-or-empty"`, tell the
user web search appears unavailable in this opencode install and offer a `seedUrls` retry.
If `abortReason` is `"verifiers-failed"`, tell the user verification infrastructure failed
and offer a retry — do NOT present unverified claims as findings.

### 5. Persist exactly one report

Write the report to `.deep-research/runs/<run-id>-report.md` in the project root,
prefixed with a header: date, question, depth, model tiers, and the
confirmed/refuted/unverified counts from `stats`. Create the directory if needed. When in
a git repository, ensure `.deep-research/` is listed in `.gitignore` (append it if
missing). Write no other files.

### 6. Summarize in chat

Lead with the answer (the executive summary), then confidence spread, notable refuted
claims (transparency), caveats, and the report path.

### 7. Offer follow-ups (do not run them unprompted)

- A deeper pass on one of the report's open questions.
- Re-verifying a specific claim the user doubts.
- Re-running at `thorough` depth if a cheaper depth was used.

End with: `Report-only — nothing applied.`
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/extension-command-skill-registration.test.mjs`
Expected: PASS (all tests including the new one).

- [ ] **Step 5: Packaging + publish-completeness (command half)**

`package.json` `files[]`: add `"commands/",` after `"workflows/",`.

`tests/publish-completeness.test.mjs`:

(a) The Task 2 version of the bundled-assets test becomes its final form:

```js
test("the plugin ships exactly one bundled workflow and one bundled command (deep-research)", () => {
  // 0.3.0 deliberately reversed the 0.2.0 zero-bundled stance for exactly one flagship
  // workflow + command pair (see CHANGELOG 0.3.0). Anything else appearing in these dirs
  // must be a deliberate decision that updates this list.
  assert.equal(existsSync(new URL("workflows/", root)), true);
  assert.deepEqual(
    readdirSync(fileURLToPath(new URL("workflows/", root))).sort(),
    ["deep-research.js"],
  );
  assert.equal(existsSync(new URL("commands/", root)), true);
  assert.deepEqual(
    readdirSync(fileURLToPath(new URL("commands/", root))).sort(),
    ["deep-research.md"],
  );
  assert.ok((pkg.files ?? []).includes("workflows/"), "files[] must ship workflows/");
  assert.ok((pkg.files ?? []).includes("commands/"), "files[] must ship commands/");
});
```

(b) L35-39 asset-dirs test: `["skills/", "workflows/", "commands/"]`.

(c) npm-pack offenders test: remove `p.startsWith("commands/")` from the offenders filter; add

```js
  assert.ok(files.includes("commands/deep-research.md"), "tarball must ship the bundled deep-research command");
```

- [ ] **Step 6: Full suite + commit**

Run: `node --test tests/*.test.mjs`
Expected: all pass.

```bash
git add commands/deep-research.md tests/extension-command-skill-registration.test.mjs package.json tests/publish-completeness.test.mjs
git commit -m "feat: bundle the /deep-research command"
```

---

### Task 5: Docs, stance reframe, CHANGELOG, version 0.3.0

**Files:**
- Modify: `README.md` ("## What you get" bullets at L31-49; "What it is *not*" L52-55; add a "Bundled workflow: deep-research" section after Install)
- Modify: `CHANGELOG.md` (new 0.3.0 section)
- Modify: `package.json` (`"version": "0.3.0"` + `description` — it currently ends "(no bundled workflows)", which 0.3.0 reverses)
- Modify: `skills/opencode-workflow-authoring/SKILL.md` (Edit And Apply paragraph, ~L232-236)
- Modify: `docs/workflow-recipes.md` (the colliding recipe name appears in FOUR places: L208 prose, L263 meta, L463 + L479 invocation examples)

**Interfaces:**
- Consumes: everything shipped in Tasks 1-4. Nothing downstream.

- [ ] **Step 1: README**

(a) In "## What you get" (README.md:31; bullet list ending at the trusted-extension bullet), add before the skills bullet:

```markdown
- One bundled flagship workflow — `deep-research` — plus its `/deep-research`
  command: deep multi-source web research with adversarial fact-checking. It
  doubles as the living gold-standard example of every convention below.
```

(b) Replace the "What it is *not*" first bullet (currently "**It ships zero workflows and zero commands.** This is an engine, not a pack of ready-made automations. You write your own workflow (or install a trusted extension that contributes one) and run it with `workflow_run`."):

```markdown
- **It is an engine, not a pack of automations.** It ships exactly one bundled
  workflow (`deep-research`, with its `/deep-research` command) as the flagship
  exemplar; everything else you write yourself (or install via a trusted
  extension) and run with `workflow_run`.
```

(c) Add a new section after Install:

```markdown
## Bundled workflow: deep-research

Deep multi-source research with adversarial fact-checking: Scope → parallel web
search per angle → URL-dedup + fetch budget → falsifiable-claim extraction →
per-claim adversarial vote panels (3 votes at `thorough`; verifier infrastructure
errors are reported as *unverified*, never as refutations) → cited synthesis.

```
workflow_run({ name: "deep-research", args: "is fish oil effective for ADHD?" })
```

Or with options: `args: { question, depth: "quick" | "normal" | "thorough",
maxSources, seedUrls }`. Depth `thorough` (default) is full 3-vote verification.

The run asks for **network authority** (`websearch`/`webfetch`) at its one-time
approval — search, fetch, and verify lanes use the web; scope and synthesize
lanes narrow themselves to read-only. No shell, no MCP, no edits. The
`/deep-research` command wraps the full flow: clarify → model tiers → approval →
report persisted to `.deep-research/runs/`.
```

Constraint check: `tests/publish-completeness.test.mjs:143-191` verifies every package-local backtick/link reference in README resolves inside the tarball — the section above references no doc paths, and `commands/deep-research.md` ships (Task 4). The "Source Checkout Verification" section regexes (L193-199) must remain untouched.

- [ ] **Step 2: CHANGELOG**

Insert a new release section under `## [Unreleased]` (moving the current Unreleased items into it):

```markdown
## [0.3.0] - 2026-07-09

### Added
- **First bundled workflow: `deep-research`** — deep multi-source web research with
  adversarial claim verification (Scope → Search → Fetch → Verify → Synthesize), depth
  presets (`quick`/`normal`/`thorough`), seed-URL fallback, lane-coverage telemetry,
  artifact spill, and an honest failure taxonomy (websearch-unavailable, verifiers-failed,
  synthesis salvage). Ships with the `/deep-research` command (clarify → tier models →
  approve → persist report). This deliberately reverses 0.2.0's zero-bundled stance for
  exactly one flagship exemplar; the bundled tier remains otherwise empty.
- `meta.whenToUse` — an author-owned, one-line discovery hint surfaced by `workflow_list`
  (Claude Code parity), alongside `category`/`examples`/`notes`.

### Changed
- Plain-string `workflow_run` args that do not look like JSON now pass through to the guest
  verbatim (gated by `meta.argsSchema`); JSON-looking strings still normalize to the object
  they encode, preserving the 0.2.x approval-hash drift fix.
```

followed by the items currently under Unreleased (approve-by-reference, changedFields, smoke-demotion, envelope v3, string-args fix) kept verbatim in their Added/Changed/Fixed subsections, and a fresh empty `## [Unreleased]` above it.

- [ ] **Step 3: package.json version + description**

`"version": "0.2.0"` → `"version": "0.3.0"`.

The `description` field (L4) currently ends `…building, running, and supervising workflows (no bundled workflows).` — replace the parenthetical so shipped metadata matches the new stance:

```json
"description": "opencode plugin providing durable, resumable multi-agent workflow orchestration: the architecture for building, running, and supervising workflows, plus one flagship bundled workflow (deep-research).",
```

- [ ] **Step 4: SKILL.md stance sentence**

In `skills/opencode-workflow-authoring/SKILL.md` (Edit And Apply, currently "The plugin ships zero bundled workflows, so project- and global-saved workflows always stop at `awaiting-diff-approval` and finalize through `workflow_apply`."):

```markdown
The plugin ships one bundled workflow (`deep-research`), which is read-only and
stages no writes. Project- and global-saved workflows always stop at
`awaiting-diff-approval` and finalize through `workflow_apply`.
```

- [ ] **Step 5: workflow-recipes.md collision — ALL FOUR occurrences**

`grep -n "deep-research" docs/workflow-recipes.md` returns exactly four lines; update all of them consistently so the recipe walkthrough never appears to invoke the new bundled workflow with the wrong args shape:

1. L208 prose "graduate to the deep-research recipe" → "graduate to the repo-deep-research recipe".
2. L263 recipe meta `name: "deep-research"` → `name: "repo-deep-research"`.
3. L463 and 4. L479 — the "### Preview and approval" walkthrough's `workflow_run({ name: "deep-research", args: { question, areas, allowExternalDocs }, … })` examples → `name: "repo-deep-research"` (args shape unchanged — it belongs to the repo recipe).

Add immediately above the L261-274 code block:

```markdown
> Naming note: the plugin now bundles a *web* research workflow named
> `deep-research` (see README). This recipe is the repo-local variant —
> save it under a different name, e.g. `repo-deep-research` (used throughout
> this walkthrough).
```

- [ ] **Step 6: Full suite + commit**

Run: `node --test tests/*.test.mjs`
Expected: all pass (publish-completeness README reference checks included).

```bash
git add README.md CHANGELOG.md package.json skills/opencode-workflow-authoring/SKILL.md docs/workflow-recipes.md
git commit -m "docs: 0.3.0 — bundled deep-research stance reframe + version bump"
```

---

### Task 6: Full verification + live smoke (release gate D10)

**Files:** none created; verification only.

- [ ] **Step 1: Full suite, three times if flaky-suspicious**

Run: `node --test tests/*.test.mjs 2>&1 | tail -5`
Expected: `pass` count = baseline 686 + new tests, `fail 0`.

- [ ] **Step 2: Tarball sanity**

Run: `npm pack --dry-run 2>&1 | grep -E "workflows/|commands/"`
Expected: `workflows/deep-research.js` and `commands/deep-research.md` listed.

- [ ] **Step 3: Live smoke protocol (manual, requires a real opencode session — release gate, not a commit gate)**

1. Restart opencode (bundled asset registration happens at plugin load — authoring SKILL.md checklist's last item).
2. In a scratch project: run `/deep-research what is the current LTS version of Node.js?` with `depth: "quick"`.
3. Verify: the approval preview names network authority and the model tiers; the toast breadcrumb walks Scope → Search → Fetch → Verify → Synthesize; the run completes; `.deep-research/runs/<run-id>-report.md` exists with stamped header; the summary cites sources.
4. Negative probe: if the environment has no working search provider, verify the run returns `abortReason: "websearch-unavailable-or-empty"` and the command surfaces the seedUrls fallback rather than an empty report.
5. Record the outcome in the PR/commit message for the release.

- [ ] **Step 4: Hand off for publish**

Publishing to npm (0.3.0) stays manual (operator-owned), per house convention.

---

## Self-Review Notes (kept for the executing agent)

- This plan passed a 4-lane adversarial claim-grounding verification (2026-07-08); the fixes it produced are already folded in: the plain-string args kernel passthrough (Task 1 Steps 5-8 — without it the CC-faithful string-question form throws at plan time), the widened `(?:completed|failed)` terminal regex (the kernel marks runs with top-level `status:"failed"` envelopes as failed runs — deliberate), non-transient error wording in error-injection fixtures (transient-classed messages like "rate limited" get retried, doubling call counts), the four-occurrence recipes rename, the real README heading ("## What you get"), the package.json `description` update, and the 686-test baseline with `> Status:` banners on every new docs/ markdown file.
- The two **checkable assumptions** deliberately left in test code (marked inline): the `workflow_list` JSON entry path (Task 1) and the `workflow_status detail:"result"` output field path (Tasks 1/3). Both carry explicit grep instructions to align with existing consumers before first run — they are assumptions about *test plumbing*, never about the deliverable's behavior.
- Suite stays green at every commit boundary: Task 2 flips only the workflow half of publish-completeness; Task 4 flips the command half.
- The workflow source in Task 2 is the reference implementation: if an E2E test in Task 3 disagrees with it, first re-read spec §4 — the spec wins over both.
