// Cost guardrails + model-tier correctness for the repo-review fan-out
// (bead opencode-workflows-rrev.22). Extends docs/repo-review-leaf-contract.md §16.
//
// Makes the suite's token/cost economics a TESTED CONTRACT rather than prose:
//   A. MODEL-TIER CORRECTNESS — leaves/meta deliberately tier models (fast=finder/recon,
//      deep=skeptic/judge) instead of inheriting one session model. Proven via BOTH the
//      approval-summary/model-plan surface AND the per-lane resolved models
//      (workflow_status detail:"full" -> laneRecords[].model).
//   B. COST-CEILING BEHAVIOR — a maxCost/maxTokens ceiling preserves requested concurrency,
//      and lanes budget-stop GRACEFULLY (onFailure:"returnNull" -> null) so the leaf/meta
//      still returns a coherent partial envelope rather than crashing.
//
// Zero-token: every child session.prompt is routed to a canned payload by the shared harness
// (tests/helpers/repo-review-leaf-harness.mjs -> harness.mjs); no real model is ever called.
//
// Resolution surfaces cited (kernel):
//   - resolveLaneModel (workflow-kernel/authority-policy.js): opts.model > run.modelTiers[tier]
//     > run.defaultChildModel. A tier with no map entry degrades to the session/default model.
//   - approvalSummary "Model plan:" line (workflow-kernel/workflow-plugin.js): the model-plan
//     surface folded into the approval preview.
//   - budgeted runs keep requested concurrency; reserveLaneBudget/releaseLaneBudget bound
//     concurrent admissions under checkBudgetBeforeLaunch (workflow-kernel/budget-accounting.js).
//   - onFailure:"returnNull" (workflow-kernel/child-agent-runner.js): the graceful per-lane
//     budget-stop path.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";

import {
  makeHarness,
  runApprovedRequest,
  resultOutput,
  makeLeafPromptRouter,
  structured,
  assertLeafEnvelope,
} from "./helpers/repo-review-leaf-harness.mjs";

// Distinct fake tier models. The harness ships no provider list, so plan-time model
// availability validation degrades gracefully (any model string passes); this isolates the
// tier-RESOLUTION behavior from provider availability. fast != deep so a tier split is
// observable; neither equals the session model, so blanket inheritance is detectable too.
const FAST_MODEL = "acme/flash";
const DEEP_MODEL = "acme/thinker";
const SESSION_MODEL = "zai-coding-plan/glm-5.2";
const DISTINCT_TIERS = { fast: FAST_MODEL, deep: DEEP_MODEL };

// ---------------------------------------------------------------------------
// Shared prompt routers (canned, zero-token)
// ---------------------------------------------------------------------------

// repo-bughunt happy-path router: recon + 7 category finders (each one finding) + a skeptic
// per candidate. Mirrors tests/repo-bughunt.test.mjs defaultLane. Produces both finder lanes
// (fast tier) and verify/skeptic lanes (deep tier) on the record.
function bughuntRoute(text, shape) {
  if (text.includes("Profile this repository")) {
    return shape({ languages: ["javascript"], notes: "test repo" });
  }
  if (text.includes("bug finder")) {
    const m = text.match(/the "([a-z-]+)" bug finder/);
    const cat = m ? m[1] : "concurrency";
    return shape({ findings: [{
      category: cat, file: `src/${cat}.js`, line: 10, severity: "high",
      description: `${cat} bug example`, reproSketch: "call it with edge input", fixSketch: "guard the path",
      proposedChange: "add a guard", confidence: 80, effort: "small", docImpact: "",
    }] });
  }
  if (text.includes("You are a skeptic")) {
    // Refute exactly the boundary finding so the merge/survive path is exercised; keep the rest.
    const refuted = text.includes("boundary");
    return shape({ refuted, reasoning: "test verdict", adjustedConfidence: refuted ? 10 : 75 });
  }
  return { data: { parts: [], info: {} } };
}
const bughuntRouter = () => makeLeafPromptRouter(bughuntRoute, { fallbackShape: structured });

