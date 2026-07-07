import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { createBeadsDrainAdapter, defaultRunBd, finalizeBeadsDomainMutation } from "../workflow-domains/beads/beads-drain-adapter.js";
import { drain } from "../workflow-kernel/drain-runtime.js";
import { finalizeStagedDomainMutations } from "../workflow-kernel/event-journal.js";

// Domain-mutation finalization is now resolved by exact operation name (the kernel is domain-neutral).
// In production the beads extension registers these handlers; the scratch test supplies them directly.
const beadsMutationResolver = (op) => (String(op).startsWith("beads.") ? finalizeBeadsDomainMutation : undefined);

const execFileAsync = promisify(execFile);
const ACTOR = "scratch-agent@example.com";
const tempDirs = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function tempDir(prefix) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `${prefix}-`));
  tempDirs.push(dir);
  return dir;
}

async function scratchRepo() {
  const dir = await tempDir("beads-drain-scratch");
  await execFileAsync("git", ["init"], { cwd: dir, encoding: "utf8" });
  await bd(dir, ["init", "--prefix", "scratch", "--non-interactive", "--skip-agents", "--skip-hooks", "--quiet"]);
  return dir;
}

async function bd(cwd, args) {
  const { stdout } = await execFileAsync("bd", [...args, "--actor", ACTOR], { cwd, encoding: "utf8", maxBuffer: 10 * 1024 * 1024 });
  return stdout;
}

function parseJson(stdout) {
  const text = stdout.trim();
  return text ? JSON.parse(text) : null;
}

function firstIssue(payload) {
  return Array.isArray(payload) ? payload[0] : payload?.issue ?? payload;
}

async function createIssue(cwd, overrides = {}) {
  const labels = overrides.labels ?? ["ready-for-agent"];
  const args = [
    "create",
    "--title",
    overrides.title ?? "Scratch task",
    "--description",
    overrides.description ?? "Implement the scratch task.",
    "--acceptance",
    overrides.acceptance ?? "Validation evidence is recorded.",
    "--type",
    overrides.type ?? "task",
    "--priority",
    String(overrides.priority ?? 1),
    "--json",
  ];
  if (labels.length > 0) args.push("--labels", labels.join(","));
  return firstIssue(parseJson(await bd(cwd, args)));
}

async function showIssue(cwd, id) {
  return firstIssue(parseJson(await bd(cwd, ["show", "--id", id, "--long", "--json", "--readonly"])));
}

async function readyTasks(cwd) {
  return parseJson(await bd(cwd, ["ready", "--type", "task", "--json", "--readonly"]));
}

function laneReport(itemId, overrides = {}) {
  return {
    itemId,
    outcome: "implemented",
    summary: `implemented ${itemId}`,
    readyForIntegration: true,
    filesChanged: [`scratch/${itemId}.txt`],
    commandsRun: ["scratch validation"],
    acceptanceEvidence: ["scratch acceptance passed"],
    residualRisks: [],
    followups: [],
    ...overrides,
  };
}

async function adapterFor(cwd, overrides = {}) {
  const run = overrides.run ?? { id: "scratch-run", dir: await tempDir("beads-drain-run") };
  const commandCwds = [];
  const runBd = async (args, options = {}) => {
    assert.equal(options.cwd, cwd);
    commandCwds.push(options.cwd);
    return await defaultRunBd(args, options);
  };
  // Wire a passing central verifier by default so the end-to-end happy-path drains genuinely
  // re-run the lane's reported commandsRun instead of trusting self-reported evidence. Without a
  // runValidationCommand the verifier is inert and (per R11) a lane that claims commandsRun is
  // rejected as unable-to-verify, so these scratch drains MUST supply a real runner.
  const runValidationCommand = overrides.runValidationCommand ?? (async (command) => ({ exitCode: 0, stdout: `${command} ok` }));
  return {
    run,
    commandCwds,
    adapter: createBeadsDrainAdapter({ cwd, actor: ACTOR, runBd, run, runValidationCommand, ...overrides }),
  };
}

test("scratch Beads drain closes one ready task and proves the scratch queue dry", async () => {
  const cwd = await scratchRepo();
  const issue = await createIssue(cwd, { title: "Single ready scratch task" });
  const { adapter, commandCwds, run } = await adapterFor(cwd);

  const report = await drain({
    adapter,
    scope: { issueTypes: ["task"] },
    runLane: async (packet) => laneReport(packet.item.id),
  });

  assert.equal(report.status, "complete");
  assert.deepEqual(report.closed.map((item) => item.itemId), [issue.id]);
  assert.equal((await showIssue(cwd, issue.id)).status, "in_progress");
  const finalized = await finalizeStagedDomainMutations(run.dir, { id: run.id }, beadsMutationResolver);
  assert.equal(finalized.finalized, 2);
  assert.equal((await showIssue(cwd, issue.id)).status, "closed");
  assert.deepEqual(await readyTasks(cwd), []);
  assert.ok(commandCwds.length > 0);
  assert.equal(commandCwds.every((dir) => dir === cwd), true);
});

