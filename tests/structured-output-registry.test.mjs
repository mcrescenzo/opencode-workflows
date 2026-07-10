import test from "node:test";
import assert from "node:assert/strict";

import { ajv, compileSchemaWithIdentity } from "../workflow-kernel/structured-output.js";

// Structured-output ajv-registry eviction regression split out of the historical
// bughunt-error-state catch-all (opencode-workflows-fnop.9). Covers the bad-state-13 finding:
// compileSchemaWithIdentity() registered every $id-bearing schema into the shared module-level
// ajv instance, but the bounded bookkeeping cache (registeredSchemaIdHashes) never told ajv to
// forget an evicted id, so ajv's own registry grew unbounded even though the wrapping cache
// claimed to be bounded.

test("compileSchemaWithIdentity evicts ajv's own registry in lockstep with the bounded id-hash cache", () => {
  // Mirrors VALIDATOR_HASH_CACHE_MAX (256) in structured-output.js, which bounds
  // registeredSchemaIdHashes. Not exported, so pinned here as a literal.
  const BOUND = 256;
  const prefix = "https://example.test/opencode-workflows/bughunt-bound/schema-";
  const total = BOUND + 40;

  for (let i = 0; i < total; i++) {
    compileSchemaWithIdentity({
      $id: `${prefix}${i}`,
      type: "object",
      properties: { i: { type: "integer" } },
      required: ["i"],
    });
  }

  // The earliest ids must be gone from ajv itself, not just forgotten by the bookkeeping map
  // while lingering in ajv's registry forever (the bug: eviction only touched our own Map).
  for (let i = 0; i < total - BOUND; i++) {
    assert.equal(ajv.getSchema(`${prefix}${i}`), undefined, `schema ${i} should have been evicted from ajv`);
  }
  // The most recently compiled BOUND ids remain resolvable.
  for (let i = total - BOUND; i < total; i++) {
    assert.ok(ajv.getSchema(`${prefix}${i}`), `schema ${i} should still be registered`);
  }

  const registeredForPrefix = Object.keys(ajv.refs).filter((key) => key.startsWith(prefix));
  assert.equal(
    registeredForPrefix.length,
    BOUND,
    "ajv's internal registry must stay bounded in lockstep with registeredSchemaIdHashes, not grow unboundedly",
  );
});
