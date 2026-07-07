import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { chmod, mkdir, rm, writeFile } from "node:fs/promises";

import WorkflowPlugin from "../workflow-kernel/workflow-plugin.js";
import {
  formatReviewMaterializeResult,
  resolveRepoReviewRunMaterializationInput,
} from "../workflow-domains/beads/beads-extension.js";
import { makeExtensionDir, writeFakeExtension } from "./helpers/fake-extension.mjs";

function ctx(dir) {
  return { directory: dir, worktree: dir, client: {} };
}

function reviewFinding(overrides = {}) {
  return {
    fingerprint: "bughunt-runid-1",
    category: "bughunt",
    file: "src/app.js",
    line: 7,
    severity: "high",
    description: "run-bound finding",
    proposedChange: "fix the run-bound finding",
    sourceDomains: ["bughunt"],
    domainDetails: { reproSketch: "trigger it", fixSketch: "patch it" },
    ...overrides,
  };
}

async function writeRepoReviewRun(root, {
  runId = "repo-review-runid-test",
  findings = [reviewFinding()],
  output = {},
  state = {},
} = {}) {
  const runDir = path.join(root, ".opencode", "workflows", "runs", runId);
  const artifactDir = path.join(runDir, "artifacts", "repo-review");
  await mkdir(artifactDir, { recursive: true });
  const findingsPath = path.join(artifactDir, "findings.full.json");
  const resultPath = path.join(runDir, "result.json");
  await writeFile(findingsPath, JSON.stringify(findings), "utf8");
  const resultOutput = {
    domain: "repo-review",
    schemaVersion: 1,
    status: "ok",
    materializationReady: true,
    artifactPaths: { findingsJson: findingsPath },
    findings: [],
    truncatedFindings: true,
    ...output,
  };
  await writeFile(resultPath, JSON.stringify({ output: resultOutput }), "utf8");
  await writeFile(path.join(runDir, "state.json"), JSON.stringify({
    id: runId,
    status: "completed",
    resultPath,
    baseCommit: "abcdef1234567890abcdef1234567890abcdef12",
    ...state,
  }), "utf8");
  return { runId, runDir, resultPath, findingsPath, output: resultOutput };
}

async function withFakeBd(root, fn) {
  const bin = path.join(root, "fake-bin");
  await mkdir(bin, { recursive: true });
  const bdPath = path.join(bin, "bd");
  await writeFile(bdPath, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "list") {
  console.log("[]");
  process.exit(0);
}
console.error("unexpected fake bd command: " + args.join(" "));
process.exit(1);
`, "utf8");
  await chmod(bdPath, 0o755);
  const oldPath = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${oldPath || ""}`;
  try {
    return await fn();
  } finally {
    process.env.PATH = oldPath;
  }
}

// A fixture extension whose tools FACTORY echoes the injected toolKit shape from execute().
const PROBE_EXT = `export default {
  id: "tool-ext",
  tools: (toolKit) => ({
    ext_probe: toolKit.tool({
      description: "probe toolKit wiring",
      args: { echo: toolKit.schema.string().optional() },
      async execute(args, context) {
        return JSON.stringify({
          echo: args.echo ?? null,
          hasContext: Boolean(context),
          kit: {
            tool: typeof toolKit.tool,
            schemaUsable: typeof toolKit.schema?.string === "function",
            pluginContext: Boolean(toolKit.pluginContext),
            guard: typeof toolKit.assertWriteWorkflowAllowed,
          },
        });
      },
    }),
  }),
};
`;

test("an extension contributes a tool into the plugin's static tool map (factory form)", async () => {
  const dir = await makeExtensionDir();
  const extPath = await writeFakeExtension(dir, { source: PROBE_EXT });
  const pluginContext = ctx(dir);
  const hooks = await WorkflowPlugin(pluginContext, { extensions: [extPath] });

  assert.ok(hooks.tool.ext_probe, "extension tool present in the returned tool map");
  assert.equal(typeof hooks.tool.ext_probe.execute, "function");

  const out = JSON.parse(await hooks.tool.ext_probe.execute({ echo: "hi" }, { sessionID: "s" }));
  assert.equal(out.echo, "hi", "args forwarded to execute");
  assert.equal(out.hasContext, true, "ToolContext forwarded to execute");
  assert.equal(out.kit.tool, "function", "toolKit.tool injected");
  assert.equal(out.kit.schemaUsable, true, "toolKit.schema injected and usable (schema.string())");
  assert.equal(out.kit.pluginContext, true, "toolKit.pluginContext injected");
  assert.equal(out.kit.guard, "function", "toolKit.assertWriteWorkflowAllowed injected");
  await rm(dir, { recursive: true, force: true });
});

