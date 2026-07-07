// LEAF workflow — repo-security-audit engine (OpenCode port).
//
// Conforms to docs/repo-review-leaf-contract.md (the shared leaf contract).
// Canonical exemplar: workflows/repo-bughunt.js + tests/repo-bughunt.test.mjs.
// Port lineage (DOMAIN LOGIC only): internal Claude workflow source,
// adapted to the OpenCode QuickJS guest: no fs/Bash/git, tier-based models
// (fast/deep) instead of sonnet/opus, PURE-JS synthesis (no model) instead of an
// opus synthesizer agent, onFailure:"returnNull", arity-1 parallel thunks for
// concurrency, and reportMarkdown returned in the envelope (the guest cannot
// write files, so reportPath is always null — the command wrapper persists the
// report).
//
// Domain stance: this is the ONLY leaf allowed to populate the `critical`
// severity tier (counts.critical is the REAL count of critical findings).
// Security finds credential/secret RISKS by LOCATION without ever surfacing raw
// secret values; the SAFETY directive below forbids embedding secret values and
// forbids reading credential files. In-guest value masking of model prose is
// applied during synthesis (maskFindingSecrets; docs/repo-review-leaf-contract.md
// §15) so no raw secret enters the returned envelope/report; the prompt layer and
// the guest sandbox (no fs) are defense-in-depth.
export const meta = {
  name: "repo-security-audit",
  description: "Report-only whole-repo security audit (injection, authz, secrets, unsafe deserialization, SSRF, crypto misuse, input validation, dependency CVEs, insecure defaults, sensitive logging) with adversarial exploitability verification. Finds credential/secret risks by location without surfacing secret values. Returns ranked structured findings; the workflow writes no files.",
  profile: "read-only-review",
  maxAgents: 4096,
  concurrency: 16,
  phases: ["recon", "find", "verify", "synthesize"],
  category: "repo-review-leaf",
  notes: "Read-only report-only security leaf. Finds secret risks by location without surfacing raw values. Finder lanes use fast tier, exploitability verification uses deep tier.",
  examples: [
    { label: "normal security scan", args: { depth: "normal", paths: ["src"] } },
    { label: "focused secrets/authz scan", args: { depth: "quick", categories: ["secrets", "authz"], paths: ["src"] } },
  ],
  argsSchema: {
    type: ["object", "string", "null"],
    properties: {
      paths: { type: "array", items: { type: "string" } },
      exclude: { type: "array", items: { type: "string" } },
      depth: { type: "string", enum: ["quick", "normal", "thorough"] },
      categories: { type: "array", items: { type: "string", enum: ["injection", "authz", "secrets", "unsafe-deserialization", "ssrf", "crypto-misuse", "input-validation", "dep-cve", "insecure-default", "sensitive-logging"] } },
      maxReturnFindings: { type: "integer", minimum: 1 },
      recon: { type: ["object", "string"] },
    },
  },
};

// ---- suite identity ----
const DOMAIN = "security";
const SCHEMA_VERSION = 1;

// args may arrive as an object (workflow_run args) or, defensively, a JSON string.
let RT = args;
if (typeof RT === "string") { try { RT = RT.trim() ? JSON.parse(RT) : {}; } catch (error) { throw new Error(`Invalid repo-security-audit runtime args JSON: ${error.message}`); } }
if (!RT || typeof RT !== "object" || Array.isArray(RT)) RT = {};

const paths = Array.isArray(RT.paths) && RT.paths.length ? RT.paths : ["."];
const exclude = Array.isArray(RT.exclude) ? RT.exclude : ["node_modules", "dist", "build", ".git", "vendor", "target", "*.min.*", "*.map"];
const depth = ["quick", "normal", "thorough"].includes(RT.depth) ? RT.depth : "thorough";

