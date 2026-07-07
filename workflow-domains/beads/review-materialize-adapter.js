// Host-owned review-materialize adapter: the deterministic bridge from a completed
// repo-review run's findings to a Beads backlog (epic + children + final gate).
//
// Mirrors the safety posture of beads-drain-adapter.js: bd reads/mutations are
// controller-owned via execFile, idempotency is enforced via deterministic external-refs
// (so a crash-resume or re-run never double-creates), and a HEAD-stable crosswalk maps
// every finding fingerprint -> beadId for cross-run dedupe.
//
// The adapter is deliberately split into PURE functions (classifyFinding, planMaterialization)
// for zero-token unit testing, and an EXECUTION layer (createReviewMaterializeAdapter) that
// shells out to bd. The plugin tool layer (workflow-plugin.js review_materialize) is a thin
// wrapper that reads a completed repo-review run's findings and calls this adapter.
//
// NON-GOALS: no git push, no bd dolt push, no network, no QuickJS guest. Local-only Beads
// writes, just like beads-drain autonomous-local.

import path from "node:path";
import fs from "node:fs/promises";
import crypto from "node:crypto";

import { defaultRunBd, parseBdJson } from "./beads-bd-util.js";
import { acquireWorkflowLock } from "../../workflow-kernel/run-store-locks.js";

const SCHEMA_VERSION = 1;

// Semantic-similarity threshold for Jaccard token overlap. Below this, two items are
// considered distinct; at or above, the finding is flagged AMBIGUOUS for human review
// (not auto-skipped, not auto-created).
const SEMANTIC_THRESHOLD = 0.5;
const CROSSWALK_META_KEY = "__reviewMaterialize";

const DOMAIN_DETAIL_KEYS = {
  bughunt: ["reproSketch", "fixSketch", "docImpact"],
  security: ["cwe", "attackVector", "exploitability", "docImpact"],
  "test-gaps": ["targetUnderTest", "suggestedTest", "docImpact"],
  cleanup: ["docImpact"],
  modernize: ["deprecatedSince", "replacement", "targetVersion", "docImpact"],
  perf: ["hotness", "estimatedImpact", "complexityBefore", "complexityAfter", "docImpact"],
  complexity: ["churn", "complexityScore", "hotspotScore", "refactorSuggestion", "docImpact"],
  deps: ["package", "currentVersion", "targetVersion", "breaking", "cve", "advisory", "docImpact"],
};

function stdoutText(result) {
  return typeof result === "string" ? result : result?.stdout ?? "";
}

// ---- normalization (mirrors beads-drain-adapter normalizeIssue) ----

export function normalizeIssue(raw) {
  if (!raw || typeof raw !== "object") return null;
  const labels = Array.isArray(raw.labels) ? raw.labels : typeof raw.labels === "string" ? raw.labels.split(/[,\s]+/).filter(Boolean) : [];
  return {
    ...raw,
    id: raw.id ?? raw.issue_id ?? raw.issueId ?? "",
    title: raw.title ?? "",
    description: raw.description ?? raw.body ?? "",
    status: raw.status ?? raw.state ?? "open",
    issue_type: raw.issue_type ?? raw.type ?? raw.issueType ?? "task",
    acceptance_criteria: raw.acceptance_criteria ?? raw.acceptance ?? raw.acceptanceCriteria ?? "",
    design: raw.design ?? "",
    labels,
    external_ref: raw.external_ref ?? raw.externalRef ?? "",
  };
}

// ---- deterministic external-ref for idempotent creation ----
// Each finding maps to a stable external-ref so a crash between create and crosswalk-write
// is safe: on resume, bd list finds the existing external-ref and skips re-creation.
export function findingExternalRef(fingerprint) {
  return `ocw-rm-${fingerprint}`;
}

export function findingFingerprints(finding) {
  const explicit = [];
  if (Array.isArray(finding?.fingerprints)) {
    for (const fp of finding.fingerprints) {
      if (typeof fp === "string" && fp.trim()) explicit.push(fp.trim());
    }
  }
  if (typeof finding?.fingerprint === "string" && finding.fingerprint.trim()) {
    explicit.unshift(finding.fingerprint.trim());
  }
  if (explicit.length) return [...new Set(explicit)];
  const basis = JSON.stringify({
    category: finding?.category ?? null,
    file: finding?.file ?? null,
    line: finding?.line ?? null,
    description: finding?.description ?? null,
    proposedChange: finding?.proposedChange ?? null,
  });
  const digest = crypto.createHash("sha256").update(basis).digest("hex").slice(0, 16);
  return [`fallback-${digest}`];
}

// ---- token-based Jaccard similarity for semantic duplicate detection ----

function tokenize(s) {
  return new Set(
    String(s ?? "")
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((t) => t.length > 2),
  );
}

function jaccard(a, b) {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const t of a) if (b.has(t)) intersection++;
  return intersection / (a.size + b.size - intersection);
}

// Build a comparison signature from a finding for semantic matching against existing beads.
function findingSignature(f) {
  return tokenize([f.category, f.file, f.description, f.proposedChange].filter(Boolean).join(" "));
}

// Build a comparison signature from an existing Beads issue.
function beadSignature(issue) {
  return tokenize([issue.title, issue.description, ...(issue.labels || [])].filter(Boolean).join(" "));
}

