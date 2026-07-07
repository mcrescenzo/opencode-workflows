import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { changedPathsSinceBase, detectPathConflicts, integrateLaneCommits, normalizeIntegrationValidationResult, normalizeRelativePath } from "../workflow-kernel/integration-mode.js";

const execFileAsync = promisify(execFile);

async function initRepo() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "workflow-integration-mode-"));
  await execFileAsync("git", ["init"], { cwd: directory });
  await execFileAsync("git", ["config", "user.email", "workflow-test@example.com"], { cwd: directory });
  await execFileAsync("git", ["config", "user.name", "Workflow Test"], { cwd: directory });
  await fs.writeFile(path.join(directory, "README.md"), "initial\n", "utf8");
  await execFileAsync("git", ["add", "README.md"], { cwd: directory });
  await execFileAsync("git", ["commit", "-m", "initial"], { cwd: directory });
  return directory;
}

test("normalizeRelativePath rejects unsafe integration paths", () => {
  for (const filePath of ["", null, "/etc/passwd", "../escaped.txt", "safe/../escaped.txt", "safe\\..\\escaped.txt"]) {
    assert.throws(
      () => normalizeRelativePath(filePath),
      /Unsafe integration path:/,
      `${filePath} should be rejected`,
    );
  }
});

test("detectPathConflicts surfaces unsafe lane paths", () => {
  assert.throws(
    () => detectPathConflicts([{ callId: "lane-1", paths: [{ path: "/etc/passwd" }] }]),
    /Unsafe integration path: \/etc\/passwd/,
  );
});

test("detectPathConflicts reports overlapping lane writes", () => {
  assert.deepEqual(
    detectPathConflicts([
      { callId: "lane-1", paths: ["src/app.js", "README.md"] },
      { callId: "lane-2", paths: [{ path: "src/app.js" }] },
      { callId: "lane-2", paths: ["README.md"] },
    ]),
    [
      { path: "src/app.js", lanes: ["lane-1", "lane-2"] },
      { path: "README.md", lanes: ["lane-1", "lane-2"] },
    ],
  );
});

test("integrateLaneCommits stops before merging on path conflicts", async () => {
  const result = await integrateLaneCommits({
    adapter: {
      async createIntegrationWorktree() {
        throw new Error("should not create integration worktree after conflict");
      },
    },
    runId: "run-1",
    baseCommit: "base",
    lanes: [
      { callId: "lane-1", branch: "lane-1", paths: ["src/app.js"] },
      { callId: "lane-2", branch: "lane-2", paths: ["src/app.js"] },
    ],
  });

  assert.equal(result.status, "review-required");
  assert.equal(result.reason, "path-conflict");
  assert.deepEqual(result.conflicts, [{ path: "src/app.js", lanes: ["lane-1", "lane-2"] }]);
});

test("integrateLaneCommits reports unsupported lane changes", async () => {
  const result = await integrateLaneCommits({
    adapter: {},
    runId: "run-1",
    baseCommit: "base",
    lanes: [{ callId: "lane-1", branch: "lane-1", paths: [{ path: "deleted.txt", status: "D", supported: false }] }],
  });

  assert.equal(result.status, "review-required");
  assert.equal(result.reason, "unsupported-lane-change");
  assert.equal(result.culpritLane, "lane-1");
});

test("integrateLaneCommits reports merge failures from the integration worktree", async () => {
  const integrationPath = await fs.mkdtemp(path.join(os.tmpdir(), "workflow-integration-merge-"));
  try {
    const result = await integrateLaneCommits({
      adapter: {
        async createIntegrationWorktree() {
          return { path: integrationPath, branch: "workflow/integration" };
        },
        async merge() {
          throw new Error("merge conflict");
        },
      },
      runId: "run-1",
      baseCommit: "base",
      lanes: [{ callId: "lane-1", branch: "lane-1", paths: ["src/app.js"] }],
    });

    assert.equal(result.status, "review-required");
    assert.equal(result.reason, "merge-failed");
    assert.equal(result.culpritLane, "lane-1");
    assert.match(result.error, /merge conflict/);
  } finally {
    await fs.rm(integrationPath, { recursive: true, force: true });
  }
});

test("normalizeIntegrationValidationResult requires an explicit accepted result", () => {
  assert.deepEqual(normalizeIntegrationValidationResult(true), { accepted: true, status: "passed" });
  assert.deepEqual(normalizeIntegrationValidationResult({ status: "passed", validationCommands: ["test"] }), {
    accepted: true,
    status: "passed",
    validationCommands: ["test"],
    reason: undefined,
  });
  assert.equal(normalizeIntegrationValidationResult({ status: "failed", reason: "tests failed" }).accepted, false);
  assert.equal(normalizeIntegrationValidationResult(undefined).accepted, false);
});

test("integrateLaneCommits stops before patch building when integration validation fails", async () => {
  const integrationPath = await fs.mkdtemp(path.join(os.tmpdir(), "workflow-integration-validation-"));
  try {
    const result = await integrateLaneCommits({
      adapter: {
        async createIntegrationWorktree() {
          return { path: integrationPath, branch: "workflow/integration" };
        },
        async merge() {
          return { merged: true };
        },
        async validateIntegrationWorktree() {
          return { accepted: false, status: "failed", reason: "tests failed", validationCommands: ["npm test"] };
        },
      },
      runId: "run-1",
      baseCommit: "base",
      lanes: [{ callId: "lane-1", branch: "lane-1", paths: ["src/app.js"] }],
    });

    assert.equal(result.status, "review-required");
    assert.equal(result.reason, "integration-validation-failed");
    assert.equal(result.validation.reason, "tests failed");
    assert.equal(result.patches, undefined);
  } finally {
    await fs.rm(integrationPath, { recursive: true, force: true });
  }
});

test("changedPathsSinceBase reports committed file changes from a real repo", async () => {
  const directory = await initRepo();
  try {
    const baseCommit = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: directory, encoding: "utf8" })).stdout.trim();
    await fs.writeFile(path.join(directory, "README.md"), "changed\n", "utf8");
    await fs.writeFile(path.join(directory, "added.txt"), "added\n", "utf8");
    await execFileAsync("git", ["add", "README.md", "added.txt"], { cwd: directory });
    await execFileAsync("git", ["commit", "-m", "change files"], { cwd: directory });

    const changes = await changedPathsSinceBase(directory, baseCommit);

    assert.deepEqual(changes.sort((a, b) => a.path.localeCompare(b.path)), [
      { status: "A", path: "added.txt", supported: true },
      { status: "M", path: "README.md", supported: true },
    ]);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
