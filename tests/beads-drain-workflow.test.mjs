import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import workflowPlugin from "../workflow-kernel/index.js";

const execFileAsync = promisify(execFile);
const { __test } = workflowPlugin;

// beads-drain now resolves from the beads extension's workflow dir (not the bundled dir). The whole
// suite is beads-drain, so makeHarness loads the real beads extension by default; the fake adapter
// supplied via __workflowDrainAdapters still takes precedence over the registered beads adapter.
const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const BEADS_EXT_PATH = path.join(REPO_ROOT, "workflow-domains", "beads", "beads-extension.js");

async function tempDir() {
  return await fs.mkdtemp(path.join(os.tmpdir(), "beads-drain-workflow-"));
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function initGitRepo(directory) {
  await execFileAsync("git", ["init"], { cwd: directory });
  await execFileAsync("git", ["config", "user.email", "workflow-test@example.com"], { cwd: directory });
  await execFileAsync("git", ["config", "user.name", "Workflow Test"], { cwd: directory });
  await fs.writeFile(path.join(directory, "README.md"), "initial\n", "utf8");
  await execFileAsync("git", ["add", "README.md"], { cwd: directory });
  await execFileAsync("git", ["commit", "-m", "initial"], { cwd: directory });
}

async function makeHarness(prompt, options = {}) {
  const directory = await tempDir();
  const pluginContext = {
    __workflowCapabilities: options.capabilities ?? {
      childSession: "available",
      permissions: "available",
      structuredOutput: "available",
      worktree: "available",
      directoryRooting: "available",
      worktreeEditIsolation: "available",
    },
    client: {
      tui: { async showToast() { return { data: true }; } },
      // The plugin no longer carries a hard-coded model fallback, so a real run needs the invoking
      // session to expose a model. Provide one here (override via options.sessionModel).
      config: { async get() { return { data: { model: options.sessionModel ?? "opencode/harness-default" } }; } },
      session: {
        async create() { return { data: { id: "child-1" } }; },
        async prompt(input) { return await prompt(input); },
        async abort() { return { data: { ok: true } }; },
      },
      worktree: {
        async create(input) { return { data: { id: "worktree-1", path: input.body.path } }; },
        async remove() { return { data: { ok: true } }; },
      },
    },
    ...(options.pluginContext ?? {}),
  };
  // The factory loads configured extensions in its body, so beads-drain resolves on the await below.
  const extensions = options.extensions ?? [BEADS_EXT_PATH];
  const registered = await workflowPlugin(pluginContext, { extensions });
  return {
    directory,
    tools: registered.tool,
    context: {
      directory,
      worktree: directory,
      sessionID: "parent-session",
      messageID: "parent-message",
      agent: "build",
      abort: new AbortController().signal,
      metadata() {},
    },
  };
}

async function runApproved(tools, context, request) {
  const preview = await tools.workflow_run.execute(request, context);
  const match = preview.match(/approvalHash: ([a-f0-9]{64})/);
  assert.ok(match, `missing approvalHash in preview: ${preview}`);
  return await tools.workflow_run.execute({ ...request, approve: true, approvalHash: match[1] }, context);
}

function runIdFrom(output) {
  const match = output.match(/Workflow ([0-9a-f-]{36}) (?:completed|started|awaiting diff approval)/);
  assert.ok(match, `missing run id in output: ${output}`);
  return match[1];
}

function resultPath(output) {
  const match = output.match(/Result file: (.+)/);
  assert.ok(match, `missing result path in output: ${output}`);
  return match[1].trim();
}

async function readResult(output) {
  return JSON.parse(await fs.readFile(resultPath(output), "utf8"));
}

async function readJsonl(filePath) {
  const text = await fs.readFile(filePath, "utf8");
  return text.trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
}

function fakeBeadsAdapter(calls, options = {}) {
  const item = { id: "item-1", title: "Fake Beads item", status: "open", issue_type: "task" };
  let closed = false;
  return {
    name: "beads",
    async discover() { calls.push("discover"); return closed ? [] : [item]; },
    async classify(discovered) { calls.push(["classify", discovered.id]); return { status: "ready", reason: "fake ready" }; },
    async claim(discovered) { calls.push(["claim", discovered.id]); return { id: discovered.id, status: "in_progress" }; },
    async buildLanePacket(discovered) { calls.push(["buildLanePacket", discovered.id]); return { item: discovered, instructions: ["Change only files needed by the fake item.", "Do not run Beads mutation commands such as bd update, bd create, bd close, or bd dep add from the child lane."] }; },
    async validate(discovered, integrationState) {
      calls.push(["validate", discovered.id, integrationState.status]);
      const accepted = options.validationAccepted !== false && integrationState.status === "integrated";
      return {
        itemId: discovered.id,
        accepted,
        reason: accepted ? "accepted fake lane" : "rejected fake lane",
        diffScopeOk: accepted,
        followupsHandled: true,
        acceptanceChecklist: ["fake validation"],
        validationCommands: ["fake validate"],
        followups: [],
      };
    },
    async close(discovered) { calls.push(["close", discovered.id]); closed = true; return { id: discovered.id, status: "closed" }; },
    async createFollowup() { throw new Error("followups are not expected in fake workflow tests"); },
    async proveDry() { calls.push(["proveDry", closed]); return { dry: closed }; },
  };
}

function verifiedDrainLiveGates() {
  return Object.fromEntries([
    "permissionEnforcement",
    "commandScopedBash",
    "secretReadDeny",
    "structuredOutput",
    "directoryRooting",
    "integrationWorktreeIsolation",
    "cancellation",
  ].map((name) => [name, { state: "verified", verified: true, evidence: `${name} forced verified in test` }]));
}

function verifiedDrainLiveGatesExceptPermissions() {
  return {
    ...verifiedDrainLiveGates(),
    permissionEnforcement: { state: "failed-with-evidence", verified: false, evidence: "permission risk accepted in test" },
    commandScopedBash: { state: "failed-with-evidence", verified: false, evidence: "command-scoped risk accepted in test" },
    secretReadDeny: { state: "blocked", verified: false, evidence: "secret-read risk accepted in test" },
  };
}

// Dispatching mock for host-owned beads-drain implementation lanes. Beads discovery,
// validation, closeout, and dry proof are supplied by fake host adapters in these tests.
function portPrompt(config = {}) {
  return async (input) => {
    const text = String(input?.body?.parts?.[0]?.text ?? "");
    const lanePrompt = text.includes("host-owned Beads drain workflow") || text.includes("Assigned item:");
    if (config.writeFile && input?.query?.directory && lanePrompt) {
      await fs.writeFile(path.join(input.query.directory, config.writeFile.name), config.writeFile.body, "utf8");
    }
    if (lanePrompt) {
      const m = text.match(/"id"\s*:\s*"([^"]+)"/);
      return { data: { parts: [{ type: "text", text: "implemented" }], info: { structured: {
        itemId: m ? m[1] : "item-1",
        outcome: config.laneOutcome === "blocked" ? "blocked" : "implemented",
        summary: "implemented fake Beads item",
        readyForIntegration: config.laneOutcome !== "blocked",
        filesChanged: config.writeFile ? [config.writeFile.name] : ["beads-work.txt"],
        commandsRun: ["write"],
        acceptanceEvidence: config.laneOutcome === "blocked" ? [] : ["written"],
        residualRisks: [],
        followups: [],
      }, tokens: { input: 1, output: 1, reasoning: 0 }, cost: 0 } } };
    }
    return { data: { parts: [], info: {} } };
  };
}

