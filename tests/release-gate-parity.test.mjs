import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = new URL("../", import.meta.url);
const releasePath = new URL(".github/workflows/release.yml", root);
const ciPath = new URL(".github/workflows/ci.yml", root);

// fnop.16: release must use the SAME canonical no-token gate as CI (lockfile-sync + full test +
// pack dry-run), not a narrower `node --test tests/*.test.mjs` glob that can drift from CI.
test("release workflow runs the canonical no-token release gate before publish", () => {
  assert.ok(existsSync(releasePath), ".github/workflows/release.yml must exist");
  const release = readFileSync(releasePath, "utf8");
  assert.match(release, /npm run release:no-token/, "release runs the canonical no-token gate");
  // The narrow bare-glob test step that previously diverged from CI must be gone.
  assert.doesNotMatch(release, /run: node --test tests\/\*\.test\.mjs/, "release must not use the narrow bare-glob test step");
});

test("release and CI share one canonical gate owner", () => {
  const release = readFileSync(releasePath, "utf8");
  const ci = readFileSync(ciPath, "utf8");
  assert.match(ci, /npm run release:no-token/);
  assert.match(release, /npm run release:no-token/);
  // Publish credentials and live smoke stay out of the no-token gate.
  assert.match(release, /npm publish/);
  // The canonical gate script itself must not publish (it is the no-token contract).
  const gateScript = readFileSync(new URL("scripts/release-no-token.mjs", root), "utf8");
  assert.doesNotMatch(gateScript, /npm publish/);
});

test("release reruns check the remote before creating a version tag", () => {
  const release = readFileSync(releasePath, "utf8");
  assert.match(release, /git ls-remote --exit-code --tags origin "refs\/tags\/\$TAG"/);
  assert.doesNotMatch(release, /git rev-parse "refs\/tags\/\$TAG"/);
});
