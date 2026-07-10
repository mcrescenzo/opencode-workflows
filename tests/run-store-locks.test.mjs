import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { acquireWorkflowLock, clearStaleRunLocks, lockPathForRun, readLock, runLocksForEntry } from "../workflow-kernel/run-store-locks.js";
import { DURABLE_STATE_VERSION } from "../workflow-kernel/constants.js";
import { runDirForRoot, writeJsonAtomic } from "../workflow-kernel/run-store-fs.js";
import { readRunEntry } from "../workflow-kernel/run-store-status-format.js";

// Lock-lifecycle regressions split out of durable-state.test.mjs (opencode-workflows-fnop.9):
// corrupt/partial lock detection, stale-lock TTL aging, transient-read-error (pi0w)
// classification, reclaimed-lock release safety, and corrupt-lock clearing during reconcile.

async function tempDir(name) {
  return await fs.mkdtemp(path.join(os.tmpdir(), `${name}-`));
}

test("corrupt/partial lock file is detected as corrupt and not stale", async () => {
  const dir = await tempDir("workflow-corrupt-lock");
  const lockPath = lockPathForRun(dir, "run");
  // A crash mid-write leaves an unparseable (partial) lock on disk.
  await fs.writeFile(lockPath, '{"acquiredAt":"2026-06-15T00:00:00.000Z","proc', "utf8");

  const lock = await readLock(lockPath);
  assert.equal(lock.corrupt, true, "unparseable lock must be flagged corrupt");
  assert.equal(lock.stale, false, "corrupt lock has no process so it is not classified stale");
  assert.equal(lock.active, false);
});

test("corrupt lock blocks acquisition with a reconcile recovery hint", async () => {
  const dir = await tempDir("workflow-corrupt-lock-acquire");
  const lockPath = lockPathForRun(dir, "run");
  await fs.writeFile(lockPath, "not-json-at-all", "utf8");

  await assert.rejects(
    acquireWorkflowLock(lockPath, { operation: "run" }),
    (error) => /already held \(corrupt\)/.test(error.message)
      && /workflow_reconcile/.test(error.message),
    "corrupt lock must surface a corrupt state + reconcile recovery hint",
  );
});

test("clearStaleRunLocks clears a corrupt lock so the run is acquirable again", async () => {
  const root = await tempDir("workflow-corrupt-lock-clear");
  const runId = "corrupt-lock-run";
  const dir = runDirForRoot(root, runId);
  await fs.mkdir(dir, { recursive: true });
  await writeJsonAtomic(path.join(dir, "state.json"), {
    id: runId,
    status: "completed",
    startedAt: "2026-06-15T00:00:00.000Z",
  });
  // Simulate a partial-write run.lock left behind by a crash.
  const lockPath = lockPathForRun(dir, "run");
  await fs.writeFile(lockPath, '{"operation":"run","acquir', "utf8");

  // Before reconcile, the corrupt lock surfaces in state.locks (wedging cleanup)
  // and blocks acquisition.
  const before = await runLocksForEntry({ kind: "valid", dir });
  assert.equal(before.run.corrupt, true, "corrupt lock should appear in run locks");
  await assert.rejects(
    acquireWorkflowLock(lockPath, { operation: "run" }),
    /already held \(corrupt\)/,
  );

  // Reconcile (clearStaleLocks) must clear the corrupt lock like a stale one.
  const cleared = await clearStaleRunLocks({ kind: "valid", dir });
  assert.deepEqual(
    cleared.map((entry) => ({ operation: entry.operation, reason: entry.reason })),
    [{ operation: "run", reason: "corrupt" }],
    "corrupt run lock must be cleared with reason=corrupt",
  );
  assert.equal(await fs.access(lockPath).then(() => true, () => false), false, "lock file removed");

  // The run is acquirable again, and the lock is now a fully-written record.
  const release = await acquireWorkflowLock(lockPath, { operation: "run" });
  const reacquired = await readLock(lockPath);
  assert.equal(reacquired.corrupt ?? false, false, "reacquired lock must be parseable");
  assert.equal(reacquired.operation, "run");
  await release();
  assert.equal(await fs.access(lockPath).then(() => true, () => false), false, "release removes the lock");
});

