import { MAX_PENDING_APPROVALS } from "./constants.js";

// Module-level (NOT factory-closure) so both instances of a double-instantiated plugin factory
// share one store (AGENTS.md invariant). Keyed by approvalHash. The insertion-ordered Map gives
// FIFO eviction; re-recording an existing hash refreshes its slot. Entries hold the previewed
// source bytes (approve-by-reference) and the hashed envelope (mismatch field diffs). Cleared by
// the plugin's dispose hook.
const pendingApprovals = new Map();

export function recordPendingApproval(approvalHashKey, entry) {
  if (typeof approvalHashKey !== "string" || approvalHashKey.length === 0) return;
  pendingApprovals.delete(approvalHashKey);
  pendingApprovals.set(approvalHashKey, entry);
  while (pendingApprovals.size > MAX_PENDING_APPROVALS) {
    pendingApprovals.delete(pendingApprovals.keys().next().value);
  }
}

export function peekPendingApproval(approvalHashKey) {
  return pendingApprovals.get(approvalHashKey);
}

export function clearPendingApprovals() {
  pendingApprovals.clear();
}

export function pendingApprovalCount() {
  return pendingApprovals.size;
}
