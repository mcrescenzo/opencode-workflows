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
import { metaDiagnostics, validateMeta, laneBlueprint, collectDiagnostics, validateMetaLanes } from "../workflow-kernel/workflow-source.js";
import { WORKFLOW_INSPECT_TOOLS, WORKFLOW_MUTATING_TOOLS } from "../workflow-kernel/authority-policy.js";
import {
  assertKnownAgentOptions,
  authorityAutoApproveTier,
  authoritySummary,
  autoApproveCovers,
  effectiveAutoApproveCeiling,
  normalizeAgentOptions,
  resolveLaneModel,
  resolveLanePolicy,
  resolveRunAuthority,
  toolAuthority,
} from "../workflow-kernel/authority-policy.js";
import { approvalHash } from "../workflow-kernel/approval-hashing.js";
import { buildNestedSnapshots, parseWorkflowSource, projectWorkflowDir, staticNestedWorkflowRefs } from "../workflow-kernel/workflow-source.js";
import { acquireWorkflowLock, lockPathForRun } from "../workflow-kernel/run-store-locks.js";
import { compactStatusForEntry, summarizeEntries } from "../workflow-kernel/run-store-status-format.js";
import { DEFAULT_TEMPLATES, listTemplates } from "../workflow-kernel/role-template-loading.js";
import {
  deliveringNotificationPaths,
  deliverWorkflowNotifications,
  idleNotificationSessions,
  notificationSendingIsStale,
  NOTIFICATION_TRACKING_MAX,
  pendingNotificationPaths,
  rehydratePendingNotifications,
  updateNotificationIdleState,
  workflowNotificationPrompt,
  writeCompletionNotification,
} from "../workflow-kernel/lifecycle-control.js";
import { domainMutationIdempotencyKey } from "../workflow-kernel/event-journal.js";
import { hash } from "../workflow-kernel/text-json.js";
import { MAX_INLINE_RESULT_BYTES, MAX_RESULT_BYTES, MAX_RESULT_READBACK_BYTES, MAX_SOURCE_BYTES, MAX_STATUS_STRING_CHARS } from "../workflow-kernel/constants.js";
import { runDirForRoot, runRoot, runs, selfProcessStartTime, writeJsonAtomic } from "../workflow-kernel/run-store-fs.js";
import { __setWriteStateTestHook } from "../workflow-kernel/run-store-state.js";
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
  const readOnly = resolveRunAuthority({ profile: "read-only-review" }, {});
  assert.equal(readOnly.profile, "read-only-review");
  assert.equal(readOnly.readOnly, true);
  assert.equal(readOnly.shell, false);
  assert.equal(Object.hasOwn(readOnly, "requiredGates"), false);

  const shell = resolveRunAuthority({ profile: "inspect-with-shell" }, {});
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

  const editPlan = resolveRunAuthority({ profile: "edit-plan-only" }, {});
  assert.equal(editPlan.profile, "edit-plan-only");
  assert.equal(editPlan.worktreeEdit, true);
  assert.equal(editPlan.edit, false);
  assert.equal(editPlan.editGate, "requires workflow_apply approval before primary writes");
  assert.equal(Object.hasOwn(editPlan, "requiredGates"), false);

  const applyApproved = resolveRunAuthority({ profile: "apply-approved-plan" }, {});
  assert.equal(applyApproved.profile, "apply-approved-plan");
  assert.equal(applyApproved.edit, true);
  assert.equal(applyApproved.editGate, "requires workflow_apply approval before primary writes");
  assert.equal(Object.hasOwn(applyApproved, "requiredGates"), false);

  const drainLocal = resolveRunAuthority({ profile: "drain-autonomous-local" }, {});
  assert.equal(drainLocal.profile, "drain-autonomous-local");
  assert.equal(drainLocal.integration, true);
  assert.equal(drainLocal.network, false);
  assert.equal(drainLocal.mcp, false);
  assert.equal(Object.hasOwn(drainLocal, "requiredGates"), false);

  const drainDry = resolveRunAuthority({ profile: "drain-dry-run" }, {});
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

  async function launchApplyApprovedPlan(tools, context, name) {
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
      launchApplyApprovedPlan(first.tools, first.context, "memo-1"),
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
      launchApplyApprovedPlan(second.tools, second.context, "memo-2"),
      /requires opencode server >= /,
    );

    // Clearing the cache forces a fresh health read on the next launch against the same
    // serverUrl, which now resolves to the (still-forced) good version and succeeds.
    __resetFingerprintCacheForTests();
    const output = await launchApplyApprovedPlan(second.tools, second.context, "memo-3");
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
  const authority = resolveRunAuthority({ authority: { shell: true } }, {});
  assert.equal(authority.profile, "ad-hoc");
  assert.equal(authority.shell, true);
  assert.deepEqual(authority.shellPolicy, { allow: ["*"], deny: [] });
});

