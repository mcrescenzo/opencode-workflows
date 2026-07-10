// Free-text secret redaction for user-visible display paths.
//
// Proves the shared redactFreeTextSecrets masks common credential-like VALUES embedded in
// prose, and that each user-visible display boundary (salvage preview snippet, lane
// taskSummary/title/errorSummary derivation, compact status text, and notification toast text)
// applies it BEFORE truncation so a model that pasted a raw token cannot leak.
//
// SCANNER-SAFE FIXTURES: every synthetic credential below is assembled at RUNTIME from
// concatenated pieces (join/repeat) so that NO full literal fake token (provider-prefixed,
// AWS-key-shaped, or bearer-header-shaped) ever appears in this tracked source file. None of
// these are real credentials. The redaction assertions still FAIL if the redactor leaks an
// assembled value: each asserts the assembled synthetic string does NOT appear in the
// redacted/displayed output.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { redactFreeTextSecrets, REDACTED_PLACEHOLDER } from "../workflow-kernel/free-text-redactor.js";
import { laneTaskSummary } from "../workflow-kernel/child-agent-runner.js";
import {
  compactStatusForEntry,
  summarizeEntries,
} from "../workflow-kernel/run-store-status-format.js";
import {
  workflowHeartbeatToastCard,
} from "../workflow-kernel/notification-toast.js";
import WorkflowPlugin from "../workflow-kernel/index.js";

const { __test } = WorkflowPlugin;
const salvageRun = __test.salvageRun;

// ---- scanner-safe synthetic credentials (assembled at runtime; none are real) ----
// OpenAI-style provider token: sk-proj-<20 a's>BcDeFg123
const skToken = ["sk-", "proj", "-", "a".repeat(20), "BcDeFg123"].join("");
// Bearer token value (the part after the "Bearer " keyword): assembled JWT-ish prefix + padding.
const bearerValue = ["ey", "J", "h".repeat(40)].join("");
// Full bearer header as it might appear in prose: assembled at runtime (scanner-safe).
const bearerHeader = ["Bear", "er ", bearerValue].join("");
// AWS access key id: AKIA + I + 16 K's + QABCD  (= AKIA + 22 chars)
const awsKey = ["AK", "IA", "I" + "K".repeat(16) + "QABCD"].join("");
// A generic secret assignment value long enough to clear the 8-char minimum.
const secretValue = ["super", "_", "secret", "_", "v", "9".repeat(12)].join("");
// A second generic assignment value (api_key) reusing the sk shape in a JSON-ish context.
const apiKeyValue = ["api", "key", "val", "Zy".repeat(8)].join("_");
// Punctuation-bearing assignment value; prior positive char classes missed this shape.
const punctuationSecretValue = ["P@ss", "w0rd!", "2024#Prod"].join("");
// Provider tokens with underscore separators; prior provider token matching required hyphens.
const githubUnderscoreToken = ["ghp_", "A".repeat(30)].join("");
const stripeUnderscoreToken = ["sk_live_", "B".repeat(28)].join("");
// Truncated PEM block; prior PEM matching required an END marker.
const truncatedPem = ["-----BEGIN ", "PRIVATE KEY-----\n", "MII", "C".repeat(64)].join("");

const PLACEHOLDER = REDACTED_PLACEHOLDER; // "[REDACTED:secret]"

// ===========================================================================
// 1. UNIT: the redactor masks each credential family and preserves plain prose
// ===========================================================================

test("redactFreeTextSecrets masks an sk-style provider token (internal hyphens included) and keeps surrounding prose", () => {
  const src = `Recovered an OpenAI key ${skToken} while scanning config/prod.env.`;
  const out = redactFreeTextSecrets(src);
  assert.ok(!out.includes(skToken), "assembled sk token must not survive redaction");
  assert.ok(out.includes(PLACEHOLDER), "masked token must carry the placeholder");
  assert.ok(out.includes("Recovered an OpenAI key"), "surrounding prose is preserved");
  assert.ok(out.includes("config/prod.env"), "non-secret path text is preserved");
});

