// child-agent-runner.js — the child-agent lane boundary extracted from the workflow
// orchestrator (opencode-workflows-96b, stage 3 of the staged RunContext split).
//
// Owns runChildAgent (the full launch/cache/retry/integration/journal lifecycle of a
// single workflow lane) plus journalFailure (its terminal-failure recorder) and the
// lane-scoped helpers that exist only to serve a lane: worktree creation, edit-plan
// accumulation, patch normalization, lane task summaries, integration-lane lookup, and the
// resume cache-hit / checkpoint-hit discriminators.
//
// Coupling surface: every entry takes the shared mutable {@link RunContext} `run` object.
// A small `deps` bundle injects the orchestrator-resident primitives this boundary needs
// (concurrency slots, abort/cancel guards, durable-lifecycle polling, dirty-worktree
// salvage) so this module imports ONLY leaf kernel modules and never workflow-plugin.js,
// keeping the import graph acyclic (workflow-plugin.js -> sandbox-executor.js ->
// child-agent-runner.js, never back).
//
// @typedef {import("./run-context.js").RunContext} RunContext

import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import {
  DEFAULT_RETRY_COUNT,
  DEFAULT_CORRECTIVE_RETRY_COUNT,
  DEFAULT_CHILD_CREATE_TIMEOUT_MS,
  DEFAULT_CHILD_PROMPT_TIMEOUT_MS,
  MAX_DEBUG_CAPTURE_FILE_BYTES,
  MAX_CORRECTIVE_RETRY_COUNT,
  MAX_CHILD_PROMPT_TIMEOUT_MS,
  MAX_STATUS_STRING_CHARS,
} from "./constants.js";
import {
  extractTextFromError,
  hash,
  redactDurableValue,
  stableStringify,
  textPart,
  truncateText,
} from "./text-json.js";
import { redactFreeTextSecrets } from "./free-text-redactor.js";
import {
  WorkflowAuthorityError,
  WorkflowBudgetStoppedError,
  WorkflowCancelledError,
  classifyLaneError,
  computeLaneBackoffMs,
  retryAfterMsFromError,
} from "./errors.js";
import {
  boundedSchemaSnapshot,
  structuredCorrectiveInstruction,
  structuredTextInstruction,
  parseStructuredTextResult,
  validateStructuredResult,
} from "./structured-output.js";
import { sessionApi } from "./session-access.js";
import { withTimeout } from "./async-util.js";
import { abortChild } from "./lifecycle-control.js";
import { unwrapClientResult } from "./capability-adapter.js";
import { checkBudgetBeforeLaunch, reserveLaneBudget, releaseLaneBudget } from "./budget-accounting.js";
import {
  appendEvent,
  appendIntegrationLedger,
  claimResumeSignatureFallback,
  laneFailureClassForError,
  laneOutcomeForError,
  laneSignature,
  markResumeSignatureClaimed,
} from "./event-journal.js";
import {
  readLaneResultCheckpoint,
  recordLaneOutcome,
  removeLaneCheckpoint,
  safeProjectionName,
  writeLaneCheckpoint,
  writeFilePrivate,
  writeLaneProjection,
  writeState,
} from "./run-store-status.js";
import {
  modelKey,
  normalizeAgentOptions,
  resolveLaneModel,
  resolveLanePolicy,
  resolveRequestedModel,
} from "./authority-policy.js";
import {
  clearLaneEffort,
  laneEffortPolicyForModel,
  normalizeLaneEffort,
  registerLaneEffort,
} from "./lane-effort-policy.js";
import { mergeRoleDefaults, resolveRole } from "./role-template-loading.js";
import { changedPathsSinceBase } from "./integration-mode.js";
import { createWorktreeAdapter } from "./worktree-adapter.js";
import { responseText } from "./text-json.js";

// --- lane-scoped helpers (owned here; re-exported by workflow-plugin.js for the barrel) ---

function permissionRuleKey(rule) {
  return stableStringify({ permission: rule?.permission, pattern: rule?.pattern, action: rule?.action });
}

function normalizeCorrectiveRetries(value) {
  if (Number.isInteger(value) && value >= 0) return Math.min(value, MAX_CORRECTIVE_RETRY_COUNT);
  return DEFAULT_CORRECTIVE_RETRY_COUNT;
}

function normalizePermissionRules(rules) {
  return rules.map((rule) => ({ permission: rule?.permission, pattern: rule?.pattern, action: rule?.action }))
    .sort((a, b) => permissionRuleKey(a).localeCompare(permissionRuleKey(b)));
}

function extractEchoedSessionPermission(created) {
  if (created?.data && Object.hasOwn(created.data, "permission")) return created.data.permission;
  if (created && Object.hasOwn(created, "permission")) return created.permission;
  return undefined;
}

export function sessionPermissionEchoStatus(created, expectedRules = []) {
  const echoed = extractEchoedSessionPermission(created);
  if (echoed === undefined) return { state: "not-echoed", expectedCount: expectedRules.length };
  if (!Array.isArray(echoed)) {
    return {
      state: "mismatch",
      expectedCount: expectedRules.length,
      echoedCount: 0,
      reason: "echoed permission field is not an array",
    };
  }

  const expected = normalizePermissionRules(expectedRules);
  const actual = normalizePermissionRules(echoed);
  const expectedKeys = new Set(expected.map(permissionRuleKey));
  const actualKeys = new Set(actual.map(permissionRuleKey));
  const missing = expected.filter((rule) => !actualKeys.has(permissionRuleKey(rule)));
  const unexpected = actual.filter((rule) => !expectedKeys.has(permissionRuleKey(rule)));
  if (missing.length === 0 && unexpected.length === 0) {
    return { state: "verified", expectedCount: expected.length, echoedCount: actual.length };
  }
  return {
    state: "mismatch",
    expectedCount: expected.length,
    echoedCount: actual.length,
    missing,
    unexpected,
  };
}

// Deterministic replacement for the deleted LLM directory-echo probe: the typed opencode Session
// always echoes `directory` on servers >= MIN_OPENCODE_SERVER_VERSION, so a lane can assert the
// child session actually landed in the lane's directory (worktree or primary) without asking the
// child to self-report. Symlink-aware: this plugin repo is itself commonly reached through a
// symlinked config directory in production, so the server may echo either the requested path or
// its realpath (or vice versa) — path.resolve is tried first, then realpathSync on both sides.
export function sessionDirectoryEchoStatus(created, expectedDirectory) {
  const echoed = created?.data?.directory ?? created?.directory;
  const expected = String(expectedDirectory ?? "");
  if (echoed === undefined || echoed === null || echoed === "") return { state: "not-echoed", expected };
  const same = (a, b) => {
    if (path.resolve(String(a)) === path.resolve(String(b))) return true;
    try {
      return fsSync.realpathSync(String(a)) === fsSync.realpathSync(String(b));
    } catch {
      return false;
    }
  };
  return same(echoed, expected)
    ? { state: "verified", echoed: String(echoed), expected }
    : { state: "mismatch", echoed: String(echoed), expected };
}

export function laneTaskSummary(prompt, opts = {}, title) {
  const explicit = opts.taskSummary || opts.summary || opts.label || opts.title;
  if (explicit) return truncateText(redactFreeTextSecrets(String(explicit)), 160);
  const firstLine = String(prompt ?? "").split(/\r?\n/).find((line) => line.trim());
  return truncateText(redactFreeTextSecrets(firstLine || title || "workflow lane"), 160);
}

