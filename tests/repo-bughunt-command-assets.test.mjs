import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";

import WorkflowPlugin from "../opencode-workflows.js";

const { __test } = WorkflowPlugin;
const root = path.resolve(import.meta.dirname, "..");
const COMMAND_PATH = path.join(root, "commands", "repo-bughunt.md");

async function readCommand() {
  return fs.readFile(COMMAND_PATH, "utf8");
}

test("repo-bughunt command asset exists with valid frontmatter", async () => {
  // (1) The file exists and carries YAML frontmatter. The runtime
  // parser split is proven by the registration test below (configureWorkflowEntrypoints calls
  // parseCommandMarkdown and surfaces .description/.template), mirroring beads-drain-assets.
  const command = await readCommand();

  assert.match(command, /^---\n[\s\S]*?\n---\n/m, "command must open with a YAML frontmatter block");
  assert.match(command, /^description: .+/m, "frontmatter must declare a description");
  assert.doesNotMatch(command, /^agent: build$/m, "frontmatter must not force the build agent");
  assert.match(command, /workflow_run/);
});

test("repo-bughunt plugin command registration resolves under configureWorkflowEntrypoints", async () => {
  // (2) Bundled commands are not auto-discovered; registration requires the coordinated
  // constants.js + configureWorkflowEntrypoints edits, mirroring beads-drain.
  const cfg = {};

  await __test.configureWorkflowEntrypoints(cfg);

  assert.ok(cfg.command["repo-bughunt"], "cfg.command['repo-bughunt'] must resolve after registration");
  assert.equal(typeof cfg.command["repo-bughunt"].description, "string");
  assert.match(cfg.command["repo-bughunt"].template, /workflow_run/);
  assert.equal(Object.hasOwn(cfg.command["repo-bughunt"], "prompt"), false);
  assert.equal(Object.hasOwn(cfg.command["repo-bughunt"], "agent"), false);

  // beads-drain is now an extension-contributed command (see beads-drain-assets), so a bundled-only
  // configureWorkflowEntrypoints call does not register it.
});

test("repo-bughunt command invokes workflow_run by NAME, never by path", async () => {
  // (3) Name-based invocation only.
  const command = await readCommand();

  assert.match(command, /workflow_run/);
  assert.match(command, /name: "repo-bughunt"/);
  assert.match(command, /format: "json"|"format": "json"/);
  assert.doesNotMatch(command, /scriptPath/);
});

test("repo-bughunt command reads back the result via workflow_status detail=result", async () => {
  // (4) Result readback is required before any report rendering.
  const command = await readCommand();

  assert.match(command, /workflow_status/);
  assert.match(command, /detail: "result"/);
  // The envelope is read from the status result object.
  assert.match(command, /\.result\.output/);
});

test("repo-bughunt command persists the single-domain report under .repo-review/runs", async () => {
  // (5) Command-side report artifact path + fallback rendering when reportMarkdown is dropped.
  const command = await readCommand();

  assert.match(command, /\.repo-review\/runs/);
  assert.match(command, /bughunt-report\.md/);
  assert.match(command, /mkdir -p/);
  // Preferred path: render from the engine's reportMarkdown.
  assert.match(command, /reportMarkdown/);
  // Fallback path: synthesize a short markdown summary from findings/counts when the engine
  // dropped reportMarkdown to fit the 256 KiB result cap.
  assert.match(command, /findings/);
  assert.match(command, /counts/);
  assert.match(command, /omitted for size|fallback|256 KiB/i);
});

test("repo-bughunt command is report-only: forbids automatic mutation", async () => {
  // (6) The command explicitly avoids every mutating surface and names the report artifact as
  // the ONLY allowed workspace write. Because the prohibition names these tools, we assert the
  // boundary is present; the happy-path flow (workflow_run -> workflow_status -> write report)
  // never instructs running a mutator.
  const command = await readCommand();

  // Each mutating surface is named under an explicit prohibition.
  for (const forbidden of [/materialize/, /beads-drain/, /workflow_apply/, /git/, /\bbd\b/]) {
    assert.match(command, forbidden, "boundary must name this mutating surface");
  }
  assert.match(command, /avoid|do not|must not|never|forbidden|out of scope/i);
  // The report artifact is the single allowed workspace write.
  assert.match(command, /ONLY allowed workspace write/);
  // No positive instruction to run a mutator as a workflow step. The prohibition phrasing
  // ("Avoid …", "out of scope", "any git write", "any bd …") intentionally avoids the
  // verb+mutator adjacency this guards against.
  assert.doesNotMatch(
    command,
    /\b(?:run|call|invoke|execute)\s+(?:the\s+)?(?:materialize|beads-drain|workflow_apply|bd\s+(?:create|update|close|claim))\b/i,
  );
  // And no instruction to commit/push the report artifact.
  assert.match(command, /do not stage or commit|do not commit|gitignored/i);
});

test("repo-bughunt command validates $ARGUMENTS as an object before workflow_run", async () => {
  // Acceptance: stop on malformed / non-object arguments before workflow_run; default
  // to the engine's thorough pass when empty; valid depth quick/normal/thorough.
  const command = await readCommand();

  assert.match(command, /\$ARGUMENTS/);
  assert.match(command, /STOP|stop before/i);
  assert.match(command, /valid JSON/);
  assert.match(command, /object/);
  assert.match(command, /default to the engine's thorough/i);
  assert.doesNotMatch(command, /default to a normal-depth/i);
  assert.doesNotMatch(command, /depth": "normal"/);
  assert.match(command, /quick/);
  assert.match(command, /thorough/);
  assert.match(command, /workflow-model-tiering/);
  assert.match(command, /modelTiers/);
});
