import fs from "node:fs/promises";
import path from "node:path";

import { createBeadsDrainAdapter, finalizeBeadsDomainMutation } from "./beads-drain-adapter.js";
import { NON_DRY_DRAIN_REQUIRED_GATES } from "../../workflow-kernel/authority-policy.js";
import {
  assertContainedRealPath,
  assertContainedRunDir,
  assertSafeRunId,
  runDirForRoot,
  runRoots,
} from "../../workflow-kernel/run-store-fs.js";

// Trusted Beads domain extension. Loaded ONLY via explicit config (opencode.json plugin options) —
// trusted host code is never auto-discovered. It supplies the host-side drain adapter and the
// staged-mutation finalizers, and contributes the thin beads-drain workflow/command/skill as
// extension asset dirs (workflow-domains/beads/{workflows,commands,skills}/). Those assets merge
// into the kernel's resolution search (project > global > extension > bundled) and resolve the
// adapter + finalizers through this registration.

// All staged beads mutations finalize through the same adapter entry point (it dispatches on
// payload.operation). beads.release-claim is executed inline by the adapter (not staged), so it is
// not registered here.
const finalize = (payload, options) => finalizeBeadsDomainMutation(payload, options);
const MUTATION_OPS = ["beads.close", "beads.append-notes", "beads.create-followup"];

function authorizedRoot(context) {
  const root = context?.worktree || context?.directory;
  if (typeof root !== "string" || root.trim() === "") {
    throw new Error("review_materialize requires an active session worktree or directory");
  }
  return path.resolve(root);
}

function resolveContainedPath(label, value, root) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`review_materialize requires ${label}`);
  }
  const resolved = path.resolve(value);
  const relative = path.relative(root, resolved);
  if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
    return resolved;
  }
  throw new Error(`review_materialize ${label} must be inside the active worktree or directory: ${root}`);
}

function reviewMaterializeAbort(status, abortReason, extra = {}) {
  return {
    domain: "review-materialize",
    schemaVersion: 1,
    status,
    abortReason,
    programLabel: null,
    epicId: null,
    finalGateId: null,
    created: [],
    skipped: [],
    ambiguous: [],
    crosswalkPath: null,
    verify: null,
    ...extra,
  };
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function firstNonEmptyStringWithSource(candidates) {
  for (const candidate of candidates) {
    if (nonEmptyString(candidate.value)) return { value: candidate.value.trim(), source: candidate.source };
  }
  return { value: null, source: null };
}

function programLabelSuffix(value) {
  return String(value ?? "")
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 12);
}

function baselineHeadFromRunState(state, output, explicitBaselineHead) {
  return firstNonEmptyStringWithSource([
    { value: output?.baselineHead, source: "result.output.baselineHead" },
    { value: output?.provenance?.baselineHead, source: "result.output.provenance.baselineHead" },
    { value: output?.provenance?.baseCommit, source: "result.output.provenance.baseCommit" },
    { value: output?.review?.baselineHead, source: "result.output.review.baselineHead" },
    { value: state?.baselineHead, source: "state.baselineHead" },
    { value: state?.baseCommit, source: "state.baseCommit" },
    { value: state?.approval?.baseCommit, source: "state.approval.baseCommit" },
    { value: state?.runtimeArgs?.baselineHead, source: "state.runtimeArgs.baselineHead" },
    { value: explicitBaselineHead, source: "args.baselineHead" },
  ]);
}

function repoReviewOutputFromResult(resultJson) {
  if (resultJson?.output && typeof resultJson.output === "object" && !Array.isArray(resultJson.output)) return resultJson.output;
  if (resultJson?.result?.output && typeof resultJson.result.output === "object" && !Array.isArray(resultJson.result.output)) return resultJson.result.output;
  if (resultJson?.domain && typeof resultJson === "object" && !Array.isArray(resultJson)) return resultJson;
  return null;
}

async function readJsonAt(filePath, label) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    throw new Error(`${label} is not readable JSON: ${String(error?.message || error)}`);
  }
}

async function containedRunPath(runDir, value, label) {
  if (!nonEmptyString(value)) return null;
  const resolved = path.isAbsolute(value) ? path.resolve(value) : path.resolve(runDir, value);
  await assertContainedRealPath(runDir, resolved, label);
  return resolved;
}

async function readRunState(context, runId) {
  const safeRunId = assertSafeRunId(runId);
  for (const root of runRoots(context)) {
    const dir = runDirForRoot(root, safeRunId);
    try {
      await assertContainedRunDir(root, dir);
      const state = await readJsonAt(path.join(dir, "state.json"), "Workflow state");
      return { runId: safeRunId, root, dir, state };
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }
  }
  throw new Error(`Workflow run not found: ${safeRunId}`);
}

async function findingsFromRepoReviewOutput(output, runDir) {
  const findingsPath = await containedRunPath(runDir, output?.artifactPaths?.findingsJson, "repo-review findings artifact");
  if (findingsPath) {
    const findings = await readJsonAt(findingsPath, "repo-review findings artifact");
    if (!Array.isArray(findings)) throw new Error("repo-review findings artifact must contain a JSON array");
    return { findings, findingsPath, findingsSource: "artifactPaths.findingsJson" };
  }
  if (Array.isArray(output?.findings) && output.truncatedFindings !== true) {
    return { findings: output.findings, findingsPath: null, findingsSource: "result.output.findings" };
  }
  throw new Error("repo-review result does not expose full findings: artifactPaths.findingsJson is missing and result.output.findings is absent or truncated");
}

