import test from "node:test";
import assert from "node:assert/strict";

import {
  CARD_LINE_MAX,
  renderWorkflowApplyCard,
  renderWorkflowHeartbeatCard,
  renderWorkflowProblemCard,
  renderWorkflowTerminalCard,
  workflowToastCardSnapshot,
} from "../workflow-kernel/notification-toast-cards.js";

const NOW = Date.parse("2026-07-07T12:04:12Z");

function baseRun(overrides = {}) {
  return {
    id: "wf_x1",
    meta: { name: "repo-bughunt", phases: ["Scan", "Verify", "Fix"] },
    currentPhase: "Verify",
    status: "running",
    startedAt: "2026-07-07T12:00:00Z",
    agentsStarted: 19,
    activeAgents: 3,
    waitingAgents: [1, 2, 3, 4, 5],
    laneOutcomes: { success: 14, failure: 1, timeout: 0, cancelled: 0, budget_stopped: 0 },
    budgetCeilings: { maxTokens: 100_000 },
    tokens: { input: 61_000, output: 0, reasoning: 0 },
    recentLogs: ["7/10 verified so far"],
    laneRecords: [
      { callId: "scope/pipeline:0/item:0/stage:0/agent:a", status: "completed", outcome: "success", startedAt: "2026-07-07T12:00:00Z", taskSummary: "verify:done" },
      { callId: "scope/pipeline:0/item:1/stage:0/agent:b", status: "running", startedAt: "2026-07-07T12:03:34Z", updatedAt: "2026-07-07T12:03:50Z", taskSummary: "verify:auth-token" },
      { callId: "scope/pipeline:0/item:2/stage:0/agent:c", status: "running", startedAt: "2026-07-07T12:04:00Z", updatedAt: "2026-07-07T12:04:05Z", taskSummary: "verify:sql-inject" },
      { callId: "scope/pipeline:0/item:3/stage:0/agent:d", status: "running", startedAt: "2026-07-07T12:02:12Z", updatedAt: "2026-07-07T12:02:12Z", taskSummary: "review:perf" },
    ],
    ...overrides,
  };
}

function assertLineWidths(card) {
  for (const part of [card.title, ...card.message.split("\n")]) {
    assert.ok(part.length <= CARD_LINE_MAX, `${part.length}: ${JSON.stringify(part)}`);
  }
}

test("heartbeat card renders indented outline status and cuts low-value fields", () => {
  const card = renderWorkflowHeartbeatCard(workflowToastCardSnapshot(baseRun(), { now: NOW }));
  assert.equal(card.title, "▶ repo-bughunt · 4m12s");
  assert.equal(card.message, [
    "└ Verify (2/3)",
    "  ├ ⟳ review:perf 2m · ⚠idle",
    "  ├ ⟳ verify:auth-token 38s",
    "  └ ⟳ verify:sql-inject 12s",
    "  done 14 · queued 5 · fail 1",
    "  items 1/4 · budget 61%",
    "» 7/10 verified so far",
  ].join("\n"));
  assert.doesNotMatch(card.message, /inspect:|runId|wf_x1|\$|replayed|concurrency|cache/);
  assertLineWidths(card);
});

test("heartbeat omits absent optional fields and zero failures", () => {
  const card = renderWorkflowHeartbeatCard(workflowToastCardSnapshot(baseRun({
    meta: { name: "minimal" },
    currentPhase: undefined,
    activeAgents: 0,
    waitingAgents: [],
    laneOutcomes: { success: 0, failure: 0, timeout: 0, cancelled: 0, budget_stopped: 0 },
    budgetCeilings: {},
    recentLogs: [],
    laneRecords: [],
  }), { now: NOW }));
  assert.equal(card.message, [
    "└ phase",
    "  done 0 · queued 0",
  ].join("\n"));
  assert.doesNotMatch(card.message, /fail|items|budget|»/);
});

test("problem card renders retry context and inspect hint", () => {
  const snapshot = workflowToastCardSnapshot(baseRun(), { now: NOW });
  const card = renderWorkflowProblemCard(snapshot, {
    label: "verify:auth-token",
    reason: "timeout",
    attempt: 2,
    maxAttempts: 3,
    retryInMs: 8_000,
    ordinal: "2nd failure this run",
  });
  assert.equal(card.variant, "warning");
  assert.equal(card.title, "✗ lane failed · repo-bughunt");
  assert.equal(card.message, [
    "verify:auth-token — timeout (attempt 2/3)",
    "retrying in 8s · 2nd failure this run",
    "▸ Verify: ✓14 ⟳3 ⧗5",
    "inspect: workflow_status wf_x1",
  ].join("\n"));
  assertLineWidths(card);
});

test("terminal card renders lane totals, budget, final log, and inspect hint", () => {
  const snapshot = workflowToastCardSnapshot(baseRun({
    status: "completed",
    finishedAt: "2026-07-07T12:12:40Z",
    activeAgents: 0,
    waitingAgents: [],
    laneOutcomes: { success: 20, failure: 2, timeout: 0, cancelled: 0, budget_stopped: 0 },
    cost: 0.84,
    tokens: { input: 188_000, output: 0, reasoning: 0 },
    budgetCeilings: { maxTokens: 265_000 },
    recentLogs: ["9 confirmed bugs"],
  }), { now: NOW });
  const card = renderWorkflowTerminalCard(snapshot);
  assert.equal(card.variant, "success");
  assert.equal(card.title, "✓ repo-bughunt done · 12m40s");
  assert.equal(card.message, [
    "✓ Scan ✓ Verify ✓ Fix",
    "22 lanes: ✓20 ✗2",
    "188k tok · $0.84 · 71% of budget",
    "» 9 confirmed bugs",
    "inspect: workflow_status wf_x1",
  ].join("\n"));
  assertLineWidths(card);
});

test("apply card supports ASCII fallback for terminals with poor glyph rendering", () => {
  const snapshot = workflowToastCardSnapshot(baseRun({
    status: "apply-running",
    editPlan: { diffPlanHash: "abcdef0123456789", patches: [{}, {}] },
  }), { now: NOW });
  const card = renderWorkflowApplyCard(snapshot, { ascii: true });
  assert.equal(card.title, "> repo-bughunt | apply running");
  assert.equal(card.message, [
    "\\ apply running",
    "  patches 2",
    "  diff abcdef012345",
    "inspect: workflow_status wf_x1",
  ].join("\n"));
  assert.doesNotMatch(`${card.title}\n${card.message}`, /[└├⟳⚠»✓✗⧗·—]/);
  assertLineWidths(card);
});

test("ASCII fallback covers heartbeat, problem, terminal, and apply cards", () => {
  const running = workflowToastCardSnapshot(baseRun(), { now: NOW });
  const terminal = workflowToastCardSnapshot(baseRun({ status: "completed", finishedAt: "2026-07-07T12:12:40Z" }), { now: NOW });
  const apply = workflowToastCardSnapshot(baseRun({ status: "apply-running", editPlan: { diffPlanHash: "abc", patches: [] } }), { now: NOW });
  const cards = [
    renderWorkflowHeartbeatCard(running, { ascii: true }),
    renderWorkflowProblemCard(running, { label: "lane", reason: "failed" }, { ascii: true }),
    renderWorkflowTerminalCard(terminal, { ascii: true }),
    renderWorkflowApplyCard(apply, { ascii: true }),
  ];
  for (const card of cards) {
    assert.doesNotMatch(`${card.title}\n${card.message}`, /[└├⟳⚠»✓✗⧗·—]/);
    assertLineWidths(card);
  }
});