test("a plain-object tools manifest is also merged", async () => {
  const dir = await makeExtensionDir();
  const extPath = await writeFakeExtension(dir, {
    source: `export default {
  id: "plain-tool-ext",
  tools: {
    plain_tool: { description: "plain", args: {}, execute: async () => "plain-ok" },
  },
};
`,
  });
  const hooks = await WorkflowPlugin(ctx(dir), { extensions: [extPath] });
  assert.ok(hooks.tool.plain_tool, "plain-object extension tool present");
  assert.equal(await hooks.tool.plain_tool.execute({}, {}), "plain-ok");
  await rm(dir, { recursive: true, force: true });
});

test("an extension tool that collides with a core tool name rejects the factory", async () => {
  const dir = await makeExtensionDir();
  const extPath = await writeFakeExtension(dir, {
    source: `export default {
  id: "collide-core",
  tools: (toolKit) => ({ workflow_run: toolKit.tool({ description: "x", args: {}, execute: async () => "no" }) }),
};
`,
  });
  await assert.rejects(
    WorkflowPlugin(ctx(dir), { extensions: [extPath] }),
    /workflow_run|collision|reserved|already/i,
  );
  await rm(dir, { recursive: true, force: true });
});

test("the real beads extension contributes review_materialize as a plugin tool", async () => {
  const beadsExt = path.resolve(import.meta.dirname, "..", "workflow-domains", "beads", "beads-extension.js");
  const pluginContext = { directory: path.dirname(beadsExt), worktree: path.dirname(beadsExt), client: {} };
  const hooks = await WorkflowPlugin(pluginContext, { extensions: [beadsExt] });

  assert.ok(hooks.tool.review_materialize, "review_materialize present from the beads extension");
  assert.equal(typeof hooks.tool.review_materialize.execute, "function");
  // A no-findings call aborts before any `bd` shell-out (validates the tool is wired + executes).
  const out = JSON.parse(await hooks.tool.review_materialize.execute(
    { repo: path.dirname(beadsExt) },
    { agent: "build", directory: path.dirname(beadsExt), worktree: path.dirname(beadsExt) },
  ));
  assert.equal(out.status, "aborted");
  assert.match(out.abortReason, /findings must be an array/);
});

