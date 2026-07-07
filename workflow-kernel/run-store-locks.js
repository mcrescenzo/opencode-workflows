// Concern (2): lock-file management. Atomic exclusive run/apply/cleanup lock acquisition,
// lock reading with PID-liveness staleness, stale/corrupt lock clearing during reconcile,
// and durable cancel/pause lifecycle request envelopes. Extracted from run-store-status.js
// (opencode-workflows-nbp). Reads/writes the lock + lifecycle-request files under a run dir;
// the RunContext properties it touches are limited to durable on-disk lock state (not the
// in-memory run object). See {@link import("./run-context.js").RunContext}.

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { DURABLE_STATE_VERSION } from "./constants.js";
import { extractTextFromError } from "./text-json.js";
import {
  currentProcessInfo,
  ensurePrivateDir,
  processAppearsAlive,
  readJsonFile,
  writeFilePrivate,
  writeJsonAtomic,
} from "./run-store-fs.js";

const RUN_LOCK_FILE = "run.lock";

const APPLY_LOCK_FILE = "apply.lock";

const CLEANUP_LOCK_FILE = ".cleanup.lock";

const CANCEL_REQUEST_FILE = "cancel-request.json";

const PAUSE_REQUEST_FILE = "pause-request.json";

const KILL_REQUEST_FILE = "kill-request.json";

function lockPathForRun(dir, operation) {
  if (operation === "run") return path.join(dir, RUN_LOCK_FILE);
  if (operation === "apply") return path.join(dir, APPLY_LOCK_FILE);
  throw new Error(`Unknown workflow lock operation: ${operation}`);
}

function cleanupLockPath(root) {
  return path.join(root, CLEANUP_LOCK_FILE);
}

async function readLock(lockPath) {
  // Split reading from parsing. A failed READ (EACCES/EMFILE/ENFILE/EIO/EISDIR —
  // plausible under this codebase's many concurrent lanes) tells us nothing about
  // whether the lock's owner is alive, so it is classified `unreadable`, NOT
  // `corrupt`. Only a genuine JSON.parse failure means the on-disk bytes are
  // malformed (a partial write from a crash) — the one case reconcile may clear.
  // If read errors were treated as corrupt, a transient FS hiccup at the wrong
  // moment would let clearStaleRunLocks delete an actively-held lock.
  let content;
  try {
    content = await fs.readFile(lockPath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    return { path: lockPath, active: false, stale: false, unreadable: true, error: extractTextFromError(error) };
  }
  let metadata;
  try {
    metadata = JSON.parse(content);
  } catch (error) {
    return { path: lockPath, active: false, stale: false, corrupt: true, error: extractTextFromError(error) };
  }
  const active = await processAppearsAlive(metadata);
  return { ...metadata, path: lockPath, active, stale: !active };
}

async function acquireWorkflowLock(lockPath, metadata) {
  await ensurePrivateDir(path.dirname(lockPath));
  const record = {
    stateVersion: DURABLE_STATE_VERSION,
    acquiredAt: new Date().toISOString(),
    ...metadata,
    process: await currentProcessInfo(),
  };
  // Lock creation must be atomic so a crash mid-write cannot leave a partial
  // (corrupt) lock file that wedges the run. Write the full record to a temp
  // file, then hard-link it into place: fs.link fails with EEXIST if the lock
  // already exists, giving us atomic exclusive create with fully-written bytes.
  const tmp = `${lockPath}.${process.pid}.${Date.now()}.${crypto.randomUUID()}.tmp`;
  try {
    await writeFilePrivate(tmp, JSON.stringify(record, null, 2), "utf8");
    await fs.link(tmp, lockPath);
  } catch (error) {
    if (error.code === "EEXIST") {
      const existing = await readLock(lockPath);
      const state = existing?.active ? "active" : existing?.stale ? "stale" : existing?.corrupt ? "corrupt" : "unreadable";
      const recovery = (existing?.stale || existing?.corrupt)
        ? "; run workflow_reconcile to clear stale/corrupt run locks"
        : "";
      throw new Error(`Workflow ${metadata.operation} lock is already held (${state}): ${lockPath}${recovery}`);
    }
    throw error;
  } finally {
    await fs.rm(tmp, { force: true });
  }
  return async () => {
    const current = await readLock(lockPath);
    if (current?.process?.pid === process.pid && current?.process?.startTime === record.process.startTime) {
      await fs.rm(lockPath, { force: true });
    }
  };
}

async function runLocksForEntry(entry) {
  const locks = {};
  if (entry.kind !== "valid") return locks;
  for (const [name, file] of Object.entries({ run: RUN_LOCK_FILE, apply: APPLY_LOCK_FILE })) {
    const lock = await readLock(path.join(entry.dir, file));
    if (lock) locks[name] = lock;
  }
  return locks;
}

async function clearStaleRunLocks(entry) {
  if (entry.kind !== "valid") return [];
  const cleared = [];
  for (const [operation, file] of Object.entries({ run: RUN_LOCK_FILE, apply: APPLY_LOCK_FILE })) {
    const lockPath = path.join(entry.dir, file);
    const lock = await readLock(lockPath);
    // A corrupt (partial-write) lock has no owning process we can ever match and
    // is never released, so it would permanently wedge acquisition and block
    // cleanup. Treat it like a stale lock and clear it during reconcile.
    // An `unreadable` lock (transient read error — EACCES/EMFILE/EIO) is
    // deliberately NOT cleared here: we could not read it, so it may still be
    // actively held, and deleting it would let a second process resume the run.
    if (lock?.stale || lock?.corrupt) {
      await fs.rm(lockPath, { force: true });
      cleared.push({ operation, path: lockPath, reason: lock?.corrupt ? "corrupt" : "stale" });
    }
  }
  return cleared;
}

function lifecycleRequestPath(dir, type) {
  if (type === "cancel") return path.join(dir, CANCEL_REQUEST_FILE);
  if (type === "pause") return path.join(dir, PAUSE_REQUEST_FILE);
  if (type === "kill") return path.join(dir, KILL_REQUEST_FILE);
  throw new Error(`Unknown workflow lifecycle request type: ${type}`);
}

async function writeLifecycleRequest(dir, type, reason) {
  const request = {
    stateVersion: DURABLE_STATE_VERSION,
    type,
    requestedAt: new Date().toISOString(),
    reason: reason || `${type} requested`,
    process: await currentProcessInfo(),
  };
  await writeJsonAtomic(lifecycleRequestPath(dir, type), request);
  return request;
}

async function readLifecycleRequests(dir) {
  const requests = {};
  for (const type of ["cancel", "pause", "kill"]) {
    const request = await readJsonFile(lifecycleRequestPath(dir, type), undefined);
    if (request) requests[type] = request;
  }
  return requests;
}

export {
  RUN_LOCK_FILE,
  APPLY_LOCK_FILE,
  CLEANUP_LOCK_FILE,
  CANCEL_REQUEST_FILE,
  PAUSE_REQUEST_FILE,
  KILL_REQUEST_FILE,
  lockPathForRun,
  cleanupLockPath,
  readLock,
  acquireWorkflowLock,
  runLocksForEntry,
  clearStaleRunLocks,
  lifecycleRequestPath,
  writeLifecycleRequest,
  readLifecycleRequests,
};
