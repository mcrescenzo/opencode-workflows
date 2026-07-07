import test from "node:test";
import assert from "node:assert/strict";

import { permissionRulesForAuthority, toolAuthority } from "../workflow-kernel/authority-policy.js";

test("permissionRulesForAuthority allows apply_patch under edit authority", () => {
  const rules = permissionRulesForAuthority({ readOnly: false, edit: true });
  const rule = rules.find((r) => r.permission === "apply_patch");
  assert.ok(rule, "apply_patch rule must be present");
  assert.equal(rule.action, "allow", "apply_patch must be allowed for an edit-authorized lane");
  assert.equal(rule.pattern, "*");
});

test("permissionRulesForAuthority allows apply_patch under worktreeEdit and integration authority", () => {
  for (const authority of [{ worktreeEdit: true }, { integration: true }]) {
    const rule = permissionRulesForAuthority(authority).find((r) => r.permission === "apply_patch");
    assert.ok(rule && rule.action === "allow", `apply_patch must be allowed under ${JSON.stringify(authority)}`);
  }
});

test("permissionRulesForAuthority denies apply_patch for a read-only lane", () => {
  const rule = permissionRulesForAuthority({ readOnly: true }).find((r) => r.permission === "apply_patch");
  assert.ok(rule, "apply_patch rule must be present");
  assert.equal(rule.action, "deny", "read-only lanes must not be able to edit via apply_patch");
});

test("catch-all deny precedes the apply_patch allow so last-match-wins allows it", () => {
  const rules = permissionRulesForAuthority({ edit: true });
  const denyAllIdx = rules.findIndex((r) => r.permission === "*" && r.pattern === "*" && r.action === "deny");
  const applyIdx = rules.findIndex((r) => r.permission === "apply_patch");
  assert.ok(denyAllIdx !== -1 && applyIdx !== -1);
  assert.ok(denyAllIdx < applyIdx, "catch-all deny must come before apply_patch allow (last-match-wins)");
});

test("apply_patch is classified as an edit-class tool authority", () => {
  assert.equal(toolAuthority("apply_patch"), "edit");
});
