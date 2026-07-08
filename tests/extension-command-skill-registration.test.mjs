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

test("the first-registered command name wins on a collision (registration order precedence)", async () => {
  const dirA = await makeExtensionDir();
  await writeFakeExtension(dirA, {
    id: "ext-a",
    assetDirs: { commands: "./commands" },
    commands: { dupe: "FIRST REGISTRATION — must win.\n" },
  });
  const dirB = await makeExtensionDir();
  await writeFakeExtension(dirB, {
    id: "ext-b",
    assetDirs: { commands: "./commands" },
    commands: { dupe: "SECOND REGISTRATION — must not win.\n" },
  });

  const cfg = {};
  await configureWorkflowEntrypoints(cfg, {
    workflows: [],
    commands: [path.join(dirA, "commands"), path.join(dirB, "commands")],
    skills: [],
  });

  assert.match(cfg.command.dupe.template, /FIRST REGISTRATION/);
  assert.doesNotMatch(cfg.command.dupe.template, /SECOND REGISTRATION/);
});

test("no-extension call registers no commands but still pushes the bundled skill dir", async () => {
  const cfg = {};
  await configureWorkflowEntrypoints(cfg); // no second arg
  assert.equal(Object.keys(cfg.command ?? {}).length, 0, "pure-architecture plugin bundles no commands");
  assert.ok(Array.isArray(cfg.skills.paths) && cfg.skills.paths.length >= 1, "bundled skill dir still pushed");
});

test("bundled workflow authoring skill ships in the skill dir", async () => {
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
});
