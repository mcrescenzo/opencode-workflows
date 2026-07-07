// LEAF workflow — repo-cleanup engine (OpenCode port).
//
// Conforms to docs/repo-review-leaf-contract.md (the shared leaf contract).
// Canonical exemplar: workflows/repo-bughunt.js + tests/repo-bughunt.test.mjs.
// Port lineage (DOMAIN LOGIC only): internal Claude workflow source, adapted to
// the OpenCode QuickJS guest: no fs/Bash/git, tier-based models, PURE-JS
// synthesis (no model), and reportMarkdown returned in the envelope (the guest
// cannot write files, so reportPath is always null — the command wrapper
// persists the report).
//
// Domain stance: this is SAFE CLEANUP, not behavior-changing refactors. Findings
// describe dead code, unused deps, duplication, stale markers, simplification,
// best-practice gaps, and doc drift — each a report-only proposal. The high-risk
// "remove this" categories (dead-code, unused-deps) are adversarially verified
// because a wrong removal is the most damaging false positive.
export const meta = {
  name: "repo-cleanup",
  description: "Report-only repo cleanup research: find dead code, unused deps, duplication, stale markers, simplification & best-practice issues, and doc drift; adversarially verify the high-risk 'remove this' findings (dead-code, unused-deps); rank and return a structured envelope. Distinguishes safe cleanup from behavior-changing refactors. Report-only: returns ranked structured findings; the workflow writes no files.",
  profile: "read-only-review",
  maxAgents: 4096,
  concurrency: 16,
  phases: ["recon", "find", "verify", "synthesize"],
  category: "repo-review-leaf",
  notes: "Read-only report-only cleanup leaf. Proposes safe cleanup only, not behavior-changing refactors. Finder lanes use fast tier, high-risk removal verification uses deep tier.",
  examples: [
    { label: "normal cleanup scan", args: { depth: "normal", paths: ["src", "docs"] } },
    { label: "dead code and deps", args: { depth: "quick", categories: ["dead-code", "unused-deps"], paths: ["src"] } },
  ],
  argsSchema: {
    type: ["object", "string", "null"],
    properties: {
      paths: { type: "array", items: { type: "string" } },
      exclude: { type: "array", items: { type: "string" } },
      depth: { type: "string", enum: ["quick", "normal", "thorough"] },
      categories: { type: "array", items: { type: "string", enum: ["dead-code", "unused-deps", "duplication", "stale-markers", "simplification", "best-practice", "doc-drift"] } },
      maxReturnFindings: { type: "integer", minimum: 1 },
      recon: { type: ["object", "string"] },
    },
  },
};

// ---- suite identity ----
const DOMAIN = "cleanup";
const SCHEMA_VERSION = 1;

// args may arrive as an object (workflow_run args) or, defensively, a JSON string.
let RT = args;
if (typeof RT === "string") { try { RT = RT.trim() ? JSON.parse(RT) : {}; } catch (error) { throw new Error(`Invalid repo-cleanup runtime args JSON: ${error.message}`); } }
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

const ALL_CATEGORIES = ["dead-code", "unused-deps", "duplication", "stale-markers", "simplification", "best-practice", "doc-drift"];
const requestedCategories = Array.isArray(RT.categories) ? RT.categories.filter((c) => typeof c === "string" && c.trim()) : [];
const categories = requestedCategories.length > 0 ? requestedCategories.filter((c) => ALL_CATEGORIES.includes(c)) : ALL_CATEGORIES;
if (requestedCategories.length > 0 && categories.length === 0) {
  throw new Error(`No valid repo-cleanup categories supplied. Valid categories: ${ALL_CATEGORIES.join(", ")}`);
}

// Categories where a wrong "remove this" is most damaging — always verified in
// 'normal', and (with everything else) in 'thorough'. quick verifies nothing.
const HIGH_RISK = ["dead-code", "unused-deps"];

