import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { MAX_STATUS_STRING_CHARS } from "./constants.js";
import { redactFreeTextSecrets } from "./free-text-redactor.js";
import { extractTextFromError, redactValue, truncateText } from "./text-json.js";
import { WorkflowCancelledError } from "./errors.js";
import { assertWriteWorkflowAllowed } from "./authority-policy.js";
import { appendEvent, countNonEmptyLines } from "./event-journal.js";
import {
  assertContainedRealPath,
  assertSafeRunId,
  clearStaleRunLocks,
  readJsonFile,
  readRunById,
  runRoots,
  runs,
  writeJsonAtomic,
  writeLifecycleRequest,
  writeState,
} from "./run-store-status.js";
import { sessionApi } from "./session-access.js";
import { withTimeout } from "./async-util.js";
import { showToast, workflowTerminalToastCard } from "./notification-toast.js";

function isIdleStatus(status) {
  return status === "idle" || status?.type === "idle" || status?.status === "idle";
}

async function writeNotificationRecord(notification) {
  if (!notification.notificationPath) throw new Error("Notification record is missing notificationPath");
  await writeJsonAtomic(notification.notificationPath, redactValue(notification, { maxString: MAX_STATUS_STRING_CHARS }));
}

const NOTIFICATION_STATE_VERSION = 1;

const NOTIFICATION_DELIVERY_TIMEOUT_MS = 5_000;

const NOTIFICATION_SENDING_STALE_MS = 60_000;

const BACKGROUND_LIFECYCLE_SETTLE_TIMEOUT_MS = 1_000;

const CHILD_ABORT_TIMEOUT_MS = 1_000;

const NOTIFICATION_TRACKING_MAX = 1_000;

const NOTIFICATION_TRACKING_TTL_MS = 24 * 60 * 60 * 1000;

class BoundedTimestampSet {
  constructor({ max = NOTIFICATION_TRACKING_MAX, ttlMs = NOTIFICATION_TRACKING_TTL_MS } = {}) {
    this.max = max;
    this.ttlMs = ttlMs;
    this.items = new Map();
  }

  prune(nowMs = Date.now()) {
    const cutoff = nowMs - this.ttlMs;
    for (const [value, timestamp] of this.items) {
      if (timestamp >= cutoff) break;
      this.items.delete(value);
    }
    while (this.items.size > this.max) {
      const oldest = this.items.keys().next().value;
      if (oldest === undefined) break;
      this.items.delete(oldest);
    }
  }

  add(value) {
    const nowMs = Date.now();
    this.prune(nowMs);
    if (this.items.has(value)) this.items.delete(value);
    this.items.set(value, nowMs);
    this.prune(nowMs);
    return this;
  }

  has(value) {
    this.prune();
    return this.items.has(value);
  }

  delete(value) {
    return this.items.delete(value);
  }

  clear() {
    this.items.clear();
  }

  get size() {
    this.prune();
    return this.items.size;
  }

  values() {
    this.prune();
    return this.items.keys();
  }

  keys() {
    return this.values();
  }

  [Symbol.iterator]() {
    return this.values();
  }
}

const pendingNotificationPaths = new BoundedTimestampSet();

// Process-local synchronous mutex for in-flight completion-notification deliveries.
// Two concurrent callers (the background maybeDeliverCompletionNotification and the
// session.idle event handler) can both read a notification record with sendingAt=null
// across the await boundary before either persists its claim, then both promptAsync the
// same completion prompt. The disk sendingAt field guards cross-process; this Set guards
// the in-process race by being a check-and-add that runs entirely synchronously (no await
// between the membership check and the add).
const deliveringNotificationPaths = new Set();

const idleNotificationSessions = new BoundedTimestampSet();

function clearNotificationRuntimeState() {
  pendingNotificationPaths.clear();
  deliveringNotificationPaths.clear();
  idleNotificationSessions.clear();
}

