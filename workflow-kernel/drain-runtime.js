// Host-owned autonomous drain runtime used by globalThis.drain and thin drain workflow
// wrappers. Domain control stays here and in trusted adapters; workflow
// source supplies adapter options rather than reimplementing the controller loop.
import { computeLaneBackoffMs } from "./errors.js";

const CLASSIFICATIONS = new Set(["ready", "blocked", "human-gated", "external", "done"]);
const LANE_OUTCOMES = new Set(["implemented", "blocked", "needs-research", "failed", "no-op"]);

function assertFunction(value, name) {
  if (typeof value !== "function") throw new Error(`drain adapter requires ${name}()`);
}

function assertArray(value, name) {
  if (!Array.isArray(value)) throw new Error(`${name} must be an array`);
}

function itemId(item) {
  const id = item?.id ?? item?.itemId;
  if (typeof id !== "string" || !id) throw new Error("drain items require string id");
  return id;
}

function normalizeClassification(value) {
  const classification = typeof value === "string" ? { status: value } : value;
  if (!classification || typeof classification !== "object") throw new Error("adapter.classify() must return a classification");
  if (!CLASSIFICATIONS.has(classification.status)) throw new Error(`Invalid drain classification: ${String(classification.status)}`);
  return classification;
}

export function validateLaneReport(report) {
  if (!report || typeof report !== "object") throw new Error("Lane report must be an object");
  if (typeof report.itemId !== "string" || !report.itemId) throw new Error("Lane report requires itemId");
  if (!LANE_OUTCOMES.has(report.outcome)) throw new Error(`Invalid lane outcome: ${String(report.outcome)}`);
  if (typeof report.summary !== "string") throw new Error("Lane report requires summary");
  if (typeof report.readyForIntegration !== "boolean") throw new Error("Lane report requires readyForIntegration boolean");
  assertArray(report.filesChanged, "Lane report filesChanged");
  assertArray(report.commandsRun, "Lane report commandsRun");
  assertArray(report.acceptanceEvidence, "Lane report acceptanceEvidence");
  assertArray(report.residualRisks, "Lane report residualRisks");
  assertArray(report.followups, "Lane report followups");
  return report;
}

export function validateValidationReport(report) {
  if (!report || typeof report !== "object") throw new Error("Validation report must be an object");
  if (typeof report.itemId !== "string" || !report.itemId) throw new Error("Validation report requires itemId");
  if (typeof report.accepted !== "boolean") throw new Error("Validation report requires accepted boolean");
  if (typeof report.reason !== "string") throw new Error("Validation report requires reason");
  if (typeof report.diffScopeOk !== "boolean") throw new Error("Validation report requires diffScopeOk boolean");
  if (typeof report.followupsHandled !== "boolean") throw new Error("Validation report requires followupsHandled boolean");
  assertArray(report.acceptanceChecklist, "Validation report acceptanceChecklist");
  assertArray(report.validationCommands, "Validation report validationCommands");
  return report;
}

function validateAdapter(adapter) {
  if (!adapter || typeof adapter !== "object") throw new Error("drain requires an adapter object");
  for (const name of ["discover", "classify", "claim", "buildLanePacket", "validate", "close", "createFollowup", "proveDry"]) {
    assertFunction(adapter[name], name);
  }
}

async function createFollowups(adapter, followups, context) {
  const created = [];
  for (const followup of followups ?? []) {
    created.push(await adapter.createFollowup(followup, context));
  }
  return created;
}

async function releaseClaimedItem(adapter, item, claim, reason, report, context = {}) {
  if (typeof adapter.releaseClaim !== "function") return undefined;
  const id = itemId(item);
  const outcome = await adapter.releaseClaim(item, { claim, reason, outcome: "failed", ...context });
  const record = { itemId: id, reason, outcome };
  report.released.push(record);
  return record;
}

function checkLifecycle(ctx, context = {}) {
  if (typeof ctx.options?.checkLifecycle === "function") ctx.options.checkLifecycle(context);
}

function isBudgetStoppedError(error) {
  return error?.name === "WorkflowBudgetStoppedError"
    || error?.code === "WORKFLOW_BUDGET_STOPPED"
    || error?.outcome === "budget_stopped";
}