test("beads-drain is listed and dry-runs by bundled workflow name without mutation", async () => {
  const calls = [];
  const { tools, context, directory } = await makeHarness(async () => {
    throw new Error("dry-run must not launch child implementation lanes");
  }, {
    capabilities: undefined,
    pluginContext: { __workflowDrainAdapters: { beads: async () => fakeBeadsAdapter(calls) } },
  });
  try {
    const listed = JSON.parse(await tools.workflow_list.execute({ format: "json" }, context));
    assert.ok(listed.find((entry) => entry.scope === "extension" && entry.name === "beads-drain"));

    const output = await runApproved(tools, context, { name: "beads-drain", args: { dryRun: true } });
    const result = await readResult(output);
    const status = JSON.parse(await tools.workflow_status.execute({ runId: runIdFrom(output), format: "json", detail: "full" }, context));

    assert.equal(result.output.status, "dry_run_complete");
    assert.equal(result.output.stop_reason, "dry_run_plan");
    assert.deepEqual(result.output.planned_ids, ["item-1"]);
    assert.equal(result.output.remote_sync, "local-only");
    assert.equal(status.authority.integration, false);
    assert.deepEqual(calls.map((call) => Array.isArray(call) ? call[0] : call), ["discover", "classify", "proveDry"]);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("beads-drain rejects non-object runtime args before approval", async () => {
  const { tools, context, directory } = await makeHarness(async () => ({ data: { parts: [], info: {} } }));
  try {
    await assert.rejects(
      tools.workflow_run.execute({ name: "beads-drain", args: "ugv_rover-oori" }, context),
      /drain workflow args must be a JSON object/,
    );
    await assert.rejects(
      tools.workflow_run.execute({ name: "beads-drain", args: [] }, context),
      /drain workflow args must be a JSON object/,
    );
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("regression: a model-emitted JSON string for workflow_run args is normalized and reaches the preview", async () => {
  // Production evidence (ses_0c2babb15ffeJa6LDk58gTaTue, 2026-07-07): a glm-5.2 session emitted the
  // workflow_run `args` parameter as a JSON-encoded string ('{"mode":"dry-run"}') rather than a
  // structured object. Under the old permissive tool schema (tool.schema.any()) plus the multi-type
  // meta argsSchema, the string was rejected at the drain authority edge before the agent could
  // launch ANY scoped drain. opencode-workflows-0y5f.1 tightened the tool-definition schema to
  // object-typed so the model emits an object directly; opencode-workflows-0y5f.2 added a one-shot
  // JSON.parse at the authority edge so a stringified payload from any model is normalized instead
  // of rejected. This test pins the normalization path: a stringified-JSON args value reaches the
  // preview, while a genuinely non-JSON string is still rejected.
  const { tools, context, directory } = await makeHarness(async () => ({ data: { parts: [], info: {} } }));
  try {
    const preview = await tools.workflow_run.execute({ name: "beads-drain", args: '{"mode":"dry-run"}' }, context);
    assert.match(preview, /approvalHash: [0-9a-f]{64}/);

    // A stringified object carrying a scope is also normalized and reaches the preview.
    const previewScoped = await tools.workflow_run.execute(
      { name: "beads-drain", args: '{"mode":"dry-run","scope":{"issueTypes":["task"]}}' },
      context,
    );
    assert.match(previewScoped, /approvalHash: [0-9a-f]{64}/);

    // A genuinely invalid (non-JSON) string is still rejected with the authority error.
    await assert.rejects(
      tools.workflow_run.execute({ name: "beads-drain", args: "not-a-json-object" }, context),
      /drain workflow args must be a JSON object/,
    );
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("beads-drain rejects a string/array scope instead of degrading to an unfiltered drain", async () => {
  const calls = [];
  const { tools, context, directory } = await makeHarness(async () => ({ data: { parts: [], info: {} } }), {
    capabilities: undefined,
    pluginContext: { __workflowDrainAdapters: { beads: async () => fakeBeadsAdapter(calls) } },
  });
  try {
    // A string scope would spread to a char-indexed object ({0:"u",1:"g",...}), dropping every
    // expected filter field and silently running an UNFILTERED drain. It must fail closed instead.
    await assert.rejects(
      runApproved(tools, context, { name: "beads-drain", args: { mode: "dry-run", scope: "ugv_rover-oori" } }),
      /beads-drain scope must be a JSON object.*UNFILTERED/s,
    );
    // An array scope spreads to {0:...,1:...} just the same — also rejected.
    await assert.rejects(
      runApproved(tools, context, { name: "beads-drain", args: { mode: "dry-run", scope: ["ugv_rover-oori"] } }),
      /beads-drain scope must be a JSON object.*UNFILTERED/s,
    );
    // No discovery/classification ran for the bad-scope launches — the drain never started.
    assert.deepEqual(calls, []);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("beads-drain non-dry by name fails closed before mutation under unverified gates", async () => {
  const calls = [];
  const { tools, context, directory } = await makeHarness(portPrompt({}), {
    capabilities: undefined,
    pluginContext: { __workflowDrainAdapters: { beads: async () => fakeBeadsAdapter(calls) } },
  });
  try {
    await initGitRepo(directory);
    await assert.rejects(
      runApproved(tools, context, { name: "beads-drain", args: { mode: "autonomous-local" } }),
      /Workflow authority profile drain-autonomous-local requires verified live gates.*permissionEnforcement=blocked/,
    );
    assert.deepEqual(calls, []);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("beads-drain non-dry by name refuses explicit unverified permission risk", async () => {
  const calls = [];
  const { tools, context, directory } = await makeHarness(portPrompt({}), {
    pluginContext: {
      __workflowLiveGates: verifiedDrainLiveGatesExceptPermissions(),
      __workflowDrainAdapters: { beads: async () => fakeBeadsAdapter(calls) },
    },
  });
  try {
    await initGitRepo(directory);
    await assert.rejects(
      runApproved(tools, context, { name: "beads-drain", args: { mode: "autonomous-local", unsafeAcceptUnverifiedPermissions: true } }),
      /(?=.*permissionEnforcement=failed-with-evidence)(?=.*commandScopedBash=failed-with-evidence)(?=.*secretReadDeny=blocked)/s,
    );
    assert.deepEqual(calls, []);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("beads-drain non-dry by name auto-applies accepted lanes in autonomous-local mode (.5)", async () => {
  const { tools, context, directory } = await makeHarness(portPrompt({
    readyByRound: [
      [{ id: "item-1", title: "Fake Beads item", priority: 2, issue_type: "task" }],
      [],
    ],
    writeFile: { name: "beads-work.txt", body: "accepted beads lane\n" },
    verifyAction: "closed",
    finalDry: true,
    finalReason: "queue empty",
  }), {
    capabilities: undefined,
    pluginContext: {
      __workflowLiveGates: verifiedDrainLiveGates(),
      __workflowDrainAdapters: { beads: async () => fakeBeadsAdapter([]) },
    },
  });
  try {
    await initGitRepo(directory);
    const output = await runApproved(tools, context, { name: "beads-drain", args: { mode: "autonomous-local" }, background: false });
    const runId = runIdFrom(output);
    const status = JSON.parse(await tools.workflow_status.execute({ runId, format: "json", detail: "full" }, context));

    // Autonomous-local no longer stops at awaiting-diff-approval: the verified diff plan is applied
    // in-run, accepted code changes land in the primary tree, and staged Beads closes are finalized.
    assert.equal(status.status, "completed");
    assert.equal(status.integrationPlan.lanes.length, 1);
    assert.equal(status.integrationPlan.lanes[0].committed, true);
    assert.equal(status.editPlan.patchCount, 1);
    assert.equal(await fileExists(path.join(context.directory, "beads-work.txt")), true);
    assert.equal(await fs.readFile(path.join(context.directory, "beads-work.txt"), "utf8"), "accepted beads lane\n");
    const applyLedger = await readJsonl(path.join(status.dir, "apply-ledger.jsonl"));
    assert.deepEqual(
      applyLedger.map((entry) => entry.phase),
      ["started", "before-write", "after-write", "completed", "domain-finalized"],
    );
    assert.ok(applyLedger.every((entry) => entry.auto === true), "auto-apply ledger entries must be tagged auto=true");
    assert.equal(applyLedger[0].patchCount, 1);
    assert.equal(applyLedger[1].path, "beads-work.txt");
    assert.equal(applyLedger[2].path, "beads-work.txt");
    assert.equal(applyLedger[1].contentHash, applyLedger[2].contentHash);
    assert.equal(applyLedger[0].diffPlanHash, status.editPlan.diffPlanHash);
    assert.equal(applyLedger[3].diffPlanHash, status.editPlan.diffPlanHash);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("beads-drain launched from proxy keeps implementation child lanes on build", async () => {
  const promptAgents = [];
  const { tools, context, directory } = await makeHarness(async (input) => {
    const text = String(input?.body?.parts?.[0]?.text ?? "");
    if (text.includes("host-owned Beads drain workflow") || text.includes("Assigned item:")) {
      promptAgents.push(input?.body?.agent);
    }
    return await portPrompt({ writeFile: { name: "proxy-lane.txt", body: "from proxy controller\n" } })(input);
  }, {
    capabilities: undefined,
    pluginContext: {
      __workflowLiveGates: verifiedDrainLiveGates(),
      __workflowDrainAdapters: { beads: async () => fakeBeadsAdapter([]) },
    },
  });
  try {
    await initGitRepo(directory);
    await runApproved(tools, { ...context, agent: "proxy" }, { name: "beads-drain", args: { mode: "autonomous-local" }, background: false });

    assert.deepEqual(promptAgents, ["build"]);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("beads-drain non-dry by name records a failed lane without closing it", async () => {
  const { tools, context, directory } = await makeHarness(portPrompt({
    readyByRound: [[{ id: "item-1", title: "Fake Beads item", priority: 2, issue_type: "task" }], []],
    laneOutcome: "blocked",
    verifyAction: "left_open",
    finalDry: true,
  }), {
    capabilities: undefined,
    pluginContext: {
      __workflowLiveGates: verifiedDrainLiveGates(),
      __workflowDrainAdapters: { beads: async () => fakeBeadsAdapter([]) },
    },
  });
  try {
    await initGitRepo(directory);
    const output = await runApproved(tools, context, { name: "beads-drain", args: { mode: "autonomous-local" }, background: false });
    const runId = runIdFrom(output);
    const result = await readResult(output);

    assert.deepEqual(result.output.closed, []);
    assert.deepEqual(result.output.failed_ids, ["item-1"]);
    assert.doesNotMatch(JSON.stringify(result.output), /action_taken/);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("beads-drain host-owned path reports no-progress lanes without null verifier crashes", async () => {
  const { tools, context, directory } = await makeHarness(portPrompt({
    laneOutcome: "blocked",
  }), {
    capabilities: undefined,
    pluginContext: {
      __workflowLiveGates: verifiedDrainLiveGates(),
      __workflowDrainAdapters: { beads: async () => fakeBeadsAdapter([]) },
    },
  });
  try {
    await initGitRepo(directory);
    const output = await runApproved(tools, context, { name: "beads-drain", args: { mode: "autonomous-local" }, background: false });
    const result = await readResult(output);

    assert.equal(result.output.status, "failed");
    assert.deepEqual(result.output.closed, []);
    assert.deepEqual(result.output.failed_ids, ["item-1"]);
    assert.doesNotMatch(JSON.stringify(result.output), /action_taken/);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("beads-drain implementation prompt is limited to implementation lane work", async () => {
  const prompts = [];
  const { tools, context, directory } = await makeHarness(async (input) => {
    assert.equal(input?.body?.tools, undefined, "prompt-level tools overwrite session permission rules in OpenCode");
    prompts.push(String(input?.body?.parts?.[0]?.text ?? ""));
    return await portPrompt({ writeFile: { name: "lane.txt", body: "x\n" } })(input);
  }, {
    capabilities: undefined,
    pluginContext: {
      __workflowLiveGates: verifiedDrainLiveGates(),
      __workflowDrainAdapters: { beads: async () => fakeBeadsAdapter([]) },
    },
  });
  try {
    await initGitRepo(directory);
    const output = await runApproved(tools, context, { name: "beads-drain", args: { mode: "autonomous-local" }, background: false });
    assert.equal(prompts.length, 1);
    assert.match(prompts[0], /host-owned drain workflow/);
    // Domain-specific command prohibitions now arrive via the adapter's buildLanePacket instructions.
    assert.match(prompts[0], /Do not run Beads mutation commands/);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("R11-followup-2: validate() receives the controller's git-derived changed paths, not the lane's self-reported manifest", async () => {
  // The drain validate wrapper (workflow-plugin.js) must hand the adapter the CONTROLLER ground
  // truth for change scope — the integrated diff's name-only paths computed at commit time — so a
  // lane cannot spoof doc-vs-code by mislabeling its filesChanged. Here the lane self-reports a
  // spoofed doc-only manifest (`docs/decoy.md`) but actually writes a code file (`beads-work.txt`);
  // the wrapper must pass the real committed path through context.controllerChangedPaths.
  const captured = [];
  const wireCapture = (calls) => {
    const base = fakeBeadsAdapter(calls);
    return { ...base, async validate(discovered, integrationState, context = {}) {
      captured.push(context?.controllerChangedPaths);
      return await base.validate(discovered, integrationState, context);
    } };
  };
  const { tools, context, directory } = await makeHarness(async (input) => {
    const text = String(input?.body?.parts?.[0]?.text ?? "");
    const lanePrompt = text.includes("host-owned Beads drain workflow") || text.includes("Assigned item:");
    if (input?.query?.directory && lanePrompt) {
      await fs.writeFile(path.join(input.query.directory, "beads-work.txt"), "real code change\n", "utf8");
    }
    if (lanePrompt) {
      return { data: { parts: [{ type: "text", text: "implemented" }], info: { structured: {
        itemId: "item-1",
        outcome: "implemented",
        summary: "implemented",
        readyForIntegration: true,
        // Spoofed self-reported manifest: claims a doc-only change that does not match the diff.
        filesChanged: ["docs/decoy.md"],
        commandsRun: ["write"],
        acceptanceEvidence: ["written"],
        residualRisks: [],
        followups: [],
      }, tokens: { input: 1, output: 1, reasoning: 0 }, cost: 0 } } };
    }
    return { data: { parts: [], info: {} } };
  }, {
    capabilities: undefined,
    pluginContext: {
      __workflowLiveGates: verifiedDrainLiveGates(),
      __workflowDrainAdapters: { beads: async () => wireCapture([]) },
    },
  });
  try {
    await initGitRepo(directory);
    await runApproved(tools, context, { name: "beads-drain", args: { mode: "autonomous-local" }, background: false });
    assert.equal(captured.length, 1, "validate ran exactly once for the single lane");
    const controllerPaths = captured[0];
    assert.ok(Array.isArray(controllerPaths), "the wrapper passed controllerChangedPaths from the committed integration lane");
    const paths = controllerPaths.map((entry) => (typeof entry === "string" ? entry : entry.path));
    // Ground truth is the actually-committed file, NOT the spoofed docs/decoy.md manifest.
    assert.ok(paths.includes("beads-work.txt"), `controller diff names the real committed file: ${JSON.stringify(paths)}`);
    assert.ok(!paths.includes("docs/decoy.md"), "the spoofed self-reported manifest is not the source of scope ground truth");
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