function durationMs(start, end) {
  const startMs = typeof start === "string" ? Date.parse(start) : Number.NaN;
  const endMs = typeof end === "string" ? Date.parse(end) : Number.NaN;
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return undefined;
  return Math.max(0, endMs - startMs);
}

function capUtf8Text(text, maxBytes = MAX_DEBUG_CAPTURE_FILE_BYTES) {
  const string = String(text ?? "");
  const bytes = Buffer.byteLength(string, "utf8");
  if (bytes <= maxBytes) return string;
  const marker = `\n[truncated to ${maxBytes} bytes from ${bytes} bytes]\n`;
  const markerBytes = Buffer.byteLength(marker, "utf8");
  const budget = Math.max(0, maxBytes - markerBytes);
  let head = string;
  while (Buffer.byteLength(head, "utf8") > budget && head.length > 0) {
    const ratio = budget / Math.max(1, Buffer.byteLength(head, "utf8"));
    head = head.slice(0, Math.max(0, Math.floor(head.length * ratio) - 1));
  }
  return `${head}${marker}`;
}

function extractMessagesArray(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  if (Array.isArray(value.data)) return value.data;
  if (value.data && Array.isArray(value.data.messages)) return value.data.messages;
  if (value.data && Array.isArray(value.data.data)) return value.data.data;
  if (Array.isArray(value.messages)) return value.messages;
  return [];
}

function promptDebugMarkdown({ callId, title, baseSystem, prompt, outputFormat }) {
  return [
    `# Workflow Lane Debug Capture`,
    "",
    `Call ID: ${redactFreeTextSecrets(callId)}`,
    `Title: ${redactFreeTextSecrets(title)}`,
    "",
    "## Rendered System Prompt",
    "",
    redactFreeTextSecrets(baseSystem ?? ""),
    "",
    "## Task Prompt",
    "",
    redactFreeTextSecrets(prompt ?? ""),
    "",
    "## Output Format",
    "",
    "```json",
    JSON.stringify(redactDurableValue(outputFormat ?? { type: "text" }), null, 2),
    "```",
    "",
  ].join("\n");
}

function transcriptJsonl(messages, maxBytes = MAX_DEBUG_CAPTURE_FILE_BYTES) {
  let output = "";
  let bytes = 0;
  let truncated = 0;
  for (const message of messages) {
    const line = `${JSON.stringify(redactDurableValue(message))}\n`;
    const lineBytes = Buffer.byteLength(line, "utf8");
    if (bytes + lineBytes > maxBytes) {
      truncated += 1;
      continue;
    }
    output += line;
    bytes += lineBytes;
  }
  if (truncated > 0) {
    const marker = `${JSON.stringify({ type: "debug_capture.truncated", skippedMessages: truncated, maxBytes })}\n`;
    while (Buffer.byteLength(output + marker, "utf8") > maxBytes && output.length > 0) {
      output = output.slice(0, Math.floor(output.length * 0.9));
    }
    output += marker;
  }
  return output;
}

async function captureLaneDebugArtifacts(pluginContext, run, details) {
  if (run.debugCapture?.enabled !== true || details.debugCaptured?.value === true) return;
  details.debugCaptured.value = true;
  const {
    callId,
    childID,
    laneDirectory,
    title,
    prompt,
    baseSystem,
    schema,
    outputFormat,
    outcome,
  } = details;
  const debugDir = path.join(run.dir, "debug", safeProjectionName(callId));
  try {
    await writeFilePrivate(
      path.join(debugDir, "prompt.md"),
      capUtf8Text(promptDebugMarkdown({ callId, title, baseSystem, prompt, outputFormat })),
      "utf8",
    );
    await writeFilePrivate(
      path.join(debugDir, "schema.json"),
      capUtf8Text(JSON.stringify(redactDurableValue(schema ?? null), null, 2)),
      "utf8",
    );
    const session = sessionApi(pluginContext);
    if (!childID || !session.has("messages")) {
      await writeFilePrivate(
        path.join(debugDir, "transcript.jsonl"),
        transcriptJsonl([{ type: "debug_capture.unavailable", reason: childID ? "session.messages unavailable" : "missing childID" }]),
        "utf8",
      );
      await appendEvent(run, { type: "debug_capture.transcript_unavailable", callId, childID, reason: childID ? "session.messages unavailable" : "missing childID" });
      return;
    }
    const transcript = unwrapClientResult(await session.messages({ sessionID: childID, directory: laneDirectory }), `Debug capture transcript read for ${childID}`);
    await writeFilePrivate(
      path.join(debugDir, "transcript.jsonl"),
      transcriptJsonl(extractMessagesArray(transcript)),
      "utf8",
    );
    await appendEvent(run, { type: "debug_capture.written", callId, childID, outcome, debugPath: `debug/${safeProjectionName(callId)}` });
  } catch (error) {
    await appendEvent(run, { type: "debug_capture.failed", callId, childID, error: truncateText(extractTextFromError(error), MAX_STATUS_STRING_CHARS) });
  }
}

export function findIntegrationLane(run, callId) {
  return run.integrationPlan?.lanes?.find((lane) => lane.callId === callId);
}

export function normalizePatches(result) {
  const patches = Array.isArray(result?.patches) ? result.patches : Array.isArray(result) ? result : [];
  return patches.map((patch, index) => {
    if (!patch || typeof patch !== "object") throw new Error(`Invalid edit patch at index ${index}`);
    const relativePath = String(patch.path ?? patch.file ?? "");
    if (!relativePath || path.isAbsolute(relativePath) || relativePath.split(/[\\/]+/).includes("..")) {
      throw new Error(`Invalid edit patch path at index ${index}: ${relativePath}`);
    }
    if (!Object.hasOwn(patch, "content")) throw new Error(`Edit patch ${relativePath} is missing content`);
    // Only full-file "replace" semantics are implemented at the apply sites
    // (safeWriteFileWithinRoot does an unconditional whole-file write). Any other
    // mode (e.g. "append") would otherwise be normalized, committed to the
    // diff-plan hash, and then silently replace the file at apply time. Reject it
    // here so the schema is honest rather than approving a plan we cannot honor.
    const mode = patch.mode == null ? "replace" : String(patch.mode);
    if (mode !== "replace") {
      throw new Error(`Unsupported edit patch mode for ${relativePath}: ${mode} (only "replace" is supported)`);
    }
    // Drop the (now always-"replace") mode field rather than carrying it into the
    // patch object: it was committed to computeDiffPlanHash but never read at any
    // apply site, so persisting it would re-introduce a hashed-but-ignored field.
    return { path: relativePath, content: String(patch.content) };
  });
}

export function addEditPlanFromResult(run, callId, result, worktreeRecord) {
  const patches = normalizePatches(result);
  for (const patch of patches) {
    run.editPlan.patches.push({ ...patch, callId, worktreePath: worktreeRecord?.path });
  }
}

function retagRecordsForCallId(records, originalCallId, callId) {
  let count = 0;
  if (!Array.isArray(records)) return count;
  for (const record of records) {
    if (record?.callId !== originalCallId) continue;
    record.callId = callId;
    count += 1;
  }
  return count;
}

