// Multi-process durability tests for the run-store.
//
// These tests prove the run-store's cross-PROCESS durability claims, which the existing
// suites only exercise single-process (with seeded fixtures). Here every "other process"
// is a REAL OS process spawned via child_process.fork, holding real locks and dying real
// deaths. The run-store's only shared state across processes is the on-disk lock/state
// files, so these tests exercise the actual cross-process mutex and PID-liveness paths.
//
// Linux note: processAppearsAlive uses /proc/<pid>/stat to read the process start time and
// defeat PID reuse. On non-Linux the startTime is undefined and the bare signal-0 liveness
// check governs; the assertions below still hold there, they simply do not additionally
// exercise the start-time match.

import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import WorkflowPlugin from "../workflow-kernel/index.js";

const { __test } = WorkflowPlugin;
const {
  acquireWorkflowLock,
  readLock,
  lockPathForRun,
  clearStaleRunLocks,
  processAppearsAlive,
  runDirForRoot,
  writeJsonAtomic,
  readRunEntry,
} = __test;

const PLUGIN_ROOT = path.join(import.meta.dirname, "..");

const children = [];
const tempRoots = [];
let scriptsDir;
const holderPath = () => path.join(scriptsDir, "holder.mjs");
const scoutPath = () => path.join(scriptsDir, "scout.mjs");
const contenderPath = () => path.join(scriptsDir, "contender.mjs");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(fn, { timeoutMs = 5000, intervalMs = 25, msg } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await fn();
    if (last) return last;
    await sleep(intervalMs);
  }
  throw new Error(msg || `waitFor timed out after ${timeoutMs}ms (last=${JSON.stringify(last)})`);
}

async function tempRoot(label) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `wf-mpd-${label}-`));
  tempRoots.push(root);
  return root;
}

function forkScript(scriptPath, args = []) {
  const child = fork(scriptPath, args, { cwd: PLUGIN_ROOT, stdio: ["ignore", "pipe", "pipe", "ipc"] });
  children.push(child);
  let buffer = "";
  child.stdout.on("data", (chunk) => { buffer += chunk; });
  child.stderr.on("data", (chunk) => { buffer += chunk; });
  child.outBuffer = () => buffer;
  return child;
}

function messageOnce(child, { timeoutMs = 8000 } = {}) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`child did not message within ${timeoutMs}ms\n--- child output ---\n${child.outBuffer()}`)),
      timeoutMs,
    );
    child.once("message", (msg) => { clearTimeout(timer); resolve(msg); });
  });
}

function exitOf(child, { timeoutMs = 5000 } = {}) {
  if (child.exitCode !== null || child.signalCode) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`child did not exit within ${timeoutMs}ms`)), timeoutMs);
    child.once("exit", (code, signal) => { clearTimeout(timer); resolve({ code, signal }); });
  });
}

async function killChild(child) {
  if (!child || child.exitCode !== null || child.signalCode) return;
  try { child.kill("SIGTERM"); } catch { return; }
  try {
    await exitOf(child, { timeoutMs: 1500 });
  } catch {
    try { child.kill("SIGKILL"); } catch { /* already gone */ }
    await exitOf(child, { timeoutMs: 1500 }).catch(() => {});
  }
}

// --- Spawned helper scripts (written once, forked many times) ---------------------------

// Holder: acquires the run.lock, reports readiness + its own process info, then keeps the
// lock until it receives an IPC {release} message, at which point it releases and exits.
const HOLDER_SRC = `
import process from "node:process";
const [pluginRoot, lockPath] = process.argv.slice(2);
const { default: WP } = await import(pluginRoot + "/workflow-kernel/index.js");
const { acquireWorkflowLock } = WP.__test;
let release;
try {
  release = await acquireWorkflowLock(lockPath, { operation: "run" });
} catch (error) {
  if (typeof process.send === "function") process.send({ error: String((error && error.message) || error) });
  process.exit(1);
}
const info = await WP.__test.currentProcessInfo();
if (typeof process.send === "function") process.send({ ready: true, pid: process.pid, info });
process.on("message", (msg) => {
  if (msg && msg.release) {
    Promise.resolve(release())
      .then(() => { if (typeof process.send === "function") process.send({ released: true }); process.exit(0); })
      .catch((error) => { if (typeof process.send === "function") process.send({ error: String((error && error.message) || error) }); process.exit(1); });
  }
});
`;

