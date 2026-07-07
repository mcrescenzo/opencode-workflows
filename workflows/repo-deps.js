// LEAF workflow — repo-deps engine (OpenCode port).
//
// Conforms to docs/repo-review-leaf-contract.md (the shared leaf contract).
// Canonical exemplar: workflows/repo-bughunt.js + tests/repo-bughunt.test.mjs.
// Sibling analog: workflows/repo-cleanup.js (same shape, top-level carve-out).
// Port lineage (DOMAIN LOGIC only): internal Claude workflow source, adapted to
// the OpenCode QuickJS guest: no fs/Bash/git, tier-based models (never hard-coded
// provider models), PURE-JS synthesis (no model), and reportMarkdown returned in
// the envelope (the guest cannot write files, so reportPath is always null — the
// command wrapper persists the report). The Claude source delegated synthesis and
// report-writing to a model lane and instructed lanes to run package-manager
// audit/outdated tools; both are reversed here: synthesis is pure JS and the
// DEPENDENCY INSPECTION POLICY is read-only lockfile/manifest inspection with NO
// network, installs, or package-manager mutation.
//
// DOMAIN: deps. This is a NON-SECURITY domain, so counts.critical is ALWAYS 0 and
// findings never carry severity "critical" (contract §6). CVE findings are still
// reported (category "cve") at high/medium/low severity.
//
// POLICY (the defining constraint of this leaf): NO network, NO installs, NO
// package-manager mutation. Lanes inspect lockfiles and manifests READ-ONLY and
// derive versions/findings from local files. CVE/outdated claims that cannot be
// proven from local files alone are reported at REDUCED confidence with the gap
// noted. See DEPS_POLICY below.
//
// SHELL-INSPECTION DEFERRAL: the contract (§2/§12) and authority-policy.js reserve
// the "inspect-with-shell" profile for the documented deps/complexity parity gaps,
// where a lane could run a read-only command allowlist (e.g. `npm ls`, `cargo tree`)
// to ground version trees and populate shellCoverage/coverageLimitations. That
// profile requires verified `permissionEnforcement` + `commandScopedBash` live gates
// (authority-policy.js:21-24), which are currently UNVERIFIED in this runtime
// (Stage-0 gate rrev.1: FALLBACK-ACCEPTED, inspect-with-shell NOT verified). This
// leaf therefore ships the DEFAULT "read-only-review" profile (requiredGates: []) and
// the shell lens is DEFERRED until those gates are verified. When shell inspection is
// later enabled, define an explicit read-only command allowlist (deny install/audit
// network commands) and populate shellCoverage/coverageLimitations; until then, keep
// the reduced-confidence policy below.
export const meta = {
  name: "repo-deps",
  description: "Report-only dependency health audit: outdated packages, known CVEs (from local-file analysis), unused/undeclared deps, license risk, version conflicts, and deprecated packages. Read-only lockfile/manifest inspection — no network, no installs, no package-manager mutation. Adversarially verifies the high-risk 'unused/undeclared' findings, ranks them, and returns a structured envelope plus a sequenced upgradePlan. Report-only: returns ranked structured findings; the workflow writes no files.",
  profile: "read-only-review",
  maxAgents: 4096,
  concurrency: 16,
  phases: ["recon", "find", "verify", "synthesize"],
  category: "repo-review-leaf",
  notes: "Read-only report-only dependency leaf. Inspects local manifests/lockfiles only: no network, installs, audit, or package-manager mutation. Finder lanes use fast tier, high-risk verification uses deep tier.",
  examples: [
    { label: "normal dependency scan", args: { depth: "normal", paths: ["."] } },
    { label: "unused and undeclared deps", args: { depth: "quick", categories: ["unused", "undeclared"], paths: ["."] } },
  ],
  argsSchema: {
    type: ["object", "string", "null"],
    properties: {
      paths: { type: "array", items: { type: "string" } },
      exclude: { type: "array", items: { type: "string" } },
      depth: { type: "string", enum: ["quick", "normal", "thorough"] },
      categories: { type: "array", items: { type: "string", enum: ["outdated", "cve", "unused", "undeclared", "license", "version-conflict", "deprecated"] } },
      maxReturnFindings: { type: "integer", minimum: 1 },
      recon: { type: ["object", "string"] },
    },
  },
};

// ---- suite identity ----
const DOMAIN = "deps";
const SCHEMA_VERSION = 1;

// args may arrive as an object (workflow_run args) or, defensively, a JSON string.
let RT = args;
if (typeof RT === "string") { try { RT = RT.trim() ? JSON.parse(RT) : {}; } catch (error) { throw new Error(`Invalid repo-deps runtime args JSON: ${error.message}`); } }
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