// Model selection is intent-based: lanes declare a tier; the kernel resolves tier -> concrete model from
// run.modelTiers (set by the planning agent), falling back to the session-inherited default.
// recon + finders = bulk work (fast); skeptics = subtle exploitability correctness (deep); synth = pure JS.
const TIER_RECON = "fast";
const TIER_FINDER = "fast";
const TIER_VERIFY = "deep";

const MAX_RETURN_FINDINGS = Number.isInteger(RT.maxReturnFindings) && RT.maxReturnFindings > 0 ? RT.maxReturnFindings : 1000000;

const ALL_CATEGORIES = [
  "injection", "authz", "secrets", "unsafe-deserialization", "ssrf",
  "crypto-misuse", "input-validation", "dep-cve", "insecure-default", "sensitive-logging",
];
const requestedCategories = Array.isArray(RT.categories) ? RT.categories.filter((c) => typeof c === "string" && c.trim()) : [];
const categories = requestedCategories.length > 0 ? requestedCategories.filter((c) => ALL_CATEGORIES.includes(c)) : ALL_CATEGORIES;
if (requestedCategories.length > 0 && categories.length === 0) {
  throw new Error(`No valid repo-security-audit categories supplied. Valid categories: ${ALL_CATEGORIES.join(", ")}`);
}

// DOMAIN-SPECIFIC SCOPE (iui1.3): security inspects the highest-signal config/CI/infra/auth surface
// in addition to source. *.lock is intentionally NOT in this domain's default exclude (lockfiles pin
// vulnerable transitive versions). The shared meta exclude no longer drops *.lock globally; config/CI/
// Docker/deploy files are a hard include for security because that is where insecure defaults, leaked
// secrets, and over-broad permissions most often live.
const DOMAIN_SCOPE_INCLUDES = "In scope for security (always inspect): CI pipelines (.github/workflows, .gitlab-ci.yml, .circleci), Docker/container files (Dockerfile, docker-compose.yml), deploy/infra manifests (k8s, terraform, serverless), non-secret application config, and auth/session code (token handling, session middleware, RBAC) — these carry the highest security signal alongside lockfiles (pin vulnerable transitive versions). Secret files themselves remain OFF-LIMITS for reading (report by location only, never paste raw values).";
const scope = `Scope: paths = ${JSON.stringify(paths)}. Exclude (do not scan/report): ${JSON.stringify(exclude)}. ${DOMAIN_SCOPE_INCLUDES}`;

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

// ---- coverage disclosure ----
// Security runs NO dynamic tooling in-guest (read-only-review profile, no shell):
// no automated vulnerability scanners, no dynamic analysis, no penetration tests.
// Dependency CVEs reflect reviewer knowledge of manifests/lockfiles and may miss
// unpublished advisories. shellCoverage:"none" + a stated limitation (contract §2
// optional extension fields; population for this domain is directed by its bead).
const SHELL_COVERAGE = "none";
const COVERAGE_LIMITATIONS =
  "Static read-only review only. No automated vulnerability scanners (npm audit, pip-audit, Semgrep, etc.), dynamic analysis, or penetration tests were run in-guest (read-only-review profile, no shell). Dependency CVEs reflect reviewer knowledge of manifests/lockfiles and may miss unpublished advisories.";

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

// ---- SAFETY directive (secret-value containment; prompt-layer enforcement) ----
// Security detects credential/secret RISKS by LOCATION only. Findings must never
// embed raw secret values, and lanes must not read credential files. (The guest
// sandbox also structurally forbids fs, so this is defense-in-depth at the prompt
// layer; in-guest value masking of model prose is applied during synthesis.)
const SAFETY = [
  "SAFETY (security domain): detect credential/secret RISKS by LOCATION only.",
  "NEVER paste or embed raw secret values (API keys, passwords, tokens, private keys, connection strings) in any field of a finding — use file:line plus a REDACTED placeholder.",
  "Credential files (.env, ~/.ssh/*, *.pem, *.key, secrets.*) are OFF-LIMITS for reading: reference their path, never their contents.",
].join("\n");

