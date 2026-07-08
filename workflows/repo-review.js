// META orchestrator workflow — /repo-review. Runs the eight repo-* LEAF engines via
// static-literal workflow() calls (one nesting level — legal because each engine is a
// leaf that never nests), computes shared recon ONCE, then normalizes + conservatively
// merges + ranks their findings into ONE cross-domain report. Report-only.
//
// Contract: docs/repo-review-leaf-contract.md §14 (Meta-to-leaf arg contract).
// Recon is computed ONCE and the SAME recon+paths+exclude+depth object reference is
// injected into every literal one-level workflow("repo-X", leafArgs) call, so all eight
// domains analyze one coherent file inventory and cross-domain dedupe stays consistent.
//
// Authority: profile "read-only-review" (authority-policy.js:11-13; readOnly:true). The meta NEVER
// calls materialize, drain, workflow_apply, git, or Beads mutation, and NEVER writes a
// file — the QuickJS guest cannot. reportPath is always null; the command wrapper
// persists the report (engine-vs-wrapper reversal, contract §1).
//
// Budget: nested workflow() lanes run INSIDE this run and share its maxAgents/concurrency;
// a nested leaf's own declared maxAgents/concurrency is IGNORED at runtime. Parent
// maxAgents=100000 intentionally over-provisions (effectively unlimited) one recon lane, the coverage auditor, plus
// the cumulative cold-run fan-out of all eight leaves under batched parallel()
// orchestration (≈50 finder lanes for an empty run, ≈150+ for a thorough-depth exhaustive
// run with skeptics, and potentially far more in large repos). concurrency=16 is the
// kernel's hard cap and bounds peak concurrent child sessions across the whole tree. An
// exhaustive thorough run may still budget-stop gracefully if a caller overrides a smaller
// parent budget: a stopped lane returns null (onFailure-equivalent try/catch), is dropped
// by .filter(Boolean), and surfaces as partial coverage + a materialization blocker rather
// than a crash.
//
// EXHAUSTIVE-BY-DEFAULT (rrev.27): empty args default to mode:"exhaustive", which selects
// depth:"thorough", a higher maxReturnFindings, and a coverage-auditor lane. Pass
// mode:"bounded" for the legacy normal-depth behavior. The read-only boundary is unchanged:
// the meta NEVER mutates Beads, applies diffs, or writes files. A separate, explicitly-
// approved review-materialize flow consumes the report ONLY when materializationReady is true.
export const meta = {
  name: "repo-review",
  description: "Comprehensive repo review meta: runs all eight repo-* domain engines (bughunt, security, test-gaps, cleanup, modernize, perf, complexity, deps) with ONE shared recon, then normalizes + conservatively merges + ranks findings cross-domain into a single report. Exhaustive by default (thorough depth + coverage auditor); report-only, nothing is applied.",
  profile: "read-only-review",
  maxAgents: 100000,
  concurrency: 16,
  phases: ["recon", "domains", "merge", "audit", "synthesize"],
  category: "repo-review-meta",
  notes: "Read-only whole-repo review. Defaults to EXHAUSTIVE (thorough depth, high maxReturnFindings, coverage auditor); pass mode:'bounded' for the legacy normal-depth pass. Emits materializationReady/materializationBlockers so a separately-approved materialize flow can refuse incomplete reports. Model tier labels (fast/deep) are lane INTENT only — the command maps both to the same deep model so no fast model is ever selected.",
  examples: [
    { label: "exhaustive full review (default)", args: { mode: "exhaustive", paths: ["src"] } },
    { label: "bounded legacy review", args: { mode: "bounded", depth: "normal", paths: ["src"] } },
    { label: "focused security and bugs (exhaustive)", args: { mode: "exhaustive", domains: ["bughunt", "security"], paths: ["src", "tests"], batchSize: 2 } },
  ],
  argsSchema: {
    type: ["object", "string", "null"],
    properties: {
      mode: { type: "string", enum: ["exhaustive", "bounded"] },
      paths: { type: "array", items: { type: "string" } },
      exclude: { type: "array", items: { type: "string" } },
      depth: { type: "string", enum: ["quick", "normal", "thorough"] },
      domains: { type: "array", items: { type: "string", enum: ["bughunt", "security", "test-gaps", "cleanup", "modernize", "perf", "complexity", "deps", "repo-bughunt", "repo-security-audit", "repo-test-gaps", "repo-cleanup", "repo-modernize", "repo-perf", "repo-complexity", "repo-deps"] } },
      batchSize: { type: "integer", minimum: 1 },
      maxReturnFindings: { type: "integer", minimum: 1 },
      maxDirs: { type: "integer", minimum: 1 },
      deepMode: { type: "string", enum: ["static", "audited-shell", "network-advisory"] },
    },
  },
};

// ---- suite identity ----
const DOMAIN = "repo-review";
const SCHEMA_VERSION = 1;

// args may arrive as an object (workflow_run args) or, defensively, a JSON string.
let RT = args;
if (typeof RT === "string") { try { RT = RT.trim() ? JSON.parse(RT) : {}; } catch (error) { throw new Error(`Invalid repo-review runtime args JSON: ${error.message}`); } }
if (!RT || typeof RT !== "object" || Array.isArray(RT)) RT = {};

// ---- args ----
const paths = Array.isArray(RT.paths) && RT.paths.length ? RT.paths : ["."];
const exclude = Array.isArray(RT.exclude) ? RT.exclude : ["node_modules", "dist", "build", ".git", "vendor", "target", "*.min.*", "*.map"];
// EXHAUSTIVE-BY-DEFAULT: empty args select exhaustive mode, which drives thorough depth and a
// high maxReturnFindings. mode:"bounded" preserves the legacy normal-depth behavior.
const mode = RT.mode === "bounded" ? "bounded" : "exhaustive";
const exhaustive = mode === "exhaustive";
const depth = ["quick", "normal", "thorough"].includes(RT.depth) ? RT.depth : (exhaustive ? "thorough" : "normal");
// batchSize bounds how many leaves run per parallel() batch (peak-concurrency control),
// mirroring the Claude meta. Positive integer only (0/neg would infinite-loop the batcher).
// Default = all active domains in ONE batch (scale: serialize the eight leaves into a single
// batched parallel() call rather than four batches of two).
const maxReturnFindings = Number.isInteger(RT.maxReturnFindings) && RT.maxReturnFindings > 0 ? RT.maxReturnFindings : 1000000;
// maxDirs (the complexity per-domain carve-out) is forwarded to repo-complexity so the meta's
// scale decision reaches the leaf instead of it silently clamping to a low local default.
const maxDirs = Number.isInteger(RT.maxDirs) && RT.maxDirs > 0 ? RT.maxDirs : 1000000;