async function writeCompletionNotification(run) {
  if (run.background !== true || !run.notificationTarget?.sessionID) return undefined;
  const notificationPath = path.join(run.dir, "notification.json");
  const existing = await readJsonFile(notificationPath, {});
  const record = {
    stateVersion: NOTIFICATION_STATE_VERSION,
    runId: run.id,
    status: run.status,
    workflowName: run.meta?.name,
    sourceHash: run.sourceHash,
    sessionID: run.notificationTarget.sessionID,
    messageID: run.notificationTarget.messageID,
    directory: run.notificationTarget.directory,
    agent: run.notificationTarget.agent,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    resultPath: run.resultPath,
    diffPlanHash: run.editPlan?.diffPlanHash,
    errorSummary: run.error ? truncateText(redactFreeTextSecrets(run.error), MAX_STATUS_STRING_CHARS) : undefined,
    createdAt: existing.createdAt ?? new Date().toISOString(),
    sentAt: existing.sentAt ?? null,
    delivery: existing.delivery ?? { attempts: 0, lastAttemptAt: null, lastError: null },
    notificationPath,
  };
  run.notification = redactValue(record, { maxString: MAX_STATUS_STRING_CHARS });
  await writeJsonAtomic(notificationPath, run.notification);
  if (!run.notification.sentAt) pendingNotificationPaths.add(notificationPath);
  return run.notification;
}

function sessionIDFromEvent(event) {
  const properties = event?.properties ?? {};
  return properties.sessionID ?? properties.sessionId ?? properties.session?.id ?? properties.info?.sessionID ?? properties.message?.info?.sessionID ?? properties.message?.sessionID;
}

function isSessionIdleEvent(event) {
  if (event?.type === "session.idle") return true;
  if (event?.type !== "session.status") return false;
  return isIdleStatus(event?.properties?.status ?? event?.properties?.session?.status);
}

function updateNotificationIdleState(event) {
  const sessionID = sessionIDFromEvent(event);
  if (!sessionID) return;
  if (isSessionIdleEvent(event)) {
    idleNotificationSessions.add(sessionID);
    return;
  }
  // Any non-idle event carrying this sessionID signals renewed activity, so clear
  // the idle flag. Restricting this to session.status events left a session falsely
  // flagged idle when idle->active was signaled by another event type, so a later
  // completion would deliver a continuation prompt into a possibly-busy session.
  idleNotificationSessions.delete(sessionID);
}

function workflowNotificationPrompt(notification) {
  return [
    `Workflow ${notification.runId} finished with status ${notification.status}.`,
    notification.resultPath ? `Result: ${notification.resultPath}` : undefined,
    notification.diffPlanHash ? `Diff plan hash: ${notification.diffPlanHash}` : undefined,
    notification.errorSummary ? `Error summary: ${truncateText(notification.errorSummary, MAX_STATUS_STRING_CHARS)}` : undefined,
    "The workflow is already terminal; do not poll workflow_status.",
    `Read the final output exactly once with workflow_status({ runId: "${notification.runId}", format: "json", detail: "result" }) if needed.`,
    "Summarize this workflow outcome for the user. Do not apply diff plans, mutate files, or close domain work unless the user explicitly asks.",
  ].filter(Boolean).join("\n");
}

function notificationSendingIsStale(notification, nowMs = Date.now()) {
  const sendingAt = notification.delivery?.sendingAt;
  if (!sendingAt) return false;
  const sentMs = Date.parse(sendingAt);
  return Number.isFinite(sentMs) && nowMs - sentMs >= NOTIFICATION_SENDING_STALE_MS;
}

function notificationDeliveryLockPath(notificationPath) {
  return `${notificationPath}.deliver.lock`;
}

async function notificationDeliveryLockIsStale(lockPath, nowMs = Date.now()) {
  let stat;
  try {
    stat = await fs.stat(lockPath);
  } catch {
    return false;
  }
  const mtimeMs = stat.mtimeMs;
  if (!Number.isFinite(mtimeMs)) return false;
  return nowMs - mtimeMs >= NOTIFICATION_SENDING_STALE_MS;
}

