import test from "node:test";
import assert from "node:assert/strict";

import { parseBdJson, defaultRunBd } from "../workflow-domains/beads/beads-bd-util.js";

// Shared bd helpers extracted from the two beads adapters (Stage 6b). Only the genuinely-identical
// helpers are shared; normalizeIssue stays per-adapter (the two implementations diverge by design).

test("parseBdJson parses valid JSON", () => {
  assert.deepEqual(parseBdJson('[{"id":"a"}]'), [{ id: "a" }]);
  assert.deepEqual(parseBdJson('{"ok":true}'), { ok: true });
});

test("parseBdJson returns null for empty/whitespace stdout", () => {
  assert.equal(parseBdJson(""), null);
  assert.equal(parseBdJson("   \n  "), null);
  assert.equal(parseBdJson(undefined), null);
});

test("parseBdJson throws with the command label on invalid JSON", () => {
  assert.throws(() => parseBdJson("not json", "bd list"), /bd list returned invalid JSON/);
});

test("defaultRunBd is an async function (bd shell-out)", () => {
  assert.equal(typeof defaultRunBd, "function");
});