// ---- PURE: classify a single finding against the crosswalk + existing beads ----
//
// Returns one of:
//   { action: "create" }
//   { action: "skip", reason: "crosswalk:<beadId>", beadId }
//   { action: "skip", reason: "exists:<beadId>", beadId }
//   { action: "skip", reason: "already_done:<beadId>", beadId }   (closed bead)
//   { action: "ambiguous", reason: "similar:<beadId>", candidates: [beadId, ...] }
export function classifyFinding(finding, crosswalk = {}, existingBeads = []) {
  const fingerprints = findingFingerprints(finding);

  // 1. Exact crosswalk match (already materialized in a prior run).
  for (const fp of fingerprints) {
    if (crosswalk[fp]) return { action: "skip", reason: `crosswalk:${crosswalk[fp]}`, beadId: crosswalk[fp] };
  }

  // 2. External-ref match against existing beads (idempotency: a prior create succeeded).
  for (const fp of fingerprints) {
    const ref = findingExternalRef(fp);
    const match = existingBeads.find((b) => b.external_ref === ref);
    if (match) {
      const isClosed = match.status === "closed";
      return {
        action: "skip",
        reason: isClosed ? `already_done:${match.id}` : `exists:${match.id}`,
        beadId: match.id,
      };
    }
  }

  // 3. Semantic similarity (token Jaccard on title/description/category/labels).
  const sig = findingSignature(finding);
  const candidates = [];
  for (const bead of existingBeads) {
    // Only match against non-closed beads for ambiguity (closed = done, handled above).
    if (bead.status === "closed") continue;
    const score = jaccard(sig, beadSignature(bead));
    if (score >= SEMANTIC_THRESHOLD) candidates.push({ beadId: bead.id, score });
  }
  if (candidates.length > 0) {
    candidates.sort((a, b) => b.score - a.score);
    return {
      action: "ambiguous",
      reason: `similar:${candidates.map((c) => c.beadId).join(",")}`,
      candidates: candidates.map((c) => c.beadId),
    };
  }

  return { action: "create" };
}

// ---- PURE: plan the full materialization from a findings array ----
//
// Returns { create: [...], skip: [...], ambiguous: [...] } where each entry carries the
// original finding plus its classification. This is the dry-run plan.
export function planMaterialization(findings, crosswalk = {}, existingBeads = []) {
  const create = [];
  const skip = [];
  const ambiguous = [];
  for (const f of findings) {
    if (!f || typeof f !== "object") continue;
    const cls = classifyFinding(f, crosswalk, existingBeads);
    const entry = { ...cls, fingerprint: findingFingerprints(f)[0], finding: f };
    if (cls.action === "create") create.push(entry);
    else if (cls.action === "skip") skip.push(entry);
    else if (cls.action === "ambiguous") ambiguous.push(entry);
  }
  return { create, skip, ambiguous };
}

// ---- Beads-ready rendering helpers ----

function labelSafe(value, fallback = "review") {
  const normalized = String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63);
  return normalized || fallback;
}

function uniqueLabels(values) {
  return [...new Set(values.map((value) => labelSafe(value)).filter(Boolean))];
}

function domainsFor(f) {
  const values = Array.isArray(f?.sourceDomains) && f.sourceDomains.length
    ? f.sourceDomains
    : [f?.sourceDomain || f?.domain || "review"];
  return [...new Set(values.map((value) => String(value || "review").replace(/^repo-/, "")).filter(Boolean))];
}

function primaryDomain(f) {
  return domainsFor(f)[0] || "review";
}

function effortLabel(f) {
  return ["small", "medium", "large"].includes(f?.effort) ? f.effort : "medium";
}

function priorityFor(f) {
  if (f?.severity === "critical" || f?.severity === "high") return "1";
  if (f?.severity === "medium") return "2";
  return "3";
}

function trimText(value, fallback = "", max = 4000) {
  const s = String(value ?? fallback).trim();
  return s.length > max ? `${s.slice(0, max - 20)}… [truncated]` : s;
}

function hasData(value) {
  if (value === null || value === undefined) return false;
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value).length > 0;
  return true;
}

function valueToText(value) {
  if (Array.isArray(value)) return value.length ? value.map(valueToText).join(", ") : "(empty)";
  if (value && typeof value === "object") return JSON.stringify(value);
  if (value === "") return "(empty)";
  return String(value);
}

function domainDetailsFor(f) {
  if (f?.domainDetails && typeof f.domainDetails === "object" && !Array.isArray(f.domainDetails)) {
    return f.domainDetails;
  }
  const details = {};
  for (const domain of domainsFor(f)) {
    for (const key of DOMAIN_DETAIL_KEYS[domain] || []) {
      if (Object.hasOwn(f || {}, key)) details[key] = f[key];
    }
  }
  return details;
}

function hasDomainDetails(f) {
  return !!(f && Object.hasOwn(f, "domainDetails") && f.domainDetails && typeof f.domainDetails === "object" && !Array.isArray(f.domainDetails));
}

function detailLines(f) {
  const details = domainDetailsFor(f);
  const lines = [];
  for (const [key, value] of Object.entries(details)) {
    if (hasData(value)) lines.push(`- ${key}: ${valueToText(value)}`);
  }
  return lines;
}

function findingLabels(f, programLabel) {
  return uniqueLabels([
    "review",
    "implementation",
    ...domainsFor(f),
    effortLabel(f),
    "needs-tests",
    programLabel,
  ]);
}

function findingTitle(f) {
  const loc = f.file ? ` ${f.file}${f.line ? `:${f.line}` : ""}` : "";
  const cat = f.category || (Array.isArray(f.sourceDomains) ? f.sourceDomains.join("+") : "review");
  const sev = f.severity ? `[${f.severity}]` : "";
  const desc = String(f.description || "review finding").slice(0, 100);
  return `Resolve ${sev} ${cat}${loc}: ${desc}`.replace(/\s+/g, " ").trim();
}

function findingDescription(f, programLabel) {
  const domains = Array.isArray(f.sourceDomains) ? f.sourceDomains.join(", ") : (f.sourceDomain || "review");
  return [
    `Source: repo-review (${domains}). Program: ${programLabel}.`,
    `Fingerprint: \`${findingFingerprints(f)[0]}\`.`,
    ``,
    `## Problem / context`,
    trimText(f.description, "(no description)"),
    ``,
    `## Desired outcome`,
    trimText(f.proposedChange, "Resolve the repo-review finding or document evidence that it is not actionable."),
    ``,
    `## Scope`,
    `Work only on the behavior or code path implicated by this repo-review finding. Known evidence location: ${f.file || "(unknown)"}${f.line ? `:${f.line}` : ""}.`,
    ``,
    `## Non-scope`,
    `Do not opportunistically fix unrelated repo-review findings, broad refactors, or neighboring cleanup unless they are required to resolve this finding.`,
  ].join("\n");
}

