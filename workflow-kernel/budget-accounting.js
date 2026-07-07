import { WorkflowBudgetStoppedError } from "./errors.js";

export function zeroTokens() {
  return { input: 0, output: 0, reasoning: 0 };
}

export function addTokens(left = zeroTokens(), right = zeroTokens()) {
  return {
    input: (left.input ?? 0) + (right.input ?? 0),
    output: (left.output ?? 0) + (right.output ?? 0),
    reasoning: (left.reasoning ?? 0) + (right.reasoning ?? 0),
  };
}

function reservedCostOf(run) {
  return Number.isFinite(run.reservedCost) ? run.reservedCost : 0;
}

function reservedTokensOf(run) {
  return Number.isFinite(run.reservedTokens) ? run.reservedTokens : 0;
}

function reservedLanesOf(run) {
  return Number.isFinite(run.reservedLanes) ? run.reservedLanes : 0;
}

function tokenCount(tokens = zeroTokens()) {
  return (tokens.input ?? 0) + (tokens.output ?? 0) + (tokens.reasoning ?? 0);
}

export function remainingBudget(run) {
  const ceilings = run.budgetCeilings ?? {};
  const totalCost = run.cost + run.replayedCost + reservedCostOf(run);
  const totalTokens = tokenCount(addTokens(run.tokens, run.replayedTokens)) + reservedTokensOf(run);
  return {
    cost: Number.isFinite(ceilings.maxCost) ? ceilings.maxCost - totalCost : null,
    tokens: Number.isFinite(ceilings.maxTokens) ? ceilings.maxTokens - totalTokens : null,
  };
}

export function budgetSnapshot(run) {
  return {
    live: { tokens: run.tokens, cost: run.cost },
    replayed: { tokens: run.replayedTokens, cost: run.replayedCost },
    total: {
      tokens: addTokens(run.tokens, run.replayedTokens),
      cost: run.cost + run.replayedCost,
    },
    // In-flight reservations of not-yet-reported concurrent-lane spend (opencode-workflows-dx1n).
    // Surfaced for observability only; `total` stays REAL reported spend so existing readers are
    // unaffected, while checkBudgetBeforeLaunch folds these into its ceiling comparison.
    reserved: { cost: reservedCostOf(run), tokens: reservedTokensOf(run), lanes: reservedLanesOf(run) },
    ceilings: run.budgetCeilings,
    remaining: remainingBudget(run),
    remainingAgents: Math.max(0, run.maxAgents - run.agentsStarted),
  };
}

export function checkBudgetBeforeLaunch(run) {
  const ceilings = run.budgetCeilings ?? {};
  const remaining = remainingBudget(run);
  // Ceilings apply to TOTAL spend (live + replayed) PLUS in-flight reservations. On a resumed run,
  // cache-hit lanes accumulate into replayedCost/replayedTokens; counting only live spend would let
  // a resume relaunch live lanes past a ceiling that total spend has already breached. The reserved
  // term closes a check-then-act race across concurrent lanes: up to `concurrency` lanes clear the
  // acquireAgentSlot semaphore and each pass this gate back-to-back BEFORE any has reported its
  // real session.prompt spend, so without reservations aggregate spend can overshoot the ceiling by
  // up to (concurrency-1) lanes' worth. Each launching lane reserves a conservative slice of the
  // remaining headroom (reserveLaneBudget) synchronously before its prompt, so a concurrent lane's
  // check here observes that in-flight commitment (opencode-workflows-dx1n).
  if (remaining.cost !== null && remaining.cost <= 0) {
    const totalCost = run.cost + run.replayedCost + reservedCostOf(run);
    throw new WorkflowBudgetStoppedError(`Workflow cost ceiling reached: ${totalCost} >= ${ceilings.maxCost}`);
  }
  if (remaining.tokens !== null && remaining.tokens <= 0) {
    const totalTokens = tokenCount(addTokens(run.tokens, run.replayedTokens)) + reservedTokensOf(run);
    throw new WorkflowBudgetStoppedError(`Workflow token ceiling reached: ${totalTokens} >= ${ceilings.maxTokens}`);
  }
}

