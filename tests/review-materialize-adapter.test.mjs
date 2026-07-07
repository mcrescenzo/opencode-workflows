// Zero-token regression suite for the review-materialize adapter.
//
// Tests the PURE classification/plan functions (no bd, no fs) and the EXECUTION layer
// (mocked bd via a custom mock that handles list/create/dep with external-refs and labels).
//
// Coverage:
//   - classifyFinding: create / crosswalk-skip / exists-skip / already_done-skip / ambiguous
//   - planMaterialization: bucket counts and entry shapes
//   - materialize dry-run: no writes, planned creates surfaced
//   - materialize non-dry: native Beads fields, epic + children + final gate created, crosswalk written
//   - idempotency: re-run does not double-create (external-ref dedupe)
//   - not-ready guard: blocked_not_ready when materializationReady=false and !acceptPartial
//   - lossy old findings guard: domainDetails required for non-dry unless acceptPartial
//   - acceptPartial override allows materializing from a not-ready report

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  classifyFinding,
  planMaterialization,
  createReviewMaterializeAdapter,
  findingExternalRef,
  findingFingerprints,
  normalizeIssue,
} from "../workflow-domains/beads/review-materialize-adapter.js";

// ---- fixtures ----

function makeFinding(overrides = {}) {
  return {
    fingerprint: "bughunt-abc123",
    fingerprints: ["bughunt-abc123"],
    category: "null-deref",
    file: "src/app.js",
    line: 42,
    severity: "high",
    description: "pointer dereferenced before null check",
    proposedChange: "add null guard before dereference",
    confidence: 85,
    effort: "small",
    sourceDomains: ["bughunt"],
    sourceDomain: "bughunt",
    domainDetails: { reproSketch: "trigger the pointer path", fixSketch: "add a guard before dereference" },
    ...overrides,
  };
}

// ---- custom mock bd (handles list by status, create with external-ref/parent, dep, cycles) ----

function createMaterializeMockBd(initialIssues = [], options = {}) {
  const issues = new Map(initialIssues.map((i) => [i.id, { ...i, labels: [...(i.labels || [])] }]));
  const calls = [];
  let createCount = 0;
  const json = (v) => ({ stdout: JSON.stringify(v) });

  async function runBd(args, meta) {
    calls.push({ args, meta });
    const [command] = args;

    if (command === "list") {
      const statusIdx = args.indexOf("--status");
      const statuses = statusIdx >= 0 ? args[statusIdx + 1].split(",") : ["open"];
      const matching = [...issues.values()].filter((i) => statuses.includes(i.status));
      return json(matching);
    }
    if (command === "create") {
      createCount += 1;
      const id = `rmat-${createCount}`;
      const titleIdx = args.indexOf("--title");
      const descIdx = args.indexOf("--description");
      const typeIdx = args.indexOf("--type");
      const labelsIdx = args.indexOf("--labels");
      const refIdx = args.indexOf("--external-ref");
      const parentIdx = args.indexOf("--parent");
      const designIdx = args.indexOf("--design");
      const acceptanceIdx = args.indexOf("--acceptance");
      const priorityIdx = args.indexOf("--priority");
      const issue = {
        id,
        title: titleIdx >= 0 ? args[titleIdx + 1] : id,
        description: descIdx >= 0 ? args[descIdx + 1] : "",
        design: designIdx >= 0 ? args[designIdx + 1] : "",
        acceptance_criteria: acceptanceIdx >= 0 ? args[acceptanceIdx + 1] : "",
        status: "open",
        issue_type: typeIdx >= 0 ? args[typeIdx + 1] : "task",
        priority: priorityIdx >= 0 ? args[priorityIdx + 1] : undefined,
        labels: labelsIdx >= 0 ? args[labelsIdx + 1].split(",") : [],
        external_ref: refIdx >= 0 ? args[refIdx + 1] : "",
        ...(parentIdx >= 0 ? { parent: args[parentIdx + 1] } : {}),
      };
      issues.set(id, issue);
      return json(issue);
    }
    if (command === "dep" && args[1] === "add") {
      // dep add <dependent> <prerequisite> --type <type>
      const dependent = args[2];
      const prerequisite = args[3];
      const typeIdx = args.indexOf("--type");
      const depType = typeIdx >= 0 ? args[typeIdx + 1] : "blocks";
      const issue = issues.get(dependent);
      if (issue) {
        issue.dependencies = [...(issue.dependencies || []), { depends_on_id: prerequisite, type: depType }];
      }
      return { stdout: `dep added ${dependent} ${prerequisite}\n` };
    }
    if (command === "dep" && args[1] === "list") {
      const dependent = args[2];
      const issue = issues.get(dependent);
      const dependencies = issue?.dependencies || [];
      if (typeof options.depListRecords === "function") {
        return json(options.depListRecords({ dependent, issue, dependencies, issues }));
      }
      if (options.depListShape === "edge") {
        return json(dependencies.map((d) => ({ issue_id: dependent, depends_on_id: d.depends_on_id, type: d.type })));
      }
      // Real `bd dep list <dependent> --type blocks --json` can return prerequisite
      // issue-like records rather than edge rows.
      return json(dependencies.map((d) => {
        const prerequisiteIssue = issues.get(d.depends_on_id);
        return {
          id: d.depends_on_id,
          title: prerequisiteIssue?.title || d.depends_on_id,
          status: prerequisiteIssue?.status || "open",
          dependency_type: d.type,
        };
      }));
    }
    if (command === "dep" && args[1] === "cycles") {
      return json([]);
    }
    if (command === "graph" && args[1] === "check") {
      return json([]);
    }
    throw new Error(`Unexpected bd command: ${args.join(" ")}`);
  }

  return { runBd, calls, issues };
}

