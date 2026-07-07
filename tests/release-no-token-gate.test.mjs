import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = path.resolve(import.meta.dirname, "..");
const releaseScript = path.join(root, "scripts", "release-no-token.mjs");
const expectedNpmCalls = [
  ["run", "test:lockfile-sync"],
  ["test"],
  ["pack", "--dry-run", "--json"],
];

async function makeFakeNpm() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "release-no-token-fake-npm-"));
  const log = path.join(dir, "calls.json");
  const npmPath = path.join(dir, "npm");
  await fs.writeFile(
    npmPath,
    `#!/usr/bin/env node
const fs = require("node:fs");
const log = process.env.FAKE_NPM_LOG;
const statuses = (process.env.FAKE_NPM_STATUSES || "").split(",").filter(Boolean).map(Number);
let calls = [];
try { calls = JSON.parse(fs.readFileSync(log, "utf8")); } catch {}
calls.push(process.argv.slice(2));
fs.writeFileSync(log, JSON.stringify(calls));
const status = statuses[calls.length - 1] ?? 0;
console.log("[fake-npm] " + process.argv.slice(2).join(" "));
process.exit(status);
`,
  );
  await fs.chmod(npmPath, 0o755);
  return { dir, log };
}

function runRelease(fake, statuses) {
  return spawnSync(process.execPath, [releaseScript], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${fake.dir}${path.delimiter}${process.env.PATH}`,
      FAKE_NPM_LOG: fake.log,
      FAKE_NPM_STATUSES: statuses.join(","),
    },
  });
}

async function readCalls(log) {
  return JSON.parse(await fs.readFile(log, "utf8"));
}

test("release:no-token script runs the complete no-token checks and prints the success banner", async () => {
  const fake = await makeFakeNpm();
  const result = runRelease(fake, [0, 0, 0]);

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(await readCalls(fake.log), expectedNpmCalls);
});

test("release:no-token script fails fast and propagates the failing suite status", async () => {
  const fake = await makeFakeNpm();
  const result = runRelease(fake, [0, 7, 0]);

  assert.equal(result.status, 7);
  assert.deepEqual(
    await readCalls(fake.log),
    [
      ["run", "test:lockfile-sync"],
      ["test"],
    ],
  );
  assert.doesNotMatch(result.stdout, /all no-token release checks passed/);
});

test("release:no-token source keeps success and separate-smoke messages", async () => {
  const releaseSrc = await fs.readFile(releaseScript, "utf8");

  assert.match(releaseSrc, /npm test/);
  assert.match(releaseSrc, /npm pack --dry-run --json/);
  assert.match(releaseSrc, /all no-token release checks passed/);
  assert.match(releaseSrc, /SEPARATE REQUIRED release step/);
  assert.match(releaseSrc, /failed with status/);
});
