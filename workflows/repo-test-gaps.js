// LEAF workflow — repo-test-gaps engine (OpenCode port).
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
// coverage tool or test suite (no shell), so it defaults shellCoverage="none"
// and emits a coverageLimitations string explaining coverage was NOT measured.
// It never claims line/branch coverage metrics it did not observe.
export const meta = {
  name: "repo-test-gaps",
  description: "Map undertested code across a repo (uncovered public surfaces, untested error paths, missing edge cases, branches exercised without assertions, weak critical paths, untested integration seams) and propose concrete tests. Report-only: returns ranked structured findings; the workflow writes no files.",
  profile: "read-only-review",
  maxAgents: 4096,
  concurrency: 16,
  phases: ["recon", "find", "verify", "synthesize"],
  category: "repo-review-leaf",
  notes: "Read-only report-only test-gap leaf. Does not run coverage or tests; findings are static proposals. Finder lanes use fast tier, high-risk verification uses deep tier.",
  examples: [
    { label: "normal test-gap scan", args: { depth: "normal", paths: ["src", "tests"] } },
    { label: "critical-path gaps", args: { depth: "quick", categories: ["weak-critical-path", "untested-error-path"], paths: ["src"] } },
  ],
  argsSchema: {
    type: ["object", "string", "null"],
    properties: {
      paths: { type: "array", items: { type: "string" } },
      exclude: { type: "array", items: { type: "string" } },
      depth: { type: "string", enum: ["quick", "normal", "thorough"] },
      categories: { type: "array", items: { type: "string", enum: ["uncovered-public", "untested-error-path", "missing-edge-case", "branch-no-assertion", "weak-critical-path", "untested-seam"] } },
      maxReturnFindings: { type: "integer", minimum: 1 },
      recon: { type: ["object", "string"] },
    },
  },
};

// ---- suite identity ----
const DOMAIN = "test-gaps";
const SCHEMA_VERSION = 1;

// args may arrive as an object (workflow_run args) or, defensively, a JSON string.
let RT = args;
if (typeof RT === "string") { try { RT = RT.trim() ? JSON.parse(RT) : {}; } catch (error) { throw new Error(`Invalid repo-test-gaps runtime args JSON: ${error.message}`); } }
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

const ALL_CATEGORIES = ["uncovered-public", "untested-error-path", "missing-edge-case", "branch-no-assertion", "weak-critical-path", "untested-seam"];
const requestedCategories = Array.isArray(RT.categories) ? RT.categories.filter((c) => typeof c === "string" && c.trim()) : [];
const categories = requestedCategories.length > 0 ? requestedCategories.filter((c) => ALL_CATEGORIES.includes(c)) : ALL_CATEGORIES;
if (requestedCategories.length > 0 && categories.length === 0) {
  throw new Error(`No valid repo-test-gaps categories supplied. Valid categories: ${ALL_CATEGORIES.join(", ")}`);
}
// High-risk gaps are the ones a "normal" depth run subjects to adversarial verification.
const HIGH_RISK = ["uncovered-public", "untested-error-path", "weak-critical-path"];

const scope = `Scope: paths = ${JSON.stringify(paths)}. Exclude (do not scan/report): ${JSON.stringify(exclude)}.`;

// ---- coverage-aware extension fields (docs/repo-review-leaf-contract.md §2) ----
// read-only-review gives the engine NO shell, so no coverage tool or test suite
// is executed. We therefore default shellCoverage="none" and state why coverage
// metrics were NOT observed. We never claim coverage percentages we did not run.
const SHELL_COVERAGE = "none";
const COVERAGE_LIMITATIONS = "No coverage tool or test suite was executed by this read-only engine (no shell); line/branch coverage was not measured. Gaps reflect static and agent review of code paths against nearby tests, not observed coverage metrics. Do not read these findings as coverage percentages.";

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
          targetUnderTest: { type: "string" },
          suggestedTest: { type: "string" },
          proposedChange: { type: "string" },
          confidence: { type: "integer" },
          effort: { type: "string", enum: ["small", "medium", "large"] },
          docImpact: { type: "string" },
        },
        required: ["category", "file", "line", "severity", "description", "targetUnderTest", "suggestedTest", "proposedChange", "confidence", "effort", "docImpact"],
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
  "uncovered-public": "Public functions/methods/exports with NO test exercising them at all.",
  "untested-error-path": "Error/exception/failure paths never asserted: thrown errors, rejected promises, non-happy returns, retries, rollbacks.",
  "missing-edge-case": "Edge cases not covered: boundaries (0, 1, max), empty/null inputs, large inputs, unicode, concurrency, time/timezone.",
  "branch-no-assertion": "Conditional branches that execute in tests but whose outcomes are never asserted (coverage without verification).",
  "weak-critical-path": "Business-critical paths (auth, payments, data writes, security) with weak or shallow assertions.",
  "untested-seam": "Integration seams (DB, network, file, queue boundaries) with no test, or only fully-mocked tests that assert nothing real.",
};

function finderPrompt(cat, recon, roundNote) {
  return [
    `You are the "${cat}" test-gap finder. REPORT-ONLY — do NOT write tests yet.`,
    scope,
    `Repo profile (recon):\n${formatRecon(recon)}`,
    `Your lens: ${LENS[cat]}`,
    roundNote || "",
    `For EVERY finding set category to exactly "${cat}". Fill targetUnderTest (the function/branch/path that needs a test) and a concrete suggestedTest (a skeleton matching the repo's test framework/style). Only flag genuine gaps — verify the code isn't already tested elsewhere before flagging.`,
    `Return findings via the structured output.`,
  ].filter(Boolean).join("\n\n");
}

