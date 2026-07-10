import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { setTimeout as sleep } from "node:timers/promises";

import WorkflowPlugin from "../workflow-kernel/index.js";
import { DEFAULT_CAPABILITIES, makeHarness } from "./helpers/harness.mjs";
import {
  classifyLaneError,
  computeLaneBackoffMs,
  retryAfterMsFromError,
  DEFAULT_LANE_RETRY_BASE_MS,
  MAX_LANE_RETRY_DELAY_MS,
} from "../workflow-kernel/errors.js";
import { laneAuthorityInstruction } from "../workflow-kernel/authority-policy.js";

// Direct unit coverage for the pure/semi-pure lane-scoped helpers exported from
// workflow-kernel/child-agent-runner.js: the resume cache-hit and checkpoint-hit discriminators,
// the lane task-summary chooser, the integration-lane lookup, and the edit-patch normalizer +
// edit-plan accumulator. runChildAgent itself is the heavy child-session lifecycle (create/prompt/
// retry/integrate) and is intentionally not exercised here; it is covered indirectly by the
// drain/workflow suites.
const {
  classifyResumeCacheHit,
  checkpointHitForSignature,
  laneTaskSummary,
  findIntegrationLane,
  normalizePatches,
  addEditPlanFromResult,
  runChildAgent,
  sessionDirectoryEchoStatus,
  createEditWorktree,
  writeLaneCheckpoint,
  applyLaneEffortParams,
  clearLaneEffort,
  laneEffortPolicies,
  laneEffortPolicyForChild,
  laneEffortPolicyForModel,
  loadRoleDefaultsManifest,
  mergeRoleDefaults,
  normalizeLaneEffort,
  registerLaneEffort,
  resolveRole,
} = WorkflowPlugin.__test;

async function tempRunDir(prefix) {
  const root = await fs.mkdtemp(path.join("/tmp", `${prefix}-`));
  const dir = path.join(root, ".opencode", "workflows", "runs", "run-child-agent");
  await fs.mkdir(dir, { recursive: true });
  return { root, dir };
}

function minimalChildRun(dir, overrides = {}) {
  return {
    id: "run-child-agent",
    dir,
    sourceHash: "source-hash",
    runtimeArgs: null,
    meta: { name: "child-agent-direct" },
    authority: {
      readOnly: true,
      shell: false,
      shellPolicy: { allow: [], deny: [] },
      network: false,
      mcp: false,
      edit: false,
      worktreeEdit: false,
      integration: false,
      profile: "read-only-review",
    },
    capabilities: { ...DEFAULT_CAPABILITIES },
    adapter: {},
    defaultChildModel: "test/model",
    modelTiers: {},
    laneTimeoutMs: 1_000,
    agentsStarted: 0,
    maxAgents: 5,
    concurrency: 1,
    activeAgents: 0,
    waitingAgents: [],
    tokens: { input: 0, output: 0, reasoning: 0 },
    replayedTokens: { input: 0, output: 0, reasoning: 0 },
    cost: 0,
    replayedCost: 0,
    cacheStats: { hits: 0, misses: 0, invalidated: 0 },
    budgetCeilings: {},
    laneOutcomes: { success: 0, failure: 0, cancelled: 0, timeout: 0, budget_stopped: 0 },
    droppedLaneCount: 0,
    laneRecords: new Map(),
    resumeJournal: new Map(),
    children: new Map(),
    activeLaneAbortControllers: new Map(),
    abortController: new AbortController(),
    editWorktrees: [],
    integrationWorktrees: [],
    integrationPlan: { lanes: [] },
    diagnostics: {},
    nestedSnapshots: new Map(),
    eventCount: 0,
    journalRecords: 0,
    status: "running",
    startedAt: new Date().toISOString(),
    ...overrides,
  };
}

function directDeps(overrides = {}) {
  return {
    throwIfAborted() {},
    throwIfLaneCancelled() {},
    async acquireAgentSlot() {},
    releaseAgentSlot() {},
    async checkDurableLifecycleRequest() {},
    async dirtyWorktreeSalvage() { return undefined; },
    ...overrides,
  };
}

function directPluginContext(prompt, calls = { create: [], prompt: [], abort: [] }) {
  return {
    client: {
      session: {
        async create(input) {
          calls.create.push(input);
          return { data: { id: `child-${calls.create.length}` } };
        },
        async prompt(input) {
          calls.prompt.push(input);
          return await prompt(input);
        },
        async abort(input) {
          calls.abort.push(input);
          return { data: { ok: true } };
        },
      },
    },
  };
}

test("lane effort policy maps OpenAI effort through providerOptions and rejects unsupported providers", () => {
  laneEffortPolicies.clear();
  assert.equal(normalizeLaneEffort("HIGH"), "high");
  assert.throws(() => normalizeLaneEffort("max"), /Invalid agent\(\) option effort/);
  assert.deepEqual(
    laneEffortPolicyForModel("high", { providerID: "openai", modelID: "gpt-5" }),
    { effort: "high", providerID: "openai", providerOptionsKey: "openai", optionKey: "reasoningEffort" },
  );
  assert.throws(
    () => laneEffortPolicyForModel("high", { providerID: "anthropic", modelID: "claude" }),
    /supported only for OpenAI providers/,
  );

  registerLaneEffort("child-effort", laneEffortPolicyForModel("medium", "openai/gpt-5"));
  const output = { options: { providerOptions: { openai: { previous: "kept" }, anthropic: { keep: true } } } };
  assert.equal(applyLaneEffortParams({ sessionID: "child-effort" }, output), true);
  assert.equal(output.options.providerOptions.openai.previous, "kept");
  assert.equal(output.options.providerOptions.openai.reasoningEffort, "medium");
  assert.deepEqual(output.options.providerOptions.anthropic, { keep: true });
  assert.equal(clearLaneEffort("child-effort"), true);
  assert.equal(applyLaneEffortParams({ sessionID: "child-effort" }, output), false);
});

test("WorkflowPlugin chat.params hook applies registered lane effort", async () => {
  laneEffortPolicies.clear();
  const hooks = await WorkflowPlugin({ client: {} }, { extensions: [] });
  registerLaneEffort("child-hook", laneEffortPolicyForModel("low", "openai/gpt-5"));
  const output = { options: { providerOptions: { openai: { previous: "kept" } } } };
  try {
    await hooks["chat.params"]({ sessionID: "child-hook", agent: "build", model: { providerID: "openai", modelID: "gpt-5" } }, output);
    assert.equal(output.options.providerOptions.openai.previous, "kept");
    assert.equal(output.options.providerOptions.openai.reasoningEffort, "low");
  } finally {
    laneEffortPolicies.clear();
  }
});

