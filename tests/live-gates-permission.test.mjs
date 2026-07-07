import test from "node:test";

import { assert, fs, path, setTimeoutP, __test, tokens, makeHarness, allProbeFlags } from "./live-gates-harness.mjs";

test("live gate report remains available-unverified and token-free until probes are requested", async () => {
  const { tools, context, calls } = await makeHarness();

  const report = JSON.parse(await tools.workflow_live_gates.execute({ format: "json" }, context));

  assert.equal(report.configured, true);
  assert.equal(report.verified, false);
  assert.equal(report.gates.permissionEnforcement.state, "available-unverified");
  assert.equal(report.gates.structuredOutput.state, "available-unverified");
  assert.equal(report.gates.worktreeApi.state, "available-unverified");
  assert.equal(report.gates.integrationWorktreeIsolation.state, "available-unverified");
  assert.equal(report.gates.workflowCompletionNotification.state, "available-unverified");
  assert.equal(report.gates.concurrencyCapacity.state, "available-unverified");
  assert.equal(report.gates.networkAccess.state, "available-unverified");
  assert.equal(report.gates.mcpAccess.state, "available-unverified");
  assert.equal(calls.create.length, 0);
  assert.equal(calls.prompt.length, 0);
  assert.equal(calls.promptAsync.length, 0);
  assert.equal(calls.worktreeCreate.length, 0);
});

test("opt-in live gate report distinguishes blocked and failed-with-evidence probes", async () => {
  const blocked = await makeHarness({ session: false, worktree: false, serverUrl: false });
  const blockedReport = JSON.parse(await blocked.tools.workflow_live_gates.execute({ format: "json", approvalIntent: "probe", ...allProbeFlags() }, blocked.context));

  assert.equal(blockedReport.configured, false);
  assert.equal(blockedReport.gates.permissionEnforcement.state, "blocked");
  assert.equal(blockedReport.gates.structuredOutput.state, "blocked");
  assert.equal(blockedReport.gates.worktreeApi.state, "blocked");
  assert.equal(blockedReport.gates.integrationWorktreeIsolation.state, "blocked");
  assert.equal(blockedReport.gates.concurrencyCapacity.state, "blocked");
  assert.equal(blockedReport.gates.cancellation.state, "blocked");
  assert.equal(blockedReport.gates.workflowCompletionNotification.state, "blocked");

  const failed = await makeHarness({
    shell: false,
    prompt: async (input, _calls, directory) => {
      const text = input.body.parts.map((part) => part.text).join("\n");
      if (text.includes("printf workflow-bash-allow-probe")) return { data: { parts: [{ type: "tool", tool: "bash", state: { status: "completed", input: { command: "printf workflow-bash-allow-probe" }, content: "workflow-bash-allow-probe" } }], info: { tokens: tokens(), cost: 0 } } };
      if (input.body.format) return { data: { parts: [{ type: "text", text: "not structured" }], info: { tokens: tokens(), cost: 0 } } };
      if (text.includes("Use the bash tool")) return { data: { parts: [{ type: "tool", tool: "bash", state: { status: "completed", input: { command: "pwd" }, content: [] } }], info: { tokens: tokens(), cost: 0 } } };
      if (text.includes("__workflow_secret_read_probe__")) {
        const leaked = await fs.readFile(path.join(directory, "__workflow_secret_read_probe__"), "utf8");
        return { data: { parts: [{ type: "tool", tool: "read", state: { status: "completed", input: { filePath: "sentinel" }, content: leaked } }], info: { tokens: tokens(), cost: 0 } } };
      }
      return { data: { parts: [{ type: "text", text: "allowed" }], info: { tokens: tokens(), cost: 0 } } };
    },
  });
  const failedReport = JSON.parse(await failed.tools.workflow_live_gates.execute({
    format: "json",
    approvalIntent: "probe",
    probePermissionEnforcement: true,
    probeCommandScopedBash: true,
    probeSecretReadDeny: true,
    probeStructuredOutput: true,
  }, failed.context));

  assert.equal(failedReport.verified, false);
  assert.equal(failedReport.gates.permissionEnforcement.state, "failed-with-evidence");
  assert.equal(failedReport.gates.commandScopedBash.state, "failed-with-evidence");
  assert.equal(failedReport.gates.secretReadDeny.state, "failed-with-evidence");
  assert.equal(failedReport.gates.structuredOutput.state, "failed-with-evidence");
});

