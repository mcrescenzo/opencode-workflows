import { setTimeout as sleep } from "node:timers/promises";

import {
  WORKFLOW_PROGRESS_TOAST_FORCE_MS,
  WORKFLOW_PROGRESS_TOAST_INTERVAL_MS,
  WORKFLOW_TOAST_DURATION_MS,
} from "./constants.js";
import { stableStringify, truncateText } from "./text-json.js";
import { redactFreeTextSecrets } from "./free-text-redactor.js";
import { addTokens, zeroTokens } from "./budget-accounting.js";
import {
  renderWorkflowApplyCard,
  renderWorkflowHeartbeatCard,
  renderWorkflowProblemCard,
  renderWorkflowTerminalCard,
  workflowToastCardSignature,
  workflowToastCardSnapshot,
} from "./notification-toast-cards.js";
import {
  createWorkflowToastPolicyState,
  evaluateWorkflowToastEventPolicy,
  evaluateWorkflowToastTickPolicy,
} from "./notification-toast-policy.js";

const WORKFLOW_TOAST_MESSAGE_MAX_CHARS = 1_000;

const WORKFLOW_TOAST_MAX_LANES = 4;

const WORKFLOW_TOAST_DELIVERY_TIMEOUT_MS = 1_000;

const activeToastDeliveries = new WeakSet();

function hasWorkflowToast(pluginContext) {
  return typeof pluginContext.client?.tui?.showToast === "function" || typeof pluginContext.tui?.ui?.toast === "function";
}

async function showToast(pluginContext, variant, title, message) {
  try {
    const body = {
      variant,
      title: truncateText(redactFreeTextSecrets(title), 120),
      message: truncateText(redactFreeTextSecrets(message), WORKFLOW_TOAST_MESSAGE_MAX_CHARS),
      duration: WORKFLOW_TOAST_DURATION_MS,
    };
    const timeoutMs = Number.isFinite(pluginContext.__workflowToastTimeoutMs) ? pluginContext.__workflowToastTimeoutMs : WORKFLOW_TOAST_DELIVERY_TIMEOUT_MS;
    if (typeof pluginContext.client?.tui?.showToast === "function") {
      if (activeToastDeliveries.has(pluginContext)) return;
      activeToastDeliveries.add(pluginContext);
      const ac = new AbortController();
      const delivery = Promise.resolve(pluginContext.client.tui.showToast({ body, signal: ac.signal })).catch(() => {}).finally(() => {
        activeToastDeliveries.delete(pluginContext);
        ac.abort();
      });
      await Promise.race([
        delivery,
        sleep(timeoutMs, undefined, { signal: ac.signal }).then(() => ac.abort()).catch(() => {}),
      ]);
      return;
    }
    pluginContext.tui?.ui?.toast?.(body);
  } catch {
    // Toasts are best effort; persisted state remains authoritative.
  }
}

function workflowDisplayName(run) {
  const name = typeof run.meta?.name === "string" ? run.meta.name.trim() : "";
  return name || "unnamed";
}

function workflowQueuedAgents(run) {
  return run.waitingAgents?.length ?? run.queuedAgents ?? 0;
}

function workflowTotalCost(run) {
  const cost = Number(run.cost ?? 0) + Number(run.replayedCost ?? 0);
  return Number.isFinite(cost) ? cost : 0;
}

function workflowCostLabel(run) {
  return workflowTotalCost(run).toFixed(4).replace(/\.?0+$/, "") || "0";
}

function workflowTotalTokens(run) {
  const total = addTokens(run.tokens ?? zeroTokens(), run.replayedTokens ?? zeroTokens());
  return (total.input ?? 0) + (total.output ?? 0) + (total.reasoning ?? 0);
}

function compactDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "-";
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h${minutes % 60}m`;
}

function laneRecordsForRun(run) {
  if (run.laneRecords instanceof Map) return [...run.laneRecords.values()];
  if (Array.isArray(run.laneRecords)) return run.laneRecords;
  return [];
}

function lanePriority(lane) {
  if (lane.status === "running" || lane.status === "committed") return 0;
  if (["failure", "timeout", "cancelled", "budget_stopped"].includes(lane.outcome) || ["failure", "timeout", "cancelled", "budget_stopped"].includes(lane.status)) return 1;
  if (lane.status === "completed") return 2;
  return 3;
}

function shortModel(model) {
  const text = String(model || "model?");
  return truncateText(text.split("/").pop() || text, 18);
}

function laneRuntimeLabel(lane, now) {
  const start = Date.parse(lane.startedAt ?? "");
  const end = Date.parse(lane.completedAt ?? "");
  if (Number.isFinite(start) && Number.isFinite(end)) return compactDuration(end - start);
  if (Number.isFinite(start)) return compactDuration(now - start);
  return "-";
}

function workflowToastSnapshot(run, options = {}) {
  return workflowToastCardSnapshot(run, options);
}

function workflowBudgetLabel(snapshot) {
  if (Number.isFinite(snapshot.budgetPercent)) return ` budget=${snapshot.budgetPercent}%`;
  const labels = [];
  const maxCost = snapshot.budgetCeilings?.maxCost;
  if (Number.isFinite(maxCost) && maxCost > 0) labels.push(`cost ${Math.round((Number(snapshot.cost) / maxCost) * 100)}%`);
  const maxTokens = snapshot.budgetCeilings?.maxTokens;
  if (Number.isFinite(maxTokens) && maxTokens > 0) labels.push(`tok ${Math.round((snapshot.tokens / maxTokens) * 100)}%`);
  return labels.length ? ` budget=${labels.join(",")}` : "";
}

function workflowToastMessage(snapshot, options = {}) {
  const maxChars = Number.isFinite(options.maxChars) ? options.maxChars : WORKFLOW_TOAST_MESSAGE_MAX_CHARS;
  return truncateText(redactFreeTextSecrets(renderWorkflowHeartbeatCard(snapshot, options).message), maxChars);
}

function workflowPhaseLabel(run) {
  const phase = run.currentPhase ? String(run.currentPhase) : "-";
  const phases = Array.isArray(run.meta?.phases) ? run.meta.phases.map((item) => String(item)) : [];
  if (phase === "-" || phases.length === 0) return phase;
  const index = phases.indexOf(phase);
  return index >= 0 ? `${phase}(${index + 1}/${phases.length})` : phase;
}

function workflowProgressToastMessage(run) {
  return workflowToastMessage(workflowToastSnapshot(run));
}

function workflowHeartbeatToastCard(run, options = {}) {
  return renderWorkflowHeartbeatCard(workflowToastSnapshot(run, options), options);
}

// Preserve exported aliases while keeping one canonical message formatter.
const workflowStartToastMessage = workflowProgressToastMessage;

function workflowTerminalToastMessage(run, options = {}) {
  return renderWorkflowTerminalCard(workflowToastSnapshot(run, options), options).message;
}

function workflowTerminalToastCard(run, options = {}) {
  return renderWorkflowTerminalCard(workflowToastSnapshot(run, options), options);
}

function workflowApplyToastCard(run, options = {}) {
  return renderWorkflowApplyCard(workflowToastSnapshot(run, options), options);
}

function workflowProgressToastSignature(run) {
  return workflowToastCardSignature(workflowToastSnapshot(run));
}

function workflowToastOptions(pluginContext) {
  return { ascii: pluginContext?.__workflowToastAscii === true };
}

function workflowToastPolicyState(run) {
  run.toastPolicyState ??= createWorkflowToastPolicyState();
  return run.toastPolicyState;
}

function renderWorkflowToastDecision(decision, pluginContext) {
  const options = workflowToastOptions(pluginContext);
  if (decision.card === "heartbeat") return renderWorkflowHeartbeatCard(decision.snapshot, options);
  if (decision.card === "problem") return renderWorkflowProblemCard(decision.snapshot, decision.problem, options);
  return undefined;
}

async function deliverWorkflowToastDecisions(pluginContext, decisions) {
  let delivered = false;
  for (const decision of decisions) {
    const card = renderWorkflowToastDecision(decision, pluginContext);
    if (!card) continue;
    await showToast(pluginContext, card.variant, card.title, card.message);
    delivered = true;
  }
  return delivered;
}

function createWorkflowToastEventSink(pluginContext, run, options = {}) {
  if (!hasWorkflowToast(pluginContext)) return undefined;
  return async (event) => {
    if (run.status !== "running") return;
    const now = Number.isFinite(options.now) ? options.now : Date.now();
    const snapshot = workflowToastSnapshot(run, { now });
    const decisions = evaluateWorkflowToastEventPolicy(workflowToastPolicyState(run), event, snapshot, {
      now,
      forceMs: options.forceMs,
      problemCooldownMs: options.problemCooldownMs,
      signature: workflowToastCardSignature(snapshot),
    });
    await deliverWorkflowToastDecisions(pluginContext, decisions);
  };
}

async function maybeShowWorkflowProgressToast(pluginContext, run, options = {}) {
  if (run.status !== "running") return false;
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  const forceMs = Number.isFinite(options.forceMs) && options.forceMs > 0 ? options.forceMs : WORKFLOW_PROGRESS_TOAST_FORCE_MS;
  const snapshot = workflowToastSnapshot(run, { now });
  const signature = workflowToastCardSignature(snapshot);
  const decisions = evaluateWorkflowToastTickPolicy(workflowToastPolicyState(run), snapshot, {
    now,
    forceMs,
    problemCooldownMs: options.problemCooldownMs,
    signature,
  });
  if (decisions.length === 0) return false;
  if (decisions.some((decision) => decision.card === "heartbeat")) {
    run.lastProgressToastSignature = signature;
    run.lastProgressToastAt = now;
  }
  return await deliverWorkflowToastDecisions(pluginContext, decisions);
}

function startWorkflowProgressToasts(pluginContext, run, options = {}) {
  if (!hasWorkflowToast(pluginContext)) return () => {};
  const intervalMs = Number.isFinite(options.intervalMs) && options.intervalMs > 0 ? options.intervalMs : WORKFLOW_PROGRESS_TOAST_INTERVAL_MS;
  const forceMs = Number.isFinite(options.forceMs) && options.forceMs > 0 ? options.forceMs : WORKFLOW_PROGRESS_TOAST_FORCE_MS;
  const timer = setInterval(() => {
    void maybeShowWorkflowProgressToast(pluginContext, run, { forceMs }).catch(() => {
      // Progress toasts are best effort and must not affect workflow execution.
    });
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

export {
  WORKFLOW_TOAST_MESSAGE_MAX_CHARS,
  WORKFLOW_TOAST_MAX_LANES,
  WORKFLOW_TOAST_DELIVERY_TIMEOUT_MS,
  hasWorkflowToast,
  showToast,
  workflowDisplayName,
  workflowQueuedAgents,
  workflowTotalCost,
  workflowCostLabel,
  workflowTotalTokens,
  compactDuration,
  laneRecordsForRun,
  lanePriority,
  shortModel,
  laneRuntimeLabel,
  workflowToastSnapshot,
  workflowBudgetLabel,
  workflowToastMessage,
  workflowPhaseLabel,
  workflowStartToastMessage,
  workflowHeartbeatToastCard,
  workflowProgressToastMessage,
  workflowTerminalToastMessage,
  workflowTerminalToastCard,
  workflowApplyToastCard,
  workflowProgressToastSignature,
  createWorkflowToastEventSink,
  renderWorkflowToastDecision,
  deliverWorkflowToastDecisions,
  maybeShowWorkflowProgressToast,
  startWorkflowProgressToasts,
};
