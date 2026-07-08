import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";

import WorkflowPlugin from "../workflow-kernel/index.js";
import { createExtensionRegistry } from "../workflow-kernel/extension-registry.js";

const { __test } = WorkflowPlugin;
const root = path.resolve(import.meta.dirname, "..");
const BEADS_EXT_PATH = path.join(root, "workflow-domains", "beads", "beads-extension.js");

// Load the beads extension into a registry and return its asset dirs, mirroring how the plugin
// config hook merges extension-contributed commands/skills into the entrypoint registration.
async function beadsExtensionAssetDirs() {
  const reg = createExtensionRegistry();
  await reg.loadExtensions([BEADS_EXT_PATH], { configDir: root });
  return reg.assetDirs();
}

test("beads-drain workflow delegates domain control to the host-owned drain primitive", async () => {
  const source = await fs.readFile(path.join(root, "workflow-domains", "beads", "workflows", "beads-drain.js"), "utf8");
  const { meta, body } = __test.parseWorkflowSource(source);

  assert.equal(meta.name, "beads-drain");
  assert.equal(meta.harness, "drain");
  assert.equal(meta.adapter, "beads");
  assert.equal(meta.profile, "drain-autonomous-local");
  assert.deepEqual(meta.phases, ["preflight", "snapshot", "claim", "spawn_lanes", "validate", "close", "final_audit", "complete"]);
  // The bundled workflow configures the trusted host primitive. Beads reads/mutations,
  // validation, and final dry proof must not be reimplemented by child prompt plumbing.
  assert.match(body, /\bdrain\s*\(\s*\{\s*adapter:\s*"beads"/);
  assert.doesNotMatch(body, /\bagent\s*\(/);
  assert.doesNotMatch(body, /\bparallel\s*\(/);
  assert.doesNotMatch(body, /\bpipeline\s*\(/);
  assert.match(body, /local-only/);
  // No host internals leak into the script body.
  assert.doesNotMatch(body, /createWorktree|runChildAgent|integrateLaneCommits|execFile|childID/);
});

test("beads-drain skill documents scope, local-only safety, ledgers, and dry proof", async () => {
  const skill = await fs.readFile(path.join(root, "workflow-domains", "beads", "skills", "beads-drain", "SKILL.md"), "utf8");

  assert.match(skill, /^---\nname: beads-drain/m);
  assert.match(skill, /local-only Beads state/);
  assert.match(skill, /Child implementation lanes must not run Beads mutation commands/);
  assert.match(skill, /journaled, and followed by fresh readback/);
  assert.match(skill, /fresh dry proof/);
  assert.match(skill, /Dry-run is the default safe mode/);
  assert.match(skill, /drain-dry-run.*drain-autonomous-local/);
  assert.match(skill, /approved once before launch/);
  assert.match(skill, /must not depend on mid-run interactive permission prompts/);
  // Design C: no live-gate preflight; the kernel verifies a server version floor via
  // GET /global/health and asserts lane rooting/permissions deterministically at launch.
  assert.match(skill, /the kernel verifies the server version floor.*GET \/global\/health.*opencode 1\.17\.13/s);
  assert.match(skill, /there is no live-gate preflight step/);
  assert.match(skill, /asserts lane rooting\/permissions deterministically at launch/);
  assert.match(skill, /laneTimeoutMs.*childPromptTimeoutMs.*3600000/s);
  assert.match(skill, /Dirty timed-out.*salvaged.*preserves the worktree/s);
  assert.match(skill, /host-owned `drain\(\{ adapter: "beads" \}\)` primitive/);
  assert.match(skill, /implementation child lanes still run as the `build` agent/);
  assert.doesNotMatch(skill, /script-body agent-orchestrated loop/);
  assert.match(skill, /legal stop/);
  assert.match(skill, /autonomous-local.*applied to the local primary tree in-run|applied to the local primary tree in-run/);
  // No user-facing EXAMPLE promotes maxWaves/maxAttempts for full drains.
  assert.doesNotMatch(skill, /"maxWaves"\s*:/);
  assert.doesNotMatch(skill, /"maxAttempts"\s*:/);
  assert.match(skill, /raw `result\.json`, ledgers, diff plans, request files, and run state/);
  assert.match(skill, /workflow_cancel.*workflow_pause.*workflow_cleanup/);
  assert.match(skill, /protected reasons/);
  assert.match(skill, /workflow_run\(\{ name: "beads-drain"/);
  // Design C: no separate live-gate release-check step exists (workflow-live-gates-release-check
  // was deleted along with the workflow_live_gates tool).
  assert.match(skill, /there is no separate live-gate release-check step/);
  assert.match(skill, /\/goal supervision/);
});

test("beads-drain command invokes the extension workflow name and requires report evidence", async () => {
  const command = await fs.readFile(path.join(root, "workflow-domains", "beads", "commands", "beads-drain.md"), "utf8");

  assert.match(command, /^---\ndescription: Run the beads-drain workflow/m);
  assert.doesNotMatch(command, /^agent: build$/m, "beads-drain command must not force the controller to build");
  assert.match(command, /workflow_run/);
  assert.match(command, /name: "beads-drain"/);
  assert.match(command, /format: "json"/);
  assert.doesNotMatch(command, /scriptPath/);
  assert.match(command, /no-mutation dry-run/);
  assert.match(command, /mode: "autonomous-local"/);
  assert.match(command, /drain-dry-run.*drain-autonomous-local/s);
  assert.match(command, /approved once before launch/);
  assert.match(command, /without mid-run interactive permission prompts/);
  // Design C: no live-gate preflight; the kernel verifies a server version floor via
  // GET /global/health and asserts lane rooting/permissions deterministically at launch.
  assert.match(command, /the kernel verifies the server version floor.*GET \/global\/health.*opencode 1\.17\.13/s);
  assert.match(command, /there is no live-gate preflight step/);
  assert.match(command, /asserts lane rooting\/permissions deterministically at launch/);
  assert.match(command, /laneTimeoutMs.*childPromptTimeoutMs.*3600000/);
  assert.match(command, /workflow_apply/);
  assert.match(command, /host-owned `drain\(\{ adapter: "beads" \}\)` primitive/);
  assert.match(command, /implementation child lanes still run as the `build` agent/);
  assert.doesNotMatch(command, /script-body agent-orchestrated loop/);
  assert.match(command, /raw run files as local sensitive artifacts/);
  assert.match(command, /workflow_cancel.*workflow_pause.*workflow_cleanup/);
  assert.match(command, /active, locked, malformed, corrupt, interrupted, paused, ambiguous edit, `apply-running`, and `apply-failed`/);
  assert.match(command, /final dry proof/);
  assert.match(command, /domain-ledger summary/);
});

test("README documents first-class beads-drain behavior and release caveats", async () => {
  const readme = await fs.readFile(path.join(root, "README.md"), "utf8");

  assert.match(readme, /## Beads Drain/);
  assert.match(readme, /not part of the published core package/);
  assert.match(readme, /Beads extension is explicitly configured/);
  assert.match(readme, /workflow_list.*scope: "extension"/s);
  assert.match(readme, /docs\/workflow-extensions\.md#beads-is-the-reference-extension/);
  assert.match(readme, /workflow_run\(\{ name: "beads-drain"/);
  assert.match(readme, /mode: "dry-run"/);
  assert.match(readme, /Dry-run is the default safe path/);
  assert.match(readme, /Non-dry Beads drain fails closed/);
  assert.match(readme, /local Git integration worktree isolation/);
  assert.match(readme, /unsafeAcceptUnverifiedPermissions.*not a non-dry bypass/s);
  assert.match(readme, /workflow-live-gates-release-check/);
  assert.match(readme, /host-owned\s+`drain\(\{ adapter: "beads" \}\)` primitive/s);
  assert.doesNotMatch(readme, /script-body agent-orchestrated loop/);
  assert.match(readme, /autonomous-local.*applied to the local\s+primary tree in-run|applied to the local\s+primary tree in-run/s);
  assert.match(readme, /failed-with-diff-plan/);
  assert.match(readme, /dirty-timeout salvage metadata.*`salvaged`/s);
  assert.match(readme, /## Authority Profiles And Apply Boundary/);
  assert.match(readme, /approved once at launch/);
  assert.match(readme, /must not stop mid-run for interactive permission prompts/);
  assert.match(readme, /`read-only-review`/);
  assert.match(readme, /`drain-autonomous-local`/);
  assert.match(readme, /`edit-plan-only`/);
  assert.match(readme, /`workflow_apply` is the normal explicit primary-tree write boundary/);
  assert.match(readme, /intentional in-run apply exception is the extension-trusted non-dry `beads-drain`/);
  assert.match(readme, /launch approval\s+authorizes in-run apply of a verified successful diff plan/s);
  assert.match(readme, /Elevated workflow launch may run required live-gate preflight probes after\s+approval/s);
  assert.match(readme, /scratch worktrees/);
  assert.match(readme, /Raw `result\.json`, ledgers, diff plans, request files, and run state/);
  assert.match(readme, /## Durable Lifecycle And Cleanup/);
  assert.match(readme, /cancel-request\.json.*pause-request\.json/s);
  assert.match(readme, /protectedRuns/);
  assert.match(readme, /docs\/plugin-system-tests\.md/);
});

test("plugin system-test docs define safe-mode startup smoke evidence", async () => {
  const doc = await fs.readFile(path.join(root, "docs", "plugin-system-tests.md"), "utf8");

  assert.match(doc, /## Safe-Mode Startup Smoke/);
  assert.match(doc, /OpenCode loads plugins at startup/);
  assert.match(doc, /trustMode: "safe"/);
  assert.match(doc, /cleanupPolicy: "delete-on-stop"/);
  assert.match(doc, /workflows\.js/);
  assert.match(doc, /command registry/);
  assert.match(doc, /tool registry/);
  assert.match(doc, /beads-drain/);
  assert.match(doc, /workflow-live-gates-release-check/);
  assert.match(doc, /safe-mode registration limitation/);
  assert.match(doc, /Use an inherited\s+child for the actual plugin registration proof/s);
  assert.match(doc, /workflow_run/);
  assert.match(doc, /processAlive: false/);
  assert.match(doc, /child ID/);
  assert.match(doc, /PID/);
  assert.match(doc, /port/);
  assert.match(doc, /Registry presence proves startup registration only/);
  assert.match(doc, /release:no-token/);
  assert.match(doc, /release:child-system-smoke/);
  assert.match(doc, /OPENCODE_WORKFLOWS_CHILD_SMOKE=1/);
  assert.match(doc, /oc_plugin_smoke_test/);
});

test("package scripts expose repeatable release verification targets", async () => {
  const pkg = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"));

  assert.equal(pkg.scripts["release:no-token"], "node scripts/release-no-token.mjs");
  assert.equal(pkg.scripts["release:child-system-smoke"], "node scripts/child-system-smoke.mjs");
  const releaseSrc = await fs.readFile(path.join(root, "scripts", "release-no-token.mjs"), "utf8");
  assert.match(releaseSrc, /npm test/);
  assert.match(releaseSrc, /npm pack --dry-run --json/);
  assert.match(await fs.readFile(path.join(root, "scripts", "child-system-smoke.mjs"), "utf8"), /OPENCODE_WORKFLOWS_CHILD_SMOKE/);
  assert.match(await fs.readFile(path.join(root, "scripts", "child-system-smoke.mjs"), "utf8"), /skipped/);
});

// docs/plugin-system-tests.md's "## Permission Gate Diagnostics" section documents the deleted
// workflow_live_gates tool end to end (probe flags, gate names, failed-with-evidence state); the
// section itself is stale doc content slated for the Task 11 docs pass, not something Task 10
// (test-suite reconciliation) rewrites test coverage for. Deleted rather than rewritten: there is
// no surviving mechanism in this section to assert against.

test("plugin system-test docs define child restart reload checks", async () => {
  const doc = await fs.readFile(path.join(root, "docs", "plugin-system-tests.md"), "utf8");

  assert.match(doc, /## Restart And Plugin Reload Check/);
  assert.match(doc, /oc_child_restart/);
  assert.match(doc, /fresh child OpenCode server/);
  assert.match(doc, /do not automate or\s+restart the parent TUI/s);
  assert.match(doc, /before-restart child status/);
  assert.match(doc, /after-restart child status/);
  assert.match(doc, /new PID/);
  assert.match(doc, /workflow tool IDs/);
  assert.match(doc, /processAlive: false/);
});

test("historical reports are clearly marked as snapshots", async () => {
  const release = await fs.readFile(path.join(root, "docs", "release-gate-validation-2026-06-16.md"), "utf8");
  const dogfood = await fs.readFile(path.join(root, "docs", "dogfood-rollout-2026-06-16.md"), "utf8");
  const design = await fs.readFile(path.join(root, "docs", "workflow-autonomous-harness-design.md"), "utf8");

  assert.match(release, /Historical snapshot/);
  assert.match(dogfood, /Historical snapshot/);
  assert.match(design, /Historical design snapshot/);
});

test("beads-drain plugin command registration uses current OpenCode command schema", async () => {
  const cfg = {};

  // beads-drain is now an extension-contributed command; the bundled-only call cannot register it.
  await __test.configureWorkflowEntrypoints(cfg, await beadsExtensionAssetDirs());

  assert.equal(cfg.command["beads-drain"].description, "Run the beads-drain workflow with explicit scope and final dry proof");
  assert.match(cfg.command["beads-drain"].template, /workflow_run/);
  assert.equal(Object.hasOwn(cfg.command["beads-drain"], "prompt"), false);
  // Design C deleted workflow_live_gates and its /workflow-live-gates-release-check command
  // entirely (no probe/reset tool surface left to gate a release check against).
  assert.equal(cfg.command["workflow-live-gates-release-check"], undefined);
});

// Design C deleted workflow_live_gates (and its /workflow-live-gates-release-check command)
// entirely: there is no probe/reset tool surface, so a release check gated on "configured"/
// "verified" gate state has nothing left to check. The two tests that used to live here proved
// that command's doc contract (opt-in probing, pass criteria, the full/native-edit vs non-dry
// Beads gate-subset split); both die with the deleted command file. Release readiness is now
// simply: does `npm test` pass, plus the deterministic checks proven throughout
// tests/workflow-run.test.mjs and tests/sandbox-executor.test.mjs (server-fingerprint version
// floor, permission/directory echo, worktree capability shape).

test("goal supervision docs define evaluator boundary and completion evidence", async () => {
  const doc = await fs.readFile(path.join(root, "docs", "goal-supervision-autonomous-drains.md"), "utf8");

  assert.match(doc, /should not schedule lanes, merge worktrees, mutate domain state, close Beads, or apply primary-tree changes itself/);
  assert.match(doc, /Final dry proof from fresh domain scans/);
  assert.match(doc, /Domain-ledger summary/);
  assert.match(doc, /Clean Git\/worktree state/);
  assert.match(doc, /workflow_apply/);
  assert.match(doc, /assistant claim alone/);
});
