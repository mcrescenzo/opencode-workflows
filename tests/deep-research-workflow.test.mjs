// Env pin MUST precede any kernel import (GLOBAL_WORKFLOW_DIR is computed at module load).
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
process.env.OPENCODE_WORKFLOWS_DIR = await fs.mkdtemp(path.join(os.tmpdir(), "dr-empty-global-"));

const { default: test, after } = await import("node:test");
const assert = (await import("node:assert/strict")).default;
const __globalWorkflowsDir = process.env.OPENCODE_WORKFLOWS_DIR;
const { makeHarness } = await import("./helpers/harness.mjs");
const { __resetFingerprintCacheForTests } = await import("../workflow-kernel/server-fingerprint.js");

const OK_HEALTH = { data: { healthy: true, version: "1.17.13" } };
let serverSeq = 0;

// ---- scripted child-session responder ----
function textOf(input) {
  const parts = input?.body?.parts ?? [];
  return parts.map((p) => (typeof p?.text === "string" ? p.text : "")).join("\n");
}
function jsonResponse(value) {
  return { data: { parts: [{ type: "text", text: JSON.stringify(value) }], info: {} } };
}

const DEFAULT_SCOPE = {
  question: "test question",
  summary: "two angles",
  angles: [
    { label: "alpha", query: "alpha query", rationale: "broad" },
    { label: "beta", query: "beta query", rationale: "skeptical" },
    { label: "gamma", query: "gamma query", rationale: "technical" },
  ],
};
const DEFAULT_SEARCH = (text) => {
  const angle = /## Web Searcher: (\w+)/.exec(text)?.[1] ?? "x";
  return {
    results: [
      { url: `https://site-${angle}.example/a`, title: `${angle} A`, snippet: "s", relevance: "high" },
      { url: `https://site-${angle}.example/b`, title: `${angle} B`, snippet: "s", relevance: "medium" },
    ],
  };
};
const DEFAULT_EXTRACT = {
  sourceQuality: "secondary",
  publishDate: "2026-01-01",
  claims: [
    { claim: "widgets frobnicate", quote: "widgets frobnicate daily", importance: "central" },
    { claim: "gadgets rotate", quote: "gadgets rotate weekly", importance: "supporting" },
  ],
};
const DEFAULT_VERDICT = { refuted: false, evidence: "independently corroborated", confidence: "high" };
const DEFAULT_REPORT = {
  summary: "Widgets frobnicate.",
  findings: [{ claim: "widgets frobnicate", confidence: "high", sources: ["https://site-alpha.example/a"], evidence: "verified", vote: "3-0" }],
  caveats: "none",
  openQuestions: ["why do gadgets rotate?"],
};

// Error-injection fixtures MUST avoid wording that matches TRANSIENT_ERROR_PATTERNS
// (workflow-kernel/errors.js:82-98 — "rate limit", "429", "timeout", "ECONNRESET", …):
// a transient-classed lane error is retried (DEFAULT_RETRY_COUNT = 1, constants.js:99),
// which doubles child-session counts and breaks call-count assertions. "crashed"/"exploded"
// are safely terminal.
function scriptedResponder(overrides = {}) {
  return async (input) => {
    const text = textOf(input);
    if (text.includes("## Deep-Research Scope")) {
      const v = overrides.scope ?? DEFAULT_SCOPE;
      if (v instanceof Error) throw v;
      return jsonResponse(v);
    }
    if (text.includes("## Web Searcher:")) {
      const v = (overrides.search ?? DEFAULT_SEARCH)(text);
      if (v instanceof Error) throw v;
      return jsonResponse(v);
    }
    if (text.includes("## Source Extractor")) {
      const v = overrides.extract ? overrides.extract(text) : DEFAULT_EXTRACT;
      if (v instanceof Error) throw v;
      return jsonResponse(v);
    }
    if (text.includes("## Adversarial Claim Verifier")) {
      const v = overrides.verdict ? overrides.verdict(text) : DEFAULT_VERDICT;
      if (v instanceof Error) throw v;
      return jsonResponse(v);
    }
    if (text.includes("## Synthesis: research report")) {
      const v = overrides.report ?? DEFAULT_REPORT;
      if (v instanceof Error) throw v;
      return jsonResponse(v);
    }
    throw new Error("unexpected child prompt: " + text.slice(0, 160));
  };
}

