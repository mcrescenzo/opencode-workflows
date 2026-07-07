import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = path.resolve(import.meta.dirname, "..");
const smokeScript = path.join(root, "scripts", "child-system-smoke.mjs");
const releaseScript = path.join(root, "scripts", "release-no-token.mjs");

// Run the smoke script in a clean env (no OPENCODE_WORKFLOWS_CHILD_SMOKE*) so
// live evidence is guaranteed absent. Keep PATH so node/helpers resolve.
function runSmoke(args, envOverrides = {}) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("OPENCODE_WORKFLOWS_CHILD_SMOKE")) delete env[key];
  }
  Object.assign(env, envOverrides);
  return spawnSync(process.execPath, [smokeScript, ...args], {
    cwd: root,
    encoding: "utf8",
    env,
  });
}

// The required gate must fail closed (non-zero) when smoke evidence is absent,
// with a message that distinguishes INCOMPLETE/missing evidence from a verified
// pass. "skipped" must never be reported as "verified".
test("required system-smoke gate fails closed when evidence is absent", () => {
  const result = runSmoke(["--required"]);

  assert.notEqual(result.status, 0, "required gate must exit non-zero when evidence is absent");
  assert.equal(result.status, 2, "required gate uses a distinct non-zero exit code");
  assert.match(result.stderr, /REQUIRED GATE FAILED/i);
  assert.match(result.stderr, /INCOMPLETE/i);
  assert.match(result.stderr, /not verified/i);
  // The required-gate output must not claim an all-pass / success verdict.
  assert.doesNotMatch(result.stdout + result.stderr, /all.*passed/i);
});

// Required gate also fails closed when the opt-in env var is set but no
// helper/binary is available (evidence still absent).
test("required system-smoke gate fails closed when enabled but helper is missing", () => {
  const result = runSmoke(["--required"], { OPENCODE_WORKFLOWS_CHILD_SMOKE: "1" });

  assert.notEqual(result.status, 0);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /REQUIRED GATE FAILED/i);
  assert.match(result.stderr, /INCOMPLETE/i);
});

// Developer convenience path (no --required) still skips with exit 0 but must
// clearly state the evidence is INCOMPLETE / not verified, so a skip is never
// mistaken for release proof.
test("developer convenience smoke skips with exit 0 but marks evidence incomplete", () => {
  const result = runSmoke([]);

  assert.equal(result.status, 0);
  assert.match(result.stdout, /skipped/i);
  assert.match(result.stdout, /INCOMPLETE/i);
  assert.match(result.stdout, /not verified/i);
  // The skip must label itself as non-release-proof, never as a pass.
  assert.match(result.stdout, /NOT release proof/i);
  assert.doesNotMatch(result.stdout, /all.*passed/i);
});

// The required gate is wired as its own npm script and is intentionally NOT
// part of the no-token matrix.
test("package.json exposes a separate required system-smoke gate script", async () => {
  const pkg = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"));

  assert.equal(pkg.scripts["release:child-system-smoke"], "node scripts/child-system-smoke.mjs");
  assert.equal(
    pkg.scripts["release:system-smoke-required"],
    "node scripts/child-system-smoke.mjs --required",
  );
});

// release:no-token must clearly call out the system smoke as a SEPARATE
// required step, and must NOT add it to the no-token suite list.
test("release:no-token documents the system smoke as a separate required step", async () => {
  const releaseSrc = await fs.readFile(releaseScript, "utf8");

  // The required gate is referenced as a separate step ...
  assert.match(releaseSrc, /release:system-smoke-required/);
  assert.match(releaseSrc, /SEPARATE REQUIRED/i);
  // ... and a skip is explicitly not treated as verified.
  assert.match(releaseSrc, /skipped/i);
  assert.match(releaseSrc, /not verified/i);
  // The required smoke is NOT added to the no-token check matrix itself.
  const checksBlock = releaseSrc.match(/const checks = \[[\s\S]*?\];/);
  assert.ok(checksBlock, "release-no-token.mjs has a checks array");
  assert.doesNotMatch(checksBlock[0], /system-smoke/i);
});

// The smoke script itself distinguishes the two modes in source.
test("child-system-smoke script separates developer skip from required gate", async () => {
  const src = await fs.readFile(smokeScript, "utf8");

  assert.match(src, /OPENCODE_WORKFLOWS_CHILD_SMOKE/);
  assert.match(src, /skipped/i);
  assert.match(src, /--required/);
  assert.match(src, /INCOMPLETE/i);
});

async function writeHelper(source) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "child-smoke-helper-"));
  const helper = path.join(dir, "helper.mjs");
  await fs.writeFile(helper, source);
  return helper;
}

test("child-system-smoke executes a configured helper and accepts exit 0", async () => {
  const helper = await writeHelper("console.log('helper-ok');\n");
  const result = runSmoke([], {
    OPENCODE_WORKFLOWS_CHILD_SMOKE: "1",
    OPENCODE_WORKFLOWS_CHILD_SMOKE_HELPER: process.execPath,
    OPENCODE_WORKFLOWS_CHILD_SMOKE_HELPER_ARGS: JSON.stringify([helper]),
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /running helper/);
  assert.match(result.stdout, /helper-ok/);
});

test("child-system-smoke propagates a configured helper failure", async () => {
  const helper = await writeHelper("console.error('helper-fail'); process.exit(7);\n");
  const result = runSmoke([], {
    OPENCODE_WORKFLOWS_CHILD_SMOKE: "1",
    OPENCODE_WORKFLOWS_CHILD_SMOKE_HELPER: process.execPath,
    OPENCODE_WORKFLOWS_CHILD_SMOKE_HELPER_ARGS: JSON.stringify([helper]),
  });

  assert.equal(result.status, 7);
  assert.match(result.stderr, /helper-fail/);
  assert.match(result.stderr, /helper exited with status 7/);
});

// A helper killed by a signal (OOM/SIGKILL/SIGSEGV/manual kill) yields
// spawnSync status=null with a populated signal and NO error field. The
// required gate must fail closed (non-zero) rather than treating the crashed
// helper as a passing release proof.
test("child-system-smoke fails closed when the helper is killed by a signal", async () => {
  const helper = await writeHelper("process.kill(process.pid, 'SIGKILL');\n");
  const result = runSmoke(["--required"], {
    OPENCODE_WORKFLOWS_CHILD_SMOKE: "1",
    OPENCODE_WORKFLOWS_CHILD_SMOKE_HELPER: process.execPath,
    OPENCODE_WORKFLOWS_CHILD_SMOKE_HELPER_ARGS: JSON.stringify([helper]),
  });

  assert.notEqual(result.status, 0, "signal-killed helper must not be treated as a pass");
  assert.equal(result.status, 1, "required gate exits 1 for a signal-killed helper");
  assert.match(result.stderr, /terminated by signal/i);
});

test("child-system-smoke times out a hung configured helper", async () => {
  const helper = await writeHelper("setTimeout(() => {}, 10000);\n");
  const result = runSmoke([], {
    OPENCODE_WORKFLOWS_CHILD_SMOKE: "1",
    OPENCODE_WORKFLOWS_CHILD_SMOKE_HELPER: process.execPath,
    OPENCODE_WORKFLOWS_CHILD_SMOKE_HELPER_ARGS: JSON.stringify([helper]),
    OPENCODE_WORKFLOWS_CHILD_SMOKE_TIMEOUT_MS: "50",
  });

  assert.equal(result.status, 124);
  assert.match(result.stderr, /timed out after 50ms/);
});
