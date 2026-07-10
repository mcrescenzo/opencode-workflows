import test from "node:test";
import assert from "node:assert/strict";

import { makeHarness } from "./helpers/harness.mjs";
import {
  parseWorkflowSource,
  staticNestedWorkflowRefs,
  buildNestedSnapshots,
  metaDiagnostics,
  validateMeta,
  laneBlueprint,
  collectDiagnostics,
} from "../workflow-kernel/workflow-source.js";
import { hash } from "../workflow-kernel/text-json.js";
import { WORKFLOW_INSPECT_TOOLS, WORKFLOW_MUTATING_TOOLS } from "../workflow-kernel/authority-policy.js";

// --- source syntax + nested snapshots ---

test("workflow source help lists drain as an available global", () => {
  assert.throws(
    () => parseWorkflowSource(`export default async function main(){ return true; }`),
    /available globals: .*drain.*line 1, column 1/,
  );
});

test("workflow source syntax errors include line and column context", () => {
  assert.throws(
    () => parseWorkflowSource(`export const meta = { name: "bad" };
const = 1;`),
    /Workflow source parse error: .*line 2, column/,
  );
});

test("parseWorkflowSource rejects stray exports sharing the meta declaration", () => {
  assert.throws(
    () =>
      parseWorkflowSource(
        `export const meta = { name: "x" }, other = 1;\nreturn typeof other;\n`,
      ),
    /additional exports in the same declaration: other/,
  );
  assert.throws(
    () =>
      parseWorkflowSource(
        `export const meta = { name: "x" }, alpha = 1, beta = 2;\nreturn 0;\n`,
      ),
    /additional exports in the same declaration: alpha, beta/,
  );
  const ok = parseWorkflowSource(
    `export const meta = { name: "x" };\nreturn { ok: true };\n`,
  );
  assert.equal(ok.meta.name, "x");
});

test("parseWorkflowSource rejects literal zero-arg fanout callbacks before approval", () => {
  assert.throws(
    () => parseWorkflowSource(`export const meta = { name: "bad-parallel" };
await parallel([
  async () => "x",
  async (api) => api.agent("ok")
]);`),
    /parallel\(\) callback\(s\) at index 0 declare 0 parameters.*line 3, column 3/s,
  );
  assert.throws(
    () => parseWorkflowSource(`export const meta = { name: "bad-default-param" };
await parallel([async (api = {}) => api.agent("x")]);`),
    /Default\/rest parameters.*line 2, column/,
  );
  assert.throws(
    () => parseWorkflowSource(`export const meta = { name: "bad-pipeline" };
await pipeline(["x"], async () => "y");`),
    /pipeline\(\) callback\(s\) at index 0 declare 0 parameters.*line 2, column/s,
  );
});

test("parseWorkflowSource allows explicit sequential fanout and scoped map lane factories", () => {
  const sequential = parseWorkflowSource(`export const meta = { name: "intentional-sequential" };
return await parallel([async () => "x"], { sequential: true });`);
  assert.equal(sequential.meta.name, "intentional-sequential");

  const scopedMap = parseWorkflowSource(`export const meta = { name: "scoped-map" };
const lanes = [1, 2].map((item) => async ({ agent }) => await agent("lane " + item));
return await parallel(lanes);`);
  assert.equal(scopedMap.meta.name, "scoped-map");

  assert.throws(
    () => parseWorkflowSource(`export const meta = { name: "bad-map" };
const lanes = [1, 2].map((item) => async () => item);
return await parallel(lanes);`),
    /parallel\(\) callback\(s\) at index map\(\) declare 0 parameters.*line 2, column/s,
  );
});

test("static nested workflow refs reject dynamic workflow calls", () => {
  assert.throws(
    () => staticNestedWorkflowRefs(`const nestedName = "child";
await workflow(nestedName);`),
    /workflow\(\) nested calls must use a static string name\/source or workflow\(\{ source: "\.\.\." \}\)/,
  );
  assert.throws(
    () => staticNestedWorkflowRefs("await workflow(`child-${suffix}`);"),
    /workflow\(\) nested calls must use a static string name\/source or workflow\(\{ source: "\.\.\." \}\)/,
  );
  assert.deepEqual(staticNestedWorkflowRefs('await workflow("child-workflow");'), ["child-workflow"]);
});

