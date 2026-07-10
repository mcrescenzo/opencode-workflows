# Port `repo-bughunt` to the OpenCode Workflow System — Implementation Plan

> Status: **historical implementation plan**. Retained for provenance; the shipped
> bundled workflow described below was later removed from this package during the
> pure-architecture extraction. This file preserves the original implementation
> record; it is not a current package inventory.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Re-create the Claude Code `/repo-bughunt` engine as a native OpenCode bundled workflow (`workflows/repo-bughunt.js`) that fans out parallel bug-finders, adversarially verifies each candidate, and returns a ranked, report-only findings envelope — with full no-token unit tests.

**Architecture:** A single QuickJS guest workflow source using only the kernel's `agent()` / `parallel()` / `phase()` / `log()` primitives. Recon → parallel finders (one per bug-class lens, structured-output schema) → skeptic verification (structured-output schema) → **pure-JS** synthesis (dedup, rank, fingerprint, render markdown). The workflow writes **no files** (the QuickJS guest has no filesystem); it `return`s a structured envelope that the host persists to `result.json`, surfaced via `workflow_status detail:"result"`. Report-only and read-only by construction (`profile: "read-only-review"`). Lanes declare model **intent** (`tier: "fast" | "deep"`) rather than concrete model ids.

**Tech Stack:** OpenCode workflow plugin kernel (`workflow-kernel/`), QuickJS guest sandbox, ajv-validated JSON-Schema structured output, Node's built-in `node --test` harness with a mocked `session.prompt` (zero model tokens).

**Dependency:** This plan is **Piece 2** of the model-tiering work. It consumes the kernel `fast`/`deep` tier resolution + session-model inheritance defined in `docs/superpowers/specs/2026-06-23-session-aware-model-tiering-design.md` (**Piece 1**). Piece 1 must be built first — the `tier:` opt and `modelTiers` arg used below come from it.

## Global Constraints

These apply to **every** task. Values copied verbatim from the kernel investigation.

