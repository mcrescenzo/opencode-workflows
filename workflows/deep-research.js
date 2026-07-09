export const meta = {
  name: "deep-research",
  description: "Deep research harness — fan-out web searches, fetch sources, adversarially verify claims, synthesize a cited report.",
  whenToUse: "When the user wants a deep, multi-source, fact-checked research report on any topic. Refine an underspecified question first; pass it as args.question (or args as a plain string).",
  category: "research",
  notes: "Network-authorized read-only research: search/fetch/verify lanes use websearch/webfetch; scope/synthesize lanes are narrowed to read-only. No shell, no MCP, no edits.",
  examples: [
    { label: "default thorough run", args: { question: "What are current best practices for passkey rollout in consumer apps?" } },
    { label: "quick pass", args: { question: "Is fish oil supplementation effective for ADHD?", depth: "quick" } },
    { label: "seeded", args: { question: "How does QuickJS handle async?", seedUrls: ["https://bellard.org/quickjs/"] } },
  ],
  profile: "read-only-review",
  authority: { readOnly: true, network: true },
  argsSchema: {
    type: ["object", "string", "null"],
    properties: {
      question: { type: "string" },
      depth: { type: "string", enum: ["quick", "normal", "thorough"] },
      maxSources: { type: "integer", minimum: 3, maximum: 30 },
      seedUrls: { type: "array", maxItems: 10, items: { type: "string" } },
    },
  },
  phases: ["Scope", "Search", "Fetch", "Verify", "Synthesize"],
  maxAgents: 160,
  concurrency: 8,
};

// deep-research: Scope → pipeline(Search → URL-dedup → Fetch+Extract) → adversarial Verify → Synthesize.
// A faithful port of the Claude Code bundled deep-research architecture onto this kernel
// (spec: docs/superpowers/specs/2026-07-08-deep-research-bundled-workflow-design.md).
// Prompt section headers ("## Deep-Research Scope", "## Web Searcher:", "## Source Extractor",
// "## Adversarial Claim Verifier", "## Synthesis: research report") are a stable contract —
// tests/deep-research-workflow.test.mjs routes scripted child responses on them.

const DOMAIN = "deep-research";
const SCHEMA_VERSION = 1;

// ---- args: plain string question | object bag | defensively a JSON string of the bag ----
let RT = args;
if (typeof RT === "string") {
  const trimmed = RT.trim();
  if (trimmed.startsWith("{")) {
    try { RT = JSON.parse(trimmed); } catch { RT = { question: trimmed }; }
  } else {
    RT = { question: trimmed };
  }
}
if (!RT || typeof RT !== "object" || Array.isArray(RT)) RT = {};

const QUESTION = typeof RT.question === "string" ? RT.question.trim() : "";
const DEPTH = ["quick", "normal", "thorough"].includes(RT.depth) ? RT.depth : "thorough";
const SEED_URLS = Array.isArray(RT.seedUrls)
  ? RT.seedUrls.filter((u) => typeof u === "string" && u.trim()).slice(0, 10)
  : [];

// Depth presets. `thorough` is Claude Code parity: 5 angles, 15-source fetch budget,
// 25-claim verify cap, 3-vote panels with 2 refutations required to kill a claim.
const PRESETS = {
  quick:    { angles: 3, maxFetch: 6,  verifyCap: 8,  votes: 1, refutesRequired: 1, centralOnly: true },
  normal:   { angles: 4, maxFetch: 10, verifyCap: 15, votes: 1, refutesRequired: 1, centralOnly: false },
  thorough: { angles: 5, maxFetch: 15, verifyCap: 25, votes: 3, refutesRequired: 2, centralOnly: false },
};
const P = PRESETS[DEPTH];
const MAX_FETCH = Number.isInteger(RT.maxSources) && RT.maxSources >= 3 && RT.maxSources <= 30
  ? RT.maxSources
  : P.maxFetch;

// Model tiers are lane-intent constants (workflow-model-tiering skill): the single scope lane
// feeds the whole funnel and verification is subtle adversarial judgment (deep); search and
// extraction are bulk work (fast). Dedup/rank/render are pure JS — zero agent cost.
const TIER_SCOPE = "deep";
const TIER_SEARCH = "fast";
const TIER_EXTRACT = "fast";
const TIER_VERIFY = "deep";
const TIER_SYNTH = "deep";