// ---- secret-value containment helper (in-guest masking; contract §15) ----
// The kernel also masks credential-shaped string values at durable/display boundaries, but
// security findings must not rely on a downstream scrubber. Leaves mask detected secret
// patterns here, during synthesis, BEFORE ranking/rendering and before the envelope is
// returned. Replacement is non-reversible: a length-aware short prefix + short suffix with
// the identifying middle removed, so the revealed portion never exceeds a small fraction of
// the total length (short secrets are fully redacted). This keeps low-entropy tokens — e.g. a
// 10-char AKIA match or an sk-/pk-/ghp- token — from leaking most of their entropy past the mask.
// <suite:maskSecrets>
function maskSecret(token) {
  const s = String(token);
  if (s.length <= 20) return "***";
  const keep = Math.min(4, Math.floor(s.length * 0.15));
  return `${s.slice(0, keep)}***${s.slice(-keep)}`;
}
function maskSecretsInText(s) {
  if (typeof s !== "string" || !s) return s;
  let out = s;
  // Well-known credential shapes.
  const patterns = [
    /\bAKIA[A-Za-z0-9_-]{6,}\b/g, // AWS access key id (and AKIA-prefixed tokens)
    /\b(sk|pk|ghp|gho|github_pat|xox[baprs])[-_][-_A-Za-z0-9]{8,}\b/g, // provider tokens
    /\b-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g, // PEM private keys
  ];
  for (const re of patterns) out = out.replace(re, (m) => maskSecret(m));
  // Generic key=value / token: value assignments.
  out = out.replace(
    /\b(api[_-]?key|access[_-]?token|refresh[_-]?token|secret|password|passwd|authorization|auth[_-]?token|token)\b\s*[:=]\s*["']?[^\s"'`,;]{8,}/gi,
    (m) => maskSecret(m),
  );
  return out;
}
function maskFindingSecrets(f) {
  if (!f || typeof f !== "object") return f;
  const mask = (v) => (typeof v === "string" ? maskSecretsInText(v) : v);
  return { ...f, description: mask(f.description), attackVector: mask(f.attackVector), proposedChange: mask(f.proposedChange), docImpact: mask(f.docImpact) };
}
// </suite:maskSecrets>

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
          // security is the ONE domain allowed to emit critical severity (4-tier real).
          severity: { type: "string", enum: ["critical", "high", "medium", "low"] },
          description: { type: "string" },
          cwe: { type: "string" },
          attackVector: { type: "string" },
          exploitability: { type: "string", enum: ["high", "medium", "low"] },
          proposedChange: { type: "string" },
          confidence: { type: "integer" },
          effort: { type: "string", enum: ["small", "medium", "large"] },
          docImpact: { type: "string" },
        },
        required: ["category", "file", "line", "severity", "description", "cwe", "attackVector", "exploitability", "proposedChange", "confidence", "effort", "docImpact"],
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

// ---- lenses (one parallel finder per vuln class) ----
const LENS = {
  "injection": "Injection: SQL/NoSQL, OS command, path traversal, template/SSTI, LDAP, XPath. Trace untrusted input to a sink without proper parameterization/escaping.",
  "authz": "Authn/authz flaws: missing access checks, IDOR, broken object-level/function-level authorization, privilege escalation, trusting client-supplied identity/role.",
  "secrets": "Secrets in code: hardcoded API keys, passwords, tokens, private keys, connection strings; secrets committed to config; secrets in logs. Report the RISK by location; never paste the value.",
  "unsafe-deserialization": "Unsafe deserialization / dynamic execution: eval, pickle, yaml.load, native deserialization of untrusted data, prototype pollution, unsafe reflection.",
  "ssrf": "SSRF and unsafe outbound requests: user-controlled URLs fetched server-side, missing allowlist, metadata-endpoint exposure, open redirects.",
  "crypto-misuse": "Crypto misuse: weak/broken algorithms (MD5/SHA1 for security, ECB), hardcoded IVs/keys, predictable randomness for security, missing TLS verification, improper password hashing.",
  "input-validation": "Missing/weak input validation & output encoding: XSS (stored/reflected/DOM), missing size/type bounds, mass assignment, unsafe file upload.",
  "dep-cve": "Dependency CVEs: known-vulnerable package versions found in manifests/lockfiles. Cross-check package versions against known advisories from your knowledge (an automated audit tool is NOT available in this read-only profile — do not attempt to run one).",
  "insecure-default": "Insecure defaults/config: debug mode on, permissive CORS, missing security headers, default credentials, overly broad permissions, verbose error exposure.",
  "sensitive-logging": "Sensitive data exposure: PII/secrets/tokens written to logs, error responses leaking internals, sensitive data in URLs/caches. Report the exposure by location; do not surface the logged value.",
};

