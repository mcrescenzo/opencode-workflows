import test from "node:test";
import assert from "node:assert/strict";
import { parseArgs } from "../scripts/analyze-runs.mjs";

// R10 regression: a missing value after `--format` (argv[++i] === undefined)
// and an invalid format value must throw a clear argument error instead of
// silently coercing to "markdown". Explicit json/markdown must keep working.

// Use a dummy --root so parseArgs does not invoke runRoots (filesystem probe)
// on the success paths; throws happen before that line regardless.
const DUMMY_ROOT = "/tmp/analyze-runs-dummy-root";

test("--format with a missing value throws a clear argument error", () => {
  assert.throws(
    () => parseArgs(["--format"]),
    /--format requires json or markdown/,
  );
});

test("--format with an invalid value throws a clear argument error", () => {
  assert.throws(
    () => parseArgs(["--format", "xml"]),
    /--format requires json or markdown/,
  );
});

test("--format=json selects json", () => {
  const args = parseArgs(["--root", DUMMY_ROOT, "--format=json"]);
  assert.equal(args.format, "json");
});

test("--format=markdown selects markdown", () => {
  const args = parseArgs(["--root", DUMMY_ROOT, "--format=markdown"]);
  assert.equal(args.format, "markdown");
});

test("--format= with an invalid value throws a clear argument error", () => {
  assert.throws(
    () => parseArgs(["--format=xml"]),
    /--format requires json or markdown/,
  );
});

test("--format= with an empty value throws a clear argument error", () => {
  assert.throws(
    () => parseArgs(["--format="]),
    /--format requires json or markdown/,
  );
});

// Explicit json/markdown still work (unchanged behavior).
test("--json and --markdown shorthand still work", () => {
  assert.equal(parseArgs(["--root", DUMMY_ROOT, "--json"]).format, "json");
  assert.equal(parseArgs(["--root", DUMMY_ROOT, "--markdown"]).format, "markdown");
});

test("--format json selects json", () => {
  const args = parseArgs(["--root", DUMMY_ROOT, "--format", "json"]);
  assert.equal(args.format, "json");
});

test("--format markdown selects markdown", () => {
  const args = parseArgs(["--root", DUMMY_ROOT, "--format", "markdown"]);
  assert.equal(args.format, "markdown");
});
