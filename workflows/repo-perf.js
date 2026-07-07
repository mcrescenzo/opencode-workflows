// LEAF workflow — repo-perf engine (OpenCode port).
//
// Contract source of truth: docs/repo-review-leaf-contract.md. Canonical
// exemplar: workflows/repo-bughunt.js + tests/repo-bughunt.test.mjs.
// Port lineage (domain logic): internal Claude workflow source (adapted
// to OpenCode: QuickJS guest, no fs, tier-based models, pure-JS synthesis).
//
// This engine is a LEAF: it NEVER calls workflow() (the /repo-review meta
// invokes THIS via workflow(); nesting is one level only). It has NO
// Bash/fs/git and CANNOT import any module — the shared contract pieces
// (envelope, emptyCounts, RECON_SCHEMA, formatRecon, fingerprintOf,
// fitWithinBudget) are duplicated verbatim per docs/repo-review-leaf-contract.md
// § "How later leaves conform".
//
// Coverage-aware domain: this is a read-only-review leaf. It does NOT run any
// profiler, benchmark, or metrics tool (no shell), so it defaults
// shellCoverage="none" and emits a coverageLimitations string explaining that
// no runtime measurements were taken. Hotness is INFERRED from code structure
// (loops, entry points, data scale), never measured; findings are suspected
// hotspots pending profiling confirmation. The finder/skeptic prompts enforce
// the OBSERVED-evidence vs SUSPECTED-hot-path-risk distinction in wording and
// confidence (non-security domain -> critical: 0).
export const meta = {
  name: "repo-perf",
  description: "Find performance hotspots across a repo (N+1/repeated I/O, accidental quadratics, hot-path allocations, sync blocking, missing caching, inefficient data structures, redundant computation) and adversarially verify each candidate before reporting. Static read-only analysis — no profiler/benchmark/metrics are run. Report-only: returns ranked structured findings; the workflow writes no files.",
  profile: "read-only-review",
  maxAgents: 4096,
  concurrency: 16,
  phases: ["recon", "find", "verify", "synthesize"],
  category: "repo-review-leaf",
  notes: "Read-only report-only performance leaf. Static suspected hotspots only; no profiler, benchmark, or metrics are run. Finder lanes use fast tier, verification uses deep tier.",
  examples: [
    { label: "normal perf scan", args: { depth: "normal", paths: ["src"] } },
    { label: "I/O and caching", args: { depth: "quick", categories: ["n-plus-one", "missing-caching"], paths: ["src"] } },
  ],
  argsSchema: {
    type: ["object", "string", "null"],
    properties: {
      paths: { type: "array", items: { type: "string" } },
      exclude: { type: "array", items: { type: "string" } },
      depth: { type: "string", enum: ["quick", "normal", "thorough"] },
      categories: { type: "array", items: { type: "string", enum: ["n-plus-one", "quadratic", "hot-alloc", "sync-blocking", "missing-caching", "inefficient-structure", "redundant-compute"] } },
      maxReturnFindings: { type: "integer", minimum: 1 },
      recon: { type: ["object", "string"] },
    },
  },
};

// ---- suite identity ----
const DOMAIN = "perf";
const SCHEMA_VERSION = 1;

// args may arrive as an object (workflow_run args) or, defensively, a JSON string.
let RT = args;
if (typeof RT === "string") { try { RT = RT.trim() ? JSON.parse(RT) : {}; } catch (error) { throw new Error(`Invalid repo-perf runtime args JSON: ${error.message}`); } }
if (!RT || typeof RT !== "object" || Array.isArray(RT)) RT = {};

const paths = Array.isArray(RT.paths) && RT.paths.length ? RT.paths : ["."];
const exclude = Array.isArray(RT.exclude) ? RT.exclude : ["node_modules", "dist", "build", ".git", "vendor", "target", "*.min.*", "*.map"];
const depth = ["quick", "normal", "thorough"].includes(RT.depth) ? RT.depth : "thorough";

