# Design C — Gate-Subsystem Removal (Trust the Platform) Implementation Plan

> Status: **historical implemented plan**. The Design C trust-model changes
> shipped; branch names, baselines, task checkboxes, and source references below
> preserve the implementation record rather than describe current work.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Delete the LLM-probe live-gate subsystem from the workflow kernel and replace it with deterministic runtime enforcement (typed directory echo, worktree path-distinctness, permission echo, clean-base apply) plus a one-shot server version fingerprint — so agents can launch any workflow profile without pre-flight probe theater, and failures are loud and truthful.

**Architecture:** The kernel currently verifies runtime capabilities by spawning LLM child sessions before launch (`live-gate-probes.js` → `capability-adapter.js` → `requiredGates` enforcement in `workflow-plugin.js`/`sandbox-executor.js`). Design C trusts opencode (the plugin runs *inside* it — same trust domain) and moves every real safety property to a deterministic check at the moment the property is used: session rooting is asserted from the typed `Session.directory` echo at lane creation, worktree isolation is asserted as path-distinctness at worktree creation, permission-rule delivery keeps the existing per-lane echo-mismatch throw, write containment keeps the existing clean-base + diff-plan-hash + rooted-write apply path, and version drift is caught by a memoized `GET /global/health` fingerprint (verified present on opencode 1.17.13: returns `{"healthy":true,"version":"1.17.13"}`) that refuses **elevated** profiles on servers older than the documented minimum.

**Tech Stack:** Node ≥ 20.11 ESM, `node:test` (`npm test` = `node --test tests/*.test.mjs`), `@opencode-ai/sdk` 1.17.13 (v1 client injected into the plugin; v2 client built lazily against `serverUrl` — existing precedent `resolveWorktreeClient`, capability-adapter.js:213-235).

## Global Constraints

- Kernel-only redesign. The beads domain gets **mechanical** updates only (imports/doc trims) — no beads verifier work (separate, undecided fork).
- Every deleted behavioral probe must have its load-bearing property either (a) enforced deterministically at runtime with a loud failure, or (b) consciously dropped per the approved design. No silent-skip paths.
- Keep intact (do not touch): one-time approval-hash flow (`approval-hashing.js` mechanics), git worktree + controller-only apply (`assertGitCleanAtBase` workflow-plugin.js:212-224, `computeDiffPlanHash`, `safeWriteFileWithinRoot` path-policy.js:137-224), lane timeouts/budgets, QuickJS sandbox bounds, `sessionPermissionEchoStatus` mismatch-throw (child-agent-runner.js:120-148, 911-936), the `childSession` shape check (child-agent-runner.js:497), worktree client machinery (`resolveWorktreeClient`/`createWorktree`/`removeWorktree`/`hasWorktreeClient`), audited-shell **live** code (`AUDITED_SHELL_ALLOWLIST`, `AUDITED_SHELL_DENY`, `SHELL_PERMISSION_DENY_PATTERNS`, `auditedShellPermissionPatterns` — consumed at authority-policy.js:378).
- `requiredGates` vocabulary is **deleted** (profiles, constant, preview field, drain funnel) — not renamed, not re-produced.
- Minimum server version constant: `MIN_OPENCODE_SERVER_VERSION = "1.17.13"` (the floor we verified `/global/health` + typed `Session.directory` + session `permission` config against).
- Working tree already has uncommitted changes (the `opencode-workflows-0y5f` arg-normalization + readiness-gate fixes). Task 1 commits those separately before any Design C change.
- Never push. Local commits only, one per task, message suffix `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- Green baseline: `npm test` (87 test files, ~1060 tests) must pass at the end of every task **except** Tasks 7–10 which are one coordinated red→green arc; the suite must be fully green again at Task 10's end.
- The repo is the live installed plugin (`~/.config/opencode/plugins/opencode-workflows` symlinks here). Do not leave the tree in a broken state between work sessions any longer than a task boundary requires.

---

### Task 1: Commit pre-existing work, then fix the truthful-status bug

**Files:**
- Modify: `workflow-kernel/workflow-plugin.js:1233-1249`
- Test: `tests/workflow-run.test.mjs` (append new test near the other drain-status tests, after line ~2700)

**Interfaces:**
- Produces: zero-patch failed drains land on `run.status === "failed"`; all later tasks and the E2E assert against this.

- [ ] **Step 1: Commit the pre-existing 0y5f working-tree changes as their own commit**

```bash
git add -A
git commit -m "fix(drain): normalize stringified workflow_run args and drop ready-for-agent drain gate (opencode-workflows-0y5f)

Pre-existing working-tree fixes committed separately from the Design C gate-simplification work.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

- [ ] **Step 2: Write the failing test**

In `tests/workflow-run.test.mjs`, mirror the structure of the existing drain-workflow tests (see the drain tests between lines 2308-2894 that build a drain workflow via `makeHarness` and stub `__workflowLiveGates`; copy the closest zero-patch drain test's scaffolding). The new test drives a `harness: "drain"` workflow whose adapter/lanes produce a drain body result `{ status: "failed", failed: [{ itemId: "x" }] }` **and zero editPlan patches**, then asserts:

```js
test("a fully-failed drain with zero patches reports run status failed, not completed", async () => {
  // ...scaffold copied from the nearest zero-patch drain test...
  const status = JSON.parse(await tools.workflow_status.execute({ runId, format: "json" }, context));
  assert.equal(status.status, "failed");
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `node --test tests/workflow-run.test.mjs --test-name-pattern "fully-failed drain"`
Expected: FAIL — actual status is `"completed"`.

- [ ] **Step 4: Fix the else branch**

`workflow-kernel/workflow-plugin.js` lines 1246-1249 currently:

```js
    } else {
      run.editPlan = undefined;
      run.status = "completed";
    }