async function runDeepResearch(responder, { args = { question: "test question" }, request = {}, keepDirectory = false } = {}) {
  __resetFingerprintCacheForTests();
  const serverUrl = `http://deep-research-${serverSeq++}.test`;
  const { tools, context, directory, calls } = await makeHarness(responder, {
    pluginContext: { __workflowServerHealth: OK_HEALTH, serverUrl },
  });
  try {
    const base = { name: "deep-research", args, background: false, ...request };
    const preview = await tools.workflow_run.execute(base, context);
    const hash = preview.match(/approvalHash: ([a-f0-9]{64})/);
    assert.ok(hash, `missing approvalHash in preview: ${preview}`);
    const output = await tools.workflow_run.execute({ ...base, approve: true, approvalHash: hash[1] }, context);
    // The kernel generically marks a run FAILED when the returned object carries top-level
    // status:"failed" (DRAIN_FAILURE_STATUSES check, workflow-plugin.js:1068-1071, applied to
    // every workflow at :1279) — deliberate for our honest failure envelopes. Accept both
    // terminal words; the result is readable either way.
    const runId = output.match(/Workflow ([0-9a-f-]{36}) (?:completed|failed)/);
    assert.ok(runId, `run did not finish: ${output}`);
    const status = JSON.parse(await tools.workflow_status.execute({ runId: runId[1], format: "json", detail: "result" }, context));
    // The envelope is the workflow's return value; field path confirmed against the existing
    // detail:"result" consumers (tests/plain-string-args.test.mjs:27, tests/workflow-run.test.mjs).
    const result = status.result?.output ?? status.result;
    return { result, calls, preview, ...(keepDirectory ? { directory } : {}) };
  } finally {
    if (!keepDirectory) await fs.rm(directory, { recursive: true, force: true });
  }
}

