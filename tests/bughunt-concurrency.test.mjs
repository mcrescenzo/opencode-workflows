import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { setTimeout as sleep } from "node:timers/promises";

import { createWorktreeAdapter } from "../workflow-kernel/worktree-adapter.js";
import { createIntegrationLaneWorktree } from "../workflow-kernel/child-agent-runner.js";
import { executeSandbox, __setSandboxHostOpTestHook } from "../workflow-kernel/sandbox-executor.js";

// Regression coverage for three adversarially-verified concurrency findings (bughunt-ad31fd87,
// bughunt-a3e1f548, bughunt-73843471): the worktree-creation mutex in worktree-adapter.js, the
// lazy-init memoization in child-agent-runner.js's createIntegrationLaneWorktree, and the
// concurrent-abort fix in sandbox-executor.js's settlePendingHostOps.

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

// --- concurrency-2: sandbox-executor.js settlePendingHostOps concurrent aborts --------------
// Reuses the established "unawaited host op" recipe (see sandbox-executor.test.mjs) to force
// settlePendingHostOps to run, but populates run.activeLaneAbortControllers with several lanes
// and stubs the underlying session.abort to record in-flight overlap, proving the aborts are
// dispatched concurrently rather than serialized one-at-a-time inside the loop.

const NO_CTX = {};
const NO_DEPS = {};

function minimalRun(overrides = {}) {
  return {
    id: "bughunt-concurrency-2-test",
    sourcePath: "<bughunt-concurrency-2-test>",
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

test("settlePendingHostOps aborts active lanes concurrently instead of serializing them (concurrency-2)", async () => {
  const laneCount = 4;
  const activeLaneAbortControllers = new Map();
  for (let i = 0; i < laneCount; i += 1) {
    activeLaneAbortControllers.set(`lane-${i}`, {
      abortController: new AbortController(),
      childID: `child-${i}`,
      directory: "/tmp/bughunt-concurrency-lane",
    });
  }
  const run = minimalRun({ waitingAgents: [], activeLaneAbortControllers });

  let inFlight = 0;
  let maxInFlight = 0;
  const pluginContext = {
    __workflowPendingHostOpSettleTimeoutMs: 5000,
    client: {
      session: {
        abort: async () => {
          inFlight += 1;
          maxInFlight = Math.max(maxInFlight, inFlight);
          await sleep(60);
          inFlight -= 1;
        },
      },
    },
  };

  __setSandboxHostOpTestHook(async ({ op, run: hookRun }) => {
    if (op === "noop" && hookRun.hostCalls === 2) await sleep(300);
  });
  try {
    await assert.rejects(
      executeSandbox(pluginContext, NO_CTX, run, '__host("noop", {}); return "done";', null, NO_DEPS),
      /host operation.*must be awaited/i,
    );
  } finally {
    __setSandboxHostOpTestHook(undefined);
  }

  assert.equal(maxInFlight, laneCount, `expected all ${laneCount} lane aborts in flight simultaneously, got max ${maxInFlight}`);
});
