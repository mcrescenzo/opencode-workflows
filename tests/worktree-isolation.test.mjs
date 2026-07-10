import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { setTimeout as sleep } from "node:timers/promises";

import { createWorktreeAdapter } from "../workflow-kernel/worktree-adapter.js";
import { createEditWorktree, createIntegrationLaneWorktree } from "../workflow-kernel/child-agent-runner.js";
import { DEFAULT_CAPABILITIES } from "./helpers/harness.mjs";

// Worktree-isolation regression coverage, grouped by owning behavior: the concurrent git worktree
// creation mutex (worktree-adapter.js), the integration-lane lazy-init memoization
// (child-agent-runner.js's createIntegrationLaneWorktree), and the edit-worktree primary-tree
// distinctness enforcement (child-agent-runner.js's createEditWorktree). These scenarios were
// previously spread across child-agent-runner.test.mjs and bughunt-concurrency.test.mjs.

const execFileAsync = promisify(execFile);

async function initRepo(prefix) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  await execFileAsync("git", ["init"], { cwd: directory });
  await execFileAsync("git", ["config", "user.email", "workflow-test@example.com"], { cwd: directory });
  await execFileAsync("git", ["config", "user.name", "Workflow Test"], { cwd: directory });
  await fs.writeFile(path.join(directory, "README.md"), "initial\n", "utf8");
  await execFileAsync("git", ["add", "README.md"], { cwd: directory });
  await execFileAsync("git", ["commit", "-m", "initial"], { cwd: directory });
  return directory;
}

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

// --- concurrency-1: worktree-adapter.js createManagedWorktree/remove() mutex ----------------
// Guards against concurrent `git worktree add` invocations racing inside git's own
// `.git/worktrees/` bookkeeping. We can't intercept the raw `git worktree add` subprocess call
// itself (git-util.js captures node:child_process's execFile into a promisified closure at
// module load, so it isn't mockable from outside), so we intercept fs.mkdir -- the last async
// step inside createRawWorktree immediately before the git call -- as an entry/exit counter for
// "a createRawWorktree invocation is in flight", per the suggested test shape.

test("createLaneWorktree serializes concurrent git worktree add calls through a per-adapter mutex (concurrency-1)", async (t) => {
  const directory = await initRepo("bughunt-concurrency-wt-");
  const worktreeRoot = path.join(path.dirname(directory), `${path.basename(directory)}.worktrees-lock`);
  try {
    const adapter = await createWorktreeAdapter({ directory, worktreeRoot });

    let inFlight = 0;
    let maxInFlight = 0;
    const originalMkdir = fs.mkdir;
    t.mock.method(fs, "mkdir", async (dirPath, ...rest) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      // Hold the "in-flight" window open long enough that a second, unserialized
      // createRawWorktree() call reliably overlaps this one if the mutex isn't applied.
      await sleep(25);
      try {
        return await originalMkdir(dirPath, ...rest);
      } finally {
        inFlight -= 1;
      }
    });

    const laneIds = ["lane-one", "lane-two", "lane-three"];
    const created = await Promise.all(laneIds.map((laneId) => adapter.createLaneWorktree({ runId: "run", laneId })));

    assert.equal(created.length, 3);
    assert.equal(maxInFlight, 1, "concurrent createLaneWorktree calls must never overlap the raw git worktree add region");
  } finally {
    await fs.rm(worktreeRoot, { recursive: true, force: true }).catch(() => {});
    await fs.rm(directory, { recursive: true, force: true }).catch(() => {});
  }
});

// --- concurrency-3: child-agent-runner.js createIntegrationLaneWorktree lazy-init -----------
// Two lanes racing into the `if (!run.worktreeAdapter)` lazy-init both see the check as true
// synchronously (before either await lands), so an unguarded fix would run createWorktreeAdapter()
// twice. We prove the memoized fix collapses this into a single construction by counting
// fs.realpath calls (a proxy for "one createWorktreeAdapter() construction ran": requireGitRepo
// and createWorktreeAdapter's own worktreeRoot resolution each call it) against a same-shape
// solo-caller baseline, rather than hardcoding an absolute count.

test("createIntegrationLaneWorktree memoizes racing lazy-init into a single adapter construction (concurrency-3)", async (t) => {
  const soloDir = await initRepo("bughunt-concurrency-solo-");
  const raceDir = await initRepo("bughunt-concurrency-race-");
  const soloRunDir = await fs.mkdtemp(path.join(os.tmpdir(), "bughunt-concurrency-solo-rundir-"));
  const raceRunDir = await fs.mkdtemp(path.join(os.tmpdir(), "bughunt-concurrency-race-rundir-"));
  try {
    let realpathCalls = 0;
    const originalRealpath = fs.realpath;
    t.mock.method(fs, "realpath", async (...args) => {
      realpathCalls += 1;
      return await originalRealpath(...args);
    });

    // Baseline: a single, non-racing caller -> exactly one createWorktreeAdapter() construction.
    const soloRun = {
      id: "solo-run",
      integrationPlan: { baseCommit: "HEAD" },
      integrationWorktrees: [],
      abortController: new AbortController(),
      dir: soloRunDir,
    };
    await createIntegrationLaneWorktree({}, soloRun, { directory: soloDir, worktree: soloDir }, "call-solo");
    const soloCost = realpathCalls;
    assert.ok(soloCost > 0, "sanity: constructing an adapter performs at least one realpath");

    // Race: two lanes call the lazy-init concurrently on a fresh run/repo with the same
    // directory-depth shape as the baseline, so the per-construction realpath cost is comparable.
    realpathCalls = 0;
    const raceRun = {
      id: "race-run",
      integrationPlan: { baseCommit: "HEAD" },
      integrationWorktrees: [],
      abortController: new AbortController(),
      dir: raceRunDir,
    };
    const toolContext = { directory: raceDir, worktree: raceDir };
    const [a, b] = await Promise.all([
      createIntegrationLaneWorktree({}, raceRun, toolContext, "call-a"),
      createIntegrationLaneWorktree({}, raceRun, toolContext, "call-b"),
    ]);

    assert.equal(realpathCalls, soloCost, "two racing lanes should share exactly one adapter construction, not two");
    assert.ok(a.path && b.path && a.path !== b.path, "both lanes still get distinct worktrees from the single shared adapter");
  } finally {
    await fs.rm(soloDir, { recursive: true, force: true }).catch(() => {});
    await fs.rm(raceDir, { recursive: true, force: true }).catch(() => {});
    await fs.rm(`${soloDir}.workflow-worktrees`, { recursive: true, force: true }).catch(() => {});
    await fs.rm(`${raceDir}.workflow-worktrees`, { recursive: true, force: true }).catch(() => {});
    await fs.rm(soloRunDir, { recursive: true, force: true }).catch(() => {});
    await fs.rm(raceRunDir, { recursive: true, force: true }).catch(() => {});
  }
});

// --- createEditWorktree: edit-worktree primary-tree distinctness enforcement ---------------

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