- **Guest is QuickJS, deterministic.** `Date`, `Date.now`, `Math.random` THROW; `crypto`, `performance`, `setTimeout`/`setInterval`/`clearTimeout`/`clearInterval` are `undefined` (`workflow-plugin.js:1464-1472`). The workflow MUST NOT use any of them. (The Claude Code `repo-bughunt.js` uses none — the djb2 fingerprint and positional `id` are pure — so this is satisfied as long as no new Date/random is introduced.)
- **No imports / single source.** The body is one source string ≤ `MAX_SOURCE_BYTES` = 512 KiB (`workflow-source.js:132-133`). No `import`, no `require`, no `export default`, exactly one `export const meta = {…}` static object literal (`workflow-source.js:30-81`).
- **Returned object ≤ 256 KB.** `MAX_RESULT_BYTES = 262144` (`constants.js:17`); `assertResultSize(output)` throws `Workflow output exceeds 262144 bytes` (`structured-output.js:17-20`, enforced at `workflow-plugin.js:1669`). The returned envelope MUST be size-fitted (see Task 1's `fitWithinBudget`).
- **Lanes declare a tier, not a model.** Each model lane sets `tier: "fast"` (bulk: recon, finders) or `tier: "deep"` (subtle: skeptics); the pure-JS synth uses no model. The kernel resolves `tier → concrete model` from the run's `modelTiers` map, falling back to the session-inherited default (Piece 1). Do NOT hard-code `provider/model` strings or use Claude Code's `'sonnet'`/`'opus'` — those are not configured here (the install has `openai/gpt-5.5` and `zai-coding-plan/glm-5.2`), and concrete selection is the planning agent's job at run time. An explicit `opts.model` remains a valid per-lane escape hatch but is not used by this workflow.
- **Schema lanes fail closed.** `agent({schema})` THROWS `Native structured output is unavailable; schema lanes fail closed in workflow v2` unless `run.capabilities.structuredOutput === "available"` (`workflow-plugin.js:882-884`). The live probe must promote it (Task 0). Tests force it available (`makeHarness` default capabilities).
- **`parallel()` thunks MUST be scoped.** A zero-arg thunk `() => …` has `fn.length === 0` and now fails fast unless the call explicitly passes `{ sequential: true }`; default/rest parameters also count as zero at runtime. For concurrency, thunks MUST take an arg (`(api) => …`, `fn.length >= 1`) and call `api.agent` / `api.parallel`, OR pass `{ scoped: true }` as the options arg. This plan uses arity-1 `(api) => api.agent(...)` thunks everywhere.
- **`agent()` throws on error by default;** returns `null` ONLY with `opts.onFailure === "returnNull"` on a non-cancellation failure (`workflow-plugin.js:1077-1080`). Use `onFailure: "returnNull"` on every lane and `.filter(Boolean)` after every fan-out.
- **No `effort` opt exists** on `agent()` (kernel passes no reasoning-effort through). Drop any effort tiering.
- **Do NOT set `maxCost` / `maxTokens`** in meta/args: a budget ceiling silently forces `concurrency = 1` (`workflow-plugin.js:1894`).
- **Profile `read-only-review`** (`authority-policy.js:16-45`): `{ authority: { readOnly: true }, requiredGates: [] }` — no live-gate preflight, every lane is read-only (edit/bash/network/mcp denied at the OpenCode permission layer, `authority-policy.js:300-334`). This is the correct profile; do NOT request `allowEdits` (it throws on a read-only run, `authority-policy.js:392`).
- **Test runner:** `node --test`. Tests use a mocked `session.prompt`; no `bd`/`git`/network/model tokens required.

---

## Design decisions (resolved during investigation)

These are settled. Listed so the implementer understands *why* the port diverges from the Claude Code source.

1. **File location & discovery:** `workflows/repo-bughunt.js` (the plugin's bundled dir = `BUNDLED_WORKFLOW_DIR`). Discoverable by `name: "repo-bughunt"` (`workflow-source.js:130-172`); slug `repo-bughunt` is valid.
2. **No `runId`/`outDir`/C3/file-write logic.** The Claude Code engine writes `<domain>-report.md` with the synth agent's Write tool. The OpenCode guest CANNOT write files and CANNOT be granted scoped write (edit authority is repo-wide worktree+patch+apply only, `authority-policy.js:315`, `workflow-plugin.js:920-934`). The workflow returns the report **as data**; an optional command wrapper (Task 6) persists it.
3. **Synthesis is pure JS, not an agent.** Dedup/rank/fingerprint/markdown-render are deterministic — done in guest JS (like the Claude Code *meta*'s `buildUnified`). This removes one structured-output dependency, saves tokens, and is fully deterministic. Only **finders** and **skeptics** (and recon) are agents.
4. **Models are tier-resolved, not hard-coded.** Lanes declare `tier: "fast"`/`tier: "deep"`; the kernel maps tier → concrete model via `run.modelTiers`, defaulting to the session-inherited model (Piece 1, `2026-06-23-session-aware-model-tiering-design.md`). The planning agent chooses the concrete `fast`/`deep` models from the available set and passes `modelTiers` at run time; the workflow source carries no model strings.
5. **Return envelope is size-fitted** to stay under 256 KB (drop `reportMarkdown`, then halve findings, until it fits).

---

## File Structure

- **Create:** `workflows/repo-bughunt.js` — the workflow (one self-contained QuickJS source). Sole responsibility: orchestrate recon → find → verify → synthesize and return the findings envelope.
- **Create:** `tests/repo-bughunt.test.mjs` — self-contained `node --test` suite (own minimal harness + routing prompt mock). Sole responsibility: prove the workflow's phases, resilience, determinism, and name-resolution with zero model tokens.
- **Modify:** `package.json` — add a `test:repo-bughunt` script.
- **Create (optional, Task 6):** `commands/repo-bughunt.md` — thin OpenCode command that runs the workflow and writes a markdown report to `.repo-review/` (already gitignored).

---

## Task 0: Spike — verify structured-output capability live (and confirm Piece 1 is in place)

**Prerequisite:** Piece 1 (session-aware model tiering — `docs/superpowers/specs/2026-06-23-session-aware-model-tiering-design.md`) must be implemented and merged first. This workflow's lanes use the `tier:` opt and rely on `modelTiers`/session-default resolution from Piece 1. Before starting, confirm the kernel exposes `tier` resolution and the `workflow_models` tool (a quick `workflow_models` call should return the session model + providers).

**Why a structured-output spike first:** The entire design depends on `agent({schema})` working against the live OpenCode runtime. If the active model/client does not return native structured output (`data.info.structured` or a fallback field, `capability-adapter.js:186-198`), **every finder/skeptic lane throws** and the workflow is useless in production (tests would still pass because they force the capability). This task is a go/no-go gate. It is a manual spike, not a committed unit test.

**Files:** none created. Uses the existing `workflow_run` tool against the real runtime.

- [ ] **Step 1: Run a one-line schema workflow against the live runtime**

Invoke the workflow tool (via the OpenCode agent / `workflow_run`) with this inline source. It spawns ONE schema lane using a `fast` tier (resolved by Piece 1 to the session model):

```js
export const meta = { name: "structured-probe", profile: "read-only-review" };
const r = await agent("Return an object with ok=true and note='hello'.", {
  label: "probe",
  tier: "fast",
  schema: { type: "object", additionalProperties: false, properties: { ok: { type: "boolean" }, note: { type: "string" } }, required: ["ok", "note"] },
  onFailure: "returnNull",
});
return { got: r };
```

- [ ] **Step 2: Inspect the result**

Run `workflow_status` with `detail: "result"` for the run id. Expected PASS: `result.output.got` is an object like `{ ok: true, note: "..." }`.

Expected FAIL signature: the run errors with `Native structured output is unavailable; schema lanes fail closed in workflow v2`, OR `result.output.got` is `null`.

- [ ] **Step 3: Decide**

- If PASS with the session model: proceed; tier resolution (Piece 1) handles model choice per lane.
- If structured output PASSES only on a specific model: that becomes a deviation the planning agent proposes (and the user confirms) when running — note it, but no workflow-source change is needed.
- If FAIL on every available model: STOP and report. The schema-based port is not viable on this runtime without a text-mode fallback (parse the model's prose JSON manually) — that is a different design and out of scope for this plan. Surface this to the user before continuing.

No commit (spike only). Record the outcome in the task notes / handoff.

---

## Task 1: Create the `repo-bughunt` workflow + happy-path test

**Files:**
- Create: `workflows/repo-bughunt.js`
- Create: `tests/repo-bughunt.test.mjs`

**Interfaces:**
- Produces (workflow `return` value, the envelope): `{ domain: "bughunt", schemaVersion: 1, status: "ok"|"empty"|"aborted", abortReason: string|null, reportPath: null, summary: string, counts: { total, critical, high, medium, low }, findings: Finding[], truncatedFindings: boolean, reportMarkdown: string|null }`.
- `Finding`: `{ id, fingerprint, rank, category, file, line, severity, description, reproSketch, fixSketch, proposedChange, confidence, effort, docImpact }`.
- Accepts `args`: `{ paths?: string[], exclude?: string[], depth?: "quick"|"normal"|"thorough", categories?: string[], recon?: object|string, maxReturnFindings?: int }`. (Model selection is NOT an arg of this workflow — lanes declare `tier`; concrete models come from the run's `modelTiers` map, set by the planning agent per Piece 1.)

- [ ] **Step 1: Write the failing happy-path test**

Create `tests/repo-bughunt.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import workflowPlugin from "../opencode-workflows.js";

// ---- self-contained harness (mirrors tests/workflows.test.mjs makeHarness) ----
async function tempDir() {
  return await fs.mkdtemp(path.join(os.tmpdir(), "repo-bughunt-"));
}

// Canonical OpenCode structured-output response shape.
function structured(obj) {
  return { data: { parts: [{ type: "text", text: "ok" }], info: { structured: obj, tokens: { input: 1, output: 1, reasoning: 0 }, cost: 0 } } };
}

// Routes each child prompt to a canned structured payload. No model is ever called.
// override(text) may return a response (or throw) to customize a specific lane.
function bughuntPrompt(override) {
  return async (input) => {
    const text = String(input?.body?.parts?.[0]?.text ?? "");
    if (override) {
      const r = override(text);
      if (r !== undefined) return r;
    }
    if (text.includes("Profile this repository")) {
      return structured({ languages: ["javascript"], notes: "test repo" });
    }
    if (text.includes("bug finder")) {
      const m = text.match(/the "([a-z-]+)" bug finder/);
      const cat = m ? m[1] : "concurrency";
      return structured({ findings: [{
        category: cat, file: `src/${cat}.js`, line: 10, severity: "high",
        description: `${cat} bug example`, reproSketch: "call it with edge input", fixSketch: "guard the path",
        proposedChange: "add a guard", confidence: 80, effort: "small", docImpact: "",
      }] });
    }
    if (text.includes("You are a skeptic")) {
      const refuted = text.includes("boundary"); // refute exactly the boundary finding
      return structured({ refuted, reasoning: "test verdict", adjustedConfidence: refuted ? 10 : 75 });
    }
    return { data: { parts: [], info: {} } };
  };
}

async function makeHarness(prompt) {
  const directory = await tempDir();
  const abort = new AbortController();
  const pluginContext = {
    __workflowCapabilities: {
      childSession: "available", permissions: "available", structuredOutput: "available",
      worktree: "available", directoryRooting: "available", worktreeEditIsolation: "available",
    },
    client: {
      tui: { async showToast() { return { data: true }; } },
      session: {
        async create() { return { data: { id: "child-1" } }; },
        async prompt(input) { return await prompt(input); },
        async abort() { return { data: { ok: true } }; },
      },
      worktree: {
        async create(input) { return { data: { id: "wt-1", path: input.body.path } }; },
        async remove() { return { data: { ok: true } }; },
      },
    },
  };
  const registered = await workflowPlugin(pluginContext);
  return {
    directory,
    tools: registered.tool,
    context: { directory, worktree: directory, sessionID: "p", messageID: "m", agent: "build", abort: abort.signal, metadata() {} },
  };
}

async function runApprovedRequest(tools, context, request) {
  const preview = await tools.workflow_run.execute(request, context);
  const match = preview.match(/approvalHash: ([a-f0-9]{64})/);
  assert.ok(match, `missing approvalHash in preview: ${preview}`);
  return await tools.workflow_run.execute({ ...request, approve: true, approvalHash: match[1] }, context);
}

function runIdFrom(output) {
  const match = output.match(/Workflow ([0-9a-f-]{36}) (?:completed|started|awaiting diff approval)/);
  assert.ok(match, `missing run id in output: ${output}`);
  return match[1];
}

async function resultOutput(tools, context, runOutput) {
  const runId = runIdFrom(runOutput);
  const status = JSON.parse(await tools.workflow_status.execute({ runId, format: "json", detail: "result" }, context));
  assert.equal(status.status, "completed", `run not completed: ${JSON.stringify(status)}`);
  return status.result.output;
}

test("repo-bughunt happy path: finds, verifies, ranks, returns envelope", async () => {
  const { tools, context, directory } = await makeHarness(bughuntPrompt());
  try {
    const out = await runApprovedRequest(tools, context, { name: "repo-bughunt", args: { depth: "normal" } });
    const env = await resultOutput(tools, context, out);

    assert.equal(env.domain, "bughunt");
    assert.equal(env.schemaVersion, 1);
    assert.equal(env.status, "ok");
    // 7 lenses x 1 finding each = 7 candidates; the boundary one is refuted -> 6 survive.
    assert.equal(env.counts.total, 6);
    assert.equal(env.counts.high, 6);
    assert.equal(env.counts.critical, 0);
    assert.ok(env.findings.every((f) => typeof f.fingerprint === "string" && f.fingerprint.startsWith("bughunt-")));
    assert.ok(env.findings.every((f, i) => f.rank === i + 1));
    assert.ok(!env.findings.some((f) => f.category === "boundary"), "refuted boundary finding must be dropped");
    assert.match(env.reportMarkdown, /# Bug Hunt Report/);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/repo-bughunt.test.mjs`
Expected: FAIL — the workflow file does not exist yet, so name resolution errors (`workflow_run` preview cannot resolve `repo-bughunt`).

- [ ] **Step 3: Create the complete workflow file**

Create `workflows/repo-bughunt.js`:

```js
export const meta = {
  name: "repo-bughunt",
  description: "Find correctness bugs across a repo (concurrency, error handling, boundaries, null/empty, resource leaks, API misuse, bad state) and adversarially verify each candidate before reporting. Report-only: returns ranked structured findings; the workflow writes no files.",
  profile: "read-only-review",
  maxAgents: 4096,
  concurrency: 16,
  phases: ["recon", "find", "verify", "synthesize"],
};

// ---- suite identity ----
const DOMAIN = "bughunt";
const SCHEMA_VERSION = 1;

// args may arrive as an object (workflow_run args) or, defensively, a JSON string.
let RT = args;
if (typeof RT === "string") { try { RT = RT.trim() ? JSON.parse(RT) : {}; } catch (_e) { RT = {}; } }
if (!RT || typeof RT !== "object" || Array.isArray(RT)) RT = {};

const paths = Array.isArray(RT.paths) && RT.paths.length ? RT.paths : ["."];
const exclude = Array.isArray(RT.exclude) ? RT.exclude : ["node_modules", "dist", "build", ".git", "vendor", "target", "*.lock", "*.min.*", "*.map"];
const depth = ["quick", "normal", "thorough"].includes(RT.depth) ? RT.depth : "normal";

// Model selection is intent-based: lanes declare a tier; the kernel resolves tier -> concrete model from
// run.modelTiers (set by the planning agent), falling back to the session-inherited default. See
// docs/superpowers/specs/2026-06-23-session-aware-model-tiering-design.md (Piece 1).
// recon + finders = bulk work (fast); skeptics = subtle correctness (deep); synth = pure JS (no model).
const TIER_RECON = "fast";
const TIER_FINDER = "fast";
const TIER_VERIFY = "deep";

const MAX_RETURN_FINDINGS = Number.isInteger(RT.maxReturnFindings) && RT.maxReturnFindings > 0 ? RT.maxReturnFindings : 200;

const ALL_CATEGORIES = ["concurrency", "error-handling", "boundary", "null-empty", "resource-leak", "api-misuse", "bad-state"];
const categories = (Array.isArray(RT.categories) && RT.categories.length ? RT.categories.filter((c) => ALL_CATEGORIES.includes(c)) : ALL_CATEGORIES);

const scope = `Scope: paths = ${JSON.stringify(paths)}. Exclude (do not scan/report): ${JSON.stringify(exclude)}.`;

// ---- standardized return envelope ----
function envelope(status, extra) {
  return { domain: DOMAIN, schemaVersion: SCHEMA_VERSION, status, abortReason: null, reportPath: null, ...extra };
}
const emptyCounts = { total: 0, critical: 0, high: 0, medium: 0, low: 0 };

// ---- shared recon schema (tolerates a prose string via formatRecon) ----
const RECON_SCHEMA = {
  type: "object", additionalProperties: false,
  properties: {
    languages: { type: "array", items: { type: "string" } },
    frameworks: { type: "array", items: { type: "string" } },
    packageManagers: { type: "array", items: { type: "string" } },
    entryPoints: { type: "array", items: { type: "string" } },
    testLayout: { type: "string" },
    buildTooling: { type: "string" },
    concurrencyModel: { type: "string" },
    errorHandling: { type: "string" },
    externalResources: { type: "array", items: { type: "string" } },
    notes: { type: "string" },
  },
  required: ["languages", "notes"],
};
function formatRecon(r) {
  if (typeof r === "string") return r;
  if (!r || typeof r !== "object") return "No recon available.";
  const L = (k, v) => (v && (Array.isArray(v) ? v.length : true) ? `${k}: ${Array.isArray(v) ? v.join(", ") : v}` : null);
  return [
    L("Languages", r.languages), L("Frameworks", r.frameworks), L("Package managers", r.packageManagers),
    L("Entry points", r.entryPoints), L("Test layout", r.testLayout), L("Build tooling", r.buildTooling),
    L("Concurrency model", r.concurrencyModel), L("Error handling", r.errorHandling),
    L("External resources", r.externalResources), L("Notes", r.notes),
  ].filter(Boolean).join("\n");
}

// ---- stable content fingerprint (djb2; deterministic, no crypto) ----
function fingerprintOf(f) {
  const norm = (s) => (s || "").toString().toLowerCase().replace(/\s+/g, " ").trim();
  const basis = `${DOMAIN}|${norm(f.file)}|${norm(f.category)}|${norm(f.description).slice(0, 160)}`;
  let h = 5381;
  for (let i = 0; i < basis.length; i++) h = ((h * 33) ^ basis.charCodeAt(i)) >>> 0;
  return `${DOMAIN}-${h.toString(16)}`;
}

// ---- schemas ----
const FINDINGS_SCHEMA = {
  type: "object", additionalProperties: false,
  properties: {
    findings: {
      type: "array",
      items: {
        type: "object", additionalProperties: false,
        properties: {
          category: { type: "string" },
          file: { type: "string" },
          line: { type: "integer" },
          severity: { type: "string", enum: ["high", "medium", "low"] },
          description: { type: "string" },
          reproSketch: { type: "string" },
          fixSketch: { type: "string" },
          proposedChange: { type: "string" },
          confidence: { type: "integer" },
          effort: { type: "string", enum: ["small", "medium", "large"] },
          docImpact: { type: "string" },
        },
        required: ["category", "file", "line", "severity", "description", "reproSketch", "fixSketch", "proposedChange", "confidence", "effort", "docImpact"],
      },
    },
  },
  required: ["findings"],
};
const VERDICT_SCHEMA = {
  type: "object", additionalProperties: false,
  properties: {
    refuted: { type: "boolean" },
    reasoning: { type: "string" },
    adjustedConfidence: { type: "integer" },
  },
  required: ["refuted", "reasoning", "adjustedConfidence"],
};

// ---- lenses ----
const LENS = {
  "concurrency": "Concurrency/race bugs: data races, unsynchronized shared state, await/async ordering mistakes, missing locks, check-then-act races, deadlock potential, unhandled promise rejections.",
  "error-handling": "Error-handling bugs: swallowed exceptions, errors logged but not handled, wrong error types, missing rollback/cleanup on failure, catch blocks that hide bugs, unchecked return/error codes.",
  "boundary": "Boundary/off-by-one bugs: loop bounds, slice/substring indices, fencepost errors, inclusive/exclusive range mistakes, pagination/limit math.",
  "null-empty": "Null/undefined/empty bugs: dereferencing possibly-null values, missing empty-collection handling, optional chaining gaps, default-value mistakes, NaN/0/\"\" falsy traps.",
  "resource-leak": "Resource leaks: files/sockets/connections/handles not closed, missing finally/defer/with, event listeners not removed, unbounded caches/growth, leaked timers.",
  "api-misuse": "API/contract misuse: wrong argument order/types, ignored required return values, misused library calls, violated preconditions, incorrect lifecycle/ordering of calls.",
  "bad-state": "Incorrect state/mutation: mutating shared/frozen data, stale state after update, invariant violations, incorrect conditional logic, type coercion errors.",
};

function finderPrompt(cat, recon, roundNote) {
  return [
    `You are the "${cat}" bug finder. REPORT-ONLY — do NOT modify files.`,
    scope,
    `Repo profile (recon):\n${formatRecon(recon)}`,
    `Your lens: ${LENS[cat]}`,
    roundNote || "",
    `For EVERY finding set category to exactly "${cat}". Fill reproSketch (how to trigger) and fixSketch. Set confidence honestly. A wrong bug is worse than a missed one.`,
    `Return findings via the structured output.`,
  ].filter(Boolean).join("\n\n");
}

function skepticPrompt(f) {
  return [
    "You are a skeptic. Try to REFUTE the candidate bug below — prove it is NOT a real bug.",
    scope,
    `Candidate (${f.category}) at ${f.file}:${f.line}:`,
    `Description: ${f.description}`,
    `Repro: ${f.reproSketch}`,
    "Investigate with your tools. Consider: is the path reachable? is it already guarded/validated upstream? is the input constrained? is this intended behavior?",
    "Set refuted=true if it is not a real, reachable bug. Default to refuted=true when genuinely uncertain.",
  ].join("\n\n");
}

// ---- 1. Recon (use injected recon if present, else profile once) ----
phase("recon");
const recon = RT.recon
  ? RT.recon
  : await agent(
    ["Profile this repository for review. Return the structured recon fields.", scope,
      "Report: languages/frameworks; package managers; entry points; test layout; build tooling; concurrency model (threads/async/event loop); error-handling conventions; external resources (DB, files, network); and notes on anything that makes a code path reachable with untrusted/edge input.",
      "Explore with your tools."].join("\n\n"),
    { label: "recon", schema: RECON_SCHEMA, tier: TIER_RECON, onFailure: "returnNull" },
  );

// ---- 2. Find + dedup ----
function dedup(findings) {
  const seen = new Set(); const out = [];
  for (const f of findings) {
    if (!f) continue;
    const key = `${f.category}::${(f.file || "").trim()}::${f.line || 0}`;
    if (seen.has(key)) continue;
    seen.add(key); out.push(f);
  }
  return out;
}

async function findRound(roundNote) {
  phase("find");
  // arity-1 thunks (api) => ... so parallel() runs them CONCURRENTLY (zero-arg thunks fail unless { sequential: true } is explicit).
  const results = await parallel(categories.map((cat) => (api) =>
    api.agent(finderPrompt(cat, recon, roundNote), { label: `find:${cat}`, schema: FINDINGS_SCHEMA, tier: TIER_FINDER, onFailure: "returnNull" })));
  return results.filter(Boolean).flatMap((r) => (r.findings || []).map((f) => ({ ...f, category: f.category || "unknown" })));
}

let findings = dedup(await findRound(null));
log(`Round 1: ${findings.length} candidate bugs across ${categories.length} lenses`);

if (depth === "thorough") {
  const known = findings.map((f) => `- ${f.category} ${f.file}:${f.line} — ${f.description}`).join("\n");
  const round2 = await findRound(`SECOND pass. Already found below — find only NEW bugs, do not repeat:\n${known}`);
  findings = dedup(findings.concat(round2));
  log(`After round 2: ${findings.length} candidates`);
}

// positional id (in-run reference) + stable content fingerprint (cross-run dedupe key)
findings = findings.map((f, i) => ({ ...f, id: `${f.category}-${i + 1}`, fingerprint: fingerprintOf(f) }));

if (findings.length === 0) {
  return envelope("empty", { summary: "No bugs found.", counts: emptyCounts, findings: [], truncatedFindings: false, reportMarkdown: null });
}

// ---- 3. Verify (high-FP profile) ----
// quick: high-severity only, 1 skeptic. normal: ALL, 1 skeptic. thorough: ALL, 3-skeptic majority.
let toVerify, votes;
if (depth === "quick") { toVerify = findings.filter((f) => f.severity === "high"); votes = 1; }
else if (depth === "thorough") { toVerify = findings; votes = 3; }
else { toVerify = findings; votes = 1; }
const verifyIds = new Set(toVerify.map((f) => f.id));
const passThrough = findings.filter((f) => !verifyIds.has(f.id));

let verified = passThrough;
if (toVerify.length > 0) {
  phase("verify");
  const checked = await parallel(toVerify.map((f) => (api) => {
    if (votes === 1) {
      return api.agent(skepticPrompt(f), { label: `verify:${f.id}`, schema: VERDICT_SCHEMA, tier: TIER_VERIFY, onFailure: "returnNull" })
        .then((v) => ({ f, keep: !!(v && !v.refuted), conf: v ? v.adjustedConfidence : undefined }));
    }
    return api.parallel([0, 1, 2].map((n) => (inner) =>
      inner.agent(`${skepticPrompt(f)}\n\n(Independent reviewer #${n + 1}.)`, { label: `verify:${f.id}#${n + 1}`, schema: VERDICT_SCHEMA, tier: TIER_VERIFY, onFailure: "returnNull" })))
      .then((vs) => {
        const ok = vs.filter(Boolean);
        const refutedCount = ok.filter((v) => v.refuted).length;
        const avg = ok.length ? Math.round(ok.reduce((s, v) => s + (v.adjustedConfidence || 0), 0) / ok.length) : f.confidence;
        return { f, keep: ok.length > 0 && refutedCount < 2, conf: avg };
      });
  }));
  const survivors = checked.filter(Boolean).filter((c) => c.keep)
    .map((c) => ({ ...c.f, confidence: c.conf != null ? c.conf : c.f.confidence }));
  verified = passThrough.concat(survivors);
  log(`Verified: ${survivors.length}/${toVerify.length} candidates survived; ${verified.length} total`);
}

if (verified.length === 0) {
  return envelope("empty", { summary: "No bugs survived verification.", counts: emptyCounts, findings: [], truncatedFindings: false, reportMarkdown: null });
}

// ---- 4. Synthesize (PURE JS — dedup, rank, render; the host persists the returned object) ----
phase("synthesize");
const SEVW = { high: 3, medium: 2, low: 1 };
const EFFD = { small: 1, medium: 0.8, large: 0.6 };
function score(f) { return (SEVW[f.severity] || 1) * ((f.confidence || 0) / 100) * (EFFD[f.effort] || 0.8); }

const ranked = verified.map((f) => ({ ...f })).sort((a, b) => score(b) - score(a));
ranked.forEach((f, i) => { f.rank = i + 1; });

const counts = {
  total: ranked.length,
  critical: 0,
  high: ranked.filter((f) => f.severity === "high").length,
  medium: ranked.filter((f) => f.severity === "medium").length,
  low: ranked.filter((f) => f.severity === "low").length,
};

function mdCell(s) { return String(s == null ? "" : s).replace(/\|/g, "\\|").replace(/\n+/g, " "); }
function renderMarkdown(rows, c) {
  const lines = [];
  lines.push(`# Bug Hunt Report (${DOMAIN})`, "");
  lines.push("> Report-only. No files were modified and nothing was applied.", "");
  lines.push("## Summary", `- Total: ${c.total} (high: ${c.high}, medium: ${c.medium}, low: ${c.low})`, "");
  lines.push("## Ranked findings", "");
  lines.push("| Rank | Category | Severity | Confidence | Location | Description |");
  lines.push("| ---- | -------- | -------- | ---------- | -------- | ----------- |");
  for (const f of rows) {
    lines.push(`| ${f.rank} | ${mdCell(f.category)} | ${mdCell(f.severity)} | ${f.confidence} | ${mdCell(f.file)}:${f.line || 0} | ${mdCell(f.description).slice(0, 140)} |`);
  }
  lines.push("", "## Detail");
  for (const f of rows) {
    lines.push("", `### ${f.rank}. ${mdCell(f.category)} — ${mdCell(f.file)}:${f.line || 0} (${f.severity}, conf ${f.confidence})`);
    lines.push(`- **What:** ${f.description}`);
    lines.push(`- **Repro:** ${f.reproSketch}`);
    lines.push(`- **Fix sketch:** ${f.fixSketch}`);
    lines.push(`- **Proposed change:** ${f.proposedChange}`);
    if (f.docImpact) lines.push(`- **Doc impact:** ${f.docImpact}`);
    lines.push(`- **Fingerprint:** \`${f.fingerprint}\``);
  }
  return lines.join("\n");
}

// Size-fit to the 256 KB host cap: drop reportMarkdown first, then halve findings, until it fits.
function fitWithinBudget(status, summary) {
  const LIMIT = 230000; // headroom under MAX_RESULT_BYTES (262144) for the {output:...} wrapper + envelope fields
  let returned = ranked.slice(0, MAX_RETURN_FINDINGS);
  let truncated = ranked.length > returned.length;
  let reportMarkdown = renderMarkdown(ranked, counts);
  const sizeOf = () => JSON.stringify(envelope(status, { summary, counts, findings: returned, truncatedFindings: truncated, reportMarkdown })).length;
  if (sizeOf() > LIMIT) reportMarkdown = null;
  while (sizeOf() > LIMIT && returned.length > 10) {
    returned = returned.slice(0, Math.ceil(returned.length / 2));
    truncated = true;
  }
  return envelope(status, { summary, counts, findings: returned, truncatedFindings: truncated, reportMarkdown });
}

const summary = `Found ${counts.total} bug(s): ${counts.high} high, ${counts.medium} medium, ${counts.low} low. Report-only — nothing applied.`;
return fitWithinBudget("ok", summary);
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test tests/repo-bughunt.test.mjs`
Expected: PASS — `repo-bughunt happy path` green (1 test passing).

- [ ] **Step 5: Commit**

```bash
git add workflows/repo-bughunt.js tests/repo-bughunt.test.mjs
git commit -m "feat(opencode-workflows): port repo-bughunt engine as a bundled workflow"
```

---

## Task 2: Verify-phase behavior (refutation drops findings; depth profiles)

**Files:**
- Modify: `tests/repo-bughunt.test.mjs` (add tests)

**Interfaces:**
- Consumes: `makeHarness`, `bughuntPrompt`, `runApprovedRequest`, `resultOutput` from Task 1.

- [ ] **Step 1: Write the failing tests**

Append to `tests/repo-bughunt.test.mjs`:

```js
test("repo-bughunt thorough depth uses 3-skeptic majority (1 refute keeps finding)", async () => {
  // In thorough mode each finding gets 3 skeptics; keep unless >=2 refute. Make ONLY reviewer #1 refute.
  const override = (text) => {
    if (text.includes("You are a skeptic") && text.includes("Independent reviewer #1")) {
      return structured({ refuted: true, reasoning: "lone refute", adjustedConfidence: 10 });
    }
    return undefined; // fall through: reviewers #2/#3 use the default (boundary refuted, others kept)
  };
  const { tools, context, directory } = await makeHarness(bughuntPrompt(override));
  try {
    const out = await runApprovedRequest(tools, context, { name: "repo-bughunt", args: { depth: "thorough" } });
    const env = await resultOutput(tools, context, out);
    // boundary: reviewers #1 (override) + #2/#3 (default refute boundary) => 3 refutes => dropped.
    // every other category: only reviewer #1 refutes => 1 < 2 => kept. 7 lenses, boundary dropped => 6.
    // thorough also runs a 2nd find round (dedup removes the identical repeats) => still 7 candidates.
    assert.equal(env.counts.total, 6);
    assert.ok(!env.findings.some((f) => f.category === "boundary"));
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("repo-bughunt quick depth only verifies high-severity candidates", async () => {
  // All mocked findings are high-severity, so quick verifies all of them; boundary refuted => 6 remain.
  const { tools, context, directory } = await makeHarness(bughuntPrompt());
  try {
    const out = await runApprovedRequest(tools, context, { name: "repo-bughunt", args: { depth: "quick" } });
    const env = await resultOutput(tools, context, out);
    assert.equal(env.counts.total, 6);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run to verify they pass (behavior already implemented in Task 1)**

Run: `node --test tests/repo-bughunt.test.mjs`
Expected: PASS — all 3 tests green. (These exercise existing Task 1 behavior; if either fails, fix the verify logic in `workflows/repo-bughunt.js` until green.)

- [ ] **Step 3: Commit**

```bash
git add tests/repo-bughunt.test.mjs
git commit -m "test(opencode-workflows): cover repo-bughunt verify depth profiles"
```

---

## Task 3: Resilience (lane failure → returnNull) and size-fitting

**Files:**
- Modify: `tests/repo-bughunt.test.mjs` (add tests)

**Interfaces:**
- Consumes: harness helpers from Task 1.

- [ ] **Step 1: Write the failing tests**

Append to `tests/repo-bughunt.test.mjs`:

```js
test("repo-bughunt survives a finder lane failure (onFailure returnNull + filter)", async () => {
  const override = (text) => {
    if (text.includes('the "concurrency" bug finder')) throw new Error("simulated lane crash");
    return undefined;
  };
  const { tools, context, directory } = await makeHarness(bughuntPrompt(override));
  try {
    const out = await runApprovedRequest(tools, context, { name: "repo-bughunt", args: { depth: "normal" } });
    const env = await resultOutput(tools, context, out);
    // concurrency finder crashed -> dropped. 6 lenses produce findings; boundary refuted -> 5 survive.
    assert.equal(env.status, "ok");
    assert.equal(env.counts.total, 5);
    assert.ok(!env.findings.some((f) => f.category === "concurrency"));
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("repo-bughunt returns empty envelope when every candidate is refuted", async () => {
  const override = (text) => {
    if (text.includes("You are a skeptic")) return structured({ refuted: true, reasoning: "all refuted", adjustedConfidence: 5 });
    return undefined;
  };
  const { tools, context, directory } = await makeHarness(bughuntPrompt(override));
  try {
    const out = await runApprovedRequest(tools, context, { name: "repo-bughunt", args: { depth: "normal" } });
    const env = await resultOutput(tools, context, out);
    assert.equal(env.status, "empty");
    assert.equal(env.counts.total, 0);
    assert.equal(env.findings.length, 0);
    assert.equal(env.reportMarkdown, null);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("repo-bughunt size-fits a large finding set under the 256KB cap", async () => {
  // Each finder returns many large findings; the returned envelope must stay serializable (run completes,
  // not aborted by assertResultSize). With many distinct lines, dedup keeps them all.
  const big = "x".repeat(2000);
  const override = (text) => {
    if (text.includes("bug finder")) {
      const m = text.match(/the "([a-z-]+)" bug finder/);
      const cat = m ? m[1] : "concurrency";
      const findings = [];
      for (let i = 0; i < 60; i++) {
        findings.push({
          category: cat, file: `src/${cat}-${i}.js`, line: i + 1, severity: "low",
          description: `${cat} ${i} ${big}`, reproSketch: big, fixSketch: big, proposedChange: big,
          confidence: 50, effort: "large", docImpact: "",
        });
      }
      return structured({ findings });
    }
    if (text.includes("You are a skeptic")) return structured({ refuted: false, reasoning: "keep", adjustedConfidence: 50 });
    return undefined;
  };
  const { tools, context, directory } = await makeHarness(bughuntPrompt(override));
  try {
    const out = await runApprovedRequest(tools, context, { name: "repo-bughunt", args: { depth: "normal", maxReturnFindings: 200 } });
    const env = await resultOutput(tools, context, out);
    assert.equal(env.status, "ok");
    // counts reflect ALL findings (7 lenses x 60 = 420), but the returned findings array is truncated to fit.
    assert.equal(env.counts.total, 420);
    assert.ok(env.truncatedFindings === true);
    assert.ok(JSON.stringify(env).length < 262144, "returned envelope must be under the host result cap");
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run to verify they pass**

Run: `node --test tests/repo-bughunt.test.mjs`
Expected: PASS — all tests green. If the size-fit test aborts the run with `Workflow output exceeds 262144 bytes`, lower the `LIMIT` constant in `fitWithinBudget` (e.g. to `200000`) until it passes.

- [ ] **Step 3: Commit**

```bash
git add tests/repo-bughunt.test.mjs
git commit -m "test(opencode-workflows): cover repo-bughunt resilience and size-fitting"
```

---

## Task 4: Determinism — fingerprint stability unit test (sentinel extraction)

**Why:** The `fingerprintOf` djb2 hash is the cross-run dedupe key and MUST be deterministic and free of disabled built-ins. This test extracts the pure function from the source and verifies it directly, without the harness.

**Files:**
- Modify: `workflows/repo-bughunt.js` (add sentinel comments around `fingerprintOf`)
- Modify: `tests/repo-bughunt.test.mjs` (add test)

**Interfaces:**
- Consumes: the `fingerprintOf` source text between sentinel markers.

- [ ] **Step 1: Add sentinel markers around `fingerprintOf` in the workflow**

In `workflows/repo-bughunt.js`, wrap the existing `fingerprintOf` function with sentinel comments (exact text — the test greps for them):

```js
// <suite:fingerprintOf>
function fingerprintOf(f) {
  const norm = (s) => (s || "").toString().toLowerCase().replace(/\s+/g, " ").trim();
  const basis = `${DOMAIN}|${norm(f.file)}|${norm(f.category)}|${norm(f.description).slice(0, 160)}`;
  let h = 5381;
  for (let i = 0; i < basis.length; i++) h = ((h * 33) ^ basis.charCodeAt(i)) >>> 0;
  return `${DOMAIN}-${h.toString(16)}`;
}
// </suite:fingerprintOf>
```

- [ ] **Step 2: Write the failing test**

Append to `tests/repo-bughunt.test.mjs`:

```js
import { fileURLToPath } from "node:url";

test("fingerprintOf is deterministic and line-independent", async () => {
  const wfPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "workflows", "repo-bughunt.js");
  const src = await fs.readFile(wfPath, "utf8");
  const m = src.match(/\/\/ <suite:fingerprintOf>([\s\S]*?)\/\/ <\/suite:fingerprintOf>/);
  assert.ok(m, "fingerprintOf sentinel block not found");
  // Extract the pure function; supply DOMAIN that the function closes over.
  const fingerprintOf = new Function("DOMAIN", `${m[1]}; return fingerprintOf;`)("bughunt");

  const a = { file: "src/x.js", category: "boundary", description: "Off by one in   loop", line: 10 };
  const b = { file: "./src/x.js", category: "boundary", description: "off by one in loop", line: 999 }; // diff line, normalized desc
  assert.equal(fingerprintOf(a), fingerprintOf({ ...a }), "same input must hash identically");
  assert.match(fingerprintOf(a), /^bughunt-[0-9a-f]+$/);
  // line is excluded from the basis; whitespace/case normalized -> a and b collide by design.
  assert.equal(fingerprintOf({ file: "src/x.js", category: "boundary", description: "off by one in loop" }), fingerprintOf(b));
});
```

- [ ] **Step 3: Run to verify it passes**

Run: `node --test tests/repo-bughunt.test.mjs`
Expected: PASS — fingerprint test green.

- [ ] **Step 4: Commit**

```bash
git add workflows/repo-bughunt.js tests/repo-bughunt.test.mjs
git commit -m "test(opencode-workflows): pin repo-bughunt fingerprint determinism"
```

---

## Task 5: Name-resolution integration + package script

**Files:**
- Modify: `tests/repo-bughunt.test.mjs` (add list/resolution test)
- Modify: `package.json` (add `test:repo-bughunt` script)

- [ ] **Step 1: Write the failing test**

Append to `tests/repo-bughunt.test.mjs`:

```js
test("repo-bughunt is discoverable as a bundled workflow and resolves by name", async () => {
  const { tools, context, directory } = await makeHarness(bughuntPrompt());
  try {
    const listed = JSON.parse(await tools.workflow_list.execute({ format: "json" }, context));
    assert.ok(listed.some((e) => e.scope === "bundled" && e.name === "repo-bughunt"),
      `repo-bughunt not listed as bundled: ${JSON.stringify(listed)}`);

    // Preview by name must resolve the bundled source and show the read-only profile.
    const preview = await tools.workflow_run.execute({ name: "repo-bughunt", args: { depth: "quick" } }, context);
    assert.match(preview, /Authority profile: read-only-review/);
    assert.match(preview, /approvalHash: [a-f0-9]{64}/);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run to verify it passes**

Run: `node --test tests/repo-bughunt.test.mjs`
Expected: PASS — all tests green.

- [ ] **Step 3: Add the package script**

In `package.json`, add this line to `"scripts"` (after the `test:beads-drain` line):

```json
    "test:repo-bughunt": "node --test tests/repo-bughunt.test.mjs",
```

- [ ] **Step 4: Run the named script**

Run: `npm run test:repo-bughunt`
Expected: PASS — the suite runs green via the new script.

- [ ] **Step 5: Run the full suite to confirm no regressions**

Run: `npm test`
Expected: PASS — the existing suites plus the new `repo-bughunt` tests all pass. (Note: some existing suites require `bd`/`git` on PATH per `AGENTS.md`; if those were already passing before this work they should still pass — this change touches none of their code.)

- [ ] **Step 6: Commit**

```bash
git add package.json tests/repo-bughunt.test.mjs
git commit -m "test(opencode-workflows): add repo-bughunt npm script and name-resolution test"
```

---

## Task 6 (optional): Command wrapper to persist a markdown report

**Why optional:** The workflow already returns the report as data (`reportMarkdown` + structured `findings`), surfaced via `workflow_status detail:"result"`. This command writes that markdown to a file for users who want an on-disk report, mirroring Claude Code's `commands/repo-bughunt.md`. The file write happens in the command's agent turn (which has Bash/Write), NOT in the guest.

**Files:**
- Create: `commands/repo-bughunt.md`
- Verify: `.gitignore` already contains `.repo-review/` (confirmed during investigation — no change needed unless absent).

- [ ] **Step 1: Confirm `.repo-review/` is gitignored**

Run: `grep -n "repo-review" .gitignore`
Expected: a line `.repo-review/`. If absent, append it:

```bash
printf '.repo-review/\n' >> .gitignore
```

- [ ] **Step 2: Create the command**

Create `commands/repo-bughunt.md`:

```markdown
---
description: Run the report-only repo-bughunt workflow and save a markdown findings report
agent: build
---

Run the bundled `repo-bughunt` workflow (report-only; read-only authority; nothing is applied).

Use `$ARGUMENTS` as the workflow runtime args only if it is a valid JSON object (e.g. `{ "depth": "normal", "paths": ["src"] }`). If empty, default to `{ "depth": "normal" }`. Valid `depth` values are `quick`, `normal`, `thorough`.

Steps:
1. Call `workflow_run` with `{ name: "repo-bughunt", args: <parsed args> }` to get the approval preview, then re-call with `approve: true` and the `approvalHash` from the preview. Do not set `maxCost`/`maxTokens` (that would force concurrency to 1).
2. Read the result with `workflow_status` using `detail: "result"` and the run id. The returned `output` is the findings envelope: `{ domain, status, summary, counts, findings, truncatedFindings, reportMarkdown }`.
3. If `output.status` is `aborted`, surface `output.abortReason` and stop. If `empty`, report that no bugs survived verification.
4. Otherwise, mint a report path: `mkdir -p .repo-review/runs` and write `output.reportMarkdown` (if non-null) to `.repo-review/runs/<run-id>-bughunt-report.md`. If `reportMarkdown` is null (size-fitted out), render a short markdown summary yourself from `output.findings` and `output.counts` instead.
5. Report to the user: the 5-tier `counts`, the top findings (rank, category, severity, file:line), `truncatedFindings` if true, and the report file path. Make clear NOTHING was applied — this is report-only.
```

- [ ] **Step 3: Sanity-check the command file is well-formed**

Run: `head -5 commands/repo-bughunt.md`
Expected: shows the YAML frontmatter (`description:` and `agent: build`).

- [ ] **Step 4: Commit**

```bash
git add commands/repo-bughunt.md .gitignore
git commit -m "feat(opencode-workflows): add repo-bughunt command wrapper for on-disk reports"
```

---

## Self-Review

**1. Spec coverage** (Claude Code `repo-bughunt.js` + `SUITE-CONTRACT.md` → this plan):
- Recon (shared, schema, tolerant of injected `args.recon`) — Task 1 ✅
- Parallel finders per lens, dedup, optional 2nd round (thorough) — Task 1 ✅
- Adversarial verify with quick/normal/thorough profiles (1 vs 3 skeptics, high-FP default) — Task 1 + Task 2 ✅
- Stable djb2 `fingerprint` (no line; cross-run dedupe key) — Task 1 + determinism test Task 4 ✅
- Standardized return envelope (`domain, schemaVersion, status, abortReason, reportPath, summary, counts(5-tier, critical:0), findings`) — Task 1 ✅
- Report output — **deliberately divergent**: returned as data (`reportMarkdown`) not written by the engine (guest has no fs); optional command persists it — Task 1 + Task 6, documented in Design Decision 2 ✅
- Run-scoping (`runId`/`outDir`/C3) — **intentionally dropped** (no file write); documented in Design Decision 2 ✅
- Model tiers — **adapted to intent-based tiering**: lanes declare `tier: "fast"`/`"deep"`; concrete models resolved by the kernel (Piece 1) from the session-inherited default / `modelTiers`; documented in Global Constraints + Design Decision 4 ✅
- Name discovery as a bundled workflow — Task 5 ✅

**2. Placeholder scan:** No `TBD`/`TODO`/"add error handling"/"similar to Task N". Every code step contains complete code. ✅

**3. Type consistency:** Envelope field names (`domain, schemaVersion, status, abortReason, reportPath, summary, counts, findings, truncatedFindings, reportMarkdown`) are identical across Tasks 1/2/3/5 and the assertions. `fingerprintOf`/`dedup`/`score`/`renderMarkdown`/`fitWithinBudget` names are consistent between the workflow source and the tests. Tier constants `TIER_RECON`/`TIER_FINDER`/`TIER_VERIFY` map to the `tier:` opt on each lane; no concrete model strings in the source. Helper names (`makeHarness`, `bughuntPrompt`, `structured`, `runApprovedRequest`, `resultOutput`, `runIdFrom`) defined once in Task 1 and reused verbatim. ✅

**Known risk carried forward:** Task 0 is a hard gate — if the live runtime does not promote `structuredOutput` to `available` for the configured model, the schema-lane design fails closed in production (tests pass regardless because they force the capability). Resolve Task 0 before relying on real runs.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-06-23-port-repo-bughunt-to-opencode.md`. Two execution options:

**1. Subagent-Driven (recommended)** — dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — execute tasks in this session with checkpoints for review.

Which approach?