test("review_materialize rejects repo and findingsPath outside the active worktree", async () => {
  const root = await makeExtensionDir("review-materialize-root-");
  const outside = await makeExtensionDir("review-materialize-outside-");
  try {
    const findingsPath = path.join(outside, "findings.json");
    await writeFile(findingsPath, "[]", "utf8");
    const beadsExt = path.resolve(import.meta.dirname, "..", "workflow-domains", "beads", "beads-extension.js");
    const hooks = await WorkflowPlugin({ directory: root, worktree: root, client: {} }, { extensions: [beadsExt] });
    const context = { agent: "build", directory: root, worktree: root };

    await assert.rejects(
      () => hooks.tool.review_materialize.execute({ repo: outside, findings: [] }, context),
      /repo must be inside the active worktree or directory/,
    );
    await assert.rejects(
      () => hooks.tool.review_materialize.execute({ repo: root, findingsPath }, context),
      /findingsPath must be inside the active worktree or directory/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("review_materialize reads findingsPath, derives programLabel, and formats early results", async () => {
  const root = await makeExtensionDir("review-materialize-root-");
  try {
    const findingsPath = path.join(root, "findings.json");
    await writeFile(findingsPath, JSON.stringify([
      {
        fingerprint: "finding-1",
        category: "test-gap",
        description: "materialize this finding",
        proposedChange: "add coverage",
        file: "src/example.js",
        line: 12,
      },
    ]), "utf8");
    const beadsExt = path.resolve(import.meta.dirname, "..", "workflow-domains", "beads", "beads-extension.js");
    const hooks = await WorkflowPlugin({ directory: root, worktree: root, client: {} }, { extensions: [beadsExt] });

    const out = await hooks.tool.review_materialize.execute({
      repo: root,
      baselineHead: "abcdef1234567890",
      findingsPath,
      materializationReady: false,
    }, { agent: "build", directory: root, worktree: root });

    assert.match(out, /review-materialize: blocked_not_ready/);
    assert.match(out, /Program: review-abcdef123456/);
    assert.match(out, /Abort: The source report is not materializationReady/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("review_materialize runId resolver binds to repo-review result artifact and review-time baseline", async () => {
  const root = await makeExtensionDir("review-materialize-runid-root-");
  try {
    const run = await writeRepoReviewRun(root);
    const resolved = await resolveRepoReviewRunMaterializationInput({
      args: { runId: run.runId },
      context: { directory: root, worktree: root },
    });

    assert.equal(resolved.ok, true);
    assert.equal(resolved.materializationReady, true);
    assert.equal(resolved.findings.length, 1);
    assert.equal(resolved.findings[0].fingerprint, "bughunt-runid-1");
    assert.equal(resolved.programLabel, "review-abcdef123456");
    assert.equal(resolved.sourceRun.runId, run.runId);
    assert.equal(resolved.sourceRun.findingsPath, run.findingsPath);
    assert.equal(resolved.sourceRun.findingsSource, "artifactPaths.findingsJson");
    assert.equal(resolved.sourceRun.baselineSource, "state.baseCommit");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("review_materialize runId resolver refuses non repo-review envelopes", async () => {
  const root = await makeExtensionDir("review-materialize-runid-root-");
  try {
    const run = await writeRepoReviewRun(root, { output: { domain: "repo-bughunt" } });
    const resolved = await resolveRepoReviewRunMaterializationInput({
      args: { runId: run.runId },
      context: { directory: root, worktree: root },
    });

    assert.equal(resolved.ok, false);
    assert.equal(resolved.result.status, "aborted");
    assert.match(resolved.result.abortReason, /not a repo-review result/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("review_materialize runId path refuses mixed caller-supplied provenance", async () => {
  const root = await makeExtensionDir("review-materialize-runid-root-");
  try {
    const run = await writeRepoReviewRun(root);
    const beadsExt = path.resolve(import.meta.dirname, "..", "workflow-domains", "beads", "beads-extension.js");
    const hooks = await WorkflowPlugin({ directory: root, worktree: root, client: {} }, { extensions: [beadsExt] });

    const out = JSON.parse(await hooks.tool.review_materialize.execute({
      repo: root,
      runId: run.runId,
      materializationReady: true,
    }, { agent: "build", directory: root, worktree: root }));

    assert.equal(out.status, "aborted");
    assert.match(out.abortReason, /runId cannot be combined/);
    assert.match(out.abortReason, /materializationReady/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("review_materialize runId path blocks not-ready reports before Beads reads unless acceptPartial is explicit", async () => {
  const root = await makeExtensionDir("review-materialize-runid-root-");
  try {
    const run = await writeRepoReviewRun(root, { output: { materializationReady: false, materializationBlockers: ["laneDropped"] } });
    const beadsExt = path.resolve(import.meta.dirname, "..", "workflow-domains", "beads", "beads-extension.js");
    const hooks = await WorkflowPlugin({ directory: root, worktree: root, client: {} }, { extensions: [beadsExt] });

    const out = JSON.parse(await hooks.tool.review_materialize.execute({
      repo: root,
      runId: run.runId,
      format: "json",
    }, { agent: "build", directory: root, worktree: root }));

    assert.equal(out.status, "blocked_not_ready");
    assert.equal(out.programLabel, "review-abcdef123456");
    assert.equal(out.sourceRun.runId, run.runId);
    assert.equal(out.sourceRun.materializationReady, false);

    const accepted = await withFakeBd(root, async () => JSON.parse(await hooks.tool.review_materialize.execute({
      repo: root,
      runId: run.runId,
      acceptPartial: true,
      format: "json",
    }, { agent: "build", directory: root, worktree: root })));
    assert.equal(accepted.status, "dry_run");
    assert.equal(accepted.sourceRun.materializationReady, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("review_materialize runId path dry-runs from the bound findings artifact by default", async () => {
  const root = await makeExtensionDir("review-materialize-runid-root-");
  try {
    const run = await writeRepoReviewRun(root);
    const beadsExt = path.resolve(import.meta.dirname, "..", "workflow-domains", "beads", "beads-extension.js");
    const hooks = await WorkflowPlugin({ directory: root, worktree: root, client: {} }, { extensions: [beadsExt] });

    const out = await withFakeBd(root, async () => JSON.parse(await hooks.tool.review_materialize.execute({
      repo: root,
      runId: run.runId,
      format: "json",
    }, { agent: "build", directory: root, worktree: root })));

    assert.equal(out.status, "dry_run");
    assert.equal(out.programLabel, "review-abcdef123456");
    assert.equal(out.sourceRun.runId, run.runId);
    assert.equal(out.sourceRun.findingsPath, run.findingsPath);
    assert.equal(out.stats.create, 1);
    assert.equal(out.plannedCreates.length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("review_materialize summary formatter covers dry-run materialization fields", () => {
  const out = formatReviewMaterializeResult({
    status: "dry_run",
    programLabel: "review-abcdef123456",
    sourceRun: { runId: "repo-review-runid-test", baselineHead: "abcdef1234567890", baselineSource: "state.baseCommit" },
    created: [],
    skipped: [{ fingerprint: "existing", beadId: "ocw-1", reason: "exists:ocw-1" }],
    ambiguous: [],
    epicId: "ocw-epic",
    finalGateId: "ocw-gate",
    verify: { ok: true, problems: [], verdict: "pass", failureClass: null, retryable: false, recoverable: false },
    childCount: 2,
    failedChecks: ["final_gate_blocked_by_scope"],
    suggestedNextAction: "Retry verify-only before re-running materialization.",
    stats: { create: 2, skip: 1, ambiguous: 0, total: 3 },
    plannedCreates: [{ fingerprint: "new", title: "new finding" }],
  }, true);

  assert.match(out, /review-materialize: dry_run/);
  assert.match(out, /Program: review-abcdef123456/);
  assert.match(out, /Source run: repo-review-runid-test/);
  assert.match(out, /Source baseline: abcdef123456 \(state\.baseCommit\)/);
  assert.match(out, /Skipped: 1/);
  assert.match(out, /Epic: ocw-epic/);
  assert.match(out, /Final gate: ocw-gate/);
  assert.match(out, /Verify: ok \(0 problem\(s\)\)/);
  assert.match(out, /Verifier verdict: pass/);
  assert.match(out, /Checked children: 2/);
  assert.match(out, /Failed checks: final_gate_blocked_by_scope/);
  assert.match(out, /Next action: Retry verify-only/);
  assert.match(out, /Stats: 2 create, 1 skip, 0 ambiguous of 3 total/);
  assert.match(out, /Planned creates: 1/);
  assert.match(out, /\(dry-run: no Beads writes were made\)/);
});

test("two extensions claiming the same tool name reject the factory", async () => {
  const dirA = await makeExtensionDir();
  const dirB = await makeExtensionDir();
  const mk = (id) => `export default { id: "${id}", tools: (k) => ({ dupe_tool: k.tool({ description: "d", args: {}, execute: async () => "d" }) }) };\n`;
  const a = await writeFakeExtension(dirA, { source: mk("ext-a") });
  const b = await writeFakeExtension(dirB, { source: mk("ext-b") });
  await assert.rejects(
    WorkflowPlugin(ctx(dirA), { extensions: [a, b] }),
    /dupe_tool|duplicate|already|collision/i,
  );
  await rm(dirA, { recursive: true, force: true });
  await rm(dirB, { recursive: true, force: true });
});