```

Change to:

```js
    } else {
      run.editPlan = undefined;
      // A drain that failed without producing any patches must not read as success:
      // drainFailed (line ~1172) already detects failed/not_dry/max_waves_exceeded/
      // budget_exhausted drain bodies. Zero patches + failed drain => failed run.
      run.status = drainFailed ? "failed" : "completed";
    }
```

Then check the event-type selection at line ~1260 and `writeCompletionNotification` (lifecycle-control.js:129-157): confirm a `"failed"` status maps to the failure event/notification wording (grep for how existing `"failed"` runs from lane errors set status; reuse that path — no new event types).

- [ ] **Step 5: Run test to verify it passes, then the whole file**

Run: `node --test tests/workflow-run.test.mjs`
Expected: PASS (all).

- [ ] **Step 6: Commit**

```bash
git add workflow-kernel/workflow-plugin.js tests/workflow-run.test.mjs
git commit -m "fix(kernel): report zero-patch failed drains as failed, not completed

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: Relocate `unwrapClientResult` into capability-adapter.js

**Files:**
- Modify: `workflow-kernel/capability-adapter.js` (add definition; remove it from the live-gate-probes re-export block at :722-753)
- Modify: `workflow-kernel/live-gate-probes.js:91-97` (remove definition; import from capability-adapter instead)

**Interfaces:**
- Produces: `unwrapClientResult(result, label)` exported **from** `capability-adapter.js` as a first-class definition. Consumers (`child-agent-runner.js:59`, `sandbox-executor.js:59`, `workflow-plugin.js:64`) already import from `capability-adapter.js` — zero changes there.

- [ ] **Step 1: Move the definition**

Copy the exact function body from `live-gate-probes.js:91-97` into `capability-adapter.js` (near `readInstalledVersion`, ~line 148), exported. Delete it from `live-gate-probes.js` and add `import { unwrapClientResult } from "./capability-adapter.js";` there (probe code uses it until Task 7 deletes the file). Remove `unwrapClientResult` from the re-export block at capability-adapter.js:722-753 (it is now a local export).

- [ ] **Step 2: Verify no circular-import breakage and suite green**

Run: `node --test tests/live-gate-probes.test.mjs tests/capability-adapter.test.mjs tests/child-agent-runner.test.mjs && npm test`
Expected: PASS. (capability-adapter already imports from live-gate-probes; the new reverse import creates a cycle — Node ESM tolerates it for function declarations, but if the suite errors on TDZ, instead relocate `unwrapClientResult` to `workflow-kernel/text-json.js` and import it in both files from there.)

- [ ] **Step 3: Commit**

```bash
git add workflow-kernel/capability-adapter.js workflow-kernel/live-gate-probes.js
git commit -m "refactor(kernel): make unwrapClientResult a first-class capability-adapter export

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Server version fingerprint module

**Files:**
- Create: `workflow-kernel/server-fingerprint.js`
- Test: `tests/server-fingerprint.test.mjs`
- Modify: `workflow-kernel/constants.js` (add `MIN_OPENCODE_SERVER_VERSION`)

**Interfaces:**
- Produces: `serverFingerprint(pluginContext) -> Promise<{ state: "ok"|"too-old"|"unreachable"|"unknown", version?: string, minimum: string, evidence: string }>` — memoized per `serverUrl` (bounded, module-level Map). `assertServerSupportsElevatedAuthority(fingerprint)` — throws `WorkflowAuthorityError` when `state` is `"too-old"`; passes on `"ok"`; passes on `"unreachable"`/`"unknown"` (a dead server fails loud at first `session.create` anyway — the fingerprint's job is version detection, not liveness).
- Consumes: `pluginContext.serverUrl`; dynamic `@opencode-ai/sdk/v2/client` import (mirror `resolveWorktreeClient`, capability-adapter.js:213-235); `WorkflowAuthorityError` from `errors.js`.

- [ ] **Step 1: Write failing tests**

`tests/server-fingerprint.test.mjs` (new file, node:test, ESM):

```js
import test from "node:test";
import assert from "node:assert/strict";
import {
  compareServerVersion,
  classifyHealthResult,
  assertServerSupportsElevatedAuthority,
  __resetFingerprintCacheForTests,
} from "../workflow-kernel/server-fingerprint.js";
import { MIN_OPENCODE_SERVER_VERSION } from "../workflow-kernel/constants.js";

test("compareServerVersion orders dotted versions numerically", () => {
  assert.equal(compareServerVersion("1.17.13", "1.17.13"), 0);
  assert.ok(compareServerVersion("1.17.12", "1.17.13") < 0);
  assert.ok(compareServerVersion("1.18.0", "1.17.13") > 0);
  assert.ok(compareServerVersion("1.17.13-beta.1", "1.17.13") < 0);
});

test("classifyHealthResult maps health payloads to fingerprint states", () => {
  assert.deepEqual(
    classifyHealthResult({ data: { healthy: true, version: "1.17.13" } }, MIN_OPENCODE_SERVER_VERSION).state,
    "ok",
  );
  assert.equal(
    classifyHealthResult({ data: { healthy: true, version: "1.16.0" } }, MIN_OPENCODE_SERVER_VERSION).state,
    "too-old",
  );
  // 404 / route-missing => the server predates /global/health => too old to verify.
  assert.equal(classifyHealthResult({ error: { status: 404 } }, MIN_OPENCODE_SERVER_VERSION).state, "too-old");
  // Malformed payload => unknown (do not block; not proof of age).
  assert.equal(classifyHealthResult({ data: { healthy: true } }, MIN_OPENCODE_SERVER_VERSION).state, "unknown");
});

