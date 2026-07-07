import fs from "node:fs/promises";
import path from "node:path";
import { git, gitCapture, gitSucceeds } from "./git-util.js";
import { pathContains } from "./path-policy.js";

async function hasWorkingTreeChanges(directory, options = {}) {
  // Detect UNSTAGED modifications (working tree differs from index), which is the
  // signal that a commit hook (e.g. a formatter) rewrote files. Pre-existing staged
  // changes do not count — those are already in the index and are not hook output.
  const result = await gitCapture(directory, ["diff", "--name-only"], options);
  return result.ok && result.stdout.trim().length > 0;
}

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

// Resolve symlinks in an absolute path even when the leaf (or some trailing
// segments) do not exist on disk yet — git worktree records can point at paths
// that have already been removed during recovery. We realpath the deepest
// existing ancestor (canonicalizing any symlinked ancestor such as macOS
// /tmp -> /private/tmp or a /home -> /Users bind mount) and re-append the
// missing tail. fs.realpath alone throws ENOENT for a missing leaf, which is
// why this walks up to the nearest existing directory.
async function realpathPartial(targetPath) {
  let current = path.resolve(targetPath);
  const tail = [];
  // Walk up until we find an existing ancestor (or hit the filesystem root).
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      const resolved = await fs.realpath(current);
      return tail.length ? path.join(resolved, ...tail) : resolved;
    } catch (error) {
      if (error.code !== "ENOENT") {
        // Permission or other errors: fall back to the lexical resolution so we
        // never throw out of a cleanup path.
        return path.resolve(targetPath);
      }
      const parent = path.dirname(current);
      if (parent === current) return path.resolve(targetPath);
      tail.unshift(path.basename(current));
      current = parent;
    }
  }
}

function isPathInside(parent, child) {
  return pathContains(path.resolve(parent), path.resolve(child));
}

// Containment check whose basis is realpath-canonical on both sides, so a
// symlinked ancestor on either the worktree root or the candidate does not
// produce a false "outside" verdict.
async function assertContainedRealPath(parent, child) {
  const parentReal = await realpathPartial(parent);
  const childReal = await realpathPartial(child);
  return { inside: isPathInside(parentReal, childReal), parentReal, childReal };
}

async function requireGitRepo(directory) {
  const inside = (await git(directory, ["rev-parse", "--is-inside-work-tree"])).stdout.trim();
  if (inside !== "true") throw new Error(`Worktree adapter requires a Git repository: ${directory}`);
  const root = (await git(directory, ["rev-parse", "--show-toplevel"])).stdout.trim();
  await git(root, ["rev-parse", "--verify", "HEAD"]);
  // git --show-toplevel is realpath-canonical; realpath defensively so every
  // containment/match basis in the adapter is on the same canonical footing.
  return await realpathPartial(root);
}

function parseWorktreeList(text) {
  const records = [];
  let current;
  for (const token of text.split("\0")) {
    if (!token) continue;
    const [key, ...rest] = token.split(" ");
    const value = rest.join(" ");
    if (key === "worktree") {
      if (current) records.push(current);
      current = { path: path.resolve(value), fields: {}, raw: [] };
    } else if (current) {
      current.raw.push(token);
      current.fields[key] = value || true;
      if (key === "HEAD") current.head = value;
      if (key === "branch") current.branch = value;
      if (key === "detached") current.detached = true;
      if (key === "locked") current.locked = value || true;
      if (key === "prunable") current.prunable = value || true;
    }
  }
  if (current) records.push(current);
  return records;
}

async function listWorktrees(root) {
  const { stdout } = await git(root, ["worktree", "list", "--porcelain", "-z"]);
  return parseWorktreeList(stdout);
}

async function worktreeStatus(directory) {
  const porcelain = (await git(directory, ["status", "--porcelain=v1", "--untracked-files=all"])).stdout;
  const lines = porcelain.split(/\r?\n/).filter(Boolean);
  const untracked = lines.filter((line) => line.startsWith("??"));
  const tracked = lines.filter((line) => !line.startsWith("??"));
  return {
    directory: path.resolve(directory),
    porcelain,
    clean: lines.length === 0,
    dirty: lines.length > 0,
    trackedDirty: tracked.length > 0,
    untrackedDirty: untracked.length > 0,
    entries: lines,
  };
}

async function assertBranchAvailable(root, branch, options = {}) {
  await git(root, ["check-ref-format", "--branch", branch], options);
  if (await gitSucceeds(root, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], options)) {
    throw new Error(`Worktree branch already exists: ${branch}`);
  }
}

async function createRawWorktree({ root, targetPath, branch, baseRef, execOptions }) {
  await assertBranchAvailable(root, branch, execOptions);
  if (await pathExists(targetPath)) throw new Error(`Worktree path already exists: ${targetPath}`);
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  await git(root, ["worktree", "add", "-b", branch, targetPath, baseRef], execOptions);
}

export {
  assertBranchAvailable,
  assertContainedRealPath,
  createRawWorktree,
  hasWorkingTreeChanges,
  isPathInside,
  listWorktrees,
  parseWorktreeList,
  pathExists,
  realpathPartial,
  requireGitRepo,
  worktreeStatus,
};