// Domain filter: the eight leaf domains. Accept either the bare domain ("bughunt") or the
// leaf name ("repo-bughunt"); normalize by stripping a leading "repo-". Default = all eight.
const ALL_DOMAINS = ["bughunt", "security", "test-gaps", "cleanup", "modernize", "perf", "complexity", "deps"];
function normDomain(d) { return typeof d === "string" ? d.replace(/^repo-/, "").trim() : ""; }
const suppliedDomains = Array.isArray(RT.domains) && RT.domains.length ? RT.domains.map(normDomain) : [];
const requestedDomains = suppliedDomains.filter((d) => ALL_DOMAINS.includes(d));
// Reject unknown-only domains with a clear error instead of silently falling back to ALL_DOMAINS.
// A mix of known+unknown is tolerated (unknown ones are dropped); only an ALL-unknown request is fatal.
if (suppliedDomains.length && requestedDomains.length === 0) {
  throw new Error(`repo-review: all requested domains are unknown. Supplied: ${JSON.stringify(RT.domains)}. Known domains: ${JSON.stringify(ALL_DOMAINS)}.`);
}
const want = new Set(requestedDomains.length ? requestedDomains : ALL_DOMAINS);
const activeDomains = ALL_DOMAINS.filter((d) => want.has(d));
const batchSize = Number.isInteger(RT.batchSize) && RT.batchSize > 0 ? RT.batchSize : activeDomains.length;

const scope = `Scope: paths = ${JSON.stringify(paths)}. Exclude (do not scan/report): ${JSON.stringify(exclude)}.`;

// DEEP MODE (iui1.7): repo-review is static + read-only by default. audited-shell and
// network-advisory are OPTIONAL, explicitly opt-in deep modes that require a different
// authority profile (e.g. "inspect-with-shell") selected at the kernel/command level; this
// leaf never selects one itself. The QuickJS guest itself NEVER requests shell or network —
// it stays static. This field reports what was REQUESTED so the envelope + report disclose
// the (intentionally static) coverage limit.
const deepModeRequested = ["audited-shell", "network-advisory"].includes(RT.deepMode) ? RT.deepMode : "static";
const deepMode = {
  requested: deepModeRequested,
  active: "static",
  shellCoverage: "none",
  coverageLimitations: deepModeRequested === "static"
    ? "Static, read-only analysis (no shell/git-churn, no network advisory lookups). Optional audited-shell / network-advisory modes require a different authority profile selected at the kernel/command level."
    : `${deepModeRequested} requested but the review engine runs static in-guest; the deep mode requires a different authority profile selected at the kernel/command level.`,
};

