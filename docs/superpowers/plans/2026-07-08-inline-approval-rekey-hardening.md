# Inline Approval Re-Key Hardening Implementation Plan

> Status: Active plan (2026-07-08). Implements all fixes from the 2026-07-08 inline-approval re-key investigation (approve-by-reference, mismatch diagnostics, nested-inline binding, string-args normalization, docs).

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make inline-source `workflow_run` approvals robust to agent re-transmission drift (the "re-keying between two hashes" bug report), diagnosable when they still mismatch, and correctly hash-bound for nested inline workflows and stringified args bags.

**Architecture:** A new module-level bounded pending-approval store (keyed by `approvalHash`) records every preview so an approve call can present just the hash and reuse the exact previewed inline source ("approve-by-reference"); the stored envelope also powers a field-level `changedFields` diff in mismatch responses. Two envelope-correctness fixes ride along: nested inline snapshots dedup by hash instead of collapsing on the shared `"<inline>"` path (envelope `version` 2 → 3), and a JSON-string `args` bag is normalized to its decoded object for all workflows (generalizing the existing drain-only tolerance) so string/object emissions of the same payload cannot hash apart.

**Tech Stack:** Node ESM, `node:test` + `node:assert/strict`, the existing `tests/helpers/harness.mjs` fake-plugin-context harness. No new dependencies.

**Background (root-cause investigation, 2026-07-08):** `approvalHash` is a pure function of the envelope — verified by a 5-lane audit + executable repro. The oscillation happens because the stateless two-phase protocol forces the agent to re-emit the full inline source byte-identically on the approve call; any 1-byte drift re-keys `sourceHash` → `approvalHash`, and each mismatch response advertises the hash of the just-sent variant, so two alternating emissions bounce between exactly two hashes forever. By-name is immune (bytes re-read from disk). This plan removes the re-transmission requirement rather than "fixing" the (already correct) hashing.

## Global Constraints

- AGENTS.md invariants apply to every task: module-level state for shared registries (factories are double-instantiated); every module-level map bounded and/or cleared in `dispose`; export exactly one factory; the `event` hook never throws; model IDs from config, never literals.
- All work in `plugins/opencode-workflows/`; never edit archived plan docs under `docs/superpowers/plans/` (some mention envelope `version: 2` historically — leave them).
- Test command: `node --test tests/<file>.test.mjs` per task; full gate `node --test tests/*.test.mjs` (currently 656 passing, expect that number to grow; 0 failures required).
- Work on a branch (`inline-approval-rekey-hardening`) created via superpowers:using-git-worktrees at execution time. Commit after every task; never push.
- Do not change the preview summary's existing line labels — tests regex them verbatim; only append new lines (see comment at `workflow-kernel/workflow-plugin.js:759-763`).
- `docs/authoring-checklist.md` is the definition of done for the whole branch.

---

### Task 1: Nested-inline snapshot dedup + envelope version 3

Two distinct nested **inline** workflows currently collapse to one snapshot in the hashed envelope: `buildNestedSnapshots` keys inline snapshots by hash (`workflow-kernel/workflow-source.js:323-324`), but `approvalSnapshotList` re-dedups `.values()` by `sourcePath` (`workflow-kernel/approval-hashing.js:4`), and every inline snapshot shares the `"<inline>"` sentinel — last-wins, so the approval hash does not bind the earlier inline body. Fix the dedup key; bump the envelope version so the semantic change re-keys cleanly across plugin upgrades.

**Files:**
- Modify: `workflow-kernel/approval-hashing.js:3-7` (dedup key), `:11` (version)
- Test: `tests/approval-hashing.test.mjs`

**Interfaces:**
- Consumes: nothing new.
- Produces: `approvalSnapshotList(nestedSnapshots)` now returns one entry per distinct inline hash; `approvalEnvelope(approval).version === 3`. Later tasks rely on `approvalEnvelope` unchanged otherwise.

- [ ] **Step 1: Write the failing tests** (append to `tests/approval-hashing.test.mjs`, reusing its existing `approval()` fixture)

```js
test("approvalSnapshotList keeps two distinct inline nested snapshots", () => {
  const snapshots = new Map([
    ["hash-a", { sourcePath: "<inline>", sourceHash: "hash-a", source: "return 1;" }],
    ["hash-b", { sourcePath: "<inline>", sourceHash: "hash-b", source: "return 2;" }],
  ]);
  assert.deepEqual(approvalSnapshotList(snapshots), [
    { sourcePath: "<inline>", sourceHash: "hash-a" },
    { sourcePath: "<inline>", sourceHash: "hash-b" },
  ]);
});

test("approvalSnapshotList still dedups path-backed snapshots stored under both path and hash keys", () => {
  const snapshot = { sourcePath: "/abs/nested.js", sourceHash: "hash-c", source: "return 3;" };
  const snapshots = new Map([["/abs/nested.js", snapshot], ["hash-c", snapshot]]);
  assert.deepEqual(approvalSnapshotList(snapshots), [{ sourcePath: "/abs/nested.js", sourceHash: "hash-c" }]);
});

test("approvalEnvelope pins version 3", () => {
  assert.equal(approvalEnvelope(approval()).version, 3);
});

test("approvalHash changes when only sourceHash changes", () => {
  assert.notEqual(
    approvalHash(approval({ sourceHash: "hash-a" })),
    approvalHash(approval({ sourceHash: "hash-b" })),
  );
});
```