test("permission probes handle hidden fully denied tools while strict probes still block", async () => {
  const noAttempt = await makeHarness({
    shell: false,
    prompt: async () => ({ data: { parts: [{ type: "text", text: "I will not call tools." }], info: { tokens: tokens(), cost: 0 } } }),
  });

  const report = JSON.parse(await noAttempt.tools.workflow_live_gates.execute({
    format: "json",
    approvalIntent: "probe",
    probePermissionEnforcement: true,
    probeCommandScopedBash: true,
    probeSecretReadDeny: true,
  }, noAttempt.context));

  assert.equal(report.gates.permissionEnforcement.state, "verified");
  assert.equal(report.gates.commandScopedBash.state, "blocked");
  assert.equal(report.gates.secretReadDeny.state, "blocked");
  assert.match(report.gates.permissionEnforcement.evidence, /hidden\/unavailable/);
  assert.match(report.gates.commandScopedBash.evidence, /without an observable bash\/oc_shell tool attempt/);
  assert.equal(report.gates.permissionEnforcement.evidenceStrength, "no-attempt-fallback");
  assert.equal(report.gates.commandScopedBash.evidenceStrength, undefined);
  assert.equal(report.gates.secretReadDeny.evidenceStrength, undefined);
});

test("permission probes verify explicit denial text without observable tool parts", async () => {
  const harness = await makeHarness({
    shell: false,
    prompt: async (input) => {
      const text = input.body.parts.map((part) => part.text).join("\n");
      if (text.includes("Use the bash tool")) {
        if (text.includes("printf workflow-bash-allow-probe")) {
          return { data: { parts: [{ type: "tool", tool: "bash", state: { status: "completed", input: { command: "printf workflow-bash-allow-probe" }, content: "workflow-bash-allow-probe" } }], info: { tokens: tokens(), cost: 0 } } };
        }
        return { data: { parts: [{ type: "text", text: "Permission denied: the bash tool is unavailable in this child session." }], info: { tokens: tokens(), cost: 0 } } };
      }
      if (text.includes("__workflow_secret_read_probe__")) {
        return { data: { parts: [{ type: "text", text: "read permission denied; grep permission denied; glob permission denied; list permission denied; lsp unsupported/not exposed." }], info: { tokens: tokens(), cost: 0 } } };
      }
      return { data: { parts: [{ type: "text", text: "ok" }], info: { tokens: tokens(), cost: 0 } } };
    },
  });

  const report = JSON.parse(await harness.tools.workflow_live_gates.execute({
    format: "json",
    approvalIntent: "probe",
    probePermissionEnforcement: true,
    probeCommandScopedBash: true,
    probeSecretReadDeny: true,
  }, harness.context));

  assert.equal(report.gates.permissionEnforcement.state, "verified");
  assert.equal(report.gates.commandScopedBash.state, "verified");
  assert.equal(report.gates.secretReadDeny.state, "verified");
  assert.match(report.gates.permissionEnforcement.evidence, /denial text/);
  assert.equal(report.gates.permissionEnforcement.evidenceStrength, "observed");
  assert.equal(report.gates.commandScopedBash.evidenceStrength, "observed");
  assert.equal(report.gates.secretReadDeny.evidenceStrength, "observed");
});

test("permission probes use prompt-path denial even when session.shell would bypass", async () => {
  const harness = await makeHarness({
    shell: async () => ({ data: { id: "shell-allowed" } }),
    prompt: async (input) => {
      const text = input.body.parts.map((part) => part.text).join("\n");
      if (text.includes("Use the bash tool")) {
        if (text.includes("printf workflow-bash-allow-probe")) {
          return { data: { parts: [{ type: "tool", tool: "bash", state: { status: "completed", input: { command: "printf workflow-bash-allow-probe" }, content: "workflow-bash-allow-probe" } }], info: { tokens: tokens(), cost: 0 } } };
        }
        return { data: { parts: [{ type: "tool", tool: "bash", state: { status: "error", input: { command: "pwd" }, error: "Permission denied: bash command blocked by prompt-path rules" } }], info: { tokens: tokens(), cost: 0 } } };
      }
      return { data: { parts: [{ type: "text", text: "ok" }], info: { tokens: tokens(), cost: 0 } } };
    },
  });

  const report = JSON.parse(await harness.tools.workflow_live_gates.execute({
    format: "json",
    approvalIntent: "probe",
    probePermissionEnforcement: true,
    probeCommandScopedBash: true,
  }, harness.context));

  assert.equal(report.gates.permissionEnforcement.state, "verified");
  assert.equal(report.gates.commandScopedBash.state, "verified");
  assert.equal(harness.calls.shell.length, 0);
  assert.equal(harness.calls.prompt.length, 3);
  assert.equal(report.gates.permissionEnforcement.evidenceStrength, "observed");
  assert.equal(report.gates.commandScopedBash.evidenceStrength, "observed");
});

