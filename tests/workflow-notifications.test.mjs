// Workflow notification delivery/recovery and toast-card regression suite.
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
  assert.ok(toastCalls.every((body) => !/agents \d+ active|usage \$/.test(body.message)), "legacy flat toast body leaked");
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
test("workflow notification timeout clears sending state and remains recoverable in status", async () => {
  const { tools, context, directory } = await makeHarness(async () => ({ data: { parts: [], info: {} } }));
  try {
    const runId = "33333333-3333-4333-8333-333333333333";
    const root = runRoot(context);
    const dir = runDirForRoot(root, runId);
    const notificationPath = path.join(dir, "notification.json");
    await fs.mkdir(dir, { recursive: true });
    await writeJsonAtomic(path.join(dir, "state.json"), { id: runId, status: "completed", notification: { notificationPath } });
    await writeJsonAtomic(notificationPath, {
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
    pendingNotificationPaths.add(notificationPath);

    const result = await deliverWorkflowNotifications({ __workflowNotificationTimeoutMs: 1, client: { session: { promptAsync: async () => await new Promise(() => {}) } } }, { type: "session.idle", properties: { sessionID: "parent-session" } });
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

    const notification = await writeCompletionNotification(run);
    assert.match(notification.errorSummary, /\[REDACTED:secret\]/);
    assert.doesNotMatch(notification.errorSummary, new RegExp(secret));
    assert.doesNotMatch(workflowNotificationPrompt(notification), new RegExp(secret));
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
    await writeJsonAtomic(notificationPath, {
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
    pendingNotificationPaths.add(notificationPath);

    const result = await deliverWorkflowNotifications({ client: { session: { promptAsync: async () => ({ data: { id: "async-1" } }) } } }, { type: "session.idle", properties: { sessionID: "parent-session" } });
    const record = JSON.parse(await fs.readFile(notificationPath, "utf8"));

    assert.equal(result.delivered, 1);
    assert.equal(record.delivery.attempts, 2);
    assert.equal(record.delivery.sendingAt, null);
    assert.equal(record.delivery.lastError, null);
    assert.equal(typeof record.delivery.staleAt, "string");
    assert.ok(record.sentAt);
  } finally {
    pendingNotificationPaths.delete(notificationPath);
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("notification sending staleness covers boundary and invalid timestamps", () => {
  const nowMs = Date.parse("2026-06-16T00:01:00.000Z");

  assert.equal(notificationSendingIsStale({ delivery: { sendingAt: null } }, nowMs), false);
  assert.equal(notificationSendingIsStale({ delivery: { sendingAt: "not-a-date" } }, nowMs), false);
  assert.equal(
    notificationSendingIsStale({ delivery: { sendingAt: "2026-06-16T00:00:00.001Z" } }, nowMs),
    false,
  );
  assert.equal(
    notificationSendingIsStale({ delivery: { sendingAt: "2026-06-16T00:00:00.000Z" } }, nowMs),
    true,
  );
});

test("workflow notification with not-yet-stale sending state is skipped", async () => {
  const directory = await tempDir();
  const notificationPath = path.join(directory, "notification.json");
  const sendingAt = new Date().toISOString();
  let promptCalls = 0;
  try {
    await writeJsonAtomic(notificationPath, {
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
    pendingNotificationPaths.add(notificationPath);

    const result = await deliverWorkflowNotifications({ client: { session: { promptAsync: async () => { promptCalls += 1; return { data: { id: "unexpected" } }; } } } }, { type: "session.idle", properties: { sessionID: "parent-session" } });
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
    pendingNotificationPaths.delete(notificationPath);
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("concurrent notification delivery sends the completion prompt exactly once", async () => {
  const directory = await tempDir();
  const notificationPath = path.join(directory, "notification.json");
  const savedDelivering = new Set(deliveringNotificationPaths);
  deliveringNotificationPaths.clear();
  try {
    await writeJsonAtomic(notificationPath, {
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
    pendingNotificationPaths.add(notificationPath);

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
      deliverWorkflowNotifications(pluginContext, idleEvent),
      deliverWorkflowNotifications(pluginContext, idleEvent),
    ]);

    assert.equal(promptCalls, 1, "completion prompt is sent exactly once across concurrent callers");
    assert.equal(first.delivered + second.delivered, 1, "exactly one caller records the delivery");
    assert.equal(first.skipped + second.skipped, 1, "the losing caller skips the in-flight record");

    const record = JSON.parse(await fs.readFile(notificationPath, "utf8"));
    assert.equal(typeof record.sentAt, "string");
    assert.equal(record.delivery.attempts, 1, "the record is only attempted once");
    assert.equal(record.delivery.sendingAt, null);
    assert.equal(deliveringNotificationPaths.size, 0, "the in-process mutex is released");
  } finally {
    pendingNotificationPaths.delete(notificationPath);
    deliveringNotificationPaths.clear();
    for (const entry of savedDelivering) deliveringNotificationPaths.add(entry);
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("updateNotificationIdleState clears the idle flag on any non-status activity event", () => {
  const sessionID = "idle-clear-session";
  const savedIdle = new Set(idleNotificationSessions);
  idleNotificationSessions.clear();
  try {
    // An idle event flags the session as idle.
    updateNotificationIdleState({ type: "session.idle", properties: { sessionID } });
    assert.equal(idleNotificationSessions.has(sessionID), true, "idle event flags the session");

    // A non-status activity event carrying the sessionID must clear the idle flag.
    // Regression for R24: previously only a session.status event cleared it, so a
    // session whose idle->active transition arrived via another event type stayed
    // falsely flagged and a later completion delivered a continuation prompt into a
    // possibly-busy session.
    updateNotificationIdleState({ type: "message.updated", properties: { sessionID } });
    assert.equal(idleNotificationSessions.has(sessionID), false, "non-status activity clears the idle flag");

    // A different active event shape (sessionID nested under message.info) also clears.
    updateNotificationIdleState({ type: "session.idle", properties: { sessionID } });
    assert.equal(idleNotificationSessions.has(sessionID), true);
    updateNotificationIdleState({ type: "message.part.updated", properties: { message: { info: { sessionID } } } });
    assert.equal(idleNotificationSessions.has(sessionID), false, "nested-sessionID activity clears the idle flag");

    // A non-idle session.status event still clears (no regression on the original path).
    updateNotificationIdleState({ type: "session.idle", properties: { sessionID } });
    assert.equal(idleNotificationSessions.has(sessionID), true);
    updateNotificationIdleState({ type: "session.status", properties: { sessionID, status: "active" } });
    assert.equal(idleNotificationSessions.has(sessionID), false, "non-idle session.status still clears");

    // An event without a resolvable sessionID is a no-op (no spurious deletes/adds).
    updateNotificationIdleState({ type: "session.idle", properties: { sessionID } });
    assert.equal(idleNotificationSessions.has(sessionID), true);
    updateNotificationIdleState({ type: "message.updated", properties: {} });
    assert.equal(idleNotificationSessions.has(sessionID), true, "event without a sessionID leaves other sessions flagged");
  } finally {
    idleNotificationSessions.clear();
    for (const entry of savedIdle) idleNotificationSessions.add(entry);
  }
});

test("notification runtime tracking is bounded and cleared on plugin dispose", async () => {
  const savedPending = new Set(pendingNotificationPaths);
  const savedDelivering = new Set(deliveringNotificationPaths);
  const savedIdle = new Set(idleNotificationSessions);
  pendingNotificationPaths.clear();
  deliveringNotificationPaths.clear();
  idleNotificationSessions.clear();
  try {
    for (let i = 0; i < NOTIFICATION_TRACKING_MAX + 5; i += 1) {
      pendingNotificationPaths.add(`/tmp/notification-${i}.json`);
      idleNotificationSessions.add(`session-${i}`);
    }
    deliveringNotificationPaths.add("/tmp/in-flight-notification.json");

    assert.equal(pendingNotificationPaths.size, NOTIFICATION_TRACKING_MAX);
    assert.equal(pendingNotificationPaths.has("/tmp/notification-0.json"), false);
    assert.equal(idleNotificationSessions.size, NOTIFICATION_TRACKING_MAX);
    assert.equal(idleNotificationSessions.has("session-0"), false);

    const hooks = await workflowPlugin({ client: {} }, { extensions: [] });
    assert.equal(typeof hooks.dispose, "function");
    await hooks.dispose();
    assert.equal(pendingNotificationPaths.size, 0);
    assert.equal(deliveringNotificationPaths.size, 0);
    assert.equal(idleNotificationSessions.size, 0);
  } finally {
    pendingNotificationPaths.clear();
    deliveringNotificationPaths.clear();
    idleNotificationSessions.clear();
    for (const entry of savedPending) pendingNotificationPaths.add(entry);
    for (const entry of savedDelivering) deliveringNotificationPaths.add(entry);
    for (const entry of savedIdle) idleNotificationSessions.add(entry);
  }
});

test("workflow notifications rehydrate from persisted run roots after simulated plugin restart", async () => {
  const project = await tempDir();
  // Simulate a fresh plugin/module instance: the in-memory pending queue starts empty
  // even though unsent notification.json records remain on disk. Snapshot+restore so
  // the shared singleton does not leak state into other tests in this process.
  const savedPending = new Set(pendingNotificationPaths);
  pendingNotificationPaths.clear();
  try {
    const root = runRoot({ directory: project, worktree: project });

    const unsentDir = runDirForRoot(root, "11111111-1111-4111-8111-111111111111");
    const unsentPath = path.join(unsentDir, "notification.json");
    await fs.mkdir(unsentDir, { recursive: true });
    await writeJsonAtomic(unsentPath, {
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
    const sentDir = runDirForRoot(root, "22222222-2222-4222-8222-222222222222");
    const sentPath = path.join(sentDir, "notification.json");
    await fs.mkdir(sentDir, { recursive: true });
    await writeJsonAtomic(sentPath, {
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
    const malformedDir = runDirForRoot(root, "33333333-3333-4333-8333-333333333333");
    await fs.mkdir(malformedDir, { recursive: true });
    await fs.writeFile(path.join(malformedDir, "notification.json"), "{ not valid json", "utf8");

    // Unrelated session: skipped because delivery is scoped to the idle session.
    const unrelatedDir = runDirForRoot(root, "44444444-4444-4444-8444-444444444444");
    const unrelatedPath = path.join(unrelatedDir, "notification.json");
    await fs.mkdir(unrelatedDir, { recursive: true });
    await writeJsonAtomic(unrelatedPath, {
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

    assert.equal(pendingNotificationPaths.size, 0, "simulated restart leaves in-memory queue empty");

    const pluginContext = {
      directory: project,
      worktree: project,
      client: { session: { promptAsync: async () => ({ data: { id: "async-rehydrate-1" } }) } },
    };
    const idleEvent = { type: "session.idle", properties: { sessionID: "parent-session" } };

    const rehydrateResult = await rehydratePendingNotifications(pluginContext, idleEvent);
    assert.equal(rehydrateResult.rehydrated, 1, "only the unsent matching record is rehydrated");
    assert.equal(rehydrateResult.skipped, 3, "sent + malformed + unrelated records are skipped");
    assert.deepEqual([...pendingNotificationPaths], [unsentPath]);

    const deliverResult = await deliverWorkflowNotifications(pluginContext, idleEvent);
    assert.equal(deliverResult.delivered, 1);
    const delivered = JSON.parse(await fs.readFile(unsentPath, "utf8"));
    assert.equal(typeof delivered.sentAt, "string");
    assert.equal(delivered.delivery.attempts, 1);
    const stillSent = JSON.parse(await fs.readFile(sentPath, "utf8"));
    assert.equal(stillSent.sentAt, "2026-06-16T00:00:00.000Z");
    assert.equal(stillSent.delivery.attempts, 1, "already-sent record is untouched");
    assert.equal(pendingNotificationPaths.size, 0, "queue drains after successful delivery");

    // Idempotent re-delivery: a subsequent idle event must not resend the now-sent record.
    const secondDeliver = await deliverWorkflowNotifications(pluginContext, idleEvent);
    assert.equal(secondDeliver.delivered, 0);
    const secondRehydrate = await rehydratePendingNotifications(pluginContext, idleEvent);
    assert.equal(secondRehydrate.rehydrated, 0);
  } finally {
    pendingNotificationPaths.clear();
    for (const entry of savedPending) pendingNotificationPaths.add(entry);
    await fs.rm(project, { recursive: true, force: true });
  }
});