// repo-review META router: meta shared recon (computed once), complexity domain recon, plus a
// bughunt finder (returns findings) + a bughunt skeptic (keep) so BOTH tiers are exercised
// THROUGH the meta fan-out. Every other leaf finder returns empty findings (fast, no skeptic).
function metaRoute(text, shape) {
  if (text.includes("comprehensive multi-domain review") || text.includes("Profile this repository once")) {
    return shape({ languages: ["javascript"], notes: "meta shared recon", frameworks: ["node"], packageManagers: ["npm"] });
  }
  if (text.includes("for a complexity")) {
    return shape({ profile: "test repo", dirs: ["src"], gitAvailable: false });
  }
  if (text.includes("Profile this repository")) {
    return shape({ languages: ["javascript"], notes: "leaf self recon fallback" });
  }
  if (text.includes("bug finder")) {
    const m = text.match(/the "([a-z-]+)" bug finder/);
    const cat = m ? m[1] : "concurrency";
    return shape({ findings: [{
      category: cat, file: `src/${cat}.js`, line: 10, severity: "high",
      description: `${cat} bug`, reproSketch: "x", fixSketch: "y", proposedChange: "z",
      confidence: 80, effort: "small", docImpact: "",
    }] });
  }
  if (text.includes("You are a skeptic")) {
    return shape({ refuted: false, reasoning: "keep", adjustedConfidence: 80 });
  }
  return shape({ findings: [] });
}
const metaRouter = () => makeLeafPromptRouter(metaRoute, { fallbackShape: structured });

// ---------------------------------------------------------------------------
// Status helpers
// ---------------------------------------------------------------------------

async function runIdFromOutput(output) {
  const match = output.match(/Workflow ([0-9a-f-]{36}) (?:completed|started|awaiting diff approval)/);
  assert.ok(match, `missing run id in output: ${output}`);
  return match[1];
}

// Full run state (carries concurrency, budgetCeilings, laneOutcomes, and per-lane laneRecords
// whose .model is the RESOLVED concrete model and .title is the lane label).
async function fullStatus(tools, context, output) {
  const runId = await runIdFromOutput(output);
  return JSON.parse(await tools.workflow_status.execute({ runId, format: "json", detail: "full" }, context));
}

// Bucket laneRecords by resolved model and by lane ROLE (inferred from the lane label/title the
// engine declares): "recon", "finder" (title starts "find:" or "score:"), "skeptic" ("verify:").
function lanesByModel(laneRecords) {
  const byModel = {};
  const roleOf = (title) => {
    const t = String(title ?? "");
    if (t === "recon" || t === "complexity-recon") return "recon";
    if (t.startsWith("find:") || t.startsWith("score:")) return "finder";
    if (t.startsWith("verify:")) return "skeptic";
    return "other";
  };
  for (const r of (Array.isArray(laneRecords) ? laneRecords : [])) {
    const model = r.model ?? "<none>";
    const role = roleOf(r.title);
    byModel[model] = byModel[model] || { recon: 0, finder: 0, skeptic: 0, other: 0 };
    byModel[model][role] += 1;
  }
  return byModel;
}

// ===========================================================================
// A. MODEL-TIER CORRECTNESS
// ===========================================================================