// Cross-process delivery claim. The in-process deliveringNotificationPaths Set only guards
// callers within THIS plugin process; two OpenCode/plugin processes handling the same idle
// session can both read notification.json with sendingAt=null across the await boundary and
// both promptAsync the same completion prompt. This lock file is the atomic cross-process
// claim: O_CREAT|O_EXCL ("wx") makes create-and-own a single atomic step that fails with
// EEXIST if another process already owns it. A unique claim token (pid + timestamp) is written
// for diagnostics, and a stale lock (older than NOTIFICATION_SENDING_STALE_MS) is reclaimed so
// a crashed owner cannot permanently suppress delivery. The release is always invoked from the
// delivery finally so a failed attempt never leaves a stuck lock.
async function acquireNotificationDeliveryLock(notificationPath) {
  const lockPath = notificationDeliveryLockPath(notificationPath);
  const tombstonePath = `${lockPath}.stale`;
  const claim = JSON.stringify({ pid: process.pid, claimedAt: new Date().toISOString() });
  const create = async () => {
    const handle = await fs.open(lockPath, "wx");
    try {
      await handle.writeFile(claim, "utf8");
    } finally {
      await handle.close();
    }
  };
  const release = async () => { await fs.unlink(lockPath).catch(() => {}); };
  try {
    await create();
    return { acquired: true, release };
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    if (!(await notificationDeliveryLockIsStale(lockPath))) return { acquired: false, release: async () => {} };
    // Serialize stale reclaimers through the tombstone directory, then atomically move the
    // abandoned lock out of the live path. Only the reclaimer that owns the tombstone may
    // create the replacement lock.
    try {
      await fs.mkdir(tombstonePath);
    } catch (reclaimError) {
      if (reclaimError.code === "EEXIST") return { acquired: false, release: async () => {} };
      throw reclaimError;
    }
    try {
      // The initial stale observation happened before acquiring the reclaim mutex. Another
      // reclaimer may have replaced that lock while this caller waited, so validate the live
      // path again while holding the mutex before moving anything out of it.
      if (!(await notificationDeliveryLockIsStale(lockPath))) return { acquired: false, release: async () => {} };
      try {
        await fs.rename(lockPath, path.join(tombstonePath, "lock"));
      } catch (renameError) {
        if (renameError.code === "ENOENT") return { acquired: false, release: async () => {} };
        throw renameError;
      }
      try {
        await create();
        return { acquired: true, release };
      } catch (reclaimError) {
        if (reclaimError.code === "EEXIST") return { acquired: false, release: async () => {} };
        throw reclaimError;
      }
    } finally {
      await fs.rm(tombstonePath, { recursive: true, force: true }).catch(() => {});
    }
  }
}