// ---- lane coverage telemetry (house pattern: repo-bughunt) ----
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
  return {
    domain: DOMAIN, schemaVersion: SCHEMA_VERSION, status, abortReason: null,
    question: QUESTION, reportPath: null, laneCoverage, ...extra,
  };
}

if (!QUESTION) {
  return envelope("failed", {
    abortReason: "no-question",
    summary: "No research question provided. Pass args as a plain question string or { question: \"…\" }.",
    findings: [], refuted: [], unverified: [], sources: [], openQuestions: [], caveats: "",
    stats: null, reportMarkdown: null, truncatedFindings: false, artifacts: null,
  });
}

// ---- URL normalization (QuickJS has no URL global; pure-string, CC-equivalent) ----
// Lowercase; strip scheme and leading www.; keep host+path; drop query/fragment; strip
// trailing slashes. Invalid/empty input normalizes to "" (callers skip those).
function normURL(u) {
  let s = String(u ?? "").trim().toLowerCase();
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, "");
  s = s.split(/[?#]/)[0];
  s = s.replace(/^www\./, "");
  s = s.replace(/\/+$/, "");
  return s;
}
function hostOf(u) {
  const n = normURL(u);
  const slash = n.indexOf("/");
  return slash === -1 ? n : n.slice(0, slash);
}

// ---- schemas (ported; plain JSON Schema, shared-Ajv strict:false compatible) ----
const SCOPE_SCHEMA = {
  type: "object", required: ["question", "angles", "summary"],
  properties: {
    question: { type: "string" },
    summary: { type: "string" },
    angles: {
      type: "array", minItems: 3, maxItems: 6,
      items: {
        type: "object", required: ["label", "query"],
        properties: { label: { type: "string" }, query: { type: "string" }, rationale: { type: "string" } },
      },
    },
  },
};
const SEARCH_SCHEMA = {
  type: "object", required: ["results"],
  properties: {
    results: {
      type: "array", maxItems: 6,
      items: {
        type: "object", required: ["url", "title", "relevance"],
        properties: {
          url: { type: "string" }, title: { type: "string" }, snippet: { type: "string" },
          relevance: { type: "string", enum: ["high", "medium", "low"] },
        },
      },
    },
  },
};
const EXTRACT_SCHEMA = {
  type: "object", required: ["claims", "sourceQuality"],
  properties: {
    sourceQuality: { type: "string", enum: ["primary", "secondary", "blog", "forum", "unreliable"] },
    publishDate: { type: "string" },
    claims: {
      type: "array", maxItems: 5,
      items: {
        type: "object", required: ["claim", "quote", "importance"],
        properties: {
          claim: { type: "string" }, quote: { type: "string" },
          importance: { type: "string", enum: ["central", "supporting", "tangential"] },
        },
      },
    },
  },
};
const VERDICT_SCHEMA = {
  type: "object", required: ["refuted", "evidence", "confidence"],
  properties: {
    refuted: { type: "boolean" }, evidence: { type: "string" },
    confidence: { type: "string", enum: ["high", "medium", "low"] },
    counterSource: { type: "string" },
  },
};
const REPORT_SCHEMA = {
  type: "object", required: ["summary", "findings", "caveats"],
  properties: {
    summary: { type: "string" },
    findings: {
      type: "array",
      items: {
        type: "object", required: ["claim", "confidence", "sources", "evidence"],
        properties: {
          claim: { type: "string" },
          confidence: { type: "string", enum: ["high", "medium", "low"] },
          sources: { type: "array", items: { type: "string" } },
          evidence: { type: "string" }, vote: { type: "string" },
        },
      },
    },
    caveats: { type: "string" },
    openQuestions: { type: "array", items: { type: "string" } },
  },
};

// ---- prompts ----
const SCOPE_PROMPT =
  "## Deep-Research Scope\n\n" +
  "Decompose this research question into complementary web-search angles.\n\n" +
  "### Question\n" + QUESTION + "\n\n" +
  "### Task\n" +
  "Generate " + P.angles + " distinct web search queries that together cover the question from different angles. " +
  "Pick angles that suit the question's domain. Examples:\n" +
  "- broad/primary · academic/technical · recent news · contrarian/skeptical · practitioner/implementation\n" +
  "- For medical: anatomy · common causes · serious differentials · authoritative refs · red flags\n" +
  "- For tech: state-of-art · benchmarks · limitations · industry adoption · cost/tradeoffs\n\n" +
  "Make queries specific enough to surface high-signal results. Avoid redundancy.\n" +
  "Return: the question (verbatim or lightly normalized), a 1-2 sentence decomposition strategy as `summary`, and the angles.";

const SEARCH_PROMPT = (angle) =>
  "## Web Searcher: " + angle.label + "\n\n" +
  "Research question: \"" + QUESTION + "\"\n\n" +
  "Your angle: **" + angle.label + "** — " + (angle.rationale || "") + "\n" +
  "Search query: `" + angle.query + "`\n\n" +
  "### Task\n" +
  "Use the websearch tool with the query above (or a refined version). Return the top 4-6 most relevant results.\n" +
  "Rank by relevance to the ORIGINAL question, not just the search query. Skip obvious SEO spam and content farms.\n" +
  "Include a short snippet capturing why each result is relevant. If search returns nothing usable, return an empty results array.";

const FETCH_PROMPT = (source, angle) =>
  "## Source Extractor\n\n" +
  "Research question: \"" + QUESTION + "\"\n\n" +
  "Fetch and extract key claims from this source:\n" +
  "**URL:** " + source.url + "\n**Title:** " + (source.title || source.url) + "\n**Found via:** " + angle + " search\n\n" +
  "### Task\n" +
  "1. Use the webfetch tool to retrieve the page content.\n" +
  "2. Assess source quality: primary research/institution? secondary reporting? blog/opinion? forum? unreliable?\n" +
  "3. Extract 2-5 FALSIFIABLE claims that bear on the research question. Each claim must:\n" +
  "   - be a concrete, checkable statement (not vague generalities)\n" +
  "   - include a direct quote from the source as support\n" +
  "   - be rated central/supporting/tangential to the research question\n" +
  "4. Note the publish date if available.\n\n" +
  "If the fetch fails or the page is irrelevant or paywalled, return claims: [] and sourceQuality: \"unreliable\".";

const VERIFY_PROMPT = (claim, v) =>
  "## Adversarial Claim Verifier (voter " + (v + 1) + "/" + P.votes + ")\n\n" +
  "Be SKEPTICAL. Try to REFUTE this claim. " + P.refutesRequired + "/" + P.votes + " refutations kill it.\n\n" +
  "### Research question\n" + QUESTION + "\n\n" +
  "### Claim under review\n\"" + claim.claim + "\"\n\n" +
  "**Source:** " + claim.sourceUrl + " (" + claim.sourceQuality + ")\n" +
  "**Supporting quote:** \"" + claim.quote + "\"\n\n" +
  "### Checklist\n" +
  "1. Is the claim actually supported by the quote, or is it an overreach or misread?\n" +
  "2. Use the websearch tool to look for contradicting evidence — does any credible source dispute or heavily qualify this?\n" +
  "3. Is the source quality sufficient for the claim's strength? (extraordinary claims need primary sources)\n" +
  "4. Is the claim outdated? (check dates — old claims about fast-moving fields are suspect)\n" +
  "5. Is this a marketing claim, press release, cherry-picked benchmark, or forum speculation?\n\n" +
  "**refuted=true** if: unsupported by quote / contradicted / low-quality source for a strong claim / outdated / marketing fluff.\n" +
  "**refuted=false** ONLY if: the claim is well-supported, current, and source quality matches claim strength.\n" +
  "Default to refuted=true if uncertain. Evidence MUST be specific.";

// ---- Phase 0: Scope ----
await phase("Scope");
const scope = await agent(SCOPE_PROMPT, {
  label: "scope", phase: "Scope", tier: TIER_SCOPE, schema: SCOPE_SCHEMA,
  readOnly: true,               // scope needs no web access — narrow below run authority
  onFailure: "returnNull",      // preserve the explicit salvage path below
});
if (!scope) {
  return envelope("failed", {
    abortReason: "scope-failed",
    summary: "Scope agent returned no result — cannot decompose the research question.",
    findings: [], refuted: [], unverified: [], sources: [], openQuestions: [], caveats: "",
    stats: null, reportMarkdown: null, truncatedFindings: false, artifacts: null,
  });
}
await log("Q: " + QUESTION.slice(0, 80) + (QUESTION.length > 80 ? "…" : ""));
const angles = scope.angles.slice(0, P.angles);
await log("Decomposed into " + angles.length + " angles: " + angles.map((a) => a.label).join(", "));

// ---- dedup state — accumulates across searchers as they complete (no barrier) ----
const seen = new Map();
const dupes = [];
const budgetDropped = [];
const relRank = { high: 0, medium: 1, low: 2 };
let fetchSlots = MAX_FETCH;
let fetchPhaseMarked = false;
let searchAgentLanes = 0;
let searchResultCount = 0;
let fetchLaneCount = 0;
let fetchFailures = 0;

// Seed URLs enter the same pipeline as a synthetic "seeds" item: no search agent, straight to
// dedup+fetch, always treated as high relevance (explicit user input).
const pipelineItems = [];
if (SEED_URLS.length > 0) {
  pipelineItems.push({ seed: true, label: "seeds", results: SEED_URLS.map((url) => ({ url, title: url, relevance: "high" })) });
}
for (const a of angles) pipelineItems.push(a);

// ---- Search → dedup → Fetch+Extract (pipeline; item A can fetch while item B still searches) ----
await phase("Search");
const perAngle = await pipeline(
  pipelineItems,
  async (item, { agent }) => {
    if (item.seed) return { angle: "seeds", results: item.results };
    searchAgentLanes++;
    const r = await agent(SEARCH_PROMPT(item), {
      label: "search:" + item.label, phase: "Search", tier: TIER_SEARCH, schema: SEARCH_SCHEMA,
    });
    searchResultCount += r.results.length;
    await log(item.label + ": " + r.results.length + " results");
    return { angle: item.label, results: r.results };
  },
  async (searchResult, { parallel }) => {
    const sorted = [...searchResult.results].sort((a, b) => relRank[a.relevance] - relRank[b.relevance]);
    const novel = [];
    for (const r of sorted) {
      const key = normURL(r.url);
      if (!key) continue;
      if (seen.has(key)) { dupes.push({ url: r.url, angle: searchResult.angle, dupOf: seen.get(key) }); continue; }
      // High-relevance results still fetch past the budget (CC-faithful); medium/low are dropped.
      if (fetchSlots <= 0 && relRank[r.relevance] >= 1) { budgetDropped.push({ url: r.url, angle: searchResult.angle }); continue; }
      seen.set(key, { angle: searchResult.angle, title: r.title });
      fetchSlots--;
      novel.push(r);
    }
    if (novel.length < searchResult.results.length) {
      await log(searchResult.angle + ": " + novel.length + " novel (" + (searchResult.results.length - novel.length) + " filtered)");
    }
    if (novel.length > 0 && !fetchPhaseMarked) { fetchPhaseMarked = true; await phase("Fetch"); }
    return await parallel(novel.map((source) => async ({ agent }) => {
      fetchLaneCount++;
      const host = hostOf(source.url) || "unknown";
      try {
        const ext = await agent(FETCH_PROMPT(source, searchResult.angle), {
          label: "fetch:" + host, phase: "Fetch", tier: TIER_EXTRACT, schema: EXTRACT_SCHEMA,
        });
        return {
          url: source.url, title: source.title, angle: searchResult.angle,
          sourceQuality: ext.sourceQuality, publishDate: ext.publishDate,
          claims: ext.claims.map((c) => ({ ...c, sourceUrl: source.url, sourceQuality: ext.sourceQuality })),
        };
      } catch (error) {
        fetchFailures++;
        await log("fetch failed: " + source.url + " — " + (error && error.message ? error.message : String(error)));
        return { url: source.url, title: source.title, angle: searchResult.angle, sourceQuality: "unreliable", publishDate: undefined, claims: [], fetchFailed: true };
      }
    }));
  },
);
tallyPhase("Search", perAngle, (i) => "search:" + (pipelineItems[i] && pipelineItems[i].label ? pipelineItems[i].label : i + 1));

const allSources = [];
for (const item of perAngle) {
  if (!Array.isArray(item)) continue;           // dropped search lane (already tallied)
  for (const s of item) if (s) allSources.push(s);
}
const allClaims = [];
for (const s of allSources) for (const c of s.claims) allClaims.push(c);

// Honesty gate: nothing to research from. Distinguish "web search unavailable/empty" from a
// plausible-but-empty report.
if (allSources.length === 0) {
  return envelope("failed", {
    abortReason: "websearch-unavailable-or-empty",
    summary: "No sources could be gathered: " + searchAgentLanes + " search lane(s) ran, " +
      searchResultCount + " results returned, " + laneCoverage.dropped + " lane(s) dropped. " +
      "Web search may be unavailable in this opencode install (websearch/webfetch are native tools " +
      "but need a working search provider). Retry, or pass seedUrls to research from known sources.",
    findings: [], refuted: [], unverified: [],
    sources: [], openQuestions: [], caveats: "",
    stats: { depth: DEPTH, angles: angles.length, sourcesFetched: 0, claimsExtracted: 0, claimsVerified: 0, confirmed: 0, killed: 0, unverified: 0, afterSynthesis: 0, urlDupes: dupes.length, budgetDropped: budgetDropped.length, fetchFailures, agentCalls: 1 + searchAgentLanes },
    reportMarkdown: null, truncatedFindings: false, artifacts: null,
  });
}

const impRank = { central: 0, supporting: 1, tangential: 2 };
const qualRank = { primary: 0, secondary: 1, blog: 2, forum: 3, unreliable: 4 };
let rankedClaims = [...allClaims].sort((a, b) =>
  (impRank[a.importance] - impRank[b.importance]) || (qualRank[a.sourceQuality] - qualRank[b.sourceQuality]));
if (P.centralOnly) rankedClaims = rankedClaims.filter((c) => c.importance === "central");
rankedClaims = rankedClaims.slice(0, P.verifyCap);
await log("Fetched " + allSources.length + " sources → " + allClaims.length + " claims → verifying top " + rankedClaims.length);

const sourcesSummary = allSources.map((s) => ({ url: s.url, quality: s.sourceQuality, angle: s.angle, claimCount: s.claims.length }));

if (rankedClaims.length === 0) {
  return envelope("failed", {
    abortReason: "no-claims-extracted",
    summary: "No claims extracted. " + allSources.length + " source(s) fetched (" + fetchFailures + " failed), all empty. " +
      dupes.length + " URL dupes, " + budgetDropped.length + " budget-dropped.",
    findings: [], refuted: [], unverified: [], sources: sourcesSummary, openQuestions: [], caveats: "",
    stats: { depth: DEPTH, angles: angles.length, sourcesFetched: allSources.length, claimsExtracted: 0, claimsVerified: 0, confirmed: 0, killed: 0, unverified: 0, afterSynthesis: 0, urlDupes: dupes.length, budgetDropped: budgetDropped.length, fetchFailures, agentCalls: 1 + searchAgentLanes + fetchLaneCount },
    reportMarkdown: null, truncatedFindings: false, artifacts: null,
  });
}

// ---- Verify: adversarial vote panels (barrier intentional: claim pool fully assembled) ----
await phase("Verify");
const votedRaw = await parallel(rankedClaims.map((claim) => async ({ parallel }) => {
  const verdicts = await parallel(Array.from({ length: P.votes }, (_, v) => async ({ agent }) =>
    agent(VERIFY_PROMPT(claim, v), {
      label: "v" + (v + 1) + ":" + claim.claim.slice(0, 40), phase: "Verify",
      tier: TIER_VERIFY, schema: VERDICT_SCHEMA,
    })));
  // A vote can be null (lane dropped) — treat as no vote cast. Three outcomes; an infra failure
  // must never read as "refuted":
  //   survives  — quorum of valid votes AND fewer than refutesRequired refuting
  //   isRefuted — ≥ refutesRequired refute votes (adjudicated against on merit)
  //   otherwise — unverified: too few valid votes to adjudicate (verifier lanes errored)
  const valid = verdicts.filter(Boolean);
  const refuted = valid.filter((x) => x.refuted).length;
  const errored = P.votes - valid.length;
  const survives = valid.length >= P.refutesRequired && refuted < P.refutesRequired;
  const isRefuted = refuted >= P.refutesRequired;
  const mark = survives ? "✓" : isRefuted ? "✗" : "?";
  await log("\"" + claim.claim.slice(0, 50) + "…\": " + (valid.length - refuted) + "-" + refuted + (errored > 0 ? " (" + errored + " errored)" : "") + " " + mark);
  return { ...claim, verdicts: valid, refutedVotes: refuted, erroredVotes: errored, survives, isRefuted };
}));
tallyPhase("Verify", votedRaw, (i) => "verify:" + (rankedClaims[i] ? rankedClaims[i].claim.slice(0, 30) : i + 1));
const voted = votedRaw.filter(Boolean);

const confirmed = voted.filter((c) => c.survives);
const killed = voted.filter((c) => c.isRefuted);
const unverifiedClaims = voted.filter((c) => !c.survives && !c.isRefuted);
await log("Verify done: " + voted.length + " claims → " + confirmed.length + " confirmed, " + killed.length + " refuted, " + unverifiedClaims.length + " unverified");

const toRefuted = (c) => ({ claim: c.claim, vote: (c.verdicts.length - c.refutedVotes) + "-" + c.refutedVotes, source: c.sourceUrl });
const toUnverified = (c) => ({ claim: c.claim, erroredVotes: c.erroredVotes, validVotes: c.verdicts.length, source: c.sourceUrl });
const statsBase = () => ({
  depth: DEPTH, angles: angles.length, sourcesFetched: allSources.length,
  claimsExtracted: allClaims.length, claimsVerified: voted.length,
  confirmed: confirmed.length, killed: killed.length, unverified: unverifiedClaims.length,
  urlDupes: dupes.length, budgetDropped: budgetDropped.length, fetchFailures,
  agentCalls: 1 + searchAgentLanes + fetchLaneCount + voted.length * P.votes + 1,
});

if (confirmed.length === 0) {
  // Distinguish "refuted on merit" (a legitimate inconclusive research outcome) from "could not
  // verify" (verifier infrastructure failure — the user should retry, not conclude).
  let summary;
  let status;
  let abortReason = null;
  if (killed.length === 0 && unverifiedClaims.length > 0) {
    status = "failed";
    abortReason = "verifiers-failed";
    summary = "Could not verify any claims — all " + unverifiedClaims.length + " verifier panels failed (likely rate-limiting or lane errors). This is an infrastructure failure, not a research finding. Raw extracted claims are preserved in artifacts; retry or verify manually.";
  } else if (unverifiedClaims.length > 0) {
    status = "degraded";
    summary = killed.length + " claim(s) refuted by adversarial verification; " + unverifiedClaims.length + " could not be verified (verifier lanes failed). No claims survived. Research inconclusive.";
  } else {
    status = "ok";
    summary = "All " + killed.length + " claim(s) refuted by adversarial verification. Research inconclusive — sources may be low-quality or claims overstated.";
  }
  return envelope(status, {
    abortReason, summary, findings: [],
    refuted: killed.map(toRefuted), unverified: unverifiedClaims.map(toUnverified),
    sources: sourcesSummary, openQuestions: [], caveats: "",
    stats: { ...statsBase(), afterSynthesis: 0, agentCalls: 1 + searchAgentLanes + fetchLaneCount + voted.length * P.votes },
    reportMarkdown: null, truncatedFindings: false, artifacts: null,
  });
}

// ---- Synthesize ----
await phase("Synthesize");
const confRank = { high: 0, medium: 1, low: 2 };
const confirmedBlock = confirmed.map((c, i) => {
  const best = c.verdicts.filter((v) => !v.refuted).sort((a, b) => confRank[a.confidence] - confRank[b.confidence])[0];
  return "### [" + i + "] " + c.claim + "\n" +
    "Vote: " + (c.verdicts.length - c.refutedVotes) + "-" + c.refutedVotes + " · Source: " + c.sourceUrl + " (" + c.sourceQuality + ")\n" +
    "Quote: \"" + c.quote + "\"\n" +
    "Verifier evidence (" + (best ? best.confidence : "n/a") + "): " + (best ? best.evidence : "none") + "\n";
}).join("\n");
const killedBlock = killed.length > 0
  ? "\n### Refuted claims (for transparency)\n" + killed.map((c) => "- \"" + c.claim + "\" (" + c.sourceUrl + ", vote " + (c.verdicts.length - c.refutedVotes) + "-" + c.refutedVotes + ")").join("\n")
  : "";
const unverifiedBlock = unverifiedClaims.length > 0
  ? "\n### Unverified claims (" + unverifiedClaims.length + " — verifier lanes failed; neither confirmed nor refuted)\n" +
    unverifiedClaims.map((c) => "- \"" + c.claim + "\" (" + c.sourceUrl + ", " + c.erroredVotes + "/" + P.votes + " votes errored)").join("\n") +
    "\n\nMention in caveats that " + unverifiedClaims.length + " claim(s) could not be verified due to infrastructure errors."
  : "";

const report = await agent(
  "## Synthesis: research report\n\n" +
  "**Question:** " + QUESTION + "\n\n" +
  confirmed.length + " claims survived " + P.votes + "-vote adversarial verification. Merge semantic duplicates and synthesize.\n\n" +
  "### Confirmed claims\n" + confirmedBlock + "\n" + killedBlock + unverifiedBlock + "\n\n" +
  "### Instructions\n" +
  "1. Identify claims that say the same thing — merge them, combine their sources.\n" +
  "2. Group related claims into coherent findings. Each finding should directly address the research question.\n" +
  "3. Assign confidence per finding: high (multiple primary sources, unanimous votes), medium (secondary sources or split votes), low (single source or blog-quality).\n" +
  "4. Write a 3-5 sentence executive summary answering the research question.\n" +
  "5. Note caveats: what's uncertain, which sources were weak, what time-sensitivity applies.\n" +
  "6. List 2-4 open questions that emerged but weren't answered.",
  { label: "synthesize", phase: "Synthesize", tier: TIER_SYNTH, schema: REPORT_SCHEMA, readOnly: true, onFailure: "returnNull" },
);

// ---- report rendering (pure JS; no Date — the command stamps the persisted file) ----
function renderMarkdown(rep, refutedList, unverifiedList) {
  const lines = ["# Deep Research: " + QUESTION, "", "## Executive summary", "", rep.summary, "", "## Findings", ""];
  for (const f of rep.findings) {
    lines.push("### " + f.claim);
    lines.push("- **Confidence:** " + f.confidence + (f.vote ? " (vote " + f.vote + ")" : ""));
    lines.push("- **Evidence:** " + f.evidence);
    lines.push("- **Sources:** " + f.sources.join(", "));
    lines.push("");
  }
  if (rep.caveats) lines.push("## Caveats", "", rep.caveats, "");
  if (Array.isArray(rep.openQuestions) && rep.openQuestions.length) {
    lines.push("## Open questions", "");
    for (const q of rep.openQuestions) lines.push("- " + q);
    lines.push("");
  }
  if (refutedList.length) {
    lines.push("## Refuted claims (transparency)", "");
    for (const r of refutedList) lines.push("- \"" + r.claim + "\" — " + r.source + " (vote " + r.vote + ")");
    lines.push("");
  }
  if (unverifiedList.length) {
    lines.push("## Unverified claims (verifier infrastructure errors)", "");
    for (const u of unverifiedList) lines.push("- \"" + u.claim + "\" — " + u.source + " (" + u.validVotes + " valid votes)");
    lines.push("");
  }
  const st = statsBase();
  lines.push("## Method", "",
    "Depth **" + DEPTH + "**: " + st.angles + " search angles, " + st.sourcesFetched + " sources fetched, " +
    st.claimsExtracted + " claims extracted, " + st.claimsVerified + " adversarially verified (" +
    P.votes + " vote(s)/claim), " + st.confirmed + " confirmed / " + st.killed + " refuted / " + st.unverified + " unverified.");
  return lines.join("\n");
}

// ---- size-fit + artifact spill (house pattern: repo-bughunt fitWithinBudget) ----
function utf8ByteLength(value) {
  const s = String(value ?? "");
  let bytes = 0;
  for (let i = 0; i < s.length; i += 1) {
    const code = s.charCodeAt(i);
    if (code <= 0x7f) bytes += 1;
    else if (code <= 0x7ff) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && i + 1 < s.length) {
      const next = s.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) { bytes += 4; i += 1; } else bytes += 3;
    } else bytes += 3;
  }
  return bytes;
}
const jsonUtf8ByteLength = (value) => utf8ByteLength(JSON.stringify(value));