export function retagRehydratedLanePlan(run, originalCallId, callId, entry) {
  const retagged = {
    editPatches: 0,
    editWorktrees: retagRecordsForCallId(run.editWorktrees, originalCallId, callId),
    integrationLanes: 0,
    integrationWorktrees: retagRecordsForCallId(run.integrationWorktrees, originalCallId, callId),
  };
  if (run.editPlan?.patches && entry?.worktreePath) {
    for (const patch of run.editPlan.patches) {
      if (patch?.callId !== originalCallId) continue;
      patch.callId = callId;
      retagged.editPatches += 1;
    }
    if (
      retagged.editPatches === 0
      && entry.result
      && typeof entry.result === "object"
      && !run.editPlan.patches.some((patch) => patch.callId === callId)
    ) {
      addEditPlanFromResult(run, callId, entry.result, { path: entry.worktreePath });
      retagged.editPatches = run.editPlan.patches.filter((patch) => patch.callId === callId).length;
    }
  }
  if (run.integrationPlan?.lanes && entry?.integrationLane) {
    const oldLane = run.integrationPlan.lanes.find((lane) => lane?.callId === originalCallId);
    const newLane = run.integrationPlan.lanes.find((lane) => lane?.callId === callId);
    if (oldLane) {
      oldLane.callId = callId;
      retagged.integrationLanes = 1;
    } else if (!newLane) {
      run.integrationPlan.lanes.push({ ...entry.integrationLane, callId });
      retagged.integrationLanes = 1;
    }
  }
  return retagged;
}

export async function createEditWorktree(run, toolContext, callId) {
  if (run.capabilities.worktree !== "available" || run.capabilities.directoryRooting !== "available") {
    throw new WorkflowAuthorityError("Edit mode requires available native worktree and child directory-rooting capabilities");
  }
  const fallbackPath = path.join(run.dir, "worktrees", callId.replace(/[^a-z0-9_.-]+/gi, "_"));
  await fs.mkdir(path.dirname(fallbackPath), { recursive: true });
  const worktreeName = `workflow-${run.id}-${hash(callId).slice(0, 8)}`;
  const branch = `workflow/${run.id}/${hash(callId).slice(0, 8)}`;
  const created = await run.adapter.createWorktree({
    name: worktreeName,
    path: fallbackPath,
    branch,
    directory: toolContext.directory,
  });
  const worktreePath = created?.path || created?.directory || created?.dir || fallbackPath;
  const resolvedWorktreePath = path.resolve(worktreePath);
  if (resolvedWorktreePath === path.resolve(toolContext.directory)) {
    throw new WorkflowAuthorityError(`Edit worktree path resolves to the primary tree (${resolvedWorktreePath}); refusing to run edit lanes against the primary checkout`);
  }
  // Register the tracking record BEFORE the defensive mkdir below. createWorktree() has already
  // created the real worktree dir + branch (workflow/<runId>/<hash>); cleanupWorktrees() and
  // reclaimStrandedWorktrees() iterate ONLY run.editWorktrees / persisted state.editWorktrees, so
  // if the trailing fs.mkdir throws (ENOSPC/EACCES/EMFILE under concurrent lanes, or an ancestor
  // racing away) after an unregistered creation, the worktree+branch are orphaned with no code path
  // that ever discovers them (recover() is never called). Pushing first makes a post-creation
  // failure recoverable (opencode-workflows-ndsr).
  const record = { callId, path: worktreePath, id: created?.id, name: created?.name ?? worktreeName, branch: created?.branch ?? branch };
  run.editWorktrees.push(record);
  await fs.mkdir(worktreePath, { recursive: true });
  return record;
}

export async function createIntegrationLaneWorktree(pluginContext, run, toolContext, callId) {
  if (!run.integrationPlan) throw new WorkflowAuthorityError("Integration lane requested without integration plan");
  if (!run.worktreeAdapter) {
    const primary = path.resolve(toolContext.worktree || toolContext.directory);
    run.worktreeAdapter = await createWorktreeAdapter({
      directory: primary,
      worktreeRoot: path.join(path.dirname(primary), `${path.basename(primary)}.workflow-worktrees`),
      integrationValidator: pluginContext?.__workflowIntegrationValidator,
      signal: run.abortController.signal,
    });
  }
  const laneId = hash(callId).slice(0, 12);
  const record = await run.worktreeAdapter.createLaneWorktree({
    runId: run.id,
    laneId,
    baseRef: run.integrationPlan.baseCommit,
  });
  const normalized = { callId, laneId, ...record };
  run.integrationWorktrees.push(normalized);
  await appendIntegrationLedger(run, { phase: "lane-worktree-created", callId, laneId, path: normalized.path, branch: normalized.branch });
  await writeLaneProjection(run, callId, { status: "worktree-created", laneId, worktreePath: normalized.path, branch: normalized.branch });
  return normalized;
}

// Resume cache-hit discriminator. The runChildAgent resume branch must reuse a prior journal
// entry whose signature + outcome match WITHOUT re-running the lane, but a recovered-from-
// transcript entry (workflow_salvage, tagged salvagedFromTranscript: true) is strictly weaker
// evidence than a controller-captured result, so it routes to a distinct cache.salvaged_hit
// event. Non-salvaged cache hits keep emitting cache.hit exactly as before. Returns null when
// the signature/outcome predicate is not satisfied (lane will be re-run or invalidated).
export function classifyResumeCacheHit(cached, sig) {
  if (!cached || cached.signatureHash !== sig || cached.outcome !== "success") return null;
  return cached.salvagedFromTranscript === true
    ? { kind: "salvaged-hit", eventType: "cache.salvaged_hit" }
    : { kind: "hit", eventType: "cache.hit" };
}

// Resume cache-hit discriminator for the durable lane checkpoint (234m.1). A result checkpoint
// written by THIS run's controller capture is trusted when its signatureHash matches the lane's
// expected signature: it is the same own-store evidence that would have reached journal.jsonl had
// the crash window not fallen between prompt-return and recordLaneOutcome. Returns a distinct
// cache.checkpoint_hit event -- separate from cache.hit (journal replay) and cache.salvaged_hit
// (transcript-recovered) -- so the three resume provenances stay observable: checkpoint
// (own-store, same signature, no journal entry yet) > journal (controller-captured, journaled) >
// salvage (transcript-recovered, weaker). Returns null when the checkpoint is absent or its
// signature does not match, so the lane falls through to the authoritative journal check / re-run.
export function checkpointHitForSignature(checkpoint, sig) {
  if (!checkpoint || !sig || checkpoint.signatureHash !== sig) return null;
  return { kind: "checkpoint-hit", eventType: "cache.checkpoint_hit", result: checkpoint.result };
}

// Backoff sleep that bails the moment the lane (or its parent run) is aborted/cancelled,
// so a long Retry-After wait cannot defer a cancel/force-kill. Rejects with a
// WorkflowCancelledError on abort (terminal-classed: never retried) so the lane unwinds
// through the normal cancellation path instead of sleeping out the full delay.
function abortableBackoffSleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new WorkflowCancelledError("Lane aborted during retry backoff"));
      return;
    }
    let onAbort;
    const timer = setTimeout(() => {
      if (onAbort) signal?.removeEventListener?.("abort", onAbort);
      resolve();
    }, Math.max(0, ms));
    onAbort = () => {
      clearTimeout(timer);
      reject(new WorkflowCancelledError("Lane aborted during retry backoff"));
    };
    signal?.addEventListener?.("abort", onAbort, { once: true });
  });
}