async function deliverWorkflowNotifications(pluginContext, event) {
  if (!isSessionIdleEvent(event)) return { delivered: 0, failed: 0, skipped: 0 };
  const sessionID = sessionIDFromEvent(event);
  const session = sessionApi(pluginContext);
  if (!sessionID || !session.has("promptAsync")) return { delivered: 0, failed: 0, skipped: 0 };
  // Rehydrate unsent persisted notifications before delivery so that records written
  // before a plugin/module reload are retried on the owning session's idle event.
  await rehydratePendingNotifications(pluginContext, event);
  let delivered = 0;
  let failed = 0;
  let skipped = 0;
  for (const notificationPath of [...pendingNotificationPaths]) {
    const notification = await readJsonFile(notificationPath, undefined);
    if (!notification) {
      pendingNotificationPaths.delete(notificationPath);
      continue;
    }
    if (notification.sessionID !== sessionID) {
      skipped += 1;
      continue;
    }
    if (notification.sentAt) {
      pendingNotificationPaths.delete(notificationPath);
      skipped += 1;
      continue;
    }
    // Synchronous in-process mutex: claim this path before any further await so a
    // concurrent caller that already read the same sendingAt=null record cannot also
    // promptAsync it. The check-and-add runs with no await in between, so at most one
    // caller wins per process; the exclusive delivery lock below covers cross-process.
    if (deliveringNotificationPaths.has(notificationPath)) {
      skipped += 1;
      continue;
    }
    deliveringNotificationPaths.add(notificationPath);
    let deliveryLock = null;
    try {
      // Atomic cross-process claim: if another OpenCode/plugin process already owns the
      // delivery for this notification, skip it here. The in-process Set above only covers
      // callers within this process; this lock file is the cross-process guard. Released in
      // the finally below so a failed delivery does not leave a stuck lock.
      deliveryLock = await acquireNotificationDeliveryLock(notificationPath);
      if (!deliveryLock.acquired) {
        skipped += 1;
        continue;
      }
      if (notification.delivery?.sendingAt) {
        if (!notificationSendingIsStale(notification)) {
          skipped += 1;
          continue;
        }
        notification.delivery = {
          ...notification.delivery,
          sendingAt: null,
          lastError: "Previous notification delivery attempt became stale before completion",
          staleAt: new Date().toISOString(),
        };
        await writeNotificationRecord(notification);
      }

      const now = new Date().toISOString();
      notification.delivery = {
        ...(notification.delivery ?? {}),
        attempts: (notification.delivery?.attempts ?? 0) + 1,
        lastAttemptAt: now,
        sendingAt: now,
        lastError: null,
      };
      await writeNotificationRecord(notification);
      try {
        const response = await withTimeout(() => session.promptAsync({
            sessionID: notification.sessionID,
            directory: notification.directory,
            body: {
              agent: notification.agent || "build",
              parts: [{ type: "text", text: workflowNotificationPrompt(notification) }],
            },
          }),
          { timeoutMs: Number.isFinite(pluginContext.__workflowNotificationTimeoutMs) ? pluginContext.__workflowNotificationTimeoutMs : NOTIFICATION_DELIVERY_TIMEOUT_MS, label: "workflow notification delivery" },
        );
        if (response?.error) throw new Error(response.error.message || response.error.name || "promptAsync failed");
        notification.sentAt = new Date().toISOString();
        notification.delivery = { ...notification.delivery, sendingAt: null, lastError: null };
        await writeNotificationRecord(notification);
        try {
          const runDir = path.dirname(notificationPath);
          const deliveryLatencyMs = Date.parse(notification.sentAt) - Date.parse(notification.delivery.lastAttemptAt);
          const totalLatencyMs = Date.parse(notification.sentAt) - Date.parse(notification.createdAt);
          await appendEvent({
            id: notification.runId,
            dir: runDir,
            eventCount: await countNonEmptyLines(path.join(runDir, "events.jsonl")),
          }, {
            type: "notification.delivered",
            attempts: notification.delivery.attempts,
            sentAt: notification.sentAt,
            lastAttemptAt: notification.delivery.lastAttemptAt,
            deliveryLatencyMs: Number.isFinite(deliveryLatencyMs) ? Math.max(0, deliveryLatencyMs) : undefined,
            totalLatencyMs: Number.isFinite(totalLatencyMs) ? Math.max(0, totalLatencyMs) : undefined,
          });
        } catch {
          // Notification latency events are observational; the notification record is authoritative.
        }
        pendingNotificationPaths.delete(notificationPath);
        delivered += 1;
      } catch (error) {
        notification.delivery = {
          ...notification.delivery,
          sendingAt: null,
          lastError: truncateText(extractTextFromError(error), MAX_STATUS_STRING_CHARS),
        };
        await writeNotificationRecord(notification);
        failed += 1;
      }
    } catch {
      // A writeNotificationRecord failure (transient disk error, or the run
      // directory being concurrently removed by workflow_cleanup) must not abort
      // delivery for the other still-pending notifications in this same pass.
      failed += 1;
      continue;
    } finally {
      deliveringNotificationPaths.delete(notificationPath);
      if (deliveryLock) await deliveryLock.release().catch(() => {});
    }
  }
  return { delivered, failed, skipped };
}

async function maybeDeliverCompletionNotification(pluginContext, notification) {
  if (!notification?.sessionID || !idleNotificationSessions.has(notification.sessionID)) return;
  try {
    await deliverWorkflowNotifications(pluginContext, { type: "session.idle", properties: { sessionID: notification.sessionID } });
  } catch {
    // Completion notifications are best effort; persisted state remains authoritative.
  }
}