// Model selection is intent-based: lanes declare a tier; the kernel resolves tier -> concrete model from
// run.modelTiers (set by the planning agent), falling back to the session-inherited default.
// recon + finders = bulk work (fast); skeptics = subtle correctness (deep); synth = pure JS (no model).
const TIER_RECON = "fast";
const TIER_FINDER = "fast";
const TIER_VERIFY = "deep";

const MAX_RETURN_FINDINGS = Number.isInteger(RT.maxReturnFindings) && RT.maxReturnFindings > 0 ? RT.maxReturnFindings : 1000000;

const ALL_CATEGORIES = ["n-plus-one", "quadratic", "hot-alloc", "sync-blocking", "missing-caching", "inefficient-structure", "redundant-compute"];
const requestedCategories = Array.isArray(RT.categories) ? RT.categories.filter((c) => typeof c === "string" && c.trim()) : [];
const categories = requestedCategories.length > 0 ? requestedCategories.filter((c) => ALL_CATEGORIES.includes(c)) : ALL_CATEGORIES;
if (requestedCategories.length > 0 && categories.length === 0) {
  throw new Error(`No valid repo-perf categories supplied. Valid categories: ${ALL_CATEGORIES.join(", ")}`);
}

const scope = `Scope: paths = ${JSON.stringify(paths)}. Exclude (do not scan/report): ${JSON.stringify(exclude)}.`;

// ---- coverage-aware extension fields (docs/repo-review-leaf-contract.md §2) ----
// read-only-review gives the engine NO shell, so no profiler, benchmark, or
// runtime metrics tool is executed. We therefore default shellCoverage="none"
// and state why performance was NOT measured. We never claim measured hotness,
// speedups, or complexity we did not observe at runtime.
const SHELL_COVERAGE = "none";
const COVERAGE_LIMITATIONS = "No profiler, benchmark, or runtime metrics were executed by this read-only engine (no shell); hotness is inferred from code structure (loops, entry points, data scale), not measured. Findings are suspected hotspots pending profiling/benchmark confirmation. Do not read these as measured performance data.";

// ---- lane coverage telemetry (iui1.2) ----
// Tracks expected/completed/dropped lane counts per phase so a dropped finder/verifier lane
// (onFailure returnNull + filter(Boolean)) surfaces as degraded coverage instead of a silent
// null. The meta reads laneCoverage.dropped to block materialization on partial coverage.
const laneCoverage = { expected: 0, completed: 0, dropped: 0, byPhase: {}, droppedLabels: [] };
function tallyPhase(name, results, labelOf) {
  const expected = results.length;
  let completed = 0;
  for (let i = 0; i < results.length; i++) {
    if (results[i] === null || results[i] === undefined) laneCoverage.droppedLabels.push(labelOf ? labelOf(i) : `${name}:${i + 1}`);
    else completed++;
  }
  const dropped = expected - completed;
  laneCoverage.expected += expected;
  laneCoverage.completed += completed;
  laneCoverage.dropped += dropped;
  const prev = laneCoverage.byPhase[name] || { expected: 0, completed: 0, dropped: 0 };
  laneCoverage.byPhase[name] = { expected: prev.expected + expected, completed: prev.completed + completed, dropped: prev.dropped + dropped };
  return results;
}

// ---- standardized return envelope ----
function envelope(status, extra) {
  return { domain: DOMAIN, schemaVersion: SCHEMA_VERSION, status, abortReason: null, reportPath: null, laneCoverage, ...extra };
}
const emptyCounts = { total: 0, critical: 0, high: 0, medium: 0, low: 0 };