const ALL_CATEGORIES = ["outdated", "cve", "unused", "undeclared", "license", "version-conflict", "deprecated"];
const requestedCategories = Array.isArray(RT.categories) ? RT.categories.filter((c) => typeof c === "string" && c.trim()) : [];
const categories = requestedCategories.length > 0 ? requestedCategories.filter((c) => ALL_CATEGORIES.includes(c)) : ALL_CATEGORIES;
if (requestedCategories.length > 0 && categories.length === 0) {
  throw new Error(`No valid repo-deps categories supplied. Valid categories: ${ALL_CATEGORIES.join(", ")}`);
}

// Categories where a wrong "remove/declare this" is most damaging — always verified
// in 'normal', and (with everything else) in 'thorough'. quick verifies nothing.
const HIGH_RISK = ["unused", "undeclared"];

// DOMAIN-SPECIFIC SCOPE (iui1.3): deps ALWAYS inspects manifests AND lockfiles — lockfiles carry the
// pinned/transitive version truth that manifests lack. *.lock is intentionally NOT in this domain's
// default exclude. The shared meta exclude no longer drops *.lock globally either; lockfile inclusion
// is a per-domain decision and for deps it is a hard include. (User-supplied excludes still win and
// are disclosed as a coverage gap if they remove a lockfile/manifest from scope.)
const DOMAIN_SCOPE_INCLUDES = "In scope for deps (always inspect): manifests (package.json, requirements.txt/pyproject.toml, go.mod, Cargo.toml, Gemfile, pom.xml, composer.json) AND lockfiles (yarn.lock, package-lock.json, pnpm-lock.yaml, composer.lock, Gemfile.lock, Podfile.lock, Cargo.lock, go.sum) — derive pinned/transitive versions and findings from these.";
const scope = `Scope: paths = ${JSON.stringify(paths)}. Exclude (do not scan/report): ${JSON.stringify(exclude)}. ${DOMAIN_SCOPE_INCLUDES}`;