const scope = `Scope: paths = ${JSON.stringify(paths)}. Exclude (do not scan/report): ${JSON.stringify(exclude)}.`;

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
          proposedChange: { type: "string" },
          confidence: { type: "integer" },
          effort: { type: "string", enum: ["small", "medium", "large"] },
          docImpact: { type: "string" },
        },
        required: ["category", "file", "line", "severity", "description", "proposedChange", "confidence", "effort", "docImpact"],
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
  "dead-code": "Find DEAD or UNREACHABLE code: functions/methods/classes never called, unreferenced exports, unreachable branches, and large commented-out blocks. Be CONSERVATIVE — before flagging, check for dynamic dispatch, reflection, string-based references, re-exports, public API surface, and test-only usage. A wrong 'remove this' is the most damaging false positive.",
  "unused-deps": "Find UNUSED DEPENDENCIES: packages declared in the manifest (package.json / pyproject / go.mod / Cargo.toml / etc.) but never imported anywhere. Check transitive/peer/dev distinctions and build-tool / config-only usage before flagging. Be CONSERVATIVE — a wrong removal breaks the build.",
  "duplication": "Find DUPLICATION: copy-pasted logic, near-identical functions, and repeated patterns that should be factored into a shared helper. Report the canonical location and the duplicates; propose the extraction.",
  "stale-markers": "Find STALE MARKERS: old TODO/FIXME/HACK/XXX comments, dated stubs, leftover debug logging (console.log / print / dbg), commented-out experiments, and skipped/xfail tests. Note which look genuinely actionable vs. noise.",
  "simplification": "Find SIMPLIFICATION opportunities: overly complex conditionals, redundant abstractions, dead config flags, needless indirection, code that a clearer standard-library or idiomatic construct would replace. PRESERVE BEHAVIOR — this is safe cleanup, not a refactor: propose equivalent simpler code, do not change semantics.",
  "best-practice": "Find BEST-PRACTICE violations relative to this repo's own conventions and ecosystem norms: error handling gaps, inconsistent patterns, missing null/empty handling, resource leaks, insecure defaults, and deviations from the project's established style. Prefer issues backed by the repo's own AGENTS.md / linters / existing patterns.",
  "doc-drift": "Find DOC DRIFT: README / API docs / AGENTS.md / docstrings / code comments that are out of sync with the current code (renamed symbols, removed flags, changed signatures, stale examples, broken internal links). Report the doc location and the correction needed.",
};

function finderPrompt(cat, recon, roundNote) {
  return [
    `You are the "${cat}" finder for a REPORT-ONLY repo cleanup. Do NOT modify any files.`,
    scope,
    `Repo profile (recon):\n${formatRecon(recon)}`,
    `Your lens: ${LENS[cat]}`,
    roundNote || "",
    `Explore with your read/search tools. For EVERY finding set category to exactly "${cat}".`,
    `This is SAFE CLEANUP, not behavior-changing refactors — for simplification especially, propose behavior-preserving edits only.`,
    `Set confidence honestly (0-100): only high when you have verified the claim. Always fill docImpact (empty string if none).`,
    `Return findings via the structured output. Quality over quantity — a wrong finding is worse than a missed one.`,
  ].filter(Boolean).join("\n\n");
}

function skepticPrompt(f) {
  return [
    "You are a skeptic. Your job is to REFUTE the cleanup finding below — prove it is wrong, unsafe, or a false positive.",
    scope,
    `Finding (${f.category}) at ${f.file}:${f.line}:`,
    `Description: ${f.description}`,
    `Proposed change: ${f.proposedChange}`,
    "Investigate with your tools. For dead-code / unused-deps especially, hunt for ANY usage: dynamic/reflective references, string lookups, re-exports, public API, config, tests, build steps, other languages.",
    "Set refuted=true if acting on this would be wrong or unsafe. Default to refuted=true when genuinely uncertain.",
  ].join("\n\n");
}

