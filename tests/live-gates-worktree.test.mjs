import test from "node:test";

import { assert, fs, path, execFileAsync, __test, mkTempDir, tokens, makeHarness } from "./live-gates-harness.mjs";

test("integration worktree gate verifies local Git adapter without native worktree API", async () => {
  const { tools, context, calls } = await makeHarness({ worktree: false });

  const report = JSON.parse(await tools.workflow_live_gates.execute({
    format: "json",
    approvalIntent: "probe",
    probeIntegrationWorktreeIsolation: true,
  }, context));

  assert.equal(report.gates.worktreeApi.state, "blocked");
  assert.equal(report.gates.worktreeEditIsolation.state, "blocked");
  assert.equal(report.gates.integrationWorktreeIsolation.state, "verified");
  assert.equal(report.gates.integrationWorktreeIsolation.verified, true);
  assert.match(report.gates.integrationWorktreeIsolation.evidence, /local Git integration-worktree probe/);
  assert.equal(calls.worktreeCreate.length, 0);
  assert.equal(calls.worktreeRemove.length, 0);
});

test("integration worktree gate reports no-HEAD precondition precisely", async () => {
  const primary = await mkTempDir();
  await execFileAsync("git", ["init"], { cwd: primary, encoding: "utf8" });
  const { context } = await makeHarness();
  const pluginContext = {
    directory: primary,
    client: {
      session: {
        async create() { return { data: { id: "child-no-head" } }; },
        async prompt(input) { return { data: { parts: [{ type: "text", text: input.query.directory }], info: { tokens: tokens(), cost: 0 } } }; },
        async abort() { return { data: { ok: true } }; },
      },
    },
  };

  const gate = await __test.probeIntegrationWorktreeIsolationGate(pluginContext, context, { primaryDirectory: primary });

  assert.equal(gate.state, "blocked");
  assert.match(gate.evidence, /requires a Git repository with HEAD/);
});

test("worktree edit-isolation probe fails closed when createWorktree returns only an id (no path)", async () => {
  const primary = await mkTempDir();
  const context = { directory: primary, worktree: primary };
  const removeCalls = [];
  const adapter = {
    async hasWorktreeClient() { return true; },
    // Native v2 client may omit every path field, returning only an id. resolve('')
    // would fall back to the process cwd (truthy, != primary) and falsely verify
    // edit isolation, so the probe must fail closed on the raw missing path.
    async createWorktree() { return { id: "worktree-no-path" }; },
    async removeWorktree(input) { removeCalls.push(input); return { data: { ok: true } }; },
  };

  const gate = await __test.probeWorktreeEditIsolationGate({}, context, adapter);

  assert.equal(gate.state, "failed-with-evidence");
  assert.equal(gate.verified, false);
  assert.match(gate.evidence, /did not produce a worktree path/);
  // The probe must not have resolved an empty path to the process cwd and accepted it.
  assert.equal(gate.evidence.includes(process.cwd()), false);
  // Best-effort cleanup is still attempted by id even when no path was returned.
  assert.equal(removeCalls.length, 1);
  assert.equal(removeCalls[0].id, "worktree-no-path");
  assert.equal(removeCalls[0].directory, undefined);
});

test("worktree edit-isolation probe verifies when createWorktree returns a distinct path", async () => {
  const primary = await mkTempDir();
  const distinct = path.join(path.dirname(primary), "edit-isolation-distinct");
  const context = { directory: primary, worktree: primary };
  const adapter = {
    async hasWorktreeClient() { return true; },
    async createWorktree() { return { id: "worktree-1", path: distinct }; },
    async removeWorktree() { return { data: { ok: true } }; },
  };

  const gate = await __test.probeWorktreeEditIsolationGate({}, context, adapter);

  assert.equal(gate.state, "verified");
  assert.equal(gate.verified, true);
  assert.match(gate.evidence, /created distinct worktree/);
});

