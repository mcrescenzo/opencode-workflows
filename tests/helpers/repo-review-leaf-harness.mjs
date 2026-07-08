// Reusable zero-token test harness for repo-* review leaf workflows.
//
// This is a factor of the patterns proven in tests/repo-bughunt.test.mjs. It
// lives in tests/ (NOT importable by QuickJS guest sources): guest workflow
// engines are self-contained and must duplicate the shared contract pieces
// verbatim into their own source — see docs/repo-review-leaf-contract.md
// § "How later leaves conform". Downstream leaf tests (repo-security-audit,
// repo-test-gaps, repo-cleanup, repo-modernize, repo-perf, repo-complexity,
// repo-deps) import the helpers below instead of re-deriving them.
//
// Every child session.prompt is routed to a canned payload by the shared
// harness (tests/helpers/harness.mjs); no real model is ever called (zero
// model tokens).

import assert from "node:assert/strict";

import { makeHarness } from "./harness.mjs";

export { makeHarness };
export { DEFAULT_CAPABILITIES } from "./harness.mjs";

// ---- approval / result helpers (operate on the shared harness tool surface) ----

// Preview -> extract approvalHash -> re-execute approved. Returns the raw run output string.
export async function runApprovedRequest(tools, context, request) {
  const preview = await tools.workflow_run.execute(request, context);
  const match = preview.match(/approvalHash: ([a-f0-9]{64})/);
  assert.ok(match, `missing approvalHash in preview: ${preview}`);
  return await tools.workflow_run.execute({ ...request, approve: true, approvalHash: match[1] }, context);
}

// Extract the run id from a workflow_run output string.
export function runIdFrom(output) {
  const match = output.match(/Workflow ([0-9a-f-]{36}) (?:completed|started|awaiting diff approval)/);
  assert.ok(match, `missing run id in output: ${output}`);
  return match[1];
}

// Resolve a run to its parsed envelope (the workflow return value). Asserts the
// run reached "completed" so a silent abort surfaces as a test failure.
export async function resultOutput(tools, context, runOutput) {
  const runId = runIdFrom(runOutput);
  const status = JSON.parse(await tools.workflow_status.execute({ runId, format: "json", detail: "result" }, context));
  assert.equal(status.status, "completed", `run not completed: ${JSON.stringify(status)}`);
  return status.result.output;
}

// Convenience: approved request -> parsed envelope in one call.
export async function runLeafEnvelope(tools, context, request) {
  const out = await runApprovedRequest(tools, context, request);
  return await resultOutput(tools, context, out);
}

// ---- response shapers ----

// Design C: structured-TEXT is the only schema-lane path (child-agent-runner.js
// never sends format: to session.prompt any more), so BOTH shapers below carry
// the JSON object in the text part and are parsed back by parseStructuredTextResult.
// `structured` is kept as a distinct name (rather than deleting it and rewriting
// every call site) purely so existing callers/fixtures across the repo-review-*
// leaf suites don't need renaming; it is otherwise identical to `textStructured`.
// The `info.structured` field is also still populated so any leftover assertions
// on it keep working, but it is no longer read by the kernel.
export function structured(obj) {
  return { data: { parts: [{ type: "text", text: JSON.stringify(obj) }], info: { structured: obj, tokens: { input: 1, output: 1, reasoning: 0 }, cost: 0 } } };
}

// Structured-TEXT response shape: the JSON object is carried in a text part
// (data.parts[].text) and parsed back by parseStructuredTextResult. This is the
// ONLY structured-output path (child-agent-runner.js injects
// structuredTextInstruction into the system prompt, sets outputFormat
// {type:"text"}, and extracts the JSON from the text part) regardless of what
// run.capabilities.structuredOutput reports.
export function textStructured(obj) {
  return { data: { parts: [{ type: "text", text: JSON.stringify(obj) }], info: { tokens: { input: 1, output: 1, reasoning: 0 }, cost: 0 } } };
}

