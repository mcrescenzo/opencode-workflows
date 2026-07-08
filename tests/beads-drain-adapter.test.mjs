import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  classifyVerifier,
  createBeadsDrainAdapter,
  finalizeBeadsDomainMutation,
  filterReadyIssues,
  normalizeIssue,
} from "../workflow-domains/beads/beads-drain-adapter.js";
import { drain } from "../workflow-kernel/drain-runtime.js";
import { appendDomainLedger, domainMutationIdempotencyKey } from "../workflow-kernel/event-journal.js";
import { hash } from "../workflow-kernel/text-json.js";
import { createMockBd, makeIssue } from "./helpers/mock-bd.mjs";

async function tempRun() {
  return { id: "beads-adapter-test", dir: await fs.mkdtemp(path.join(os.tmpdir(), "beads-adapter-run-")) };
}

async function readDomainLedger(run) {
  const content = await fs.readFile(path.join(run.dir, "domain-ledger.jsonl"), "utf8");
  return content.trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
}

test("beads adapter discover uses local readonly JSON scans and filters epics defensively", async () => {
  const task = makeIssue("task-1");
  const epic = makeIssue("epic-1", { issue_type: "epic" });
  const { runBd, calls } = createMockBd([task, epic]);
  const adapter = createBeadsDrainAdapter({ runBd, actor: "agent@example.com" });

  const discovered = await adapter.discover({ issueTypes: ["task"] });
  assert.deepEqual(discovered.map((issue) => issue.id), ["task-1"]);

  const readyCall = calls.find((call) => call.args[0] === "ready");
  assert.ok(readyCall.args.includes("--json"));
  assert.ok(readyCall.args.includes("--readonly"));
  assert.ok(readyCall.args.includes("--exclude-type"));
  assert.ok(!calls.some((call) => call.args.includes("--global")));

  assert.deepEqual(filterReadyIssues([task, epic], { includeEpics: true }).map((issue) => issue.id), ["task-1", "epic-1"]);
});

test("empty issueTypes scope is treated as no issue-type filter", async () => {
  const task = makeIssue("task-1");
  const bug = makeIssue("bug-1", { issue_type: "bug" });
  assert.deepEqual(filterReadyIssues([task, bug], { issueTypes: [] }).map((issue) => issue.id), ["task-1", "bug-1"]);
  assert.deepEqual(filterReadyIssues([task, bug], { issueTypes: [" ", ""] }).map((issue) => issue.id), ["task-1", "bug-1"]);
  assert.deepEqual(filterReadyIssues([task, bug], { issueTypes: [" task "] }).map((issue) => issue.id), ["task-1"]);
});

test("beads adapter discover rejects a wrong args.repo via preflight instead of a silent no-op", async () => {
  const { runBd } = createMockBd([makeIssue("task-1")]);
  const adapter = createBeadsDrainAdapter({ runBd, actor: "agent@example.com" });

  // Mock `bd where` reports /tmp/project/.beads -> repo root /tmp/project.
  // A drain pointed at a different repo must abort with a clear message.
  await assert.rejects(
    adapter.discover({ repo: "/tmp/different-project" }),
    /preflight rejected wrong repo.*human_decision_required/s,
  );

  // Matching repo drains normally (no silent rejection).
  const ok = await adapter.discover({ repo: "/tmp/project", issueTypes: ["task"] });
  assert.deepEqual(ok.map((issue) => issue.id), ["task-1"]);
});

test("beads adapter discover aborts when bd where cannot resolve a Beads database", async () => {
  const { runBd, calls } = createMockBd([makeIssue("task-1")]);
  // Override the `where` handler to return an empty string (no resolvable DB).
  const originalWhere = runBd;
  const emptyWhereAdapter = createBeadsDrainAdapter({
    runBd: async (args, meta) => (args[0] === "where" ? { stdout: "\n" } : originalWhere(args, meta)),
    actor: "agent@example.com",
  });

  await assert.rejects(emptyWhereAdapter.discover({}), /could not resolve a Beads database/);
  // No ready/status calls should happen after the preflight aborts.
  assert.equal(calls.some((call) => call.args[0] === "ready"), false);
});

test("central verifier passes a lane whose re-run validation commands succeed", async () => {
  const { runBd } = createMockBd([makeIssue("task-1")]);
  const adapter = createBeadsDrainAdapter({
    runBd,
    actor: "agent@example.com",
    runValidationCommand: async (command) => ({ exitCode: 0, stdout: `${command} ok` }),
  });
  const report = await adapter.validate(
    { id: "task-1" },
    { status: "integrated" },
    { laneReport: { readyForIntegration: true, acceptanceEvidence: ["e"], commandsRun: ["npm test", "ruff check ."] } },
  );
  assert.equal(report.verifierClassification, "pass");
  assert.equal(report.accepted, true);
  assert.deepEqual(report.verifierEvidence.map((entry) => entry.result), ["pass", "pass"]);
});

test("classifyVerifier returns explicit classification reasons", () => {
  assert.deepEqual(
    classifyVerifier({ unableToVerify: true, claimedCommands: ["npm test"] }),
    {
      classification: "unable-to-verify",
      reason: "central verifier inert: no validation runner wired, cannot re-check 1 claimed command(s) (fabricated-evidence guard)",
    },
  );
  assert.deepEqual(
    classifyVerifier({ failed: { command: "npm test", detail: "exit 1" } }),
    { classification: "fail", reason: "central verifier failed: npm test -> exit 1" },
  );
  assert.deepEqual(
    classifyVerifier({ verifierEvidence: [{ command: "npm test", result: "pass" }] }),
    { classification: "pass", reason: "central verifier passed" },
  );
});

test("central verifier rejects a lane with self-reported evidence but failing re-run commands", async () => {
  const { runBd } = createMockBd([makeIssue("task-1")]);
  const adapter = createBeadsDrainAdapter({
    runBd,
    actor: "agent@example.com",
    runValidationCommand: async (command) => (command.includes("ruff") ? { exitCode: 1, stderr: "E501 line too long" } : { exitCode: 0 }),
  });
  const report = await adapter.validate(
    { id: "task-1" },
    { status: "integrated" },
    { laneReport: { readyForIntegration: true, acceptanceEvidence: ["self-reported"], commandsRun: ["npm test", "ruff check ."] } },
  );
  assert.equal(report.verifierClassification, "fail");
  assert.equal(report.accepted, false);
  assert.match(report.reason, /central verifier failed: ruff/);
});