test("redactFreeTextSecrets masks only the Bearer token portion, preserving the keyword", () => {
  const src = `Authorization: ${bearerHeader} sent to the upstream.`;
  const out = redactFreeTextSecrets(src);
  assert.ok(!out.includes(bearerValue), "assembled bearer token value must not survive redaction");
  assert.ok(!out.includes(bearerHeader), "full 'Bearer <token>' must not survive redaction");
  assert.ok(out.includes(PLACEHOLDER), "masked token must carry the placeholder");
  // The "Bearer " keyword is preserved for readability; only the value is masked.
  assert.ok(/Bearer\s/.test(out) || /bearer\s/i.test(out), "the bearer keyword is preserved");
});

test("redactFreeTextSecrets masks only the Basic credential portion, preserving the keyword", () => {
  const secret = "QWxhZGRpbjpvcGVuIHNlc2FtZQ==";
  const out = redactFreeTextSecrets(`Authorization: Basic ${secret}`);
  assert.ok(!out.includes(secret), "basic credential value masked");
  assert.match(out, /Basic\s+\[REDACTED:secret\]/);
});

test("redactFreeTextSecrets masks an AWS access key id", () => {
  const src = `AWS_ACCESS_KEY_ID is ${awsKey} per the deployment notes.`;
  const out = redactFreeTextSecrets(src);
  assert.ok(!out.includes(awsKey), "assembled AWS access key must not survive redaction");
  assert.ok(out.includes(PLACEHOLDER));
  assert.ok(out.includes("deployment notes"), "non-secret prose is preserved");
});

test("redactFreeTextSecrets masks aws_secret_access_key / aws_access_key_id assignments (env + colon styles)", () => {
  const envSrc = `export aws_secret_access_key=${secretValue}`;
  const colonSrc = `aws_access_key_id: ${awsKey}`;
  assert.ok(!redactFreeTextSecrets(envSrc).includes(secretValue), "aws_secret_access_key= value masked");
  assert.ok(!redactFreeTextSecrets(colonSrc).includes(awsKey), "aws_access_key_id: value masked");
});

test("redactFreeTextSecrets masks generic key=value / key: value / JSON-ish secret assignments", () => {
  const cases = [
    [`secret=${secretValue}`, secretValue],
    [`api_key: ${apiKeyValue}`, apiKeyValue],
    [`password="${secretValue}"`, secretValue],
    [`"token":"${apiKeyValue}"`, apiKeyValue],
    [`access_token = ${secretValue}`, secretValue],
    [`refresh_token:${apiKeyValue}`, apiKeyValue],
  ];
  for (const [src, secret] of cases) {
    const out = redactFreeTextSecrets(src);
    assert.ok(!out.includes(secret), `secret must be masked in: ${src}`);
    assert.ok(out.includes(PLACEHOLDER), `placeholder present for: ${src}`);
  }
});

test("redactFreeTextSecrets masks punctuation assignments, underscore provider tokens, and truncated PEM blocks", () => {
  const cases = [
    [`password=${punctuationSecretValue}`, punctuationSecretValue],
    [`token: "${punctuationSecretValue}"`, punctuationSecretValue],
    [`github token ${githubUnderscoreToken}`, githubUnderscoreToken],
    [`stripe token ${stripeUnderscoreToken}`, stripeUnderscoreToken],
    [`pem ${truncatedPem}`, truncatedPem],
  ];
  for (const [src, secret] of cases) {
    const out = redactFreeTextSecrets(src);
    assert.ok(!out.includes(secret), `secret must be masked in: ${src.slice(0, 24)}`);
    assert.ok(out.includes(PLACEHOLDER), `placeholder present for: ${src.slice(0, 24)}`);
  }
});

