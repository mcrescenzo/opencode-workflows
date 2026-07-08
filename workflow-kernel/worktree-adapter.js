import path from "node:path";
import { git, gitCapture, gitSucceeds } from "./git-util.js";
import {
  assertContainedRealPath,
  createRawWorktree,
  hasWorkingTreeChanges,
  isPathInside,
  listWorktrees,
  parseWorktreeList,
  realpathPartial,
  requireGitRepo,
  worktreeStatus,
} from "./worktree-git.js";

function safeSlug(value, label) {
  const slug = String(value ?? "")
    .trim()
    .replace(/[^a-zA-Z0-9_.-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  if (!slug) throw new Error(`${label} must contain at least one safe path character`);
  return slug;
}

class CommitHookError extends Error {
  constructor({ directory, command, stderr, stdout, hookModifiedFiles, retried }) {
    const detail = (stderr || stdout || "").trim();
    super(
      `git ${command} failed in ${directory}${retried ? " after restage retry" : ""}: ${detail || "commit hook failure"}`,
    );
    this.name = "CommitHookError";
    this.directory = directory;
    this.command = command;
    this.stderr = stderr || "";
    this.stdout = stdout || "";
    this.hookModifiedFiles = !!hookModifiedFiles;
    this.retried = !!retried;
  }
}

function normalizeCreatedWorktree(input, data, fallback) {
  const worktreePath = path.resolve(data?.path || data?.directory || data?.dir || fallback.targetPath);
  return {
    role: fallback.role,
    runId: fallback.runId,
    laneId: fallback.laneId,
    path: worktreePath,
    branch: data?.branch || fallback.branch,
    baseRef: fallback.baseRef,
    id: data?.id,
    name: data?.name || input?.name || path.basename(worktreePath),
    native: Boolean(data),
  };
}

async function createWorktreeAdapter(options = {}) {
  const root = await requireGitRepo(options.directory || process.cwd());
  // Realpath the worktree root so a symlinked ancestor (e.g. a symlinked
  // worktreeRoot, or /home -> /Users on macOS) does not cause containment checks
  // against git's realpath-canonical worktree records to fail — which would leak
  // worktrees by refusing to remove/recover them.
  const worktreeRoot = await realpathPartial(options.worktreeRoot || path.join(path.dirname(root), `${path.basename(root)}.worktrees`));
  const nativeWorktreeClient = options.nativeWorktreeClient;
  const integrationValidator = options.integrationValidator;
  const execOptions = { signal: options.signal };

  // Concurrent `git worktree add`/`worktree remove` against the same repo race inside git's own
  // `.git/worktrees/` bookkeeping (observed: transient exit-128 "fatal: failed to read
  // .git/worktrees/<sibling>/commondir: Success" under parallel integration lanes), so serialize
  // them through a promise-chain mutex per adapter -- same idiom as writeState's stateWriteChains
  // and writeLaneProjection's laneProjectionWriteChains.
  let worktreeMutationChain = Promise.resolve();
  function withWorktreeMutationLock(task) {
    const current = worktreeMutationChain.catch(() => {}).then(task);
    worktreeMutationChain = current.catch(() => {});
    return current;
  }

  async function createManagedWorktree(input, role) {
    const runId = safeSlug(input.runId ?? "run", "runId");
    const laneId = role === "lane" ? safeSlug(input.laneId, "laneId") : undefined;
    const baseRef = input.baseRef || "HEAD";
    const branch = input.branch || (role === "lane" ? `workflow/${runId}/lane/${laneId}` : `workflow/${runId}/integration`);
    const targetPath = path.resolve(input.path || (role === "lane"
      ? path.join(worktreeRoot, runId, "lanes", laneId)
      : path.join(worktreeRoot, runId, "integration")));
    const fallback = { role, runId, laneId, baseRef, branch, targetPath };

    if (nativeWorktreeClient?.create) {
      const result = await nativeWorktreeClient.create({ body: { name: input.name || path.basename(targetPath), path: targetPath, branch }, query: { directory: root } });
      const data = result?.data ?? result;
      return normalizeCreatedWorktree(input, data, fallback);
    }

    await withWorktreeMutationLock(() => createRawWorktree({ root, targetPath, branch, baseRef, execOptions }));
    return normalizeCreatedWorktree(input, undefined, fallback);
  }

  async function findLinkedWorktree(targetPath) {
    // git worktree records are realpath-canonical; realpath the caller's target
    // (which may carry a symlinked ancestor) before matching so the record is
    // found instead of being misclassified as not-linked and leaked.
    const target = await realpathPartial(targetPath);
    const records = await listWorktrees(root);
    let record;
    for (const item of records) {
      if ((await realpathPartial(item.path)) === target) {
        record = item;
        break;
      }
    }
    return { target, records, record };
  }

  return {
    root,
    worktreeRoot,

    async createLaneWorktree(input = {}) {
      return await createManagedWorktree(input, "lane");
    },

    async createIntegrationWorktree(input = {}) {
      return await createManagedWorktree(input, "integration");
    },

    ...(typeof integrationValidator === "function" ? {
      async validateIntegrationWorktree(input = {}) {
        return await integrationValidator(input);
      },
    } : {}),

    async status(input = {}) {
      return await worktreeStatus(input.directory || input.path);
    },

    async diff(input = {}) {
      return (await git(input.directory || input.path, ["diff", "HEAD", "--"], execOptions)).stdout;
    },

    async commit(input = {}) {
      const directory = input.directory || input.path;
      const message = input.message || "workflow worktree commit";
      const command = `commit -m ${JSON.stringify(message)}`;
      await git(directory, ["add", "-A"], execOptions);
      if (await gitSucceeds(directory, ["diff", "--cached", "--quiet"], execOptions)) {
        return { committed: false, reason: "nothing-to-commit" };
      }
      const first = await gitCapture(directory, ["commit", "-m", message], execOptions);
      if (first.ok) {
        const commit = (await git(directory, ["rev-parse", "HEAD"], execOptions)).stdout.trim();
        return { committed: true, commit };
      }
      // A commit hook may have modified files (formatter) and left unstaged changes, or
      // rejected the commit (linter). Restage once and retry; never bypass hooks (--no-verify).
      const hookModified = await hasWorkingTreeChanges(directory, execOptions);
      if (hookModified) {
        await git(directory, ["add", "-A"], execOptions);
        const retry = await gitCapture(directory, ["commit", "-m", message], execOptions);
        if (retry.ok) {
          const commit = (await git(directory, ["rev-parse", "HEAD"], execOptions)).stdout.trim();
          return { committed: true, commit, hookModifiedFiles: true, retried: true };
        }
        // Dirty worktree is intentionally preserved so the hook output is reviewable.
        throw new CommitHookError({ directory, command, stderr: retry.stderr, stdout: retry.stdout, hookModifiedFiles: true, retried: true });
      }
      throw new CommitHookError({ directory, command, stderr: first.stderr, stdout: first.stdout, hookModifiedFiles: false, retried: false });
    },

    async merge(input = {}) {
      const args = input.message ? ["merge", "--no-ff", "-m", input.message, input.ref] : ["merge", "--no-ff", "--no-edit", input.ref];
      await git(input.directory || input.path, args, execOptions);
      return { merged: true, ref: input.ref, head: (await git(input.directory || input.path, ["rev-parse", "HEAD"], execOptions)).stdout.trim() };
    },

    async cherryPick(input = {}) {
      await git(input.directory || input.path, ["cherry-pick", input.ref], execOptions);
      return { cherryPicked: true, ref: input.ref, head: (await git(input.directory || input.path, ["rev-parse", "HEAD"], execOptions)).stdout.trim() };
    },

    async rebase(input = {}) {
      await git(input.directory || input.path, ["rebase", input.baseRef], execOptions);
      return { rebased: true, baseRef: input.baseRef, head: (await git(input.directory || input.path, ["rev-parse", "HEAD"], execOptions)).stdout.trim() };
    },

    async remove(input = {}) {
      const targetPath = input.path || input.directory;
      const { target, record } = await findLinkedWorktree(targetPath);
      if (!record) return { removed: false, preserved: true, reason: "not-linked-worktree", path: target };
      if (target === root) return { removed: false, preserved: true, reason: "main-worktree", path: target };
      if (!(await assertContainedRealPath(worktreeRoot, target)).inside) return { removed: false, preserved: true, reason: "outside-worktree-root", path: target };
      if (record.locked) return { removed: false, preserved: true, reason: "locked", path: target, record };
      const status = await worktreeStatus(target);
      if (!status.clean) return { removed: false, preserved: true, reason: "dirty", path: target, status };
      if (input.native && nativeWorktreeClient?.remove) {
        await nativeWorktreeClient.remove({ body: input.id ? { id: input.id } : {}, query: { directory: target } });
        return { removed: true, path: target };
      }
      await withWorktreeMutationLock(() => git(root, ["worktree", "remove", target], execOptions));
      // `git worktree remove` deletes the directory + admin record but leaves the
      // lane branch behind; over many autonomous-drain runs those orphaned
      // branches accumulate unbounded. Delete it with a capture helper that
      // swallows the "branch not found" error (detached worktree, branch already
      // gone, or a non-refs/heads ref). `git branch -D` wants the short name, so
      // strip the refs/heads/ prefix git reports in the porcelain record.
      const branchRef = typeof record.branch === "string" ? record.branch : "";
      const branchName = branchRef.startsWith("refs/heads/") ? branchRef.slice("refs/heads/".length) : branchRef;
      let branchDeleted = false;
      if (branchName) {
        const deletion = await gitCapture(root, ["branch", "-D", branchName], execOptions);
        branchDeleted = deletion.ok;
      }
      return { removed: true, path: target, branch: branchName || undefined, branchDeleted };
    },

    async recover(input = {}) {
      const known = Array.isArray(input.records) ? input.records : [];
      const records = await listWorktrees(root);
      // Key git records by their realpath-canonical path, and realpath the
      // caller-supplied known paths too, so a symlinked ancestor does not split
      // a single real worktree into a "missing" known entry plus an
      // "outside-worktree-root" git record (both of which would leak it).
      const byPath = new Map();
      for (const record of records) {
        byPath.set(await realpathPartial(record.path), record);
      }
      const knownReal = [];
      for (const record of known) {
        const raw = record.path || record.directory || "";
        if (raw) knownReal.push(await realpathPartial(raw));
      }
      const paths = [...new Set([...byPath.keys(), ...knownReal])];
      const worktrees = [];
      for (const itemPath of paths) {
        const record = byPath.get(itemPath);
        if (!record) {
          worktrees.push({ path: itemPath, state: "missing", preserved: true });
          continue;
        }
        if (itemPath === root) {
          worktrees.push({ path: itemPath, state: "main-worktree", preserved: true, record });
          continue;
        }
        if (!(await assertContainedRealPath(worktreeRoot, itemPath)).inside) {
          worktrees.push({ path: itemPath, state: "outside-worktree-root", preserved: true, record });
          continue;
        }
        if (record.locked) {
          worktrees.push({ path: itemPath, state: "locked", preserved: true, record });
          continue;
        }
        const status = await worktreeStatus(itemPath);
        worktrees.push({ path: itemPath, state: status.clean ? "clean" : "dirty", preserved: !status.clean, status, record });
      }
      return { root, worktreeRoot, worktrees };
    },
  };
}

export {
  CommitHookError,
  createWorktreeAdapter,
  isPathInside,
  parseWorktreeList,
  requireGitRepo,
  safeSlug,
  worktreeStatus,
};