test("central verifier records unable-to-run when a validation command cannot execute", async () => {
  const { runBd } = createMockBd([makeIssue("task-1")]);
  const adapter = createBeadsDrainAdapter({
    runBd,
    actor: "agent@example.com",
    runValidationCommand: async (command) => (command.includes("some-tool")
      ? (() => { throw new Error("command not found"); })()
      : { exitCode: 0, stdout: "ok" }),
  });
  const report = await adapter.validate(
    { id: "task-1" },
    { status: "integrated" },
    { laneReport: { readyForIntegration: true, filesChanged: ["docs/guide.md"], acceptanceEvidence: ["e"], commandsRun: ["npm test", "some-tool check"] } },
  );
  // The unable-to-run entry is recorded with its spawn error detail.
  const synthetic = report.verifierEvidence.find((entry) => entry.result === "unable-to-run");
  assert.ok(synthetic, "the unable-to-run entry is recorded");
  assert.match(synthetic.detail, /command not found/);
  // R12: a single unable-to-run command does NOT hard-fail acceptance *as long as* at least one
  // other command was actually re-run and passed (a flaky/missing tool among real proof). The lane
  // still carries a verifier-passed command, so it is accepted.
  assert.equal(report.verifierEvidence.some((entry) => entry.result === "pass"), true);
  assert.equal(report.accepted, true);
});

test("R12: a lane whose validation commands are ALL unable-to-run is not accepted (no real verification)", async () => {
  const { runBd } = createMockBd([makeIssue("task-1")]);
  // Runner IS wired, but every reported command cannot execute (binary missing / wrong cwd / spawn
  // error). The verifier re-ran nothing successfully, so there is ZERO real verification. Previously
  // verifierPassed=!failed left this accepted for a doc-only lane (unprovenProse=false) — the R12
  // fail-open. A doc-only manifest is used deliberately so this exercises the all-unable-to-run gate
  // itself rather than the R11-followup-2 code/config unproven-prose rule.
  const adapter = createBeadsDrainAdapter({
    runBd,
    actor: "agent@example.com",
    runValidationCommand: async () => { throw new Error("command not found"); },
  });
  const report = await adapter.validate(
    { id: "task-1" },
    { status: "integrated" },
    { laneReport: { readyForIntegration: true, filesChanged: ["docs/guide.md"], acceptanceEvidence: ["e"], commandsRun: ["some-tool check", "another-tool lint"] } },
  );
  assert.equal(report.docOnly, true, "doc-only manifest so the all-unable-to-run gate is exercised, not unproven-prose");
  assert.ok(report.verifierEvidence.length > 0, "the verifier produced evidence (it tried to re-run commands)");
  assert.equal(report.verifierEvidence.some((entry) => entry.result === "pass"), false, "no command passed");
  assert.equal(report.verifierEvidence.some((entry) => entry.result === "fail"), false, "no command failed; all are unable-to-run");
  assert.equal(report.verifierClassification, "unable-to-run");
  assert.equal(report.accepted, false, "all-unable-to-run is not real verification and must not accept the lane");
  assert.match(report.reason, /central verifier proved nothing: all 2 re-run command\(s\) were unable-to-run/);
});

test("R11: no runner wired + fabricated commandsRun is unable-to-verify and rejected", async () => {
  const { runBd } = createMockBd([makeIssue("task-1")]);
  // Shipped autonomous-local default: createDrainAdapter does NOT pass runValidationCommand, so the
  // central verifier is inert. A lane that fabricates commandsRun/acceptanceEvidence must NOT be
  // accepted on evidenceCount alone — it must fail closed as unable-to-verify.
  const adapter = createBeadsDrainAdapter({ runBd, actor: "agent@example.com" });
  const report = await adapter.validate(
    { id: "task-1" },
    { status: "integrated" },
    { laneReport: { readyForIntegration: true, acceptanceEvidence: ["claimed it passed"], commandsRun: ["npm test", "ruff check ."] } },
  );
  assert.equal(report.verifierEnabled, false);
  assert.equal(report.verifierClassification, "unable-to-verify");
  assert.equal(report.accepted, false, "fabricated evidence must not be accepted when the verifier is inert");
  assert.match(report.reason, /no validation runner wired/);
  assert.match(report.reason, /fabricated-evidence guard/);
  // Verifier status is visible in the acceptance checklist diagnostics.
  assert.ok(report.acceptanceChecklist.some((line) => /central verifier: unable-to-verify \(runner not wired\)/.test(line)));
});

test("R11: no runner wired + doc-only lane claims no commands is not penalized by the inert verifier", async () => {
  const { runBd } = createMockBd([makeIssue("task-1")]);
  const adapter = createBeadsDrainAdapter({ runBd, actor: "agent@example.com" });
  // A genuinely doc-only lane (manifest lists only documentation) that reports acceptance evidence
  // but does not claim it ran commands has nothing for the verifier to re-check, so the inert
  // verifier stays "skipped" and does not block acceptance. (R11-followup-2: the manifest must be
  // present and doc-only; an absent manifest is no longer auto doc-only — covered separately.)
  const report = await adapter.validate(
    { id: "task-1" },
    { status: "integrated" },
    { laneReport: { readyForIntegration: true, filesChanged: ["docs/notes.md"], acceptanceEvidence: ["doc-only change, reviewed"], commandsRun: [] } },
  );
  assert.equal(report.verifierEnabled, false);
  assert.equal(report.verifierClassification, "skipped");
  assert.equal(report.docOnly, true);
  assert.equal(report.changeScopeSource, "lane-manifest");
  assert.equal(report.accepted, true);
});