// R1 fail-closed: live denial probes must NOT classify a transport/structural failure
// (timeout / cancellation / no-child-id) as observed denial. The denial-text regex used
// to also match the probe's own label, so a timeout in the "denied-bash probe" silently
// returned gateVerified and escalated authority. These probes gate the most privileged
// dimensions (shell/network/mcp/edit/secret isolation), so they must fail closed.

test("denialProbeResult classifies a probe timeout as a non-verified gate, not observed denial", () => {
  const { WorkflowTimeoutError, denialProbeResult } = __test;
  // The timeout message embeds the probe label, which historically contained the denial
  // keyword "denied" and tripped the regex -> false gateVerified.
  const error = new WorkflowTimeoutError("denied-bash probe prompt timed out after 20ms");
  const gate = denialProbeResult(error, "blocked-bash live probe");
  assert.equal(gate.verified, false);
  assert.equal(gate.state, "failed-with-evidence");
  assert.match(gate.evidence, /could not be verified/);
  assert.equal(/\bwas rejected\b/.test(gate.evidence), false);
});

test("denialProbeResult classifies a probe cancellation as a non-verified (blocked) gate", () => {
  const { WorkflowCancelledError, denialProbeResult } = __test;
  const gate = denialProbeResult(new WorkflowCancelledError(), "secret-read isolation probe");
  assert.equal(gate.verified, false);
  assert.equal(gate.state, "blocked");
  assert.equal(/\bwas rejected\b/.test(gate.evidence), false);
});

test("denialProbeResult classifies a structural no-child-id failure as blocked, not observed denial", () => {
  const { WorkflowProbeStructuralError, denialProbeResult } = __test;
  // This error's message contains "denied"/"deny"-adjacent keywords from the probe label;
  // it must still be classified by type (structural) before the denial regex runs.
  const error = new WorkflowProbeStructuralError("OpenCode returned no child session id for the secret-read isolation probe");
  const gate = denialProbeResult(error, "secret-read isolation probe");
  assert.equal(gate.verified, false);
  assert.equal(gate.state, "blocked");
  assert.equal(/\bwas rejected\b/.test(gate.evidence), false);
});

test("denialProbeResult still verifies a genuine permission-denial error", () => {
  const { denialProbeResult } = __test;
  const gate = denialProbeResult(new Error("Permission denied: bash command blocked by probe rules"), "blocked-bash live probe");
  assert.equal(gate.verified, true);
  assert.equal(gate.state, "verified");
  assert.match(gate.evidence, /was rejected/);
});

test("permission-enforcement probe fails closed when session.prompt times out", async () => {
  const harness = await makeHarness({
    pluginContext: { __workflowLiveProbeTimeoutMs: 25 },
    prompt: async (input) => {
      const text = input.body.parts.map((part) => part.text).join("\n");
      // The denied-bash/permission probe prompt hangs long enough to trip the live-probe
      // timeout; a non-prompt path resolves normally so the rest of the report is unaffected.
      if (text.includes("Use the bash tool")) {
        return await setTimeoutP(500, { data: { parts: [{ type: "text", text: "late" }], info: { tokens: tokens(), cost: 0 } } });
      }
      return { data: { parts: [{ type: "text", text: "ok" }], info: { tokens: tokens(), cost: 0 } } };
    },
  });

  const report = JSON.parse(await harness.tools.workflow_live_gates.execute({
    format: "json",
    approvalIntent: "probe",
    probePermissionEnforcement: true,
  }, harness.context));

  const gate = report.gates.permissionEnforcement;
  assert.equal(gate.verified, false);
  assert.equal(gate.state, "failed-with-evidence");
  assert.match(gate.evidence, /timed out|could not be verified/);
  assert.equal(/\bwas rejected\b/.test(gate.evidence), false);
});