export async function resolveRepoReviewRunMaterializationInput({ args, context }) {
  const run = await readRunState(context, args.runId);
  const resultPath = await containedRunPath(run.dir, run.state?.resultPath || path.join(run.dir, "result.json"), "Workflow result path");
  const resultJson = await readJsonAt(resultPath, "Workflow result");
  const output = repoReviewOutputFromResult(resultJson);
  if (!output || output.domain !== "repo-review") {
    return {
      ok: false,
      result: reviewMaterializeAbort("aborted", `runId ${run.runId} is not a repo-review result (domain=${JSON.stringify(output?.domain ?? null)}).`, {
        sourceRun: { runId: run.runId, status: run.state?.status ?? null, resultPath },
      }),
    };
  }

  const baseline = baselineHeadFromRunState(run.state, output, args.baselineHead);
  const suffix = programLabelSuffix(baseline.value) || programLabelSuffix(run.runId);
  const programLabel = args.programLabel || `review-${suffix}`;
  const findingsInfo = args.verifyOnly === true
    ? { findings: undefined, findingsPath: null, findingsSource: null }
    : await findingsFromRepoReviewOutput(output, run.dir);
  return {
    ok: true,
    findings: findingsInfo.findings,
    materializationReady: output.materializationReady === true,
    baselineHead: baseline.value,
    programLabel,
    sourceRun: {
      runId: run.runId,
      status: run.state?.status ?? null,
      resultPath,
      findingsPath: findingsInfo.findingsPath,
      findingsSource: findingsInfo.findingsSource,
      materializationReady: output.materializationReady === true,
      baselineHead: baseline.value,
      baselineSource: baseline.source,
      programLabel,
    },
  };
}

export function formatReviewMaterializeResult(result, dryRun) {
  const lines = [
    `review-materialize: ${result.status}`,
    `Program: ${result.programLabel || "?"}`,
    ...(result.sourceRun?.runId ? [`Source run: ${result.sourceRun.runId}`] : []),
    ...(result.sourceRun?.baselineHead ? [`Source baseline: ${result.sourceRun.baselineHead.slice(0, 12)}${result.sourceRun.baselineSource ? ` (${result.sourceRun.baselineSource})` : ""}`] : []),
    ...(result.abortReason ? [`Abort: ${result.abortReason}`] : []),
    ...(result.created ? [`Created: ${result.created.length}`] : []),
    ...(result.skipped ? [`Skipped: ${result.skipped.length}`] : []),
    ...(result.ambiguous ? [`Ambiguous: ${result.ambiguous.length}`] : []),
    ...(result.plannedEpic ? [`Planned epic: ${result.plannedEpic.title}`] : []),
    ...(result.plannedFinalGate ? [`Planned final gate: ${result.plannedFinalGate.title}`] : []),
    ...(result.epicId ? [`Epic: ${result.epicId}`, `Final gate: ${result.finalGateId}`] : []),
    ...(result.verify ? [`Verify: ${result.verify.ok ? "ok" : "FAILED"} (${(result.verify.problems || []).length} problem(s))`] : []),
    ...(result.verify?.verdict ? [`Verifier verdict: ${result.verify.verdict}${result.verify.failureClass ? ` (failureClass=${result.verify.failureClass}, retryable=${Boolean(result.verify.retryable)}, recoverable=${Boolean(result.verify.recoverable)})` : ""}`] : []),
    ...(Number.isInteger(result.childCount) ? [`Checked children: ${result.childCount}`] : []),
    ...(Array.isArray(result.failedChecks) && result.failedChecks.length ? [`Failed checks: ${result.failedChecks.join(", ")}`] : []),
    ...(result.suggestedNextAction ? [`Next action: ${result.suggestedNextAction}`] : []),
    ...(result.stats ? [`Stats: ${result.stats.create} create, ${result.stats.skip} skip, ${result.stats.ambiguous} ambiguous of ${result.stats.total} total`] : []),
    ...(result.plannedCreates ? [`Planned creates: ${result.plannedCreates.length}`] : []),
    ...(dryRun ? ["(dry-run: no Beads writes were made)"] : []),
  ];
  return lines.join("\n");
}