function isLifecycleAbortError(error) {
  return error?.code === "WORKFLOW_CANCELLED"
    || error?.name === "WorkflowCancelledError"
    || error?.name === "WorkflowPausedError";
}

function errorSummary(error) {
  return error?.message ? String(error.message) : String(error);
}

async function canLaunchLane(options, context) {
  if (typeof options.canLaunchLane !== "function") return true;
  try {
    return await options.canLaunchLane(context) !== false;
  } catch (error) {
    if (isBudgetStoppedError(error)) return false;
    throw error;
  }
}

function defaultIntegrate(laneReports) {
  return { status: "integrated", laneReports };
}

// Deterministic exponential backoff between drain repair attempts (opencode-workflows-jbs3.2).
// Opt-in: with no retryBackoffBaseMs configured the delay is 0 and ctx.sleep is never called, so
// the historical repair-loop timing is preserved exactly. When configured, a failed item's repair
// attempt waits baseMs * 2**(attempt-1) (capped) before re-running, the same backoff curve the
// child-lane retry uses, so a wave of failing items cannot hot-loop their repair attempts.
async function applyRepairBackoff(ctx, attempt) {
  checkLifecycle(ctx, { phase: "repair-backoff", attempt, point: "before" });
  const baseMs = ctx.retryBackoffBaseMs;
  if (!(Number.isFinite(baseMs) && baseMs > 0)) return 0;
  // jitter: () => 1 keeps the delay deterministic (full exponential value, no random component).
  const delayMs = computeLaneBackoffMs(attempt, { baseMs, jitter: () => 1 });
  if (delayMs > 0) await ctx.sleep(delayMs);
  checkLifecycle(ctx, { phase: "repair-backoff", attempt, point: "after" });
  return delayMs;
}

