import test from "node:test";
import assert from "node:assert/strict";

import { MAX_RESULT_BYTES } from "../workflow-kernel/constants.js";
import {
  assertResultSize,
  compileSchemaWithIdentity,
  parseStructuredTextResult,
  structuredCorrectiveInstruction,
  structuredTextInstruction,
  validateStructuredResult,
} from "../workflow-kernel/structured-output.js";

// Design C (2026-07-07): schema lanes are structured-TEXT only — the `format` prompt key
// (and the structuredFormat() helper that built it) was deleted along with the live-gate
// probe subsystem. A schema-bearing lane instead gets an in-prompt instruction to reply with
// bare JSON (structuredTextInstruction/structuredCorrectiveInstruction), and the child's
// final text is parsed back out with parseStructuredTextResult.

test("structuredTextInstruction embeds the JSON Schema and forbids markdown/commentary", () => {
  const schema = { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] };
  const instruction = structuredTextInstruction(schema);

  assert.match(instruction, /single valid JSON object/);
  assert.match(instruction, /Do not include markdown/);
  assert.ok(instruction.includes(JSON.stringify(schema)), "instruction must embed the literal schema JSON");
});

test("structuredCorrectiveInstruction surfaces the prior validation failure and re-embeds the schema", () => {
  const schema = { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] };
  const instruction = structuredCorrectiveInstruction(schema, "result.ok must be boolean");

  assert.match(instruction, /previous response failed validation: result\.ok must be boolean/);
  assert.match(instruction, /Reply again with ONLY a corrected JSON object/);
  assert.ok(instruction.includes(JSON.stringify(schema)), "corrective instruction must re-embed the literal schema JSON");
});

test("parseStructuredTextResult parses bare JSON and recovers JSON embedded in surrounding prose", () => {
  assert.deepEqual(parseStructuredTextResult('{"ok":true}'), { ok: true });
  assert.deepEqual(parseStructuredTextResult('  {"ok":true}  \n'), { ok: true });
  // Tolerates a model wrapping the JSON in commentary/code fences despite the instruction.
  assert.deepEqual(parseStructuredTextResult('```json\n{"ok":true}\n```'), { ok: true });
  assert.deepEqual(parseStructuredTextResult('Here is the result: {"ok":true} — done.'), { ok: true });
});

test("parseStructuredTextResult throws on empty or unrecoverable non-JSON text", () => {
  assert.throws(() => parseStructuredTextResult(""), /empty response/);
  assert.throws(() => parseStructuredTextResult("   "), /empty response/);
  assert.throws(() => parseStructuredTextResult("not json at all"));
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