function finderPrompt(cat, recon, roundNote) {
  return [
    `You are the "${cat}" security finder. REPORT-ONLY — do NOT modify files.`,
    scope,
    SAFETY,
    `Repo profile (recon):\n${formatRecon(recon)}`,
    `Your lens: ${LENS[cat]}`,
    roundNote || "",
    `For EVERY finding set category to exactly "${cat}". Fill cwe (CWE id or empty), attackVector (how an attacker reaches it), and exploitability. Trace from an untrusted source to the dangerous sink — only flag reachable issues. A false alarm wastes triage; be precise.`,
    `Return findings via the structured output.`,
  ].filter(Boolean).join("\n\n");
}

function skepticPrompt(f) {
  return [
    "You are a skeptic security reviewer. Try to REFUTE the finding — prove it is NOT exploitable.",
    SAFETY,
    scope,
    `Finding (${f.category}) at ${f.file}:${f.line}: ${f.description}`,
    `Attack vector: ${f.attackVector}`,
    "Check: is the source actually untrusted/attacker-controlled? is it sanitized/validated/parameterized upstream? is the sink reachable in practice? is there a mitigating control?",
    "Set refuted=true if it is not a real, reachable vulnerability. Default to refuted=true when genuinely uncertain.",
  ].join("\n\n");
}