// =========================================================================
// 1. PURE: classifyFinding
// =========================================================================

test("classifyFinding: a brand-new finding is classified as create", () => {
  const f = makeFinding();
  const cls = classifyFinding(f, {}, []);
  assert.equal(cls.action, "create");
});

test("classifyFinding: a fingerprint in the crosswalk is a crosswalk skip", () => {
  const f = makeFinding();
  const crosswalk = { "bughunt-abc123": "existing-bead-1" };
  const cls = classifyFinding(f, crosswalk, []);
  assert.equal(cls.action, "skip");
 assert.equal(cls.reason, "crosswalk:existing-bead-1");
  assert.equal(cls.beadId, "existing-bead-1");
});

test("classifyFinding: an open bead with the same external-ref is an exists skip", () => {
  const f = makeFinding();
  const ref = findingExternalRef("bughunt-abc123");
  const existing = [normalizeIssue({ id: "bead-9", status: "open", external_ref: ref, title: "old", description: "" })];
  const cls = classifyFinding(f, {}, existing);
  assert.equal(cls.action, "skip");
  assert.equal(cls.reason, "exists:bead-9");
});

test("classifyFinding: a closed bead with the same external-ref is an already_done skip", () => {
  const f = makeFinding();
  const ref = findingExternalRef("bughunt-abc123");
  const existing = [normalizeIssue({ id: "bead-old", status: "closed", external_ref: ref, title: "old", description: "" })];
  const cls = classifyFinding(f, {}, existing);
  assert.equal(cls.action, "skip");
  assert.equal(cls.reason, "already_done:bead-old");
});

test("classifyFinding: a semantically similar open bead is ambiguous", () => {
  const f = makeFinding({ description: "null dereference in app.js pointer check" });
  const existing = [normalizeIssue({
    id: "bead-sim",
    status: "open",
    external_ref: "different-ref",
    title: "null dereference app.js pointer",
    description: "null dereference in app.js pointer check guard",
    labels: ["bughunt"],
  })];
  const cls = classifyFinding(f, {}, existing);
  assert.equal(cls.action, "ambiguous");
  assert.ok(cls.candidates.includes("bead-sim"));
});

test("classifyFinding: cross-domain-merged finding with multiple fingerprints checks all", () => {
  const f = makeFinding({ fingerprints: ["bughunt-abc", "security-def"] });
  const crosswalk = { "security-def": "existing-bead-2" };
  const cls = classifyFinding(f, crosswalk, []);
  assert.equal(cls.action, "skip");
  assert.equal(cls.reason, "crosswalk:existing-bead-2");
});

