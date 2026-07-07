// Shared run-store primitives: FS/JSON atomic helpers, run-id/path containment guards,
// run-root resolution, PID liveness, and the in-memory `runs` registry. These are the
// concern-agnostic building blocks that every run-store module (durable state, locks,
// projections, rehydration, status formatting) reads/writes; they were extracted from the
// former 957-line run-store-status.js (opencode-workflows-nbp) so each concern module can
// depend on this base rather than on each other.

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { GLOBAL_WORKFLOW_DIR, RUN_ID_RE } from "./constants.js";
import { hash } from "./text-json.js";
import { projectWorkflowDir } from "./workflow-source.js";
import { pathContains as isPathInside } from "./path-policy.js";

const PRIVATE_DIR_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const LOCK_LIVENESS_FALLBACK_TTL_MS = 24 * 60 * 60 * 1000;

async function chmodBestEffort(filePath, mode) {
  try {
    await fs.chmod(filePath, mode);
  } catch {
    // chmod can be unsupported on some filesystems. Creation still requested the
    // restrictive mode; keep workflow execution moving if the chmod backstop is unavailable.
  }
}

async function ensurePrivateDir(dir) {
  await fs.mkdir(dir, { recursive: true, mode: PRIVATE_DIR_MODE });
  await chmodBestEffort(dir, PRIVATE_DIR_MODE);
}

function privateFileOptions(options = "utf8") {
  if (typeof options === "string") return { encoding: options, mode: PRIVATE_FILE_MODE };
  return { mode: PRIVATE_FILE_MODE, ...options };
}

async function writeFilePrivate(filePath, data, options = "utf8") {
  await ensurePrivateDir(path.dirname(filePath));
  await fs.writeFile(filePath, data, privateFileOptions(options));
  await chmodBestEffort(filePath, PRIVATE_FILE_MODE);
}

async function appendFilePrivate(filePath, data, options = "utf8") {
  await ensurePrivateDir(path.dirname(filePath));
  await fs.appendFile(filePath, data, privateFileOptions(options));
  await chmodBestEffort(filePath, PRIVATE_FILE_MODE);
}

// Generic FS-JSON helper (read with fallback) — colocated with writeJsonAtomic/pathExists.
async function readJsonFile(filePath, fallback) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw error;
  }
}

async function writeJsonAtomic(filePath, value) {
  const tmp = `${filePath}.${process.pid}.${Date.now()}.${crypto.randomUUID()}.tmp`;
  try {
    await writeFilePrivate(tmp, JSON.stringify(value, null, 2), "utf8");
    await fs.rename(tmp, filePath);
    await chmodBestEffort(filePath, PRIVATE_FILE_MODE);
  } catch (error) {
    // A write/rename failure (EACCES/ENOSPC) can otherwise orphan a tmp file on disk.
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw error;
  }
}

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

const runs = new Map();

let selfStartTime;

function assertSafeRunId(runId, label = "runId") {
  if (typeof runId !== "string" || !RUN_ID_RE.test(runId) || runId === "." || runId === "..") {
    throw new Error(`${label} must be a simple run id without path separators`);
  }
  return runId;
}

function runDirForRoot(root, runId) {
  assertSafeRunId(runId);
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, runId);
  if (!resolved.startsWith(`${resolvedRoot}${path.sep}`)) throw new Error(`runId escapes workflow run root: ${runId}`);
  return resolved;
}

async function processStartTime(pid) {
  // Linux-only best effort: field 22 of /proc/<pid>/stat is the process start time. The
  // comm (field 2) can contain spaces/parens, so parse after the final ')'.
  try {
    const stat = await fs.readFile(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 1).trim().split(/\s+/);
    const starttime = Number(fields[19]);
    return Number.isFinite(starttime) ? starttime : undefined;
  } catch {
    return undefined;
  }
}

async function selfProcessStartTime() {
  if (selfStartTime === undefined) selfStartTime = (await processStartTime(process.pid)) ?? null;
  return selfStartTime === null ? undefined : selfStartTime;
}