// ---- standardized return envelope ----
function envelope(status, extra) {
  return { domain: DOMAIN, schemaVersion: SCHEMA_VERSION, status, abortReason: null, reportPath: null, ...extra };
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

// ---- 1. Shared recon (computed ONCE for all domains; or accept an injected args.recon) ----
await phase("recon");
// Deterministic file inventory + sharding (iui1.5): a bounded, sorted fs walk produces a real
// file manifest so coverage is NOT agent-discovered ("Explore with your tools"). Large repos are
// partitioned into shards (by source root, capped at shardSize files each); a shard ledger tracks
// coverage so a missed/failed shard blocks materialization. The QuickJS guest has no fs, so
// inventoryFiles is a kernel host op. inventoryFailed or any shardMissed is a materialization blocker.
let inventory = null;
try {
  inventory = await inventoryFiles({ paths, exclude, shardSize: 2000 });
} catch (e) {
  inventory = { ok: false, error: String((e && e.message) || e), manifest: null, shards: [], partial: false };
}
const inventoryReady = !!(inventory && inventory.ok);
const manifest = (inventory && inventory.manifest) || null;
const inventoryShards = (inventory && inventory.shards) || [];
// Shard ledger: one entry per shard. Status is finalized after the domain phase (a shard is
// "completed" when at least one domain leaf ran; "missed" when every domain failed so the shard
// received zero review coverage). A partial inventory (hit the file cap) leaves a coverage gap.
const shardLedger = inventoryShards.map((s) => ({ id: s.id, root: s.root, fileCount: s.fileCount, languages: s.languages, status: "expected" }));
if (inventory && inventory.ok) {
  await log(`Inventory: ${manifest.totalFiles} files, ${inventoryShards.length} shard(s) across ${manifest.sourceRoots.length} source root(s)${inventory.partial ? " (PARTIAL — hit file cap)" : ""}.`);
} else {
  await log(`WARNING: file inventory failed — ${inventory && inventory.error}. Coverage accounting degraded.`);
}
const manifestBrief = manifest
  ? `Deterministic file inventory (grounding, not a suggestion): ${manifest.totalFiles} files across ${manifest.sourceRoots.length} source root(s) (${manifest.sourceRoots.slice(0, 12).join(", ")}${manifest.sourceRoots.length > 12 ? ", ..." : ""}); languages: ${Object.entries(manifest.byLanguage).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}(${v})`).join(", ") || "none"}; file roles: ${Object.entries(manifest.byRole).map(([k, v]) => `${k}(${v})`).join(", ") || "none"}; sharded into ${inventoryShards.length} shard(s)${inventory.partial ? " (PARTIAL inventory — some files beyond the cap were not enumerated)" : ""}.`
  : "No deterministic file inventory available; profile from what you can observe.";

let recon;
if (RT.recon !== undefined && RT.recon !== null) {
  recon = RT.recon;
  await log("Using injected shared recon (args.recon present) — every leaf skips self-profiling.");
} else {
  recon = await agent(
    ["Profile this repository once for a comprehensive multi-domain review (bugs, security, test gaps, cleanliness, complexity, deps, modernization, performance). Return the structured recon fields.",
      scope,
      manifestBrief,
      "Report: languages/frameworks; package managers; entry points; test layout; build tooling; concurrency model; error-handling conventions; external resources (DB, files, network); and notes on anything relevant to reviewing this repo.",
      "Use the deterministic inventory above as the file-set ground truth; only explore further for semantics the file list cannot reveal."].join("\n\n"),
    { label: "recon", schema: RECON_SCHEMA, tier: "fast", onFailure: "returnNull" },
  );
  if (!recon || typeof recon !== "object") {
    await log("WARNING: shared recon returned null/invalid — each leaf will self-profile (~8x recon cost).");
  }
}

// ONE shared args object: the SAME reference is injected into every literal one-level
// workflow("repo-X", leafArgs) call (contract §14.2). Leaves skip self-profiling because
// recon is present. maxReturnFindings (effectively-unlimited ceiling) and maxDirs (the
// complexity per-domain carve-out) are forwarded so the meta's scale decisions reach every
// leaf instead of each leaf silently defaulting to a low local cap.
const leafArgs = { recon, paths, exclude, depth, maxReturnFindings, maxDirs };

// ---- 2. Run the eight leaf engines (static literals only, batched to bound peak concurrency) ----
// Each leaf is a LEAF (never nests), so this is one nesting level. workflow() does not take
// an onFailure option, so each literal call is wrapped in try/catch: a failed/budget-stopped
// leaf resolves to null and is dropped by .filter(Boolean) — it never aborts the meta.
async function runBughunt(a, w) { if (!w.has("bughunt")) return null; try { return await workflow("repo-bughunt", a); } catch (e) { return { domain: "bughunt", __error: String((e && e.message) || e) }; } }
async function runSecurity(a, w) { if (!w.has("security")) return null; try { return await workflow("repo-security-audit", a); } catch (e) { return { domain: "security", __error: String((e && e.message) || e) }; } }
async function runTestGaps(a, w) { if (!w.has("test-gaps")) return null; try { return await workflow("repo-test-gaps", a); } catch (e) { return { domain: "test-gaps", __error: String((e && e.message) || e) }; } }
async function runCleanup(a, w) { if (!w.has("cleanup")) return null; try { return await workflow("repo-cleanup", a); } catch (e) { return { domain: "cleanup", __error: String((e && e.message) || e) }; } }
async function runModernize(a, w) { if (!w.has("modernize")) return null; try { return await workflow("repo-modernize", a); } catch (e) { return { domain: "modernize", __error: String((e && e.message) || e) }; } }
async function runPerf(a, w) { if (!w.has("perf")) return null; try { return await workflow("repo-perf", a); } catch (e) { return { domain: "perf", __error: String((e && e.message) || e) }; } }
async function runComplexity(a, w) { if (!w.has("complexity")) return null; try { return await workflow("repo-complexity", a); } catch (e) { return { domain: "complexity", __error: String((e && e.message) || e) }; } }
async function runDeps(a, w) { if (!w.has("deps")) return null; try { return await workflow("repo-deps", a); } catch (e) { return { domain: "deps", __error: String((e && e.message) || e) }; } }

// Ordered runner list (one entry per static-literal leaf). Slicing this into batchSize
// groups keeps the workflow() call sites static literals while bounding peak concurrency.
const LEAF_RUNNERS = [
  runBughunt, runSecurity, runTestGaps, runCleanup, runModernize, runPerf, runComplexity, runDeps,
];

await phase("domains");
const rawCoverage = [];
for (let i = 0; i < LEAF_RUNNERS.length; i += batchSize) {
  const batchRunners = LEAF_RUNNERS.slice(i, i + batchSize);
  await log(`Domains batch ${Math.floor(i / batchSize) + 1}: ${batchRunners.map((fn) => fn.name.replace(/^run/, "").toLowerCase()).join(", ")}`);
  // arity-1 thunks (api) => ... so parallel() runs them CONCURRENTLY (zero-arg thunks fail unless { sequential: true } is explicit).
  const got = await parallel(batchRunners.map((fn) => (api) => fn(leafArgs, want)));
  for (const res of got) if (res) rawCoverage.push(res);
}

// Normalize raw leaf outputs into a DomainOutcome ledger (defensive against malformed leaves).
const EXTRAS_KEYS = ["staleDocs", "migrationPlan", "upgradePlan", "shellCoverage", "coverageLimitations"];
const leafOutcomes = [];
const domainExtras = {};
for (const env of rawCoverage) {
  if (!env || typeof env !== "object") continue;
  const dom = typeof env.domain === "string" ? env.domain.replace(/^repo-/, "") : "unknown";
  if (env.__error) {
    leafOutcomes.push({ domain: dom, status: "failed", counts: emptyCounts, error: env.__error });
    continue;
  }
  const status = env.status === "ok" || env.status === "empty" || env.status === "aborted" ? env.status : (Array.isArray(env.findings) && env.findings.length ? "ok" : "empty");
  const counts = (env.counts && typeof env.counts === "object") ? env.counts : emptyCounts;
  const outcome = { domain: dom, status, counts };
  // Propagate leaf-level truncation into the ledger so the materialization gate can refuse
  // a report whose per-domain finding set was size-capped (materializing from a truncated
  // leaf would silently drop issues).
  if (env.truncatedFindings === true) outcome.truncatedFindings = true;
  // Propagate per-leaf lane coverage telemetry (iui1.2). A dropped finder/verifier/scorer lane
  // means the leaf's coverage is degraded even if it returned status ok/empty; the meta surfaces
  // it as partialCoverage + a materialization blocker so a silent per-lane drop can never produce
  // a report that looks complete but is missing whole issue classes.
  if (env.laneCoverage && typeof env.laneCoverage === "object") {
    outcome.laneCoverage = env.laneCoverage;
    if (env.laneCoverage.dropped > 0) outcome.laneDropped = env.laneCoverage.dropped;
  }
  leafOutcomes.push(outcome);
  // Preserve per-domain top-level extras (carve-outs) surfaced, not merged.
  const extras = {};
  for (const k of EXTRAS_KEYS) if (env[k] !== undefined) extras[k] = env[k];
  if (Object.keys(extras).length) domainExtras[dom] = extras;
}

const ran = leafOutcomes.filter((o) => o.status === "ok" || o.status === "empty");
const failed = leafOutcomes.filter((o) => o.status === "failed");
await log(`Domains complete: ${ran.length} ran (ok/empty), ${failed.length} failed, of ${activeDomains.length} active.`);

// Finalize shard coverage (iui1.5): leaves run over the whole repo, so a shard is "completed"
// when at least one domain leaf produced a usable envelope. A shard is "missed" only when EVERY
// domain leaf failed (the shard's files received zero review). A partial inventory leaves any
// un-enumerated files as an inherent coverage gap (recorded on the ledger, not a per-shard miss).
const shardAnyCoverage = ran.length > 0;
for (const s of shardLedger) s.status = (s.fileCount > 0 && !shardAnyCoverage) ? "missed" : "completed";
const shardMissedCount = shardLedger.filter((s) => s.status === "missed").length;
if (shardMissedCount > 0) await log(`Shard coverage: ${shardMissedCount} shard(s) missed (no domain produced coverage).`);

// Map domain -> raw findings (only from leaves that returned an envelope with findings).
const findingsByDomain = {};
for (const env of rawCoverage) {
  if (!env || typeof env !== "object" || env.__error) continue;
  const dom = typeof env.domain === "string" ? env.domain.replace(/^repo-/, "") : "unknown";
  findingsByDomain[dom] = Array.isArray(env.findings) ? env.findings : [];
}

// ---- 3. Normalize + conservatively merge cross-domain (pure JS — no tokens) ----
await phase("merge");
const SEVW = { critical: 4, high: 3, medium: 2, low: 1 };
const EFFW = { small: 1, medium: 2, large: 3 };
const EFFD = { small: 1, medium: 0.8, large: 0.6 };
const normFile = (s) => (s || "").toString().replace(/^\.\//, "").trim();
const sevRank = (s) => SEVW[s] || 1;
const maxEffort = (a, b) => ((EFFW[a] || 2) >= (EFFW[b] || 2) ? a : b);
const weight = (f) => sevRank(f.severity) * ((f.confidence || 0) / 100);

// corroborationKey (iui1.6): a CROSS-DOMAIN "same root cause" key DISTINCT from the domain-
// prefixed materialization fingerprint. Two findings with the same file+category corroborate
// each other even across domains (fingerprints never match cross-domain because each leaf's
// fingerprintOf prefixes with its DOMAIN). Used ONLY to LINK (relatesTo) and to BOOST priority
// for multi-domain corroboration — never to MERGE (the materialization fingerprint stays
// domain-stable so a fix closes coverage for exactly the issue it fixes).
function corroborationKeyOf(file, category) {
  return `${normFile(file)}::${String(category || "").toLowerCase().replace(/\s+/g, " ").trim()}`;
}

// Curated per-domain fields preserved for Beads materialization. The meta keeps these under
// domainDetails in findings.full.json so /review-materialize can build native Beads design and
// acceptance fields instead of losing implementation-relevant context during normalization.
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
function domainDetailsFor(dom, finding) {
  const details = {};
  for (const key of DOMAIN_DETAIL_KEYS[dom] || []) {
    if (finding && Object.prototype.hasOwnProperty.call(finding, key)) details[key] = finding[key];
  }
  return details;
}

function buildUnified() {
  // Flatten every domain's findings into the UnifiedFinding shape. The lead `domain` and
  // `sourceDomain` start as the originating leaf domain; a fingerprint merge unions tags.
  const all = [];
  const domainsInOrder = ALL_DOMAINS.filter((d) => findingsByDomain[d]);
  for (const dom of domainsInOrder) {
    for (const f of findingsByDomain[dom]) {
      if (!f || typeof f !== "object") continue;
      all.push({
        domain: dom,
        sourceDomain: dom,
        sourceDomains: [dom],
        fingerprints: [f.fingerprint].filter(Boolean),
        category: f.category || dom,
        file: normFile(f.file),
        line: Number.isInteger(f.line) && f.line > 0 ? f.line : 0,
        severity: f.severity || "low",
        description: f.description || "",
        proposedChange: f.proposedChange || "",
        confidence: Number.isInteger(f.confidence) ? f.confidence : 60,
        effort: f.effort || "medium",
        domainDetails: domainDetailsFor(dom, f),
        relatesTo: [],
        __corr: corroborationKeyOf(f.file, f.category || dom),
      });
    }
  }

  // Corroboration domain sets (iui1.6): corroborationKey -> Set<domain>. Drives the multi-domain
  // priority boost that was previously dead code (sourceDomains.length was always 1 because
  // cross-domain findings never fingerprint-merge). Computed from the pre-merge `all` set so a
  // corroborating finding boosts even when it is NOT merged into the lead.
  const corroborationDomains = new Map();
  for (const f of all) {
    if (!f.file) continue;
    const set = corroborationDomains.get(f.__corr);
    if (set) set.add(f.sourceDomain);
    else corroborationDomains.set(f.__corr, new Set([f.sourceDomain]));
  }

  // CONSERVATIVE MERGE — only on identical fingerprint (intra-domain, since fingerprints are
  // domain-prefixed). O(1) Map lookup (iui1.6) instead of O(n^2) unified.find(). Adoption is
  // decided on ORIGINAL severities first, then upgraded, so the weight compare is never skewed by
  // an in-place severity upgrade. Proximity/corroboration is NEVER a merge (it is a LINK below) so
  // two distinct nearby issues never collapse into one (which would let a fix close coverage for
  // an unfixed bug).
  const byFingerprint = new Map();
  const unified = [];
  for (const f of all) {
    let hit = null;
    for (const fp of f.fingerprints) { const g = byFingerprint.get(fp); if (g) { hit = g; break; } }
    if (!hit) {
      unified.push(f);
      for (const fp of f.fingerprints) byFingerprint.set(fp, f);
      continue;
    }
    // Adoption picks which contributor's LEAD fields the merged finding carries. Higher weight
    // wins; on an EXACT weight tie, break deterministically by (description, proposedChange) so the
    // result NEVER depends on lane/insertion order (rrev.25). `line` tracks the lead so the
    // reported location (and the relatesTo links derived from it) are stable too.
    const wf = weight(f);
    const wh = weight(hit);
    const adopt = wf > wh
      || (wf === wh && (String(f.description) < String(hit.description)
           || (String(f.description) === String(hit.description) && String(f.proposedChange) < String(hit.proposedChange))));
    if (sevRank(f.severity) > sevRank(hit.severity)) hit.severity = f.severity;
    if (adopt) { hit.description = f.description; hit.proposedChange = f.proposedChange; hit.domain = f.domain; hit.sourceDomain = f.sourceDomain; hit.line = f.line; hit.domainDetails = f.domainDetails; hit.__corr = f.__corr; }
    hit.confidence = Math.max(hit.confidence, f.confidence);
    hit.effort = maxEffort(hit.effort, f.effort);
    for (const d of f.sourceDomains) if (!hit.sourceDomains.includes(d)) hit.sourceDomains.push(d);
    for (const fp of f.fingerprints) { if (!hit.fingerprints.includes(fp)) hit.fingerprints.push(fp); byFingerprint.set(fp, hit); }
  }

  // Singular lead fingerprint (first contributor) so every unified finding carries one.
  for (const f of unified) f.fingerprint = f.fingerprints[0] || null;

  // Rank FIRST (stable, deterministic) so relatesTo can reference stable ranks. Multi-domain
  // corroboration gets a small, capped boost keyed on corroborationKey (iui1.6) — this previously
  // used sourceDomains.length, which was dead code (always 1) because cross-domain findings never
  // fingerprint-merge. Deterministic tie-break: severity weight, then domain name, then fingerprint.
  for (const f of unified) {
    const corrCount = f.file ? (corroborationDomains.get(f.__corr)?.size || 1) : 1;
    const boost = Math.min(1.25, 1 + 0.1 * (corrCount - 1));
    f.priorityScore = Math.round(sevRank(f.severity) * (f.confidence / 100) * (EFFD[f.effort] || 0.8) * boost * 100) / 100;
    f.corroborationCount = corrCount;
  }
  unified.sort((a, b) => {
    if (b.priorityScore !== a.priorityScore) return b.priorityScore - a.priorityScore;
    if (sevRank(b.severity) !== sevRank(a.severity)) return sevRank(b.severity) - sevRank(a.severity);
    const da = a.sourceDomains.slice().sort().join(",") || a.domain;
    const db = b.sourceDomains.slice().sort().join(",") || b.domain;
    if (da !== db) return da < db ? -1 : 1;
    const fa = a.fingerprint || "";
    const fb = b.fingerprint || "";
    return fa < fb ? -1 : fa > fb ? 1 : 0;
  });
  unified.forEach((f, i) => { f.rank = i + 1; });

  // relatesTo AFTER the sort, storing the related finding's stable RANK. Bucketed by
  // corroborationKey (iui1.6) for O(n)-average lookup instead of O(n^2). Two link rules, both
  // confined to the SAME file+category bucket (so the inner loop is over a small bucket, not the
  // whole set): (a) PROXIMITY — same file+category within ±3 lines (both lines non-zero);
  // (b) CROSS-DOMAIN CORROBORATION — same file+category from DIFFERENT source domains (no line
  // requirement; the cross-domain "same root cause" link fingerprint merging could never express).
  // Both are LINKs, never merges.
  const byBucket = new Map();
  for (const f of unified) {
    if (!f.file) continue;
    const bucket = byBucket.get(f.__corr);
    if (bucket) bucket.push(f); else byBucket.set(f.__corr, [f]);
  }
  for (const bucket of byBucket.values()) {
    for (let i = 0; i < bucket.length; i++) {
      const a = bucket[i];
      for (let j = i + 1; j < bucket.length; j++) {
        const b = bucket[j];
        const proximity = a.line !== 0 && b.line !== 0 && Math.abs(a.line - b.line) <= 3;
        const crossDomain = a.sourceDomain !== b.sourceDomain;
        if (proximity || crossDomain) {
          if (!a.relatesTo.includes(b.rank)) a.relatesTo.push(b.rank);
          if (!b.relatesTo.includes(a.rank)) b.relatesTo.push(a.rank);
        }
      }
    }
  }
  for (const f of unified) { f.relatesTo = [...new Set(f.relatesTo)].sort((x, y) => x - y); delete f.__corr; }
  return unified;
}

const unified = buildUnified();
const counts = {
  total: unified.length,
  critical: unified.filter((f) => f.severity === "critical").length,
  high: unified.filter((f) => f.severity === "high").length,
  medium: unified.filter((f) => f.severity === "medium").length,
  low: unified.filter((f) => f.severity === "low").length,
};
await log(`Merged into ${unified.length} unified findings across ${ran.length} domain(s).`);

// partialCoverage is true when a whole leaf failed/missing OR any leaf dropped a lane
// (finder/verifier/scorer). A per-lane drop degrades coverage as seriously as a failed leaf —
// the leaf can return "ok" while a whole finder lens silently returned null (iui1.2).
const partialCoverage = failed.length > 0 || ran.length < activeDomains.length || leafOutcomes.some((o) => o.laneDropped > 0);
const totalLaneDropped = leafOutcomes.reduce((s, o) => s + (o.laneDropped || 0), 0);
if (totalLaneDropped > 0) await log(`Lane coverage degraded: ${totalLaneDropped} lane(s) dropped across leaf(es).`);

// ---- materialization readiness gate (pure JS) ----
// A report is safe to materialize into Beads ONLY when OBJECTIVE coverage is complete and the
// finding set was not size-capped or lost. materializationBlockers is the authoritative list of
// such objective signals; the command refuses to OFFER materialize when materializationReady is
// false, and the separate review-materialize flow re-checks it. This is the review→materialize
// boundary gate.
//
// The gate is OBJECTIVE ONLY. The coverage auditor is a meta-judgment lane, not a finding producer:
// its subjective assessment (coverageAssessment / confidence / gaps) can NEVER hard-block
// materialization. Instead the auditor's concerns are surfaced as coverageAdvisories, which the
// command reports separately ("mechanically safe to materialize; auditor recommends follow-up
// review areas"). This prevents a conservative or under-informed auditor from vetoing a complete,
// artifact-backed review (see the goals-4bd5a7fd incident: all 8 domains ok/empty, artifacts ready,
// 127 findings, yet auditor partial/medium falsely blocked materialization).
const AUDITOR_SCHEMA = {
  type: "object", additionalProperties: false,
  required: ["coverageAssessment", "confidence", "gaps", "missedAreas"],
  properties: {
    coverageAssessment: { type: "string", enum: ["complete", "partial", "degraded"] },
    confidence: { type: "string", enum: ["high", "medium", "low"] },
    gaps: { type: "array", items: { type: "string" } },
    missedAreas: { type: "array", items: { type: "string" } },
  },
};
// coverageGrade is the OBJECTIVE coverage grade derived only from materializationBlockers (the
// auditor never contributes). "degraded" is a reserved/legacy enum value kept for compatibility;
// it is not currently produced because auditor-only concerns are coverageAdvisories, not blockers.
function gradeFor(blockers) {
  if (blockers.length === 0) return "complete";
  if (blockers.includes("truncatedFindings") || blockers.includes("reportMarkdownDropped") || blockers.some((b) => b.startsWith("leafTruncated:"))) return "truncated";
  return "partial";
}
// Build the gate from the observable coverage state. `auditor` is null in bounded mode or
// when the auditor lane failed (onFailure returnNull); both are handled distinctly.
//
// Artifact awareness (iui1.4): when the full ranked set + full markdown were spilled to host-owned
// artifacts (artifactsReady), truncation of the RETURNED preview array and the dropped in-envelope
// reportMarkdown are intentional compaction, NOT data loss — so they are no longer blockers. Only
// when artifactization FAILED (artifactFailed) do we block with artifactPersistenceFailed, because
// then the full data truly was lost to the size cap.
function materializationGate({ truncated, reportMarkdown, unifiedCount, auditor, artifactsReady, artifactFailed }) {
  const blockers = [];
  if (partialCoverage) blockers.push("partialCoverage");
  // Inventory + shard coverage (iui1.5): a failed inventory means coverage accounting is unknown,
  // and a missed shard means a whole file group received zero review. Either blocks materialization.
  if (!inventoryReady) blockers.push("inventoryFailed");
  if (inventory && inventory.partial) blockers.push("inventoryPartial");
  for (const s of shardLedger) if (s.status === "missed") blockers.push(`shardMissed:${s.id}`);
  // Truncation/reportMarkdown-drop only block when the full data is NOT preserved in artifacts.
  if (!artifactsReady) {
    if (truncated) blockers.push("truncatedFindings");
    // reportMarkdown is legitimately null when there are zero findings; it is only a blocker
    // when findings EXISTED but the report was dropped to fit the 256 KiB cap AND no artifact
    // holds the full markdown (the full ranked detail would be lost).
    if (unifiedCount > 0 && reportMarkdown === null) blockers.push("reportMarkdownDropped");
  }
  if (artifactFailed && unifiedCount > 0) blockers.push("artifactPersistenceFailed");
  for (const o of leafOutcomes) if (o.truncatedFindings) blockers.push(`leafTruncated:${o.domain}`);
  // Per-lane drops (iui1.2): a leaf that dropped finder/verifier/scorer lanes has degraded
  // coverage. Emit one blocker per domain plus finer-grained per-phase blockers so the operator
  // sees WHICH lens class was lost, not just that something dropped.
  for (const o of leafOutcomes) {
    if (!o.laneCoverage || o.laneCoverage.dropped <= 0) continue;
    blockers.push(`leafLaneDrops:${o.domain}`);
    const bp = o.laneCoverage.byPhase || {};
    if (bp.find && bp.find.dropped > 0) blockers.push(`leafFinderDrops:${o.domain}`);
    if (bp.verify && bp.verify.dropped > 0) blockers.push(`leafVerifierDrops:${o.domain}`);
    if (bp.score && bp.score.dropped > 0) blockers.push(`leafScorerDrops:${o.domain}`);
  }
  // Coverage auditor (ADVISORY ONLY). A meta-judgment lane must not veto a complete, artifact-
  // backed review on subjective grounds. The auditor's assessment is surfaced as coverageAdvisories
  // for the command to report separately from the objective blockers. `auditor` is null in bounded
  // mode (no auditor expected) or when the auditor lane failed in exhaustive mode (onFailure
  // returnNull); a failed auditor lane is an advisory gap, not data loss — exhaustive mode promised
  // an auditor and did not get one, but every finding-producing leaf still completed.
  const advisories = [];
  if (exhaustive) {
    if (auditor) {
      if (auditor.coverageAssessment !== "complete") advisories.push(`auditorCoverage:${auditor.coverageAssessment}`);
      if (auditor.confidence === "low") advisories.push("auditorLowConfidence");
    } else {
      advisories.push("auditorUnavailable");
    }
  }
  return { materializationReady: blockers.length === 0, materializationBlockers: blockers, coverageAdvisories: advisories, coverageGrade: gradeFor(blockers) };
}

// ---- coverage auditor (EXHAUSTIVE only) ----
// A final deep-tier lane that reviews the merged coverage for blind spots before the report
// is finalized. It cannot add findings; it can only flag gaps that become coverageAdvisories
// (ADVISORY ONLY — never a materializationBlocker). It runs BEFORE the empty-check so "we found
// nothing" is audited too (a clean bill of health is most valuable precisely when findings are
// sparse). onFailure returnNull keeps a failed auditor from crashing the meta (it becomes an
// "auditorUnavailable" advisory instead). Bounded mode skips it entirely.
//
// The auditor is fed OBJECTIVE telemetry (lane completion, inventory/shard status, per-domain
// empty-vs-failed distinction) so it cannot mistake a clean empty domain for a coverage gap. An
// empty domain that ran to completion (all lanes completed, zero dropped) is a clean result, not
// a missed-area: the domain produced no findings after full analysis.
let coverageAudit = null;
if (exhaustive) {
  await phase("audit");
  const auditLedger = leafOutcomes.map((o) => {
    const lc = o.laneCoverage;
    const laneStr = lc ? ` [lanes ${lc.completed}/${lc.expected}${lc.dropped ? `, DROPPED ${lc.dropped}` : ""}]` : "";
    const emptyNote = o.status === "empty" && lc && lc.dropped === 0 ? " (ran to completion; no findings survived)" : "";
    return `- ${o.domain}: ${o.status}${o.error ? ` (${o.error})` : ""}${emptyNote} — ${(o.counts && o.counts.total) || 0} findings${o.truncatedFindings ? " (TRUNCATED)" : ""}${laneStr}`;
  }).join("\n");
  coverageAudit = await agent(
    ["You are a coverage auditor for an exhaustive, read-only repo review. Assess whether the review likely missed important issue classes given the repo profile and the coverage ledger below.",
      scope,
      `Recon:\n${formatRecon(recon)}`,
      `Active domains: ${activeDomains.join(", ")}.`,
      `Objective coverage state: partialCoverage=${partialCoverage}; inventory=${inventoryReady ? "ok" : "FAILED"}${inventory && inventory.partial ? " (PARTIAL)" : ""}; shards=${shardLedger.length} (${shardMissedCount} missed); total lane drops=${totalLaneDropped}.`,
      `Coverage ledger:\n${auditLedger}`,
      `Merged findings: ${unified.length} (critical ${counts.critical}, high ${counts.high}, medium ${counts.medium}, low ${counts.low}).`,
      "Consider: did any domain fail or return partial results? Are there repo areas the scope excludes (config, CI, scripts, generated code, secrets, infra) that might hide issues? Is thorough depth sufficient for this repo's size and language mix? Are there obvious issue classes (e.g. license compliance, accessibility, i18n, error-handling paths) no domain covers?",
      "IMPORTANT: a domain listed as 'empty (ran to completion; no findings survived)' is a CLEAN result — the domain analyzed its scope fully and produced no findings. An empty-but-complete domain is NOT a coverage gap. Distinguish 'the domain ran and found nothing' from 'the domain failed or was not run'.",
      "Return coverageAssessment (complete if you are confident the review found the materially important issues; partial if there are real gaps; degraded if coverage is seriously incomplete), your confidence, specific gaps (short strings), and missedAreas (short strings). Be conservative: if unsure, say partial."].join("\n\n"),
    { label: "coverage-auditor", schema: AUDITOR_SCHEMA, tier: "deep", onFailure: "returnNull" },
  );
  if (coverageAudit && typeof coverageAudit === "object") {
    await log(`Coverage auditor: ${coverageAudit.coverageAssessment} (confidence ${coverageAudit.confidence})${coverageAudit.gaps?.length ? ` — ${coverageAudit.gaps.length} gap(s)` : ""}.`);
  } else {
    await log("WARNING: coverage auditor returned null — recording as auditorUnavailable advisory.");
  }
}

// ---- 4. Synthesize ONE cross-domain report (PURE JS render; no model tokens) ----
await phase("synthesize");
function mdCell(s) { return String(s == null ? "" : s).replace(/\|/g, "\\|").replace(/\n+/g, " "); }
function renderMarkdown(rows, c) {
  const ledger = leafOutcomes.map((o) => `- ${o.domain}: ${o.status}${o.error ? ` (${o.error})` : ""} — ${(o.counts && o.counts.total) || 0} findings`).join("\n");
  const lines = [];
  lines.push("# Comprehensive Repo Review Report", "");
  lines.push("> Report-only. No files were modified and nothing was applied.", "");
  // ---- Scale + coverage telemetry (iui1.8) ----
  lines.push("## Scope summary", `- Paths: ${JSON.stringify(paths)}`, `- Exclude: ${JSON.stringify(exclude)}`, `- Active domains: ${activeDomains.join(", ")}`, `- Depth: ${depth} (mode: ${mode})`, "");
  if (scaleProfile) {
    lines.push("## Inventory summary",
      `- Files enumerated: ${scaleProfile.totalFiles}`,
      `- Source roots: ${inventorySummary.sourceRoots}`,
      `- Shards: ${scaleProfile.shards} (${scaleProfile.shardMissed} missed)${scaleProfile.inventoryPartial ? " — PARTIAL inventory (file cap hit)" : ""}`,
      `- Files reviewed: ${scaleProfile.reviewedFiles}${scaleProfile.skippedFiles ? ` (skipped: ${scaleProfile.skippedFiles})` : ""}`,
      "");
    // Lane coverage per domain.
    const laneLines = leafOutcomes.map((o) => {
      const lc = o.laneCoverage;
      if (!lc) return `- ${o.domain}: ${o.status} (no lane telemetry)`;
      return `- ${o.domain}: ${o.status} — lanes ${lc.completed}/${lc.expected}${lc.dropped ? ` (DROPPED ${lc.dropped}: ${mdCell((lc.droppedLabels || []).join(", "))})` : ""}`;
    });
    lines.push("## Lane coverage", ...laneLines, "");
    // Dropped / failed lanes named explicitly so they cannot be missed.
    if (scaleProfile.droppedLanes > 0 || scaleProfile.failedDomains.length) {
      lines.push("## Dropped / failed lanes");
      for (const lbl of scaleProfile.droppedLaneLabels) lines.push(`- dropped: ${mdCell(lbl)}`);
      for (const dom of scaleProfile.failedDomains) lines.push(`- failed domain: ${mdCell(dom)}`);
      lines.push("");
    }
    lines.push("## Artifact status",
      `- Full ranked findings + this report persisted as host-owned artifacts (see \`artifactPaths\`).`,
      "");
    // What this review did NOT do — prevents misreading incomplete coverage as exhaustive.
    const gaps = [];
    if (scaleProfile.droppedLanes > 0) gaps.push(`${scaleProfile.droppedLanes} finder/verifier lane(s) dropped — some issue classes may be under-counted.`);
    if (scaleProfile.shardMissed > 0) gaps.push(`${scaleProfile.shardMissed} shard(s) received zero domain coverage.`);
    if (scaleProfile.inventoryPartial) gaps.push("File inventory hit its cap — some files were not enumerated.");
    if (scaleProfile.failedDomains.length) gaps.push(`Domain(s) failed: ${scaleProfile.failedDomains.join(", ")}.`);
    gaps.push("Static, read-only analysis (no shell/git-churn, no network advisory lookups) — optional deep modes were not enabled.");
    lines.push("## What this review did not do", ...gaps.map((g) => `- ${g}`), "");
  }
  lines.push("## Coverage ledger", ledger, "");
  lines.push("## Summary", `- Total: ${c.total} (critical: ${c.critical}, high: ${c.high}, medium: ${c.medium}, low: ${c.low})`, "");
  lines.push("## Ranked cross-domain findings", "");
  lines.push("| Rank | Severity | Score | Domain(s) | Location | Category | Description |");
  lines.push("| ---- | -------- | ----- | --------- | -------- | -------- | ----------- |");
  for (const f of rows) {
    lines.push(`| ${f.rank} | ${mdCell(f.severity)} | ${f.priorityScore} | ${mdCell(f.sourceDomains.join("+"))} | ${mdCell(f.file)}:${f.line || 0} | ${mdCell(f.category)} | ${mdCell(f.description).slice(0, 140)} |`);
  }
  lines.push("", "## Detail");
  for (const f of rows) {
    lines.push("", `### ${f.rank}. ${mdCell(f.category)} — ${mdCell(f.file)}:${f.line || 0} (${f.severity}, conf ${f.confidence})`);
    lines.push(`- **Domain(s):** ${f.sourceDomains.join(", ")}`);
    lines.push(`- **What:** ${f.description}`);
    if (f.proposedChange) lines.push(`- **Proposed change:** ${f.proposedChange}`);
    if (f.relatesTo.length) lines.push(`- **Related (ranks):** ${f.relatesTo.join(", ")}`);
    lines.push(`- **Fingerprint:** \`${f.fingerprint}\``);
  }
  return lines.join("\n");
}

