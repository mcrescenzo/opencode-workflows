// workflow_list / invocation metadata / args-schema listing / extension-by-name
// resolution surface.
//
// Split out of the former tests/workflow-run.test.mjs monolith (bd opencode-workflows-fnop.18).
// These tests exercise the read-only discovery/catalog surface: workflow_list output,
// machine-readable invocation metadata, args-schema listing, summary rendering, and
// resolving a workflow by name from extension scope.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { makeHarness } from "./helpers/harness.mjs";
import { makeExtensionDir, writeFakeExtension } from "./helpers/fake-extension.mjs";
import { projectWorkflowDir } from "../workflow-kernel/workflow-source.js";
import { hash } from "../workflow-kernel/text-json.js";

const execFileAsync = promisify(execFile);

// Synthetic drain extension: contributes the `fixture-drain` workflow (scope:"extension") so
// workflow_list summary rendering can assert bundled/extension run: lines and next steps.
const FIXTURE_DRAIN_EXT = path.join(import.meta.dirname, "fixtures", "drain-extension", "extension.js");

// Fixture workflow with a fully-populated meta: the invocation-metadata contract
// (ux.1) is now asserted against this fixture instead of any bundled workflow.
const RICH_META_WORKFLOW = `export const meta = {
  name: "fixture-rich",
  description: "Fixture workflow with complete invocation metadata.",
  profile: "read-only-review",
  maxAgents: 4,
  concurrency: 2,
  phases: ["recon", "find"],
  category: "fixture",
  notes: "Read-only fixture. Finder lanes use fast tier, verification lanes use deep tier.",
  examples: [
    { label: "default scan", args: { depth: "normal", paths: ["src"] } },
  ],
  argsSchema: {
    type: ["object", "null"],
    properties: {
      paths: { type: "array", items: { type: "string" } },
      depth: { type: "string", enum: ["quick", "normal"] },
      categories: { type: "array", items: { type: "string", enum: ["concurrency"] } },
    },
  },
};
return "ok";
`;

async function initGitRepo(directory) {
  await execFileAsync("git", ["init"], { cwd: directory });
  await execFileAsync("git", ["config", "user.email", "workflow-test@example.com"], { cwd: directory });
  await execFileAsync("git", ["config", "user.name", "Workflow Test"], { cwd: directory });
  await fs.writeFile(path.join(directory, "README.md"), "initial\n", "utf8");
  await execFileAsync("git", ["add", "README.md"], { cwd: directory });
  await execFileAsync("git", ["commit", "-m", "initial"], { cwd: directory });
}

test("workflow_list includes extension workflows with source metadata", async () => {
  const extDir = await makeExtensionDir();
  const extPath = await writeFakeExtension(extDir, {
    id: "list-meta",
    assetDirs: { workflows: "./workflows" },
    workflows: { "fixture-rich": RICH_META_WORKFLOW },
  });
  const { tools, context, directory } = await makeHarness(async () => ({ data: { parts: [], info: {} } }), {
    extensions: [extPath],
  });
  try {
    const listed = JSON.parse(await tools.workflow_list.execute({ format: "json" }, context));
    const entry = listed.find((e) => e.scope === "extension" && e.name === "fixture-rich");
    const srcPath = path.join(extDir, "workflows", "fixture-rich.js");
    const src = await fs.readFile(srcPath, "utf8");

    assert.ok(entry, "missing extension fixture-rich workflow");
    assert.equal(entry.sourcePath, srcPath);
    assert.equal(entry.sourceHash, hash(src));
    assert.deepEqual(entry.phases, ["recon", "find"]);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
    await fs.rm(extDir, { recursive: true, force: true });
  }
});

test("workflow_list summary format renders authority= without throwing (regression: authoritySummary/truncateText imports)", async () => {
  const extDir = await makeExtensionDir();
  const extPath = await writeFakeExtension(extDir, {
    id: "list-summary",
    assetDirs: { workflows: "./workflows" },
    workflows: { "fixture-rich": RICH_META_WORKFLOW },
  });
  const { tools, context, directory } = await makeHarness(async () => ({ data: { parts: [], info: {} } }), {
    extensions: [extPath],
  });
  try {
    const summary = await tools.workflow_list.execute({}, context);
    assert.equal(typeof summary, "string");
    assert.match(summary, /extension\/fixture-rich/, "summary should list the extension fixture workflow");
    assert.match(summary, /authority=/, "summary must render authority= via authoritySummary");
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
    await fs.rm(extDir, { recursive: true, force: true });
  }
});

// ux.1: workflow_list should make bundled + saved workflows self-describing — runnable
// workflow_run examples, args shape, authority/profile, model-tier hints, maxAgents/concurrency,
// and workflow_status next steps — sourced only from explicit meta or curated bundled defaults.
// (The former bundled-drain "carries invocation metadata from curated defaults" test was removed
// with the domain extension; its generic contract is covered by the fixture-based ux.1 test below,
// "ux.1: extension workflows expose machine-readable invocation metadata".)

