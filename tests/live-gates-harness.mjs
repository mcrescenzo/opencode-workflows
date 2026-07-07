import { afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as setTimeoutP } from "node:timers/promises";
import { promisify } from "node:util";

import WorkflowPlugin from "../workflow-kernel/index.js";
import { makeHarness as makeSharedHarness } from "./helpers/harness.mjs";

const { __test } = WorkflowPlugin;
const execFileAsync = promisify(execFile);
const tempDirs = [];
const LIVE_GATE_NAMES = [
  "permissionEnforcement",
  "commandScopedBash",
  "secretReadDeny",
  "structuredOutput",
  "worktreeApi",
  "directoryRooting",
  "worktreeEditIsolation",
  "integrationWorktreeIsolation",
  "backgroundContinuation",
  "concurrencyCapacity",
  "cancellation",
  "workflowCompletionNotification",
  "networkAccess",
  "mcpAccess",
];

afterEach(async () => {
  __test.runs.clear();
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function mkTempDir() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "workflow-live-gate-test-"));
  tempDirs.push(dir);
  return dir;
}

function tokens() {
  return { input: 0, output: 0, reasoning: 0 };
}

function liveGateSession(_prompt, options, calls, directory) {
  if (options.sessionEnabled === false) return undefined;
  const session = {
    async create(input) {
      calls.create.push(input);
      if (options.create) return await options.create(input, calls);
      return { data: { id: `child-${calls.create.length}`, permission: input.body?.permission } };
    },
    async prompt(input) {
      calls.prompt.push(input);
      if (options.prompt) return await options.prompt(input, calls, directory);
      const text = input.body.parts?.map((part) => part.text).join("\n") ?? "";
      // Default rooting behavior for directoryRooting AND integrationWorktreeIsolation: the
      // probe asks the child to read a relative sentinel; a real child rooted in the probed
      // directory reads it from disk. Read from input.query.directory (the directory the
      // probe actually rooted the child in) so the integration worktree sentinel resolves.
      if (text.includes("read tool to read the relative path")) {
        const match = text.match(/relative path `([^`]+)`/);
        const sentinelName = match ? match[1] : "";
        const root = input.query?.directory || directory;
        let content = "";
        try { content = await fs.readFile(path.join(root, sentinelName), "utf8"); } catch {
          // sentinel may have been cleaned up; fall through to empty content
        }
        return { data: { parts: [
          { type: "tool", tool: "read", state: { status: "completed", input: { filePath: sentinelName }, content } },
          { type: "text", text: content },
        ], info: { tokens: tokens(), cost: 0 } } };
      }
      return { data: { parts: [{ type: "text", text: "ok" }], info: { tokens: tokens(), cost: 0 } } };
    },
    async promptAsync(input) {
      calls.promptAsync.push(input);
      if (options.promptAsync) return await options.promptAsync(input, calls, directory);
      return { data: { id: `async-${calls.promptAsync.length}` } };
    },
    async messages(input) {
      calls.messages.push(input);
      if (options.messages) return await options.messages(input, calls, directory);
      return { data: [] };
    },
    async abort(input) {
      calls.abort.push(input);
      if (options.abort) return await options.abort(input, calls);
      return { data: { ok: true } };
    },
  };
  if (typeof options.shell === "function") {
    session.shell = async (input) => {
      calls.shell.push(input);
      return await options.shell(input, calls, directory);
    };
  }
  return session;
}

function liveGateWorktree(options, calls, directory) {
  if (options.worktreeEnabled === false) return undefined;
  return {
    async create(input) {
      calls.worktreeCreate.push(input);
      if (options.worktreeCreate) return await options.worktreeCreate(input, calls, directory);
      return { data: { id: `worktree-${calls.worktreeCreate.length}`, path: path.join(path.dirname(directory), `probe-${calls.worktreeCreate.length}`) } };
    },
    async remove(input) {
      calls.worktreeRemove.push(input);
      if (options.worktreeRemove) return await options.worktreeRemove(input, calls);
      return { data: { ok: true } };
    },
  };
}

async function makeHarness(options = {}) {
  const directory = await mkTempDir();
  const { tools, context, calls } = await makeSharedHarness({
    ...options,
    directory,
    includeDirectory: true,
    serverUrl: options.serverUrl === false ? false : (options.serverUrl ?? new URL("http://127.0.0.1:4096/?token=secret")),
    capabilities: options.capabilities === undefined ? false : options.capabilities,
    tui: false,
    // Preserve the caller's enable/disable intent under separate flags because
    // session/worktree are reused below to carry the live-gate mock builders.
    sessionEnabled: options.session !== false,
    worktreeEnabled: options.worktree !== false,
    session: liveGateSession,
    worktree: liveGateWorktree,
  });
  return { tools, context, calls, directory };
}

function allProbeFlags() {
  return {
    probePermissionEnforcement: true,
    probeCommandScopedBash: true,
    probeSecretReadDeny: true,
    probeStructuredOutput: true,
    probeWorktreeApi: true,
    probeDirectoryRooting: true,
    probeWorktreeEditIsolation: true,
    probeIntegrationWorktreeIsolation: true,
    probeBackgroundContinuation: true,
    probeConcurrencyCapacity: true,
    probeCancellation: true,
    probeWorkflowNotification: true,
  };
}

export {
  assert,
  fs,
  path,
  setTimeoutP,
  execFileAsync,
  __test,
  LIVE_GATE_NAMES,
  mkTempDir,
  tokens,
  makeHarness,
  allProbeFlags,
};