// Synchronously reserve a conservative per-lane slice of the REMAINING budget headroom for a lane
// that is about to launch but has not yet reported its session.prompt cost/tokens. Reserving before
// the async prompt begins — and folding run.reservedCost/reservedTokens into checkBudgetBeforeLaunch
// — is what stops a wave of up to `concurrency` concurrent lanes from each clearing the ceiling gate
// on stale (pre-spend) counters and collectively overshooting maxCost/maxTokens (opencode-workflows-
// dx1n). The slice is (remaining headroom / remaining concurrency slots): distributing the headroom
// evenly across the at-most-`concurrency` in-flight lanes makes their combined reservation approach
// the full headroom, so the (concurrency+1)-th launch attempt is gated instead of overshooting.
// Parameter-free (derived from the run's own ceilings + concurrency), so it needs no magic per-lane
// cost constant and self-scales to any ceiling. Returns the reservation for releaseLaneBudget to
// reconcile once the lane's real spend lands (or the attempt fails). A no-op (zero slice) when the
// corresponding ceiling is unset.
export function reserveLaneBudget(run) {
  const ceilings = run.budgetCeilings ?? {};
  const concurrency = Number.isInteger(run.concurrency) && run.concurrency > 0 ? run.concurrency : 1;
  // reservedLanes counts lanes ALREADY holding a reservation; this lane also holds an acquireAgentSlot
  // slot, so at most (concurrency-1) others precede it and remainingSlots >= 1.
  const remainingSlots = Math.max(1, concurrency - reservedLanesOf(run));

  let cost = 0;
  if (Number.isFinite(ceilings.maxCost)) {
    const headroom = ceilings.maxCost - (run.cost + run.replayedCost + reservedCostOf(run));
    cost = Math.max(0, headroom / remainingSlots);
  }
  let tokens = 0;
  if (Number.isFinite(ceilings.maxTokens)) {
    const combined = addTokens(run.tokens, run.replayedTokens);
    const liveTokens = combined.input + combined.output + combined.reasoning;
    const headroom = ceilings.maxTokens - (liveTokens + reservedTokensOf(run));
    tokens = Math.max(0, headroom / remainingSlots);
  }

  run.reservedCost = reservedCostOf(run) + cost;
  run.reservedTokens = reservedTokensOf(run) + tokens;
  run.reservedLanes = reservedLanesOf(run) + 1;
  return { cost, tokens };
}

// Reconcile a reservation made by reserveLaneBudget once the lane's real spend has been folded into
// run.cost/run.tokens (success) or the attempt failed without spending (retry/terminal). Idempotent
// against a null/absent reservation and floored at zero so a double-release cannot drive the
// counters negative (opencode-workflows-dx1n).
export function releaseLaneBudget(run, reservation) {
  if (!reservation) return;
  run.reservedCost = Math.max(0, reservedCostOf(run) - (Number.isFinite(reservation.cost) ? reservation.cost : 0));
  run.reservedTokens = Math.max(0, reservedTokensOf(run) - (Number.isFinite(reservation.tokens) ? reservation.tokens : 0));
  run.reservedLanes = Math.max(0, reservedLanesOf(run) - 1);
}

export function copyTokenTotals(target, source) {
  if (!source || typeof source !== "object") return;
  for (const key of ["input", "output", "reasoning"]) {
    if (Number.isFinite(source[key])) target[key] = source[key];
  }
}

export function normalizeBudgetCeilings(ceilings = {}) {
  return {
    maxCost: Number.isFinite(ceilings.maxCost) ? ceilings.maxCost : undefined,
    maxTokens: Number.isInteger(ceilings.maxTokens) ? ceilings.maxTokens : undefined,
  };
}