function findingDesign(f) {
  const lines = [
    `## Repo-review evidence`,
    `- Source domain(s): ${domainsFor(f).join(", ")}`,
    `- Severity: ${f.severity || "unknown"}`,
    `- Confidence: ${Number.isInteger(f.confidence) ? `${f.confidence}/100` : "unknown"}`,
    `- Estimated effort: ${f.effort || "medium"}`,
    `- Category: ${f.category || primaryDomain(f)}`,
    `- Location: ${f.file || "(unknown)"}${f.line ? `:${f.line}` : ""}`,
  ];
  if (typeof f.priorityScore === "number") lines.push(`- Priority score: ${f.priorityScore}`);
  if (Array.isArray(f.relatesTo) && f.relatesTo.length) lines.push(`- Related repo-review ranks: ${f.relatesTo.join(", ")}`);
  const details = detailLines(f);
  if (details.length) lines.push("", "## Domain details", ...details);
  lines.push(
    "",
    "## Implementation notes",
    "- Re-check the finding against the current source before editing; repo-review is static analysis and may be stale or incomplete.",
    "- Prefer the smallest behavior-preserving change that resolves the finding.",
    "- If the finding cannot be confirmed, record the evidence and close/defer with rationale instead of making speculative changes.",
    "",
    "## Constraints and risks",
    "- Keep the fix scoped to this finding and preserve existing public behavior unless the finding is a confirmed bug or security issue.",
    "- Do not expose secrets, credentials, or raw sensitive values in notes, tests, or logs.",
  );
  return lines.join("\n");
}

function domainAcceptance(f) {
  const domain = primaryDomain(f);
  if (domain === "bughunt") return ["The suspected bug is reproduced or otherwise confirmed before changing behavior, then no longer reproduces after the fix."];
  if (domain === "security") return ["The vulnerable or risky path is mitigated without exposing sensitive values; any required credential rotation or policy decision is captured as follow-up or blocker."];
  if (domain === "test-gaps") return ["A meaningful test covers the target behavior or an evidence-backed rationale explains why no test should be added."];
  if (domain === "cleanup") return ["The cleanup removes or updates only confirmed stale/dead/duplicated material without changing intended behavior."];
  if (domain === "modernize") return ["The modernized path preserves compatibility or records a documented compatibility decision."];
  if (domain === "perf") return ["The optimization is behavior-preserving; measurable performance evidence is recorded when practical, otherwise the no-measurement rationale is explicit."];
  if (domain === "complexity") return ["The refactor reduces the targeted complexity while preserving behavior through existing or added tests."];
  if (domain === "deps") return ["Manifest and lockfile state remain consistent; dependency risk, breaking-change notes, and rollback considerations are recorded."];
  return [];
}

function findingAcceptance(f) {
  return [
    ...domainAcceptance(f),
    "The implementation addresses the repo-review finding described in the bead or records evidence that the finding is not actionable.",
    "Scope and non-scope are respected; unrelated review findings remain separate work.",
    "Project validation is discovered from AGENTS.md, package scripts, Makefiles, or CI config and the relevant commands/results are recorded in notes.",
    "If validation cannot be run, the exact blocker and the narrowest alternative evidence are recorded.",
  ].map((line) => `- ${line}`).join("\n");
}

function createArgsFromPlan(plan) {
  const args = ["create", "--title", plan.title, "--description", plan.description, "--type", plan.type, "--labels", plan.labels.join(","), "--external-ref", plan.externalRef];
  if (plan.parent) args.push("--parent", plan.parent);
  if (plan.priority) args.push("--priority", String(plan.priority));
  if (plan.design) args.push("--design", plan.design);
  if (plan.acceptance) args.push("--acceptance", plan.acceptance);
  return args;
}

function childPlan(entry, programLabel, epicId) {
  const f = entry.finding;
  return {
    fingerprint: entry.fingerprint,
    title: findingTitle(f),
    description: findingDescription(f, programLabel),
    design: findingDesign(f),
    acceptance: findingAcceptance(f),
    type: "task",
    parent: epicId,
    labels: findingLabels(f, programLabel),
    priority: priorityFor(f),
    externalRef: findingExternalRef(entry.fingerprint),
    readinessStatus: "needs-post-materialization-review",
    hasDomainDetails: hasDomainDetails(f),
  };
}

function plannedChildSummary(entry, programLabel) {
  const plan = childPlan(entry, programLabel, null);
  return {
    fingerprint: entry.fingerprint,
    title: plan.title,
    labels: plan.labels,
    priority: plan.priority,
    readinessStatus: plan.readinessStatus,
    hasDomainDetails: plan.hasDomainDetails,
  };
}

function epicPlan(programLabel, crosswalkPath, stats) {
  return {
    title: `Review epic: ${programLabel}`,
    description: [
      `Epic for repo-review findings materialized under program label ${programLabel}.`,
      `Crosswalk: ${crosswalkPath}`,
      `Findings: ${stats.total} total; ${stats.create} planned new; ${stats.skip} exact duplicate/skipped; ${stats.ambiguous} ambiguous.`,
    ].join("\n"),
    design: [
      "This epic tracks the repo-review materialization program.",
      "Children are one finding per materialized work item. Existing exact duplicates and ambiguous candidates remain part of the gate scope through the crosswalk and materialization result.",
      "Do not close the epic until the final verification gate confirms all children are closed/deferred and post-materialization review findings have been reconciled or honestly blocked.",
    ].join("\n"),
    acceptance: [
      "- Every created child bead is closed or explicitly deferred with rationale.",
      "- Skipped/existing duplicate findings are reconciled against the crosswalk or recorded as already covered.",
      "- Ambiguous findings are resolved, split, or explicitly deferred with rationale.",
      "- The final verification gate is closed with graph and validation evidence.",
    ].join("\n"),
    type: "epic",
    parent: null,
    labels: uniqueLabels(["review", "review-materialize", programLabel]),
    priority: "2",
    externalRef: `ocw-rm-epic-${programLabel}`,
  };
}