test("A1. repo-bughunt model-plan surface: distinct modelTiers split fast/deep; absent modelTiers inherit the default", async () => {
  const { tools, context, directory } = await makeHarness(bughuntRouter(), { sessionModel: SESSION_MODEL });
  try {
    // Distinct tiers -> the approval surface reports fast != deep (the tier policy is active).
    const splitPreview = await tools.workflow_run.execute(
      { name: "repo-bughunt", args: { depth: "normal" }, modelTiers: DISTINCT_TIERS },
      context,
    );
    assert.match(splitPreview, new RegExp(`Model plan: fast=${FAST_MODEL.replace("/", "\\/")} deep=${DEEP_MODEL.replace("/", "\\/")}`),
      "distinct modelTiers must surface as a split fast/deep model plan");

    // No tiers -> BOTH lanes degrade to the session/default model (blanket inheritance). This is
    // the explicit no-deviation default, NOT a tier policy.
    const inheritPreview = await tools.workflow_run.execute(
      { name: "repo-bughunt", args: { depth: "normal" } },
      context,
    );
    assert.match(inheritPreview, new RegExp(`Model plan: fast=${SESSION_MODEL.replace("/", "\\/")} deep=${SESSION_MODEL.replace("/", "\\/")}`),
      "absent modelTiers must degrade both tiers to the session model");
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("A2. repo-review meta model-plan surface: distinct modelTiers split fast/deep; absent modelTiers inherit the default", async () => {
  const { tools, context, directory } = await makeHarness(metaRouter(), { sessionModel: SESSION_MODEL });
  try {
    const splitPreview = await tools.workflow_run.execute(
      { name: "repo-review", args: { depth: "normal" }, modelTiers: DISTINCT_TIERS },
      context,
    );
    assert.match(splitPreview, new RegExp(`Model plan: fast=${FAST_MODEL.replace("/", "\\/")} deep=${DEEP_MODEL.replace("/", "\\/")}`));

    const inheritPreview = await tools.workflow_run.execute(
      { name: "repo-review", args: { depth: "normal" } },
      context,
    );
    assert.match(inheritPreview, new RegExp(`Model plan: fast=${SESSION_MODEL.replace("/", "\\/")} deep=${SESSION_MODEL.replace("/", "\\/")}`));
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("A3. repo-bughunt per-lane resolution: recon+finder lanes run on the FAST model; skeptic lanes run on the DEEP model", async () => {
  const { tools, context, directory } = await makeHarness(bughuntRouter(), { sessionModel: SESSION_MODEL });
  try {
    const out = await runApprovedRequest(tools, context,
      { name: "repo-bughunt", args: { depth: "normal" }, modelTiers: DISTINCT_TIERS });
    const full = await fullStatus(tools, context, out);
    const byModel = lanesByModel(full.laneRecords);

    // The FAST model served every recon + finder lane; the DEEP model served every skeptic.
    assert.ok(byModel[FAST_MODEL], "fast-tier model must be present in lane records");
    assert.ok(byModel[DEEP_MODEL], "deep-tier model must be present in lane records");
    assert.ok(byModel[FAST_MODEL].recon + byModel[FAST_MODEL].finder > 0, "recon/finder lanes must resolve to the fast model");
    assert.ok(byModel[FAST_MODEL].skeptic === 0, "no skeptic lane may run on the fast model");
    assert.ok(byModel[DEEP_MODEL].skeptic > 0, "skeptic lanes must resolve to the deep model");
    assert.ok(byModel[DEEP_MODEL].finder === 0 && byModel[DEEP_MODEL].recon === 0, "no recon/finder lane may run on the deep model");

    // No lane inherited the session/default model: the tier policy, not blanket inheritance,
    // resolved every lane (fast != deep != session).
    assert.equal(byModel[SESSION_MODEL], undefined, "no lane may inherit the session model when distinct tiers are supplied");

    // Contrast: without modelTiers, EVERY lane (recon + finder + skeptic) collapses onto the
    // single session/default model — the blanket-inheritance baseline this policy replaces.
    const inheritOut = await runApprovedRequest(tools, context,
      { name: "repo-bughunt", args: { depth: "normal" } });
    const inheritFull = await fullStatus(tools, context, inheritOut);
    const inheritByModel = lanesByModel(inheritFull.laneRecords);
    assert.ok(inheritByModel[SESSION_MODEL], "absent tiers: lanes should run on the session/default model");
    assert.equal(Object.keys(inheritByModel).length, 1, "absent tiers: exactly ONE model serves every lane");
    assert.ok(inheritByModel[SESSION_MODEL].skeptic > 0 && inheritByModel[SESSION_MODEL].finder > 0,
      "absent tiers: BOTH finder and skeptic lanes share the single session model");
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("A4. repo-review meta per-lane resolution: meta recon + finders run FAST; skeptics run DEEP; no lane inherits the session model", async () => {
  const { tools, context, directory } = await makeHarness(metaRouter(), { sessionModel: SESSION_MODEL });
  try {
    const out = await runApprovedRequest(tools, context,
      { name: "repo-review", args: { depth: "normal" }, modelTiers: DISTINCT_TIERS });
    const full = await fullStatus(tools, context, out);
    const byModel = lanesByModel(full.laneRecords);

    // The meta's own shared recon lane (tier "fast") + every nested leaf finder resolved to FAST;
    // the nested bughunt skeptic resolved to DEEP. The split propagates THROUGH the meta fan-out
    // (nested workflow() lanes share the parent run and its modelTiers).
    assert.ok(byModel[FAST_MODEL]?.recon + byModel[FAST_MODEL]?.finder > 0, "meta recon + finders must resolve to the fast model");
    assert.ok(byModel[FAST_MODEL]?.skeptic === 0, "no skeptic lane may run on the fast model");
    assert.ok(byModel[DEEP_MODEL]?.skeptic > 0, "a skeptic lane must resolve to the deep model through the meta fan-out");
    assert.equal(byModel[SESSION_MODEL], undefined, "no lane may inherit the session model when distinct tiers are supplied");
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("A5. all eight leaf engines declare the uniform tier policy (fast=recon/finder, deep=verify) in source", async () => {
  const HERE = new URL(".", import.meta.url);
  const leaves = [
    "repo-bughunt", "repo-security-audit", "repo-test-gaps", "repo-cleanup",
    "repo-modernize", "repo-perf", "repo-complexity", "repo-deps",
  ];
  for (const leaf of leaves) {
    const src = await fs.readFile(new URL(`../workflows/${leaf}.js`, HERE), "utf8");
    // The three tier constants are the contract: bulk work is fast, adversarial verify is deep.
    assert.match(src, /TIER_RECON\s*=\s*"fast"/, `${leaf} must declare TIER_RECON = "fast"`);
    assert.match(src, /TIER_FINDER\s*=\s*"fast"/, `${leaf} must declare TIER_FINDER = "fast"`);
    assert.match(src, /TIER_VERIFY\s*=\s*"deep"/, `${leaf} must declare TIER_VERIFY = "deep"`);
    // Every agent(...) lane routes its tier through one of the three constants (no hard-coded model).
    assert.doesNotMatch(src, /tier:\s*"model"/, `${leaf} must not hard-code a model tier`);
  }
});

// ===========================================================================
// B. COST-CEILING BEHAVIOR
// ===========================================================================

test("B1. a budget ceiling preserves declared concurrency (preview + persisted state)", async () => {
  const { tools, context, directory } = await makeHarness(async () => ({ data: { parts: [], info: {} } }));
  try {
    // repo-bughunt: ceiling present -> declared parallel concurrency is still honored.
    const costPreview = await tools.workflow_run.execute(
      { name: "repo-bughunt", args: { depth: "normal" }, maxCost: 2 },
      context,
    );
    assert.match(costPreview, /Concurrency: 16/);
    assert.match(costPreview, /Budget ceilings: maxCost=2/);

    const tokenPreview = await tools.workflow_run.execute(
      { name: "repo-bughunt", args: { depth: "normal" }, maxTokens: 1000 },
      context,
    );
    assert.match(tokenPreview, /Concurrency: 16/);
    assert.match(tokenPreview, /Budget ceilings: maxCost=none, maxTokens=1000/);

    // repo-bughunt: NO ceiling -> the declared parallel concurrency (16) is honored.
    const freePreview = await tools.workflow_run.execute(
      { name: "repo-bughunt", args: { depth: "normal" } },
      context,
    );
    assert.match(freePreview, /Concurrency: 16/);
    assert.match(freePreview, /Budget ceilings: maxCost=none, maxTokens=none/);

    // repo-review meta: ceiling -> declared parallel concurrency is still honored.
    const metaBudgeted = await tools.workflow_run.execute(
      { name: "repo-review", args: { depth: "normal" }, maxTokens: 1000 },
      context,
    );
    assert.match(metaBudgeted, /Concurrency: 16/);

    const metaFree = await tools.workflow_run.execute(
      { name: "repo-review", args: { depth: "normal" } },
      context,
    );
    assert.match(metaFree, /Concurrency: 16/);

    // Persisted state confirms the requested concurrency actually took effect on an approved run.
    const approvedOut = await runApprovedRequest(tools, context,
      { name: "repo-bughunt", args: { depth: "normal" }, maxTokens: 1000 });
    const full = await fullStatus(tools, context, approvedOut);
    assert.equal(full.concurrency, 16, "an approved budgeted run must persist requested concurrency");
    assert.equal(full.budgetCeilings.maxTokens, 1000);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("B2. repo-bughunt: a lane budget-stops GRACEFULLY — run completes, contract-valid partial envelope, no crash", async () => {
  const { tools, context, directory } = await makeHarness(bughuntRouter(), { sessionModel: SESSION_MODEL });
  try {
    // Tight token ceiling: each mocked lane reports 2 tokens. The ceiling trips partway through
    // the fan-out, so some lanes succeed and the rest budget-stop. onFailure:"returnNull"
    // converts each WorkflowBudgetStoppedError to a null result the engine already tolerates.
    const out = await runApprovedRequest(tools, context,
      { name: "repo-bughunt", args: { depth: "normal" }, maxTokens: 5 });

    // The run does NOT crash: it reaches a terminal state and the budget-stop was handled at the
    // lane level (returnNull), so the run completes rather than failing.
    const full = await fullStatus(tools, context, out);
    assert.ok(["completed", "budget_stopped"].includes(full.status),
      `budgeted run must terminate gracefully, got status=${full.status}`);
    assert.equal(full.concurrency, 16, "budgeted run preserves declared concurrency");
    assert.ok((full.laneOutcomes?.budget_stopped ?? 0) > 0,
      "at least one lane must have budget-stopped (proving the stop fired AND was handled, not swallowed silently)");

    // The leaf still returns a COHERENT partial envelope (contract-valid). Under exhaustion the
    // surviving set may be empty (null skeptic verdicts drop candidates) — both ok and empty are
    // valid partial results; what is forbidden is a crash or a malformed envelope.
    const env = await resultOutput(tools, context, out);
    assertLeafEnvelope(env, "bughunt", { allowEmptyOk: true });
    assert.ok(["ok", "empty", "aborted"].includes(env.status), `unexpected leaf status: ${env.status}`);

    // Contrast: the SAME router with NO ceiling never budget-stops.
    const freeOut = await runApprovedRequest(tools, context,
      { name: "repo-bughunt", args: { depth: "normal" } });
    const freeFull = await fullStatus(tools, context, freeOut);
    assert.equal(freeFull.laneOutcomes?.budget_stopped ?? 0, 0, "no ceiling -> no budget stops");
    assert.equal(freeFull.concurrency, 16, "no ceiling -> declared concurrency is also honored");
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("B3. repo-review meta: a budget stop yields a coherent partial UNIFIED envelope, no crash", async () => {
  const { tools, context, directory } = await makeHarness(metaRouter(), { sessionModel: SESSION_MODEL });
  try {
    // Tight ceiling across the whole meta fan-out. Nested workflow() lanes share the parent run
    // budget; each leaf lane (onFailure:"returnNull") converts a stop to null, and the meta's
    // try/catch around every workflow() call drops a fully-stopped leaf. The merge therefore
    // completes over whatever survived instead of crashing.
    const out = await runApprovedRequest(tools, context,
      { name: "repo-review", args: { depth: "normal" }, maxTokens: 5 });

    const full = await fullStatus(tools, context, out);
    assert.ok(["completed", "budget_stopped"].includes(full.status),
      `budgeted meta run must terminate gracefully, got status=${full.status}`);
    assert.equal(full.concurrency, 16, "budgeted meta run preserves declared concurrency");
    assert.ok((full.laneOutcomes?.budget_stopped ?? 0) > 0,
      "at least one lane must have budget-stopped across the meta fan-out");

    // The meta returns a coherent partial UNIFIED envelope (not a crash). partialCoverage is
    // surfaced when coverage was dropped; counts stay internally consistent regardless.
    const env = await resultOutput(tools, context, out);
    assert.ok(env && typeof env === "object", "meta must return an envelope object");
    assert.equal(env.domain, "repo-review");
    assert.ok(["ok", "empty", "aborted"].includes(env.status), `unexpected meta status: ${env.status}`);
    assert.equal(env.reportPath, null, "meta reportPath must stay null (QuickJS guest cannot write)");
    assert.ok(Array.isArray(env.leafOutcomes), "meta must carry a leafOutcomes ledger even under budget stop");
    const c = env.counts;
    assert.equal(c.total, c.critical + c.high + c.medium + c.low, "counts.total must equal the tier sum under partial coverage");
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
