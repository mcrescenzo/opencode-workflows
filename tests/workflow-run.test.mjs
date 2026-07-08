// startWorkflow / workflow_run / workflow_status / workflow_cancel / workflow_pause
// / workflow_cleanup / drain / notification regression suite.
//
// Split out of the former tests/workflows.test.mjs monolith (bd opencode-workflows-9pv).
// workflow_apply finalization/patch tests live in workflow-apply.test.mjs.

import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as setTimeoutP } from "node:timers/promises";
import { promisify } from "node:util";
import workflowPlugin from "../workflow-kernel/index.js";
import {
  DEFAULT_HARD_CONCURRENCY_LIMIT,
  HARD_CONCURRENCY_LIMIT_ENV,
  MAX_CONFIGURABLE_CONCURRENCY_LIMIT,
  normalizeHardConcurrencyLimit,
  resolveHardConcurrencyLimit,
} from "../workflow-kernel/constants.js";
import { permissionRulesForAuthority } from "../workflow-kernel/authority-policy.js";
import { __resetFingerprintCacheForTests } from "../workflow-kernel/server-fingerprint.js";
import { makeHarness, makeTempDir, HARNESS_DEFAULT_MODEL } from "./helpers/harness.mjs";
import { createWorktreeAdapter } from "../workflow-kernel/worktree-adapter.js";
import { fakeDrainAdapter, emptyDrainAdapter } from "./helpers/fake-drain-adapter.mjs";
import { makeExtensionDir, writeFakeExtension } from "./helpers/fake-extension.mjs";
const execFileAsync = promisify(execFile);
const { __test } = workflowPlugin;

// Synthetic drain extension: contributes the `fixture-drain` workflow (scope:"extension") so the
// kernel drain mechanisms (canonical mode/profile normalization, dry-run default, autonomous-local
// background default, profile/mode conflict rejection, lane-timeout aliases, host-owned lane
// dispatch, sub-floor refusal, autonomous-local auto-apply) stay covered without any domain
// extension. Drain adapter behavior is injected per-test via __workflowDrainAdapters.fake.
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

// The plugin-local no-token regression (this file + sibling suites) is the public
// source of truth and must remain runnable from a standalone clone. The private
// parent monorepo regression is explicit-only via `npm run
// test:parent-integration`; do not auto-import it here or public/package-local
// validation will depend on checkout layout.