test("capability adapter resolves the production v2 worktree client against serverUrl", async (t) => {
  const calls = [];
  t.mock.method(globalThis, "fetch", async (req) => {
    const bodyText = typeof req.text === "function" ? await req.text() : "";
    const body = bodyText ? JSON.parse(bodyText) : undefined;
    const url = new URL(req.url);
    calls.push({ method: req.method, pathname: url.pathname, search: url.searchParams, body });
    if (req.method === "POST" && url.pathname === "/experimental/worktree") {
      return new Response(JSON.stringify({ id: "v2-worktree", path: "/tmp/v2-worktree" }), {
        headers: { "content-type": "application/json" },
      });
    }
    if (req.method === "DELETE" && url.pathname === "/experimental/worktree") {
      return new Response(JSON.stringify({ ok: true }), {
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ error: "not found" }), {
      status: 404,
      headers: { "content-type": "application/json" },
    });
  });

  const adapter = await __test.createCapabilityAdapter({
    serverUrl: new URL("http://127.0.0.1:4096/?token=secret"),
    client: { session: {} },
  });

  assert.equal(await adapter.hasWorktreeClient(), true);
  const created = await adapter.createWorktree({ name: "lane-one", directory: "/repo/root" });
  assert.deepEqual(created, { id: "v2-worktree", path: "/tmp/v2-worktree" });
  const removed = await adapter.removeWorktree({ directory: "/tmp/v2-worktree" });
  assert.deepEqual(removed, { ok: true });

  assert.equal(calls[0].method, "POST");
  assert.equal(calls[0].pathname, "/experimental/worktree");
  assert.equal(calls[0].search.get("directory"), "/repo/root");
  assert.deepEqual(calls[0].body, { name: "lane-one" });
  assert.equal(calls[1].method, "DELETE");
  assert.equal(calls[1].pathname, "/experimental/worktree");
  assert.deepEqual(calls[1].body, { directory: "/tmp/v2-worktree" });
});

// R31 (opencode-workflows-8w8): a model echoing the cwd in text is NOT verification.
// It must report available-unverified (verified=false), never gateVerified — otherwise the
// required directoryRooting authority gate fails open on a model echo without a real
// sentinel read.
test("directory-rooting probe reports available-unverified (not verified) when only model cwd text matches", async () => {
  const harness = await makeHarness({
    prompt: async (input) => {
      const text = input.body.parts.map((part) => part.text).join("\n");
      // Child echoes the directory as text but does not perform a read tool call
      // on the sentinel, so deterministic rooting evidence is unavailable.
      if (text.includes("read tool to read the relative path")) {
        return { data: { parts: [{ type: "text", text: input.query.directory }], info: { tokens: tokens(), cost: 0 } } };
      }
      return { data: { parts: [{ type: "text", text: "ok" }], info: { tokens: tokens(), cost: 0 } } };
    },
  });

  const report = JSON.parse(await harness.tools.workflow_live_gates.execute({
    format: "json",
    approvalIntent: "probe",
    probeDirectoryRooting: true,
  }, harness.context));

  assert.equal(report.gates.directoryRooting.state, "available-unverified");
  assert.equal(report.gates.directoryRooting.verified, false);
  assert.equal(report.gates.directoryRooting.evidenceStrength, undefined);
  assert.match(report.gates.directoryRooting.evidence, /model-reported cwd text/);
  assert.match(report.gates.directoryRooting.evidence, /no deterministic read tool evidence/);
  assert.match(report.gates.directoryRooting.evidence, /unverified/);
});