- [ ] **Step 2: Run to verify the new tests fail**

Run: `node --test tests/approval-hashing.test.mjs`
Expected: FAIL — inline-dedup test sees one entry instead of two; version test sees 2.

- [ ] **Step 3: Implement** (replace `approvalSnapshotList` and the `version` line in `workflow-kernel/approval-hashing.js`)

```js
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
```

```js
    version: 3, // v3: nested inline snapshots dedup by hash (v2 collapsed distinct inline bodies on the shared "<inline>" path)
```

- [ ] **Step 4: Check nothing pins the old behavior**

Run: `rg -n 'version.?:? ?2' tests/ workflow-kernel/` — update any test asserting envelope version 2 or asserting that two inline snapshots collapse (that assertion, if present, encoded the bug; flip its expectation).
Then run: `node --test tests/approval-hashing.test.mjs tests/workflow-run.test.mjs` — expected: PASS.

- [ ] **Step 5: Full suite + commit**

Run: `node --test tests/*.test.mjs` — expected: all pass.

```bash
git add workflow-kernel/approval-hashing.js tests/approval-hashing.test.mjs
git commit -m "fix: bind every distinct nested inline snapshot into the approval envelope (version 3)"
```

---

### Task 2: `approvalEnvelopeDiff` pure function

Field-level diff between two hashed envelopes; feeds Task 7's mismatch diagnostics.

**Files:**
- Modify: `workflow-kernel/approval-hashing.js` (new export; extend the `./text-json.js` import with `truncateText`)
- Test: `tests/approval-hashing.test.mjs`

**Interfaces:**
- Consumes: `stableStringify`, `truncateText` from `./text-json.js`.
- Produces: `approvalEnvelopeDiff(previous, fresh) -> Array<{ field: string, before: string, after: string }>` — sorted by field name, values `stableStringify`-rendered and truncated to 200 chars; `[]` when identical. Task 7 imports it into `workflow-plugin.js`.

- [ ] **Step 1: Write the failing tests** (append to `tests/approval-hashing.test.mjs`; add `approvalEnvelopeDiff` to its import list)

```js
test("approvalEnvelopeDiff names exactly the changed fields, sorted", () => {
  const before = approvalEnvelope(approval({ sourceHash: "hash-a" }));
  const after = approvalEnvelope(approval({ sourceHash: "hash-b", maxAgents: 2 }));
  const diff = approvalEnvelopeDiff(before, after);
  assert.deepEqual(diff.map((entry) => entry.field), ["maxAgents", "sourceHash"]);
  const sourceEntry = diff.find((entry) => entry.field === "sourceHash");
  assert.equal(sourceEntry.before, '"hash-a"');
  assert.equal(sourceEntry.after, '"hash-b"');
});

test("approvalEnvelopeDiff returns [] for identical envelopes", () => {
  const envelope = approvalEnvelope(approval());
  assert.deepEqual(approvalEnvelopeDiff(envelope, approvalEnvelope(approval())), []);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test tests/approval-hashing.test.mjs`
Expected: FAIL with "approvalEnvelopeDiff is not a function" (export missing).

- [ ] **Step 3: Implement** (append to `workflow-kernel/approval-hashing.js`; change line 1 to `import { hash, hashStable, stableStringify, truncateText } from "./text-json.js";`)

```js
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
```

- [ ] **Step 4: Run to verify pass**

Run: `node --test tests/approval-hashing.test.mjs` — expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add workflow-kernel/approval-hashing.js tests/approval-hashing.test.mjs
git commit -m "feat: approvalEnvelopeDiff for field-level approval mismatch diagnostics"
```

---

### Task 3: Bounded pending-approval store

New module holding recent previews keyed by `approvalHash`. Module-level (double-instantiation invariant), FIFO-bounded, cleared on `dispose` (wired in Task 6).

**Files:**
- Create: `workflow-kernel/pending-approvals.js`
- Modify: `workflow-kernel/constants.js` (add `MAX_PENDING_APPROVALS` next to `MAX_SOURCE_BYTES`, line ~49)
- Test: Create `tests/pending-approvals.test.mjs`

**Interfaces:**
- Consumes: `MAX_PENDING_APPROVALS` from `./constants.js`.
- Produces (Tasks 6–7 import these into `workflow-plugin.js`):
  - `recordPendingApproval(approvalHashKey: string, entry: { source: string, sourcePath: string, envelope: object, byteLength: number }): void`
  - `peekPendingApproval(approvalHashKey: string): entry | undefined`
  - `clearPendingApprovals(): void`
  - `pendingApprovalCount(): number`

- [ ] **Step 1: Write the failing tests** (`tests/pending-approvals.test.mjs`)

```js
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
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test tests/pending-approvals.test.mjs`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement**

`workflow-kernel/constants.js` (after the `MAX_SOURCE_BYTES` line):

```js
// Bound for the in-memory pending-approval store (approve-by-reference). Worst case memory is
// MAX_PENDING_APPROVALS * MAX_SOURCE_BYTES (16 * 512 KiB = 8 MiB); typical sources are a few KiB.
export const MAX_PENDING_APPROVALS = 16;
```

`workflow-kernel/pending-approvals.js`:

```js
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
```

- [ ] **Step 4: Run to verify pass**

Run: `node --test tests/pending-approvals.test.mjs` — expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add workflow-kernel/pending-approvals.js workflow-kernel/constants.js tests/pending-approvals.test.mjs
git commit -m "feat: bounded module-level pending-approval store"
```