// ---- artifactize full output (iui1.4) ----
// The workflow return is capped at MAX_RESULT_BYTES (256 KiB); a large exhaustive report would
// otherwise be truncated (reportMarkdown dropped, findings halved) and the materialization gate
// would block. Instead, spill the FULL ranked findings + coverage ledger + full markdown to
// host-owned artifacts under the run directory. NO data is lost to size fitting: the return
// envelope carries compact artifactPaths + counts + a top-N preview, and review-materialize reads
// the full set from findings.full.json via its findingsPath handoff. The QuickJS guest cannot
// write files; persistArtifacts is a kernel host op rooted under run.dir/artifacts/ (controller-
// owned, gitignored), preserving the read-only-review contract (no workspace/source writes).
// Compact inventory summary for the envelope (the full manifest + per-shard file lists live in the
// shard-ledger.json artifact). shardLedger carries per-shard coverage status for observability.
const inventorySummary = {
  ready: inventoryReady,
  partial: !!(inventory && inventory.partial),
  totalFiles: manifest ? manifest.totalFiles : 0,
  sourceRoots: manifest ? manifest.sourceRoots.length : 0,
  shards: shardLedger.length,
  shardMissed: shardMissedCount,
};

// scaleProfile (iui1.8): structured scale + coverage telemetry aggregated from the inventory,
// shard ledger, and per-leaf lane coverage. Makes dropped lanes, missed shards, and skipped files
// visible at the envelope + report level so an operator cannot misread incomplete coverage as
// exhaustive. artifactsReady/truncatedFindings are mutated after persistence / size-fitting.
const scaleProfile = (() => {
  const totalFiles = manifest ? manifest.totalFiles : 0;
  const missedFiles = shardLedger.filter((s) => s.status === "missed").reduce((s2, sh) => s2 + (sh.fileCount || 0), 0);
  let totalLanes = 0, droppedLanes = 0;
  const droppedLaneLabels = [];
  for (const o of leafOutcomes) {
    if (o.laneCoverage && typeof o.laneCoverage === "object") {
      totalLanes += o.laneCoverage.expected || 0;
      droppedLanes += o.laneCoverage.dropped || 0;
      for (const lbl of (o.laneCoverage.droppedLabels || [])) droppedLaneLabels.push(`${o.domain}:${lbl}`);
    }
  }
  return {
    shards: shardLedger.length,
    shardMissed: shardMissedCount,
    totalFiles,
    reviewedFiles: Math.max(0, totalFiles - missedFiles),
    skippedFiles: missedFiles,
    inventoryPartial: !!(inventory && inventory.partial),
    totalLanes,
    droppedLanes,
    droppedLaneLabels,
    failedDomains: failed.map((o) => o.domain),
    artifactsReady: false, // mutated after artifact persistence completes
    truncatedFindings: false, // mutated in fitWithinBudget for the non-empty path
  };
})();