// ---- generic leaf-prompt router builder ----
//
// `route(text, shape)` inspects the prompt text and returns a canned response.
// `shape` is `structured` (native) or `textStructured` (fallback) so the SAME
// route function drives both paths. Return undefined to fall through to
// `defaultLane` (also called with (text, shape)); a final empty response is
// returned if neither yields. Domain-specific routers (e.g. a bughunt route)
// are authored in each leaf test; this builder supplies the plumbing.
export function makeLeafPromptRouter(route, { fallbackShape = structured, defaultLane } = {}) {
  return async (input) => {
    const text = String(input?.body?.parts?.[0]?.text ?? "");
    const r = await route(text, fallbackShape);
    if (r !== undefined) return r;
    if (defaultLane) return await defaultLane(text, fallbackShape);
    return { data: { parts: [], info: {} } };
  };
}

// ---- contract constants (mirror docs/repo-review-leaf-contract.md) ----

export const LEAF_DOMAINS = [
  "bughunt", "security", "test-gaps", "cleanup", "modernize", "perf", "complexity", "deps",
];
// Only `security` populates the `critical` severity tier; the six other
// non-security domains keep counts.critical === 0.
export const SECURITY_DOMAINS = new Set(["security"]);
export const STATUS_VALUES = new Set(["ok", "empty", "aborted"]);
export const SEVERITY_VALUES = new Set(["critical", "high", "medium", "low"]);
export const EFFORT_VALUES = new Set(["small", "medium", "large"]);

// Common required finding fields (every domain, every finding). `confidence`
// and `effort` are required because ranking (severity * confidence * effort)
// is a leaf-invariant synthesis step.
export const REQUIRED_FINDING_FIELDS = [
  "id", "fingerprint", "rank", "category", "file", "line", "severity", "description", "confidence", "effort",
];

// Per-domain action fields beyond the common required set (cited from
// SUITE-CONTRACT § Per-domain carve-outs). Future leaf-port beads extend this
// map for their domain; bughunt's action fields are the exemplar.
export const DOMAIN_ACTION_FIELDS = {
  bughunt: ["reproSketch", "fixSketch", "proposedChange", "docImpact"],
};

// Top-level envelope extras per domain (required for that domain when present).
export const DOMAIN_TOP_LEVEL_EXTRAS = {
  cleanup: ["staleDocs"],
  modernize: ["migrationPlan"],
  deps: ["upgradePlan"],
};

// ---- envelope contract assertions ----

// Validate a leaf envelope against docs/repo-review-leaf-contract.md.
// Validates the top-level shape, the 5-tier counts, and status invariants.
// Use assertLeafFindings() for per-finding validation.
export function assertLeafEnvelope(env, domain, opts = {}) {
  assert.ok(env && typeof env === "object", "envelope must be an object");
  assert.ok(LEAF_DOMAINS.includes(domain), `unknown leaf domain: ${domain}`);
  assert.equal(env.domain, domain, `envelope.domain must be ${domain}`);
  assert.equal(env.schemaVersion, 1, "schemaVersion must be 1 (integer)");
  assert.ok(STATUS_VALUES.has(env.status), `status must be one of ${[...STATUS_VALUES].join("|")}, got ${env.status}`);
  assert.ok(env.abortReason === null || typeof env.abortReason === "string", "abortReason must be string|null");
  if (env.status === "aborted") {
    assert.ok(typeof env.abortReason === "string" && env.abortReason.length > 0, "aborted status requires a non-empty abortReason");
  }
  // reportPath is null/command-side only in OpenCode: the QuickJS guest cannot
  // write files; only the command wrapper persists .repo-review/runs/<run-id>-<domain>-report.md.
  assert.equal(env.reportPath, null, "reportPath must be null in OpenCode (command-side persistence only)");
  assert.equal(typeof env.summary, "string", "summary must be a string");
  assertLeafCounts(env.counts, domain);
  assert.ok(Array.isArray(env.findings), "findings must be an array");
  assert.equal(typeof env.truncatedFindings, "boolean", "truncatedFindings must be a boolean");
  assert.ok(env.reportMarkdown === null || typeof env.reportMarkdown === "string", "reportMarkdown must be string|null");
  if (env.status === "empty" || env.status === "aborted") {
    assert.equal(env.findings.length, 0, `${env.status} status must carry zero findings`);
    assert.equal(env.reportMarkdown, null, `${env.status} status must have null reportMarkdown`);
    assert.equal(env.truncatedFindings, false, `${env.status} status must have truncatedFindings === false`);
  } else if (env.status === "ok" && !opts.allowEmptyOk) {
    assert.ok(env.findings.length > 0, "ok status should carry at least one finding (pass allowEmptyOk to relax)");
  }
}

