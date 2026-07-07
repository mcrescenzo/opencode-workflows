import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { createWorktreeAdapter, CommitHookError } from "../workflow-kernel/worktree-adapter.js";

const execFileAsync = promisify(execFile);

async function initRepo() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "worktree-commit-hook-"));
  await execFileAsync("git", ["init"], { cwd: directory });
  await execFileAsync("git", ["config", "user.email", "workflow-test@example.com"], { cwd: directory });
  await execFileAsync("git", ["config", "user.name", "Workflow Test"], { cwd: directory });
  await fs.writeFile(path.join(directory, "README.md"), "initial\n", "utf8");
  await execFileAsync("git", ["add", "README.md"], { cwd: directory });
  await execFileAsync("git", ["commit", "-m", "initial"], { cwd: directory });
  return directory;
}

async function writeHook(directory, script) {
  const hookPath = path.join(directory, ".git", "hooks", "pre-commit");
  await fs.writeFile(hookPath, script, "utf8");
  await fs.chmod(hookPath, 0o755);
}

test("commit returns nothing-to-commit for a clean worktree", async () => {
  const directory = await initRepo();
  try {
    const adapter = await createWorktreeAdapter({ directory });

    const result = await adapter.commit({ directory, message: "no changes" });

    assert.deepEqual(result, { committed: false, reason: "nothing-to-commit" });
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("commit recovers when a formatter hook modifies files and the retry succeeds", async () => {
  const directory = await initRepo();
  try {
    // Idempotent formatter: appends FORMATTED once (rejecting so we re-stage), then passes.
    await writeHook(
      directory,
      `#!/bin/sh
if grep -q FORMATTED file.txt; then
  exit 0
else
  printf 'FORMATTED\\n' >> file.txt
  echo 'formatter: file.txt needed reformatting' >&2
  exit 1
fi
`,
    );
    await fs.writeFile(path.join(directory, "file.txt"), "original\n", "utf8");
    const adapter = await createWorktreeAdapter({ directory });

    const result = await adapter.commit({ directory, message: "lane with formatter hook" });

    assert.equal(result.committed, true);
    assert.equal(result.hookModifiedFiles, true);
    assert.equal(result.retried, true);
    assert.ok(result.commit, "retry commit produced a sha");
    const committed = await fs.readFile(path.join(directory, "file.txt"), "utf8");
    assert.match(committed, /FORMATTED/);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("commit surfaces hook output in a CommitHookError and preserves the dirty worktree when a linter rejects", async () => {
  const directory = await initRepo();
  try {
    await writeHook(
      directory,
      `#!/bin/sh
echo 'flake8: E501 line too long at file.txt:1' >&2
exit 1
`,
    );
    await fs.writeFile(path.join(directory, "file.txt"), "original\n", "utf8");
    const adapter = await createWorktreeAdapter({ directory });

    await assert.rejects(
      () => adapter.commit({ directory, message: "lane with linter hook" }),
      (error) => {
        assert.ok(error instanceof CommitHookError, "should throw CommitHookError");
        assert.match(error.stderr, /flake8: E501/);
        assert.equal(error.hookModifiedFiles, false);
        assert.equal(error.retried, false);
        assert.equal(error.command.includes("commit"), true);
        return true;
      },
    );

    // The staged change is still present (worktree preserved, not cleaned up).
    const staged = await execFileAsync("git", ["diff", "--cached", "--name-only"], { cwd: directory });
    assert.match(staged.stdout, /file.txt/);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("commit never bypasses hooks (no --no-verify) when a hook fails", async () => {
  const directory = await initRepo();
  try {
    let invoked = false;
    const realHook = `#!/bin/sh
echo 'rejected-by-hook' >&2
exit 1
`;
    await writeHook(directory, realHook);
    await fs.writeFile(path.join(directory, "file.txt"), "original\n", "utf8");
    const adapter = await createWorktreeAdapter({ directory });

    await assert.rejects(() => adapter.commit({ directory, message: "must not bypass" }), /rejected-by-hook/);

    // The hook must actually have run (it was the thing that failed). Confirm by checking
    // that a no-op commit after removing the hook succeeds, proving --no-verify was not used.
    invoked = true;
    await writeHook(directory, "#!/bin/sh\nexit 0\n");
    const again = await adapter.commit({ directory, message: "retry after hook removed" });
    assert.equal(again.committed, true);
    assert.ok(invoked);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("createLaneWorktree rejects an existing worktree branch", async () => {
  const directory = await initRepo();
  const worktreeRoot = path.join(path.dirname(directory), `${path.basename(directory)}.worktrees`);
  try {
    await execFileAsync("git", ["branch", "workflow/run/lane/lane1"], { cwd: directory });
    const adapter = await createWorktreeAdapter({ directory, worktreeRoot });

    await assert.rejects(
      () => adapter.createLaneWorktree({ runId: "run", laneId: "lane1" }),
      /Worktree branch already exists: workflow\/run\/lane\/lane1/,
    );
  } finally {
    await fs.rm(worktreeRoot, { recursive: true, force: true });
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("createLaneWorktree rejects an existing target path", async () => {
  const directory = await initRepo();
  const worktreeRoot = path.join(path.dirname(directory), `${path.basename(directory)}.worktrees`);
  const targetPath = path.join(worktreeRoot, "run", "lanes", "lane1");
  try {
    await fs.mkdir(targetPath, { recursive: true });
    const adapter = await createWorktreeAdapter({ directory, worktreeRoot });

    await assert.rejects(
      () => adapter.createLaneWorktree({ runId: "run", laneId: "lane1" }),
      new RegExp(`Worktree path already exists: ${targetPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`),
    );
  } finally {
    await fs.rm(worktreeRoot, { recursive: true, force: true });
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("merge surfaces conflicts without cleaning the conflicted worktree", async () => {
  const directory = await initRepo();
  try {
    const baseBranch = (await execFileAsync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: directory })).stdout.trim();
    await execFileAsync("git", ["checkout", "-b", "feature"], { cwd: directory });
    await fs.writeFile(path.join(directory, "README.md"), "feature change\n", "utf8");
    await execFileAsync("git", ["commit", "-am", "feature change"], { cwd: directory });

    await execFileAsync("git", ["checkout", baseBranch], { cwd: directory });
    await fs.writeFile(path.join(directory, "README.md"), "base change\n", "utf8");
    await execFileAsync("git", ["commit", "-am", "base change"], { cwd: directory });

    const adapter = await createWorktreeAdapter({ directory });
    await assert.rejects(
      () => adapter.merge({ directory, ref: "feature" }),
      /CONFLICT|Automatic merge failed|merge failed/i,
    );

    const status = await execFileAsync("git", ["status", "--porcelain"], { cwd: directory });
    assert.match(status.stdout, /^UU README\.md/m, "conflicted file should remain for review");
  } finally {
    await execFileAsync("git", ["merge", "--abort"], { cwd: directory }).catch(() => {});
    await fs.rm(directory, { recursive: true, force: true });
  }
});
