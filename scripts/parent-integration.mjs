// Optional parent-integration regression runner.
//
// The plugin's public no-token validation (`npm test`, `npm run test:workflows`,
// `npm run release:no-token`) is fully runnable from a standalone clone and does
// not depend on any private parent monorepo checkout. This separate, explicitly
// named script reuses a parent monorepo's workflow regression suite when the
// plugin is loaded from inside such a private tree, for extra cross-tree
// coverage. It is intentionally NOT part of the public no-token matrix: in a
// public/standalone clone it exits with a clear message and a non-zero status so
// the optional parent integration can never be confused with public validation.
import { spawnSync } from "node:child_process";
import { access } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const parentCandidates = [
  new URL("../../../tests/workflows.test.mjs", import.meta.url),
  new URL("../../../../tests/workflows.test.mjs", import.meta.url),
];

let parentSuite;
for (const candidate of parentCandidates) {
  try {
    await access(candidate);
    parentSuite = candidate;
    break;
  } catch {
    // keep checking the other layout
  }
}

if (!parentSuite) {
  console.error(
    "[parent-integration] private parent monorepo checkout not found; " +
      "this optional script only runs inside such a private tree. " +
      "Public validation uses `npm test` / `npm run release:no-token`.",
  );
  process.exit(2);
}

// Use fileURLToPath, not .pathname: a URL pathname is percent-encoded, so a
// parent checkout path containing spaces (e.g. /tmp/parent repo) would be
// passed to `node --test` as the non-existent /tmp/parent%20repo/...
const parentSuitePath = fileURLToPath(parentSuite);
console.log(`[parent-integration] running parent suite: ${parentSuitePath}`);
const result = spawnSync(
  process.execPath,
  ["--test", parentSuitePath],
  { stdio: "inherit" },
);
if (result.error) {
  console.error(`[parent-integration] failed to start: ${result.error.message}`);
  process.exit(1);
}
process.exit(result.status ?? 1);