test("R11-followup: non-doc code change with only prose acceptanceEvidence (empty commandsRun) is rejected as unproven-prose", async () => {
  const { runBd } = createMockBd([makeIssue("task-1")]);
  // No runner wired (shipped autonomous-local default). The lane reports a code change but claims
  // NO commands, only prose acceptanceEvidence. R11 only closed the commandsRun channel; this is
  // the prose channel of the same validation theater. evidenceCount>0 alone must NOT auto-accept a
  // code change with zero re-verifiable proof.
  const adapter = createBeadsDrainAdapter({ runBd, actor: "agent@example.com" });
  const report = await adapter.validate(
    { id: "task-1" },
    { status: "integrated" },
    { laneReport: { readyForIntegration: true, filesChanged: ["src/app.js"], commandsRun: [], acceptanceEvidence: ["looks good to me"] } },
  );
  assert.equal(report.docOnly, false);
  assert.equal(report.verifierClassification, "unproven-prose");
  assert.equal(report.accepted, false, "a code change with no verifier-passed command must not be accepted on prose alone");
  assert.match(report.reason, /pure-prose acceptanceEvidence is not re-verifiable proof/);
  assert.ok(report.acceptanceChecklist.some((line) => /change scope: code\/config/.test(line)));
});

test("R11-followup: doc-only change with prose acceptanceEvidence (empty commandsRun) is still accepted", async () => {
  const { runBd } = createMockBd([makeIssue("task-1")]);
  // A change that only touches documentation has no executable surface to re-run. The deliberate
  // doc-only accept path is preserved: reviewed prose evidence can close documentation work.
  const adapter = createBeadsDrainAdapter({ runBd, actor: "agent@example.com" });
  const report = await adapter.validate(
    { id: "task-1" },
    { status: "integrated" },
    { laneReport: { readyForIntegration: true, filesChanged: ["docs/guide.md", "README.md"], commandsRun: [], acceptanceEvidence: ["doc reviewed for accuracy"] } },
  );
  assert.equal(report.docOnly, true);
  assert.equal(report.verifierClassification, "skipped");
  assert.equal(report.accepted, true);
});

test("R11-followup: a non-doc change is accepted only when the central verifier re-runs a passing command", async () => {
  const { runBd } = createMockBd([makeIssue("task-1")]);
  // With a runner wired and the lane reporting a real command that re-runs green, the code change
  // carries re-verifiable proof and is accepted.
  const adapter = createBeadsDrainAdapter({
    runBd,
    actor: "agent@example.com",
    runValidationCommand: async () => ({ exitCode: 0, stdout: "ok" }),
  });
  const report = await adapter.validate(
    { id: "task-1" },
    { status: "integrated" },
    { laneReport: { readyForIntegration: true, filesChanged: ["src/app.js"], commandsRun: ["npm test"], acceptanceEvidence: ["tests pass"] } },
  );
  assert.equal(report.docOnly, false);
  assert.equal(report.verifierClassification, "pass");
  assert.equal(report.accepted, true);
});

test("R11-followup: a non-doc change with a wired runner but no reported commands is still rejected as unproven-prose", async () => {
  const { runBd } = createMockBd([makeIssue("task-1")]);
  // Even with a runner wired, a code-change lane that reports NO commands gives the verifier nothing
  // to re-run, so there is no verifier-passed command and prose alone must not accept it.
  const adapter = createBeadsDrainAdapter({
    runBd,
    actor: "agent@example.com",
    runValidationCommand: async () => ({ exitCode: 0, stdout: "ok" }),
  });
  const report = await adapter.validate(
    { id: "task-1" },
    { status: "integrated" },
    { laneReport: { readyForIntegration: true, filesChanged: ["src/app.js"], commandsRun: [], acceptanceEvidence: ["trust me"] } },
  );
  assert.equal(report.docOnly, false);
  assert.equal(report.verifierClassification, "unproven-prose");
  assert.equal(report.accepted, false);
});

// R11-followup-2 (opencode-workflows-qga): the doc-vs-code scope used to derive from the lane's
// self-reported filesChanged, so a fabricating lane could reach the prose-only accept path three
// ways. Each vector below must now fail to reach prose-only accept.

test("R11-followup-2 spoof vector 1: a code file mislabeled with a .md suffix cannot reach prose-only accept", async () => {
  const { runBd } = createMockBd([makeIssue("task-1")]);
  // No runner wired. The lane mislabels a real code change as `src/app.js.md` so the basename ext
  // `.md` would classify it doc-only. The controller provides the integrated diff's git name-only
  // ground truth (`src/app.js`), which the lane cannot spoof, so scope is code/config and the
  // prose-only accept path is closed.
  const adapter = createBeadsDrainAdapter({ runBd, actor: "agent@example.com" });
  const report = await adapter.validate(
    { id: "task-1" },
    { status: "integrated" },
    {
      laneReport: { readyForIntegration: true, filesChanged: ["src/app.js.md"], commandsRun: [], acceptanceEvidence: ["looks good"] },
      controllerChangedPaths: [{ status: "M", path: "src/app.js" }],
    },
  );
  assert.equal(report.changeScopeSource, "controller-diff");
  assert.equal(report.docOnly, false, "controller diff ground truth (src/app.js) overrides the spoofed .md basename");
  assert.equal(report.verifierClassification, "unproven-prose");
  assert.equal(report.accepted, false);
});

test("R11-followup-2 spoof vector 2: a code file placed under a docs/ path segment cannot reach prose-only accept", async () => {
  const { runBd } = createMockBd([makeIssue("task-1")]);
  // The lane reports the change as `src/docs/payload.js` so a `docs/` directory segment would
  // classify it doc-only. The controller diff (`src/payload.js`) is the ground truth and has no
  // docs/ segment, so scope is code/config.
  const adapter = createBeadsDrainAdapter({ runBd, actor: "agent@example.com" });
  const report = await adapter.validate(
    { id: "task-1" },
    { status: "integrated" },
    {
      laneReport: { readyForIntegration: true, filesChanged: ["src/docs/payload.js"], commandsRun: [], acceptanceEvidence: ["ship it"] },
      controllerChangedPaths: [{ status: "M", path: "src/payload.js" }],
    },
  );
  assert.equal(report.changeScopeSource, "controller-diff");
  assert.equal(report.docOnly, false, "controller diff ground truth overrides the spoofed docs/ segment");
  assert.equal(report.verifierClassification, "unproven-prose");
  assert.equal(report.accepted, false);
});

