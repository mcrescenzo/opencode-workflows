import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";

import WorkflowPlugin from "../opencode-workflows.js";

const { __test } = WorkflowPlugin;
const root = path.resolve(import.meta.dirname, "..");
const COMMAND_PATH = path.join(root, "commands", "repo-review.md");

async function readCommand() {
  return fs.readFile(COMMAND_PATH, "utf8");
}

test("repo-review command asset exists with valid frontmatter", async () => {
  // (1) The file exists and carries YAML frontmatter. The runtime
  // parser split is proven by the registration test below (configureWorkflowEntrypoints calls
  // parseCommandMarkdown and surfaces .description/.template), mirroring repo-bughunt-assets.
  const command = await readCommand();

  assert.match(command, /^---\n[\s\S]*?\n---\n/m, "command must open with a YAML frontmatter block");
  assert.match(command, /^description: .+/m, "frontmatter must declare a description");
  assert.doesNotMatch(command, /^agent: build$/m, "frontmatter must not force the build agent");
  assert.match(command, /workflow_run/);
});

test("repo-review plugin command registration resolves under configureWorkflowEntrypoints", async () => {
  // (2) Bundled commands are not auto-discovered; registration requires the coordinated
  // constants.js + configureWorkflowEntrypoints edits, mirroring repo-bughunt/beads-drain.
  const cfg = {};

  await __test.configureWorkflowEntrypoints(cfg);

  assert.ok(cfg.command["repo-review"], "cfg.command['repo-review'] must resolve after registration");
  assert.equal(typeof cfg.command["repo-review"].description, "string");
  assert.match(cfg.command["repo-review"].template, /workflow_run/);
  assert.equal(Object.hasOwn(cfg.command["repo-review"], "prompt"), false);
  assert.equal(Object.hasOwn(cfg.command["repo-review"], "agent"), false);

  // beads-drain moved to the beads extension (covered by beads-drain-assets); a bundled-only call
  // does not register it.
  assert.ok(cfg.command["repo-bughunt"]);
});

test("repo-review command invokes workflow_run by NAME, never by path", async () => {
  // (3) Name-based invocation only.
  const command = await readCommand();

  assert.match(command, /workflow_run/);
  assert.match(command, /name: "repo-review"/);
  assert.match(command, /format: "json"|"format": "json"/);
  assert.doesNotMatch(command, /scriptPath/);
});

test("repo-review command reads back the result via workflow_status detail=result", async () => {
  // (4) Result readback is required before any report rendering.
  const command = await readCommand();

  assert.match(command, /workflow_status/);
  assert.match(command, /detail: "result"/);
  // The envelope is read from the status result object.
  assert.match(command, /\.result\.output/);
});

test("repo-review command persists the merged report under .repo-review/runs", async () => {
  // (5) Command-side report artifact path + artifact-first full-report rendering.
  const command = await readCommand();

  assert.match(command, /\.repo-review\/runs/);
  assert.match(command, /repo-review-report\.md/);
  assert.match(command, /mkdir -p/);
  // Preferred path: read the full markdown from the safe artifact path returned by workflow_status.
  assert.match(command, /artifactPaths\.reportMarkdownPath/);
  assert.match(command, /full report|full ranked cross-domain markdown report/i);
  // Returned reportMarkdown is only a bounded preview/fallback.
  assert.match(command, /reportMarkdown/);
  assert.match(command, /preview\/fallback|bounded.*preview/i);
  // Fallback path: synthesize a short markdown summary from findings/counts when the engine
  // dropped reportMarkdown to fit the 256 KiB result cap.
  assert.match(command, /findings/);
  assert.match(command, /counts/);
  assert.match(command, /omitted for size|fallback|256 KiB/i);
});

test("repo-review command is report-only: forbids automatic mutation", async () => {
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

test("repo-review command validates $ARGUMENTS as an object before workflow_run", async () => {
  // Acceptance: stop on malformed / non-object arguments before workflow_run; default
  // mode:exhaustive when empty; valid mode exhaustive/bounded; depth quick/normal/thorough;
  // optional domains subset.
  const command = await readCommand();

  assert.match(command, /\$ARGUMENTS/);
  assert.match(command, /STOP|stop before/i);
  assert.match(command, /valid JSON/);
  assert.match(command, /object/);
  // Exhaustive is the default (not depth:normal).
  assert.match(command, /mode": "exhaustive"/);
  assert.match(command, /quick/);
  assert.match(command, /thorough/);
  assert.match(command, /bounded/);
  // Optional domains subset.
  assert.match(command, /domains/);
  // Model-tiering resolution before workflow_run.
  assert.match(command, /workflow-model-tiering/);
  assert.match(command, /modelTiers/);
});

test("repo-review command resolves NO FAST MODELS — both tiers map to the same deep model", async () => {
  const command = await readCommand();

  // The command must explicitly state it never selects a fast model.
  assert.match(command, /NO FAST MODELS|never.*fast model/i);
  // Both tiers resolve to the same deep model.
  assert.match(command, /both tiers|both.*to.*same/i);
  // The fast tier is mapped to the deep model (not a fast model).
  assert.match(command, /"fast": "<.*deep.*>"/i);
});

test("repo-review command surfaces leafOutcomes and partialCoverage coverage", async () => {
  // (7) The full-suite command must surface which domains completed/failed via the merged
  // envelope's leafOutcomes ledger and partialCoverage flag.
  const command = await readCommand();

  assert.match(command, /leafOutcomes/);
  assert.match(command, /partialCoverage/);
});

test("repo-review command surfaces the materialization readiness gate", async () => {
  // (8) The command must surface materializationReady / materializationBlockers / coverageGrade
  // and conditionally OFFER materialization ONLY when ready. The offer is a question, never an
  // automatic action — the command itself never mutates.
  const command = await readCommand();

  assert.match(command, /materializationReady/);
  assert.match(command, /materializationBlockers/);
  assert.match(command, /coverageGrade/);
  assert.match(command, /coverageAudit/);
  // The offer is gated on materializationReady and phrased as a question/option, not auto-run.
  assert.match(command, /offer|option|whether/i);
  assert.match(command, /review-materialize/);
  assert.match(command, /Beads extension/);
  assert.match(command, /command\s+registry/);
  assert.match(command, /command is absent|command is unavailable/i);
  assert.match(command, /runId/);
  assert.match(command, /domain: "repo-review"/);
  assert.match(command, /review-time provenance|current\s+`HEAD`/i);
  assert.match(command, /artifactPaths\.findingsJson/);
  // Even though materialize is mentioned, the command must NOT auto-run it.
  assert.doesNotMatch(
    command,
    /\b(?:run|call|invoke|execute)\s+(?:the\s+)?(?:materialize|beads-drain|workflow_apply|bd\s+(?:create|update|close|claim))\b/i,
  );
});
