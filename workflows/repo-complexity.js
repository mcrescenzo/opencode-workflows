// LEAF workflow — repo-complexity engine. Conforms to
// docs/repo-review-leaf-contract.md (the shared leaf contract). Mirrors the
// repo-bughunt template + the contract; the shared pieces (envelope(),
// RECON_SCHEMA, formatRecon(), fingerprintOf(), the arg-coercion preamble, and
// fitWithinBudget()) are duplicated verbatim because the QuickJS guest cannot
// `import` any module. This is a LEAF: it NEVER calls workflow() (the
// /repo-review meta invokes THIS via workflow(); nesting is one level only).
export const meta = {
  name: "repo-complexity",
  description: "Rank refactor hotspots across a repo by complexity x churn (god-object, long-function, deep-nesting, tangled-module, high-churn-hotspot). Fans out one scorer per source directory, adversarially verifies each refactor suggestion, and ranks by hotspot score. Report-only: returns ranked structured findings; the workflow writes no files.",
  profile: "read-only-review",
  maxAgents: 4096,
  concurrency: 16,
  phases: ["recon", "find", "verify", "synthesize"],
  category: "repo-review-leaf",
  notes: "Read-only report-only complexity leaf. Ranks refactor hotspots by static complexity/churn signals; maxDirs bounds scorer fan-out. Finder lanes use fast tier, verification uses deep tier.",
  examples: [
    { label: "normal complexity scan", args: { depth: "normal", paths: ["src"], maxDirs: 40 } },
    { label: "focused hotspots", args: { depth: "quick", categories: ["long-function", "tangled-module"], paths: ["src"], maxDirs: 20 } },
  ],
  argsSchema: {
    type: ["object", "string", "null"],
    properties: {
      paths: { type: "array", items: { type: "string" } },
      exclude: { type: "array", items: { type: "string" } },
      depth: { type: "string", enum: ["quick", "normal", "thorough"] },
      categories: { type: "array", items: { type: "string", enum: ["god-object", "long-function", "deep-nesting", "tangled-module", "high-churn-hotspot"] } },
      maxDirs: { type: "integer", minimum: 1 },
      maxReturnFindings: { type: "integer", minimum: 1 },
      recon: { type: ["object", "string"] },
    },
  },
};

// ---- suite identity ----
const DOMAIN = "complexity";
const SCHEMA_VERSION = 1;

// ---- arg coercion preamble (duplicated verbatim per docs/repo-review-leaf-contract.md §8/§11) ----
// args may arrive as an object (workflow_run args) or, defensively, a JSON string.
let RT = args;
if (typeof RT === "string") { try { RT = RT.trim() ? JSON.parse(RT) : {}; } catch (error) { throw new Error(`Invalid repo-complexity runtime args JSON: ${error.message}`); } }
if (!RT || typeof RT !== "object" || Array.isArray(RT)) RT = {};

const paths = Array.isArray(RT.paths) && RT.paths.length ? RT.paths : ["."];
const exclude = Array.isArray(RT.exclude) ? RT.exclude : ["node_modules", "dist", "build", ".git", "vendor", "target", "*.min.*", "*.map"];
const depth = ["quick", "normal", "thorough"].includes(RT.depth) ? RT.depth : "thorough";

// Complexity is churn-dependent: accept a maxDirs clamp arg (SUITE-CONTRACT per-domain carve-out;
// cited in docs/repo-review-leaf-contract.md §2). Positive integer; bounds the per-directory scorer
// fan-out so agent count stays predictable. 0/neg would drop the whole tail, so default to 40.
const maxDirs = Number.isInteger(RT.maxDirs) && RT.maxDirs > 0 ? RT.maxDirs : 1000000;

// Model selection is intent-based: lanes declare a tier; the kernel resolves tier -> concrete model
// from run.modelTiers (set by the planning agent). recon + scorers = bulk work (fast); skeptics =
// subtle correctness (deep); synth = pure JS (no model).
const TIER_RECON = "fast";
const TIER_FINDER = "fast";
const TIER_VERIFY = "deep";

const MAX_RETURN_FINDINGS = Number.isInteger(RT.maxReturnFindings) && RT.maxReturnFindings > 0 ? RT.maxReturnFindings : 1000000;

