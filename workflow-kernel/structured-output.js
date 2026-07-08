import Ajv from "ajv";

import { MAX_RESULT_BYTES } from "./constants.js";
import { hash, stableStringify } from "./text-json.js";

export const ajv = new Ajv({ allErrors: true, strict: false });
export const MAX_SCHEMA_SNAPSHOT_BYTES = 16 * 1024;

const VALIDATOR_HASH_CACHE_MAX = 256;

// Bounded, insertion-ordered validator cache keyed by canonical schema hash.
// schema values originate from guest workflow source (untrusted per AGENTS.md/SECURITY.md)
// and this cache lives for the whole plugin process, shared across every workflow run, so
// it must be bounded to honor the "bound all module-level maps / no unbounded accumulation"
// invariant. Uses the same oldest-first eviction as BoundedTimestampSet in
// workflow-kernel/lifecycle-control.js (Map preserves insertion order).
class BoundedValidatorCache {
  constructor({ max = VALIDATOR_HASH_CACHE_MAX } = {}) {
    this.max = max;
    this.items = new Map();
  }

  get(key) {
    return this.items.get(key);
  }

  set(key, value) {
    if (this.items.has(key)) this.items.delete(key);
    this.items.set(key, value);
    while (this.items.size > this.max) {
      const oldest = this.items.keys().next().value;
      if (oldest === undefined) break;
      this.items.delete(oldest);
    }
    return this;
  }

  get size() {
    return this.items.size;
  }
}

const validatorCache = new WeakMap();
const validatorHashCache = new BoundedValidatorCache();

// Maps a schema $id to the canonical content hash of the schema last compiled under it.
// Ajv treats $id as a stable, unique content identity: ajv.getSchema($id) returns whatever
// validator was FIRST registered under that id and never re-checks it against the schema
// passed on this call. Guest workflow schemas are untrusted (AGENTS.md/SECURITY.md) and can
// reuse one $id for a differently-shaped schema, which would otherwise be validated with the
// stale wrong rules. We record the content hash per id so we can detect drift and
// remove+recompile instead of trusting the id string forever. Bounded for the same
// module-level-map reason as validatorHashCache.
const registeredSchemaIdHashes = new BoundedValidatorCache();

// Compile `schema` into an AJV validator, reusing an already-registered $id validator ONLY when
// the schema content still hashes to what was registered under that $id. On content drift (a reused
// $id carrying a different shape) the stale registration is removed before recompiling, so a payload
// is never silently validated against a different schema's rules. Falls back to a plain compile for
// schemas without a usable $id (AJV never rejects those as duplicate ids).
export function compileSchemaWithIdentity(schema) {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return ajv.compile(schema);
  const id = typeof schema.$id === "string" && schema.$id.trim() ? schema.$id : null;
  if (!id) return ajv.compile(schema);
  const schemaKey = hash(stableStringify(schema));
  const existing = ajv.getSchema(id);
  if (existing && registeredSchemaIdHashes.get(id) === schemaKey) return existing;
  // Either the $id is registered with a different (or unverified) schema, or we hold no proof its
  // content matches: drop the stale registration before compiling the schema passed on this call.
  if (existing) ajv.removeSchema(id);
  const validate = ajv.compile(schema);
  registeredSchemaIdHashes.set(id, schemaKey);
  return validate;
}

function compiledValidator(schema) {
  if (!schema || typeof schema !== "object") return ajv.compile(schema);
  let validate = validatorCache.get(schema);
  if (validate) return validate;
  const schemaKey = hash(stableStringify(schema));
  validate = validatorHashCache.get(schemaKey);
  if (!validate) {
    // Content-cache miss: compile via the identity-checked path so a reused $id can't return a
    // stale validator compiled for a different schema.
    validate = compileSchemaWithIdentity(schema);
    validatorHashCache.set(schemaKey, validate);
  }
  validatorCache.set(schema, validate);
  return validate;
}

export function validateStructuredResult(schema, value) {
  const validate = compiledValidator(schema);
  if (validate(value)) return;
  throw new Error(ajv.errorsText(validate.errors, { separator: "\n", dataVar: "result" }));
}

export function boundedSchemaSnapshot(schema, maxBytes = MAX_SCHEMA_SNAPSHOT_BYTES) {
  if (!schema) return { status: "absent" };
  const canonical = stableStringify(schema);
  const bytes = Buffer.byteLength(canonical, "utf8");
  const schemaHash = hash(canonical);
  if (bytes > maxBytes) return { status: "oversized", bytes, hash: schemaHash };
  return { status: "present", bytes, hash: schemaHash, schema };
}


export function structuredTextInstruction(schema) {
  return [
    "Your final response MUST be a single valid JSON object matching this JSON Schema.",
    "Do not include markdown, code fences, commentary, or any text before or after the JSON.",
    "JSON Schema:\n" + JSON.stringify(schema),
  ].join("\n\n");
}

export function structuredCorrectiveInstruction(schema, validationMessage) {
  return [
    `Your previous response failed validation: ${String(validationMessage ?? "unknown validation error")}.`,
    "Reply again with ONLY a corrected JSON object. Do not include markdown, code fences, commentary, or any text before or after the JSON.",
    "JSON Schema:\n" + JSON.stringify(schema),
  ].join("\n\n");
}

export function parseStructuredTextResult(text) {
  const raw = String(text ?? "").trim();
  if (!raw) throw new Error("Structured text fallback returned an empty response");
  try {
    return JSON.parse(raw);
  } catch (e) {
    const s = raw.indexOf("{"), t = raw.lastIndexOf("}");
    if (s >= 0 && t > s) return JSON.parse(raw.slice(s, t + 1));
    throw e;
  }
}

export function assertResultSize(value) {
  const bytes = Buffer.byteLength(JSON.stringify(value ?? null), "utf8");
  if (bytes > MAX_RESULT_BYTES) throw new Error(`Workflow output exceeds ${MAX_RESULT_BYTES} bytes`);
}