// Scout: reports its own currentProcessInfo() (pid + start time) over IPC, then exits.
// Used to obtain a REAL process identity that becomes genuinely dead.
const SCOUT_SRC = `
import process from "node:process";
const [pluginRoot] = process.argv.slice(2);
const { default: WP } = await import(pluginRoot + "/workflow-kernel/index.js");
const info = await WP.__test.currentProcessInfo();
if (typeof process.send === "function") process.send({ info });
`;

// Contender: attempts ONE acquisition. Reports {acquired} or {denied} over IPC, releases if
// it acquired, then exits. The main process never calls a lock function in the two-child
// test, so this proves the mutex is between two independent processes.
const CONTENDER_SRC = `
import process from "node:process";
const [pluginRoot, lockPath] = process.argv.slice(2);
const { default: WP } = await import(pluginRoot + "/workflow-kernel/index.js");
const { acquireWorkflowLock } = WP.__test;
try {
  const release = await acquireWorkflowLock(lockPath, { operation: "run" });
  if (typeof process.send === "function") process.send({ acquired: true, pid: process.pid });
  await release();
} catch (error) {
  if (typeof process.send === "function") process.send({ denied: true, message: String((error && error.message) || error) });
}
process.exit(0);
`;

before(async () => {
  scriptsDir = await fs.mkdtemp(path.join(os.tmpdir(), "wf-mpd-scripts-"));
  await fs.writeFile(path.join(scriptsDir, "holder.mjs"), HOLDER_SRC);
  await fs.writeFile(path.join(scriptsDir, "scout.mjs"), SCOUT_SRC);
  await fs.writeFile(path.join(scriptsDir, "contender.mjs"), CONTENDER_SRC);
});

after(async () => {
  for (const child of children) await killChild(child);
  await Promise.all(tempRoots.map((root) => fs.rm(root, { recursive: true, force: true })));
  if (scriptsDir) await fs.rm(scriptsDir, { recursive: true, force: true });
});

// --- Scenario A: cross-process run.lock contention (holder = child, contender = main) ---

test("cross-process run.lock: a separate process holding the lock denies acquisition in this process", { timeout: 15000 }, async () => {
  const root = await tempRoot("lock-contend");
  const dir = runDirForRoot(root, "contend-run");
  await fs.mkdir(dir, { recursive: true });
  const lockPath = lockPathForRun(dir, "run");

  // A genuinely separate OS process acquires and holds the lock.
  const holder = forkScript(holderPath(), [PLUGIN_ROOT, lockPath]);
  const ready = await messageOnce(holder);
  assert.equal(ready.error, undefined, `holder failed to acquire lock: ${ready.error ?? ""}`);
  assert.equal(ready.ready, true);
  assert.notEqual(ready.pid, process.pid, "holder must be a different process");

  // Contention from THIS process must be denied while the holder is alive. The denial is
  // driven by the on-disk lock file (fs.link EEXIST), not any in-process state, so this
  // proves the mutex is cross-process.
  await assert.rejects(
    acquireWorkflowLock(lockPath, { operation: "run" }),
    (error) => /already held \(active\)/.test(error.message),
  );

  // Holder releases; the lock file is removed and acquisition in this process succeeds.
  holder.send({ release: true });
  const released = await messageOnce(holder);
  assert.equal(released.released, true);
  await exitOf(holder);

  const release = await acquireWorkflowLock(lockPath, { operation: "run" });
  const reread = await readLock(lockPath);
  assert.equal(reread.operation, "run");
  assert.equal(reread.process.pid, process.pid);
  assert.equal(reread.active, true);
  await release();
  assert.equal(await fs.access(lockPath).then(() => false, () => true), true, "release removes the lock file");
});

// --- Scenario A (strict): mutex between TWO spawned processes; main never locks ----------