// DEPENDENCY INSPECTION POLICY — the defining constraint of this leaf.
// Injected into every finder and the recon lane. Note: it deliberately uses the
// generic words "installs"/"mutation"/"network" rather than literal command tokens
// like "npm install" so policy checks can cleanly prove no positive mutation command
// is ever instructed.
const DEPS_POLICY = [
  "DEPENDENCY INSPECTION POLICY (read-only):",
  "- Inspect manifests and lockfiles ONLY. Derive versions and findings from local files.",
  "- Never run installs, upgrades, or any package-manager mutation.",
  "- Never fetch from the network or any advisory API/database.",
  "- Never run audit/outdated tooling that mutates state or reaches the network.",
  "- For CVE/outdated claims not provable from local files, set REDUCED confidence and note the gap.",
].join("\n");

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
const emptyUpgradePlan = { safeBatch: [], breakingChanges: [] };

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
// severity excludes "critical": deps is a NON-SECURITY domain (contract §6).
const FINDINGS_SCHEMA = {
  type: "object", additionalProperties: false,
  properties: {
    findings: {
      type: "array",
      items: {
        type: "object", additionalProperties: false,
        properties: {
          category: { type: "string" },
          package: { type: "string" },
          file: { type: "string", description: "manifest/lockfile path" },
          line: { type: "integer" },
          severity: { type: "string", enum: ["high", "medium", "low"] },
          description: { type: "string" },
          currentVersion: { type: "string" },
          targetVersion: { type: "string", description: "recommended version, or empty string if none" },
          breaking: { type: "boolean", description: "is the recommended upgrade a breaking (major) change" },
          cve: { type: "array", items: { type: "string" } },
          advisory: { type: "string" },
          proposedChange: { type: "string" },
          confidence: { type: "integer" },
          effort: { type: "string", enum: ["small", "medium", "large"] },
          docImpact: { type: "string" },
        },
        required: ["category", "package", "file", "line", "severity", "description", "currentVersion", "targetVersion", "breaking", "cve", "advisory", "proposedChange", "confidence", "effort", "docImpact"],
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

// ---- lenses (read-only inspection; no command execution) ----
const LENS = {
  "outdated": "Outdated packages: compare the versions DECLARED in manifests/lockfiles against your knowledge of newer releases. Classify each bump as patch/minor/major and set breaking=true for majors. Derive current/target versions from the local files only.",
  "cve": "Known vulnerabilities: read the pinned versions in the lockfile/manifest and flag packages fixed at versions you know to be vulnerable from advisories in your training data. Do NOT fetch advisory databases. For any CVE claim you cannot confirm from local files alone, set REDUCED confidence and note the gap in the description.",
  "unused": "Declared dependencies never imported/used anywhere in the code. Cross-check the manifest against actual imports/requires. Be CONSERVATIVE — check build-only, type-only, plugin, config-only, and CLI-invoked deps before flagging. A wrong removal breaks the build.",
  "undeclared": "Imported/required packages that are NOT declared in the manifest (relying on transitive resolution). Flag each, citing the importing file.",
  "license": "License risk: copyleft (GPL/AGPL) or unknown/missing licenses among dependencies that may conflict with the project's own license. Read license metadata/files locally only.",
  "version-conflict": "Duplicate or conflicting versions of the same package across the tree; peer-dependency conflicts; lockfile drift vs manifest. Cite both manifest and lockfile evidence.",
  "deprecated": "Dependencies marked deprecated by their maintainers, or unmaintained (no releases in a long time, archived repos). Note the deprecation source if visible in local metadata.",
};

function finderPrompt(cat, recon, roundNote) {
  return [
    `You are the "${cat}" dependency analyst for a REPORT-ONLY audit. Do NOT modify any files.`,
    DEPS_POLICY,
    scope,
    `Repo profile (recon):\n${formatRecon(recon)}`,
    `Your track: ${LENS[cat]}`,
    roundNote || "",
    `For EVERY finding set category to exactly "${cat}". Fill package, currentVersion, targetVersion (empty string if none), breaking, cve (list, possibly empty), advisory, proposedChange, confidence, effort, docImpact (empty string if none).`,
    `Set confidence honestly (0-100): high only when the claim is provable from local files. Quality over quantity — a wrong finding is worse than a missed one.`,
    `Return findings via the structured output.`,
  ].filter(Boolean).join("\n\n");
}

function skepticPrompt(f) {
  return [
    "You are a skeptic. Your job is to REFUTE the dependency finding below — prove it is wrong or a false positive.",
    DEPS_POLICY,
    scope,
    `Finding (${f.category}) for package "${f.package}" in ${f.file}:${f.line}:`,
    `Description: ${f.description}`,
    `Proposed change: ${f.proposedChange}`,
    "Investigate with your read/search tools. For 'unused': hunt exhaustively for ANY usage including dynamic imports, config refs, build/CLI usage, type-only imports. For upgrades: confirm whether the recommended target is genuinely breaking. For CVEs: confirm the pinned version actually falls in the vulnerable range.",
    "Set refuted=true if the finding is wrong. Default to refuted=true when genuinely uncertain.",
  ].join("\n\n");
}

// ---- 1. Recon (use injected recon if present, else profile once) ----
await phase("recon");
const recon = RT.recon
  ? RT.recon
  : await agent(
    ["Profile this repository's dependency setup for a READ-ONLY audit.", scope,
      DEPS_POLICY,
      "Report: languages/frameworks; package managers; manifest files (package.json, pyproject.toml, requirements.txt, go.mod, Cargo.toml, Gemfile, etc.) and their paths; lockfiles present; the project's own license.",
      "Also note: entry points, test layout, build tooling, concurrency model, error-handling conventions, external resources.",
      "Explore with your read/search tools only. Return the structured recon fields."].join("\n\n"),
    { label: "recon", schema: RECON_SCHEMA, tier: TIER_RECON, onFailure: "returnNull" },
  );

// ---- 2. Find + dedup ----
function dedup(findings) {
  const seen = new Set(); const out = [];
  for (const f of findings) {
    if (!f) continue;
    const key = `${f.category}::${(f.package || "").trim()}::${(f.file || "").trim()}`;
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
await log(`Round 1: ${findings.length} dependency findings across ${categories.length} tracks`);

if (depth === "thorough") {
  const known = findings.map((f) => `- ${f.category} ${f.package} — ${f.description}`).join("\n");
  const round2 = await findRound(`SECOND pass. Already found below — find only NEW issues, do not repeat:\n${known}`);
  findings = dedup(findings.concat(round2));
  await log(`After round 2: ${findings.length} findings`);
}

// positional id (in-run reference) + stable content fingerprint (cross-run dedupe key)
findings = findings.map((f, i) => ({ ...f, id: `${f.category}-${i + 1}`, fingerprint: fingerprintOf(f) }));

if (findings.length === 0) {
  return envelope("empty", { summary: "Dependencies look healthy.", counts: emptyCounts, findings: [], truncatedFindings: false, reportMarkdown: null, upgradePlan: emptyUpgradePlan });
}

// ---- 3. Verify (high-FP profile on the "remove/declare this" categories) ----
// quick: verify nothing. normal: verify HIGH_RISK categories (unused, undeclared). thorough: verify ALL.
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
  return envelope("empty", { summary: "No dependency issues survived verification.", counts: emptyCounts, findings: [], truncatedFindings: false, reportMarkdown: null, upgradePlan: emptyUpgradePlan });
}

// ---- 4. Synthesize (PURE JS — dedup, rank, build upgradePlan, render; the host persists the returned object) ----
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

// Per-domain carve-out (SUITE-CONTRACT § Per-domain carve-outs; contract §2):
// upgradePlan sequences the surviving findings into a non-breaking safe batch and a
// breaking-changes list. Built in PURE JS (the Claude source delegated this to a model
// lane; OpenCode synthesis is model-free). safeBatch = non-breaking bumps safe to apply
// together; breakingChanges = major/breaking upgrades each with a one-line migration note.
function buildUpgradePlan(rows) {
  const safeBatch = [];
  const breakingChanges = [];
  for (const f of rows) {
    const cur = f.currentVersion || "?";
    const tgt = f.targetVersion || "latest";
    const label = `${f.package}: ${cur} -> ${tgt}`;
    if (f.breaking) {
      const note = f.advisory || f.description || "breaking upgrade; migrate before applying";
      breakingChanges.push(`${label} — ${note}`);
    } else {
      safeBatch.push(label);
    }
  }
  return { safeBatch, breakingChanges };
}
const upgradePlan = buildUpgradePlan(ranked);

function mdCell(s) { return String(s == null ? "" : s).replace(/\|/g, "\\|").replace(/\n+/g, " "); }
function renderMarkdown(rows, c, plan) {
  const lines = [];
  lines.push(`# Dependency Audit Report (${DOMAIN})`, "");
  lines.push("> Report-only. No files were modified, nothing was installed or upgraded.", "");
  lines.push("## Summary", `- Total: ${c.total} (high: ${c.high}, medium: ${c.medium}, low: ${c.low})`, "");
  lines.push("## Upgrade plan", "");
  lines.push("### Safe batch (non-breaking)");
  if (plan.safeBatch.length) for (const s of plan.safeBatch) lines.push(`- ${mdCell(s)}`);
  else lines.push("- (none)");
  lines.push("### Breaking changes");
  if (plan.breakingChanges.length) for (const s of plan.breakingChanges) lines.push(`- ${mdCell(s)}`);
  else lines.push("- (none)");
  lines.push("");
  lines.push("## Ranked findings", "");
  lines.push("| Rank | Category | Package | Severity | Current -> Target | Breaking | CVE |");
  lines.push("| ---- | -------- | ------- | -------- | ----------------- | -------- | --- |");
  for (const f of rows) {
    lines.push(`| ${f.rank} | ${mdCell(f.category)} | ${mdCell(f.package)} | ${mdCell(f.severity)} | ${mdCell(f.currentVersion)} -> ${mdCell(f.targetVersion)} | ${f.breaking ? "yes" : "no"} | ${mdCell((f.cve || []).join(", "))} |`);
  }
  lines.push("", "## Detail");
  for (const f of rows) {
    lines.push("", `### ${f.rank}. ${mdCell(f.category)} — ${mdCell(f.package)} (${f.severity}, conf ${f.confidence})`);
    lines.push(`- **What:** ${f.description}`);
    lines.push(`- **Manifest:** ${mdCell(f.file)}:${f.line || 0}`);
    lines.push(`- **Current -> target:** ${f.currentVersion || "?"} -> ${f.targetVersion || "(none)"}`);
    lines.push(`- **Breaking:** ${f.breaking ? "yes" : "no"}`);
    if (f.advisory) lines.push(`- **Advisory:** ${f.advisory}`);
    if (f.cve && f.cve.length) lines.push(`- **CVE:** ${(f.cve || []).join(", ")}`);
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
  let reportMarkdown = renderMarkdown(ranked, counts, upgradePlan);
  const sizeOf = () => jsonUtf8ByteLength(envelope(status, { summary, counts, findings: returned, truncatedFindings: truncated, reportMarkdown, upgradePlan }));
  if (sizeOf() > LIMIT) reportMarkdown = null;
  while (sizeOf() > LIMIT && returned.length > 10) {
    returned = returned.slice(0, Math.ceil(returned.length / 2));
    truncated = true;
  }
  return envelope(status, { summary, counts, findings: returned, truncatedFindings: truncated, reportMarkdown, upgradePlan });
}

const summary = `Found ${counts.total} dependency finding(s): ${counts.high} high, ${counts.medium} medium, ${counts.low} low. Report-only — nothing installed or upgraded.`;
return fitWithinBudget("ok", summary);
