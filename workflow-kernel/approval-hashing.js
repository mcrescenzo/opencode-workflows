import { hash, hashStable, stableStringify } from "./text-json.js";

export function approvalSnapshotList(nestedSnapshots) {
  return [...new Map([...(nestedSnapshots?.values?.() ?? [])].map((item) => [item.sourcePath, item])).values()]
    .map(({ sourcePath, sourceHash }) => ({ sourcePath, sourceHash }))
    .sort((a, b) => `${a.sourcePath}:${a.sourceHash}`.localeCompare(`${b.sourcePath}:${b.sourceHash}`));
}

export function approvalEnvelope(approval) {
  return {
    version: 2,
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