test("cross-process run.lock mutex between two distinct spawned processes", { timeout: 15000 }, async () => {
  const root = await tempRoot("two-children");
  const dir = runDirForRoot(root, "two-children-run");
  await fs.mkdir(dir, { recursive: true });
  const lockPath = lockPathForRun(dir, "run");

  const holder = forkScript(holderPath(), [PLUGIN_ROOT, lockPath]);
  await messageOnce(holder); // ready

  // First contender (independent process) is denied while the holder holds.
  const contender1 = forkScript(contenderPath(), [PLUGIN_ROOT, lockPath]);
  const res1 = await messageOnce(contender1);
  await exitOf(contender1);
  assert.equal(res1.acquired, undefined, `contender must not acquire while lock is held: ${JSON.stringify(res1)}`);
  assert.equal(res1.denied, true);
  assert.match(res1.message, /already held \(active\)/);

  // Release the holder; the lock is now free.
  holder.send({ release: true });
  await messageOnce(holder);
  await exitOf(holder);

  // Second contender (independent process) now acquires and releases on its own.
  const contender2 = forkScript(contenderPath(), [PLUGIN_ROOT, lockPath]);
  const res2 = await messageOnce(contender2);
  await exitOf(contender2);
  assert.equal(res2.acquired, true, `contender should acquire after release: ${JSON.stringify(res2)}`);
  assert.equal(await fs.access(lockPath).then(() => false, () => true), true, "lock freed after contender released");
});

// --- Scenario B: stale-active reconcile over a REAL exited owner process ----------------

test("stale-active reconcile reclassifies a run owned by a REAL exited process as interrupted", { timeout: 15000 }, async () => {
  // Spawn a real process, capture its exact production identity, let it exit, and prove via
  // the production PID-liveness check that it is dead. This is NOT a seeded 999999999 fixture.
  const scout = forkScript(scoutPath(), [PLUGIN_ROOT]);
  const { info } = await messageOnce(scout);
  await exitOf(scout);
  await waitFor(async () => !(await processAppearsAlive(info)), { msg: "scout never appeared dead via processAppearsAlive" });
  assert.equal(await processAppearsAlive(info), false, "owner process must be provably dead before reconciling");

  const root = await tempRoot("dead-owner");
  const runId = "dead-owner-run";
  const dir = runDirForRoot(root, runId);
  await fs.mkdir(dir, { recursive: true });
  await writeJsonAtomic(path.join(dir, "state.json"), {
    id: runId,
    status: "running",
    startedAt: "2026-06-25T00:00:00.000Z",
    process: info,
    laneRecords: [],
  });

  // Read-only path (no reconcile): must NOT mutate any run files and must surface stale-active.
  const filesBefore = (await fs.readdir(dir)).sort();
  const readOnly = await readRunEntry(root, runId);
  assert.equal(readOnly.status, "stale-active");
  assert.deepEqual((await fs.readdir(dir)).sort(), filesBefore, "non-reconcile read must not write any run files");

  // Reconcile path: the genuinely-dead owner forces a persisted reclassification.
  const reconciled = await readRunEntry(root, runId, { reconcile: true });
  assert.equal(reconciled.status, "interrupted");
  assert.equal(reconciled.state.status, "interrupted");
  assert.equal(
    await fs.access(path.join(dir, "closeout.json")).then(() => true, () => false),
    true,
    "reconcile writes closeout.json for a dead owner",
  );
  const onDisk = JSON.parse(await fs.readFile(path.join(dir, "state.json"), "utf8"));
  assert.equal(onDisk.status, "interrupted");
  assert.ok(onDisk.finishedAt, "reconcile stamps finishedAt on the interrupted run");
});

// --- Scenario C: crashed holder (SIGKILL) leaves a stale lock reconcile reclaims --------

