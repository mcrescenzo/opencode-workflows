// STANDING no-mutation + authority-coexistence regression for the ported repo-*
// review workflows (bead opencode-workflows-rrev.21).
//
// The read-only guarantee for the eight repo-* leaves and the repo-review meta is
// converted from a one-time validation note into a durable, zero-token suite that
// FAILS if any of these workflows can mutate under its declared "read-only-review"
// profile, and that they coexist safely with the mutating beads-drain workflow
// shipping in the same bundled dir + kernel.
//
// Coverage map (mirrors the bead's four deliverables):
//   1. Authority layer denies every mutation surface (fs edit/apply_patch, bash,
//      network, mcp) for each repo-* leaf AND the repo-review meta, and the lane-
//      level escalation path (opts.edit/shell/network/mcp/worktreeEdit) is rejected
//      by resolveLanePolicy against the read-only run authority.
//   2. The meta's literal workflow() calls NEVER include "beads-drain" (source
//      scan), and a synthetic meta that DID nest beads-drain is surfaced by the
//      same static-ref scanner and cannot escalate: authorityArgsForWorkflow gates
//      the beads authority path on meta.name === "beads-drain", and nested lanes
//      inherit the parent run's read-only authority.
//   3. Recorded client calls after a full leaf run AND a full meta run contain
//      ZERO session-side write/apply/git/bd operations: every spawned child
//      session receives a deny-by-default permission ruleset, no edit worktree is
//      created, and no prompt requests a mutation command.
//   4. Coexistence: repo-* (read-only) and beads-drain (mutating) resolve from the
//      same BUNDLED_WORKFLOW_DIR with disjoint authority pinned by each meta, and a
//      repo-* workflow cannot enter the drain-dry-run/beads-autonomous authority
//      path (profile clamp via authorityArgsForWorkflow).
//
// Zero-token: every child session.prompt is routed to a canned payload by the
// shared harness (tests/helpers/repo-review-leaf-harness.mjs -> harness.mjs); no
// real model is ever called. No git/gh/network/bd mutation is performed — this is
// read-only source parsing plus the mocked harness.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  makeHarness,
  runApprovedRequest,
  resultOutput,
  makeLeafPromptRouter,
  structured,
} from "./helpers/repo-review-leaf-harness.mjs";
import {
  parseWorkflowSource,
  staticNestedWorkflowRefs,
} from "../workflow-kernel/workflow-source.js";
import {
  resolveRunAuthority,
  permissionRulesForAuthority,
  authorityArgsForWorkflow,
  resolveLanePolicy,
} from "../workflow-kernel/authority-policy.js";
import { BUNDLED_WORKFLOW_DIR } from "../workflow-kernel/constants.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORKFLOWS_DIR = path.join(HERE, "..", "workflows");
// beads-drain moved out of the bundled dir into the beads extension's workflow dir.
const BEADS_WORKFLOWS_DIR = path.join(HERE, "..", "workflow-domains", "beads", "workflows");

// The eight repo-* LEAF engines (in bundled-file order) + the static-literal meta.
const LEAF_FILES = [
  "repo-bughunt.js",
  "repo-security-audit.js",
  "repo-test-gaps.js",
  "repo-cleanup.js",
  "repo-modernize.js",
  "repo-perf.js",
  "repo-complexity.js",
  "repo-deps.js",
];
const EIGHT_LEAVES = [
  "repo-bughunt", "repo-security-audit", "repo-test-gaps", "repo-cleanup",
  "repo-modernize", "repo-perf", "repo-complexity", "repo-deps",
];
// Every bundled workflow asserted by this suite (leaves + meta).
const ALL_REPO_WORKFLOW_FILES = [...LEAF_FILES, "repo-review.js"];

// Permission keys that, when denied, block every mutation surface reachable from a
// child lane: edit/apply_patch (fs writes), bash (shell + git-via-bash), webfetch/
// websearch (network), mcp. Read-class tools + structured_output stay allowed so the
// read-only review lanes can still inspect the repo and emit structured findings.
const DENIED_MUTATION_PERMS = ["edit", "apply_patch", "bash", "webfetch", "websearch", "mcp"];
const ALLOWED_READ_PERMS = ["read", "glob", "grep", "list", "lsp", "structured_output"];

