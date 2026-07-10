// Workflow lifecycle regression suite: cleanup, reconcile, pause/cancel/kill, locks, finalization, background, deadline, timeout recovery.
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

test("workflow run lookup and cleanup protect symlinked run directories", async () => {
  const escapeRoot = await tempDir();
  const { tools, context, directory } = await makeHarness(async () => ({ data: { parts: [], info: {} } }));
  try {
    const runId = "symlink-run";
    const root = runRoot(context);
    const linkPath = runDirForRoot(root, runId);
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
    const root = runRoot(context);
    await fs.mkdir(root, { recursive: true });
    async function writeRun(id, state) {
      const dir = runDirForRoot(root, id);
      await fs.mkdir(dir, { recursive: true });
      await writeJsonAtomic(path.join(dir, "state.json"), { id, startedAt: "2026-06-16T00:00:00.000Z", ...state });
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
    const corruptDir = runDirForRoot(root, "cleanup-corrupt");
    await fs.mkdir(corruptDir, { recursive: true });
    await fs.writeFile(path.join(corruptDir, "state.json"), "{not json", "utf8");
    const malformedDir = path.join(root, "!bad-run-id");
    await fs.mkdir(malformedDir, { recursive: true });
    await writeJsonAtomic(path.join(malformedDir, "state.json"), { id: "!bad-run-id", status: "completed" });

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
    assert.equal(await fileExists(runDirForRoot(root, "cleanup-apply-failed")), true);
    assert.equal(await fileExists(runDirForRoot(root, "cleanup-failed")), true);
    assert.equal(await fileExists(runDirForRoot(root, "cleanup-budget-stopped")), true);
    assert.equal(await fileExists(runDirForRoot(root, "cleanup-review")), true);
    assert.equal(await fileExists(runDirForRoot(root, "cleanup-running")), true);
    assert.equal(await fileExists(runDirForRoot(root, "cleanup-pinned")), true);
    assert.equal(await fileExists(runDirForRoot(root, "cleanup-apply-running")), true);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("workflow_cleanup protects paused runs from deletion (resumable)", async () => {
  const { tools, context, directory } = await makeHarness(async () => ({ data: { parts: [], info: {} } }));
  try {
    const root = runRoot(context);
    const pausedDir = runDirForRoot(root, "cleanup-paused");
    await fs.mkdir(pausedDir, { recursive: true });
    // A paused run releases its run.lock and leaves the in-memory map, so it has no live
    // lock and is not active-in-process; only the explicit paused guard keeps it.
    await writeJsonAtomic(path.join(pausedDir, "state.json"), { id: "cleanup-paused", status: "paused", startedAt: "2026-06-16T00:00:00.000Z" });

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
    const root = runRoot(context);
    const runDir = runDirForRoot(root, "kill-run");
    await fs.mkdir(runDir, { recursive: true });
    // A run that was active (running) with a now-dead process — simulates SIGKILL mid-run.
    await writeJsonAtomic(path.join(runDir, "state.json"), {
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
    const root = runRoot(context);
    const runDir = runDirForRoot(root, "kill-dirty");
    await fs.mkdir(runDir, { recursive: true });
    await writeJsonAtomic(path.join(runDir, "state.json"), {
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
    const root = runRoot(context);
    await fs.mkdir(root, { recursive: true });
    async function writeInterrupted(id, lastProgressAt) {
      const dir = runDirForRoot(root, id);
      await fs.mkdir(dir, { recursive: true });
      // status:running + a dead pid → reconcile (run during cleanup) flips it to interrupted.
      await writeJsonAtomic(path.join(dir, "state.json"), {
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
    const root = runRoot(context);
    await fs.mkdir(root, { recursive: true });
    const dir = runDirForRoot(root, "ttl-config");
    await fs.mkdir(dir, { recursive: true });
    await writeJsonAtomic(path.join(dir, "state.json"), {
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
    const root = runRoot(context);
    // Two deletable runs. Cleanup processes them newest-first; the decoy is deleted first and
    // its fs.rm is the seam where we simulate a concurrent resume acquiring the target's lock
    // BEFORE cleanup's per-entry re-validation re-reads the target. Patching the shared
    // node:fs/promises namespace intercepts the plugin's own fs.rm (same module singleton).
    const decoyDir = runDirForRoot(root, "cleanup-decoy");
    await fs.mkdir(decoyDir, { recursive: true });
    await writeJsonAtomic(path.join(decoyDir, "state.json"), { id: "cleanup-decoy", status: "completed", startedAt: "2026-06-17T00:00:00.000Z" });
    const racedDir = runDirForRoot(root, "cleanup-raced");
    await fs.mkdir(racedDir, { recursive: true });
    await writeJsonAtomic(path.join(racedDir, "state.json"), { id: "cleanup-raced", status: "completed", startedAt: "2026-06-16T00:00:00.000Z" });

    let injected = false;
    fs.rm = async (target, ...rest) => {
      if (!injected && typeof target === "string" && target === decoyDir) {
        // Concurrent resume re-acquires the target's run.lock (as workflow_resume would).
        injected = true;
        await writeJsonAtomic(path.join(racedDir, "run.lock"), { operation: "run", runId: "cleanup-raced", process: { pid: process.pid } });
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
    const root = runRoot(context);
    const dir = runDirForRoot(root, runId);
    await fs.mkdir(dir, { recursive: true });
    await writeJsonAtomic(path.join(dir, "state.json"), { id: runId, status: "completed", startedAt: "2026-06-16T00:00:00.000Z" });
    await writeJsonAtomic(path.join(dir, "run.lock"), { operation: "run", runId, process: { pid: 999999999, startTime: 1 } });

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
test("workflow_cancel and workflow_pause persist requests for runs owned by another process", async () => {
  const { tools, context, directory } = await makeHarness(async () => ({ data: { parts: [], info: {} } }));
  try {
    const runId = "remote-lifecycle-run";
    const root = runRoot(context);
    const dir = runDirForRoot(root, runId);
    await fs.mkdir(dir, { recursive: true });
    await writeJsonAtomic(path.join(dir, "state.json"), { id: runId, status: "running", process: { pid: 999999999, startTime: 1 } });

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
    const root = runRoot(context);
    const partialRunId = "partial-lifecycle-run";
    await fs.mkdir(runDirForRoot(root, partialRunId), { recursive: true });

    await assert.rejects(
      tools.workflow_cancel.execute({ runId: partialRunId }, context),
      /Cannot cancel invalid run partial/,
    );

    const corruptRunId = "corrupt-lifecycle-run";
    const corruptDir = runDirForRoot(root, corruptRunId);
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
    const root = runRoot(context);

    const cancelRunId = "in-memory-cancel-run";
    const cancelDir = runDirForRoot(root, cancelRunId);
    await fs.mkdir(cancelDir, { recursive: true });
    const cancelRejects = [];
    const cancelRun = makeInMemoryRun(cancelRunId, cancelDir, {
      waitingAgents: [{ reject(error) { cancelRejects.push(error); } }],
    });
    runs.set(cancelRunId, cancelRun);

    assert.match(await tools.workflow_cancel.execute({ runId: cancelRunId }, context), /Cancellation requested/);
    assert.equal(cancelRun.abortController.signal.aborted, true);
    assert.equal(cancelRun.status, "cancelling");
    assert.equal(cancelRejects[0]?.code, "WORKFLOW_CANCELLED");
    assert.equal(JSON.parse(await fs.readFile(path.join(cancelDir, "state.json"), "utf8")).status, "cancelling");
    assert.ok(toastCalls.some((body) => body.variant === "warning" && /^⚠ in-memory-cancel-run cancelling/.test(body.title) && /inspect: workflow_status/.test(body.message)), "missing cancel terminal-style toast card");

    const pauseRunId = "in-memory-pause-run";
    const pauseDir = runDirForRoot(root, pauseRunId);
    await fs.mkdir(pauseDir, { recursive: true });
    const pauseRejects = [];
    const pauseRun = makeInMemoryRun(pauseRunId, pauseDir, {
      waitingAgents: [{ reject(error) { pauseRejects.push(error); } }],
    });
    runs.set(pauseRunId, pauseRun);

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
    assert.ok(toastCalls.every((body) => !/agents \d+ active|cache|concurrency/.test(body.message)), "legacy lifecycle toast body leaked");
    assert.deepEqual(abortCalls.map((input) => input.path.id), [`${cancelRunId}-child`, `${pauseRunId}-child`]);
  } finally {
    runs.delete("in-memory-cancel-run");
    runs.delete("in-memory-pause-run");
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("workflow_cancel and workflow_kill do not wedge when child session abort hangs", async () => {
  const abortCalls = [];
  const { tools, context, directory } = await makeHarness(async () => ({ data: { parts: [], info: {} } }), {
    pluginContext: { __workflowChildAbortTimeoutMs: 20, __workflowLifecycleSettleTimeoutMs: 20 },
    session(prompt, _options, calls) {
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
    const root = runRoot(context);
    const cancelDir = runDirForRoot(root, cancelRunId);
    const killDir = runDirForRoot(root, killRunId);
    await fs.mkdir(cancelDir, { recursive: true });
    await fs.mkdir(killDir, { recursive: true });
    const cancelRun = makeInMemoryRun(cancelRunId, cancelDir);
    const killRun = makeInMemoryRun(killRunId, killDir);
    runs.set(cancelRunId, cancelRun);
    runs.set(killRunId, killRun);

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
    runs.delete(cancelRunId);
    runs.delete(killRunId);
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
    const transitionalState = JSON.parse(await fs.readFile(path.join(runDirForRoot(runRoot(context), runId), "state.json"), "utf8"));
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
    if (runId) runs.delete(runId);
    await fs.rm(directory, { recursive: true, force: true });
  }
});

// jbs3.7: assertResumableState surfaces actionable settle guidance for the transitional
// "pausing"/"cancelling" statuses (poll then resume / poll to terminal), while a genuinely
// non-resumable terminal status keeps the existing hard rejection.
test("jbs3.7: resuming a settling run returns poll guidance; a terminal non-resumable status still rejects", async () => {
  const { tools, context, directory } = await makeHarness(async () => ({ data: { parts: [], info: {} } }));
  try {
    const root = runRoot(context);
    async function writeStateFor(runId, status) {
      const dir = runDirForRoot(root, runId);
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
    await runs.get(wideRunId)?.done;
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

// mfv9.7: meta.recommendBackground — an author-declared "this workflow runs wide/long" signal
// defaults the run to background with a distinct workflow-declared reason line. Explicit
// background:false (and resume-pinned background, already covered by mfv9.6) always wins.
test("mfv9.7: meta.recommendBackground defaults the run to background; explicit background:false wins", async () => {
  const source = `export const meta = { name: "bg-meta", description: "d", recommendBackground: true, maxAgents: 4, concurrency: 2 };
return { ok: true };`;
  // Preview with no background arg → defaulted on, workflow-declared reason line present.
  {
    const { tools, context, directory } = await makeHarness(async () => ({ data: { parts: [], info: {} } }));
    try {
      const preview = await tools.workflow_run.execute({ source, format: "text" }, context);
      assert.match(preview, /Background: true/);
      assert.match(preview, /Background defaulted \(workflow-declared\)/);
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  }
  // Explicit background:false overrides the meta recommendation.
  {
    const { tools, context, directory } = await makeHarness(async () => ({ data: { parts: [], info: {} } }));
    try {
      const preview = await tools.workflow_run.execute({ source, background: false, format: "text" }, context);
      assert.match(preview, /Background: false/);
      assert.doesNotMatch(preview, /Background defaulted \(workflow-declared\)/);
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
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
  const readOnlyAuthority = resolveRunAuthority({ profile: "read-only-review" }, {});
  const editAuthority = resolveRunAuthority({ authority: { edit: true } }, {});
  const integrationAuthority = resolveRunAuthority({ authority: { integration: true } }, {});
  async function writeRun(id, state) {
    const dir = runDirForRoot(runRoot(context), id);
    await fs.mkdir(dir, { recursive: true });
    await writeJsonAtomic(path.join(dir, "state.json"), {
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
    await writeJsonAtomic(path.join(lockedDir, "run.lock"), {
      operation: "run",
      runId: "timeout-active-lock",
      process: { pid: process.pid, startTime: await selfProcessStartTime() },
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
    const root = runRoot(context);
    const dir = runDirForRoot(root, runId);
    await fs.mkdir(dir, { recursive: true });
    const lockPath = lockPathForRun(dir, "run");
    rawReleaseRunLock = await acquireWorkflowLock(lockPath, { operation: "run", runId });
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
    runs.set(runId, run);

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
    runs.delete(runId);
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
    const run = runs.get(runId);
    assert.ok(run, "background run should be in-memory before kill");
    const dir = runDirForRoot(runRoot(context), runId);
    const lockPath = lockPathForRun(dir, "run");

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
    if (runId) runs.delete(runId);
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
    const root = runRoot(context);
    const dir = runDirForRoot(root, runId);
    await fs.mkdir(dir, { recursive: true });
    await writeJsonAtomic(path.join(dir, "state.json"), { id: runId, status: "running", process: { pid: 999999999, startTime: 1 } });
    // A run lock held by a dead PID is stale and must be cleared immediately by kill.
    await writeJsonAtomic(lockPathForRun(dir, "run"), { operation: "run", runId, process: { pid: 999999999, startTime: 1 } });

    const message = await tools.workflow_kill.execute({ runId }, context);
    assert.match(message, /Force-terminate requested/i);
    assert.match(message, /stale lock/i);

    const killRequest = JSON.parse(await fs.readFile(path.join(dir, "kill-request.json"), "utf8"));
    assert.equal(killRequest.type, "kill");
    assert.equal(await fileExists(lockPathForRun(dir, "run")), false, "stale lock must be cleared");

    const status = JSON.parse(await tools.workflow_status.execute({ runId, format: "json", detail: "full" }, context));
    assert.equal(status.lifecycleRequests.kill.type, "kill");
  } finally {
    runs.delete(runId);
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
    __setWriteStateTestHook(({ state }) => {
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
    assert.equal(await fileExists(lockPathForRun(status.dir, "run")), false, "run.lock must be released despite cleanup write failure");
    assert.equal(runs.has(runId), false, "in-memory run must be deleted despite cleanup write failure");
    assert.equal(await fileExists(path.join(status.dir, "events.jsonl")), true, "finalization cleanup diagnostic should be best-effort only");
  } finally {
    __setWriteStateTestHook(undefined);
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
    await writeJsonAtomic(path.join(status.dir, "pause-request.json"), { type: "pause", requestedAt: new Date().toISOString(), reason: "test durable pause" });
    releaseFirstPrompt();
    await runs.get(runId).done;
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
    assert.equal(runs.has(knownRunId), false, "precondition: run-map must not already hold the id");
    await assert.rejects(
      tools.workflow_run.execute(args, context),
      /injected events\.jsonl write failure/,
    );
    assert.equal(consumedRunId, true, "the stub must have supplied the run id");
    assert.equal(
      runs.has(knownRunId),
      false,
      "the failed setup must not leave a phantom run-map entry (runs.delete in catch)",
    );
  } finally {
    crypto.randomUUID = realRandomUUID;
    fs.appendFile = realAppendFile;
    await fs.rm(directory, { recursive: true, force: true });
  }
});