// ---- shared recon schema (tolerates a prose string via formatRecon) ----
const RECON_SCHEMA = {
  type: "object", additionalProperties: false,
  properties: {
    languages: { type: "array", items: { type: "string" } },
    frameworks: { type: "array", items: { type: "string" } },
    packageManagers: { type: "array", items: { type: "string" } },
    entryPoints: { type: "array", items: { type: "string" } },
    testLayout: { type: "string" },
    buildTooling: { type: "string" },
    concurrencyModel: { type: "string" },
    errorHandling: { type: "string" },
    externalResources: { type: "array", items: { type: "string" } },
    notes: { type: "string" },
  },
  required: ["languages", "notes"],
};
function formatRecon(r) {
  if (typeof r === "string") return r;
  if (!r || typeof r !== "object") return "No recon available.";
  const L = (k, v) => (v && (Array.isArray(v) ? v.length : true) ? `${k}: ${Array.isArray(v) ? v.join(", ") : v}` : null);
  return [
    L("Languages", r.languages), L("Frameworks", r.frameworks), L("Package managers", r.packageManagers),
    L("Entry points", r.entryPoints), L("Test layout", r.testLayout), L("Build tooling", r.buildTooling),
    L("Concurrency model", r.concurrencyModel), L("Error handling", r.errorHandling),
    L("External resources", r.externalResources), L("Notes", r.notes),
  ].filter(Boolean).join("\n");
}

// ---- stable content fingerprint (djb2; deterministic, no crypto) ----
// <suite:fingerprintOf>
function fingerprintOf(f) {
  const norm = (s) => (s || "").toString().toLowerCase().replace(/\s+/g, " ").trim();
  const basis = `${DOMAIN}|${norm(f.file)}|${norm(f.category)}|${norm(f.description).slice(0, 160)}`;
  let h = 5381;
  for (let i = 0; i < basis.length; i++) h = ((h * 33) ^ basis.charCodeAt(i)) >>> 0;
  return `${DOMAIN}-${h.toString(16)}`;
}
// </suite:fingerprintOf>

// ---- schemas ----
const FINDINGS_SCHEMA = {
  type: "object", additionalProperties: false,
  properties: {
    findings: {
      type: "array",
      items: {
        type: "object", additionalProperties: false,
        properties: {
          category: { type: "string" },
          file: { type: "string" },
          line: { type: "integer" },
          severity: { type: "string", enum: ["high", "medium", "low"] },
          description: { type: "string" },
          hotness: { type: "string", enum: ["hot", "warm", "cold"] },
          estimatedImpact: { type: "string" },
          complexityBefore: { type: "string" },
          complexityAfter: { type: "string" },
          proposedChange: { type: "string" },
          confidence: { type: "integer" },
          effort: { type: "string", enum: ["small", "medium", "large"] },
          docImpact: { type: "string" },
        },
        required: ["category", "file", "line", "severity", "description", "hotness", "estimatedImpact", "complexityBefore", "complexityAfter", "proposedChange", "confidence", "effort", "docImpact"],
      },
    },
  },
  required: ["findings"],
};
const VERDICT_SCHEMA = {
  type: "object", additionalProperties: false,
  properties: {
    refuted: { type: "boolean" },
    reasoning: { type: "string" },
    adjustedConfidence: { type: "integer" },
  },
  required: ["refuted", "reasoning", "adjustedConfidence"],
};

// ---- lenses ----
const LENS = {
  "n-plus-one": "N+1 and repeated I/O: queries/requests/reads inside loops, per-item fetches that could be batched, missing eager-loading, repeated identical calls.",
  "quadratic": "Accidental quadratic or worse: nested loops over the same large collection, repeated linear scans (indexOf/includes in a loop), array operations that rebuild each iteration.",
  "hot-alloc": "Hot-path allocations: object/array/string allocation in tight loops, unnecessary copies/spreads, allocations that could be hoisted or pooled.",
  "sync-blocking": "Synchronous blocking on hot paths: sync I/O, blocking calls in async/event-loop code, unawaited parallelizable work done serially.",
  "missing-caching": "Missing caching/memoization: recomputing pure results, refetching unchanged data, no result/HTTP caching where appropriate.",
  "inefficient-structure": "Inefficient data structures: array used where set/map needed (O(n) lookups), wrong container for the access pattern, unindexed lookups.",
  "redundant-compute": "Redundant computation: work repeated that could be hoisted out of a loop, double serialization/parsing, recomputing invariants.",
};