test("R11-followup-2 spoof vector 3: omitting filesChanged (absent manifest) cannot reach prose-only accept on a non-failed lane", async () => {
  const { runBd } = createMockBd([makeIssue("task-1")]);
  // No runner wired and the lane omits filesChanged entirely. Previously an empty manifest was
  // treated as doc-only by design, so prose-only evidence auto-accepted. Now an absent manifest with
  // no controller ground truth is unknown scope (not doc-only) and must carry a verifier-passed
  // command, so prose alone cannot accept it.
  const adapter = createBeadsDrainAdapter({ runBd, actor: "agent@example.com" });
  const report = await adapter.validate(
    { id: "task-1" },
    { status: "integrated" },
    { laneReport: { readyForIntegration: true, commandsRun: [], acceptanceEvidence: ["all good, trust me"] } },
  );
  assert.equal(report.changeScopeSource, "unknown-no-manifest");
  assert.equal(report.docOnly, false);
  assert.equal(report.verifierClassification, "unproven-prose");
  assert.equal(report.accepted, false, "an absent manifest on a non-failed lane must not auto-accept on prose alone");
  assert.match(report.reason, /pure-prose acceptanceEvidence is not re-verifiable proof/);
});

test("R11-followup-2: controller diff ground truth still accepts a genuine doc-only change with prose evidence", async () => {
  const { runBd } = createMockBd([makeIssue("task-1")]);
  // The deliberate doc-only accept path is preserved when the CONTROLLER diff (not just the lane
  // claim) confirms every changed file is documentation.
  const adapter = createBeadsDrainAdapter({ runBd, actor: "agent@example.com" });
  const report = await adapter.validate(
    { id: "task-1" },
    { status: "integrated" },
    {
      laneReport: { readyForIntegration: true, filesChanged: ["docs/guide.md"], commandsRun: [], acceptanceEvidence: ["doc reviewed"] },
      controllerChangedPaths: [{ status: "M", path: "docs/guide.md" }, { status: "A", path: "README.md" }],
    },
  );
  assert.equal(report.changeScopeSource, "controller-diff");
  assert.equal(report.docOnly, true);
  assert.equal(report.verifierClassification, "skipped");
  assert.equal(report.accepted, true);
});

test("R11-followup-2: controller diff ground truth overrides a lane that mislabels a real code change as doc-only", async () => {
  const { runBd } = createMockBd([makeIssue("task-1")]);
  // Belt-and-suspenders: even with a runner wired, if the lane claims a doc-only manifest but the
  // controller diff shows a real code file, scope is code/config and a verifier-passed command is
  // required. Here a passing command is present, so the (real) code change is accepted on proof.
  const adapter = createBeadsDrainAdapter({
    runBd,
    actor: "agent@example.com",
    runValidationCommand: async () => ({ exitCode: 0, stdout: "ok" }),
  });
  const report = await adapter.validate(
    { id: "task-1" },
    { status: "integrated" },
    {
      laneReport: { readyForIntegration: true, filesChanged: ["docs/guide.md"], commandsRun: ["npm test"], acceptanceEvidence: ["green"] },
      controllerChangedPaths: [{ status: "M", path: "src/app.js" }],
    },
  );
  assert.equal(report.changeScopeSource, "controller-diff");
  assert.equal(report.docOnly, false, "the controller diff (src/app.js) overrides the lane's doc-only manifest claim");
  assert.equal(report.verifierClassification, "pass");
  assert.equal(report.accepted, true);
});

test("closeout note includes central verifier evidence", async () => {
  const { runBd } = createMockBd([makeIssue("task-1")]);
  const run = await tempRun();
  const adapter = createBeadsDrainAdapter({ runBd, run, actor: "agent@example.com", runValidationCommand: async () => ({ exitCode: 0, stdout: "ok" }) });
  const validation = await adapter.validate(
    { id: "task-1" },
    { status: "integrated" },
    { laneReport: { readyForIntegration: true, acceptanceEvidence: ["e"], commandsRun: ["npm test"] } },
  );
  await adapter.close(
    { id: "task-1" },
    { laneReport: { summary: "done", commandsRun: ["npm test"], acceptanceEvidence: ["e"] }, validationReport: validation },
  );
  const ledger = await readDomainLedger(run);
  const noteRecord = ledger.find((record) => record.operation === "beads.append-notes" && record.phase === "staged");
  assert.ok(noteRecord);
  assert.match(noteRecord.payload.note, /Central verifier \(pass\)/);
  assert.match(noteRecord.payload.note, /npm test: pass/);
});

test("closeout note redacts secrets from lane and verifier-controlled text", async () => {
  const { runBd } = createMockBd([makeIssue("task-1")]);
  const run = await tempRun();
  const adapter = createBeadsDrainAdapter({ runBd, run, actor: "agent@example.com" });
  const secret = "sk-proj_secret_closeout_value_1234567890";
  await adapter.close(
    { id: "task-1" },
    {
      laneReport: {
        summary: "done",
        commandsRun: [`npm test --token=${secret}`],
        acceptanceEvidence: [`saw Authorization: Bearer ${secret}`],
      },
      validationReport: {
        reason: "central validation passed",
        verifierClassification: "pass",
        verifierEvidence: [{ command: `npm test --token=${secret}`, result: "pass", detail: `stdout contained ${secret}` }],
      },
    },
  );
  const ledger = await readDomainLedger(run);
  const noteRecord = ledger.find((record) => record.operation === "beads.append-notes" && record.phase === "staged");
  assert.ok(noteRecord);
  assert.doesNotMatch(noteRecord.payload.note, new RegExp(secret));
  assert.match(noteRecord.payload.note, /\[REDACTED:secret\]/);
});