test("a holder killed with SIGKILL leaves a stale run.lock that blocks then is reclaimed", { timeout: 15000 }, async () => {
  const root = await tempRoot("kill9");
  const dir = runDirForRoot(root, "kill9-run");
  await fs.mkdir(dir, { recursive: true });
  const lockPath = lockPathForRun(dir, "run");

  const holder = forkScript(holderPath(), [PLUGIN_ROOT, lockPath]);
  const ready = await messageOnce(holder);
  assert.equal(ready.ready, true);
  const holderInfo = ready.info;

  // Crash the holder mid-lock; the lock file stays on disk owned by a now-dead process.
  process.kill(holder.pid, "SIGKILL");
  await exitOf(holder);
  await waitFor(async () => (await readLock(lockPath))?.stale === true, { msg: "lock never went stale after SIGKILL" });

  const stale = await readLock(lockPath);
  assert.equal(stale.active, false);
  assert.equal(stale.stale, true);
  assert.equal(stale.process.pid, holderInfo.pid);

  // A stale lock is not silently stolen: fresh acquisition stays blocked until reconcile.
  await assert.rejects(
    acquireWorkflowLock(lockPath, { operation: "run" }),
    (error) => /already held \(stale\)/.test(error.message),
  );

  // Reconcile clearing reclaims the stale lock so the run is acquirable again.
  const cleared = await clearStaleRunLocks({ kind: "valid", dir });
  assert.deepEqual(
    cleared.map((entry) => ({ operation: entry.operation, reason: entry.reason })),
    [{ operation: "run", reason: "stale" }],
  );
  assert.equal(await fs.access(lockPath).then(() => false, () => true), true, "stale lock file removed by reconcile");
  const release = await acquireWorkflowLock(lockPath, { operation: "run" });
  assert.ok(typeof release === "function");
  await release();
});

test("readRunEntry reconcile clears a crashed-holder stale run.lock out of state.locks and interrupts the run", { timeout: 15000 }, async () => {
  const root = await tempRoot("kill9-reconcile");
  const runId = "kill9-reconcile-run";
  const dir = runDirForRoot(root, runId);
  await fs.mkdir(dir, { recursive: true });
  const lockPath = lockPathForRun(dir, "run");

  const holder = forkScript(holderPath(), [PLUGIN_ROOT, lockPath]);
  const ready = await messageOnce(holder);
  const holderInfo = ready.info;

  await writeJsonAtomic(path.join(dir, "state.json"), {
    id: runId,
    status: "running",
    startedAt: "2026-06-25T00:00:00.000Z",
    process: holderInfo,
    laneRecords: [],
  });

  // Crash the holder so both the run's owner and the run.lock owner are genuinely dead.
  process.kill(holder.pid, "SIGKILL");
  await exitOf(holder);
  await waitFor(async () => (await readLock(lockPath))?.stale === true, { msg: "lock never went stale after SIGKILL" });

  // Before reconcile, the stale run.lock surfaces in state.locks.
  const before = await readRunEntry(root, runId);
  assert.equal(before.state.locks?.run?.stale, true);

  // Reconcile both interrupts the run (dead owner) AND clears the stale lock off disk.
  const reconciled = await readRunEntry(root, runId, { reconcile: true, clearStaleLocks: true });
  assert.equal(reconciled.status, "interrupted");
  assert.equal(reconciled.state.locks, undefined, "stale run.lock must be cleared by reconcile");
  assert.deepEqual((reconciled.state.staleLocksCleared ?? []).map((entry) => entry.reason), ["stale"]);
});

// --- Foundational: cross-process PID-liveness primitive in both directions ---------------

test("processAppearsAlive: a REAL exited process is dead and a REAL live separate process is alive", { timeout: 15000 }, async () => {
  // Dead direction: scout reports its identity then exits.
  const scout = forkScript(scoutPath(), [PLUGIN_ROOT]);
  const { info: deadInfo } = await messageOnce(scout);
  await exitOf(scout);
  await waitFor(async () => !(await processAppearsAlive(deadInfo)), { msg: "scout never appeared dead" });
  assert.equal(await processAppearsAlive(deadInfo), false);

  // Alive direction: holder reports its identity and stays alive while holding a lock.
  const root = await tempRoot("liveness");
  const dir = runDirForRoot(root, "liveness-run");
  await fs.mkdir(dir, { recursive: true });
  const holder = forkScript(holderPath(), [PLUGIN_ROOT, lockPathForRun(dir, "run")]);
  const { info: liveInfo } = await messageOnce(holder);
  try {
    assert.notEqual(liveInfo.pid, process.pid, "must be a distinct process");
    assert.equal(await processAppearsAlive(liveInfo), true, "a live separate process must appear alive");
  } finally {
    holder.send({ release: true });
    await messageOnce(holder);
    await exitOf(holder);
  }
});