test("redactFreeTextSecrets preserves the key name and separator in an assignment (only the value is masked)", () => {
  const out = redactFreeTextSecrets(`api_key=${apiKeyValue}`);
  assert.ok(out.startsWith("api_key="), "key + separator preserved");
  assert.ok(!out.includes(apiKeyValue));
});

test("redactFreeTextSecrets does NOT redact plain prose or short common words (no false positives)", () => {
  const plain = "The secret to a good token review is checking the password policy and api surface.";
  assert.equal(redactFreeTextSecrets(plain), plain, "prose without an assignment/value is untouched");
  // Short bare values below the 8-char minimum are not masked.
  assert.equal(redactFreeTextSecrets("token: abc"), "token: abc", "sub-minimum value is not masked");
  assert.equal(redactFreeTextSecrets("see https://example.com/path"), "see https://example.com/path");
});

test("redactFreeTextSecrets is idempotent (running twice === once) and does not redact the placeholder itself", () => {
  const src = `keys: ${skToken} and ${bearerHeader} and aws=${awsKey} secret=${secretValue}`;
  const once = redactFreeTextSecrets(src);
  const twice = redactFreeTextSecrets(once);
  assert.equal(twice, once, "second pass must not change the already-masked text");
  assert.ok(!once.includes(skToken) && !once.includes(bearerValue) && !once.includes(awsKey) && !once.includes(secretValue));
  // The placeholder contains the word "secret" but must not be treated as an assignment value.
  assert.equal(redactFreeTextSecrets(PLACEHOLDER), PLACEHOLDER, "placeholder is not self-redacted");
});

test("redactFreeTextSecrets returns non-string / empty inputs as-is (defensive)", () => {
  assert.equal(redactFreeTextSecrets(""), "");
  assert.equal(redactFreeTextSecrets(null), null);
  assert.equal(redactFreeTextSecrets(undefined), undefined);
  assert.equal(redactFreeTextSecrets(42), 42);
});

test("redactFreeTextSecrets masks multiple distinct secrets in one block of prose", () => {
  // Each secret is in a detectable context: shaped tokens, or a recognized assignment key.
  const src = [`found ${skToken}`, `bearer ${bearerValue}`, `aws ${awsKey}`, `secret=${secretValue}`].join(" | ");
  const out = redactFreeTextSecrets(src);
  for (const secret of [skToken, bearerValue, awsKey, secretValue]) {
    assert.ok(!out.includes(secret), `secret must be masked: ${secret.slice(0, 6)}...`);
  }
});

// ===========================================================================
// 2. INTEGRATION: each user-visible DISPLAY path applies masking before truncation
// ===========================================================================

test("laneTaskSummary masks a secret embedded in the prompt-derived summary", () => {
  const summary = laneTaskSummary(`audit the repo using key ${skToken}`, {}, "workflow lane");
  assert.ok(!summary.includes(skToken), "taskSummary must not leak the sk token");
  assert.ok(summary.includes(PLACEHOLDER));
});

test("laneTaskSummary masks a secret in an explicit opts.label-derived title", () => {
  const summary = laneTaskSummary("ignored", { label: `scan with aws ${awsKey}` }, "fallback");
  assert.ok(!summary.includes(awsKey), "explicit label summary must not leak the aws key");
});