async function tempDir() {
  return await fs.mkdtemp(path.join(os.tmpdir(), "workflow-apply-security-"));
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function initGitRepo(directory) {
  await execFileAsync("git", ["init"], { cwd: directory });
  await execFileAsync("git", ["config", "user.email", "workflow-test@example.com"], { cwd: directory });
  await execFileAsync("git", ["config", "user.name", "Workflow Test"], { cwd: directory });
  await fs.writeFile(path.join(directory, "README.md"), "initial\n", "utf8");
  await execFileAsync("git", ["add", "README.md"], { cwd: directory });
  await execFileAsync("git", ["commit", "-m", "initial"], { cwd: directory });
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function approvalArgs(tools, context, source) {
  const preview = await tools.workflow_run.execute({ source }, context);
  const match = preview.match(/approvalHash: ([a-f0-9]{64})/);
  assert.ok(match, `missing approvalHash in preview: ${preview}`);
  return { source, approve: true, approvalHash: match[1] };
}

async function runApproved(tools, context, source) {
  return await tools.workflow_run.execute(await approvalArgs(tools, context, source), context);
}

async function runApprovedRequest(tools, context, request) {
  const preview = await tools.workflow_run.execute(request, context);
  const match = preview.match(/approvalHash: ([a-f0-9]{64})/);
  assert.ok(match, `missing approvalHash in preview: ${preview}`);
  return await tools.workflow_run.execute({ ...request, approve: true, approvalHash: match[1] }, context);
}

test("workflow_run emits new-style start, phase, and terminal toast cards", async () => {
  const toastCalls = [];
  const { tools, context } = await makeHarness({
    tui: {
      async showToast(input) {
        toastCalls.push(input.body);
        return { data: true };
      },
    },
  });
  const source = `export const meta = { name: "toast-flow", profile: "read-only-review", maxAgents: 0, phases: ["Plan", "Done"] };
await phase("Plan");
await log("planned two checks");
await phase("Done");
return { ok: true };`;

  const output = await runApproved(tools, context, source);

  assert.match(output, /Workflow [0-9a-f-]{36} completed/);
  assert.ok(toastCalls.some((body) => body.variant === "info" && /^▶ toast-flow/.test(body.title) && /└ Plan \(1\/2\)/.test(body.message)), "missing start/Plan heartbeat card");
  assert.ok(toastCalls.some((body) => body.variant === "info" && /^▶ toast-flow/.test(body.title) && /└ Done \(2\/2\)/.test(body.message)), "missing phase-change heartbeat card");
  assert.ok(toastCalls.some((body) => body.variant === "success" && /^✓ toast-flow done/.test(body.title) && /inspect: workflow_status/.test(body.message)), "missing terminal card");
  assert.ok(toastCalls.every((body) => !/agents \d+ active|usage \$|runId=/.test(body.message)), "legacy flat toast body leaked");
});

test("workflowToastAscii plugin option flips workflow cards to ASCII", async () => {
  const toastCalls = [];
  const { tools, context } = await makeHarness({
    pluginOptions: { workflowToastAscii: true },
    tui: {
      async showToast(input) {
        toastCalls.push(input.body);
        return { data: true };
      },
    },
  });
  const source = `export const meta = { name: "ascii-toast", profile: "read-only-review", maxAgents: 0, phases: ["Plan"] };
await phase("Plan");
return true;`;

  await runApproved(tools, context, source);

  assert.ok(toastCalls.some((body) => body.variant === "info" && /^> ascii-toast/.test(body.title) && /\\ Plan \(1\/1\)/.test(body.message)), "missing ASCII heartbeat card");
  assert.ok(toastCalls.some((body) => body.variant === "success" && /^ok ascii-toast done/.test(body.title)), "missing ASCII terminal card");
  assert.ok(toastCalls.every((body) => !/[└├⟳⚠»✓✗⧗·—]/.test(`${body.title}\n${body.message}`)), "unicode glyph leaked while ASCII option was enabled");
});

function runIdFrom(output) {
  const match = output.match(/Workflow ([0-9a-f-]{36}) (?:completed|started|awaiting diff approval|review-required)/);
  assert.ok(match, `missing run id in output: ${output}`);
  return match[1];
}

function resultPath(output) {
  const match = output.match(/Result file: (.+)/);
  assert.ok(match, `missing result path in output: ${output}`);
  return match[1].trim();
}

async function statusByName(tools, context, name) {
  const statuses = JSON.parse(await tools.workflow_status.execute({ format: "json", detail: "compact", limit: 100 }, context));
  const status = statuses.find((entry) => entry.meta?.name === name);
  assert.ok(status, `missing workflow status for ${name}`);
  return JSON.parse(await tools.workflow_status.execute({ runId: status.id, format: "json", detail: "full" }, context));
}

async function readResult(output) {
  return JSON.parse(await fs.readFile(resultPath(output), "utf8"));
}

async function refreshDomainManifest(status) {
  const planPath = path.join(status.dir, "diff-plan.json");
  const plan = JSON.parse(await fs.readFile(planPath, "utf8"));
  plan.domainMutationManifest = await __test.stagedDomainMutationManifest(status.dir);
  plan.domainMutationHash = __test.computeDomainMutationHash(plan.domainMutationManifest);
  plan.diffPlanHash = __test.computeDiffPlanHash(plan);
  await __test.writeJsonAtomic(planPath, plan);
  status.editPlan = { ...status.editPlan, domainMutationManifest: plan.domainMutationManifest, domainMutationHash: plan.domainMutationHash, diffPlanHash: plan.diffPlanHash };
  return status;
}

const EXTERNAL_WORKFLOW_SOURCE = `export const meta = { name: "external-source", profile: "read-only-review" };
return true;`;

async function writeExternalWorkflow() {
  const outsideDir = await tempDir();
  const externalFile = path.join(outsideDir, "external-workflow.js");
  await fs.writeFile(externalFile, EXTERNAL_WORKFLOW_SOURCE, "utf8");
  return { outsideDir, externalFile };
}

function portPrompt(config = {}) {
  return async (input) => {
    const text = String(input?.body?.parts?.[0]?.text ?? "");
    const lanePrompt = text.includes("host-owned drain workflow") || text.includes("Assigned item:");
    if (config.writeFile && input?.query?.directory && lanePrompt) {
      await fs.writeFile(path.join(input.query.directory, config.writeFile.name), config.writeFile.body, "utf8");
    }
    if (lanePrompt) {
      const m = text.match(/"id"\s*:\s*"([^"]+)"/);
      const laneResult = {
        itemId: m ? m[1] : "item-1", outcome: config.laneOutcome === "blocked" ? "blocked" : "implemented", summary: "implemented",
        readyForIntegration: config.laneOutcome !== "blocked",
        filesChanged: config.writeFile ? [config.writeFile.name] : [], commandsRun: ["write"],
        acceptanceEvidence: config.laneOutcome === "blocked" ? [] : ["written"], residualRisks: [], followups: [],
      };
      return { data: { parts: [{ type: "text", text: JSON.stringify(laneResult) }], info: { structured: laneResult, tokens: { input: 1, output: 1, reasoning: 0 }, cost: 0 } } };
    }
    return { data: { parts: [], info: {} } };
  };
}

test("authority profiles carry no gate vocabulary; elevated launch consults the server fingerprint", () => {
  // Design C deleted the live-gate-probe subsystem: WORKFLOW_AUTHORITY_PROFILES no longer declares
  // requiredGates, and resolveRunAuthority's output carries none either. What replaces the old
  // profile-declared gate ceiling is a deterministic, launch-time check — the server-fingerprint
  // version floor (workflow-plugin.js's assertServerSupportsElevatedAuthority for
  // edit/worktreeEdit/integration/shell authority) plus per-lane permission-echo/directory-echo
  // assertions in child-agent-runner.js — proven end-to-end by the fingerprint tests below.
  const readOnly = __test.resolveRunAuthority({ profile: "read-only-review" }, {});
  assert.equal(readOnly.profile, "read-only-review");
  assert.equal(readOnly.readOnly, true);
  assert.equal(readOnly.shell, false);
  assert.equal(Object.hasOwn(readOnly, "requiredGates"), false);

  const shell = __test.resolveRunAuthority({ profile: "inspect-with-shell" }, {});
  assert.equal(shell.profile, "inspect-with-shell");
  assert.equal(shell.shell, true);
  // inspect-with-shell still enforces the audited command-scoped allowlist + denylist
  // (opencode-workflows-public-inspect-shell-scope), not an unrestricted bash "*" allow — that
  // policy lives in the permission ruleset now, not in a requiredGates ceiling.
  assert.ok(shell.shellPolicy.allow.length > 0, "audited shell allow patterns must be non-empty");
  assert.ok(!shell.shellPolicy.allow.includes("*"), "inspect-with-shell must NOT grant unrestricted bash");
  assert.ok(shell.shellPolicy.deny.length > 0, "audited shell deny patterns must be present");
  assert.ok(shell.shellPolicy.allow.includes("git ls-files"), "git ls-files must be allowlisted");
  assert.equal(Object.hasOwn(shell, "requiredGates"), false);

  const editPlan = __test.resolveRunAuthority({ profile: "edit-plan-only" }, {});
  assert.equal(editPlan.profile, "edit-plan-only");
  assert.equal(editPlan.worktreeEdit, true);
  assert.equal(editPlan.edit, false);
  assert.equal(editPlan.editGate, "requires workflow_apply approval before primary writes");
  assert.equal(Object.hasOwn(editPlan, "requiredGates"), false);

  const applyApproved = __test.resolveRunAuthority({ profile: "apply-approved-plan" }, {});
  assert.equal(applyApproved.profile, "apply-approved-plan");
  assert.equal(applyApproved.edit, true);
  assert.equal(applyApproved.editGate, "requires workflow_apply approval before primary writes");
  assert.equal(Object.hasOwn(applyApproved, "requiredGates"), false);

  const drainLocal = __test.resolveRunAuthority({ profile: "drain-autonomous-local" }, {});
  assert.equal(drainLocal.profile, "drain-autonomous-local");
  assert.equal(drainLocal.integration, true);
  assert.equal(drainLocal.network, false);
  assert.equal(drainLocal.mcp, false);
  assert.equal(Object.hasOwn(drainLocal, "requiredGates"), false);

  const drainDry = __test.resolveRunAuthority({ profile: "drain-dry-run" }, {});
  assert.equal(drainDry.profile, "drain-dry-run");
  assert.equal(drainDry.readOnly, true);
  assert.equal(Object.hasOwn(drainDry, "requiredGates"), false);
});

test("elevated authority version floor: rejects a too-old server before any lane spawns; read-only ignores it", async () => {
  const tooOldHealth = { data: { healthy: true, version: "1.0.0" } };

  // Elevated (apply-approved-plan: edit:true) must consult the server fingerprint and refuse
  // BEFORE any lane spawns — the source below would spawn a lane if the gate were missing/dead
  // (the exact bug this test guards: workflow-plugin.js used to check `authority.readOnly !== true`,
  // which is structurally always true for every built-in profile, so the fingerprint was never
  // consulted for any of them).
  {
    const { tools, context, directory, calls } = await makeHarness(async () => { throw new Error("must not prompt a child lane"); }, {
      pluginContext: { __workflowServerHealth: tooOldHealth, serverUrl: "http://fingerprint-elevated.test" },
    });
    try {
      await initGitRepo(directory);
      const source = `export const meta = { name: "elevated-version-floor", profile: "apply-approved-plan" };
return await agent("would spawn a lane if not gated");`;
      await assert.rejects(runApproved(tools, context, source), /requires opencode server >= /);
      assert.equal(calls.create.length, 0, "the fingerprint check must reject before any session.create");
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  }

  // read-only-review is never elevated, so the SAME forced too-old health does not block launch —
  // the fingerprint is never consulted for it.
  {
    const { tools, context, directory } = await makeHarness(async () => ({ data: { parts: [], info: {} } }), {
      pluginContext: { __workflowServerHealth: tooOldHealth, serverUrl: "http://fingerprint-readonly.test" },
    });
    try {
      const source = `export const meta = { name: "readonly-ignores-fingerprint", profile: "read-only-review" };
return true;`;
      const output = await runApproved(tools, context, source);
      assert.match(output, /completed/);
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  }
});

test("server fingerprint is memoized per serverUrl until __resetFingerprintCacheForTests clears it", async () => {
  const serverUrl = "http://fingerprint-memo.test";
  const tooOldHealth = { data: { healthy: true, version: "1.0.0" } };
  const okHealth = { data: { healthy: true, version: "1.17.13" } };

  async function launchApplyApprovedPlan(directory, tools, context, name) {
    const source = `export const meta = { name: "${name}", profile: "apply-approved-plan" };
return true;`;
    return await runApproved(tools, context, source);
  }

  // First launch against serverUrl: forced too-old -> the fingerprint is fetched and cached
  // as "too-old" for this serverUrl.
  const first = await makeHarness(async () => ({ data: { parts: [], info: {} } }), {
    pluginContext: { __workflowServerHealth: tooOldHealth, serverUrl },
  });
  try {
    await initGitRepo(first.directory);
    await assert.rejects(
      launchApplyApprovedPlan(first.directory, first.tools, first.context, "memo-1"),
      /requires opencode server >= /,
    );
  } finally {
    await fs.rm(first.directory, { recursive: true, force: true });
  }

  // Second launch, SAME serverUrl, but now forcing a GOOD version. If the fingerprint were not
  // memoized, this would succeed (fresh probe reads okHealth). It still rejects: the cached
  // "too-old" fingerprint from the first launch is reused, proving memoization.
  const second = await makeHarness(async () => ({ data: { parts: [], info: {} } }), {
    pluginContext: { __workflowServerHealth: okHealth, serverUrl },
  });
  try {
    await initGitRepo(second.directory);
    await assert.rejects(
      launchApplyApprovedPlan(second.directory, second.tools, second.context, "memo-2"),
      /requires opencode server >= /,
    );

    // Clearing the cache forces a fresh health read on the next launch against the same
    // serverUrl, which now resolves to the (still-forced) good version and succeeds.
    __resetFingerprintCacheForTests();
    const output = await launchApplyApprovedPlan(second.directory, second.tools, second.context, "memo-3");
    assert.match(output, /completed/);
  } finally {
    await fs.rm(second.directory, { recursive: true, force: true });
  }
});

test("inspect-with-shell launch refuses a sub-floor server", async () => {
  // Task 10 fix pass: shell-granting authority is now ALSO gated by the server-fingerprint
  // version floor (workflow-plugin.js's `authority.edit || authority.worktreeEdit ||
  // authority.integration || authority.shell` check) — before this fix, inspect-with-shell
  // (shell:true, but none of edit/worktreeEdit/integration) slipped past the gate entirely.
  // The audited shell command allowlist/denylist is enforced ONLY by the session permission
  // ruleset, which is exactly the contract the version floor guarantees; the per-lane
  // permission echo tolerates "not-echoed" as a pass, so it cannot substitute for the floor.
  const tooOldHealth = { data: { healthy: true, version: "1.0.0" } };
  const { tools, context, directory, calls } = await makeHarness(async () => { throw new Error("must not prompt a child lane"); }, {
    pluginContext: { __workflowServerHealth: tooOldHealth, serverUrl: "http://fingerprint-shell.test" },
  });
  try {
    const source = `export const meta = { name: "shell-version-floor", profile: "inspect-with-shell" };
return await agent("would spawn a lane if not gated");`;
    await assert.rejects(runApproved(tools, context, source), /requires opencode server >= /);
    assert.equal(calls.create.length, 0, "the fingerprint check must reject before any session.create");
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("drain-autonomous-local launch refuses a sub-floor server", async () => {
  // Companion to the shell test above, exercised through the drain entry point (name:
  // "fixture-drain") rather than a synthetic inline profile assertion. drain-autonomous-local
  // is integration:true, so it was already inside the elevated gate before this fix; this proves
  // the production drain launch path is refused pre-lane too, before the drain adapter or any
  // lane is ever touched (the assertion here is the pre-lane rejection, not drain mechanics).
  const tooOldHealth = { data: { healthy: true, version: "1.0.0" } };
  const { tools, context, directory, calls } = await makeHarness(async () => { throw new Error("must not prompt a child lane"); }, {
    extensions: [FIXTURE_DRAIN_EXT],
    pluginContext: { __workflowServerHealth: tooOldHealth, serverUrl: "http://fingerprint-drain.test" },
  });
  try {
    await initGitRepo(directory);
    await assert.rejects(
      runApprovedRequest(tools, context, { name: "fixture-drain", args: { mode: "autonomous-local" }, background: false }),
      /requires opencode server >= /,
    );
    assert.equal(calls.create.length, 0, "the fingerprint check must reject before any session.create");
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("network-authority launch refuses a sub-floor server", async () => {
  // Final-review fix pass (design-owner decision): network/mcp authority now joins the
  // version-floor gate alongside edit/worktreeEdit/integration/shell (workflow-plugin.js's
  // `authority.edit || authority.worktreeEdit || authority.integration || authority.shell ||
  // authority.network || authority.mcp` check). The rationale is uniform across all six:
  // webfetch/websearch/mcp tool access is granted purely by the permission ruleset
  // (permissionRulesForAuthority), which is exactly the contract the version floor guarantees —
  // there is no independent runtime check backing it up, so network/mcp-granting authority must
  // refuse sub-floor servers just like the others.
  const tooOldHealth = { data: { healthy: true, version: "1.0.0" } };
  const { tools, context, directory, calls } = await makeHarness(async () => { throw new Error("must not prompt a child lane"); }, {
    pluginContext: { __workflowServerHealth: tooOldHealth, serverUrl: "http://fingerprint-network.test" },
  });
  try {
    const source = `export const meta = { name: "network-version-floor", authority: { network: true } };
return { ok: true };`;
    await assert.rejects(runApproved(tools, context, source), /requires opencode server >= /);
    assert.equal(calls.create.length, 0, "the fingerprint check must reject before any session.create");
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("ad hoc authority remains supported and intentionally mapped", () => {
  const authority = __test.resolveRunAuthority({ authority: { shell: true } }, {});
  assert.equal(authority.profile, "ad-hoc");
  assert.equal(authority.shell, true);
  assert.deepEqual(authority.shellPolicy, { allow: ["*"], deny: [] });
});

test("MCP authority emits pattern-scoped permission rules", () => {
  const authority = __test.resolveRunAuthority({
    authority: { readOnly: true, mcpPolicy: { allow: ["mcp__docs_*"], deny: ["mcp__docs_delete"] } },
  }, {});

  assert.equal(authority.mcp, true);
  assert.deepEqual(authority.mcpPolicy, { allow: ["mcp__docs_*"], deny: ["mcp__docs_delete"] });
  assert.match(__test.authoritySummary(authority), /mcpPolicy=allow:1,deny:1/);

  const mcpRules = __test.permissionRulesForAuthority(authority).filter((rule) => rule.permission === "mcp");
  assert.deepEqual(mcpRules, [
    { permission: "mcp", pattern: "mcp__docs_*", action: "allow" },
    { permission: "mcp", pattern: "mcp__docs_delete", action: "deny" },
  ]);
  assert.equal(mcpRules.some((rule) => rule.pattern === "*" && rule.action === "allow"), false);
});

test("MCP authority accepts mcp object shorthand", () => {
  const authority = __test.resolveRunAuthority({
    authority: { mcp: { allow: ["mcp__kb_read"], deny: ["mcp__kb_write"] } },
  }, {});

  assert.equal(authority.mcp, true);
  assert.deepEqual(authority.mcpPolicy, { allow: ["mcp__kb_read"], deny: ["mcp__kb_write"] });
});

test("lane MCP policy narrows run authority without escalating", () => {
  const runAuthority = __test.resolveRunAuthority({
    authority: { mcpPolicy: { allow: ["mcp__docs_*"], deny: ["mcp__docs_delete"] } },
  }, {});
  const run = { authority: runAuthority, capabilities: { permissions: "available" } };

  const policy = __test.resolveLanePolicy(run, {
    mcpPolicy: { allow: ["mcp__docs_read"], deny: ["mcp__docs_write"] },
  });

  assert.equal(policy.authority.mcp, true);
  assert.deepEqual(policy.mcpPolicy, {
    allow: ["mcp__docs_read"],
    deny: ["mcp__docs_delete", "mcp__docs_write"],
  });
  const mcpRules = policy.permissionRules.filter((rule) => rule.permission === "mcp");
  assert.deepEqual(mcpRules, [
    { permission: "mcp", pattern: "mcp__docs_read", action: "allow" },
    { permission: "mcp", pattern: "mcp__docs_delete", action: "deny" },
    { permission: "mcp", pattern: "mcp__docs_write", action: "deny" },
  ]);

  assert.throws(
    () => __test.resolveLanePolicy(run, { mcpPolicy: { allow: ["mcp__secrets_*"] } }),
    /exceeds approved workflow mcpPolicy/,
  );
});

test("readOnly lane erases MCP policy even when MCP is requested", () => {
  const runAuthority = __test.resolveRunAuthority({
    authority: { mcpPolicy: { allow: ["mcp__docs_*"], deny: ["mcp__docs_delete"] } },
  }, {});
  const run = { authority: runAuthority, capabilities: { permissions: "available" } };

  const policy = __test.resolveLanePolicy(run, {
    readOnly: true,
    mcp: true,
    mcpPolicy: { allow: ["mcp__docs_read"] },
  });

  assert.equal(policy.authority.mcp, false);
  assert.deepEqual(policy.mcpPolicy, { allow: [], deny: [] });
  assert.deepEqual(policy.permissionRules.filter((rule) => rule.permission === "mcp"), [
    { permission: "mcp", pattern: "*", action: "deny" },
  ]);
});

test("authoritySummary flags unrestricted shell policy explicitly", () => {
  const authority = __test.resolveRunAuthority(
    { profile: "inspect-with-shell", authority: { shell: { allow: ["*"], deny: [] } } },
    {},
  );

  assert.match(__test.authoritySummary(authority), /shellPolicy=UNRESTRICTED\(\*\)/);
});

// --- OpenCode bash permission wildcard matcher (mirrors OpenCode's simple-wildcard semantics) ---
// `*` = zero-or-more of any char, `?` = exactly one char, all else literal. Used to evaluate the
// generated permission ruleset under last-matching-rule-wins for the inspect-with-shell tests.
function bashWildcardMatch(pattern, value) {
  let regex = "^";
  for (const char of String(pattern)) {
    if (char === "*") regex += ".*";
    else if (char === "?") regex += ".";
    else regex += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  regex += "$";
  return new RegExp(regex).test(String(value));
}

// Evaluate "last matching rule wins" for a bash command string against the generated rules. A rule
// matches when its permission is "bash" or the catch-all "*" and its pattern matches the command.
function bashRuleAction(rules, command) {
  let action = null;
  for (const rule of rules) {
    if (rule.permission !== "bash" && rule.permission !== "*") continue;
    if (bashWildcardMatch(rule.pattern, command)) action = rule.action;
  }
  return action;
}

test("inspect-with-shell enforces the audited command-scoped allowlist in permission rules (P0)", () => {
  const authority = __test.resolveRunAuthority({ profile: "inspect-with-shell" }, {});
  const rules = __test.permissionRulesForAuthority(authority);

  // Dangerous / non-inspection commands are DENIED (last-matching-rule-wins).
  for (const command of ["rm -rf x", "curl http://x", "cat .env", "ls -la", "wget http://evil"]) {
    assert.equal(bashRuleAction(rules, command), "deny", `expected deny: ${command}`);
  }
  // Shell chaining on an allowlisted command is DENIED even though the allow prefix matches.
  assert.equal(bashRuleAction(rules, "git ls-files && rm x"), "deny", "chained && must be denied");
  assert.equal(bashRuleAction(rules, "git log --numstat HEAD | grep foo"), "deny", "chained | must be denied");
  assert.equal(bashRuleAction(rules, "npm ls --depth=0 > out.txt"), "deny", "redirect must be denied");
  // Git mutation via an allowlisted prefix is denied.
  assert.equal(bashRuleAction(rules, "git ls-files; git commit -m x"), "deny", "git mutation via chaining denied");

  // Intended read-only inspection commands are ALLOWED.
  for (const command of ["git ls-files", "git log --numstat HEAD", "npm ls --depth=0", "cargo tree", "pip list", "go list"]) {
    assert.equal(bashRuleAction(rules, command), "allow", `expected allow: ${command}`);
  }
});

test("inspect-with-shell permission rules deny known mutation/network/install classes", () => {
  const authority = __test.resolveRunAuthority({ profile: "inspect-with-shell" }, {});
  const rules = __test.permissionRulesForAuthority(authority);
  for (const command of [
    "npm install foo", "npm i foo", "yarn add foo", "cargo add bar", "go get baz",
    "npm publish", "git commit -m x", "git push origin", "git merge feat", "git reset --hard",
    "npm audit", "pip-audit", "mv a b", "cp a b", "touch x", "mkdir d", "chmod 777 x",
    "ssh host", "scp f host:", "rsync a b",
  ]) {
    assert.equal(bashRuleAction(rules, command), "deny", `expected deny: ${command}`);
  }
});

test("inspect-with-shell explicit shellPolicy override is respected over the audited allowlist", () => {
  // An explicit caller-supplied shell object (authority.shell = { allow, deny }) is a deliberate
  // override and wins over the audited policy. This preserves the explicit-override path.
  const override = __test.resolveRunAuthority(
    { profile: "inspect-with-shell", authority: { shell: { allow: ["echo *"], deny: ["echo secret"] } } },
    {},
  );
  assert.deepEqual(override.shellPolicy.allow, ["echo *"]);
  assert.deepEqual(override.shellPolicy.deny, ["echo secret"]);
  // The audited deny patterns are NOT injected when an explicit override is present.
  const rules = __test.permissionRulesForAuthority(override);
  assert.equal(bashRuleAction(rules, "echo hello"), "allow");
  assert.equal(bashRuleAction(rules, "echo secret"), "deny");
  // A non-overridden inspect-with-shell run still uses the audited list (regression guard).
  const audited = __test.resolveRunAuthority({ profile: "inspect-with-shell" }, {});
  assert.ok(audited.shellPolicy.allow.includes("git ls-files"));
  assert.ok(!audited.shellPolicy.allow.includes("echo *"));
});

test("inspect-with-shell does not grant unrestricted bash wildcard", () => {
  const authority = __test.resolveRunAuthority({ profile: "inspect-with-shell" }, {});
  assert.ok(!authority.shellPolicy.allow.includes("*"), "no unrestricted bash allow");
  // An arbitrary non-allowlisted command falls through to the catch-all deny.
  const rules = __test.permissionRulesForAuthority(authority);
  assert.equal(bashRuleAction(rules, "python3 -c 'print(1)'"), "deny");
});

test("secret globs deny read, grep, glob, list, and lsp lane permissions (R21)", () => {
  const rules = __test.permissionRulesForAuthority({ readOnly: true });
  // lsp gets a broad allow:* like the other read-class tools, so it must also be
  // denied against every secret glob; otherwise an LSP response could surface
  // secret-file fragments to a read-only lane (opencode-workflows-wgh).
  for (const permission of ["read", "grep", "glob", "list", "lsp"]) {
    for (const glob of ["**/.env", "**/.env.*", ".env", ".env.*", "**/*secret*", "**/*credentials*", "**/id_rsa"]) {
      assert.ok(
        rules.some((rule) => rule.permission === permission && rule.pattern === glob && rule.action === "deny"),
        `${permission} ${glob}`,
      );
    }
  }
});

test("extra secret globs are deduped into every read-class deny rule", () => {
  const rules = __test.permissionRulesForAuthority({ readOnly: true }, ["**/custom-secret.json", "**/custom-secret.json"]);

  for (const permission of ["read", "grep", "glob", "list", "lsp"]) {
    const matches = rules.filter((rule) => rule.permission === permission && rule.pattern === "**/custom-secret.json" && rule.action === "deny");
    assert.equal(matches.length, 1, `${permission} should get one custom secret deny rule`);
  }
});

test("workflow child lanes deny inherited opencode-child tools and permissions", () => {
  const childTools = [
    "oc_child_start",
    "oc_child_status",
    "oc_child_stop",
    "oc_child_restart",
    "oc_session_create",
    "oc_prompt",
    "oc_inspect",
    "oc_events",
    "oc_command",
    "oc_shell",
    "oc_permission",
    "oc_plugin_smoke_test",
  ];
  const childPermissions = [
    "opencode-child.start",
    "opencode-child.status",
    "opencode-child.stop",
    "opencode-child.stop.registry-pid-signal",
    "opencode-child.restart",
    "opencode-child.command",
    "opencode-child.shell",
    "opencode-child.permission",
  ];
  const run = {
    authority: { readOnly: true, shell: false, network: false, mcp: false, edit: false, worktreeEdit: false, integration: false },
    capabilities: { permissions: "available" },
  };

  const policy = __test.resolveLanePolicy(run);
  for (const tool of childTools) {
    assert.equal(policy.tools[tool], false, tool);
    assert.equal(__test.toolAuthority(tool), "delegation", tool);
    assert.ok(policy.permissionRules.some((rule) => rule.permission === tool && rule.pattern === "*" && rule.action === "deny"), tool);
  }
  for (const permission of childPermissions) {
    assert.ok(policy.permissionRules.some((rule) => rule.permission === permission && rule.pattern === "*" && rule.action === "deny"), permission);
  }
  assert.throws(
    () => __test.resolveLanePolicy(run, { tools: { oc_prompt: true } }),
    /unapproved delegation tool authority|denied by the workflow authority policy/,
  );
});

test("opts.readOnly is authoritative over network/mcp/shell/edit lane toggles (R10)", () => {
  const run = {
    authority: {
      readOnly: false,
      shell: true,
      network: true,
      mcp: true,
      edit: true,
      worktreeEdit: false,
      integration: false,
    },
    capabilities: { permissions: "available" },
  };

  // Convenience-flag escalation under readOnly must be dropped, not honored.
  const networkFlag = __test.resolveLanePolicy(run, { readOnly: true, network: true });
  assert.equal(networkFlag.authority.readOnly, true);
  assert.equal(networkFlag.authority.network, false);
  assert.equal(networkFlag.mode, "readOnly");
  assert.equal(networkFlag.tools.webfetch, false);
  assert.equal(networkFlag.tools.websearch, false);
  const webfetchRule = networkFlag.permissionRules.find(
    (rule) => rule.permission === "webfetch" && rule.pattern === "*",
  );
  assert.equal(webfetchRule.action, "deny");

  // edit escalation under readOnly must NOT flip readOnly back off.
  for (const dimension of ["edit", "mcp", "shell"]) {
    const policy = __test.resolveLanePolicy(run, { readOnly: true, [dimension]: true });
    assert.equal(policy.authority.readOnly, true, dimension);
    assert.equal(policy.authority[dimension], false, dimension);
    assert.equal(policy.mode, "readOnly", dimension);
  }

  // Escalation passed via the tools map under readOnly is stripped (not a throw).
  const toolsMap = __test.resolveLanePolicy(run, {
    readOnly: true,
    tools: { webfetch: true, edit: true, bash: true, websearch: true },
  });
  assert.equal(toolsMap.authority.readOnly, true);
  assert.equal(toolsMap.authority.network, false);
  assert.equal(toolsMap.tools.webfetch, false);
  assert.equal(toolsMap.tools.websearch, false);
  assert.equal(toolsMap.tools.edit, false);
  assert.equal(toolsMap.tools.bash, false);

  // Sanity: without readOnly, an approved run still escalates normally.
  const escalated = __test.resolveLanePolicy(run, { network: true });
  assert.equal(escalated.authority.network, true);
  assert.equal(escalated.tools.webfetch, true);

  // Sanity: escalation beyond approved authority still fails closed.
  const lowRun = {
    authority: {
      readOnly: false,
      shell: false,
      network: false,
      mcp: false,
      edit: false,
      worktreeEdit: false,
      integration: false,
    },
    capabilities: { permissions: "available" },
  };
  assert.throws(
    () => __test.resolveLanePolicy(lowRun, { network: true }),
    /network authority beyond approved/,
  );
});

test("opts.readOnly lane on an integration-approved run denies edit in permission ruleset", () => {
  const run = {
    authority: {
      readOnly: false,
      shell: true,
      network: true,
      mcp: true,
      edit: false,
      worktreeEdit: false,
      integration: true,
    },
    capabilities: { permissions: "available" },
  };

  const policy = __test.resolveLanePolicy(run, { readOnly: true });
  assert.equal(policy.mode, "readOnly");
  assert.equal(policy.authority.readOnly, true);
  assert.equal(policy.authority.integration, false);
  assert.equal(policy.tools.edit, false);

  // The permission ruleset is the authoritative session-level enforcement, so
  // the edit rule must be deny (not allow leaked via authority.integration).
  const editRule = policy.permissionRules.find(
    (rule) => rule.permission === "edit" && rule.pattern === "*",
  );
  assert.equal(editRule.action, "deny");

  // bash / network were already denied; confirm they stay denied alongside edit.
  const bashRule = policy.permissionRules.find(
    (rule) => rule.permission === "bash" && rule.pattern === "*",
  );
  assert.equal(bashRule.action, "deny");
  const webfetchRule = policy.permissionRules.find(
    (rule) => rule.permission === "webfetch" && rule.pattern === "*",
  );
  assert.equal(webfetchRule.action, "deny");

  // Sanity: without readOnly, the integration run still grants edit:* allow.
  const integrationLane = __test.resolveLanePolicy(run, { worktreeEdit: true });
  const integrationEditRule = integrationLane.permissionRules.find(
    (rule) => rule.permission === "edit" && rule.pattern === "*",
  );
  assert.equal(integrationEditRule.action, "allow");
});

test("default (non-worktree) child lane in an integration run cannot leak edit/apply_patch into the primary tree", () => {
  // A plain agent() lane in an integration-approved run has no edit/worktreeEdit
  // opt-in and therefore must not receive edit/apply_patch permission. The controller
  // only creates an edit/integration worktree for lanes that opt into editing, so a
  // default lane rooted at the primary tree must be denied edit at the permission
  // ruleset (the authoritative enforcement). (Public-release hardening:
  // opencode-workflows-public-integration-lane-edit-leak.)
  const run = {
    authority: {
      readOnly: false,
      shell: false,
      network: false,
      mcp: false,
      edit: false,
      worktreeEdit: false,
      integration: true,
    },
    capabilities: { permissions: "available" },
  };

  const policy = __test.resolveLanePolicy(run, {});

  // tools map already forbids edit for a default lane.
  assert.equal(policy.tools.edit, false);
  assert.equal(policy.tools.apply_patch, false);

  // The permission ruleset must also deny edit/apply_patch: authority.integration
  // is run-level metadata and cannot grant primary-tree edit to a non-worktree lane.
  const editRule = policy.permissionRules.find(
    (rule) => rule.permission === "edit" && rule.pattern === "*",
  );
  assert.equal(editRule.action, "deny");
  const applyPatchRule = policy.permissionRules.find(
    (rule) => rule.permission === "apply_patch" && rule.pattern === "*",
  );
  assert.equal(applyPatchRule.action, "deny");

  // Regression guard: a lane that DOES opt into worktreeEdit (the legitimate
  // integration worktree lane, edited inside a created worktree) still gets edit
  // permission, so legitimate integration editing is preserved.
  const worktreeLane = __test.resolveLanePolicy(run, { worktreeEdit: true });
  const worktreeEditRule = worktreeLane.permissionRules.find(
    (rule) => rule.permission === "edit" && rule.pattern === "*",
  );
  assert.equal(worktreeEditRule.action, "allow");
  const worktreeApplyRule = worktreeLane.permissionRules.find(
    (rule) => rule.permission === "apply_patch" && rule.pattern === "*",
  );
  assert.equal(worktreeApplyRule.action, "allow");
});

test("network workflow authority launches without reserved gate rejection", async () => {
  const { tools, context, directory } = await makeHarness(async () => ({ data: { parts: [], info: {} } }));
  try {
    const source = `export const meta = { name: "networked-research", authority: { network: true }, maxAgents: 1 };
return { ok: true };`;
    // The preview still surfaces the normal approval boundary before launch.
    const preview = await tools.workflow_run.execute({ source }, context);
    const match = preview.match(/approvalHash: ([a-f0-9]{64})/);
    assert.ok(match, "preview must still surface an approvalHash");
    const output = await tools.workflow_run.execute({ source, approve: true, approvalHash: match[1] }, context);
    assert.match(output, /completed/);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("mcp workflow authority launches without reserved gate rejection", async () => {
  const { tools, context, directory } = await makeHarness(async () => ({ data: { parts: [], info: {} } }));
  try {
    const source = `export const meta = { name: "mcp-research", authority: { mcp: true }, maxAgents: 1 };
return { ok: true };`;
    const preview = await tools.workflow_run.execute({ source }, context);
    const match = preview.match(/approvalHash: ([a-f0-9]{64})/);
    assert.ok(match);
    const output = await tools.workflow_run.execute({ source, approve: true, approvalHash: match[1] }, context);
    assert.match(output, /completed/);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("ad-hoc network authority via args.authority launches without reserved gate rejection", async () => {
  const { tools, context, directory } = await makeHarness(async () => ({ data: { parts: [], info: {} } }));
  try {
    const source = `export const meta = { name: "args-network", maxAgents: 1 };
return { ok: true };`;
    const request = { source, authority: { network: true } };
    const preview = await tools.workflow_run.execute(request, context);
    const match = preview.match(/approvalHash: ([a-f0-9]{64})/);
    assert.ok(match);
    const output = await tools.workflow_run.execute({ ...request, approve: true, approvalHash: match[1] }, context);
    assert.match(output, /completed/);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("a run without network/mcp authority executes normally", async () => {
  const { tools, context, directory } = await makeHarness(async () => ({ data: { parts: [], info: {} } }));
  try {
    const source = `export const meta = { name: "plain-readonly", profile: "read-only-review", maxAgents: 1 };
return { ok: true };`;
    const output = await runApproved(tools, context, source);
    assert.match(output, /completed/);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("drain-autonomous-local resolves network:false, mcp:false with no gate to verify before launch", () => {
  // Design C deleted the network/mcp live-gate verifier hook. drain-autonomous-local's
  // network:false/mcp:false is enforced entirely by the permission ruleset (no webfetch/websearch/
  // mcp allow rules), so there is nothing left to probe before launch — the authority shape itself
  // is the whole contract now.
  const drain = __test.resolveRunAuthority({ profile: "drain-autonomous-local" }, {});
  assert.equal(drain.network, false);
  assert.equal(drain.mcp, false);
});

test("network authority launches without any gate verification", async () => {
  // Design C: there is no networkAccess live gate left to verify; network:true authority is
  // enforced solely by the permission ruleset (webfetch/websearch allow rules), so a network-
  // authorized run launches with nothing forced/verified.
  const { tools, context, directory } = await makeHarness(async () => ({ data: { parts: [], info: {} } }));
  try {
    const source = `export const meta = { name: "forced-network", authority: { network: true }, maxAgents: 1 };
return { ok: true };`;
    const output = await runApproved(tools, context, source);
    assert.match(output, /completed/);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("authority profile name changes approval hash", () => {
  const approval = {
    sourcePath: "<inline>",
    sourceHash: "source-hash",
    runtimeArgs: null,
    maxAgents: 1,
    concurrency: 1,
    defaultChildModel: "test/model",
    budgetCeilings: {},
    guestDeadlineMs: 1000,
    background: false,
    capabilities: {},
    nestedSnapshots: new Map(),
  };
  const adHoc = __test.resolveRunAuthority({ authority: { shell: true } }, {});
  const profiled = __test.resolveRunAuthority({ profile: "inspect-with-shell" }, {});

  assert.equal(adHoc.shell, profiled.shell);
  assert.notEqual(
    __test.approvalHash({ ...approval, authority: adHoc }),
    __test.approvalHash({ ...approval, authority: profiled }),
  );
});

test("auto-approve tiers resolve from post-resolution authority and can only narrow", () => {
  assert.equal(__test.authorityAutoApproveTier({ readOnly: true }), "readOnly");
  assert.equal(__test.authorityAutoApproveTier({ readOnly: true, shell: true }), "readOnly");
  assert.equal(__test.authorityAutoApproveTier({ worktreeEdit: true }), "worktree");
  assert.equal(__test.authorityAutoApproveTier({ edit: true }), "worktree");
  assert.equal(__test.authorityAutoApproveTier({ integration: true }), "all");
  assert.equal(__test.authorityAutoApproveTier({ network: true }), "all");
  assert.equal(__test.authorityAutoApproveTier({ mcp: true }), "all");

  assert.equal(__test.effectiveAutoApproveCeiling(false, undefined), false);
  assert.equal(__test.effectiveAutoApproveCeiling("all", undefined), "all");
  assert.equal(__test.effectiveAutoApproveCeiling("all", "readOnly"), "readOnly");
  assert.equal(__test.effectiveAutoApproveCeiling("readOnly", "all"), "readOnly");
  assert.equal(__test.autoApproveCovers("worktree", "readOnly"), true);
  assert.equal(__test.autoApproveCovers("readOnly", "worktree"), false);
});

test("workflow_run autoApprove launches eligible read-only workflow on first call and records audit trail", async () => {
  const { tools, context, directory, calls } = await makeHarness({
    pluginOptions: { autoApprove: "readOnly" },
  });
  try {
    const source = `export const meta = { name: "auto-readonly", profile: "read-only-review", maxAgents: 0 };
return { ok: true };`;

    const output = await tools.workflow_run.execute({ source }, context);
    assert.match(output, /Workflow [0-9a-f-]{36} completed/);
    assert.doesNotMatch(output, /approvalHash:/);
    assert.equal(calls.prompt.length, 0);

    const runId = runIdFrom(output);
    const compact = JSON.parse(await tools.workflow_status.execute({ runId, format: "json", detail: "compact" }, context));
    assert.deepEqual(compact.autoApproved, { tier: "readOnly", ceiling: "readOnly" });

    const full = JSON.parse(await tools.workflow_status.execute({ runId, format: "json", detail: "full" }, context));
    assert.deepEqual(full.autoApproved, { tier: "readOnly", ceiling: "readOnly" });

    const events = (await fs.readFile(path.join(full.dir, "events.jsonl"), "utf8"))
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line));
    assert.ok(events.some((event) => event.type === "run.auto_approved" && event.tier === "readOnly" && event.ceiling === "readOnly"));
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("workflow_run autoApprove default-off and explicit approve:true keep the approvalHash path", async () => {
  const { tools, context, directory, calls } = await makeHarness({
    pluginOptions: { autoApprove: "readOnly" },
    prompt: async () => {
      throw new Error("manual mismatch must not prompt a child lane");
    },
  });
  try {
    const source = `export const meta = { name: "auto-manual-hash", profile: "read-only-review", maxAgents: 1 };
await agent("must not run without current approval");
return true;`;

    const missing = JSON.parse(await tools.workflow_run.execute({ source, approve: true }, context));
    assert.equal(missing.status, "approval_mismatch");
    assert.equal(missing.reason, "missing_approval_hash");

    const unconfigured = await makeHarness({
      prompt: async () => {
        throw new Error("unconfigured preview must not prompt a child lane");
      },
    });
    try {
      const preview = await unconfigured.tools.workflow_run.execute({ source, autoApprove: "readOnly" }, unconfigured.context);
      assert.match(preview, /approvalHash: [a-f0-9]{64}/);
      assert.match(preview, /Auto-approve: off/);
      assert.equal(unconfigured.calls.prompt.length, 0);
    } finally {
      await fs.rm(unconfigured.directory, { recursive: true, force: true });
    }

    assert.equal(calls.prompt.length, 0);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("workflow_run format=json returns a structured approval preview", async () => {
  const { tools, context, directory, calls } = await makeHarness(async () => {
    throw new Error("structured preview must not prompt a child lane");
  });
  try {
    const source = `export const meta = { name: "structured-preview", description: "Preview contract", phases: ["plan"], profile: "inspect-with-shell", maxAgents: 2, concurrency: 2 };
return true;`;

    const preview = JSON.parse(await tools.workflow_run.execute({ source, format: "json" }, context));

    assert.equal(preview.type, "workflow_preview");
    assert.equal(preview.status, "approval_required");
    assert.equal(preview.executed, false);
    assert.equal(preview.workflow.name, "structured-preview");
    assert.equal(preview.workflow.description, "Preview contract");
    assert.deepEqual(preview.workflow.phases, ["plan"]);
    assert.equal(preview.workflow.phasesText, "plan");
    assert.equal(preview.source.path, "<inline>");
    assert.match(preview.source.sourceHash, /^[a-f0-9]{64}$/);
    assert.equal(preview.source.inline, true);
    assert.equal(preview.source.byteLength, Buffer.byteLength(source, "utf8"));
    assert.equal(preview.source.lineCount, 2);
    assert.equal(preview.source.snippet, undefined);
    assert.match(preview.approvalHash, /^[a-f0-9]{64}$/);
    assert.equal(preview.runtimeArgsPreview, "null");
    assert.equal(preview.laneBudget.maxAgents, 2);
    assert.equal(preview.laneBudget.concurrency, 2);
    assert.equal(preview.modelPlan.defaultChildModel, HARNESS_DEFAULT_MODEL);
    assert.equal(preview.modelPlan.fast, HARNESS_DEFAULT_MODEL);
    assert.equal(preview.modelPlan.deep, HARNESS_DEFAULT_MODEL);
    assert.deepEqual(preview.budgetCeilings, { maxCost: null, maxTokens: null });
    assert.equal(preview.authority.profile, "inspect-with-shell");
    // Design C: the preview's authority object carries no gate vocabulary at all.
    assert.equal(Object.hasOwn(preview.authority, "requiredGates"), false);
    assert.equal(preview.authority.isolation, "no workflow-managed write isolation requested");
    assert.equal(preview.mutationDomains.summary, "none declared");
    assert.deepEqual(preview.nestedSnapshots, []);
    assert.equal(calls.prompt.length, 0, "preview must not execute lanes");
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("workflow_run honors meta maxAgents zero in the approval preview", async () => {
  const { tools, context, directory, calls } = await makeHarness(async () => {
    throw new Error("zero-agent preview must not prompt a child lane");
  });
  try {
    const source = `export const meta = { name: "zero-agent-data", maxAgents: 0 };
return { ok: true };`;
    const preview = JSON.parse(await tools.workflow_run.execute({ source, format: "json" }, context));
    assert.equal(preview.laneBudget.maxAgents, 0);
    assert.equal(calls.prompt.length, 0);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("workflow_run structured preview includes bounded source snippet only when requested", async () => {
  const { tools, context, directory } = await makeHarness(async () => {
    throw new Error("source snippet preview must not execute lanes");
  });
  try {
    const source = `export const meta = { name: "snippet-preview", profile: "read-only-review" };
return "visible body";`;
    const preview = JSON.parse(await tools.workflow_run.execute({ source, format: "json", includeSourceSnippet: true, sourceSnippetMaxChars: 32 }, context));

    assert.equal(preview.source.inline, true);
    assert.equal(preview.source.snippetChars, 32);
    assert.match(preview.source.snippet, /^export co/);
    assert.match(preview.source.snippet, /\[truncated \d+ chars\]/);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("workflow_run approve:true with missing or stale approvalHash returns approval_mismatch and does not execute", async () => {
  const { tools, context, directory, calls } = await makeHarness(async () => {
    throw new Error("approval mismatch must not prompt a child lane");
  });
  try {
    const source = `export const meta = { name: "approval-mismatch", profile: "read-only-review", maxAgents: 1 };
await agent("must not run without current approval");
return true;`;

    const preview = JSON.parse(await tools.workflow_run.execute({ source, args: { mode: "first" }, format: "json" }, context));
    const stale = JSON.parse(await tools.workflow_run.execute({ source, args: { mode: "second" }, approve: true, approvalHash: preview.approvalHash }, context));

    assert.equal(stale.type, "workflow_approval_mismatch");
    assert.equal(stale.status, "approval_mismatch");
    assert.equal(stale.executed, false);
    assert.equal(stale.reason, "approval_hash_mismatch");
    assert.equal(stale.suppliedApprovalHash, preview.approvalHash);
    assert.match(stale.freshApprovalHash, /^[a-f0-9]{64}$/);
    assert.notEqual(stale.freshApprovalHash, preview.approvalHash, "changed args must produce a fresh approval hash");
    assert.equal(stale.freshPreview.status, "approval_required");
    assert.match(stale.freshPreview.runtimeArgsPreview, /"mode": "second"/);

    const missing = JSON.parse(await tools.workflow_run.execute({ source, approve: true }, context));
    assert.equal(missing.status, "approval_mismatch");
    assert.equal(missing.reason, "missing_approval_hash");
    assert.equal(missing.suppliedApprovalHash, null);
    assert.equal(missing.executed, false);
    assert.equal(calls.prompt.length, 0, "mismatch paths must not execute lanes");
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("resume preview preserves original authority and budget envelope", async () => {
  const { tools, context, directory } = await makeHarness(async () => ({ data: { parts: [], info: {} } }));
  try {
    const runId = "11111111-1111-4111-8111-111111111111";
    const source = `export const meta = { name: "resume-envelope", profile: "read-only-review", maxAgents: 10 };
return true;`;
    const root = __test.runRoot(context);
    const dir = __test.runDirForRoot(root, runId);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "script.js"), source, "utf8");
    await __test.writeJsonAtomic(path.join(dir, "state.json"), {
      id: runId,
      status: "paused",
      sourcePath: "<inline>",
      sourceHash: __test.hash(source),
      meta: { name: "resume-envelope", profile: "read-only-review", maxAgents: 10 },
      authority: __test.resolveRunAuthority({ profile: "read-only-review" }, {}),
      maxAgents: 2,
      agentsStarted: 2,
      concurrency: 1,
      defaultChildModel: "original/model",
      budgetCeilings: { maxCost: 1.5, maxTokens: 12 },
      background: true,
    });

    const preview = await tools.workflow_run.execute({ resumeRunId: runId }, context);

    assert.match(preview, /Max agents: 2/);
    assert.match(preview, /Budget ceilings: maxCost=1.5, maxTokens=12/);
    assert.match(preview, /Authority profile: read-only-review/);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("resume rejects maxAgents, budget, profile, and authority expansion", async () => {
  const { tools, context, directory } = await makeHarness(async () => ({ data: { parts: [], info: {} } }));
  try {
    const runId = "22222222-2222-4222-8222-222222222222";
    const source = `export const meta = { name: "resume-locked", profile: "read-only-review" };
return true;`;
    const root = __test.runRoot(context);
    const dir = __test.runDirForRoot(root, runId);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "script.js"), source, "utf8");
    await __test.writeJsonAtomic(path.join(dir, "state.json"), {
      id: runId,
      status: "paused",
      sourcePath: "<inline>",
      sourceHash: __test.hash(source),
      meta: { name: "resume-locked", profile: "read-only-review" },
      authority: __test.resolveRunAuthority({ profile: "read-only-review" }, {}),
      maxAgents: 1,
      agentsStarted: 1,
      concurrency: 1,
      defaultChildModel: "original/model",
      budgetCeilings: { maxCost: 1, maxTokens: 10 },
    });

    await assert.rejects(tools.workflow_run.execute({ resumeRunId: runId, maxAgents: 2 }, context), /cannot change maxAgents/);
    await assert.rejects(tools.workflow_run.execute({ resumeRunId: runId, maxCost: 2 }, context), /cannot change maxCost/);
    await assert.rejects(tools.workflow_run.execute({ resumeRunId: runId, maxTokens: 20 }, context), /cannot change maxTokens/);
    await assert.rejects(tools.workflow_run.execute({ resumeRunId: runId, profile: "inspect-with-shell" }, context), /cannot change profile/);
    await assert.rejects(tools.workflow_run.execute({ resumeRunId: runId, authority: { shell: true } }, context), /cannot change authority/);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("resume rejects a persisted source whose hash no longer matches script.js", async () => {
  const { tools, context, directory } = await makeHarness(async () => ({ data: { parts: [], info: {} } }));
  try {
    const runId = "33333333-3333-4333-8333-333333333333";
    const source = `export const meta = { name: "resume-hash" };
return true;`;
    const root = __test.runRoot(context);
    const dir = __test.runDirForRoot(root, runId);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "script.js"), source, "utf8");
    await __test.writeJsonAtomic(path.join(dir, "state.json"), {
      id: runId,
      status: "paused",
      sourcePath: "<inline>",
      sourceHash: __test.hash("export const meta = { name: 'tampered' };\nreturn false;"),
      meta: { name: "resume-hash" },
      authority: __test.resolveRunAuthority({}, {}),
      maxAgents: 1,
      agentsStarted: 0,
      concurrency: 1,
      defaultChildModel: HARNESS_DEFAULT_MODEL,
      budgetCeilings: {},
    });

    // The persisted sourceHash mismatch is caught during envelope planning, before approval.
    await assert.rejects(
      tools.workflow_run.execute({ resumeRunId: runId }, context),
      /resumeRunId persisted source hash mismatch/,
    );
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("resume rejects a persisted run whose script.js is missing", async () => {
  const { tools, context, directory } = await makeHarness(async () => ({ data: { parts: [], info: {} } }));
  try {
    const runId = "missing-script-run";
    const root = __test.runRoot(context);
    const dir = __test.runDirForRoot(root, runId);
    await fs.mkdir(dir, { recursive: true });
    await __test.writeJsonAtomic(path.join(dir, "state.json"), {
      id: runId,
      status: "paused",
      sourcePath: "<inline>",
      sourceHash: __test.hash("return true;"),
      meta: { name: "resume-missing-script" },
      authority: __test.resolveRunAuthority({}, {}),
      maxAgents: 1,
      agentsStarted: 0,
      concurrency: 1,
      defaultChildModel: HARNESS_DEFAULT_MODEL,
      budgetCeilings: {},
    });

    await assert.rejects(
      tools.workflow_run.execute({ resumeRunId: runId }, context),
      /Workflow run missing-script-run cannot resume: missing script\.js/,
    );
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

// jbs3.4: pinning the model envelope on resume + the approval-preview replay warning.
async function seedResumableRun(context, runId, { sourceHash, ...stateOverrides } = {}) {
  const source = `export const meta = { name: "resume-model-pin", profile: "read-only-review" };
return true;`;
  const root = __test.runRoot(context);
  const dir = __test.runDirForRoot(root, runId);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "script.js"), source, "utf8");
  await __test.writeJsonAtomic(path.join(dir, "state.json"), {
    id: runId,
    status: "interrupted",
    sourcePath: "<inline>",
    sourceHash: sourceHash ?? __test.hash(source),
    meta: { name: "resume-model-pin", profile: "read-only-review" },
    authority: __test.resolveRunAuthority({ profile: "read-only-review" }, {}),
    maxAgents: 1,
    agentsStarted: 1,
    concurrency: 1,
    defaultChildModel: "pinned/model",
    modelTiers: { fast: "pinned/fast", deep: "pinned/deep" },
    budgetCeilings: {},
    ...stateOverrides,
  });
  return { dir, source };
}

test("jbs3.4: resume pins the prior child model even when the session model changed (0 lanes will re-run)", async () => {
  const { tools, context, directory } = await makeHarness(
    async () => ({ data: { parts: [], info: {} } }),
    { sessionModel: "switched/session-model" },
  );
  try {
    const runId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    await seedResumableRun(context, runId);
    const preview = await tools.workflow_run.execute({ resumeRunId: runId }, context);
    // The pinned prior model is reused, NOT the switched session model.
    assert.match(preview, /Default child model: pinned\/model/);
    assert.match(preview, /Model plan: fast=pinned\/fast deep=pinned\/deep/);
    assert.doesNotMatch(preview, /switched\/session-model/);
    // No envelope change => the completed lanes replay from cache at no new spend.
    assert.match(preview, /Resume replay: 0 lanes will re-run, ~\$0 re-spend/);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("mfv9.4: resume start compacts the journal before resumed execution appends", async () => {
  const { tools, context, directory } = await makeHarness(async () => ({ data: { parts: [], info: {} } }));
  try {
    const runId = "abababab-abab-4aba-8aba-abababababab";
    const { dir } = await seedResumableRun(context, runId);
    await fs.writeFile(
      path.join(dir, "journal.jsonl"),
      [
        JSON.stringify({ type: "agent", callId: "lane:1", outcome: "failure", attempt: 1, cost: 0.01 }),
        JSON.stringify({ type: "agent", callId: "lane:2", outcome: "success", attempt: 1, cost: 0.02 }),
        JSON.stringify({ type: "agent", callId: "lane:1", outcome: "success", attempt: 2, cost: 0.03 }),
        '{"callId":"truncated"',
      ].join("\n"),
      "utf8",
    );

    const output = await runApprovedRequest(tools, context, { resumeRunId: runId });
    assert.match(output, /Workflow .* completed/);

    const lines = (await fs.readFile(path.join(dir, "journal.jsonl"), "utf8")).trim().split(/\r?\n/);
    assert.equal(lines.length, 2, "resume-start compaction should keep only latest valid entries");
    const parsed = lines.map((line) => JSON.parse(line));
    assert.equal(parsed.find((entry) => entry.callId === "lane:1").attempt, 2);
    assert.equal(parsed.find((entry) => entry.callId === "lane:2").attempt, 1);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("jbs3.4: cannot change model on resume — a different childModel/modelTiers is rejected", async () => {
  const { tools, context, directory } = await makeHarness(async () => ({ data: { parts: [], info: {} } }));
  try {
    const runId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    await seedResumableRun(context, runId);
    await assert.rejects(
      tools.workflow_run.execute({ resumeRunId: runId, childModel: "different/model" }, context),
      /cannot change the child model from pinned\/model to different\/model/,
    );
    await assert.rejects(
      tools.workflow_run.execute({ resumeRunId: runId, modelTiers: { fast: "different/fast" } }, context),
      /cannot change the fast-tier model from pinned\/fast to different\/fast/,
    );
    // Re-passing the SAME pinned model is accepted (resolves to a preview, not a rejection).
    const preview = await tools.workflow_run.execute({ resumeRunId: runId, childModel: "pinned/model" }, context);
    assert.match(preview, /Default child model: pinned\/model/);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("jbs3.4: a runtime-args change that invalidates cached lanes warns 'N lanes will re-run, ~$X re-spend' before approval", async () => {
  const { tools, context, directory } = await makeHarness(async () => ({ data: { parts: [], info: {} } }));
  try {
    const runId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const { dir } = await seedResumableRun(context, runId, { runtimeArgs: { mode: "first" } });
    // Two completed lanes recorded in the journal at known cost.
    await fs.writeFile(
      path.join(dir, "journal.jsonl"),
      [
        JSON.stringify({ type: "agent", callId: "root/agent:0", outcome: "success", cost: 0.01, signatureHash: "sig-0" }),
        JSON.stringify({ type: "agent", callId: "root/agent:1", outcome: "success", cost: 0.02, signatureHash: "sig-1" }),
      ].join("\n") + "\n",
      "utf8",
    );
    // Same model envelope (no rejection), but the runtime args change invalidates every cached lane.
    const preview = await tools.workflow_run.execute({ resumeRunId: runId, args: { mode: "second" } }, context);
    assert.match(preview, /Resume replay: 2 lanes will re-run, ~\$0\.0300 re-spend/);
    assert.match(preview, /replayed spend already counts toward the budget ceiling/);
    // The unchanged-args resume of the same run shows zero re-run.
    const clean = await tools.workflow_run.execute({ resumeRunId: runId, args: { mode: "first" } }, context);
    assert.match(clean, /Resume replay: 0 lanes will re-run, ~\$0 re-spend \(2 completed lanes replay from cache/);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("budget ceilings preserve requested concurrency and gate further launches via reservations", async () => {
  let releasePrompts;
  const promptsGate = new Promise((resolve) => { releasePrompts = resolve; });
  let resolveFourInFlight;
  const fourInFlight = new Promise((resolve) => { resolveFourInFlight = resolve; });
  let promptsEntered = 0;
  const { tools, context, directory, calls } = await makeHarness(async () => {
    promptsEntered += 1;
    if (promptsEntered === 4) resolveFourInFlight();
    await promptsGate;
    return { data: { parts: [{ type: "text", text: "ok" }], info: { tokens: { input: 1, output: 0, reasoning: 0 }, cost: 0 } } };
  });
  let launch;
  try {
    const source = `export const meta = { name: "budgeted-concurrency", maxAgents: 8, concurrency: 4, maxTokens: 4 };
const lanes = [0, 1, 2, 3, 4].map((i) => async ({ agent }) => {
  return await agent("budgeted lane " + i, { onFailure: "returnNull" });
});
return await parallel(lanes);`;
    const preview = await tools.workflow_run.execute({ source }, context);
    assert.match(preview, /Concurrency: 4/);
    assert.match(preview, /Budget ceilings: maxCost=none, maxTokens=4/);

    const match = preview.match(/approvalHash: ([a-f0-9]{64})/);
    assert.ok(match, `missing approvalHash in preview: ${preview}`);
    launch = tools.workflow_run.execute({ source, approve: true, approvalHash: match[1] }, context);
    await Promise.race([
      fourInFlight,
      setTimeoutP(500).then(() => {
        throw new Error(`expected four budgeted lanes in flight concurrently, saw ${promptsEntered}`);
      }),
    ]);
    assert.equal(calls.prompt.length, 4, "only the four admitted lanes should reach session.prompt");
    releasePrompts();

    const output = await launch;
    const status = JSON.parse(await tools.workflow_status.execute({ runId: runIdFrom(output), format: "json", detail: "full" }, context));

    assert.equal(status.concurrency, 4);
    assert.equal(status.budgetCeilings.maxTokens, 4);
    assert.equal(calls.prompt.length, 4, "the fifth lane budget-stops before prompting");
    assert.equal(status.laneOutcomes?.success, 4);
    assert.equal(status.laneOutcomes?.budget_stopped, 1);
    assert.equal(status.usage.totalTokens.input, 4);
  } finally {
    releasePrompts?.();
    if (launch) await Promise.allSettled([launch]);
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("workflow source help lists drain as an available global", () => {
  assert.throws(
    () => __test.parseWorkflowSource(`export default async function main(){ return true; }`),
    /available globals: .*drain.*line 1, column 1/,
  );
});

test("workflow source syntax errors include line and column context", () => {
  assert.throws(
    () => __test.parseWorkflowSource(`export const meta = { name: "bad" };
const = 1;`),
    /Workflow source parse error: .*line 2, column/,
  );
});

test("parseWorkflowSource rejects stray exports sharing the meta declaration", () => {
  assert.throws(
    () =>
      __test.parseWorkflowSource(
        `export const meta = { name: "x" }, other = 1;\nreturn typeof other;\n`,
      ),
    /additional exports in the same declaration: other/,
  );
  assert.throws(
    () =>
      __test.parseWorkflowSource(
        `export const meta = { name: "x" }, alpha = 1, beta = 2;\nreturn 0;\n`,
      ),
    /additional exports in the same declaration: alpha, beta/,
  );
  const ok = __test.parseWorkflowSource(
    `export const meta = { name: "x" };\nreturn { ok: true };\n`,
  );
  assert.equal(ok.meta.name, "x");
});

test("parseWorkflowSource rejects literal zero-arg fanout callbacks before approval", () => {
  assert.throws(
    () => __test.parseWorkflowSource(`export const meta = { name: "bad-parallel" };
await parallel([
  async () => "x",
  async (api) => api.agent("ok")
]);`),
    /parallel\(\) callback\(s\) at index 0 declare 0 parameters.*line 3, column 3/s,
  );
  assert.throws(
    () => __test.parseWorkflowSource(`export const meta = { name: "bad-default-param" };
await parallel([async (api = {}) => api.agent("x")]);`),
    /Default\/rest parameters.*line 2, column/,
  );
  assert.throws(
    () => __test.parseWorkflowSource(`export const meta = { name: "bad-pipeline" };
await pipeline(["x"], async () => "y");`),
    /pipeline\(\) callback\(s\) at index 0 declare 0 parameters.*line 2, column/s,
  );
});

test("parseWorkflowSource allows explicit sequential fanout and scoped map lane factories", () => {
  const sequential = __test.parseWorkflowSource(`export const meta = { name: "intentional-sequential" };
return await parallel([async () => "x"], { sequential: true });`);
  assert.equal(sequential.meta.name, "intentional-sequential");

  const scopedMap = __test.parseWorkflowSource(`export const meta = { name: "scoped-map" };
const lanes = [1, 2].map((item) => async ({ agent }) => await agent("lane " + item));
return await parallel(lanes);`);
  assert.equal(scopedMap.meta.name, "scoped-map");

  assert.throws(
    () => __test.parseWorkflowSource(`export const meta = { name: "bad-map" };
const lanes = [1, 2].map((item) => async () => item);
return await parallel(lanes);`),
    /parallel\(\) callback\(s\) at index map\(\) declare 0 parameters.*line 2, column/s,
  );
});

test("static nested workflow refs reject dynamic workflow calls", () => {
  assert.throws(
    () => __test.staticNestedWorkflowRefs(`const nestedName = "child";
await workflow(nestedName);`),
    /workflow\(\) nested calls must use a static string name\/source or workflow\(\{ source: "\.\.\." \}\)/,
  );
  assert.throws(
    () => __test.staticNestedWorkflowRefs("await workflow(`child-${suffix}`);"),
    /workflow\(\) nested calls must use a static string name\/source or workflow\(\{ source: "\.\.\." \}\)/,
  );
  assert.deepEqual(__test.staticNestedWorkflowRefs('await workflow("child-workflow");'), ["child-workflow"]);
});

test("static nested workflow refs support explicit object source/name forms and reject dynamic source values", () => {
  assert.deepEqual(__test.staticNestedWorkflowRefs('await workflow({ source: "return 1;", args: { ok: true } });'), ["return 1;"]);
  assert.deepEqual(__test.staticNestedWorkflowRefs('await workflow({ name: "child-workflow", args });'), ["child-workflow"]);
  assert.throws(
    () => __test.staticNestedWorkflowRefs('await workflow({ source: args.childSource });'),
    /workflow\(\{ source \}\) must use a static string literal at line 1, column/,
  );
  assert.throws(
    () => __test.staticNestedWorkflowRefs('await workflow({ source: "return 1;", name: "child" });'),
    /workflow\(\) nested source form must include exactly one static source or name/,
  );
});

test("buildNestedSnapshots treats explicit tiny source form as inline source without newline heuristics", async () => {
  const tiny = "return 1;";
  const parent = `export const meta = { name: "parent" };
await workflow({ source: ${JSON.stringify(tiny)}, args: { value: 1 } });
return true;`;

  const context = { directory: process.cwd() };
  const snapshots = await __test.buildNestedSnapshots(context, parent);
  const tinyHash = __test.hash(tiny);

  assert.equal(snapshots.get(tinyHash)?.source, tiny);
  assert.equal(snapshots.get(tinyHash)?.sourceHash, tinyHash);
  assert.equal(snapshots.has("<inline>"), false);
});

test("buildNestedSnapshots keeps distinct inline nested workflows separate by hash", async () => {
  // Two distinct inline nested workflows both resolve to sourcePath "<inline>".
  // Keying snapshots by that shared sentinel would let the second overwrite the
  // first; both must survive, keyed purely by their content hash.
  const inlineA = `export const meta = { name: "nested-a" };\nreturn "A";\n`;
  const inlineB = `export const meta = { name: "nested-b" };\nreturn "B";\n`;
  const parent = `export const meta = { name: "parent" };
await workflow(${JSON.stringify(inlineA)});
await workflow(${JSON.stringify(inlineB)});
return true;`;

  const context = { directory: process.cwd() };
  const snapshots = await __test.buildNestedSnapshots(context, parent);

  const hashA = __test.hash(inlineA);
  const hashB = __test.hash(inlineB);

  // Both inline snapshots are retrievable by their own hash and carry their own source.
  assert.equal(snapshots.get(hashA)?.source, inlineA);
  assert.equal(snapshots.get(hashB)?.source, inlineB);
  assert.equal(snapshots.get(hashA)?.sourceHash, hashA);
  assert.equal(snapshots.get(hashB)?.sourceHash, hashB);

  // The shared "<inline>" sentinel is NOT a key, so the path-based lookup cannot
  // return a stale snapshot for the wrong inline workflow.
  assert.equal(snapshots.has("<inline>"), false);

  // Replicate runNestedWorkflow's lookup for each inline source: sourcePath is the
  // shared "<inline>" sentinel, so resolution must fall through to the hash key and
  // land on the matching snapshot for each distinct workflow.
  const sourcePath = "<inline>";
  const lookupA = (sourcePath !== "<inline>" && snapshots.get(sourcePath)) || snapshots.get(hashA);
  const lookupB = (sourcePath !== "<inline>" && snapshots.get(sourcePath)) || snapshots.get(hashB);
  assert.equal(lookupA.source, inlineA);
  assert.equal(lookupB.source, inlineB);
  // Neither lookup trips the stale-source guard (snapshot.sourceHash === sourceHash).
  assert.equal(lookupA.sourceHash, hashA);
  assert.equal(lookupB.sourceHash, hashB);
});

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
    assert.equal(entry.sourceHash, __test.hash(src));
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
    const projectRoot = __test.projectWorkflowDir(context);
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

// --- jbs3.10: input/output contracts ---------------------------------------------------------

test("jbs3.10: normalizeAgentOptions rejects a misspelled agent() opt and preserves valid ones", () => {
  // A typo'd opt would otherwise be silently dropped, leaving the lane on unintended defaults.
  assert.throws(() => __test.normalizeAgentOptions({ onFailur: "returnNull" }), /Unknown agent\(\) option: onFailur/);
  assert.throws(() => __test.normalizeAgentOptions({ readonly: true }), /Unknown agent\(\) option: readonly/);
  assert.throws(() => __test.assertKnownAgentOptions({ foo: 1, bar: 2 }), /Unknown agent\(\) options: foo, bar/);
  // Every documented opt key stays accepted; label/phase are still stripped from the normalized value.
  const valid = { model: "v/m", tier: "fast", readOnly: true, edit: false, allowEdits: false, worktreeEdit: false,
    shell: false, allowShell: false, network: false, allowNetwork: false, mcp: false, allowMcp: false,
    mcpPolicy: { allow: ["mcp__docs_*"] }, tools: {}, secretGlobs: [], agent: "build", agentType: "build", role: "explorer", effort: "high", retryCount: 0, correctiveRetries: 1,
    schema: { type: "object" }, timeoutMs: 1000, system: "sys", onFailure: "returnNull",
    taskSummary: "t", summary: "s", label: "L", title: "T", phase: "p" };
  const normalized = __test.normalizeAgentOptions(valid);
  assert.equal(normalized.label, undefined, "label is stripped");
  assert.equal(normalized.phase, undefined, "phase is stripped");
  assert.equal(normalized.onFailure, "returnNull", "valid opt survives normalization");
});

test("jbs3.10: a misspelled agent() opt fails the run at run time instead of being silently ignored", async () => {
  const { tools, context, directory } = await makeHarness(async () => ({
    data: { parts: [{ type: "text", text: "child ok" }], info: {} },
  }));
  try {
    const source = `export const meta = { name: "typo-opt", readOnly: true };
return await agent("inspect safely", { readOnly: true, onFailur: "returnNull" });`;
    await assert.rejects(runApproved(tools, context, source), /Unknown agent\(\) option: onFailur/);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("jbs3.10: meta.argsSchema rejects a malformed args payload at plan time with a clear message", async () => {
  const { tools, context, directory } = await makeHarness(async () => ({ data: { parts: [], info: {} } }));
  try {
    const source = `export const meta = {
  name: "args-contract",
  profile: "read-only-review",
  argsSchema: { type: "object", properties: { mode: { type: "string" }, count: { type: "integer" } }, required: ["mode"], additionalProperties: false },
};
return true;`;
    // Missing the required "mode" -> rejected before the approval envelope is built.
    await assert.rejects(
      tools.workflow_run.execute({ source, args: { count: 3 } }, context),
      /Workflow args do not match meta\.argsSchema[\s\S]*mode/,
    );
    // Wrong type for a declared property -> rejected.
    await assert.rejects(
      tools.workflow_run.execute({ source, args: { mode: "go", count: "lots" } }, context),
      /Workflow args do not match meta\.argsSchema/,
    );
    // An unexpected extra key (additionalProperties:false) -> rejected.
    await assert.rejects(
      tools.workflow_run.execute({ source, args: { mode: "go", typo: true } }, context),
      /Workflow args do not match meta\.argsSchema/,
    );
    // A valid payload passes validation and reaches the approval preview.
    const preview = await tools.workflow_run.execute({ source, args: { mode: "go", count: 3 } }, context);
    assert.match(preview, /approvalHash: [a-f0-9]{64}/);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("jbs3.10: assertWorkflowArgsMatchSchema is a no-op when no argsSchema is declared and rejects a non-object schema", () => {
  // No schema declared -> any args payload is accepted.
  assert.doesNotThrow(() => __test.assertWorkflowArgsMatchSchema({ name: "x" }, { anything: true }));
  assert.doesNotThrow(() => __test.assertWorkflowArgsMatchSchema({ name: "x" }, null));
  // A declared-but-malformed schema is itself an authoring error surfaced clearly.
  assert.throws(() => __test.assertWorkflowArgsMatchSchema({ argsSchema: "not-an-object" }, {}), /meta\.argsSchema must be a JSON Schema object/);
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

test("external scriptPath fails closed without allowExternalScriptPath", async () => {
  const { tools, context, directory } = await makeHarness(async () => {
    throw new Error("external scriptPath must fail before any child prompt");
  });
  const { outsideDir, externalFile } = await writeExternalWorkflow();
  try {
    await assert.rejects(
      tools.workflow_run.execute({ scriptPath: externalFile }, context),
      /scriptPath resolves outside trusted workflow roots/,
    );
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
    await fs.rm(outsideDir, { recursive: true, force: true });
  }
});

test("external scriptPath fails closed even when the target file does not exist", async () => {
  const { tools, context, directory } = await makeHarness(async () => {
    throw new Error("missing external file must fail closed on trust, not on stat");
  });
  const { outsideDir } = await writeExternalWorkflow();
  try {
    const missing = path.join(outsideDir, "does-not-exist.js");
    await assert.rejects(
      tools.workflow_run.execute({ scriptPath: missing }, context),
      /scriptPath resolves outside trusted workflow roots/,
    );
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
    await fs.rm(outsideDir, { recursive: true, force: true });
  }
});

test("external scriptPath with traversal segments fails closed after normalization", async () => {
  const { tools, context, directory } = await makeHarness(async () => {
    throw new Error("traversal scriptPath must fail before any child prompt");
  });
  const { outsideDir, externalFile } = await writeExternalWorkflow();
  try {
    // Relative path with leading ".." that resolves out of the project root into outsideDir.
    const traversalScriptPath = path.relative(context.directory, externalFile);
    assert.ok(traversalScriptPath.startsWith(".."), `expected a traversal relative path, got ${traversalScriptPath}`);
    await assert.rejects(
      tools.workflow_run.execute({ scriptPath: traversalScriptPath }, context),
      new RegExp(`scriptPath resolves outside trusted workflow roots: ${escapeRegExp(externalFile.replace(/\\/g, "/"))}`),
    );
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
    await fs.rm(outsideDir, { recursive: true, force: true });
  }
});

test("external scriptPath with allowExternalScriptPath opt-in previews path + hash and runs", async () => {
  const { tools, context, directory } = await makeHarness(async () => {
    throw new Error("read-only external workflow should not call child prompts");
  });
  const { outsideDir, externalFile } = await writeExternalWorkflow();
  try {
    const request = { scriptPath: externalFile, allowExternalScriptPath: true };
    const preview = await tools.workflow_run.execute(request, context);

    assert.match(preview, new RegExp(`Source: ${escapeRegExp(externalFile.replace(/\\/g, "/"))}`));
    assert.match(preview, /sourceHash: [a-f0-9]{64}/);
    assert.match(preview, /External source \(allowExternalScriptPath opt-in\): true/);
    assert.equal(__test.hash(EXTERNAL_WORKFLOW_SOURCE), preview.match(/sourceHash: ([a-f0-9]{64})/)[1]);

    const output = await runApprovedRequest(tools, context, request);
    assert.match(output, /completed/);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
    await fs.rm(outsideDir, { recursive: true, force: true });
  }
});

test("scriptPath inside the trusted project workflow root runs without opt-in", async () => {
  const { tools, context, directory } = await makeHarness(async () => {
    throw new Error("trusted project-root workflow should not call child prompts");
  });
  try {
    const projectRoot = __test.projectWorkflowDir(context);
    await fs.mkdir(projectRoot, { recursive: true });
    const trustedFile = path.join(projectRoot, "trusted-project.js");
    await fs.writeFile(trustedFile, EXTERNAL_WORKFLOW_SOURCE, "utf8");

    const output = await runApprovedRequest(tools, context, {
      scriptPath: ".opencode/workflows/trusted-project.js",
    });
    assert.match(output, /completed/);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("named project workflow resolves from a trusted root without opt-in (no regression)", async () => {
  const { tools, context, directory } = await makeHarness(async () => {
    throw new Error("named workflow should not call child prompts");
  });
  try {
    const projectRoot = __test.projectWorkflowDir(context);
    await fs.mkdir(projectRoot, { recursive: true });
    await fs.writeFile(path.join(projectRoot, "named-project.js"), EXTERNAL_WORKFLOW_SOURCE, "utf8");

    const preview = await tools.workflow_run.execute({ name: "named-project" }, context);
    assert.match(preview, new RegExp(`Source: ${escapeRegExp(path.join(projectRoot, "named-project.js").replace(/\\/g, "/"))}`));
    assert.match(preview, /sourceHash: [a-f0-9]{64}/);
    assert.doesNotMatch(preview, /External source/);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("workflow_save rejects duplicates and invalid sources", async () => {
  const { tools, context, directory } = await makeHarness(async () => {
    throw new Error("workflow_save validation must not prompt a model");
  });
  try {
    const source = `export const meta = { name: "saved-test", profile: "read-only-review" };
return { ok: true };`;
    const saved = await tools.workflow_save.execute({ name: "saved-test", source, scope: "project" }, context);
    assert.match(saved, /Saved workflow saved-test/);

    await assert.rejects(
      () => tools.workflow_save.execute({ name: "saved-test", source, scope: "project" }, context),
      /Workflow already exists: .*saved-test\.js\. Pass overwrite: true to replace it\./,
    );
    await assert.rejects(
      () => tools.workflow_save.execute({ name: "missing-source", scope: "project" }, context),
      /workflow_save requires `source`/,
    );
    await assert.rejects(
      () => tools.workflow_save.execute({ name: "too-large", source: "x".repeat(__test.MAX_SOURCE_BYTES + 1), scope: "project" }, context),
      /Workflow source exceeds 524288 bytes/,
    );
    await assert.rejects(
      () => tools.workflow_save.execute({ name: "bad-syntax", source: "export const meta = {", scope: "project" }, context),
      /Unexpected|Unterminated|Parse error/i,
    );
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("workflow_save defaults to project scope and requires explicit global intent", async () => {
  const { tools, context, directory } = await makeHarness(async () => {
    throw new Error("workflow_save validation must not prompt a model");
  });
  try {
    const name = `default-project-${crypto.randomUUID().slice(0, 8)}`;
    const source = `export const meta = { name: ${JSON.stringify(name)}, profile: "read-only-review" };
return { ok: true };`;
    const saved = await tools.workflow_save.execute({ name, source }, context);
    const projectPath = path.join(__test.projectWorkflowDir(context), `${name}.js`);
    assert.match(saved, new RegExp(`Path: ${escapeRegExp(projectPath)}`));
    assert.equal(await fs.readFile(projectPath, "utf8"), source);

    await assert.rejects(
      () => tools.workflow_save.execute({ name: `${name}-global`, source, scope: "global" }, context),
      /global scope requires globalScopeIntent: "save-global-workflow"/,
    );
    await assert.rejects(
      () => tools.workflow_save.execute({
        name: `${name}-global-invalid`,
        source: "export const meta = {",
        scope: "global",
        globalScopeIntent: "save-global-workflow",
      }, context),
      /Unexpected|Unterminated|Parse error/i,
    );
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("representative workflow tools execute without model prompts", async () => {
  const { tools, context, directory } = await makeHarness(async () => {
    throw new Error("deterministic workflow tool smoke must not prompt a model");
  }, {
    extensions: [FIXTURE_DRAIN_EXT],
  });
  try {
    for (const name of ["workflow_list", "workflow_roles", "workflow_templates", "workflow_run", "workflow_status", "workflow_reconcile", "workflow_cleanup"]) {
      assert.equal(typeof tools[name]?.execute, "function", `missing executable tool ${name}`);
    }
    // Design C deleted workflow_live_gates entirely (no probe report/reset tool surface left).
    assert.equal(tools.workflow_live_gates, undefined, "workflow_live_gates must not be registered");

    const listed = JSON.parse(await tools.workflow_list.execute({ format: "json" }, context));
    assert.ok(listed.some((entry) => entry.scope === "extension" && entry.name === "fixture-drain"));

    const roles = JSON.parse(await tools.workflow_roles.execute({ format: "json" }, context));
    assert.ok(roles.some((entry) => entry.name === "implementer"));

    const templates = JSON.parse(await tools.workflow_templates.execute({ format: "json" }, context));
    assert.ok(templates.some((entry) => entry.name === "scoped-parallel"));

    const source = `export const meta = { name: "deterministic-tool-smoke", profile: "read-only-review" };
return { ok: true };`;
    const preview = await tools.workflow_run.execute({ source }, context);
    assert.match(preview, /Authority profile: read-only-review/);
    assert.match(preview, /approvalHash: [a-f0-9]{64}/);

    const output = await runApproved(tools, context, source);
    const runId = runIdFrom(output);
    const status = JSON.parse(await tools.workflow_status.execute({ runId, format: "json", detail: "result" }, context));
    assert.equal(status.status, "completed");
    assert.equal(status.result.output.ok, true);

    const statusList = JSON.parse(await tools.workflow_status.execute({ format: "json", detail: "compact", limit: 10 }, context));
    assert.ok(statusList.some((entry) => entry.id === runId && entry.status === "completed"));

    const cleanup = JSON.parse(await tools.workflow_cleanup.execute({ dryRun: true, keep: 100 }, context));
    assert.equal(cleanup.dryRun, true);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("workflow_roles surfaces roles.json defaults with prompt hash provenance", async () => {
  const directory = await makeTempDir("workflow-roles-defaults-");
  const roleDir = path.join(directory, "roles");
  await fs.mkdir(roleDir, { recursive: true });
  await fs.writeFile(path.join(roleDir, "implementer.md"), "custom implementer role", "utf8");
  await fs.writeFile(path.join(roleDir, "roles.json"), JSON.stringify({
    roles: {
      implementer: { tier: "deep", readOnly: true, timeoutMs: 3000 },
    },
  }), "utf8");
  const { tools, context } = await makeHarness(async () => {
    throw new Error("workflow_roles must not prompt a model");
  }, {
    directory,
    pluginContext: { __workflowRoleDir: roleDir },
  });

  try {
    const roles = JSON.parse(await tools.workflow_roles.execute({ format: "json" }, context));
    const implementer = roles.find((entry) => entry.name === "implementer");
    assert.ok(implementer, "missing implementer role");
    assert.equal(implementer.userModified, true);
    assert.equal(typeof implementer.contentHash, "string");
    assert.equal(typeof implementer.shippedHash, "string");
    assert.deepEqual(implementer.defaults, { tier: "deep", readOnly: true, timeoutMs: 3000 });
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("public workflow tool schemas describe non-obvious arguments", async () => {
  const { tools, directory } = await makeHarness(async () => {
    throw new Error("schema metadata inspection must not prompt a model");
  });
  try {
    assert.match(tools.workflow_apply.description, /workflow_status/);
    assert.match(tools.workflow_apply.description, /workflow_apply_approval_mismatch/);
    for (const [toolName, fields] of Object.entries({
      workflow_apply: ["runId", "approvedSourceHash", "baseCommit", "diffPlanHash", "domainMutationHash", "approvalIntent"],
      workflow_cleanup: ["dryRun", "keep"],
      workflow_salvage: ["runId", "callIds", "approve", "approvalHash"],
      workflow_template_save: ["template", "name", "scope", "overwrite"],
    })) {
      for (const field of fields) {
        assert.equal(
          typeof tools[toolName].args[field].description,
          "string",
          `${toolName}.${field} must expose a schema description`,
        );
        assert.ok(
          tools[toolName].args[field].description.length > 12,
          `${toolName}.${field} description should be useful`,
        );
      }
    }
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("first-run-slice template is a bounded read-only listing surface", async () => {
  // Surface contract for bd opencode-workflows-ux.2: the shipped first-run slice must
  // stay the smallest safe shape — read-only-review, bounded agents, no edit gate — so a
  // fresh agent can validate one slice before fanning out.
  const source = __test.DEFAULT_TEMPLATES["first-run-slice"];
  assert.equal(typeof source, "string", "first-run-slice template must ship in DEFAULT_TEMPLATES");

  const { meta, body } = __test.parseWorkflowSource(source);
  assert.equal(meta.name, "first-run-slice");
  assert.equal(meta.profile, "read-only-review");
  assert.ok(meta.maxAgents >= 1 && meta.maxAgents <= 2, `maxAgents must stay small, got ${meta.maxAgents}`);
  assert.ok(meta.concurrency >= 1 && meta.concurrency <= 2, `concurrency must stay small, got ${meta.concurrency}`);
  // Pure-JS synthesis: at most the lane fanout uses agent(); the return is plain JS.
  assert.ok(body.includes("await parallel("), "template must fan out scoped parallel lanes");
  assert.ok(/return\s*{/.test(body), "template must synthesize and return a plain-JS envelope");

  // read-only-review denies edits and requests no apply gate, so no guest write can land.
  const authority = __test.resolveRunAuthority(meta, {});
  assert.equal(authority.readOnly, true);
  assert.equal(authority.edit, false);
  assert.equal(authority.mode, "readOnly");
  assert.equal(authority.editGate, "not-requested");

  const templates = JSON.parse(await __test.listTemplates({ format: "json" }));
  const entry = templates.find((item) => item.name === "first-run-slice");
  assert.ok(entry, "first-run-slice must appear in workflow_templates listing");
  assert.match(entry.sourceHash, /^[a-f0-9]{12,}$/);
  assert.equal(typeof entry.byteLength, "number");
  assert.equal(typeof entry.lineCount, "number");
  assert.equal(entry.source, undefined);
});

test("workflow_templates retrieves shipped template source explicitly", async () => {
  const { tools, context, directory } = await makeHarness(async () => {
    throw new Error("template listing must not prompt a model");
  });
  try {
    const templates = JSON.parse(await tools.workflow_templates.execute({ format: "json", template: "first-run-slice", includeSource: true }, context));
    assert.equal(templates.length, 1);
    assert.equal(templates[0].name, "first-run-slice");
    assert.equal(templates[0].source, __test.DEFAULT_TEMPLATES["first-run-slice"]);
    assert.equal(templates[0].byteLength, Buffer.byteLength(templates[0].source, "utf8"));
    assert.ok(templates[0].lineCount > 1);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("workflow_template_save saves templates, rejects unsafe calls, and honors overwrite", async () => {
  const { tools, context, directory } = await makeHarness(async () => {
    throw new Error("template save must not prompt a model");
  });
  try {
    const saved = await tools.workflow_template_save.execute({
      template: "first-run-slice",
      name: "saved-template",
      scope: "project",
    }, context);
    const filePath = path.join(__test.projectWorkflowDir(context), "saved-template.js");
    assert.match(saved, /Saved workflow saved-template/);
    assert.equal(await fs.readFile(filePath, "utf8"), __test.DEFAULT_TEMPLATES["first-run-slice"]);

    await assert.rejects(
      () => tools.workflow_template_save.execute({
        template: "first-run-slice",
        name: "saved-template",
        scope: "project",
      }, context),
      /Workflow already exists: .*saved-template\.js\. Pass overwrite: true to replace it\./,
    );

    const overwritten = await tools.workflow_template_save.execute({
      template: "scoped-parallel",
      name: "saved-template",
      scope: "project",
      overwrite: true,
    }, context);
    assert.match(overwritten, /Saved workflow saved-template/);
    assert.equal(await fs.readFile(filePath, "utf8"), __test.DEFAULT_TEMPLATES["scoped-parallel"]);

    await assert.rejects(
      () => tools.workflow_template_save.execute({ template: "does-not-exist", scope: "project" }, context),
      /Unknown workflow template: does-not-exist/,
    );
    await assert.rejects(
      () => tools.workflow_template_save.execute({ template: "first-run-slice", scope: "project" }, { ...context, agent: "plan" }),
      /workflow_template_save is not available in plan mode/,
    );
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("first-run-slice template runs read-only, synthesizes in pure JS, and writes no files", async () => {
  // Lanes echo a structured finding keyed off the slice in their prompt. The "blank"
  // slice returns empty evidence so we can prove the pure-JS synthesis drops
  // unsupported claims rather than promoting them.
  const { tools, context, directory, calls } = await makeHarness(async (input) => {
    const text = String(input?.body?.parts?.[0]?.text ?? "");
    const match = text.match(/Read-only slice "([^"]+)"/);
    const slice = match ? match[1] : "primary";
    const laneResult = {
      slice,
      claim: `slice ${slice} does X`,
      evidence: slice === "blank" ? "" : "file.js:10",
    };
    return { data: { parts: [{ type: "text", text: JSON.stringify(laneResult) }], info: { structured: laneResult, tokens: { input: 1, output: 1, reasoning: 0 }, cost: 0 } } };
  });
  try {
    const source = __test.DEFAULT_TEMPLATES["first-run-slice"].replace(
      `{ role: "explorer", schema: findingSchema, label: "slice:" + slice }`,
      `{ schema: findingSchema, label: "slice:" + slice }`,
    );
    const request = { source, args: { question: "What does this slice do?", slices: ["alpha", "blank"] } };

    const output = await runApprovedRequest(tools, context, request);
    // A read-only run completes directly; it never enters "awaiting diff approval".
    assert.doesNotMatch(output, /awaiting diff approval/);
    const runId = runIdFrom(output);

    const status = JSON.parse(await tools.workflow_status.execute({ runId, format: "json", detail: "result" }, context));
    assert.equal(status.status, "completed");
    const result = status.result.output;
    assert.deepEqual(result.slices, ["alpha", "blank"]);
    // alpha had evidence -> grounded; blank had none -> dropped, not promoted.
    assert.equal(result.groundedFindings.length, 1);
    assert.equal(result.groundedFindings[0].slice, "alpha");
    assert.equal(result.droppedUnsupportedClaims.length, 1);
    assert.equal(result.droppedUnsupportedClaims[0].slice, "blank");
    assert.match(result.note, /No edits, no domain mutation, no files written/);

    // Two slices -> two scoped lanes, one prompt each; synthesis adds no agent calls.
    assert.equal(calls.prompt.length, 2);

    // The QuickJS guest has no filesystem; the only thing in the working dir is the
    // workflow run store. Nothing the guest produced was written to the tree.
    const entries = await fs.readdir(directory);
    assert.deepEqual(entries.filter((name) => name !== ".opencode"), []);
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

    const projectPath = path.join(__test.projectWorkflowDir(context), "fixture-rich.js");
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

test("approval preview shows authority profile with no gate vocabulary", async () => {
  const { tools, context, directory } = await makeHarness(async () => {
    throw new Error("approval preview must not run live probes or child prompts");
  });
  try {
    const source = `export const meta = { name: "profile-preview", profile: "inspect-with-shell" };
return true;`;
    const preview = await tools.workflow_run.execute({ source }, context);

    assert.match(preview, /Authority profile: inspect-with-shell/);
    // Design C: the preview never surfaces a "Required gates:" line at all.
    assert.doesNotMatch(preview, /Required gates:/);
    assert.match(preview, /Isolation: no workflow-managed write isolation requested/);
    assert.match(preview, /Authority: .*profile=inspect-with-shell/);
    assert.match(preview, /Authority: .*shell=true/);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("read-only-review profile runs without live permission probes", async () => {
  const { tools, context, directory } = await makeHarness(async () => {
    throw new Error("read-only workflow should not call child prompt probes");
  });
  try {
    const source = `export const meta = { name: "read-only-profile", profile: "read-only-review" };
return true;`;
    const output = await runApproved(tools, context, source);

    assert.match(output, /completed/);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

// Design C: the kernel trusts the platform's session.create permission contract instead of
// refusing to spawn a lane until a probe confirms run.capabilities.permissions === "available".
// An unverified (or even absent) permissions capability must no longer block a lane from
// launching; the containment property that matters is that the permission ruleset is still
// attached to the child session verbatim, with delivery checked per-lane by
// sessionPermissionEchoStatus (which throws only on an actual mismatch, covered elsewhere).
test("read-only child lanes launch without verified per-session permissions, ruleset still attached", async () => {
  const { tools, context, directory, calls } = await makeHarness(async () => ({
    data: { parts: [{ type: "text", text: "child ok" }], info: {} },
  }), {
    capabilities: {
      childSession: "available",
      permissions: "available-unverified",
      structuredOutput: "available",
      worktree: "unavailable",
      directoryRooting: "available-unverified",
      worktreeEditIsolation: "unavailable",
    },
  });
  try {
    const source = `export const meta = { name: "read-only-child-permissions", profile: "read-only-review" };
return await agent("inspect safely", { readOnly: true });`;

    const output = await runApproved(tools, context, source);
    assert.match(output, /completed/);
    assert.equal(calls.prompt.length, 1, "the lane must have launched and prompted");

    const createPermissions = calls.create.map((input) => input.permission ?? input.body?.permission).find((permission) => Array.isArray(permission));
    assert.ok(createPermissions, "child session should still receive the permission ruleset verbatim");
    assert.ok(
      createPermissions.some((rule) => rule.permission === "bash" && rule.pattern === "*" && rule.action === "deny"),
      "read-only child permission rules should deny bash even though permissions capability is unverified",
    );
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

// Design C removed the permissionEnforcement live gate and the ad-hoc-profile preflight that used
// to require it verified before any read-only child-capable run could spawn a lane (the four tests
// that used to live here forced __workflowLiveGates.permissionEnforcement into verified/failed
// states and asserted status.capabilities.permissions, a field the shape-only capability adapter no
// longer has). The surviving safety property — a read-only run's child lane is contained by its
// deny-by-default permission ruleset regardless of any gate state, and a *delivery* mismatch fails
// closed — is proven without any gate seam by the test right above ("read-only child lanes launch
// without verified per-session permissions, ruleset still attached") and end-to-end in
// tests/workflow-permissions.test.mjs ("real child lane fails closed on explicit permission echo
// mismatch before prompt", "...surfaces no-echo permission runtime without blocking compatible
// clients", "sessionPermissionEchoStatus treats extra broad grants as a mismatch").

test("inspect-with-shell profile's command scoping is enforced by the permission ruleset, not a live gate", async () => {
  // Design C deleted the commandScopedBash live gate entirely: inspect-with-shell is readOnly (the
  // server-fingerprint elevated check never consults it either), so nothing blocks launch. The
  // command-scoping safety property is now enforced solely by the audited allow/deny permission
  // ruleset attached to the child session (authority-policy.js's shellPolicy for this profile),
  // verified per-lane by sessionPermissionEchoStatus — covered end-to-end in
  // workflow-permissions.test.mjs. This proves the ruleset itself: broad bash denied, only the
  // audited read-only prefixes allowed.
  const { tools, context, directory, calls } = await makeHarness(async () => ({ data: { parts: [], info: {} } }));
  try {
    const source = `export const meta = { name: "shell-profile", profile: "inspect-with-shell" };
return true;`;

    const output = await runApproved(tools, context, source);
    assert.match(output, /completed/);

    const authority = __test.resolveRunAuthority({ profile: "inspect-with-shell" }, {});
    const rules = permissionRulesForAuthority(authority);
    assert.ok(
      rules.some((rule) => rule.permission === "*" && rule.pattern === "*" && rule.action === "deny"),
      "the catch-all deny-by-default rule must be present (covers unscoped bash)",
    );
    assert.ok(
      !rules.some((rule) => rule.permission === "bash" && rule.pattern === "*" && rule.action === "allow"),
      "inspect-with-shell must never grant unscoped bash",
    );
    assert.ok(
      rules.some((rule) => rule.permission === "bash" && rule.pattern === "git ls-files" && rule.action === "allow"),
      "the audited git ls-files prefix must be explicitly allowed",
    );
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

// Dispatching mock for host-owned drain implementation lanes. Discovery, validation, closeout,
// and dry proof are supplied by fake host adapters (injected via __workflowDrainAdapters.fake) in
// these tests; the drain workflow itself is the synthetic fixture-drain extension.

test("drain-autonomous-local profile completes with the git-based integration worktree adapter, no native worktree capability required", async () => {
  // Design C: createIntegrationLaneWorktree (child-agent-runner.js) always builds its
  // worktreeAdapter from the git-based fallback (worktree-adapter.js), never the native
  // client — unlike authority.edit/worktreeEdit, which DO require adapter.capabilities.worktree
  // === "available" (see the edit-plan-only/apply-approved-plan tests below). Forcing
  // capabilities.worktree "unavailable" here, with zero live-gate seam of any kind, proves
  // integration mode never needed that native capability in the first place.
  const { tools, context, directory } = await makeHarness(portPrompt({
    readyByRound: [[{ id: "item-1", title: "profile item", priority: 2, issue_type: "task" }], []],
    writeFile: { name: "profile-integration.txt", body: "integration profile lane\n" },
    verifyAction: "closed",
    finalDry: true,
  }), {
    capabilities: { childSession: "available", worktree: "unavailable", toast: "available" },
    extensions: [FIXTURE_DRAIN_EXT],
    pluginContext: {
      __workflowDrainAdapters: { fake: async () => fakeDrainAdapter([]) },
    },
  });
  try {
    await initGitRepo(directory);
    const preview = await tools.workflow_run.execute({ name: "fixture-drain", args: { mode: "autonomous-local" }, background: false }, context);
    assert.match(preview, /Authority profile: drain-autonomous-local/);
    assert.match(preview, /Background: false/);
    assert.doesNotMatch(preview, /Required gates:/);
    assert.match(preview, /Isolation: local integration worktrees; primary-tree writes require workflow_apply/);

    const output = await runApprovedRequest(tools, context, { name: "fixture-drain", args: { mode: "autonomous-local" }, background: false });
    const status = JSON.parse(await tools.workflow_status.execute({ runId: runIdFrom(output), format: "json", detail: "full" }, context));
    // Autonomous-local auto-applies the verified diff plan (.5).
    assert.equal(status.status, "completed");
    assert.equal(status.declaredProfile, "drain-autonomous-local");
    assert.equal(status.effectiveAuthorityProfile, "drain-autonomous-local");
    assert.equal(status.authority.profile, "drain-autonomous-local");
    assert.equal(status.integrationPlan.lanes.length, 1);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("edit-plan-only profile is rejected when the native worktree client capability is unavailable", async () => {
  // Design C: the requiredGates worktreeApi/worktreeEditIsolation live gates are gone. What
  // survives is the shape check in workflow-plugin.js's startWorkflow: an edit/worktreeEdit
  // authority profile requires adapter.capabilities.worktree === "available", or it refuses
  // before any lane spawns.
  const { tools, context, directory } = await makeHarness(async () => ({ data: { parts: [], info: {} } }), {
    capabilities: { childSession: "available", worktree: "unavailable", toast: "available" },
  });
  try {
    await initGitRepo(directory);
    const source = `export const meta = { name: "native-edit-profile", profile: "edit-plan-only" };
return true;`;
    const preview = await tools.workflow_run.execute({ source }, context);
    assert.match(preview, /Isolation: native edit worktrees; primary-tree writes require workflow_apply/);
    await assert.rejects(
      runApproved(tools, context, source),
      /Edit-mode workflows require the native worktree client, which this opencode server\/SDK does not expose/,
    );
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("apply-approved-plan profile is rejected when the native worktree client capability is unavailable", async () => {
  const { tools, context, directory } = await makeHarness(async () => ({ data: { parts: [], info: {} } }), {
    capabilities: { childSession: "available", worktree: "unavailable", toast: "available" },
  });
  try {
    await initGitRepo(directory);
    const source = `export const meta = { name: "apply-approved-edit", profile: "apply-approved-plan" };
return true;`;
    const preview = await tools.workflow_run.execute({ source }, context);
    assert.match(preview, /Isolation: primary-tree write authority gated by workflow_apply/);
    await assert.rejects(
      runApproved(tools, context, source),
      /Edit-mode workflows require the native worktree client, which this opencode server\/SDK does not expose/,
    );
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("workflow drain global reaches the host-owned drain adapter wrapper", async () => {
  const calls = [];
  const { tools, context, directory } = await makeHarness(async () => ({ data: { parts: [], info: {} } }), {
    pluginContext: {
      __workflowDrainAdapters: {
        fake: async () => ({
          name: "fake",
          async discover() {
            calls.push("discover");
            return [];
          },
          async classify() {
            throw new Error("classify should not be called with no items");
          },
          async claim() {
            throw new Error("claim should not be called with no items");
          },
          async buildLanePacket() {
            throw new Error("buildLanePacket should not be called with no items");
          },
          async validate() {
            throw new Error("validate should not be called with no items");
          },
          async close() {
            throw new Error("close should not be called with no items");
          },
          async createFollowup() {
            throw new Error("createFollowup should not be called with no items");
          },
          async proveDry() {
            calls.push("proveDry");
            return { dry: true };
          },
        }),
      },
    },
  });
  try {
    await initGitRepo(directory);
    const source = `export const meta = { name: "host-drain", authority: { integration: true }, maxAgents: 1 };
return await drain({ adapter: "fake", dryRun: true });`;

    const output = await runApproved(tools, context, source);
    const result = await readResult(output);

    assert.equal(result.output.adapter, "fake");
    assert.equal(result.output.status, "dry_run_complete");
    assert.deepEqual(calls, ["discover", "proveDry"]);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("fixture-drain dry-run is allowed with unverified gates and reports them", async () => {
  const calls = [];
  const { tools, context, directory } = await makeHarness(async () => {
    throw new Error("bundled dry-run must not launch child lanes");
  }, {
    extensions: [FIXTURE_DRAIN_EXT],
    pluginContext: { __workflowDrainAdapters: { fake: async () => emptyDrainAdapter(calls) } },
  });
  try {
    const output = await runApprovedRequest(tools, context, { name: "fixture-drain", args: { dryRun: true } });
    const runId = runIdFrom(output);
    const result = await readResult(output);
    const status = JSON.parse(await tools.workflow_status.execute({ runId, format: "json", detail: "full" }, context));

    assert.equal(result.output.status, "dry_run_complete");
    assert.equal(result.output.stop_reason, "queue_empty");
    assert.equal(status.authority.integration, false);
    assert.equal(status.authority.profile, "drain-dry-run");
    assert.deepEqual(calls, ["discover", "proveDry"]);
    // Dry-run completed without requiring verified live gates (drain-dry-run profile requires none).
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("fixture-drain defaults to dry-run mode without domain mutation", async () => {
  const calls = [];
  const { tools, context, directory } = await makeHarness(async () => {
    throw new Error("default dry-run must not launch child lanes");
  }, {
    extensions: [FIXTURE_DRAIN_EXT],
    pluginContext: { __workflowDrainAdapters: { fake: async () => emptyDrainAdapter(calls) } },
  });
  try {
    const preview = await tools.workflow_run.execute({ name: "fixture-drain" }, context);
    assert.match(preview, /Authority profile: drain-dry-run/);

    const output = await runApprovedRequest(tools, context, { name: "fixture-drain" });
    const result = await readResult(output);

    assert.equal(result.output.status, "dry_run_complete");
    assert.equal(result.output.stop_reason, "queue_empty");
    assert.deepEqual(result.output.closed, []);
    assert.deepEqual(calls, ["discover", "proveDry"]);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("fixture-drain autonomous-local defaults to background unless explicitly disabled", async () => {
  const calls = [];
  const { tools, context, directory } = await makeHarness(async () => {
    throw new Error("empty non-dry drain must not launch child lanes");
  }, {
    extensions: [FIXTURE_DRAIN_EXT],
    pluginContext: {
      __workflowDrainAdapters: { fake: async () => emptyDrainAdapter(calls) },
    },
  });
  try {
    await initGitRepo(directory);

    const backgroundPreview = await tools.workflow_run.execute({ name: "fixture-drain", args: { mode: "autonomous-local" } }, context);
    assert.match(backgroundPreview, /Background: true/);
    const backgroundHash = backgroundPreview.match(/approvalHash: ([a-f0-9]{64})/)?.[1];
    assert.ok(backgroundHash, `missing approval hash in preview: ${backgroundPreview}`);
    const started = await tools.workflow_run.execute({ name: "fixture-drain", args: { mode: "autonomous-local" }, approve: true, approvalHash: backgroundHash }, context);
    assert.match(started, /started in background/);
    const backgroundRunId = runIdFrom(started);
    await __test.runs.get(backgroundRunId)?.done;
    const backgroundStatus = JSON.parse(await tools.workflow_status.execute({ runId: backgroundRunId, format: "json", detail: "full" }, context));
    assert.equal(backgroundStatus.background, true);

    const foregroundPreview = await tools.workflow_run.execute({ name: "fixture-drain", args: { mode: "autonomous-local" }, background: false }, context);
    assert.match(foregroundPreview, /Background: false/);
    const foreground = await runApprovedRequest(tools, context, { name: "fixture-drain", args: { mode: "autonomous-local" }, background: false });
    assert.match(foreground, /completed/);
    assert.doesNotMatch(foreground, /started in background/);
    const foregroundStatus = JSON.parse(await tools.workflow_status.execute({ runId: runIdFrom(foreground), format: "json", detail: "full" }, context));
    assert.equal(foregroundStatus.background, false);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("drain: top-level profile and args.mode are canonically equivalent (same approval hash)", async () => {
  const harnessOpts = {
    extensions: [FIXTURE_DRAIN_EXT],
    pluginContext: {
      __workflowDrainAdapters: { fake: async () => emptyDrainAdapter([]) },
    },
  };
  // One harness/context so capabilities + base state are identical; the ONLY variable is the
  // invocation form. (Two harnesses can probe capabilities differently under concurrency.)
  const { tools, context, directory } = await makeHarness(async () => ({ data: { parts: [], info: {} } }), harnessOpts);
  try {
    await initGitRepo(directory);
    const viaProfile = await tools.workflow_run.execute({ name: "fixture-drain", profile: "drain-autonomous-local" }, context);
    const viaMode = await tools.workflow_run.execute({ name: "fixture-drain", args: { mode: "autonomous-local" } }, context);
    const h1 = viaProfile.match(/approvalHash: ([a-f0-9]{64})/)?.[1];
    const h2 = viaMode.match(/approvalHash: ([a-f0-9]{64})/)?.[1];
    assert.ok(h1 && h2, "both previews must carry an approvalHash");
    assert.equal(h1, h2, "equivalent drain invocation forms must yield the same approvalHash");
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("drain: a conflicting top-level profile and args.mode are rejected", async () => {
  const { tools, context, directory } = await makeHarness(async () => ({ data: { parts: [], info: {} } }), {
    extensions: [FIXTURE_DRAIN_EXT],
  });
  try {
    await assert.rejects(
      tools.workflow_run.execute({ name: "fixture-drain", profile: "drain-dry-run", args: { mode: "autonomous-local" } }, context),
      /conflicting drain invocation/,
    );
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("fixture-drain rejects unknown mode", async () => {
  const { tools, context, directory } = await makeHarness(async () => ({ data: { parts: [], info: {} } }), {
    extensions: [FIXTURE_DRAIN_EXT],
  });
  try {
    await assert.rejects(
      runApprovedRequest(tools, context, { name: "fixture-drain", args: { mode: "unsafe" } }),
      /drain mode must be "dry-run" or "autonomous-local"/,
    );
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("non-drain workflow with a custom args.mode does not hit drain mode validation", async () => {
  const { tools, context, directory } = await makeHarness(async () => ({ data: { parts: [], info: {} } }));
  try {
    // A custom `args.mode` on a non-drain workflow must NOT be interpreted as a drain
    // mode; resolveDrainMode would otherwise throw at startup for any value other than
    // "dry-run"/"autonomous-local". Regression for authorityArgsForWorkflow gating.
    const source = `export const meta = { name: "custom-mode-smoke", profile: "read-only-review" };
return { mode: args?.mode ?? null };`;
    const request = { source, args: { mode: "unsafe" } };
    const preview = await tools.workflow_run.execute(request, context);
    assert.doesNotMatch(preview, /drain mode must be/);
    assert.match(preview, /approvalHash: [a-f0-9]{64}/);

    const output = await runApprovedRequest(tools, context, request);
    const status = JSON.parse(await tools.workflow_status.execute({ runId: runIdFrom(output), format: "json", detail: "result" }, context));
    assert.equal(status.status, "completed");
    assert.equal(status.result.output.mode, "unsafe");
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("a fully-failed drain with zero patches reports run status failed, not completed", async () => {
  const { tools, context, directory } = await makeHarness(async () => ({ data: { parts: [], info: {} } }));
  try {
    // A drain body can report a DRAIN_FAILURE_STATUSES status (e.g. "failed", when
    // report.failed.length > 0) without ever reaching the integration/diff-plan path, so
    // run.editPlan never gets patches. The zero-patch else branch (workflow-plugin.js ~1246)
    // must consult drainFailed instead of defaulting to "completed" -- a failed drain with no
    // patches is not a success.
    const source = `export const meta = { name: "fully-failed-drain", profile: "read-only-review" };
return { status: "failed", failed: [{ itemId: "x" }] };`;
    const output = await runApproved(tools, context, source);
    // The "failed" wording isn't in runIdFrom's recognized-status alternation (same reason the
    // failed-with-diff-plan test above extracts the run id from the result path instead).
    const runId = path.basename(path.dirname(resultPath(output)));
    const status = JSON.parse(await tools.workflow_status.execute({ runId, format: "json" }, context));
    assert.equal(status.status, "failed");
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

// Design C deleted the drain gate funnel entirely: NON_DRY_DRAIN_REQUIRED_GATES,
// adapter.requiredGates enforcement, unsafeAcceptUnverifiedPermissions, and the "Non-dry drain
// requires verified live gates" preflight in runHostDrain are all gone. The five tests that used
// to live here proved that preflight's mechanics (fails closed on unverified gates, ignores
// guest-spoofed gate claims, refuses an unsafe override, proceeds once forced-verified). The
// surviving concept — a non-dry drain reaches the adapter and mutates via the integration diff
// plan with ZERO gate preflight of any kind — is proven in tests/sandbox-executor.test.mjs
// ("non-dry drain launches with zero gate preflight and reaches the adapter (no drain.live_gates
// event)") and by "workflow drain non-dry accepted lanes flow through integration diff plan" right
// below, neither of which forces any gate state. What replaces "ignores guest-spoofed gates" is
// proven directly below: a guest script can no longer even get a spoofed gate claim INTO the
// drain report, because sandbox-executor.js's runHostDrain destructures gateStatus/gates out of
// the guest payload and never forwards them.

test("non-dry drain never lets guest-supplied gateStatus/gates reach the report", async () => {
  const calls = [];
  const { tools, context, directory } = await makeHarness(async (input) => {
    await fs.writeFile(path.join(input.query.directory, "drain.txt"), "accepted lane\n", "utf8");
    const laneResult = {
      itemId: "item-1",
      outcome: "implemented",
      summary: "implemented",
      readyForIntegration: true,
      filesChanged: ["drain.txt"],
      commandsRun: ["write drain.txt"],
      acceptanceEvidence: ["drain.txt written"],
      residualRisks: [],
      followups: [],
    };
    return {
      data: {
        parts: [{ type: "text", text: JSON.stringify(laneResult) }],
        info: { structured: laneResult, tokens: { input: 1, output: 1, reasoning: 0 }, cost: 0 },
      },
    };
  }, {
    pluginContext: {
      __workflowDrainAdapters: { fake: async () => fakeDrainAdapter(calls) },
      __workflowIntegrationValidator: async () => ({ accepted: true, status: "passed", validationCommands: [], evidence: [] }),
    },
  });
  try {
    await initGitRepo(directory);
    // A guest script tries to inject a fully-verified gate claim directly into the drain report.
    const source = `export const meta = { name: "fixture-drain-spoofed-gates", authority: { integration: true }, maxAgents: 1 };
const fakeVerified = { permissionEnforcement: { state: "verified", verified: true, evidence: "guest spoof" } };
return await drain({
  adapter: "fake",
  dryRun: false,
  gateStatus: fakeVerified,
  gates: fakeVerified,
  maxAttempts: 1,
  maxWaves: 1,
});`;

    const output = await runApproved(tools, context, source);
    const result = await readResult(output);

    // The drain proceeded (reached the adapter, no gate preflight) AND the guest-supplied
    // gateStatus/gates never made it into the report — runHostDrain strips them unconditionally.
    assert.equal(result.output.status, "complete");
    assert.equal(result.output.gateStatus, undefined);
    assert.equal(calls.includes("discover"), true);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("workflow drain non-dry accepted lanes flow through integration diff plan", async () => {
  const calls = [];
  const prompts = [];
  const validations = [];
  const { tools, context, directory } = await makeHarness(async (input) => {
    prompts.push(input);
    await fs.writeFile(path.join(input.query.directory, "drain.txt"), "accepted lane\n", "utf8");
    const laneResult = {
      itemId: "item-1",
      outcome: "implemented",
      summary: "implemented fake drain item",
      readyForIntegration: true,
      filesChanged: ["drain.txt"],
      commandsRun: ["write drain.txt"],
      acceptanceEvidence: ["drain.txt written"],
      residualRisks: [],
      followups: [],
    };
    return {
      data: {
        parts: [{ type: "text", text: JSON.stringify(laneResult) }],
        info: {
          structured: laneResult,
          tokens: { input: 1, output: 1, reasoning: 0 },
          cost: 0,
        },
      },
    };
  }, {
    pluginContext: {
      __workflowDrainAdapters: { fake: async () => fakeDrainAdapter(calls) },
      __workflowIntegrationValidator: async (input) => {
        validations.push(input);
        return { accepted: true, status: "passed", validationCommands: ["fake integration validation"], evidence: ["merged tree validated"] };
      },
    },
  });
  try {
    await initGitRepo(directory);
    const source = `export const meta = { name: "fake-drain", authority: { integration: true }, maxAgents: 1 };
return await drain({ adapter: "fake", dryRun: false, maxAttempts: 1, maxWaves: 2 });`;

    const output = await runApproved(tools, context, source);
    const runId = runIdFrom(output);
    const result = await readResult(output);
    const status = JSON.parse(await tools.workflow_status.execute({ runId, format: "json", detail: "full" }, context));

    assert.equal(result.output.status, "complete");
    assert.equal(status.status, "awaiting-diff-approval");
    assert.equal(status.integrationPlan.lanes.length, 1);
    assert.equal(status.integrationPlan.lanes[0].acceptedForIntegration, true);
    assert.equal(status.editPlan.integration, true);
    assert.equal(status.editPlan.patchCount, 1);
    assert.equal(status.integrationPlan.integrationResult.validation.accepted, true);
    assert.equal(status.integrationPlan.integrationResult.patches, undefined, "full status must not expose raw integration patch contents");
    assert.equal(status.diagnostics.integration.status, "awaiting-diff-approval");
    assert.deepEqual(status.diagnostics.integration.mergedLanes, [status.integrationPlan.lanes[0].callId]);
    assert.equal(status.diagnostics.integration.affectedLanes[0].callId, status.integrationPlan.lanes[0].callId);
    assert.equal(status.diagnostics.integration.affectedLanes[0].paths[0].path, "drain.txt");
    assert.equal(validations.length, 1);
    assert.equal(validations[0].directory, status.integrationPlan.integrationResult.integrationWorktree.path);
    const validationLedger = (await fs.readFile(path.join(status.dir, "validation-ledger.jsonl"), "utf8"))
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    assert.ok(validationLedger.some((entry) => entry.phase === "integration-validation" && entry.status === "passed"));
    assert.equal(await fileExists(path.join(context.directory, "drain.txt")), false);
    // Design C: structured-text is the only schema-lane path; the kernel must never send
    // format: to session.prompt (child-agent-runner.js injects a structured-text instruction
    // into the system prompt instead).
    assert.ok(!("format" in prompts[0].body), "schema lanes must never send format: to session.prompt");
    assert.match(prompts[0].body.parts[0].text, /Do not mutate domain state directly/);

    const applied = await tools.workflow_apply.execute({
      runId,
      approvedSourceHash: status.sourceHash,
      baseCommit: status.editPlan.baseCommit,
      diffPlanHash: status.editPlan.diffPlanHash,
      domainMutationHash: status.editPlan.domainMutationHash,
      approvalIntent: "apply",
      expectedPrimaryDirtyState: "clean",
    }, context);
    assert.match(applied, /applied 1 patches/);
    assert.equal(await fs.readFile(path.join(context.directory, "drain.txt"), "utf8"), "accepted lane\n");
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("workflow drain integration validation failure blocks diff plan creation", async () => {
  const calls = [];
  const { tools, context, directory } = await makeHarness(async (input) => {
    await fs.writeFile(path.join(input.query.directory, "drain.txt"), "accepted lane\n", "utf8");
    const laneResult = {
      itemId: "item-1",
      outcome: "implemented",
      summary: "implemented fake drain item",
      readyForIntegration: true,
      filesChanged: ["drain.txt"],
      commandsRun: ["write drain.txt"],
      acceptanceEvidence: ["drain.txt written"],
      residualRisks: [],
      followups: [],
    };
    return {
      data: {
        parts: [{ type: "text", text: JSON.stringify(laneResult) }],
        info: {
          structured: laneResult,
          tokens: { input: 1, output: 1, reasoning: 0 },
          cost: 0,
        },
      },
    };
  }, {
    pluginContext: {
      __workflowDrainAdapters: { fake: async () => fakeDrainAdapter(calls) },
      __workflowIntegrationValidator: async () => ({
        accepted: false,
        status: "failed",
        reason: "fake integration validation failed",
        validationCommands: ["fake integration validation"],
        evidence: ["failure evidence"],
      }),
    },
  });
  try {
    await initGitRepo(directory);
    const source = `export const meta = { name: "fake-drain-integration-validation-fails", authority: { integration: true }, maxAgents: 1 };
return await drain({ adapter: "fake", dryRun: false, maxAttempts: 1, maxWaves: 2 });`;

    const output = await runApproved(tools, context, source);
    assert.match(output, /review-required/);
    assert.match(output, /integration-validation-failed/);
    const runId = runIdFrom(output);
    const result = await readResult(output);
    const status = JSON.parse(await tools.workflow_status.execute({ runId, format: "json", detail: "full" }, context));

    assert.equal(status.status, "review-required");
    assert.equal(status.integrationPlan.integrationResult.reason, "integration-validation-failed");
    assert.equal(status.integrationPlan.integrationResult.patches, undefined, "review-required full status must not expose raw patch contents");
    assert.equal(status.diagnostics.integration.status, "review-required");
    assert.equal(status.diagnostics.integration.reason, "integration-validation-failed");
    assert.match(status.diagnostics.integration.errorSummary, /fake integration validation failed/);
    assert.equal(status.diagnostics.integration.affectedLanes[0].paths[0].path, "drain.txt");
    assert.equal(status.editPlan, undefined);
    assert.equal(await fileExists(path.join(status.dir, "diff-plan.json")), false);
    assert.equal(result.integration.reason, "integration-validation-failed");
    assert.equal(result.integration.validation.reason, "fake integration validation failed");
    const validationLedger = (await fs.readFile(path.join(status.dir, "validation-ledger.jsonl"), "utf8"))
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    assert.ok(validationLedger.some((entry) => entry.phase === "integration-validation" && entry.status === "failed" && entry.reason === "fake integration validation failed"));
    assert.equal(await fileExists(path.join(context.directory, "drain.txt")), false);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("workflow_status full surfaces bounded integration path-conflict diagnostics", async () => {
  const { tools, context, directory } = await makeHarness(async () => {
    throw new Error("synthetic status test must not prompt a model");
  });
  const runId = "integration-conflict-status";
  try {
    const root = __test.runRoot(context);
    const dir = __test.runDirForRoot(root, runId);
    await fs.mkdir(dir, { recursive: true });
    await __test.writeJsonAtomic(path.join(dir, "state.json"), {
      id: runId,
      status: "review-required",
      sourcePath: "<inline>",
      sourceHash: __test.hash("return true;"),
      meta: { name: "integration-conflict-status" },
      authority: __test.resolveRunAuthority({ authority: { integration: true } }, {}),
      startedAt: new Date(0).toISOString(),
      agentsStarted: 2,
      maxAgents: 2,
      concurrency: 2,
      laneOutcomes: {},
      droppedLaneCount: 0,
      capabilities: {},
      diagnostics: {},
      integrationPlan: {
        sourceHash: __test.hash("return true;"),
        baseCommit: "base",
        patches: [{ path: "conflict.txt", content: "raw patch content must not leak", mode: "replace" }],
        lanes: [],
        integrationResult: {
          status: "review-required",
          reason: "path-conflict",
          conflicts: [{ path: "conflict.txt", lanes: ["lane-a", "lane-b"] }],
          lanes: [
            { callId: "lane-a", branch: "branch-a", paths: [{ status: "M", path: "conflict.txt", supported: true }] },
            { callId: "lane-b", branch: "branch-b", paths: [{ status: "M", path: "conflict.txt", supported: true }] },
          ],
          patches: [{ path: "conflict.txt", content: "nested raw patch content must not leak", mode: "replace" }],
        },
      },
    });

    const status = JSON.parse(await tools.workflow_status.execute({ runId, format: "json", detail: "full" }, context));

    assert.equal(status.status, "review-required");
    assert.equal(status.diagnostics.integration.reason, "path-conflict");
    assert.equal(status.diagnostics.integration.conflictCount, 1);
    assert.deepEqual(status.diagnostics.integration.conflicts[0], { path: "conflict.txt", lanes: ["lane-a", "lane-b"] });
    assert.equal(status.diagnostics.integration.affectedLanes.length, 2);
    assert.equal(status.integrationPlan.patches, undefined);
    assert.equal(status.integrationPlan.integrationResult.patches, undefined);
    assert.doesNotMatch(JSON.stringify(status), /raw patch content must not leak/);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("workflow drain partial failure with patches is not masked as clean awaiting diff approval", async () => {
  const calls = [];
  const { tools, context, directory } = await makeHarness(async (input) => {
    await fs.writeFile(path.join(input.query.directory, "drain.txt"), "accepted lane\n", "utf8");
    const laneResult = {
      itemId: "item-1",
      outcome: "implemented",
      summary: "implemented fake drain item",
      readyForIntegration: true,
      filesChanged: ["drain.txt"],
      commandsRun: ["write drain.txt"],
      acceptanceEvidence: ["drain.txt written"],
      residualRisks: [],
      followups: [],
    };
    return {
      data: {
        parts: [{ type: "text", text: JSON.stringify(laneResult) }],
        info: {
          structured: laneResult,
          tokens: { input: 1, output: 1, reasoning: 0 },
          cost: 0,
        },
      },
    };
  }, {
    pluginContext: { __workflowDrainAdapters: { fake: async () => fakeDrainAdapter(calls, { forceNotDry: true }) } },
  });
  try {
    await initGitRepo(directory);
    const source = `export const meta = { name: "fake-drain-partial", authority: { integration: true }, maxAgents: 1 };
return await drain({ adapter: "fake", dryRun: false, maxAttempts: 1, maxWaves: 2 });`;

    const output = await runApproved(tools, context, source);
    assert.match(output, /failed with diff plan for review/);
    const runId = path.basename(path.dirname(resultPath(output)));
    const result = await readResult(output);
    const status = JSON.parse(await tools.workflow_status.execute({ runId, format: "json", detail: "full" }, context));

    // Drain output is a failure status (not_dry) but a lane was accepted and committed.
    assert.equal(result.output.status, "not_dry");
    // The outer run status must NOT be masked as clean awaiting-diff-approval.
    assert.equal(status.status, "failed-with-diff-plan");
    // Patch metadata is preserved for review.
    assert.equal(status.editPlan.integration, true);
    assert.equal(status.editPlan.patchCount, 1);
    assert.ok(status.editPlan.diffPlanHash, "diff plan hash preserved");

    // The diff plan remains reviewable/applyable despite the failure status.
    const applied = await tools.workflow_apply.execute({
      runId,
      approvedSourceHash: status.sourceHash,
      baseCommit: status.editPlan.baseCommit,
      diffPlanHash: status.editPlan.diffPlanHash,
      domainMutationHash: status.editPlan.domainMutationHash,
      approvalIntent: "apply",
      expectedPrimaryDirtyState: "clean",
    }, context);
    assert.match(applied, /applied 1 patches/);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("workflow drain records dirty timeout salvage before releasing a claim", async () => {
  const calls = [];
  const releases = [];
  const { tools, context, directory } = await makeHarness(async (input) => {
    await fs.writeFile(path.join(input.query.directory, "salvage.txt"), "partial work\n", "utf8");
    return await new Promise(() => {});
  }, {
    pluginContext: {
      __workflowDrainAdapters: {
        fake: async () => fakeDrainAdapter(calls, {
          forceNotDry: true,
          async releaseClaim(item, releaseContext) {
            releases.push({ id: item.id, salvage: releaseContext.salvage, reason: releaseContext.reason });
            return { id: item.id, status: "released" };
          },
        }),
      },
    },
  });
  try {
    await initGitRepo(directory);
    const source = `export const meta = { name: "fake-drain-timeout-salvage", authority: { integration: true }, maxAgents: 1 };
return await drain({ adapter: "fake", dryRun: false, maxAttempts: 1, maxWaves: 1 });`;
    const output = await runApprovedRequest(tools, context, { source, laneTimeoutMs: 1 });
    // "failed" isn't in runIdFrom's recognized-status alternation; extract the run id from the
    // result path instead (same approach the failed-with-diff-plan test below uses).
    const runId = path.basename(path.dirname(resultPath(output)));
    const result = await readResult(output);
    const status = JSON.parse(await tools.workflow_status.execute({ runId, format: "json", detail: "full" }, context));

    assert.equal(result.output.status, "failed");
    // A salvaged (uncommitted) lane is never integrable, so this drain produces zero patches; a
    // failed drain body with zero patches must surface as a failed run, not a masked "completed".
    assert.equal(status.status, "failed");
    assert.equal(result.output.salvaged.length, 1);
    assert.equal(result.output.salvaged[0].itemId, "item-1");
    assert.equal(result.output.salvaged[0].salvage.dirty, true);
    assert.deepEqual(result.output.salvaged[0].salvage.changedFiles.map((entry) => entry.path), ["salvage.txt"]);
    assert.equal(releases.length, 1);
    assert.equal(releases[0].salvage.dirty, true);
    assert.match(releases[0].salvage.worktreePath, /workflow-worktrees/);
    assert.equal(status.laneRecords[0].outcome, "timeout");
    assert.equal(status.laneRecords[0].salvage.dirty, true);
    assert.deepEqual(status.laneRecords[0].salvage.changedFiles.map((entry) => entry.path), ["salvage.txt"]);
    assert.equal(status.durability.ledgers["validation-ledger"].phases["salvage-validation-skipped"], 1);
    assert.equal(status.worktreeCleanup.integration[0].preserved, true);
    assert.equal(status.worktreeCleanup.integration[0].reason, "dirty");
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("workflow drain rejected lanes are recorded but excluded from integration", async () => {
  const calls = [];
  const { tools, context, directory } = await makeHarness(async (input) => {
    await fs.writeFile(path.join(input.query.directory, "rejected.txt"), "rejected lane\n", "utf8");
    const laneResult = {
      itemId: "item-1",
      outcome: "blocked",
      summary: "not ready for integration",
      readyForIntegration: false,
      filesChanged: ["rejected.txt"],
      commandsRun: ["write rejected.txt"],
      acceptanceEvidence: [],
      residualRisks: ["blocked"],
      followups: [],
    };
    return {
      data: {
        parts: [{ type: "text", text: JSON.stringify(laneResult) }],
        info: {
          structured: laneResult,
          tokens: { input: 1, output: 1, reasoning: 0 },
          cost: 0,
        },
      },
    };
  }, {
    pluginContext: { __workflowDrainAdapters: { fake: async () => fakeDrainAdapter(calls) } },
  });
  try {
    await initGitRepo(directory);
    const source = `export const meta = { name: "fake-drain-rejected", authority: { integration: true }, maxAgents: 1 };
return await drain({ adapter: "fake", dryRun: false, maxAttempts: 1, maxWaves: 1 });`;

    const output = await runApproved(tools, context, source);
    // "failed" isn't in runIdFrom's recognized-status alternation; extract the run id from the
    // result path instead (same approach the failed-with-diff-plan test below uses).
    const runId = path.basename(path.dirname(resultPath(output)));
    const result = await readResult(output);
    const status = JSON.parse(await tools.workflow_status.execute({ runId, format: "json", detail: "full" }, context));

    assert.equal(result.output.status, "failed");
    // The rejected lane is excluded from integration, so this drain produces zero patches; a
    // failed drain body with zero patches must surface as a failed run, not a masked "completed".
    assert.equal(status.status, "failed");
    assert.equal(status.integrationPlan.lanes.length, 1);
    assert.equal(status.integrationPlan.lanes[0].acceptedForIntegration, false);
    assert.equal(status.integrationPlan.integrationResult, undefined);
    assert.equal(status.editPlan, undefined);
    assert.equal(await fileExists(path.join(context.directory, "rejected.txt")), false);
    assert.equal(calls.some((call) => Array.isArray(call) && call[0] === "validate"), false);
    assert.equal(calls.some((call) => Array.isArray(call) && call[0] === "close"), false);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("workflow drain invalid lane reports do not create integration lanes", async () => {
  const calls = [];
  const { tools, context, directory } = await makeHarness(async (input) => {
    await fs.writeFile(path.join(input.query.directory, "invalid.txt"), "invalid lane\n", "utf8");
    return {
      data: {
        parts: [{ type: "text", text: "invalid" }],
        info: {
          structured: { itemId: "item-1" },
          tokens: { input: 1, output: 1, reasoning: 0 },
          cost: 0,
        },
      },
    };
  }, {
    pluginContext: { __workflowDrainAdapters: { fake: async () => fakeDrainAdapter(calls) } },
  });
  try {
    await initGitRepo(directory);
    const source = `export const meta = { name: "fake-drain-invalid", authority: { integration: true }, maxAgents: 1 };
return await drain({ adapter: "fake", dryRun: false, maxAttempts: 1, maxWaves: 1 });`;

    const output = await runApproved(tools, context, source);
    // "failed" isn't in runIdFrom's recognized-status alternation; extract the run id from the
    // result path instead (same approach the failed-with-diff-plan test below uses).
    const runId = path.basename(path.dirname(resultPath(output)));
    const result = await readResult(output);
    const status = JSON.parse(await tools.workflow_status.execute({ runId, format: "json", detail: "full" }, context));

    assert.equal(result.output.status, "failed");
    // An invalid lane report never reaches integration, so this drain produces zero patches; a
    // failed drain body with zero patches must surface as a failed run, not a masked "completed".
    assert.equal(status.status, "failed");
    assert.equal(status.integrationPlan.lanes.length, 0);
    assert.equal(status.editPlan, undefined);
    assert.equal(status.laneRecords.some((record) => record.outcome === "failure"), true);
    assert.equal(await fileExists(path.join(context.directory, "invalid.txt")), false);
    assert.equal(calls.some((call) => Array.isArray(call) && call[0] === "validate"), false);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("workflow drain rejects unsupported adapter names", async () => {
  const { tools, context, directory } = await makeHarness(async () => ({ data: { parts: [], info: {} } }));
  try {
    const source = `export const meta = { name: "bad-drain" };
return await drain({ adapter: "unknown", dryRun: true });`;

    await assert.rejects(runApproved(tools, context, source), /Unsupported drain adapter: unknown/);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("workflow status exposes lane telemetry and derived usage totals", async () => {
  const { tools, context, directory } = await makeHarness(async () => ({
    data: {
      parts: [{ type: "text", text: "lane result" }],
      info: { tokens: { input: 7, output: 3, reasoning: 2 }, cost: 0.25 },
    },
  }));
  try {
    const source = `export const meta = { name: "telemetry" };
return await agent("Inspect alpha\\nDo not expose the full prompt", { label: "Alpha lane", agent: "build" });`;

    const output = await runApproved(tools, context, source);
    const status = JSON.parse(await tools.workflow_status.execute({ runId: runIdFrom(output), format: "json", detail: "full" }, context));
    const lane = status.laneRecords[0];

    assert.equal(status.defaultChildModel, HARNESS_DEFAULT_MODEL);
    assert.deepEqual(status.usage.totalTokens, { input: 7, output: 3, reasoning: 2 });
    assert.equal(status.usage.totalCost, 0.25);
    assert.equal(lane.status, "completed");
    assert.ok(lane.startedAt);
    assert.ok(lane.completedAt);
    assert.equal(lane.taskSummary, "Alpha lane");
    assert.equal(lane.agent, "build");
    assert.deepEqual(lane.tokens, { input: 7, output: 3, reasoning: 2 });
    assert.equal(lane.cost, 0.25);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("workflow_run laneTimeoutMs is approved, stored, and applied to child lanes", async () => {
  const { tools, context, directory } = await makeHarness(async () => ({
    data: {
      parts: [{ type: "text", text: "lane result" }],
      info: { tokens: { input: 1, output: 1, reasoning: 0 }, cost: 0 },
    },
  }));
  try {
    const source = `export const meta = { name: "lane-timeout" };
return await agent("long lane", { label: "Long lane" });`;

    const preview = await tools.workflow_run.execute({ source, laneTimeoutMs: 3_600_000 }, context);
    assert.match(preview, /Lane timeout: 3600000ms/);
    const approvalHash = preview.match(/approvalHash: ([a-f0-9]{64})/)?.[1];
    assert.ok(approvalHash, `missing approval hash in preview: ${preview}`);
    const output = await tools.workflow_run.execute({ source, laneTimeoutMs: 3_600_000, approve: true, approvalHash }, context);
    const status = JSON.parse(await tools.workflow_status.execute({ runId: runIdFrom(output), format: "json", detail: "full" }, context));

    assert.equal(status.laneTimeoutMs, 3_600_000);
    assert.equal(status.laneRecords[0].timeoutMs, 3_600_000);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("fixture-drain runtime lane timeout aliases are validated", async () => {
  const { tools, context, directory } = await makeHarness(async () => {
    throw new Error("dry-run fixture-drain must not launch child lanes");
  }, {
    extensions: [FIXTURE_DRAIN_EXT],
    pluginContext: { __workflowDrainAdapters: { fake: async () => emptyDrainAdapter([]) } },
  });
  try {
    const preview = await tools.workflow_run.execute({ name: "fixture-drain", args: { mode: "dry-run", laneTimeoutMs: 3_600_000 } }, context);
    assert.match(preview, /Lane timeout: 3600000ms/);

    await assert.rejects(
      tools.workflow_run.execute({ name: "fixture-drain", args: { mode: "dry-run", laneTimeoutMs: 3_600_000 }, childPromptTimeoutMs: 600_000 }, context),
      /must match/,
    );
    await assert.rejects(
      tools.workflow_run.execute({ name: "fixture-drain", args: { mode: "dry-run", childPromptTimeoutMs: 3_600_001 } }, context),
      /childPromptTimeoutMs must be <= 3600000ms/,
    );
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("scoped parallel failFast aborts active siblings and records cancelled outcomes", async () => {
  const prompts = [];
  const aborts = [];
  async function waitForStarted(count) {
    for (let index = 0; index < 100 && prompts.length < count; index += 1) {
      await setTimeoutP(1);
    }
  }
  const { tools, context, directory } = await makeHarness(async (input) => {
    prompts.push(input.body.parts[0].text);
    if (input.body.parts[0].text.includes("fail first")) {
      await waitForStarted(3);
      throw new Error("boom failFast");
    }
    return await new Promise(() => {});
  }, { onAbort: (input) => aborts.push(input) });
  try {
    const source = `export const meta = { name: "failfast-active", concurrency: 3 };
await parallel([
  async ({ agent }) => await agent("fail first"),
  async ({ agent }) => await agent("slow sibling one"),
  async ({ agent }) => await agent("slow sibling two"),
], { failFast: true });`;

    await assert.rejects(runApproved(tools, context, source), /boom failFast/);
    const status = await statusByName(tools, context, "failfast-active");

    assert.equal(status.laneOutcomes.failure, 1);
    assert.equal(status.laneOutcomes.cancelled, 2);
    assert.equal(status.activeAgents, 0);
    assert.equal(status.queuedAgents, 0);
    assert.equal(aborts.length, 2);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("scoped pipeline failFast cancels queued siblings before launch", async () => {
  const prompts = [];
  const aborts = [];
  const { tools, context, directory } = await makeHarness(async (input) => {
    prompts.push(input.body.parts[0].text);
    throw new Error("pipeline failed");
  }, { onAbort: (input) => aborts.push(input) });
  try {
    const source = `export const meta = { name: "failfast-queued", concurrency: 1 };
await pipeline(["one", "two", "three"], async (item, { agent }) => await agent("pipeline " + item), { failFast: true });`;

    await assert.rejects(runApproved(tools, context, source), /pipeline failed/);
    const status = await statusByName(tools, context, "failfast-queued");

    assert.equal(prompts.length, 1);
    assert.equal(status.laneOutcomes.failure, 1);
    assert.equal(status.laneOutcomes.cancelled, 2);
    assert.equal(status.activeAgents, 0);
    assert.equal(status.queuedAgents, 0);
    assert.equal(aborts.length, 0);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

// Design C deleted the launch-time capability-shape gates these three tests exercised
// (permissions/directoryRooting/worktreeEditIsolation are not fields the shape-only capability
// adapter reports at all anymore — see tests/helpers/harness.mjs's DEFAULT_CAPABILITIES). The
// kernel now trusts the platform's session.create permission/directory contract instead of
// refusing to launch until a probe promotes those capabilities to "available": shell/edit/
// integration authority no longer rejects on a shape-only "unavailable"/"available-unverified"
// signal. What replaces each deleted rejection:
//   - permission delivery:  sessionPermissionEchoStatus (mismatch => throw), covered end-to-end
//                           in tests/workflow-permissions.test.mjs.
//   - directory rooting:    sessionDirectoryEchoStatus (mismatch => throw), covered in
//                           tests/child-agent-runner.test.mjs.
//   - edit/worktreeEdit:    adapter.capabilities.worktree === "available" shape check (still
//                           live), covered above by the edit-plan-only/apply-approved-plan tests.
//   - elevated version floor: the server-fingerprint tests further down this file.
// Empirically, each of the three ad-hoc/drain runs these tests forced to reject now completes
// successfully instead — the intended, not regressed, outcome of trusting the platform.

test("shell authority and integration authority launch without any capability-shape gate to satisfy", async () => {
  const { tools, context, directory } = await makeHarness(async () => ({ data: { parts: [{ type: "text", text: "allowed" }], info: { tokens: { input: 0, output: 0, reasoning: 0 }, cost: 0 } } }));
  try {
    await initGitRepo(directory);
    const shellSource = `export const meta = { name: "shape-only-shell", authority: { shell: true } };
return await agent("run shell", { shell: true });`;
    const shellOutput = await runApproved(tools, context, shellSource);
    assert.match(shellOutput, /completed/);

    const integrationSource = `export const meta = { name: "missing-isolation", authority: { integration: true }, maxAgents: 1 };
return true;`;
    const integrationOutput = await runApproved(tools, context, integrationSource);
    assert.match(integrationOutput, /completed/);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("workflow_status refuses result paths outside the run directory", async () => {
  const escapeRoot = await tempDir();
  const { tools, context, directory } = await makeHarness(async () => ({ data: { parts: [], info: {} } }));
  try {
    const runId = "forged-result-run";
    const root = __test.runRoot(context);
    const dir = __test.runDirForRoot(root, runId);
    const resultPath = path.join(escapeRoot, "result.json");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(resultPath, JSON.stringify({ escaped: true }), "utf8");
    await fs.writeFile(path.join(dir, "state.json"), JSON.stringify({ id: runId, status: "completed", resultPath }, null, 2), "utf8");

    const status = JSON.parse(await tools.workflow_status.execute({ runId, format: "json", detail: "result" }, context));

    assert.equal(status.status, "completed");
    assert.match(status.resultError, /Workflow result path escapes expected root/);
    assert.equal(status.result, undefined);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
    await fs.rm(escapeRoot, { recursive: true, force: true });
  }
});

test("workflow_status validates empty runId and result detail arguments", async () => {
  const { tools, context, directory } = await makeHarness(async () => ({ data: { parts: [], info: {} } }));
  try {
    const listResult = await tools.workflow_status.execute({ runId: "", format: "json" }, context);
    assert.ok(Array.isArray(JSON.parse(listResult)));
    await assert.rejects(
      () => tools.workflow_status.execute({ format: "json", detail: "result" }, context),
      /workflow_status detail=result requires runId/,
    );
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("workflow_status detail full refuses notification paths outside the run directory", async () => {
  const escapeRoot = await tempDir();
  const { tools, context, directory } = await makeHarness(async () => ({ data: { parts: [], info: {} } }));
  try {
    const runId = "forged-notification-run";
    const root = __test.runRoot(context);
    const dir = __test.runDirForRoot(root, runId);
    const notificationPath = path.join(escapeRoot, "notification.json");
    await fs.mkdir(dir, { recursive: true });
    // Attacker-controlled file outside the run dir that the forged state.json points at.
    await fs.writeFile(notificationPath, JSON.stringify({ stolenSecret: "exfiltrated" }), "utf8");
    await fs.writeFile(
      path.join(dir, "state.json"),
      JSON.stringify({ id: runId, status: "completed", notification: { notificationPath, status: "persisted-record" } }, null, 2),
      "utf8",
    );

    const status = JSON.parse(await tools.workflow_status.execute({ runId, format: "json", detail: "full" }, context));

    assert.equal(status.status, "completed");
    // Containment rejection => fall back to the persisted record, never the out-of-run file contents.
    assert.equal(status.notification.status, "persisted-record");
    assert.equal(status.notification.stolenSecret, undefined);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
    await fs.rm(escapeRoot, { recursive: true, force: true });
  }
});

test("rehydratePendingNotifications rejects a notificationPath outside the run directory", async () => {
  const escapeRoot = await tempDir();
  const { context, directory } = await makeHarness(async () => ({ data: { parts: [], info: {} } }));
  const savedPending = new Set(__test.pendingNotificationPaths);
  __test.pendingNotificationPaths.clear();
  try {
    const runId = "tampered-rehydrate-run";
    const root = __test.runRoot(context);
    const dir = __test.runDirForRoot(root, runId);
    const inRunNotificationPath = path.join(dir, "notification.json");
    const escapedPath = path.join(escapeRoot, "notification.json");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(escapedPath, JSON.stringify({ unused: true }), "utf8");
    // notification.json lives inside the run dir but its notificationPath is tampered to escape it.
    await __test.writeJsonAtomic(inRunNotificationPath, {
      stateVersion: 1,
      runId,
      status: "completed",
      sessionID: "parent-session",
      directory,
      agent: "build",
      notificationPath: escapedPath,
      sentAt: null,
      delivery: { attempts: 0, lastAttemptAt: null, sendingAt: null, lastError: null },
    });

    const summary = await __test.rehydratePendingNotifications(
      { directory, worktree: directory },
      { type: "session.idle", properties: { sessionID: "parent-session" } },
    );

    assert.equal(summary.rehydrated, 0);
    assert.ok(summary.skipped >= 1);
    // The tampered out-of-run path must never enter the delivery queue.
    assert.equal(__test.pendingNotificationPaths.has(escapedPath), false);
  } finally {
    __test.pendingNotificationPaths.clear();
    for (const value of savedPending) __test.pendingNotificationPaths.add(value);
    await fs.rm(directory, { recursive: true, force: true });
    await fs.rm(escapeRoot, { recursive: true, force: true });
  }
});

test("workflow_status detail result redacts credential-like values", async () => {
  const { tools, context, directory } = await makeHarness(async () => ({ data: { parts: [], info: {} } }));
  try {
    const source = `export const meta = { name: "redacted-result" };
return { apiKey: "secret", nested: { token: "hidden" }, usageTokens: { input: 3, output: 4 } };`;
    const output = await runApproved(tools, context, source);
    assert.match(output, /Result \(redacted JSON, \d+ bytes\):/);
    assert.match(output, /"apiKey": "\[redacted\]"/);
    assert.match(output, /"token": "\[redacted\]"/);
    assert.match(output, /Read redacted result: workflow_status\(\{ runId: "[0-9a-f-]{36}", format: "json", detail: "result" \}\)/);
    assert.match(output, /JSON result payload: status\.result\.output/);
    assert.doesNotMatch(output, /secret/);
    assert.doesNotMatch(output, /hidden/);
    const status = JSON.parse(await tools.workflow_status.execute({ runId: runIdFrom(output), format: "json", detail: "result" }, context));

    assert.equal(status.result.output.apiKey, "[redacted]");
    assert.equal(status.result.output.nested.token, "[redacted]");
    assert.deepEqual(status.result.output.usageTokens, { input: 3, output: 4 });
    assert.equal(status.resultReadback.mode, "full");
    assert.equal(status.resultReadback.truncated, false);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("foreground workflow_run omits oversized inline results and points to result readback", async () => {
  const { tools, context, directory } = await makeHarness(async () => ({ data: { parts: [], info: {} } }));
  try {
    const source = `export const meta = { name: "large-inline-result" };
return { marker: "large-inline-result", blob: "x".repeat(${__test.MAX_INLINE_RESULT_BYTES + 2048}) };`;
    const output = await runApproved(tools, context, source);

    assert.match(output, /Result omitted from workflow_run: redacted JSON is \d+ bytes, above inline cap \d+\./);
    assert.match(output, /Read full\/partial result: workflow_status\(\{ runId: "[0-9a-f-]{36}", format: "json", detail: "result" \}\)/);
    assert.match(output, /Result file: /);
    assert.doesNotMatch(output, /x{1000}/);

    const status = JSON.parse(await tools.workflow_status.execute({ runId: runIdFrom(output), format: "json", detail: "result" }, context));
    assert.equal(status.result.output.marker, "large-inline-result");
    assert.equal(status.result.output.blob.length, __test.MAX_INLINE_RESULT_BYTES + 2048);
    assert.equal(status.resultReadback.mode, "full");
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("ux.6: compact status redacts sensitive meta keys and bounds oversized meta/error strings", () => {
  const oversized = "x".repeat(__test.MAX_STATUS_STRING_CHARS + 500);
  const entry = {
    id: "compact-redaction-run",
    root: "/runs",
    dir: "/runs/compact-redaction-run",
    status: "completed",
    kind: "valid",
    state: {
      id: "compact-redaction-run",
      status: "completed",
      meta: {
        name: "compact-redaction",
        apiKey: "COMPACT-SECRET-APIKEY-9000",
        authorization: "Bearer COMPACT-BEARER-9000",
        nested: { token: "COMPACT-SECRET-TOKEN-9000", password: "COMPACT-PW-9000", note: oversized },
        prompt: oversized,
      },
      error: oversized,
    },
  };
  const compact = __test.compactStatusForEntry(entry);
  const json = JSON.stringify(compact);
  // Credential-like keys are redacted at top level and when nested.
  assert.equal(compact.meta.apiKey, "[redacted]");
  assert.equal(compact.meta.authorization, "[redacted]");
  assert.equal(compact.meta.nested.token, "[redacted]");
  assert.equal(compact.meta.nested.password, "[redacted]");
  // The raw secret values must never survive into the compact meta view.
  assert.ok(!json.includes("COMPACT-SECRET-APIKEY-9000"), "raw apiKey leaked into compact status");
  assert.ok(!json.includes("COMPACT-BEARER-9000"), "raw authorization leaked into compact status");
  assert.ok(!json.includes("COMPACT-SECRET-TOKEN-9000"), "raw nested token leaked into compact status");
  assert.ok(!json.includes("COMPACT-PW-9000"), "raw nested password leaked into compact status");
  // Oversized non-sensitive strings are bounded by MAX_STATUS_STRING_CHARS.
  assert.ok(compact.meta.nested.note.length <= __test.MAX_STATUS_STRING_CHARS, "oversized meta string not bounded");
  assert.match(compact.meta.nested.note, /\[truncated \d+ chars\]/);
  assert.ok(compact.meta.prompt.length <= __test.MAX_STATUS_STRING_CHARS, "oversized meta prompt not bounded");
  assert.match(compact.meta.prompt, /\[truncated \d+ chars\]/);
  assert.ok(!json.includes(oversized), "unbounded oversized string leaked into compact status");
  // errorSummary is bounded too.
  assert.ok(compact.errorSummary.length <= __test.MAX_STATUS_STRING_CHARS, "oversized errorSummary not bounded");
  assert.match(compact.errorSummary, /\[truncated \d+ chars\]/);
});

test("ux.6: compact status omits raw prompts, tool outputs, and lane results not in the projection", () => {
  const entry = {
    id: "compact-projection-run",
    root: "/runs",
    dir: "/runs/compact-projection-run",
    status: "completed",
    kind: "valid",
    state: {
      id: "compact-projection-run",
      status: "completed",
      meta: { name: "compact-projection" },
      // Hostile raw evidence that the compact allowlist projection must never surface.
      transcript: "RAW-CHILD-TRANSCRIPT-CONTENT",
      prompt: "RAW-CHILD-PROMPT-CONTENT",
      rawToolOutput: "RAW-TOOL-OUTPUT-CONTENT",
      messages: [{ role: "assistant", content: "RAW-ASSISTANT-MESSAGE" }],
      laneResults: [{ output: "RAW-LANE-RESULT-CONTENT" }],
    },
  };
  const compact = __test.compactStatusForEntry(entry);
  const json = JSON.stringify(compact);
  assert.equal(compact.transcript, undefined);
  assert.equal(compact.prompt, undefined);
  assert.equal(compact.rawToolOutput, undefined);
  assert.equal(compact.messages, undefined);
  assert.equal(compact.laneResults, undefined);
  for (const leak of [
    "RAW-CHILD-TRANSCRIPT-CONTENT",
    "RAW-CHILD-PROMPT-CONTENT",
    "RAW-TOOL-OUTPUT-CONTENT",
    "RAW-ASSISTANT-MESSAGE",
    "RAW-LANE-RESULT-CONTENT",
  ]) {
    assert.ok(!json.includes(leak), `raw evidence ${leak} leaked into compact status`);
  }
});

test("ux.6: workflow_status detail=full redacts sensitive meta, bounds oversized strings, and omits raw evidence", async () => {
  const { tools, context, directory } = await makeHarness(async () => ({ data: { parts: [], info: {} } }));
  try {
    const runId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const root = __test.runRoot(context);
    const dir = __test.runDirForRoot(root, runId);
    await fs.mkdir(dir, { recursive: true });
    const oversized = "y".repeat(__test.MAX_STATUS_STRING_CHARS + 400);
    await __test.writeJsonAtomic(path.join(dir, "state.json"), {
      id: runId,
      status: "completed",
      meta: {
        name: "full-redaction",
        secret: "FULL-TOP-SECRET-VALUE",
        credential: "FULL-CREDENTIAL-VALUE",
        nested: { apiKey: "FULL-NESTED-APIKEY-VALUE", blurb: oversized },
      },
      error: oversized,
      // Raw evidence that the full allowlist projection must never surface.
      transcript: "FULL-RAW-TRANSCRIPT",
      rawToolOutput: "FULL-RAW-TOOL-OUTPUT",
      laneResults: [{ output: "FULL-RAW-LANE-RESULT" }],
    });
    const status = JSON.parse(await tools.workflow_status.execute({ runId, format: "json", detail: "full" }, context));
    const json = JSON.stringify(status);
    // Credential-like meta keys are redacted at every depth.
    assert.equal(status.meta.secret, "[redacted]");
    assert.equal(status.meta.credential, "[redacted]");
    assert.equal(status.meta.nested.apiKey, "[redacted]");
    assert.ok(!json.includes("FULL-TOP-SECRET-VALUE"), "raw secret leaked into full status");
    assert.ok(!json.includes("FULL-CREDENTIAL-VALUE"), "raw credential leaked into full status");
    assert.ok(!json.includes("FULL-NESTED-APIKEY-VALUE"), "raw nested apiKey leaked into full status");
    // Oversized meta strings and errorSummary are bounded.
    assert.ok(status.meta.nested.blurb.length <= __test.MAX_STATUS_STRING_CHARS, "oversized full meta string not bounded");
    assert.match(status.meta.nested.blurb, /\[truncated \d+ chars\]/);
    assert.ok(status.errorSummary.length <= __test.MAX_STATUS_STRING_CHARS, "oversized full errorSummary not bounded");
    assert.match(status.errorSummary, /\[truncated \d+ chars\]/);
    assert.ok(!json.includes(oversized), "unbounded oversized string leaked into full status");
    // Raw lane/tool/transcript evidence is never projected into the full view.
    assert.equal(status.transcript, undefined);
    assert.equal(status.rawToolOutput, undefined);
    assert.equal(status.laneResults, undefined);
    for (const leak of ["FULL-RAW-TRANSCRIPT", "FULL-RAW-TOOL-OUTPUT", "FULL-RAW-LANE-RESULT"]) {
      assert.ok(!json.includes(leak), `raw evidence ${leak} leaked into full status`);
    }
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("workflow_status detail=result preserves full-fidelity strings when the readback fits", async () => {
  const { tools, context, directory } = await makeHarness(async () => ({ data: { parts: [], info: {} } }));
  try {
    const oversizedLen = __test.MAX_STATUS_STRING_CHARS + 500;
    const source = `export const meta = { name: "oversized-result" };
return { blob: "z".repeat(${oversizedLen}), nested: { note: "z".repeat(${oversizedLen}) } };`;
    const output = await runApproved(tools, context, source);
    const status = JSON.parse(await tools.workflow_status.execute({ runId: runIdFrom(output), format: "json", detail: "result" }, context));
    assert.equal(status.result.output.blob.length, oversizedLen);
    assert.equal(status.result.output.nested.note.length, oversizedLen);
    assert.equal(status.resultReadback.mode, "full");
    assert.equal(status.resultReadback.truncated, false);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("workflow_status detail=result returns partial readback for oversized result files", async () => {
  const { tools, context, directory } = await makeHarness(async () => ({ data: { parts: [], info: {} } }));
  try {
    const runId = "oversized-result-readback";
    const root = __test.runRoot(context);
    const dir = __test.runDirForRoot(root, runId);
    const resultPath = path.join(dir, "result.json");
    const blob = "q".repeat(__test.MAX_RESULT_READBACK_BYTES + 5000);
    await fs.mkdir(dir, { recursive: true });
    await __test.writeJsonAtomic(resultPath, {
      output: {
        blob,
        stable: "kept",
        apiKey: "SHOULD-NOT-LEAK",
      },
    });
    await __test.writeJsonAtomic(path.join(dir, "state.json"), {
      id: runId,
      status: "completed",
      resultPath,
    });

    const status = JSON.parse(await tools.workflow_status.execute({ runId, format: "json", detail: "result" }, context));

    assert.ok(status.resultFileBytes > __test.MAX_RESULT_BYTES);
    assert.equal(status.resultError, undefined);
    assert.equal(status.result.output.stable, "kept");
    assert.equal(status.result.output.apiKey, "[redacted]");
    assert.ok(status.result.output.blob.length < blob.length);
    assert.match(status.result.output.blob, /\[truncated \d+ chars\]/);
    assert.equal(status.resultReadback.mode, "partial");
    assert.equal(status.resultReadback.truncated, true);
    assert.ok(status.resultReadback.fullBytes > status.resultReadback.maxBytes);
    assert.doesNotMatch(JSON.stringify(status), /SHOULD-NOT-LEAK/);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

// opencode-workflows-ux.4: workflow_status operator next-step hints.
// A valid synthetic run entry whose state.status drives nextActions, with optional
// hostile evidence fields the projection must never echo into a hint string.
function ux4Entry(status, stateExtra = {}, entryExtra = {}) {
  const id = "44444444-4444-4444-8444-444444444444";
  return {
    id,
    root: "/runs",
    dir: "/runs/ux4",
    status,
    kind: "valid",
    state: { id, status, ...stateExtra },
    ...entryExtra,
  };
}

function ux4ApplyableDiffPlan() {
  return {
    sourceHash: "ux4-source-hash",
    editPlan: {
      baseCommit: "ux4-base",
      diffPlanHash: "ux4-diff-hash",
      domainMutationHash: "ux4-domain-hash",
      patchCount: 1,
    },
  };
}

test("ux.4: compact status carries bounded operator nextActions for every run lifecycle state", () => {
  const expectations = [
    ["completed", { resultPath: "/runs/ux4/result.json" }, [/detail=result/, /detail=full/]],
    ["applied", {}, [/detail=full/]],
    ["failed", {}, [/detail=full/, /workflow_run resumeRunId=/]],
    ["timed-out", {}, [/detail=full/, /blocked from resume/]],
    ["failed-with-diff-plan", ux4ApplyableDiffPlan(), [/detail=full/, /workflow_apply runId=/]],
    ["awaiting-diff-approval", ux4ApplyableDiffPlan(), [/detail=full/, /workflow_apply runId=/]],
    ["apply-failed", ux4ApplyableDiffPlan(), [/detail=full/, /workflow_apply runId=/]],
    ["review-required", {}, [/detail=full/, /not directly applyable/]],
    ["cancelled", {}, [/detail=full/, /non-resumable/]],
    ["stale-active", {}, [/workflow_reconcile runId=/]],
    ["active-unknown", {}, [/another OpenCode process/]],
    ["interrupted", {}, [/workflow_run resumeRunId=/]],
    ["paused", {}, [/workflow_run resumeRunId=/]],
    ["running", {}, [/detail=full/, /workflow_pause runId=/, /workflow_kill runId=/]],
    ["apply-running", {}, [/detail=full/, /workflow_pause runId=/]],
    ["cancelling", {}, [/detail=full/, /workflow_kill runId=/]],
    ["pausing", {}, [/workflow_kill runId=/]],
    ["pending-approval", {}, [/approve=true/]],
  ];
  for (const [status, stateExtra, patterns] of expectations) {
    const compact = __test.compactStatusForEntry(ux4Entry(status, stateExtra));
    assert.ok(Array.isArray(compact.nextActions), `${status} nextActions must be an array`);
    assert.ok(compact.nextActions.length >= 1, `${status} must offer at least one next action`);
    assert.ok(compact.nextActions.length <= 5, `${status} nextActions must stay bounded`);
    for (const action of compact.nextActions) {
      assert.equal(typeof action, "string");
    }
    for (const pattern of patterns) {
      assert.ok(compact.nextActions.some((a) => pattern.test(a)), `${status} nextActions missing ${pattern}`);
    }
  }
  const timedOut = __test.compactStatusForEntry(ux4Entry("timed-out"));
  assert.ok(!timedOut.nextActions.some((a) => /workflow_run resumeRunId=/.test(a)), "timed-out runs must not advertise resume");
});

test("ux.4: review-required without an applyable diff plan does not recommend workflow_apply", () => {
  const compact = __test.compactStatusForEntry(ux4Entry("review-required", {
    integrationPlan: {
      integrationResult: {
        status: "review-required",
        reason: "conflict",
      },
    },
  }));
  assert.ok(compact.nextActions.some((a) => /review-required diagnostics/.test(a)));
  assert.ok(!compact.nextActions.some((a) => /workflow_apply runId=/.test(a)), "review-required without diff plan must not advertise workflow_apply");
});

test("ux.4: awaiting-diff-approval with an applyable diff plan recommends workflow_apply", () => {
  const compact = __test.compactStatusForEntry(ux4Entry("awaiting-diff-approval", ux4ApplyableDiffPlan()));
  assert.ok(compact.nextActions.some((a) => /workflow_apply runId=/.test(a)), "applyable awaiting-diff-approval must advertise workflow_apply");
});

test("ux.4: failed retryable lanes recommend resume while terminal schema lanes require fix-inspect first", () => {
  const retryable = __test.compactStatusForEntry(ux4Entry("failed", {
    laneRecords: [{
      callId: "lane:retryable",
      outcome: "failure",
      failureClass: "transient_exhausted",
      retryable: true,
      errorSummary: "provider overloaded after retries",
    }],
  }));
  assert.ok(retryable.nextActions.some((a) => /workflow_run resumeRunId=/.test(a)), "retryable failure must advertise resume");

  const terminal = __test.compactStatusForEntry(ux4Entry("failed", {
    laneRecords: [{
      callId: "lane:schema",
      outcome: "failure",
      failureClass: "terminal",
      retryable: false,
      errorSummary: "structured output schema validation failed",
    }],
  }));
  assert.ok(terminal.nextActions.some((a) => /structured-output\/schema/.test(a)), "terminal schema failure must name fix-inspect path");
  assert.ok(!terminal.nextActions.some((a) => /workflow_run resumeRunId=/.test(a)), "terminal schema failure must not advertise resume");
});

test("ux.4: partial and corrupt run entries still receive bounded recovery nextActions", () => {
  const partial = __test.compactStatusForEntry({ id: "p", root: "/runs", dir: "/runs/p", status: "partial", kind: "partial", error: "Missing state.json" });
  assert.ok(partial.nextActions.some((a) => /workflow_cleanup dryRun=true/.test(a)), "partial must suggest cleanup review");
  assert.ok(partial.nextActions.length <= 5);
  const corrupt = __test.compactStatusForEntry({ id: "c", root: "/runs", dir: "/runs/c", status: "corrupt", kind: "corrupt", error: "bad json" });
  assert.ok(corrupt.nextActions.some((a) => /workflow_cleanup dryRun=true/.test(a)), "corrupt must suggest cleanup review");
  assert.ok(corrupt.nextActions.length <= 5);
});

test("ux.4: stale/interrupted runs with salvage candidates recommend recovery then salvage", () => {
  const stale = __test.compactStatusForEntry(ux4Entry("stale-active", {}, { salvageCandidates: [{ callId: "lane:orphan", hint: "running lane with transcript" }] }));
  assert.ok(stale.nextActions.some((a) => /workflow_reconcile runId=/.test(a)), "stale must recommend reconcile");
  assert.ok(stale.nextActions.some((a) => /workflow_salvage runId=/.test(a)), "stale+salvage must recommend salvage");

  const interrupted = __test.compactStatusForEntry(ux4Entry("interrupted", {}, { salvageCandidates: [{ callId: "lane:orphan", hint: "running lane with transcript" }] }));
  assert.ok(interrupted.nextActions.some((a) => /workflow_run resumeRunId=/.test(a)), "interrupted must recommend resume");
  assert.ok(interrupted.nextActions.some((a) => /workflow_salvage runId=/.test(a)), "interrupted+salvage must recommend salvage");
});

test("ux.4: nextActions never echo prompts, tool output, lane results, meta, or secrets", () => {
  const hostile = {
    meta: { name: "ux4", apiKey: "UX4-SECRET-APIKEY", prompt: "UX4-RAW-PROMPT" },
    error: "UX4-RAW-ERROR-DETAIL",
    transcript: "UX4-RAW-TRANSCRIPT",
    rawToolOutput: "UX4-RAW-TOOL-OUTPUT",
    laneResults: [{ output: "UX4-RAW-LANE-RESULT" }],
    resultPath: "/runs/ux4/result.json",
  };
  const leaks = ["UX4-SECRET-APIKEY", "UX4-RAW-PROMPT", "UX4-RAW-ERROR-DETAIL", "UX4-RAW-TRANSCRIPT", "UX4-RAW-TOOL-OUTPUT", "UX4-RAW-LANE-RESULT"];
  for (const status of ["completed", "failed", "awaiting-diff-approval", "apply-failed", "cancelled", "running"]) {
    const compact = __test.compactStatusForEntry(ux4Entry(status, hostile));
    const json = JSON.stringify(compact.nextActions);
    for (const leak of leaks) {
      assert.ok(!json.includes(leak), `${status} nextActions leaked ${leak}`);
    }
  }
});

test("ux.4: summarizeEntries text view appends bounded next: lines without leaking evidence", () => {
  const entries = [
    ux4Entry("running", { meta: { name: "live", apiKey: "SUMMARY-SECRET" }, transcript: "SUMMARY-RAW-TRANSCRIPT", laneOutcomes: { success: 1 } }),
    ux4Entry("completed", { resultPath: "/runs/ux4/result.json", laneOutcomes: { success: 2 } }),
    { id: "broken", root: "/runs", dir: "/runs/broken", status: "corrupt", kind: "corrupt", error: "bad json" },
  ];
  const text = __test.summarizeEntries(entries);
  assert.match(text, /next: workflow_status runId=.* detail=full/);
  assert.match(text, /next: workflow_pause runId=/);
  assert.match(text, /next: workflow_cleanup dryRun=true/);
  assert.ok(!text.includes("SUMMARY-SECRET"), "summary leaked a secret meta value");
  assert.ok(!text.includes("SUMMARY-RAW-TRANSCRIPT"), "summary leaked raw transcript");
  // Each entry contributes at most MAX_NEXT_ACTIONS (5) next: lines.
  assert.ok(text.split("\n").filter((l) => l.startsWith("  next: ")).length <= 15);
});

test("ux.4: workflow_status detail=full surfaces nextActions for a completed run via the live tool", async () => {
  const { tools, context, directory } = await makeHarness(async () => ({ data: { parts: [{ type: "text", text: "ok" }], info: {} } }));
  try {
    const source = `export const meta = { name: "ux4-full" };
return await agent("Inspect alpha", { label: "Alpha", agent: "build" });`;
    const output = await runApproved(tools, context, source);
    const runId = runIdFrom(output);
    const full = JSON.parse(await tools.workflow_status.execute({ runId, format: "json", detail: "full" }, context));
    assert.ok(Array.isArray(full.nextActions) && full.nextActions.length >= 1, "full view must carry nextActions");
    assert.ok(full.nextActions.some((a) => /detail=full/.test(a)), "completed full view should recommend detail=full review");
    const summary = await tools.workflow_status.execute({ runId, format: "summary" }, context);
    assert.match(summary, /next: /);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("workflow notification timeout clears sending state and remains recoverable in status", async () => {
  const { tools, context, directory } = await makeHarness(async () => ({ data: { parts: [], info: {} } }));
  try {
    const runId = "33333333-3333-4333-8333-333333333333";
    const root = __test.runRoot(context);
    const dir = __test.runDirForRoot(root, runId);
    const notificationPath = path.join(dir, "notification.json");
    await fs.mkdir(dir, { recursive: true });
    await __test.writeJsonAtomic(path.join(dir, "state.json"), { id: runId, status: "completed", notification: { notificationPath } });
    await __test.writeJsonAtomic(notificationPath, {
      stateVersion: 1,
      runId,
      status: "completed",
      sessionID: "parent-session",
      directory,
      agent: "build",
      notificationPath,
      sentAt: null,
      delivery: { attempts: 0, lastAttemptAt: null, sendingAt: null, lastError: null },
    });
    __test.pendingNotificationPaths.add(notificationPath);

    const result = await __test.deliverWorkflowNotifications({ __workflowNotificationTimeoutMs: 1, client: { session: { promptAsync: async () => await new Promise(() => {}) } } }, { type: "session.idle", properties: { sessionID: "parent-session" } });
    const record = JSON.parse(await fs.readFile(notificationPath, "utf8"));
    const status = JSON.parse(await tools.workflow_status.execute({ runId, format: "json", detail: "full" }, context));

    assert.equal(result.failed, 1);
    assert.equal(record.delivery.sendingAt, null);
    assert.match(record.delivery.lastError, /timed out/);
    assert.match(status.notification.delivery.lastError, /timed out/);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("completion notification redacts secrets from run error before persistence and prompt text", async () => {
  const directory = await tempDir();
  try {
    const runDir = path.join(directory, ".opencode", "workflows", "runs", "secret-notification-run");
    await fs.mkdir(runDir, { recursive: true });
    const secret = "sk-proj_secret_error_value_1234567890";
    const run = {
      id: "secret-notification-run",
      dir: runDir,
      background: true,
      status: "failed",
      error: `upstream rejected Authorization: Bearer ${secret}`,
      meta: { name: "notify-secret" },
      notificationTarget: {
        sessionID: "session-secret",
        directory,
        agent: "build",
      },
    };

    const notification = await __test.writeCompletionNotification(run);
    assert.match(notification.errorSummary, /\[REDACTED:secret\]/);
    assert.doesNotMatch(notification.errorSummary, new RegExp(secret));
    assert.doesNotMatch(__test.workflowNotificationPrompt(notification), new RegExp(secret));
    const persisted = JSON.parse(await fs.readFile(path.join(runDir, "notification.json"), "utf8"));
    assert.doesNotMatch(persisted.errorSummary, new RegExp(secret));
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("workflow notification stale sending state is retried", async () => {
  const directory = await tempDir();
  const notificationPath = path.join(directory, "notification.json");
  try {
    await __test.writeJsonAtomic(notificationPath, {
      stateVersion: 1,
      runId: "stale-notification-run",
      status: "completed",
      sessionID: "parent-session",
      directory,
      agent: "build",
      notificationPath,
      sentAt: null,
      delivery: { attempts: 1, lastAttemptAt: "2026-06-16T00:00:00.000Z", sendingAt: "2026-06-16T00:00:00.000Z", lastError: null },
    });
    __test.pendingNotificationPaths.add(notificationPath);

    const result = await __test.deliverWorkflowNotifications({ client: { session: { promptAsync: async () => ({ data: { id: "async-1" } }) } } }, { type: "session.idle", properties: { sessionID: "parent-session" } });
    const record = JSON.parse(await fs.readFile(notificationPath, "utf8"));

    assert.equal(result.delivered, 1);
    assert.equal(record.delivery.attempts, 2);
    assert.equal(record.delivery.sendingAt, null);
    assert.equal(record.delivery.lastError, null);
    assert.equal(typeof record.delivery.staleAt, "string");
    assert.ok(record.sentAt);
  } finally {
    __test.pendingNotificationPaths.delete(notificationPath);
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("notification sending staleness covers boundary and invalid timestamps", () => {
  const nowMs = Date.parse("2026-06-16T00:01:00.000Z");

  assert.equal(__test.notificationSendingIsStale({ delivery: { sendingAt: null } }, nowMs), false);
  assert.equal(__test.notificationSendingIsStale({ delivery: { sendingAt: "not-a-date" } }, nowMs), false);
  assert.equal(
    __test.notificationSendingIsStale({ delivery: { sendingAt: "2026-06-16T00:00:00.001Z" } }, nowMs),
    false,
  );
  assert.equal(
    __test.notificationSendingIsStale({ delivery: { sendingAt: "2026-06-16T00:00:00.000Z" } }, nowMs),
    true,
  );
});

test("workflow notification with not-yet-stale sending state is skipped", async () => {
  const directory = await tempDir();
  const notificationPath = path.join(directory, "notification.json");
  const sendingAt = new Date().toISOString();
  let promptCalls = 0;
  try {
    await __test.writeJsonAtomic(notificationPath, {
      stateVersion: 1,
      runId: "fresh-sending-notification-run",
      status: "completed",
      sessionID: "parent-session",
      directory,
      agent: "build",
      notificationPath,
      sentAt: null,
      delivery: { attempts: 1, lastAttemptAt: sendingAt, sendingAt, lastError: null },
    });
    __test.pendingNotificationPaths.add(notificationPath);

    const result = await __test.deliverWorkflowNotifications({ client: { session: { promptAsync: async () => { promptCalls += 1; return { data: { id: "unexpected" } }; } } } }, { type: "session.idle", properties: { sessionID: "parent-session" } });
    const record = JSON.parse(await fs.readFile(notificationPath, "utf8"));

    assert.equal(result.delivered, 0);
    assert.equal(result.failed, 0);
    assert.equal(result.skipped, 1);
    assert.equal(promptCalls, 0);
    assert.equal(record.sentAt, null);
    assert.equal(record.delivery.attempts, 1);
    assert.equal(record.delivery.sendingAt, sendingAt);
    assert.equal(record.delivery.lastError, null);
  } finally {
    __test.pendingNotificationPaths.delete(notificationPath);
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("concurrent notification delivery sends the completion prompt exactly once", async () => {
  const directory = await tempDir();
  const notificationPath = path.join(directory, "notification.json");
  const savedDelivering = new Set(__test.deliveringNotificationPaths);
  __test.deliveringNotificationPaths.clear();
  try {
    await __test.writeJsonAtomic(notificationPath, {
      stateVersion: 1,
      runId: "concurrent-notification-run",
      status: "completed",
      sessionID: "parent-session",
      directory,
      agent: "build",
      notificationPath,
      sentAt: null,
      delivery: { attempts: 0, lastAttemptAt: null, sendingAt: null, lastError: null },
    });
    __test.pendingNotificationPaths.add(notificationPath);

    // Count promptAsync invocations. The mock yields to the microtask queue before
    // resolving so a second concurrent caller can interleave at the record-read step
    // exactly as the background maybeDeliver + session.idle handler race would.
    let promptCalls = 0;
    const pluginContext = {
      client: {
        session: {
          promptAsync: async () => {
            promptCalls += 1;
            await Promise.resolve();
            return { data: { id: "async-concurrent-1" } };
          },
        },
      },
    };
    const idleEvent = { type: "session.idle", properties: { sessionID: "parent-session" } };

    // Two concurrent callers both observe sendingAt=null in the persisted record; the
    // synchronous in-process mutex must ensure only one actually delivers.
    const [first, second] = await Promise.all([
      __test.deliverWorkflowNotifications(pluginContext, idleEvent),
      __test.deliverWorkflowNotifications(pluginContext, idleEvent),
    ]);

    assert.equal(promptCalls, 1, "completion prompt is sent exactly once across concurrent callers");
    assert.equal(first.delivered + second.delivered, 1, "exactly one caller records the delivery");
    assert.equal(first.skipped + second.skipped, 1, "the losing caller skips the in-flight record");

    const record = JSON.parse(await fs.readFile(notificationPath, "utf8"));
    assert.equal(typeof record.sentAt, "string");
    assert.equal(record.delivery.attempts, 1, "the record is only attempted once");
    assert.equal(record.delivery.sendingAt, null);
    assert.equal(__test.deliveringNotificationPaths.size, 0, "the in-process mutex is released");
  } finally {
    __test.pendingNotificationPaths.delete(notificationPath);
    __test.deliveringNotificationPaths.clear();
    for (const entry of savedDelivering) __test.deliveringNotificationPaths.add(entry);
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("updateNotificationIdleState clears the idle flag on any non-status activity event", () => {
  const sessionID = "idle-clear-session";
  const savedIdle = new Set(__test.idleNotificationSessions);
  __test.idleNotificationSessions.clear();
  try {
    // An idle event flags the session as idle.
    __test.updateNotificationIdleState({ type: "session.idle", properties: { sessionID } });
    assert.equal(__test.idleNotificationSessions.has(sessionID), true, "idle event flags the session");

    // A non-status activity event carrying the sessionID must clear the idle flag.
    // Regression for R24: previously only a session.status event cleared it, so a
    // session whose idle->active transition arrived via another event type stayed
    // falsely flagged and a later completion delivered a continuation prompt into a
    // possibly-busy session.
    __test.updateNotificationIdleState({ type: "message.updated", properties: { sessionID } });
    assert.equal(__test.idleNotificationSessions.has(sessionID), false, "non-status activity clears the idle flag");

    // A different active event shape (sessionID nested under message.info) also clears.
    __test.updateNotificationIdleState({ type: "session.idle", properties: { sessionID } });
    assert.equal(__test.idleNotificationSessions.has(sessionID), true);
    __test.updateNotificationIdleState({ type: "message.part.updated", properties: { message: { info: { sessionID } } } });
    assert.equal(__test.idleNotificationSessions.has(sessionID), false, "nested-sessionID activity clears the idle flag");

    // A non-idle session.status event still clears (no regression on the original path).
    __test.updateNotificationIdleState({ type: "session.idle", properties: { sessionID } });
    assert.equal(__test.idleNotificationSessions.has(sessionID), true);
    __test.updateNotificationIdleState({ type: "session.status", properties: { sessionID, status: "active" } });
    assert.equal(__test.idleNotificationSessions.has(sessionID), false, "non-idle session.status still clears");

    // An event without a resolvable sessionID is a no-op (no spurious deletes/adds).
    __test.updateNotificationIdleState({ type: "session.idle", properties: { sessionID } });
    assert.equal(__test.idleNotificationSessions.has(sessionID), true);
    __test.updateNotificationIdleState({ type: "message.updated", properties: {} });
    assert.equal(__test.idleNotificationSessions.has(sessionID), true, "event without a sessionID leaves other sessions flagged");
  } finally {
    __test.idleNotificationSessions.clear();
    for (const entry of savedIdle) __test.idleNotificationSessions.add(entry);
  }
});

test("notification runtime tracking is bounded and cleared on plugin dispose", async () => {
  const savedPending = new Set(__test.pendingNotificationPaths);
  const savedDelivering = new Set(__test.deliveringNotificationPaths);
  const savedIdle = new Set(__test.idleNotificationSessions);
  __test.pendingNotificationPaths.clear();
  __test.deliveringNotificationPaths.clear();
  __test.idleNotificationSessions.clear();
  try {
    for (let i = 0; i < __test.NOTIFICATION_TRACKING_MAX + 5; i += 1) {
      __test.pendingNotificationPaths.add(`/tmp/notification-${i}.json`);
      __test.idleNotificationSessions.add(`session-${i}`);
    }
    __test.deliveringNotificationPaths.add("/tmp/in-flight-notification.json");

    assert.equal(__test.pendingNotificationPaths.size, __test.NOTIFICATION_TRACKING_MAX);
    assert.equal(__test.pendingNotificationPaths.has("/tmp/notification-0.json"), false);
    assert.equal(__test.idleNotificationSessions.size, __test.NOTIFICATION_TRACKING_MAX);
    assert.equal(__test.idleNotificationSessions.has("session-0"), false);

    const hooks = await workflowPlugin({ client: {} }, { extensions: [] });
    assert.equal(typeof hooks.dispose, "function");
    await hooks.dispose();
    assert.equal(__test.pendingNotificationPaths.size, 0);
    assert.equal(__test.deliveringNotificationPaths.size, 0);
    assert.equal(__test.idleNotificationSessions.size, 0);
  } finally {
    __test.pendingNotificationPaths.clear();
    __test.deliveringNotificationPaths.clear();
    __test.idleNotificationSessions.clear();
    for (const entry of savedPending) __test.pendingNotificationPaths.add(entry);
    for (const entry of savedDelivering) __test.deliveringNotificationPaths.add(entry);
    for (const entry of savedIdle) __test.idleNotificationSessions.add(entry);
  }
});

test("workflow notifications rehydrate from persisted run roots after simulated plugin restart", async () => {
  const project = await tempDir();
  // Simulate a fresh plugin/module instance: the in-memory pending queue starts empty
  // even though unsent notification.json records remain on disk. Snapshot+restore so
  // the shared singleton does not leak state into other tests in this process.
  const savedPending = new Set(__test.pendingNotificationPaths);
  __test.pendingNotificationPaths.clear();
  try {
    const root = __test.runRoot({ directory: project, worktree: project });

    const unsentDir = __test.runDirForRoot(root, "11111111-1111-4111-8111-111111111111");
    const unsentPath = path.join(unsentDir, "notification.json");
    await fs.mkdir(unsentDir, { recursive: true });
    await __test.writeJsonAtomic(unsentPath, {
      stateVersion: 1,
      runId: "11111111-1111-4111-8111-111111111111",
      status: "completed",
      sessionID: "parent-session",
      directory: project,
      agent: "build",
      notificationPath: unsentPath,
      sentAt: null,
      delivery: { attempts: 0, lastAttemptAt: null, sendingAt: null, lastError: null },
    });

    // Already-sent record: must remain idempotently skipped after rehydration.
    const sentDir = __test.runDirForRoot(root, "22222222-2222-4222-8222-222222222222");
    const sentPath = path.join(sentDir, "notification.json");
    await fs.mkdir(sentDir, { recursive: true });
    await __test.writeJsonAtomic(sentPath, {
      stateVersion: 1,
      runId: "22222222-2222-4222-8222-222222222222",
      status: "completed",
      sessionID: "parent-session",
      directory: project,
      agent: "build",
      notificationPath: sentPath,
      sentAt: "2026-06-16T00:00:00.000Z",
      delivery: { attempts: 1, lastAttemptAt: "2026-06-16T00:00:00.000Z", sendingAt: null, lastError: null },
    });

    // Malformed JSON: skipped safely rather than poisoning the delivery queue.
    const malformedDir = __test.runDirForRoot(root, "33333333-3333-4333-8333-333333333333");
    await fs.mkdir(malformedDir, { recursive: true });
    await fs.writeFile(path.join(malformedDir, "notification.json"), "{ not valid json", "utf8");

    // Unrelated session: skipped because delivery is scoped to the idle session.
    const unrelatedDir = __test.runDirForRoot(root, "44444444-4444-4444-8444-444444444444");
    const unrelatedPath = path.join(unrelatedDir, "notification.json");
    await fs.mkdir(unrelatedDir, { recursive: true });
    await __test.writeJsonAtomic(unrelatedPath, {
      stateVersion: 1,
      runId: "44444444-4444-4444-8444-444444444444",
      status: "completed",
      sessionID: "some-other-session",
      directory: project,
      agent: "build",
      notificationPath: unrelatedPath,
      sentAt: null,
      delivery: { attempts: 0, lastAttemptAt: null, sendingAt: null, lastError: null },
    });

    assert.equal(__test.pendingNotificationPaths.size, 0, "simulated restart leaves in-memory queue empty");

    const pluginContext = {
      directory: project,
      worktree: project,
      client: { session: { promptAsync: async () => ({ data: { id: "async-rehydrate-1" } }) } },
    };
    const idleEvent = { type: "session.idle", properties: { sessionID: "parent-session" } };

    const rehydrateResult = await __test.rehydratePendingNotifications(pluginContext, idleEvent);
    assert.equal(rehydrateResult.rehydrated, 1, "only the unsent matching record is rehydrated");
    assert.equal(rehydrateResult.skipped, 3, "sent + malformed + unrelated records are skipped");
    assert.deepEqual([...__test.pendingNotificationPaths], [unsentPath]);

    const deliverResult = await __test.deliverWorkflowNotifications(pluginContext, idleEvent);
    assert.equal(deliverResult.delivered, 1);
    const delivered = JSON.parse(await fs.readFile(unsentPath, "utf8"));
    assert.equal(typeof delivered.sentAt, "string");
    assert.equal(delivered.delivery.attempts, 1);
    const stillSent = JSON.parse(await fs.readFile(sentPath, "utf8"));
    assert.equal(stillSent.sentAt, "2026-06-16T00:00:00.000Z");
    assert.equal(stillSent.delivery.attempts, 1, "already-sent record is untouched");
    assert.equal(__test.pendingNotificationPaths.size, 0, "queue drains after successful delivery");

    // Idempotent re-delivery: a subsequent idle event must not resend the now-sent record.
    const secondDeliver = await __test.deliverWorkflowNotifications(pluginContext, idleEvent);
    assert.equal(secondDeliver.delivered, 0);
    const secondRehydrate = await __test.rehydratePendingNotifications(pluginContext, idleEvent);
    assert.equal(secondRehydrate.rehydrated, 0);
  } finally {
    __test.pendingNotificationPaths.clear();
    for (const entry of savedPending) __test.pendingNotificationPaths.add(entry);
    await fs.rm(project, { recursive: true, force: true });
  }
});

test("workflow run lookup and cleanup protect symlinked run directories", async () => {
  const escapeRoot = await tempDir();
  const { tools, context, directory } = await makeHarness(async () => ({ data: { parts: [], info: {} } }));
  try {
    const runId = "symlink-run";
    const root = __test.runRoot(context);
    const linkPath = __test.runDirForRoot(root, runId);
    await fs.mkdir(root, { recursive: true });
    await fs.writeFile(path.join(escapeRoot, "state.json"), JSON.stringify({ id: runId, status: "completed" }), "utf8");
    await fs.symlink(escapeRoot, linkPath, "dir");

    const status = JSON.parse(await tools.workflow_status.execute({ runId, format: "json" }, context));
    assert.equal(status.status, "corrupt");
    assert.match(status.errorSummary, /Workflow run directory escapes expected root|Workflow run directory is a symlink/);

    const cleanup = JSON.parse(await tools.workflow_cleanup.execute({ dryRun: false, keep: 0 }, context));
    assert.equal(await fileExists(path.join(escapeRoot, "state.json")), true);
    assert.equal(cleanup.deleteDirs.includes(linkPath), false);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
    await fs.rm(escapeRoot, { recursive: true, force: true });
  }
});

test("workflow_cleanup reports protected reasons and deletes only safe terminal runs", async () => {
  const { tools, context, directory } = await makeHarness(async () => ({ data: { parts: [], info: {} } }));
  try {
    const root = __test.runRoot(context);
    await fs.mkdir(root, { recursive: true });
    async function writeRun(id, state) {
      const dir = __test.runDirForRoot(root, id);
      await fs.mkdir(dir, { recursive: true });
      await __test.writeJsonAtomic(path.join(dir, "state.json"), { id, startedAt: "2026-06-16T00:00:00.000Z", ...state });
      return dir;
    }
    const safeDir = await writeRun("cleanup-safe", { status: "completed" });
    await writeRun("cleanup-apply-failed", { status: "apply-failed" });
    await writeRun("cleanup-failed", { status: "failed" });
    await writeRun("cleanup-budget-stopped", { status: "budget_stopped" });
    await writeRun("cleanup-review", { status: "review-required" });
    // Recent last-progress so the dead-process interrupted run is within the interrupted-run
    // TTL and stays protected; the TTL-expiry path has its own coverage in
    // tests/crash-resource-reclamation.test.mjs.
    await writeRun("cleanup-running", { status: "running", process: { pid: 999999999, startTime: 1 }, lastProgressAt: new Date(Date.now() - 60_000).toISOString() });
    await writeRun("cleanup-pinned", { status: "completed", pinned: true });
    // apply-running owned by a live process resolves to active-unknown and is protected
    // via the active-status branch (distinct from the dead-process interrupted path).
    await writeRun("cleanup-apply-running", { status: "apply-running", process: { pid: process.pid } });
    const corruptDir = __test.runDirForRoot(root, "cleanup-corrupt");
    await fs.mkdir(corruptDir, { recursive: true });
    await fs.writeFile(path.join(corruptDir, "state.json"), "{not json", "utf8");
    const malformedDir = path.join(root, "!bad-run-id");
    await fs.mkdir(malformedDir, { recursive: true });
    await __test.writeJsonAtomic(path.join(malformedDir, "state.json"), { id: "!bad-run-id", status: "completed" });

    const dryRun = JSON.parse(await tools.workflow_cleanup.execute({ dryRun: true, keep: 0 }, context));
    const reasons = Object.fromEntries(dryRun.protectedRuns.map((entry) => [entry.id, entry.reason]));
    assert.equal(reasons["cleanup-apply-failed"], "retryable-apply-failed");
    assert.equal(reasons["cleanup-failed"], "resumable-run");
    assert.equal(reasons["cleanup-budget-stopped"], "resumable-run");
    assert.equal(reasons["cleanup-review"], "ambiguous-edit-status");
    assert.equal(reasons["cleanup-running"], "interrupted-recovery");
    assert.equal(reasons["cleanup-pinned"], "pinned");
    assert.equal(reasons["cleanup-apply-running"], "active-status");
    assert.equal(reasons["cleanup-corrupt"], "corrupt-or-partial");
    assert.equal(reasons["!bad-run-id"], "corrupt-or-partial");
    assert.equal(dryRun.deleteDirs.includes(safeDir), true);

    const cleanup = JSON.parse(await tools.workflow_cleanup.execute({ dryRun: false, keep: 0 }, context));
    assert.equal(cleanup.deleteDirs.includes(safeDir), true);
    assert.equal(await fileExists(safeDir), false);
    assert.equal(await fileExists(corruptDir), true);
    assert.equal(await fileExists(malformedDir), true);
    assert.equal(await fileExists(__test.runDirForRoot(root, "cleanup-apply-failed")), true);
    assert.equal(await fileExists(__test.runDirForRoot(root, "cleanup-failed")), true);
    assert.equal(await fileExists(__test.runDirForRoot(root, "cleanup-budget-stopped")), true);
    assert.equal(await fileExists(__test.runDirForRoot(root, "cleanup-review")), true);
    assert.equal(await fileExists(__test.runDirForRoot(root, "cleanup-running")), true);
    assert.equal(await fileExists(__test.runDirForRoot(root, "cleanup-pinned")), true);
    assert.equal(await fileExists(__test.runDirForRoot(root, "cleanup-apply-running")), true);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("workflow_cleanup protects paused runs from deletion (resumable)", async () => {
  const { tools, context, directory } = await makeHarness(async () => ({ data: { parts: [], info: {} } }));
  try {
    const root = __test.runRoot(context);
    const pausedDir = __test.runDirForRoot(root, "cleanup-paused");
    await fs.mkdir(pausedDir, { recursive: true });
    // A paused run releases its run.lock and leaves the in-memory map, so it has no live
    // lock and is not active-in-process; only the explicit paused guard keeps it.
    await __test.writeJsonAtomic(path.join(pausedDir, "state.json"), { id: "cleanup-paused", status: "paused", startedAt: "2026-06-16T00:00:00.000Z" });

    const dryRun = JSON.parse(await tools.workflow_cleanup.execute({ dryRun: true, keep: 0 }, context));
    const reasons = Object.fromEntries(dryRun.protectedRuns.map((entry) => [entry.id, entry.reason]));
    assert.equal(reasons["cleanup-paused"], "paused-resumable");
    assert.equal(dryRun.deleteDirs.includes(pausedDir), false);

    const cleanup = JSON.parse(await tools.workflow_cleanup.execute({ dryRun: false, keep: 0 }, context));
    assert.equal(cleanup.deleteDirs.includes(pausedDir), false);
    assert.equal(await fileExists(path.join(pausedDir, "state.json")), true);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("workflow_reconcile reclaims the stranded worktree and branch of a crashed run", async () => {
  const repoDir = await makeTempDir("reconcile-worktree-repo-");
  await initGitRepo(repoDir);
  const adapter = await createWorktreeAdapter({ directory: repoDir });
  const wt = await adapter.createLaneWorktree({ runId: "kill-run", laneId: "lane1", role: "lane", baseRef: "HEAD" });
  const wtPath = wt.path ?? wt.targetPath;
  const branch = wt.branch;
  assert.equal(await fileExists(wtPath), true, "lane worktree exists before the crash");
  const { tools, context, directory } = await makeHarness({ directory: repoDir });
  try {
    const root = __test.runRoot(context);
    const runDir = __test.runDirForRoot(root, "kill-run");
    await fs.mkdir(runDir, { recursive: true });
    // A run that was active (running) with a now-dead process — simulates SIGKILL mid-run.
    await __test.writeJsonAtomic(path.join(runDir, "state.json"), {
      id: "kill-run",
      status: "running",
      process: { pid: 999999999, startTime: 1 },
      startedAt: "2026-06-26T00:00:00.000Z",
      editWorktrees: [{ role: "lane", callId: "lane:1", laneId: "lane1", path: wtPath, branch }],
    });

    await tools.workflow_reconcile.execute({}, context);

    const persisted = JSON.parse(await fs.readFile(path.join(runDir, "state.json"), "utf8"));
    assert.equal(persisted.status, "interrupted", "dead run is reconciled to interrupted");
    assert.equal(await fileExists(wtPath), false, "stranded worktree directory is removed");
    const branches = (await execFileAsync("git", ["branch", "--list", branch], { cwd: repoDir })).stdout.trim();
    assert.equal(branches, "", "stranded lane branch is deleted");
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
    await fs.rm(repoDir, { recursive: true, force: true });
    await fs.rm(adapter.worktreeRoot, { recursive: true, force: true });
  }
});

test("workflow_reconcile preserves a dirty stranded worktree (conservative)", async () => {
  const repoDir = await makeTempDir("reconcile-worktree-dirty-");
  await initGitRepo(repoDir);
  const adapter = await createWorktreeAdapter({ directory: repoDir });
  const wt = await adapter.createLaneWorktree({ runId: "kill-dirty", laneId: "lane1", role: "lane", baseRef: "HEAD" });
  const wtPath = wt.path ?? wt.targetPath;
  // Uncommitted work in the worktree must NOT be destroyed by reclamation.
  await fs.writeFile(path.join(wtPath, "uncommitted.txt"), "in-flight lane work\n", "utf8");
  const { tools, context, directory } = await makeHarness({ directory: repoDir });
  try {
    const root = __test.runRoot(context);
    const runDir = __test.runDirForRoot(root, "kill-dirty");
    await fs.mkdir(runDir, { recursive: true });
    await __test.writeJsonAtomic(path.join(runDir, "state.json"), {
      id: "kill-dirty",
      status: "running",
      process: { pid: 999999999, startTime: 1 },
      startedAt: "2026-06-26T00:00:00.000Z",
      editWorktrees: [{ role: "lane", callId: "lane:1", laneId: "lane1", path: wtPath, branch: wt.branch }],
    });

    await tools.workflow_reconcile.execute({}, context);

    assert.equal(await fileExists(wtPath), true, "dirty worktree is preserved, not reclaimed");
    assert.equal(await fileExists(path.join(wtPath, "uncommitted.txt")), true, "in-flight lane work survives");
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
    await fs.rm(repoDir, { recursive: true, force: true });
    await fs.rm(adapter.worktreeRoot, { recursive: true, force: true });
  }
});

test("workflow_cleanup reaps an interrupted run past the TTL but protects a fresh one", async () => {
  const { tools, context, directory } = await makeHarness(async () => ({ data: { parts: [], info: {} } }));
  try {
    const root = __test.runRoot(context);
    await fs.mkdir(root, { recursive: true });
    async function writeInterrupted(id, lastProgressAt) {
      const dir = __test.runDirForRoot(root, id);
      await fs.mkdir(dir, { recursive: true });
      // status:running + a dead pid → reconcile (run during cleanup) flips it to interrupted.
      await __test.writeJsonAtomic(path.join(dir, "state.json"), {
        id,
        status: "running",
        process: { pid: 999999999, startTime: 1 },
        startedAt: "2026-06-01T00:00:00.000Z",
        lastProgressAt,
      });
      return dir;
    }
    const staleDir = await writeInterrupted("ttl-stale", new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString());
    const freshDir = await writeInterrupted("ttl-fresh", new Date(Date.now() - 60_000).toISOString());

    const dryRun = JSON.parse(await tools.workflow_cleanup.execute({ dryRun: true, keep: 0 }, context));
    const reasons = Object.fromEntries(dryRun.protectedRuns.map((entry) => [entry.id, entry.reason]));
    // Fresh interrupted run keeps its salvage protection; stale one falls out of protectedRuns.
    assert.equal(reasons["ttl-fresh"], "interrupted-recovery");
    assert.equal(reasons["ttl-stale"], undefined);
    assert.equal(dryRun.deleteDirs.includes(staleDir), true);
    assert.equal(dryRun.deleteDirs.includes(freshDir), false);

    const cleanup = JSON.parse(await tools.workflow_cleanup.execute({ dryRun: false, keep: 0 }, context));
    assert.equal(cleanup.deleteDirs.includes(staleDir), true);
    assert.equal(await fileExists(staleDir), false, "stale interrupted run past TTL is reaped");
    assert.equal(await fileExists(freshDir), true, "fresh interrupted run within TTL survives");
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("workflow_cleanup interruptedTtlMs arg makes the TTL configurable", async () => {
  const { tools, context, directory } = await makeHarness(async () => ({ data: { parts: [], info: {} } }));
  try {
    const root = __test.runRoot(context);
    await fs.mkdir(root, { recursive: true });
    const dir = __test.runDirForRoot(root, "ttl-config");
    await fs.mkdir(dir, { recursive: true });
    await __test.writeJsonAtomic(path.join(dir, "state.json"), {
      id: "ttl-config",
      status: "running",
      process: { pid: 999999999, startTime: 1 },
      startedAt: "2026-06-01T00:00:00.000Z",
      // ~2h old: protected under the 7-day default, reapable under a 1h override.
      lastProgressAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
    });

    const def = JSON.parse(await tools.workflow_cleanup.execute({ dryRun: true, keep: 0 }, context));
    assert.equal(def.deleteDirs.includes(dir), false, "protected under the default TTL");

    const tight = JSON.parse(await tools.workflow_cleanup.execute({ dryRun: true, keep: 0, interruptedTtlMs: 60 * 60 * 1000 }, context));
    assert.equal(tight.deleteDirs.includes(dir), true, "reapable under a 1h TTL override");
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("workflow_cleanup skips a run that re-acquires its lock between enumeration and delete", async () => {
  const { tools, context, directory } = await makeHarness(async () => ({ data: { parts: [], info: {} } }));
  const originalRm = fs.rm;
  try {
    const root = __test.runRoot(context);
    // Two deletable runs. Cleanup processes them newest-first; the decoy is deleted first and
    // its fs.rm is the seam where we simulate a concurrent resume acquiring the target's lock
    // BEFORE cleanup's per-entry re-validation re-reads the target. Patching the shared
    // node:fs/promises namespace intercepts the plugin's own fs.rm (same module singleton).
    const decoyDir = __test.runDirForRoot(root, "cleanup-decoy");
    await fs.mkdir(decoyDir, { recursive: true });
    await __test.writeJsonAtomic(path.join(decoyDir, "state.json"), { id: "cleanup-decoy", status: "completed", startedAt: "2026-06-17T00:00:00.000Z" });
    const racedDir = __test.runDirForRoot(root, "cleanup-raced");
    await fs.mkdir(racedDir, { recursive: true });
    await __test.writeJsonAtomic(path.join(racedDir, "state.json"), { id: "cleanup-raced", status: "completed", startedAt: "2026-06-16T00:00:00.000Z" });

    let injected = false;
    fs.rm = async (target, ...rest) => {
      if (!injected && typeof target === "string" && target === decoyDir) {
        // Concurrent resume re-acquires the target's run.lock (as workflow_resume would).
        injected = true;
        await __test.writeJsonAtomic(path.join(racedDir, "run.lock"), { operation: "run", runId: "cleanup-raced", process: { pid: process.pid } });
      }
      return originalRm(target, ...rest);
    };

    const cleanup = JSON.parse(await tools.workflow_cleanup.execute({ dryRun: false, keep: 0 }, context));
    assert.equal(injected, true);
    // The decoy was unprotected and is gone; the raced run was skipped by re-validation.
    assert.equal(cleanup.deleteDirs.includes(decoyDir), true);
    assert.equal(await fileExists(decoyDir), false);
    assert.equal(cleanup.deleteDirs.includes(racedDir), false);
    const revalidated = Object.fromEntries((cleanup.protectedRevalidated ?? []).map((entry) => [entry.id, entry.reason]));
    assert.equal(revalidated["cleanup-raced"], "locked");
    // The raced run survived: its state.json and the freshly injected lock are still on disk.
    assert.equal(await fileExists(path.join(racedDir, "state.json")), true);
    assert.equal(await fileExists(path.join(racedDir, "run.lock")), true);
  } finally {
    fs.rm = originalRm;
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("workflow status exposes stale locks and reconcile clears them explicitly", async () => {
  const { tools, context, directory } = await makeHarness(async () => ({ data: { parts: [], info: {} } }));
  try {
    const runId = "stale-lock-run";
    const root = __test.runRoot(context);
    const dir = __test.runDirForRoot(root, runId);
    await fs.mkdir(dir, { recursive: true });
    await __test.writeJsonAtomic(path.join(dir, "state.json"), { id: runId, status: "completed", startedAt: "2026-06-16T00:00:00.000Z" });
    await __test.writeJsonAtomic(path.join(dir, "run.lock"), { operation: "run", runId, process: { pid: 999999999, startTime: 1 } });

    const status = JSON.parse(await tools.workflow_status.execute({ runId, format: "json", detail: "full" }, context));
    assert.equal(status.locks.run.stale, true);

    const cleanup = JSON.parse(await tools.workflow_cleanup.execute({ dryRun: false, keep: 0 }, context));
    assert.equal(await fileExists(path.join(dir, "state.json")), true);
    assert.equal(cleanup.protectedLocked[0].id, runId);

    await assert.rejects(
      tools.workflow_status.execute({ runId, format: "json", detail: "full", reconcile: true }, context),
      /workflow_reconcile/,
    );
    const reconciled = JSON.parse(await tools.workflow_reconcile.execute({ runId, format: "json", detail: "full" }, context));
    assert.deepEqual(reconciled.staleLocksCleared.map((lock) => lock.operation), ["run"]);
    assert.equal(await fileExists(path.join(dir, "run.lock")), false);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("workflow_run resume fails clearly when an active run lock exists", async () => {
  const { tools, context, directory } = await makeHarness(async () => ({ data: { parts: [], info: {} } }));
  try {
    const runId = "locked-resume-run";
    const source = `export const meta = { name: "locked-resume" };
return "resumed";`;
    const root = __test.runRoot(context);
    const dir = __test.runDirForRoot(root, runId);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "script.js"), source, "utf8");
    await __test.writeJsonAtomic(path.join(dir, "state.json"), { id: runId, status: "paused", sourceHash: __test.hash(source), sourcePath: "<inline>" });
    await __test.writeJsonAtomic(path.join(dir, "run.lock"), { operation: "run", runId, process: { pid: process.pid } });

    await assert.rejects(runApprovedRequest(tools, context, { resumeRunId: runId }), /Workflow run lock is already held \(active\)/);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("workflow_cancel and workflow_pause persist requests for runs owned by another process", async () => {
  const { tools, context, directory } = await makeHarness(async () => ({ data: { parts: [], info: {} } }));
  try {
    const runId = "remote-lifecycle-run";
    const root = __test.runRoot(context);
    const dir = __test.runDirForRoot(root, runId);
    await fs.mkdir(dir, { recursive: true });
    await __test.writeJsonAtomic(path.join(dir, "state.json"), { id: runId, status: "running", process: { pid: 999999999, startTime: 1 } });

    assert.match(await tools.workflow_cancel.execute({ runId }, context), /cancel-request\.json/);
    assert.match(await tools.workflow_pause.execute({ runId }, context), /pause-request\.json/);
    const status = JSON.parse(await tools.workflow_status.execute({ runId, format: "json", detail: "full" }, context));

    assert.equal(status.lifecycleRequests.cancel.type, "cancel");
    assert.equal(status.lifecycleRequests.pause.type, "pause");
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("workflow_cancel and workflow_pause reject corrupt or partial run entries", async () => {
  const { tools, context, directory } = await makeHarness(async () => ({ data: { parts: [], info: {} } }));
  try {
    const root = __test.runRoot(context);
    const partialRunId = "partial-lifecycle-run";
    await fs.mkdir(__test.runDirForRoot(root, partialRunId), { recursive: true });

    await assert.rejects(
      tools.workflow_cancel.execute({ runId: partialRunId }, context),
      /Cannot cancel invalid run partial/,
    );

    const corruptRunId = "corrupt-lifecycle-run";
    const corruptDir = __test.runDirForRoot(root, corruptRunId);
    await fs.mkdir(corruptDir, { recursive: true });
    await fs.writeFile(path.join(corruptDir, "state.json"), "{not-json", "utf8");

    await assert.rejects(
      tools.workflow_pause.execute({ runId: corruptRunId }, context),
      /Cannot pause invalid run corrupt/,
    );
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("workflow_cancel and workflow_pause interrupt in-memory runs", async () => {
  const abortCalls = [];
  const toastCalls = [];
  const { tools, context, directory } = await makeHarness(async () => ({ data: { parts: [], info: {} } }), {
    onAbort(input) {
      abortCalls.push(input);
    },
    tui: {
      async showToast(input) {
        toastCalls.push(input.body);
        return { data: true };
      },
    },
  });

  function makeInMemoryRun(runId, dir, overrides = {}) {
    return {
      id: runId,
      dir,
      status: "running",
      sourcePath: "inline",
      sourceHash: "source-hash",
      meta: { name: runId },
      authority: {},
      argsPreview: "{}",
      startedAt: "2026-06-24T00:00:00.000Z",
      currentPhase: "test",
      agentsStarted: 1,
      maxAgents: 1,
      concurrency: 1,
      defaultChildModel: HARNESS_DEFAULT_MODEL,
      activeAgents: 1,
      waitingAgents: [],
      tokens: { input: 0, output: 0, reasoning: 0 },
      replayedTokens: { input: 0, output: 0, reasoning: 0 },
      cost: 0,
      replayedCost: 0,
      cacheStats: { hits: 0, misses: 0, invalidated: 0 },
      budgetCeilings: {},
      laneOutcomes: { success: 0, failure: 0, cancelled: 0, timeout: 0, budget_stopped: 0 },
      droppedLaneCount: 0,
      capabilities: {},
      diagnostics: {},
      editWorktrees: [],
      integrationWorktrees: [],
      laneRecords: new Map(),
      nestedSnapshots: new Map(),
      children: new Map([[`${runId}-child`, directory]]),
      abortController: new AbortController(),
      background: false,
      eventCount: 0,
      journalRecords: 0,
      ...overrides,
    };
  }

  try {
    const root = __test.runRoot(context);

    const cancelRunId = "in-memory-cancel-run";
    const cancelDir = __test.runDirForRoot(root, cancelRunId);
    await fs.mkdir(cancelDir, { recursive: true });
    const cancelRejects = [];
    const cancelRun = makeInMemoryRun(cancelRunId, cancelDir, {
      waitingAgents: [{ reject(error) { cancelRejects.push(error); } }],
    });
    __test.runs.set(cancelRunId, cancelRun);

    assert.match(await tools.workflow_cancel.execute({ runId: cancelRunId }, context), /Cancellation requested/);
    assert.equal(cancelRun.abortController.signal.aborted, true);
    assert.equal(cancelRun.status, "cancelling");
    assert.equal(cancelRejects[0]?.code, "WORKFLOW_CANCELLED");
    assert.equal(JSON.parse(await fs.readFile(path.join(cancelDir, "state.json"), "utf8")).status, "cancelling");
    assert.ok(toastCalls.some((body) => body.variant === "warning" && /^⚠ in-memory-cancel-run cancelling/.test(body.title) && /inspect: workflow_status/.test(body.message)), "missing cancel terminal-style toast card");

    const pauseRunId = "in-memory-pause-run";
    const pauseDir = __test.runDirForRoot(root, pauseRunId);
    await fs.mkdir(pauseDir, { recursive: true });
    const pauseRejects = [];
    const pauseRun = makeInMemoryRun(pauseRunId, pauseDir, {
      waitingAgents: [{ reject(error) { pauseRejects.push(error); } }],
    });
    __test.runs.set(pauseRunId, pauseRun);

    // This in-memory run has no background execution promise (run.done), so the settle wait
    // returns immediately with run.status still transitional ("pausing") -- the alive-but-not-
    // settled window. The message must surface settle guidance (poll then resume), not the old
    // unconditional "resume now".
    const pauseMessage = await tools.workflow_pause.execute({ runId: pauseRunId }, context);
    assert.match(pauseMessage, /still settling \(status pausing\)/);
    assert.match(pauseMessage, /Poll workflow_status/);
    assert.match(pauseMessage, new RegExp(`resume with workflow_run\\(\\{ resumeRunId: "${pauseRunId}"`));
    assert.equal(pauseRun.abortController.signal.aborted, true);
    assert.equal(pauseRun.pauseRequested, true);
    assert.equal(pauseRun.status, "pausing");
    assert.equal(pauseRejects[0]?.code, "WORKFLOW_CANCELLED");
    assert.equal(JSON.parse(await fs.readFile(path.join(pauseDir, "state.json"), "utf8")).status, "pausing");
    assert.ok(toastCalls.some((body) => body.variant === "warning" && /^⚠ in-memory-pause-run pausing/.test(body.title) && /inspect: workflow_status/.test(body.message)), "missing pause terminal-style toast card");
    assert.ok(toastCalls.every((body) => !/agents \d+ active|runId=|cache|concurrency/.test(body.message)), "legacy lifecycle toast body leaked");
    assert.deepEqual(abortCalls.map((input) => input.path.id), [`${cancelRunId}-child`, `${pauseRunId}-child`]);
  } finally {
    __test.runs.delete("in-memory-cancel-run");
    __test.runs.delete("in-memory-pause-run");
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("workflow_cancel and workflow_kill do not wedge when child session abort hangs", async () => {
  const abortCalls = [];
  const { tools, context, directory } = await makeHarness(async () => ({ data: { parts: [], info: {} } }), {
    pluginContext: { __workflowChildAbortTimeoutMs: 20, __workflowLifecycleSettleTimeoutMs: 20 },
    session(prompt, options, calls) {
      return {
        async create(input) {
          calls.create.push(input);
          return { data: { id: "child-1" } };
        },
        async prompt(input) {
          calls.prompt.push(input);
          return await prompt(input);
        },
        async abort(input) {
          calls.abort.push(input);
          abortCalls.push(input);
          return await new Promise(() => {});
        },
      };
    },
  });

  function makeInMemoryRun(runId, dir) {
    return {
      id: runId,
      dir,
      status: "running",
      sourcePath: "inline",
      sourceHash: "source-hash",
      meta: { name: runId },
      authority: {},
      argsPreview: "{}",
      startedAt: "2026-06-24T00:00:00.000Z",
      currentPhase: "test",
      agentsStarted: 1,
      maxAgents: 1,
      concurrency: 1,
      defaultChildModel: HARNESS_DEFAULT_MODEL,
      activeAgents: 1,
      waitingAgents: [],
      tokens: { input: 0, output: 0, reasoning: 0 },
      replayedTokens: { input: 0, output: 0, reasoning: 0 },
      cost: 0,
      replayedCost: 0,
      cacheStats: { hits: 0, misses: 0, invalidated: 0 },
      budgetCeilings: {},
      laneOutcomes: { success: 0, failure: 0, cancelled: 0, timeout: 0, budget_stopped: 0 },
      droppedLaneCount: 0,
      capabilities: {},
      diagnostics: {},
      editWorktrees: [],
      integrationWorktrees: [],
      laneRecords: new Map(),
      nestedSnapshots: new Map(),
      children: new Map([[`${runId}-child`, directory]]),
      abortController: new AbortController(),
      background: false,
      eventCount: 0,
      journalRecords: 0,
    };
  }

  const cancelRunId = "hung-abort-cancel-run";
  const killRunId = "hung-abort-kill-run";
  try {
    const root = __test.runRoot(context);
    const cancelDir = __test.runDirForRoot(root, cancelRunId);
    const killDir = __test.runDirForRoot(root, killRunId);
    await fs.mkdir(cancelDir, { recursive: true });
    await fs.mkdir(killDir, { recursive: true });
    const cancelRun = makeInMemoryRun(cancelRunId, cancelDir);
    const killRun = makeInMemoryRun(killRunId, killDir);
    __test.runs.set(cancelRunId, cancelRun);
    __test.runs.set(killRunId, killRun);

    const cancelBegin = Date.now();
    assert.match(await tools.workflow_cancel.execute({ runId: cancelRunId }, context), /Cancellation requested/);
    assert.ok(Date.now() - cancelBegin < 500, "workflow_cancel must not wait forever for child abort");
    assert.equal(JSON.parse(await fs.readFile(path.join(cancelDir, "state.json"), "utf8")).status, "cancelling");

    const killBegin = Date.now();
    assert.match(await tools.workflow_kill.execute({ runId: killRunId }, context), /force-terminated/i);
    assert.ok(Date.now() - killBegin < 500, "workflow_kill must not wait forever for child abort");
    assert.equal(JSON.parse(await fs.readFile(path.join(killDir, "state.json"), "utf8")).status, "interrupted");
    assert.deepEqual(abortCalls.map((input) => input.path.id), [`${cancelRunId}-child`, `${killRunId}-child`]);
  } finally {
    __test.runs.delete(cancelRunId);
    __test.runs.delete(killRunId);
    await fs.rm(directory, { recursive: true, force: true });
  }
});

// jbs3.7: settle-aware pause via the REAL run lifecycle path. A background run whose guest body
// catches the lane cancellation and then wedges never settles past the transitional "pausing"
// status, so awaitBackgroundRunIfPresent's bounded settle wait expires with the run alive but not
// settled. workflow_pause must surface settle guidance (poll workflow_status, then resume) rather
// than an unconditional "resume now"; an immediate resume in that window must return the same
// actionable settle guidance, NOT the bare "not resumable from status pausing" surprise.
test("jbs3.7: pause on an alive-but-not-settled background run returns settle guidance, and an immediate resume returns settle guidance not a hard error", async () => {
  let laneStarted;
  const laneStartedP = new Promise((resolve) => { laneStarted = resolve; });
  const { tools, context, directory } = await makeHarness(async () => {
    laneStarted();
    // Wedge the lane; pause aborts it, the guest catches the cancellation and then wedges on a
    // guest-level never-resolving promise so the run stays in "pausing" deterministically.
    await new Promise(() => {});
    return "never";
  }, { pluginContext: { __workflowLifecycleSettleTimeoutMs: 20 } });
  let runId;
  try {
    const source = `export const meta = { name: "pause-settle-guidance", concurrency: 1 };
try { await agent("wedged lane"); } catch (e) {}
await new Promise(() => {});
return true;`;
    const preview = await tools.workflow_run.execute({ source, background: true }, context);
    const approvalHash = preview.match(/approvalHash: ([a-f0-9]{64})/)[1];
    const started = await tools.workflow_run.execute({ source, background: true, approve: true, approvalHash }, context);
    runId = started.match(/Workflow ([0-9a-f-]{36}) started in background/)[1];
    await laneStartedP;

    const pauseMessage = await tools.workflow_pause.execute({ runId }, context);
    assert.match(pauseMessage, /still settling \(status pausing\)/, "pause must report the transitional status, not claim it is paused");
    assert.match(pauseMessage, /Poll workflow_status/);
    assert.match(pauseMessage, new RegExp(`resume with workflow_run\\(\\{ resumeRunId: "${runId}"`));
    assert.doesNotMatch(pauseMessage, /^Pause requested for workflow [0-9a-f-]+\. Resume with/, "must not emit the old optimistic resume-now line");

    // The on-disk state is still transitional; an immediate resume must return settle guidance.
    const transitionalState = JSON.parse(await fs.readFile(path.join(__test.runDirForRoot(__test.runRoot(context), runId), "state.json"), "utf8"));
    assert.equal(transitionalState.status, "pausing");
    await assert.rejects(
      tools.workflow_run.execute({ resumeRunId: runId }, context),
      (error) => {
        assert.match(error.message, /still settling \(status pausing\)[\s\S]*poll workflow_status[\s\S]*resume with workflow_run/i);
        assert.doesNotMatch(error.message, /^Workflow run [^ ]+ is not resumable from status pausing;/, "the bare 'not resumable from status pausing' surprise must be gone");
        return true;
      },
    );
  } finally {
    // Force-terminate the wedged run and remove the in-memory handle so it does not linger.
    if (runId) { try { await tools.workflow_kill.execute({ runId }, context); } catch {} }
    if (runId) __test.runs.delete(runId);
    await fs.rm(directory, { recursive: true, force: true });
  }
});

// jbs3.7: assertResumableState surfaces actionable settle guidance for the transitional
// "pausing"/"cancelling" statuses (poll then resume / poll to terminal), while a genuinely
// non-resumable terminal status keeps the existing hard rejection.
test("jbs3.7: resuming a settling run returns poll guidance; a terminal non-resumable status still rejects", async () => {
  const { tools, context, directory } = await makeHarness(async () => ({ data: { parts: [], info: {} } }));
  try {
    const root = __test.runRoot(context);
    async function writeStateFor(runId, status) {
      const dir = __test.runDirForRoot(root, runId);
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, "state.json"), JSON.stringify({ status }), "utf8");
      return runId;
    }

    const pausingId = await writeStateFor("settling-pausing-run", "pausing");
    await assert.rejects(
      tools.workflow_run.execute({ resumeRunId: pausingId }, context),
      /still settling \(status pausing\)[\s\S]*poll workflow_status[\s\S]*until status is paused[\s\S]*resume with workflow_run/i,
    );

    const cancellingId = await writeStateFor("settling-cancelling-run", "cancelling");
    await assert.rejects(
      tools.workflow_run.execute({ resumeRunId: cancellingId }, context),
      /still settling \(status cancelling\)[\s\S]*terminal status[\s\S]*not resumable/i,
    );

    const completedId = await writeStateFor("terminal-completed-run", "completed");
    await assert.rejects(
      tools.workflow_run.execute({ resumeRunId: completedId }, context),
      /not resumable from status completed/,
    );
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

// jbs3.7 + mfv9.6: background heuristic. Omitted background defaults to background
// for large/long fan-outs (wide maxAgents, deep concurrency waves, or an explicit
// long deadline) so an autonomous agent keeps a control channel. Explicit
// args.background and resume-pinned priorState.background still win.
test("mfv9.6: wide/deep/long runs default to background while explicit and resume-pinned modes win", async () => {
  const { tools, context, directory } = await makeHarness(async () => ({ data: { parts: [], info: {} } }));
  try {
    async function preview(request) {
      return await tools.workflow_run.execute(request, context);
    }
    const wideSource = `export const meta = { name: "rec-wide" };\nreturn true;`;
    const wide = await preview({ source: wideSource, maxAgents: 8 });
    assert.match(wide, /Background: true/);
    assert.match(wide, /Background defaulted \(heuristic\)/);
    assert.match(wide, /maxAgents=8/);
    assert.match(wide, /workflow_status, workflow_pause, and workflow_cancel/);
    assert.match(wide, /session\.promptAsync is unavailable/);

    const wideHash = wide.match(/approvalHash: ([a-f0-9]{64})/)?.[1];
    assert.ok(wideHash, `missing approval hash in preview: ${wide}`);
    const started = await tools.workflow_run.execute({ source: wideSource, maxAgents: 8, approve: true, approvalHash: wideHash }, context);
    assert.match(started, /started in background/);
    assert.match(started, /session\.promptAsync is unavailable/);
    const wideRunId = runIdFrom(started);
    await __test.runs.get(wideRunId)?.done;
    const wideStatus = JSON.parse(await tools.workflow_status.execute({ runId: wideRunId, format: "json", detail: "full" }, context));
    assert.equal(wideStatus.background, true);

    const deep = await preview({ source: `export const meta = { name: "rec-deep" };\nreturn true;`, maxAgents: 4, concurrency: 1 });
    assert.match(deep, /Background: true/);
    assert.match(deep, /Background defaulted \(heuristic\)/, "a serialized multi-wave fan-out (4 waves) should default background");

    const long = await preview({ source: `export const meta = { name: "rec-long", maxAgents: 1, maxRuntimeMs: 600000 };\nreturn true;` });
    assert.match(long, /Background: true/);
    assert.match(long, /Background defaulted \(heuristic\)/, "an explicit long maxRuntimeMs should default background");

    const small = await preview({ source: `export const meta = { name: "rec-small", maxAgents: 2, concurrency: 2 };\nreturn true;` });
    assert.match(small, /Background: false/);
    assert.doesNotMatch(small, /Background defaulted/, "a small single-wave run must stay foreground");
    assert.doesNotMatch(small, /session\.promptAsync is unavailable/, "foreground runs do not need completion notification delivery");

    const explicitForeground = await preview({ source: wideSource, maxAgents: 8, background: false });
    assert.match(explicitForeground, /Background: false/);
    assert.doesNotMatch(explicitForeground, /Background defaulted/, "explicit background:false must override the heuristic");

    const alreadyBackground = await preview({ source: `export const meta = { name: "rec-bg", maxAgents: 16 };\nreturn true;`, background: true });
    assert.match(alreadyBackground, /Background: true/);
    assert.doesNotMatch(alreadyBackground, /Background defaulted/, "explicit background:true must not be reported as an automatic default");

    const failingWideSource = `export const meta = { name: "resume-bg-pin" };\nthrow new Error("resume pin");`;
    await assert.rejects(
      runApprovedRequest(tools, context, { source: failingWideSource, maxAgents: 8, background: false }),
      /resume pin/,
    );
    const failed = await statusByName(tools, context, "resume-bg-pin");
    assert.equal(failed.background, false);
    const resumePreview = await tools.workflow_run.execute({ resumeRunId: failed.id }, context);
    assert.match(resumePreview, /Background: false/);
    assert.doesNotMatch(resumePreview, /Background defaulted/, "resumed runs must keep the prior foreground mode pinned");
    assert.doesNotMatch(resumePreview, /Background recommended/, "resumed runs cannot change background mode in-place");
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

// jbs3.6: run-level wall-clock deadline. Drives the REAL runWorkflowExecution path: one lane
// completes and one lane wedges forever; maxRuntimeMs must hard-stop the whole run at the
// deadline with the completed lane's work preserved and a partial result.json recorded.
test("workflow_run maxRuntimeMs terminates a wedged run within the deadline preserving completed-lane work", async () => {
  const prompts = [];
  const { tools, context, directory } = await makeHarness(async (input) => {
    const text = input.body.parts[0].text;
    prompts.push(text);
    if (text.includes("quick lane")) {
      return { data: { parts: [{ type: "text", text: "done" }], info: { tokens: { input: 1, output: 1, reasoning: 0 }, cost: 0 } } };
    }
    // The wedged lane never resolves on its own; only the run-level deadline abort can end it.
    return await new Promise(() => {});
  });
  try {
    const source = `export const meta = { name: "deadline-run", concurrency: 1 };
await agent("quick lane");
await agent("wedged lane");
return true;`;
    await assert.rejects(
      runApprovedRequest(tools, context, { source, maxRuntimeMs: 1000 }),
      /deadline|cancel/i,
    );
    const status = await statusByName(tools, context, "deadline-run");
    assert.equal(status.status, "timed-out");
    assert.equal(status.laneOutcomes.success, 1, "the completed quick lane must be preserved");
    assert.deepEqual(prompts, ["quick lane", "wedged lane"]);

    const result = JSON.parse(await fs.readFile(path.join(status.dir, "result.json"), "utf8"));
    assert.equal(result.status, "timed-out");
    assert.equal(result.partial, true);
    assert.equal(result.maxRuntimeMs, 1000);
    assert.equal(result.laneOutcomes.success, 1);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("timed-out read-only runs require explicit deadline-extension resume and replay completed lanes", async () => {
  const prompts = [];
  let wedgedAttempts = 0;
  const { tools, context, directory } = await makeHarness(async (input) => {
    const text = input.body.parts[0].text;
    prompts.push(text);
    if (text.includes("quick lane")) {
      return { data: { parts: [{ type: "text", text: "quick done" }], info: { tokens: { input: 1, output: 1, reasoning: 0 }, cost: 0 } } };
    }
    if (text.includes("wedged lane")) {
      wedgedAttempts += 1;
      if (wedgedAttempts === 1) return await new Promise(() => {});
      return { data: { parts: [{ type: "text", text: "resume done" }], info: { tokens: { input: 1, output: 1, reasoning: 0 }, cost: 0 } } };
    }
    throw new Error(`unexpected prompt: ${text}`);
  });
  try {
    const source = `export const meta = { name: "timeout-resume-policy", profile: "read-only-review", concurrency: 1 };
await agent("quick lane");
await agent("wedged lane");
return true;`;
    await assert.rejects(
      runApprovedRequest(tools, context, { source, maxRuntimeMs: 500 }),
      /deadline|cancel/i,
    );

    const timedOut = await statusByName(tools, context, "timeout-resume-policy");
    assert.equal(timedOut.status, "timed-out");
    assert.equal(timedOut.timeoutRecovery.eligible, true);
    assert.equal(timedOut.timeoutRecovery.completedLaneCount, 1);
    assert.equal(timedOut.timeoutRecovery.activeOrTimedOutLaneCount, 1);
    assert.deepEqual(timedOut.timeoutRecovery.requiredResumeArgs, {
      resumePolicy: "extend-deadline",
      maxRuntimeMsGreaterThan: 500,
    });
    assert.ok(timedOut.nextActions.some((action) => /resumePolicy=extend-deadline/.test(action)));

    await assert.rejects(
      tools.workflow_run.execute({ resumeRunId: timedOut.id, maxRuntimeMs: 1000 }, context),
      /requires resumePolicy:"extend-deadline"/,
    );
    await assert.rejects(
      tools.workflow_run.execute({ resumeRunId: timedOut.id, resumePolicy: "extend-deadline" }, context),
      /requires maxRuntimeMs greater than prior maxRuntimeMs 500/,
    );
    await assert.rejects(
      tools.workflow_run.execute({ resumeRunId: timedOut.id, resumePolicy: "extend-deadline", maxRuntimeMs: 500 }, context),
      /requires maxRuntimeMs greater than prior maxRuntimeMs 500/,
    );

    const preview = await tools.workflow_run.execute({ resumeRunId: timedOut.id, resumePolicy: "extend-deadline", maxRuntimeMs: 1000 }, context);
    assert.match(preview, /Resume policy: extend-deadline/);
    assert.match(preview, /Run deadline .*1000ms/);
    assert.match(preview, /Resume replay: 0 lanes will re-run, ~\$0 re-spend \(1 completed lanes replay from cache/);

    const output = await runApprovedRequest(tools, context, { resumeRunId: timedOut.id, resumePolicy: "extend-deadline", maxRuntimeMs: 1000 });
    assert.match(output, new RegExp(`Workflow ${escapeRegExp(timedOut.id)} completed`));
    const resumed = JSON.parse(await tools.workflow_status.execute({ runId: timedOut.id, format: "json", detail: "full" }, context));
    assert.equal(resumed.status, "completed");
    assert.equal(resumed.maxRuntimeMs, 1000);
    assert.equal(resumed.cacheStats.hits, 1, "quick lane must replay from the journal cache");
    assert.deepEqual(prompts, ["quick lane", "wedged lane", "wedged lane"]);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("workflow_status exposes write-capable timeout recovery blocked reasons", async () => {
  const { tools, context, directory } = await makeHarness(async () => {
    throw new Error("synthetic status test must not launch lanes");
  });
  const emptyLedgers = () => ({
    "integration-ledger": { records: 0, phases: {} },
    "validation-ledger": { records: 0, phases: {} },
    "domain-ledger": { records: 0, phases: {} },
    "apply-ledger": { records: 0, phases: {} },
  });
  const readOnlyAuthority = __test.resolveRunAuthority({ profile: "read-only-review" }, {});
  const editAuthority = __test.resolveRunAuthority({ authority: { edit: true } }, {});
  const integrationAuthority = __test.resolveRunAuthority({ authority: { integration: true } }, {});
  async function writeRun(id, state) {
    const dir = __test.runDirForRoot(__test.runRoot(context), id);
    await fs.mkdir(dir, { recursive: true });
    await __test.writeJsonAtomic(path.join(dir, "state.json"), {
      id,
      status: "timed-out",
      maxRuntimeMs: 500,
      authority: readOnlyAuthority,
      durability: { ledgers: emptyLedgers() },
      ...state,
    });
    return dir;
  }
  async function fullStatus(id) {
    return JSON.parse(await tools.workflow_status.execute({ runId: id, format: "json", detail: "full" }, context));
  }
  try {
    await writeRun("timeout-dirty-worktree", {
      authority: integrationAuthority,
      integrationWorktrees: [{ path: "/tmp/dirty-integration" }],
      worktreeCleanup: { integration: [{ preserved: true, reason: "dirty", dirty: true }] },
    });
    await writeRun("timeout-partial-integration", {
      authority: integrationAuthority,
      integrationPlan: { lanes: [{ callId: "lane:1" }] },
    });
    await writeRun("timeout-diff-apply", {
      authority: editAuthority,
      editPlan: { sourceHash: "source", baseCommit: "base", diffPlanHash: "diff", domainMutationHash: "domain", patchCount: 1 },
      durability: {
        ledgers: {
          ...emptyLedgers(),
          "apply-ledger": { records: 2, phases: { started: 1, "before-write": 1 } },
        },
      },
    });
    await writeRun("timeout-staged-domain", {
      authority: editAuthority,
      durability: {
        ledgers: {
          ...emptyLedgers(),
          "domain-ledger": { records: 1, phases: { staged: 1 } },
        },
      },
    });
    const lockedDir = await writeRun("timeout-active-lock", {});
    await __test.writeJsonAtomic(path.join(lockedDir, "run.lock"), {
      operation: "run",
      runId: "timeout-active-lock",
      process: { pid: process.pid, startTime: await __test.selfProcessStartTime() },
    });

    const expectations = [
      ["timeout-dirty-worktree", [/authority is not strictly read-only/, /integration worktrees are present/, /preserved dirty integration worktree is present/]],
      ["timeout-partial-integration", [/authority is not strictly read-only/, /partial integration plan is present/]],
      ["timeout-diff-apply", [/authority is not strictly read-only/, /diff plan is present/, /apply ledger is incomplete/]],
      ["timeout-staged-domain", [/authority is not strictly read-only/, /staged domain mutation ledger is present/]],
      ["timeout-active-lock", [/run\.lock is active/]],
    ];
    for (const [runId, patterns] of expectations) {
      const status = await fullStatus(runId);
      assert.equal(status.timeoutRecovery.eligible, false, `${runId} must remain non-resumable`);
      const reasons = status.timeoutRecovery.blockedReasons.join("\n");
      for (const pattern of patterns) assert.match(reasons, pattern, `${runId} blockedReasons`);
      assert.ok(status.nextActions.some((action) => /blocked from resume/.test(action)), `${runId} nextActions must stay blocked`);
      await assert.rejects(
        tools.workflow_run.execute({ resumeRunId: runId, resumePolicy: "extend-deadline", maxRuntimeMs: 1000 }, context),
        /timed-out resume is blocked/,
      );
    }
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

// jbs3.6 / sqoh.2: workflow_kill on a process-owned in-memory run must return promptly (no 1s
// cooperative settle), abort the run, and leave it resumable, but must NOT release run.lock while
// the old owner may still write. The runWorkflowExecution finally releases the lock after settle.
test("workflow_kill force-terminates an in-memory run promptly and keeps run lock until owner settles", async () => {
  const abortCalls = [];
  const { tools, context, directory } = await makeHarness(async () => ({ data: { parts: [], info: {} } }), {
    onAbort(input) { abortCalls.push(input); },
  });
  const runId = "kill-in-memory-run";
  let rawReleaseRunLock;
  try {
    const root = __test.runRoot(context);
    const dir = __test.runDirForRoot(root, runId);
    await fs.mkdir(dir, { recursive: true });
    const lockPath = __test.lockPathForRun(dir, "run");
    rawReleaseRunLock = await __test.acquireWorkflowLock(lockPath, { operation: "run", runId });
    assert.equal(await fileExists(lockPath), true);

    let releaseCalled = false;
    const rejects = [];
    const run = {
      id: runId, dir, status: "running", sourcePath: "inline", sourceHash: "source-hash",
      meta: { name: runId }, authority: {}, argsPreview: "{}", startedAt: "2026-06-24T00:00:00.000Z",
      currentPhase: "test", agentsStarted: 1, maxAgents: 1, concurrency: 1,
      defaultChildModel: HARNESS_DEFAULT_MODEL, activeAgents: 1,
      waitingAgents: [{ reject(error) { rejects.push(error); } }],
      tokens: { input: 0, output: 0, reasoning: 0 }, replayedTokens: { input: 0, output: 0, reasoning: 0 },
      cost: 0, replayedCost: 0, cacheStats: { hits: 0, misses: 0, invalidated: 0 }, budgetCeilings: {},
      laneOutcomes: { success: 0, failure: 0, cancelled: 0, timeout: 0, budget_stopped: 0 },
      droppedLaneCount: 0, capabilities: {}, diagnostics: {}, editWorktrees: [], integrationWorktrees: [],
      laneRecords: new Map(), nestedSnapshots: new Map(),
      children: new Map([[`${runId}-child`, directory]]),
      abortController: new AbortController(), background: true, eventCount: 0, journalRecords: 0,
      // A never-resolving done proves kill does not block on the background cooperative settle and
      // must not drop the durable ownership lock while this owner can still write.
      done: new Promise(() => {}),
      releaseRunLock: async () => { releaseCalled = true; await rawReleaseRunLock(); },
    };
    __test.runs.set(runId, run);

    const begin = Date.now();
    const message = await tools.workflow_kill.execute({ runId }, context);
    const elapsed = Date.now() - begin;

    assert.ok(elapsed < 500, `kill must return promptly without the cooperative settle; took ${elapsed}ms`);
    assert.match(message, /force-terminated/i);
    assert.equal(run.status, "interrupted");
    assert.equal(run.killed, true);
    assert.equal(run.abortController.signal.aborted, true);
    assert.equal(rejects[0]?.code, "WORKFLOW_CANCELLED");
    assert.equal(releaseCalled, false);
    assert.equal(await fileExists(lockPath), true, "the run lock must stay held until the owner settles");
    assert.equal(JSON.parse(await fs.readFile(path.join(dir, "state.json"), "utf8")).status, "interrupted");
    const killRequest = JSON.parse(await fs.readFile(path.join(dir, "kill-request.json"), "utf8"));
    assert.equal(killRequest.type, "kill");
    assert.deepEqual(abortCalls.map((input) => input.path.id), [`${runId}-child`]);
    assert.match(message, /will release run\.lock/);
  } finally {
    try { await rawReleaseRunLock?.(); } catch {}
    __test.runs.delete(runId);
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("workflow_kill prevents late sandbox success from overwriting interrupted state", async () => {
  let laneStarted;
  let releaseLane;
  const laneStartedP = new Promise((resolve) => { laneStarted = resolve; });
  const releaseLaneP = new Promise((resolve) => { releaseLane = resolve; });
  const { tools, context, directory } = await makeHarness(async () => {
    laneStarted();
    await releaseLaneP;
    return { data: { parts: [{ type: "text", text: "late lane result" }], info: { tokens: { input: 0, output: 0, reasoning: 0 }, cost: 0 } } };
  });
  let runId;
  try {
    const source = `export const meta = { name: "kill-late-success", maxAgents: 1 };
await agent("late lane");
return "should-not-complete";`;
    const preview = await tools.workflow_run.execute({ source, background: true }, context);
    const approvalHash = preview.match(/approvalHash: ([a-f0-9]{64})/)[1];
    const started = await tools.workflow_run.execute({ source, background: true, approve: true, approvalHash }, context);
    runId = runIdFrom(started);
    const run = __test.runs.get(runId);
    assert.ok(run, "background run should be in-memory before kill");
    const dir = __test.runDirForRoot(__test.runRoot(context), runId);
    const lockPath = __test.lockPathForRun(dir, "run");

    await laneStartedP;
    await tools.workflow_kill.execute({ runId }, context);
    assert.equal(JSON.parse(await fs.readFile(path.join(dir, "state.json"), "utf8")).status, "interrupted");
    assert.equal(await fileExists(lockPath), true, "lock stays held until the original owner settles");

    releaseLane();
    await run.done;

    const state = JSON.parse(await fs.readFile(path.join(dir, "state.json"), "utf8"));
    assert.equal(state.status, "interrupted", "late sandbox success must not overwrite kill state as completed");
    assert.equal(await fileExists(lockPath), false, "runWorkflowExecution finally releases the lock after settle");
  } finally {
    if (runId) __test.runs.delete(runId);
    await fs.rm(directory, { recursive: true, force: true });
  }
});

// jbs3.6: workflow_kill on a run owned by a (dead) foreign process. Must persist a durable kill
// request a live owner would observe and clear the stale dead-process run lock immediately so
// the wedged run is not permanently blocked on the dead owner's lock.
test("workflow_kill on a run owned by another process writes a durable kill request and clears stale locks", async () => {
  const { tools, context, directory } = await makeHarness(async () => ({ data: { parts: [], info: {} } }));
  const runId = "kill-foreign-run";
  try {
    const root = __test.runRoot(context);
    const dir = __test.runDirForRoot(root, runId);
    await fs.mkdir(dir, { recursive: true });
    await __test.writeJsonAtomic(path.join(dir, "state.json"), { id: runId, status: "running", process: { pid: 999999999, startTime: 1 } });
    // A run lock held by a dead PID is stale and must be cleared immediately by kill.
    await __test.writeJsonAtomic(__test.lockPathForRun(dir, "run"), { operation: "run", runId, process: { pid: 999999999, startTime: 1 } });

    const message = await tools.workflow_kill.execute({ runId }, context);
    assert.match(message, /Force-terminate requested/i);
    assert.match(message, /stale lock/i);

    const killRequest = JSON.parse(await fs.readFile(path.join(dir, "kill-request.json"), "utf8"));
    assert.equal(killRequest.type, "kill");
    assert.equal(await fileExists(__test.lockPathForRun(dir, "run")), false, "stale lock must be cleared");

    const status = JSON.parse(await tools.workflow_status.execute({ runId, format: "json", detail: "full" }, context));
    assert.equal(status.lifecycleRequests.kill.type, "kill");
  } finally {
    __test.runs.delete(runId);
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("run finalization releases run lock when cleanup state persistence fails", async () => {
  const { tools, context, directory } = await makeHarness(async () => ({
    data: {
      parts: [{ type: "text", text: JSON.stringify({ patches: [{ path: "cleanup-finalizer.txt", content: "patched\n" }] }) }],
      info: {
        structured: { patches: [{ path: "cleanup-finalizer.txt", content: "patched\n" }] },
        tokens: { input: 1, output: 1, reasoning: 0 },
        cost: 0,
      },
    },
  }));
  let awaitingDiffWrites = 0;
  try {
    await initGitRepo(directory);
    __test.__setWriteStateTestHook(({ state }) => {
      if (state.status !== "awaiting-diff-approval") return;
      awaitingDiffWrites += 1;
      if (awaitingDiffWrites === 2) throw new Error("injected cleanup state write failure");
    });

    const source = `export const meta = { name: "cleanup-write-failure", authority: { edit: true }, maxAgents: 1 };
return await agent("edit", { edit: true, schema: { type: "object", properties: { patches: { type: "array" } }, required: ["patches"] } });`;

    const output = await runApproved(tools, context, source);
    assert.match(output, /awaiting diff approval/);
    const runId = runIdFrom(output);
    const status = JSON.parse(await tools.workflow_status.execute({ runId, format: "json", detail: "full" }, context));
    assert.equal(status.status, "awaiting-diff-approval");
    assert.equal(await fileExists(__test.lockPathForRun(status.dir, "run")), false, "run.lock must be released despite cleanup write failure");
    assert.equal(__test.runs.has(runId), false, "in-memory run must be deleted despite cleanup write failure");
    assert.equal(await fileExists(path.join(status.dir, "events.jsonl")), true, "finalization cleanup diagnostic should be best-effort only");
  } finally {
    __test.__setWriteStateTestHook(undefined);
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("background workflow observes durable pause request before launching next lane", async () => {
  let firstPromptResolve;
  const firstPromptStarted = new Promise((resolve) => { firstPromptResolve = resolve; });
  let releaseFirstPrompt;
  const firstPromptMayFinish = new Promise((resolve) => { releaseFirstPrompt = resolve; });
  const prompts = [];
  const { tools, context, directory } = await makeHarness(async (input) => {
    prompts.push(input.body.parts[0].text);
    firstPromptResolve();
    await firstPromptMayFinish;
    return "first done";
  });
  try {
    const source = `export const meta = { name: "durable-pause-observed", concurrency: 1 };
await agent("first lane");
await agent("second lane");`;
    const preview = await tools.workflow_run.execute({ source, background: true }, context);
    const approvalHash = preview.match(/approvalHash: ([a-f0-9]{64})/)[1];
    const started = await tools.workflow_run.execute({ source, background: true, approve: true, approvalHash }, context);
    const runId = started.match(/Workflow ([0-9a-f-]{36}) started in background/)[1];

    await firstPromptStarted;
    const status = JSON.parse(await tools.workflow_status.execute({ runId, format: "json", detail: "full" }, context));
    await __test.writeJsonAtomic(path.join(status.dir, "pause-request.json"), { type: "pause", requestedAt: new Date().toISOString(), reason: "test durable pause" });
    releaseFirstPrompt();
    await __test.runs.get(runId).done;
    const finalStatus = JSON.parse(await tools.workflow_status.execute({ runId, format: "json", detail: "full" }, context));

    assert.deepEqual(prompts, ["first lane"]);
    assert.equal(finalStatus.status, "paused");
    assert.equal(finalStatus.lifecycleRequests.pause.reason, "test durable pause");
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

// R28: startWorkflow does runs.set(run.id, run) before appendEvent/writeState. If either
// throws during setup, the catch must drop the run-map entry it added — otherwise a phantom
// 'running' entry survives for the process lifetime and blocks resume-id retry (runs.has ->
// "already active"). Force the first post-runs.set write (appendEvent -> events.jsonl) to
// throw and assert no phantom entry remains.

test("R28: a throw after runs.set during startWorkflow leaves no phantom run-map entry", async () => {
  const { tools, context, directory } = await makeHarness(async () => "lane done");
  const knownRunId = "00000000-0000-4000-8000-00000000ce28";
  const source = `export const meta = { name: "r28-runmap-leak", concurrency: 1 };
await agent("only lane");`;
  // Build the approval envelope before installing stubs so the preview pass (which does not
  // runs.set) does not consume the stubbed run id.
  const args = await approvalArgs(tools, context, source);
  const realRandomUUID = crypto.randomUUID;
  const realAppendFile = fs.appendFile;
  let consumedRunId = false;
  crypto.randomUUID = (...callArgs) => {
    if (!consumedRunId) {
      consumedRunId = true;
      return knownRunId;
    }
    return realRandomUUID.apply(crypto, callArgs);
  };
  const targetEventsSuffix = path.join(knownRunId, "events.jsonl");
  fs.appendFile = async (filePath, ...rest) => {
    // Only the run's own first post-runs.set write (its events.jsonl) should fail, so probe
    // gate artifacts under other run ids are untouched and the failure lands at appendEvent.
    if (typeof filePath === "string" && filePath.endsWith(targetEventsSuffix)) {
      throw new Error("injected events.jsonl write failure");
    }
    return await realAppendFile.call(fs, filePath, ...rest);
  };
  try {
    assert.equal(__test.runs.has(knownRunId), false, "precondition: run-map must not already hold the id");
    await assert.rejects(
      tools.workflow_run.execute(args, context),
      /injected events\.jsonl write failure/,
    );
    assert.equal(consumedRunId, true, "the stub must have supplied the run id");
    assert.equal(
      __test.runs.has(knownRunId),
      false,
      "the failed setup must not leave a phantom run-map entry (runs.delete in catch)",
    );
  } finally {
    crypto.randomUUID = realRandomUUID;
    fs.appendFile = realAppendFile;
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("workflow body runtime error surfaces its real message, not [object Object]", async () => {
  // Regression: a thrown Error inside the QuickJS sandbox lost its non-enumerable .message
  // when vm.dump()-ed across the VM/host boundary, so run.error became "[object Object]".
  // The body try/catch now captures the message inside the VM and returns a sentinel whose
  // enumerable string props survive dump(); the host re-throws a real Error with the message.
  const { tools, context, directory } = await makeHarness(async () => {
    throw new Error("body-throws test must not prompt a model");
  });
  try {
    const directSource = `export const meta = { name: "body-throws-direct", maxAgents: 1 };\nthrow new Error("specific boom from workflow body");\nreturn "unreachable";`;
    await assert.rejects(runApproved(tools, context, directSource), /specific boom from workflow body/);

    // Real-world case that originally triggered the bug: the sandbox disables Date.now(),
    // and the disabled-global error message must reach the caller intact.
    const dateSource = `export const meta = { name: "body-throws-disabled-global", maxAgents: 1 };\nconst t = Date.now();\nreturn t;`;
    await assert.rejects(runApproved(tools, context, dateSource), /Date\.now is disabled in deterministic workflows/);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("default lane concurrency is conservative (4) when neither meta nor args specify it", async () => {
  // High fan-out (12) has stalled entire waves of blocking child prompts in real runtimes,
  // so the default must be conservative. Explicit meta.concurrency / args.concurrency still win.
  const { tools, context, directory } = await makeHarness(async () => {
    throw new Error("default-concurrency test must not prompt a model");
  });
  try {
    const source = `export const meta = { name: "default-concurrency", maxAgents: 1 };\nreturn { ok: true };`;
    const output = await runApproved(tools, context, source);
    const runId = runIdFrom(output);
    const status = JSON.parse(await tools.workflow_status.execute({ runId, format: "json", detail: "full" }, context));
    assert.equal(status.concurrency, 4, "default concurrency should be the conservative 4, not the stall-prone 12");
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("hard concurrency limit resolver accepts env override values and ignores invalid values", () => {
  assert.equal(resolveHardConcurrencyLimit({ [HARD_CONCURRENCY_LIMIT_ENV]: "32" }), 32);
  assert.equal(resolveHardConcurrencyLimit({ [HARD_CONCURRENCY_LIMIT_ENV]: String(MAX_CONFIGURABLE_CONCURRENCY_LIMIT) }), MAX_CONFIGURABLE_CONCURRENCY_LIMIT);
  assert.equal(resolveHardConcurrencyLimit({ [HARD_CONCURRENCY_LIMIT_ENV]: "0" }), DEFAULT_HARD_CONCURRENCY_LIMIT);
  assert.equal(resolveHardConcurrencyLimit({ [HARD_CONCURRENCY_LIMIT_ENV]: "not-a-number" }), DEFAULT_HARD_CONCURRENCY_LIMIT);
  assert.equal(normalizeHardConcurrencyLimit(12.5, 9), 9);
});

test("plugin hardConcurrencyLimit option raises requested concurrency above the default ceiling", async () => {
  const requestedConcurrency = DEFAULT_HARD_CONCURRENCY_LIMIT + 8;
  const { tools, context, directory } = await makeHarness(async () => {
    throw new Error("hard-concurrency-limit option test must not prompt a model");
  }, { pluginOptions: { hardConcurrencyLimit: requestedConcurrency } });
  try {
    const source = `export const meta = { name: "raised-hard-concurrency", maxAgents: 1 };\nreturn { ok: true };`;
    const output = await runApprovedRequest(tools, context, { source, concurrency: requestedConcurrency });
    const status = JSON.parse(await tools.workflow_status.execute({ runId: runIdFrom(output), format: "json", detail: "full" }, context));
    assert.equal(status.concurrency, requestedConcurrency);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("plugin hardConcurrencyLimit option clamps workflow meta concurrency at plan time", async () => {
  const { tools, context, directory } = await makeHarness(async () => {
    throw new Error("hard-concurrency-limit clamp test must not prompt a model");
  }, { pluginOptions: { hardConcurrencyLimit: 8 } });
  try {
    const source = `export const meta = { name: "clamped-hard-concurrency", maxAgents: 1, concurrency: 40 };\nreturn { ok: true };`;
    const output = await runApproved(tools, context, source);
    const status = JSON.parse(await tools.workflow_status.execute({ runId: runIdFrom(output), format: "json", detail: "full" }, context));
    assert.equal(status.concurrency, 8);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("modelTiers resolves lane models and is covered by the approval hash", async () => {
  // Prompt mock records the concrete provider/model each lane was dispatched with,
  // so we can assert tier -> mapped model resolution from the real dispatch path
  // (not just the unit resolver). childModel pins the default so the test is
  // self-contained and does not depend on session-model inheritance (a later task).
  const seen = [];
  const prompt = async (input) => {
    seen.push(input?.body?.model ? `${input.body.model.providerID}/${input.body.model.modelID}` : "none");
    return { data: { parts: [{ type: "text", text: JSON.stringify({ ok: true }) }], info: { structured: { ok: true }, tokens: { input: 1, output: 1, reasoning: 0 }, cost: 0 } } };
  };
  const { tools, context, directory } = await makeHarness(prompt);
  try {
    const source = [
      'export const meta = { name: "tier-smoke", profile: "read-only-review" };',
      'const f = await agent("fast lane", { tier: "fast", schema: { type: "object", additionalProperties: false, properties: { ok: { type: "boolean" } }, required: ["ok"] } });',
      'const d = await agent("deep lane", { tier: "deep", schema: { type: "object", additionalProperties: false, properties: { ok: { type: "boolean" } }, required: ["ok"] } });',
      'return { f, d };',
    ].join("\n");
    const childModel = "zai-coding-plan/glm-5.2";
    const tiers = { fast: "zai-coding-plan/glm-5.2", deep: "zai-coding-plan/glm-5.2-max" };

    // approvalHash must change when modelTiers change (the model plan is hash-covered).
    const p1 = await tools.workflow_run.execute({ source, childModel, modelTiers: tiers }, context);
    const p2 = await tools.workflow_run.execute({ source, childModel, modelTiers: { fast: tiers.fast, deep: tiers.fast } }, context);
    const h1 = p1.match(/approvalHash: ([a-f0-9]{64})/)[1];
    const h2 = p2.match(/approvalHash: ([a-f0-9]{64})/)[1];
    assert.notEqual(h1, h2, "different modelTiers must yield different approvalHash");

    // The approval preview must surface the resolved fast/deep model plan so an
    // approver can see, before consenting, which model each tier maps to.
    assert.match(p1, /Model plan: fast=zai-coding-plan\/glm-5\.2 deep=zai-coding-plan\/glm-5\.2-max/);

    // Run with the first plan; assert each lane used its tier-mapped model.
    await tools.workflow_run.execute({ source, childModel, modelTiers: tiers, approve: true, approvalHash: h1 }, context);
    assert.ok(seen.includes("zai-coding-plan/glm-5.2"), `fast lane model missing: ${JSON.stringify(seen)}`);
    assert.ok(seen.includes("zai-coding-plan/glm-5.2-max"), `deep lane model missing: ${JSON.stringify(seen)}`);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("resolveLaneModel: precedence, tier map, graceful fallback, validation", () => {
  const run = { defaultChildModel: "zai-coding-plan/glm-5.2", modelTiers: { fast: "zai-coding-plan/glm-5.2", deep: "zai-coding-plan/glm-5.2-max" } };
  // explicit model wins over everything
  assert.equal(__test.resolveLaneModel(run, { model: "openai/gpt-5.5", tier: "deep" }), "openai/gpt-5.5");
  // tier resolves from the map
  assert.equal(__test.resolveLaneModel(run, { tier: "fast" }), "zai-coding-plan/glm-5.2");
  assert.equal(__test.resolveLaneModel(run, { tier: "deep" }), "zai-coding-plan/glm-5.2-max");
  // tier with no map entry falls back to the default
  assert.equal(__test.resolveLaneModel({ defaultChildModel: "openai/gpt-5.5" }, { tier: "deep" }), "openai/gpt-5.5");
  // no tier, no model => default (unchanged legacy behavior)
  assert.equal(__test.resolveLaneModel(run, {}), "zai-coding-plan/glm-5.2");
  // invalid tier is a hard error
  assert.throws(() => __test.resolveLaneModel(run, { tier: "medium" }), /tier/);
});

// --- jbs3.3: edit-and-resume (prefix reuse) over the REAL runWorkflowExecution path ---------
//
// An operator edits a failed/paused workflow body (e.g. the synthesis lane prompt) and resumes
// with editAndResume:true. Unchanged upstream lanes are served from the journal cache at zero
// re-spend (lane signatures are content-addressed per lane, decoupled from the whole-file
// sourceHash); only the edited lane and its dependents re-run; and the two-phase approval gate
// still fires because the edited body yields a new sourceHash -> a new approvalHash.

// Each lane echoes its own prompt into its result, so a downstream lane that embeds an upstream
// result re-keys only when that upstream prompt changed. A lane whose resolved prompt carries a
// "BREAK_" marker throws, so the FIRST run fails there with the earlier lanes already complete; the
// operator's edit replaces that marker so the resumed lane succeeds. The failure is driven purely
// from the body (not runtimeArgs), so runtimeArgs stays null across both runs and lane signatures
// stay stable for the unchanged lanes. A fixed live cost makes completed-lane spend observable.
function editResumePrompt() {
  return async (input) => {
    const text = input.body.parts.map((part) => part.text).join("\n");
    if (text.includes("BREAK_")) {
      throw new Error("lane boom (deliberate failure on the un-edited body)");
    }
    return { data: { parts: [{ type: "text", text: `done:${text}` }], info: { tokens: { input: 1, output: 1, reasoning: 0 }, cost: 0.01 } } };
  };
}

const EDIT_RESUME_SOURCE = ({ name, synthMarker }) => `export const meta = { name: ${JSON.stringify(name)}, profile: "read-only-review", maxAgents: 5 };
const a = await agent("research lane-A stable-A");
const b = await agent("research lane-B stable-B");
const s = await agent("synthesize from " + a + " and " + b + " " + ${JSON.stringify(synthMarker)});
return { a, b, s };`;

test("jbs3.3: editing a failed lane's prompt and resuming reuses unchanged upstream lanes at zero re-spend; only the edited lane re-runs", async () => {
  const { tools, context, directory, calls } = await makeHarness(editResumePrompt());
  try {
    const name = "edit-resume-prefix-reuse";
    const original = EDIT_RESUME_SOURCE({ name, synthMarker: "BREAK_SYNTH" });

    // First run: A and B complete; the synthesis lane throws (BREAK_SYNTH) -> resumable "failed".
    await assert.rejects(runApprovedRequest(tools, context, { source: original }), /lane boom/);
    const failed = await statusByName(tools, context, name);
    const runId = failed.id;
    assert.equal(failed.status, "failed");
    assert.equal(failed.laneOutcomes.success, 2, "A and B complete before the synthesis lane fails");
    assert.equal(failed.laneOutcomes.failure, 1);

    const promptsBeforeResume = calls.prompt.length; // A, B, and the failed synthesis attempt = 3
    assert.equal(promptsBeforeResume, 3);

    // The operator edits ONLY the synthesis lane prompt to fix it. A different sourceHash must force
    // a fresh approval: an editAndResume preview (no approve) returns a new approvalHash and an
    // edited-body replay line rather than executing.
    const edited = EDIT_RESUME_SOURCE({ name, synthMarker: "FIXED_SYNTH" });
    const preview = await tools.workflow_run.execute({ resumeRunId: runId, source: edited, editAndResume: true }, context);
    assert.match(preview, /approvalHash: [a-f0-9]{64}/, "an edited body must require fresh two-phase approval");
    assert.match(preview, /edited body/, "the approval preview must state edited-body per-lane reuse");
    assert.equal(calls.prompt.length, promptsBeforeResume, "the approval preview must not run any lane");

    // Approve and resume: A and B replay from cache (no new prompt, no new live spend); only the
    // edited synthesis lane re-runs, and it now succeeds.
    const resumeOutput = await runApprovedRequest(tools, context, { resumeRunId: runId, source: edited, editAndResume: true });
    assert.match(resumeOutput, /completed/, "the resumed run must complete after the synthesis-lane edit");

    const resumed = await statusByName(tools, context, name);
    assert.equal(resumed.status, "completed");
    assert.equal(resumed.cacheStats.hits, 2, "unchanged upstream lanes A and B replay from cache");
    assert.equal(calls.prompt.length - promptsBeforeResume, 1, "only the edited synthesis lane re-runs");
    assert.ok(resumed.usage.replayedCost > 0, `replayedCost should be > 0, got ${resumed.usage.replayedCost}`);
    assert.equal(resumed.usage.liveCost, 0.01, "live cost is only the single re-run lane (A and B re-spend 0)");
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("jbs3.3: editing an upstream lane re-runs that lane and its dependent while the unrelated lane is reused", async () => {
  // Lanes: A and B (independent), S (synthesis: embeds A's and B's results), T (tail). T carries a
  // BREAK_ marker so the FIRST run fails there with A, B, and S already complete -> a resumable run
  // whose dependent lane S is cached as a SUCCESS. The edit changes lane A's prompt AND clears the
  // tail break. Because A's echoed result feeds S's prompt, the dependent S re-keys and re-runs even
  // though S's own body text is unchanged; the unrelated lane B replays from cache.
  const { tools, context, directory, calls } = await makeHarness(editResumePrompt());
  try {
    const name = "edit-resume-dependent";
    const original = `export const meta = { name: ${JSON.stringify(name)}, profile: "read-only-review", maxAgents: 5 };
const a = await agent("research lane-A vA");
const b = await agent("research lane-B stable");
const s = await agent("synthesize from " + a + " and " + b);
const t = await agent("tail lane BREAK_TAIL");
return { a, b, s, t };`;

    // First run: A, B, S complete; the tail lane throws -> resumable "failed" with 3 lanes cached.
    await assert.rejects(runApprovedRequest(tools, context, { source: original }), /lane boom/);
    const failed = await statusByName(tools, context, name);
    const runId = failed.id;
    assert.equal(failed.status, "failed");
    assert.equal(failed.laneOutcomes.success, 3, "A, B, and S all complete before the tail lane fails");
    assert.equal(failed.laneOutcomes.failure, 1);
    const promptsBeforeResume = calls.prompt.length; // A, B, S, and the failed tail attempt = 4

    // Edit lane A's prompt and clear the tail break. A's resolved prompt changes (re-run) and so does
    // its echoed result, so the dependent synthesis lane S re-keys and re-runs; the tail lane re-runs
    // because its prior outcome was a failure; only the unrelated lane B replays from cache.
    const edited = `export const meta = { name: ${JSON.stringify(name)}, profile: "read-only-review", maxAgents: 5 };
const a = await agent("research lane-A vA-EDITED");
const b = await agent("research lane-B stable");
const s = await agent("synthesize from " + a + " and " + b);
const t = await agent("tail lane FIXED_TAIL");
return { a, b, s, t };`;
    const resumeOutput = await runApprovedRequest(tools, context, { resumeRunId: runId, source: edited, editAndResume: true });
    assert.match(resumeOutput, /completed/);

    const resumed = await statusByName(tools, context, name);
    assert.equal(resumed.status, "completed");
    assert.equal(resumed.cacheStats.hits, 1, "only the unrelated lane B is reused");
    assert.equal(calls.prompt.length - promptsBeforeResume, 3, "edited lane A, its dependent S, and the fixed tail all re-run");
    assert.equal(resumed.usage.liveCost, 0.03, "live cost is exactly the three re-run lanes (A + dependent S + tail)");
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("mfv9.14: inserted upstream lane reuses shifted edit lane by signature and retags the diff plan", async () => {
  const patchSchema = {
    type: "object",
    additionalProperties: false,
    properties: {
      patches: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            path: { type: "string" },
            content: { type: "string" },
          },
          required: ["path", "content"],
        },
      },
    },
    required: ["patches"],
  };
  const promptTexts = [];
  const { tools, context, directory, calls } = await makeHarness(async (input) => {
    const text = input.body.parts.map((part) => part.text).join("\n");
    promptTexts.push(text);
    if (text.includes("BREAK_TAIL")) throw new Error("tail boom");
    if (text.includes("edit stable")) {
      return { data: { parts: [{ type: "text", text: JSON.stringify({ patches: [{ path: "shifted-edit.txt", content: "patched\n" }] }) }], info: {
        structured: { patches: [{ path: "shifted-edit.txt", content: "patched\n" }] },
        tokens: { input: 1, output: 1, reasoning: 0 },
        cost: 0.01,
      } } };
    }
    return { data: { parts: [{ type: "text", text: `ok:${text}` }], info: { tokens: { input: 1, output: 1, reasoning: 0 }, cost: 0.01 } } };
  });
  try {
    await initGitRepo(directory);
    const name = "signature-fallback-shifted-edit";
    const original = `export const meta = { name: ${JSON.stringify(name)}, authority: { edit: true }, maxAgents: 5 };
const editResult = await agent("edit stable", { edit: true, schema: ${JSON.stringify(patchSchema)} });
await agent("tail BREAK_TAIL");
return editResult;`;

    await assert.rejects(runApprovedRequest(tools, context, { source: original }), /tail boom/);
    const failed = await statusByName(tools, context, name);
    const runId = failed.id;
    assert.equal(failed.status, "failed");
    assert.equal(calls.prompt.length, 2, "first run prompts edit and failing tail lanes");

    const edited = `export const meta = { name: ${JSON.stringify(name)}, authority: { edit: true }, maxAgents: 5 };
await agent("inserted upstream lane");
const editResult = await agent("edit stable", { edit: true, schema: ${JSON.stringify(patchSchema)} });
await agent("tail FIXED_TAIL");
return editResult;`;

    const resumeOutput = await runApprovedRequest(tools, context, { resumeRunId: runId, source: edited, editAndResume: true });
    assert.match(resumeOutput, /awaiting diff approval/);
    assert.equal(calls.prompt.length, 4, "resume prompts only inserted and fixed tail lanes");
    assert.equal(promptTexts.filter((text) => text.includes("edit stable")).length, 1, "shifted edit lane must not rerun");

    const resumed = await statusByName(tools, context, name);
    assert.equal(resumed.status, "awaiting-diff-approval");
    assert.equal(resumed.cacheStats.hits, 1, "shifted edit lane is served by signature fallback");

    const state = JSON.parse(await fs.readFile(path.join(resumed.dir, "state.json"), "utf8"));
    assert.deepEqual(state.editPlan.patches.map((patch) => patch.callId), ["root/agent:1"]);
    assert.equal(state.editPlan.patches[0].path, "shifted-edit.txt");
    assert.equal(state.editWorktrees[0].callId, "root/agent:1", "rehydrated edit worktree is retagged with the shifted callId");

    const events = (await fs.readFile(path.join(resumed.dir, "events.jsonl"), "utf8"))
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    const signatureHit = events.find((event) => event.type === "cache.signature_hit");
    assert.ok(signatureHit, "signature fallback event must be observable");
    assert.equal(signatureHit.callId, "root/agent:1");
    assert.equal(signatureHit.originalCallId, "root/agent:0");
    assert.equal(signatureHit.retaggedPlan.editPatches, 1);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("jbs3.3: edit-and-resume guardrails — opt-in is required and misuse is rejected", async () => {
  const { tools, context, directory } = await makeHarness(editResumePrompt());
  try {
    const name = "edit-resume-guardrails";
    const original = EDIT_RESUME_SOURCE({ name, synthMarker: "BREAK_SYNTH" });
    await assert.rejects(runApprovedRequest(tools, context, { source: original }), /lane boom/);
    const runId = (await statusByName(tools, context, name)).id;
    const edited = EDIT_RESUME_SOURCE({ name, synthMarker: "FIXED_SYNTH" });

    // Without the opt-in, a body swap on resume stays rejected by the whole-run source-hash gate.
    await assert.rejects(
      tools.workflow_run.execute({ resumeRunId: runId, source: edited }, context),
      /resumeRunId source hash mismatch/,
    );
    // editAndResume requires resumeRunId.
    await assert.rejects(
      tools.workflow_run.execute({ source: edited, editAndResume: true }, context),
      /editAndResume requires resumeRunId/,
    );
    // editAndResume requires the edited body (no implicit reuse of the persisted script).
    await assert.rejects(
      tools.workflow_run.execute({ resumeRunId: runId, editAndResume: true }, context),
      /editAndResume requires the edited body/,
    );
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