/**
 * Launch (or resume-cache-hit) a single child-agent lane.
 *
 * @param {object} pluginContext OpenCode plugin context.
 * @param {object} toolContext Tool-call context (sessionID, directory, abort, ...).
 * @param {RunContext} run Shared mutable run state.
 * @param {object} payload Host "agent" op payload ({ callId, prompt, opts }).
 * @param {object} deps Orchestrator-resident primitives injected to keep the import graph acyclic.
 * @param {(run: RunContext, toolContext: object) => void} deps.throwIfAborted
 * @param {(run: RunContext, callId: string) => void} deps.throwIfLaneCancelled
 * @param {(run: RunContext, callId: string) => Promise<void>} deps.acquireAgentSlot
 * @param {(run: RunContext) => void} deps.releaseAgentSlot
 * @param {(run: RunContext) => Promise<void>} deps.checkDurableLifecycleRequest
 * @param {(worktreePath: string|undefined, extra?: object) => Promise<object|undefined>} deps.dirtyWorktreeSalvage
 */
export async function runChildAgent(pluginContext, toolContext, run, payload, deps) {
  const {
    throwIfAborted,
    throwIfLaneCancelled,
    acquireAgentSlot,
    releaseAgentSlot,
    checkDurableLifecycleRequest,
    dirtyWorktreeSalvage,
  } = deps;

  throwIfAborted(run, toolContext);
  if (run.capabilities.childSession !== "available") {
    throw new Error("Child sessions are unavailable in the active OpenCode client");
  }

  const prompt = String(payload.prompt ?? "");
  let opts = payload.opts && typeof payload.opts === "object" ? payload.opts : {};
  const callId = String(payload.callId ?? `agent:${run.agentsStarted}`);
  const title = redactFreeTextSecrets(opts.label || `workflow ${run.id} ${callId}`);
  const taskSummary = laneTaskSummary(prompt, opts, title);
  let laneEnqueuedAt;
  let laneStartedAt;
  let model;
  let effort;
  let effortPolicy;
  let agent;
  let role;
  let retryCount;
  let correctiveRetries;
  let schema;
  let timeoutMs;
  let baseSystem;
  let policy;
  let outputFormat;
  let resolved;
  let roleInfo;
  let worktreeRecord;
  let integrationLane = false;
  let integrationLaneRecord;
  let sig = hash(stableStringify({ sourceHash: run.sourceHash, runtimeArgs: run.runtimeArgs, prompt, opts: normalizeAgentOptions(opts), preflight: true }));
  let childID;
  let permissionEcho;
  let acquired = false;
  let failureJournaled = false;
  const debugCaptured = { value: false };
  const laneAbortController = new AbortController();
  const runAbortListener = () => laneAbortController.abort();
  run.abortController.signal.addEventListener("abort", runAbortListener, { once: true });
  if (run.abortController.signal.aborted) laneAbortController.abort();
  run.activeLaneAbortControllers?.set(callId, { abortController: laneAbortController, childID: undefined, directory: undefined });

  async function journalFailure(error, returnedNullDueToFailure = false, outcomeDetails = {}) {
    if (failureJournaled) return;
    failureJournaled = true;
    const outcome = laneOutcomeForError(error);
    const failureClass = outcomeDetails.failureClass ?? laneFailureClassForError(error);
    const retryable = outcomeDetails.retryable ?? (failureClass === "transient" || failureClass === "transient_exhausted" || failureClass === "validation_exhausted");
    const salvage = await dirtyWorktreeSalvage(worktreeRecord?.path, {
      callId,
      laneId: worktreeRecord?.laneId,
      branch: worktreeRecord?.branch,
      childID,
      outcome,
      reason: truncateText(extractTextFromError(error), MAX_STATUS_STRING_CHARS),
    });
    await captureLaneDebugArtifacts(pluginContext, run, {
      debugCaptured,
      callId,
      childID,
      laneDirectory: worktreeRecord?.path || toolContext.directory,
      title,
      prompt,
      baseSystem,
      schema,
      outputFormat,
      outcome,
    });
    await recordLaneOutcome(run, {
      callId,
      signatureHash: sig,
      outcome,
      childID,
      title,
      taskSummary,
      enqueuedAt: laneEnqueuedAt,
      startedAt: laneStartedAt,
      model: resolved?.modelKey,
      agent,
      role,
      timeoutMs,
      worktreePath: worktreeRecord?.path,
      integrationLane: integrationLane ? findIntegrationLane(run, callId) : undefined,
      salvage,
      permissionPolicy: resolved?.policy,
      permissionEcho,
      error: extractTextFromError(error),
      errorSummary: truncateText(redactFreeTextSecrets(extractTextFromError(error)), MAX_STATUS_STRING_CHARS),
      // The retry decision input: only a transient-classed failure (incl. one that exhausted
      // its backed-off retries) is worth re-attempting on a later resume; a terminal one
      // (bad model id, auth, schema) is not.
      failureClass,
      retryable,
      ...outcomeDetails,
      returnedNullDueToFailure,
    });
    if (salvage?.dirty) await appendEvent(run, { type: "agent.salvageable_dirty_failure", callId, childID, worktreePath: salvage.worktreePath, changedFileCount: salvage.changedFileCount, outcome });
    await appendEvent(run, { type: `agent.${outcome}`, callId, childID, failureClass, error: truncateText(extractTextFromError(error), MAX_STATUS_STRING_CHARS) });
    await writeState(run);
  }

  try {
    role = typeof opts.role === "string" ? opts.role : undefined;
    roleInfo = await resolveRole(role, pluginContext?.__workflowRoleDir);
    opts = mergeRoleDefaults(roleInfo?.defaults, opts);
    model = resolveRequestedModel(resolveLaneModel(run, opts), "child");
    effort = normalizeLaneEffort(opts.effort);
    effortPolicy = laneEffortPolicyForModel(effort, model);
    agent = typeof opts.agent === "string" ? opts.agent : typeof opts.agentType === "string" ? opts.agentType : undefined;
    retryCount = Number.isInteger(opts.retryCount) ? opts.retryCount : DEFAULT_RETRY_COUNT;
    correctiveRetries = normalizeCorrectiveRetries(opts.correctiveRetries);
    schema = opts.schema;
    timeoutMs = Math.min(
      Number.isInteger(opts.timeoutMs) && opts.timeoutMs > 0 ? opts.timeoutMs : (run.laneTimeoutMs ?? DEFAULT_CHILD_PROMPT_TIMEOUT_MS),
      MAX_CHILD_PROMPT_TIMEOUT_MS,
    );
    // Design C: the structured-TEXT path (instruction + parse + corrective retry) is the
    // one production-proven route (see commit 0b48f51); native `format:` was gated behind
    // a probe that no longer exists. Text is now the only structured path.
    const useStructuredTextFallback = Boolean(schema);
    baseSystem = [
      "You are a child worker for an OpenCode workflow.",
      "Your final response is consumed as the workflow return value.",
      "Be concise and return raw findings/results, not a conversational status update.",
      roleInfo ? `Role ${roleInfo.name}:\n${roleInfo.content}` : "",
      opts.system || "",
      useStructuredTextFallback ? structuredTextInstruction(schema) : "",
    ]
      .filter(Boolean)
      .join("\n\n");
    policy = resolveLanePolicy(run, opts);
    outputFormat = { type: "text" };
    resolved = {
      opts,
      modelKey: modelKey(model),
      effort,
      effortPolicy,
      agent,
      role,
      rolePromptHash: roleInfo?.contentHash,
      system: baseSystem,
      schema,
      outputFormat,
      policy: {
        mode: policy.mode,
        policyMode: policy.policyMode,
        authority: policy.authority,
        shellPolicy: policy.shellPolicy,
        mcpPolicy: policy.mcpPolicy,
        tools: policy.tools,
        permissionRules: policy.permissionRules,
        secretGlobs: policy.secretGlobs,
      },
    };
    sig = laneSignature(run, prompt, resolved);

    const cached = run.resumeJournal.get(callId);
    const cacheHit = classifyResumeCacheHit(cached, sig);
    if (cacheHit) {
      markResumeSignatureClaimed(run, callId);
      run.cacheStats.hits += 1;
      await appendEvent(run, {
        type: cacheHit.eventType,
        callId,
        ...(cacheHit.kind === "salvaged-hit" ? { salvagedFromTranscript: true } : {}),
      });
      // Do NOT re-accumulate this cache hit's spend: prior historical spend (live +
      // replayed) was already folded into run.replayedTokens/run.replayedCost at resume
      // (see rehydrateRunFromPriorState). Adding it again here would double-count prior
      // spend and trip budget ceilings at a fraction of the configured limit (R9). This
      // mirrors the agentsStarted replay model, where a replaced (cache-hit) lane does
      // not re-increment the carried-forward counter. A salvaged hit reuses the recovered
      // result the same way (no re-run, no new spend) but emits cache.salvaged_hit so the
      // weaker transcript-recovered provenance stays distinguishable from a real capture.
      return cached.result;
    }
    const signatureFallback = claimResumeSignatureFallback(run, callId, sig);
    if (signatureFallback) {
      run.cacheStats.hits += 1;
      const originalCallId = String(signatureFallback.callId);
      const retaggedPlan = retagRehydratedLanePlan(run, originalCallId, callId, signatureFallback);
      const integrationLaneRecord = signatureFallback.integrationLane
        ? { ...signatureFallback.integrationLane, callId }
        : undefined;
      await recordLaneOutcome(run, {
        callId,
        signatureHash: sig,
        outcome: "success",
        childID: signatureFallback.childID,
        title: signatureFallback.title ?? title,
        taskSummary: signatureFallback.taskSummary ?? taskSummary,
        enqueuedAt: signatureFallback.enqueuedAt,
        startedAt: signatureFallback.startedAt,
        queueWaitMs: signatureFallback.queueWaitMs,
        model: signatureFallback.model ?? resolved.modelKey,
        agent: signatureFallback.agent ?? agent,
        role: signatureFallback.role ?? role,
        rolePromptHash: signatureFallback.rolePromptHash ?? roleInfo?.contentHash,
        timeoutMs: signatureFallback.timeoutMs ?? timeoutMs,
        worktreePath: signatureFallback.worktreePath,
        integrationLane: integrationLaneRecord,
        permissionPolicy: signatureFallback.permissionPolicy ?? resolved.policy,
        permissionEcho: signatureFallback.permissionEcho,
        result: signatureFallback.result,
        salvagedFromTranscript: signatureFallback.salvagedFromTranscript === true || undefined,
        matchedViaSignatureFallback: true,
        originalCallId,
        replayedOutcome: true,
      });
      await appendEvent(run, {
        type: "cache.signature_hit",
        callId,
        originalCallId,
        signatureHash: sig,
        ...(signatureFallback.salvagedFromTranscript === true ? { salvagedFromTranscript: true } : {}),
        retaggedPlan,
      });
      await writeState(run);
      return signatureFallback.result;
    }
    // Workflow-native lane checkpoint (234m.1): a durable lanes/<callId>.result.json written
    // around session.prompt can recover a completed result when the crash window fell between
    // prompt-return and recordLaneOutcome. Journal entries are authoritative, so the checkpoint
    // path is evaluated only after a same-signature resume-journal hit has been ruled out. A
    // successful checkpoint recovery records the lane, then retires the checkpoint so later
    // resumes route through the journal cache and cannot re-increment lane tallies.
    const checkpoint = cached ? null : await readLaneResultCheckpoint(run.dir, callId);
    const checkpointHit = checkpointHitForSignature(checkpoint, sig);
    if (checkpointHit) {
      run.cacheStats.hits += 1;
      // Replay this lane's diff-plan contribution BEFORE recording the outcome. The
      // integration-commit / addEditPlanFromResult step runs AFTER the result checkpoint is
      // written, and its effects (run.integrationPlan.lanes / run.editPlan.patches) are only
      // persisted by the trailing writeState. On a checkpoint-hit resume the rehydrated plan
      // (from the pre-crash state.json) lacks this lane's changes, so restoring it here from the
      // checkpoint's captured descriptor is what keeps recovery from journaling outcome:'success'
      // while silently dropping the lane's patches (opencode-workflows-zi0f). Guarded so a repeated
      // recovery cannot double-append.
      if (checkpoint.integrationLane && run.integrationPlan && !findIntegrationLane(run, callId)) {
        run.integrationPlan.lanes.push(checkpoint.integrationLane);
      } else if (checkpoint.worktreePath && run.editPlan && checkpointHit.result && typeof checkpointHit.result === "object"
        && !run.editPlan.patches?.some((patch) => patch.callId === callId)) {
        addEditPlanFromResult(run, callId, checkpointHit.result, { path: checkpoint.worktreePath });
      }
      await recordLaneOutcome(run, {
        callId,
        signatureHash: sig,
        outcome: "success",
        childID: checkpoint.childID,
        title,
        taskSummary,
        enqueuedAt: checkpoint.enqueuedAt,
        startedAt: checkpoint.startedAt,
        queueWaitMs: checkpoint.queueWaitMs,
        model: checkpoint.model ?? resolved.modelKey,
        agent: checkpoint.agent ?? agent,
        role: checkpoint.role ?? role,
        rolePromptHash: roleInfo?.contentHash,
        timeoutMs: checkpoint.timeoutMs ?? timeoutMs,
        worktreePath: checkpoint.worktreePath,
        integrationLane: checkpoint.integrationLane,
        permissionPolicy: checkpoint.permissionPolicy ?? resolved.policy,
        permissionEcho: checkpoint.permissionEcho,
        result: checkpointHit.result,
        recoveredFromCheckpoint: true,
        checkpointSignatureHash: checkpoint.signatureHash,
        checkpointCapturedAt: checkpoint.capturedAt,
      });
      await appendEvent(run, {
        type: checkpointHit.eventType,
        callId,
        recoveredFromCheckpoint: true,
        checkpointSignatureHash: checkpoint.signatureHash,
        checkpointCapturedAt: checkpoint.capturedAt,
      });
      await removeLaneCheckpoint(run.dir, callId, "result");
      await removeLaneCheckpoint(run.dir, callId, "request");
      await writeState(run);
      return checkpointHit.result;
    }
    if (cached) {
      run.cacheStats.invalidated += 1;
      await appendEvent(run, { type: "cache.invalidated", callId, previousOutcome: cached.outcome ?? "unknown" });
    } else if (run.resumeJournal.size > 0) {
      run.cacheStats.misses += 1;
      await appendEvent(run, { type: "cache.miss", callId });
    }

    await checkDurableLifecycleRequest(run);
    throwIfLaneCancelled(run, callId);
    laneEnqueuedAt = new Date().toISOString();
    await acquireAgentSlot(run, callId);
    acquired = true;
    laneStartedAt = new Date().toISOString();
    const laneQueueWaitMs = durationMs(laneEnqueuedAt, laneStartedAt);
    throwIfAborted(run, toolContext);
    await checkDurableLifecycleRequest(run);
    throwIfLaneCancelled(run, callId);
    const replacesPriorLane = Boolean(cached);
    if (!replacesPriorLane && run.agentsStarted >= run.maxAgents) {
      throw new WorkflowBudgetStoppedError(`Workflow exceeded maxAgents=${run.maxAgents}`);
    }
    checkBudgetBeforeLaunch(run);
    if (!replacesPriorLane) run.agentsStarted += 1;

    integrationLane = run.authority.integration === true && opts.worktreeEdit === true && opts.edit !== true;
    if ((opts.edit === true || opts.worktreeEdit === true) && !(run.authority.edit || run.authority.worktreeEdit || run.authority.integration)) {
      throw new WorkflowAuthorityError("Edit lane requested without workflow edit authority");
    }
    if ((opts.edit === true || opts.worktreeEdit === true) && !integrationLane && !opts.schema) {
      // Edit lanes contribute to the diff plan only when they return structured patches
      // (addEditPlanFromResult requires an object). A schemaless edit lane would silently
      // discard its work and leak a worktree, so reject it up front.
      throw new WorkflowAuthorityError("Edit lanes must declare a schema that returns { patches: [...] }");
    }
    if (integrationLane) {
      worktreeRecord = await createIntegrationLaneWorktree(pluginContext, run, toolContext, callId);
    } else if (opts.edit === true || opts.worktreeEdit === true) {
      worktreeRecord = await createEditWorktree(run, toolContext, callId);
    }
    const laneDirectory = worktreeRecord?.path || toolContext.directory;
    const activeLane = run.activeLaneAbortControllers?.get(callId);
    if (activeLane) activeLane.directory = laneDirectory;
    const session = sessionApi(pluginContext);
    const createBody = { parentID: toolContext.sessionID, title, directory: laneDirectory };
    if (policy.policyMode === "permission-ruleset") createBody.permission = policy.permissionRules;
    const childCreateTimeoutMs = Number.isFinite(pluginContext?.__workflowChildCreateTimeoutMs) && pluginContext.__workflowChildCreateTimeoutMs > 0
      ? pluginContext.__workflowChildCreateTimeoutMs
      : DEFAULT_CHILD_CREATE_TIMEOUT_MS;
    const promptBody = {
      ...(agent ? { agent } : {}),
      ...(model ? { model } : {}),
      system: baseSystem,
      parts: [textPart(prompt)],
    };

    // Bounded lane-level retry with two independent classes:
    // - retryCount covers transient infrastructure failures and recreates a clean child session.
    // - correctiveRetries covers malformed structured output and re-prompts the SAME child session
    //   with validation feedback, preserving its transcript. Corrective attempts are still budget-
    //   gated and spend-accounted because they run through the same prompt path below.
    const maxAttempts = 1 + (Number.isInteger(retryCount) && retryCount >= 0 ? retryCount : DEFAULT_RETRY_COUNT);
    let transientAttempt = 1;
    let promptAttempt = 1;
    let correctiveAttempts = 0;
    let pendingCorrectiveMessage = null;
    const correctivePromptBody = (validationMessage) => ({
      ...(agent ? { agent } : {}),
      ...(model ? { model } : {}),
      parts: [textPart(structuredCorrectiveInstruction(schema, validationMessage))],
    });
    const finalValidationFailureClass = () => correctiveRetries > 0 ? "validation_exhausted" : "terminal";
    let result;
    let tokens;
    let cost;
    for (;;) {
      const attempt = promptAttempt;
      const correctiveTurn = pendingCorrectiveMessage !== null && Boolean(childID);
      const bodyForAttempt = correctiveTurn ? correctivePromptBody(pendingCorrectiveMessage) : promptBody;
      pendingCorrectiveMessage = null;
      // Re-check the shared budget ceiling before each (re)attempt so retries stay inside the same
      // gate as the initial launch; a budget stop here is terminal-classed and never retried.
      checkBudgetBeforeLaunch(run);
      throwIfAborted(run, toolContext);
      throwIfLaneCancelled(run, callId);
      // Reserve this attempt's conservative budget slice SYNCHRONOUSLY here — no await between the
      // ceiling check above and this reservation — so a concurrent lane's checkBudgetBeforeLaunch
      // observes the in-flight commitment and a wave of up to `concurrency` lanes cannot each clear
      // the gate on stale (pre-spend) counters and collectively overshoot maxCost/maxTokens by up to
      // (concurrency-1) unreported lanes (opencode-workflows-dx1n). Reconciled in the finally below:
      // released after the real prompt spend is folded into run.cost/run.tokens (success) or after a
      // failed attempt that accrued no spend (retry/terminal), so a retry re-reserves cleanly and the
      // lane's own reservation never trips its own next-attempt ceiling check.
      const laneReservation = reserveLaneBudget(run);
      try {
        if (!correctiveTurn) {
          let createDetached = false;
          const createPromise = Promise.resolve().then(() => session.create(createBody));
          createPromise.then(async (created) => {
            if (!createDetached) return;
            const lateChild = unwrapClientResult(created, `Child session creation for ${callId}`);
            const lateChildID = lateChild?.data?.id;
            if (lateChildID) await abortChild(pluginContext, lateChildID, laneDirectory);
          }).catch(() => {
            // Create already failed; the lane failure path handles the original timeout/cancel error.
          });
          let child;
          try {
            child = unwrapClientResult(await withTimeout(
              () => createPromise,
              {
                timeoutMs: childCreateTimeoutMs,
                signal: laneAbortController.signal,
                label: `Child session creation for ${callId}`,
                onTimeout: () => { createDetached = true; },
              },
            ), `Child session creation for ${callId}`);
          } catch (error) {
            createDetached = true;
            throw error;
          }
          createDetached = false;
          childID = child?.data?.id;
          if (!childID) throw new Error("OpenCode did not return a child session id");
          run.children.set(childID, laneDirectory);
          registerLaneEffort(childID, effortPolicy);
          if (activeLane) activeLane.childID = childID;
          // Reset the per-lane abort guard for this fresh child session. A prior attempt's retry
          // teardown (or a prompt-timeout abort) set activeLane.childAbortRequested = true against the
          // OLD childID; leaving it true would make every abortChild gate (this lane's prompt-timeout
          // handler, sandbox-executor fanout-cancel / settlePendingHostOps, lifecycle-control
          // abortRunChildren) silently skip aborting the brand-new attempt-2 child on cancel/kill/
          // timeout, letting it keep running and accruing cost (opencode-workflows-dvww).
          if (activeLane) activeLane.childAbortRequested = false;
          throwIfLaneCancelled(run, callId);

          permissionEcho = policy.policyMode === "permission-ruleset"
            ? sessionPermissionEchoStatus(child, policy.permissionRules)
            : { state: "not-requested" };
          if (permissionEcho.state === "mismatch") {
            await writeLaneProjection(run, callId, {
              status: "permission-mismatch",
              enqueuedAt: laneEnqueuedAt,
              startedAt: laneStartedAt,
              queueWaitMs: laneQueueWaitMs,
              attempt,
              childID,
              title,
              taskSummary,
              model: resolved.modelKey,
              agent,
              role,
              timeoutMs,
              policyMode: policy.policyMode,
              worktreePath: worktreeRecord?.path,
              integrationLane,
              permissionPolicy: resolved.policy,
              permissionEcho,
              signatureHash: sig,
            });
            await appendEvent(run, { type: "agent.permission_mismatch", callId, childID, permissionEcho });
            throw new WorkflowAuthorityError(`Child session permission echo mismatch for ${callId}`);
          }

          const directoryEcho = sessionDirectoryEchoStatus(child, laneDirectory);
          if (directoryEcho.state === "mismatch") {
            await writeLaneProjection(run, callId, {
              status: "directory-mismatch",
              enqueuedAt: laneEnqueuedAt,
              startedAt: laneStartedAt,
              queueWaitMs: laneQueueWaitMs,
              attempt,
              childID,
              title,
              taskSummary,
              model: resolved.modelKey,
              agent,
              role,
              timeoutMs,
              policyMode: policy.policyMode,
              worktreePath: worktreeRecord?.path,
              integrationLane,
              permissionPolicy: resolved.policy,
              permissionEcho,
              directoryEcho,
              signatureHash: sig,
            });
            await appendEvent(run, { type: "agent.directory_mismatch", callId, childID, directoryEcho });
            throw new WorkflowAuthorityError(`Child session directory echo mismatch for ${callId}: expected ${directoryEcho.expected}, got ${directoryEcho.echoed}`);
          }
          // "not-echoed" is tolerated: Session.directory is typed-required on >= MIN_OPENCODE_SERVER_VERSION,
          // and the fingerprint refuses elevated authority below that floor.

          await writeLaneProjection(run, callId, {
            status: "running",
            enqueuedAt: laneEnqueuedAt,
            startedAt: laneStartedAt,
            queueWaitMs: laneQueueWaitMs,
            attempt,
            childID,
            title,
            taskSummary,
            model: resolved.modelKey,
            agent,
            role,
            timeoutMs,
            policyMode: policy.policyMode,
            worktreePath: worktreeRecord?.path,
            integrationLane,
            permissionPolicy: resolved.policy,
            permissionEcho,
            // Persist the lane signature so an interrupted run's transcript-salvage
            // (workflow_salvage) can stamp the recovered journal entry with the same cache
            // identity the resume path checks, letting a salvaged read-only result cache-hit
            // through the normal signature branch without weakening that invariant.
            signatureHash: sig,
          });
          await appendEvent(run, { type: "agent.started", callId, childID, title, model: resolved.modelKey, policyMode: policy.policyMode, permissionEcho, attempt });
          await writeState(run);
        }

        // Durable lane checkpoint (234m.1): capture prompt-time intent BEFORE issuing the prompt so a
        // crash anywhere in the prompt->capture->journal window leaves a forensics trail and (for the
        // result half) a recoverable own-store result. childID is known by this point (session.create
        // returned above), so it is recorded here. Best-effort: a checkpoint write failure must never
        // break a run (journal.jsonl remains authoritative); it is surfaced as a diagnostic event only.
        try {
          await writeLaneCheckpoint(run.dir, callId, "request", {
            runId: run.id,
            callId,
            signatureHash: sig,
            promptHash: hash(prompt),
            schemaHash: schema ? hash(stableStringify(schema)) : undefined,
            schemaSnapshot: boundedSchemaSnapshot(schema),
            enqueuedAt: laneEnqueuedAt,
            startedAt: laneStartedAt,
            queueWaitMs: laneQueueWaitMs,
            childID,
            model: resolved.modelKey,
            agent,
            role,
            attempt,
            correctiveAttempts: correctiveAttempts || undefined,
            writtenAt: new Date().toISOString(),
          });
        } catch (error) {
          await appendEvent(run, { type: "cache.checkpoint_write_failed", callId, kind: "request", error: truncateText(extractTextFromError(error), MAX_STATUS_STRING_CHARS) });
        }

        const lastResult = unwrapClientResult(await withTimeout(
          () => session.prompt({ sessionID: childID, directory: laneDirectory, body: bodyForAttempt }),
          {
            timeoutMs,
            signal: laneAbortController.signal,
            label: `Child prompt for ${callId}`,
            onTimeout: () => {
              const lane = run.activeLaneAbortControllers?.get(callId);
              if (lane) {
                if (lane.childAbortRequested === true) return undefined;
                lane.childAbortRequested = true;
              }
              return abortChild(pluginContext, childID, laneDirectory);
            },
          },
        ), `Child prompt for ${callId}`);

        const info = lastResult?.data?.info ?? {};
        tokens = {
          input: info.tokens?.input ?? 0,
          output: info.tokens?.output ?? 0,
          reasoning: info.tokens?.reasoning ?? 0,
        };
        cost = info.cost ?? 0;
        run.tokens.input += tokens.input;
        run.tokens.output += tokens.output;
        run.tokens.reasoning += tokens.reasoning;
        run.cost += cost;

        if (useStructuredTextFallback) {
          const rawText = responseText(lastResult);
          try {
            result = parseStructuredTextResult(rawText);
          } catch (parseError) {
            const validationMessage = truncateText(extractTextFromError(parseError), MAX_STATUS_STRING_CHARS);
            if (correctiveAttempts < correctiveRetries) {
              parseError.laneRetryKind = "correctable";
              parseError.laneValidationMessage = validationMessage;
              throw parseError;
            }
            await journalFailure(parseError, false, {
              rawInvalidStructuredOutput: truncateText(redactFreeTextSecrets(rawText), MAX_STATUS_STRING_CHARS),
              failureClass: finalValidationFailureClass(),
              retryable: correctiveRetries > 0,
              correctiveAttempts: correctiveAttempts || undefined,
            });
            throw parseError;
          }
        } else {
          result = responseText(lastResult);
        }

        if (schema) {
          try {
            validateStructuredResult(schema, result);
          } catch (error) {
            const validationMessage = truncateText(extractTextFromError(error), MAX_STATUS_STRING_CHARS);
            if (correctiveAttempts < correctiveRetries) {
              error.laneRetryKind = "correctable";
              error.laneValidationMessage = validationMessage;
              throw error;
            }
            await journalFailure(error, false, {
              rawInvalidStructuredOutput: redactFreeTextSecrets(result),
              failureClass: finalValidationFailureClass(),
              retryable: correctiveRetries > 0,
              correctiveAttempts: correctiveAttempts || undefined,
            });
            throw error;
          }
        }
        break; // attempt succeeded — leave the retry loop with result/tokens/cost set
      } catch (error) {
        if (error?.laneRetryKind === "correctable" && correctiveAttempts < correctiveRetries && childID) {
          correctiveAttempts += 1;
          pendingCorrectiveMessage = truncateText(error.laneValidationMessage ?? extractTextFromError(error), MAX_STATUS_STRING_CHARS);
          await appendEvent(run, {
            type: "agent.corrective_retry",
            callId,
            childID,
            attempt,
            nextAttempt: promptAttempt + 1,
            correctiveAttempt: correctiveAttempts,
            maxCorrectiveRetries: correctiveRetries,
            failureClass: "correctable",
            error: pendingCorrectiveMessage,
          });
          promptAttempt += 1;
          continue;
        }
        const transient = classifyLaneError(error) === "transient";
        if (!transient || transientAttempt >= maxAttempts) {
          // Terminal failure (or a transient one that exhausted its retries): rethrow with childID
          // intact so journalFailure records the failing child and the outer finally performs the
          // SAME single teardown as before retries existed (no extra abortChild here — the timeout
          // path's onTimeout already aborted the child). Tag an exhausted-transient error so the
          // failure class stays distinguishable from a terminal one.
          if (transient) error.laneFailureClass = "transient_exhausted";
          throw error;
        }
        // About to retry: proactively tear down this attempt's child so the next attempt starts from
        // a clean childID and we never leak an orphaned session across the backoff wait.
        if (childID) {
          try {
            if (activeLane) activeLane.childAbortRequested = true;
            await abortChild(pluginContext, childID, laneDirectory);
          } catch { /* best-effort teardown */ }
          run.children.delete(childID);
          clearLaneEffort(childID);
          if (activeLane && activeLane.childID === childID) activeLane.childID = undefined;
          childID = undefined;
        }
        const delayMs = computeLaneBackoffMs(transientAttempt, { retryAfterMs: retryAfterMsFromError(error) });
        await appendEvent(run, {
          type: "agent.retry",
          callId,
          attempt: transientAttempt,
          nextAttempt: transientAttempt + 1,
          maxAttempts,
          delayMs,
          failureClass: "transient",
          error: truncateText(extractTextFromError(error), MAX_STATUS_STRING_CHARS),
        });
        transientAttempt += 1;
        promptAttempt += 1;
        await abortableBackoffSleep(delayMs, laneAbortController.signal);
      } finally {
        // Reconcile this attempt's reservation regardless of outcome (success break, terminal
        // rethrow, or retry fall-through). Runs after the real spend was folded into run.cost/tokens
        // on success and before the next attempt re-reserves on retry (opencode-workflows-dx1n).
        releaseLaneBudget(run, laneReservation);
      }
    }

    // Register this lane's file changes into the diff plan FIRST: an integration lane commits its
    // worktree and appends the committed descriptor to run.integrationPlan.lanes; a plain edit lane
    // folds its structured patches into run.editPlan.patches. Both effects are in-memory and only
    // become durable at the trailing writeState, so the result checkpoint is written AFTER this
    // block (below) — never before it — and captures the contribution so a checkpoint-hit resume can
    // replay it (234m.1 / opencode-workflows-zi0f).
    if (integrationLane && worktreeRecord) {
      const committed = await run.worktreeAdapter.commit({ directory: worktreeRecord.path, message: `workflow ${run.id} ${callId}` });
      const paths = committed.committed ? await changedPathsSinceBase(worktreeRecord.path, run.integrationPlan.baseCommit) : [];
      integrationLaneRecord = {
        callId,
        laneId: worktreeRecord.laneId,
        path: worktreeRecord.path,
        branch: worktreeRecord.branch,
        commit: committed.commit,
        committed: committed.committed,
        paths,
      };
      run.integrationPlan.lanes.push(integrationLaneRecord);
      await appendIntegrationLedger(run, { phase: "lane-committed", callId, laneId: worktreeRecord.laneId, branch: worktreeRecord.branch, commit: committed.commit, committed: committed.committed, paths });
      await writeLaneProjection(run, callId, { status: "committed", integrationLane: integrationLaneRecord });
      await appendEvent(run, { type: "integration.lane_committed", callId, branch: worktreeRecord.branch, commit: committed.commit, pathCount: paths.length });
    } else if (worktreeRecord && result && typeof result === "object") {
      addEditPlanFromResult(run, callId, result, worktreeRecord);
    }

    // Durable lane checkpoint (234m.1): atomically capture the controller's validated result plus
    // the diff-plan contribution computed just above (worktreePath + the committed integration-lane
    // descriptor). Written AFTER the integration-commit / addEditPlanFromResult block, and AFTER
    // schema validation, so the crash window is [contribution-computed, recordLaneOutcome): if the
    // owning process dies here, a resumed run recovers this same own-store result from
    // lanes/<callId>.result.json (cache.checkpoint_hit) AND replays the captured contribution back
    // into run.integrationPlan.lanes / run.editPlan.patches without re-running the lane, committing
    // git, or reading any transcript. A crash BEFORE this write leaves no checkpoint, so the lane is
    // re-run cleanly on resume rather than recorded as a success with a dropped contribution
    // (opencode-workflows-zi0f). Best-effort: a write failure must never break a run; journal.jsonl
    // remains authoritative.
    try {
      await writeLaneCheckpoint(run.dir, callId, "result", {
        runId: run.id,
        callId,
        signatureHash: sig,
        result,
        enqueuedAt: laneEnqueuedAt,
        startedAt: laneStartedAt,
        queueWaitMs: laneQueueWaitMs,
        childID,
        model: resolved.modelKey,
        agent,
        role,
        timeoutMs,
        permissionPolicy: resolved.policy,
        permissionEcho,
        worktreePath: worktreeRecord?.path,
        integrationLane: integrationLaneRecord,
        capturedAt: new Date().toISOString(),
      });
    } catch (error) {
      await appendEvent(run, { type: "cache.checkpoint_write_failed", callId, kind: "result", error: truncateText(extractTextFromError(error), MAX_STATUS_STRING_CHARS) });
    }

    await captureLaneDebugArtifacts(pluginContext, run, {
      debugCaptured,
      callId,
      childID,
      laneDirectory,
      title,
      prompt,
      baseSystem,
      schema,
      outputFormat,
      outcome: "success",
    });

    await recordLaneOutcome(run, {
      callId,
      signatureHash: sig,
      outcome: "success",
      childID,
      title,
      taskSummary,
      enqueuedAt: laneEnqueuedAt,
      startedAt: laneStartedAt,
      queueWaitMs: laneQueueWaitMs,
      model: resolved.modelKey,
      agent,
      role,
      rolePromptHash: roleInfo?.contentHash,
      timeoutMs,
      worktreePath: worktreeRecord?.path,
      integrationLane: integrationLaneRecord,
      permissionPolicy: resolved.policy,
      permissionEcho,
      result,
      tokens,
      cost,
      correctiveAttempts: correctiveAttempts || undefined,
    });
    // The journal entry has superseded the crash-window checkpoint (journal.jsonl is
    // authoritative), so retire the narrow-window artifacts. This keeps the checkpoint from
    // shadowing the canonical cache.hit on the next resume (a surviving result.json would route
    // a normally-journaled lane through cache.checkpoint_hit instead). Removed only on the
    // success path AFTER recordLaneOutcome, so a crash before journaling leaves result.json in
    // place for recovery, and a checkpoint-hit resume (which returns above before journaling)
    // also leaves it in place for repeated recovery. Best-effort: removal never throws.
    await removeLaneCheckpoint(run.dir, callId, "result");
    await removeLaneCheckpoint(run.dir, callId, "request");
    await appendEvent(run, { type: "agent.completed", callId, childID, tokens, cost });
    await writeState(run);
    return result;
  } catch (error) {
    try {
      await journalFailure(error, opts.onFailure === "returnNull" && laneOutcomeForError(error) !== "cancelled");
    } catch (journalError) {
      // A fallible I/O step inside journalFailure (dirtyWorktreeSalvage, recordLaneOutcome,
      // appendEvent, writeState) threw while recording the ORIGINAL lane failure. Never let that
      // secondary error replace `error`: record it as a diagnostic and fall through so the original
      // lane error surfaces and the returnNull contract below still holds.
      run.diagnostics ??= {};
      run.diagnostics.journalFailureError = truncateText(extractTextFromError(journalError), MAX_STATUS_STRING_CHARS);
    }
    if (opts.onFailure === "returnNull" && laneOutcomeForError(error) !== "cancelled") return null;
    throw error;
  } finally {
    if (acquired) releaseAgentSlot(run);
    run.activeLaneAbortControllers?.delete(callId);
    if (childID) {
      run.children?.delete(childID);
      clearLaneEffort(childID);
    }
    run.abortController.signal.removeEventListener("abort", runAbortListener);
  }
}