// Run one attempt for a claimed item. Returns a control signal the caller's
// attempt loop acts on, preserving drain()'s original break/continue semantics:
//   - { control: "retry", priorValidation }  -> caller continues (a "repair" attempt)
//   - { control: "break" }                    -> caller stops the attempt loop
//   - { control: "break", closed: true }      -> caller stops; the item closed
// Side effects (failed/closed/salvaged/followups accumulation, releaseClaim,
// budgetExhausted) are applied to ctx.report exactly as the inline body did.
async function runLaneAttempt(ctx, { item, id, claim, attempt, context, wave, priorValidation, releaseState }) {
  const { adapter, options, integrate, maxAttempts, report, phase } = ctx;
  const attemptContext = { ...context, item, itemId: id, attempt, claim, priorValidation };
  checkLifecycle(ctx, { ...attemptContext, phase: "attempt", point: "start" });
  if (!await canLaunchLane(options, { ...attemptContext, phase: "preattempt" })) {
    const reason = "lane launch budget exhausted";
    report.budgetExhausted = true;
    report.failed.push({ itemId: id, reason });
    wave.attempts.push({ itemId: id, attempt, stopped: "budget_exhausted", reason });
    // Mark attempted BEFORE the await: if releaseClaim throws mid-mutation the
    // exception unwinds into processReadyItem's catch, which must NOT re-release.
    if (releaseState) releaseState.attempted = true;
    await releaseClaimedItem(adapter, item, claim, reason, report);
    return { control: "break" };
  }
  checkLifecycle(ctx, { ...attemptContext, phase: "buildLanePacket", point: "before" });
  const packet = await adapter.buildLanePacket(item, attemptContext);
  checkLifecycle(ctx, { ...attemptContext, phase: "buildLanePacket", point: "after" });
  phase("spawn_lanes");
  phase("monitor");
  checkLifecycle(ctx, { ...attemptContext, phase: "runLane", point: "before" });
  const laneReport = validateLaneReport(await options.runLane(packet, attemptContext));
  checkLifecycle(ctx, { ...attemptContext, phase: "runLane", point: "after" });
  if (laneReport.itemId !== id) throw new Error(`Lane report itemId mismatch: ${laneReport.itemId} !== ${id}`);
  if (laneReport.salvage?.dirty) report.salvaged.push({ itemId: id, attempt, salvage: laneReport.salvage });
  phase("collect_reports");
  checkLifecycle(ctx, { ...attemptContext, phase: "lane-followups", point: "before" });
  const laneFollowups = await createFollowups(adapter, laneReport.followups, { ...attemptContext, laneReport });
  checkLifecycle(ctx, { ...attemptContext, phase: "lane-followups", point: "after" });
  report.followups.push(...laneFollowups);
  const attemptRecord = { itemId: id, attempt, laneReport, validationReport: undefined, followups: laneFollowups };
  wave.attempts.push(attemptRecord);

  if (!laneReport.readyForIntegration || laneReport.outcome === "failed") {
    if (attempt < maxAttempts) {
      phase("repair");
      await applyRepairBackoff(ctx, attempt);
      return { control: "retry", priorValidation };
    }
    report.failed.push({ itemId: id, reason: laneReport.summary, laneReport });
    if (releaseState) releaseState.attempted = true;
    await releaseClaimedItem(adapter, item, claim, laneReport.summary ?? "lane failed", report, { laneReport, salvage: laneReport.salvage });
    return { control: "break" };
  }

  phase("integrate");
  checkLifecycle(ctx, { ...attemptContext, phase: "integrate", point: "before" });
  const integrationState = await integrate([laneReport], attemptContext);
  checkLifecycle(ctx, { ...attemptContext, phase: "integrate", point: "after" });
  phase("validate");
  checkLifecycle(ctx, { ...attemptContext, phase: "validate", point: "before" });
  const validationReport = validateValidationReport(await adapter.validate(item, integrationState, { ...attemptContext, laneReport }));
  checkLifecycle(ctx, { ...attemptContext, phase: "validate", point: "after" });
  if (validationReport.itemId !== id) throw new Error(`Validation report itemId mismatch: ${validationReport.itemId} !== ${id}`);
  attemptRecord.validationReport = validationReport;
  checkLifecycle(ctx, { ...attemptContext, phase: "validation-followups", point: "before" });
  const validationFollowups = await createFollowups(adapter, validationReport.followups ?? [], { ...attemptContext, laneReport, validationReport });
  checkLifecycle(ctx, { ...attemptContext, phase: "validation-followups", point: "after" });
  report.followups.push(...validationFollowups);

  if (validationReport.accepted && validationReport.diffScopeOk && validationReport.followupsHandled) {
    phase("close");
    checkLifecycle(ctx, { ...attemptContext, phase: "close", point: "before" });
    const closeResult = await adapter.close(item, { claim, laneReport, validationReport, integrationState }, attemptContext);
    checkLifecycle(ctx, { ...attemptContext, phase: "close", point: "after" });
    report.closed.push({ itemId: id, closeResult, laneReport, validationReport });
    return { control: "break", closed: true };
  }

  if (attempt < maxAttempts) {
    phase("repair");
    await applyRepairBackoff(ctx, attempt);
    return { control: "retry", priorValidation: validationReport };
  }
  report.failed.push({ itemId: id, reason: validationReport.reason, laneReport, validationReport });
  if (releaseState) releaseState.attempted = true;
  await releaseClaimedItem(adapter, item, claim, validationReport.reason ?? "validation rejected", report, { laneReport, validationReport, salvage: laneReport.salvage });
  return { control: "break", priorValidation: validationReport };
}