test("static nested workflow refs support explicit object source/name forms and reject dynamic source values", () => {
  assert.deepEqual(staticNestedWorkflowRefs('await workflow({ source: "return 1;", args: { ok: true } });'), ["return 1;"]);
  assert.deepEqual(staticNestedWorkflowRefs('await workflow({ name: "child-workflow", args });'), ["child-workflow"]);
  assert.throws(
    () => staticNestedWorkflowRefs('await workflow({ source: args.childSource });'),
    /workflow\(\{ source \}\) must use a static string literal at line 1, column/,
  );
  assert.throws(
    () => staticNestedWorkflowRefs('await workflow({ source: "return 1;", name: "child" });'),
    /workflow\(\) nested source form must include exactly one static source or name/,
  );
});

test("buildNestedSnapshots treats explicit tiny source form as inline source without newline heuristics", async () => {
  const tiny = "return 1;";
  const parent = `export const meta = { name: "parent" };
await workflow({ source: ${JSON.stringify(tiny)}, args: { value: 1 } });
return true;`;

  const context = { directory: process.cwd() };
  const snapshots = await buildNestedSnapshots(context, parent);
  const tinyHash = hash(tiny);

  assert.equal(snapshots.get(tinyHash)?.source, tiny);
  assert.equal(snapshots.get(tinyHash)?.sourceHash, tinyHash);
  assert.equal(snapshots.has("<inline>"), false);
});

test("buildNestedSnapshots keeps distinct inline nested workflows separate by hash", async () => {
  // Two distinct inline nested workflows both resolve to sourcePath "<inline>".
  // Keying snapshots by that shared sentinel would let the second overwrite the
  // first; both must survive, keyed purely by their content hash.
  const inlineA = `export const meta = { name: "nested-a" };\nreturn "A";\n`;
  const inlineB = `export const meta = { name: "nested-b" };\nreturn "B";\n`;
  const parent = `export const meta = { name: "parent" };
await workflow(${JSON.stringify(inlineA)});
await workflow(${JSON.stringify(inlineB)});
return true;`;

  const context = { directory: process.cwd() };
  const snapshots = await buildNestedSnapshots(context, parent);

  const hashA = hash(inlineA);
  const hashB = hash(inlineB);

  // Both inline snapshots are retrievable by their own hash and carry their own source.
  assert.equal(snapshots.get(hashA)?.source, inlineA);
  assert.equal(snapshots.get(hashB)?.source, inlineB);
  assert.equal(snapshots.get(hashA)?.sourceHash, hashA);
  assert.equal(snapshots.get(hashB)?.sourceHash, hashB);

  // The shared "<inline>" sentinel is NOT a key, so the path-based lookup cannot
  // return a stale snapshot for the wrong inline workflow.
  assert.equal(snapshots.has("<inline>"), false);

  // Replicate runNestedWorkflow's lookup for each inline source: sourcePath is the
  // shared "<inline>" sentinel, so resolution must fall through to the hash key and
  // land on the matching snapshot for each distinct workflow.
  const sourcePath = "<inline>";
  const lookupA = (sourcePath !== "<inline>" && snapshots.get(sourcePath)) || snapshots.get(hashA);
  const lookupB = (sourcePath !== "<inline>" && snapshots.get(sourcePath)) || snapshots.get(hashB);
  assert.equal(lookupA.source, inlineA);
  assert.equal(lookupB.source, inlineB);
  // Neither lookup trips the stale-source guard (snapshot.sourceHash === sourceHash).
  assert.equal(lookupA.sourceHash, hashA);
  assert.equal(lookupB.sourceHash, hashB);
});

// --- tfil.1: meta validation ---

