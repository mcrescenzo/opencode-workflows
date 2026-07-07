// Concern (4): run rehydration from prior on-disk state. Seeds a freshly constructed
// RunContext from the prior segment's persisted state.json on resume — folding prior spend
// into the replayed counters (never re-adding it), restoring agent/budget/cache counters,
// lane outcomes, and the edit/integration plan + worktree records. Extracted from
// run-store-status.js (opencode-workflows-nbp).
//
// This is the inverse of writeState (run-store-state.js): it reads the persisted snapshot
// and writes the subset of RunContext that survives across segments. See
// {@link import("./run-context.js").RunContext}.

import { LANE_OUTCOMES } from "./constants.js";
import { addTokens, copyTokenTotals, normalizeBudgetCeilings, zeroTokens } from "./budget-accounting.js";
import { normalizeRecentLogs } from "./run-observability.js";

function rehydrateRunFromPriorState(run, prior) {
  if (!prior || typeof prior !== "object") return run;
  if (Number.isInteger(prior.agentsStarted) && prior.agentsStarted >= 0) run.agentsStarted = prior.agentsStarted;
  if (Number.isInteger(prior.maxAgents) && prior.maxAgents > 0) run.maxAgents = prior.maxAgents;
  if (prior.budgetCeilings && typeof prior.budgetCeilings === "object") run.budgetCeilings = normalizeBudgetCeilings(prior.budgetCeilings);
  if (prior.authority && typeof prior.authority === "object") run.authority = prior.authority;
  if (prior.laneOutcomes && typeof prior.laneOutcomes === "object") {
    for (const outcome of LANE_OUTCOMES) {
      if (Number.isFinite(prior.laneOutcomes[outcome])) run.laneOutcomes[outcome] = prior.laneOutcomes[outcome];
    }
  }
  if (Number.isFinite(prior.droppedLaneCount)) run.droppedLaneCount = prior.droppedLaneCount;
  if (typeof prior.startedAt === "string") run.startedAt = prior.startedAt;
  if (prior.debugCapture && typeof prior.debugCapture === "object") run.debugCapture = prior.debugCapture;
  if (typeof prior.firstResultAt === "string") run.firstResultAt = prior.firstResultAt;
  if (Number.isFinite(prior.timeToFirstResultMs)) run.timeToFirstResultMs = prior.timeToFirstResultMs;
  if (prior.approvalWait && typeof prior.approvalWait === "object") run.approvalWait = prior.approvalWait;
  run.recentLogs = normalizeRecentLogs(prior.recentLogs);
  if (typeof prior.currentPhase === "string") run.currentPhase = prior.currentPhase;
  if (typeof prior.resultPath === "string") run.resultPath = prior.resultPath;
  // All historical spend (prior live + prior replayed) is folded into the replayed
  // counters and the live counters start at zero for this segment, mirroring the
  // agentsStarted replay model (carry the aggregate forward authoritatively; do NOT
  // let replay re-add it). Copying prior.tokens/prior.cost into run.tokens/run.cost
  // here AND re-accumulating the same spend as cache-hit lanes replay would double-count
  // prior spend (R9), tripping budget ceilings at a fraction of the configured limit.
  const priorLiveTokens = zeroTokens();
  copyTokenTotals(priorLiveTokens, prior.tokens);
  const priorReplayedTokens = zeroTokens();
  copyTokenTotals(priorReplayedTokens, prior.replayedTokens);
  run.replayedTokens = addTokens(priorLiveTokens, priorReplayedTokens);
  run.tokens = zeroTokens();
  const priorLiveCost = Number.isFinite(prior.cost) ? prior.cost : 0;
  const priorReplayedCost = Number.isFinite(prior.replayedCost) ? prior.replayedCost : 0;
  run.replayedCost = priorLiveCost + priorReplayedCost;
  run.cost = 0;
  if (prior.cacheStats && typeof prior.cacheStats === "object") {
    for (const key of ["hits", "misses", "invalidated"]) {
      if (Number.isFinite(prior.cacheStats[key])) run.cacheStats[key] = prior.cacheStats[key];
    }
  }
  if (Array.isArray(prior.editWorktrees)) run.editWorktrees = prior.editWorktrees;
  if (Array.isArray(prior.integrationWorktrees)) run.integrationWorktrees = prior.integrationWorktrees;
  if (prior.editPlan && typeof prior.editPlan === "object") run.editPlan = prior.editPlan;
  if (prior.integrationPlan && typeof prior.integrationPlan === "object") run.integrationPlan = prior.integrationPlan;
  if (prior.closeout && typeof prior.closeout === "object") run.closeout = prior.closeout;
  if (prior.recovery && typeof prior.recovery === "object") run.recovery = prior.recovery;
  if (Array.isArray(prior.laneRecords)) {
    run.laneRecords = new Map(prior.laneRecords.filter((record) => record?.callId).map((record) => [record.callId, record]));
  }
  return run;
}

export { rehydrateRunFromPriorState };