// =========================================================================
// 2. PURE: planMaterialization
// =========================================================================

test("planMaterialization: buckets findings into create/skip/ambiguous", () => {
  const findings = [
    makeFinding({ fingerprint: "fp-new", fingerprints: ["fp-new"], category: "race-condition", file: "src/worker.js", description: "data race in concurrent map access", proposedChange: "add mutex lock" }),
    makeFinding({ fingerprint: "fp-dup", fingerprints: ["fp-dup"] }),
    makeFinding({ fingerprint: "fp-sim", fingerprints: ["fp-sim"], description: "null dereference in app.js pointer check" }),
  ];
  const crosswalk = { "fp-dup": "bead-dup" };
  const existing = [normalizeIssue({
    id: "bead-sim", status: "open", external_ref: "other",
    title: "null dereference app.js pointer", description: "null dereference in app.js pointer check guard", labels: [],
  })];
  const plan = planMaterialization(findings, crosswalk, existing);
  assert.equal(plan.create.length, 1);
  assert.equal(plan.create[0].fingerprint, "fp-new");
  assert.equal(plan.skip.length, 1);
  assert.equal(plan.skip[0].fingerprint, "fp-dup");
  assert.equal(plan.ambiguous.length, 1);
  assert.equal(plan.ambiguous[0].fingerprint, "fp-sim");
});

test("planMaterialization: fingerprint-less findings get distinct stable fallback identities", () => {
  const a = makeFinding({ fingerprint: undefined, fingerprints: undefined, file: "src/a.js", line: 1, description: "first missing fingerprint" });
  const b = makeFinding({ fingerprint: undefined, fingerprints: undefined, file: "src/b.js", line: 2, description: "second missing fingerprint" });
  const aAgain = { ...a };

  assert.match(findingFingerprints(a)[0], /^fallback-[0-9a-f]{16}$/);
  assert.equal(findingFingerprints(a)[0], findingFingerprints(aAgain)[0]);
  assert.notEqual(findingFingerprints(a)[0], findingFingerprints(b)[0]);

  const plan = planMaterialization([a, b], {}, []);
  assert.equal(plan.create.length, 2);
  assert.notEqual(plan.create[0].fingerprint, plan.create[1].fingerprint);
  assert.notEqual(findingExternalRef(plan.create[0].fingerprint), findingExternalRef(plan.create[1].fingerprint));
});

// =========================================================================
// 3. EXECUTION: dry-run makes no writes
// =========================================================================

