import test from "node:test";

import { assert, fs, path, LIVE_GATE_NAMES, tokens, makeHarness, allProbeFlags } from "./live-gates-harness.mjs";

test("opt-in live gate probes verify all workflow_live_gates states with mocked OpenCode behavior", async () => {
  const { tools, context, calls } = await makeHarness({
    prompt: async (input, calls, directory) => {
      const text = input.body.parts.map((part) => part.text).join("\n");
      if (text.includes("printf workflow-bash-allow-probe")) {
        return { data: { parts: [{ type: "tool", tool: "bash", state: { status: "completed", input: { command: "printf workflow-bash-allow-probe" }, content: "workflow-bash-allow-probe" } }], info: { tokens: tokens(), cost: 0 } } };
      }
      if (text.includes("Use the bash tool")) throw new Error("Permission denied: bash command blocked by probe rules");
      if (text.includes("__workflow_secret_read_probe__")) {
        return { data: { parts: [{ type: "text", text: "read permission denied; grep permission denied; glob permission denied; list permission denied; lsp unsupported/not exposed." }], info: { tokens: tokens(), cost: 0 } } };
      }
      if (input.body.format) return { data: { parts: [{ type: "text", text: "ignored" }], info: { structured: { ok: true }, tokens: tokens(), cost: 0 } } };
      if (text.includes("current working directory")) return { data: { parts: [{ type: "text", text: input.query.directory }], info: { tokens: tokens(), cost: 0 } } };
      if (text.includes("read tool to read the relative path")) {
        const match = text.match(/relative path `([^`]+)`/);
        const sentinelName = match ? match[1] : "";
        // Read from the directory the probe actually rooted the child in
        // (input.query.directory): directoryRooting roots in the harness directory, while
        // integrationWorktreeIsolation roots in the clean integration worktree path.
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
  });

  const report = JSON.parse(await tools.workflow_live_gates.execute({ format: "json", approvalIntent: "probe", ...allProbeFlags() }, context));

  assert.equal(report.configured, true);
  assert.equal(report.verified, false, "reserved network/MCP gates remain unverified until behavioral probes exist");
  assert.deepEqual(Object.keys(report.gates), LIVE_GATE_NAMES);
  // backgroundContinuation is intentionally in-process smoke only; all other gates
  // produce directly-observed evidence under the mocked runtime.
  const expectedStrength = { backgroundContinuation: "in-process-smoke" };
  for (const name of LIVE_GATE_NAMES.filter((gate) => gate !== "networkAccess" && gate !== "mcpAccess")) {
    assert.equal(report.gates[name].state, "verified", name);
    assert.equal(report.gates[name].verified, true, name);
    assert.match(report.gates[name].evidence, /probe|session|worktree|background|structured|denied|abort/i, name);
    assert.equal(report.gates[name].evidenceStrength, expectedStrength[name] ?? "observed", `${name} evidenceStrength`);
  }
  assert.equal(report.gates.networkAccess.state, "available-unverified");
  assert.equal(report.gates.mcpAccess.state, "available-unverified");
  assert.ok(calls.create.length >= 6);
  assert.ok(calls.prompt.length >= 6);
  const bashPrompts = calls.prompt.filter((input) => input.body.parts?.some((part) => part.text?.includes("Use the bash tool")));
  assert.ok(bashPrompts.length >= 2);
  for (const input of bashPrompts) {
    assert.equal(input.body.tools, undefined, "prompt-level tools overwrite session permission rules in OpenCode");
  }
  assert.equal(calls.promptAsync.length, 1);
  assert.ok(calls.abort.length >= 5);
  assert.equal(calls.worktreeCreate.length, 2);
  assert.equal(calls.worktreeRemove.length, 2);
});
