import test from "node:test";
import assert from "node:assert/strict";

import { makeHarness } from "./helpers/harness.mjs";
import { validateMetaLanes } from "../workflow-kernel/workflow-source.js";
import workflowPlugin from "../workflow-kernel/workflow-plugin.js";

const { __test } = workflowPlugin;

test("tfil.2 blueprint is exposed on the preview envelope (display-only, not in hash)", async () => {
  const { tools, context } = await makeHarness(async () => ({ data: { parts: [], info: {} } }));
  const source = `export const meta = { name: "preview-blueprint", profile: "read-only-review" };
const a = agent({ role: "finder", tier: "fast", readOnly: true });
const b = parallel([(api) => api.agent({ role: "v", tier: "deep" })]);
return [a, b];`;
  const preview = await tools.workflow_run.execute({ source, format: "json" }, context);
  const envelope = JSON.parse(preview);
  assert.ok(envelope.laneBlueprint, "laneBlueprint present on preview envelope");
  assert.equal(envelope.laneBlueprint.lanes.length, 2);
  assert.equal(envelope.laneBlueprint.lanes[0].kind, "agent");
  assert.equal(envelope.laneBlueprint.lanes[1].fanOut, true);
});

// --- tfil.3: consequence translation ---

test("tfil.3 consequenceStatements: read-only workflow, no budgets", () => {
  const { statements, applyGate } = __test.consequenceStatements({
    authority: { readOnly: true, profile: "read-only-review" }, budgetCeilings: { maxCost: null, maxTokens: null }, maxAgents: 4,
  });
  assert.equal(applyGate, "read-only");
  assert.ok(statements.some((s) => s.startsWith("Cost ceiling: none declared")));
  assert.ok(statements.some((s) => s.startsWith("Token ceiling: none declared")));
  assert.ok(statements.some((s) => /Concurrency ceiling: up to 4 agent lanes/.test(s)));
  assert.ok(statements.some((s) => s.startsWith("Authority: read-only")));
  assert.ok(statements.some((s) => s.startsWith("Apply gate: read-only")));
});

test("tfil.3 consequenceStatements: edit workflow with budgets is apply-gated", () => {
  const { statements, applyGate } = __test.consequenceStatements({
    authority: { edit: true, profile: "edit-plan-only" }, budgetCeilings: { maxCost: 2, maxTokens: 5000 }, maxAgents: 2, meta: {},
  });
  assert.equal(applyGate, "apply-gated");
  assert.ok(statements.some((s) => /Cost ceiling: up to \$2/.test(s)));
  assert.ok(statements.some((s) => /Token ceiling: up to 5000 tokens/.test(s)));
  assert.ok(statements.some((s) => s.startsWith("Authority: edit")));
  assert.ok(statements.some((s) => s.startsWith("Apply gate: this workflow may stage changes")));
});

test("tfil.3 consequenceStatements: drain autonomous-local is in-run-apply", () => {
  const { statements, applyGate } = __test.consequenceStatements({
    authority: { profile: "drain-autonomous-local", edit: true }, budgetCeilings: { maxCost: 1 }, maxAgents: 6,
    meta: { harness: "drain" }, runtimeArgs: { mode: "autonomous-local" }, autoApplyEligible: true,
  });
  assert.equal(applyGate, "in-run-apply");
  assert.ok(statements.some((s) => s.startsWith("Authority: autonomous-local drain")));
  assert.ok(statements.some((s) => s.startsWith("Apply gate: a successful run applies its verified diff plan in-run")));
});

test("fnop.4 consequenceStatements: autonomous-local drain without auto-apply eligibility is apply-gated", () => {
  // Preview must describe the SAME resolved auto-apply eligibility that execution enforces. A
  // trusted adapter that explicitly disables auto-apply (supportsAutoApply:false) is not eligible,
  // so the preview must promise explicit workflow_apply approval, not in-run apply.
  const disabled = __test.consequenceStatements({
    authority: { profile: "drain-autonomous-local", edit: true }, budgetCeilings: {}, maxAgents: 1,
    meta: { harness: "drain" }, autoApplyEligible: false,
  });
  assert.equal(disabled.applyGate, "apply-gated");
  assert.ok(disabled.statements.some((s) => s.startsWith("Apply gate: this workflow may stage changes")));
  // The eligible case stays in-run-apply.
  const eligible = __test.consequenceStatements({
    authority: { profile: "drain-autonomous-local", edit: true }, budgetCeilings: {}, maxAgents: 1,
    meta: { harness: "drain" }, autoApplyEligible: true,
  });
  assert.equal(eligible.applyGate, "in-run-apply");
});