// Mutation command tokens a repo-* prompt must never instruct a lane to perform.
const FORBIDDEN_PROMPT_COMMANDS = [
  "git commit", "git push", "git apply", "git rebase",
  "bd create", "bd update", "bd close", "bd dep", "bd dolt",
  "workflow_apply", "drain(",
];

// ---- helpers ----

async function readWorkflow(file) {
  const dir = file === "beads-drain.js" ? BEADS_WORKFLOWS_DIR : WORKFLOWS_DIR;
  const sourcePath = path.join(dir, file);
  const source = await fs.readFile(sourcePath, "utf8");
  const { meta } = parseWorkflowSource(source);
  return { meta, source, sourcePath };
}

function findRule(rules, permission, pattern = "*") {
  return rules.find((r) => r?.permission === permission && r?.pattern === pattern);
}

// Permission rules travel to the mock session.create under .body.permission (v1
// shape) or .permission (v2 shape); accept either so the assertion is shape-agnostic.
function extractCreatePermission(createCall) {
  return createCall?.body?.permission ?? createCall?.permission ?? [];
}

function assertReadOnlyAuthority(authority, label) {
  assert.equal(authority.profile, "read-only-review", `${label}: authority.profile`);
  assert.equal(authority.readOnly, true, `${label}: authority.readOnly`);
  assert.equal(authority.mode, "readOnly", `${label}: authority.mode`);
  for (const dim of ["edit", "worktreeEdit", "integration", "shell", "network", "mcp"]) {
    assert.equal(authority[dim], false, `${label}: authority.${dim} must be false`);
  }
  // Design C: authority carries no gate vocabulary at all (requiredGates was deleted with the
  // live-gate-probe subsystem); read-only-review's "nothing to enforce" property is now the
  // absence of the key entirely, not an empty array.
  assert.equal(Object.hasOwn(authority, "requiredGates"), false, `${label}: authority must not carry requiredGates`);
}

function assertRulesDenyMutation(rules, label) {
  // Catch-all deny is the authoritative floor: anything not explicitly allowed is denied.
  const catchAll = rules.find((r) => r.permission === "*" && r.pattern === "*");
  assert.ok(catchAll, `${label}: missing catch-all rule`);
  assert.equal(catchAll.action, "deny", `${label}: catch-all must deny`);

  for (const perm of DENIED_MUTATION_PERMS) {
    const rule = findRule(rules, perm);
    assert.ok(rule, `${label}: missing ${perm} rule`);
    assert.equal(rule.action, "deny", `${label}: ${perm} must be DENIED (got ${rule.action})`);
  }
  for (const perm of ALLOWED_READ_PERMS) {
    const rule = findRule(rules, perm);
    assert.ok(rule, `${label}: missing ${perm} allow rule`);
    assert.equal(rule.action, "allow", `${label}: ${perm} must be allowed for read-only review`);
  }
}

// ============================================================================
// 1. read-only-review authority denies every mutation surface (all repo-* + meta)
//    + lane-level escalation inside a repo-* run is rejected by resolveLanePolicy.
// ============================================================================

