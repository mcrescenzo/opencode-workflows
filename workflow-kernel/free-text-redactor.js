// free-text-redactor.js — content-based (value) secret masking for user-visible text.
//
// The kernel's redactValue (text-json.js) combines key-based redaction for sensitive object
// keys with this value-based scanner for prose strings. Domain workflows that can discover
// secrets still run their own in-guest masking before returning report envelopes, so raw
// values are removed before both durable persistence and operator display.
//
// This module is the SHARED, pure, idempotent free-text masker applied at the user-visible
// DISPLAY boundaries (salvage preview snippet, lane taskSummary/title/errorSummary
// derivation, compact status text, and notification toast text) BEFORE truncation. It masks
// common credential-like VALUES embedded in prose so a model that pasted a raw token into
// assistant text, a lane label, or an error summary cannot leak through a preview/status/toast.
//
// Scope note: raw transcripts remain local-sensitive by design; durable controller artifacts
// and display projections use this scanner through redactValue/redactDurableValue. Approval,
// source, and diff-plan HASHES are computed from raw approved material and are never fed masked
// text, so this masking cannot perturb a hash.
//
// All regexes are linear (no nested/overlapping quantifiers) to avoid catastrophic
// backtracking. The fixed placeholder [REDACTED:secret] is deliberately composed of characters
// ([ ] : and the word "secret"/"redacted") that are NOT present in any secret-value character
// class below, so a second pass finds nothing to match — the function is idempotent by
// construction (redact(redact(x)) === redact(x)).

// Fixed, non-reversible replacement. The brackets/colons keep it out of every value char class.
const PLACEHOLDER = "[REDACTED:secret]";

// Well-known credential SHAPES (whole-token match → mask the entire token).
//
// AWS access key id: AKIA + 16+ uppercase alphanumerics (real keys are exactly 20 chars).
const AWS_ACCESS_KEY_RE = /\bAKIA[0-9A-Z]{16,}\b/g;
// Provider tokens with a known prefix, allowing internal hyphen-separated segments so the
// OpenAI `sk-proj-<long>` shape is matched (the prior in-guest regex missed embedded hyphens).
// Segment form `(?:[A-Za-z0-9]+-)*[A-Za-z0-9]{8,}` is unambiguous (hyphen is the sole
// delimiter and is not in the segment class) → linear, no catastrophic backtracking.
const PROVIDER_TOKEN_RE = /\b(sk|pk|ghp|gho|github_pat|xox[baprs])[-_](?:[A-Za-z0-9]+[-_])*[A-Za-z0-9]{8,}/g;
// PEM private key blocks (lazy up to the matching END marker, or EOF for truncated blocks).
const PEM_KEY_RE = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g;

// `Bearer <token>` / `Authorization: Bearer <token>` — mask only the token portion, keeping the
// keyword for readability. Capture group 1 is the "bearer " prefix; the trailing value run is the
// token. Value class excludes whitespace/brackets so it cannot run past the token.
const BEARER_RE = /(\bbearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi;
// HTTP Basic credentials are base64-ish and commonly appear in diagnostics/log errors.
const BASIC_RE = /(\bbasic\s+)[A-Za-z0-9+/=]{8,}/gi;

// Generic key/value ASSIGNMENTS in env-ish, colon-ish, and JSON-ish contexts:
//   secret=value   api_key: value   "token":"value"   password = "value"
// Anchored on the key NAME (so common prose words are not redacted unless they appear as an
// assignment key), with an optional quote between key and separator to absorb JSON's `"key":`.
// Only the VALUE (group 2) is masked; the key + separator are preserved so the surrounding text
// stays readable. The value minimum (8 chars) avoids masking short common words.
const ASSIGN_RE = /\b(api[_-]?key|apikey|access[_-]?token|refresh[_-]?token|secret[_-]?key|secret|password|passwd|auth[_-]?token|authorization|aws[_-]?secret[_-]?access[_-]?key|aws[_-]?access[_-]?key[_-]?id|client[_-]?secret|private[_-]?key|token)\b["']?\s*[:=]\s*["']?([^\s"'`,;]{8,})/gi;

function maskWhole() {
  return PLACEHOLDER;
}

function maskValueOnly(match, key, value) {
  // `key` is capture group 1 (the key name); `value` is capture group 2 (the secret).
  // Preserve everything before the value (key + separator + optional quotes); mask only the
  // value run so the surrounding assignment stays readable.
  return match.slice(0, match.length - value.length) + PLACEHOLDER;
}

function maskBearer(match, prefix) {
  return prefix + PLACEHOLDER;
}

// Mask common credential-like values embedded in free text. Pure and idempotent.
//
// @param {string} text - the source text to mask.
// @param {object} [options] - reserved for future use (accepted but currently ignored; the
//   placeholder is fixed so the idempotency guarantee always holds).
// @returns {string} the text with detected secrets replaced by [REDACTED:secret].
export function redactFreeTextSecrets(text, options) {
  if (typeof text !== "string" || text.length === 0) return text;
  // `options` is intentionally accepted but not consumed: the placeholder is fixed to preserve
  // the idempotency guarantee, so no knob may change it. Kept on the signature per contract.
  void options;
  let out = text;
  out = out.replace(PROVIDER_TOKEN_RE, maskWhole);
  out = out.replace(AWS_ACCESS_KEY_RE, maskWhole);
  out = out.replace(PEM_KEY_RE, maskWhole);
  out = out.replace(BEARER_RE, maskBearer);
  out = out.replace(BASIC_RE, maskBearer);
  out = out.replace(ASSIGN_RE, maskValueOnly);
  return out;
}

export { PLACEHOLDER as REDACTED_PLACEHOLDER };
