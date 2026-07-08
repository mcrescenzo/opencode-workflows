import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as setTimeoutP } from "node:timers/promises";
import { promisify } from "node:util";

import workflowPlugin from "../workflow-kernel/index.js";
import { analyzeRuns } from "../scripts/analyze-runs.mjs";
import { makeHarness } from "./helpers/harness.mjs";

const execFileAsync = promisify(execFile);
const { __test } = workflowPlugin;

async function initGitRepo(directory) {
  await execFileAsync("git", ["init"], { cwd: directory });
  await execFileAsync("git", ["config", "user.email", "workflow-test@example.com"], { cwd: directory });
  await execFileAsync("git", ["config", "user.name", "Workflow Test"], { cwd: directory });
  await fs.writeFile(path.join(directory, "README.md"), "initial\n", "utf8");
  await execFileAsync("git", ["add", "README.md"], { cwd: directory });
  await execFileAsync("git", ["commit", "-m", "initial"], { cwd: directory });
}

async function runApproved(tools, context, request) {
  const preview = await tools.workflow_run.execute(request, context);
  const match = preview.match(/approvalHash: ([a-f0-9]{64})/);
  assert.ok(match, `missing approvalHash in preview: ${preview}`);
  return await tools.workflow_run.execute({ ...request, approve: true, approvalHash: match[1] }, context);
}

function runIdFrom(output) {
  const match = output.match(/Workflow ([0-9a-f-]{36}) (?:completed|started|awaiting diff approval|failed with diff plan)/);
  assert.ok(match, `missing run id in output: ${output}`);
  return match[1];
}

function sessionWithMessages(prompt, options, calls) {
  return {
    async create(input) {
      calls.create.push(input);
      return { data: { id: `child-${calls.create.length}` } };
    },
    async prompt(input) {
      calls.prompt.push(input);
      return await prompt(input);
    },
    async messages(input) {
      calls.messages.push(input);
      return {
        data: [
          { role: "user", content: "token=sk-proj-abcdefghijklmnop" },
          { role: "assistant", content: "Bearer abcdefghijklmnop" },
        ],
      };
    },
    async abort(input) {
      calls.abort.push(input);
      return { data: { ok: true } };
    },
  };
}

