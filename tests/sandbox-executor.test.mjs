import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import WorkflowPlugin from "../workflow-kernel/index.js";

// Direct unit coverage for workflow-kernel/sandbox-executor.js. The module exports only
// executeSandbox (the QuickJS sandbox lifecycle + host bridge) and runNestedWorkflow (the
// host "workflow" op dispatcher); the smaller drain host helpers live as private functions
// and are intentionally not exported (see report). We exercise executeSandbox against tiny
// inline workflow bodies through the real QuickJS VM — which is deterministic and needs no
// network or child sessions — plus runNestedWorkflow's pure guard paths.
const {
  executeSandbox,
  drainGateStatus,
  newSandboxContext,
  persistRunArtifacts,
  quickJSAsyncModule,
  runNestedWorkflow,
  MAX_HOST_CALLS,
  MAX_PENDING_JOB_DRAIN_ITERATIONS,
  DEFAULT_GUEST_DEADLINE_MS,
  maxHostCallsForRun,
  __setSandboxHostOpTestHook,
  hash,
} = WorkflowPlugin.__test;

// executeSandbox only touches `run` for the host ops these tests use (noop/budget) plus the
// top-level counters; noop/budget/runtime-error paths never call appendEvent/writeState, so no
// run directory is required. pluginContext/toolContext/deps are unused by those op branches.
function minimalRun(overrides = {}) {
  return {
    id: "sandbox-executor-test",
    sourcePath: "<sandbox-executor-test>",
    hostCalls: 0,
    tokens: { input: 7, output: 5, reasoning: 1 },
    cost: 0.12,
    replayedTokens: { input: 3, output: 0, reasoning: 0 },
    replayedCost: 0.04,
    budgetCeilings: {},
    maxAgents: 8,
    agentsStarted: 2,
    ...overrides,
  };
}

const NO_CTX = {};
const NO_DEPS = {};

// --- executeSandbox: return-value round-trip and arg injection ----------------------------

test("executeSandbox returns the workflow body's return value through the QuickJS boundary", async () => {
  const out = await executeSandbox(NO_CTX, NO_CTX, minimalRun(), "return { a: 1, b: [2, 3], c: 'x' };", null, NO_DEPS);
  assert.deepEqual(out, { a: 1, b: [2, 3], c: "x" });
});

test("executeSandbox injects runtime args as globalThis.args (null when omitted)", async () => {
  assert.deepEqual(await executeSandbox(NO_CTX, NO_CTX, minimalRun(), "return args;", { role: "research" }, NO_DEPS), { role: "research" });
  assert.equal(await executeSandbox(NO_CTX, NO_CTX, minimalRun(), "return args;", null, NO_DEPS), null);
});

// --- host-op dispatch: noop and budget ----------------------------------------------------

test('the "noop" host op resolves to null and is counted by the shared host-call meter', async () => {
  const run = minimalRun();
  const out = await executeSandbox(NO_CTX, NO_CTX, run, 'const r = await __host("noop", {}); return r;', null, NO_DEPS);
  assert.equal(out, null);
  // Two host calls: the prelude itself ends with `await __host("noop", {})` and then the body
  // issues its own noop. Both are metered through the same run.hostCalls counter.
  assert.equal(run.hostCalls, 2);
});

test('the "budget" host op returns the live+replayed combined token snapshot (pure read)', async () => {
  // budget.spent() -> (await __host("budget", {})).total.tokens, which is addTokens(tokens, replayedTokens).
  const run = minimalRun();
  const out = await executeSandbox(NO_CTX, NO_CTX, run, "return await budget.spent();", null, NO_DEPS);
  assert.deepEqual(out, { input: 10, output: 5, reasoning: 1 });
});

test('the "budget" API exposes ceilings and remaining headroom with null unset semantics', async () => {
  const run = minimalRun({
    cost: 1,
    replayedCost: 2,
    budgetCeilings: { maxCost: 10, maxTokens: 20 },
    reservedCost: 3,
    reservedTokens: 3,
  });
  const out = await executeSandbox(NO_CTX, NO_CTX, run, `return {
    ceilings: await budget.ceilings(),
    remaining: await budget.remaining(),
  };`, null, NO_DEPS);

  assert.deepEqual(out.ceilings, { maxCost: 10, maxTokens: 20 });
  assert.deepEqual(out.remaining, { cost: 4, tokens: 1 });

  const unset = await executeSandbox(NO_CTX, NO_CTX, minimalRun(), "return await budget.remaining();", null, NO_DEPS);
  assert.deepEqual(unset, { cost: null, tokens: null });
});