async function processAppearsAlive(processInfo, {
  readStartTime = processStartTime,
  now = Date.now(),
  lockTtlMs = LOCK_LIVENESS_FALLBACK_TTL_MS,
} = {}) {
  const owner = processInfo && typeof processInfo === "object" && processInfo.process ? processInfo.process : processInfo;
  const pid = typeof owner === "number" ? owner : owner?.pid;
  if (!Number.isInteger(pid) || pid <= 0) return false;
  let alive;
  try {
    process.kill(pid, 0);
    alive = true;
  } catch (error) {
    alive = error.code === "EPERM";
  }
  if (!alive) return false;
  // Guard against PID reuse: if the owner's process start time was recorded, compare it to
  // the live process's start time. When NO start time was recorded (non-Linux owner, legacy
  // state) we have nothing to compare against, so fall back to the bare liveness check.
  const recordedStart = typeof owner === "object" ? owner?.startTime : undefined;
  if (Number.isFinite(recordedStart)) {
    // A recorded start exists, so we expect to be able to confirm it. Distrust the PID unless
    // the live start is readable AND matches: a non-finite liveStart (/proc unreadable,
    // hidepid/EPERM, TOCTOU) is treated as a mismatch rather than blind trust, so a reused PID
    // is not pinned as active and reconcile/cleanup is not blocked.
    const liveStart = await readStartTime(pid);
    if (!Number.isFinite(liveStart) || liveStart !== recordedStart) return false;
  } else if (processInfo && typeof processInfo === "object" && typeof processInfo.acquiredAt === "string") {
    const acquiredMs = Date.parse(processInfo.acquiredAt);
    if (Number.isFinite(acquiredMs) && Number.isFinite(lockTtlMs) && lockTtlMs > 0 && now - acquiredMs >= lockTtlMs) {
      return false;
    }
  }
  return true;
}

async function currentProcessInfo() {
  return { pid: process.pid, startTime: await selfProcessStartTime() };
}

function runRoot(context) {
  return path.join(projectWorkflowDir(context), "runs");
}

function globalRunRoot(context) {
  const key = hash(path.resolve(context.worktree || context.directory || ".")).slice(0, 16);
  return path.join(GLOBAL_WORKFLOW_DIR, "runs", key);
}

function runRoots(context) {
  return [...new Set([runRoot(context), globalRunRoot(context)])];
}

async function ensureRunRoot(context) {
  for (const root of runRoots(context)) {
    try {
      await ensurePrivateDir(root);
      await writeFilePrivate(path.join(root, ".gitignore"), "*\n!.gitignore\n", "utf8");
      return root;
    } catch (error) {
      if (error.code !== "EACCES" && error.code !== "EROFS" && error.code !== "EPERM") throw error;
    }
  }
  throw new Error("Could not create a writable workflow run directory");
}

async function assertContainedRealPath(root, candidate, label) {
  const rootReal = await fs.realpath(root);
  const candidateReal = await fs.realpath(candidate);
  if (!isPathInside(rootReal, candidateReal)) throw new Error(`${label} escapes expected root: ${candidate}`);
  return { rootReal, candidateReal };
}

async function assertContainedRunDir(root, dir) {
  await assertContainedRealPath(root, dir, "Workflow run directory");
  const stat = await fs.lstat(dir);
  if (stat.isSymbolicLink()) throw new Error(`Workflow run directory is a symlink: ${dir}`);
  if (!stat.isDirectory()) throw new Error(`Workflow run path is not a directory: ${dir}`);
}

function safeProjectionName(value) {
  const safe = String(value ?? "").replace(/[^a-z0-9_.-]+/gi, "_").replace(/^_+|_+$/g, "").slice(0, 120);
  return safe || hash(String(value ?? "lane")).slice(0, 16);
}

export {
  PRIVATE_DIR_MODE,
  PRIVATE_FILE_MODE,
  LOCK_LIVENESS_FALLBACK_TTL_MS,
  runs,
  selfStartTime,
  readJsonFile,
  writeJsonAtomic,
  ensurePrivateDir,
  writeFilePrivate,
  appendFilePrivate,
  pathExists,
  assertSafeRunId,
  runDirForRoot,
  processStartTime,
  selfProcessStartTime,
  processAppearsAlive,
  currentProcessInfo,
  runRoot,
  globalRunRoot,
  runRoots,
  ensureRunRoot,
  assertContainedRealPath,
  assertContainedRunDir,
  safeProjectionName,
  isPathInside,
};
