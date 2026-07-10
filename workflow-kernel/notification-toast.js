import { setTimeout as sleep } from "node:timers/promises";

import {
  WORKFLOW_PROGRESS_TOAST_FORCE_MS,
  WORKFLOW_PROGRESS_TOAST_INTERVAL_MS,
  WORKFLOW_TOAST_DURATION_MS,
} from "./constants.js";
import { truncateText } from "./text-json.js";
import { redactFreeTextSecrets } from "./free-text-redactor.js";
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

function workflowToastSnapshot(run, options = {}) {
  return workflowToastCardSnapshot(run, options);
}

function workflowHeartbeatToastCard(run, options = {}) {
  return renderWorkflowHeartbeatCard(workflowToastSnapshot(run, options), options);
}

function workflowTerminalToastCard(run, options = {}) {
  return renderWorkflowTerminalCard(workflowToastSnapshot(run, options), options);
}

function workflowApplyToastCard(run, options = {}) {
  return renderWorkflowApplyCard(workflowToastSnapshot(run, options), options);
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
  WORKFLOW_TOAST_DELIVERY_TIMEOUT_MS,
  hasWorkflowToast,
  showToast,
  workflowToastSnapshot,
  workflowHeartbeatToastCard,
  workflowTerminalToastCard,
  workflowApplyToastCard,
  createWorkflowToastEventSink,
  renderWorkflowToastDecision,
  deliverWorkflowToastDecisions,
  maybeShowWorkflowProgressToast,
  startWorkflowProgressToasts,
};