function finderPrompt(cat, recon, roundNote) {
  return [
    `You are the "${cat}" performance finder. REPORT-ONLY — do NOT modify files.`,
    scope,
    `Repo profile (recon):\n${formatRecon(recon)}`,
    `Your lens: ${LENS[cat]}`,
    roundNote || "",
    `For EVERY finding set category to exactly "${cat}". Fill hotness (hot|warm|cold — how often the path actually runs, inferred from code), estimatedImpact (expected speedup/cost reduction), complexityBefore and complexityAfter (Big-O), and proposedChange (behavior-preserving optimization; describe, do NOT apply). Set confidence honestly. This is a STATIC READ-ONLY audit: no profiler, benchmark, or runtime metrics were run, so hotness is inferred from code structure, NOT measured. Distinguish OBSERVED evidence (the hot loop / large-data path / known entry point is directly visible in the code) from SUSPECTED hot-path risk (the path is only assumed hot without direct code evidence): state which in the description and set confidence HIGHER for observed evidence, LOWER for suspected-only risk. A premature optimization on a cold path is worse than a missed hotspot.`,
    `Return findings via the structured output.`,
  ].filter(Boolean).join("\n\n");
}

function skepticPrompt(f) {
  return [
    "You are a skeptic. REFUTE the performance finding — prove it is not worth fixing.",
    scope,
    `Finding (${f.category}) at ${f.file}:${f.line}:`,
    `Description: ${f.description}`,
    `Claimed hotness: ${f.hotness}; estimatedImpact: ${f.estimatedImpact}; complexity ${f.complexityBefore} -> ${f.complexityAfter}`,
    "Check: is this path actually hot / over large data? Is there OBSERVED code evidence (an explicit loop, a known entry point, visible data scale), or is the hot-path only SUSPECTED? Is the complexity analysis correct? Would the proposed change preserve behavior? Is this premature optimization of a cold path?",
    "Set refuted=true if not a real, worthwhile, evidenced optimization. Default to refuted=true when the hot-path is only SUSPECTED and unsupported by code evidence.",
  ].join("\n\n");
}

// ---- 1. Recon (use injected recon if present, else profile once) ----
await phase("recon");
const recon = RT.recon
  ? RT.recon
  : await agent(
    ["Profile this repository for performance analysis. Return the structured recon fields.", scope,
      "Report: languages/frameworks; package managers; entry points; hot paths (request handlers, loops over large data, batch jobs, render paths); data stores & I/O; expected data scale; any existing benchmarks/profiling (note their presence but do NOT run one); concurrency model; error-handling conventions; external resources; and notes on paths that look hot or process large data.",
      "Explore with your tools."].join("\n\n"),
    { label: "recon", schema: RECON_SCHEMA, tier: TIER_RECON, onFailure: "returnNull" },
  );

// ---- 2. Find + dedup ----
function dedup(findings) {
  const seen = new Set(); const out = [];
  for (const f of findings) {
    if (!f) continue;
    const key = `${f.category}::${(f.file || "").trim()}::${f.line || 0}`;
    if (seen.has(key)) continue;
    seen.add(key); out.push(f);
  }
  return out;
}

async function findRound(roundNote) {
  await phase("find");
  // arity-1 thunks (api) => ... so parallel() runs them CONCURRENTLY (zero-arg thunks fail unless { sequential: true } is explicit).
  const results = await parallel(categories.map((cat) => (api) =>
    api.agent(finderPrompt(cat, recon, roundNote), { label: `find:${cat}`, schema: FINDINGS_SCHEMA, tier: TIER_FINDER, onFailure: "returnNull" })));
  tallyPhase("find", results, (i) => `find:${categories[i]}`);
  return results.filter(Boolean).flatMap((r) => (r.findings || []).map((f) => ({ ...f, category: f.category || "unknown" })));
}

let findings = dedup(await findRound(null));
await log(`Round 1: ${findings.length} candidate hotspots across ${categories.length} lenses`);

if (depth === "thorough") {
  const known = findings.map((f) => `- ${f.category} ${f.file}:${f.line} — ${f.description}`).join("\n");
  const round2 = await findRound(`SECOND pass. Already found below — find only NEW hotspots, do not repeat:\n${known}`);
  findings = dedup(findings.concat(round2));
  await log(`After round 2: ${findings.length} candidates`);
}

