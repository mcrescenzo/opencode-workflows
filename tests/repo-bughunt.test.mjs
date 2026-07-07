// repo-bughunt bundled workflow regression suite.
//
// Zero-token: every child session.prompt is routed to a canned payload by the
// shared test harness (tests/helpers/harness.mjs); no real model is ever called.
//
// Covers:
//   - Task 1: happy path (find -> verify -> rank -> envelope)
//   - Task 2: verify depth profiles (thorough 3-skeptic majority; quick high-only)
//   - Task 3: resilience (lane failure -> returnNull; all-refuted -> empty; size-fit)
//   - Task 4: fingerprint determinism (sentinel extraction)
//   - Task 5: bundled name-resolution / discovery
//   - Fallback path: native structured output UNAVAILABLE -> structured-text fallback
//     still yields the correct ranked envelope (reconciliation of the stale plan doc).

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { makeHarness, DEFAULT_CAPABILITIES } from "./helpers/harness.mjs";

// ---- approval/result helpers (operate on the shared harness tool surface) ----

async function runApprovedRequest(tools, context, request) {
  const preview = await tools.workflow_run.execute(request, context);
  const match = preview.match(/approvalHash: ([a-f0-9]{64})/);
  assert.ok(match, `missing approvalHash in preview: ${preview}`);
  return await tools.workflow_run.execute({ ...request, approve: true, approvalHash: match[1] }, context);
}

function runIdFrom(output) {
  const match = output.match(/Workflow ([0-9a-f-]{36}) (?:completed|started|awaiting diff approval)/);
  assert.ok(match, `missing run id in output: ${output}`);
  return match[1];
}

async function resultOutput(tools, context, runOutput) {
  const runId = runIdFrom(runOutput);
  const status = JSON.parse(await tools.workflow_status.execute({ runId, format: "json", detail: "result" }, context));
  assert.equal(status.status, "completed", `run not completed: ${JSON.stringify(status)}`);
  return status.result.output;
}

// ---- response shapers ----

// Canonical OpenCode NATIVE structured-output response shape (data.info.structured).
function structured(obj) {
  return { data: { parts: [{ type: "text", text: "ok" }], info: { structured: obj, tokens: { input: 1, output: 1, reasoning: 0 }, cost: 0 } } };
}

// Structured-TEXT FALLBACK response shape: the JSON object is carried in a text
// part (data.parts[].text) and parsed back by parseStructuredTextResult. Used
// when run.capabilities.structuredOutput !== "available" (child-agent-runner.js
// injects structuredTextInstruction into the system prompt and sets
// outputFormat: { type: "text" }).
function textStructured(obj) {
  return { data: { parts: [{ type: "text", text: JSON.stringify(obj) }], info: { tokens: { input: 1, output: 1, reasoning: 0 }, cost: 0 } } };
}

// Routes each child prompt to a canned NATIVE structured payload. override(text)
// may return a response (or throw) to customize a specific lane.
function bughuntPrompt(override) {
  return async (input) => {
    const text = String(input?.body?.parts?.[0]?.text ?? "");
    if (override) {
      const r = override(text);
      if (r !== undefined) return r;
    }
    return defaultLane(text, structured);
  };
}

// Same routing, but every canned payload is delivered as a TEXT response (the
// structured-text fallback path). Proves the fallback parse path.
function bughuntTextPrompt(override) {
  return async (input) => {
    const text = String(input?.body?.parts?.[0]?.text ?? "");
    if (override) {
      const r = override(text);
      if (r !== undefined) return r;
    }
    return defaultLane(text, textStructured);
  };
}

function defaultLane(text, shape) {
  if (text.includes("Profile this repository")) {
    return shape({ languages: ["javascript"], notes: "test repo" });
  }
  if (text.includes("bug finder")) {
    const m = text.match(/the "([a-z-]+)" bug finder/);
    const cat = m ? m[1] : "concurrency";
    return shape({ findings: [{
      category: cat, file: `src/${cat}.js`, line: 10, severity: "high",
      description: `${cat} bug example`, reproSketch: "call it with edge input", fixSketch: "guard the path",
      proposedChange: "add a guard", confidence: 80, effort: "small", docImpact: "",
    }] });
  }
  if (text.includes("You are a skeptic")) {
    const refuted = text.includes("boundary"); // refute exactly the boundary finding
    return shape({ refuted, reasoning: "test verdict", adjustedConfidence: refuted ? 10 : 75 });
  }
  return { data: { parts: [], info: {} } };
}

// ---- Task 1: happy path ----

