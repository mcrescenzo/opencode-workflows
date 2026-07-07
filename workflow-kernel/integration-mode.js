import fs from "node:fs/promises";
import path from "node:path";
import { git } from "./git-util.js";
import { protectedPathReason } from "./path-policy.js";

function normalizeRelativePath(filePath) {
  const normalized = String(filePath ?? "").replace(/\\/g, "/");
  if (!normalized || normalized.startsWith("/") || normalized.split("/").includes("..")) {
    throw new Error(`Unsafe integration path: ${filePath}`);
  }
  return normalized;
}

async function changedPathsSinceBase(directory, baseCommit, options = {}) {
  const { stdout } = await git(directory, ["diff", "--name-status", baseCommit, "HEAD", "--"], { signal: options.signal });
  return stdout.split(/\r?\n/).filter(Boolean).map((line) => {
    const [status, ...parts] = line.split(/\t/);
    const filePath = normalizeRelativePath(parts.at(-1));
    return { status, path: filePath, supported: /^[AMTUXB]/.test(status) };
  });
}

function detectPathConflicts(laneChanges) {
  const seen = new Map();
  const conflicts = [];
  for (const lane of laneChanges) {
    for (const change of lane.paths ?? []) {
      const filePath = normalizeRelativePath(typeof change === "string" ? change : change.path);
      const previous = seen.get(filePath);
      if (previous && previous.callId !== lane.callId) {
        conflicts.push({ path: filePath, lanes: [previous.callId, lane.callId] });
      } else {
        seen.set(filePath, { callId: lane.callId });
      }
    }
  }
  return conflicts;
}

async function buildPatchesFromIntegration({ integrationPath, baseCommit, paths, secretGlobs, signal }) {
  const changes = paths?.length ? paths : await changedPathsSinceBase(integrationPath, baseCommit, { signal });
  const patches = [];
  const unsupported = [];
  for (const change of changes) {
    const filePath = normalizeRelativePath(typeof change === "string" ? change : change.path);
    const status = typeof change === "string" ? "M" : change.status;
    if (status && !/^[AMTUXB]/.test(status)) {
      unsupported.push({ path: filePath, status, reason: "unsupported-change-kind" });
      continue;
    }
    const protectedReason = protectedPathReason(filePath, { secretGlobs });
    if (protectedReason) {
      unsupported.push({ path: filePath, status, reason: protectedReason });
      continue;
    }
    const absolute = path.join(integrationPath, filePath);
    const stat = await fs.lstat(absolute).catch(() => undefined);
    if (!stat || !stat.isFile()) {
      unsupported.push({ path: filePath, status, reason: stat?.isSymbolicLink() ? "symlink" : "not-regular-file" });
      continue;
    }
    let content;
    try {
      content = await fs.readFile(absolute, "utf8");
    } catch {
      unsupported.push({ path: filePath, status, reason: "non-utf8-or-unreadable" });
      continue;
    }
    patches.push({ path: filePath, content, mode: "replace" });
  }
  return { patches, unsupported };
}

function normalizeIntegrationValidationResult(result) {
  if (result === true) return { accepted: true, status: "passed" };
  if (result === false) return { accepted: false, status: "failed", reason: "integration validation rejected" };
  if (!result || typeof result !== "object") return { accepted: false, status: "failed", reason: "integration validation returned no explicit result" };
  const status = typeof result.status === "string" ? result.status : undefined;
  const accepted = result.accepted === true
    || result.ok === true
    || ["ok", "pass", "passed", "success", "validated"].includes(status);
  return {
    ...result,
    accepted,
    status: status ?? (accepted ? "passed" : "failed"),
    reason: accepted ? result.reason : (result.reason ?? result.error ?? "integration validation rejected"),
  };
}

async function integrateLaneCommits({ adapter, runId, baseCommit, lanes, secretGlobs, signal }) {
  const laneChanges = [];
  for (const lane of lanes) {
    laneChanges.push({ ...lane, paths: lane.paths?.length ? lane.paths : await changedPathsSinceBase(lane.path, baseCommit, { signal }) });
  }
  const unsupportedLane = laneChanges.find((lane) => lane.paths.some((change) => {
    const filePath = typeof change === "string" ? change : change.path;
    return change.supported === false || protectedPathReason(filePath, { secretGlobs });
  }));
  if (unsupportedLane) {
    return { status: "review-required", culpritLane: unsupportedLane.callId, reason: "unsupported-lane-change", lanes: laneChanges };
  }
  const conflicts = detectPathConflicts(laneChanges);
  if (conflicts.length > 0) {
    return { status: "review-required", conflicts, reason: "path-conflict", lanes: laneChanges };
  }

  const integration = await adapter.createIntegrationWorktree({ runId, baseRef: baseCommit });
  const mergedLanes = [];
  try {
    for (const lane of laneChanges.sort((a, b) => String(a.callId).localeCompare(String(b.callId)))) {
      try {
        await adapter.merge({ directory: integration.path, ref: lane.branch, message: `merge ${lane.callId}` });
        mergedLanes.push(lane.callId);
      } catch (error) {
        return { status: "review-required", integrationWorktree: integration, mergedLanes, culpritLane: lane.callId, reason: "merge-failed", error: error.message, lanes: laneChanges };
      }
    }
    let validation;
    if (typeof adapter.validateIntegrationWorktree === "function") {
      try {
        validation = normalizeIntegrationValidationResult(await adapter.validateIntegrationWorktree({
          runId,
          directory: integration.path,
          path: integration.path,
          baseCommit,
          lanes: laneChanges,
          mergedLanes,
          signal,
        }));
      } catch (error) {
        validation = { accepted: false, status: "failed", reason: "integration validation threw", error: error.message };
      }
      if (validation.accepted !== true) {
        return { status: "review-required", integrationWorktree: integration, mergedLanes, reason: "integration-validation-failed", validation, lanes: laneChanges };
      }
    }
    const allChanges = await changedPathsSinceBase(integration.path, baseCommit, { signal });
    const built = await buildPatchesFromIntegration({ integrationPath: integration.path, baseCommit, paths: allChanges, secretGlobs, signal });
    if (built.unsupported.length > 0) {
      return { status: "review-required", integrationWorktree: integration, mergedLanes, reason: "unsupported-integration-change", unsupported: built.unsupported, lanes: laneChanges };
    }
    return { status: "awaiting-diff-approval", integrationWorktree: integration, mergedLanes, validation, lanes: laneChanges, patches: built.patches };
  } catch (error) {
    return { status: "review-required", integrationWorktree: integration, mergedLanes, reason: "integration-failed", error: error.message, lanes: laneChanges };
  }
}

export {
  buildPatchesFromIntegration,
  changedPathsSinceBase,
  detectPathConflicts,
  integrateLaneCommits,
  normalizeIntegrationValidationResult,
  normalizeRelativePath,
};
