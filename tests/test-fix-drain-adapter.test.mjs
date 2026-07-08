import test from "node:test";
import assert from "node:assert/strict";

import { drain } from "../workflow-kernel/drain-runtime.js";
import { createTestFixDrainAdapter, defaultRunCommand, groupTestFailures } from "./fixtures/test-fix-drain-adapter.js";

function laneReport(itemId, overrides = {}) {
  return {
    itemId,
    outcome: "implemented",
    summary: "repair applied",
    readyForIntegration: true,
    filesChanged: ["src/example.js"],
    commandsRun: ["npm test"],
    acceptanceEvidence: ["target test passed"],
    residualRisks: [],
    followups: [],
    ...overrides,
  };
}

test("test-fix adapter groups failing tests without domain-specific branches", () => {
  assert.deepEqual(groupTestFailures("FAIL tests/a.test.js: adds numbers\nnot ok tests/b.test.js: subtracts"), [
    { id: "test:tests/a.test.js", target: "tests/a.test.js", summary: "adds numbers", raw: "FAIL tests/a.test.js: adds numbers" },
    { id: "test:tests/b.test.js", target: "tests/b.test.js", summary: "subtracts", raw: "not ok tests/b.test.js: subtracts" },
  ]);
});

test("defaultRunCommand uses real execFile and returns stdout/stderr plus exit code", async () => {
  const ok = await defaultRunCommand(["printf", "real-run-command"]);
  assert.equal(ok.exitCode, 0);
  assert.equal(ok.stdout.trim(), "real-run-command");
  assert.equal(ok.stderr, "");

  const failed = await defaultRunCommand(["sh", "-c", "printf boom >&2; exit 3"]);
  assert.equal(failed.exitCode, 3);
  assert.equal(failed.stdout, "");
  assert.match(failed.stderr, /boom/);
});

test("test-fix adapter drains a seeded failing test to dry", async () => {
  const results = [
    { exitCode: 1, stdout: "FAIL tests/a.test.js: adds numbers", stderr: "" },
    { exitCode: 0, stdout: "ok", stderr: "" },
    { exitCode: 0, stdout: "ok", stderr: "" },
    { exitCode: 0, stdout: "ok", stderr: "" },
  ];
  const runCommand = async () => results.shift();
  const adapter = createTestFixDrainAdapter({ testCommand: ["npm", "test"], runCommand });

  const report = await drain({ adapter, runLane: async (packet) => laneReport(packet.itemId) });

  assert.equal(report.status, "complete");
  assert.equal(report.closed.length, 1);
  assert.equal(report.closed[0].itemId, "test:tests/a.test.js");
  assert.deepEqual(adapter.commandRuns.map((run) => run.phase), ["discover", "validate", "discover", "proveDry"]);
});

test("test-fix adapter retries validation failures then closes after repair", async () => {
  const results = [
    { exitCode: 1, stdout: "FAIL tests/a.test.js: adds numbers", stderr: "" },
    { exitCode: 1, stdout: "FAIL tests/a.test.js: adds numbers", stderr: "" },
    { exitCode: 0, stdout: "ok", stderr: "" },
    { exitCode: 0, stdout: "ok", stderr: "" },
    { exitCode: 0, stdout: "ok", stderr: "" },
  ];
  const adapter = createTestFixDrainAdapter({ runCommand: async () => results.shift() });

  const report = await drain({ adapter, maxAttempts: 2, runLane: async (packet) => laneReport(packet.itemId) });

  assert.equal(report.status, "complete");
  assert.ok(report.phases.includes("repair"));
  assert.equal(report.waves[0].attempts.length, 2);
});

test("test-fix adapter human-gates unisolated failures and reports non-dry", async () => {
  const adapter = createTestFixDrainAdapter({
    runCommand: async () => ({ exitCode: 1, stdout: "panic without target", stderr: "" }),
  });

  const report = await drain({ adapter, maxWaves: 1, runLane: async (packet) => laneReport(packet.itemId) });

  assert.equal(report.status, "not_dry");
  assert.deepEqual(report.skipped.map((item) => item.classification), ["human-gated"]);
  assert.equal(report.closed.length, 0);
});
