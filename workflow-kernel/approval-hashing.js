import { hash, hashStable, stableStringify } from "./text-json.js";

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