const ALL_CATEGORIES = ["god-object", "long-function", "deep-nesting", "tangled-module", "high-churn-hotspot"];
const requestedCategories = Array.isArray(RT.categories) ? RT.categories.filter((c) => typeof c === "string" && c.trim()) : [];
const categories = requestedCategories.length > 0 ? requestedCategories.filter((c) => ALL_CATEGORIES.includes(c)) : ALL_CATEGORIES;
if (requestedCategories.length > 0 && categories.length === 0) {
  throw new Error(`No valid repo-complexity categories supplied. Valid categories: ${ALL_CATEGORIES.join(", ")}`);
}

const scope = `Scope: paths = ${JSON.stringify(paths)}. Exclude (do not scan/report): ${JSON.stringify(exclude)}.`;

// ---- shell/churn lens (DECISION: deferred under read-only-review) ----
//
// Complexity is the ONE domain whose hotspot score depends on git churn (the
// "high-churn-hotspot" category), which needs a shell (`git log`). The OPTIONAL
// shell lens maps to the `inspect-with-shell` authority profile
// (workflow-kernel/authority-policy.js:21-24; requiredGates:
// ["permissionEnforcement","commandScopedBash"]). Those gates are currently
// UNVERIFIED in this runtime, so this engine ships under `read-only-review`
// (authority-policy.js:17-20; requiredGates: [], authority readOnly:true) as the
// SAFE DEFAULT: no Bash, no `git`, no fs writes. Churn is therefore best-effort
// (inferred from read-only tree signals, or 0 when unknown) and hotspotScore
// approximates complexityScore. Enabling the shell/churn lens is a future,
// separately-approved change gated on VERIFIED inspect-with-shell gates; until
// then shellCoverage stays "none" (emitted on every exit path below). This engine
// does NOT enable the shell lens.
const SHELL_COVERAGE = "none";
const COVERAGE_LIMITATIONS =
  "Shell/git churn not measured: read-only-review denies Bash, so `git log` churn is unavailable. churn is best-effort (0 when unknown) and hotspotScore approximates complexityScore. Enable inspect-with-shell (verified permissionEnforcement + commandScopedBash gates) for real git-log churn.";

// ---- lane coverage telemetry (iui1.2) ----
// Tracks expected/completed/dropped lane counts per phase so a dropped scorer/verifier lane
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
// Complexity always emits the shellCoverage/coverageLimitations extension fields (per-domain carve-out,
// docs/repo-review-leaf-contract.md §2); they are added to the base envelope here so every exit path carries them.
function envelope(status, extra) {
  return { domain: DOMAIN, schemaVersion: SCHEMA_VERSION, status, abortReason: null, reportPath: null, laneCoverage, shellCoverage: SHELL_COVERAGE, coverageLimitations: COVERAGE_LIMITATIONS, ...extra };
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

// ---- domain-specific recon schema (source dirs + git availability) ----
const COMPLEXITY_RECON_SCHEMA = {
  type: "object", additionalProperties: false,
  properties: {
    profile: { type: "string" },
    dirs: { type: "array", items: { type: "string" } },
    gitAvailable: { type: "boolean" },
  },
  required: ["profile", "dirs", "gitAvailable"],
};

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
          churn: { type: "integer" },
          complexityScore: { type: "integer" },
          hotspotScore: { type: "integer" },
          refactorSuggestion: { type: "string" },
          proposedChange: { type: "string" },
          confidence: { type: "integer" },
          effort: { type: "string", enum: ["small", "medium", "large"] },
          docImpact: { type: "string" },
        },
        required: ["category", "file", "line", "severity", "description", "churn", "complexityScore", "hotspotScore", "refactorSuggestion", "proposedChange", "confidence", "effort", "docImpact"],
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

// ---- lenses / prompts ----
function scorerPrompt(dir, recon, complexityProfile, gitAvailable) {
  return [
    `You are a complexity scorer for the directory "${dir}". REPORT-ONLY — do NOT modify files.`,
    scope,
    `Repo profile (recon):\n${formatRecon(recon)}`,
    `Domain profile:\n${complexityProfile || "(no profile)"}`,
    "You have READ-ONLY tools only (no shell, no git). Compute a complexity heuristic (0-100) from file size, max nesting depth, function length, and parameter counts by inspecting the files in this directory.",
    gitAvailable
      ? "This is a git repo, but you CANNOT run git under read-only-review. Infer churn signals only from working-tree evidence visible to read-only tools (recent WIP/TODO markers, obvious churn hints); otherwise set churn to 0."
      : "Not a git repo: set churn to 0 for every finding.",
    `Compute hotspotScore as a 0-100 composite of churn x complexity. With churn unavailable, hotspotScore approximates complexityScore. Emit a finding for each genuinely notable hotspot — category one of: ${categories.join(" | ")}. Provide a concrete refactorSuggestion and proposedChange. Only flag notable files, not every file.`,
    "Return findings via the structured output.",
  ].join("\n\n");
}

