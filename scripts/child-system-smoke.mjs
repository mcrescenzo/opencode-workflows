import { spawnSync } from "node:child_process";

// Live child-system smoke evidence runner.
//
// Two invocation modes, deliberately separated so "skipped" can never be
// reported as "verified":
//
//   1. Developer convenience (default, no `--required`):
//      `npm run release:child-system-smoke`. Useful locally without the opencode
//      binary/config. When the live smoke is not run it prints a clear "skipped"
//      message stating the evidence is INCOMPLETE (not verified) and exits 0 so
//      local iteration is not blocked.
//
//   2. Opt-in strict gate (`--required`):
//      `npm run release:system-smoke-required`. Fails closed (non-zero) when live
//      smoke evidence is absent, so a caller asking for strict verification can
//      never mistake a skipped smoke for a verified one. Recommended before
//      breaking or high-risk releases; the automated npm release
//      (.github/workflows/release.yml) gates on the token-free suite only and
//      does not run this.
//
// Running the real smoke requires the opencode binary/config and is NOT
// token-free. Set OPENCODE_WORKFLOWS_CHILD_SMOKE=1 plus
// OPENCODE_WORKFLOWS_CHILD_SMOKE_HELPER (and optionally
// OPENCODE_WORKFLOWS_CHILD_SMOKE_HELPER_ARGS) to a local helper command, or use
// the MCP oc_plugin_smoke_test / oc_child_* runbook documented in
// docs/plugin-system-tests.md.

const required = process.argv.includes("--required");
const enabled = process.env.OPENCODE_WORKFLOWS_CHILD_SMOKE === "1";
const helper = process.env.OPENCODE_WORKFLOWS_CHILD_SMOKE_HELPER;
const helperTimeoutMs = parseHelperTimeout(process.env.OPENCODE_WORKFLOWS_CHILD_SMOKE_TIMEOUT_MS);

function parseHelperTimeout(value) {
  if (value === undefined || value === "") return 120000;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    console.error("[child-system-smoke] OPENCODE_WORKFLOWS_CHILD_SMOKE_TIMEOUT_MS must be a positive integer");
    process.exit(1);
  }
  return parsed;
}

function incomplete(reason) {
  const headline = `live child-system smoke was NOT run (${reason}); release evidence is INCOMPLETE, not verified`;
  if (required) {
    console.error(`[child-system-smoke] REQUIRED GATE FAILED: ${headline}`);
    console.error(
      "[child-system-smoke] set OPENCODE_WORKFLOWS_CHILD_SMOKE=1 with a helper/opencode binary and rerun `npm run release:system-smoke-required`, or complete the manual procedure in docs/plugin-system-tests.md and record the evidence fields.",
    );
    process.exit(2);
  }
  console.log(`[child-system-smoke] skipped (developer convenience; ${headline})`);
  console.log(
    "[child-system-smoke] this skip is NOT release proof; run `npm run release:system-smoke-required` for the opt-in strict gate or follow docs/plugin-system-tests.md.",
  );
  process.exit(0);
}

if (!enabled) {
  incomplete("set OPENCODE_WORKFLOWS_CHILD_SMOKE=1 to run live child-system smoke evidence");
}

if (!helper) {
  incomplete(
    "OPENCODE_WORKFLOWS_CHILD_SMOKE_HELPER is not set; use the MCP oc_plugin_smoke_test/oc_child_* runbook or provide a local helper command",
  );
}

const args = process.env.OPENCODE_WORKFLOWS_CHILD_SMOKE_HELPER_ARGS
  ? JSON.parse(process.env.OPENCODE_WORKFLOWS_CHILD_SMOKE_HELPER_ARGS)
  : [];

if (!Array.isArray(args) || !args.every((item) => typeof item === "string")) {
  console.error("[child-system-smoke] OPENCODE_WORKFLOWS_CHILD_SMOKE_HELPER_ARGS must be a JSON array of strings");
  process.exit(1);
}

console.log(`[child-system-smoke] running helper: ${helper} ${args.join(" ")}`.trim());
const result = spawnSync(helper, args, { stdio: "inherit", shell: false, timeout: helperTimeoutMs });
if (result.error) {
  if (result.error.code === "ETIMEDOUT") {
    console.error(`[child-system-smoke] helper timed out after ${helperTimeoutMs}ms; live smoke evidence is not sufficient`);
    process.exit(124);
  }
  console.error(`[child-system-smoke] failed to start helper: ${result.error.message}`);
  process.exit(1);
}
if (result.signal) {
  console.error(`[child-system-smoke] helper was terminated by signal ${result.signal}; live smoke evidence is not sufficient`);
  process.exit(1);
}
if (result.status !== 0) {
  console.error(`[child-system-smoke] helper exited with status ${result.status}; live smoke evidence is not sufficient`);
}
// Fail closed: never fall back to 0 for a null/non-numeric status (e.g. a
// signal-killed helper). Mirrors scripts/parent-integration.mjs' `?? 1` default.
process.exit(Number.isInteger(result.status) ? result.status : 1);
