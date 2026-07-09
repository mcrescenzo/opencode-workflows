import { hash, hashStable, stableStringify, truncateText } from "./text-json.js";

export function approvalSnapshotList(nestedSnapshots) {
  // Dedup key: path-backed snapshots dedup by sourcePath (buildNestedSnapshots stores the same
  // snapshot under BOTH its path key and its hash key, so it appears twice in .values()). Inline
  // snapshots all share the "<inline>" sentinel path, so path-keyed dedup would collapse DISTINCT
  // nested inline bodies last-wins and under-bind the approval envelope — key those by hash.
  return [...new Map([...(nestedSnapshots?.values?.() ?? [])].map((item) => [
    item.sourcePath === "<inline>" ? `<inline>:${item.sourceHash}` : item.sourcePath,
    item,
  ])).values()]
    .map(({ sourcePath, sourceHash }) => ({ sourcePath, sourceHash }))
    .sort((a, b) => `${a.sourcePath}:${a.sourceHash}`.localeCompare(`${b.sourcePath}:${b.sourceHash}`));
}

export function approvalEnvelope(approval) {
  return {
    version: 3, // v3: nested inline snapshots dedup by hash (v2 collapsed distinct inline bodies on the shared "<inline>" path)
    sourcePath: approval.sourcePath,
    sourceHash: approval.sourceHash,
    runtimeArgs: approval.runtimeArgs ?? null,
    maxAgents: approval.maxAgents,
    concurrency: approval.concurrency,
    defaultChildModel: approval.defaultChildModel,
    modelTiers: approval.modelTiers ?? null,
    authority: approval.authority,
    budgetCeilings: approval.budgetCeilings,
    baseCommit: approval.baseCommit ?? null,
    guestDeadlineMs: approval.guestDeadlineMs,
    laneTimeoutMs: approval.laneTimeoutMs ?? null,
    debugCapture: approval.debugCapture === true,
    background: approval.background === true,
    resumeRunId: approval.resumeRunId ?? null,
    resumePolicy: approval.resumePolicy ?? null,
    capabilities: approval.capabilities,
    nestedSnapshots: approvalSnapshotList(approval.nestedSnapshots),
  };
}

export function approvalHash(approval) {
  return hashStable(approvalEnvelope(approval));
}

export function computeDiffPlanHash(plan) {
  return hash(stableStringify({ patches: plan.patches, sourceHash: plan.sourceHash, baseCommit: plan.baseCommit, domainMutationHash: plan.domainMutationHash }));
}

// Field-level diff between two approvalEnvelope() objects. Values render via stableStringify and
// are truncated so a mismatch response stays bounded even when runtimeArgs is large.
const MAX_DIFF_VALUE_CHARS = 200;

export function approvalEnvelopeDiff(previous, fresh) {
  const fields = new Set([...Object.keys(previous ?? {}), ...Object.keys(fresh ?? {})]);
  const changed = [];
  for (const field of [...fields].sort()) {
    const before = stableStringify(previous?.[field]);
    const after = stableStringify(fresh?.[field]);
    if (before === after) continue;
    changed.push({
      field,
      before: truncateText(before, MAX_DIFF_VALUE_CHARS),
      after: truncateText(after, MAX_DIFF_VALUE_CHARS),
    });
  }
  return changed;
}

// tfil.4: applyBundle token. A single opaque string computed from the four review-binding hashes
// (approvedSourceHash, baseCommit, diffPlanHash, domainMutationHash) so workflow_apply can be
// invoked with one field instead of four error-prone copies. Pure presentation/transport: the
// four hashes still transit (encoded) and are still compared server-side unchanged, so the
// review-binding security property is fully preserved. The four explicit fields remain accepted
// for backward compatibility.
const APPLY_BUNDLE_PREFIX = "wfapply1.";

export function encodeApplyBundle({ approvedSourceHash, baseCommit, diffPlanHash, domainMutationHash }) {
  const json = JSON.stringify({ approvedSourceHash, baseCommit, diffPlanHash, domainMutationHash });
  return APPLY_BUNDLE_PREFIX + Buffer.from(json, "utf8").toString("base64url");
}

export function decodeApplyBundle(bundle) {
  if (typeof bundle !== "string" || !bundle.startsWith(APPLY_BUNDLE_PREFIX)) {
    throw new Error('applyBundle must be a wfapply1.-prefixed opaque token from workflow_status detail:"full"');
  }
  let parsed;
  try {
    parsed = JSON.parse(Buffer.from(bundle.slice(APPLY_BUNDLE_PREFIX.length), "base64url").toString("utf8"));
  } catch (error) {
    throw new Error(`applyBundle could not be decoded: ${error.message}`);
  }
  if (!parsed || typeof parsed !== "object") throw new Error("applyBundle decoded to a non-object");
  const { approvedSourceHash, baseCommit, diffPlanHash, domainMutationHash } = parsed;
  return { approvedSourceHash, baseCommit, diffPlanHash, domainMutationHash };
}