test("repo-bughunt happy path: finds, verifies, ranks, returns envelope", async () => {
  const { tools, context, directory } = await makeHarness(bughuntPrompt());
  try {
    const out = await runApprovedRequest(tools, context, { name: "repo-bughunt", args: { depth: "normal" } });
    const env = await resultOutput(tools, context, out);

    assert.equal(env.domain, "bughunt");
    assert.equal(env.schemaVersion, 1);
    assert.equal(env.status, "ok");
    // 7 lenses x 1 finding each = 7 candidates; the boundary one is refuted -> 6 survive.
    assert.equal(env.counts.total, 6);
    assert.equal(env.counts.high, 6);
    assert.equal(env.counts.critical, 0);
    assert.ok(env.findings.every((f) => typeof f.fingerprint === "string" && f.fingerprint.startsWith("bughunt-")));
    assert.ok(env.findings.every((f, i) => f.rank === i + 1));
    assert.ok(!env.findings.some((f) => f.category === "boundary"), "refuted boundary finding must be dropped");
    assert.match(env.reportMarkdown, /# Bug Hunt Report/);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

// ---- Task 2: verify depth profiles ----

test("repo-bughunt thorough depth uses 3-skeptic majority (1 refute keeps finding)", async () => {
  // In thorough mode each finding gets 3 skeptics; keep unless >=2 refute. Make ONLY reviewer #1 refute.
  const override = (text) => {
    if (text.includes("You are a skeptic") && text.includes("Independent reviewer #1")) {
      return structured({ refuted: true, reasoning: "lone refute", adjustedConfidence: 10 });
    }
    return undefined; // fall through: reviewers #2/#3 use the default (boundary refuted, others kept)
  };
  const { tools, context, directory } = await makeHarness(bughuntPrompt(override));
  try {
    const out = await runApprovedRequest(tools, context, { name: "repo-bughunt", args: { depth: "thorough" } });
    const env = await resultOutput(tools, context, out);
    // boundary: reviewers #1 (override) + #2/#3 (default refute boundary) => 3 refutes => dropped.
    // every other category: only reviewer #1 refutes => 1 < 2 => kept. 7 lenses, boundary dropped => 6.
    // thorough also runs a 2nd find round (dedup removes the identical repeats) => still 7 candidates.
    assert.equal(env.counts.total, 6);
    assert.ok(!env.findings.some((f) => f.category === "boundary"));
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("repo-bughunt quick depth only verifies high-severity candidates", async () => {
  // All mocked findings are high-severity, so quick verifies all of them; boundary refuted => 6 remain.
  const { tools, context, directory } = await makeHarness(bughuntPrompt());
  try {
    const out = await runApprovedRequest(tools, context, { name: "repo-bughunt", args: { depth: "quick" } });
    const env = await resultOutput(tools, context, out);
    assert.equal(env.counts.total, 6);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

// ---- Task 3: resilience + size-fitting ----

test("repo-bughunt survives a finder lane failure (onFailure returnNull + filter)", async () => {
  const override = (text) => {
    if (text.includes('the "concurrency" bug finder')) throw new Error("simulated lane crash");
    return undefined;
  };
  const { tools, context, directory } = await makeHarness(bughuntPrompt(override));
  try {
    const out = await runApprovedRequest(tools, context, { name: "repo-bughunt", args: { depth: "normal" } });
    const env = await resultOutput(tools, context, out);
    // concurrency finder crashed -> dropped. 6 lenses produce findings; boundary refuted -> 5 survive.
    assert.equal(env.status, "ok");
    assert.equal(env.counts.total, 5);
    assert.ok(!env.findings.some((f) => f.category === "concurrency"));
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("repo-bughunt returns empty envelope when every candidate is refuted", async () => {
  const override = (text) => {
    if (text.includes("You are a skeptic")) return structured({ refuted: true, reasoning: "all refuted", adjustedConfidence: 5 });
    return undefined;
  };
  const { tools, context, directory } = await makeHarness(bughuntPrompt(override));
  try {
    const out = await runApprovedRequest(tools, context, { name: "repo-bughunt", args: { depth: "normal" } });
    const env = await resultOutput(tools, context, out);
    assert.equal(env.status, "empty");
    assert.equal(env.counts.total, 0);
    assert.equal(env.findings.length, 0);
    assert.equal(env.reportMarkdown, null);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("repo-bughunt size-fits a large finding set under the 256KB cap", async () => {
  // Each finder returns many large findings; the returned envelope must stay serializable (run completes,
  // not aborted by assertResultSize). With many distinct lines, dedup keeps them all.
  // Per-lens count is bounded so the total agent count (1 recon + 7 finders + 105 skeptics = 113)
  // stays under the workflow's maxAgents ceiling; lanes past that ceiling are dropped via
  // onFailure returnNull, which would silently lose findings and undercount. 105 findings at ~8KB
  // each (~870KB) still amply exceeds the 256KB cap, so truncation is fully exercised.
  const PER_LENS = 15;
  const big = "x".repeat(2000);
  const override = (text) => {
    if (text.includes("bug finder")) {
      const m = text.match(/the "([a-z-]+)" bug finder/);
      const cat = m ? m[1] : "concurrency";
      const findings = [];
      for (let i = 0; i < PER_LENS; i++) {
        findings.push({
          category: cat, file: `src/${cat}-${i}.js`, line: i + 1, severity: "low",
          description: `${cat} ${i} ${big}`, reproSketch: big, fixSketch: big, proposedChange: big,
          confidence: 50, effort: "large", docImpact: "",
        });
      }
      return structured({ findings });
    }
    if (text.includes("You are a skeptic")) return structured({ refuted: false, reasoning: "keep", adjustedConfidence: 50 });
    return undefined;
  };
  const { tools, context, directory } = await makeHarness(bughuntPrompt(override));
  try {
    const out = await runApprovedRequest(tools, context, { name: "repo-bughunt", args: { depth: "normal", maxReturnFindings: 200 } });
    const env = await resultOutput(tools, context, out);
    assert.equal(env.status, "ok");
    // counts reflect ALL findings (7 lenses x 15 = 105), but the returned findings array is truncated to fit.
    assert.equal(env.counts.total, 7 * PER_LENS);
    assert.ok(env.truncatedFindings === true);
    assert.ok(JSON.stringify(env).length < 262144, "returned envelope must be under the host result cap");
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

// ---- Task 4: fingerprint determinism (sentinel extraction) ----

test("fingerprintOf is deterministic and line-independent", async () => {
  const wfPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "workflows", "repo-bughunt.js");
  const src = await fs.readFile(wfPath, "utf8");
  const m = src.match(/\/\/ <suite:fingerprintOf>([\s\S]*?)\/\/ <\/suite:fingerprintOf>/);
  assert.ok(m, "fingerprintOf sentinel block not found");
  // Extract the pure function; supply DOMAIN that the function closes over.
  const fingerprintOf = new Function("DOMAIN", `${m[1]}; return fingerprintOf;`)("bughunt");

  const a = { file: "src/x.js", category: "boundary", description: "Off by one in   loop", line: 10 };
  // NOTE: fingerprintOf normalizes case + whitespace in each field, and excludes `line` from the
  // basis, but it does NOT strip path prefixes (so "./src/x.js" != "src/x.js"). Keep b on the SAME
  // path as a so the collision proves line-exclusion + description normalization (the stated intent),
  // not an accidental path-prefix difference.
  const b = { file: "src/x.js", category: "boundary", description: "off by one in loop", line: 999 };
  assert.equal(fingerprintOf(a), fingerprintOf({ ...a }), "same input must hash identically");
  assert.match(fingerprintOf(a), /^bughunt-[0-9a-f]+$/);
  // line is excluded from the basis; whitespace/case normalized -> a and b collide by design.
  assert.equal(fingerprintOf({ file: "src/x.js", category: "boundary", description: "off by one in loop" }), fingerprintOf(b));
});

// ---- Task 5: bundled discovery / name resolution ----

test("repo-bughunt is discoverable as a bundled workflow and resolves by name", async () => {
  const { tools, context, directory } = await makeHarness(bughuntPrompt());
  try {
    const listed = JSON.parse(await tools.workflow_list.execute({ format: "json" }, context));
    assert.ok(listed.some((e) => e.scope === "bundled" && e.name === "repo-bughunt"),
      `repo-bughunt not listed as bundled: ${JSON.stringify(listed)}`);

    // Preview by name must resolve the bundled source and show the read-only profile.
    const preview = await tools.workflow_run.execute({ name: "repo-bughunt", args: { depth: "quick" } }, context);
    assert.match(preview, /Authority profile: read-only-review/);
    assert.match(preview, /approvalHash: [a-f0-9]{64}/);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

// ---- Structured-text fallback (native structured output UNAVAILABLE) ----
//
// Reconciliation of the stale plan doc: schema lanes do NOT fail closed when
// native structured output is unavailable. The kernel instead injects a
// structured-text instruction and parses the model's JSON text back
// (child-agent-runner.js: structuredTextInstruction -> outputFormat text ->
// parseStructuredTextResult). This test forces that path by marking
// structuredOutput "unavailable" and returning text-shaped responses, then
// asserts the workflow still produces the correct ranked envelope.

test("repo-bughunt works under the structured-text fallback when native structured output is unavailable", async () => {
  const { tools, context, directory } = await makeHarness(bughuntTextPrompt(), {
    capabilities: { ...DEFAULT_CAPABILITIES, structuredOutput: "unavailable" },
  });
  try {
    const out = await runApprovedRequest(tools, context, { name: "repo-bughunt", args: { depth: "normal" } });
    const env = await resultOutput(tools, context, out);

    // Same ranked envelope as the native happy path: boundary refuted -> 6 survive.
    assert.equal(env.domain, "bughunt");
    assert.equal(env.status, "ok");
    assert.equal(env.counts.total, 6);
    assert.equal(env.counts.high, 6);
    assert.ok(!env.findings.some((f) => f.category === "boundary"), "boundary must still be refuted via the fallback path");
    assert.ok(env.findings.every((f) => f.fingerprint.startsWith("bughunt-")));
    assert.ok(env.findings.every((f, i) => f.rank === i + 1));
    assert.match(env.reportMarkdown, /# Bug Hunt Report/);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