test("ux.1: extension workflows expose machine-readable invocation metadata", async () => {
  const extDir = await makeExtensionDir();
  const extPath = await writeFakeExtension(extDir, {
    id: "ux1-meta",
    assetDirs: { workflows: "./workflows" },
    workflows: { "fixture-rich": RICH_META_WORKFLOW },
  });
  const { tools, context, directory } = await makeHarness(async () => {
    throw new Error("workflow_list metadata must not prompt a model");
  }, { extensions: [extPath] });
  try {
    const listed = JSON.parse(await tools.workflow_list.execute({ format: "json" }, context));
    // 0.3.0 deliberately reverses the 0.2.0 zero-bundled stance for exactly one flagship
    // workflow (deep-research; see CHANGELOG and tests/publish-completeness.test.mjs). Assert
    // the bundled set is exactly that one entry, not empty — no other bundled workflow should
    // sneak in unnoticed.
    const bundled = listed.filter((e) => e.scope === "bundled");
    assert.deepEqual(bundled.map((e) => e.name), ["deep-research"], "expected exactly the bundled deep-research workflow");
    const entries = listed.filter((e) => e.scope === "extension" && e.name === "fixture-rich");
    assert.equal(entries.length, 1, "fixture workflow must be listed exactly once");
    for (const entry of entries) {
      assert.ok(entry.argsSchema, `${entry.name} must expose argsSchema`);
      assert.ok(entry.invocation?.argsShape, `${entry.name} must expose a summarized args shape`);
      assert.ok(entry.invocation?.category, `${entry.name} must expose a category`);
      assert.ok(entry.invocation?.notes, `${entry.name} must expose operator/agent notes`);
      assert.ok(entry.invocation?.profile, `${entry.name} must expose authority profile`);
      assert.ok(entry.invocation?.runExamples?.some((line) => line.includes(`name="${entry.name}"`)), `${entry.name} must expose runnable examples`);
      assert.ok(entry.invocation?.argsExamples?.length > 0, `${entry.name} must expose structured args examples`);
      assert.ok(entry.invocation?.nextSteps?.some((step) => /workflow_status detail=result/.test(step)), `${entry.name} must expose safe readback next step`);
    }
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
    await fs.rm(extDir, { recursive: true, force: true });
  }
});