// ---- 1. Recon (use injected recon if present, else profile once) ----
await phase("recon");
const recon = RT.recon
  ? RT.recon
  : await agent(
    ["Profile this repository for a security audit.", scope,
      "Report: languages/frameworks; entry points & trust boundaries (HTTP handlers, CLIs, message consumers); where untrusted input enters; auth/session model; data stores & external calls; how secrets are managed (approach only — never surface secret values); dependency manifests/lockfiles.",
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
await log(`Round 1: ${findings.length} candidate vulnerabilities across ${categories.length} lenses`);

if (depth === "thorough") {
  const known = findings.map((f) => `- ${f.category} ${f.file}:${f.line} — ${f.description}`).join("\n");
  const round2 = await findRound(`SECOND pass. Already found below — find only NEW issues, do not repeat:\n${known}`);
  findings = dedup(findings.concat(round2));
  await log(`After round 2: ${findings.length} candidates`);
}

// positional id (in-run reference) + stable content fingerprint (cross-run dedupe key)
findings = findings.map((f, i) => ({ ...f, id: `${f.category}-${i + 1}`, fingerprint: fingerprintOf(f) }));

if (findings.length === 0) {
  return envelope("empty", { summary: "No vulnerabilities found.", counts: emptyCounts, findings: [], truncatedFindings: false, reportMarkdown: null, shellCoverage: SHELL_COVERAGE, coverageLimitations: COVERAGE_LIMITATIONS });
}

// ---- 3. Verify (high-FP profile) ----
// quick: verify critical+high only, 1 skeptic. normal: verify ALL, 1 skeptic.
// thorough: verify ALL, 3-skeptic majority (keep unless >=2 refute).
let toVerify, votes;
if (depth === "quick") { toVerify = findings.filter((f) => f.severity === "critical" || f.severity === "high"); votes = 1; }
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
  await log(`Verified: ${survivors.length}/${toVerify.length} survived; ${verified.length} total`);
}

if (verified.length === 0) {
  return envelope("empty", { summary: "No vulnerabilities survived verification.", counts: emptyCounts, findings: [], truncatedFindings: false, reportMarkdown: null, shellCoverage: SHELL_COVERAGE, coverageLimitations: COVERAGE_LIMITATIONS });
}

// ---- 4. Synthesize (PURE JS — dedup, rank, render; the host persists the returned object) ----
await phase("synthesize");
// Secret-value containment (docs/repo-review-leaf-contract.md §15): mask credential values
// embedded in free-text prose (description/attackVector/proposedChange) BEFORE ranking and
// rendering reportMarkdown. No raw secret should enter the returned envelope or the report.
verified = verified.map(maskFindingSecrets);
// Security ranks by severity weighted by exploitability and confidence (port of the
// Claude synthesizer's intent; here it is pure JS, never an agent).
const SEVW = { critical: 4, high: 3, medium: 2, low: 1 };
const EXPW = { high: 1.15, medium: 1.0, low: 0.85 };
const EFFD = { small: 1, medium: 0.8, large: 0.6 };
function score(f) { return (SEVW[f.severity] || 1) * (EXPW[f.exploitability] || 1) * ((f.confidence || 0) / 100) * (EFFD[f.effort] || 0.8); }

const ranked = verified.map((f) => ({ ...f })).sort((a, b) => score(b) - score(a));
ranked.forEach((f, i) => { f.rank = i + 1; });

// counts are NORMALIZED from the actual surviving findings — never trusted from an
// agent. security is the one domain that populates the critical tier for real.
const counts = {
  total: ranked.length,
  critical: ranked.filter((f) => f.severity === "critical").length,
  high: ranked.filter((f) => f.severity === "high").length,
  medium: ranked.filter((f) => f.severity === "medium").length,
  low: ranked.filter((f) => f.severity === "low").length,
};

function mdCell(s) { return String(s == null ? "" : s).replace(/\|/g, "\\|").replace(/\n+/g, " "); }
function renderMarkdown(rows, c) {
  const lines = [];
  lines.push(`# Security Audit Report (${DOMAIN})`, "");
  lines.push("> Report-only. No files were modified and nothing was applied.", "");
  lines.push("## Summary", `- Total: ${c.total} (critical: ${c.critical}, high: ${c.high}, medium: ${c.medium}, low: ${c.low})`, "");
  lines.push("## Ranked findings", "");
  lines.push("| Rank | Category | Severity | Exploitability | CWE | Confidence | Location | Description |");
  lines.push("| ---- | -------- | -------- | -------------- | --- | ---------- | -------- | ----------- |");
  for (const f of rows) {
    lines.push(`| ${f.rank} | ${mdCell(f.category)} | ${mdCell(f.severity)} | ${mdCell(f.exploitability)} | ${mdCell(f.cwe)} | ${f.confidence} | ${mdCell(f.file)}:${f.line || 0} | ${mdCell(f.description).slice(0, 120)} |`);
  }
  lines.push("", "## Detail");
  for (const f of rows) {
    lines.push("", `### ${f.rank}. ${mdCell(f.category)} — ${mdCell(f.file)}:${f.line || 0} (${f.severity}, exploitability ${f.exploitability}, conf ${f.confidence})`);
    lines.push(`- **What:** ${f.description}`);
    if (f.cwe) lines.push(`- **CWE:** ${f.cwe}`);
    lines.push(`- **Attack vector:** ${f.attackVector}`);
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

const summary = `Found ${counts.total} vulnerability(s): ${counts.critical} critical, ${counts.high} high, ${counts.medium} medium, ${counts.low} low. Report-only — nothing applied.`;
return fitWithinBudget("ok", summary);