// ---- 1. Recon (use injected recon if present, else profile once) ----
await phase("recon");
const recon = RT.recon
  ? RT.recon
  : await agent(
    ["Profile this repository for a cleanup pass. Be concise but concrete.", scope,
      "Report: primary language(s) and framework(s); build system & manifest files; entry points / public API surface; where docs live (README, docs/, AGENTS.md, etc.); test layout & runner; linter/formatter config present; anything that would make dead-code or unused-dep analysis tricky (dynamic loading, plugin systems, codegen).",
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
await log(`Round 1: ${findings.length} findings across ${categories.length} lenses`);

if (depth === "thorough") {
  const known = findings.map((f) => `- ${f.category} ${f.file}:${f.line} — ${f.description}`).join("\n");
  const round2 = await findRound(`SECOND pass. Already found below — find only NEW issues, do not repeat:\n${known}`);
  findings = dedup(findings.concat(round2));
  await log(`After round 2: ${findings.length} findings`);
}

// positional id (in-run reference) + stable content fingerprint (cross-run dedupe key)
findings = findings.map((f, i) => ({ ...f, id: `${f.category}-${i + 1}`, fingerprint: fingerprintOf(f) }));

if (findings.length === 0) {
  return envelope("empty", { summary: "No cleanup findings surfaced.", counts: emptyCounts, findings: [], truncatedFindings: false, reportMarkdown: null, staleDocs: [] });
}

// ---- 3. Verify (high-FP profile on the "remove this" categories) ----
// quick: verify nothing. normal: verify HIGH_RISK categories (dead-code, unused-deps). thorough: verify ALL.
function shouldVerify(f) {
  if (depth === "quick") return false;
  if (depth === "thorough") return true;
  return HIGH_RISK.includes(f.category);
}
const toVerify = findings.filter(shouldVerify);
const passThrough = findings.filter((f) => !shouldVerify(f));

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
  await log(`Verified: ${survivors.length}/${toVerify.length} high-risk findings survived; ${verified.length} total`);
}

if (verified.length === 0) {
  return envelope("empty", { summary: "No cleanup findings survived verification.", counts: emptyCounts, findings: [], truncatedFindings: false, reportMarkdown: null, staleDocs: [] });
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
  critical: 0,
  high: ranked.filter((f) => f.severity === "high").length,
  medium: ranked.filter((f) => f.severity === "medium").length,
  low: ranked.filter((f) => f.severity === "low").length,
};

// Per-domain carve-out (SUITE-CONTRACT): staleDocs = doc paths from the
// surviving doc-drift findings. Empty when no doc-drift finding survives.
const staleDocs = [];
const seenDocs = new Set();
for (const f of ranked) {
  if (f.category !== "doc-drift") continue;
  const doc = (f.file || "").trim();
  if (doc && !seenDocs.has(doc)) { seenDocs.add(doc); staleDocs.push(doc); }
}

function mdCell(s) { return String(s == null ? "" : s).replace(/\|/g, "\\|").replace(/\n+/g, " "); }
function renderMarkdown(rows, c, docs) {
  const lines = [];
  lines.push(`# Cleanup Report (${DOMAIN})`, "");
  lines.push("> Report-only. No files were modified and nothing was applied — these are proposals, not edits.", "");
  lines.push("## Summary", `- Total: ${c.total} (high: ${c.high}, medium: ${c.medium}, low: ${c.low})`, "");
  if (docs.length > 0) {
    lines.push("## Docs already stale", "Documentation paths out of sync with the current code (from the doc-drift lens):");
    for (const d of docs) lines.push(`- ${mdCell(d)}`);
    lines.push("");
  }
  lines.push("## Ranked findings", "");
  lines.push("| Rank | Category | Severity | Confidence | Effort | Location | Description |");
  lines.push("| ---- | -------- | -------- | ---------- | ------ | -------- | ----------- |");
  for (const f of rows) {
    lines.push(`| ${f.rank} | ${mdCell(f.category)} | ${mdCell(f.severity)} | ${f.confidence} | ${mdCell(f.effort)} | ${mdCell(f.file)}:${f.line || 0} | ${mdCell(f.description).slice(0, 140)} |`);
  }
  lines.push("", "## Detail");
  for (const f of rows) {
    lines.push("", `### ${f.rank}. ${mdCell(f.category)} — ${mdCell(f.file)}:${f.line || 0} (${f.severity}, conf ${f.confidence})`);
    lines.push(`- **What:** ${f.description}`);
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
  let reportMarkdown = renderMarkdown(ranked, counts, staleDocs);
  const sizeOf = () => jsonUtf8ByteLength(envelope(status, { summary, counts, findings: returned, truncatedFindings: truncated, reportMarkdown, staleDocs }));
  if (sizeOf() > LIMIT) reportMarkdown = null;
  while (sizeOf() > LIMIT && returned.length > 10) {
    returned = returned.slice(0, Math.ceil(returned.length / 2));
    truncated = true;
  }
  return envelope(status, { summary, counts, findings: returned, truncatedFindings: truncated, reportMarkdown, staleDocs });
}

const summary = `Found ${counts.total} cleanup finding(s): ${counts.high} high, ${counts.medium} medium, ${counts.low} low. Report-only — nothing applied.`;
return fitWithinBudget("ok", summary);