function skepticPrompt(f) {
  return [
    "You are a skeptic. Try to REFUTE the refactor suggestion below — argue it is unsound, risky, or not worth the effort.",
    scope,
    `Hotspot (${f.category}) at ${f.file}:${f.line}:`,
    `Description: ${f.description}`,
    `Suggested refactor: ${f.refactorSuggestion}`,
    "Consider: would the refactor preserve behavior? is the file genuinely a maintenance burden (complexity x churn)? is the suggestion concrete and safe?",
    "Set refuted=true if the suggestion is poor. Default to refuted=true when genuinely uncertain.",
  ].join("\n\n");
}

// ---- 1. Recon (use injected recon if present, else profile once) + domain recon ----
await phase("recon");
const recon = RT.recon
  ? RT.recon
  : await agent(
    ["Profile this repository for review. Return the structured recon fields.", scope,
      "Report: languages/frameworks; package managers; entry points; test layout; build tooling; concurrency model (threads/async/event loop); error-handling conventions; external resources (DB, files, network); and notes on anything that makes a code path notable for complexity or high churn.",
      "Explore with your tools."].join("\n\n"),
    { label: "recon", schema: RECON_SCHEMA, tier: TIER_RECON, onFailure: "returnNull" },
  );

// Domain recon always computed locally (shared recon does not carry dirs/gitAvailable).
const complexityRecon = await agent(
  ["Profile this repository for a complexity / refactor-hotspot analysis.", scope,
    "Determine: whether it is a git repo (so git-based churn would be relevant); and the list of real SOURCE directories worth analyzing (repo-relative paths, excluding vendored/build/test-fixture dirs). Keep the dir list focused (merge tiny ones). Also write a compact prose profile of the codebase.",
    "Explore with your tools. Return the structured output."].join("\n\n"),
  { label: "complexity-recon", schema: COMPLEXITY_RECON_SCHEMA, tier: TIER_RECON, onFailure: "returnNull" },
);
if (!complexityRecon || typeof complexityRecon !== "object") {
  return envelope("aborted", { abortReason: "complexity-recon agent returned null; cannot score directories.", summary: "Aborted: complexity recon failed.", counts: emptyCounts, findings: [], truncatedFindings: false, reportMarkdown: null });
}

// Apply the maxDirs clamp so the per-directory fan-out stays bounded.
const rawDirs = (Array.isArray(complexityRecon.dirs) && complexityRecon.dirs.length) ? complexityRecon.dirs : paths;
const dirs = rawDirs.slice(0, maxDirs);
if (rawDirs.length > maxDirs) {
  await log(`maxDirs clamp applied: ${rawDirs.length} dirs -> ${dirs.length} (maxDirs=${maxDirs})`);
}
const gitAvailable = !!complexityRecon.gitAvailable;

// ---- 2. Find + dedup (one scorer per directory) ----
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

await phase("find");
// arity-1 thunks (api) => ... so parallel() runs them CONCURRENTLY (zero-arg thunks fail unless { sequential: true } is explicit).
const perDir = await parallel(dirs.map((dir) => (api) =>
  api.agent(scorerPrompt(dir, recon, complexityRecon.profile, gitAvailable), { label: `score:${dir}`, schema: FINDINGS_SCHEMA, tier: TIER_FINDER, onFailure: "returnNull" })));

tallyPhase("score", perDir, (i) => `score:${dirs[i]}`);
let findings = dedup(perDir.filter(Boolean).flatMap((r) => (r.findings || []).map((f) => ({ ...f, category: f.category || "unknown" }))));
await log(`Scored ${dirs.length} directories: ${findings.length} hotspots`);

