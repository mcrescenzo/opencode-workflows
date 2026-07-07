// Secret-value containment for repo-* review findings.
//
// Zero-token: every child session.prompt is routed to a canned payload by the shared
// test harness; no real model is ever called.
//
// Enforces docs/repo-review-leaf-contract.md §15 (Evidence-safety / secret-value
// containment). The suite covers both layers: security leaves mask detected secret values
// IN-GUEST during synthesis (maskFindingSecrets in repo-security-audit.js), and the kernel's
// result redaction masks credential-shaped string values at persistence/readback boundaries.
//
// Covers:
//   - end-to-end: repo-security-audit masks a planted fake secret so it never appears in
//     the structured result envelope, the workflow_status detail=result output, or the
//     rendered reportMarkdown (the finding still survives — masking, not dropping)
//   - kernel redaction proof: redactValue scrubs credential-shaped prose values and still
//     redacts sensitive keys by key name
//   - generic envelope containment: the extracted maskSecretsInText masks a planted secret
//     in a synthetic finding and leaves plain prose untouched
//   - contract rule present: §15 exists in the leaf contract

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  makeHarness,
  runApprovedRequest,
  runIdFrom,
  makeLeafPromptRouter,
  assertLeafEnvelope,
} from "./helpers/repo-review-leaf-harness.mjs";
import { redactValue } from "../workflow-kernel/text-json.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_SECURITY_SRC = path.join(HERE, "..", "workflows", "repo-security-audit.js");
const CONTRACT_DOC = path.join(HERE, "..", "docs", "repo-review-leaf-contract.md");

// A fake, obviously-not-real credential planted into model prose to prove containment.
// Constructed from pieces at runtime so no full AWS-key-shaped literal appears in tracked
// source (scanner-safe), while still exercising the in-guest maskSecretsInText AKIA detector
// (which matches AKIA + [A-Za-z0-9_-]{6,}). NOT a real credential.
const PLANTED_SECRET = ["AK", "IA", "-FAKE-SECRET-VALUE-", "12345"].join("");
const PUNCTUATION_SECRET = ["P@ss", "w0rd!", "2024#Prod"].join("");

// ---- domain-specific prompt router that leaks the planted secret ----
//
// Simulates a model that ignored the SAFETY directive and pasted a raw secret into the
// finding prose (description/attackVector/proposedChange). Only the "secrets" lens returns
// a finding; the recon + skeptic lanes are stubbed to keep the run deterministic.
function secretLeakingPromptRouter(shape) {
  return makeLeafPromptRouter((text, sh) => {
    const use = sh || shape;
    if (text.includes("Profile this repository")) {
      return use({ languages: ["javascript"], notes: "test repo" });
    }
    if (text.includes("security finder")) {
      const m = text.match(/the "([a-z-]+)" security finder/);
      const cat = m ? m[1] : "secrets";
      // Only the secrets lens finds the leaking finding; other lenses find nothing.
      if (cat !== "secrets") return use({ findings: [] });
      return use({ findings: [{
        category: "secrets", file: "config/prod.env", line: 42, severity: "critical",
        description: `Hardcoded AWS access key ${PLANTED_SECRET} committed to the repo.`,
        cwe: "CWE-798",
        attackVector: `The key ${PLANTED_SECRET} is readable in source and can be used to call AWS APIs.`,
        exploitability: "high",
        proposedChange: `Rotate ${PLANTED_SECRET} immediately and load it from a secret manager.`,
        confidence: 90, effort: "small", docImpact: "",
      }] });
    }
    if (text.includes("You are a skeptic")) {
      // Keep the finding (do not refute) so it survives into the returned envelope.
      return use({ refuted: false, reasoning: "confirmed reachable", adjustedConfidence: 90 });
    }
    return undefined;
  }, { fallbackShape: shape });
}

// ---- end-to-end: repo-security-audit masks the planted secret everywhere it matters ----

