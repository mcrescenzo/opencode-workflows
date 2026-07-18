import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

// R14 regression: scripts/parent-integration.mjs must convert the parent suite
// URL with fileURLToPath (not .pathname) before logging/spawning node --test.
// A URL .pathname is percent-encoded, so a parent path with spaces would be
// passed to `node --test` as the non-existent /tmp/parent%20repo/...
//
// Why a focused conversion test (not a full parent-integration run):
// `scripts/parent-integration.mjs` executes at module top level (top-level
// await + process.exit) and the candidate URLs are resolved relative to the
// script's OWN location via import.meta.url. Reproducing the bug end-to-end
// would require this plugin repo itself to live under a path containing spaces
// AND a private parent monorepo checkout to exist, which is not feasible in the
// test environment. Instead we (a) prove the conversion semantics that the fix
// relies on, and (b) assert the source applies fileURLToPath and never passes
// .pathname to spawnSync.

const root = path.resolve(import.meta.dirname, "..");
const scriptPath = path.join(root, "scripts", "parent-integration.mjs");

// (a) Conversion behavior: for a file URL pointing at a real path with a
// space, fileURLToPath decodes it back to an accessible path while .pathname
// stays percent-encoded and unusable. This is the exact bug mechanism: the old
// code passed parentSuite.pathname to `node --test`, which on a spaced parent
// path resolves to a non-existent file.
test("fileURLToPath decodes a percent-encoded file URL with spaces; .pathname does not", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "r14 parent suite "));
  const target = path.join(dir, "suite.test.mjs");
  await fs.writeFile(target, 'import test from "node:test"; test("noop", () => {});\n');
  try {
    const url = new URL(`file://${target}`);

    // A file URL pathname percent-encodes spaces (this is the bug).
    assert.match(url.pathname, /%20/);

    const decoded = fileURLToPath(url);
    // Decoded path contains literal spaces and is the real filesystem path.
    assert.ok(decoded.includes(" "), "decoded path should contain literal spaces");
    assert.doesNotMatch(decoded, /%20/, "decoded path should not be percent-encoded");
    await fs.access(decoded); // the decoded path is real

    // The percent-encoded .pathname does NOT resolve to the real file (the bug).
    await assert.rejects(fs.access(url.pathname), /ENOENT/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// (b) Source presence: the fix must apply fileURLToPath and must NOT pass
// .pathname into the spawnSync args or the log line.
test("parent-integration.mjs source converts the suite URL with fileURLToPath and avoids .pathname", async () => {
  const source = await fs.readFile(scriptPath, "utf8");

  // Imports fileURLToPath from node:url.
  assert.match(source, /import\s*\{[^}]*\bfileURLToPath\b[^}]*\}\s*from\s*["']node:url["']/);

  // Computes a path via fileURLToPath(parentSuite) and uses it for spawn + log.
  assert.match(source, /fileURLToPath\(parentSuite\)/);
  assert.match(source, /parentSuitePath/);

  // The spawn args must use the decoded path, not .pathname.
  assert.match(source, /\["--test",\s*parentSuitePath\]/);

  // The old buggy pattern (.pathname used as a spawn arg or in a path context)
  // must be gone. We assert no occurrence of parentSuite.pathname remains.
  assert.doesNotMatch(source, /parentSuite\.pathname/);
});

// (c) Behavioral confirmation via status-code contrast: the decoded path runs
// under `node --test` (exit 0) while the percent-encoded .pathname (the old
// buggy value) fails to resolve and exits non-zero. Status codes are used
// instead of stdout matching because the nested test-runner does not reliably
// surface the inner `node --test` reporter output to the spawnSync capture.
test("node --test runs a spaced-path suite via fileURLToPath but fails on the .pathname form", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "r14 e2e spaced "));
  const target = path.join(dir, "suite.test.mjs");
  await fs.writeFile(target, 'import test from "node:test"; test("noop", () => {});\n');
  try {
    const url = new URL(`file://${target}`);
    const decoded = fileURLToPath(url);

    // The fixed, decoded path runs the suite successfully.
    const fixed = spawnSync(process.execPath, ["--test", decoded], { encoding: "utf8" });
    assert.equal(fixed.status, 0, `decoded path should run: ${fixed.stdout}${fixed.stderr}`);

    // The old buggy .pathname form is percent-encoded and resolves to nothing.
    const buggy = spawnSync(process.execPath, ["--test", url.pathname], { encoding: "utf8" });
    assert.notEqual(buggy.status, 0, "percent-encoded .pathname should not resolve to a real file");
    assert.match(buggy.stderr, /Could not find.*%20/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