test("debug capture is off by default and does not call session.messages", async () => {
  const { tools, context, directory, calls } = await makeHarness(
    async () => ({ data: { parts: [{ type: "text", text: "ok" }], info: { tokens: { input: 1, output: 1, reasoning: 0 }, cost: 0 } } }),
    { session: sessionWithMessages },
  );
  try {
    const source = `export const meta = { name: "debug-capture-off", maxAgents: 1 };
return await agent("ordinary lane");`;
    const output = await runApproved(tools, context, { source });
    const status = JSON.parse(await tools.workflow_status.execute({ runId: runIdFrom(output), format: "json", detail: "full" }, context));
    assert.equal(calls.messages.length, 0);
    await assert.rejects(fs.access(path.join(status.dir, "debug")), /ENOENT/);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("debug capture persists redacted prompt, schema, and transcript with private modes", async () => {
  const { tools, context, directory, calls } = await makeHarness(
    async () => ({
      data: {
        parts: [{ type: "text", text: JSON.stringify({ ok: true }) }],
        info: {
          structured: { ok: true },
          tokens: { input: 1, output: 1, reasoning: 0 },
          cost: 0,
        },
      },
    }),
    { session: sessionWithMessages },
  );
  try {
    const source = `export const meta = { name: "debug-capture-on", maxAgents: 1 };
return await agent("inspect token=sk-proj-abcdefghijklmnop", {
  label: "debug lane",
  schema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"], additionalProperties: false }
});`;
    const output = await runApproved(tools, context, { source, debugCapture: true });
    const status = JSON.parse(await tools.workflow_status.execute({ runId: runIdFrom(output), format: "json", detail: "full" }, context));
    assert.equal(calls.messages.length, 1);
    const debugLaneDir = path.join(status.dir, "debug", (await fs.readdir(path.join(status.dir, "debug")))[0]);
    const prompt = await fs.readFile(path.join(debugLaneDir, "prompt.md"), "utf8");
    const schema = JSON.parse(await fs.readFile(path.join(debugLaneDir, "schema.json"), "utf8"));
    const transcript = await fs.readFile(path.join(debugLaneDir, "transcript.jsonl"), "utf8");
    assert.match(prompt, /Task Prompt/);
    assert.equal(schema.required[0], "ok");
    assert.doesNotMatch(prompt, /sk-proj-abcdefghijklmnop/);
    assert.doesNotMatch(transcript, /abcdefghijklmnop/);
    assert.match(transcript, /\[REDACTED:secret\]/);
    const mode = (await fs.stat(path.join(debugLaneDir, "prompt.md"))).mode & 0o777;
    assert.equal(mode, __test.PRIVATE_FILE_MODE);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("lane projections and workflow_status expose enqueuedAt and queueWaitMs under saturation", async () => {
  let promptCount = 0;
  const { tools, context, directory } = await makeHarness(async () => {
    promptCount += 1;
    if (promptCount === 1) await setTimeoutP(80);
    return { data: { parts: [{ type: "text", text: "ok" }], info: { tokens: { input: 1, output: 1, reasoning: 0 }, cost: 0 } } };
  });
  try {
    const source = `export const meta = { name: "queue-wait", maxAgents: 2, concurrency: 1 };
return await parallel([
  async ({ agent }) => await agent("lane one"),
  async ({ agent }) => await agent("lane two")
]);`;
    const output = await runApproved(tools, context, { source });
    const status = JSON.parse(await tools.workflow_status.execute({ runId: runIdFrom(output), format: "json", detail: "full" }, context));
    const waits = status.laneRecords.map((lane) => lane.queueWaitMs);
    assert.equal(status.laneRecords.length, 2);
    assert.ok(status.laneRecords.every((lane) => lane.enqueuedAt && lane.startedAt && Date.parse(lane.enqueuedAt) <= Date.parse(lane.startedAt)));
    assert.ok(Math.max(...waits) >= 50, `expected saturated queue wait, got ${waits.join(",")}`);
    assert.equal(status.operatorMetrics.timeToFirstResultMs >= 0, true);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("workflow_events filters, pages, and reports corrupt trailing lines", async () => {
  const { tools, context, directory } = await makeHarness(async () => ({ data: { parts: [], info: {} } }));
  try {
    const root = __test.runRoot(context);
    const runId = "events-run";
    const dir = __test.runDirForRoot(root, runId);
    await fs.mkdir(dir, { recursive: true });
    await __test.writeJsonAtomic(path.join(dir, "state.json"), { id: runId, status: "completed", startedAt: "2026-07-07T00:00:00.000Z" });
    await fs.writeFile(path.join(dir, "events.jsonl"), [
      JSON.stringify({ ts: "2026-07-07T00:00:01.000Z", type: "run.started" }),
      JSON.stringify({ ts: "2026-07-07T00:00:02.000Z", type: "cache.hit", callId: "a" }),
      JSON.stringify({ ts: "2026-07-07T00:00:03.000Z", type: "cache.miss", callId: "b" }),
      "{truncated",
    ].join("\n"), "utf8");
    const page = JSON.parse(await tools.workflow_events.execute({ runId, format: "json", typePrefix: "cache.", order: "oldest", limit: 1 }, context));
    assert.equal(page.totalMatching, 2);
    assert.equal(page.returned, 1);
    assert.equal(page.nextOffset, 1);
    assert.equal(page.invalidLineCount, 1);
    assert.equal(page.events[0].type, "cache.hit");
    const second = JSON.parse(await tools.workflow_events.execute({ runId, format: "json", typePrefix: "cache.", order: "oldest", limit: 1, offset: page.nextOffset }, context));
    assert.equal(second.events[0].type, "cache.miss");
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("workflow_apply records approval wait metrics in status and closeout", async () => {
  const { tools, context, directory } = await makeHarness(async () => ({
    data: {
      parts: [{ type: "text", text: JSON.stringify({ patches: [{ path: "applied.txt", content: "applied\n" }] }) }],
      info: {
        structured: { patches: [{ path: "applied.txt", content: "applied\n" }] },
        tokens: { input: 1, output: 1, reasoning: 0 },
        cost: 0,
      },
    },
  }));
  try {
    await initGitRepo(directory);
    const source = `export const meta = { name: "approval-wait", authority: { edit: true }, maxAgents: 1 };
return await agent("edit file", { edit: true, schema: { type: "object", properties: { patches: { type: "array" } }, required: ["patches"] } });`;
    const output = await runApproved(tools, context, { source });
    const runId = runIdFrom(output);
    const status = JSON.parse(await tools.workflow_status.execute({ runId, format: "json", detail: "full" }, context));
    assert.equal(status.status, "awaiting-diff-approval");
    assert.ok(status.operatorMetrics.awaitingDiffApprovalAt);
    await setTimeoutP(5);
    await tools.workflow_apply.execute({
      runId,
      approvedSourceHash: status.sourceHash,
      baseCommit: status.editPlan.baseCommit,
      diffPlanHash: status.editPlan.diffPlanHash,
      domainMutationHash: status.editPlan.domainMutationHash,
      approvalIntent: "apply",
    }, context);
    const applied = JSON.parse(await tools.workflow_status.execute({ runId, format: "json", detail: "full" }, context));
    const closeout = JSON.parse(await fs.readFile(path.join(status.dir, "closeout.json"), "utf8"));
    assert.equal(applied.status, "applied");
    assert.equal(applied.operatorMetrics.approvalWaitMs >= 0, true);
    assert.equal(closeout.operatorMetrics.approvalWaitMs, applied.operatorMetrics.approvalWaitMs);
    const events = await tools.workflow_events.execute({ runId, format: "json", typePrefix: "run.approval_wait" }, context);
    assert.equal(JSON.parse(events).events[0].type, "run.approval_wait_completed");
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("workflow_status full exposes notification delivery latency and delivery event is recorded", async () => {
  const { tools, context, directory } = await makeHarness(async () => ({ data: { parts: [], info: {} } }));
  const savedPending = new Set(__test.pendingNotificationPaths);
  __test.pendingNotificationPaths.clear();
  try {
    const root = __test.runRoot(context);
    const runId = "notification-latency";
    const dir = __test.runDirForRoot(root, runId);
    const notificationPath = path.join(dir, "notification.json");
    await fs.mkdir(dir, { recursive: true });
    await __test.writeJsonAtomic(path.join(dir, "state.json"), {
      id: runId,
      status: "completed",
      startedAt: "2026-07-07T00:00:00.000Z",
      notification: { notificationPath },
    });
    await __test.writeJsonAtomic(notificationPath, {
      stateVersion: 1,
      runId,
      status: "completed",
      sessionID: "parent-session",
      directory,
      agent: "build",
      createdAt: "2026-07-07T00:00:00.000Z",
      sentAt: null,
      delivery: { attempts: 0, lastAttemptAt: null, lastError: null },
      notificationPath,
    });
    __test.pendingNotificationPaths.add(notificationPath);
    const delivered = await __test.deliverWorkflowNotifications({
      client: { session: { promptAsync: async () => ({ data: { id: "async-1" } }) } },
    }, { type: "session.idle", properties: { sessionID: "parent-session" } });
    assert.equal(delivered.delivered, 1);
    const status = JSON.parse(await tools.workflow_status.execute({ runId, format: "json", detail: "full" }, context));
    assert.equal(status.notification.delivery.deliveryLatencyMs >= 0, true);
    const events = JSON.parse(await tools.workflow_events.execute({ runId, format: "json", typePrefix: "notification." }, context));
    assert.equal(events.events[0].type, "notification.delivered");
  } finally {
    __test.pendingNotificationPaths.clear();
    for (const value of savedPending) __test.pendingNotificationPaths.add(value);
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("analyze-runs aggregates partial run directories without mutation", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "analyze-runs-"));
  try {
    const runA = path.join(root, "run-a");
    const runB = path.join(root, "run-b");
    await fs.mkdir(path.join(runA, "lanes"), { recursive: true });
    await fs.mkdir(path.join(runB, "lanes"), { recursive: true });
    await __test.writeJsonAtomic(path.join(runA, "state.json"), { id: "run-a", status: "completed", meta: { name: "wf-a" }, defaultChildModel: "test/model-a" });
    await __test.writeJsonAtomic(path.join(runA, "lanes", "lane_1.json"), {
      callId: "lane:1",
      role: "finder",
      model: "test/model-a",
      outcome: "success",
      correctiveAttempts: 1,
      tokens: { input: 2, output: 3, reasoning: 0 },
      cost: 0.01,
      queueWaitMs: 12,
    });
    await fs.writeFile(path.join(runA, "events.jsonl"), `${JSON.stringify({ type: "cache.hit" })}\n{bad`, "utf8");
    await __test.writeJsonAtomic(path.join(runB, "state.json"), { id: "run-b", status: "failed", meta: { name: "wf-b" }, defaultChildModel: "test/model-b" });
    await __test.writeJsonAtomic(path.join(runB, "lanes", "lane_2.json"), {
      callId: "lane:2",
      role: "verifier",
      model: "test/model-b",
      outcome: "timeout",
      queueWaitMs: 30,
    });
    const report = await analyzeRuns({ roots: [root] });
    assert.equal(report.runsScanned, 2);
    assert.equal(report.byRole.finder.correctiveAttempts, 1);
    assert.equal(report.byModel["test/model-b"].timeout, 1);
    assert.equal(report.cacheEvents["cache.hit"], 1);
    assert.equal(report.invalidJsonlLines, 1);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