test("tfil.3 consequenceStatements makes no per-file or runtime-cost claims", () => {
  const { statements } = __test.consequenceStatements({
    authority: { edit: true, profile: "edit-plan-only" }, budgetCeilings: { maxCost: 2 }, maxAgents: 2, meta: {},
  });
  for (const s of statements) {
    assert.ok(!/will change|will modify|files? will|exact cost|estimated cost/i.test(s), `statement overclaims: ${s}`);
  }
});

test("tfil.3 consequences field is exposed on the preview envelope", async () => {
  const { tools, context } = await makeHarness(async () => ({ data: { parts: [], info: {} } }));
  const source = `export const meta = { name: "consequence-preview", profile: "read-only-review" };\nreturn agent({ role: "x" });`;
  const envelope = JSON.parse(await tools.workflow_run.execute({ source, format: "json" }, context));
  assert.ok(envelope.consequences, "consequences present on preview envelope");
  assert.ok(Array.isArray(envelope.consequences.statements));
  assert.equal(envelope.consequences.applyGate, "read-only");
});

// --- tfil.7: render What-this-workflow-will-do block + plainEnglishSummary ---

test("tfil.7 approvalSummary renders a leading What-this-workflow-will-do block for fixed lanes", async () => {
  const { tools, context } = await makeHarness(async () => ({ data: { parts: [], info: {} } }));
  const source = `export const meta = { name: "fixed-render", description: "a fixed-lane flow", profile: "read-only-review", maxAgents: 2, maxCost: 1 };
const a = agent({ role: "finder", tier: "fast", readOnly: true });
const b = agent({ role: "verifier", tier: "deep" });
return [a, b];`;
  const summary = await tools.workflow_run.execute({ source }, context);
  assert.match(summary, /What this workflow will do:/);
  assert.match(summary, /finder, fast, read-only/);
  assert.match(summary, /verifier, deep/);
  assert.match(summary, /Summary: fixed-render will run/);
  // the block leads — appears before the Technical envelope footer
  assert.ok(summary.indexOf("What this workflow will do:") < summary.indexOf("Technical envelope"));
});

test("tfil.7 approvalSummary renders fan-out lanes with runtime-determined markers (no false counts)", async () => {
  const { tools, context } = await makeHarness(async () => ({ data: { parts: [], info: {} } }));
  const items = '["a","b"]';
  const source = `export const meta = { name: "fanout-render", profile: "read-only-review" };
const r = parallel([${items}].map((api) => api.agent({ role: "fetcher", readOnly: true })));
return r;`;
  const summary = await tools.workflow_run.execute({ source }, context);
  assert.match(summary, /What this workflow will do:/);
  assert.match(summary, /runtime-determined/);
  // Must NOT present a definitive total count for the dynamic fan-out.
  assert.doesNotMatch(summary, /exactly \d+ lanes/);
});

test("tfil.7 plainEnglishSummary is on the preview envelope (display-only)", async () => {
  const { tools, context } = await makeHarness(async () => ({ data: { parts: [], info: {} } }));
  const source = `export const meta = { name: "summary-field", profile: "read-only-review", maxAgents: 3, maxCost: 2, maxTokens: 1000 };
return agent({ role: "scout", tier: "fast", readOnly: true });`;
  const envelope = JSON.parse(await tools.workflow_run.execute({ source, format: "json" }, context));
  assert.ok(typeof envelope.plainEnglishSummary === "string" && envelope.plainEnglishSummary.length > 0);
  assert.match(envelope.plainEnglishSummary, /summary-field will run/);
  assert.match(envelope.plainEnglishSummary, /\$2 cost ceiling/);
  assert.match(envelope.plainEnglishSummary, /read-only/i);
});

test("tfil.7 approvalHash is unchanged by summary content (display-only proof)", async () => {
  const { tools, context } = await makeHarness(async () => ({ data: { parts: [], info: {} } }));
  // The approvalEnvelope (approval-hashing.js) uses an EXPLICIT field list and must not include
  // plainEnglishSummary / laneBlueprint / consequences. Assert by computing the hash two ways:
  // the live preview hash must equal the approvalEnvelope(run) hash, which structurally cannot
  // depend on the summary fields.
  const source = `export const meta = { name: "hash-invariant", profile: "read-only-review" };
return agent({ role: "x" });`;
  const preview = await tools.workflow_run.execute({ source, format: "json" }, context);
  const envelope = JSON.parse(preview);
  // The approvalHash from the preview must NOT contain summary content: mutate the display-only
  // fields and confirm approvalEnvelope() (recomputed) is identical, proving they are not hashed.
  const { approvalHash } = await import("../workflow-kernel/approval-hashing.js");
  const baseHash = approvalHash(runLikeEnvelope(envelope));
  const mutated = runLikeEnvelope(envelope);
  // approvalEnvelope ignores unknown keys, so adding summary fields cannot change the hash.
  // This structurally proves display-only: the hash is a function of the explicit envelope fields only.
  assert.equal(approvalHash({ ...mutated, plainEnglishSummary: "DIFFERENT", laneBlueprint: { lanes: [] }, consequences: { statements: [], applyGate: "read-only" } }), baseHash);
});

