import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

const root = new URL("../", import.meta.url);
const workflowPath = new URL(".github/workflows/ci.yml", root);

test("public CI workflow runs the no-token release gate without credentials", () => {
  assert.ok(existsSync(workflowPath), ".github/workflows/ci.yml must exist");
  const ci = readFileSync(workflowPath, "utf8");

  assert.match(ci, /^name: Public Release Gate/m);
  assert.match(ci, /^\s*pull_request:/m);
  assert.match(ci, /^\s*push:/m);
  assert.match(ci, /^\s*workflow_dispatch:/m);
  assert.match(ci, /^\s*contents: read/m);
  assert.match(ci, /actions\/checkout@v4/);
  assert.match(ci, /actions\/setup-node@v4/);
  assert.match(ci, /node-version: "22"/);
  assert.match(ci, /oven-sh\/setup-bun@v2/);
  assert.match(ci, /bun install --frozen-lockfile/);
  assert.match(ci, /npm run release:no-token/);

  assert.doesNotMatch(ci, /NODE_AUTH_TOKEN|NPM_TOKEN|secrets\./);
  assert.doesNotMatch(ci, /npm publish|git push|release:system-smoke-required|test:parent-integration/);
});