test("tfil.1 validateMeta accepts a rich, fully-populated meta (compatibility)", () => {
  const rich = {
    name: "fixture-rich", description: "x", profile: "read-only-review", harness: "drain",
    maxAgents: 4, concurrency: 2, modelTiers: { fast: "p/m1", deep: "p/m2" },
    childModel: "p/m", defaultChildModel: "p/m", maxCost: 2, maxTokens: 1000,
    maxRuntimeMs: 60000, guestDeadlineMs: 5000, phases: ["Plan", "Done"],
    authority: { readOnly: true }, argsSchema: { type: "object" }, recommendBackground: true,
    category: "review", whenToUse: "use it", notes: "n", examples: ["a"], unknownExtraKey: 123,
  };
  assert.deepEqual(metaDiagnostics(rich), []);
  assert.doesNotThrow(() => validateMeta(rich));
});

test("tfil.1 validateMeta accepts omitted name/description and unknown keys (permissive)", () => {
  assert.deepEqual(metaDiagnostics({ phases: ["a"], customDoc: { x: 1 } }), []);
  assert.doesNotThrow(() => validateMeta({}));
  assert.doesNotThrow(() => validateMeta(null));
});

test("tfil.1 validateMeta rejects wrong types for recognized consumed fields", () => {
  const re = (pattern) => () => validateMeta(pattern);
  assert.throws(re({ maxAgents: "4" }), /maxAgents must be a non-negative integer/);
  assert.throws(re({ maxAgents: -1 }), /maxAgents must be a non-negative integer/);
  assert.throws(re({ concurrency: 1.5 }), /concurrency must be a non-negative integer/);
  assert.throws(re({ maxTokens: -1 }), /maxTokens must be a non-negative integer/);
  assert.throws(re({ maxCost: "x" }), /maxCost must be a finite non-negative number/);
  assert.throws(re({ modelTiers: [] }), /modelTiers must be an object/);
  assert.throws(re({ modelTiers: { fast: 5 } }), /modelTiers.fast must be a string/);
  assert.throws(re({ phases: "Plan" }), /phases must be an array of strings/);
  assert.throws(re({ phases: [1] }), /phases must be an array of strings/);
  assert.throws(re({ authority: "yes" }), /authority must be an object/);
  assert.throws(re({ argsSchema: [] }), /argsSchema must be an object/);
  assert.throws(re({ name: 5 }), /name must be a string/);
  assert.throws(re({ harness: 1 }), /harness must be a string/);
  assert.throws(re({ lanes: "nope" }), /lanes must be an array/);
  assert.throws(re({ recommendBackground: "yes" }), /recommendBackground must be a boolean/);
});

test("tfil.1 validateMeta allows maxAgents: 0 (synchronous single-lane workflows)", () => {
  assert.doesNotThrow(() => validateMeta({ maxAgents: 0, concurrency: 0 }));
});

test("tfil.1 metaDiagnostics is non-throwing and collects multiple at once", () => {
  const diags = metaDiagnostics({ maxAgents: "x", name: 1, phases: [2] });
  const fields = diags.map((d) => d.field).sort();
  assert.deepEqual(fields, ["maxAgents", "name", "phases"]);
});

test("tfil.1 bad meta type fails at preview (workflow_run)", async () => {
  const { tools, context } = await makeHarness(async () => ({ data: { parts: [], info: {} } }));
  const source = `export const meta = { maxAgents: "not-a-number" };\nreturn 1;`;
  await assert.rejects(tools.workflow_run.execute({ source }, context), /maxAgents must be a non-negative integer/);
});

// --- tfil.2: static lane-shape introspection ---

test("tfil.2 laneBlueprint extracts fixed-lane agent call sites with resolved opts", () => {
  const bp = laneBlueprint(`export const meta = { name: "fixed", profile: "read-only-review" };
const a = agent({ role: "finder", tier: "fast", readOnly: true });
const b = agent({ role: "verifier", tier: "deep", schema: { type: "object" } });
return [a, b];`);
  assert.equal(bp.lanes.length, 2);
  assert.equal(bp.lanes[0].kind, "agent");
  assert.equal(bp.lanes[0].fanOut, false);
  assert.equal(bp.lanes[0].shapes[0].role, "finder");
  assert.equal(bp.lanes[0].shapes[0].tier, "fast");
  assert.equal(bp.lanes[0].shapes[0].readOnly, true);
  assert.equal(bp.lanes[0].shapes[0].schema, false);
  assert.equal(bp.lanes[1].shapes[0].role, "verifier");
  assert.equal(bp.lanes[1].shapes[0].schema, true);
  assert.equal(bp.lanes[0].label, "lane-1");
  assert.equal(bp.lanes[1].label, "lane-2");
});