// Claim a ready item and drive its attempt loop to a terminal outcome.
// Returns { breakItems } telling the wave loop whether to stop iterating ready
// items (true once the launch budget is exhausted). The preclaim budget check
// short-circuits before the "claim" phase, exactly as the inline body did.
async function processReadyItem(ctx, { item, classification, context, wave }) {
  const { adapter, options, maxAttempts, report, phase } = ctx;
  const id = itemId(item);
  checkLifecycle(ctx, { ...context, item, itemId: id, phase: "preclaim", point: "before" });
  if (!await canLaunchLane(options, { ...context, item, itemId: id, phase: "preclaim" })) {
    report.budgetExhausted = true;
    wave.budgetExhausted = { itemId: id, phase: "preclaim", reason: "lane launch budget exhausted before claim" };
    return { breakItems: true };
  }
  phase("claim");
  checkLifecycle(ctx, { ...context, item, itemId: id, phase: "claim", point: "before" });
  const claim = await adapter.claim(item, { ...context, classification });
  checkLifecycle(ctx, { ...context, item, itemId: id, phase: "claim", point: "after" });
  let priorValidation;
  let closed = false;
  // Tracks whether any internal release site (in runLaneAttempt or the
  // post-loop guard below) has already invoked releaseClaimedItem for this
  // claim. The catch block must not issue a second real bd release: for the
  // beads adapter the release mutationKey embeds the free-text reason, so a
  // fresh "drain exception: ..." reason produces a different idempotency marker
  // and can double-apply against the git-synced issue (opencode-workflows-5rzm).
  const releaseState = { attempted: false };
  try {
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const result = await runLaneAttempt(ctx, { item, id, claim, attempt, context, wave, priorValidation, releaseState });
      if (result.control === "retry") {
        priorValidation = result.priorValidation;
        continue;
      }
      closed = result.closed === true;
      break;
    }
    if (!closed && !report.failed.some((failure) => failure.itemId === id)) {
      report.failed.push({ itemId: id, reason: "attempts exhausted without close" });
      releaseState.attempted = true;
      await releaseClaimedItem(adapter, item, claim, "attempts exhausted without close", report);
    }
  } catch (error) {
    if (isLifecycleAbortError(error)) throw error;
    const reason = `drain exception: ${errorSummary(error)}`;
    if (!report.failed.some((failure) => failure.itemId === id)) {
      report.failed.push({ itemId: id, reason, error: errorSummary(error) });
    }
    // Only release here if no internal release was already attempted for this
    // claim. Re-releasing with a fresh reason defeats the adapter's release
    // dedup and can double-apply the mutation against the real issue.
    if (!releaseState.attempted) {
      await releaseClaimedItem(adapter, item, claim, reason, report, { error });
    }
    throw error;
  }
  return { breakItems: report.budgetExhausted === true };
}

// Run one wave: discover, classify, then either plan (dryRun) or process every
// ready item. Returns the wave's signal for drain()'s wave loop:
//   - "drained"  -> no ready work (or a dryRun plan); stop, the queue is drained
//   - "stop"     -> budget exhausted or a failure occurred; stop, work may remain
//   - "continue" -> all ready items handled cleanly; advance to the next wave
async function runWave(ctx, { waveNumber }) {
  const { adapter, options, dryRun, report, phase, skippedIds } = ctx;
  const context = { scope: options.scope, waveNumber, report };
  phase(waveNumber === 1 ? "snapshot" : "resnapshot");
  checkLifecycle(ctx, { ...context, phase: "discover", point: "before" });
  const discovered = await adapter.discover(options.scope, context);
  checkLifecycle(ctx, { ...context, phase: "discover", point: "after" });
  assertArray(discovered, "adapter.discover result");

  phase("classify");
  const ready = [];
  const wave = { waveNumber, discovered: discovered.length, ready: [], skipped: [], attempts: [] };
  for (const item of discovered) {
    const id = itemId(item);
    checkLifecycle(ctx, { ...context, item, itemId: id, phase: "classify", point: "before" });
    const classification = normalizeClassification(await adapter.classify(item, context));
    checkLifecycle(ctx, { ...context, item, itemId: id, phase: "classify", point: "after" });
    if (classification.status === "ready") {
      ready.push({ item, classification });
      wave.ready.push(itemId(item));
    } else {
      const skipped = { itemId: itemId(item), classification: classification.status, reason: classification.reason };
      wave.skipped.push(skipped);
      if (!skippedIds.has(skipped.itemId)) {
        skippedIds.add(skipped.itemId);
        report.skipped.push(skipped);
      }
    }
  }

  if (ready.length === 0) {
    report.waves.push(wave);
    return { signal: "drained" };
  }

  phase("plan_wave");
  checkLifecycle(ctx, { ...context, phase: "plan_wave", point: "before" });
  if (dryRun) {
    for (const { item, classification } of ready) {
      const id = itemId(item);
      report.planned.push({ itemId: id, classification: classification.status, reason: classification.reason });
    }
    wave.planned = report.planned.map((entry) => entry.itemId);
    report.waves.push(wave);
    checkLifecycle(ctx, { ...context, phase: "plan_wave", point: "after" });
    return { signal: "drained" };
  }

  for (const { item, classification } of ready) {
    checkLifecycle(ctx, { ...context, item, itemId: itemId(item), phase: "process", point: "before" });
    const { breakItems } = await processReadyItem(ctx, { item, classification, context, wave });
    checkLifecycle(ctx, { ...context, item, itemId: itemId(item), phase: "process", point: "after" });
    if (breakItems) break;
  }
  report.waves.push(wave);
  if (report.budgetExhausted) return { signal: "stop" };
  if (report.failed.length > 0) return { signal: "stop" };
  return { signal: "continue" };
}