test("MCP authority emits pattern-scoped permission rules", () => {
  const authority = resolveRunAuthority({
    authority: { readOnly: true, mcpPolicy: { allow: ["mcp__docs_*"], deny: ["mcp__docs_delete"] } },
  }, {});

  assert.equal(authority.mcp, true);
  assert.deepEqual(authority.mcpPolicy, { allow: ["mcp__docs_*"], deny: ["mcp__docs_delete"] });
  assert.match(authoritySummary(authority), /mcpPolicy=allow:1,deny:1/);

  const mcpRules = permissionRulesForAuthority(authority).filter((rule) => rule.permission === "mcp");
  assert.deepEqual(mcpRules, [
    { permission: "mcp", pattern: "mcp__docs_*", action: "allow" },
    { permission: "mcp", pattern: "mcp__docs_delete", action: "deny" },
  ]);
  assert.equal(mcpRules.some((rule) => rule.pattern === "*" && rule.action === "allow"), false);
});

test("MCP authority accepts mcp object shorthand", () => {
  const authority = resolveRunAuthority({
    authority: { mcp: { allow: ["mcp__kb_read"], deny: ["mcp__kb_write"] } },
  }, {});

  assert.equal(authority.mcp, true);
  assert.deepEqual(authority.mcpPolicy, { allow: ["mcp__kb_read"], deny: ["mcp__kb_write"] });
});