test("ux.1: workflow_list surfaces explicit meta invocation fields for a saved workflow and ignores curated defaults", async () => {
  const { tools, context, directory } = await makeHarness(async () => {
    throw new Error("workflow_list metadata must not prompt a model");
  });
  try {
    const source = `export const meta = {
  name: "documented-saved",
  description: "saved workflow with explicit examples",
  profile: "read-only-review",
  maxAgents: 3,
  concurrency: 2,
  category: "custom-saved-category",
  notes: "saved-only note",
  modelTiers: { fast: "vendor/fast-tier", deep: "vendor/deep-tier" },
  examples: [{ label: "narrow run", args: { items: ["a", "b"] } }],
};
return { ok: true };`;
    await tools.workflow_save.execute({ name: "documented-saved", source, scope: "project" }, context);

    const listed = JSON.parse(await tools.workflow_list.execute({ format: "json" }, context));
    const saved = listed.find((entry) => entry.scope === "project" && entry.name === "documented-saved");
    assert.ok(saved, "missing saved documented-saved workflow");
    const inv = saved.invocation;
    assert.equal(inv.category, "custom-saved-category");
    assert.equal(inv.notes, "saved-only note");
    assert.equal(inv.maxAgents, 3);
    assert.equal(inv.concurrency, 2);
    assert.equal(inv.profile, "read-only-review");
    assert.equal(inv.modelTier.fast, "vendor/fast-tier");
    assert.equal(inv.modelTier.deep, "vendor/deep-tier");
    assert.deepEqual(inv.argsExamples[0].args, { items: ["a", "b"] });
    assert.ok(inv.runExamples.some((line) => /name="documented-saved"/.test(line) && /"items"/.test(line)));
    // read-only workflow => no workflow_apply approval step.
    assert.ok(!inv.nextSteps.some((step) => /workflow_apply/.test(step)), "read-only workflow must not mention workflow_apply");
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("ux.1: workflow_list redacts secret-bearing example args and never leaks the raw value", async () => {
  const { tools, context, directory } = await makeHarness(async () => {
    throw new Error("workflow_list redaction must not prompt a model");
  });
  try {
    const source = `export const meta = {
  name: "leaky-examples",
  profile: "read-only-review",
  examples: [{ label: "looks safe", args: { token: "SUPER-SECRET-VALUE-123", mode: "dry-run" } }],
};
return { ok: true };`;
    await tools.workflow_save.execute({ name: "leaky-examples", source, scope: "project" }, context);

    const json = await tools.workflow_list.execute({ format: "json" }, context);
    const summary = await tools.workflow_list.execute({}, context);
    assert.ok(!json.includes("SUPER-SECRET-VALUE-123"), "json output must not contain the raw secret");
    assert.ok(!summary.includes("SUPER-SECRET-VALUE-123"), "summary output must not contain the raw secret");
    assert.ok(json.includes("[redacted]"), "secret key must be redacted");
    const listed = JSON.parse(json);
    const leaky = listed.find((entry) => entry.scope === "project" && entry.name === "leaky-examples");
    assert.equal(leaky.invocation.argsExamples[0].args.token, "[redacted]");
    assert.equal(leaky.invocation.argsExamples[0].args.mode, "dry-run");
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("ux.1: workflow_list malformed entries stay bounded and carry no invocation metadata", async () => {
  const { tools, context, directory } = await makeHarness(async () => {
    throw new Error("workflow_list malformed handling must not prompt a model");
  });
  try {
    const projectRoot = projectWorkflowDir(context);
    await fs.mkdir(projectRoot, { recursive: true });
    await fs.writeFile(path.join(projectRoot, "broken.js"), "export const meta = { name: \"broken\"", "utf8");

    const listed = JSON.parse(await tools.workflow_list.execute({ format: "json" }, context));
    const broken = listed.find((entry) => entry.scope === "project" && entry.name === "broken");
    assert.ok(broken, "missing malformed broken workflow");
    assert.equal(broken.status, "malformed");
    assert.equal(broken.invocation, undefined, "malformed entries must not carry invocation metadata");

    const summary = await tools.workflow_list.execute({}, context);
    assert.match(summary, /project\/broken malformed:/);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("jbs3.10: workflow_list surfaces the args shape declared by meta.argsSchema", async () => {
  const { tools, context, directory } = await makeHarness(async () => {
    throw new Error("workflow_list args-shape must not prompt a model");
  });
  try {
    const source = `export const meta = {
  name: "documented-args",
  profile: "read-only-review",
  argsSchema: { type: "object", properties: { mode: { type: "string" }, count: { type: "integer" } }, required: ["mode"], additionalProperties: false },
};
return { ok: true };`;
    await tools.workflow_save.execute({ name: "documented-args", source, scope: "project" }, context);

    const listed = JSON.parse(await tools.workflow_list.execute({ format: "json" }, context));
    const entry = listed.find((e) => e.scope === "project" && e.name === "documented-args");
    assert.ok(entry, "missing documented-args workflow");
    assert.equal(entry.argsSchema.required[0], "mode", "raw schema surfaced for json consumers");
    assert.ok(/mode:string\*/.test(entry.invocation.argsShape), "args shape marks required mode");
    assert.ok(/count:integer/.test(entry.invocation.argsShape), "args shape lists optional count");

    const summary = await tools.workflow_list.execute({}, context);
    assert.match(summary, /args: \{ mode:string\*, count:integer \}/);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("ux.1: workflow_list summary renders runnable run: lines and next steps for bundled workflows", async () => {
  const { tools, context, directory } = await makeHarness(async () => ({ data: { parts: [], info: {} } }), {
    extensions: [FIXTURE_DRAIN_EXT],
  });
  try {
    const summary = await tools.workflow_list.execute({}, context);
    assert.match(summary, /run: workflow_run name="fixture-drain"/);
    assert.match(summary, /profile=drain-autonomous-local/);
    assert.match(summary, /next: .*workflow_status detail=result/);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("workflow_run resolves extension workflows by name and project overrides win", async () => {
  const extDir = await makeExtensionDir();
  const extPath = await writeFakeExtension(extDir, {
    id: "resolve-order",
    assetDirs: { workflows: "./workflows" },
    workflows: { "fixture-rich": RICH_META_WORKFLOW },
  });
  const { tools, context, directory } = await makeHarness(async () => ({ data: { parts: [], info: {} } }), {
    extensions: [extPath],
  });
  try {
    await initGitRepo(directory);

    const extWorkflowPath = path.join(extDir, "workflows", "fixture-rich.js");
    const extPreview = await tools.workflow_run.execute({ name: "fixture-rich" }, context);
    assert.match(extPreview, new RegExp(`Source: ${extWorkflowPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));

    const projectPath = path.join(projectWorkflowDir(context), "fixture-rich.js");
    await fs.mkdir(path.dirname(projectPath), { recursive: true });
    await fs.writeFile(projectPath, `export const meta = { name: "fixture-rich", description: "project override" };
return true;`, "utf8");
    const projectPreview = await tools.workflow_run.execute({ name: "fixture-rich" }, context);
    assert.match(projectPreview, new RegExp(`Source: ${projectPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    assert.match(projectPreview, /Description: project override/);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
    await fs.rm(extDir, { recursive: true, force: true });
  }
});