test("secret-read probe fails closed when session.prompt times out", async () => {
  const harness = await makeHarness({
    pluginContext: { __workflowLiveProbeTimeoutMs: 25 },
    prompt: async (input) => {
      const text = input.body.parts.map((part) => part.text).join("\n");
      if (text.includes("__workflow_secret_read_probe__")) {
        return await setTimeoutP(500, { data: { parts: [{ type: "text", text: "late" }], info: { tokens: tokens(), cost: 0 } } });
      }
      return { data: { parts: [{ type: "text", text: "ok" }], info: { tokens: tokens(), cost: 0 } } };
    },
  });

  const report = JSON.parse(await harness.tools.workflow_live_gates.execute({
    format: "json",
    approvalIntent: "probe",
    probeSecretReadDeny: true,
  }, harness.context));

  const gate = report.gates.secretReadDeny;
  assert.equal(gate.verified, false);
  assert.notEqual(gate.state, "verified");
  assert.equal(/\bwas rejected\b/.test(gate.evidence), false);
});

test("permission-enforcement probe fails closed when session.create returns no child id", async () => {
  const harness = await makeHarness({
    // Success-shaped create response with NO id: previously the no-child-id Error message
    // contained "denied" and matched the denial regex -> false gateVerified.
    create: async () => ({ data: {} }),
  });

  const report = JSON.parse(await harness.tools.workflow_live_gates.execute({
    format: "json",
    approvalIntent: "probe",
    probePermissionEnforcement: true,
    probeCommandScopedBash: true,
    probeSecretReadDeny: true,
  }, harness.context));

  for (const name of ["permissionEnforcement", "commandScopedBash", "secretReadDeny"]) {
    const gate = report.gates[name];
    assert.equal(gate.verified, false, `${name} must not be verified on a no-child-id response`);
    assert.equal(gate.state, "blocked", `${name} must be blocked on a no-child-id response`);
    assert.equal(/\bwas rejected\b/.test(gate.evidence), false, `${name} must not report observed denial`);
  }
});

test("live denial probe labels do not contain denial-regex keywords", async () => {
  const { isDenialEvidence } = __test;
  // Drive each probe down the no-denial-evidence failure path so its label is echoed into
  // the gate evidence, then assert the label itself would not have tripped the denial regex.
  const harness = await makeHarness({
    prompt: async () => { throw new Error("transient backend hiccup with no rejection wording"); },
  });

  const report = JSON.parse(await harness.tools.workflow_live_gates.execute({
    format: "json",
    approvalIntent: "probe",
    probePermissionEnforcement: true,
    probeCommandScopedBash: true,
    probeSecretReadDeny: true,
  }, harness.context));

  const denialKeyword = /permission|denied|deny|not allowed|forbidden|unavailable/i;
  const labels = ["blocked-bash live probe", "command-scoped bash probe", "secret-read isolation probe"];
  for (const label of labels) {
    assert.equal(denialKeyword.test(label), false, `probe label "${label}" must not contain a denial-regex keyword`);
    assert.equal(isDenialEvidence(label), false, `probe label "${label}" must not be classified as denial evidence`);
  }
  // Each probe failed without denial wording, so it must fail closed (not verify).
  for (const name of ["permissionEnforcement", "commandScopedBash", "secretReadDeny"]) {
    assert.equal(report.gates[name].verified, false);
    assert.equal(report.gates[name].state, "failed-with-evidence");
  }
});

test("secret-read probe fails without leaking sentinel content", async () => {
  let leakedContent;
  const harness = await makeHarness({
    prompt: async (input, calls, directory) => {
      const text = input.body.parts.map((part) => part.text).join("\n");
      if (text.includes("__workflow_secret_read_probe__")) {
        leakedContent = await fs.readFile(path.join(directory, "__workflow_secret_read_probe__"), "utf8");
        return { data: { parts: [
          { type: "tool", tool: "read", state: { status: "completed", input: { filePath: "__workflow_secret_read_probe__" }, content: leakedContent } },
          { type: "text", text: leakedContent },
        ], info: { tokens: tokens(), cost: 0 } } };
      }
      return { data: { parts: [{ type: "text", text: "ok" }], info: { tokens: tokens(), cost: 0 } } };
    },
  });

  const raw = await harness.tools.workflow_live_gates.execute({ format: "json", approvalIntent: "probe", probeSecretReadDeny: true }, harness.context);
  const report = JSON.parse(raw);

  assert.equal(report.gates.secretReadDeny.state, "failed-with-evidence");
  assert.match(report.gates.secretReadDeny.evidence, /sentinel secret content/);
  assert.ok(leakedContent);
  assert.equal(raw.includes(leakedContent.trim()), false);
});