test("F5: a lane reporting more than MAX_VERIFIER_COMMANDS surfaces truncation and does not silently pass", async () => {
  const { runBd } = createMockBd([makeIssue("task-1")]);
  // The verifier only re-runs the first 8 (default cap) commands. A lane that pads 8 passing
  // commands ahead of a real failing check at index >= 8 would, without the F5 fix, never run the
  // failing command yet still pass. Make every run command pass so the only signal that the tail is
  // unverified is the truncation guard itself.
  const ran = [];
  const adapter = createBeadsDrainAdapter({
    runBd,
    actor: "agent@example.com",
    runValidationCommand: async (command) => { ran.push(command); return { exitCode: 0, stdout: `${command} ok` }; },
  });
  const commandsRun = Array.from({ length: 12 }, (_, i) => `check-${i}`);
  const report = await adapter.validate(
    { id: "task-1" },
    { status: "integrated" },
    { laneReport: { readyForIntegration: true, acceptanceEvidence: ["e"], commandsRun } },
  );
  assert.equal(report.verifierTruncated, true);
  assert.equal(report.verifierClassification, "truncated");
  assert.equal(report.accepted, false, "a lane whose reported commands exceed the cap must not silently pass");
  assert.equal(report.verifierTotalCommands, 12);
  assert.equal(report.verifierRunCommands, 8);
  assert.equal(ran.length, 8, "only the first cap commands are actually re-run");
  assert.match(report.reason, /central verifier truncated: ran 8 of 12/);
  // The synthetic entry names the unverified tail so the truncation is not silent.
  const synthetic = report.verifierEvidence.find((entry) => entry.result === "unable-to-run");
  assert.ok(synthetic, "a synthetic unable-to-run entry is appended on truncation");
  assert.match(synthetic.detail, /exceeded MAX_VERIFIER_COMMANDS/);
  assert.match(synthetic.detail, /check-8/);
  assert.ok(report.acceptanceChecklist.some((line) => /central verifier: truncated/.test(line)));
});

test("F5: maxVerifierCommands cap is configurable", async () => {
  const { runBd } = createMockBd([makeIssue("task-1")]);
  const ran = [];
  const adapter = createBeadsDrainAdapter({
    runBd,
    actor: "agent@example.com",
    maxVerifierCommands: 2,
    runValidationCommand: async (command) => { ran.push(command); return { exitCode: 0, stdout: "ok" }; },
  });
  const report = await adapter.validate(
    { id: "task-1" },
    { status: "integrated" },
    { laneReport: { readyForIntegration: true, acceptanceEvidence: ["e"], commandsRun: ["a", "b", "c"] } },
  );
  assert.equal(report.verifierTruncated, true);
  assert.equal(report.verifierRunCommands, 2);
  assert.equal(ran.length, 2);
  assert.equal(report.accepted, false);
});

test("F5: a lane reporting exactly MAX_VERIFIER_COMMANDS is not treated as truncated", async () => {
  const { runBd } = createMockBd([makeIssue("task-1")]);
  const adapter = createBeadsDrainAdapter({
    runBd,
    actor: "agent@example.com",
    runValidationCommand: async () => ({ exitCode: 0, stdout: "ok" }),
  });
  const commandsRun = Array.from({ length: 8 }, (_, i) => `check-${i}`);
  const report = await adapter.validate(
    { id: "task-1" },
    { status: "integrated" },
    { laneReport: { readyForIntegration: true, acceptanceEvidence: ["e"], commandsRun } },
  );
  assert.equal(report.verifierTruncated, false);
  assert.equal(report.verifierClassification, "pass");
  assert.equal(report.accepted, true);
});


test("beads adapter classification is conservative and no longer enforces a ready-for-agent gate", async () => {
  const { runBd } = createMockBd([]);
  const adapter = createBeadsDrainAdapter({ runBd, actor: "agent@example.com" });

  assert.equal((await adapter.classify(makeIssue("ready"))).status, "ready");
  assert.equal((await adapter.classify(makeIssue("closed", { status: "closed" }))).status, "done");
  assert.equal((await adapter.classify(makeIssue("epic", { issue_type: "epic" }))).status, "external");
  // The ready-for-agent readiness gate was removed (opencode-workflows-0y5f.5): an open issue that
  // lacks the ready-for-agent label, a description, or acceptance criteria is now classified as a
  // ready drain candidate instead of being skipped as human-gated. Only genuinely human/blocking
  // labels, externally-owned in-progress work, blocked status, and wrong type still skip.
  assert.equal((await adapter.classify(makeIssue("missing", { acceptance_criteria: "" }))).status, "ready");
  assert.equal((await adapter.classify(makeIssue("unlabeled", { labels: [] }))).status, "ready");
  assert.equal((await adapter.classify(makeIssue("mine", { status: "in_progress", assignee: "agent@example.com" }))).status, "ready");
  assert.equal((await adapter.classify(makeIssue("other", { status: "in_progress", assignee: "other@example.com" }))).status, "human-gated");
  assert.equal(normalizeIssue({ id: "x", type: "task", state: "open", labels: "a b" }).issue_type, "task");
});

test("beads adapter rejects child mutations before calling bd", async () => {
  const { runBd, calls } = createMockBd([makeIssue("task-1")]);
  const adapter = createBeadsDrainAdapter({ runBd, laneAuthority: "child", run: await tempRun() });

  await assert.rejects(adapter.claim(makeIssue("task-1")), /controller-only/);
  await assert.rejects(adapter.close(makeIssue("task-1"), {}), /controller-only/);
  await assert.rejects(adapter.createFollowup({ title: "x" }), /controller-only/);
  assert.equal(calls.length, 0);
});

test("beads adapter claim mutates immediately and close is staged for apply finalization", async () => {
  const issue = makeIssue("task-1");
  const { runBd, calls, issues } = createMockBd([issue]);
  const run = await tempRun();
  const adapter = createBeadsDrainAdapter({ runBd, run, actor: "agent@example.com" });

  const claimed = await adapter.claim(issue);
  assert.equal(claimed.status, "in_progress");
  assert.equal(claimed.assignee, "agent@example.com");

  const closed = await adapter.close(issue, {
    laneReport: { summary: "done", commandsRun: ["npm test"], acceptanceEvidence: ["tests passed"] },
    validationReport: { reason: "central validation passed" },
  });
  assert.equal(closed.status, "staged-close");
  assert.equal(issues.get("task-1").status, "in_progress");
  assert.equal(issues.get("task-1").notes ?? "", "");

  const ledger = await readDomainLedger(run);
  assert.equal(ledger.some((record) => record.mutationKey === "bd-claim:task-1" && record.phase === "completed"), true);
  assert.equal(ledger.some((record) => record.operation === "beads.append-notes" && record.phase === "staged"), true);
  assert.equal(ledger.some((record) => record.operation === "beads.close" && record.phase === "staged"), true);
  assert.ok(calls.some((call) => call.args[0] === "update" && call.args.includes("--claim")));
  assert.equal(calls.some((call) => call.args[0] === "close" && call.args[1] === "task-1"), false);

  for (const record of ledger.filter((item) => item.phase === "staged")) {
    await finalizeBeadsDomainMutation({ operation: record.operation, ...record.payload }, { runBd });
  }
  assert.equal(issues.get("task-1").status, "closed");
  assert.match(issues.get("task-1").notes, /VALIDATION: Beads drain closeout/);
});