// Notification RECOVERY (not durable execution). After a plugin/module reload the
// in-memory pendingNotificationPaths set is empty even though unsent notification.json
// records may still exist on disk. This scans the active project/worktree run roots and
// re-enqueues records that are still unsent, matching the idle session, and well-formed.
// It does not keep background workflows alive across OpenCode process death; a run whose
// owning process died stays stale until workflow_reconcile marks it interrupted.
async function rehydratePendingNotifications(pluginContext, event) {
  const directory = pluginContext?.directory || pluginContext?.worktree;
  if (!directory) return { rehydrated: 0, skipped: 0, scanned: 0 };
  const scopeContext = { directory, worktree: pluginContext?.worktree || directory };
  const sessionID = sessionIDFromEvent(event);
  let rehydrated = 0;
  let skipped = 0;
  let scanned = 0;
  for (const root of runRoots(scopeContext)) {
    let dirents;
    try {
      dirents = await fs.readdir(root, { withFileTypes: true });
    } catch {
      // Notification RECOVERY is best effort and runs inside the fire-and-forget event hook,
      // which must never throw (AGENTS.md). A missing root (ENOENT/ENOTDIR) is the normal case,
      // but a permission/IO failure (EPERM/EACCES/EIO) must be swallowed just the same: a throw
      // here would propagate out of deliverWorkflowNotifications and out of the event hook,
      // destabilizing the session or silencing later events. Skip this root and keep scanning.
      continue;
    }
    for (const dirent of dirents) {
      if (!dirent.isDirectory() && !dirent.isSymbolicLink()) continue;
      scanned += 1;
      const runDir = path.join(root, dirent.name);
      const notificationPath = path.join(runDir, "notification.json");
      if (pendingNotificationPaths.has(notificationPath)) continue;
      let notification;
      try {
        notification = await readJsonFile(notificationPath, undefined);
      } catch {
        // Malformed JSON: skip safely rather than poisoning the delivery queue.
        skipped += 1;
        continue;
      }
      if (!notification || typeof notification !== "object") { skipped += 1; continue; }
      if (typeof notification.sessionID !== "string" || notification.sessionID === "") { skipped += 1; continue; }
      if (typeof notification.directory !== "string" || notification.directory === "") { skipped += 1; continue; }
      if (sessionID && notification.sessionID !== sessionID) { skipped += 1; continue; }
      if (notification.sentAt) { skipped += 1; continue; }
      const resolvedPath = typeof notification.notificationPath === "string" ? notification.notificationPath : notificationPath;
      try {
        // Reject a tampered notificationPath that redirects delivery outside the run dir.
        await assertContainedRealPath(runDir, resolvedPath, "Workflow notification path");
      } catch {
        skipped += 1;
        continue;
      }
      pendingNotificationPaths.add(resolvedPath);
      rehydrated += 1;
    }
  }
  return { rehydrated, skipped, scanned };
}

function rejectWaitingAgents(run, error, predicate = () => true) {
  const remaining = [];
  for (const waiter of run.waitingAgents.splice(0)) {
    if (predicate(waiter)) waiter.reject(error);
    else remaining.push(waiter);
  }
  run.waitingAgents.push(...remaining);
}

async function abortChild(pluginContext, childID, directory) {
  const session = sessionApi(pluginContext);
  if (!childID || !session.has("abort")) return;
  try {
    const timeoutMs = Number.isFinite(pluginContext?.__workflowChildAbortTimeoutMs) && pluginContext.__workflowChildAbortTimeoutMs > 0
      ? pluginContext.__workflowChildAbortTimeoutMs
      : CHILD_ABORT_TIMEOUT_MS;
    await withTimeout(() => session.abort({ sessionID: childID, directory }), {
      timeoutMs,
      label: `Child session abort ${childID}`,
    });
  } catch {
    // Child abort is best effort.
  }
}

async function abortRunChildren(pluginContext, run, fallbackDirectory) {
  const aborts = [];
  const activeLanesByChildID = new Map();
  for (const lane of run.activeLaneAbortControllers?.values?.() ?? []) {
    try { lane.abortController?.abort?.(); } catch {}
    if (lane.childID) activeLanesByChildID.set(lane.childID, lane);
  }
  for (const [childID, directory] of run.children ?? []) {
    const lane = activeLanesByChildID.get(childID);
    if (lane?.childAbortRequested === true) continue;
    if (lane) lane.childAbortRequested = true;
    aborts.push(abortChild(pluginContext, childID, directory ?? fallbackDirectory));
  }
  for (const lane of run.activeLaneAbortControllers?.values?.() ?? []) {
    if (lane.childID && !(run.children ?? new Map()).has(lane.childID) && lane.childAbortRequested !== true) {
      lane.childAbortRequested = true;
      aborts.push(abortChild(pluginContext, lane.childID, lane.directory ?? fallbackDirectory));
    }
  }
  await Promise.allSettled(aborts);
}

async function awaitBackgroundRunIfPresent(run, settleTimeoutMs = BACKGROUND_LIFECYCLE_SETTLE_TIMEOUT_MS) {
  if (!run.background || !run.done) return;
  const ac = new AbortController();
  await Promise.race([
    run.done.catch(() => {}).finally(() => ac.abort()),
    sleep(settleTimeoutMs, undefined, { signal: ac.signal }).catch(() => {}),
  ]);
}

