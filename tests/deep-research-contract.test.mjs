import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";

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
