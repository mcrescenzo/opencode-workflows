import { spawnSync } from "node:child_process";

const checks = [
  { label: "npm run test:lockfile-sync", command: "npm", args: ["run", "test:lockfile-sync"] },
  { label: "npm test", command: "npm", args: ["test"] },
  { label: "npm pack --dry-run --json", command: "npm", args: ["pack", "--dry-run", "--json"] },
];

for (const check of checks) {
  console.log(`\n[release-no-token] ${check.label}`);
  const result = spawnSync(check.command, check.args, { stdio: "inherit", shell: false });
  if (result.error) {
    console.error(`[release-no-token] failed to start ${check.label}: ${result.error.message}`);
    process.exit(1);
  }
  if (result.status !== 0) {
    console.error(`[release-no-token] ${check.label} failed with status ${result.status}`);
    process.exit(result.status ?? 1);
  }
}

console.log("\n[release-no-token] all no-token release checks passed");
console.log(
  "[release-no-token] NOTE: the live child system smoke is a SEPARATE REQUIRED release step and is intentionally not part of this no-token matrix (it needs the opencode binary/config and is not token-free).",
);
console.log(
  "[release-no-token] run `npm run release:system-smoke-required` (fails closed when smoke evidence is missing) or complete the manual procedure in docs/plugin-system-tests.md before claiming public release readiness. A skipped smoke is NOT verified.",
);