// positional id (in-run reference) + stable content fingerprint (cross-run dedupe key)
findings = findings.map((f, i) => ({ ...f, id: `${f.category}-${i + 1}`, fingerprint: fingerprintOf(f) }));

if (findings.length === 0) {
  return envelope("empty", { summary: "No performance hotspots found.", counts: emptyCounts, findings: [], truncatedFindings: false, reportMarkdown: null, shellCoverage: SHELL_COVERAGE, coverageLimitations: COVERAGE_LIMITATIONS });
}

// ---- 3. Verify (high-FP profile) ----
// quick: high-severity only, 1 skeptic. normal: ALL, 1 skeptic. thorough: ALL, 3-skeptic majority (keep unless >=2 refute).
let toVerify, votes;
if (depth === "quick") { toVerify = findings.filter((f) => f.severity === "high"); votes = 1; }
else if (depth === "thorough") { toVerify = findings; votes = 3; }
else { toVerify = findings; votes = 1; }
const verifyIds = new Set(toVerify.map((f) => f.id));
const passThrough = findings.filter((f) => !verifyIds.has(f.id));

let verified = passThrough;
if (toVerify.length > 0) {
  await phase("verify");
  const checked = await parallel(toVerify.map((f) => (api) => {
    if (votes === 1) {
      return api.agent(skepticPrompt(f), { label: `verify:${f.id}`, schema: VERDICT_SCHEMA, tier: TIER_VERIFY, onFailure: "returnNull" })
        .then((v) => ({ f, keep: !!(v && !v.refuted), conf: v ? v.adjustedConfidence : undefined }));
    }
    return api.parallel([0, 1, 2].map((n) => (inner) =>
      inner.agent(`${skepticPrompt(f)}\n\n(Independent reviewer #${n + 1}.)`, { label: `verify:${f.id}#${n + 1}`, schema: VERDICT_SCHEMA, tier: TIER_VERIFY, onFailure: "returnNull" })))
      .then((vs) => {
        const ok = vs.filter(Boolean);
        const refutedCount = ok.filter((v) => v.refuted).length;
        const avg = ok.length ? Math.round(ok.reduce((s, v) => s + (v.adjustedConfidence || 0), 0) / ok.length) : f.confidence;
        return { f, keep: ok.length > 0 && refutedCount < 2, conf: avg };
      });
  }));
  tallyPhase("verify", checked, (i) => `verify:${toVerify[i].id}`);
  const survivors = checked.filter(Boolean).filter((c) => c.keep)
    .map((c) => ({ ...c.f, confidence: c.conf != null ? c.conf : c.f.confidence }));
  verified = passThrough.concat(survivors);
  await log(`Verified: ${survivors.length}/${toVerify.length} candidates survived; ${verified.length} total`);
}

if (verified.length === 0) {
  return envelope("empty", { summary: "No hotspots survived verification.", counts: emptyCounts, findings: [], truncatedFindings: false, reportMarkdown: null, shellCoverage: SHELL_COVERAGE, coverageLimitations: COVERAGE_LIMITATIONS });
}

// ---- 4. Synthesize (PURE JS — dedup, rank, render; the host persists the returned object) ----
await phase("synthesize");
const SEVW = { high: 3, medium: 2, low: 1 };
const EFFD = { small: 1, medium: 0.8, large: 0.6 };
function score(f) { return (SEVW[f.severity] || 1) * ((f.confidence || 0) / 100) * (EFFD[f.effort] || 0.8); }

const ranked = verified.map((f) => ({ ...f })).sort((a, b) => score(b) - score(a));
ranked.forEach((f, i) => { f.rank = i + 1; });

const counts = {
  total: ranked.length,
  critical: 0, // non-security domain: critical tier never populated
  high: ranked.filter((f) => f.severity === "high").length,
  medium: ranked.filter((f) => f.severity === "medium").length,
  low: ranked.filter((f) => f.severity === "low").length,
};

