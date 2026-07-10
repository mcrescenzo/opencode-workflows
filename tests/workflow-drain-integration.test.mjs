// Drain + integration-mode regression suite.
//
// Mechanically split out of tests/workflow-run.test.mjs
// (bd opencode-workflows-fnop.19 / -fnop.20). Pure mechanical move; test names and assertions
// preserved verbatim. End-to-end harness coverage (real workflow_run tool via makeHarness)
// is retained where the original tests used it.

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

test("configured drain extensions can stage domain mutations for finalization after workflow_apply", async () => {
  const extensionDir = await makeExtensionDir("wf-staged-domain-");
  const markerPath = path.join(extensionDir, "finalized.jsonl");
  const extensionSource = `import { appendFile } from "node:fs/promises";

export default {
  id: "staged-domain-fixture",
  assetDirs: { workflows: "./workflows" },
  drainAdapters: {
    staged: {
      supportsAutoApply: false,
      mutationOperations: ["fixture.close"],
      createAdapter: ({ stageDomainMutation }) => {
        let closed = false;
        const item = { id: "item-1", title: "stage one mutation", status: "open", issue_type: "task" };
        return {
          name: "staged",
          async discover() { return closed ? [] : [item]; },
          async classify() { return { status: "ready", reason: "fixture ready" }; },
          async claim() { return { id: item.id, status: "in_progress" }; },
          async buildLanePacket() { return { item, instructions: ["write the requested fixture file"] }; },
          async validate(_item, integrationState) {
            return {
              itemId: item.id,
              accepted: integrationState.status === "integrated",
              reason: "fixture accepted",
              diffScopeOk: true,
              followupsHandled: true,
              acceptanceChecklist: ["fixture patch integrated"],
              validationCommands: ["fixture validation"],
              followups: [],
            };
          },
          async close() {
            await stageDomainMutation({
              mutationKey: "fixture-close:item-1",
              operation: "fixture.close",
              payload: { issueId: item.id, markerPath: ${JSON.stringify(markerPath)} },
            });
            closed = true;
            return { id: item.id, status: "staged-close" };
          },
          async createFollowup() { throw new Error("fixture followups are not expected"); },
          async proveDry() { return { dry: closed }; },
        };
      },
    },
  },
  mutationHandlers: {
    "fixture.close": async ({ operation, idempotencyKey, issueId, markerPath }) => {
      await appendFile(markerPath, JSON.stringify({ operation, idempotencyKey, issueId }) + "\\n", "utf8");
      return { issueId, status: "closed" };
    },
  },
};
`;
  const workflowSource = `export const meta = { name: "staged-domain-drain", harness: "drain", adapter: "staged", profile: "drain-autonomous-local", maxAgents: 1 };
return await drain({ adapter: "staged", dryRun: false, maxWaves: 2, maxAttempts: 1 });`;
  const extensionPath = await writeFakeExtension(extensionDir, {
    source: extensionSource,
    assetDirs: { workflows: "./workflows" },
    workflows: { "staged-domain-drain": workflowSource },
  });
  const { tools, context, directory } = await makeHarness(portPrompt({
    writeFile: { name: "staged-domain-change.txt", body: "applied before domain finalization\n" },
  }), { extensions: [extensionPath] });
  try {
    await initGitRepo(directory);
    const output = await runApprovedRequest(tools, context, {
      name: "staged-domain-drain",
      args: { mode: "autonomous-local" },
      background: false,
    });
    const runId = runIdFrom(output);
    const status = JSON.parse(await tools.workflow_status.execute({ runId, format: "json", detail: "full" }, context));

    assert.equal(status.status, "awaiting-diff-approval");
    assert.equal(status.editPlan.domainMutationManifest.length, 1);
    await assert.rejects(fs.access(markerPath), { code: "ENOENT" }, "the domain handler must not run before primary apply");

    const applied = await tools.workflow_apply.execute({
      runId,
      applyBundle: status.editPlan.applyBundle,
      approvalIntent: "apply",
    }, context);
    assert.match(applied, /applied 1 patches and finalized 1 domain mutations/);
    assert.equal(await fs.readFile(path.join(directory, "staged-domain-change.txt"), "utf8"), "applied before domain finalization\n");

    const records = (await fs.readFile(markerPath, "utf8")).trim().split(/\r?\n/).map((line) => JSON.parse(line));
    assert.equal(records.length, 1);
    assert.deepEqual(records[0], {
      operation: "fixture.close",
      idempotencyKey: domainMutationIdempotencyKey("fixture-close:item-1"),
      issueId: "item-1",
    });

    assert.match(await tools.workflow_apply.execute({ runId, applyBundle: status.editPlan.applyBundle, approvalIntent: "apply" }, context), /already applied/);
    assert.equal((await fs.readFile(markerPath, "utf8")).trim().split(/\r?\n/).length, 1, "replay must not duplicate the mutation");
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
    await fs.rm(extensionDir, { recursive: true, force: true });
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
    await runs.get(backgroundRunId)?.done;
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
    const root = runRoot(context);
    const dir = runDirForRoot(root, runId);
    await fs.mkdir(dir, { recursive: true });
    await writeJsonAtomic(path.join(dir, "state.json"), {
      id: runId,
      status: "review-required",
      sourcePath: "<inline>",
      sourceHash: hash("return true;"),
      meta: { name: "integration-conflict-status" },
      authority: resolveRunAuthority({ authority: { integration: true } }, {}),
      startedAt: new Date(0).toISOString(),
      agentsStarted: 2,
      maxAgents: 2,
      concurrency: 2,
      laneOutcomes: {},
      droppedLaneCount: 0,
      capabilities: {},
      diagnostics: {},
      integrationPlan: {
        sourceHash: hash("return true;"),
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