const fullMarkdown = unified.length ? renderMarkdown(unified, counts) : null;
const findingsJsonl = unified.map((f) => JSON.stringify(f)).join("\n");
let artifactResult = null;
try {
  artifactResult = await persistArtifacts({
    namespace: "repo-review",
    files: [
      { name: "findings.full.json", content: unified },
      { name: "findings.jsonl", content: findingsJsonl || "" },
      { name: "coverage-ledger.json", content: { counts, leafOutcomes, domainExtras, partialCoverage, coverageAudit, shardLedger } },
      { name: "leaf-outcomes.json", content: leafOutcomes },
      { name: "shard-ledger.json", content: { inventory: manifest, shards: inventoryShards, shardLedger } },
      ...(fullMarkdown ? [{ name: "report-markdown.md", content: fullMarkdown }] : []),
    ],
  });
} catch (e) {
  artifactResult = { ok: false, error: String((e && e.message) || e), dir: null, files: [] };
}
const artifactsReady = !!(artifactResult && artifactResult.ok);
const artifactFailed = !artifactsReady;
scaleProfile.artifactsReady = artifactsReady;
if (artifactsReady) {
  await log(`Artifacts persisted: ${unified.length} findings + coverage ledger under ${artifactResult.dir}.`);
} else {
  await log(`WARNING: artifact persistence failed — ${artifactResult && artifactResult.error}. Full findings will be subject to the size cap.`);
}
// artifactPaths maps a stable logical key -> absolute host path. findingsJson (findings.full.json)
// is the canonical handoff to review-materialize (its findingsPath expects a JSON array).
const ARTIFACT_KEY = {
  "findings.full.json": "findingsJson",
  "findings.jsonl": "findingsJsonl",
  "coverage-ledger.json": "coverageLedgerJson",
  "leaf-outcomes.json": "leafOutcomesJson",
  "shard-ledger.json": "shardLedgerJson",
  "report-markdown.md": "reportMarkdownPath",
};
const artifactPaths = {};
if (artifactResult && Array.isArray(artifactResult.files)) {
  for (const af of artifactResult.files) {
    const key = ARTIFACT_KEY[af.name] || af.name.replace(/[^A-Za-z0-9]+/g, "_");
    artifactPaths[key] = af.path;
  }
}
if (unified.length === 0) {
  const summary = `No findings across ${ran.length} of ${activeDomains.length} active domain(s).${failed.length ? ` ${failed.length} domain(s) failed — partial coverage.` : ""}`;
  const gate = materializationGate({ truncated: false, reportMarkdown: null, unifiedCount: 0, auditor: coverageAudit, artifactsReady, artifactFailed });
  return envelope(ran.length ? "empty" : "aborted", {
    abortReason: ran.length ? null : "All active domains failed; no findings available.",
    summary,
    counts,
    findings: [],
    truncatedFindings: false,
    reportMarkdown: null,
    leafOutcomes,
    domainExtras,
    partialCoverage,
    coverageAudit,
    artifactPaths,
    artifactsReady,
    artifactCounts: { findings: unified.length },
    inventorySummary,
    scaleProfile,
    shardLedger,
    deepMode,
    ...gate,
  });
}