// R31 (opencode-workflows-8w8) fail-closed: a model-text-only directory-rooting signal
// must NOT satisfy the *required* directoryRooting authority gate. Previously the probe
// returned gateVerified(model-text-only), so verifyRequiredAuthorityGates accepted a model
// echoing the cwd without any deterministic sentinel read.
test("verifyRequiredAuthorityGates rejects directoryRooting satisfied only by model cwd text", async () => {
  const directory = await mkTempDir();
  const pluginContext = {
    directory,
    client: {
      session: {
        async create(input) { return { data: { id: "child-dr", permission: input.permission } }; },
        // Child echoes the target directory as plain text but performs no read tool call on
        // the sentinel, so there is no deterministic rooting evidence.
        async prompt(input) { return { data: { parts: [{ type: "text", text: input.query?.directory ?? directory }], info: { tokens: tokens(), cost: 0 } } }; },
        async messages() { return { data: [] }; },
        async abort() { return { data: { ok: true } }; },
      },
    },
  };
  const context = { directory, worktree: directory, sessionID: "parent", agent: "build" };
  const adapter = { diagnostics: {} };
  await assert.rejects(
    __test.verifyRequiredAuthorityGates(pluginContext, context, adapter, {
      profile: "ad-hoc",
      requiredGates: ["directoryRooting"],
    }),
    /requires verified live gates.*directoryRooting=available-unverified/s,
  );
  // The gate is recorded as available-unverified (verified=false), never verified.
  assert.equal(adapter.diagnostics.liveGates.directoryRooting.state, "available-unverified");
  assert.equal(adapter.diagnostics.liveGates.directoryRooting.verified, false);
  assert.equal(adapter.diagnostics.liveGates.directoryRooting.evidenceStrength, undefined);
});

test("directory-rooting probe fails when neither deterministic evidence nor cwd text matches", async () => {
  const harness = await makeHarness({
    prompt: async (input) => {
      const text = input.body.parts.map((part) => part.text).join("\n");
      if (text.includes("read tool to read the relative path")) {
        return { data: { parts: [{ type: "text", text: "I am somewhere else" }], info: { tokens: tokens(), cost: 0 } } };
      }
      return { data: { parts: [{ type: "text", text: "ok" }], info: { tokens: tokens(), cost: 0 } } };
    },
  });

  const report = JSON.parse(await harness.tools.workflow_live_gates.execute({
    format: "json",
    approvalIntent: "probe",
    probeDirectoryRooting: true,
  }, harness.context));

  assert.equal(report.gates.directoryRooting.state, "failed-with-evidence");
  assert.equal(report.gates.directoryRooting.verified, false);
  assert.equal(report.gates.directoryRooting.evidenceStrength, undefined);
  assert.match(report.gates.directoryRooting.evidence, /neither a completed sentinel read nor matching cwd text/);
});