export default {
  id: "beads",
  drainAdapters: {
    beads: {
      // The host (sandbox-executor) calls createAdapter with the live run context; beads owns how to
      // build its adapter (cwd, actor, scope, abort signal) from that context.
      createAdapter: ({ toolContext, run, options }) => ({
        ...createBeadsDrainAdapter({
          cwd: path.resolve(toolContext.worktree || toolContext.directory),
          actor: typeof options.actor === "string" ? options.actor : toolContext.sessionID,
          run,
          scope: options.scope,
          signal: run.abortController.signal,
        }),
        // The host enforces these before any non-dry Beads mutation or lane launch (gate-union floor).
        requiredGates: NON_DRY_DRAIN_REQUIRED_GATES,
      }),
      requiredGates: NON_DRY_DRAIN_REQUIRED_GATES,
      supportsAutoApply: true,
      mutationOperations: MUTATION_OPS,
    },
  },
  mutationHandlers: Object.fromEntries(MUTATION_OPS.map((op) => [op, finalize])),
  // Thin guest assets contributed by this extension (resolved relative to this module's dir).
  // They are sandboxed like any guest workflow; the extension seam confers trust on the host
  // capabilities above, not on these files.
  assetDirs: { workflows: "./workflows", commands: "./commands", skills: "./skills" },
  // review_materialize: a host plugin tool (beads-coupled) the kernel used to ship. The kernel
  // injects toolKit { tool, schema, assertWriteWorkflowAllowed, pluginContext } so this extension
  // needs no @opencode-ai/plugin dependency and shares the kernel's single zod instance.
  tools: (toolKit) => ({
    review_materialize: toolKit.tool({
      description:
        "Materialize repo-review findings into a duplicate-aware Beads epic (epic + children + final gate). Prefer runId so the tool validates the repo-review result envelope and consumes its findings artifact itself. Defaults to dry-run (no writes). Reads existing open/in_progress/deferred/closed beads + a HEAD-stable crosswalk to avoid duplicates. Non-dry requires explicit approval and creates local Beads writes only (no git/dolt push).",
      args: {
        repo: toolKit.schema.string(),
        runId: toolKit.schema.string().optional(),
        programLabel: toolKit.schema.string().optional(),
        baselineHead: toolKit.schema.string().optional(),
        dryRun: toolKit.schema.boolean().optional(),
        verifyOnly: toolKit.schema.boolean().optional(),
        acceptPartial: toolKit.schema.boolean().optional(),
        materializationReady: toolKit.schema.boolean().optional(),
        findings: toolKit.schema.any().optional(),
        findingsPath: toolKit.schema.string().optional(),
        crosswalkPath: toolKit.schema.string().optional(),
        format: toolKit.schema.enum(["summary", "json"]).optional(),
      },
      async execute(args, context) {
        toolKit.assertWriteWorkflowAllowed(context, "review_materialize");
        const { createReviewMaterializeAdapter } = await import("./review-materialize-adapter.js");
        const root = authorizedRoot(context);
        const repo = resolveContainedPath("repo", args.repo, root);
        let findingsPath = args.findingsPath
          ? resolveContainedPath("findingsPath", args.findingsPath, root)
          : null;
        const crosswalkPath = args.crosswalkPath
          ? resolveContainedPath("crosswalkPath", args.crosswalkPath, root)
          : null;
        const verifyOnly = args.verifyOnly === true;
        let materializationReady = args.materializationReady;
        let baselineHead = args.baselineHead;
        let programLabel = args.programLabel || null;
        let sourceRun = null;

        // Resolve findings: inline array or file handoff.
        let findings = args.findings;
        if (args.runId) {
          const mixedInputs = [
            args.findings !== undefined ? "findings" : null,
            args.findingsPath ? "findingsPath" : null,
            args.materializationReady !== undefined ? "materializationReady" : null,
          ].filter(Boolean);
          if (mixedInputs.length > 0) {
            return JSON.stringify(reviewMaterializeAbort("aborted", `runId cannot be combined with caller-supplied ${mixedInputs.join(", ")}; the tool reads findings and readiness from the repo-review result envelope.`));
          }
          const resolved = await resolveRepoReviewRunMaterializationInput({ args: { ...args, verifyOnly }, context });
          if (!resolved.ok) return JSON.stringify(resolved.result);
          findings = resolved.findings;
          findingsPath = resolved.sourceRun.findingsPath;
          materializationReady = resolved.materializationReady;
          baselineHead = resolved.baselineHead;
          programLabel = args.programLabel || resolved.programLabel;
          sourceRun = resolved.sourceRun;
        }
        if (!verifyOnly && !findings && findingsPath) {
          const raw = await fs.readFile(findingsPath, "utf8");
          findings = JSON.parse(raw);
        }
        if (!verifyOnly && !Array.isArray(findings)) {
          return JSON.stringify({ domain: "review-materialize", status: "aborted", abortReason: "findings must be an array (pass inline or via findingsPath)." });
        }

        // Derive programLabel from baselineHead if not given directly.
        programLabel = programLabel || (baselineHead ? `review-${baselineHead.slice(0, 12)}` : null);
        const dryRun = args.dryRun !== false; // default: dry-run (safe preview)

        const adapter = createReviewMaterializeAdapter({ cwd: repo });
        const result = await adapter.materialize({
          findings,
          programLabel,
          dryRun,
          verifyOnly,
          crosswalkPath,
          acceptPartial: args.acceptPartial === true,
          materializationReady,
        });
        if (sourceRun) result.sourceRun = sourceRun;

        if (args.format === "json") return JSON.stringify(result, null, 2);
        return formatReviewMaterializeResult(result, dryRun && !verifyOnly);
      },
    }),
  }),
};