function finalGatePlan(programLabel, crosswalkPath, stats, epicId) {
  return {
    title: `Final verification: ${programLabel}`,
    description: [
      `Final gate for repo-review materialization program ${programLabel}.`,
      `Crosswalk: ${crosswalkPath}`,
      `Scope: ${stats.total} findings (${stats.create} created/new, ${stats.skip} skipped or existing, ${stats.ambiguous} ambiguous).`,
    ].join("\n"),
    design: [
      "This is a review/gate bead, not implementation work.",
      "It should become ready only after the active materialized children it depends on are closed.",
      "Before closing, re-run or inspect the scoped Beads graph, reconcile skipped/existing/ambiguous findings, and confirm no high/medium post-materialization review defects remain unresolved.",
    ].join("\n"),
    acceptance: [
      "- All created child beads are closed or explicitly deferred with rationale.",
      "- Exact duplicates and skipped findings are reconciled against existing beads or the crosswalk.",
      "- Ambiguous findings are resolved, represented as follow-up work, or explicitly deferred with rationale.",
      "- `bd dep cycles` and graph integrity checks pass for the scoped graph.",
      "- A scoped `/beads-review post-materialization` pass has no unresolved high/medium defects, or each residual defect is blocked/deferred with rationale.",
      "- Final notes record validation evidence and the exact local-only sync/publication state.",
    ].join("\n"),
    type: "task",
    parent: epicId,
    labels: uniqueLabels(["review", "review-materialize", "final-gate", programLabel]),
    priority: "2",
    externalRef: `ocw-rm-gate-${programLabel}`,
  };
}

function statsFor(plan, total) {
  return { create: plan.create.length, skip: plan.skip.length, ambiguous: plan.ambiguous.length, total };
}

function skippedSummary(entry, existingById = new Map()) {
  const existing = entry.beadId ? existingById.get(entry.beadId) : null;
  return { fingerprint: entry.fingerprint, beadId: entry.beadId, reason: entry.reason, beadStatus: existing?.status ?? null };
}

function ambiguousSummary(entry) {
  return { fingerprint: entry.fingerprint, candidates: entry.candidates, reason: entry.reason };
}

function dependencyPrerequisiteIds(records, expectedType = "blocks") {
  const ids = new Set();
  for (const rec of Array.isArray(records) ? records : []) {
    const dependencyType = rec?.dependency_type ?? rec?.dependencyType ?? rec?.type ?? rec?.relation ?? null;
    if (dependencyType && dependencyType !== expectedType) continue;
    for (const key of ["depends_on_id", "dependsOnId", "prerequisite_id", "prerequisiteId", "target_id", "targetId", "dependency_id", "dependencyId"]) {
      if (typeof rec?.[key] === "string" && rec[key]) ids.add(rec[key]);
    }
    if (typeof rec?.id === "string" && rec.id) ids.add(rec.id);
  }
  return ids;
}

function programExternalRefs(programLabel) {
  return {
    epicRef: `ocw-rm-epic-${programLabel}`,
    gateRef: `ocw-rm-gate-${programLabel}`,
  };
}

function isProgramChildIssue(bead, programLabel, { epicRef, gateRef } = programExternalRefs(programLabel)) {
  const ref = String(bead?.external_ref || "");
  if (!ref.startsWith("ocw-rm-")) return false;
  if (ref === epicRef || ref === gateRef) return false;
  if (ref.startsWith("ocw-rm-epic-") || ref.startsWith("ocw-rm-gate-")) return false;
  const labels = Array.isArray(bead?.labels) ? bead.labels : [];
  return labels.includes(labelSafe(programLabel));
}

function uniquePrerequisitesForVerification({ crosswalk, existingBeads, programLabel, epicId, finalGateId }) {
  const { epicRef, gateRef } = programExternalRefs(programLabel);
  const existingById = new Map(existingBeads.map((issue) => [issue.id, issue]));
  const metadata = crosswalk?.[CROSSWALK_META_KEY] && typeof crosswalk[CROSSWALK_META_KEY] === "object"
    ? crosswalk[CROSSWALK_META_KEY]
    : {};
  const entries = Array.isArray(metadata.entries) ? metadata.entries : [];
  const candidates = [];

  for (const entry of entries) {
    if (!entry?.beadId || entry.status === "ambiguous") continue;
    if (entry.beadId === epicId || entry.beadId === finalGateId) continue;
    const issue = existingById.get(entry.beadId);
    const status = issue?.status ?? entry.beadStatus ?? null;
    if (status === "closed" || String(entry.reason || "").startsWith("already_done")) continue;
    candidates.push({ beadId: entry.beadId, source: `crosswalk:${entry.status || "entry"}` });
  }

  for (const issue of existingBeads) {
    if (!issue?.id || issue.status === "closed") continue;
    if (!isProgramChildIssue(issue, programLabel, { epicRef, gateRef })) continue;
    candidates.push({ beadId: issue.id, source: "program-scan" });
  }

  const seen = new Set();
  return candidates.filter((candidate) => {
    if (seen.has(candidate.beadId)) return false;
    seen.add(candidate.beadId);
    return true;
  });
}

function verificationStatusFor(verify) {
  if (verify?.verdict === "pass") return "verified";
  if (verify?.verdict === "tool_error") return "inconclusive";
  if (verify?.verdict === "hard_fail") return "invalid";
  if (verify?.ok) return "verified";
  if (verify?.toolError) return "inconclusive";
  return "invalid";
}

