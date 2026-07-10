import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";

import { parseWorkflowSource, resolveWorkflowSource, laneBlueprint } from "../workflow-kernel/workflow-source.js";
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
  assert.equal(meta.recommendBackground, true);
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

test("fnop.3 bundled deep-research laneBlueprint resolves two-argument agent(prompt, opts) shapes", async () => {
  // The bundled workflow calls agent(prompt, opts) throughout. Before fnop.3, static
  // introspection read the first argument as opts, so every detected lane shape rendered
  // unresolved (optsResolved false). Literal two-arg options must now resolve.
  const source = await fs.readFile(bundledPath, "utf8");
  const bp = laneBlueprint(source);
  assert.ok(bp.lanes.length > 0, "deep-research must declare at least one lane");
  const allShapes = bp.lanes.flatMap((l) => l.shapes ?? []);
  const resolved = allShapes.filter((s) => s.optsResolved === true);
  assert.ok(
    resolved.length > 0,
    `deep-research literal agent(prompt, opts) calls must produce resolved shapes; got ${JSON.stringify(allShapes.map((s) => ({ role: s.role, tier: s.tier, optsResolved: s.optsResolved })))}`,
  );
});