// Cooperative interrupt (pause/cancel) only requests a transition; the run does not reach its
// resumable/terminal status until the abort propagates through the in-flight lane and the
// background execution unwinds. After the bounded settle wait above, run.status is either the
// settled status (the run unwound inside the window) or still the transitional "pausing"/
// "cancelling" (the run is alive but not yet settled). Returning an unconditional "resume now"
// in the latter case is the documented surprise: an immediate resume hits the on-disk transitional
// status and is rejected with "not resumable from status pausing". So surface the actual status
// and, when not yet settled, point the caller at workflow_status to poll for the settled status
// before acting -- rather than promising a resume that will bounce.
function settleAwarePauseMessage(runId, run) {
  if (run.status === "paused") {
    return `Workflow ${runId} paused and is resumable. Resume with workflow_run({ resumeRunId: "${runId}" }).`;
  }
  return [
    `Pause requested for workflow ${runId}; the run is still settling (status ${run.status}).`,
    `Poll workflow_status({ runId: "${runId}" }) until status is paused, then resume with workflow_run({ resumeRunId: "${runId}" }).`,
    `Resuming before it settles returns the same settle guidance, not a hard "not resumable" error.`,
  ].join(" ");
}

function settleAwareCancelMessage(runId, run) {
  if (run.status === "cancelled") {
    return `Cancellation requested for workflow ${runId}; the run has settled to cancelled (terminal, not resumable).`;
  }
  return [
    `Cancellation requested for workflow ${runId}; the run is still settling (status ${run.status}).`,
    `Poll workflow_status({ runId: "${runId}" }) until it reaches a terminal status (cancelled).`,
  ].join(" ");
}

async function interruptRun(pluginContext, context, args, options) {
  assertWriteWorkflowAllowed(context, options.toolName);
  const runId = assertSafeRunId(args.runId);
  const run = runs.get(runId);
  if (!run) {
    const entry = await readRunById(context, runId);
    if (entry.kind !== "valid") throw new Error(`Cannot ${options.operation} invalid run ${runId}: ${entry.status}`);
    await writeLifecycleRequest(entry.dir, options.lifecycleType, options.remoteReason);
    return `${options.returnPrefix} requested for workflow ${args.runId}; active owner will observe ${options.lifecycleType}-request.json before launching more work.`;
  }
  const request = await writeLifecycleRequest(run.dir, options.lifecycleType, options.localReason);
  run.lifecycleRequests = { ...(run.lifecycleRequests ?? {}), [options.lifecycleType]: request };
  options.markRun(run);
  run.abortController.abort();
  rejectWaitingAgents(run, options.waitingError());
  try { await appendEvent(run, { type: options.eventType }); } catch {}
  await abortRunChildren(pluginContext, run, context.directory);
  await writeState(run);
  const card = workflowTerminalToastCard(run, { ascii: pluginContext?.__workflowToastAscii === true });
  await showToast(pluginContext, card.variant, card.title, card.message);
  const settleTimeoutMs = Number.isFinite(pluginContext?.__workflowLifecycleSettleTimeoutMs)
    ? pluginContext.__workflowLifecycleSettleTimeoutMs
    : BACKGROUND_LIFECYCLE_SETTLE_TIMEOUT_MS;
  await awaitBackgroundRunIfPresent(run, settleTimeoutMs);
  return options.localMessage(args.runId, run);
}

async function cancelRun(pluginContext, context, args) {
  return await interruptRun(pluginContext, context, args, {
    toolName: "workflow_cancel",
    operation: "cancel",
    lifecycleType: "cancel",
    remoteReason: "Cancellation requested from another OpenCode process",
    localReason: "Cancellation requested in this OpenCode process",
    returnPrefix: "Cancellation",
    eventType: "run.cancelling",
    waitingError: () => new WorkflowCancelledError(),
    markRun(run) {
      run.status = "cancelling";
    },
    localMessage: settleAwareCancelMessage,
  });
}