test("roles.json defaults manifest is validated and attached to prompt hash provenance", async () => {
  const root = await fs.mkdtemp(path.join("/tmp", "role-defaults-manifest-"));
  const roleDir = path.join(root, "roles");
  await fs.mkdir(roleDir, { recursive: true });
  await fs.writeFile(path.join(roleDir, "explorer.md"), "custom explorer prompt", "utf8");
  await fs.writeFile(path.join(roleDir, "roles.json"), JSON.stringify({
    roles: {
      explorer: {
        tier: "fast",
        readOnly: true,
        tools: { bash: false },
        retryCount: 2,
        correctiveRetries: 1,
        timeoutMs: 2500,
        mcpPolicy: { allow: ["mcp__docs_*"], deny: ["mcp__secrets_*"] },
        secretGlobs: [".env.local", ".env.local"],
        effort: "low",
      },
    },
  }), "utf8");

  try {
    assert.deepEqual(await loadRoleDefaultsManifest(roleDir), {
      explorer: {
        tier: "fast",
        readOnly: true,
        tools: { bash: false },
        retryCount: 2,
        correctiveRetries: 1,
        timeoutMs: 2500,
        mcpPolicy: { allow: ["mcp__docs_*"], deny: ["mcp__secrets_*"] },
        secretGlobs: [".env.local"],
        effort: "low",
      },
    });

    const role = await resolveRole("explorer", roleDir);
    assert.equal(role.content, "custom explorer prompt");
    assert.equal(role.userModified, true, "custom prompt keeps shipped-vs-user-modified provenance");
    assert.equal(typeof role.contentHash, "string");
    assert.equal(typeof role.shippedHash, "string");
    assert.deepEqual(role.defaults, {
      tier: "fast",
      readOnly: true,
      tools: { bash: false },
      retryCount: 2,
      correctiveRetries: 1,
      timeoutMs: 2500,
      mcpPolicy: { allow: ["mcp__docs_*"], deny: ["mcp__secrets_*"] },
      secretGlobs: [".env.local"],
      effort: "low",
    });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("roles.json rejects unsupported or misshaped defaults", async () => {
  const root = await fs.mkdtemp(path.join("/tmp", "role-defaults-invalid-"));
  const roleDir = path.join(root, "roles");
  await fs.mkdir(roleDir, { recursive: true });
  try {
    await fs.writeFile(path.join(roleDir, "roles.json"), JSON.stringify({ roles: { explorer: { edit: true } } }), "utf8");
    await assert.rejects(
      () => loadRoleDefaultsManifest(roleDir),
      /Unsupported role default option for explorer: edit/,
    );

    await fs.writeFile(path.join(roleDir, "roles.json"), JSON.stringify({ roles: { explorer: { tools: { bash: "yes" } } } }), "utf8");
    await assert.rejects(
      () => loadRoleDefaultsManifest(roleDir),
      /Role explorer default tools\.bash must be a boolean/,
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("role defaults merge before explicit opts with explicit opts taking precedence", () => {
  const merged = mergeRoleDefaults(
    { model: "openai/gpt-5", readOnly: true, tools: { bash: false }, retryCount: 2, timeoutMs: 2500 },
    { model: "anthropic/claude-opus", tools: { webfetch: true }, timeoutMs: 9000 },
  );
  assert.deepEqual(merged, {
    model: "anthropic/claude-opus",
    readOnly: true,
    tools: { webfetch: true },
    retryCount: 2,
    timeoutMs: 9000,
  });
});

test("runChildAgent registers effort for the live child session and clears it after completion", async () => {
  const { root, dir } = await tempRunDir("child-agent-effort-policy");
  laneEffortPolicies.clear();
  const calls = { create: [], prompt: [], abort: [] };
  let observedPolicy;
  let appliedOptions;
  const pluginContext = directPluginContext(async (input) => {
    const childID = input.path?.id;
    observedPolicy = laneEffortPolicyForChild(childID);
    const output = { options: { providerOptions: { openai: { previous: "kept" } } } };
    assert.equal(applyLaneEffortParams({ sessionID: childID }, output), true);
    appliedOptions = output.options;
    return {
      data: {
        parts: [{ type: "text", text: "effort-result" }],
        info: { tokens: { input: 1, output: 1, reasoning: 0 }, cost: 0 },
      },
    };
  }, calls);
  const toolContext = { directory: root, sessionID: "parent-session", abort: new AbortController().signal };
  const run = minimalChildRun(dir, { defaultChildModel: "openai/gpt-5" });
  try {
    const result = await runChildAgent(pluginContext, toolContext, run, {
      callId: "lane:effort",
      prompt: "do high effort work",
      opts: { effort: "high" },
    }, directDeps());

    assert.equal(result, "effort-result");
    assert.deepEqual(observedPolicy, {
      effort: "high",
      providerID: "openai",
      providerOptionsKey: "openai",
      optionKey: "reasoningEffort",
    });
    assert.equal(appliedOptions.providerOptions.openai.previous, "kept");
    assert.equal(appliedOptions.providerOptions.openai.reasoningEffort, "high");
    assert.equal(laneEffortPolicyForChild("child-1"), undefined, "child effort policy must be cleared after finalization");
  } finally {
    laneEffortPolicies.clear();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("runChildAgent rejects effort for unsupported providers before creating a child", async () => {
  const { root, dir } = await tempRunDir("child-agent-effort-unsupported");
  const calls = { create: [], prompt: [], abort: [] };
  const pluginContext = directPluginContext(async () => {
    throw new Error("unsupported provider effort must fail before prompt");
  }, calls);
  const toolContext = { directory: root, sessionID: "parent-session", abort: new AbortController().signal };
  const run = minimalChildRun(dir, { defaultChildModel: "anthropic/claude-3-5-sonnet" });
  try {
    await assert.rejects(
      runChildAgent(pluginContext, toolContext, run, {
        callId: "lane:unsupported-effort",
        prompt: "do unsupported high effort work",
        opts: { effort: "high" },
      }, directDeps()),
      /supported only for OpenAI providers/,
    );
    assert.equal(calls.create.length, 0, "unsupported effort must fail before child session creation");
    assert.equal(calls.prompt.length, 0, "unsupported effort must fail before prompting");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("runChildAgent applies roles.json defaults before model, timeout, prompt, and policy resolution", async () => {
  const { root, dir } = await tempRunDir("child-agent-role-defaults");
  const roleDir = path.join(root, "roles");
  await fs.mkdir(roleDir, { recursive: true });
  await fs.writeFile(path.join(roleDir, "explorer.md"), "role default prompt", "utf8");
  await fs.writeFile(path.join(roleDir, "roles.json"), JSON.stringify({
    roles: {
      explorer: {
        model: "openai/gpt-5",
        readOnly: true,
        tools: { bash: true },
        retryCount: 0,
        timeoutMs: 2345,
      },
    },
  }), "utf8");

  const calls = { create: [], prompt: [], abort: [] };
  const pluginContext = directPluginContext(async () => ({
    data: {
      parts: [{ type: "text", text: "role-default-result" }],
      info: { tokens: { input: 1, output: 1, reasoning: 0 }, cost: 0 },
    },
  }), calls);
  pluginContext.__workflowRoleDir = roleDir;
  const toolContext = { directory: root, sessionID: "parent-session", abort: new AbortController().signal };
  const run = minimalChildRun(dir, { defaultChildModel: "opencode/harness-default" });

  try {
    const result = await runChildAgent(pluginContext, toolContext, run, {
      callId: "lane:role-defaults",
      prompt: "inspect with role defaults",
      opts: { role: "explorer" },
    }, directDeps());

    assert.equal(result, "role-default-result");
    assert.deepEqual(calls.prompt[0].body.model, { providerID: "openai", modelID: "gpt-5" });
    assert.match(calls.prompt[0].body.system, /Role explorer:\nrole default prompt/);

    const [entry] = (await readJournal(dir)).filter((record) => record.type === "agent" && record.callId === "lane:role-defaults");
    assert.equal(entry.model, "openai/gpt-5");
    assert.equal(entry.timeoutMs, 2345);
    assert.equal(entry.rolePromptHash.length, 64);
    assert.equal(entry.permissionPolicy.tools.bash, false, "readOnly role default strips escalation tools");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("runChildAgent explicit opts override roles.json defaults", async () => {
  const { root, dir } = await tempRunDir("child-agent-role-default-overrides");
  const roleDir = path.join(root, "roles");
  await fs.mkdir(roleDir, { recursive: true });
  await fs.writeFile(path.join(roleDir, "explorer.md"), "role override prompt", "utf8");
  await fs.writeFile(path.join(roleDir, "roles.json"), JSON.stringify({
    roles: {
      explorer: {
        model: "openai/gpt-5",
        readOnly: true,
        tools: { bash: true },
        retryCount: 2,
        timeoutMs: 2345,
      },
    },
  }), "utf8");

  const calls = { create: [], prompt: [], abort: [] };
  const pluginContext = directPluginContext(async () => ({
    data: {
      parts: [{ type: "text", text: "role-override-result" }],
      info: { tokens: { input: 1, output: 1, reasoning: 0 }, cost: 0 },
    },
  }), calls);
  pluginContext.__workflowRoleDir = roleDir;
  const toolContext = { directory: root, sessionID: "parent-session", abort: new AbortController().signal };
  const run = minimalChildRun(dir, {
    defaultChildModel: "opencode/harness-default",
    authority: {
      readOnly: false,
      shell: false,
      shellPolicy: { allow: [], deny: [] },
      network: true,
      mcp: false,
      edit: false,
      worktreeEdit: false,
      integration: false,
      profile: "custom-network",
    },
  });

  try {
    const result = await runChildAgent(pluginContext, toolContext, run, {
      callId: "lane:role-overrides",
      prompt: "inspect with explicit overrides",
      opts: {
        role: "explorer",
        model: "anthropic/claude-opus",
        readOnly: false,
        tools: { webfetch: true },
        timeoutMs: 4567,
        retryCount: 0,
      },
    }, directDeps());

    assert.equal(result, "role-override-result");
    assert.deepEqual(calls.prompt[0].body.model, { providerID: "anthropic", modelID: "claude-opus" });
    const [entry] = (await readJournal(dir)).filter((record) => record.type === "agent" && record.callId === "lane:role-overrides");
    assert.equal(entry.model, "anthropic/claude-opus");
    assert.equal(entry.timeoutMs, 4567);
    assert.equal(entry.permissionPolicy.tools.webfetch, true);
    assert.equal(entry.permissionPolicy.tools.bash, false, "explicit tools map replaces role default tools");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

// --- classifyResumeCacheHit: resume journal cache-hit discriminator ----------------------

test("classifyResumeCacheHit routes a matching controller-captured success to cache.hit", () => {
  assert.deepEqual(
    classifyResumeCacheHit({ signatureHash: "sig", outcome: "success", result: { ok: 1 } }, "sig"),
    { kind: "hit", eventType: "cache.hit" },
  );
  // An entry that omits salvagedFromTranscript entirely is a legacy normal capture too.
  assert.deepEqual(
    classifyResumeCacheHit({ signatureHash: "sig", outcome: "success", result: {} }, "sig"),
    { kind: "hit", eventType: "cache.hit" },
  );
});

test("classifyResumeCacheHit routes a matching transcript-salvaged success to the DISTINCT cache.salvaged_hit", () => {
  const hit = classifyResumeCacheHit({ signatureHash: "sig", outcome: "success", salvagedFromTranscript: true }, "sig");
  assert.deepEqual(hit, { kind: "salvaged-hit", eventType: "cache.salvaged_hit" });
  assert.notEqual(hit.eventType, "cache.hit", "salvaged provenance must remain distinguishable");
});

test("classifyResumeCacheHit returns null on missing entry, signature mismatch, or non-success outcome", () => {
  const ok = { signatureHash: "sig", outcome: "success", result: {} };
  assert.equal(classifyResumeCacheHit(null, "sig"), null);
  assert.equal(classifyResumeCacheHit(undefined, "sig"), null);
  assert.equal(classifyResumeCacheHit(ok, "wrong-sig"), null, "signature mismatch must not cache-hit");
  assert.equal(classifyResumeCacheHit(ok, undefined), null, "undefined incoming signature must not cache-hit");
  assert.equal(
    classifyResumeCacheHit({ signatureHash: "sig", outcome: "failure" }, "sig"),
    null,
    "a failed lane must never be reused as a cache hit",
  );
  // A salvaged entry whose outcome is failure (e.g. schema-mismatch salvage) must not be reused either.
  assert.equal(classifyResumeCacheHit({ signatureHash: "sig", outcome: "failure", salvagedFromTranscript: true }, "sig"), null);
});

// --- checkpointHitForSignature: durable lane checkpoint discriminator ---------------------

test("checkpointHitForSignature returns a checkpoint-hit (with result) on a signature match", () => {
  const result = { itemId: "x", findings: ["a"] };
  assert.deepEqual(
    checkpointHitForSignature({ signatureHash: "sig", result }, "sig"),
    { kind: "checkpoint-hit", eventType: "cache.checkpoint_hit", result },
  );
});

test("checkpointHitForSignature returns null for an absent or signature-mismatched checkpoint", () => {
  assert.equal(checkpointHitForSignature(null, "sig"), null, "absent checkpoint must fall through");
  assert.equal(checkpointHitForSignature(undefined, "sig"), null);
  assert.equal(
    checkpointHitForSignature({ signatureHash: "sig", result: {} }, "other-sig"),
    null,
    "signature mismatch must fall through to the journal check",
  );
});

test("checkpointHitForSignature returns null when the incoming signature is falsy", () => {
  // Guards the discriminator against being called before the lane signature is computed.
  assert.equal(checkpointHitForSignature({ signatureHash: "sig", result: {} }, ""), null);
  assert.equal(checkpointHitForSignature({ signatureHash: "sig", result: {} }, undefined), null);
  assert.equal(checkpointHitForSignature({ signatureHash: "sig", result: {} }, null), null);
});

// --- laneTaskSummary: the lane display/signature summary chooser -------------------------

test("laneTaskSummary precedence is taskSummary > summary > label > title", () => {
  assert.equal(laneTaskSummary("prompt", { taskSummary: "ts", summary: "sm", label: "lb", title: "ti" }), "ts");
  assert.equal(laneTaskSummary("prompt", { summary: "sm", label: "lb", title: "ti" }), "sm");
  assert.equal(laneTaskSummary("prompt", { label: "lb", title: "ti" }), "lb");
  assert.equal(laneTaskSummary("prompt", { title: "ti" }), "ti");
});

test("laneTaskSummary falls back to the first non-empty prompt line, then the title, then a default", () => {
  assert.equal(laneTaskSummary("first line\nsecond line", {}), "first line");
  assert.equal(laneTaskSummary("   \nsecond", {}), "second", "blank-only first line is skipped");
  assert.equal(laneTaskSummary("", {}, "Fallback Title"), "Fallback Title");
  assert.equal(laneTaskSummary("", {}), "workflow lane");
  assert.equal(laneTaskSummary(undefined, {}), "workflow lane");
});

test("laneTaskSummary truncates any summary to 160 characters", () => {
  assert.equal(laneTaskSummary("", { taskSummary: "x".repeat(200) }).length, 160);
  assert.equal(laneTaskSummary(`${"y".repeat(200)}\nmore`, {}).length, 160);
});

// --- findIntegrationLane: integration plan lane lookup -----------------------------------

test("findIntegrationLane returns the matching lane by callId, else undefined", () => {
  const lane = { callId: "lane:a", committed: true };
  const run = { integrationPlan: { lanes: [lane, { callId: "lane:b" }] } };
  assert.equal(findIntegrationLane(run, "lane:a"), lane);
  assert.equal(findIntegrationLane(run, "lane:missing"), undefined);
  assert.equal(findIntegrationLane({ integrationPlan: { lanes: [] } }, "lane:a"), undefined);
  assert.equal(findIntegrationLane({ integrationPlan: {} }, "lane:a"), undefined, "missing lanes array -> undefined");
  assert.equal(findIntegrationLane({}, "lane:a"), undefined, "missing integrationPlan -> undefined");
  // Note: findIntegrationLane assumes a non-null run object (its RunContext contract); a nullish
  // run is out of contract and is not tested here.
});

// --- normalizePatches: edit-patch validation + normalization ------------------------------

test("normalizePatches normalizes a patches array to {path, content} and drops the mode field", () => {
  const out = normalizePatches({ patches: [{ path: "src/a.txt", content: "new", mode: "replace" }] });
  assert.deepEqual(out, [{ path: "src/a.txt", content: "new" }]);
});

test("normalizePatches accepts a bare patch array and the `file` path alias, coercing content to a string", () => {
  assert.deepEqual(
    normalizePatches([{ file: "b.txt", content: 123 }]),
    [{ path: "b.txt", content: "123" }],
  );
});

test("normalizePatches returns [] for empty/absent patch inputs", () => {
  assert.deepEqual(normalizePatches({}), []);
  assert.deepEqual(normalizePatches({ patches: [] }), []);
  assert.deepEqual(normalizePatches(null), []);
  assert.deepEqual(normalizePatches(undefined), []);
});

test("normalizePatches rejects a non-object patch", () => {
  assert.throws(
    () => normalizePatches({ patches: ["nope"] }),
    /Invalid edit patch at index 0/,
  );
  assert.throws(
    () => normalizePatches({ patches: [null, { path: "a", content: "x" }] }),
    /Invalid edit patch at index 0/,
  );
});

test("normalizePatches rejects absolute paths and parent-directory traversal", () => {
  assert.throws(
    () => normalizePatches({ patches: [{ path: "/etc/passwd", content: "x" }] }),
    /Invalid edit patch path at index 0: \/etc\/passwd/,
  );
  assert.throws(
    () => normalizePatches({ patches: [{ path: "a/../b", content: "x" }] }),
    /Invalid edit patch path at index 0: a\/\.\.\/b/,
  );
});

test("normalizePatches rejects a patch missing content", () => {
  assert.throws(
    () => normalizePatches({ patches: [{ path: "a.txt" }] }),
    /Edit patch a\.txt is missing content/,
  );
});

test('normalizePatches rejects any mode other than "replace" (case-sensitive) and defaults null mode', () => {
  assert.throws(
    () => normalizePatches({ patches: [{ path: "a", content: "x", mode: "append" }] }),
    /Unsupported edit patch mode for a: append \(only "replace" is supported\)/,
  );
  // Mode matching is case-sensitive: "REPLACE" is rejected, only lowercase "replace" is honored.
  assert.throws(
    () => normalizePatches({ patches: [{ path: "a", content: "x", mode: "REPLACE" }] }),
    /Unsupported edit patch mode for a: REPLACE/,
  );
  // null/undefined mode defaults to the supported "replace" and is dropped from the output.
  assert.deepEqual(
    normalizePatches({ patches: [{ path: "a", content: "x", mode: null }] }),
    [{ path: "a", content: "x" }],
  );
});

// --- addEditPlanFromResult: edit-plan accumulation (semi-pure; mutates run) ---------------

test("addEditPlanFromResult pushes normalized patches onto run.editPlan stamped with callId + worktreePath", () => {
  const run = { editPlan: { patches: [] } };
  addEditPlanFromResult(run, "lane:edit", { patches: [{ path: "f.txt", content: "z" }, { file: "g.txt", content: "w" }] }, { path: "/wt/lane-edit" });
  assert.deepEqual(run.editPlan.patches, [
    { path: "f.txt", content: "z", callId: "lane:edit", worktreePath: "/wt/lane-edit" },
    { path: "g.txt", content: "w", callId: "lane:edit", worktreePath: "/wt/lane-edit" },
  ]);
});

test("addEditPlanFromResult without a worktree record stamps worktreePath as undefined", () => {
  const run = { editPlan: { patches: [{ path: "pre.txt", content: "0", callId: "x" }] } };
  addEditPlanFromResult(run, "lane:edit", { patches: [{ path: "h.txt", content: "y" }] });
  assert.deepEqual(run.editPlan.patches[1], { path: "h.txt", content: "y", callId: "lane:edit", worktreePath: undefined });
});

test("addEditPlanFromResult propagates normalizePatches validation failures (invalid patches never partially accumulate)", () => {
  const run = { editPlan: { patches: [] } };
  assert.throws(
    () => addEditPlanFromResult(run, "lane:edit", { patches: [{ path: "a", content: "x", mode: "append" }] }),
    /Unsupported edit patch mode for a: append/,
  );
  assert.deepEqual(run.editPlan.patches, [], "no patch is pushed when normalization throws");
});

// --- lane failure taxonomy (errors.js): transient vs terminal classification --------------

test("classifyLaneError treats rate-limit / overload / transport faults as transient", () => {
  assert.equal(classifyLaneError(Object.assign(new Error("429 Too Many Requests"), { status: 429 })), "transient");
  assert.equal(classifyLaneError(Object.assign(new Error("upstream"), { statusCode: 503 })), "transient");
  assert.equal(classifyLaneError(new Error("Anthropic API is Overloaded")), "transient");
  assert.equal(classifyLaneError(new Error("read ECONNRESET")), "transient");
  assert.equal(classifyLaneError(new Error("socket hang up")), "transient");
  assert.equal(classifyLaneError(new Error("Provider returned 529")), "transient");
});

test("classifyLaneError treats bad-model / auth / schema rejections as terminal (fail fast)", () => {
  assert.equal(classifyLaneError(Object.assign(new Error("model not found: bogus/model"), { status: 404 })), "terminal");
  assert.equal(classifyLaneError(new Error("Unknown model openai/nope")), "terminal");
  assert.equal(classifyLaneError(Object.assign(new Error("unauthorized"), { status: 401 })), "terminal");
  assert.equal(classifyLaneError(new Error("invalid api key")), "terminal");
  // A terminal HTTP status wins over an incidental transient-looking word in the message.
  assert.equal(classifyLaneError(Object.assign(new Error("400 bad request"), { status: 400 })), "terminal");
});

test("classifyLaneError treats workflow control errors and unknown faults as terminal (never auto-retried)", () => {
  for (const code of ["WORKFLOW_CANCELLED", "WORKFLOW_TIMEOUT", "WORKFLOW_BUDGET_STOPPED", "WORKFLOW_AUTHORITY_VIOLATION"]) {
    assert.equal(classifyLaneError({ code, message: "x" }), "terminal", code);
  }
  // Unknown/unmatched errors default terminal so an unclassified fault never becomes a retry storm.
  assert.equal(classifyLaneError(new Error("something weird happened")), "terminal");
  assert.equal(classifyLaneError(undefined), "terminal");
});

test("retryAfterMsFromError honors retryAfterMs, delay-seconds, and HTTP-date retry-after", (t) => {
  assert.equal(retryAfterMsFromError({ retryAfterMs: 60 }), 60);
  assert.equal(retryAfterMsFromError({ headers: { "retry-after": "2" } }), 2000);
  assert.equal(retryAfterMsFromError({ retryAfter: 1.5 }), 1500);
  const now = Date.UTC(2026, 0, 1, 0, 0, 0);
  t.mock.method(Date, "now", () => now);
  assert.equal(retryAfterMsFromError({ headers: { "retry-after": new Date(now + 12_000).toUTCString() } }), 12_000);
  assert.equal(retryAfterMsFromError({ headers: { "retry-after": new Date(now - 12_000).toUTCString() } }), 0);
  assert.equal(retryAfterMsFromError(new Error("no hint")), undefined);
});

test("computeLaneBackoffMs grows exponentially, honors Retry-After, and caps", () => {
  // Deterministic full-jitter (jitter:()=>1) yields the full exponential value.
  assert.equal(computeLaneBackoffMs(1, { baseMs: 100, jitter: () => 1 }), 100);
  assert.equal(computeLaneBackoffMs(2, { baseMs: 100, jitter: () => 1 }), 200);
  assert.equal(computeLaneBackoffMs(3, { baseMs: 100, jitter: () => 1 }), 400);
  // Half-jitter (jitter:()=>0) is the floor of the full-jitter window.
  assert.equal(computeLaneBackoffMs(2, { baseMs: 100, jitter: () => 0 }), 100);
  // An upstream Retry-After overrides the computed exponential delay (still capped).
  assert.equal(computeLaneBackoffMs(5, { baseMs: 100, retryAfterMs: 37, jitter: () => 1 }), 37);
  // Cap is enforced for both the exponential and the Retry-After paths.
  assert.equal(computeLaneBackoffMs(40, { baseMs: 1000, jitter: () => 1 }), MAX_LANE_RETRY_DELAY_MS);
  assert.equal(computeLaneBackoffMs(1, { retryAfterMs: MAX_LANE_RETRY_DELAY_MS + 5000, jitter: () => 1 }), MAX_LANE_RETRY_DELAY_MS);
  assert.ok(DEFAULT_LANE_RETRY_BASE_MS > 0);
});

// --- runChildAgent: real lane retry / backoff / terminal-classification (drives the live path) ---

async function runApproved(tools, context, source) {
  const preview = await tools.workflow_run.execute({ source }, context);
  const match = preview.match(/approvalHash: ([a-f0-9]{64})/);
  assert.ok(match, `missing approvalHash in preview: ${preview}`);
  return await tools.workflow_run.execute({ source, approve: true, approvalHash: match[1] }, context);
}

function runIdFrom(output) {
  const match = output.match(/Workflow ([0-9a-f-]{36}) /);
  assert.ok(match, `missing run id in output: ${output}`);
  return match[1];
}

async function readEvents(runDir) {
  const content = await fs.readFile(path.join(runDir, "events.jsonl"), "utf8");
  return content.split(/\r?\n/).filter((line) => line.trim()).map((line) => JSON.parse(line));
}

async function readJournal(runDir) {
  const content = await fs.readFile(path.join(runDir, "journal.jsonl"), "utf8");
  return content.split(/\r?\n/).filter((line) => line.trim()).map((line) => JSON.parse(line));
}

test("runChildAgent prefers authoritative resume journal over a stale checkpoint without re-incrementing lane outcomes", async () => {
  const { root, dir } = await tempRunDir("child-agent-checkpoint-idempotency");
  const calls = { create: [], prompt: [], abort: [] };
  const pluginContext = directPluginContext(async () => ({
    data: {
      parts: [{ type: "text", text: "journal-result" }],
      info: { tokens: { input: 1, output: 1, reasoning: 0 }, cost: 0 },
    },
  }), calls);
  const toolContext = { directory: root, sessionID: "parent-session", abort: new AbortController().signal };
  const run = minimalChildRun(dir);
  const payload = { callId: "lane:cached", prompt: "do cached work", opts: {} };
  try {
    assert.equal(await runChildAgent(pluginContext, toolContext, run, payload, directDeps()), "journal-result");
    assert.equal(run.laneOutcomes.success, 1);
    const [entry] = (await readJournal(dir)).filter((record) => record.type === "agent" && record.callId === "lane:cached");
    assert.ok(entry?.signatureHash, "first lane run records the authoritative journal signature");

    run.resumeJournal = new Map([["lane:cached", entry]]);
    await writeLaneCheckpoint(dir, "lane:cached", "result", {
      runId: run.id,
      callId: "lane:cached",
      signatureHash: entry.signatureHash,
      result: "stale-checkpoint-result",
      capturedAt: new Date().toISOString(),
    });

    assert.equal(await runChildAgent(pluginContext, toolContext, run, payload, directDeps()), "journal-result");
    assert.equal(run.laneOutcomes.success, 1, "journal cache hit must not re-increment the carried lane tally");
    assert.equal(calls.prompt.length, 1, "resume cache hit must not prompt a second child");
    assert.equal(run.cacheStats.hits, 1);
    const events = await readEvents(dir);
    assert.equal(events.filter((event) => event.type === "cache.hit").length, 1);
    assert.equal(events.some((event) => event.type === "cache.checkpoint_hit"), false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

// opencode-workflows-zi0f: a checkpoint-hit resume of an edit lane must re-apply the lane's
// diff-plan contribution. The result checkpoint is written AFTER addEditPlanFromResult and captures
// worktreePath + result, so recovery replays the patches into run.editPlan instead of journaling
// outcome:'success' with a silently dropped contribution.
test("runChildAgent checkpoint-hit resume of an edit lane replays the dropped diff-plan patches", async () => {
  const { root, dir } = await tempRunDir("child-agent-checkpoint-editplan");
  const calls = { create: [], prompt: [], abort: [] };
  const pluginContext = directPluginContext(async () => ({
    data: {
      parts: [{ type: "text", text: "first-result" }],
      info: { tokens: { input: 1, output: 1, reasoning: 0 }, cost: 0 },
    },
  }), calls);
  const toolContext = { directory: root, sessionID: "parent-session", abort: new AbortController().signal };
  const run = minimalChildRun(dir, { editPlan: { sourceHash: "sh", baseCommit: "base", patches: [], worktrees: [] } });
  const payload = { callId: "lane:edit", prompt: "do edit work", opts: {} };
  try {
    // First run captures the authoritative lane signature for this payload.
    await runChildAgent(pluginContext, toolContext, run, payload, directDeps());
    const [entry] = (await readJournal(dir)).filter((record) => record.type === "agent" && record.callId === "lane:edit");
    assert.ok(entry?.signatureHash, "first lane run records the authoritative journal signature");

    // Simulate a crash after the result checkpoint (with captured worktreePath + patches) but before
    // the lane's contribution was persisted: no resume-journal entry, checkpoint present, empty plan.
    run.resumeJournal = new Map();
    run.editPlan = { sourceHash: "sh", baseCommit: "base", patches: [], worktrees: [] };
    await writeLaneCheckpoint(dir, "lane:edit", "result", {
      runId: run.id,
      callId: "lane:edit",
      signatureHash: entry.signatureHash,
      result: { patches: [{ path: "src/a.txt", content: "hello" }] },
      worktreePath: "/wt/lane-edit",
      capturedAt: new Date().toISOString(),
    });
    const promptCountBefore = calls.prompt.length;

    await runChildAgent(pluginContext, toolContext, run, payload, directDeps());
    assert.equal(calls.prompt.length, promptCountBefore, "checkpoint-hit resume must not prompt a child again");
    assert.deepEqual(run.editPlan.patches, [
      { path: "src/a.txt", content: "hello", callId: "lane:edit", worktreePath: "/wt/lane-edit" },
    ], "checkpoint-hit resume must replay the edit lane's dropped patches");
    const events = await readEvents(dir);
    assert.ok(events.some((event) => event.type === "cache.checkpoint_hit"), "recovery must emit cache.checkpoint_hit");

    // Idempotency: a repeated recovery (checkpoint re-present, still no journal entry) must not
    // double-append the same patches.
    run.resumeJournal = new Map();
    await writeLaneCheckpoint(dir, "lane:edit", "result", {
      runId: run.id,
      callId: "lane:edit",
      signatureHash: entry.signatureHash,
      result: { patches: [{ path: "src/a.txt", content: "hello" }] },
      worktreePath: "/wt/lane-edit",
      capturedAt: new Date().toISOString(),
    });
    await runChildAgent(pluginContext, toolContext, run, payload, directDeps());
    assert.equal(run.editPlan.patches.length, 1, "repeated checkpoint-hit recovery must not double-append patches");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

// opencode-workflows-zi0f: a checkpoint-hit resume of an integration lane must restore the committed
// lane descriptor into run.integrationPlan.lanes (the git commit already happened before the
// checkpoint write, so recovery replays the descriptor without re-committing).
test("runChildAgent checkpoint-hit resume of an integration lane restores the committed lane descriptor", async () => {
  const { root, dir } = await tempRunDir("child-agent-checkpoint-integration");
  const calls = { create: [], prompt: [], abort: [] };
  const pluginContext = directPluginContext(async () => ({
    data: {
      parts: [{ type: "text", text: "first-result" }],
      info: { tokens: { input: 1, output: 1, reasoning: 0 }, cost: 0 },
    },
  }), calls);
  const toolContext = { directory: root, sessionID: "parent-session", abort: new AbortController().signal };
  const run = minimalChildRun(dir, { integrationPlan: { baseCommit: "base", lanes: [] } });
  const payload = { callId: "lane:integ", prompt: "do integration work", opts: {} };
  const laneDescriptor = {
    callId: "lane:integ",
    laneId: "lane-1234",
    path: "/wt/lane-integ",
    branch: "workflow/run/lane",
    commit: "abc123",
    committed: true,
    paths: ["src/b.txt"],
  };
  try {
    await runChildAgent(pluginContext, toolContext, run, payload, directDeps());
    const [entry] = (await readJournal(dir)).filter((record) => record.type === "agent" && record.callId === "lane:integ");
    assert.ok(entry?.signatureHash, "first lane run records the authoritative journal signature");

    run.resumeJournal = new Map();
    run.integrationPlan = { baseCommit: "base", lanes: [] };
    await writeLaneCheckpoint(dir, "lane:integ", "result", {
      runId: run.id,
      callId: "lane:integ",
      signatureHash: entry.signatureHash,
      result: "integration-result",
      worktreePath: "/wt/lane-integ",
      integrationLane: laneDescriptor,
      capturedAt: new Date().toISOString(),
    });

    await runChildAgent(pluginContext, toolContext, run, payload, directDeps());
    assert.deepEqual(run.integrationPlan.lanes, [laneDescriptor], "checkpoint-hit resume must restore the committed integration lane descriptor");

    // Idempotency: repeated recovery must not double-push the descriptor.
    run.resumeJournal = new Map();
    await writeLaneCheckpoint(dir, "lane:integ", "result", {
      runId: run.id,
      callId: "lane:integ",
      signatureHash: entry.signatureHash,
      result: "integration-result",
      worktreePath: "/wt/lane-integ",
      integrationLane: laneDescriptor,
      capturedAt: new Date().toISOString(),
    });
    await runChildAgent(pluginContext, toolContext, run, payload, directDeps());
    assert.equal(run.integrationPlan.lanes.length, 1, "repeated checkpoint-hit recovery must not double-push the lane descriptor");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("runChildAgent structured-text parse failure journals dirty salvage exactly once", async () => {
  const { root, dir } = await tempRunDir("child-agent-structured-salvage");
  const calls = { create: [], prompt: [], abort: [] };
  const pluginContext = directPluginContext(async () => ({
    data: {
      parts: [{ type: "text", text: "not json at all" }],
      info: { tokens: { input: 1, output: 1, reasoning: 0 }, cost: 0 },
    },
  }), calls);
  const toolContext = { directory: root, sessionID: "parent-session", abort: new AbortController().signal };
  // Design C: structured-text is the ONLY schema-lane path, even when the mock capabilities
  // advertise native support ("available") — the run must never send `format:` to session.prompt.
  const run = minimalChildRun(dir, { capabilities: { ...DEFAULT_CAPABILITIES, structuredOutput: "available" } });
  const salvageCalls = [];
  try {
    await assert.rejects(
      runChildAgent(pluginContext, toolContext, run, {
        callId: "lane:structured-failure",
        prompt: "return schema",
        opts: {
          schema: {
            type: "object",
            properties: { ok: { type: "boolean" } },
            required: ["ok"],
            additionalProperties: false,
	          },
	          retryCount: 0,
	          correctiveRetries: 0,
	        },
      }, directDeps({
        async dirtyWorktreeSalvage(worktreePath, extra) {
          salvageCalls.push({ worktreePath, extra });
          return {
            dirty: true,
            worktreePath: worktreePath ?? "/tmp/salvaged-lane",
            changedFileCount: 1,
            changedFiles: [{ path: "partial.txt", status: "M" }],
          };
        },
      })),
      /Unexpected token|not valid JSON/i,
    );

    assert.equal(calls.prompt.length, 1, "terminal structured parse failure must not retry");
    assert.ok(!("format" in calls.prompt[0].body), "structured-text path must never send format: to session.prompt");
    assert.equal(run.laneOutcomes.failure, 1, "failure should be recorded exactly once");
    assert.equal(salvageCalls.length, 1, "shared journalFailure path captures salvage exactly once");
    const lane = run.laneRecords.get("lane:structured-failure");
    assert.equal(lane?.salvage?.dirty, true);
    assert.deepEqual(lane.salvage.changedFiles.map((entry) => entry.path), ["partial.txt"]);
    const journalEntries = (await readJournal(dir)).filter((record) => record.type === "agent" && record.callId === "lane:structured-failure");
    assert.equal(journalEntries.length, 1, "structured failure must produce one authoritative journal entry");
    assert.equal(journalEntries[0].rawInvalidStructuredOutput, "not json at all");
    assert.equal(journalEntries[0].failureClass, "terminal");
    assert.equal(journalEntries[0].retryable, false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("runChildAgent structured schema-validation failure journals dirty salvage exactly once", async () => {
  const { root, dir } = await tempRunDir("child-agent-schema-salvage");
  const calls = { create: [], prompt: [], abort: [] };
  const pluginContext = directPluginContext(async () => ({
    data: {
      parts: [{ type: "text", text: JSON.stringify({ ok: "not-a-boolean" }) }],
      info: { tokens: { input: 1, output: 1, reasoning: 0 }, cost: 0 },
    },
  }), calls);
  const toolContext = { directory: root, sessionID: "parent-session", abort: new AbortController().signal };
  // Design C: structured-text is the ONLY schema-lane path, even when the mock capabilities
  // advertise native support ("available") — the run must never send `format:` to session.prompt.
  const run = minimalChildRun(dir, { capabilities: { ...DEFAULT_CAPABILITIES, structuredOutput: "available" } });
  const salvageCalls = [];
  try {
    await assert.rejects(
      runChildAgent(pluginContext, toolContext, run, {
        callId: "lane:schema-failure",
        prompt: "return schema",
        opts: {
          schema: {
            type: "object",
            properties: { ok: { type: "boolean" } },
            required: ["ok"],
            additionalProperties: false,
	          },
	          retryCount: 0,
	          correctiveRetries: 0,
	        },
      }, directDeps({
        async dirtyWorktreeSalvage(worktreePath, extra) {
          salvageCalls.push({ worktreePath, extra });
          return {
            dirty: true,
            worktreePath: worktreePath ?? "/tmp/salvaged-schema-lane",
            changedFileCount: 1,
            changedFiles: [{ path: "schema-partial.txt", status: "M" }],
          };
        },
      })),
      /did not match stored JSON schema|must be boolean|schema/i,
    );

    assert.equal(calls.prompt.length, 1, "terminal schema validation failure must not retry");
    assert.ok(!("format" in calls.prompt[0].body), "structured-text path must never send format: to session.prompt");
    assert.equal(run.laneOutcomes.failure, 1, "failure should be recorded exactly once");
    assert.equal(salvageCalls.length, 1, "schema failure uses the shared journalFailure salvage path once");
    const lane = run.laneRecords.get("lane:schema-failure");
    assert.equal(lane?.salvage?.dirty, true);
    assert.deepEqual(lane.salvage.changedFiles.map((entry) => entry.path), ["schema-partial.txt"]);
    const journalEntries = (await readJournal(dir)).filter((record) => record.type === "agent" && record.callId === "lane:schema-failure");
    assert.equal(journalEntries.length, 1);
    assert.equal(journalEntries[0].failureClass, "terminal");
    assert.equal(journalEntries[0].retryable, false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("runChildAgent corrective retry re-prompts the same child session and succeeds after schema failure", async () => {
  const { root, dir } = await tempRunDir("child-agent-corrective-success");
  const calls = { create: [], prompt: [], abort: [] };
  let promptCalls = 0;
  const pluginContext = directPluginContext(async () => {
    promptCalls += 1;
    const payload = promptCalls === 1 ? { ok: "not-a-boolean" } : { ok: true };
    return {
      data: {
        parts: [{ type: "text", text: JSON.stringify(payload) }],
        info: { tokens: { input: 1, output: 1, reasoning: 0 }, cost: 0.01 },
      },
    };
  }, calls);
  const toolContext = { directory: root, sessionID: "parent-session", abort: new AbortController().signal };
  // Design C: structured-text is the ONLY schema-lane path, even when the mock capabilities
  // advertise native support ("available") — the run must never send `format:` to session.prompt.
  const run = minimalChildRun(dir, { capabilities: { ...DEFAULT_CAPABILITIES, structuredOutput: "available" } });
  try {
    const result = await runChildAgent(pluginContext, toolContext, run, {
      callId: "lane:corrective-success",
      prompt: "return schema",
      opts: {
        schema: {
          type: "object",
          properties: { ok: { type: "boolean" } },
          required: ["ok"],
          additionalProperties: false,
        },
      },
    }, directDeps());

    assert.deepEqual(result, { ok: true });
    assert.equal(calls.create.length, 1, "corrective retry must reuse the original child session");
    assert.equal(calls.prompt.length, 2);
    assert.equal(calls.prompt[0].path.id, "child-1");
    assert.equal(calls.prompt[1].path.id, "child-1");
    assert.ok(!("format" in calls.prompt[0].body), "structured-text path must never send format: to session.prompt");
    assert.ok(!("format" in calls.prompt[1].body), "corrective retries must never send format: to session.prompt");
    assert.match(calls.prompt[1].body.parts[0].text, /previous response failed validation/i);
    assert.match(calls.prompt[1].body.parts[0].text, /ONLY a corrected JSON object/);
    assert.doesNotMatch(calls.prompt[1].body.parts[0].text, /not-a-boolean/);
    assert.equal(run.tokens.input, 2, "both prompt attempts accrue usage");
    assert.equal(run.tokens.output, 2, "both prompt attempts accrue usage");
    assert.ok(Math.abs(run.cost - 0.02) < 0.000001);

    const events = await readEvents(dir);
    assert.ok(events.some((event) => event.type === "agent.corrective_retry" && event.childID === "child-1"));
    const journalEntries = (await readJournal(dir)).filter((record) => record.type === "agent" && record.callId === "lane:corrective-success");
    assert.equal(journalEntries.length, 1, "corrective retry must preserve one authoritative journal record");
    assert.equal(journalEntries[0].outcome, "success");
    assert.equal(journalEntries[0].correctiveAttempts, 1);
    const lane = run.laneRecords.get("lane:corrective-success");
    assert.equal(lane?.correctiveAttempts, 1);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("runChildAgent corrective retry exhaustion records validation_exhausted as retryable", async () => {
  const { root, dir } = await tempRunDir("child-agent-corrective-exhausted");
  const calls = { create: [], prompt: [], abort: [] };
  const pluginContext = directPluginContext(async () => ({
    data: {
      parts: [{ type: "text", text: "not json at all" }],
      info: { tokens: { input: 1, output: 1, reasoning: 0 }, cost: 0.01 },
    },
  }), calls);
  const toolContext = { directory: root, sessionID: "parent-session", abort: new AbortController().signal };
  // Design C: structured-text is the ONLY schema-lane path, even when the mock capabilities
  // advertise native support ("available") — the run must never send `format:` to session.prompt.
  const run = minimalChildRun(dir, { capabilities: { ...DEFAULT_CAPABILITIES, structuredOutput: "available" } });
  try {
    await assert.rejects(
      runChildAgent(pluginContext, toolContext, run, {
        callId: "lane:corrective-exhausted",
        prompt: "return schema",
        opts: {
          schema: {
            type: "object",
            properties: { ok: { type: "boolean" } },
            required: ["ok"],
            additionalProperties: false,
          },
        },
      }, directDeps()),
      /Unexpected token|not valid JSON/i,
    );

    assert.equal(calls.create.length, 1, "corrective exhaustion stays in the same child session");
    assert.equal(calls.prompt.length, 2, "default correctiveRetries=1 gives one corrective turn");
    assert.equal(calls.prompt[0].path.id, "child-1");
    assert.equal(calls.prompt[1].path.id, "child-1");
    assert.ok(!("format" in calls.prompt[0].body), "structured-text path must never send format: to session.prompt");
    assert.ok(!("format" in calls.prompt[1].body), "corrective retries must never send format: to session.prompt");
    assert.equal(run.tokens.input, 2);
    assert.equal(run.tokens.output, 2);
    assert.equal(run.laneOutcomes.failure, 1);

    const journalEntries = (await readJournal(dir)).filter((record) => record.type === "agent" && record.callId === "lane:corrective-exhausted");
    assert.equal(journalEntries.length, 1, "exhaustion still produces one authoritative journal entry");
    assert.equal(journalEntries[0].failureClass, "validation_exhausted");
    assert.equal(journalEntries[0].retryable, true);
    assert.equal(journalEntries[0].correctiveAttempts, 1);
    assert.equal(journalEntries[0].rawInvalidStructuredOutput, "not json at all");
    const lane = run.laneRecords.get("lane:corrective-exhausted");
    assert.equal(lane?.failureClass, "validation_exhausted");
    assert.equal(lane?.retryable, true);
    assert.equal(lane?.correctiveAttempts, 1);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("runChildAgent retries a transient 429 with a backed-off delay then succeeds without failing the run", async () => {
  let attempts = 0;
  const prompt = async () => {
    attempts += 1;
    if (attempts === 1) {
      const error = new Error("429 Too Many Requests");
      error.status = 429;
      error.retryAfterMs = 80; // upstream Retry-After in ms; the backoff must honor it.
      throw error;
    }
    return { data: { parts: [{ type: "text", text: "recovered" }], info: { tokens: { input: 1, output: 1, reasoning: 0 }, cost: 0 } } };
  };
  const { tools, context, directory, calls } = await makeHarness(prompt);
  try {
    const source = `export const meta = { name: "retry-429", profile: "read-only-review", maxAgents: 1 };
return await agent("do transient work");`;

    const startedAt = Date.now();
    const output = await runApproved(tools, context, source);
    const elapsedMs = Date.now() - startedAt;

    // >1 attempt: the lane re-prompted after the simulated 429.
    assert.equal(calls.prompt.length, 2, "lane should have retried exactly once (2 attempts)");
    assert.match(output, /completed/, "the run must complete despite the transient failure");

    const status = JSON.parse(await tools.workflow_status.execute({ runId: runIdFrom(output), format: "json", detail: "full" }, context));
    const events = await readEvents(status.dir);
    const retry = events.find((event) => event.type === "agent.retry");
    assert.ok(retry, "an agent.retry event should record the backed-off retry");
    assert.equal(retry.failureClass, "transient");
    assert.equal(retry.delayMs, 80, "the backoff must honor the upstream Retry-After (80ms)");
    // Delay honored: the run waited at least most of the honored backoff before retrying.
    assert.ok(elapsedMs >= 60, `run should have waited out the backoff, elapsed=${elapsedMs}ms`);
    // The recovered lane is a clean success — no failure outcome recorded.
    assert.equal(status.laneOutcomes.success, 1);
    assert.equal(status.laneOutcomes.failure, 0);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

// opencode-workflows-dvww: when a lane retries, attempt 1's teardown sets the per-lane
// childAbortRequested guard to true against the OLD childID. Starting the fresh attempt-2 child
// session must reset that guard to false — otherwise every abortChild gate (this lane's
// prompt-timeout handler, sandbox-executor fanout-cancel / settlePendingHostOps, and
// lifecycle-control abortRunChildren behind interruptRun/killRun/timeout) reads the stale true and
// silently skips aborting the real, still-running attempt-2 child on cancel/kill/timeout, leaving it
// to keep running and accrue cost after the run was cancelled.
test("runChildAgent resets the per-lane childAbortRequested guard when a retry starts a fresh child", async () => {
  const { root, dir } = await tempRunDir("child-agent-retry-abort-guard");
  const calls = { create: [], prompt: [], abort: [] };
  const run = minimalChildRun(dir);
  let guardDuringAttempt2;
  let childIDDuringAttempt2;
  const pluginContext = directPluginContext(async (input) => {
    if (calls.prompt.length === 1) {
      // Attempt 1: a transient failure drives the retry teardown, which sets
      // activeLane.childAbortRequested = true and aborts this attempt's child.
      const error = new Error("503 Service Unavailable - overloaded");
      error.status = 503;
      error.retryAfterMs = 1; // tiny backoff so the retry is near-immediate.
      throw error;
    }
    // Attempt 2: a brand-new child session (child-2) is now running. Sample the guard exactly as the
    // real abort gates read it at this moment. Before the fix it is stuck true from attempt 1.
    const lane = run.activeLaneAbortControllers.get("lane:retry");
    guardDuringAttempt2 = lane?.childAbortRequested;
    childIDDuringAttempt2 = input.path?.id; // v1 session shape: { path: { id }, query, body }
    return {
      data: {
        parts: [{ type: "text", text: "attempt-2-result" }],
        info: { tokens: { input: 1, output: 1, reasoning: 0 }, cost: 0 },
      },
    };
  }, calls);
  const toolContext = { directory: root, sessionID: "parent-session", abort: new AbortController().signal };
  const payload = { callId: "lane:retry", prompt: "do transient work", opts: { retryCount: 1 } };
  try {
    assert.equal(await runChildAgent(pluginContext, toolContext, run, payload, directDeps()), "attempt-2-result");
    assert.equal(calls.prompt.length, 2, "the lane must have retried once (attempt 2 ran)");
    // The retry teardown aborted the ORIGINAL child (child-1)…
    assert.deepEqual(calls.abort.map((input) => input.path?.id), ["child-1"], "retry teardown aborts the stale attempt-1 child");
    // …and the fresh attempt-2 child is a distinct session…
    assert.equal(childIDDuringAttempt2, "child-2", "attempt 2 runs against a brand-new child session");
    // …whose abort guard was reset to false, so a later cancel/kill/timeout can actually abort it.
    assert.equal(guardDuringAttempt2, false, "childAbortRequested must be reset to false for the fresh attempt-2 child");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

// opencode-workflows-dx1n: the budget ceiling was enforced only per-wave. Up to `concurrency` lanes
// clear the acquireAgentSlot semaphore and each pass checkBudgetBeforeLaunch on stale (pre-spend)
// counters before any reports its session.prompt cost, so aggregate spend could overshoot maxCost by
// up to (concurrency-1) lanes. runChildAgent now reserves a conservative headroom slice synchronously
// before each attempt's prompt (folded into the ceiling comparison), so concurrent in-flight lanes
// consume the headroom and a would-be overshooting launch is gated; reservations reconcile to real
// spend on completion.
test("runChildAgent reserves in-flight lane budget so concurrent lanes cannot overshoot the ceiling", async () => {
  const { root, dir } = await tempRunDir("child-agent-budget-reservation");
  // All four lane prompts block on this gate so they sit in-flight (reservation held) simultaneously.
  let releasePrompts;
  const promptsGate = new Promise((resolve) => { releasePrompts = resolve; });
  let allEntered;
  const fourInFlight = new Promise((resolve) => { allEntered = resolve; });
  let promptsEntered = 0;
  const calls = { create: [], prompt: [], abort: [] };
  const pluginContext = directPluginContext(async () => {
    promptsEntered += 1;
    if (promptsEntered === 4) allEntered();
    await promptsGate;
    return { data: { parts: [{ type: "text", text: "ok" }], info: { tokens: { input: 10, output: 0, reasoning: 0 }, cost: 0.25 } } };
  }, calls);
  const toolContext = { directory: root, sessionID: "parent", abort: new AbortController().signal };
  // concurrency 4 against a maxCost of 1.0 — each lane really costs 0.25, so four lanes exactly
  // exhaust the ceiling and a fifth must be blocked, not allowed to overshoot.
  const run = minimalChildRun(dir, { concurrency: 4, maxAgents: 10, budgetCeilings: { maxCost: 1, maxTokens: 100 } });

  const lanes = [0, 1, 2, 3].map((i) =>
    runChildAgent(pluginContext, toolContext, run, { callId: `lane:${i}`, prompt: `work ${i}`, opts: {} }, directDeps()),
  );
  try {
    await fourInFlight; // every lane has reserved and is parked in its prompt await
    // The four in-flight reservations have consumed the entire headroom (no real cost has landed
    // yet), so a further launch attempt is budget-stopped instead of overshooting the ceiling.
    assert.equal(run.reservedLanes, 4, "all four in-flight lanes hold a reservation");
    assert.ok(run.reservedCost >= 1 - 1e-9, "reservations consumed the full cost headroom while lanes are in-flight");
    assert.throws(
      () => WorkflowPlugin.__test.checkBudgetBeforeLaunch(run),
      (error) => error?.code === "WORKFLOW_BUDGET_STOPPED",
      "a fifth concurrent launch must be gated by the in-flight reservations, not allowed to overshoot",
    );

    releasePrompts();
    const results = await Promise.all(lanes);
    assert.deepEqual(results, ["ok", "ok", "ok", "ok"], "all four lanes complete once released");
    // Reconciliation: every reservation released, real spend counted exactly once (4 * 0.25 = 1.0).
    assert.equal(run.reservedLanes, 0, "reservations reconciled on completion");
    assert.ok(Math.abs(run.reservedCost) < 1e-9, "reserved cost reconciles back to zero");
    assert.ok(Math.abs(run.reservedTokens) < 1e-9, "reserved tokens reconcile back to zero");
    assert.ok(Math.abs(run.cost - 1.0) < 1e-9, "real cost is the sum of the four lanes' actual spend");
    assert.equal(run.tokens.input, 40, "real token spend counted exactly once per lane");
  } finally {
    releasePrompts();
    await Promise.allSettled(lanes);
    await fs.rm(root, { recursive: true, force: true });
  }
});

// opencode-workflows-dx1n: a lane's own reservation must not trip its own retry-attempt budget check
// (the per-attempt reservation is released before the next attempt re-reserves), and a failed attempt
// that accrued no spend must reconcile its reservation back to zero.
test("runChildAgent reconciles the per-attempt reservation across a retry", async () => {
  const { root, dir } = await tempRunDir("child-agent-budget-retry-reserve");
  const calls = { create: [], prompt: [], abort: [] };
  const pluginContext = directPluginContext(async () => {
    if (calls.prompt.length === 1) {
      const error = new Error("503 Service Unavailable - overloaded");
      error.status = 503;
      error.retryAfterMs = 1;
      throw error;
    }
    return { data: { parts: [{ type: "text", text: "recovered" }], info: { tokens: { input: 5, output: 0, reasoning: 0 }, cost: 0.3 } } };
  }, calls);
  const toolContext = { directory: root, sessionID: "parent", abort: new AbortController().signal };
  const run = minimalChildRun(dir, { concurrency: 2, budgetCeilings: { maxCost: 1, maxTokens: 100 } });
  const payload = { callId: "lane:retry", prompt: "do transient work", opts: { retryCount: 1 } };
  try {
    assert.equal(await runChildAgent(pluginContext, toolContext, run, payload, directDeps()), "recovered");
    assert.equal(calls.prompt.length, 2, "the lane retried once");
    // The transient attempt-1 reservation was released (no spend), attempt-2 re-reserved and released
    // after real spend landed: reservations reconcile to zero and only the real 0.3 cost remains.
    assert.equal(run.reservedLanes, 0, "no reservation leaks across the retry");
    assert.ok(Math.abs(run.reservedCost) < 1e-9, "reserved cost reconciles to zero after retry");
    assert.ok(Math.abs(run.cost - 0.3) < 1e-9, "only the successful attempt's real cost is counted");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

// opencode-workflows-mnfx.2: a lane reporting tokens with cost=0 means the provider gave no per-lane
// pricing, so the maxCost ceiling cannot be trusted to bound the run. run.costTrackingUnreliable is
// sticky (set once, never cleared) and accrual-unaffected: a later priced lane keeps the flag set
// while its real cost still lands in run.cost.
test("costTrackingUnreliable: sticky when a lane reports tokens with cost=0; never resets", async () => {
  const { root, dir } = await tempRunDir("child-agent-cost-unreliable");
  const calls = { create: [], prompt: [], abort: [] };
  // Lane 1 reports tokens>0 with cost=0 (unpriced provider) → flag set. Lane 2 reports a real
  // cost of 0.25 → flag STAYS set and the real cost still accrues.
  let lane = 0;
  const pluginContext = directPluginContext(async () => {
    lane += 1;
    if (lane === 1) {
      return { data: { parts: [{ type: "text", text: "unpriced" }], info: { tokens: { input: 12, output: 3, reasoning: 0 }, cost: 0 } } };
    }
    return { data: { parts: [{ type: "text", text: "priced" }], info: { tokens: { input: 4, output: 1, reasoning: 0 }, cost: 0.25 } } };
  }, calls);
  const toolContext = { directory: root, sessionID: "parent", abort: new AbortController().signal };
  const run = minimalChildRun(dir, { concurrency: 1, maxAgents: 5, budgetCeilings: { maxCost: 2, maxTokens: 100 } });
  try {
    await runChildAgent(pluginContext, toolContext, run, { callId: "lane:unpriced", prompt: "work 1", opts: {} }, directDeps());
    assert.equal(run.costTrackingUnreliable, true, "an unpriced lane (tokens>0, cost=0) must set the sticky flag");
    assert.equal(run.cost, 0, "the unpriced lane contributed no cost");

    await runChildAgent(pluginContext, toolContext, run, { callId: "lane:priced", prompt: "work 2", opts: {} }, directDeps());
    assert.equal(run.costTrackingUnreliable, true, "the flag is sticky — a later priced lane must not clear it");
    assert.ok(Math.abs(run.cost - 0.25) < 1e-9, "real cost accrual is unaffected by the flag");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("runChildAgent aborts a child session that is created after the create timeout", async () => {
  const { tools, context, directory, calls } = await makeHarness(async () => ({ data: { parts: [{ type: "text", text: "never prompted" }], info: {} } }), {
    pluginContext: { __workflowChildCreateTimeoutMs: 10, __workflowChildAbortTimeoutMs: 20 },
    session(prompt, _options, sessionCalls) {
      return {
        async create(input) {
          sessionCalls.create.push(input);
          await sleep(40);
          return { data: { id: "late-child" } };
        },
        async prompt(input) {
          sessionCalls.prompt.push(input);
          return await prompt(input);
        },
        async abort(input) {
          sessionCalls.abort.push(input);
          return { data: { ok: true } };
        },
      };
    },
  });
  try {
    const source = `export const meta = { name: "late-create-cleanup", profile: "read-only-review", maxAgents: 1 };
return await agent("create too slowly");`;

    await assert.rejects(runApproved(tools, context, source), /Child session creation.*timed out/);
    await sleep(80);

    assert.equal(calls.create.length, 1);
    assert.equal(calls.prompt.length, 0, "prompt must not run after create timeout");
    assert.deepEqual(calls.abort.map((input) => input.path.id), ["late-child"]);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("runChildAgent fails a bad-model lane fast with a terminal classification visible in workflow_status", async () => {
  let attempts = 0;
  const prompt = async () => {
    attempts += 1;
    const error = new Error("model not found: bogus/model");
    error.status = 404;
    throw error;
  };
  const { tools, context, directory, calls } = await makeHarness(prompt);
  try {
    const source = `export const meta = { name: "bad-model", profile: "read-only-review", maxAgents: 1 };
return await agent("use a bad model", { model: "bogus/model" });`;

    await assert.rejects(runApproved(tools, context, source), /model not found/);

    // Fail fast: a terminal classification must NOT be retried.
    assert.equal(calls.prompt.length, 1, "a terminal bad-model lane must not be retried");
    assert.equal(attempts, 1);

    const statuses = JSON.parse(await tools.workflow_status.execute({ format: "json", detail: "compact", limit: 50 }, context));
    const failed = statuses.find((entry) => entry.meta?.name === "bad-model");
    assert.ok(failed, "the failed run should be listed");
    const status = JSON.parse(await tools.workflow_status.execute({ runId: failed.id, format: "json", detail: "full" }, context));
    assert.equal(status.status, "failed");
    assert.equal(status.laneOutcomes.failure, 1);
    const laneRecords = Array.isArray(status.laneRecords) ? status.laneRecords : [];
    const lane = laneRecords.find((record) => record.outcome === "failure");
    assert.ok(lane, "the failed lane should be recorded");
    assert.equal(lane.failureClass, "terminal", "the bad-model failure must be classified terminal in status");
    assert.equal(lane.retryable, false, "a terminal lane is not retryable");
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("runChildAgent records structured-text fallback parse failure details as terminal", async () => {
  const prompt = async () => ({
    data: {
      parts: [{ type: "text", text: "not json at all" }],
      info: { tokens: { input: 1, output: 1, reasoning: 0 }, cost: 0 },
    },
  });
  // Design C: structured-text is the ONLY schema-lane path, even when the mock capabilities
  // advertise native support ("available") — the run must never send `format:` to session.prompt.
  const { tools, context, directory, calls } = await makeHarness(prompt, {
    capabilities: { ...DEFAULT_CAPABILITIES, structuredOutput: "available" },
  });
  try {
    const source = `export const meta = { name: "structured-text-terminal", profile: "read-only-review", maxAgents: 1 };
return await agent("return schema", {
  schema: {
    type: "object",
    properties: { ok: { type: "boolean" } },
    required: ["ok"],
    additionalProperties: false
	  },
	  retryCount: 1,
	  correctiveRetries: 0
	});`;

    await assert.rejects(runApproved(tools, context, source), /Unexpected token|not valid JSON/i);

    assert.equal(calls.prompt.length, 1, "malformed structured-text output must not be retried");
    assert.ok(!("format" in calls.prompt[0].body), "structured-text path must never send format: to session.prompt");
    const statuses = JSON.parse(await tools.workflow_status.execute({ format: "json", detail: "compact", limit: 50 }, context));
    const failed = statuses.find((entry) => entry.meta?.name === "structured-text-terminal");
    assert.ok(failed, "the failed structured-text run should be listed");
    const status = JSON.parse(await tools.workflow_status.execute({ runId: failed.id, format: "json", detail: "full" }, context));
    const lane = (status.laneRecords ?? []).find((record) => record.outcome === "failure");
    assert.ok(lane, "the failed lane should be recorded");
    assert.equal(lane.failureClass, "terminal");
    assert.equal(lane.retryable, false);
    assert.match(lane.errorSummary, /Unexpected token|not valid JSON/i);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("runChildAgent records a transient failure that exhausts its retries as transient_exhausted (distinct from terminal)", async () => {
  const prompt = async () => {
    const error = new Error("503 Service Unavailable - overloaded");
    error.status = 503;
    error.retryAfterMs = 5; // tiny so the test stays fast across both attempts.
    throw error;
  };
  const { tools, context, directory, calls } = await makeHarness(prompt);
  try {
    // retryCount:1 (the default) => 2 attempts total, both 503 => transient retries exhausted.
    const source = `export const meta = { name: "transient-exhausted", profile: "read-only-review", maxAgents: 1 };
return await agent("persistently overloaded", { retryCount: 1 });`;

    await assert.rejects(runApproved(tools, context, source), /Service Unavailable|overloaded|503/);
    assert.equal(calls.prompt.length, 2, "should have used both attempts (1 retry) before giving up");

    const statuses = JSON.parse(await tools.workflow_status.execute({ format: "json", detail: "compact", limit: 50 }, context));
    const entry = statuses.find((item) => item.meta?.name === "transient-exhausted");
    const status = JSON.parse(await tools.workflow_status.execute({ runId: entry.id, format: "json", detail: "full" }, context));
    const lane = (status.laneRecords ?? []).find((record) => record.outcome === "failure");
    assert.ok(lane);
    assert.equal(lane.failureClass, "transient_exhausted", "an exhausted transient lane is distinct from terminal");
    assert.equal(lane.retryable, true, "a transient-class failure stays retryable for a later resume");
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("sessionDirectoryEchoStatus verifies the typed create echo", () => {
  assert.equal(sessionDirectoryEchoStatus({ data: { id: "s", directory: "/tmp/lane-a" } }, "/tmp/lane-a").state, "verified");
  assert.equal(sessionDirectoryEchoStatus({ data: { id: "s", directory: "/tmp/other" } }, "/tmp/lane-a").state, "mismatch");
  assert.equal(sessionDirectoryEchoStatus({ data: { id: "s" } }, "/tmp/lane-a").state, "not-echoed");
});

test("sessionDirectoryEchoStatus tolerates symlink-realpath divergence", async (t) => {
  // The plugin repo itself is reached via a symlinked config dir in production;
  // the server may echo the realpath of the directory it was given.
  const real = await fs.mkdtemp(path.join(os.tmpdir(), "echo-real-"));
  const link = `${real}-link`;
  await fs.symlink(real, link);
  t.after(() => fs.rm(real, { recursive: true, force: true }).then(() => fs.rm(link, { force: true })));
  assert.equal(sessionDirectoryEchoStatus({ data: { id: "s", directory: real } }, link).state, "verified");
});

test("createEditWorktree throws when the adapter's worktree path resolves to the primary directory", async () => {
  const { root, dir } = await tempRunDir("child-agent-worktree-distinctness");
  try {
    const run = minimalChildRun(dir, {
      adapter: {
        async createWorktree() {
          return { path: root };
        },
      },
    });
    const toolContext = { directory: root, sessionID: "parent-session" };
    await assert.rejects(
      createEditWorktree(run, toolContext, "lane:edit"),
      /worktree path resolves to the primary tree/,
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("createEditWorktree rejects a symlink alias that physically resolves to the primary tree", async (t) => {
  // fnop.1: path.resolve sees the distinct lexical alias; only realpath resolves the symlink
  // back to the primary checkout. The isolation boundary must compare physical locations.
  const { root, dir } = await tempRunDir("child-agent-worktree-symlink-alias");
  const alias = path.join(dir, "primary-alias");
  await fs.symlink(root, alias);
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const run = minimalChildRun(dir, {
    adapter: {
      async createWorktree() {
        return { path: alias };
      },
    },
  });
  const toolContext = { directory: root, sessionID: "parent-session" };
  await assert.rejects(
    createEditWorktree(run, toolContext, "lane:edit"),
    /worktree path resolves to the primary tree/,
  );
});

test("laneAuthorityInstruction renders grants and denials from authority flags", () => {
  assert.equal(
    laneAuthorityInstruction({ readOnly: true }),
    "Lane authority: read/search only. Not permitted: edit, shell, network, mcp — such tool calls are denied by policy; do not retry them.",
  );
  assert.match(
    laneAuthorityInstruction({ edit: true, shell: true, network: true, mcp: true, integration: true }),
    /read\/search plus edit, shell, network, mcp, integration/,
  );
  assert.match(laneAuthorityInstruction({ worktreeEdit: true }), /worktree edit \(isolated worktree only\)/);
  assert.match(laneAuthorityInstruction(undefined), /read\/search only/);
  // Non-edit lanes have integration stripped from their enforced permissions, so it must not
  // be advertised as a grant (default drain-autonomous-local lane shape).
  assert.equal(
    laneAuthorityInstruction({ readOnly: true, integration: true }),
    "Lane authority: read/search only. Not permitted: edit, shell, network, mcp — such tool calls are denied by policy; do not retry them.",
  );
});

test("child lane system prompt discloses the lane's resolved authority ceiling", async () => {
  const { root, dir } = await tempRunDir("child-agent-authority-line");
  const calls = { create: [], prompt: [], abort: [] };
  const pluginContext = directPluginContext(async () => ({
    data: {
      parts: [{ type: "text", text: "ok" }],
      info: { tokens: { input: 1, output: 1, reasoning: 0 }, cost: 0 },
    },
  }), calls);
  const toolContext = { directory: root, sessionID: "parent-session", abort: new AbortController().signal };
  const run = minimalChildRun(dir);
  try {
    await runChildAgent(pluginContext, toolContext, run, {
      callId: "lane:authority-line",
      prompt: "inspect",
      opts: {},
    }, directDeps());
    assert.match(calls.prompt[0].body.system, /Lane authority: read\/search only\./);
    assert.match(calls.prompt[0].body.system, /Not permitted: edit, shell, network, mcp/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
