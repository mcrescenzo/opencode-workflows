import {
  MAX_INLINE_RESULT_BYTES,
  MAX_RESULT_READBACK_BYTES,
} from "./constants.js";
import { redactValue } from "./text-json.js";

const FULL_RESULT_REDACTION = {
  maxDepth: Number.POSITIVE_INFINITY,
  maxString: Number.POSITIVE_INFINITY,
  maxArray: Number.POSITIVE_INFINITY,
};

const PARTIAL_READBACK_LIMITS = [
  { maxDepth: Number.POSITIVE_INFINITY, maxString: 16 * 1024, maxArray: 500 },
  { maxDepth: Number.POSITIVE_INFINITY, maxString: 8 * 1024, maxArray: 250 },
  { maxDepth: 20, maxString: 4 * 1024, maxArray: 100 },
  { maxDepth: 12, maxString: 2 * 1024, maxArray: 50 },
  { maxDepth: 8, maxString: 1024, maxArray: 25 },
  { maxDepth: 6, maxString: 600, maxArray: 10 },
  { maxDepth: 4, maxString: 240, maxArray: 5 },
];

function normalizeJsonValue(value) {
  return value === undefined ? null : value;
}

function jsonText(value, { pretty = false } = {}) {
  return JSON.stringify(normalizeJsonValue(value), null, pretty ? 2 : 0);
}

function byteLength(text) {
  return Buffer.byteLength(String(text ?? ""), "utf8");
}

function serializedBytes(value) {
  return byteLength(jsonText(value));
}

function resultSummary(value) {
  if (Array.isArray(value)) return { type: "array", length: value.length };
  if (value && typeof value === "object") return { type: "object", keys: Object.keys(value).slice(0, 50) };
  return { type: value === null ? "null" : typeof value };
}

export function redactResultValue(value, options = {}) {
  return redactValue(value, { ...FULL_RESULT_REDACTION, ...options });
}

export function inlineResultProjection(value, { maxBytes = MAX_INLINE_RESULT_BYTES } = {}) {
  const result = redactResultValue(value);
  const text = jsonText(result, { pretty: true });
  const bytes = byteLength(text);
  if (bytes > maxBytes) return { inline: false, bytes, maxBytes, result };
  return { inline: true, bytes, maxBytes, text, result };
}

export function resultReadbackProjection(value, { maxBytes = MAX_RESULT_READBACK_BYTES } = {}) {
  const full = redactResultValue(value);
  const fullBytes = serializedBytes(full);
  if (fullBytes <= maxBytes) {
    return {
      result: full,
      resultReadback: {
        mode: "full",
        truncated: false,
        bytes: fullBytes,
        maxBytes,
      },
    };
  }

  for (const limits of PARTIAL_READBACK_LIMITS) {
    const candidate = redactResultValue(value, limits);
    const bytes = serializedBytes(candidate);
    if (bytes <= maxBytes) {
      return {
        result: candidate,
        resultReadback: {
          mode: "partial",
          truncated: true,
          bytes,
          fullBytes,
          maxBytes,
          limits,
        },
      };
    }
  }

  const summary = {
    status: "truncated",
    reason: `Result readback exceeds ${maxBytes} bytes after bounded projection`,
    summary: resultSummary(full),
  };
  return {
    result: summary,
    resultReadback: {
      mode: "summary",
      truncated: true,
      bytes: serializedBytes(summary),
      fullBytes,
      maxBytes,
    },
  };
}