test("fnop.3 laneBlueprint resolves canonical two-argument agent(prompt, opts) call sites", () => {
  // The guest runtime and bundled workflows use agent(prompt, opts). Static preview must
  // introspect literal options from that form; the legacy one-object form stays recognized.
  const bp = laneBlueprint(`export const meta = { name: "twoarg", profile: "read-only-review" };
const a = agent("find targets", { role: "finder", tier: "fast", readOnly: true });
const b = agent("verify", { role: "verifier", tier: "deep", schema: { type: "object" } });
return [a, b];`);
  assert.equal(bp.lanes.length, 2);
  assert.equal(bp.lanes[0].shapes[0].optsResolved, true);
  assert.equal(bp.lanes[0].shapes[0].role, "finder");
  assert.equal(bp.lanes[0].shapes[0].tier, "fast");
  assert.equal(bp.lanes[0].shapes[0].readOnly, true);
  assert.equal(bp.lanes[1].shapes[0].role, "verifier");
  assert.equal(bp.lanes[1].shapes[0].tier, "deep");
  assert.equal(bp.lanes[1].shapes[0].schema, true);
});

test("fnop.3 two-argument fan-out and dynamic option forms", () => {
  const bp = laneBlueprint(`export const meta = { name: "twoarg-fan", profile: "read-only-review" };
const r = parallel([() => agent("x", { role: "finder", tier: "fast" }), () => agent("y", { role: "v", tier: "deep" })]);
return r;`);
  const lane = bp.lanes[0];
  assert.equal(lane.fanOut, true);
  assert.deepEqual(lane.shapes.map((s) => s.role), ["finder", "v"]);
  assert.equal(lane.shapes[0].optsResolved, true);

  // Dynamic opts in the canonical two-arg form stay uncertain.
  const dyn = laneBlueprint(`export const meta = { name: "twoarg-dyn", profile: "read-only-review" };
const opts = compute();
const r = agent("p", opts);
return r;`);
  assert.equal(dyn.lanes[0].shapes[0].optsResolved, false);
  assert.equal(dyn.lanes[0].shapes[0].role, null);
});

test("tfil.2 laneBlueprint marks parallel fan-out runtime-determined and never totals", () => {
  const bp = laneBlueprint(`export const meta = { name: "fan", profile: "read-only-review" };
const r = parallel([() => agent({ role: "finder" }), () => agent({ role: "verifier", tier: "deep" })]);
return r;`);
  assert.equal(bp.lanes.length, 1);
  const lane = bp.lanes[0];
  assert.equal(lane.kind, "parallel");
  assert.equal(lane.fanOut, true);
  // staticCount is advisory (literal array length) but the site is still runtime-determined.
  assert.equal(lane.staticCount, 2);
  assert.equal(lane.certain, true);
  assert.deepEqual(lane.shapes.map((s) => s.role), ["finder", "verifier"]);
});

test("tfil.2 dynamic map fan-out is uncertain with no false count and no phantom direct lane", () => {
  const bp = laneBlueprint(`export const meta = { name: "dyn", profile: "read-only-review" };
const items = ["a", "b", "c"];
const r = parallel(items.map((api) => api.agent({ role: "fetcher", readOnly: true })));
return r;`);
  assert.equal(bp.lanes.length, 1, "no phantom direct lane leaked from the map callback");
  const lane = bp.lanes[0];
  assert.equal(lane.kind, "parallel");
  assert.equal(lane.fanOut, true);
  assert.equal(lane.staticCount, null, "dynamic count is not statically known");
  assert.equal(lane.certain, false, "unresolvable callbacks render uncertain");
  assert.equal(lane.shapes.length, 0);
});