function suggestedNextActionFor(status) {
  if (status === "verified") {
    return "Graph verification passed. Continue with scoped post-materialization review before any autonomous drain.";
  }
  if (status === "inconclusive") {
    return "A verifier/tool readback failed. Inspect the failed checks and retry verify-only before re-running materialization.";
  }
  return "The materialized graph is invalid. Repair missing blockers or graph issues, then rerun verify-only.";
}

function normalizeVerifierResult(verify) {
  verify.failedChecks = verify.checks.filter((check) => !check.pass).map((check) => check.name);
  verify.warnings = Array.isArray(verify.warnings) ? verify.warnings : [];
  const failedClasses = verify.checks.filter((check) => !check.pass).map((check) => check.failureClass).filter(Boolean);
  if (verify.ok) {
    verify.verdict = "pass";
    verify.failureClass = null;
    verify.retryable = false;
    verify.recoverable = false;
  } else if (verify.toolError || failedClasses.includes("tool_error")) {
    verify.verdict = "tool_error";
    verify.failureClass = "tool_error";
    verify.retryable = true;
    verify.recoverable = true;
  } else {
    verify.verdict = "hard_fail";
    verify.failureClass = "hard_fail";
    verify.retryable = false;
    verify.recoverable = true;
  }
  verify.suggestedRecovery = suggestedNextActionFor(verificationStatusFor(verify));
  return verify;
}

function addCrosswalkMetadata(crosswalk, { programLabel, epicId, finalGateId, created, skipped, ambiguous, total }) {
  for (const s of skipped) {
    if (s.beadId && !crosswalk[s.fingerprint]) crosswalk[s.fingerprint] = s.beadId;
  }
  crosswalk[CROSSWALK_META_KEY] = {
    schemaVersion: 2,
    programLabel,
    epicId,
    finalGateId,
    stats: { create: created.length, skip: skipped.length, ambiguous: ambiguous.length, total },
    entries: [
      ...created.map((c) => ({ fingerprint: c.fingerprint, status: "created", beadId: c.beadId, title: c.title })),
      ...skipped.map((s) => ({ fingerprint: s.fingerprint, status: "skipped", beadId: s.beadId, reason: s.reason, beadStatus: s.beadStatus ?? null })),
      ...ambiguous.map((a) => ({ fingerprint: a.fingerprint, status: "ambiguous", candidates: a.candidates, reason: a.reason })),
    ],
  };
}

// ---- adapter factory ----