test("scratch Beads drain processes distinct ready tasks and actor-owned in-progress work", async () => {
  const cwd = await scratchRepo();
  const first = await createIssue(cwd, { title: "Path A scratch task", priority: 0 });
  const second = await createIssue(cwd, { title: "Path B scratch task", priority: 1 });
  const inProgress = await createIssue(cwd, { title: "Continue scratch task", priority: 2 });
  await bd(cwd, ["update", inProgress.id, "--status", "in_progress", "--assignee", ACTOR]);
  const { adapter, run } = await adapterFor(cwd);
  const filesByItem = new Map([
    [first.id, "paths/a.txt"],
    [second.id, "paths/b.txt"],
    [inProgress.id, "paths/continue.txt"],
  ]);

  const report = await drain({
    adapter,
    scope: { issueTypes: ["task"] },
    runLane: async (packet) => laneReport(packet.item.id, { filesChanged: [filesByItem.get(packet.item.id)] }),
  });

  assert.equal(report.status, "complete");
  assert.deepEqual(report.closed.map((item) => item.itemId), [first.id, second.id, inProgress.id]);
  assert.deepEqual(new Set(report.closed.map((item) => item.laneReport.filesChanged[0])).size, 3);
  assert.equal((await showIssue(cwd, inProgress.id)).status, "in_progress");
  const finalized = await finalizeStagedDomainMutations(run.dir, { id: run.id }, beadsMutationResolver);
  assert.equal(finalized.finalized, 6);
  assert.equal((await showIssue(cwd, inProgress.id)).status, "closed");
  assert.deepEqual(await readyTasks(cwd), []);
});

test("scratch Beads drain human-gates externally owned in-progress work", async () => {
  const cwd = await scratchRepo();
  const issue = await createIssue(cwd, { title: "External in-progress scratch task" });
  await bd(cwd, ["update", issue.id, "--status", "in_progress", "--assignee", "other@example.com"]);
  const { adapter, run } = await adapterFor(cwd);

  const report = await drain({
    adapter,
    scope: { issueTypes: ["task"] },
    maxWaves: 1,
    runLane: async () => assert.fail("externally owned in-progress work must not run"),
  });

  assert.equal(report.status, "not_dry");
  assert.deepEqual(report.skipped, [{ itemId: issue.id, classification: "human-gated", reason: "in-progress issue is not assigned to this controller" }]);
  assert.deepEqual(report.dryProof.unsafeInProgress.map((item) => item.id), [issue.id]);
  assert.equal((await showIssue(cwd, issue.id)).status, "in_progress");
});

test("scratch child Beads mutation attempts are denied before bd runs", async () => {
  const cwd = await scratchRepo();
  const issue = await createIssue(cwd);
  let calls = 0;
  const adapter = createBeadsDrainAdapter({
    cwd,
    actor: ACTOR,
    laneAuthority: "child",
    runBd: async () => {
      calls += 1;
      throw new Error("bd should not be called for child mutations");
    },
  });

  await assert.rejects(adapter.claim(issue), /controller-only/);
  await assert.rejects(adapter.close(issue, {}), /controller-only/);
  await assert.rejects(adapter.createFollowup({ title: "No child mutation" }), /controller-only/);
  assert.equal(calls, 0);
});

test("scratch Beads adapter creates and links follow-up work", async () => {
  const cwd = await scratchRepo();
  const source = await createIssue(cwd, { title: "Source scratch task" });
  const { adapter, run } = await adapterFor(cwd);

  const created = await adapter.createFollowup({
    title: "Scratch follow-up",
    description: "Follow-up created from scratch drain evidence.",
    dependsOn: source.id,
    dependencyType: "discovered-from",
  });

  assert.match(created.id, /^staged-followup:/);
  const finalized = await finalizeStagedDomainMutations(run.dir, { id: run.id }, beadsMutationResolver);
  assert.equal(finalized.finalized, 1);
  const createdId = finalized.results[0].result.id;
  const readback = await showIssue(cwd, createdId);
  assert.equal(readback.title, "Scratch follow-up");
  assert.equal(readback.dependencies.some((dep) => (dep.depends_on_id ?? dep.id) === source.id && (dep.type ?? dep.dependency_type) === "discovered-from"), true);
});

test("scratch validation failure prevents close and dry proof catches remaining ready work", async () => {
  const cwd = await scratchRepo();
  const failing = await createIssue(cwd, { title: "Failing scratch task", priority: 0 });
  const remaining = await createIssue(cwd, { title: "Remaining scratch task", priority: 1, labels: [] });
  const { adapter } = await adapterFor(cwd);

  const report = await drain({
    adapter,
    scope: { issueTypes: ["task"] },
    maxAttempts: 1,
    runLane: async (packet) => laneReport(packet.item.id, { commandsRun: [], acceptanceEvidence: [] }),
  });

  assert.equal(report.status, "failed");
  assert.deepEqual(report.closed, []);
  assert.deepEqual(report.failed.map((item) => item.itemId), [failing.id]);
  assert.equal((await showIssue(cwd, failing.id)).status, "open");
  assert.equal((await showIssue(cwd, failing.id)).assignee, undefined);
  assert.equal((await showIssue(cwd, remaining.id)).status, "open");
  assert.equal(report.dryProof.dry, false);
  assert.deepEqual(report.dryProof.ready.map((item) => item.id), [failing.id, remaining.id]);
});