test("readLock classifies a transient non-ENOENT read error as unreadable, not corrupt (pi0w)", async (t) => {
  // pi0w regression: a failed READ (EACCES/EMFILE/EIO) tells us nothing about whether the
  // lock's owner is alive. It must be classified `unreadable`, never `corrupt`, so reconcile
  // does not delete a possibly-live lock on a filesystem hiccup. Only JSON.parse failure is corrupt.
  const dir = await tempDir("workflow-unreadable-lock");
  const lockPath = lockPathForRun(dir, "run");
  // A fully-written, parseable lock exists on disk; the failure is purely at the read step.
  const release = await acquireWorkflowLock(lockPath, { operation: "run", runId: "live-owner" });
  try {
    const originalReadFile = fs.readFile;
    const mock = t.mock.method(fs, "readFile", async (filePath, ...rest) => {
      if (String(filePath) === lockPath) {
        const error = new Error("too many open files");
        error.code = "EMFILE";
        throw error;
      }
      return await originalReadFile.call(fs, filePath, ...rest);
    });

    const lock = await readLock(lockPath);
    assert.equal(lock.unreadable, true, "a transient read error must be classified unreadable");
    assert.notEqual(lock.corrupt, true, "a transient read error must NOT be classified corrupt");
    assert.equal(lock.stale, false, "an unreadable lock is not stale");
    assert.equal(lock.active, false);
    mock.mock.restore();
  } finally {
    await release();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("clearStaleRunLocks does not delete an actively-held lock on a transient read error (pi0w)", async (t) => {
  // pi0w core regression: while a run.lock is held by a live process, a single transient read
  // failure on that lock path must not let clearStaleRunLocks (invoked from killRun on a foreign
  // run, and from workflow_reconcile) remove it — that would let a second process resume the run
  // concurrently, the exact corruption this lock prevents.
  const root = await tempDir("workflow-unreadable-lock-clear");
  const runId = "unreadable-lock-run";
  const dir = runDirForRoot(root, runId);
  await fs.mkdir(dir, { recursive: true });
  const lockPath = lockPathForRun(dir, "run");
  const release = await acquireWorkflowLock(lockPath, { operation: "run", runId });
  try {
    const originalReadFile = fs.readFile;
    const mock = t.mock.method(fs, "readFile", async (filePath, ...rest) => {
      if (String(filePath) === lockPath) {
        const error = new Error("permission denied");
        error.code = "EACCES";
        throw error;
      }
      return await originalReadFile.call(fs, filePath, ...rest);
    });

    const cleared = await clearStaleRunLocks({ kind: "valid", dir });
    assert.deepEqual(cleared, [], "a transiently-unreadable, actively-held lock must NOT be cleared");

    mock.mock.restore();
    assert.equal(await fs.access(lockPath).then(() => true, () => false), true, "the live lock file must remain on disk");
    const reread = await readLock(lockPath);
    assert.equal(reread.active, true, "the still-held lock reads back as active once the read succeeds again");
  } finally {
    await release();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("readLock ages out live-PID locks that lack a recorded process start time", async () => {
  const dir = await tempDir("workflow-startless-lock-ttl");
  const lockPath = lockPathForRun(dir, "run");
  await writeJsonAtomic(lockPath, {
    operation: "run",
    runId: "startless-lock",
    acquiredAt: "1970-01-01T00:00:00.000Z",
    process: { pid: process.pid },
  });

  const lock = await readLock(lockPath);

  assert.equal(lock.active, false);
  assert.equal(lock.stale, true);
});

test("workflow lock release does not unlink a reclaimed lock with a different process start time", async () => {
  const dir = await tempDir("workflow-lock-release-reclaimed");
  const lockPath = lockPathForRun(dir, "run");
  const releaseStaleOwner = await acquireWorkflowLock(lockPath, { operation: "run", runId: "first-owner" });
  const first = await readLock(lockPath);
  assert.equal(first.process.pid, process.pid);

  await writeJsonAtomic(lockPath, {
    stateVersion: DURABLE_STATE_VERSION,
    acquiredAt: new Date().toISOString(),
    operation: "run",
    runId: "reclaimed-owner",
    process: {
      pid: process.pid,
      startTime: (first.process.startTime ?? 0) + 1,
    },
  });

  await releaseStaleOwner();

  const after = await readLock(lockPath);
  assert.equal(after.runId, "reclaimed-owner", "stale release must leave the reclaimed lock in place");
  assert.notEqual(after.process.startTime, first.process.startTime);
});

test("readRunEntry reconcile clears a corrupt lock out of state.locks", async () => {
  const root = await tempDir("workflow-corrupt-lock-reconcile");
  const runId = "corrupt-lock-reconcile-run";
  const dir = runDirForRoot(root, runId);
  await fs.mkdir(dir, { recursive: true });
  await writeJsonAtomic(path.join(dir, "state.json"), {
    id: runId,
    status: "completed",
    startedAt: "2026-06-15T00:00:00.000Z",
  });
  await fs.writeFile(lockPathForRun(dir, "run"), "{partial", "utf8");

  const reconciled = await readRunEntry(root, runId, { reconcile: true, clearStaleLocks: true });
  assert.equal(reconciled.state.locks, undefined, "corrupt lock must be gone after reconcile");
  assert.deepEqual(
    (reconciled.state.staleLocksCleared ?? []).map((entry) => entry.reason),
    ["corrupt"],
    "reconcile must report the corrupt lock it cleared",
  );
});