test("live gate probe flags require explicit approval and are blocked in plan mode", async () => {
  const { tools, context } = await makeHarness();

  await assert.rejects(
    tools.workflow_live_gates.execute({ format: "json", probeStructuredOutput: true }, context),
    /approvalIntent: "probe"/,
  );
  await assert.rejects(
    tools.workflow_live_gates.execute({ format: "json", approvalIntent: "probe", probeStructuredOutput: true }, { ...context, agent: "plan" }),
    /not available in plan mode/,
  );
});

test("live gate probes time out bounded session prompts", async () => {
  const { tools, context } = await makeHarness({
    prompt: async () => await new Promise(() => {}),
    pluginContext: { __workflowLiveProbeTimeoutMs: 5 },
  });

  const report = JSON.parse(await tools.workflow_live_gates.execute({ format: "json", approvalIntent: "probe", probeStructuredOutput: true }, context));

  assert.equal(report.gates.structuredOutput.state, "failed-with-evidence");
  assert.match(report.gates.structuredOutput.evidence, /structured-output probe prompt timed out/);
});

test("network remains reserved while MCP has an opt-in behavioral probe", async () => {
  const { tools, context } = await makeHarness();

  const unprobed = JSON.parse(await tools.workflow_live_gates.execute({ format: "json" }, context));
  assert.equal(unprobed.gates.networkAccess.state, "available-unverified");
  assert.equal(unprobed.gates.mcpAccess.state, "available-unverified");
  assert.match(unprobed.gates.networkAccess.evidence, /no behavioral live-gate probe exists/);
  assert.match(unprobed.gates.mcpAccess.evidence, /MCP allow\/deny still needs a live probe/);

  const probed = JSON.parse(await tools.workflow_live_gates.execute({
    format: "json",
    approvalIntent: "probe",
    probeNetworkAccess: true,
    probeMcpAccess: true,
  }, context));
  assert.equal(probed.gates.networkAccess.state, "blocked");
  assert.equal(probed.gates.mcpAccess.state, "blocked");
  assert.match(probed.gates.networkAccess.evidence, /reserved/);
  assert.match(probed.gates.mcpAccess.evidence, /without an observable mcp/);
});

test("MCP access live probe verifies observed allow and deny behavior", async () => {
  const { tools, context, calls } = await makeHarness({
    prompt: async (input) => {
      const text = input.body.parts.map((part) => part.text).join("\n");
      if (text.includes("workflow-mcp-allow-probe")) {
        return { data: { parts: [{
          type: "tool",
          tool: "mcp__workflow_mcp_allow_probe",
          state: { status: "completed", input: { tool: "workflow-mcp-allow-probe" }, content: "workflow-mcp-allow-probe" },
        }], info: { tokens: tokens(), cost: 0 } } };
      }
      if (text.includes("workflow-mcp-deny-probe")) {
        return { data: { parts: [{
          type: "tool",
          tool: "mcp__workflow_mcp_deny_probe",
          state: { status: "error", input: { tool: "workflow-mcp-deny-probe" }, error: "Permission denied: mcp tool blocked" },
        }], info: { tokens: tokens(), cost: 0 } } };
      }
      return { data: { parts: [{ type: "text", text: "ok" }], info: { tokens: tokens(), cost: 0 } } };
    },
  });

  const report = JSON.parse(await tools.workflow_live_gates.execute({
    format: "json",
    approvalIntent: "probe",
    probeMcpAccess: true,
  }, context));

  assert.equal(report.gates.mcpAccess.state, "verified");
  assert.equal(report.gates.mcpAccess.verified, true);
  assert.equal(report.gates.mcpAccess.evidenceStrength, "observed");
  assert.match(report.gates.mcpAccess.evidence, /allowed MCP tool completion and one denied MCP tool attempt/);

  const permission = calls.create.at(-1).body.permission;
  assert.ok(permission.some((rule) => rule.permission === "mcp" && rule.pattern === "workflow-mcp-allow-probe" && rule.action === "allow"));
  assert.ok(permission.some((rule) => rule.permission === "mcp" && rule.pattern === "workflow-mcp-deny-probe" && rule.action === "deny"));
});
