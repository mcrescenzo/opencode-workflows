import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import { spawnSync } from "node:child_process";

// R09 regression: malformed OPENCODE_WORKFLOWS_CHILD_SMOKE_HELPER_ARGS must
// surface the intended validation message and exit 1, NOT an uncaught
// SyntaxError stack trace. Valid arrays and non-array parsed values keep their
// intended behavior.

const root = path.resolve(import.meta.dirname, "..");
const smokeScript = path.join(root, "scripts", "child-system-smoke.mjs");

function runSmoke(envOverrides = {}) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("OPENCODE_WORKFLOWS_CHILD_SMOKE")) delete env[key];
  }
  Object.assign(env, envOverrides);
  return spawnSync(process.execPath, [smokeScript], {
    cwd: root,
    encoding: "utf8",
    env,
  });
}

// The primary regression: bad JSON previously threw an uncaught SyntaxError
// (stack trace, no clear diagnostic) before the validation message could run.
test("malformed helper-args JSON exits 1 with a concise validation message, not a SyntaxError stack", () => {
  const result = runSmoke({
    OPENCODE_WORKFLOWS_CHILD_SMOKE: "1",
    OPENCODE_WORKFLOWS_CHILD_SMOKE_HELPER: process.execPath,
    OPENCODE_WORKFLOWS_CHILD_SMOKE_HELPER_ARGS: "{not json",
  });

  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /OPENCODE_WORKFLOWS_CHILD_SMOKE_HELPER_ARGS must be a JSON array of strings/);
  // No SyntaxError stack trace should leak.
  assert.doesNotMatch(result.stderr, /SyntaxError/);
  assert.doesNotMatch(result.stderr, /at Object\.JSON\.parse/);
});

// Another malformed variant: trailing garbage.
test("malformed helper-args JSON (trailing garbage) exits 1 with the validation message", () => {
  const result = runSmoke({
    OPENCODE_WORKFLOWS_CHILD_SMOKE: "1",
    OPENCODE_WORKFLOWS_CHILD_SMOKE_HELPER: process.execPath,
    OPENCODE_WORKFLOWS_CHILD_SMOKE_HELPER_ARGS: '["ok"] trailing',
  });

  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /OPENCODE_WORKFLOWS_CHILD_SMOKE_HELPER_ARGS must be a JSON array of strings/);
  assert.doesNotMatch(result.stderr, /SyntaxError/);
});

// Acceptance 2: non-array parsed values keep intended behavior (the existing
// array-of-strings check still runs and rejects with the same message).
test("non-array helper-args JSON is rejected by the array check", () => {
  const result = runSmoke({
    OPENCODE_WORKFLOWS_CHILD_SMOKE: "1",
    OPENCODE_WORKFLOWS_CHILD_SMOKE_HELPER: process.execPath,
    OPENCODE_WORKFLOWS_CHILD_SMOKE_HELPER_ARGS: JSON.stringify({ not: "an array" }),
  });

  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /OPENCODE_WORKFLOWS_CHILD_SMOKE_HELPER_ARGS must be a JSON array of strings/);
});

// Acceptance 2: a valid array of strings still works (helper runs).
test("valid helper-args JSON array still runs the helper", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "r09-helper-"));
  const helper = path.join(dir, "helper.mjs");
  await fs.writeFile(helper, "console.log('r09-ok');\n");
  try {
    const result = runSmoke({
      OPENCODE_WORKFLOWS_CHILD_SMOKE: "1",
      OPENCODE_WORKFLOWS_CHILD_SMOKE_HELPER: process.execPath,
      OPENCODE_WORKFLOWS_CHILD_SMOKE_HELPER_ARGS: JSON.stringify([helper]),
    });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /r09-ok/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// Acceptance 2: a non-string element in an otherwise-valid array is rejected
// by the array-of-strings check (unaffected by the parse fix).
test("helper-args array with a non-string element is rejected", () => {
  const result = runSmoke({
    OPENCODE_WORKFLOWS_CHILD_SMOKE: "1",
    OPENCODE_WORKFLOWS_CHILD_SMOKE_HELPER: process.execPath,
    OPENCODE_WORKFLOWS_CHILD_SMOKE_HELPER_ARGS: JSON.stringify([1, 2, 3]),
  });

  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /OPENCODE_WORKFLOWS_CHILD_SMOKE_HELPER_ARGS must be a JSON array of strings/);
});