test("compact status masks secrets in state.error, lane errorSummary/title/taskSummary (JSON + text)", () => {
  const id = "55555555-5555-5555-8555-555555555555";
  const entry = {
    id,
    root: "/runs",
    dir: "/runs/redact",
    status: "failed",
    kind: "valid",
    state: {
      id,
      status: "failed",
      startedAt: "2026-07-02T00:00:00.000Z",
      // state.error surfaces as compact.errorSummary
      error: `lane failed after receiving token ${skToken}`,
      laneRecords: [
        {
          callId: "lane:fail",
          outcome: "failure",
          status: "committed",
          // errorSummary surfaces in compact.laneFailures[]
          errorSummary: `upstream auth rejected ${bearerHeader}`,
        },
        {
          callId: "lane:active",
          status: "running",
          // title + taskSummary surface in compact.activeLanes[]
          title: `active title with ${awsKey}`,
          taskSummary: `active summary token=${secretValue}`,
          startedAt: "2026-07-02T00:00:00.000Z",
        },
      ],
    },
  };

  const compact = compactStatusForEntry(entry);
  const serialized = JSON.stringify(compact);

  // No assembled synthetic secret appears anywhere in the compact JSON projection.
  for (const secret of [skToken, bearerValue, bearerHeader, awsKey, secretValue]) {
    assert.ok(!serialized.includes(secret), `compact status must not leak secret: ${secret.slice(0, 6)}...`);
  }
  // The values were masked (not dropped).
  assert.ok(compact.errorSummary?.includes(PLACEHOLDER));
  assert.ok(compact.laneFailures?.some((lane) => lane.errorSummary?.includes(PLACEHOLDER)));
  const active = compact.activeLanes?.find((lane) => lane.callId === "lane:active");
  assert.ok(active?.title?.includes(PLACEHOLDER), "active lane title masked");
  assert.ok(active?.taskSummary?.includes(PLACEHOLDER), "active lane taskSummary masked");

  // The text mirror (summarizeEntries) is masked too.
  const text = summarizeEntries([entry]);
  for (const secret of [skToken, bearerValue, awsKey, secretValue]) {
    assert.ok(!text.includes(secret), `compact status TEXT must not leak secret: ${secret.slice(0, 6)}...`);
  }
});

test("notification toast masks a secret embedded in a lane taskSummary (the toast's task field)", () => {
  const run = {
    id: "toast-redact-run",
    meta: { name: "secret-toast" },
    status: "running",
    startedAt: "2026-07-02T00:00:00.000Z",
    laneOutcomes: { success: 0, failure: 0 },
    agentsStarted: 1,
    maxAgents: 2,
    activeAgents: 1,
    queuedAgents: 0,
    laneRecords: [
      { callId: "lane:toast", status: "running", model: "p/m", taskSummary: `toast task using ${skToken}` },
      { callId: "lane:toast2", status: "running", model: "p/m", title: `alt title ${awsKey}` },
    ],
  };
  const msg = workflowHeartbeatToastCard(run).message;

  assert.ok(!msg.includes(skToken), "toast message must not leak the sk token");
  assert.ok(!msg.includes(awsKey), "toast message must not leak the aws key");
  assert.ok(msg.includes(PLACEHOLDER), "toast carries a masked placeholder where a secret was");
});

// ---- salvage preview: a secret in the final assistant reply must not reach redactedSnippet ----
//
// Mirrors the workflow-salvage.test.mjs harness: an interrupted run with one read-only orphan
// lane whose raw transcript final assistant message embeds a secret in JSON prose. The preview
// must surface a redactedSnippet that does NOT contain the secret (masking applied before the
// 200-char truncation), while the approval hash is computed from finalMessageHash (raw) and is
// therefore unaffected by the display-only masking.

async function tempDir(name) {
  return await fs.mkdtemp(path.join(os.tmpdir(), `${name}-`));
}
function runRootFor(dir) { return path.join(dir, ".opencode", "workflows", "runs"); }
function runDirFor(dir, runId) { return __test.runDirForRoot(runRootFor(dir), runId); }
function contextFor(dir) { return { worktree: dir }; }
function assistantMessage(text) { return { role: "assistant", parts: [{ type: "text", text }] }; }
function userMessage(text) { return { role: "user", parts: [{ type: "text", text }] }; }

function mockPluginContext(transcripts) {
  return {
    client: {
      session: {
        messages: async (arg) => {
          const id = arg?.sessionID ?? arg?.path?.id;
          return transcripts[id] ?? { data: [] };
        },
      },
    },
  };
}