// positional id (in-run reference) + stable content fingerprint (cross-run dedupe key)
findings = findings.map((f, i) => ({ ...f, id: `${f.category}-${i + 1}`, fingerprint: fingerprintOf(f) }));

if (findings.length === 0) {
  return envelope("empty", { summary: "No notable complexity hotspots found.", counts: emptyCounts, findings: [], truncatedFindings: false, reportMarkdown: null });
}

// ---- 3. Verify (light: refactor soundness) ----
// quick: none. normal: verify high-severity. thorough: verify all. Single skeptic each (no majority vote).
let toVerify;
if (depth === "quick") toVerify = [];
else if (depth === "thorough") toVerify = findings;
else toVerify = findings.filter((f) => f.severity === "high");
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
  await log(`Verified: ${survivors.length}/${toVerify.length} suggestions held; ${verified.length} total`);
}

if (verified.length === 0) {
  return envelope("empty", { summary: "No hotspots survived verification.", counts: emptyCounts, findings: [], truncatedFindings: false, reportMarkdown: null });
}

// ---- 4. Synthesize (PURE JS — rank by hotspotScore, then severity, then confidence; render markdown) ----
await phase("synthesize");
const SEVW = { high: 3, medium: 2, low: 1 };
function rankKey(f) {
  return [Number(f.hotspotScore) || 0, SEVW[f.severity] || 0, Number(f.confidence) || 0];
}
const ranked = verified.map((f) => ({ ...f })).sort((a, b) => {
  const ka = rankKey(a), kb = rankKey(b);
  if (ka[0] !== kb[0]) return kb[0] - ka[0];
  if (ka[1] !== kb[1]) return kb[1] - ka[1];
  return kb[2] - ka[2];
});
ranked.forEach((f, i) => { f.rank = i + 1; });

const counts = {
  total: ranked.length,
  critical: 0, // non-security domain: never populates critical (docs/repo-review-leaf-contract.md §4/§6)
  high: ranked.filter((f) => f.severity === "high").length,
  medium: ranked.filter((f) => f.severity === "medium").length,
  low: ranked.filter((f) => f.severity === "low").length,
};

function mdCell(s) { return String(s == null ? "" : s).replace(/\|/g, "\\|").replace(/\n+/g, " "); }
function renderMarkdown(rows, c) {
  const lines = [];
  lines.push(`# Complexity Hotspot Report (${DOMAIN})`, "");
  lines.push("> Report-only. No files were modified and nothing was applied.", "");
  lines.push("## Summary", `- Total: ${c.total} (high: ${c.high}, medium: ${c.medium}, low: ${c.low})`, "");
  lines.push("## Ranked findings", "");
  lines.push("| Rank | Category | Severity | Hotspot | Churn | Complexity | Confidence | Location | Description |");
  lines.push("| ---- | -------- | -------- | ------- | ----- | ---------- | ---------- | -------- | ----------- |");
  for (const f of rows) {
    lines.push(`| ${f.rank} | ${mdCell(f.category)} | ${mdCell(f.severity)} | ${f.hotspotScore} | ${f.churn} | ${f.complexityScore} | ${f.confidence} | ${mdCell(f.file)}:${f.line || 0} | ${mdCell(f.description).slice(0, 140)} |`);
  }
  lines.push("", "## Detail");
  for (const f of rows) {
    lines.push("", `### ${f.rank}. ${mdCell(f.category)} — ${mdCell(f.file)}:${f.line || 0} (${f.severity}, hotspot ${f.hotspotScore}, churn ${f.churn}, complexity ${f.complexityScore})`);
    lines.push(`- **What:** ${f.description}`);
    lines.push(`- **Refactor:** ${f.refactorSuggestion}`);
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
  const sizeOf = () => jsonUtf8ByteLength(envelope(status, { summary, counts, findings: returned, truncatedFindings: truncated, reportMarkdown }));
  if (sizeOf() > LIMIT) reportMarkdown = null;
  while (sizeOf() > LIMIT && returned.length > 10) {
    returned = returned.slice(0, Math.ceil(returned.length / 2));
    truncated = true;
  }
  return envelope(status, { summary, counts, findings: returned, truncatedFindings: truncated, reportMarkdown });
}

const summary = `Found ${counts.total} complexity hotspot(s): ${counts.high} high, ${counts.medium} medium, ${counts.low} low. Report-only — nothing applied.`;
return fitWithinBudget("ok", summary);