export function createReviewMaterializeAdapter(options = {}) {
  const cwd = options.cwd ?? process.cwd();
  const runBd = options.runBd ?? defaultRunBd;

  async function bd(args, { json = true, readonly = true } = {}) {
    const finalArgs = [...args];
    if (json && !finalArgs.includes("--json")) finalArgs.push("--json");
    if (readonly && !finalArgs.includes("--readonly")) finalArgs.push("--readonly");
    const result = await runBd(finalArgs, { cwd, json, readonly });
    return json ? parseBdJson(stdoutText(result), `bd ${args.join(" ")}`) : stdoutText(result);
  }

  async function listExistingBeads(programLabel) {
    // Read open, in_progress, and deferred beads (the active set a new finding might duplicate).
    // Also read closed beads (already-done check). Use --limit 0 for unbounded.
    const active = await bd(["list", "--status", "open,in_progress,deferred", "--limit", "0"]);
    const closed = await bd(["list", "--status", "closed", "--limit", "0"]);
    const all = [...(Array.isArray(active) ? active : []), ...(Array.isArray(closed) ? closed : [])];
    return all.map(normalizeIssue).filter(Boolean);
  }

  async function readCrosswalk(crosswalkPath) {
    let content;
    try {
      content = await fs.readFile(crosswalkPath, "utf8");
    } catch (error) {
      // A missing crosswalk is the normal first-run case; degrade to empty.
      if (error.code === "ENOENT") return {};
      // Other read errors (EACCES, EIO) are unexpected and must surface.
      throw error;
    }
    // A truncated/empty-but-present crosswalk (e.g. a process kill or ENOSPC mid-write of an
    // older, non-atomic writer) must NOT crash the whole materialize call. Degrade to an empty
    // crosswalk: we lose only the fingerprint->beadId memoization, not correctness, since
    // external-ref lookups still catch most duplicates.
    try {
      return JSON.parse(content);
    } catch {
      return {};
    }
  }

  async function writeCrosswalk(crosswalkPath, crosswalk) {
    await fs.mkdir(path.dirname(crosswalkPath), { recursive: true });
    // Atomic temp-file + rename, mirroring writeJsonAtomic in workflow-kernel/run-store-fs.js,
    // so a process kill / ENOSPC during the write can never leave a zero-byte or partially
    // written crosswalk.json in place (the next readCrosswalk would otherwise inherit it).
    const tmp = `${crosswalkPath}.${process.pid}.${Date.now()}.${crypto.randomUUID()}.tmp`;
    try {
      await fs.writeFile(tmp, JSON.stringify(crosswalk, null, 2), "utf8");
      await fs.rename(tmp, crosswalkPath);
    } catch (error) {
      // Avoid orphaning the temp file on a write/rename failure.
      await fs.rm(tmp, { force: true }).catch(() => {});
      throw error;
    }
  }

  function result(status, extra) {
    return {
      domain: "review-materialize",
      schemaVersion: SCHEMA_VERSION,
      status,
      abortReason: null,
      programLabel: options.programLabel ?? null,
      epicId: null,
      finalGateId: null,
      created: [],
      skipped: [],
      ambiguous: [],
      crosswalkPath: options.crosswalkPath ?? null,
      verify: null,
      ...extra,
    };
  }

  // Normalized verifier result contract for this adapter:
  // { ok, verdict, failureClass, retryable, recoverable, checks, problems, warnings,
  //   failedChecks, suggestedRecovery }. Existing callers can keep reading ok/checks/problems;
  // recovery-aware callers should prefer verdict/failureClass/retryable/recoverable.
  async function verifyGraph({ finalGateId, uniquePrerequisites, depAddProblems = null }) {
    const verify = { ok: true, checks: [], problems: [], toolError: false };
    if (Array.isArray(depAddProblems)) {
      verify.checks.push({ name: "deps_added", pass: depAddProblems.length === 0, ...(depAddProblems.length ? { failureClass: "hard_fail" } : {}) });
      if (depAddProblems.length > 0) {
        verify.ok = false;
        verify.problems.push(...depAddProblems);
      }
    }
    try {
      const cycles = await bd(["dep", "cycles"]);
      if (cycles && !Array.isArray(cycles)) {
        verify.ok = false;
        verify.toolError = true;
        verify.problems.push("dep cycles check returned unexpected shape");
        verify.checks.push({ name: "no_cycles", pass: false, failureClass: "tool_error" });
      } else {
        if (Array.isArray(cycles) && cycles.length > 0) {
          verify.ok = false;
          verify.problems.push(`${cycles.length} dependency cycle(s) detected`);
        }
        verify.checks.push({ name: "no_cycles", pass: !Array.isArray(cycles) || cycles.length === 0, ...(Array.isArray(cycles) && cycles.length > 0 ? { failureClass: "hard_fail" } : {}) });
      }
    } catch (e) {
      verify.problems.push(`dep cycles check failed: ${String(e?.message || e).slice(0, 200)}`);
      verify.ok = false;
      verify.toolError = true;
      verify.checks.push({ name: "no_cycles", pass: false, failureClass: "tool_error" });
    }
    try {
      await bd(["graph", "check"]);
      verify.checks.push({ name: "graph_check", pass: true });
    } catch (e) {
      verify.problems.push(`graph check failed: ${String(e?.message || e).slice(0, 200)}`);
      verify.ok = false;
      verify.checks.push({ name: "graph_check", pass: false, failureClass: "hard_fail" });
    }
    try {
      const deps = await bd(["dep", "list", finalGateId, "--type", "blocks"]);
      const dependencyIds = dependencyPrerequisiteIds(deps, "blocks");
      const missing = uniquePrerequisites.map((p) => p.beadId).filter((id) => !dependencyIds.has(id));
      const pass = missing.length === 0;
      verify.checks.push({ name: "final_gate_blocked_by_scope", pass, expected: uniquePrerequisites.length, missing, ...(!pass ? { failureClass: "hard_fail" } : {}) });
      if (!pass) {
        verify.ok = false;
        verify.problems.push(`final gate is missing ${missing.length} expected prerequisite(s): ${missing.join(", ")}`);
      }
    } catch (e) {
      verify.problems.push(`final gate dependency readback failed: ${String(e?.message || e).slice(0, 200)}`);
      verify.ok = false;
      verify.toolError = true;
      verify.checks.push({ name: "final_gate_blocked_by_scope", pass: false, expected: uniquePrerequisites.length, missing: uniquePrerequisites.map((p) => p.beadId), failureClass: "tool_error" });
    }
    return normalizeVerifierResult(verify);
  }

  async function verifyMaterialization({ programLabel, crosswalkPath }) {
    if (!programLabel) return result("aborted", { abortReason: "programLabel is required (or baselineHead to derive it)." });
    if (!/^[A-Za-z0-9._-]+$/.test(programLabel)) return result("aborted", { abortReason: `programLabel must match ^[A-Za-z0-9._-]+$ (got ${JSON.stringify(programLabel)})` });
    const cwPath = crosswalkPath || path.join(cwd, ".repo-review", "crosswalk", `${programLabel}.json`);
    const crosswalk = await readCrosswalk(cwPath);
    const existingBeads = await listExistingBeads(programLabel);
    const { epicRef, gateRef } = programExternalRefs(programLabel);
    const metadata = crosswalk?.[CROSSWALK_META_KEY] && typeof crosswalk[CROSSWALK_META_KEY] === "object"
      ? crosswalk[CROSSWALK_META_KEY]
      : {};
    const epicId = metadata.epicId || existingBeads.find((issue) => issue.external_ref === epicRef)?.id || null;
    const finalGateId = metadata.finalGateId || existingBeads.find((issue) => issue.external_ref === gateRef)?.id || null;

    if (!epicId || !finalGateId) {
      const verify = {
        ok: false,
        checks: [{ name: "materialization_metadata", pass: false, missing: [!epicId ? "epicId" : null, !finalGateId ? "finalGateId" : null].filter(Boolean), failureClass: "hard_fail" }],
        problems: ["could not resolve materialization epic/final gate from crosswalk metadata or deterministic external refs"],
        toolError: false,
      };
      normalizeVerifierResult(verify);
      const status = verificationStatusFor(verify);
      return result(status, {
        programLabel,
        epicId,
        finalGateId,
        crosswalkPath: cwPath,
        verify,
        childCount: 0,
        failedChecks: verify.failedChecks,
        suggestedNextAction: suggestedNextActionFor(status),
      });
    }

    const uniquePrerequisites = uniquePrerequisitesForVerification({ crosswalk, existingBeads, programLabel, epicId, finalGateId });
    const verify = await verifyGraph({ finalGateId, uniquePrerequisites });
    const status = verificationStatusFor(verify);
    return result(status, {
      programLabel,
      epicId,
      finalGateId,
      crosswalkPath: cwPath,
      verify,
      childCount: uniquePrerequisites.length,
      checkedChildren: uniquePrerequisites,
      failedChecks: verify.failedChecks,
      suggestedNextAction: suggestedNextActionFor(status),
    });
  }

  async function materialize({ findings, programLabel, dryRun = true, crosswalkPath, acceptPartial = false, materializationReady, verifyOnly = false }) {
    if (verifyOnly) return verifyMaterialization({ programLabel, crosswalkPath });
    if (!programLabel) return result("aborted", { abortReason: "programLabel is required (or baselineHead to derive it)." });
    if (!/^[A-Za-z0-9._-]+$/.test(programLabel)) return result("aborted", { abortReason: `programLabel must match ^[A-Za-z0-9._-]+$ (got ${JSON.stringify(programLabel)})` });
    if (!Array.isArray(findings) || findings.length === 0) return result("aborted", { abortReason: "no findings to materialize." });
    if (materializationReady === false && !acceptPartial) {
      return result("blocked_not_ready", {
        programLabel,
        abortReason: "The source report is not materializationReady (materializationReady=false) and acceptPartial was not set. Re-run the review to fix blockers, or explicitly pass acceptPartial=true if you understand the risk of materializing from an incomplete report.",
      });
    }
    if (!dryRun && materializationReady !== true && !acceptPartial) {
      return result("blocked_not_ready", {
        programLabel,
        abortReason: "Non-dry review materialization requires an explicit materializationReady=true source report, or acceptPartial=true if you understand the risk.",
      });
    }

    const cwPath = crosswalkPath || path.join(cwd, ".repo-review", "crosswalk", `${programLabel}.json`);

    // Concurrency guard: serialize non-dry passes for this program label. Without a lock,
    // two overlapping invocations (a caller retry after a slow/timed-out first call, or two
    // sessions both approving) each snapshot the SAME pre-create bd state via
    // listExistingBeads() before either has created anything, both classify a finding as
    // not-yet-created, and both issue `bd create --external-ref ocw-rm-<fingerprint>` for the
    // identical fingerprint — double-creating a bead (permanently breaking future dedupe) or
    // aborting mid-loop on a uniqueness violation. The lock is held for the WHOLE write pass
    // (snapshot -> plan -> create -> crosswalk write) and released in the finally below, so the
    // existingBeads snapshot can only go stale relative to THIS invocation's own creates, which
    // the per-finding external-ref re-check already handles. Dry runs make no writes and skip it.
    // programLabel is validated ^[A-Za-z0-9._-]+$ above, so it is filesystem-safe in the name.
    let releaseLock = null;
    if (!dryRun) {
      const lockPath = path.join(path.dirname(cwPath), `.materialize-${programLabel}.lock`);
      try {
        releaseLock = await acquireWorkflowLock(lockPath, { operation: "review-materialize", programLabel });
      } catch (error) {
        return result("aborted", {
          programLabel,
          crosswalkPath: cwPath,
          abortReason: `A review materialization is already in progress for program ${programLabel} (${String(error?.message || error)}). Retry after it completes; overlapping non-dry runs are refused to prevent duplicate beads for the same finding.`,
        });
      }
    }

    try {
    const crosswalk = await readCrosswalk(cwPath);
    const existingBeads = await listExistingBeads(programLabel);
    const existingById = new Map(existingBeads.map((b) => [b.id, b]));
    const plan = planMaterialization(findings, crosswalk, existingBeads);
    const stats = statsFor(plan, findings.length);
    const plannedEpic = epicPlan(programLabel, cwPath, stats);
    const plannedFinalGate = finalGatePlan(programLabel, cwPath, stats, null);
    const lossyCreateCount = plan.create.filter((e) => !hasDomainDetails(e.finding)).length;

    // DRY RUN: report the plan without any writes.
    if (dryRun) {
      return result("dry_run", {
        programLabel,
        crosswalkPath: cwPath,
        created: [],
        skipped: plan.skip.map((e) => skippedSummary(e, existingById)),
        ambiguous: plan.ambiguous.map(ambiguousSummary),
        plannedEpic: { title: plannedEpic.title, labels: plannedEpic.labels, externalRef: plannedEpic.externalRef },
        plannedFinalGate: { title: plannedFinalGate.title, labels: plannedFinalGate.labels, externalRef: plannedFinalGate.externalRef },
        plannedCreates: plan.create.map((e) => plannedChildSummary(e, programLabel)),
        lossyFindings: lossyCreateCount,
        stats,
      });
    }

    // NON-DRY: create epic + children + final gate.
    if (plan.create.length === 0) {
      return result("dry_run", {
        programLabel,
        crosswalkPath: cwPath,
        created: [],
        skipped: plan.skip.map((e) => skippedSummary(e, existingById)),
        ambiguous: plan.ambiguous.map(ambiguousSummary),
        plannedEpic: { title: plannedEpic.title, labels: plannedEpic.labels, externalRef: plannedEpic.externalRef },
        plannedFinalGate: { title: plannedFinalGate.title, labels: plannedFinalGate.labels, externalRef: plannedFinalGate.externalRef },
        lossyFindings: lossyCreateCount,
        abortReason: "Nothing to create (all findings are duplicates or ambiguous).",
      });
    }
    if (lossyCreateCount > 0 && !acceptPartial) {
      return result("blocked_lossy_findings", {
        programLabel,
        crosswalkPath: cwPath,
        abortReason: `${lossyCreateCount} finding(s) lack repo-review domainDetails. Re-run /repo-review with the updated materialization contract, or pass acceptPartial=true if you understand that the created Beads may be less LLM-ready.`,
        plannedEpic: { title: plannedEpic.title, labels: plannedEpic.labels, externalRef: plannedEpic.externalRef },
        plannedFinalGate: { title: plannedFinalGate.title, labels: plannedFinalGate.labels, externalRef: plannedFinalGate.externalRef },
        stats,
      });
    }

    const created = [];
    const skipped = plan.skip.map((e) => skippedSummary(e, existingById));
    const ambiguous = plan.ambiguous.map(ambiguousSummary);
    const depAddProblems = [];

    // 1. Ensure the epic exists (idempotent via external-ref).
    const epicRef = plannedEpic.externalRef;
    let epicId = existingBeads.find((b) => b.external_ref === epicRef)?.id;
    if (!epicId) {
      const epicPayload = await bd(
        createArgsFromPlan(plannedEpic),
        { json: true, readonly: false },
      );
      epicId = normalizeIssue(Array.isArray(epicPayload) ? epicPayload[0] : epicPayload)?.id;
    }
    if (!epicId) throw new Error("Failed to create or resolve the review epic.");

    // 2. Create one child bead per NEW finding (idempotent via external-ref).
    for (const entry of plan.create) {
      const fp = entry.fingerprint;
      const ref = findingExternalRef(fp);
      // Re-check idempotency right before create (a concurrent run might have created it).
      const existing = existingBeads.find((b) => b.external_ref === ref);
      if (existing) {
        skipped.push({ fingerprint: fp, beadId: existing.id, reason: `exists:${existing.id}`, beadStatus: existing.status ?? null });
        continue;
      }
      const renderedChild = childPlan(entry, programLabel, epicId);
      const childPayload = await bd(
        createArgsFromPlan(renderedChild),
        { json: true, readonly: false },
      );
      const childId = normalizeIssue(Array.isArray(childPayload) ? childPayload[0] : childPayload)?.id;
      if (childId) {
        created.push({ fingerprint: fp, beadId: childId, title: renderedChild.title, labels: renderedChild.labels, readinessStatus: renderedChild.readinessStatus });
        crosswalk[fp] = childId;
        // Union all fingerprints of a cross-domain-merged finding into the crosswalk.
        if (Array.isArray(entry.finding.fingerprints)) {
          for (const alt of entry.finding.fingerprints) if (alt !== fp) crosswalk[alt] = childId;
        }
      }
    }

    // 3. Ensure ONE final-verification gate (idempotent via external-ref).
    const renderedGate = finalGatePlan(programLabel, cwPath, { create: created.length, skip: skipped.length, ambiguous: ambiguous.length, total: findings.length }, epicId);
    const gateRef = renderedGate.externalRef;
    let finalGateId = existingBeads.find((b) => b.external_ref === gateRef)?.id;
    if (!finalGateId) {
      const gatePayload = await bd(
        createArgsFromPlan(renderedGate),
        { json: true, readonly: false },
      );
      finalGateId = normalizeIssue(Array.isArray(gatePayload) ? gatePayload[0] : gatePayload)?.id;
    }
    if (!finalGateId) throw new Error("Failed to create or resolve the final verification gate.");

    // 4. Wire the final gate to be BLOCKED BY every active child/exact duplicate.
    //    This MUST cover children created in THIS invocation AND every pre-existing
    //    program child from an earlier (possibly crash-interrupted) run. A prior run can
    //    create children and then throw before the final-gate/dep-add steps; on the retry
    //    those children are classified skip:exists/crosswalk and never re-enter `created`.
    //    Worse, if the current `findings` array no longer surfaces such a child, it is not
    //    even in `plan.skip`/`skipped`, so wiring only created+skipped would silently leave
    //    it unblocking the gate — defeating the children-block-final-gate invariant on re-runs.
    //    We therefore also scan every existing bead whose external-ref matches this program's
    //    ocw-rm-* CHILD pattern (excluding the epic and the gate themselves) and is not closed.
    const gatePrerequisites = [
      ...created.map((c) => ({ beadId: c.beadId, source: "created" })),
      ...skipped
        .filter((s) => s.beadId && s.beadStatus !== "closed" && !String(s.reason).startsWith("already_done"))
        .map((s) => ({ beadId: s.beadId, source: "existing" })),
      ...existingBeads
        .filter((b) => b && b.id && b.status !== "closed" && isProgramChildIssue(b, programLabel, { epicRef, gateRef }))
        .map((b) => ({ beadId: b.id, source: "program-scan" })),
    ];
    const seenPrereq = new Set();
    const uniquePrerequisites = gatePrerequisites.filter((p) => {
      if (seenPrereq.has(p.beadId)) return false;
      seenPrereq.add(p.beadId);
      return true;
    });
    for (const c of uniquePrerequisites) {
      try {
        await bd(["dep", "add", finalGateId, c.beadId, "--type", "blocks"], { json: false, readonly: false });
      } catch (error) {
        const message = String(error?.message || error);
        if (/already\s+exists|already\s+present|duplicate/i.test(message)) continue;
        depAddProblems.push(`dep add ${finalGateId} ${c.beadId} failed: ${message.slice(0, 200)}`);
      }
    }

    // 5. Write the crosswalk (merge with pre-existing entries).
    addCrosswalkMetadata(crosswalk, { programLabel, epicId, finalGateId, created, skipped, ambiguous, total: findings.length });
    await writeCrosswalk(cwPath, crosswalk);

    // 6. Verify: read back the graph and check for cycles/integrity/gate blockers.
    const verify = await verifyGraph({ finalGateId, uniquePrerequisites, depAddProblems });
    const verifyStatus = verificationStatusFor(verify);

    return result(verify.ok ? "materialized" : "materialized_verify_failed", {
      programLabel,
      epicId,
      finalGateId,
      created,
      skipped,
      ambiguous,
      crosswalkPath: cwPath,
      verify,
      childCount: uniquePrerequisites.length,
      failedChecks: verify.failedChecks,
      suggestedNextAction: verify.ok ? null : suggestedNextActionFor(verifyStatus),
      plannedEpic: { title: plannedEpic.title, labels: plannedEpic.labels, externalRef: plannedEpic.externalRef },
      plannedFinalGate: { title: renderedGate.title, labels: renderedGate.labels, externalRef: renderedGate.externalRef },
      stats: { create: created.length, skip: skipped.length, ambiguous: ambiguous.length, total: findings.length },
    });
    } finally {
      // Release the whole-pass lock on every exit (success, early return, or throw).
      if (releaseLock) await releaseLock();
    }
  }

  return { materialize, verifyMaterialization, bd, listExistingBeads, readCrosswalk, writeCrosswalk };
}
