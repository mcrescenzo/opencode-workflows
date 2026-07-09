import crypto from "node:crypto";

import { MAX_ARGS_PREVIEW_CHARS, MAX_STATUS_STRING_CHARS, SENSITIVE_KEY_RE } from "./constants.js";
import { redactFreeTextSecrets } from "./free-text-redactor.js";

const SAFE_USAGE_KEY_RE = /^(tokens|tokenUsage|usageTokens)$/i;
const SAFE_USAGE_METRIC_KEYS = new Set(["input", "output", "reasoning", "total", "cached"]);

export function stableStringify(value) {
  // R29: mirror JSON.stringify / writeJsonAtomic for undefined so an in-memory hash
  // matches the hash recomputed from the persisted (JSON.stringify'd) file. JSON.stringify
  // drops undefined-valued object keys and coerces undefined array elements to null; a
  // standalone undefined serializes to the JS value undefined, which we represent with a
  // stable sentinel only at the top level (object/array recursion never reaches it).
  if (value === undefined) return "undefined";
  if (typeof value === "bigint") return JSON.stringify(String(value));
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => (item === undefined ? "null" : stableStringify(item))).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .filter((key) => value[key] !== undefined)
    .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
    .join(",")}}`;
}

export function hash(value) {
  return crypto.hash("sha256", value, "hex");
}

export function hashStable(value) {
  return hash(stableStringify(value));
}

export function jsonLine(value) {
  return `${JSON.stringify(value)}\n`;
}

export function hasFunction(value, key) {
  return typeof value?.[key] === "function";
}

export function textPart(text) {
  return { type: "text", text };
}

// Cap a string to at most `max` characters without ever appending the (oversized)
// truncation marker. Used only for the degenerate small-max branch of truncateText,
// where the marker itself would not fit. Prefers a short "..." ellipsis when there is
// room for it, otherwise falls back to a plain slice; never splits a trailing surrogate.
function hardTruncate(string, max) {
  if (max <= 0) return "";
  if (max <= 3) return string.slice(0, max);
  let head = string.slice(0, max - 3);
  const last = head.charCodeAt(head.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) head = head.slice(0, -1);
  return `${head}...`;
}

export function truncateText(text, max = MAX_STATUS_STRING_CHARS) {
  const string = String(text ?? "");
  if (string.length <= max) return string;
  // The reported drop-count must reflect how many characters are ACTUALLY dropped
  // (string.length - head.length), not string.length - max: the suffix is carved out
  // of the max-character budget, so the head keeps fewer than max chars. There is a
  // mutual dependency — the suffix length depends on the count's digits, and the head
  // length depends on the suffix length — so iterate to a fixed point (converges in a
  // few steps because the count changes by at most one digit per pass).
  let n = string.length - max;
  let head = "";
  let suffix = "";
  for (let i = 0; i < 5; i++) {
    suffix = `...[truncated ${n} chars]`;
    // Degenerate case: when the truncation marker alone is at least as long as the
    // whole budget, appending it to any head would blow past max. Hard-cap at exactly
    // max characters instead so the result.length <= max invariant holds for every max.
    if (suffix.length >= max) return hardTruncate(string, max);
    head = string.slice(0, Math.max(0, max - suffix.length));
    const last = head.charCodeAt(head.length - 1);
    if (last >= 0xd800 && last <= 0xdbff) head = head.slice(0, -1);
    const dropped = string.length - head.length;
    if (dropped === n) break;
    n = dropped;
  }
  return `${head}${suffix}`;
}

function isSafeUsageObject(key, value) {
  if (!SAFE_USAGE_KEY_RE.test(key) || !value || typeof value !== "object" || Array.isArray(value)) return false;
  const entries = Object.entries(value);
  return entries.length > 0 && entries.every(([metric, child]) => SAFE_USAGE_METRIC_KEYS.has(metric) && Number.isFinite(child));
}

export function redactValue(value, { depth = 0, maxDepth = 5, maxString = MAX_STATUS_STRING_CHARS, maxArray = 50 } = {}) {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return truncateText(redactFreeTextSecrets(value), maxString);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return String(value);
  if (depth >= maxDepth) return "[redacted:depth]";
  if (Array.isArray(value)) {
    const limit = Number.isFinite(maxArray) ? maxArray : value.length;
    return value.slice(0, limit).map((item) => redactValue(item, { depth: depth + 1, maxDepth, maxString, maxArray }));
  }
  if (typeof value === "object") {
    const redacted = {};
    for (const [key, child] of Object.entries(value)) {
      redacted[key] = SENSITIVE_KEY_RE.test(key) && !isSafeUsageObject(key, child) ? "[redacted]" : redactValue(child, { depth: depth + 1, maxDepth, maxString, maxArray });
    }
    return redacted;
  }
  return `[redacted:${typeof value}]`;
}

export function redactDurableValue(value) {
  return redactValue(value, {
    maxDepth: Number.POSITIVE_INFINITY,
    maxString: Number.POSITIVE_INFINITY,
    maxArray: Number.POSITIVE_INFINITY,
  });
}

export function jsonPreview(value, max = MAX_ARGS_PREVIEW_CHARS) {
  const text = JSON.stringify(redactValue(value), null, 2);
  return truncateText(text, max);
}

export function responseText(result) {
  return (result?.data?.parts ?? [])
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n")
    .trim();
}

export function extractTextFromError(error) {
  return error?.message || String(error);
}

// jbs3.10: render a one-line, human-readable summary of a workflow's declared meta.argsSchema so
// `workflow_list` advertises the args contract (which keys are accepted, which are required) without
// dumping the whole schema. Returns undefined when no usable object schema is declared.
export function summarizeArgsSchema(schema) {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return undefined;
  const properties = schema.properties && typeof schema.properties === "object" && !Array.isArray(schema.properties)
    ? schema.properties
    : undefined;
  const required = new Set(Array.isArray(schema.required) ? schema.required.filter((k) => typeof k === "string") : []);
  if (!properties) {
    // No property map (e.g. a bare type constraint); still surface the declared top-level type.
    return typeof schema.type === "string" ? `type=${schema.type}` : "declared";
  }
  const fields = Object.keys(properties).slice(0, 16).map((key) => {
    const propType = properties[key] && typeof properties[key].type === "string" ? properties[key].type : undefined;
    const label = propType ? `${key}:${propType}` : key;
    return required.has(key) ? `${label}*` : label;
  });
  if (fields.length === 0) return schema.additionalProperties === false ? "{} (no args)" : "declared";
  return `{ ${fields.join(", ")} }${Object.keys(properties).length > fields.length ? " …" : ""} (*=required)`;
}