// Validate the always-5-tier counts object and the non-security critical:0 rule.
export function assertLeafCounts(counts, domain) {
  assert.ok(counts && typeof counts === "object", "counts must be an object");
  for (const key of ["total", "critical", "high", "medium", "low"]) {
    assert.ok(Number.isInteger(counts[key]), `counts.${key} must be an integer, got ${counts[key]}`);
    assert.ok(counts[key] >= 0, `counts.${key} must be >= 0, got ${counts[key]}`);
  }
  if (!SECURITY_DOMAINS.has(domain)) {
    assert.equal(counts.critical, 0, `non-security domain ${domain} must keep counts.critical === 0`);
  }
  const sum = counts.critical + counts.high + counts.medium + counts.low;
  assert.equal(counts.total, sum, `counts.total (${counts.total}) must equal critical+high+medium+low (${sum})`);
}

// Validate a single finding against the contract. `opts.requireActionFields`
// (default true) also checks the domain's declared action fields.
export function assertLeafFinding(f, domain, opts = {}) {
  assert.ok(f && typeof f === "object", "finding must be an object");
  for (const field of REQUIRED_FINDING_FIELDS) {
    assert.ok(f[field] !== undefined && f[field] !== null, `finding missing required field: ${field}`);
  }
  assert.equal(typeof f.id, "string", "finding.id must be a string (positional, in-run)");
  assert.equal(typeof f.fingerprint, "string", "finding.fingerprint must be a string (cross-run dedupe key)");
  assert.match(f.fingerprint, new RegExp(`^${domain}-[0-9a-f]+$`), `finding.fingerprint must match ^${domain}-<hex>$`);
  assert.ok(Number.isInteger(f.rank) && f.rank > 0, "finding.rank must be a positive integer");
  assert.equal(typeof f.category, "string", "finding.category must be a string");
  assert.equal(typeof f.file, "string", "finding.file must be a string");
  assert.ok(Number.isInteger(f.line) && f.line >= 0, "finding.line must be a non-negative integer");
  assert.ok(SEVERITY_VALUES.has(f.severity), `finding.severity must be one of ${[...SEVERITY_VALUES].join("|")}, got ${f.severity}`);
  if (!SECURITY_DOMAINS.has(domain)) {
    assert.notEqual(f.severity, "critical", `non-security domain ${domain} must not emit critical severity`);
  }
  assert.equal(typeof f.description, "string", "finding.description must be a string");
  assert.ok(
    Number.isInteger(f.confidence) && f.confidence >= 0 && f.confidence <= 100,
    `finding.confidence must be an integer 0-100, got ${f.confidence}`,
  );
  assert.ok(EFFORT_VALUES.has(f.effort), `finding.effort must be one of ${[...EFFORT_VALUES].join("|")}, got ${f.effort}`);
  if (opts.requireActionFields !== false) {
    for (const field of (DOMAIN_ACTION_FIELDS[domain] || [])) {
      assert.ok(f[field] !== undefined, `finding missing domain action field for ${domain}: ${field}`);
    }
  }
}

// Validate an findings array: every finding conforms, ranks are contiguous 1..N,
// and fingerprints are unique within the run.
export function assertLeafFindings(findings, domain, opts = {}) {
  assert.ok(Array.isArray(findings), "findings must be an array");
  findings.forEach((f) => assertLeafFinding(f, domain, opts));
  const ranks = findings.map((f) => f.rank).sort((a, b) => a - b);
  ranks.forEach((r, i) => assert.equal(r, i + 1, `finding ranks must be contiguous 1..N (gap/break at index ${i})`));
  const fps = new Set(findings.map((f) => f.fingerprint));
  assert.equal(fps.size, findings.length, "finding fingerprints must be unique within a run");
}
