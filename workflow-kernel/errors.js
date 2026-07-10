export class WorkflowCancelledError extends Error {
  constructor(message = "Workflow run was cancelled") {
    super(message);
    this.name = "WorkflowCancelledError";
    this.code = "WORKFLOW_CANCELLED";
    this.outcome = "cancelled";
  }
}

export class WorkflowTimeoutError extends Error {
  constructor(message) {
    super(message);
    this.name = "WorkflowTimeoutError";
    this.code = "WORKFLOW_TIMEOUT";
    this.outcome = "timeout";
  }
}

export class WorkflowBudgetStoppedError extends Error {
  constructor(message) {
    super(message);
    this.name = "WorkflowBudgetStoppedError";
    this.code = "WORKFLOW_BUDGET_STOPPED";
    this.outcome = "budget_stopped";
  }
}

export class WorkflowAuthorityError extends Error {
  constructor(message) {
    super(message);
    this.name = "WorkflowAuthorityError";
    this.code = "WORKFLOW_AUTHORITY_VIOLATION";
    this.outcome = "failure";
  }
}

// --- lane failure taxonomy: transient (retryable) vs terminal (fail-fast) ----------------
//
// classifyLaneError partitions a thrown lane error into "transient" (a provider
// rate-limit / overload / transport fault that a backed-off retry routinely clears)
// vs "terminal" (a misconfiguration — bad/unknown model id, auth rejection, request
// schema — that no retry can fix). The lane retry loop only retries the transient
// class, and the budget gate is re-checked before every retry, so a misconfigured
// or persistently-overloaded lane fails fast instead of burning the retry/cost budget
// (the "retry storm" hazard called out in the bead). Unknown/unmatched errors default
// to "terminal" so the runtime never silently turns an unclassified fault into a retry
// storm; this strictly preserves today's single-attempt behavior for everything except
// the clearly-transient signals below.

// Workflow control-flow errors are never a lane-network retry candidate: cancellation,
// budget stops, authority violations, and lane-deadline timeouts must propagate immediately.
const NON_RETRYABLE_ERROR_CODES = new Set([
  "WORKFLOW_CANCELLED",
  "WORKFLOW_TIMEOUT",
  "WORKFLOW_BUDGET_STOPPED",
  "WORKFLOW_AUTHORITY_VIOLATION",
]);

// HTTP statuses that mark a transient upstream condition (rate limit / overload /
// temporary unavailability) vs a terminal request-shape/auth/not-found rejection.
const TRANSIENT_HTTP_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504, 529]);
const TERMINAL_HTTP_STATUSES = new Set([400, 401, 403, 404, 405, 422]);

// Substrings that mark a transient, retryable upstream condition: provider rate
// limits / overload, and transport faults a fresh attempt routinely clears.
const TRANSIENT_ERROR_PATTERNS = [
  /\b429\b/,
  /\b503\b/,
  /\b529\b/,
  /rate.?limit/i,
  /overloaded/i,
  /too many requests/i,
  /temporar(?:il)?y unavailable/i,
  /service unavailable/i,
  /econnreset/i,
  /econnrefused/i,
  /etimedout/i,
  /\bepipe\b/i,
  /eai_again/i,
  /socket hang ?up/i,
  /connection (?:reset|closed|refused|aborted)/i,
  /network (?:error|timeout)/i,
];

// Substrings that mark a TERMINAL condition no retry can fix: an unknown/bad model id,
// authentication/authorization rejection, and request-shape/schema validation. Checked
// before the transient patterns so a "model not found" 404 stays terminal.
const TERMINAL_ERROR_PATTERNS = [
  /\b40[0-5]\b/,
  /\b422\b/,
  /unauthorized/i,
  /forbidden/i,
  /authentication/i,
  /invalid api[_ -]?key/i,
  /(?:unknown|invalid|unsupported|unrecognized|bad) model/i,
  /model[^.]*(?:not found|does not exist|is not valid|is invalid)/i,
  /no such model/i,
  /provider[^.]*not (?:found|configured|supported)/i,
];

function laneErrorStatus(error) {
  for (const candidate of [error?.status, error?.statusCode, error?.response?.status, error?.cause?.status]) {
    const n = Number(candidate);
    if (Number.isInteger(n)) return n;
  }
  return undefined;
}

function laneErrorText(error) {
  if (error == null) return "";
  const parts = [];
  if (typeof error === "string") parts.push(error);
  if (error.message) parts.push(String(error.message));
  if (error.error) parts.push(typeof error.error === "string" ? error.error : String(error.error?.message ?? ""));
  if (error.cause) parts.push(typeof error.cause === "string" ? error.cause : String(error.cause?.message ?? ""));
  return parts.join(" ");
}

export function classifyLaneError(error) {
  if (error?.code && NON_RETRYABLE_ERROR_CODES.has(error.code)) return "terminal";
  const status = laneErrorStatus(error);
  if (status !== undefined) {
    if (TERMINAL_HTTP_STATUSES.has(status)) return "terminal";
    if (TRANSIENT_HTTP_STATUSES.has(status)) return "transient";
  }
  const text = laneErrorText(error);
  if (TERMINAL_ERROR_PATTERNS.some((pattern) => pattern.test(text))) return "terminal";
  if (TRANSIENT_ERROR_PATTERNS.some((pattern) => pattern.test(text))) return "transient";
  return "terminal";
}

// Honor an upstream Retry-After. `error.retryAfterMs` is authoritative (already ms);
// a `retry-after` header / `error.retryAfter` is the HTTP convention (seconds).
export function retryAfterMsFromError(error) {
  if (Number.isFinite(error?.retryAfterMs) && error.retryAfterMs >= 0) return Math.floor(error.retryAfterMs);
  const headerValue = error?.headers?.["retry-after"] ?? error?.response?.headers?.["retry-after"] ?? error?.retryAfter;
  const headerSeconds = Number(
    headerValue,
  );
  if (Number.isFinite(headerSeconds) && headerSeconds >= 0) return Math.floor(headerSeconds * 1000);
  const headerDate = Date.parse(String(headerValue ?? ""));
  if (Number.isFinite(headerDate)) return Math.max(0, Math.floor(headerDate - Date.now()));
  return undefined;
}

export const DEFAULT_LANE_RETRY_BASE_MS = 250;
export const MAX_LANE_RETRY_DELAY_MS = 30_000;

// Exponential backoff with full jitter, capped at MAX_LANE_RETRY_DELAY_MS. When the
// upstream supplied a Retry-After (retryAfterMs), that delay is honored (still capped)
// instead of the computed exponential one. `attempt` is the 1-based index of the retry
// that is about to be waited out (1 = first retry).
export function computeLaneBackoffMs(attempt, options = {}) {
  const {
    baseMs = DEFAULT_LANE_RETRY_BASE_MS,
    maxMs = MAX_LANE_RETRY_DELAY_MS,
    retryAfterMs,
    jitter = Math.random,
  } = options;
  if (Number.isFinite(retryAfterMs) && retryAfterMs >= 0) return Math.min(Math.floor(retryAfterMs), maxMs);
  const exponential = baseMs * 2 ** Math.max(0, attempt - 1);
  const capped = Math.min(exponential, maxMs);
  const half = capped / 2;
  return Math.min(maxMs, Math.round(half + jitter() * half));
}
