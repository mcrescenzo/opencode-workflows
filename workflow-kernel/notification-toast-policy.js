const DEFAULT_FORCE_MS = 75_000;
const DEFAULT_PROBLEM_COOLDOWN_MS = 30_000;

const LANE_FAILURE_EVENTS = new Set([
  "agent.failure",
  "agent.timeout",
  "agent.cancelled",
  "agent.budget_stopped",
  "agent.retry",
  "agent.salvageable_dirty_failure",
]);

function requireNow(now) {
  if (!Number.isFinite(now)) throw new Error("workflow toast policy requires an injected numeric now");
  return now;
}

function createWorkflowToastPolicyState() {
  return {
    lastHeartbeatSignature: undefined,
    lastHeartbeatAt: undefined,
    lastProblemAt: {},
    pendingFailures: {},
    budgetThresholds: {},
  };
}

function problemReady(state, key, now, cooldownMs) {
  const last = state.lastProblemAt[key];
  return !Number.isFinite(last) || now - last >= cooldownMs;
}

function markProblem(state, key, now) {
  state.lastProblemAt[key] = now;
}

function evaluateWorkflowHeartbeatPolicy(state, snapshot, options = {}) {
  const now = requireNow(options.now);
  const forceMs = Number.isFinite(options.forceMs) && options.forceMs > 0 ? options.forceMs : DEFAULT_FORCE_MS;
  const signature = String(options.signature ?? "");
  const changed = signature !== state.lastHeartbeatSignature;
  const forced = options.force === true || (Number.isFinite(state.lastHeartbeatAt) && now - state.lastHeartbeatAt >= forceMs);
  if (!changed && !forced) return null;
  state.lastHeartbeatSignature = signature;
  state.lastHeartbeatAt = now;
  return { card: "heartbeat", snapshot };
}

function evaluateBudgetPolicy(state, snapshot) {
  const percent = snapshot.budgetPercent;
  if (!Number.isFinite(percent)) return [];
  if (percent >= 100 && state.budgetThresholds["100"] !== true) {
    state.budgetThresholds["100"] = true;
    state.budgetThresholds["80"] = true;
    return [{ card: "problem", snapshot, problem: { kind: "budget-100", variant: "error", label: "budget", reason: "budget exhausted" } }];
  }
  if (percent >= 80 && state.budgetThresholds["80"] !== true) {
    state.budgetThresholds["80"] = true;
    return [{ card: "problem", snapshot, problem: { kind: "budget-80", variant: "warning", label: "budget", reason: "budget 80%" } }];
  }
  return [];
}

function evaluateStallPolicy(state, snapshot, options = {}) {
  const now = requireNow(options.now);
  if (!snapshot.staleness?.stale) return [];
  const cooldownMs = Number.isFinite(options.problemCooldownMs) ? options.problemCooldownMs : DEFAULT_PROBLEM_COOLDOWN_MS;
  const key = "stall";
  if (!problemReady(state, key, now, cooldownMs)) return [];
  markProblem(state, key, now);
  const idleLaneCount = snapshot.activeLanes.filter((lane) => lane.idle).length;
  return [{
    card: "problem",
    snapshot,
    problem: {
      kind: "stall",
      variant: "warning",
      label: "workflow",
      reason: "stalled",
      idleMs: snapshot.staleness.ageMs,
      idleLaneCount,
    },
  }];
}

function failureCategory(snapshot) {
  return `lane-failure:${snapshot.phase?.name || "phase"}`;
}

function pendingFailure(state, key) {
  const pending = state.pendingFailures[key];
  if (!pending) return undefined;
  delete state.pendingFailures[key];
  return pending;
}

function addPendingFailure(state, key, event) {
  const pending = state.pendingFailures[key] ?? { count: 0, sample: event };
  pending.count += 1;
  pending.sample = pending.sample ?? event;
  state.pendingFailures[key] = pending;
}

function laneFailureProblem(event, snapshot, count = 1) {
  return {
    kind: "lane-failure",
    count,
    label: count > 1 ? `${count} lanes failed in ${snapshot.phase?.name || "phase"}` : event.callId,
    callId: event.callId,
    reason: event.error || event.failureClass || event.type,
    attempt: Number.isInteger(event.attempt) ? event.attempt : undefined,
    maxAttempts: Number.isInteger(event.maxAttempts) ? event.maxAttempts : undefined,
    retryInMs: Number.isFinite(event.delayMs) ? event.delayMs : undefined,
    ordinal: count > 1 ? `${count} failures this run` : undefined,
  };
}

function evaluateFailurePolicy(state, event, snapshot, options = {}) {
  if (!LANE_FAILURE_EVENTS.has(event?.type)) return [];
  const now = requireNow(options.now);
  const cooldownMs = Number.isFinite(options.problemCooldownMs) ? options.problemCooldownMs : DEFAULT_PROBLEM_COOLDOWN_MS;
  const key = failureCategory(snapshot);
  if (!problemReady(state, key, now, cooldownMs)) {
    addPendingFailure(state, key, event);
    return [];
  }
  const pending = pendingFailure(state, key);
  const count = 1 + (pending?.count ?? 0);
  markProblem(state, key, now);
  return [{ card: "problem", snapshot, problem: laneFailureProblem(event, snapshot, count) }];
}

function flushWorkflowToastPolicy(state, snapshot, options = {}) {
  const now = requireNow(options.now);
  const cooldownMs = Number.isFinite(options.problemCooldownMs) ? options.problemCooldownMs : DEFAULT_PROBLEM_COOLDOWN_MS;
  const decisions = [];
  for (const [key, pending] of Object.entries(state.pendingFailures)) {
    if (!pending || !problemReady(state, key, now, cooldownMs)) continue;
    delete state.pendingFailures[key];
    markProblem(state, key, now);
    decisions.push({ card: "problem", snapshot, problem: laneFailureProblem(pending.sample, snapshot, pending.count) });
  }
  return decisions;
}

function evaluateWorkflowToastEventPolicy(state, event, snapshot, options = {}) {
  requireNow(options.now);
  const decisions = [
    ...evaluateBudgetPolicy(state, snapshot),
    ...evaluateStallPolicy(state, snapshot, options),
    ...evaluateFailurePolicy(state, event, snapshot, options),
  ];
  if (event?.type === "phase") {
    const heartbeat = evaluateWorkflowHeartbeatPolicy(state, snapshot, { ...options, force: true });
    if (heartbeat) decisions.push(heartbeat);
  }
  return decisions;
}

function evaluateWorkflowToastTickPolicy(state, snapshot, options = {}) {
  const decisions = [
    ...evaluateBudgetPolicy(state, snapshot),
    ...evaluateStallPolicy(state, snapshot, options),
    ...flushWorkflowToastPolicy(state, snapshot, options),
  ];
  const heartbeat = evaluateWorkflowHeartbeatPolicy(state, snapshot, options);
  if (heartbeat) decisions.push(heartbeat);
  return decisions;
}

export {
  DEFAULT_FORCE_MS,
  DEFAULT_PROBLEM_COOLDOWN_MS,
  createWorkflowToastPolicyState,
  evaluateWorkflowHeartbeatPolicy,
  evaluateWorkflowToastEventPolicy,
  evaluateWorkflowToastTickPolicy,
  flushWorkflowToastPolicy,
};
