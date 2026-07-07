import test from "node:test";
import assert from "node:assert/strict";

import { permissionRulesForAuthority } from "../workflow-kernel/authority-policy.js";

test("permissionRulesForAuthority includes structured_output allow under readOnly", () => {
  const rules = permissionRulesForAuthority({ readOnly: true });
  const soRule = rules.find(
    (r) => r.permission === "structured_output" && r.action === "allow",
  );
  assert.ok(soRule, "structured_output allow rule must be present for schema lanes to work under deny-by-default");
  assert.equal(soRule.pattern, "*");
});

test("permissionRulesForAuthority includes structured_output allow under edit authority", () => {
  const rules = permissionRulesForAuthority({ readOnly: false, edit: true });
  const soRule = rules.find(
    (r) => r.permission === "structured_output" && r.action === "allow",
  );
  assert.ok(soRule, "structured_output allow rule must be present under edit authority too");
});

test("catch-all deny rule is before structured_output allow so last-match-wins allows it", () => {
  const rules = permissionRulesForAuthority({ readOnly: true });
  const denyAllIdx = rules.findIndex(
    (r) => r.permission === "*" && r.pattern === "*" && r.action === "deny",
  );
  const soIdx = rules.findIndex((r) => r.permission === "structured_output");
  assert.ok(denyAllIdx !== -1, "catch-all deny must exist");
  assert.ok(soIdx !== -1, "structured_output allow must exist");
  assert.ok(
    denyAllIdx < soIdx,
    "catch-all deny must come before structured_output allow (last-match-wins semantics)",
  );
});