test("repo-security-audit masks a planted secret out of the result envelope, workflow_status detail=result, and reportMarkdown", async () => {
  const { tools, context, directory } = await makeHarness(secretLeakingPromptRouter());
  try {
    const request = { name: "repo-security-audit", args: { depth: "normal" } };
    const runOut = await runApprovedRequest(tools, context, request);
    const runId = runIdFrom(runOut);

    // The raw workflow_status detail=result output string (kernel-applied redaction).
    const statusJson = await tools.workflow_status.execute(
      { runId, format: "json", detail: "result" }, context,
    );
    const status = JSON.parse(statusJson);
    assert.equal(status.status, "completed", `run not completed: ${JSON.stringify(status)}`);
    const env = status.result.output;

    assertLeafEnvelope(env, "security");

    // 1. The raw secret MUST NOT appear anywhere in the structured result envelope.
    assert.ok(
      !JSON.stringify(env).includes(PLANTED_SECRET),
      "raw planted secret must not appear in the structured result envelope",
    );

    // 2. The raw secret MUST NOT appear in the raw workflow_status detail=result output.
    assert.ok(
      !String(statusJson).includes(PLANTED_SECRET),
      "raw planted secret must not appear in the workflow_status detail=result output",
    );

    // 3. The raw secret MUST NOT appear in the rendered reportMarkdown.
    assert.ok(env.reportMarkdown && typeof env.reportMarkdown === "string", "reportMarkdown must be present");
    assert.ok(
      !env.reportMarkdown.includes(PLANTED_SECRET),
      "raw planted secret must not appear in the rendered reportMarkdown",
    );

    // 4. The finding SURVIVED (it was masked, not dropped): one critical secrets finding.
    assert.equal(env.counts.total, 1);
    assert.equal(env.counts.critical, 1);
    assert.equal(env.findings.length, 1);
    assert.equal(env.findings[0].category, "secrets");

    // 5. Masking happened (a non-reversible masked indicator replaced the secret value).
    assert.ok(
      /AKIA\*+\d{4}/.test(env.findings[0].description),
      "masked description should carry a non-reversible AKIA***<suffix> indicator",
    );
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

// ---- kernel redaction proof: redactValue covers prose values and key names ----

test("kernel redactValue scrubs secret-shaped values in prose fields while preserving key-based redaction", () => {
  const env = {
    domain: "security",
    findings: [{ description: `hardcoded password=${PUNCTUATION_SECRET} in config`, file: "a.js", line: 1 }],
  };
  const redacted = redactValue(env);

  assert.ok(
    !JSON.stringify(redacted).includes(PUNCTUATION_SECRET),
    "redactValue must scrub secret-shaped strings inside non-sensitive prose values",
  );

  const withSensitiveKey = { password: PLANTED_SECRET, api_key: PLANTED_SECRET };
  const keyed = redactValue(withSensitiveKey);
  assert.equal(keyed.password, "[redacted]", "sensitive key 'password' must be redacted");
  assert.equal(keyed.api_key, "[redacted]", "sensitive key 'api_key' must be redacted");
});

test("workflow result persistence and detail=result mask secret-shaped string values under non-sensitive keys", async () => {
  const { tools, context, directory } = await makeHarness(async () => ({ data: { parts: [], info: {} } }));
  try {
    const source = `return { summary: ${JSON.stringify(`credential password=${PUNCTUATION_SECRET} in prose`)} };`;
    const runOut = await runApprovedRequest(tools, context, { source });
    const runId = runIdFrom(runOut);
    const statusJson = await tools.workflow_status.execute({ runId, format: "json", detail: "result" }, context);
    const status = JSON.parse(statusJson);
    assert.equal(status.status, "completed");
    assert.ok(!statusJson.includes(PUNCTUATION_SECRET), "detail=result must not leak the raw secret value");
    assert.ok(!JSON.stringify(status.result).includes(PUNCTUATION_SECRET), "result payload must be masked");

    const persisted = await fs.readFile(status.resultPath, "utf8");
    assert.ok(!persisted.includes(PUNCTUATION_SECRET), "persisted result.json must be masked at write time");
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

// ---- generic envelope containment via the extracted masking helper ----

test("maskSecretsInText (extracted sentinel) masks a planted secret in a synthetic envelope's prose fields and leaves plain prose untouched", async () => {
  const src = await fs.readFile(REPO_SECURITY_SRC, "utf8");
  const m = src.match(/\/\/ <suite:maskSecrets>([\s\S]*?)\/\/ <\/suite:maskSecrets>/);
  assert.ok(m, "maskSecrets sentinel block not found in repo-security-audit.js");
  // The helpers are fully self-contained (no closure over DOMAIN/etc.), so a bare Function works.
  const ns = new Function(`${m[1]}; return { maskSecretsInText, maskFindingSecrets };`)();

  // A synthetic finding (generic envelope shape) with the planted secret in prose fields.
  const finding = {
    category: "secrets", file: "config/prod.env", line: 42, severity: "critical",
    description: `Hardcoded key ${PLANTED_SECRET} in config.`,
    attackVector: `Use ${PLANTED_SECRET} to call AWS.`,
    proposedChange: `Rotate ${PLANTED_SECRET}.`,
    docImpact: "",
    confidence: 90,
  };
  const masked = ns.maskFindingSecrets(finding);
  const serialized = JSON.stringify(masked);

  // The raw secret is gone from every masked prose field.
  assert.ok(!serialized.includes(PLANTED_SECRET), "raw secret must not survive masking");
  // Non-prose / structured fields are preserved (masking, not restructuring).
  assert.equal(masked.category, "secrets");
  assert.equal(masked.file, "config/prod.env");
  assert.equal(masked.line, 42);
  assert.equal(masked.confidence, 90);
  // A masked, non-reversible indicator replaced the secret in the description.
  assert.ok(/AKIA\*+\d{4}/.test(masked.description), "masked description carries a non-reversible indicator");

  // Plain prose with no secret is left byte-for-byte untouched.
  assert.equal(
    ns.maskSecretsInText("plain prose describing an injection vulnerability, no secrets here"),
    "plain prose describing an injection vulnerability, no secrets here",
    "non-secret prose must pass through unchanged",
  );

  // Non-string / falsy inputs are returned as-is (defensive).
  assert.equal(ns.maskSecretsInText(""), "");
  assert.equal(ns.maskSecretsInText(null), null);
});

test("maskSecretsInText masks punctuation-bearing secret assignments", async () => {
  const src = await fs.readFile(REPO_SECURITY_SRC, "utf8");
  const m = src.match(/\/\/ <suite:maskSecrets>([\s\S]*?)\/\/ <\/suite:maskSecrets>/);
  assert.ok(m, "maskSecrets sentinel block not found in repo-security-audit.js");
  const ns = new Function(`${m[1]}; return { maskSecretsInText, maskFindingSecrets };`)();

  const out = ns.maskSecretsInText(`leaked password=${PUNCTUATION_SECRET} in config`);
  assert.ok(!out.includes(PUNCTUATION_SECRET), "punctuation-bearing assignment must be masked");
  assert.match(out, /\*+/, "masked output should retain a non-reversible indicator");
});

// ---- contract rule present: §15 exists in the leaf contract ----

test("the leaf contract documents the evidence-safety / secret-value containment rule", async () => {
  const doc = await fs.readFile(CONTRACT_DOC, "utf8");
  assert.match(doc, /Evidence-safety \/ secret-value containment/, "contract must have an evidence-safety / secret-value containment section");
  assert.match(doc, /NEVER the raw secret/i, "contract must forbid surfacing raw secret values");
  assert.match(doc, /file:line|fingerprint|masked/i, "contract must require location + fingerprint/masked snippet");
  assert.match(doc, /kernel value masking|defense in depth/i, "contract must document layered kernel and in-guest masking");
});