function skepticPrompt(f) {
  return [
    "You are a skeptic. Try to REFUTE the claimed test gap below — prove it IS already tested.",
    scope,
    `Claimed gap (${f.category}) at ${f.file}:${f.line}:`,
    `Description: ${f.description}`,
    `Target under test: ${f.targetUnderTest}`,
    "Search the WHOLE test suite for DIRECT OR INDIRECT coverage. A gap is refuted if any test — even one written for a different purpose — exercises and asserts this target, OR if the target is unreachable/does not exist.",
    "Set refuted=true if it is already covered (directly or indirectly) or not a real gap. Default to refuted=true when genuinely uncertain.",
  ].join("\n\n");
}

// ---- 1. Recon (use injected recon if present, else profile once) ----
await phase("recon");
const recon = RT.recon
  ? RT.recon
  : await agent(
    ["Profile this repository for test-gap analysis.", scope,
      "Report: languages/frameworks; test framework(s) & runner; how tests are organized/named; whether a coverage tool is configured (note its name but do NOT run or install one); the public API surface and the most critical paths (auth, money, data writes).",
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
await log(`Round 1: ${findings.length} candidate gaps across ${categories.length} lenses`);

if (depth === "thorough") {
  const known = findings.map((f) => `- ${f.category} ${f.file}:${f.line} — ${f.description}`).join("\n");
  const round2 = await findRound(`SECOND pass. Already found below — find only NEW gaps, do not repeat:\n${known}`);
  findings = dedup(findings.concat(round2));
  await log(`After round 2: ${findings.length} candidates`);
}

// positional id (in-run reference) + stable content fingerprint (cross-run dedupe key)
findings = findings.map((f, i) => ({ ...f, id: `${f.category}-${i + 1}`, fingerprint: fingerprintOf(f) }));

if (findings.length === 0) {
  return envelope("empty", { summary: "No test gaps found.", counts: emptyCounts, findings: [], truncatedFindings: false, reportMarkdown: null, shellCoverage: SHELL_COVERAGE, coverageLimitations: COVERAGE_LIMITATIONS });
}

// ---- 3. Verify (indirect-coverage refutation profile) ----
// quick: no verification. normal: verify HIGH_RISK categories only. thorough: verify ALL. Single-vote skeptic.
let toVerify;
if (depth === "quick") toVerify = [];
else if (depth === "thorough") toVerify = findings;
else toVerify = findings.filter((f) => HIGH_RISK.includes(f.category)); // normal
const verifyIds = new Set(toVerify.map((f) => f.id));
const passThrough = findings.filter((f) => !verifyIds.has(f.id));

let verified = passThrough;
if (toVerify.length > 0) {
  await phase("verify");
  const checked = await parallel(toVerify.map((f) => (api) =>
    api.agent(skepticPrompt(f), { label: `verify:${f.id}`, schema: VERDICT_SCHEMA, tier: TIER_VERIFY, onFailure: "returnNull" })
      .then((v) => ({ f, keep: !!(v && !v.refuted), conf: v ? v.adjustedConfidence : undefined }))));
  tallyPhase("verify", checked, (i) => `verify:${toVerify[i].id}`);
  const survivors = checked.filter(Boolean).filter((c) => c.keep)
    .map((c) => ({ ...c.f, confidence: c.conf != null ? c.conf : c.f.confidence }));
  verified = passThrough.concat(survivors);
  await log(`Verified: ${survivors.length}/${toVerify.length} gaps survived; ${verified.length} total`);
}

if (verified.length === 0) {
  return envelope("empty", { summary: "No test gaps survived verification.", counts: emptyCounts, findings: [], truncatedFindings: false, reportMarkdown: null, shellCoverage: SHELL_COVERAGE, coverageLimitations: COVERAGE_LIMITATIONS });
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
  lines.push(`# Test Gaps Report (${DOMAIN})`, "");
  lines.push("> Report-only. No files were modified, no tests were written, and no coverage tool was run.", "");
  lines.push("## Summary", `- Total: ${c.total} (high: ${c.high}, medium: ${c.medium}, low: ${c.low})`, "");
  lines.push(`## Coverage`, `- shellCoverage: ${SHELL_COVERAGE}`, `- coverageLimitations: ${COVERAGE_LIMITATIONS}`, "");
  lines.push("## Ranked findings", "");
  lines.push("| Rank | Category | Severity | Confidence | Location | Target | Description |");
  lines.push("| ---- | -------- | -------- | ---------- | -------- | ------ | ----------- |");
  for (const f of rows) {
    lines.push(`| ${f.rank} | ${mdCell(f.category)} | ${mdCell(f.severity)} | ${f.confidence} | ${mdCell(f.file)}:${f.line || 0} | ${mdCell(f.targetUnderTest).slice(0, 80)} | ${mdCell(f.description).slice(0, 120)} |`);
  }
  lines.push("", "## Detail");
  for (const f of rows) {
    lines.push("", `### ${f.rank}. ${mdCell(f.category)} — ${mdCell(f.file)}:${f.line || 0} (${f.severity}, conf ${f.confidence})`);
    lines.push(`- **What's untested:** ${f.description}`);
    lines.push(`- **Target under test:** ${f.targetUnderTest}`);
    lines.push(`- **Suggested test:** ${f.suggestedTest}`);
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

const summary = `Found ${counts.total} test gap(s): ${counts.high} high, ${counts.medium} medium, ${counts.low} low. Report-only — nothing applied.`;
return fitWithinBudget("ok", summary);