test("executeSandbox rejects host operations that are started but not awaited", async () => {
  const run = minimalRun({ hostCalls: 0, activeLaneAbortControllers: new Map(), waitingAgents: [] });
  __setSandboxHostOpTestHook(async ({ op, run: hookRun }) => {
    if (op === "noop" && hookRun.hostCalls === 2) await sleep(50);
  });
  try {
    await assert.rejects(
      executeSandbox(
        { __workflowPendingHostOpSettleTimeoutMs: 200 },
        NO_CTX,
        run,
        '__host("noop", {}); return "done";',
        null,
        NO_DEPS,
      ),
      /host operation.*must be awaited/i,
    );
  } finally {
    __setSandboxHostOpTestHook(undefined);
  }
});

test("executeSandbox records structured diagnostics for dropped fanout failures", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "workflow-fanout-diagnostics-"));
  try {
    const run = minimalRun({ dir, droppedLaneCount: 0, diagnostics: {}, cancelledFanoutScopes: new Set() });
    const output = await executeSandbox(
      NO_CTX,
      NO_CTX,
      run,
      'const result = await parallel([async () => { throw new Error("fanout secret-token failure detail"); }], { sequential: true }); return result;',
      null,
      NO_DEPS,
    );

    assert.deepEqual(output, [null]);
    assert.equal(run.droppedLaneCount, 1);
    assert.equal(run.diagnostics.fanoutDroppedFailures.length, 1);
    assert.equal(run.diagnostics.fanoutDroppedFailures[0].scope, "root/parallel:0/item:0");
    assert.match(run.diagnostics.fanoutDroppedFailures[0].errorSummary, /fanout secret-token failure detail/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("executeSandbox hard-errors zero-arg parallel callbacks unless sequential is explicit", async () => {
  await assert.rejects(
    executeSandbox(NO_CTX, NO_CTX, minimalRun(), 'return await parallel([async () => "x"]);', null, NO_DEPS),
    /parallel\(\) requires every callback.*index 0.*Default\/rest parameters.*sequential: true/s,
  );
});

test("executeSandbox allows explicit sequential zero-arg parallel callbacks", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "workflow-sequential-fanout-"));
  try {
    const run = minimalRun({ dir, eventCount: 0 });
    const out = await executeSandbox(
      NO_CTX,
      NO_CTX,
      run,
      'return await parallel([async () => "a", async () => "b"], { sequential: true });',
      null,
      NO_DEPS,
    );
    assert.deepEqual(out, ["a", "b"]);
    const events = await fs.readFile(path.join(dir, "events.jsonl"), "utf8");
    assert.match(events, /"type":"fanout\.sequential"/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("executeSandbox hard-errors zero-arg pipeline stages unless sequential is explicit", async () => {
  await assert.rejects(
    executeSandbox(NO_CTX, NO_CTX, minimalRun(), 'return await pipeline(["x"], async () => "y");', null, NO_DEPS),
    /pipeline\(\) requires every callback.*index 0.*Default\/rest parameters.*sequential: true/s,
  );
});

test("inventoryFiles applies precompiled literal and glob excludes", async () => {
  const project = await fs.mkdtemp(path.join(os.tmpdir(), "workflow-inventory-excludes-"));
  try {
    await fs.mkdir(path.join(project, "src"), { recursive: true });
    await fs.mkdir(path.join(project, "fixtures"), { recursive: true });
    await fs.writeFile(path.join(project, "src", "app.js"), "export const ok = true;\n", "utf8");
    await fs.writeFile(path.join(project, "src", "app.test.js"), "export const test = true;\n", "utf8");
    await fs.writeFile(path.join(project, "fixtures", "fixture.js"), "export const fixture = true;\n", "utf8");
    const runDir = path.join(project, ".run");
    await fs.mkdir(runDir, { recursive: true });

    const out = await executeSandbox(
      NO_CTX,
      { directory: project, worktree: project },
      minimalRun({ dir: runDir, eventCount: 0 }),
      'return await inventoryFiles({ paths: ["."], exclude: ["fixtures", "*.test.js"], shardSize: 10 });',
      null,
      NO_DEPS,
    );

    assert.equal(out.ok, true);
    assert.deepEqual(out.manifest.exclude, ["fixtures", "*.test.js"]);
    assert.deepEqual(out.shards.flatMap((shard) => shard.paths), ["src/app.js"]);
  } finally {
    await fs.rm(project, { recursive: true, force: true });
  }
});

test("drainGateStatus maps workflowCompletionNotification to the canonical probe flag", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "workflow-gate-map-"));
  const promptAsyncCalls = [];
  try {
    const status = await drainGateStatus(
      {
        client: {
          session: {
            async promptAsync(input) {
              promptAsyncCalls.push(input);
              return { data: { ok: true } };
            },
          },
        },
      },
      { sessionID: "parent-session", directory, worktree: directory, agent: "build" },
      { probeRequired: true, requiredGates: ["workflowCompletionNotification"] },
    );

    assert.equal(promptAsyncCalls.length, 1);
    assert.equal(status.workflowCompletionNotification.verified, true);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("persistRunArtifacts returns validation failures from the real artifact writer", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "workflow-artifact-validation-"));
  try {
    const run = minimalRun({ dir, eventCount: 0 });

    assert.deepEqual(
      await persistRunArtifacts({}, run, { namespace: "review", files: [] }),
      { ok: false, error: "persistArtifacts requires a non-empty files array", dir: null, files: [] },
    );

    const missing = await persistRunArtifacts({}, run, { namespace: "review", files: [{ content: "x" }] });
    assert.equal(missing.ok, false);
    assert.equal(missing.error, "artifact missing name");

    const unsafe = await persistRunArtifacts({}, run, { namespace: "review", files: [{ name: ".bad.md", content: "x" }] });
    assert.equal(unsafe.ok, false);
    assert.match(unsafe.error, /artifact name rejected/);

    const extension = await persistRunArtifacts({}, run, { namespace: "review", files: [{ name: "bad.txt", content: "x" }] });
    assert.equal(extension.ok, false);
    assert.match(extension.error, /must end in \.json\/\.jsonl\/\.md/);

    const unicode = await persistRunArtifacts({}, run, { namespace: "review", files: [{ name: "unicode.md", content: "é😀" }] });
    assert.equal(unicode.ok, true);
    assert.equal(unicode.files[0].bytes, Buffer.byteLength("é😀", "utf8"));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("persistRunArtifacts returns mkdir and per-file write failures from the real artifact writer", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "workflow-artifact-write-"));
  try {
    const fileRunDir = path.join(dir, "run-file");
    await fs.writeFile(fileRunDir, "not a directory", "utf8");
    const mkdirFailure = await persistRunArtifacts({}, minimalRun({ dir: fileRunDir }), {
      namespace: "review",
      files: [{ name: "ok.md", content: "x" }],
    });
    assert.equal(mkdirFailure.ok, false);
    assert.match(mkdirFailure.error, /artifact root mkdir failed/);

    const runDir = path.join(dir, "run-dir");
    const targetRoot = path.join(runDir, "artifacts", "review");
    await fs.mkdir(path.join(targetRoot, "blocked.md"), { recursive: true });
    const writeFailure = await persistRunArtifacts({}, minimalRun({ dir: runDir, eventCount: 0 }), {
      namespace: "review",
      files: [{ name: "blocked.md", content: "x" }],
    });
    assert.equal(writeFailure.ok, false);
    assert.match(writeFailure.error, /artifact write failed for blocked\.md/);
    assert.equal(writeFailure.dir, targetRoot);
    assert.deepEqual(writeFailure.files, []);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// --- host-op dispatch error handling -----------------------------------------------------

test("executeSandbox rejects an unsupported host operation via the dispatch fallback", async () => {
  // The body reaches the host bridge directly with an op the dispatch table has no branch for.
  await assert.rejects(
    executeSandbox(NO_CTX, NO_CTX, minimalRun(), 'await __host("bogusOp", {}); return 1;', null, NO_DEPS),
    /Unsupported workflow host operation: bogusOp/,
  );
});

test("executeSandbox accepts explicit workflow object form at the runtime boundary", async () => {
  await assert.rejects(
    executeSandbox(
      NO_CTX,
      NO_CTX,
      minimalRun({ nestedSnapshots: new Map(), nestingDepth: 0 }),
      'return await workflow({ source: "return 1;", args: { ok: true } });',
      null,
      NO_DEPS,
    ),
    /Nested workflow was not part of approved static snapshot: <inline>/,
  );
});

// --- Host-call and pending-job boundaries -------------------------------------------------

test("pending job drain keeps the historical fixed iteration limit", () => {
  assert.equal(MAX_PENDING_JOB_DRAIN_ITERATIONS, 10000);
  assert.equal(MAX_PENDING_JOB_DRAIN_ITERATIONS, MAX_HOST_CALLS);
});

test("maxHostCallsForRun keeps the historical floor and scales for wide maxAgents", () => {
  assert.ok(Number.isInteger(MAX_HOST_CALLS) && MAX_HOST_CALLS > 0);
  assert.equal(maxHostCallsForRun(minimalRun({ maxAgents: 8 })), MAX_HOST_CALLS);
  assert.equal(maxHostCallsForRun(minimalRun({ maxAgents: MAX_HOST_CALLS + 5000 })), MAX_HOST_CALLS + 6000);
});

test("scaled host-op ceiling permits approved wide fan-out past the old fixed wall", async () => {
  const run = minimalRun({ maxAgents: MAX_HOST_CALLS + 5000, hostCalls: MAX_HOST_CALLS });
  const out = await executeSandbox(NO_CTX, NO_CTX, run, "return 'ok';", null, NO_DEPS);
  assert.equal(out, "ok");
  assert.equal(run.hostCalls, MAX_HOST_CALLS + 1);
});

test("scaled host-op ceiling rejects the first call that would exceed the computed cap", async () => {
  // The host bridge increments run.hostCalls BEFORE dispatching and throws when it exceeds the
  // computed per-run cap. Even the prelude's own noop pushes cap -> cap+1, so the body rejects.
  const run = minimalRun({ maxAgents: MAX_HOST_CALLS + 5000 });
  const cap = maxHostCallsForRun(run);
  await assert.rejects(
    executeSandbox(NO_CTX, NO_CTX, { ...run, hostCalls: cap }, "return 1;", null, NO_DEPS),
    new RegExp(`exceeded max host calls \\(${cap}\\)`),
  );
});

test("scaled host-op ceiling permits a call that lands exactly on the computed cap", async () => {
  // MAX-1 + the single prelude noop = MAX, which is NOT > MAX, so the run succeeds.
  const run = minimalRun({ maxAgents: MAX_HOST_CALLS + 5000 });
  const cap = maxHostCallsForRun(run);
  run.hostCalls = cap - 1;
  const out = await executeSandbox(NO_CTX, NO_CTX, run, "return 'ok';", null, NO_DEPS);
  assert.equal(out, "ok");
  assert.equal(run.hostCalls, cap);
});

// --- runtime error capture (the body try/catch -> __workflowRuntimeError unwrap) ----------

test("executeSandbox re-throws a body Error with its message intact across the dump boundary", async () => {
  await assert.rejects(
    executeSandbox(NO_CTX, NO_CTX, minimalRun(), 'throw new Error("boom");', null, NO_DEPS),
    (error) => error instanceof Error && error.message === "boom",
  );
});

test("executeSandbox captures a non-Error thrown value as the runtime error message", async () => {
  await assert.rejects(
    executeSandbox(NO_CTX, NO_CTX, minimalRun(), 'throw "string err";', null, NO_DEPS),
    (error) => error instanceof Error && error.message === "string err",
  );
});

// --- determinism prelude (Date / Math.random disabled) -----------------------------------

test("the determinism prelude disables Date, Date.now, and Math.random in the guest", async () => {
  await assert.rejects(
    executeSandbox(NO_CTX, NO_CTX, minimalRun(), "return new Date();", null, NO_DEPS),
    /Date is disabled in deterministic workflows/,
  );
  await assert.rejects(
    executeSandbox(NO_CTX, NO_CTX, minimalRun(), "return Date.now();", null, NO_DEPS),
    /Date\.now is disabled in deterministic workflows/,
  );
  await assert.rejects(
    executeSandbox(NO_CTX, NO_CTX, minimalRun(), "return Math.random();", null, NO_DEPS),
    /Math\.random is disabled in deterministic workflows/,
  );
});

// --- guest deadline arming ----------------------------------------------------------------

test("a runaway synchronous guest loop is interrupted by the re-armed guest deadline", async () => {
  // shouldInterruptAfterDeadline is armed before each guest burst; with a tiny deadline an
  // infinite synchronous loop must be broken (reject) rather than hang the run. The default
  // deadline is a real, finite guard rather than an unbounded wall clock.
  assert.ok(DEFAULT_GUEST_DEADLINE_MS > 0);
  await assert.rejects(
    executeSandbox(NO_CTX, NO_CTX, minimalRun({ guestDeadlineMs: 15 }), "while (true) {}", null, NO_DEPS),
    /interrupted/i,
  );
});

test("executeSandbox reuses the async QuickJS module and disposes context plus runtime", async (t) => {
  const module = await quickJSAsyncModule();
  assert.equal(await quickJSAsyncModule(), module, "QuickJS async WASM module must be memoized");

  let seenContext;
  let seenRuntime;
  const originalNewRuntime = module.newRuntime.bind(module);
  t.mock.method(module, "newRuntime", (...runtimeArgs) => {
    const runtime = originalNewRuntime(...runtimeArgs);
    seenRuntime = runtime;
    const originalRuntimeNewContext = runtime.newContext.bind(runtime);
    t.mock.method(runtime, "newContext", (...contextArgs) => {
      const context = originalRuntimeNewContext(...contextArgs);
      seenContext = context;
      return context;
    });
    return runtime;
  });

  const out = await executeSandbox(NO_CTX, NO_CTX, minimalRun(), "return 'disposed';", null, NO_DEPS);

  assert.equal(out, "disposed");
  assert.equal(seenContext?.alive, false, "QuickJS context must be disposed after execution");
  assert.equal(seenRuntime?.alive, false, "QuickJS runtime must be disposed after execution");

  const manual = await newSandboxContext();
  const manualRuntime = manual.runtime;
  assert.equal(manualRuntime.alive, true);
  try {
    manual.dispose();
  } finally {
    if (manualRuntime.alive) manualRuntime.dispose();
  }
});

// --- runNestedWorkflow guard paths (pure; no pluginContext/toolContext/deps needed) -------

function nestedRun(overrides = {}) {
  return { nestingDepth: 0, nestedSnapshots: new Map(), ...overrides };
}

test("runNestedWorkflow rejects recursion beyond one nesting level", async () => {
  await assert.rejects(
    runNestedWorkflow(NO_CTX, NO_CTX, nestedRun({ nestingDepth: 1 }), {}, NO_DEPS),
    /Nested workflow recursion is rejected; only one nesting level is supported/,
  );
});

test("runNestedWorkflow requires a static name or source", async () => {
  await assert.rejects(
    runNestedWorkflow(NO_CTX, NO_CTX, nestedRun(), {}, NO_DEPS),
    /Nested workflow\(\) requires a static workflow name or source/,
  );
  // An empty source string is falsy and therefore falls through to a missing name.
  await assert.rejects(
    runNestedWorkflow(NO_CTX, NO_CTX, nestedRun(), { source: "" }, NO_DEPS),
    /Nested workflow\(\) requires a static workflow name or source/,
  );
});

test("runNestedWorkflow rejects an inline source absent from the approved static snapshots", async () => {
  const source = "return 1;";
  await assert.rejects(
    runNestedWorkflow(NO_CTX, NO_CTX, nestedRun(), { source }, NO_DEPS),
    /Nested workflow was not part of approved static snapshot: <inline>/,
  );
});

test("runNestedWorkflow rejects an inline source whose hash changed after approval", async () => {
  const source = "return 1;";
  const sourceHash = hash(source);
  const snapshots = new Map([[sourceHash, { sourceHash: "different-than-current" }]]);
  await assert.rejects(
    runNestedWorkflow(NO_CTX, NO_CTX, nestedRun({ nestedSnapshots: snapshots }), { source }, NO_DEPS),
    /Nested workflow source changed after approval: <inline>/,
  );
});