// Size-fit the RETURNED preview to the 256 KiB host cap. Because the FULL ranked set + markdown
// were spilled to artifacts above, this compaction is lossless: counts.total ALWAYS reflects the
// full ranked set, and the full data lives in artifactPaths. The envelope keeps a top-N preview +
// reportMarkdown when they fit (dropped only to fit the cap, never losing the artifact copy).
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
function fitWithinBudget() {
  const LIMIT = 230000; // headroom under MAX_RESULT_BYTES (262144) for the {output:...} wrapper + envelope fields
  let returned = unified.slice(0, maxReturnFindings);
  let truncated = unified.length > returned.length;
  let reportMarkdown = fullMarkdown;
  const summary = `Reviewed ${ran.length} of ${activeDomains.length} domain(s): ${counts.total} findings (${counts.critical} critical, ${counts.high} high). Report-only — nothing applied.${partialCoverage ? " PARTIAL coverage." : ""} Full findings in artifacts.`;
  const gate0 = () => materializationGate({ truncated, reportMarkdown, unifiedCount: unified.length, auditor: coverageAudit, artifactsReady, artifactFailed });
  const sizeOf = () => jsonUtf8ByteLength(envelope("ok", { summary, counts, findings: returned, truncatedFindings: truncated, reportMarkdown, leafOutcomes, domainExtras, partialCoverage, artifactPaths, artifactsReady, artifactCounts: { findings: unified.length }, inventorySummary, scaleProfile: { ...scaleProfile, truncatedFindings: truncated }, shardLedger, deepMode, ...gate0(), coverageAudit }));
  if (sizeOf() > LIMIT) reportMarkdown = null;
  while (sizeOf() > LIMIT && returned.length > 10) {
    returned = returned.slice(0, Math.ceil(returned.length / 2));
    truncated = true;
  }
  return envelope("ok", { summary, counts, findings: returned, truncatedFindings: truncated, reportMarkdown, leafOutcomes, domainExtras, partialCoverage, artifactPaths, artifactsReady, artifactCounts: { findings: unified.length }, inventorySummary, scaleProfile: { ...scaleProfile, truncatedFindings: truncated }, shardLedger, deepMode, ...materializationGate({ truncated, reportMarkdown, unifiedCount: unified.length, auditor: coverageAudit, artifactsReady, artifactFailed }), coverageAudit });
}

return fitWithinBudget();