test("materialize dry-run: reports planned creates without any bd writes", async () => {
  const { runBd, calls } = createMaterializeMockBd([]);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rmat-test-"));
  const adapter = createReviewMaterializeAdapter({ cwd: dir, runBd });
  try {
    const result = await adapter.materialize({
      findings: [makeFinding({ fingerprint: "fp-1", fingerprints: ["fp-1"] })],
      programLabel: "review-abc123",
      dryRun: true,
      materializationReady: true,
    });
    assert.equal(result.status, "dry_run");
    assert.equal(result.stats.create, 1);
    assert.equal(result.stats.skip, 0);
    assert.equal(result.plannedCreates.length, 1);
    assert.equal(result.plannedEpic.title, "Review epic: review-abc123");
    assert.equal(result.plannedFinalGate.title, "Final verification: review-abc123");
    assert.ok(result.plannedCreates[0].labels.includes("implementation"));
    assert.ok(result.plannedCreates[0].labels.includes("bughunt"));
    assert.ok(!result.plannedCreates[0].labels.includes("ready-for-agent"), "materialization must not auto-mark findings ready-for-agent");
    // No create/dep calls in dry-run.
    assert.ok(!calls.some((c) => c.args[0] === "create"), "dry-run must not call bd create");
    assert.ok(!calls.some((c) => c.args[0] === "dep"), "dry-run must not call bd dep");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// =========================================================================
// 4. EXECUTION: non-dry creates epic + children + gate + crosswalk
// =========================================================================

test("materialize non-dry: creates epic, children, final gate, and writes crosswalk", async () => {
  const { runBd, calls, issues } = createMaterializeMockBd([]);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rmat-test-"));
  const adapter = createReviewMaterializeAdapter({ cwd: dir, runBd });
  try {
    const result = await adapter.materialize({
      findings: [
        makeFinding({ fingerprint: "fp-a", fingerprints: ["fp-a"], description: "bug a", category: "null-deref" }),
        makeFinding({ fingerprint: "fp-b", fingerprints: ["fp-b"], description: "bug b", category: "logic" }),
      ],
      programLabel: "review-deadbee",
      dryRun: false,
      materializationReady: true,
    });
    assert.equal(result.status, "materialized");
    assert.ok(result.epicId, "epic must be created");
    assert.ok(result.finalGateId, "final gate must be created");
    assert.equal(result.created.length, 2, "two children created");
    // Crosswalk written.
    const crosswalk = JSON.parse(await fs.readFile(result.crosswalkPath, "utf8"));
    assert.equal(crosswalk["fp-a"], result.created[0].beadId);
    assert.equal(crosswalk["fp-b"], result.created[1].beadId);
    // The epic and gate exist in the mock issue store.
    assert.ok(issues.has(result.epicId));
    assert.ok(issues.has(result.finalGateId));
    const epic = issues.get(result.epicId);
    const gate = issues.get(result.finalGateId);
    const child = issues.get(result.created[0].beadId);
    assert.match(epic.acceptance_criteria, /Every created child bead is closed/);
    assert.match(epic.design, /repo-review materialization program/);
    assert.equal(gate.parent, result.epicId, "final gate should be parented to the epic");
    assert.match(gate.acceptance_criteria, /bd dep cycles/);
    assert.match(child.acceptance_criteria, /bug is reproduced|repo-review finding/);
    assert.match(child.design, /Domain details/);
    assert.ok(child.labels.includes("implementation"));
    assert.ok(child.labels.includes("bughunt"));
    assert.ok(child.labels.includes("small"));
    assert.ok(child.labels.includes("needs-tests"));
    assert.ok(!child.labels.includes("ready-for-agent"), "children must not be auto-ready-for-agent");
    // dep add was called for each child -> gate.
    const depAdds = calls.filter((c) => c.args[0] === "dep" && c.args[1] === "add");
    assert.equal(depAdds.length, 2, "final gate must be blocked by both children");
    for (const dep of depAdds) {
      assert.equal(dep.args[2], result.finalGateId, "dependent is the final gate");
    }
    assert.ok(calls.some((c) => c.args[0] === "graph" && c.args[1] === "check"), "materialize must run graph check");
    assert.ok(result.verify.checks.some((c) => c.name === "final_gate_blocked_by_scope" && c.pass === true));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("materialize non-dry: final-gate readback accepts real Beads prerequisite issue records", async () => {
  const { runBd } = createMaterializeMockBd([]);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rmat-test-"));
  const adapter = createReviewMaterializeAdapter({ cwd: dir, runBd });
  try {
    const result = await adapter.materialize({
      findings: [makeFinding({ fingerprint: "fp-real-dep-shape", fingerprints: ["fp-real-dep-shape"] })],
      programLabel: "review-real-dep-shape",
      dryRun: false,
      materializationReady: true,
    });

    assert.equal(result.status, "materialized");
    const scopeCheck = result.verify.checks.find((c) => c.name === "final_gate_blocked_by_scope");
    assert.deepEqual(scopeCheck, {
      name: "final_gate_blocked_by_scope",
      pass: true,
      expected: 1,
      missing: [],
    });
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("materialize non-dry: final-gate readback rejects non-blocking dependency types", async () => {
  const mock = createMaterializeMockBd([], {
    depListRecords({ dependencies }) {
      return dependencies.map((d) => ({ id: d.depends_on_id, dependency_type: "parent-child" }));
    },
  });
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rmat-test-"));
  const adapter = createReviewMaterializeAdapter({ cwd: dir, runBd: mock.runBd });
  try {
    const result = await adapter.materialize({
      findings: [makeFinding({ fingerprint: "fp-non-blocking-dep", fingerprints: ["fp-non-blocking-dep"] })],
      programLabel: "review-non-blocking-dep",
      dryRun: false,
      materializationReady: true,
    });

    assert.equal(result.status, "materialized_verify_failed");
    const scopeCheck = result.verify.checks.find((c) => c.name === "final_gate_blocked_by_scope");
    assert.equal(scopeCheck.pass, false);
    assert.equal(scopeCheck.expected, 1);
    assert.deepEqual(scopeCheck.missing, [result.created[0].beadId]);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("materialize non-dry: pre-existing program children absent from current findings still block the gate", async () => {
  // Regression: a prior run created a child bead (external_ref ocw-rm-*, labeled with the
  // program) that the CURRENT findings array no longer surfaces. It is not in `plan.skip`,
  // so wiring only created+skipped would leave it unblocking the gate. The program-scan must
  // still dep-add it so the children-block-final-gate invariant holds on re-runs.
  const orphanChild = {
    id: "orphan-child-1",
    status: "open",
    issue_type: "task",
    external_ref: "ocw-rm-fp-orphan",
    title: "orphaned prior-run child",
    description: "",
    labels: ["review", "implementation", "review-scan"],
  };
  const { runBd, calls } = createMaterializeMockBd([orphanChild]);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rmat-test-"));
  const adapter = createReviewMaterializeAdapter({ cwd: dir, runBd });
  try {
    const result = await adapter.materialize({
      findings: [makeFinding({ fingerprint: "fp-new", fingerprints: ["fp-new"], description: "brand new finding" })],
      programLabel: "review-scan",
      dryRun: false,
      materializationReady: true,
    });
    assert.equal(result.status, "materialized");
    assert.equal(result.created.length, 1, "only the new finding is created");
    const depAdds = calls.filter((c) => c.args[0] === "dep" && c.args[1] === "add");
    const prereqIds = new Set(depAdds.map((d) => d.args[3]));
    assert.ok(prereqIds.has(result.created[0].beadId), "the new child must block the gate");
    assert.ok(prereqIds.has("orphan-child-1"), "the pre-existing program child must also block the gate");
    for (const dep of depAdds) assert.equal(dep.args[2], result.finalGateId, "every dep add targets the gate");
    const scopeCheck = result.verify.checks.find((c) => c.name === "final_gate_blocked_by_scope");
    assert.ok(scopeCheck && scopeCheck.pass === true, "gate must be blocked by full program scope");
    // The epic and gate created THIS run must NOT be treated as their own prerequisites.
    assert.ok(!prereqIds.has(result.epicId), "epic must not block the gate");
    assert.ok(!prereqIds.has(result.finalGateId), "gate must not block itself");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("materialize non-dry: fingerprint-less findings create distinct crosswalk entries", async () => {
  const { runBd } = createMaterializeMockBd([]);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rmat-test-"));
  const adapter = createReviewMaterializeAdapter({ cwd: dir, runBd });
  try {
    const result = await adapter.materialize({
      findings: [
        makeFinding({ fingerprint: undefined, fingerprints: undefined, file: "src/a.js", line: 1, description: "first missing fingerprint" }),
        makeFinding({ fingerprint: undefined, fingerprints: undefined, file: "src/b.js", line: 2, description: "second missing fingerprint" }),
      ],
      programLabel: "review-fallback",
      dryRun: false,
      materializationReady: true,
    });
    assert.equal(result.status, "materialized");
    assert.equal(result.created.length, 2);
    assert.notEqual(result.created[0].fingerprint, result.created[1].fingerprint);
    const crosswalk = JSON.parse(await fs.readFile(result.crosswalkPath, "utf8"));
    assert.equal(Object.keys(crosswalk).filter((k) => !k.startsWith("__")).length, 2);
    assert.equal(crosswalk.__reviewMaterialize.entries.length, 2);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("materialize non-dry: missing final gate id fails loudly", async () => {
  const base = createMaterializeMockBd([]);
  const runBd = async (args, meta) => {
    if (args[0] === "create" && args.includes("Final verification: review-no-gate")) {
      return { stdout: JSON.stringify({}) };
    }
    return await base.runBd(args, meta);
  };
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rmat-test-"));
  const adapter = createReviewMaterializeAdapter({ cwd: dir, runBd });
  try {
    await assert.rejects(
      () => adapter.materialize({
        findings: [makeFinding({ fingerprint: "fp-gate", fingerprints: ["fp-gate"] })],
        programLabel: "review-no-gate",
        dryRun: false,
        materializationReady: true,
      }),
      /Failed to create or resolve the final verification gate/,
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("materialize non-dry: dep-add failures mark verification failed unless already exists", async () => {
  const first = createMaterializeMockBd([]);
  const failingRunBd = async (args, meta) => {
    if (args[0] === "dep" && args[1] === "add") throw new Error("permission denied");
    return await first.runBd(args, meta);
  };
  const firstDir = await fs.mkdtemp(path.join(os.tmpdir(), "rmat-test-"));
  try {
    const adapter = createReviewMaterializeAdapter({ cwd: firstDir, runBd: failingRunBd });
    const result = await adapter.materialize({
      findings: [makeFinding({ fingerprint: "fp-dep-fail", fingerprints: ["fp-dep-fail"] })],
      programLabel: "review-dep-fail",
      dryRun: false,
      materializationReady: true,
    });
    assert.equal(result.status, "materialized_verify_failed");
    assert.equal(result.verify.ok, false);
    assert.match(result.verify.problems.join("\n"), /dep add .*permission denied/);
  } finally {
    await fs.rm(firstDir, { recursive: true, force: true });
  }

  const second = createMaterializeMockBd([]);
  const duplicateRunBd = async (args, meta) => {
    if (args[0] === "dep" && args[1] === "add") {
      await second.runBd(args, meta);
      throw new Error("dependency already exists");
    }
    return await second.runBd(args, meta);
  };
  const secondDir = await fs.mkdtemp(path.join(os.tmpdir(), "rmat-test-"));
  try {
    const adapter = createReviewMaterializeAdapter({ cwd: secondDir, runBd: duplicateRunBd });
    const result = await adapter.materialize({
      findings: [makeFinding({ fingerprint: "fp-dep-dupe", fingerprints: ["fp-dep-dupe"] })],
      programLabel: "review-dep-dupe",
      dryRun: false,
      materializationReady: true,
    });
    assert.equal(result.status, "materialized");
    assert.equal(result.verify.ok, true);
  } finally {
    await fs.rm(secondDir, { recursive: true, force: true });
  }
});

// =========================================================================
// 5. IDEMPOTENCY: re-run does not double-create
// =========================================================================

test("materialize idempotency: a second run skips findings already in the crosswalk", async () => {
  const { runBd, issues } = createMaterializeMockBd([]);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rmat-test-"));
  const adapter = createReviewMaterializeAdapter({ cwd: dir, runBd });
  try {
    const args = {
      findings: [makeFinding({ fingerprint: "fp-x", fingerprints: ["fp-x"] })],
      programLabel: "review-idem",
      dryRun: false,
      materializationReady: true,
    };
    const first = await adapter.materialize(args);
    assert.equal(first.created.length, 1);
    const second = await adapter.materialize(args);
    // The second run finds the fingerprint in the crosswalk -> skip, no new creates.
    assert.equal(second.created.length, 0, "re-run must not create duplicates");
    assert.equal(second.skipped.length, 1, "re-run must skip the already-materialized finding");
    assert.equal(second.skipped[0].reason, `crosswalk:${first.created[0].beadId}`);
    // The issue store did not grow beyond the first run's creates.
    const totalCreates = [...issues.values()].filter((i) => i.external_ref?.startsWith("ocw-rm-") && i.issue_type !== "epic" && !i.title?.startsWith("Final verification")).length;
    assert.equal(totalCreates, 1, "only one child bead should exist across both runs");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("verify-only materialization recovery succeeds for an existing valid graph without writes", async () => {
  const { runBd, calls } = createMaterializeMockBd([]);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rmat-test-"));
  const adapter = createReviewMaterializeAdapter({ cwd: dir, runBd });
  try {
    const materialized = await adapter.materialize({
      findings: [makeFinding({ fingerprint: "fp-verify-valid", fingerprints: ["fp-verify-valid"] })],
      programLabel: "review-verify-valid",
      dryRun: false,
      materializationReady: true,
    });
    assert.equal(materialized.status, "materialized");
    const crosswalkBefore = await fs.readFile(materialized.crosswalkPath, "utf8");
    const callCountBeforeVerify = calls.length;

    const verified = await adapter.materialize({
      programLabel: "review-verify-valid",
      verifyOnly: true,
    });

    assert.equal(verified.status, "verified");
    assert.equal(verified.epicId, materialized.epicId);
    assert.equal(verified.finalGateId, materialized.finalGateId);
    assert.equal(verified.childCount, 1);
    assert.equal(verified.verify.verdict, "pass");
    assert.equal(verified.verify.failureClass, null);
    assert.equal(verified.verify.retryable, false);
    assert.equal(verified.verify.recoverable, false);
    assert.deepEqual(verified.failedChecks, []);
    assert.deepEqual(verified.verify.failedChecks, []);
    assert.match(verified.suggestedNextAction, /post-materialization review/);
    assert.match(verified.verify.suggestedRecovery, /post-materialization review/);
    assert.equal(await fs.readFile(materialized.crosswalkPath, "utf8"), crosswalkBefore, "verify-only must not rewrite the crosswalk");

    const verifyCalls = calls.slice(callCountBeforeVerify);
    assert.ok(!verifyCalls.some((c) => c.args[0] === "create"), "verify-only must not create beads");
    assert.ok(!verifyCalls.some((c) => c.args[0] === "update"), "verify-only must not update beads");
    assert.ok(!verifyCalls.some((c) => c.args[0] === "dep" && c.args[1] === "add"), "verify-only must not add dependencies");
    assert.ok(verifyCalls.every((c) => c.meta?.readonly !== false), "verify-only bd calls must stay read-only");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("verify-only materialization recovery reports missing final-gate blockers", async () => {
  const { runBd, issues } = createMaterializeMockBd([]);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rmat-test-"));
  const adapter = createReviewMaterializeAdapter({ cwd: dir, runBd });
  try {
    const materialized = await adapter.materialize({
      findings: [makeFinding({ fingerprint: "fp-verify-invalid", fingerprints: ["fp-verify-invalid"] })],
      programLabel: "review-verify-invalid",
      dryRun: false,
      materializationReady: true,
    });
    assert.equal(materialized.status, "materialized");
    issues.get(materialized.finalGateId).dependencies = [];

    const verified = await adapter.materialize({
      programLabel: "review-verify-invalid",
      verifyOnly: true,
    });

    assert.equal(verified.status, "invalid");
    assert.equal(verified.epicId, materialized.epicId);
    assert.equal(verified.finalGateId, materialized.finalGateId);
    assert.equal(verified.childCount, 1);
    assert.equal(verified.verify.verdict, "hard_fail");
    assert.equal(verified.verify.failureClass, "hard_fail");
    assert.equal(verified.verify.retryable, false);
    assert.equal(verified.verify.recoverable, true);
    assert.deepEqual(verified.failedChecks, ["final_gate_blocked_by_scope"]);
    assert.equal(verified.verify.checks.find((c) => c.name === "final_gate_blocked_by_scope").failureClass, "hard_fail");
    assert.match(verified.verify.problems.join("\n"), /final gate is missing 1 expected prerequisite/);
    assert.match(verified.suggestedNextAction, /Repair missing blockers/);
    assert.match(verified.verify.suggestedRecovery, /Repair missing blockers/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("verify-only materialization recovery reports inconclusive tool readback failures", async () => {
  const base = createMaterializeMockBd([]);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rmat-test-"));
  const materializer = createReviewMaterializeAdapter({ cwd: dir, runBd: base.runBd });
  try {
    const materialized = await materializer.materialize({
      findings: [makeFinding({ fingerprint: "fp-verify-tool-error", fingerprints: ["fp-verify-tool-error"] })],
      programLabel: "review-verify-tool-error",
      dryRun: false,
      materializationReady: true,
    });
    assert.equal(materialized.status, "materialized");

    const failingRunBd = async (args, meta) => {
      if (args[0] === "dep" && args[1] === "list") throw new Error("bd socket unavailable");
      return await base.runBd(args, meta);
    };
    const verifier = createReviewMaterializeAdapter({ cwd: dir, runBd: failingRunBd });
    const verified = await verifier.materialize({
      programLabel: "review-verify-tool-error",
      verifyOnly: true,
    });

    assert.equal(verified.status, "inconclusive");
    assert.equal(verified.childCount, 1);
    assert.equal(verified.verify.verdict, "tool_error");
    assert.equal(verified.verify.failureClass, "tool_error");
    assert.equal(verified.verify.retryable, true);
    assert.equal(verified.verify.recoverable, true);
    assert.deepEqual(verified.failedChecks, ["final_gate_blocked_by_scope"]);
    assert.equal(verified.verify.checks.find((c) => c.name === "final_gate_blocked_by_scope").failureClass, "tool_error");
    assert.match(verified.verify.problems.join("\n"), /dependency readback failed.*bd socket unavailable/);
    assert.match(verified.suggestedNextAction, /retry verify-only/);
    assert.match(verified.verify.suggestedRecovery, /retry verify-only/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// =========================================================================
// 6. NOT-READY GUARD
// =========================================================================

test("materialize refuses a not-ready report when acceptPartial is false", async () => {
  const { runBd, calls } = createMaterializeMockBd([]);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rmat-test-"));
  const adapter = createReviewMaterializeAdapter({ cwd: dir, runBd });
  try {
    const result = await adapter.materialize({
      findings: [makeFinding()],
      programLabel: "review-notready",
      dryRun: false,
      materializationReady: false,
      acceptPartial: false,
    });
    assert.equal(result.status, "blocked_not_ready");
    assert.ok(result.abortReason.includes("materializationReady"));
    assert.ok(!calls.some((c) => c.args[0] === "create"), "must not create anything when blocked");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("materialize refuses lossy old findings without domainDetails unless acceptPartial is true", async () => {
  const { runBd, calls } = createMaterializeMockBd([]);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rmat-test-"));
  const adapter = createReviewMaterializeAdapter({ cwd: dir, runBd });
  try {
    const result = await adapter.materialize({
      findings: [makeFinding({ domainDetails: undefined, fingerprint: "fp-lossy", fingerprints: ["fp-lossy"] })],
      programLabel: "review-lossy",
      dryRun: false,
      materializationReady: true,
      acceptPartial: false,
    });
    assert.equal(result.status, "blocked_lossy_findings");
    assert.match(result.abortReason, /lack repo-review domainDetails/);
    assert.ok(!calls.some((c) => c.args[0] === "create"), "must not create lossy findings without override");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("materialize acceptPartial override allows materializing from a not-ready report", async () => {
  const { runBd } = createMaterializeMockBd([]);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rmat-test-"));
  const adapter = createReviewMaterializeAdapter({ cwd: dir, runBd });
  try {
    const result = await adapter.materialize({
      findings: [makeFinding({ fingerprint: "fp-partial", fingerprints: ["fp-partial"] })],
      programLabel: "review-partial",
      dryRun: false,
      materializationReady: false,
      acceptPartial: true,
    });
    assert.equal(result.status, "materialized");
    assert.equal(result.created.length, 1);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// =========================================================================
// 7. All-duplicate run: no creates, honest empty result
// =========================================================================

test("materialize with all-duplicate findings: no creates, all skipped", async () => {
  const { runBd, calls } = createMaterializeMockBd([]);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rmat-test-"));
  const adapter = createReviewMaterializeAdapter({ cwd: dir, runBd });
  try {
    // Seed the crosswalk so the finding is a known duplicate.
    const crosswalkPath = path.join(dir, ".repo-review", "crosswalk", "review-dups.json");
    await fs.mkdir(path.dirname(crosswalkPath), { recursive: true });
    await fs.writeFile(crosswalkPath, JSON.stringify({ "fp-dup": "existing-bead-1" }), "utf8");

    const result = await adapter.materialize({
      findings: [makeFinding({ fingerprint: "fp-dup", fingerprints: ["fp-dup"] })],
      programLabel: "review-dups",
      dryRun: false,
      materializationReady: true,
      crosswalkPath,
    });
    assert.equal(result.created.length, 0);
    assert.equal(result.skipped.length, 1);
    assert.ok(!calls.some((c) => c.args[0] === "create"), "no creates when all findings are duplicates");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
