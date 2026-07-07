import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";

import {
  resolveWorkflowSource,
  trustedWorkflowRoots,
  isTrustedWorkflowPath,
  buildNestedSnapshots,
  projectWorkflowDir,
} from "../workflow-kernel/workflow-source.js";
import { listWorkflows } from "../workflow-kernel/role-template-loading.js";
import WorkflowPlugin from "../workflow-kernel/workflow-plugin.js";
import { makeExtensionDir, writeFakeExtension, defaultWorkflowBody } from "./helpers/fake-extension.mjs";

async function tmp(prefix) {
  return await fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

// ---- Stage 2: extension workflow dirs merge into resolution (project > global > extension > bundled) ----

test("resolveWorkflowSource finds a workflow in an extension dir", async () => {
  const dir = await makeExtensionDir();
  await writeFakeExtension(dir, {
    assetDirs: { workflows: "./workflows" },
    workflows: { "fake-wf": defaultWorkflowBody("fake-wf") },
  });
  const extWfDir = path.join(dir, "workflows");
  const context = { directory: await tmp("proj-"), worktree: undefined };

  const resolved = await resolveWorkflowSource(context, { name: "fake-wf" }, [extWfDir]);
  assert.equal(resolved.sourcePath, path.join(extWfDir, "fake-wf.js"));
  assert.match(resolved.source, /fake-wf/);
});

test("resolveWorkflowSource reports searched registries for an unknown workflow name", async () => {
  const dir = await makeExtensionDir();
  await writeFakeExtension(dir, { assetDirs: { workflows: "./workflows" } });
  const extWfDir = path.join(dir, "workflows");
  const projectRoot = await tmp("proj-");

  await assert.rejects(
    resolveWorkflowSource({ directory: projectRoot, worktree: projectRoot }, { name: "missing-wf" }, [extWfDir]),
    (error) => {
      assert.match(error.message, /Workflow name "missing-wf" was not found/);
      assert.match(error.message, /project:/);
      assert.match(error.message, /global:/);
      assert.match(error.message, /extension:/);
      assert.match(error.message, /bundled:/);
      assert.match(error.message, /missing-wf\.js/);
      assert.doesNotMatch(error.message, /Provide `source`, `scriptPath`, or `name`/);
      return true;
    },
  );
});

test("a project shadow wins over the extension dir (project > extension)", async () => {
  const dir = await makeExtensionDir();
  await writeFakeExtension(dir, {
    assetDirs: { workflows: "./workflows" },
    workflows: { "dup-wf": defaultWorkflowBody("dup-wf", "// extension copy\n") },
  });
  const extWfDir = path.join(dir, "workflows");
  const projectRoot = await tmp("proj-");
  const projWfDir = projectWorkflowDir({ directory: projectRoot, worktree: projectRoot });
  await fs.mkdir(projWfDir, { recursive: true });
  await fs.writeFile(path.join(projWfDir, "dup-wf.js"), defaultWorkflowBody("dup-wf", "// project copy\n"));

  const resolved = await resolveWorkflowSource(
    { directory: projectRoot, worktree: projectRoot },
    { name: "dup-wf" },
    [extWfDir],
  );
  assert.equal(resolved.sourcePath, path.join(projWfDir, "dup-wf.js"));
  assert.match(resolved.source, /project copy/);
});

test("trustedWorkflowRoots orders extension dirs before bundled", async () => {
  const extWfDir = "/ext/beads/workflows";
  const context = { directory: "/proj", worktree: "/proj" };
  const roots = trustedWorkflowRoots(context, [extWfDir]);
  const extIdx = roots.indexOf(extWfDir);
  assert.ok(extIdx >= 0, "extension dir present in trusted roots");
  // bundled root is the last entry; extension must precede it
  assert.ok(extIdx < roots.length - 1, "extension dir precedes bundled");
});

test("scriptPath into an extension dir is admitted as a trusted root", async () => {
  const dir = await makeExtensionDir();
  await writeFakeExtension(dir, {
    assetDirs: { workflows: "./workflows" },
    workflows: { "script-wf": defaultWorkflowBody("script-wf") },
  });
  const extWfDir = path.join(dir, "workflows");
  const scriptPath = path.join(extWfDir, "script-wf.js");
  const context = { directory: await tmp("proj-"), worktree: undefined };

  // With the extension dir trusted, the explicit scriptPath is admitted (no opt-in needed).
  const resolved = await resolveWorkflowSource(context, { scriptPath }, [extWfDir]);
  assert.equal(resolved.sourcePath, scriptPath);

  // Without it, the same scriptPath is rejected as outside trusted roots.
  await assert.rejects(
    resolveWorkflowSource(context, { scriptPath }, []),
    /outside trusted workflow roots/i,
  );
});

test("isTrustedWorkflowPath trusts an extension dir only when supplied", async () => {
  const extWfDir = "/ext/beads/workflows";
  const p = path.join(extWfDir, "x.js");
  const context = { directory: "/proj", worktree: "/proj" };
  assert.equal(isTrustedWorkflowPath(p, context, [extWfDir]), true);
  assert.equal(isTrustedWorkflowPath(p, context, []), false);
});

test("buildNestedSnapshots resolves a nested workflow from an extension dir", async () => {
  const dir = await makeExtensionDir();
  await writeFakeExtension(dir, {
    assetDirs: { workflows: "./workflows" },
    workflows: { "nested-ext-wf": defaultWorkflowBody("nested-ext-wf") },
  });
  const extWfDir = path.join(dir, "workflows");
  const context = { directory: await tmp("proj-"), worktree: undefined };
  const parentSource = 'export const meta = { name: "parent" };\nawait workflow({ name: "nested-ext-wf" });\nreturn "ok";\n';

  const snapshots = await buildNestedSnapshots(context, parentSource, [extWfDir]);
  assert.ok(
    snapshots.has(path.join(extWfDir, "nested-ext-wf.js")),
    "nested extension workflow captured by its resolved extension path",
  );
});

test("listWorkflows lists an extension workflow with scope:extension", async () => {
  const dir = await makeExtensionDir();
  await writeFakeExtension(dir, {
    assetDirs: { workflows: "./workflows" },
    workflows: { "listed-wf": defaultWorkflowBody("listed-wf") },
  });
  const extWfDir = path.join(dir, "workflows");
  const context = { directory: await tmp("proj-"), worktree: undefined };

  const result = await listWorkflows(context, { format: "json" }, null, [extWfDir]);
  const entries = JSON.parse(result);
  const entry = entries.find((w) => w.name === "listed-wf");
  assert.ok(entry, `listed-wf present (saw: ${JSON.stringify(entries.map((w) => w.name))})`);
  assert.equal(entry.scope, "extension");
});

test("workflow_list (integration) surfaces an extension workflow as scope:extension", async () => {
  const dir = await makeExtensionDir();
  await writeFakeExtension(dir, {
    id: "fixture",
    assetDirs: { workflows: "./workflows" },
    workflows: { "integ-wf": defaultWorkflowBody("integ-wf") },
  });
  const extPath = path.join(dir, "extension.js");
  const projectDir = await tmp("proj-");
  const pluginContext = {
    directory: projectDir,
    worktree: projectDir,
    client: { config: { async get() { return { data: { model: "opencode/x" } }; } } },
  };
  const hooks = await WorkflowPlugin(pluginContext, { extensions: [extPath] });
  await hooks.config({});

  const context = { directory: projectDir, worktree: projectDir, sessionID: "s", messageID: "m", agent: "build", metadata() {} };
  const out = await hooks.tool.workflow_list.execute({ format: "json" }, context);
  const parsed = typeof out === "string" ? JSON.parse(out) : out;
  const list = parsed.workflows ?? parsed;
  const entry = list.find((w) => w.name === "integ-wf");
  assert.ok(entry, `integ-wf present in workflow_list (saw ${JSON.stringify(list.map((w) => w.name))})`);
  assert.equal(entry.scope, "extension");
});
