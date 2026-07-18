import test from "node:test";
import assert from "node:assert/strict";

import { createTestFixDrainAdapter, defaultRunCommand } from "./fixtures/test-fix-drain-adapter.js";

// R05 regression: defaultRunCommand must not shell-split string commands.
//
// execFile does not invoke a shell, so a previous implementation that did
// `String(command).split(/\s+/)` corrupted any command whose argv contained
// quoted arguments or spaces inside a single element. The supported contract is
// now an explicit array command `[bin, ...args]`; strings are rejected with a
// clear error so callers cannot silently get the wrong argv.

test("defaultRunCommand rejects a string command with a clear error", async () => {
  await assert.rejects(
    () => defaultRunCommand("npm test"),
    (error) => {
      assert.ok(error instanceof TypeError, "should throw TypeError");
      assert.match(error.message, /\[bin, \.\.\.args\]/);
      assert.match(error.message, /npm test/);
      return true;
    }
  );
});

test("defaultRunCommand preserves a single argv element containing spaces when passed as an array", async () => {
  // `node -e` runs a script argument that itself contains spaces. With shell
  // splitting this would fragment; with the array contract it must round-trip
  // intact and be echoed back verbatim.
  const script = "process.stdout.write('one two three four')";
  const result = await defaultRunCommand(["node", "-e", script]);
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, "one two three four");
});

test("defaultRunCommand preserves quoted-style argv fragments as a single argument", async () => {
  // An argument that *looks* quoted ('"hello world"') must be delivered to the
  // child as a single literal value, not split into ["'hello", "world'"].
  const result = await defaultRunCommand(["node", "-e", "process.stdout.write(JSON.stringify(process.argv[1]))", "payload with spaces"]);
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, '"payload with spaces"');
});

test("createTestFixDrainAdapter accepts an array testCommand and rejects a string contract via defaultRunCommand", async () => {
  const seen = [];
  const adapter = createTestFixDrainAdapter({
    testCommand: ["node", "--version"],
    runCommand: async (command, opts) => {
      seen.push(command);
      // Delegate to the real defaultRunCommand to prove arrays flow through.
      return defaultRunCommand(command, opts);
    },
  });

  const dry = await adapter.proveDry();
  assert.equal(dry.dry, true);
  assert.deepEqual(seen, [["node", "--version"]]);
});