function mdCell(s) { return String(s == null ? "" : s).replace(/\|/g, "\\|").replace(/\n+/g, " "); }
function renderMarkdown(rows, c) {
  const lines = [];
  lines.push(`# Performance Audit Report (${DOMAIN})`, "");
  lines.push("> Report-only. No files were modified and nothing was applied. Static read-only analysis — no profiler/benchmark/metrics were run.", "");
  lines.push("## Summary", `- Total: ${c.total} (high: ${c.high}, medium: ${c.medium}, low: ${c.low})`, "");
  lines.push(`## Coverage`, `- shellCoverage: ${SHELL_COVERAGE}`, `- coverageLimitations: ${COVERAGE_LIMITATIONS}`, "");
  lines.push("## Ranked findings", "");
  lines.push("| Rank | Category | Severity | Hotness | Confidence | Location | Estimated impact |");
  lines.push("| ---- | -------- | -------- | ------- | ---------- | -------- | ---------------- |");
  for (const f of rows) {
    lines.push(`| ${f.rank} | ${mdCell(f.category)} | ${mdCell(f.severity)} | ${mdCell(f.hotness)} | ${f.confidence} | ${mdCell(f.file)}:${f.line || 0} | ${mdCell(f.estimatedImpact).slice(0, 100)} |`);
  }
  lines.push("", "## Detail");
  for (const f of rows) {
    lines.push("", `### ${f.rank}. ${mdCell(f.category)} — ${mdCell(f.file)}:${f.line || 0} (${f.severity}, ${mdCell(f.hotness)}, conf ${f.confidence})`);
    lines.push(`- **What:** ${f.description}`);
    lines.push(`- **Estimated impact:** ${f.estimatedImpact}`);
    lines.push(`- **Complexity:** ${f.complexityBefore} -> ${f.complexityAfter}`);
    lines.push(`- **Proposed change:** ${f.proposedChange}`);
    if (f.docImpact) lines.push(`- **Doc impact:** ${f.docImpact}`);
    lines.push(`- **Fingerprint:** \`${f.fingerprint}\``);
  }
  return lines.join("\n");
}

// Size-fit to the 256 KB host cap: drop reportMarkdown first, then halve findings, until it fits.
function utf8ByteLength(value) {
  const s = String(value ?? "");
  let bytes = 0;
  for (let i = 0; i < s.length; i += 1) {
    const code = s.charCodeAt(i);
    if (code <= 0x7f) bytes += 1;
    else if (code <= 0x7ff) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && i + 1 < s.length) {
      const next = s.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        i += 1;
      } else bytes += 3;
    } else bytes += 3;
  }
  return bytes;
}
function jsonUtf8ByteLength(value) {
  return utf8ByteLength(JSON.stringify(value));
}
function fitWithinBudget(status, summary) {
  const LIMIT = 230000; // headroom under MAX_RESULT_BYTES (262144) for the {output:...} wrapper + envelope fields
  let returned = ranked.slice(0, MAX_RETURN_FINDINGS);
  let truncated = ranked.length > returned.length;
  let reportMarkdown = renderMarkdown(ranked, counts);
  const sizeOf = () => jsonUtf8ByteLength(envelope(status, { summary, counts, findings: returned, truncatedFindings: truncated, reportMarkdown, shellCoverage: SHELL_COVERAGE, coverageLimitations: COVERAGE_LIMITATIONS }));
  if (sizeOf() > LIMIT) reportMarkdown = null;
  while (sizeOf() > LIMIT && returned.length > 10) {
    returned = returned.slice(0, Math.ceil(returned.length / 2));
    truncated = true;
  }
  return envelope(status, { summary, counts, findings: returned, truncatedFindings: truncated, reportMarkdown, shellCoverage: SHELL_COVERAGE, coverageLimitations: COVERAGE_LIMITATIONS });
}

const summary = `Found ${counts.total} performance hotspot(s): ${counts.high} high, ${counts.medium} medium, ${counts.low} low. Report-only — nothing applied. Static read-only analysis (no profiler/benchmark run).`;
return fitWithinBudget("ok", summary);