describe("repo-* no-mutation: authority layer (read-only-review)", { concurrency: false }, () => {
  for (const file of ALL_REPO_WORKFLOW_FILES) {
    test(`${file}: resolveRunAuthority -> readOnly, zero mutating dims, no required gates`, async () => {
      const { meta } = await readWorkflow(file);
      const authority = resolveRunAuthority(meta);
      assertReadOnlyAuthority(authority, file);
    });

    test(`${file}: permissionRulesForAuthority denies edit/apply_patch/bash/network/mcp`, async () => {
      const { meta } = await readWorkflow(file);
      const authority = resolveRunAuthority(meta);
      const rules = permissionRulesForAuthority(authority);
      assertRulesDenyMutation(rules, file);
    });
  }

  test("lane-level escalation (edit/shell/network/mcp/worktreeEdit) is rejected against a repo-* run authority", async () => {
    const { meta } = await readWorkflow("repo-review.js");
    // The same run authority a real repo-review run gets: read-only-review.
    const run = {
      authority: resolveRunAuthority(meta),
      capabilities: { permissions: "available" },
    };
    for (const dim of ["edit", "worktreeEdit", "shell", "network", "mcp"]) {
      assert.throws(
        () => resolveLanePolicy(run, { [dim]: true }),
        /beyond approved workflow authority/,
        `${dim}: a repo-* lane must not be able to opt into mutating authority`,
      );
    }
  });

  test("lane readOnly is authoritative defense-in-depth: it drops even a contradictory edit/shell/network/mcp request", async () => {
    const { meta } = await readWorkflow("repo-review.js");
    const run = {
      authority: resolveRunAuthority(meta),
      capabilities: { permissions: "available" },
    };
    const clamped = resolveLanePolicy(run, {
      readOnly: true, edit: true, shell: true, network: true, mcp: true, worktreeEdit: true,
    });
    assert.equal(clamped.authority.readOnly, true, "readOnly must win");
    assert.equal(clamped.mode, "readOnly");
    for (const dim of ["edit", "worktreeEdit", "integration", "shell", "network", "mcp"]) {
      assert.equal(clamped.authority[dim], false, `clamped authority.${dim} must be false`);
    }
    // The authoritative permission ruleset still denies every mutation surface.
    assertRulesDenyMutation(clamped.permissionRules, "readOnly-clamped lane");
  });
});

// ============================================================================
// 2. meta never nests beads-drain; a synthetic nest is caught + cannot escalate.
// ============================================================================