---

### Task 4: Regression baseline — pin the oscillation as executable spec

Adapt the investigation's scratch repro into the suite *before* any behavior changes, so Tasks 5–7 evolve against a pinned baseline. These tests pass against today's kernel.

**Files:**
- Create: `tests/inline-approval-rekey.test.mjs`

**Interfaces:**
- Consumes: `makeHarness` from `./helpers/harness.mjs`; the real `tools.workflow_run.execute(args, context)`.
- Produces: the shared helpers `SOURCE`, `approvalHashFromJsonPreview(previewOutput)` used by Tasks 5–7's added tests in this same file.

- [ ] **Step 1: Write the tests** (`tests/inline-approval-rekey.test.mjs`)

```js
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";

import { makeHarness } from "./helpers/harness.mjs";

// Regression suite for the 2026-07-08 bug report: "inline-source workflow_run approvals kept
// re-keying between two hashes and couldn't lock; running by name worked immediately."
// Root cause: the stateless approve call must re-send the inline source byte-identically; any
// re-emission drift re-keys sourceHash -> approvalHash, and each mismatch advertises the hash of
// the just-sent variant, so two alternating emissions bounce between exactly two hashes.

const SOURCE = `export const meta = { name: "rekey-repro", profile: "read-only-review", maxAgents: 0 };
return 1;`;

function approvalHashFromJsonPreview(previewOutput) {
  const parsed = JSON.parse(previewOutput);
  assert.equal(parsed.type, "workflow_preview");
  assert.equal(parsed.status, "approval_required");
  assert.match(parsed.approvalHash, /^[a-f0-9]{64}$/);
  return parsed.approvalHash;
}

function assertNotMismatch(result) {
  let parsed = null;
  try {
    parsed = JSON.parse(result);
  } catch {
    return; // prose output means real execution happened
  }
  assert.notEqual(parsed.type, "workflow_approval_mismatch", `unexpected mismatch: ${result}`);
}

test("byte-identical inline source across separately-constructed args hashes identically", async () => {
  const { tools, context, directory } = await makeHarness(async () => ({ data: { parts: [], info: {} } }));
  try {
    const baseArgs = { source: SOURCE, format: "json" };
    const hash1 = approvalHashFromJsonPreview(await tools.workflow_run.execute(JSON.parse(JSON.stringify(baseArgs)), context));
    const hash2 = approvalHashFromJsonPreview(await tools.workflow_run.execute(JSON.parse(JSON.stringify(baseArgs)), context));
    assert.equal(hash1, hash2);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("approve:true with the matching hash and identical source executes", async () => {
  const { tools, context, directory } = await makeHarness(async () => ({ data: { parts: [], info: {} } }));
  try {
    const hash = approvalHashFromJsonPreview(await tools.workflow_run.execute({ source: SOURCE, format: "json" }, context));
    const result = await tools.workflow_run.execute({ source: SOURCE, format: "json", approve: true, approvalHash: hash }, context);
    assertNotMismatch(result);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("one-byte source drift between calls reproduces the two-hash oscillation", async () => {
  const { tools, context, directory } = await makeHarness(async () => ({ data: { parts: [], info: {} } }));
  try {
    const hashA = approvalHashFromJsonPreview(await tools.workflow_run.execute({ source: SOURCE, format: "json" }, context));

    // Drifted re-emission (trailing newline), supplying the hash the preview advertised.
    const mismatch1 = JSON.parse(await tools.workflow_run.execute(
      { source: `${SOURCE}\n`, format: "json", approve: true, approvalHash: hashA },
      context,
    ));
    assert.equal(mismatch1.type, "workflow_approval_mismatch");
    assert.equal(mismatch1.reason, "approval_hash_mismatch");
    assert.equal(mismatch1.executed, false);
    assert.equal(mismatch1.suppliedApprovalHash, hashA);
    const hashB = mismatch1.freshApprovalHash;
    assert.notEqual(hashB, hashA);

    // Retry with the advertised fresh hash but the ORIGINAL bytes: the bounce flips back to hashA.
    const mismatch2 = JSON.parse(await tools.workflow_run.execute(
      { source: SOURCE, format: "json", approve: true, approvalHash: hashB },
      context,
    ));
    assert.equal(mismatch2.type, "workflow_approval_mismatch");
    assert.equal(mismatch2.suppliedApprovalHash, hashB);
    assert.equal(mismatch2.freshApprovalHash, hashA);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run to verify these pass TODAY (baseline, not TDD-red)**

Run: `node --test tests/inline-approval-rekey.test.mjs`
Expected: PASS (3/3). These pin current behavior; later tasks extend this file.

- [ ] **Step 3: Commit**

```bash
git add tests/inline-approval-rekey.test.mjs
git commit -m "test: pin inline approval two-hash oscillation as a regression baseline"
```

---

### Task 5: Normalize JSON-string args bags for all workflows

The tool schema declares `args` object-typed (`workflow-plugin.js:2702-2706`), but some models emit it as a JSON-encoded string under permissive hosts; only the drain harness parses it today (`authority-policy.js:412-424`). A string bag hashes differently from its object equivalent (`runtimeArgs` enters the envelope verbatim) — a second re-key vector, confirmed live. Generalize: parse-or-throw at plan time for non-drain workflows too. Drain keeps its exact current path and error type.

**Files:**
- Modify: `workflow-kernel/authority-policy.js` (new export after `authorityArgsForWorkflow`, ~line 442)
- Modify: `workflow-kernel/workflow-plugin.js:1665-1666` (wire-in) and the `./authority-policy.js` import block (~line 133)
- Test: `tests/inline-approval-rekey.test.mjs`

**Interfaces:**
- Consumes: `WorkflowAuthorityError` from `./errors.js` (already imported in authority-policy.js).
- Produces: `parseRuntimeArgsString(rawRuntime)` — returns non-strings unchanged; a string is JSON-parsed and must decode to a plain object, else throws `WorkflowAuthorityError`.

- [ ] **Step 1: Write the failing tests** (append to `tests/inline-approval-rekey.test.mjs`)

```js
test("args bag as JSON string and as object hash to the same approvalHash", async () => {
  const { tools, context, directory } = await makeHarness(async () => ({ data: { parts: [], info: {} } }));
  try {
    const source = `export const meta = { name: "rekey-args", profile: "read-only-review", maxAgents: 0 };
return args;`;
    const payload = { mode: "first", n: 1 };
    const hashObject = approvalHashFromJsonPreview(await tools.workflow_run.execute({ source, format: "json", args: payload }, context));
    const hashString = approvalHashFromJsonPreview(await tools.workflow_run.execute({ source, format: "json", args: JSON.stringify(payload) }, context));
    assert.equal(hashObject, hashString);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("a non-JSON string args bag fails loudly at plan time", async () => {
  const { tools, context, directory } = await makeHarness(async () => ({ data: { parts: [], info: {} } }));
  try {
    await assert.rejects(
      tools.workflow_run.execute({ source: SOURCE, format: "json", args: "not json" }, context),
      /JSON object.*not a JSON-encoded string/s,
    );
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test tests/inline-approval-rekey.test.mjs`
Expected: FAIL — hashes differ in the first test; second test sees no rejection.

- [ ] **Step 3: Implement**

`workflow-kernel/authority-policy.js` (after `authorityArgsForWorkflow`):

```js
// Generalizes the drain-only JSON-string tolerance above to every workflow: under a permissive
// host a model may emit the `args` bag as a JSON-encoded string even though the tool schema
// declares an object. A string that decodes to a plain object is normalized so the approval
// envelope hashes the SAME runtimeArgs for the string and object emissions (otherwise the two
// forms re-key approvalHash against each other). Anything else fails loudly here, at plan time.
export function parseRuntimeArgsString(rawRuntime) {
  if (typeof rawRuntime !== "string") return rawRuntime;
  let parsed;
  try {
    parsed = JSON.parse(rawRuntime);
  } catch {
    throw new WorkflowAuthorityError(
      "workflow args must be a JSON object when provided; got a string that is not valid JSON. Pass args as a JSON object, not a JSON-encoded string.",
    );
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new WorkflowAuthorityError(
      `workflow args must be a JSON object when provided; the supplied JSON string decodes to ${Array.isArray(parsed) ? "an array" : typeof parsed}. Pass args as a JSON object, not a JSON-encoded string.`,
    );
  }
  return parsed;
}
```

`workflow-kernel/workflow-plugin.js` — add `parseRuntimeArgsString` to the `./authority-policy.js` import block (line ~133), then extend the canonicalization site:

```js
  args = authorityArgsForWorkflow(meta, args);
  // Same model-stringification tolerance for non-drain workflows (drain normalizes above, keeping
  // its own error type): decode a JSON-string args bag into the object it encodes BEFORE the
  // argsSchema check and the approval envelope, so string and object emissions of one payload
  // cannot hash to different approvalHashes.
  if (meta.harness !== "drain" && typeof args.args === "string") {
    args = { ...args, args: parseRuntimeArgsString(args.args) };
  }
  assertWorkflowArgsMatchSchema(meta, args.args);
```

- [ ] **Step 4: Run to verify pass, then full suite**

Run: `node --test tests/inline-approval-rekey.test.mjs` — expected: PASS.
Run: `node --test tests/*.test.mjs` — expected: all pass (drain tests unaffected: the new branch is `meta.harness !== "drain"` only).

- [ ] **Step 5: Commit**

```bash
git add workflow-kernel/authority-policy.js workflow-kernel/workflow-plugin.js tests/inline-approval-rekey.test.mjs
git commit -m "fix: normalize JSON-string args bags for all workflows so string/object emissions hash identically"
```

---

### Task 6: Approve-by-reference

Record every preview (and every mismatch's fresh envelope) in the pending store; let an approve call present only `{ approve: true, approvalHash }` and reuse the previewed **inline** source. The injected bytes still flow through `planWorkflowEnvelope` and the exact-hash compare, so nothing executes that the presented hash does not bind. Scope: inline envelopes only — injecting stored bytes for a path-backed preview would flip `sourcePath` to `"<inline>"` and guarantee a mismatch; by-name callers just resend the slug.

**Files:**
- Modify: `workflow-kernel/workflow-plugin.js`:
  - import block: add `approvalEnvelope` to the `./approval-hashing.js` import (lines ~70-73); add a new import for `./pending-approvals.js`
  - `startWorkflow` (lines 1833-1838): injection + recording
  - new helper `pendingApprovalEntry` next to `approvalMismatchResponse` (~line 807)
  - `approvalPreviewEnvelope` (~line 670): add `approveByReference: true` after `approvalHash`
  - `approvalSummary` (~line 799): append one line (do not modify existing lines)
  - `dispose` hook (line 2685-2687): clear the store
- Test: `tests/inline-approval-rekey.test.mjs`

**Interfaces:**
- Consumes: `recordPendingApproval`, `peekPendingApproval`, `clearPendingApprovals` (Task 3); `approvalEnvelope` (existing); `hasExplicitWorkflowSource` (already imported, line 147).
- Produces: approve-by-reference protocol; `pendingApprovalEntry(run, source)` helper reused by Task 7; JSON previews carry `approveByReference: true`.

- [ ] **Step 1: Write the failing tests** (append to `tests/inline-approval-rekey.test.mjs`)

```js
test("approve-by-reference: approve with only approvalHash reuses the previewed inline source", async () => {
  const { tools, context, directory } = await makeHarness(async () => ({ data: { parts: [], info: {} } }));
  try {
    const preview = JSON.parse(await tools.workflow_run.execute({ source: SOURCE, format: "json" }, context));
    assert.equal(preview.approveByReference, true);
    const result = await tools.workflow_run.execute(
      { approve: true, approvalHash: preview.approvalHash, format: "json" },
      context,
    );
    assertNotMismatch(result);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("approve-by-reference after a drift mismatch recovers using freshApprovalHash alone", async () => {
  const { tools, context, directory } = await makeHarness(async () => ({ data: { parts: [], info: {} } }));
  try {
    const hashA = approvalHashFromJsonPreview(await tools.workflow_run.execute({ source: SOURCE, format: "json" }, context));
    const mismatch = JSON.parse(await tools.workflow_run.execute(
      { source: `${SOURCE}\n`, format: "json", approve: true, approvalHash: hashA },
      context,
    ));
    // The escape hatch from the oscillation: no source re-transmission on the retry.
    const result = await tools.workflow_run.execute(
      { approve: true, approvalHash: mismatch.freshApprovalHash, format: "json" },
      context,
    );
    assertNotMismatch(result);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("approve-by-reference with an unknown hash fails loudly with recovery guidance", async () => {
  const { tools, context, directory } = await makeHarness(async () => ({ data: { parts: [], info: {} } }));
  try {
    await assert.rejects(
      tools.workflow_run.execute({ approve: true, approvalHash: "0".repeat(64) }, context),
      /no pending preview.*Re-run the preview/s,
    );
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test tests/inline-approval-rekey.test.mjs`
Expected: FAIL — first test: `approveByReference` undefined; second/third: "Provide `source`, `scriptPath`, or `name`" instead of the new behaviors.

- [ ] **Step 3: Implement**

Imports in `workflow-kernel/workflow-plugin.js`: extend the approval-hashing import to
`import { approvalEnvelope, approvalSnapshotList, approvalHash, computeDiffPlanHash } from "./approval-hashing.js";` (match the existing names at lines 70-73 — keep whatever is already there and add `approvalEnvelope`), and add:

```js
import { clearPendingApprovals, peekPendingApproval, recordPendingApproval } from "./pending-approvals.js";
```

Helper (place directly above `approvalMismatchResponse`, ~line 807):

```js
// Snapshot of a previewed envelope for the pending store: the exact source bytes (reused by an
// approve-by-reference call) plus the hashed envelope (diffed field-by-field on mismatch).
function pendingApprovalEntry(run, source) {
  return {
    source,
    sourcePath: run.sourcePath,
    envelope: approvalEnvelope(run),
    byteLength: run.sourceMetadata?.byteLength ?? Buffer.byteLength(source, "utf8"),
  };
}
```

`startWorkflow` — replace lines 1833-1838 with:

```js
async function startWorkflow(pluginContext, toolContext, args) {
  assertWriteWorkflowAllowed(toolContext, "workflow_run");
  // Approve-by-reference: an approve call may omit source/scriptPath/name and present only the
  // approvalHash from a prior preview in this process; the previewed source bytes are reused from
  // the in-memory pending store. This removes the need to re-transmit a large inline source
  // byte-identically (re-emission drift re-keys sourceHash and can never lock). The stored bytes
  // still flow through planWorkflowEnvelope and the exact-hash compare below, so nothing executes
  // that the presented approvalHash does not bind.
  if (args.approve === true && !hasExplicitWorkflowSource(args) && !args.resumeRunId && typeof args.approvalHash === "string") {
    const pending = peekPendingApproval(args.approvalHash);
    if (!pending) {
      throw new Error(
        `approvalHash ${args.approvalHash} has no pending preview in this process (the store is in-memory, bounded, and cleared on restart). Re-run the preview, or re-send the full source/scriptPath/name with approve: true.`,
      );
    }
    if (pending.sourcePath !== "<inline>") {
      throw new Error(
        `approvalHash ${args.approvalHash} was previewed from ${pending.sourcePath}; re-send the same name/scriptPath with approve: true (approve-by-reference applies to inline source only).`,
      );
    }
    args = { ...args, source: pending.source };
  }
  const { resumeRunId, resumeEntry, priorState, source, body, adapter, meta, approval } = await planWorkflowEnvelope(pluginContext, toolContext, args);
  const approvedHash = approvalHash(approval);
  const autoApproved = args.approve === true ? null : workflowAutoApproval(pluginContext, args, approval);
  if (args.approve !== true && !autoApproved) {
    recordPendingApproval(approvedHash, pendingApprovalEntry(approval, source));
    return approvalPreviewResponse(approval, args);
  }
  if (args.approve === true && args.approvalHash !== approvedHash) {
    // Record the fresh envelope too: the agent's next call may approve freshApprovalHash by
    // reference instead of re-transmitting the source yet again.
    recordPendingApproval(approvedHash, pendingApprovalEntry(approval, source));
    return approvalMismatchResponse(approval, args);
  }
```

(The remainder of `startWorkflow` — the destructuring at old lines 1839-1860 onward — is unchanged.)

`approvalPreviewEnvelope` (~line 670), after the `approvalHash: approvedHash,` line:

```js
    approveByReference: true,
```

`approvalSummary` (~line 799) — append a NEW line after the existing final line (existing lines stay verbatim):

```js
    "Re-run with approve: true and approvalHash set to this approvalHash to execute this exact workflow envelope.",
    "Inline-source callers may instead omit source on that approve call: the previewed bytes are retained in-memory for this approvalHash (bounded store, cleared on restart), avoiding byte-identical re-transmission drift.",
```

`dispose` hook (line 2685):

```js
    dispose: async () => {
      clearNotificationRuntimeState();
      clearPendingApprovals();
    },
```

- [ ] **Step 4: Run to verify pass, then full suite**

Run: `node --test tests/inline-approval-rekey.test.mjs` — expected: PASS.
Run: `node --test tests/*.test.mjs` — expected: all pass. If any preview-shape test asserts an exact JSON key set, add `approveByReference` to its expectation.

- [ ] **Step 5: Commit**

```bash
git add workflow-kernel/workflow-plugin.js tests/inline-approval-rekey.test.mjs
git commit -m "feat: approve-by-reference — approve inline previews by hash without re-transmitting source"
```

---

### Task 7: Field-level mismatch diagnostics

When an approve mismatches, diff the stored envelope for the *supplied* hash against the fresh one and name exactly what changed; add a targeted hint for inline source drift.

**Files:**
- Modify: `workflow-kernel/workflow-plugin.js` — `approvalMismatchResponse` (~line 807); add `approvalEnvelopeDiff` to the `./approval-hashing.js` import
- Test: `tests/inline-approval-rekey.test.mjs`; check `tests/workflow-run.test.mjs:1113` ("approve:true with missing or stale approvalHash…") for pinned message text

**Interfaces:**
- Consumes: `approvalEnvelopeDiff` (Task 2), `peekPendingApproval` + `pendingApprovalEntry` (Tasks 3/6).
- Produces: mismatch JSON gains `changedFields: Array<{field,before,after}> | null` and, for inline source drift, `hint: string`.

- [ ] **Step 1: Write the failing tests** (append to `tests/inline-approval-rekey.test.mjs`)

```js
test("mismatch response names the drifted field and hints at inline re-transmission drift", async () => {
  const { tools, context, directory } = await makeHarness(async () => ({ data: { parts: [], info: {} } }));
  try {
    const hashA = approvalHashFromJsonPreview(await tools.workflow_run.execute({ source: SOURCE, format: "json" }, context));
    const mismatch = JSON.parse(await tools.workflow_run.execute(
      { source: `${SOURCE}\n`, format: "json", approve: true, approvalHash: hashA },
      context,
    ));
    assert.deepEqual(mismatch.changedFields.map((entry) => entry.field), ["sourceHash"]);
    assert.match(mismatch.hint, /re-transmission drift/);
    assert.match(mismatch.hint, /workflow_save/);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("mismatch from changed runtime args names runtimeArgs and carries no inline-drift hint", async () => {
  const { tools, context, directory } = await makeHarness(async () => ({ data: { parts: [], info: {} } }));
  try {
    const source = `export const meta = { name: "rekey-args-drift", profile: "read-only-review", maxAgents: 0 };
return args;`;
    const hash = approvalHashFromJsonPreview(await tools.workflow_run.execute({ source, format: "json", args: { n: 1 } }, context));
    const mismatch = JSON.parse(await tools.workflow_run.execute(
      { source, format: "json", args: { n: 2 }, approve: true, approvalHash: hash },
      context,
    ));
    assert.deepEqual(mismatch.changedFields.map((entry) => entry.field), ["runtimeArgs"]);
    assert.equal(mismatch.hint, undefined);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("mismatch with a hash the store has never seen reports changedFields: null", async () => {
  const { tools, context, directory } = await makeHarness(async () => ({ data: { parts: [], info: {} } }));
  try {
    const mismatch = JSON.parse(await tools.workflow_run.execute(
      { source: SOURCE, format: "json", approve: true, approvalHash: "f".repeat(64) },
      context,
    ));
    assert.equal(mismatch.status, "approval_mismatch");
    assert.equal(mismatch.changedFields, null);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test tests/inline-approval-rekey.test.mjs`
Expected: FAIL — `changedFields` undefined.

- [ ] **Step 3: Implement** — replace `approvalMismatchResponse` (add `approvalEnvelopeDiff` to the approval-hashing import first):

```js
function approvalMismatchResponse(run, args) {
  const freshPreview = approvalPreviewEnvelope(run);
  // If the SUPPLIED hash matches a recorded preview, diff that envelope against the fresh one so
  // the caller learns exactly which field re-keyed instead of guessing from two opaque hashes.
  const prior = typeof args.approvalHash === "string" ? peekPendingApproval(args.approvalHash) : undefined;
  const changedFields = prior ? approvalEnvelopeDiff(prior.envelope, approvalEnvelope(run)) : null;
  const inlineSourceDrift = Boolean(prior) && run.sourcePath === "<inline>"
    && (changedFields ?? []).some((entry) => entry.field === "sourceHash");
  return JSON.stringify({
    type: "workflow_approval_mismatch",
    status: "approval_mismatch",
    executed: false,
    reason: typeof args.approvalHash === "string" && args.approvalHash.length > 0 ? "approval_hash_mismatch" : "missing_approval_hash",
    message: "Workflow approval required: nothing executed because approve:true did not include the current approvalHash for this workflow envelope. Review changedFields (when present) and the freshPreview, then re-run with freshApprovalHash if the plan is acceptable — inline-source callers may omit source on that retry (approve-by-reference).",
    suppliedApprovalHash: typeof args.approvalHash === "string" ? args.approvalHash : null,
    freshApprovalHash: freshPreview.approvalHash,
    changedFields,
    ...(inlineSourceDrift
      ? {
          hint:
            `Inline source re-transmission drift: this call's source (sha256 ${run.sourceHash.slice(0, 12)}…, ${run.sourceMetadata.byteLength} bytes) differs from the one previewed under the supplied approvalHash (sha256 ${String(prior.envelope.sourceHash).slice(0, 12)}…, ${prior.byteLength} bytes). ` +
            "Re-approve with approve: true and freshApprovalHash WITHOUT re-sending source, or save the body with workflow_save and run it by name.",
        }
      : {}),
    freshPreview,
  }, null, 2);
}
```

- [ ] **Step 4: Reconcile the existing mismatch-shape test**

Read `tests/workflow-run.test.mjs:1113` ("workflow_run approve:true with missing or stale approvalHash returns approval_mismatch and does not execute"). New fields are additive; if it pins the exact `message` string, update the expected text to the new message above.
Run: `node --test tests/workflow-run.test.mjs tests/inline-approval-rekey.test.mjs` — expected: PASS.

- [ ] **Step 5: Full suite + commit**

Run: `node --test tests/*.test.mjs` — expected: all pass.

```bash
git add workflow-kernel/workflow-plugin.js tests/workflow-run.test.mjs tests/inline-approval-rekey.test.mjs
git commit -m "feat: field-level changedFields diff and inline-drift hint on approval mismatch"
```

---

### Task 8: Agent-facing surface — tool descriptions, docs, skills, changelog

The docs audit found no statement anywhere that the approve call must re-send inline source byte-identically, no drift guidance, and no steer toward `workflow_save` for large bodies. Close all gaps and document the new protocol.

**Files:**
- Modify: `workflow-kernel/workflow-plugin.js` (description strings only, ~lines 2694-2708), `docs/workflow-recipes.md`, `docs/workflow-plugin.md:16`, `README.md`, `skills/opencode-workflow-authoring/SKILL.md`, `skills/workflow-plan-review/SKILL.md`, `CHANGELOG.md`
- Test: `tests/workflow-docs.test.mjs` (existing assertions must stay green), full suite

**Interfaces:** none — prose only; tool behavior was completed in Tasks 5-7.

- [ ] **Step 1: Tool schema strings** (`workflow-kernel/workflow-plugin.js`)

Append to the `workflow_run` `description` (line 2694), before the final sentence about `workflow_apply`:

```
An approve call for an inline-source preview may omit source and present only the approvalHash (approve-by-reference): the previewed bytes are reused from a bounded in-memory store, avoiding byte-identical re-transmission of the source.
```

Replace the `source` describe (line 2699):

```js
        source: tool.schema.string().optional().describe("Inline workflow source: export const meta = {...} plus top-level statements ending in return. Hashed into the approval envelope — an approve call that re-sends it must be byte-identical; prefer omitting it on approve (approve-by-reference), or workflow_save + name for reuse."),
```

Add a describe to `args` (line 2706, keeping the existing comment and `.passthrough()`):

```js
        args: tool.schema.object({}).passthrough().optional().describe("Runtime args bag for the workflow body (a JSON object, not a JSON-encoded string; a stringified object is decoded once and normalized before hashing)."),
```

Replace the `approvalHash` describe (line 2708):

```js
        approvalHash: tool.schema.string().optional().describe("Hash returned by the immediately prior preview for this exact envelope; any envelope change re-keys it (mismatch responses list changedFields). With approve: true and no source/name, the previewed inline source is reused for this hash (approve-by-reference)."),
```

- [ ] **Step 2: `docs/workflow-recipes.md`**

Replace the "Stale `approvalHash`" bullet (lines 175-177):

```markdown
- **Stale `approvalHash`.** If approve fails with a hash mismatch, your `source`
  or `args` changed after the preview — the mismatch response's `changedFields`
  names exactly which envelope field re-keyed. For inline `source` the usual
  cause is re-transmission drift (a single re-typed byte re-keys the hash): do
  not re-send the source on the retry — approve with only `approve: true` and
  the `freshApprovalHash` (approve-by-reference), or `workflow_save` the body
  once and run it by `name`, which re-reads byte-stable bytes from disk. Never
  hand-edit a hash.
```

In the paragraph at lines 104-107 ("Then approve the **exact** envelope…"), append after "by echoing the `approvalHash`:" sentence:

```markdown
For inline `source`, "exact" means byte-identical — re-typing the body drifts
the hash. Prefer approving with only `approve: true` + the `approvalHash`
(the previewed source is retained in-memory), or save once and run by `name`.
```

After the "Option B" line (~line 43: `// Option B: paste the template body as \`source\` into workflow_run (no save needed).`), add:

```markdown
// For large bodies prefer Option A: run-by-name never re-transmits source bytes,
// and inline approve calls otherwise must be byte-identical (or approve-by-reference).
```

- [ ] **Step 3: `README.md`, `docs/workflow-plugin.md`, skills**

`README.md` — **note:** anchor against the COMMITTED README (571 lines; an unrelated
uncommitted rewrite exists only in the main checkout's working tree and must not be
touched). After the paragraph beginning "Workflow authority is approved once at
launch. The approval hash covers the" (~line 203), add a new paragraph:

```markdown
Approving an inline-source preview does not require re-transmitting the source:
an approve call may send only `approve: true` + `approvalHash`, and the
previewed bytes are reused from a bounded in-memory store (approve-by-reference).
A mismatched approve returns `changedFields` naming exactly which envelope
fields re-keyed.
```

`docs/workflow-plugin.md:16` — in the `workflow_run` approval column, after "execution requires `approve: true` plus the matching `approvalHash`.", insert:

```markdown
Inline-source approve calls may omit `source` and present only the hash (approve-by-reference); mismatches return `changedFields` naming the re-keyed envelope fields.
```

`skills/opencode-workflow-authoring/SKILL.md` — in "Launch And Readback" (after the paragraph ending "a per-call `autoApprove` argument may narrow that ceiling."), add:

```markdown
Approving an inline-source preview does not require re-sending the source:
present only `approve: true` + the `approvalHash` and the previewed bytes are
reused (approve-by-reference). Re-sending the source works too but must be
byte-identical — any drift re-keys `sourceHash`/`approvalHash`, and the
mismatch response's `changedFields` will name the drifted field. For bodies
you run more than once, `workflow_save` + run-by-`name` avoids the issue
entirely.
```

`skills/workflow-plan-review/SKILL.md` — in step 5 ("Approve or continue."), append:

```markdown
   For an inline-source preview, approve with only `approve: true` and the matching
   `approvalHash` (no source re-transmission needed — approve-by-reference).
```

- [ ] **Step 4: `CHANGELOG.md`** — add at the top under an `## Unreleased` heading (create it if absent):

```markdown
## Unreleased

### Added
- Approve-by-reference: a `workflow_run` approve call for an inline-source preview may present
  only `approve: true` + `approvalHash`; the previewed source bytes are reused from a bounded
  module-level pending store (cleared on dispose/restart). Eliminates the byte-identical
  re-transmission requirement that made inline approvals oscillate between two hashes.
- Approval mismatches now return `changedFields` (field-level envelope diff vs the supplied
  hash's recorded preview) and an inline re-transmission-drift `hint`.

### Fixed
- Approval envelope (`version` 2 → 3): distinct nested **inline** workflows no longer collapse
  to one snapshot in the hash (they dedup by hash instead of the shared `"<inline>"` path).
- A JSON-string `args` bag is decoded and normalized for every workflow (previously drain-only),
  so string and object emissions of the same payload hash to the same `approvalHash`.
```

- [ ] **Step 5: Verify docs tests and full suite, then commit**

Run: `node --test tests/workflow-docs.test.mjs` — expected: PASS (tool registry still 16; term checks unaffected).
Run: `node --test tests/*.test.mjs` — expected: all pass.

```bash
git add workflow-kernel/workflow-plugin.js docs/workflow-recipes.md docs/workflow-plugin.md README.md skills/opencode-workflow-authoring/SKILL.md skills/workflow-plan-review/SKILL.md CHANGELOG.md
git commit -m "docs: approve-by-reference protocol, byte-identical inline caveat, changedFields diagnostics"
```

---

## Definition of done (whole branch)

- [ ] `node --test tests/*.test.mjs` fully green (656 pre-existing + ~15 new, 0 fail).
- [ ] Every item in `docs/authoring-checklist.md` ticked.
- [ ] All 6 findings addressed: oscillation escape hatch (T6), mismatch diagnosability (T7), docs (T8), regression coverage (T4), nested-inline under-binding (T1), string-args divergence (T5).
- [ ] No pushes; branch left for review/merge decision.