test("lane MCP policy narrows run authority without escalating", () => {
  const runAuthority = resolveRunAuthority({
    authority: { mcpPolicy: { allow: ["mcp__docs_*"], deny: ["mcp__docs_delete"] } },
  }, {});
  const run = { authority: runAuthority, capabilities: { permissions: "available" } };

  const policy = resolveLanePolicy(run, {
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
    () => resolveLanePolicy(run, { mcpPolicy: { allow: ["mcp__secrets_*"] } }),
    /exceeds approved workflow mcpPolicy/,
  );
});

test("readOnly lane erases MCP policy even when MCP is requested", () => {
  const runAuthority = resolveRunAuthority({
    authority: { mcpPolicy: { allow: ["mcp__docs_*"], deny: ["mcp__docs_delete"] } },
  }, {});
  const run = { authority: runAuthority, capabilities: { permissions: "available" } };

  const policy = resolveLanePolicy(run, {
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
  const authority = resolveRunAuthority(
    { profile: "inspect-with-shell", authority: { shell: { allow: ["*"], deny: [] } } },
    {},
  );

  assert.match(authoritySummary(authority), /shellPolicy=UNRESTRICTED\(\*\)/);
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
  const authority = resolveRunAuthority({ profile: "inspect-with-shell" }, {});
  const rules = permissionRulesForAuthority(authority);

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
  const authority = resolveRunAuthority({ profile: "inspect-with-shell" }, {});
  const rules = permissionRulesForAuthority(authority);
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
  const override = resolveRunAuthority(
    { profile: "inspect-with-shell", authority: { shell: { allow: ["echo *"], deny: ["echo secret"] } } },
    {},
  );
  assert.deepEqual(override.shellPolicy.allow, ["echo *"]);
  assert.deepEqual(override.shellPolicy.deny, ["echo secret"]);
  // The audited deny patterns are NOT injected when an explicit override is present.
  const rules = permissionRulesForAuthority(override);
  assert.equal(bashRuleAction(rules, "echo hello"), "allow");
  assert.equal(bashRuleAction(rules, "echo secret"), "deny");
  // A non-overridden inspect-with-shell run still uses the audited list (regression guard).
  const audited = resolveRunAuthority({ profile: "inspect-with-shell" }, {});
  assert.ok(audited.shellPolicy.allow.includes("git ls-files"));
  assert.ok(!audited.shellPolicy.allow.includes("echo *"));
});

test("inspect-with-shell does not grant unrestricted bash wildcard", () => {
  const authority = resolveRunAuthority({ profile: "inspect-with-shell" }, {});
  assert.ok(!authority.shellPolicy.allow.includes("*"), "no unrestricted bash allow");
  // An arbitrary non-allowlisted command falls through to the catch-all deny.
  const rules = permissionRulesForAuthority(authority);
  assert.equal(bashRuleAction(rules, "python3 -c 'print(1)'"), "deny");
});

test("secret globs deny read, grep, glob, list, and lsp lane permissions (R21)", () => {
  const rules = permissionRulesForAuthority({ readOnly: true });
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
  const rules = permissionRulesForAuthority({ readOnly: true }, ["**/custom-secret.json", "**/custom-secret.json"]);

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

  const policy = resolveLanePolicy(run);
  for (const tool of childTools) {
    assert.equal(policy.tools[tool], false, tool);
    assert.equal(toolAuthority(tool), "delegation", tool);
    assert.ok(policy.permissionRules.some((rule) => rule.permission === tool && rule.pattern === "*" && rule.action === "deny"), tool);
  }
  for (const permission of childPermissions) {
    assert.ok(policy.permissionRules.some((rule) => rule.permission === permission && rule.pattern === "*" && rule.action === "deny"), permission);
  }
  assert.throws(
    () => resolveLanePolicy(run, { tools: { oc_prompt: true } }),
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
  const networkFlag = resolveLanePolicy(run, { readOnly: true, network: true });
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
    const policy = resolveLanePolicy(run, { readOnly: true, [dimension]: true });
    assert.equal(policy.authority.readOnly, true, dimension);
    assert.equal(policy.authority[dimension], false, dimension);
    assert.equal(policy.mode, "readOnly", dimension);
  }

  // Escalation passed via the tools map under readOnly is stripped (not a throw).
  const toolsMap = resolveLanePolicy(run, {
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
  const escalated = resolveLanePolicy(run, { network: true });
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
    () => resolveLanePolicy(lowRun, { network: true }),
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

  const policy = resolveLanePolicy(run, { readOnly: true });
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
  const integrationLane = resolveLanePolicy(run, { worktreeEdit: true });
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

  const policy = resolveLanePolicy(run, {});

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
  const worktreeLane = resolveLanePolicy(run, { worktreeEdit: true });
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
  const drain = resolveRunAuthority({ profile: "drain-autonomous-local" }, {});
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
  const adHoc = resolveRunAuthority({ authority: { shell: true } }, {});
  const profiled = resolveRunAuthority({ profile: "inspect-with-shell" }, {});

  assert.equal(adHoc.shell, profiled.shell);
  assert.notEqual(
    approvalHash({ ...approval, authority: adHoc }),
    approvalHash({ ...approval, authority: profiled }),
  );
});

test("auto-approve tiers resolve from post-resolution authority and can only narrow", () => {
  assert.equal(authorityAutoApproveTier({ readOnly: true }), "readOnly");
  assert.equal(authorityAutoApproveTier({ readOnly: true, shell: true }), "readOnly");
  assert.equal(authorityAutoApproveTier({ worktreeEdit: true }), "worktree");
  assert.equal(authorityAutoApproveTier({ edit: true }), "worktree");
  assert.equal(authorityAutoApproveTier({ integration: true }), "all");
  assert.equal(authorityAutoApproveTier({ network: true }), "all");
  assert.equal(authorityAutoApproveTier({ mcp: true }), "all");

  assert.equal(effectiveAutoApproveCeiling(false, undefined), false);
  assert.equal(effectiveAutoApproveCeiling("all", undefined), "all");
  assert.equal(effectiveAutoApproveCeiling("all", "readOnly"), "readOnly");
  assert.equal(effectiveAutoApproveCeiling("readOnly", "all"), "readOnly");
  assert.equal(autoApproveCovers("worktree", "readOnly"), true);
  assert.equal(autoApproveCovers("readOnly", "worktree"), false);
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
    const root = runRoot(context);
    const dir = runDirForRoot(root, runId);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "script.js"), source, "utf8");
    await writeJsonAtomic(path.join(dir, "state.json"), {
      id: runId,
      status: "paused",
      sourcePath: "<inline>",
      sourceHash: hash(source),
      meta: { name: "resume-envelope", profile: "read-only-review", maxAgents: 10 },
      authority: resolveRunAuthority({ profile: "read-only-review" }, {}),
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
    // mnfx.2: the cost-ceiling caveat rides the preview whenever maxCost is set.
    assert.match(preview, /Cost-ceiling caveat:/);
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
    const root = runRoot(context);
    const dir = runDirForRoot(root, runId);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "script.js"), source, "utf8");
    await writeJsonAtomic(path.join(dir, "state.json"), {
      id: runId,
      status: "paused",
      sourcePath: "<inline>",
      sourceHash: hash(source),
      meta: { name: "resume-locked", profile: "read-only-review" },
      authority: resolveRunAuthority({ profile: "read-only-review" }, {}),
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
    const root = runRoot(context);
    const dir = runDirForRoot(root, runId);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "script.js"), source, "utf8");
    await writeJsonAtomic(path.join(dir, "state.json"), {
      id: runId,
      status: "paused",
      sourcePath: "<inline>",
      sourceHash: hash("export const meta = { name: 'tampered' };\nreturn false;"),
      meta: { name: "resume-hash" },
      authority: resolveRunAuthority({}, {}),
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
    const root = runRoot(context);
    const dir = runDirForRoot(root, runId);
    await fs.mkdir(dir, { recursive: true });
    await writeJsonAtomic(path.join(dir, "state.json"), {
      id: runId,
      status: "paused",
      sourcePath: "<inline>",
      sourceHash: hash("return true;"),
      meta: { name: "resume-missing-script" },
      authority: resolveRunAuthority({}, {}),
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
  const root = runRoot(context);
  const dir = runDirForRoot(root, runId);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "script.js"), source, "utf8");
  await writeJsonAtomic(path.join(dir, "state.json"), {
    id: runId,
    status: "interrupted",
    sourcePath: "<inline>",
    sourceHash: sourceHash ?? hash(source),
    meta: { name: "resume-model-pin", profile: "read-only-review" },
    authority: resolveRunAuthority({ profile: "read-only-review" }, {}),
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

test("resume without overrides preserves the approved runtime args, model tiers, and guest deadline", async () => {
  let promptAttempt = 0;
  const seenModels = [];
  const { tools, context, directory } = await makeHarness(async (input) => {
    promptAttempt += 1;
    const model = input?.body?.model;
    seenModels.push(model ? `${model.providerID}/${model.modelID}` : "none");
    if (promptAttempt === 1) {
      const error = new Error("first segment terminal lane failure");
      error.status = 400;
      throw error;
    }
    return { data: { parts: [{ type: "text", text: "recovered" }], info: { tokens: { input: 1, output: 1, reasoning: 0 }, cost: 0 } } };
  });
  try {
    const name = "resume-approved-envelope";
    const source = `export const meta = { name: ${JSON.stringify(name)}, profile: "read-only-review", maxAgents: 1 };
const lane = await agent("fail once, then recover", { tier: "deep", retryCount: 0 });
return { seen: args?.value ?? null, lane };`;
    const runtimeArgs = { value: "must-survive" };
    const childModel = "zai-coding-plan/glm-5.2";
    const modelTiers = { fast: childModel, deep: "zai-coding-plan/glm-5.2-max" };
    const guestDeadlineMs = 4_321;

    await assert.rejects(
      runApprovedRequest(tools, context, { source, args: runtimeArgs, childModel, modelTiers, guestDeadlineMs, background: false }),
      /first segment terminal lane failure/,
    );
    const failed = await statusByName(tools, context, name);
    assert.equal(failed.status, "failed");

    const preview = JSON.parse(await tools.workflow_run.execute({ resumeRunId: failed.id, format: "json" }, context));
    assert.match(preview.runtimeArgsPreview, /"value": "must-survive"/);
    assert.deepEqual(preview.modelPlan, { defaultChildModel: childModel, ...modelTiers });
    assert.equal(preview.laneBudget.guestDeadlineMs, guestDeadlineMs);

    const output = await tools.workflow_run.execute({ resumeRunId: failed.id, approve: true, approvalHash: preview.approvalHash }, context);
    const result = await readResult(output);
    assert.equal(result.output.seen, "must-survive");
    assert.equal(seenModels.at(-1), modelTiers.deep);
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
    // mnfx.2: no cost-ceiling caveat when maxCost is not set.
    assert.doesNotMatch(preview, /Cost-ceiling caveat:/);

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

// --- jbs3.10: input/output contracts ---------------------------------------------------------

test("jbs3.10: normalizeAgentOptions rejects a misspelled agent() opt and preserves valid ones", () => {
  // A typo'd opt would otherwise be silently dropped, leaving the lane on unintended defaults.
  assert.throws(() => normalizeAgentOptions({ onFailur: "returnNull" }), /Unknown agent\(\) option: onFailur/);
  assert.throws(() => normalizeAgentOptions({ readonly: true }), /Unknown agent\(\) option: readonly/);
  assert.throws(() => assertKnownAgentOptions({ foo: 1, bar: 2 }), /Unknown agent\(\) options: foo, bar/);
  // Every documented opt key stays accepted; label/phase are still stripped from the normalized value.
  const valid = { model: "v/m", tier: "fast", readOnly: true, edit: false, allowEdits: false, worktreeEdit: false,
    shell: false, allowShell: false, network: false, allowNetwork: false, mcp: false, allowMcp: false,
    mcpPolicy: { allow: ["mcp__docs_*"] }, tools: {}, secretGlobs: [], agent: "build", agentType: "build", role: "explorer", effort: "high", retryCount: 0, correctiveRetries: 1,
    schema: { type: "object" }, timeoutMs: 1000, system: "sys", onFailure: "returnNull",
    taskSummary: "t", summary: "s", label: "L", title: "T", phase: "p" };
  const normalized = normalizeAgentOptions(valid);
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
  const { tools, context, directory } = await makeHarness(async () => ({ data: { parts: [], info: {} } }));
  try {
    const source = `export const meta = { name: "shell-profile", profile: "inspect-with-shell" };
return true;`;

    const output = await runApproved(tools, context, source);
    assert.match(output, /completed/);

    const authority = resolveRunAuthority({ profile: "inspect-with-shell" }, {});
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




test("workflow_run resume fails clearly when an active run lock exists", async () => {
  const { tools, context, directory } = await makeHarness(async () => ({ data: { parts: [], info: {} } }));
  try {
    const runId = "locked-resume-run";
    const source = `export const meta = { name: "locked-resume" };
return "resumed";`;
    const root = runRoot(context);
    const dir = runDirForRoot(root, runId);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "script.js"), source, "utf8");
    await writeJsonAtomic(path.join(dir, "state.json"), { id: runId, status: "paused", sourceHash: hash(source), sourcePath: "<inline>" });
    await writeJsonAtomic(path.join(dir, "run.lock"), { operation: "run", runId, process: { pid: process.pid } });

    await assert.rejects(runApprovedRequest(tools, context, { resumeRunId: runId }), /Workflow run lock is already held \(active\)/);
  } finally {
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
  assert.equal(resolveLaneModel(run, { model: "openai/gpt-5.5", tier: "deep" }), "openai/gpt-5.5");
  // tier resolves from the map
  assert.equal(resolveLaneModel(run, { tier: "fast" }), "zai-coding-plan/glm-5.2");
  assert.equal(resolveLaneModel(run, { tier: "deep" }), "zai-coding-plan/glm-5.2-max");
  // tier with no map entry falls back to the default
  assert.equal(resolveLaneModel({ defaultChildModel: "openai/gpt-5.5" }, { tier: "deep" }), "openai/gpt-5.5");
  // no tier, no model => default (unchanged legacy behavior)
  assert.equal(resolveLaneModel(run, {}), "zai-coding-plan/glm-5.2");
  // invalid tier is a hard error
  assert.throws(() => resolveLaneModel(run, { tier: "medium" }), /tier/);
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