test("tfil.2 pipeline fan-out sites are detected", () => {
  const bp = laneBlueprint(`export const meta = { name: "pipe", profile: "read-only-review" };
const r = pipeline(
  ["a", "b"],
  (ctx) => ctx.agent({ role: "plan", tier: "deep" }),
  (ctx) => ctx.agent({ role: "edit", edit: true }),
);
return r;`);
  assert.equal(bp.lanes.length, 1);
  assert.equal(bp.lanes[0].kind, "pipeline");
  assert.equal(bp.lanes[0].fanOut, true);
  assert.deepEqual(bp.lanes[0].shapes.map((s) => s.role), ["plan", "edit"]);
  assert.equal(bp.lanes[0].shapes[1].edit, true);
});

test("tfil.2 dynamic agent opts render uncertain (optsResolved false)", () => {
  const bp = laneBlueprint(`export const meta = { name: "dynopts", profile: "read-only-review" };
const opts = compute();
const r = agent(opts);
return r;`);
  assert.equal(bp.lanes.length, 1);
  assert.equal(bp.lanes[0].shapes[0].optsResolved, false);
  assert.equal(bp.lanes[0].shapes[0].role, null);
});

// --- tfil.6: workflow_lint tool ---

test("tfil.6 collectDiagnostics returns clean for a valid workflow", () => {
  const r = collectDiagnostics(`export const meta = { name: "ok", profile: "read-only-review" };
const r1 = agent({ role: "finder", tier: "fast", readOnly: true });
return r1;`);
  assert.equal(r.ok, true);
  assert.deepEqual(r.diagnostics, []);
});

test("tfil.6 collectDiagnostics reports multiple issues at once (non-throwing)", () => {
  const r = collectDiagnostics(`import fs from "fs";
export const meta = { maxAgents: "bad" };
parallel([() => agent()]);`);
  assert.equal(r.ok, false);
  const rules = r.diagnostics.map((d) => d.rule);
  assert.ok(rules.includes("no-imports"));
  assert.ok(rules.includes("meta-schema"));
  assert.ok(rules.includes("top-level-return"), "top-level return is a NEW check");
  assert.ok(rules.includes("fanout-callback-arity"));
  assert.ok(rules.includes("agent-arity"), "agent arity is a NEW check");
});

test("tfil.6 collectDiagnostics flags missing top-level return", () => {
  const r = collectDiagnostics(`export const meta = { name: "noreturn" };\nconst x = 1;`);
  assert.equal(r.ok, false);
  assert.ok(r.diagnostics.some((d) => d.rule === "top-level-return"));
});

test("tfil.6 collectDiagnostics flags agent() called with no arguments", () => {
  const r = collectDiagnostics(`export const meta = { name: "noargs" };\nreturn agent();`);
  assert.equal(r.ok, false);
  assert.ok(r.diagnostics.some((d) => d.rule === "agent-arity" && /no arguments/.test(d.message)));
});

test("tfil.6 collectDiagnostics flags export default", () => {
  const r = collectDiagnostics(`export const meta = {};\nexport default 1;\nreturn 1;`);
  assert.equal(r.ok, false);
  assert.ok(r.diagnostics.some((d) => d.rule === "exports"));
});

test("tfil.6 workflow_lint tool produces multi-diagnostics (read-only, no execute)", async () => {
  const { tools, context } = await makeHarness(async () => ({ data: { parts: [], info: {} } }));
  const summary = await tools.workflow_lint.execute({
    source: `export const meta = { maxAgents: "bad" };\nparallel([() => agent()]);`,
  }, context);
  assert.match(summary, /issue\(s\)/);
  assert.match(summary, /meta-schema/);
  assert.match(summary, /top-level-return/);
  assert.match(summary, /agent-arity/);
  assert.match(summary, /does NOT prove/);
  const json = JSON.parse(await tools.workflow_lint.execute({
    source: `export const meta = { maxAgents: "bad" };\nparallel([() => agent()]);`, format: "json",
  }, context));
  assert.equal(json.ok, false);
  assert.ok(json.diagnostics.length >= 3);
});

test("tfil.6 workflow_lint is registered as an inspect tool (read-only authority)", () => {
  assert.ok(WORKFLOW_INSPECT_TOOLS.includes("workflow_lint"), "workflow_lint in WORKFLOW_INSPECT_TOOLS");
  assert.ok(!WORKFLOW_MUTATING_TOOLS.includes("workflow_lint"), "workflow_lint NOT a mutating tool");
});