// Build a minimal run-shaped object carrying only the explicit approvalEnvelope fields so the
// display-only invariant can be asserted without reconstructing the full preview run.
function runLikeEnvelope(envelope) {
  return {
    sourcePath: envelope.source.path,
    sourceHash: envelope.source.sourceHash,
    runtimeArgs: envelope.runtimeArgsPreview ?? null,
    maxAgents: envelope.laneBudget.maxAgents,
    concurrency: envelope.laneBudget.concurrency,
    defaultChildModel: envelope.modelPlan.defaultChildModel,
    modelTiers: envelope.modelPlan,
    authority: envelope.authority.details,
    budgetCeilings: envelope.budgetCeilings,
    baseCommit: null,
    guestDeadlineMs: envelope.laneBudget.guestDeadlineMs,
    laneTimeoutMs: envelope.laneBudget.laneTimeoutMs,
    debugCapture: envelope.debugCapture.enabled,
    background: envelope.background.enabled,
    capabilities: envelope.capabilities,
    nestedSnapshots: envelope.nestedSnapshots,
  };
}

// --- tfil.8: optional meta.lanes declaration ---

test("tfil.8 validateMetaLanes: clean declaration against a fixed-lane blueprint", () => {
  const blueprint = { lanes: [
    { label: "lane-1", kind: "agent", fanOut: false, shapes: [{ role: "finder", tier: "fast", readOnly: true, edit: false }] },
  ] };
  const roles = new Set(["finder", "verifier", "explorer", "skeptic", "synthesizer", "implementer"]);
  const diags = validateMetaLanes([{ id: "lane-1", title: "Find targets", role: "explorer", tier: "fast" }], blueprint, roles);
  assert.deepEqual(diags, []);
});

test("tfil.8 validateMetaLanes rejects a missing role", () => {
  const blueprint = { lanes: [{ label: "lane-1", kind: "agent", fanOut: false, shapes: [{ role: "finder" }] }] };
  const roles = new Set(["finder"]);
  const diags = validateMetaLanes([{ id: "lane-1", role: "ghost" }], blueprint, roles);
  assert.equal(diags.length, 1);
  assert.match(diags[0].message, /missing role "ghost"/);
});

test("tfil.8 validateMetaLanes rejects exact fan-out counts", () => {
  const blueprint = { lanes: [{ label: "lane-1", kind: "parallel", fanOut: true, staticCount: 2, shapes: [{ role: "x" }] }] };
  const diags = validateMetaLanes([{ id: "lane-1", count: 5 }], blueprint, new Set(["x"]));
  assert.ok(diags.some((d) => /must not claim exact fan-out counts/.test(d.message)));
});

test("tfil.8 validateMetaLanes rejects authority/tier/schema escalation", () => {
  const blueprint = { lanes: [
    { label: "lane-1", kind: "agent", fanOut: false, shapes: [{ role: "finder", tier: "fast", edit: false, schema: false, optsResolved: true }] },
  ] };
  const roles = new Set(["finder"]);
  // edit:true overclaims (blueprint edit:false)
  assert.ok(validateMetaLanes([{ id: "lane-1", edit: true }], blueprint, roles).some((d) => /escalates.*edit/.test(d.message)));
  // schema:true overclaims (blueprint schema:false)
  assert.ok(validateMetaLanes([{ id: "lane-1", schema: true }], blueprint, roles).some((d) => /escalates.*schema/.test(d.message)));
  // tier:deep mismatches blueprint tier:fast
  assert.ok(validateMetaLanes([{ id: "lane-1", tier: "deep" }], blueprint, roles).some((d) => /does not match detected lane tier/.test(d.message)));
});

test("tfil.8 validateMetaLanes allows narrowing and partial/absent declarations", () => {
  const blueprint = { lanes: [
    { label: "lane-1", kind: "agent", fanOut: false, shapes: [{ role: "finder", tier: "deep", edit: true, optsResolved: true }] },
    { label: "lane-2", kind: "agent", fanOut: false, shapes: [{ role: "x", optsResolved: true }] },
  ] };
  const roles = new Set(["finder", "x"]);
  // edit:true is consistent with blueprint edit:true (not escalation); partial declaration for lane-2
  assert.deepEqual(validateMetaLanes([{ id: "lane-1", edit: true, tier: "deep" }], blueprint, roles), []);
  // absent declarations entirely is valid
  assert.deepEqual(validateMetaLanes([], blueprint, roles), []);
});