test("salvage preview redactedSnippet masks a secret embedded in the final assistant reply", async () => {
  const root = await tempDir("salvage-redact");
  const runId = "salvage-redact-run";
  const dir = runDirFor(root, runId);
  await fs.mkdir(dir, { recursive: true });
  const callId = "lane:salvage-redact";
  const childID = "child-salvage-redact";
  const signatureHash = "sig-salvage-redact";
  await __test.writeJsonAtomic(path.join(dir, "state.json"), {
    id: runId,
    status: "interrupted",
    startedAt: "2026-06-24T00:00:00.000Z",
    finishedAt: "2026-06-24T00:02:00.000Z",
    laneRecords: [],
  });
  await __test.writeLaneProjection({ id: runId, dir, laneRecords: new Map() }, callId, {
    status: "running",
    childID,
    signatureHash,
    title: "orphan",
    model: "p/m",
  });

  // Final assistant message is valid JSON (so parseVerdict=valid, finalMessageFound=true, and a
  // redactedSnippet is produced) but embeds every synthetic secret in prose fields.
  const finalPayload = JSON.stringify({
    ok: true,
    note: `recovered using key ${skToken} and bearer ${bearerValue}`,
    detail: `aws ${awsKey} secret=${secretValue}`,
  });
  const transcripts = {
    [childID]: { data: [userMessage("inspect"), assistantMessage(finalPayload)] },
  };

  const out = JSON.parse(await salvageRun(mockPluginContext(transcripts), contextFor(root), { runId }));
  assert.equal(out.mode, "preview");
  assert.equal(out.candidates.length, 1);
  assert.equal(out.candidates[0].finalMessageFound, true);
  assert.ok(typeof out.candidates[0].redactedSnippet === "string" && out.candidates[0].redactedSnippet.length > 0);

  const snippet = out.candidates[0].redactedSnippet;
  for (const secret of [skToken, bearerValue, awsKey, secretValue]) {
    assert.ok(!snippet.includes(secret), `redactedSnippet must not leak secret: ${secret.slice(0, 6)}...`);
  }
  assert.ok(snippet.includes(PLACEHOLDER), "redactedSnippet carries a masked placeholder");

  // Hash stability: the approval hash is derived from finalMessageHash (raw), so the display-only
  // masking must not perturb it. Re-running produces the same hash deterministically.
  const out2 = JSON.parse(await salvageRun(mockPluginContext(transcripts), contextFor(root), { runId }));
  assert.equal(out2.approvalHash, out.approvalHash, "approval hash must be unaffected by display masking");
});

test("salvage preview redactedSnippet is truncated AFTER masking (a long secret is masked, not half-leaked)", async () => {
  const root = await tempDir("salvage-redact-trunc");
  const runId = "salvage-redact-trunc-run";
  const dir = runDirFor(root, runId);
  await fs.mkdir(dir, { recursive: true });
  const callId = "lane:salvage-redact-trunc";
  const childID = "child-salvage-redact-trunc";
  const signatureHash = "sig-trunc";
  await __test.writeJsonAtomic(path.join(dir, "state.json"), {
    id: runId, status: "interrupted",
    startedAt: "2026-06-24T00:00:00.000Z", finishedAt: "2026-06-24T00:02:00.000Z",
    laneRecords: [],
  });
  await __test.writeLaneProjection({ id: runId, dir, laneRecords: new Map() }, callId, {
    status: "running", childID, signatureHash, title: "orphan", model: "p/m",
  });
  // A reply well over the 200-char snippet cap with the secret near the start: masking must
  // happen before truncation so the secret never appears even partially in the snippet.
  const longText = `${skToken} ${"x".repeat(400)}`;
  const transcripts = { [childID]: { data: [assistantMessage(JSON.stringify({ ok: true, v: longText }))] } };
  const out = JSON.parse(await salvageRun(mockPluginContext(transcripts), contextFor(root), { runId }));
  const snippet = out.candidates[0].redactedSnippet;
  assert.ok(snippet.length <= 200, "snippet respects the 200-char cap");
  assert.ok(!snippet.includes(skToken), "long secret masked before truncation, not half-leaked");
});