test("beads adapter claim rejects when --claim no-ops (readback not in_progress)", async () => {
  const issue = makeIssue("task-1");
  const base = createMockBd([issue]);
  const run = await tempRun();
  // Wrap runBd so `bd update --claim` is a silent no-op: it returns success but does NOT flip the
  // issue to in_progress/assigned. claim() must reject on its readback instead of treating this as
  // a successful claim (fail-open at the ownership boundary).
  const runBd = async (args, meta) => {
    if (args[0] === "update" && args.includes("--claim")) return { stdout: `updated ${args[1]}\n` };
    return base.runBd(args, meta);
  };
  const adapter = createBeadsDrainAdapter({ runBd, run, actor: "agent@example.com" });

  await assert.rejects(adapter.claim(issue), /did not show in_progress status/);
  // The issue was never actually claimed.
  assert.equal(base.issues.get("task-1").status, "open");
});

test("beads adapter claim rejects a foreign claim (TOCTOU: owned by another actor on readback)", async () => {
  const issue = makeIssue("task-1");
  const base = createMockBd([issue]);
  const run = await tempRun();
  // `bd update --claim` succeeds, but a concurrent actor owns the item: the fresh readback shows
  // in_progress assigned to someone else. claim() must reject rather than dispatch a lane for an
  // item this controller does not own.
  const runBd = async (args, meta) => {
    if (args[0] === "update" && args.includes("--claim")) {
      base.issues.get(args[1]).status = "in_progress";
      base.issues.get(args[1]).assignee = "other@example.com";
      return { stdout: `updated ${args[1]}\n` };
    }
    return base.runBd(args, meta);
  };
  const adapter = createBeadsDrainAdapter({ runBd, run, actor: "agent@example.com" });

  await assert.rejects(adapter.claim(issue), /not assigned to this controller/);
});

test("beads adapter stages followups and dependency links for apply finalization", async () => {
  const { runBd, calls, issues } = createMockBd([makeIssue("source-1")]);
  const run = await tempRun();
  const adapter = createBeadsDrainAdapter({ runBd, run, actor: "agent@example.com" });

  const created = await adapter.createFollowup({ title: "Follow up", description: "Later", dependsOn: "source-1", dependencyType: "discovered-from" });

  assert.match(created.id, /^staged-followup:/);
  assert.equal(issues.has("followup-1"), false);
  assert.equal(calls.some((call) => call.args[0] === "create"), false);
  assert.equal(calls.some((call) => call.args[0] === "dep" && call.args[1] === "add"), false);
  const ledger = await readDomainLedger(run);
  const staged = ledger.find((record) => record.operation === "beads.create-followup" && record.phase === "staged");
  assert.ok(staged);

  const finalized = await finalizeBeadsDomainMutation({ operation: staged.operation, ...staged.payload }, { runBd });
  assert.equal(finalized.id, "followup-1");
  assert.deepEqual(issues.get("followup-1").dependencies, [{ depends_on_id: "source-1", type: "discovered-from" }]);
  assert.ok(calls.some((call) => call.args[0] === "create"));
  assert.ok(calls.some((call) => call.args[0] === "dep" && call.args[1] === "add"));
});

test("beads adapter stages identical follow-up text with distinct dependsOn as separate mutations", async () => {
  const { runBd, issues } = createMockBd([makeIssue("source-1"), makeIssue("source-2")]);
  const run = await tempRun();
  const adapter = createBeadsDrainAdapter({ runBd, run, actor: "agent@example.com" });

  const a = await adapter.createFollowup({ title: "Same", description: "Same body", dependsOn: "source-1" });
  const b = await adapter.createFollowup({ title: "Same", description: "Same body", dependsOn: "source-2" });

  assert.notEqual(a.id, b.id, "distinct dependsOn must produce distinct staged ids");
  const ledger = await readDomainLedger(run);
  const staged = ledger.filter((record) => record.operation === "beads.create-followup" && record.phase === "staged");
  assert.equal(staged.length, 2);
  assert.deepEqual(
    staged.map((record) => record.payload.dependsOn).sort(),
    ["source-1", "source-2"],
  );

  for (const record of staged) {
    const finalized = await finalizeBeadsDomainMutation({ operation: record.operation, ...record.payload }, { runBd });
    assert.ok(finalized.id);
  }
  assert.deepEqual(issues.get("followup-1").dependencies, [{ depends_on_id: "source-1", type: "discovered-from" }]);
  assert.deepEqual(issues.get("followup-2").dependencies, [{ depends_on_id: "source-2", type: "discovered-from" }]);
});

test("beads adapter replays exact identical follow-up stage idempotently", async () => {
  const { runBd } = createMockBd([makeIssue("source-1")]);
  const run = await tempRun();
  const adapter = createBeadsDrainAdapter({ runBd, run, actor: "agent@example.com" });

  const first = await adapter.createFollowup({ title: "Twin", description: "d", dependsOn: "source-1", dependencyType: "discovered-from" });
  const second = await adapter.createFollowup({ title: "Twin", description: "d", dependsOn: "source-1", dependencyType: "discovered-from" });

  assert.equal(first.id, second.id, "exact replay must keep the same staged id");
  const ledger = await readDomainLedger(run);
  const staged = ledger.filter((record) => record.operation === "beads.create-followup" && record.phase === "staged");
  assert.equal(staged.length, 1);
});

