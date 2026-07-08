import test from "node:test";
import assert from "node:assert/strict";

import {
  createWorkflowToastEventSink,
  maybeShowWorkflowProgressToast,
  shortModel,
  showToast,
} from "../workflow-kernel/notification-toast.js";
import { truncateText } from "../workflow-kernel/text-json.js";

test("truncateText enforces result.length <= max even when max is smaller than the marker suffix", () => {
  const long = "x".repeat(50);
  // The truncation marker "...[truncated N chars]" is ~23 chars, wider than these budgets.
  for (const max of [0, 1, 3, 4, 10, 18, 22]) {
    const result = truncateText(long, max);
    assert.ok(result.length <= max, `max=${max} produced ${result.length}-char result: ${JSON.stringify(result)}`);
  }
  // The specific reproduction from the bug report: was 23 chars, must now be <= 18.
  assert.ok(truncateText(long, 18).length <= 18);
  // A max large enough for the marker still keeps the normal truncated form.
  assert.match(truncateText(long, 40), /truncated \d+ chars\]$/);
});

test("shortModel hard-caps long model ids at 18 characters", () => {
  const label = shortModel("claude-opus-4-5-20260301-extended-thinking");
  assert.ok(label.length <= 18, `shortModel returned ${label.length}-char label: ${JSON.stringify(label)}`);
});

test("showToast does not accumulate overlapping hung TUI deliveries after timeout", async () => {
  let calls = 0;
  let signal;
  const pluginContext = {
    __workflowToastTimeoutMs: 1,
    client: {
      tui: {
        showToast(input) {
          calls += 1;
          signal = input.signal;
          return new Promise(() => {});
        },
      },
    },
  };

  await showToast(pluginContext, "info", "one", "first");
  assert.equal(calls, 1);
  assert.equal(signal?.aborted, true);

  await showToast(pluginContext, "info", "two", "second");
  assert.equal(calls, 1, "a timed-out hung delivery remains active and suppresses overlapping toasts");
});

function toastContext() {
  const calls = [];
  return {
    calls,
    context: {
      client: {
        tui: {
          async showToast(input) {
            calls.push(input.body);
            return { data: true };
          },
        },
      },
    },
  };
}

function toastRun(overrides = {}) {
  return {
    id: "wf_x1",
    status: "running",
    meta: { name: "fixture-review", phases: ["Scan", "Verify"] },
    currentPhase: "Verify",
    startedAt: "2026-07-07T12:00:00.000Z",
    agentsStarted: 1,
    activeAgents: 1,
    waitingAgents: [],
    laneOutcomes: { success: 0, failure: 0, timeout: 0, cancelled: 0, budget_stopped: 0 },
    tokens: { input: 0, output: 0, reasoning: 0 },
    replayedTokens: { input: 0, output: 0, reasoning: 0 },
    cost: 0,
    replayedCost: 0,
    budgetCeilings: {},
    laneRecords: [],
    recentLogs: [],
    ...overrides,
  };
}

test("createWorkflowToastEventSink emits an immediate heartbeat on phase events", async () => {
  const { context, calls } = toastContext();
  const run = toastRun();
  const sink = createWorkflowToastEventSink(context, run, { now: Date.parse("2026-07-07T12:01:00.000Z") });

  await sink({ type: "phase", phase: "Verify" });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].variant, "info");
  assert.equal(calls[0].title, "▶ fixture-review · 1m");
  assert.match(calls[0].message, /^└ Verify \(2\/2\)/);
});

test("maybeShowWorkflowProgressToast uses policy dedup and ASCII card option", async () => {
  const { context, calls } = toastContext();
  context.__workflowToastAscii = true;
  const run = toastRun({ recentLogs: ["halfway"] });
  const now = Date.parse("2026-07-07T12:01:00.000Z");

  assert.equal(await maybeShowWorkflowProgressToast(context, run, { now, forceMs: 75_000 }), true);
  assert.equal(await maybeShowWorkflowProgressToast(context, run, { now: now + 10_000, forceMs: 75_000 }), false);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].title, "> fixture-review | 1m");
  assert.doesNotMatch(calls[0].message, /[└├⟳⚠»✓✗⧗·—]/);
});