describe("repo-* no-mutation: meta never reaches beads-drain", { concurrency: false }, () => {
  test("repo-review meta's static workflow() refs are exactly the eight leaves (no beads-drain)", async () => {
    const { source } = await readWorkflow("repo-review.js");
    const refs = staticNestedWorkflowRefs(source);
    assert.ok(!refs.includes("beads-drain"), "meta must NEVER nest workflow(\"beads-drain\", ...)");
    assert.deepEqual([...new Set(refs)].sort(), [...EIGHT_LEAVES].sort());
    assert.equal(refs.length, 8, "exactly eight literal leaf calls");
  });

  test("repo-review meta source contains no drain()/workflow_apply/materialize primitives", async () => {
    const { source } = await readWorkflow("repo-review.js");
    // The only mention of these tokens is the header comment that documents their
    // ABSENCE; an actual call site would be `drain(` (open paren) etc.
    assert.doesNotMatch(source, /drain\(/, "meta must not call drain()");
    assert.doesNotMatch(source, /workflow_apply\(/, "meta must not call workflow_apply()");
    assert.doesNotMatch(source, /materialize\(/, "meta must not call materialize()");
  });

  test("every repo-* LEAF is a leaf: zero nested workflow() refs (authoritative scanner)", async () => {
    for (const file of LEAF_FILES) {
      const { source } = await readWorkflow(file);
      // staticNestedWorkflowRefs is the same scanner that builds the approval-time
      // nested-snapshot ledger; a leaf must register ZERO nested workflow refs (one
      // nesting level is legal only for the meta). Raw-source regexing is unreliable
      // because leaves document the rule in comments that spell "workflow()".
      const refs = staticNestedWorkflowRefs(source);
      assert.deepEqual(refs, [], `${file} must be a leaf (zero nested workflow refs)`);
    }
  });

  test("a synthetic meta that DID nest workflow(\"beads-drain\") is surfaced by the static-ref scanner", () => {
    // Construct the offending source so the rule is documented and enforced: the
    // same scanner that builds the approval-time nested-snapshot ledger WOULD list
    // beads-drain, making the escalation visible (and hash-pinned) at approval time.
    const synthetic = `
export const meta = { name: "evil-meta", profile: "read-only-review", maxAgents: 4, concurrency: 1, phases: ["x"] };
const r = await workflow("beads-drain", { mode: "autonomous-local" });
return r;`;
    const refs = staticNestedWorkflowRefs(synthetic);
    assert.ok(refs.includes("beads-drain"), "static scanner must surface a nested beads-drain call");
  });

  test("a repo-* run cannot enter the beads authority path: authorityArgsForWorkflow is a no-op for non-beads-drain", async () => {
    const { meta: reviewMeta } = await readWorkflow("repo-review.js");
    const { meta: bughuntMeta } = await readWorkflow("repo-bughunt.js");
    const { meta: beadsMeta } = await readWorkflow("beads-drain.js");

    // The beads authority remap (dry-run -> profile "drain-dry-run", integration/edit
    // forced false) is gated on meta.name === "beads-drain". For every repo-* workflow
    // the args come back UNCHANGED, so the beads mutating/dry authority path is
    // unreachable regardless of any args.args.mode a caller supplies.
    const reviewArgs = { args: { mode: "autonomous-local" } };
    const clamped = authorityArgsForWorkflow(reviewMeta, reviewArgs);
    assert.equal(clamped, reviewArgs, "repo-review authorityArgs must be returned unchanged");
    assert.notEqual(clamped.profile, "drain-dry-run");
    assert.notEqual(clamped.profile, "drain-autonomous-local");

    const bughuntArgs = { args: { mode: "dry-run" } };
    assert.equal(authorityArgsForWorkflow(bughuntMeta, bughuntArgs), bughuntArgs, "repo-bughunt authorityArgs unchanged");

    // Contrast: the bundled beads-drain DOES get remapped on dry-run.
    const beadsDry = authorityArgsForWorkflow(beadsMeta, { args: { mode: "dry-run" } });
    assert.equal(beadsDry.profile, "drain-dry-run", "beads-drain dry-run is remapped to its own profile");

    // And the parent run authority stays read-only for repo-* regardless of mode.
    assert.equal(resolveRunAuthority(reviewMeta, clamped).readOnly, true);
    assert.equal(resolveRunAuthority(reviewMeta, clamped).profile, "read-only-review");
  });

  test("nested workflow() lanes inherit the parent run authority: a hypothetical nested beads-drain runs under read-only", async () => {
    // runNestedWorkflow (workflow-kernel/sandbox-executor.js) executes the nested body
    // via executeSandbox(..., run, ...) sharing the SAME run object, so a nested
    // workflow's own meta.profile is IGNORED for authority — the parent run governs.
    // The repo-review parent authority is read-only, so any nested body (including a
    // hypothetical beads-drain) is contained by it; it could never escalate to
    // integration/edit authority.
    const { meta: reviewMeta } = await readWorkflow("repo-review.js");
    const parentAuthority = resolveRunAuthority(reviewMeta);
    assert.equal(parentAuthority.readOnly, true);
    assert.equal(parentAuthority.integration, false);
    assert.equal(parentAuthority.edit, false);
    assert.equal(parentAuthority.profile, "read-only-review");
  });
});

// ============================================================================
// 3. recorded client calls after a full leaf + meta run contain ZERO session-side
//    write/apply/git/bd operations.
// ============================================================================

describe("repo-* no-mutation: recorded client calls (mocked harness)", { concurrency: false }, () => {
  // ---- minimal zero-token prompt routers (EMPTY findings so runs complete fast) ----

  // repo-bughunt leaf: recon -> recon object; every finder -> empty findings; the
  // verify phase is skipped because there is nothing to verify.
  function bughuntRoute(text, shape) {
    if (text.includes("Profile this repository")) {
      return shape({ languages: ["javascript"], notes: "no-mutation recon" });
    }
    return shape({ findings: [] });
  }

  // repo-review meta: drives the single shared meta recon + complexity's domain
  // recon + every leaf finder (all empty). Mirrors tests/repo-review-meta-smoke.
  function metaRoute(text, shape) {
    if (text.includes("comprehensive multi-domain review") || text.includes("Profile this repository once")) {
      return shape({ languages: ["javascript"], notes: "meta shared recon", frameworks: ["node"], packageManagers: ["npm"] });
    }
    if (text.includes("for a complexity")) {
      return shape({ profile: "test repo", dirs: ["src"], gitAvailable: false });
    }
    if (text.includes("Profile this repository")) {
      return shape({ languages: ["javascript"], notes: "leaf self recon fallback" });
    }
    return shape({ findings: [] });
  }

  function assertNoMutatingPrompts(calls, label) {
    const texts = calls.prompt.map((p) => String(p?.body?.parts?.[0]?.text ?? ""));
    assert.ok(texts.length > 0, `${label}: expected at least one routed prompt`);
    for (const text of texts) {
      for (const cmd of FORBIDDEN_PROMPT_COMMANDS) {
        assert.ok(
          !text.includes(cmd),
          `${label}: a routed prompt must not instruct a mutation command (found ${JSON.stringify(cmd)})`,
        );
      }
    }
  }

  function assertEveryChildSessionIsReadOnly(calls, label) {
    assert.ok(calls.create.length > 0, `${label}: expected at least one child session`);
    for (let i = 0; i < calls.create.length; i += 1) {
      const permission = extractCreatePermission(calls.create[i]);
      assert.ok(Array.isArray(permission) && permission.length > 0, `${label}: child session #${i} must receive a permission ruleset`);
      assertRulesDenyMutation(permission, `${label} child session #${i}`);
    }
    // No edit/integration worktree is ever created for a read-only run.
    assert.equal(calls.worktreeCreate.length, 0, `${label}: no edit worktree may be created`);
  }

  test("repo-bughunt leaf run: every child session is read-only; no mutation prompt; no edit worktree", async () => {
    const { tools, context, directory, calls } = await makeHarness(makeLeafPromptRouter(bughuntRoute, { fallbackShape: structured }));
    try {
      const out = await runApprovedRequest(tools, context, { name: "repo-bughunt", args: { depth: "normal" } });
      const env = await resultOutput(tools, context, out);
      assert.equal(env.reportPath, null, "leaf envelope reportPath must be null (QuickJS guest cannot write)");

      assertEveryChildSessionIsReadOnly(calls, "repo-bughunt leaf");
      assertNoMutatingPrompts(calls, "repo-bughunt leaf");
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

  test("repo-review meta run: every child session (incl. nested leaf lanes) is read-only; no mutation prompt; no edit worktree", async () => {
    const { tools, context, directory, calls } = await makeHarness(makeLeafPromptRouter(metaRoute, { fallbackShape: structured }));
    try {
      const out = await runApprovedRequest(tools, context, { name: "repo-review", args: { depth: "normal" } });
      const env = await resultOutput(tools, context, out);
      assert.equal(env.reportPath, null, "meta envelope reportPath must be null (QuickJS guest cannot write)");
      assert.ok(Array.isArray(env.leafOutcomes) && env.leafOutcomes.length === 8, "meta must run all eight leaves");

      assertEveryChildSessionIsReadOnly(calls, "repo-review meta");
      assertNoMutatingPrompts(calls, "repo-review meta");
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });
});

// ============================================================================
// 4. separation: repo-* (read-only) stay bundled; beads-drain (mutating) lives in
//    the beads extension dir, with disjoint authority gated on name.
// ============================================================================

describe("repo-* no-mutation: separation from beads-drain", { concurrency: false }, () => {
  test("repo-* reside in BUNDLED_WORKFLOW_DIR; beads-drain does NOT (it moved to the beads extension)", async () => {
    assert.equal(
      path.resolve(WORKFLOWS_DIR),
      path.resolve(BUNDLED_WORKFLOW_DIR),
      "this repo's workflows/ dir is the plugin's bundled workflow dir",
    );
    for (const file of ALL_REPO_WORKFLOW_FILES) {
      const p = path.join(WORKFLOWS_DIR, file);
      const stat = await fs.stat(p);
      assert.equal(stat.isFile(), true, `${file} co-resides in the bundled dir`);
    }
    // beads-drain is no longer bundled — it is an extension asset.
    await assert.rejects(fs.stat(path.join(WORKFLOWS_DIR, "beads-drain.js")), /ENOENT/);
    const beadsStat = await fs.stat(path.join(BEADS_WORKFLOWS_DIR, "beads-drain.js"));
    assert.equal(beadsStat.isFile(), true, "beads-drain.js lives in the beads extension workflow dir");
  });

  test("same dir, disjoint authority: repo-* is read-only; beads-drain is mutating (pinned by each meta)", async () => {
    const { meta: reviewMeta } = await readWorkflow("repo-review.js");
    const { meta: bughuntMeta } = await readWorkflow("repo-bughunt.js");
    const { meta: beadsMeta } = await readWorkflow("beads-drain.js");

    const reviewAuth = resolveRunAuthority(reviewMeta);
    const bughuntAuth = resolveRunAuthority(bughuntMeta);
    const beadsAuth = resolveRunAuthority(beadsMeta);

    assertReadOnlyAuthority(reviewAuth, "repo-review");
    assertReadOnlyAuthority(bughuntAuth, "repo-bughunt");

    // beads-drain declares the mutating profile: integration authority (the flag that
    // opens edit/apply_patch in permissionRulesForAuthority) and integrationMode. Note
    // resolveRunAuthority keeps the defense flag readOnly=true alongside integration;
    // the truthful mutating indicator is integration/mode, not readOnly. Design C carries
    // no gate vocabulary on EITHER side any more (requiredGates was deleted with the
    // live-gate-probe subsystem) — the mutating/read-only split is expressed entirely by
    // integration/mode and the permission ruleset asserted below, not by a gate ceiling.
    assert.equal(beadsAuth.profile, "drain-autonomous-local");
    assert.equal(beadsAuth.integration, true);
    assert.equal(beadsAuth.mode, "integrationMode");
    assert.equal(Object.hasOwn(beadsAuth, "requiredGates"), false, "beads-drain authority must not carry requiredGates either");
    // The integration authority is exactly what opens the edit/apply_patch allow path:
    const beadsRules = permissionRulesForAuthority(beadsAuth);
    assert.equal(findRule(beadsRules, "edit").action, "allow", "beads-drain integration -> edit allowed");
    assert.equal(findRule(beadsRules, "apply_patch").action, "allow", "beads-drain integration -> apply_patch allowed");
    // ...while the read-only repo-* leaves in the SAME dir deny both:
    const reviewRules = permissionRulesForAuthority(reviewAuth);
    assert.equal(findRule(reviewRules, "edit").action, "deny");
    assert.equal(findRule(reviewRules, "apply_patch").action, "deny");
  });

  test("profile clamp: a repo-* workflow cannot obtain the drain-dry-run/beads-autonomous authority path", async () => {
    const { meta: bughuntMeta } = await readWorkflow("repo-bughunt.js");
    const { meta: beadsMeta } = await readWorkflow("beads-drain.js");

    // Even with an autonomous-local mode argument, a repo-* workflow's authority is
    // resolved from its own read-only-review profile — the mode has no effect.
    const repoAutonomous = resolveRunAuthority(bughuntMeta, { args: { mode: "autonomous-local" } });
    assertReadOnlyAuthority(repoAutonomous, "repo-bughunt with autonomous-local mode");

    // The beads authority remap is reachable ONLY when meta.name === "beads-drain".
    // authorityArgsForWorkflow returns the args untouched for repo-*, so the remap
    // that sets profile "drain-dry-run" never fires for a review workflow.
    assert.notEqual(authorityArgsForWorkflow(bughuntMeta, { args: { mode: "dry-run" } }).profile, "drain-dry-run");
    assert.equal(authorityArgsForWorkflow(beadsMeta, { args: { mode: "dry-run" } }).profile, "drain-dry-run");
  });
});