async function pauseRun(pluginContext, context, args) {
  return await interruptRun(pluginContext, context, args, {
    toolName: "workflow_pause",
    operation: "pause",
    lifecycleType: "pause",
    remoteReason: "Pause requested from another OpenCode process",
    localReason: "Pause requested in this OpenCode process",
    returnPrefix: "Pause",
    eventType: "run.pausing",
    waitingError: () => new WorkflowCancelledError("Workflow run was paused"),
    markRun(run) {
      run.pauseRequested = true;
      run.status = "pausing";
    },
    localMessage: settleAwarePauseMessage,
  });
}

// Force-terminate (workflow_kill). Unlike cooperative cancel/pause, kill does not wait on the
// background cooperative settle before returning. The killed run lands in a resumable terminal
// state (status "interrupted"), but the current owner keeps run.lock until its background
// execution actually unwinds so another process cannot resume while this owner may still write.
async function killRun(pluginContext, context, args) {
  assertWriteWorkflowAllowed(context, "workflow_kill");
  const runId = assertSafeRunId(args.runId);
  const run = runs.get(runId);
  if (!run) {
    // The run is not owned by this process (its owner may have died). Persist a durable kill
    // request that a still-live owner observes via checkDurableLifecycleRequest, and clear any
    // stale (dead-process) or corrupt locks immediately so a wedged run is not permanently
    // blocked on a dead owner's lock. A live owner's lock is left intact for it to release.
    const entry = await readRunById(context, runId);
    if (entry.kind !== "valid") throw new Error(`Cannot kill invalid run ${runId}: ${entry.status}`);
    await writeLifecycleRequest(entry.dir, "kill", "Force-terminate requested from another OpenCode process");
    const cleared = await clearStaleRunLocks(entry);
    return [
      `Force-terminate requested for workflow ${args.runId}.`,
      cleared.length > 0
        ? `Cleared ${cleared.length} stale lock(s): ${cleared.map((lock) => lock.operation).join(", ")}.`
        : "No stale locks to clear.",
      "A live owner will observe kill-request.json and abandon the run to a resumable (interrupted) state.",
    ].join(" ");
  }
  // Owned in this process: abort immediately, mark the run resumable, keep the run lock held by
  // this owner until run.done settles, and return promptly.
  const request = await writeLifecycleRequest(run.dir, "kill", "Force-terminate requested in this OpenCode process");
  run.lifecycleRequests = { ...(run.lifecycleRequests ?? {}), kill: request };
  run.killed = true;
  run.status = "interrupted";
  run.finishedAt = run.finishedAt ?? new Date().toISOString();
  run.abortController.abort();
  rejectWaitingAgents(run, new WorkflowCancelledError("Workflow run was force-terminated"));
  try { await appendEvent(run, { type: "run.killed" }); } catch {}
  await abortRunChildren(pluginContext, run, context.directory);
  await writeState(run);
  const card = workflowTerminalToastCard(run, { ascii: pluginContext?.__workflowToastAscii === true });
  await showToast(pluginContext, card.variant, card.title, card.message);
  return `Workflow ${args.runId} force-terminated; state is resumable (status interrupted). The active owner is still settling and will release run.lock when it can no longer write. Resume with workflow_run({ resumeRunId: "${args.runId}" }) after workflow_status shows the run lock is released or stale/reconciled.`;
}

export {
  NOTIFICATION_STATE_VERSION,
  NOTIFICATION_DELIVERY_TIMEOUT_MS,
  NOTIFICATION_SENDING_STALE_MS,
  CHILD_ABORT_TIMEOUT_MS,
  NOTIFICATION_TRACKING_MAX,
  NOTIFICATION_TRACKING_TTL_MS,
  pendingNotificationPaths,
  deliveringNotificationPaths,
  idleNotificationSessions,
  clearNotificationRuntimeState,
  writeCompletionNotification,
  sessionIDFromEvent,
  isSessionIdleEvent,
  updateNotificationIdleState,
  workflowNotificationPrompt,
  notificationSendingIsStale,
  notificationDeliveryLockPath,
  notificationDeliveryLockIsStale,
  acquireNotificationDeliveryLock,
  deliverWorkflowNotifications,
  maybeDeliverCompletionNotification,
  rehydratePendingNotifications,
  rejectWaitingAgents,
  abortChild,
  abortRunChildren,
  awaitBackgroundRunIfPresent,
  settleAwarePauseMessage,
  settleAwareCancelMessage,
  interruptRun,
  cancelRun,
  pauseRun,
  killRun,
};