test("assertServerSupportsElevatedAuthority throws only on too-old", () => {
  assert.throws(
    () => assertServerSupportsElevatedAuthority({ state: "too-old", version: "1.16.0", minimum: MIN_OPENCODE_SERVER_VERSION, evidence: "x" }),
    /requires opencode server >= /,
  );
  assertServerSupportsElevatedAuthority({ state: "ok", version: "1.17.13", minimum: MIN_OPENCODE_SERVER_VERSION, evidence: "x" });
  assertServerSupportsElevatedAuthority({ state: "unreachable", minimum: MIN_OPENCODE_SERVER_VERSION, evidence: "x" });
  assertServerSupportsElevatedAuthority({ state: "unknown", minimum: MIN_OPENCODE_SERVER_VERSION, evidence: "x" });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test tests/server-fingerprint.test.mjs`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `workflow-kernel/server-fingerprint.js`**

```js
// Deterministic replacement for the deleted live-gate probe preflight (Design C).
// One memoized GET /global/health per serverUrl answers "which opencode is this?";
// elevated authority refuses servers older than MIN_OPENCODE_SERVER_VERSION, where
// the typed Session.directory echo and session permission config are unverified.
// Liveness is intentionally NOT this module's job: an unreachable server fails loud
// at the first session.create, so "unreachable"/"unknown" do not block launch.
import { WorkflowAuthorityError } from "./errors.js";
import { MIN_OPENCODE_SERVER_VERSION } from "./constants.js";

const fingerprintCache = new Map(); // serverUrl -> Promise<fingerprint>
const FINGERPRINT_CACHE_MAX = 8;

export function compareServerVersion(a, b) {
  const parse = (v) => {
    const [core, pre] = String(v).split("-", 2);
    return { parts: core.split(".").map((n) => Number.parseInt(n, 10) || 0), pre };
  };
  const va = parse(a), vb = parse(b);
  for (let i = 0; i < Math.max(va.parts.length, vb.parts.length); i += 1) {
    const d = (va.parts[i] ?? 0) - (vb.parts[i] ?? 0);
    if (d !== 0) return d;
  }
  if (Boolean(va.pre) !== Boolean(vb.pre)) return va.pre ? -1 : 1;
  return 0;
}

export function classifyHealthResult(result, minimum) {
  const status = result?.error?.status ?? result?.response?.status;
  if (result?.error !== undefined) {
    if (status === 404) {
      return { state: "too-old", minimum, evidence: `GET /global/health returned 404; servers >= ${minimum} implement it` };
    }
    return { state: "unknown", minimum, evidence: `GET /global/health errored (status=${status ?? "none"})` };
  }
  const version = result?.data?.version;
  if (typeof version !== "string" || version === "") {
    return { state: "unknown", minimum, evidence: "health payload had no version string" };
  }
  if (compareServerVersion(version, minimum) < 0) {
    return { state: "too-old", version, minimum, evidence: `server ${version} < required ${minimum}` };
  }
  return { state: "ok", version, minimum, evidence: `server ${version} >= ${minimum}` };
}

export async function serverFingerprint(pluginContext) {
  const key = String(pluginContext?.serverUrl ?? "");
  if (!fingerprintCache.has(key)) {
    if (fingerprintCache.size >= FINGERPRINT_CACHE_MAX) fingerprintCache.clear();
    fingerprintCache.set(key, probeHealth(pluginContext).catch((error) => {
      fingerprintCache.delete(key);
      return { state: "unreachable", minimum: MIN_OPENCODE_SERVER_VERSION, evidence: String(error?.message ?? error) };
    }));
  }
  return fingerprintCache.get(key);
}

async function probeHealth(pluginContext) {
  // Test seam mirrors __workflowCapabilities: lets unit tests inject a health result.
  const forced = pluginContext?.__workflowServerHealth;
  if (forced !== undefined) return classifyHealthResult(forced, MIN_OPENCODE_SERVER_VERSION);
  const { createOpencodeClient } = await import("@opencode-ai/sdk/v2/client");
  const v2 = createOpencodeClient({ baseUrl: new URL(String(pluginContext.serverUrl)).origin });
  const result = await v2.global.health();
  return classifyHealthResult(result, MIN_OPENCODE_SERVER_VERSION);
}

export function assertServerSupportsElevatedAuthority(fingerprint) {
  if (fingerprint?.state === "too-old") {
    throw new WorkflowAuthorityError(
      `Elevated workflow authority requires opencode server >= ${fingerprint.minimum}; detected ${fingerprint.version ?? "pre-/global/health server"} (${fingerprint.evidence}). Upgrade opencode or run a read-only profile.`,
    );
  }
}

export function __resetFingerprintCacheForTests() {
  fingerprintCache.clear();
}
```

Add to `workflow-kernel/constants.js` (near the timeout constants, ~line 99):

```js
// Floor verified against a live opencode 1.17.13: GET /global/health exists and
// returns {healthy,version}; Session.directory is a typed required create echo.
export const MIN_OPENCODE_SERVER_VERSION = "1.17.13";
```

Check the actual v2 client result shape while implementing: recon confirmed `GlobalHealthResponses` `200: { healthy: true; version: string }`; the HeyAPI client returns `{ data, error, response }` envelopes (same shape `resolveWorktreeClient` handles). Adjust `classifyHealthResult`'s error-status extraction to whatever the v2 client actually exposes (`result.response.status` per HeyAPI convention) and keep the tests as the contract.

- [ ] **Step 4: Run tests**

Run: `node --test tests/server-fingerprint.test.mjs && npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add workflow-kernel/server-fingerprint.js workflow-kernel/constants.js tests/server-fingerprint.test.mjs
git commit -m "feat(kernel): memoized /global/health server version fingerprint

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: Deterministic lane assertions — directory echo + worktree path-distinctness

**Files:**
- Modify: `workflow-kernel/child-agent-runner.js` (new echo assertion after session create ~line 897; distinctness assertion in `createEditWorktree` ~line 383)
- Test: `tests/child-agent-runner.test.mjs`

**Interfaces:**
- Produces: `sessionDirectoryEchoStatus(created, expectedDirectory) -> { state: "verified"|"mismatch"|"not-echoed", echoed?, expected }` (exported for tests); lanes throw `WorkflowAuthorityError` on `mismatch`; `createEditWorktree` throws when the created worktree path resolves to the primary directory.
- Consumes: nothing new; sits beside `sessionPermissionEchoStatus` (child-agent-runner.js:120-148) and mirrors its projection/event handling (lines 911-936).

- [ ] **Step 1: Write failing tests**

Append to `tests/child-agent-runner.test.mjs` (mirror the import style at the top of that file — it imports internals from `../workflow-kernel/child-agent-runner.js`):

```js
test("sessionDirectoryEchoStatus verifies the typed create echo", () => {
  assert.equal(sessionDirectoryEchoStatus({ data: { id: "s", directory: "/tmp/lane-a" } }, "/tmp/lane-a").state, "verified");
  assert.equal(sessionDirectoryEchoStatus({ data: { id: "s", directory: "/tmp/other" } }, "/tmp/lane-a").state, "mismatch");
  assert.equal(sessionDirectoryEchoStatus({ data: { id: "s" } }, "/tmp/lane-a").state, "not-echoed");
});

test("sessionDirectoryEchoStatus tolerates symlink-realpath divergence", async (t) => {
  // The plugin repo itself is reached via a symlinked config dir in production;
  // the server may echo the realpath of the directory it was given.
  const real = await fs.mkdtemp(path.join(os.tmpdir(), "echo-real-"));
  const link = `${real}-link`;
  await fs.symlink(real, link);
  t.after(() => fs.rm(real, { recursive: true, force: true }).then(() => fs.rm(link, { force: true })));
  assert.equal(sessionDirectoryEchoStatus({ data: { id: "s", directory: real } }, link).state, "verified");
});
```

Plus a `createEditWorktree` distinctness test: copy the existing edit-worktree test scaffolding in the same file (grep `createEditWorktree` there), stub the adapter's `createWorktree` to return `{ path: <primary directory> }`, and assert the lane throws `/worktree path resolves to the primary tree/`.

- [ ] **Step 2: Run to verify failure**

Run: `node --test tests/child-agent-runner.test.mjs --test-name-pattern "sessionDirectoryEchoStatus|primary tree"`
Expected: FAIL (function not exported / no throw).

- [ ] **Step 3: Implement**

In `child-agent-runner.js`, next to `sessionPermissionEchoStatus` (~line 120):

```js
export function sessionDirectoryEchoStatus(created, expectedDirectory) {
  const echoed = created?.data?.directory ?? created?.directory;
  const expected = String(expectedDirectory ?? "");
  if (echoed === undefined || echoed === null || echoed === "") return { state: "not-echoed", expected };
  const same = (a, b) => {
    if (path.resolve(String(a)) === path.resolve(String(b))) return true;
    try {
      return fsSync.realpathSync(String(a)) === fsSync.realpathSync(String(b));
    } catch {
      return false;
    }
  };
  return same(echoed, expected)
    ? { state: "verified", echoed: String(echoed), expected }
    : { state: "mismatch", echoed: String(echoed), expected };
}
```

(Use the file's existing `path` import; add `import fsSync from "node:fs";` if not present.) Wire it directly after the permission echo block (after line ~936), same pattern — write a `directory-mismatch` lane projection, append an `agent.directory_mismatch` event, and:

```js
          const directoryEcho = sessionDirectoryEchoStatus(child, laneDirectory);
          if (directoryEcho.state === "mismatch") {
            // (projection + event mirroring the permission-mismatch block above)
            throw new WorkflowAuthorityError(`Child session directory echo mismatch for ${callId}: expected ${directoryEcho.expected}, got ${directoryEcho.echoed}`);
          }
          // "not-echoed" is tolerated: Session.directory is typed-required on >= MIN_OPENCODE_SERVER_VERSION,
          // and the fingerprint refuses elevated authority below that floor.
```

In `createEditWorktree` (after `worktreePath` is resolved at ~line 383):

```js
    const resolvedWorktreePath = path.resolve(worktreePath);
    if (resolvedWorktreePath === path.resolve(toolContext.directory)) {
      throw new WorkflowAuthorityError(`Edit worktree path resolves to the primary tree (${resolvedWorktreePath}); refusing to run edit lanes against the primary checkout`);
    }
```

(`createIntegrationLaneWorktree` needs nothing: its target is structurally `<primary>.workflow-worktrees/<runId>/lanes/<laneId>` — worktree-adapter.js:72-74.)

- [ ] **Step 4: Run tests**

Run: `node --test tests/child-agent-runner.test.mjs && npm test`
Expected: PASS. If existing lane tests fail because their mock `session.create` responses omit `directory`, that is the tolerated `not-echoed` path — they must still pass; only an explicit wrong echo throws.

- [ ] **Step 5: Commit**

```bash
git add workflow-kernel/child-agent-runner.js tests/child-agent-runner.test.mjs
git commit -m "feat(kernel): deterministic lane directory-echo and edit-worktree distinctness assertions

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: Structured output — text fallback becomes the only path

**Files:**
- Modify: `workflow-kernel/child-agent-runner.js:611-624, 1024-1048`
- Modify: `workflow-kernel/event-journal.js:72-74`
- Test: `tests/child-agent-runner.test.mjs` (existing structured-output tests), `tests/event-journal.test.mjs` if present (grep)

**Interfaces:**
- Produces: schema lanes always use `structuredTextInstruction` + `parseStructuredTextResult` (the corrective-retry path); no lane ever sends `format:` to `session.prompt`. `laneSignature` no longer embeds capability values; it embeds `signatureVersion: 2`.

- [ ] **Step 1: Flip the selection and delete the native branch**

`child-agent-runner.js:611-612` currently:

```js
  const useNativeStructuredOutput = Boolean(schema && run.capabilities.structuredOutput === "available");
  const useStructuredTextFallback = Boolean(schema && !useNativeStructuredOutput);
```

Replace with:

```js
  // Design C: the structured-TEXT path (instruction + parse + corrective retry) is the
  // one production-proven route (see commit 0b48f51); native `format:` was gated behind
  // a probe that no longer exists. Text is now the only structured path.
  const useStructuredTextFallback = Boolean(schema);
```

Delete the `useNativeStructuredOutput` consumption at :624 (always `{ type: "text" }` — inline it) and the native read branch at :1024-1048 (the `getStructured`/`run.capabilities.structuredOutputField` arm), keeping the text-parse arm. Grep `useNativeStructuredOutput|structuredFormat|structuredOutputField` across `workflow-kernel/` and remove now-dead helpers (`structuredFormat` in `structured-output.js` if unused elsewhere; keep `structuredTextInstruction`/`parseStructuredTextResult`).

- [ ] **Step 2: laneSignature**

`event-journal.js:72-74` — replace the `capabilityMode: {permissions, structuredOutput, structuredOutputField}` object with `signatureVersion: 2` and a comment: `// v2: capability probes removed (Design C); bumping the version invalidates pre-C resume caches once, deliberately.`

- [ ] **Step 3: Run and reconcile tests**

Run: `node --test tests/child-agent-runner.test.mjs && npm test`
Expected: structured-output native-path tests fail — rewrite them to assert the text-instruction path is taken even when mocks advertise native support (assert no `format` key in the prompt body `session.prompt` receives). Resume-cache tests asserting old signatures: update fixtures.

- [ ] **Step 4: Commit**

```bash
git add workflow-kernel/child-agent-runner.js workflow-kernel/structured-output.js workflow-kernel/event-journal.js tests/
git commit -m "refactor(kernel): structured-text is the only schema-lane path; bump lane signature

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: Trust platform permissions — remove the capability throw and the legacy tools-map fork

**Files:**
- Modify: `workflow-kernel/authority-policy.js:656-658, 679`
- Test: `tests/workflow-permissions.test.mjs`, `tests/child-agent-runner.test.mjs`

**Interfaces:**
- Produces: `resolveLanePolicy` never consults `run.capabilities.permissions`; `policyMode` is always `"permission-ruleset"`; per-lane containment stays enforced by the ruleset itself + `sessionPermissionEchoStatus` mismatch-throw.

- [ ] **Step 1: Delete the throw at authority-policy.js:656-658**

Remove:

```js
  if (run.capabilities.permissions !== "available") {
    throw new WorkflowAuthorityError("Per-session permission rules are unavailable; ...");
  }
```

Replace with a comment: `// Design C: permission rules are a typed platform contract (session.create body); the plugin trusts its host and verifies delivery per-lane via sessionPermissionEchoStatus (mismatch => throw). Version floor enforced by server-fingerprint at launch.`

- [ ] **Step 2: Collapse policyMode at :679**

`policyMode: run.capabilities.permissions === "available" ? "permission-ruleset" : "legacy-tools-map",` → `policyMode: "permission-ruleset",`

Then grep `legacy-tools-map` repo-wide. If the branch is localized (a tools-map construction consumed only when policyMode is legacy), delete it and its tests; if it threads widely, leave the dead constant with a `// dead since Design C — remove with next authority refactor` marker and note it in the final report.

- [ ] **Step 3: Run and reconcile**

Run: `node --test tests/workflow-permissions.test.mjs tests/child-agent-runner.test.mjs && npm test`
Expected: tests that force `permissions: "available-unverified"` and expect a lane-spawn throw now fail — rewrite them to assert the lane launches AND the permission ruleset is still passed in the create body verbatim (the containment property that actually matters).

- [ ] **Step 4: Commit**

```bash
git add workflow-kernel/authority-policy.js tests/
git commit -m "refactor(kernel): trust platform permission enforcement; ruleset mode always on

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 7: Delete the probe subsystem (the big one — starts the red arc)

**Files:**
- Delete: `workflow-kernel/live-gate-probes.js`, `workflow-kernel/gate-shapes.js`, `commands/workflow-live-gates-release-check.md`
- Modify: `workflow-kernel/capability-adapter.js` (gut), `workflow-kernel/workflow-plugin.js` (imports :57-68; launch block :1867-1892; `workflow_live_gates` tool :2929-2960; preview :656/:711-717/:729-736/:741-743/:793/:807-808; dead constant :183), `workflow-kernel/constants.js` (`DEFAULT_LIVE_PROBE_TIMEOUT_MS` ~:101), `workflow-kernel/index.js` (barrel unaffected — verify)

**Interfaces:**
- Produces: `createCapabilityAdapter` returns shape-only capabilities `{ childSession: "available"|"unavailable", worktree: "available"|"unavailable", toast: ... }` (drop `permissions`, `structuredOutput`, `structuredOutputField`, `directoryRooting`, `worktreeEditIsolation`, `backgroundContinuation` if unread — grep first; drop dead `modelListing`/`agentListing`). Launch path calls `serverFingerprint` + `assertServerSupportsElevatedAuthority` for non-read-only authority. Preview has no `requiredGates`, no probe consent line; keeps a slim `capabilities: { childSession, worktree }`.

- [ ] **Step 1: Gut capability-adapter.js**

Delete: both import blocks from gate-shapes/live-gate-probes (:23-28, :32-48 minus the now-local `unwrapClientResult`), both re-export blocks (:712-753), `promoteCapabilities`, `promoteVerifiedGateCapabilities`, `VERIFIED_GATE_CAPABILITY_MAP`, `weakEvidenceGateBlockers`, `verifyRequiredAuthorityGates`, `verifyNetworkMcpAuthorityGates`, `hasLiveGateProbeFlags`, `assertLiveGateProbeAllowed`, `liveGateReport`, `compactLiveGateStatus`, `gateCapability`, `setLiveGateDiagnostic`, `liveGateProbeArgsForNames`, `nonVerifiedGateSummaries`, `NON_BEHAVIORAL_EVIDENCE_STRENGTHS`, probe-cache members (`capabilityProbes`, `cachedProbe`, `invalidateCapabilityProbes`, `CAPABILITY_PROBE_CACHE_MAX`, `VERIFIED_PROBE_TTL_MS`) — **keep `BoundedProbeCache` only if** you reuse it for the fingerprint cache (Task 3 shipped its own Map; then delete the class too). Keep: `createCapabilityAdapter` (slimmed shape defaults: `childSession` and `worktree` become `"available"`/`"unavailable"` — no more `-unverified` middle state), `resolveWorktreeClient` + `hasWorktreeClient`/`createWorktree`/`removeWorktree`, `getStructured` **only if** still referenced after Task 5 (grep; else delete), `readInstalledVersion`, `redactServerUrl`, `unwrapClientResult`, diagnostics (replace `opencodeVersion: "not-probed"` default with `"unknown"`).

- [ ] **Step 2: workflow-plugin.js launch block**

At :1867-1892, replace the `promoteCapabilities` / `verifyRequiredAuthorityGates` / `verifyNetworkMcpAuthorityGates` / `promoteVerifiedGateCapabilities` / ad-hoc `requireCapability` sequence with:

```js
    const fingerprint = await serverFingerprint(pluginContext);
    run.diagnostics.serverFingerprint = fingerprint;
    if (run.diagnostics?.opencodeVersion !== undefined || adapter.diagnostics) {
      adapter.diagnostics.opencodeVersion = fingerprint.version ?? "unknown";
    }
    if (authority.readOnly !== true) {
      assertServerSupportsElevatedAuthority(fingerprint);
    }
    if ((authority.edit || authority.worktreeEdit) && adapter.capabilities.worktree !== "available") {
      throw new WorkflowAuthorityError("Edit-mode workflows require the native worktree client, which this opencode server/SDK does not expose");
    }
```

Import `serverFingerprint`/`assertServerSupportsElevatedAuthority` from `./server-fingerprint.js`; drop the deleted capability-adapter imports at :57-68. Confirm the exact authority flag names (`authority.readOnly`, `authority.edit`, `authority.worktreeEdit`) against `WORKFLOW_AUTHORITY_PROFILES` (authority-policy.js:20-45) while editing.

- [ ] **Step 3: Delete the `workflow_live_gates` tool (:2929-2960) and the dead constant `NON_DRY_BEADS_DRAIN_PERMISSION_GATES` (:183)**

Keep `invalidateWorkflowProviderListCache` (:1533) — remove only the call inside the deleted tool. Tool count drops 17 → 16.

- [ ] **Step 4: Preview envelope**

At :656 drop the `requiredGates` read; at :711-717 drop `requiredGates` from the authority object; at :729-736 slim `capabilities` to `{ childSession, worktree }`; delete the probe consent note at :741-743 and the `Required gates:` / capability-note lines at :793/:807-808; update the `approvalHashCovers` string at :748 to stop naming gates. Delete `commands/workflow-live-gates-release-check.md`.

- [ ] **Step 5: Delete probe constants**

Remove `DEFAULT_LIVE_PROBE_TIMEOUT_MS` (constants.js ~:101) and any `__workflowLiveProbeTimeoutMs` plumbing (grep).

- [ ] **Step 6: Sanity compile**

Run: `node --input-type=module -e "await import('./workflow-kernel/index.js'); console.log('kernel loads')"`
Expected: `kernel loads`. Suite is expected red until Task 10.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(kernel)!: delete the live-gate probe subsystem; fingerprint + deterministic checks replace preflight (Design C)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 8: Remove the drain gate funnel and requiredGates vocabulary

**Files:**
- Modify: `workflow-kernel/sandbox-executor.js` (:34 import, :259-277, :320-338, :368-371), `workflow-kernel/authority-policy.js` (:6-14, :20-45), `workflow-kernel/audited-shell-policy.js` (:125-200 dead half), `workflow-kernel/drain-runtime.js` (no change — verify :358 passthrough stays)

**Interfaces:**
- Produces: `runHostDrain` spawns the drain with no gate preflight; profiles have no `requiredGates` key; `NON_DRY_DRAIN_REQUIRED_GATES` no longer exists; audited-shell keeps only the live allowlist/deny/pattern exports.

- [ ] **Step 1: sandbox-executor.js**

Delete `drainGateStatus` (:264-277), `nonVerifiedDrainBlockers` (:259-262), the gate block in `runHostDrain` (:320-338: `requiredGates` resolution, `gateStatus` computation, `run.diagnostics.drainLiveGates`, the `drain.live_gates` event, the non-dry blocker throw), and the `gateStatus` argument at :368-371. **Keep** the guest-field strip at :307-311 (still prevents a guest script spoofing `gateStatus`/`gates` into the report) and the capability-adapter import line trimmed to what remains. Replace the deleted block with:

```js
    // Design C: no probe preflight. Non-dry drain safety = one-time approval (hash),
    // server-fingerprint floor (workflow-plugin launch path), per-lane permission +
    // directory echo assertions, integration worktrees, and controller-only mutation
    // staging. A dead server or dishonored ruleset fails loud at the first lane.
```

- [ ] **Step 2: authority-policy.js**

Delete `NON_DRY_DRAIN_REQUIRED_GATES` (:6-14) and every `requiredGates:` line in `WORKFLOW_AUTHORITY_PROFILES` (:23/:27/:31/:35/:39/:43). Verify the generic consumers at :351-392/:468 (recon: `resolveRunAuthority` reads `profile.requiredGates` into `authority.requiredGates`) — delete that threading too.

- [ ] **Step 3: audited-shell-policy.js dead half**

Delete `validateAuditedCommand` (:54-73), `DEEP_MODE_REQUIRED_GATES` (:125-128), `resolveShellCoverage` (:133-137), `resolveDeepMode` (:142-200). Keep `AUDITED_SHELL_ALLOWLIST`, `AUDITED_SHELL_DENY`, `SHELL_PERMISSION_DENY_PATTERNS`, `auditedShellPermissionPatterns` (live at authority-policy.js:378).

- [ ] **Step 4: Kernel loads**

Run: `node --input-type=module -e "await import('./workflow-kernel/index.js'); console.log('ok')"`
Expected: `ok`.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "refactor(kernel): remove drain gate funnel and requiredGates vocabulary

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 9: Beads-domain and workflow-comment mechanical updates

**Files:**
- Modify: `workflow-domains/beads/beads-extension.js` (:5 import, :229, :231), `workflow-domains/beads/commands/beads-drain.md` (:12, :24, :28, :30, :32, :40), `workflow-domains/beads/skills/beads-drain/SKILL.md` (:29-31, :40, :56), `workflows/repo-complexity.js` (:77-80, :89 comments), `workflows/repo-deps.js` (:30-34 comments), `workflows/repo-review.js` (:11, :107, :117-118 comments)

- [ ] **Step 1: beads-extension.js**

Remove the `NON_DRY_DRAIN_REQUIRED_GATES` import (line 5) and both `requiredGates:` fields (:229, :231). Do not touch `finalGateId` / "Final gate" (unrelated bd-epic concept).

- [ ] **Step 2: Command/skill/workflow prose**

Rewrite the gate sentences in `beads-drain.md` and `SKILL.md` to the new contract: "non-dry drain requires a one-time approval; the kernel verifies the server version floor and asserts lane rooting/permissions deterministically at launch — there is no live-gate preflight and no `/workflow-live-gates-release-check` step." Leave "human-gated" occurrences (unrelated bd concept). Update the three `workflows/*.js` comments to stop referencing gate verification as the reason leaves stay read-only (the profiles are still read-only; the *reason* is now just profile policy).

- [ ] **Step 3: Kernel + beads assets load, commit**

Run: `node --input-type=module -e "await import('./workflow-domains/beads/beads-extension.js'); console.log('beads ok')"`
Expected: `beads ok`.

```bash
git add -A
git commit -m "chore(beads,workflows): drop gate vocabulary from extension wiring and docs

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 10: Test-suite reconciliation (ends the red arc — suite fully green)

**Files:**
- Delete: `tests/live-gate-probes.test.mjs`, `tests/live-gates-harness.mjs`, `tests/live-gates-integration.test.mjs`, `tests/live-gates-permission.test.mjs`, `tests/live-gates-runtime.test.mjs`, `tests/live-gates-worktree.test.mjs`
- Modify: `package.json` (:51 drop `test:live-gates`), `tests/helpers/harness.mjs` (:25-32, :50-54, :196), `tests/beads-drain-workflow.test.mjs` (:42-49, :145-162, 7 forced-gate tests), `tests/workflow-run.test.mjs` (21 tests, lines 141-3550), `tests/workflow-apply.test.mjs` (:143-162 dead helpers), `tests/beads-drain-assets.test.mjs` (3 delete + 5 trim), `tests/publish-completeness.test.mjs` (3 refs), `tests/repo-bughunt-command-assets.test.mjs` (:44), `tests/repo-review-command-assets.test.mjs` (:44), `tests/repo-review-deep-modes.test.mjs` (delete deep-mode/validator tests; keep allowlist/deny-pattern coverage), `tests/repo-review-no-mutation.test.mjs` (:124, :422), `tests/sandbox-executor.test.mjs` (:209-232), `tests/model-tiering.test.mjs` (:123-152 drop the live-gates invalidation trigger), `tests/workflow-docs.test.mjs` (:51-69 tool count 17→16; :71-83 file list), `tests/capability-adapter.test.mjs` (drop `probeCancellationGate` import; keep `readInstalledVersion`), `tests/repo-deps.test.mjs` (:313 fixture), `tests/drain-runtime.test.mjs` (verify :315-320 still passes unchanged)

- [ ] **Step 1: Shared harness first**

`tests/helpers/harness.mjs` `DEFAULT_CAPABILITIES` (:25-32) → `{ childSession: "available", worktree: "available", toast: "available" }` (match the slimmed adapter). Keep `makeHarness(options)`'s signature. Then run `npm test` and fix per-file fallout in the order listed above; principles: (a) tests asserting *probe mechanics* die with the subsystem; (b) tests asserting *safety outcomes* (profile can't launch X, drain blocked when Y) get rewritten against the new mechanism (fingerprint refusal via `__workflowServerHealth` forcing `{ data: { healthy: true, version: "1.0.0" } }`, echo mismatch throws, worktree-shape refusal); (c) preview-shape assertions drop `requiredGates`/gate lines.
Preserve-the-concept rewrites required (not just deletions):
  - `workflow-run.test.mjs:248` "authority profiles expand to required gates" → "authority profiles carry no gate vocabulary; elevated launch consults the server fingerprint".
  - `live-gates-worktree.test.mjs:310`'s apply-approved-plan rejection concept → new test in `workflow-run.test.mjs`: an `apply-approved-plan` run against `__workflowServerHealth` forcing `too-old` throws before launch.
  - `sandbox-executor.test.mjs:209-232` → non-dry drain launches with zero gate preflight and reaches the adapter (assert no `drain.live_gates` event exists in the journal).

- [ ] **Step 2: Full suite**

Run: `npm test`
Expected: PASS, zero skipped-as-red files. Also run `npm run test:lockfile-sync`.

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "test: reconcile suite with probe-subsystem removal

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 11: Documentation sweep

**Files:**
- Modify: `README.md` (sections per recon: Source Checkout Verification :44-97, Documentation Map :126, Command/Skill Registration :140-152, Extension Trust Boundary :165, Beads Drain :179-238, Repo Review Suite :248/:283, Authority Profiles :318-370, **replace the ~94-line `## Live Gates` + `### Active Runtime Release Check` sections :618-711** with a short "Runtime trust model" section), `AGENTS.md` (:18, :41-42), `CONTRIBUTING.md` (:48), `CHANGELOG.md` (add entry), `SECURITY.md` (:34), `docs/workflow-plugin.md` (:32 tool row), `docs/plugin-system-tests.md` (Permission Gate Diagnostics section + smoke prose), `docs/workflow-extensions.md` (:59), `docs/workflow-recipes.md` (:231, :375), `docs/repo-review.md` (:175, :303), `docs/repo-review-leaf-contract.md` (:230), `docs/repo-review-parity-matrix.md` (:161, :167), `docs/claude-parity-roadmap.md` (:31, :83) (retro note: shipped commands/ and skills/ assets were missed by this list and reconciled in the final-review fix pass)

- [ ] **Step 1: Write the replacement trust-model paragraph once, reuse everywhere**

README "Runtime trust model" section content:

> Every workflow needs a one-time hashed human approval before it runs. Lanes work inside real git worktrees; their edits land on your tree only through the controller, after a clean-base check and a diff-plan hash match. Lane rooting and worktree isolation are asserted from typed API fields at creation time, and each lane's deny-by-default permission ruleset is sent with the session and re-checked against the create echo. The kernel trusts opencode itself — the plugin runs inside it — and verifies compatibility once per server via `GET /global/health`, refusing elevated profiles below opencode `1.17.13`.

Leave historical docs (`docs/dogfood-rollout-2026-06-16.md`, `docs/release-gate-validation-2026-06-16.md`, `docs/review-2026-06-19-*.md`, `docs/workflow-autonomous-harness-*.md`, `docs/superpowers/plans/*`) untouched — they are dated snapshots.

- [ ] **Step 2: Doc-asserting tests**

Run: `node --test tests/workflow-docs.test.mjs tests/publish-completeness.test.mjs tests/beads-drain-assets.test.mjs tests/repo-bughunt-command-assets.test.mjs tests/repo-review-command-assets.test.mjs && npm test`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "docs: replace live-gate documentation with the deterministic trust model

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 12: End-to-end test against a live opencode server

**Files:**
- Create: `scripts/design-c-e2e.mjs` (disposable driver, committed for repeatability)
- Scratch: a temp project dir with `opencode.json` registering this plugin by path, a git repo, and a scratch bd database (pattern: `tests/beads-drain-scratch.test.mjs` scaffolding)

**Interfaces:**
- Consumes: `opencode serve --port 41967` (CLI 1.17.13 verified installed); the plugin factory loaded against the **real** server client (pattern: `scripts/parent-integration.mjs` / `scripts/child-system-smoke.mjs` — read them first and reuse their client-construction approach).

- [ ] **Step 1: Ladder rung A — plugin loads on a real server**

Start `opencode serve --port 41967` in a scratch HOME/project; assert the server log shows the plugin loaded without error and (via the SDK or `opencode run`-level introspection, whichever the existing scripts use) that `workflow_run`/`workflow_status` are registered and `workflow_live_gates` is **absent**.

- [ ] **Step 2: Rung B — fingerprint against the real server**

From the driver script: `serverFingerprint({ serverUrl: "http://127.0.0.1:41967" })` → expect `{ state: "ok", version: "1.17.13" }`.

- [ ] **Step 3: Rung C — real preview + approval + dry-run drain**

Drive the plugin factory in-process against the real server (parent-integration pattern): execute `workflow_run` `{ name: "beads-drain", args: { mode: "dry-run", repo: <scratch bd repo> }, format: "json" }`, assert `approvalHash` present and **no** `requiredGates`/gate consent text; re-execute with `approve: true` + hash; assert the run completes, `stop_reason` ∈ {`dry_run_plan`,`queue_empty`,`not_dry`}, and `workflow_status` shows truthful status.

- [ ] **Step 4: Rung D (best-effort) — one real child lane**

If a configured model responds in this environment (check `opencode models` / the user's provider config; the local proxy may be down), run a minimal `maxAgents: 1` workflow that spawns one real child session and assert the directory-echo assertion passes against the real server (and a deliberate wrong-directory harness variant throws). If no model is reachable, record rung D as NOT RUN with the reason in the final report — do not fake it.

- [ ] **Step 5: Teardown + commit driver**

Kill the server; remove scratch dirs.

```bash
git add scripts/design-c-e2e.mjs
git commit -m "test: live-server E2E driver for the Design C trust model

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 13: Final verification + honest report

- [ ] **Step 1:** `npm test` (full green), `npm run test:lockfile-sync`, `node scripts/release-no-token.mjs` (the CI gate: lockfile-sync → test → pack dry-run).
- [ ] **Step 2:** `git log --oneline` sanity; diffstat summary (expect net ≈ −1,800 to −2,000 kernel/test lines).
- [ ] **Step 3:** Report to Michael: what was deleted, what now enforces each safety property, E2E rung results (including any NOT RUN), the one-time resume-cache invalidation, and the follow-ups deliberately not done (beads verifier fork; `legacy-tools-map` if left marked-dead).

## Self-Review Notes

- Spec coverage: probe files deleted (T7), tool deleted (T7), requiredGates vocabulary deleted (T7/T8), drain funnel deleted (T8), deterministic checks added (T4), fingerprint added + enforced (T3/T7), structured-text-only (T5), permissions trust (T6), truthful status (T1), dead code (audited-shell half, `NON_DRY_BEADS_DRAIN_PERMISSION_GATES`, `modelListing`/`agentListing`) removed (T7/T8), beads mechanical (T9), tests (T10), docs (T11), E2E (T12).
- Known judgment calls encoded: `unreachable`/`unknown` fingerprints do not block (fail-loud-at-first-use); `not-echoed` directory tolerated (typed-required above the version floor); slim `capabilities` object kept in preview/approval-hash for continuity.
- Line numbers are from 2026-07-07 recon of the working tree **after** the 0y5f changes; they shift as tasks land — re-anchor by the quoted code, not the number.
