import test from "node:test";
import assert from "node:assert/strict";

import { MAX_RESULT_BYTES } from "../workflow-kernel/constants.js";
import {
  assertResultSize,
  compileSchemaWithIdentity,
  structuredFormat,
  validateStructuredResult,
} from "../workflow-kernel/structured-output.js";

test("structuredFormat builds the json_schema prompt format without retryCount", () => {
  const schema = { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] };

  assert.deepEqual(structuredFormat(schema), {
    type: "json_schema",
    schema,
  });
});

test("validateStructuredResult accepts schema-shaped values and rejects invalid ones", () => {
  const schema = {
    type: "object",
    properties: { ok: { type: "boolean" } },
    required: ["ok"],
    additionalProperties: false,
  };

  assert.doesNotThrow(() => validateStructuredResult(schema, { ok: true }));
  assert.throws(
    () => validateStructuredResult(schema, { ok: "true" }),
    /must be boolean/,
  );
  assert.throws(
    () => validateStructuredResult(schema, { ok: true, extra: "nope" }),
    /must NOT have additional properties/,
  );
});

test("validateStructuredResult reuses cloned schemas with $id without duplicate-id failures", () => {
  const schema = {
    $id: "https://example.test/opencode-workflows/structured-output/reused-schema",
    type: "object",
    properties: { ok: { type: "boolean" } },
    required: ["ok"],
    additionalProperties: false,
  };
  const dumpedClone = JSON.parse(JSON.stringify(schema));

  assert.doesNotThrow(() => validateStructuredResult(schema, { ok: true }));
  assert.doesNotThrow(() => validateStructuredResult(dumpedClone, { ok: false }));
  assert.throws(
    () => validateStructuredResult(JSON.parse(JSON.stringify(schema)), { ok: "no" }),
    /must be boolean/,
  );
});

test("validateStructuredResult does not validate a drifted schema with a stale $id validator", () => {
  const id = "https://example.test/opencode-workflows/structured-output/drifting-schema";
  const first = {
    $id: id,
    type: "object",
    properties: { mode: { type: "string" } },
    required: ["mode"],
    additionalProperties: false,
  };
  // A DIFFERENT schema reusing the same $id: now `count` is required and permitted. If the code
  // trusted the $id alone it would reuse `first`'s validator and (a) accept a payload missing
  // `count`, and (b) reject `count` as an additional property.
  const drifted = {
    $id: id,
    type: "object",
    properties: { mode: { type: "string" }, count: { type: "integer" } },
    required: ["mode", "count"],
    additionalProperties: false,
  };

  assert.doesNotThrow(() => validateStructuredResult(first, { mode: "run" }));
  // Under the drifted schema, a payload missing `count` is INVALID and must be rejected.
  assert.throws(
    () => validateStructuredResult(drifted, { mode: "run" }),
    /count/,
  );
  // ...and a payload satisfying the drifted schema must be accepted (the stale validator would
  // have rejected `count` as an additional property).
  assert.doesNotThrow(() => validateStructuredResult(drifted, { mode: "run", count: 2 }));
  // The original schema must still validate against its OWN rules after the drift+recompile.
  assert.doesNotThrow(() => validateStructuredResult(JSON.parse(JSON.stringify(first)), { mode: "again" }));
});

test("compileSchemaWithIdentity recompiles on $id content drift and reuses on content match", () => {
  const id = "https://example.test/opencode-workflows/structured-output/identity-reuse";
  const schemaA = { $id: id, type: "object", properties: { a: { type: "boolean" } }, required: ["a"] };
  const validateA = compileSchemaWithIdentity(schemaA);
  // Same content (cloned) under the same $id -> reuse the already-registered validator.
  assert.equal(compileSchemaWithIdentity(JSON.parse(JSON.stringify(schemaA))), validateA);

  const schemaB = { $id: id, type: "object", properties: { b: { type: "boolean" } }, required: ["b"] };
  const validateB = compileSchemaWithIdentity(schemaB);
  assert.notEqual(validateB, validateA);
  assert.equal(validateB({ b: true }), true);
  assert.equal(validateB({ a: true }), false); // `b` is now required
  // Previously-returned validators keep validating their own schema after the recompile.
  assert.equal(validateA({ a: true }), true);
});

test("assertResultSize enforces the maximum serialized result byte length", () => {
  assert.doesNotThrow(() => assertResultSize({ ok: true }));
  assert.doesNotThrow(() => assertResultSize(null));

  assert.throws(
    () => assertResultSize("x".repeat(MAX_RESULT_BYTES)),
    new RegExp(`Workflow output exceeds ${MAX_RESULT_BYTES} bytes`),
  );
});