test("beads adapter proveDry uses fresh ready and in-progress scans", async () => {
  const clean = createMockBd([]);
  const cleanAdapter = createBeadsDrainAdapter({ runBd: clean.runBd, actor: "agent@example.com" });
  const cleanProof = await cleanAdapter.proveDry({ issueTypes: ["task"] });
  assert.equal(cleanProof.dry, true);
  assert.ok(clean.calls.some((call) => call.args[0] === "ready"));
  assert.ok(clean.calls.some((call) => call.args[0] === "list" && call.args.includes("in_progress")));
  assert.ok(clean.calls.some((call) => call.args[0] === "dep" && call.args[1] === "cycles"));

  const dirty = createMockBd([makeIssue("task-1"), makeIssue("mine", { status: "in_progress", assignee: "agent@example.com" }), makeIssue("other", { status: "in_progress", assignee: "other@example.com" })]);
  const dirtyAdapter = createBeadsDrainAdapter({ runBd: dirty.runBd, actor: "agent@example.com" });
  const dirtyProof = await dirtyAdapter.proveDry({ issueTypes: ["task"] });
  assert.equal(dirtyProof.dry, false);
  assert.deepEqual(dirtyProof.ready.map((issue) => issue.id), ["task-1"]);
  assert.deepEqual(dirtyProof.unsafeInProgress.map((issue) => issue.id), ["other"]);
});

test("beads adapter proveDry treats empty issueTypes as unscoped", async () => {
  const { runBd } = createMockBd([makeIssue("task-1")]);
  const adapter = createBeadsDrainAdapter({ runBd, actor: "agent@example.com" });

  const proof = await adapter.proveDry({ issueTypes: [] });

  assert.equal(proof.dry, false);
  assert.deepEqual(proof.ready.map((issue) => issue.id), ["task-1"]);
});

test("beads drain dryRun performs only readonly Beads commands", async () => {
  const issue = makeIssue("task-1");
  const { runBd, calls } = createMockBd([issue]);
  const adapter = createBeadsDrainAdapter({ runBd, actor: "agent@example.com" });

  const report = await drain({ adapter, dryRun: true, scope: { issueTypes: ["task"] } });

  assert.equal(report.status, "dry_run_complete");
  assert.deepEqual(report.planned.map((item) => item.itemId), ["task-1"]);
  assert.equal(report.closed.length, 0);
  assert.equal(report.followups.length, 0);
  assert.equal(calls.some((call) => call.meta?.readonly === false), false);
  assert.equal(calls.some((call) => ["update", "close", "create"].includes(call.args[0])), false);
  assert.equal(calls.some((call) => call.args[0] === "dep" && call.args[1] === "add"), false);
  assert.ok(calls.some((call) => call.args[0] === "ready"));
  assert.ok(calls.some((call) => call.args[0] === "lint"));
});

test("releaseClaim immediately appends cleanup evidence, reopens, and unassigns", async () => {
  const { runBd, calls, issues } = createMockBd([makeIssue("task-1", { status: "in_progress", assignee: "agent@example.com" })]);
  const run = await tempRun();
  const adapter = createBeadsDrainAdapter({ runBd, run, actor: "agent@example.com" });

  const result = await adapter.releaseClaim({ id: "task-1" }, {
    reason: "lane failed validation",
    salvage: {
      dirty: true,
      worktreePath: "/tmp/worktrees/lane-1",
      changedFiles: [{ path: "src/app.py" }, { path: "tests/test_app.py" }],
    },
  });

  assert.equal(result.status, "released");
  assert.equal(result.staged, false);
  assert.equal(result.issue.status, "open");
  assert.equal(result.issue.assignee, undefined);
  assert.equal(issues.get("task-1").status, "open");
  assert.equal(issues.get("task-1").assignee, undefined);
  const ledger = await readDomainLedger(run);
  assert.equal(ledger.some((record) => record.operation === "beads.release-claim" && record.phase === "completed"), true);
  const update = calls.find((call) => call.args[0] === "update" && call.args[1] === "task-1" && call.args.includes("--status"));
  assert.ok(update);
  assert.ok(update.args.includes("--append-notes"));
  assert.ok(update.args.includes("--status"));
  assert.ok(update.args.includes("open"));
  assert.ok(update.args.includes("--assignee"));
  assert.match(issues.get("task-1").notes, /DRAIN CLEANUP/);
  assert.match(issues.get("task-1").notes, /lane failed validation/);
  assert.match(issues.get("task-1").notes, /Salvage worktree: \/tmp\/worktrees\/lane-1/);
  assert.match(issues.get("task-1").notes, /Salvage changed files: src\/app\.py, tests\/test_app\.py/);
  assert.match(issues.get("task-1").notes, /NOT closed/);
});

test("releaseClaim tolerates missing readback after raw bd update output", async () => {
  const mock = createMockBd([makeIssue("task-1", { status: "in_progress", assignee: "agent@example.com" })]);
  const run = await tempRun();
  const adapter = createBeadsDrainAdapter({
    runBd: async (args, meta) => {
      if (args[0] === "show" && args.includes("task-1")) return { stdout: JSON.stringify([null]) };
      return await mock.runBd(args, meta);
    },
    run,
    actor: "agent@example.com",
  });

  const result = await adapter.releaseClaim({ id: "task-1" }, { reason: "lane failed validation" });

  assert.equal(result.status, "released");
  assert.equal(result.issue, null);
  assert.equal(mock.issues.get("task-1").status, "open");
  assert.equal(mock.issues.get("task-1").assignee, undefined);
});

test("releaseClaim replays idempotently after a crash before the executed ledger record", async () => {
  const issue = makeIssue("task-1", { status: "open", assignee: undefined, notes: "" });
  const { runBd, calls, issues } = createMockBd([issue]);
  const run = await tempRun();
  const adapter = createBeadsDrainAdapter({ runBd, run, actor: "agent@example.com" });
  const reason = "lane failed";
  const note = [
    "DRAIN CLEANUP: controller released a failed/cancelled claim.",
    `Reason: ${reason}`,
    "The issue was reopened and unassigned for re-classification; it was NOT closed by this drain.",
    "Re-run the drain or re-scope the work; do not assume this issue is complete.",
  ].join("\n");
  const mutationKey = `bd-release:task-1:${hash(note)}`;
  const idempotencyKey = domainMutationIdempotencyKey(mutationKey);
  issues.get("task-1").notes = `${note}\n[ocw-idem:${idempotencyKey}]`;
  await appendDomainLedger(run, { phase: "started", mutationKey, operation: "beads.release-claim", idempotencyKey });

  const result = await adapter.releaseClaim({ id: "task-1" }, { reason });

  assert.equal(result.status, "released");
  assert.equal(result.issue.status, "open");
  assert.equal(calls.some((call) => call.args[0] === "update"), false, "marker replay must not append/reopen a second time");
  assert.equal((issues.get("task-1").notes.match(/DRAIN CLEANUP/g) ?? []).length, 1);
});

