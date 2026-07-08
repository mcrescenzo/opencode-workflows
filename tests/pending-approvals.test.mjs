import test from "node:test";
import assert from "node:assert/strict";

import { MAX_PENDING_APPROVALS } from "../workflow-kernel/constants.js";
import {
  clearPendingApprovals,
  peekPendingApproval,
  pendingApprovalCount,
  recordPendingApproval,
} from "../workflow-kernel/pending-approvals.js";

function entry(id) {
  return { source: `return ${id};`, sourcePath: "<inline>", envelope: { sourceHash: `hash-${id}` }, byteLength: 10 };
}

test("record/peek round-trips an entry", () => {
  clearPendingApprovals();
  recordPendingApproval("hash-1", entry(1));
  assert.deepEqual(peekPendingApproval("hash-1"), entry(1));
  assert.equal(pendingApprovalCount(), 1);
});

test("store evicts oldest entries FIFO beyond MAX_PENDING_APPROVALS", () => {
  clearPendingApprovals();
  for (let i = 0; i < MAX_PENDING_APPROVALS + 2; i += 1) recordPendingApproval(`hash-${i}`, entry(i));
  assert.equal(pendingApprovalCount(), MAX_PENDING_APPROVALS);
  assert.equal(peekPendingApproval("hash-0"), undefined);
  assert.equal(peekPendingApproval("hash-1"), undefined);
  assert.deepEqual(peekPendingApproval(`hash-${MAX_PENDING_APPROVALS + 1}`), entry(MAX_PENDING_APPROVALS + 1));
});

test("re-recording an existing hash refreshes its eviction slot", () => {
  clearPendingApprovals();
  for (let i = 0; i < MAX_PENDING_APPROVALS; i += 1) recordPendingApproval(`hash-${i}`, entry(i));
  recordPendingApproval("hash-0", entry(0)); // refresh: hash-0 becomes newest
  recordPendingApproval("hash-new", entry("new")); // overflow evicts the OLDEST, now hash-1
  assert.deepEqual(peekPendingApproval("hash-0"), entry(0));
  assert.equal(peekPendingApproval("hash-1"), undefined);
});

test("clearPendingApprovals empties the store; bad keys are ignored", () => {
  clearPendingApprovals();
  recordPendingApproval("hash-1", entry(1));
  recordPendingApproval("", entry(2));
  recordPendingApproval(undefined, entry(3));
  assert.equal(pendingApprovalCount(), 1);
  clearPendingApprovals();
  assert.equal(pendingApprovalCount(), 0);
});