test("deep-research defaults to background via meta.recommendBackground", async () => {
  __resetFingerprintCacheForTests();
  const { tools, context, directory } = await makeHarness(scriptedResponder(), {
    pluginContext: { __workflowServerHealth: OK_HEALTH, serverUrl: `http://deep-research-${serverSeq++}.test` },
  });
  try {
    const preview = await tools.workflow_run.execute({ name: "deep-research", args: { question: "test question" } }, context);
    assert.match(preview, /Background: true/);
    assert.match(preview, /Background defaulted \(workflow-declared\)/);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("happy path: envelope, findings, stats, dedupe-free markdown", async () => {
  const { result } = await runDeepResearch(scriptedResponder());
  assert.equal(result.domain, "deep-research");
  assert.equal(result.schemaVersion, 1);
  assert.equal(result.status, "ok");
  assert.equal(result.abortReason, null);
  assert.equal(result.findings.length, 1);
  assert.equal(result.stats.angles, 3);
  assert.equal(result.stats.confirmed > 0, true);
  assert.match(result.reportMarkdown, /# Deep Research: test question/);
  assert.match(result.reportMarkdown, /## Method/);
  assert.equal(result.reportPath, null);
  assert.equal(result.laneCoverage.dropped, 0);
});

test("plain-string args become the question (CC-faithful; requires Task 1's passthrough)", async () => {
  const { result } = await runDeepResearch(scriptedResponder(), { args: "why is the sky blue?" });
  assert.equal(result.question, "why is the sky blue?");
  assert.equal(result.status, "ok");
});

test("JSON-string args are defensively parsed", async () => {
  const { result } = await runDeepResearch(scriptedResponder(), { args: JSON.stringify({ question: "test question", depth: "quick" }) });
  assert.equal(result.stats.depth, "quick");
});

test("missing question returns an explicit failed envelope without spawning lanes", async () => {
  const { result, calls } = await runDeepResearch(scriptedResponder(), { args: {} });
  assert.equal(result.status, "failed");
  assert.equal(result.abortReason, "no-question");
  assert.equal(calls.create.length, 0, "no child session may be created");
});

test("scope failure salvages to an explicit failed envelope", async () => {
  const { result } = await runDeepResearch(scriptedResponder({ scope: new Error("scope lane exploded") }));
  assert.equal(result.status, "failed");
  assert.equal(result.abortReason, "scope-failed");
});

test("all searchers empty → websearch-unavailable failed envelope, not an empty report", async () => {
  const { result } = await runDeepResearch(scriptedResponder({ search: () => ({ results: [] }) }));
  assert.equal(result.status, "failed");
  assert.equal(result.abortReason, "websearch-unavailable-or-empty");
  assert.match(result.summary, /seedUrls/);
});

test("URL dedup: identical URL across angles fetches once; dupes counted", async () => {
  const { result } = await runDeepResearch(scriptedResponder({
    search: () => ({ results: [{ url: "https://www.same.example/page/", title: "same", snippet: "s", relevance: "high" }] }),
  }));
  // 3 angles all return the same URL (www + trailing slash variants must also collapse).
  assert.equal(result.stats.sourcesFetched, 1);
  assert.equal(result.stats.urlDupes, 2);
});

test("fetch budget: medium/low results beyond maxSources are dropped and counted", async () => {
  const manyResults = (text) => {
    const angle = /## Web Searcher: (\w+)/.exec(text)?.[1] ?? "x";
    return {
      results: [1, 2, 3, 4, 5, 6].map((i) => ({
        url: `https://bulk-${angle}.example/${i}`, title: `${angle}-${i}`, snippet: "s",
        relevance: i <= 2 ? "high" : "medium",
      })),
    };
  };
  const { result } = await runDeepResearch(scriptedResponder({ search: manyResults }), {
    args: { question: "test question", maxSources: 3 },
  });
  assert.ok(result.stats.budgetDropped > 0, "must count budget-dropped results");
  assert.ok(result.stats.sourcesFetched <= 3, `explicit maxSources must be a hard cap, got ${result.stats.sourcesFetched}`);
});

test("quick depth verifies only central claims with 1-vote panels", async () => {
  let verifierCalls = 0;
  const { result } = await runDeepResearch(scriptedResponder({
    verdict: () => { verifierCalls++; return DEFAULT_VERDICT; },
  }), { args: { question: "test question", depth: "quick" } });
  assert.equal(result.stats.depth, "quick");
  // Each fetched source contributes 1 central + 1 supporting claim; quick verifies central only, 1 vote each.
  assert.equal(verifierCalls, result.stats.claimsVerified);
});

test("all claims refuted → ok envelope, zero findings, refuted list (inconclusive on merit)", async () => {
  const { result } = await runDeepResearch(scriptedResponder({
    verdict: () => ({ refuted: true, evidence: "contradicted by primary source", confidence: "high" }),
  }));
  assert.equal(result.status, "ok");
  assert.equal(result.findings.length, 0);
  assert.ok(result.refuted.length > 0);
  assert.match(result.summary, /refuted/);
});

test("verifier infra failure → failed envelope flagged as infrastructure, not refutation", async () => {
  const { result } = await runDeepResearch(scriptedResponder({
    verdict: () => new Error("verifier lane crashed"),
  }));
  assert.equal(result.status, "failed");
  assert.equal(result.abortReason, "verifiers-failed");
  assert.ok(result.unverified.length > 0);
  assert.match(result.summary, /infrastructure/);
});

test("synthesis failure salvages confirmed claims unmerged (degraded)", async () => {
  const { result } = await runDeepResearch(scriptedResponder({ report: new Error("synth exploded") }));
  assert.equal(result.status, "degraded");
  assert.equal(result.abortReason, "synthesis-failed");
  assert.ok(result.findings.length > 0, "verified claims must be salvaged as findings");
});

test("seedUrls are fetched without search lanes when search is empty", async () => {
  const { result } = await runDeepResearch(scriptedResponder({ search: () => ({ results: [] }) }), {
    args: { question: "test question", seedUrls: ["https://seed.example/doc"] },
  });
  assert.equal(result.status, "ok");
  assert.equal(result.stats.sourcesFetched, 1);
});

test("authority narrowing: scope lane denies webfetch/websearch; search lanes allow them", async () => {
  const { calls } = await runDeepResearch(scriptedResponder());
  assert.ok(calls.create.length >= 2, "expected multiple child sessions");
  const ruleAction = (createCall, permission) => {
    const rules = JSON.stringify(createCall);
    const m = new RegExp(`"permission":"${permission}"[^}]*"action":"(allow|deny)"`).exec(rules);
    return m?.[1];
  };
  // The scope lane is the first child created (sequential await before the pipeline).
  assert.equal(ruleAction(calls.create[0], "webfetch"), "deny", "scope lane must be narrowed read-only");
  assert.equal(ruleAction(calls.create[1], "webfetch"), "allow", "search/fetch lanes must carry network authority");
});

test("scope fitWarning surfaces in envelope, caveats, and report", async () => {
  const warn = "This question targets the local repository; public web search cannot see it.";
  const { result } = await runDeepResearch(scriptedResponder({ scope: { ...DEFAULT_SCOPE, fitWarning: warn } }));
  assert.equal(result.fitWarning, warn);
  assert.ok(result.caveats.startsWith(warn), "fitWarning must prefix caveats");
  assert.match(result.reportMarkdown, /## Caveats/);
  assert.ok(result.reportMarkdown.includes(warn));
});

test("fitWarning defaults to null and does not disturb caveats", async () => {
  const { result } = await runDeepResearch(scriptedResponder());
  assert.equal(result.fitWarning, null);
  assert.equal(result.caveats, "none"); // DEFAULT_REPORT.caveats untouched
});

test("verifier prompt: local-file sources get read-directly guidance, not websearch default-refute", async () => {
  const prompts = [];
  const { result } = await runDeepResearch(scriptedResponder({
    search: () => ({ results: [] }),
    verdict: (text) => { prompts.push(text); return DEFAULT_VERDICT; },
  }), { args: { question: "test question", seedUrls: ["workflow-kernel/notification-toast.js"] } });
  assert.equal(result.status, "ok");
  assert.ok(prompts.length > 0);
  for (const p of prompts) {
    assert.match(p, /^## Adversarial Claim Verifier/);
    assert.match(p, /Local source — read it directly/);
    assert.match(p, /Use the Read or Grep tool/);
    assert.doesNotMatch(p, /Use the websearch tool to look for contradicting evidence/);
    assert.match(p, /absence of public web-search results.*NOT grounds for refuting/s);
  }
});

test("verifier prompt: web sources keep the websearch cross-check", async () => {
  const prompts = [];
  await runDeepResearch(scriptedResponder({ verdict: (text) => { prompts.push(text); return DEFAULT_VERDICT; } }));
  for (const p of prompts) {
    assert.match(p, /Use the websearch tool to look for contradicting evidence/);
    assert.doesNotMatch(p, /Local source — read it directly/);
  }
});

test("a crashed fetch lane registers as a Fetch drop and degrades the run", async () => {
  const { result } = await runDeepResearch(scriptedResponder({
    extract: (text) => text.includes("site-alpha.example/a") ? new Error("extract lane crashed") : DEFAULT_EXTRACT,
  }));
  assert.equal(result.status, "degraded");
  assert.equal(result.laneCoverage.byPhase.Fetch.dropped, 1);
  assert.ok(result.laneCoverage.byPhase.Fetch.expected >= 2);
  assert.equal(result.stats.fetchFailures, 1);
  assert.ok(result.laneCoverage.droppedLabels.some((l) => l.startsWith("fetch:")));
});

test("quick depth with zero central claims aborts as no-central-claims, not no-claims-extracted", async () => {
  const supportingOnly = {
    ...DEFAULT_EXTRACT,
    claims: [
      { claim: "widgets frobnicate", quote: "q1", importance: "supporting" },
      { claim: "gadgets rotate", quote: "q2", importance: "tangential" },
    ],
  };
  const { result } = await runDeepResearch(scriptedResponder({ extract: () => supportingOnly }), {
    args: { question: "test question", depth: "quick" },
  });
  assert.equal(result.status, "failed");
  assert.equal(result.abortReason, "no-central-claims");
  assert.ok(result.stats.claimsExtracted > 0, "extracted claims must be counted honestly");
  assert.match(result.summary, /central/);
  assert.doesNotMatch(result.summary, /all empty/);
});

test("claims beyond the verify cap are counted and spilled to artifacts", async () => {
  const fiveClaims = {
    ...DEFAULT_EXTRACT,
    claims: [1, 2, 3, 4, 5].map((i) => ({ claim: `claim ${i}`, quote: `quote ${i}`, importance: "central" })),
  };
  // 3 angles × 2 sources × 5 claims = 30 extracted; quick verifyCap=8 → 22 dropped by cap.
  const { result } = await runDeepResearch(scriptedResponder({ extract: () => fiveClaims }), {
    args: { question: "test question", depth: "quick" },
  });
  assert.equal(result.stats.claimsDroppedByCap, 22);
  assert.match(result.reportMarkdown, /lower-priority claim\(s\) were extracted but not verified/);
});

test("synthesis title drives the report H1; long titles truncate", async () => {
  const { result } = await runDeepResearch(scriptedResponder({
    report: { ...DEFAULT_REPORT, title: "Widget Frobnication Works" },
  }));
  assert.match(result.reportMarkdown, /# Deep Research: Widget Frobnication Works/);
  const { result: longRun } = await runDeepResearch(scriptedResponder({
    report: { ...DEFAULT_REPORT, title: "x".repeat(80) },  // maxLength-valid, render still bounds it
  }));
  assert.match(longRun.reportMarkdown, /# Deep Research: x{77}…|# Deep Research: x{80}/);
});

test("title-absent long question is bounded to 80 chars in the H1 (not byte-identical to today)", async () => {
  // Regression for the corrected Interfaces claim: with no title the fallback is QUESTION,
  // which today is emitted untruncated; the new render bounds it to 80 chars (77 + ellipsis).
  const longQ = "z".repeat(200);
  const { result } = await runDeepResearch(scriptedResponder(), { args: { question: longQ } });
  assert.match(result.reportMarkdown, /# Deep Research: z{77}…/);
  assert.ok(!result.reportMarkdown.includes("z".repeat(90)), "the H1 must not carry the full over-long question");
});

test("single-vote depths annotate the Method section", async () => {
  const { result } = await runDeepResearch(scriptedResponder(), { args: { question: "test question", depth: "normal" } });
  assert.match(result.reportMarkdown, /single-vote verification/);
});

test("oversized refuted set is trimmed and sets truncatedFindings=true", async () => {
  // Amendment: size MUST live in `claim` (toRefuted drops quote), and each source respects
  // EXTRACT_SCHEMA maxItems:5. 6 sources × 5 large (~11 KB) central claims = 30 claims;
  // thorough verifyCap=25 → 25 verified. Refute 24, keep 1 confirmed → refutedOut (~24 × 11 KB
  // ≈ 265 KB) blows past fitWithinBudget's 230000 LIMIT even after reportMarkdown is nulled,
  // so the refuted trim loop (floor 5) must engage and truncatedFindings must read true.
  const bigExtract = (text) => {
    const m = /\*\*URL:\*\* ([^\s]+)/.exec(text);
    const url = m ? m[1] : "";
    return {
      ...DEFAULT_EXTRACT,
      claims: [0, 1, 2, 3, 4].map((i) => ({
        claim: (url === "https://site-alpha.example/a" && i === 0 ? "SURVIVE " : "") + "claim " + i + " " + "y".repeat(11000),
        quote: "q",
        importance: "central",
      })),
    };
  };
  const { result } = await runDeepResearch(scriptedResponder({
    extract: bigExtract,
    verdict: (text) => text.includes("SURVIVE") ? DEFAULT_VERDICT : { refuted: true, evidence: "contradicted by primary source", confidence: "high" },
  }), { args: { question: "test question", depth: "thorough" } });
  assert.equal(result.truncatedFindings, true, "trimming the refuted array must set truncatedFindings");
  assert.ok(result.refuted.length >= 5, "the floor of 5 refuted must be respected");
  assert.ok(JSON.stringify(result).length < 262144, "the envelope must fit under MAX_RESULT_BYTES after trimming");
});

test("oversized unverified set is trimmed and sets truncatedFindings=true (sibling)", async () => {
  // Same claim volume, but verifier lanes CRASH (non-transient — see errors.js: "crashed" is
  // terminal, not retried) for every claim except the SURVIVE claim → 24 claims land in
  // unverifiedClaims (erroredVotes), not killed. confirmed.length === 1 avoids both the
  // verifiers-failed and all-refuted early returns so fitWithinBudget runs and the unverified
  // trim loop (floor 5) engages.
  const bigExtract = (text) => {
    const m = /\*\*URL:\*\* ([^\s]+)/.exec(text);
    const url = m ? m[1] : "";
    return {
      ...DEFAULT_EXTRACT,
      claims: [0, 1, 2, 3, 4].map((i) => ({
        claim: (url === "https://site-alpha.example/a" && i === 0 ? "SURVIVE " : "") + "claim " + i + " " + "y".repeat(11000),
        quote: "q",
        importance: "central",
      })),
    };
  };
  const { result } = await runDeepResearch(scriptedResponder({
    extract: bigExtract,
    verdict: (text) => text.includes("SURVIVE") ? DEFAULT_VERDICT : new Error("verifier lane crashed"),
  }), { args: { question: "test question", depth: "thorough" } });
  assert.equal(result.truncatedFindings, true, "trimming the unverified array must set truncatedFindings");
  assert.ok(result.unverified.length >= 5, "the floor of 5 unverified must be respected");
  assert.ok(JSON.stringify(result).length < 262144, "the envelope must fit under MAX_RESULT_BYTES after trimming");
});

test("artifact files mask token-shaped strings from fetched content", async () => {
  // The secret rides in a REFUTED claim's text: toRefuted keeps `claim`, so it lands in BOTH
  // report.md (Refuted-claims transparency section) and findings.full.json (refuted array).
  // A clean co-claim survives so the run reaches synthesis + artifact persistence. The artifact
  // files live under the harness temp dir, so keepDirectory holds them until this test reads them.
  const leaky = "creds AKIAABCDEFGHIJKLMNOP and sk-abcdefghijklmnopqrstuv";
  const { result, directory } = await runDeepResearch(scriptedResponder({
    extract: () => ({
      ...DEFAULT_EXTRACT,
      claims: [
        { claim: "clean claim", quote: "q", importance: "central" },
        { claim: leaky, quote: "q", importance: "central" },
      ],
    }),
    verdict: (text) => text.includes("AKIA") ? { refuted: true, evidence: "contradicted by primary source", confidence: "high" } : DEFAULT_VERDICT,
  }), { keepDirectory: true });
  try {
    assert.equal(result.artifacts?.ok, true, "artifacts must persist in the harness");
    const reportMd = await fs.readFile(path.join(result.artifacts.dir, "report.md"), "utf8");
    const fullJson = await fs.readFile(path.join(result.artifacts.dir, "findings.full.json"), "utf8");
    for (const content of [reportMd, fullJson]) {
      assert.doesNotMatch(content, /AKIAABCDEFGHIJKLMNOP/);
      assert.doesNotMatch(content, /sk-abcdefghijklmnopqrstuv/);
      assert.match(content, /\[redacted\]/);
    }
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

// Clean up the empty-global-registry temp dir pinned at module load (mirrors the top-level
// after() teardown convention in tests/multi-process-durability.test.mjs).
after(async () => {
  await fs.rm(__globalWorkflowsDir, { recursive: true, force: true });
});