test("finalizeBeadsDomainMutation close short-circuits an already-closed issue", async () => {
  const { runBd, calls, issues } = createMockBd([makeIssue("task-1")]);
  const payload = { operation: "beads.close", issueId: "task-1", reason: "validated" };

  const first = await finalizeBeadsDomainMutation(payload, { runBd });
  const second = await finalizeBeadsDomainMutation(payload, { runBd });

  assert.equal(first.status, "closed");
  assert.equal(second.status, "closed");
  assert.equal(issues.get("task-1").status, "closed");
  assert.equal(calls.filter((call) => call.args[0] === "close" && call.args[1] === "task-1").length, 1);
});

test("proveDry reports released claims as ready work and external in-progress distinctly", async () => {
  const claimed = makeIssue("claimed-failed", { status: "in_progress", assignee: "agent@example.com" });
  const external = makeIssue("external-owned", { status: "in_progress", assignee: "other@example.com" });
  const { runBd } = createMockBd([claimed, external]);
  const run = await tempRun();
  const adapter = createBeadsDrainAdapter({ runBd, run, actor: "agent@example.com" });

  // releaseClaim records the controller-owned claim as released and immediately
  // reopens/unassigns it, so dry proof sees it as ready work instead of a stranded claim.
  await adapter.releaseClaim({ id: "claimed-failed" }, { reason: "lane failed" });

  const proof = await adapter.proveDry({ issueTypes: ["task"] });

  assert.equal(proof.dry, false);
  assert.deepEqual(proof.ready.map((issue) => issue.id), ["claimed-failed"]);
  assert.deepEqual(proof.unsafeInProgress.map((issue) => issue.id), ["external-owned"]);
  assert.deepEqual(proof.controllerOwnedIncomplete.map((issue) => issue.id), []);
  assert.ok(proof.releasedClaimIds.includes("claimed-failed"));
});

test("R6: proveDry can report dry under a task scope despite an out-of-scope in_progress epic", async () => {
  // A human-owned epic is in_progress and out of a task-only scope. proveDry must judge dry-ness
  // against the SAME scope discover uses (filterReadyIssues with statuses:['in_progress']), so this
  // out-of-scope epic must not keep a finished scoped drain reporting not_dry forever.
  const epic = makeIssue("epic-1", { status: "in_progress", issue_type: "epic", assignee: "human@example.com" });
  const { runBd, calls } = createMockBd([epic]);
  const adapter = createBeadsDrainAdapter({ runBd, actor: "agent@example.com" });

  const proof = await adapter.proveDry({ issueTypes: ["task"] });

  // The unscoped in_progress epic is excluded by scope, so it does not appear in unsafeInProgress
  // and the scoped drain can report dry once its own scoped work is done.
  assert.deepEqual(proof.unsafeInProgress.map((issue) => issue.id), []);
  assert.deepEqual(proof.controllerOwnedIncomplete.map((issue) => issue.id), []);
  assert.equal(proof.dry, true);
  // The raw in_progress scan is still performed (and still surfaced) so reporting is unaffected.
  assert.ok(calls.some((call) => call.args[0] === "list" && call.args.includes("in_progress")));
  assert.deepEqual(proof.inProgress.map((issue) => issue.id), ["epic-1"]);
});

test("R6: an in_progress epic still keeps an epic-inclusive scope non-dry", async () => {
  // Inverse guard: when the scope DOES include epics, an externally-owned in_progress epic remains
  // unsafe in-progress and keeps the queue non-dry. Scope-filtering must not blanket-drop epics.
  const epic = makeIssue("epic-1", { status: "in_progress", issue_type: "epic", assignee: "human@example.com" });
  const { runBd } = createMockBd([epic]);
  const adapter = createBeadsDrainAdapter({ runBd, actor: "agent@example.com" });

  const proof = await adapter.proveDry({ includeEpics: true });

  assert.deepEqual(proof.unsafeInProgress.map((issue) => issue.id), ["epic-1"]);
  assert.equal(proof.dry, false);
});

test("R7: proveDry passes --limit 0 so >50 in_progress items are not truncated to a false dry", async () => {
  // Regression for R7: proveDry's in_progress scan must mirror discover's `--limit 0`. bd defaults to
  // 50 rows; without --limit 0 a >50 in_progress backlog is truncated and unsafeInProgress is computed
  // from the first 50 only. Here the first 50 in_progress items are controller-owned-but-unclaimed
  // (benign for dry-ness) and a SINGLE externally-owned unsafe item sits at row 51. A truncated 50-row
  // scan would see only the benign rows and wrongly report dry=true; the full scan must report dry=false.
  const benign = Array.from({ length: 50 }, (_, i) =>
    makeIssue(`mine-${i}`, { status: "in_progress", assignee: "agent@example.com" }),
  );
  const unsafeLate = makeIssue("external-late", { status: "in_progress", assignee: "other@example.com" });
  const { runBd, calls } = createMockBd([...benign, unsafeLate]);
  const adapter = createBeadsDrainAdapter({ runBd, actor: "agent@example.com" });

  const proof = await adapter.proveDry({ issueTypes: ["task"] });

  // The in_progress scan must request the full, untruncated list.
  const listCall = calls.find((call) => call.args[0] === "list" && call.args.includes("in_progress"));
  assert.ok(listCall, "expected an in_progress list scan");
  const limitIdx = listCall.args.indexOf("--limit");
  assert.ok(limitIdx >= 0, "proveDry in_progress scan must pass --limit");
  assert.equal(listCall.args[limitIdx + 1], "0", "proveDry in_progress scan must pass --limit 0 (no truncation)");

  // The externally-owned item past row 50 must be seen, keeping the queue non-dry.
  assert.equal(proof.inProgress.length, 51);
  assert.deepEqual(proof.unsafeInProgress.map((issue) => issue.id), ["external-late"]);
  assert.equal(proof.dry, false);
});