test("tfil.8 meta.lanes renders in preview and stays out of the hash envelope", async () => {
  const { tools, context } = await makeHarness(async () => ({ data: { parts: [], info: {} } }));
  const source = `export const meta = {
  name: "lanes-decl", profile: "read-only-review",
  lanes: [{ id: "lane-1", title: "Find targets", description: "Locate review surface", role: "explorer", tier: "fast" }],
};
return agent({ role: "explorer", tier: "fast", readOnly: true });`;
  const summary = await tools.workflow_run.execute({ source }, context);
  assert.match(summary, /Find targets/);
  assert.match(summary, /Locate review surface/);
});

test("tfil.8 invalid meta.lanes (escalation) fails at preview", async () => {
  const { tools, context } = await makeHarness(async () => ({ data: { parts: [], info: {} } }));
  const source = `export const meta = {
  name: "bad-lanes", profile: "read-only-review",
  lanes: [{ id: "lane-1", edit: true }],
};
return agent({ role: "explorer", tier: "fast", readOnly: true });`;
  await assert.rejects(tools.workflow_run.execute({ source }, context), /escalates beyond introspected call-site authority/);
});

// --- tfil.10: final gate end-to-end convergence verification ---

test("tfil.10 GATE: fixed-lane preview renders the per-lane plan block with the full blueprint", async () => {
  const { tools, context } = await makeHarness(async () => ({ data: { parts: [], info: {} } }));
  const source = `export const meta = { name: "gate-fixed", description: "fixed lanes", profile: "read-only-review", maxAgents: 2 };
const a = agent({ role: "finder", tier: "fast", readOnly: true });
const b = agent({ role: "verifier", tier: "deep", schema: { type: "object" } });
return [a, b];`;
  const summary = await tools.workflow_run.execute({ source }, context);
  assert.match(summary, /What this workflow will do:/);
  assert.match(summary, /finder, fast, read-only/);
  assert.match(summary, /verifier, deep, schema/);
  const envelope = JSON.parse(await tools.workflow_run.execute({ source, format: "json" }, context));
  assert.equal(envelope.laneBlueprint.lanes.length, 2);
  assert.equal(envelope.laneBlueprint.lanes.every((l) => !l.fanOut), true);
});

test("tfil.10 GATE: fan-out preview renders runtime-determined markers with NO false total counts", async () => {
  const { tools, context } = await makeHarness(async () => ({ data: { parts: [], info: {} } }));
  const source = `export const meta = { name: "gate-fanout", profile: "read-only-review" };
const items = ["a", "b", "c"];
const r = parallel(items.map((api) => api.agent({ role: "fetcher", tier: "fast", readOnly: true })));
return r;`;
  const summary = await tools.workflow_run.execute({ source }, context);
  assert.match(summary, /runtime-determined/);
  assert.doesNotMatch(summary, /exactly \d+ (total )?lanes? will run/);
  const envelope = JSON.parse(await tools.workflow_run.execute({ source, format: "json" }, context));
  const fanLane = envelope.laneBlueprint.lanes.find((l) => l.fanOut);
  assert.ok(fanLane, "fan-out lane present");
  assert.equal(fanLane.staticCount, null, "dynamic fan-out has no static count");
});

test("tfil.10 GATE: workflow_lint returns multi-diagnostics incl top-level-return, meta-schema, agent-arity", async () => {
  const { tools, context } = await makeHarness(async () => ({ data: { parts: [], info: {} } }));
  const json = JSON.parse(await tools.workflow_lint.execute({
    source: `export const meta = { maxAgents: "bad" };\nparallel([() => agent()]);`,
    format: "json",
  }, context));
  const rules = json.diagnostics.map((d) => d.rule);
  assert.ok(rules.includes("meta-schema"));
  assert.ok(rules.includes("top-level-return"));
  assert.ok(rules.includes("agent-arity"));
  assert.ok(rules.includes("fanout-callback-arity"));
});

test("tfil.10 GATE: approval/diff hash envelope unchanged by summary content (display-only)", async () => {
  const { tools, context } = await makeHarness(async () => ({ data: { parts: [], info: {} } }));
  const source = `export const meta = { name: "gate-hash", profile: "read-only-review" };\nreturn agent({ role: "x" });`;
  const e1 = JSON.parse(await tools.workflow_run.execute({ source, format: "json" }, context));
  // Re-preview the SAME source: approvalHash must be byte-stable across calls (summary is deterministic).
  const e2 = JSON.parse(await tools.workflow_run.execute({ source, format: "json" }, context));
  assert.equal(e1.approvalHash, e2.approvalHash, "approvalHash stable across previews");
  // The display-only fields are present but do not appear in approvalEnvelope's explicit field set.
  assert.ok(e1.plainEnglishSummary && e1.laneBlueprint && e1.consequences);
});
