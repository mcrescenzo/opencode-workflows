import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  DEFAULT_SECRET_GLOBS,
  matchesPolicyGlob,
  normalizePolicyPath,
  pathContains,
  protectedPathReason,
  assertWritableWorkflowPath,
  safeWriteFileWithinRoot,
} from "../workflow-kernel/path-policy.js";

async function makeTmpDir(prefix) {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

test("protectedPathReason flags lowercase control-path segments", () => {
  assert.equal(protectedPathReason(".git/config"), "control-path");
  assert.equal(protectedPathReason(".opencode/agent.json"), "control-path");
});

// Regression for opencode-workflows-3hi (R3): the first-segment control-path
// check was case-sensitive, so .GIT/.Opencode/.OPENCODE bypassed the guard and
// folded onto the real .git/.opencode dir on case-insensitive filesystems.
test("protectedPathReason rejects mixed-case .git control-path segments", () => {
  for (const segment of [".GIT", ".Git", ".gIt"]) {
    assert.equal(
      protectedPathReason(`${segment}/hooks/post-commit`),
      "control-path",
      `${segment} should fold to the .git control path`,
    );
  }
});

test("protectedPathReason rejects mixed-case .opencode control-path segments", () => {
  for (const segment of [".OPENCODE", ".OpenCode", ".Opencode"]) {
    assert.equal(
      protectedPathReason(`${segment}/config.json`),
      "control-path",
      `${segment} should fold to the .opencode control path`,
    );
  }
});

test("assertWritableWorkflowPath throws control-path reason for mixed-case .git", () => {
  assert.throws(
    () => assertWritableWorkflowPath(".GIT/config"),
    /Patch target is protected \(control-path\): \.GIT\/config/,
  );
});

// Regression for opencode-workflows-ccv (R2): protectedPathReason previously
// checked only normalized.split('/')[0], so a nested .git/.opencode segment
// (vendor/.git/hooks/pre-commit, pkg/.opencode/plugin.js) returned undefined and
// passed workflow_apply -> git-hook RCE / opencode plugin-config injection.
test("protectedPathReason rejects nested .git control-path segments", () => {
  for (const target of [
    "vendor/.git/hooks/pre-commit",
    "a/b/c/.git/config",
    "submodule/.git",
  ]) {
    assert.equal(
      protectedPathReason(target),
      "control-path",
      `${target} should be rejected for its nested .git segment`,
    );
  }
});

test("protectedPathReason rejects nested .opencode control-path segments", () => {
  for (const target of [
    "pkg/.opencode/plugin.js",
    "nested/dir/.opencode/config.json",
  ]) {
    assert.equal(
      protectedPathReason(target),
      "control-path",
      `${target} should be rejected for its nested .opencode segment`,
    );
  }
});

test("protectedPathReason rejects nested mixed-case control-path segments", () => {
  assert.equal(protectedPathReason("vendor/.GIT/hooks/pre-commit"), "control-path");
  assert.equal(protectedPathReason("pkg/.OpenCode/plugin.js"), "control-path");
});

test("assertWritableWorkflowPath throws control-path reason for nested .git", () => {
  assert.throws(
    () => assertWritableWorkflowPath("vendor/.git/hooks/pre-commit"),
    /Patch target is protected \(control-path\): vendor\/\.git\/hooks\/pre-commit/,
  );
});

test("protectedPathReason leaves ordinary paths writable", () => {
  assert.equal(protectedPathReason("src/index.js"), undefined);
  assert.equal(protectedPathReason("docs/readme.md"), undefined);
  // Substring of a control segment in a normal name must stay writable.
  assert.equal(protectedPathReason("src/git/index.js"), undefined);
  assert.equal(protectedPathReason("src/opencode/index.js"), undefined);
  assert.equal(protectedPathReason("src/agitate.js"), undefined);
});

test("normalizePolicyPath handles empty and dot-only paths", () => {
  assert.equal(normalizePolicyPath(""), "");
  assert.equal(normalizePolicyPath(null), "");
  assert.equal(normalizePolicyPath("..."), "...");
});

test("pathContains accepts only the root or descendants", () => {
  const root = path.resolve("/tmp/workflow-root");
  assert.equal(pathContains(root, root), true);
  assert.equal(pathContains(root, path.join(root, "nested", "file.txt")), true);
  assert.equal(pathContains(root, path.resolve("/tmp/workflow-root-sibling")), false);
  assert.equal(pathContains(root, path.resolve(root, "..", "outside.txt")), false);
});

test("matchesPolicyGlob handles trailing globstar without trailing slash", () => {
  assert.equal(matchesPolicyGlob("src/index.js", "src/**"), true);
  assert.equal(matchesPolicyGlob("src/nested/index.js", "src/**"), true);
  assert.equal(matchesPolicyGlob("test/index.js", "src/**"), false);
});

test("matchesPolicyGlob handles unicode path components", () => {
  assert.equal(matchesPolicyGlob("docs/naive-cafe/guide.md", "docs/**/*.md"), true);
  assert.equal(matchesPolicyGlob("docs/秘密/guide.md", "docs/**/*.md"), true);
  assert.equal(matchesPolicyGlob("secrets/秘密/CLIENT.PEM", "**/*.pem"), true);
});

test("protectedPathReason rejects common credential and key default paths", () => {
  for (const target of [
    "home/user/.aws/credentials",
    "home/user/.aws/config",
    "home/user/.kube/config",
    "home/user/.ssh/id_ecdsa",
    "home/user/.ssh/id_dsa",
    "home/user/.netrc",
    "home/user/.pgpass",
    "home/user/.config/gcloud/credentials.db",
    "home/user/.docker/config.json",
    "certs/client.pem",
    "certs/CLIENT.PEM",
    "keys/service.key",
    "keys/SERVICE.KEY",
  ]) {
    assert.equal(protectedPathReason(target), "secret-path", `${target} should be rejected as a secret path`);
  }
});

test("default secret globs include root env-file permission patterns", () => {
  assert.ok(DEFAULT_SECRET_GLOBS.includes(".env"));
  assert.ok(DEFAULT_SECRET_GLOBS.includes(".env.*"));
  assert.equal(protectedPathReason(".env"), "secret-path");
  assert.equal(protectedPathReason(".env.local"), "secret-path");
});

// --- R18 / opencode-workflows-994: TOCTOU between symlink validation and write ---
// validatePatchTargets lstat-checks ancestors + target up front, but the patch
// write happens later. A concurrent local actor can swap a validated dir/file for a
// symlink to outside-root between validation and write. safeWriteFileWithinRoot must
// re-validate + use O_NOFOLLOW so the write never lands outside root.

test("safeWriteFileWithinRoot writes ordinary nested paths inside root", async () => {
  const root = await makeTmpDir("r18-ok-");
  try {
    await safeWriteFileWithinRoot(root, "a/b/c.txt", "hello");
    const written = await fs.readFile(path.join(root, "a/b/c.txt"), "utf8");
    assert.equal(written, "hello");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("safeWriteFileWithinRoot writes empty content as a zero-byte file", async () => {
  const root = await makeTmpDir("djl-empty-content-");
  try {
    await safeWriteFileWithinRoot(root, "empty.txt", "");
    const stat = await fs.stat(path.join(root, "empty.txt"));
    assert.equal(stat.size, 0);
    assert.equal(await fs.readFile(path.join(root, "empty.txt"), "utf8"), "");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("safeWriteFileWithinRoot rejects root-directory targets", async () => {
  const root = await makeTmpDir("djl-root-target-");
  try {
    await assert.rejects(
      () => safeWriteFileWithinRoot(root, "", "content"),
      /Patch target must name a file/i,
    );
    await assert.rejects(
      () => safeWriteFileWithinRoot(root, ".", "content"),
      /Patch target must name a file/i,
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("safeWriteFileWithinRoot writes null bytes and binary buffers", async () => {
  const root = await makeTmpDir("djl-binary-content-");
  try {
    await safeWriteFileWithinRoot(root, "null-byte.txt", "before\0after");
    assert.equal(await fs.readFile(path.join(root, "null-byte.txt"), "utf8"), "before\0after");

    const bytes = Buffer.from([0xff, 0x00, 0xfe, 0x61]);
    await safeWriteFileWithinRoot(root, "bytes.bin", bytes);
    assert.deepEqual(await fs.readFile(path.join(root, "bytes.bin")), bytes);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("safeWriteFileWithinRoot accepts a relative root path", async () => {
  const base = await makeTmpDir("djl-relative-root-");
  try {
    const root = path.join(base, "root");
    await fs.mkdir(root);
    const relativeRoot = path.relative(process.cwd(), root);
    assert.equal(path.isAbsolute(relativeRoot), false);

    await safeWriteFileWithinRoot(relativeRoot, "file.txt", "ok");
    assert.equal(await fs.readFile(path.join(root, "file.txt"), "utf8"), "ok");
  } finally {
    await fs.rm(base, { recursive: true, force: true });
  }
});

test("safeWriteFileWithinRoot truncate-overwrites an existing tracked file", async () => {
  const root = await makeTmpDir("r18-overwrite-");
  try {
    await fs.writeFile(path.join(root, "file.txt"), "old-and-longer-content");
    await safeWriteFileWithinRoot(root, "file.txt", "new");
    assert.equal(await fs.readFile(path.join(root, "file.txt"), "utf8"), "new");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("safeWriteFileWithinRoot fails closed before truncating when fd realpath is unavailable", async (t) => {
  const root = await makeTmpDir("r18-no-fd-realpath-");
  try {
    const target = path.join(root, "file.txt");
    await fs.writeFile(target, "ORIGINAL");
    const originalReadlink = fs.readlink;
    t.mock.method(fs, "readlink", async (linkPath, ...args) => {
      if (String(linkPath).startsWith("/proc/self/fd/")) {
        const error = new Error("fd realpath unavailable");
        error.code = "ENOENT";
        throw error;
      }
      return await originalReadlink(linkPath, ...args);
    });

    await assert.rejects(
      () => safeWriteFileWithinRoot(root, "file.txt", "PWNED"),
      /requires fd realpath support/,
    );
    assert.equal(await fs.readFile(target, "utf8"), "ORIGINAL", "unsupported fd realpath must not truncate before failing");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("safeWriteFileWithinRoot refuses a final-component symlink swapped in after validation", async () => {
  const root = await makeTmpDir("r18-finalsym-");
  const outsideDir = await makeTmpDir("r18-outside-");
  const victim = path.join(outsideDir, "victim.txt");
  try {
    await fs.writeFile(victim, "ORIGINAL-SECRET");
    // Attacker swaps the target name for a symlink pointing outside root.
    await fs.symlink(victim, path.join(root, "target.txt"));

    await assert.rejects(
      () => safeWriteFileWithinRoot(root, "target.txt", "PWNED"),
      /symlink|escapes primary root/i,
      "write through a symlinked final component must be rejected",
    );
    // The outside victim must be untouched (write did not follow the symlink).
    assert.equal(await fs.readFile(victim, "utf8"), "ORIGINAL-SECRET");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(outsideDir, { recursive: true, force: true });
  }
});

test("safeWriteFileWithinRoot refuses an ancestor-directory symlink swapped in after validation", async () => {
  const root = await makeTmpDir("r18-ancsym-");
  const outsideDir = await makeTmpDir("r18-ancout-");
  try {
    // A validated ancestor dir is swapped for a symlink to a dir outside root.
    await fs.symlink(outsideDir, path.join(root, "sub"));

    await assert.rejects(
      () => safeWriteFileWithinRoot(root, "sub/escaped.txt", "PWNED"),
      /symlink|escapes primary root/i,
      "write through a symlinked ancestor must be rejected",
    );
    // Nothing was written into the outside dir via the ancestor symlink.
    await assert.rejects(
      () => fs.readFile(path.join(outsideDir, "escaped.txt"), "utf8"),
      /ENOENT/,
      "the redirected write must not have created the file outside root",
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(outsideDir, { recursive: true, force: true });
  }
});

test("safeWriteFileWithinRoot rejects an absolute/.. target escaping root", async () => {
  const root = await makeTmpDir("r18-escape-");
  try {
    await assert.rejects(
      () => safeWriteFileWithinRoot(root, "../escaped.txt", "PWNED"),
      /escapes primary root/i,
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

// --- R18-followup / opencode-workflows-2gs: symlinked-ancestor apply root ---
// Apply call sites derive root via path.resolve(context.worktree||directory), which
// normalizes ./.. but does NOT resolve symlinks. When the root path has a symlinked
// ancestor (macOS /tmp->/private/tmp, symlinked $HOME/worktree parent), the previous
// code computed targetAbs against the raw (un-realpathed) root yet compared it to
// rootReal=realpath(root); the two diverged and EVERY legitimate write was rejected
// fail-closed, bricking workflow_apply. The fix resolves the target against rootReal.
// npm test normally runs under Linux /tmp (already a realpath), so this case is only
// exercised by handing safeWriteFileWithinRoot a root *through* a symlink.

test("safeWriteFileWithinRoot writes legit nested paths when the apply root has a symlinked ancestor", async () => {
  const realBase = await makeTmpDir("r18f-realbase-");
  try {
    // Real apply root lives under realBase; hand the function a path that reaches it
    // through a symlinked ancestor (linkBase -> realBase), mimicking a symlinked
    // worktree parent. path.resolve does not collapse the symlink, so the root the
    // function receives is NOT its own realpath.
    const realRoot = path.join(realBase, "root");
    await fs.mkdir(realRoot);
    const linkBase = path.join(realBase, "link");
    await fs.symlink(realBase, linkBase);
    const symlinkedRoot = path.join(linkBase, "root");

    // Sanity: the root we pass is genuinely not its own realpath (otherwise the test
    // would not exercise the divergence the fix targets).
    assert.notEqual(symlinkedRoot, await fs.realpath(symlinkedRoot));

    await safeWriteFileWithinRoot(symlinkedRoot, "a/b/c.txt", "hello");
    // The byte landed inside the real root, under the symlinked ancestor.
    assert.equal(await fs.readFile(path.join(realRoot, "a/b/c.txt"), "utf8"), "hello");
  } finally {
    await fs.rm(realBase, { recursive: true, force: true });
  }
});

test("safeWriteFileWithinRoot still rejects a ..-escape when the apply root has a symlinked ancestor", async () => {
  const realBase = await makeTmpDir("r18f-escape-");
  try {
    const realRoot = path.join(realBase, "root");
    await fs.mkdir(realRoot);
    const linkBase = path.join(realBase, "link");
    await fs.symlink(realBase, linkBase);
    const symlinkedRoot = path.join(linkBase, "root");

    // Even though the root reaches its target through a symlink, a ../ target must
    // still collapse out of root and be rejected (containment is enforced against
    // the realpathed root).
    await assert.rejects(
      () => safeWriteFileWithinRoot(symlinkedRoot, "../escaped.txt", "PWNED"),
      /escapes primary root/i,
    );
    await assert.rejects(
      () => fs.readFile(path.join(realBase, "escaped.txt"), "utf8"),
      /ENOENT/,
      "the ../ escape must not have written outside the real root",
    );
  } finally {
    await fs.rm(realBase, { recursive: true, force: true });
  }
});

test("safeWriteFileWithinRoot still rejects a final-component symlink swap when the apply root has a symlinked ancestor", async () => {
  const realBase = await makeTmpDir("r18f-finalsym-");
  const outsideDir = await makeTmpDir("r18f-outside-");
  const victim = path.join(outsideDir, "victim.txt");
  try {
    const realRoot = path.join(realBase, "root");
    await fs.mkdir(realRoot);
    const linkBase = path.join(realBase, "link");
    await fs.symlink(realBase, linkBase);
    const symlinkedRoot = path.join(linkBase, "root");

    await fs.writeFile(victim, "ORIGINAL-SECRET");
    // Attacker swaps the target name for a symlink pointing outside root; even with a
    // symlinked-ancestor root the O_NOFOLLOW final-component open must refuse it.
    await fs.symlink(victim, path.join(realRoot, "target.txt"));

    await assert.rejects(
      () => safeWriteFileWithinRoot(symlinkedRoot, "target.txt", "PWNED"),
      /symlink|escapes primary root/i,
    );
    assert.equal(await fs.readFile(victim, "utf8"), "ORIGINAL-SECRET");
  } finally {
    await fs.rm(realBase, { recursive: true, force: true });
    await fs.rm(outsideDir, { recursive: true, force: true });
  }
});
