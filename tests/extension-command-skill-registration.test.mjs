import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";

import WorkflowPlugin from "../workflow-kernel/workflow-plugin.js";
import { makeExtensionDir, writeFakeExtension } from "./helpers/fake-extension.mjs";

const { configureWorkflowEntrypoints } = WorkflowPlugin.__test;

// ---- Stage 2: extension commands + skills merge into entrypoint registration ----

test("extension command dirs register into cfg.command and skill dirs push into cfg.skills.paths", async () => {
  const dir = await makeExtensionDir();
  await writeFakeExtension(dir, {
    assetDirs: { commands: "./commands", skills: "./skills" },
    commands: { "ext-only-cmd": "Run the ext-only-cmd workflow.\n" },
    skills: { "ext-skill": "---\nname: ext-skill\n---\next skill.\n" },
  });
  const cmdDir = path.join(dir, "commands");
  const skillDir = path.join(dir, "skills");

  const cfg = {};
  await configureWorkflowEntrypoints(cfg, { workflows: [], commands: [cmdDir], skills: [skillDir] });

  assert.ok(cfg.command["ext-only-cmd"], "net-new extension command registered");
  assert.ok(cfg.skills.paths.includes(skillDir), "extension skill dir pushed into cfg.skills.paths");
});

test("a bundled command name wins over a same-named extension command (bundled > extension)", async () => {
  // Baseline: register bundled commands only and capture the bundled repo-review command.
  const cfgBundled = {};
  await configureWorkflowEntrypoints(cfgBundled);
  const bundledRepoReview = cfgBundled.command["repo-review"];
  assert.ok(bundledRepoReview, "repo-review is a bundled command");

  // Now register WITH an extension that shadows repo-review with distinctive content.
  const dir = await makeExtensionDir();
  await writeFakeExtension(dir, {
    assetDirs: { commands: "./commands" },
    commands: { "repo-review": "EXTENSION SHADOW — must not win.\n" },
  });
  const cfg = {};
  await configureWorkflowEntrypoints(cfg, { workflows: [], commands: [path.join(dir, "commands")], skills: [] });

  assert.deepEqual(
    cfg.command["repo-review"],
    bundledRepoReview,
    "bundled repo-review is unchanged by the shadowing extension command",
  );
});

test("no-extension call still registers bundled commands + skill dir (backward compatible)", async () => {
  const cfg = {};
  await configureWorkflowEntrypoints(cfg); // no second arg
  assert.ok(cfg.command["repo-review"], "bundled commands still registered with the default arg");
  assert.ok(Array.isArray(cfg.skills.paths) && cfg.skills.paths.length >= 1, "bundled skill dir still pushed");
});

test("bundled workflow authoring and repo-review command protocol skills ship in the skill dir", async () => {
  const root = path.resolve(import.meta.dirname, "..");
  const skillDir = path.join(root, "skills");
  const cfg = {};
  await configureWorkflowEntrypoints(cfg);

  assert.ok(cfg.skills.paths.includes(skillDir), "bundled skills directory is registered");

  const authoring = await fs.readFile(path.join(skillDir, "opencode-workflow-authoring", "SKILL.md"), "utf8");
  assert.match(authoring, /^name: opencode-workflow-authoring$/m);
  assert.match(authoring, /author -> run -> read -> decide/);
  assert.match(authoring, /autoApprove/);
  assert.match(authoring, /budget\.remaining\(\)/);
  assert.match(authoring, /arity/);
  assert.match(authoring, /inline result/i);

  const protocol = await fs.readFile(path.join(skillDir, "repo-review-command-protocol", "SKILL.md"), "utf8");
  assert.match(protocol, /^name: repo-review-command-protocol$/m);
  assert.match(protocol, /workflow_run/);
  assert.match(protocol, /workflow_status\(\{ runId, detail: "result" \}\)/);
  assert.match(protocol, /\.repo-review\/runs/);
  assert.match(protocol, /ONLY allowed workspace write/);
});