const refutedOut = killed.map(toRefuted);
const unverifiedOut = unverifiedClaims.map(toUnverified);

if (!report) {
  // Synthesis skipped/failed — salvage the verified claims raw rather than discarding the run.
  const salvage = {
    abortReason: "synthesis-failed",
    summary: "Synthesis lane failed — returning " + confirmed.length + " verified claim(s) unmerged.",
    findings: confirmed.map((c) => ({
      claim: c.claim, confidence: "medium", sources: [c.sourceUrl],
      evidence: "Survived " + P.votes + "-vote adversarial verification (vote " + (c.verdicts.length - c.refutedVotes) + "-" + c.refutedVotes + "). Quote: \"" + c.quote + "\"",
      vote: (c.verdicts.length - c.refutedVotes) + "-" + c.refutedVotes,
    })),
    refuted: refutedOut, unverified: unverifiedOut, sources: sourcesSummary,
    openQuestions: [], caveats: "Synthesis failed; findings are unmerged verified claims.",
    stats: { ...statsBase(), afterSynthesis: 0 },
    reportMarkdown: null, truncatedFindings: false, artifacts: null,
  };
  return envelope("degraded", salvage);
}

const reportMarkdown = renderMarkdown(report, refutedOut, unverifiedOut);

const artifactPayload = {
  namespace: "deep-research",
  files: [
    { name: "findings.full.json", content: JSON.stringify({ question: QUESTION, depth: DEPTH, report, confirmed, refuted: refutedOut, unverified: unverifiedOut, sources: sourcesSummary, stats: statsBase() }, null, 2) },
    { name: "sources.json", content: JSON.stringify(sourcesSummary, null, 2) },
    { name: "report.md", content: reportMarkdown },
  ],
};
let artifacts = null;
try {
  const persisted = await persistArtifacts(artifactPayload);
  artifacts = { ok: persisted.ok === true, dir: persisted.dir ?? null, files: (persisted.files ?? []).map((f) => f.name ?? f) };
  if (!artifacts.ok) await log("artifact persistence failed: " + (persisted.error ?? "unknown"));
} catch (error) {
  artifacts = { ok: false, dir: null, files: [] };
  await log("artifact persistence failed: " + (error && error.message ? error.message : String(error)));
}

const finalStatus = laneCoverage.dropped > 0 ? "degraded" : "ok";
function fitWithinBudget() {
  const LIMIT = 230000; // headroom under MAX_RESULT_BYTES (262144) for the host result wrapper
  let findingsOut = report.findings;
  let truncated = false;
  let md = reportMarkdown;
  const build = () => envelope(finalStatus, {
    summary: report.summary, findings: findingsOut,
    refuted: refutedOut, unverified: unverifiedOut, sources: sourcesSummary,
    openQuestions: report.openQuestions ?? [], caveats: report.caveats ?? "",
    stats: { ...statsBase(), afterSynthesis: report.findings.length },
    reportMarkdown: md, truncatedFindings: truncated, artifacts,
  });
  if (jsonUtf8ByteLength(build()) > LIMIT) md = null;
  while (jsonUtf8ByteLength(build()) > LIMIT && findingsOut.length > 5) {
    findingsOut = findingsOut.slice(0, Math.ceil(findingsOut.length / 2));
    truncated = true;
  }
  return build();
}
return fitWithinBudget();