export async function drain(options) {
  const dryRun = options?.dryRun === true;
  const adapter = options?.adapter;
  validateAdapter(adapter);
  if (!dryRun) assertFunction(options.runLane, "runLane");
  const integrate = options.integrate ?? defaultIntegrate;
  if (!dryRun) assertFunction(integrate, "integrate");

  const maxWaves = Number.isInteger(options.maxWaves) && options.maxWaves > 0 ? options.maxWaves : 10;
  const maxAttempts = Number.isInteger(options.maxAttempts) && options.maxAttempts > 0 ? options.maxAttempts : 2;
  // Opt-in repair backoff (jbs3.2): default 0 preserves the historical no-delay repair loop.
  const retryBackoffBaseMs = Number.isFinite(options.retryBackoffBaseMs) && options.retryBackoffBaseMs > 0 ? options.retryBackoffBaseMs : 0;
  const sleep = typeof options.sleep === "function" ? options.sleep : ((ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms))));
  const report = {
    adapter: adapter.name || "anonymous",
    status: "running",
    dryRun,
    scope: options.scope ?? {},
    gateStatus: options.gateStatus ?? options.gates,
    phases: [],
    waves: [],
    planned: [],
    closed: [],
    failed: [],
    released: [],
    salvaged: [],
    skipped: [],
    followups: [],
    budgetExhausted: false,
    dryProof: undefined,
  };
  const ctx = { adapter, options, integrate, dryRun, maxAttempts, retryBackoffBaseMs, sleep, report, phase: undefined, skippedIds: new Set() };
  const phase = (name) => {
    checkLifecycle(ctx, { phase: name, point: "transition" });
    report.phases.push(name);
  };
  ctx.phase = phase;

  phase("preflight");
  // exhaustedWaves stays true unless a wave drains the queue (no ready work or a
  // dryRun plan). A budget/failure "stop" leaves it true because work may remain,
  // which the terminal-status table reads as max_waves_exceeded vs not_dry.
  let exhaustedWaves = true;
  let drainError;
  try {
    for (let waveNumber = 1; waveNumber <= maxWaves; waveNumber += 1) {
      const { signal } = await runWave(ctx, { waveNumber });
      if (signal === "drained") {
        exhaustedWaves = false;
        break;
      }
      if (signal === "stop") break;
      // signal === "continue": advance to the next wave.
    }
  } catch (error) {
    if (isLifecycleAbortError(error)) throw error;
    drainError = error;
    report.error = errorSummary(error);
  }

  phase("final_audit");
  checkLifecycle(ctx, { phase: "proveDry", point: "before" });
  report.dryProof = await adapter.proveDry(options.scope, { report });
  checkLifecycle(ctx, { phase: "proveDry", point: "after" });
  if (drainError) {
    report.status = "failed";
  } else if (dryRun) {
    report.status = "dry_run_complete";
  } else if (report.budgetExhausted) {
    report.status = "budget_exhausted";
  } else if (report.failed.length > 0) {
    report.status = "failed";
  } else if (report.dryProof?.dry === true) {
    report.status = "complete";
  } else if (exhaustedWaves) {
    report.status = "max_waves_exceeded";
  } else {
    report.status = "not_dry";
  }
  phase("complete");
  return report;
}