test("directory-rooting probe rejects a read tool result with mismatched sentinel content", async () => {
  const harness = await makeHarness({
    prompt: async (input) => {
      const text = input.body.parts.map((part) => part.text).join("\n");
      if (text.includes("read tool to read the relative path")) {
        const match = text.match(/relative path `([^`]+)`/);
        const sentinelName = match ? match[1] : "";
        // Wrong content: child claims to have read the file but the unique
        // sentinel token does not match. Must not count as observed evidence.
        return { data: { parts: [
          { type: "tool", tool: "read", state: { status: "completed", input: { filePath: sentinelName }, content: "not the sentinel" } },
        ], info: { tokens: tokens(), cost: 0 } } };
      }
      return { data: { parts: [{ type: "text", text: "ok" }], info: { tokens: tokens(), cost: 0 } } };
    },
  });

  const report = JSON.parse(await harness.tools.workflow_live_gates.execute({
    format: "json",
    approvalIntent: "probe",
    probeDirectoryRooting: true,
  }, harness.context));

  assert.equal(report.gates.directoryRooting.state, "failed-with-evidence");
  assert.equal(report.gates.directoryRooting.verified, false);
});

// Regression for the integrationWorktreeIsolation child-rooting proof
// (opencode-workflows-public-live-gate-proof-research): the gate's prior child-rooting
// check asked the child to "reply with the current working directory" and verified on a
// model-text echo of the clean worktree path. A child can parrot that path (it is passed to
// session.create/prompt) without ever rooting there, so model text is not verification. The
// gate now mirrors directoryRooting: it requires a completed `read` tool part returning
// unique sentinel content under the integration worktree; a text-only echo downgrades to
// available-unverified (verified=false). These mirror the directoryRooting text-only
// rejection tests above (R31 / opencode-workflows-8w8).
test("integration-worktree probe reports available-unverified (not verified) when only model cwd text matches", async () => {
  const harness = await makeHarness({
    worktree: false,
    prompt: async (input) => {
      const text = input.body.parts.map((part) => part.text).join("\n");
      // Child echoes the integration worktree path as text but performs no read tool call
      // on the rooting sentinel, so deterministic rooting evidence is unavailable.
      if (text.includes("read tool to read the relative path")) {
        return { data: { parts: [{ type: "text", text: input.query.directory }], info: { tokens: tokens(), cost: 0 } } };
      }
      return { data: { parts: [{ type: "text", text: "ok" }], info: { tokens: tokens(), cost: 0 } } };
    },
  });

  const report = JSON.parse(await harness.tools.workflow_live_gates.execute({
    format: "json",
    approvalIntent: "probe",
    probeIntegrationWorktreeIsolation: true,
  }, harness.context));

  assert.equal(report.gates.integrationWorktreeIsolation.state, "available-unverified");
  assert.equal(report.gates.integrationWorktreeIsolation.verified, false);
  assert.equal(report.gates.integrationWorktreeIsolation.evidenceStrength, undefined);
  assert.match(report.gates.integrationWorktreeIsolation.evidence, /model-reported cwd text/);
  assert.match(report.gates.integrationWorktreeIsolation.evidence, /no deterministic read tool evidence/);
  assert.match(report.gates.integrationWorktreeIsolation.evidence, /unverified/);
});

// Fail-closed enforcement: a model-text-only integration rooting signal (available-unverified)
// must NOT satisfy the *required* integrationWorktreeIsolation authority gate, so a non-dry/
// integration release never advances on a path parrot without a deterministic sentinel read.
test("verifyRequiredAuthorityGates rejects integrationWorktreeIsolation satisfied only by model cwd text", async () => {
  const directory = await mkTempDir();
  const pluginContext = {
    directory,
    client: {
      session: {
        async create(input) { return { data: { id: "child-int", permission: input.permission } }; },
        // Child echoes the probed directory (the scratch integration worktree) as plain text
        // but performs no read tool call on the rooting sentinel, so there is no deterministic
        // rooting evidence.
        async prompt(input) {
          const text = input.body.parts?.map((part) => part.text).join("\n") ?? "";
          if (text.includes("read tool to read the relative path")) {
            return { data: { parts: [{ type: "text", text: input.query?.directory ?? directory }], info: { tokens: tokens(), cost: 0 } } };
          }
          return { data: { parts: [{ type: "text", text: "ok" }], info: { tokens: tokens(), cost: 0 } } };
        },
        async messages() { return { data: [] }; },
        async abort() { return { data: { ok: true } }; },
      },
    },
  };
  const context = { directory, worktree: directory, sessionID: "parent", agent: "build" };
  const adapter = { diagnostics: {} };
  await assert.rejects(
    __test.verifyRequiredAuthorityGates(pluginContext, context, adapter, {
      profile: "ad-hoc",
      requiredGates: ["integrationWorktreeIsolation"],
    }),
    /requires verified live gates.*integrationWorktreeIsolation=available-unverified/s,
  );
  // The gate is recorded as available-unverified (verified=false), never verified.
  assert.equal(adapter.diagnostics.liveGates.integrationWorktreeIsolation.state, "available-unverified");
  assert.equal(adapter.diagnostics.liveGates.integrationWorktreeIsolation.verified, false);
  assert.equal(adapter.diagnostics.liveGates.integrationWorktreeIsolation.evidenceStrength, undefined);
});

// Positive control: when the child DOES perform the sentinel read tool call (returning the
// unique on-disk content), the integration gate verifies as before — the Git/worktree
// isolation checks still run and pass. This locks in that the strengthened probe does not
// regress the verified happy path.
test("integration-worktree probe verifies when the child reads the rooting sentinel via a tool", async () => {
  const harness = await makeHarness({
    worktree: false,
    prompt: async (input) => {
      const text = input.body.parts.map((part) => part.text).join("\n");
      if (text.includes("read tool to read the relative path")) {
        const match = text.match(/relative path `([^`]+)`/);
        const sentinelName = match ? match[1] : "";
        const root = input.query?.directory || "";
        let content = "";
        try { content = await fs.readFile(path.join(root, sentinelName), "utf8"); } catch {
          // sentinel cleaned up; fall through to empty content
        }
        return { data: { parts: [
          { type: "tool", tool: "read", state: { status: "completed", input: { filePath: sentinelName }, content } },
        ], info: { tokens: tokens(), cost: 0 } } };
      }
      return { data: { parts: [{ type: "text", text: "ok" }], info: { tokens: tokens(), cost: 0 } } };
    },
  });

  const report = JSON.parse(await harness.tools.workflow_live_gates.execute({
    format: "json",
    approvalIntent: "probe",
    probeIntegrationWorktreeIsolation: true,
  }, harness.context));

  assert.equal(report.gates.integrationWorktreeIsolation.state, "verified");
  assert.equal(report.gates.integrationWorktreeIsolation.verified, true);
  assert.match(report.gates.integrationWorktreeIsolation.evidence, /local Git integration-worktree probe/);
});

