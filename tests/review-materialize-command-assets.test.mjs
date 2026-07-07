import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";

import WorkflowPlugin from "../opencode-workflows.js";
import { createExtensionRegistry } from "../workflow-kernel/extension-registry.js";

const { __test } = WorkflowPlugin;
const root = path.resolve(import.meta.dirname, "..");
const COMMAND_PATH = path.join(root, "workflow-domains", "beads", "commands", "review-materialize.md");
const BEADS_EXT_PATH = path.join(root, "workflow-domains", "beads", "beads-extension.js");

async function beadsExtensionAssetDirs() {
  const reg = createExtensionRegistry();
  await reg.loadExtensions([BEADS_EXT_PATH], { configDir: root });
  return reg.assetDirs();
}

async function readCommand() {
  return fs.readFile(COMMAND_PATH, "utf8");
}

test("review-materialize command asset exists with valid frontmatter", async () => {
  const command = await readCommand();
  assert.match(command, /^---\n[\s\S]*?\n---\n/m);
  assert.match(command, /^description: .+/m);
  assert.match(command, /review_materialize/);
  assert.match(command, /workflow-domains\/beads\/review-materialize-adapter\.js/);
});

test("review-materialize plugin command registration resolves (extension-contributed)", async () => {
  const cfg = {};
  // review-materialize.md moved into the beads extension; the bundled-only call cannot register it.
  await __test.configureWorkflowEntrypoints(cfg, await beadsExtensionAssetDirs());
  assert.ok(cfg.command["review-materialize"], "cfg.command['review-materialize'] must resolve");
  assert.equal(typeof cfg.command["review-materialize"].description, "string");
  // Bundled siblings remain intact; beads-drain also arrives via the same extension asset dirs.
  assert.ok(cfg.command["repo-review"]);
  assert.ok(cfg.command["beads-drain"]);
});

test("review-materialize command defaults to dry-run and requires explicit approval", async () => {
  const command = await readCommand();
  assert.match(command, /dry.?run/i);
  assert.match(command, /approval|approve/i);
  assert.match(command, /explicit/i);
});

test("review-materialize command checks materializationReady before proceeding", async () => {
  const command = await readCommand();
  assert.match(command, /materializationReady/);
  assert.match(command, /acceptPartial/);
});

test("review-materialize command is local-only: forbids push/commit/dolt", async () => {
  const command = await readCommand();
  assert.match(command, /git push|no.*push/i);
  assert.match(command, /dolt push/i);
  assert.match(command, /git commit|no.*commit/i);
});

test("review-materialize command names idempotency (re-runs do not double-create)", async () => {
  const command = await readCommand();
  assert.match(command, /idempotent/i);
});

test("review-materialize command documents Beads-ready shape and post-materialization review", async () => {
  const command = await readCommand();
  assert.match(command, /description`, `design`, and `acceptance`|native Beads fields/i);
  assert.match(command, /not[\s\S]*ready-for-agent/i);
  assert.match(command, /beads-review post-materialization/i);
  assert.match(command, /runId/);
  assert.match(command, /Do not pass `findings`, `findingsPath`, or `materializationReady` with `runId`/);
  assert.match(command, /not a repo-review result|domain: "repo-review"/i);
  assert.match(command, /domainDetails|lossy/i);
});

test("review-materialize command documents verify-only recovery after verifier failure", async () => {
  const command = await readCommand();
  assert.match(command, /verifyOnly/);
  assert.match(command, /materialized_verify_failed/);
  assert.match(command, /no Beads\s+writes|must not call `bd create`/i);
  assert.match(command, /failedChecks/);
  assert.match(command, /suggestedNextAction/);
  assert.match(command, /verdict=pass/);
  assert.match(command, /verdict=hard_fail/);
  assert.match(command, /verdict=tool_error/);
});
