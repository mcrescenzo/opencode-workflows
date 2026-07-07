import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { appendEvent } from "../workflow-kernel/event-journal.js";

async function withDiagnosticsRoot(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "workflow-diagnostics-"));
  const previous = process.env.OPENCODE_PLUGIN_DIAGNOSTICS_DIR;
  const previousDisabled = process.env.OPENCODE_PLUGIN_DIAGNOSTICS_DISABLED;
  process.env.OPENCODE_PLUGIN_DIAGNOSTICS_DIR = dir;
  delete process.env.OPENCODE_PLUGIN_DIAGNOSTICS_DISABLED;
  try {
    return await fn(dir);
  } finally {
    if (previous === undefined) delete process.env.OPENCODE_PLUGIN_DIAGNOSTICS_DIR;
    else process.env.OPENCODE_PLUGIN_DIAGNOSTICS_DIR = previous;
    if (previousDisabled === undefined) delete process.env.OPENCODE_PLUGIN_DIAGNOSTICS_DISABLED;
    else process.env.OPENCODE_PLUGIN_DIAGNOSTICS_DISABLED = previousDisabled;
    await fs.rm(dir, { recursive: true, force: true });
  }
}

async function diagnosticLines(root) {
  const projects = await fs.readdir(root).catch(() => []);
  const lines = [];
  for (const project of projects) {
    const pluginDir = path.join(root, project, "opencode-workflows");
    for (const file of await fs.readdir(pluginDir).catch(() => [])) {
      if (!file.endsWith(".jsonl")) continue;
      const content = await fs.readFile(path.join(pluginDir, file), "utf8");
      lines.push(...content.trim().split(/\r?\n/).filter(Boolean));
    }
  }
  return lines;
}

async function makeRun(projectDirectory) {
  const dir = path.join(projectDirectory, ".opencode", "workflows", "runs", "run_diag");
  await fs.mkdir(dir, { recursive: true });
  return { id: "run_diag", dir, projectDirectory, eventCount: 0 };
}

test("appendEvent mirrors high-signal workflow events to redacted diagnostics", async () => {
  await withDiagnosticsRoot(async (diagRoot) => {
    const project = await fs.mkdtemp(path.join(os.tmpdir(), "workflow-project-"));
    try {
      const run = await makeRun(project);
      await appendEvent(run, {
        type: "agent.failure",
        callId: "lane_1",
        childID: "child_1",
        error: [
          "failed with Bearer abcdefghijklmnop and token=abc123456789",
          "aws key AKIAABCDEFGHIJKLMNOP",
          "provider sk-proj_secret_diagnostics_value_1234567890",
          "basic Basic QWxhZGRpbjpvcGVuIHNlc2FtZQ==",
        ].join("; "),
      });

      const rawEvents = await fs.readFile(path.join(run.dir, "events.jsonl"), "utf8");
      assert.match(rawEvents, /agent.failure/);

      const lines = await diagnosticLines(diagRoot);
      assert.equal(lines.length, 1);
      const record = JSON.parse(lines[0]);
      assert.equal(record.schema, "opencode.plugin.diagnostic.v1");
      assert.equal(record.plugin, "opencode-workflows");
      assert.equal(record.level, "error");
      assert.equal(record.event, "workflow_lane_failed");
      assert.equal(record.runID, "run_diag");
      assert.equal(record.childID, "child_1");
      assert.doesNotMatch(lines[0], /abcdefghijklmnop|abc123456789|AKIAABCDEFGHIJKLMNOP|sk-proj_secret_diagnostics_value|QWxhZGRpbjpvcGVu/);
      assert.match(lines[0], /\[REDACTED:secret\]/);
    } finally {
      await fs.rm(project, { recursive: true, force: true });
    }
  });
});

test("workflow diagnostics ignore low-signal events and disabled mode", async () => {
  await withDiagnosticsRoot(async (diagRoot) => {
    const project = await fs.mkdtemp(path.join(os.tmpdir(), "workflow-project-"));
    try {
      const run = await makeRun(project);
      await appendEvent(run, { type: "agent.completed", callId: "lane_1" });
      assert.deepEqual(await diagnosticLines(diagRoot), []);

      process.env.OPENCODE_PLUGIN_DIAGNOSTICS_DISABLED = "1";
      await appendEvent(run, { type: "run.failed", error: "disabled" });
      assert.deepEqual(await diagnosticLines(diagRoot), []);
    } finally {
      await fs.rm(project, { recursive: true, force: true });
    }
  });
});
