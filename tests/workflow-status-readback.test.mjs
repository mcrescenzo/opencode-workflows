// Workflow status readback, projection, and next-actions regression suite.
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
test("workflow_status refuses result paths outside the run directory", async () => {
  const escapeRoot = await tempDir();
  const { tools, context, directory } = await makeHarness(async () => ({ data: { parts: [], info: {} } }));
  try {
    const runId = "forged-result-run";
    const root = runRoot(context);
    const dir = runDirForRoot(root, runId);
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
    const root = runRoot(context);
    const dir = runDirForRoot(root, runId);
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
  const savedPending = new Set(pendingNotificationPaths);
  pendingNotificationPaths.clear();
  try {
    const runId = "tampered-rehydrate-run";
    const root = runRoot(context);
    const dir = runDirForRoot(root, runId);
    const inRunNotificationPath = path.join(dir, "notification.json");
    const escapedPath = path.join(escapeRoot, "notification.json");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(escapedPath, JSON.stringify({ unused: true }), "utf8");
    // notification.json lives inside the run dir but its notificationPath is tampered to escape it.
    await writeJsonAtomic(inRunNotificationPath, {
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

    const summary = await rehydratePendingNotifications(
      { directory, worktree: directory },
      { type: "session.idle", properties: { sessionID: "parent-session" } },
    );

    assert.equal(summary.rehydrated, 0);
    assert.ok(summary.skipped >= 1);
    // The tampered out-of-run path must never enter the delivery queue.
    assert.equal(pendingNotificationPaths.has(escapedPath), false);
  } finally {
    pendingNotificationPaths.clear();
    for (const value of savedPending) pendingNotificationPaths.add(value);
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
return { marker: "large-inline-result", blob: "x".repeat(${MAX_INLINE_RESULT_BYTES + 2048}) };`;
    const output = await runApproved(tools, context, source);

    assert.match(output, /Result omitted from workflow_run: redacted JSON is \d+ bytes, above inline cap \d+\./);
    assert.match(output, /Read redacted result: workflow_status\(\{ runId: "[0-9a-f-]{36}", format: "json", detail: "result" \}\)/);
    assert.match(output, /Result file: /);
    assert.doesNotMatch(output, /x{1000}/);
    // mnfx.3: truncation resilience — the omitted branch has no JSON body, so every load-bearing
    // line trivially precedes it; still assert the readback line precedes the omission notice.
    const omittedIdx = output.indexOf("Result omitted from workflow_run");
    const fileIdx = output.indexOf("Result file:");
    const readbackIdx = output.indexOf("Read redacted result:");
    assert.ok(fileIdx !== -1 && readbackIdx !== -1 && omittedIdx !== -1);
    assert.ok(fileIdx < omittedIdx, "Result file: must precede the omission notice");
    assert.ok(readbackIdx < omittedIdx, "Read redacted result: must precede the omission notice");

    const status = JSON.parse(await tools.workflow_status.execute({ runId: runIdFrom(output), format: "json", detail: "result" }, context));
    assert.equal(status.result.output.marker, "large-inline-result");
    assert.equal(status.result.output.blob.length, MAX_INLINE_RESULT_BYTES + 2048);
    assert.equal(status.resultReadback.mode, "full");
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

// mnfx.3: the most load-bearing envelope fields (status/summary/stats/artifacts) are lifted into
// short plain lines that PRECEDE the raw redacted-JSON body, so client-side display truncation
// (which cuts the tail) can only ever cost the JSON dump — never the result pointer or readback.
test("workflow_run lifts status/summary/stats/artifacts ahead of the redacted JSON body", async () => {
  const { tools, context, directory } = await makeHarness(async () => ({ data: { parts: [], info: {} } }));
  try {
    const source = `export const meta = { name: "important-lines-first" };
return { status: "ok", summary: "hello", stats: { a: 1, b: 2 }, artifacts: { dir: "/tmp/x", files: ["r.md"] } };`;
    const output = await runApproved(tools, context, source);

    const jsonIdx = output.indexOf("Result (redacted JSON");
    assert.ok(jsonIdx !== -1, "expected an inline JSON body for a small result");
    for (const marker of ["Output status: ok", "Summary: hello", "Stats: a:1 b:2", "Artifacts: /tmp/x (r.md)", "Result file:", "Read redacted result:"]) {
      const idx = output.indexOf(marker);
      assert.ok(idx !== -1, `missing ${marker}`);
      assert.ok(idx < jsonIdx, `${marker} must precede the JSON body`);
    }
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("ux.6: compact status meta is an allowlisted projection; sensitive/free-form keys are dropped", () => {
  const oversized = "x".repeat(MAX_STATUS_STRING_CHARS + 500);
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
        name: "sensitive-meta-workflow",
        apiKey: "COMPACT-SECRET-APIKEY-9000",
        authorization: "Bearer COMPACT-BEARER-9000",
        nested: { token: "COMPACT-SECRET-TOKEN-9000", password: "COMPACT-PW-9000", note: oversized },
        prompt: oversized,
        argsSchema: { type: "object", properties: { question: { type: "string" }, depth: { type: "string" } }, required: ["question"] },
        examples: [{ args: { question: "demo" } }],
      },
      error: oversized,
    },
  };
  const compact = compactStatusForEntry(entry);
  const json = JSON.stringify(compact);
  // Compact meta is an allowlisted projection: sensitive/free-form keys are DROPPED (not
  // merely redacted); the full frontmatter remains on detail:"full" (see the 3741 test).
  assert.equal(compact.meta.apiKey, undefined);
  assert.equal(compact.meta.authorization, undefined);
  assert.equal(compact.meta.nested, undefined);
  assert.equal(compact.meta.prompt, undefined);
  assert.equal(compact.meta.argsSchema, undefined);
  assert.equal(compact.meta.examples, undefined);
  assert.equal(compact.meta.name, "sensitive-meta-workflow"); // allowlisted key survives
  assert.match(compact.meta.argsSummary ?? "", /\{ .*\*.*\}|declared|type=/); // one-line args summary when argsSchema declared
  // The raw secret values must never survive into the compact meta view.
  assert.ok(!json.includes("COMPACT-SECRET-APIKEY-9000"), "raw apiKey leaked into compact status");
  assert.ok(!json.includes("COMPACT-BEARER-9000"), "raw authorization leaked into compact status");
  assert.ok(!json.includes("COMPACT-SECRET-TOKEN-9000"), "raw nested token leaked into compact status");
  assert.ok(!json.includes("COMPACT-PW-9000"), "raw nested password leaked into compact status");
  assert.ok(!json.includes(oversized), "unbounded oversized string leaked into compact status");
  // errorSummary is bounded too.
  assert.ok(compact.errorSummary.length <= MAX_STATUS_STRING_CHARS, "oversized errorSummary not bounded");
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
  const compact = compactStatusForEntry(entry);
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
    const root = runRoot(context);
    const dir = runDirForRoot(root, runId);
    await fs.mkdir(dir, { recursive: true });
    const oversized = "y".repeat(MAX_STATUS_STRING_CHARS + 400);
    await writeJsonAtomic(path.join(dir, "state.json"), {
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
    assert.ok(status.meta.nested.blurb.length <= MAX_STATUS_STRING_CHARS, "oversized full meta string not bounded");
    assert.match(status.meta.nested.blurb, /\[truncated \d+ chars\]/);
    assert.ok(status.errorSummary.length <= MAX_STATUS_STRING_CHARS, "oversized full errorSummary not bounded");
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

// mnfx.2: a run with costTrackingUnreliable (sticky, set when a lane reports tokens with cost=0)
// surfaces a costTrackingWarning in BOTH compact and full workflow_status views — but ONLY when a
// maxCost ceiling is set (no ceiling → no false caveat). detail:"full" carries the caveat too,
// since it surfaces cost/liveCost/totalCost most prominently.
test("costTrackingWarning surfaces in compact and full status only when maxCost is set", async () => {
  const { tools, context, directory } = await makeHarness(async () => ({ data: { parts: [], info: {} } }));
  try {
    const runId = "cost-unreliable-run";
    const root = runRoot(context);
    const dir = runDirForRoot(root, runId);
    await fs.mkdir(dir, { recursive: true });

    async function statusFor(budgetCeilings) {
      await writeJsonAtomic(path.join(dir, "state.json"), {
        id: runId,
        status: "completed",
        meta: { name: "cost-unreliable" },
        budgetCeilings,
        costTrackingUnreliable: true,
        cost: 0,
      });
      const compact = JSON.parse(await tools.workflow_status.execute({ runId, format: "json", detail: "compact" }, context));
      const full = JSON.parse(await tools.workflow_status.execute({ runId, format: "json", detail: "full" }, context));
      return { compact, full };
    }

    // With a maxCost ceiling: both views carry the warning.
    const withCeiling = await statusFor({ maxCost: 1 });
    assert.equal(typeof withCeiling.compact.costTrackingWarning, "string");
    assert.match(withCeiling.compact.costTrackingWarning, /cost=0/);
    assert.equal(typeof withCeiling.full.costTrackingWarning, "string");
    assert.match(withCeiling.full.costTrackingWarning, /cost=0/);

    // Without a maxCost ceiling: no warning in either view (parity between compact and full).
    const noCeiling = await statusFor({ maxTokens: 100 });
    assert.equal(noCeiling.compact.costTrackingWarning, undefined);
    assert.equal(noCeiling.full.costTrackingWarning, undefined);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("workflow_status detail=result preserves full-fidelity strings when the readback fits", async () => {
  const { tools, context, directory } = await makeHarness(async () => ({ data: { parts: [], info: {} } }));
  try {
    const oversizedLen = MAX_STATUS_STRING_CHARS + 500;
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
    const root = runRoot(context);
    const dir = runDirForRoot(root, runId);
    const resultPath = path.join(dir, "result.json");
    const blob = "q".repeat(MAX_RESULT_READBACK_BYTES + 5000);
    await fs.mkdir(dir, { recursive: true });
    await writeJsonAtomic(resultPath, {
      output: {
        blob,
        stable: "kept",
        apiKey: "SHOULD-NOT-LEAK",
      },
    });
    await writeJsonAtomic(path.join(dir, "state.json"), {
      id: runId,
      status: "completed",
      resultPath,
    });

    const status = JSON.parse(await tools.workflow_status.execute({ runId, format: "json", detail: "result" }, context));

    assert.ok(status.resultFileBytes > MAX_RESULT_BYTES);
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
    const compact = compactStatusForEntry(ux4Entry(status, stateExtra));
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
  const timedOut = compactStatusForEntry(ux4Entry("timed-out"));
  assert.ok(!timedOut.nextActions.some((a) => /workflow_run resumeRunId=/.test(a)), "timed-out runs must not advertise resume");
});

test("ux.4: review-required without an applyable diff plan does not recommend workflow_apply", () => {
  const compact = compactStatusForEntry(ux4Entry("review-required", {
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
  const compact = compactStatusForEntry(ux4Entry("awaiting-diff-approval", ux4ApplyableDiffPlan()));
  assert.ok(compact.nextActions.some((a) => /workflow_apply runId=/.test(a)), "applyable awaiting-diff-approval must advertise workflow_apply");
});

test("ux.4: failed retryable lanes recommend resume while terminal schema lanes require fix-inspect first", () => {
  const retryable = compactStatusForEntry(ux4Entry("failed", {
    laneRecords: [{
      callId: "lane:retryable",
      outcome: "failure",
      failureClass: "transient_exhausted",
      retryable: true,
      errorSummary: "provider overloaded after retries",
    }],
  }));
  assert.ok(retryable.nextActions.some((a) => /workflow_run resumeRunId=/.test(a)), "retryable failure must advertise resume");

  const terminal = compactStatusForEntry(ux4Entry("failed", {
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
  const partial = compactStatusForEntry({ id: "p", root: "/runs", dir: "/runs/p", status: "partial", kind: "partial", error: "Missing state.json" });
  assert.ok(partial.nextActions.some((a) => /workflow_cleanup dryRun=true/.test(a)), "partial must suggest cleanup review");
  assert.ok(partial.nextActions.length <= 5);
  const corrupt = compactStatusForEntry({ id: "c", root: "/runs", dir: "/runs/c", status: "corrupt", kind: "corrupt", error: "bad json" });
  assert.ok(corrupt.nextActions.some((a) => /workflow_cleanup dryRun=true/.test(a)), "corrupt must suggest cleanup review");
  assert.ok(corrupt.nextActions.length <= 5);
});

test("ux.4: stale/interrupted runs with salvage candidates recommend recovery then salvage", () => {
  const stale = compactStatusForEntry(ux4Entry("stale-active", {}, { salvageCandidates: [{ callId: "lane:orphan", hint: "running lane with transcript" }] }));
  assert.ok(stale.nextActions.some((a) => /workflow_reconcile runId=/.test(a)), "stale must recommend reconcile");
  assert.ok(stale.nextActions.some((a) => /workflow_salvage runId=/.test(a)), "stale+salvage must recommend salvage");

  const interrupted = compactStatusForEntry(ux4Entry("interrupted", {}, { salvageCandidates: [{ callId: "lane:orphan", hint: "running lane with transcript" }] }));
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
    const compact = compactStatusForEntry(ux4Entry(status, hostile));
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
  const text = summarizeEntries(entries);
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