test("apply-approved-plan profile requires the worktree-isolation live gates", () => {
  const authority = __test.resolveRunAuthority({ profile: "apply-approved-plan" }, {});
  assert.equal(authority.profile, "apply-approved-plan");
  assert.equal(authority.edit, true);
  for (const gate of ["worktreeApi", "directoryRooting", "worktreeEditIsolation"]) {
    assert.ok(authority.requiredGates.includes(gate), `apply-approved-plan must require ${gate}`);
  }
});

test("apply-approved-plan run is rejected when worktreeEditIsolation is blocked", async () => {
  const { tools, context, directory } = await makeHarness({
    pluginContext: {
      __workflowLiveGates: {
        permissionEnforcement: { state: "verified", verified: true, evidence: "forced permission verified in test" },
        worktreeApi: { state: "verified", verified: true, evidence: "forced worktree API verified in test" },
        directoryRooting: { state: "verified", verified: true, evidence: "forced rooting verified in test" },
        worktreeEditIsolation: { state: "blocked", verified: false, evidence: "edit isolation unavailable in test" },
      },
    },
  });
  await execFileAsync("git", ["init"], { cwd: directory });
  await execFileAsync("git", ["config", "user.email", "workflow-test@example.com"], { cwd: directory });
  await execFileAsync("git", ["config", "user.name", "Workflow Test"], { cwd: directory });
  await fs.writeFile(path.join(directory, "README.md"), "initial\n", "utf8");
  await execFileAsync("git", ["add", "README.md"], { cwd: directory });
  await execFileAsync("git", ["commit", "-m", "initial"], { cwd: directory });

  const source = `export const meta = { name: "apply-approved-edit-live", profile: "apply-approved-plan" };
return true;`;
  const preview = await tools.workflow_run.execute({ source }, context);
  const match = preview.match(/approvalHash: ([a-f0-9]{64})/);
  assert.ok(match, `missing approvalHash in preview: ${preview}`);
  await assert.rejects(
    tools.workflow_run.execute({ source, approve: true, approvalHash: match[1] }, context),
    /requires verified live gates.*worktreeEditIsolation=blocked/s,
  );
});
