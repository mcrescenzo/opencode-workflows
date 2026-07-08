import { addTokens, zeroTokens } from "./budget-accounting.js";
import { redactFreeTextSecrets } from "./free-text-redactor.js";
import { deriveScopeItemProgress } from "./notification-toast-scope.js";
import { stableStringify, truncateText } from "./text-json.js";

const CARD_LINE_MAX = 44;
const CARD_MAX_LANES = 4;
const LANE_IDLE_MS = 2 * 60 * 1000;
const STALE_PROGRESS_THRESHOLD_MS = 10 * 60 * 1000;
const ACTIVE_LANE_STATUSES = new Set(["worktree-created", "running", "committed", "permission-mismatch"]);
const FAILURE_OUTCOMES = ["failure", "timeout", "cancelled", "budget_stopped"];

const GLYPHS = {
  unicode: {
    play: "▶",
    running: "⟳",
    warning: "⚠",
    success: "✓",
    failure: "✗",
    queued: "⧗",
    log: "»",
    phase: "▸",
    root: "└",
    branch: "├",
    last: "└",
    sep: " · ",
    dash: " — ",
  },
  ascii: {
    play: ">",
    running: "~",
    warning: "!",
    success: "ok",
    failure: "x",
    queued: "q",
    log: ">",
    phase: ">",
    root: "\\",
    branch: "+",
    last: "\\",
    sep: " | ",
    dash: " - ",
  },
};

function glyphs(options = {}) {
  return options.ascii === true ? GLYPHS.ascii : GLYPHS.unicode;
}

function cleanText(value, max = 80) {
  return truncateText(redactFreeTextSecrets(String(value ?? "").replace(/\s+/g, " ").trim()), max);
}

function line(text, options = {}) {
  return truncateText(String(text ?? ""), Number.isFinite(options.maxLine) ? options.maxLine : CARD_LINE_MAX);
}

function compactDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "-";
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m${seconds % 60 ? `${seconds % 60}s` : ""}`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h${minutes % 60}m`;
}

function parseTime(value) {
  const parsed = typeof value === "string" ? Date.parse(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : undefined;
}

function laneRecordsForCards(run) {
  if (run?.laneRecords instanceof Map) return [...run.laneRecords.values()];
  return Array.isArray(run?.laneRecords) ? run.laneRecords : [];
}

function workflowDisplayName(run) {
  const name = typeof run?.meta?.name === "string" ? run.meta.name.trim() : "";
  return name || "unnamed";
}

function workflowQueuedAgents(run) {
  return run?.waitingAgents?.length ?? run?.queuedAgents ?? 0;
}

function workflowTotalCost(run) {
  const cost = Number(run?.cost ?? 0) + Number(run?.replayedCost ?? 0);
  return Number.isFinite(cost) ? cost : 0;
}

function workflowTotalTokens(run) {
  const total = addTokens(run?.tokens ?? zeroTokens(), run?.replayedTokens ?? zeroTokens());
  return (total.input ?? 0) + (total.output ?? 0) + (total.reasoning ?? 0);
}

function workflowCostLabel(run) {
  return workflowTotalCost(run).toFixed(4).replace(/\.?0+$/, "") || "0";
}

function budgetPercent(run, tokens, cost) {
  const values = [];
  const maxTokens = Number(run?.budgetCeilings?.maxTokens);
  if (Number.isFinite(maxTokens) && maxTokens > 0) values.push((tokens / maxTokens) * 100);
  const maxCost = Number(run?.budgetCeilings?.maxCost);
  if (Number.isFinite(maxCost) && maxCost > 0) values.push((cost / maxCost) * 100);
  if (values.length === 0) return undefined;
  return Math.max(0, Math.round(Math.max(...values)));
}

function phaseSnapshot(run) {
  const phases = Array.isArray(run?.meta?.phases) ? run.meta.phases.map((item) => String(item)) : [];
  const name = run?.currentPhase ? String(run.currentPhase) : phases[0] || "phase";
  const index = phases.indexOf(name);
  return {
    name,
    phases,
    index: index >= 0 ? index : undefined,
    total: phases.length || undefined,
    label: index >= 0 && phases.length > 0 ? `${name} (${index + 1}/${phases.length})` : name,
  };
}

function laneLabel(record) {
  const value = record?.taskSummary || record?.title || record?.label || record?.callId || "lane";
  return cleanText(value, 28);
}

function laneSnapshot(record, now) {
  const startedMs = parseTime(record?.startedAt);
  const lastActivityMs = parseTime(record?.lastActivityAt ?? record?.updatedAt ?? record?.completedAt ?? record?.startedAt);
  const status = String(record?.outcome ?? record?.status ?? "unknown");
  const ageMs = Number.isFinite(startedMs) ? Math.max(0, now - startedMs) : undefined;
  const idleMs = Number.isFinite(lastActivityMs) ? Math.max(0, now - lastActivityMs) : undefined;
  return {
    callId: record?.callId,
    label: laneLabel(record),
    status,
    outcome: record?.outcome,
    ageMs,
    idleMs,
    age: compactDuration(ageMs),
    idle: Number.isFinite(idleMs) && idleMs >= LANE_IDLE_MS,
    attempt: Number.isInteger(record?.attempt) ? record.attempt : undefined,
    maxAttempts: Number.isInteger(record?.maxAttempts) ? record.maxAttempts : undefined,
    errorSummary: record?.errorSummary ? cleanText(record.errorSummary, 36) : undefined,
    retryable: record?.retryable,
  };
}

function activeLaneRows(lanes, max = CARD_MAX_LANES) {
  const active = lanes.filter((lane) => ACTIVE_LANE_STATUSES.has(lane.status) && !lane.outcome);
  const sorted = active.sort((a, b) => (b.ageMs ?? 0) - (a.ageMs ?? 0));
  const selected = sorted.slice(0, max);
  for (const idle of sorted.filter((lane) => lane.idle)) {
    if (selected.some((item) => item.callId === idle.callId)) continue;
    const replaceAt = selected.findLastIndex((lane) => !lane.idle);
    if (replaceAt === -1) break;
    selected[replaceAt] = idle;
  }
  return selected.sort((a, b) => (b.ageMs ?? 0) - (a.ageMs ?? 0));
}

function latestLog(run) {
  const logs = Array.isArray(run?.recentLogs) ? run.recentLogs : [];
  return logs.length ? cleanText(logs.at(-1), 58) : undefined;
}

function stalenessSnapshot(run, lanes, now) {
  const candidates = [parseTime(run?.startedAt), parseTime(run?.resumedAt), parseTime(run?.lastEventAt)];
  for (const lane of lanes) {
    candidates.push(parseTime(lane.lastActivityAt ?? lane.updatedAt ?? lane.completedAt ?? lane.startedAt));
  }
  const latest = candidates.filter(Number.isFinite).sort((a, b) => b - a)[0];
  const ageMs = Number.isFinite(latest) ? Math.max(0, now - latest) : null;
  return {
    ageMs,
    thresholdMs: STALE_PROGRESS_THRESHOLD_MS,
    stale: run?.status === "running" && ageMs !== null && ageMs > STALE_PROGRESS_THRESHOLD_MS,
  };
}

function workflowToastCardSnapshot(run, options = {}) {
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  const startedMs = parseTime(run?.startedAt);
  const finishedMs = parseTime(run?.finishedAt);
  const endMs = Number.isFinite(finishedMs) ? finishedMs : now;
  const tokens = workflowTotalTokens(run);
  const cost = workflowTotalCost(run);
  const laneRecords = laneRecordsForCards(run);
  const lanes = laneRecords.map((record) => laneSnapshot(record, now));
  const outcomes = run?.laneOutcomes ?? {};
  const failed = FAILURE_OUTCOMES.reduce((sum, key) => sum + (Number(outcomes[key]) || 0), 0);
  return {
    id: run?.id,
    shortId: String(run?.id ?? "").slice(0, 8),
    name: workflowDisplayName(run),
    status: run?.status ?? "unknown",
    elapsedMs: Number.isFinite(startedMs) ? Math.max(0, endMs - startedMs) : undefined,
    elapsed: Number.isFinite(startedMs) ? compactDuration(endMs - startedMs) : "-",
    elapsedBucket: Number.isFinite(startedMs) ? Math.floor((endMs - startedMs) / 30_000) : 0,
    phase: phaseSnapshot(run),
    agentsStarted: run?.agentsStarted ?? 0,
    activeAgents: run?.activeAgents ?? 0,
    queuedAgents: workflowQueuedAgents(run),
    outcomes,
    done: Number(outcomes.success) || 0,
    failed,
    droppedLaneCount: run?.droppedLaneCount ?? 0,
    tokens,
    tokenLabel: tokens >= 1000 ? `${Math.round(tokens / 1000)}k` : String(tokens),
    cost,
    costLabel: workflowCostLabel(run),
    budgetPercent: budgetPercent(run, tokens, cost),
    lanes,
    activeLanes: activeLaneRows(lanes, CARD_MAX_LANES),
    itemProgress: deriveScopeItemProgress(laneRecords),
    recentLog: latestLog(run),
    staleness: stalenessSnapshot(run, laneRecords, now),
    recoveredCount: lanes.filter((lane) => lane.status === "success" || lane.status === "completed").filter((lane) => (lane.attempt ?? 1) > 1).length,
    error: run?.error ? cleanText(run.error, 80) : undefined,
    diffPlanHash: run?.editPlan?.diffPlanHash,
    patchCount: Array.isArray(run?.editPlan?.patches) ? run.editPlan.patches.length : run?.editPlan?.patchCount,
  };
}

function counterLine(snapshot, g) {
  const parts = [`done ${snapshot.done}`, `queued ${snapshot.queuedAgents}`];
  if (snapshot.failed > 0) parts.push(`fail ${snapshot.failed}`);
  if (snapshot.droppedLaneCount > 0) parts.push(`drop ${snapshot.droppedLaneCount}`);
  return parts.join(g.sep);
}

function progressLine(snapshot, g) {
  const parts = [];
  if (snapshot.itemProgress) parts.push(`items ${snapshot.itemProgress.done}/${snapshot.itemProgress.total}`);
  if (Number.isFinite(snapshot.budgetPercent)) parts.push(`budget ${snapshot.budgetPercent}%`);
  return parts.length ? parts.join(g.sep) : undefined;
}

function renderWorkflowHeartbeatCard(snapshot, options = {}) {
  const g = glyphs(options);
  const title = line(`${g.play} ${snapshot.name}${g.sep}${snapshot.elapsed}`, options);
  const lines = [
    `${g.root} ${snapshot.phase.label}`,
  ];
  snapshot.activeLanes.forEach((lane, index) => {
    const branch = index === snapshot.activeLanes.length - 1 ? g.last : g.branch;
    lines.push(`  ${branch} ${g.running} ${lane.label} ${lane.age}${lane.idle ? `${g.sep}${g.warning}idle` : ""}`);
  });
  lines.push(`  ${counterLine(snapshot, g)}`);
  const progress = progressLine(snapshot, g);
  if (progress) lines.push(`  ${progress}`);
  if (snapshot.recentLog) lines.push(`${g.log} ${snapshot.recentLog}`);
  return {
    variant: "info",
    title,
    message: lines.map((item) => line(item, options)).join("\n"),
  };
}

function statusCounters(snapshot, g) {
  return `${g.success}${snapshot.done} ${g.running}${snapshot.activeAgents} ${g.queued}${snapshot.queuedAgents}`;
}

function renderWorkflowProblemCard(snapshot, problem = {}, options = {}) {
  const g = glyphs(options);
  const kind = problem.kind || "lane-failure";
  const severity = problem.variant || (kind === "budget-100" ? "error" : "warning");
  const titleSubject = kind === "stall" ? "workflow stalled"
    : kind === "budget-80" ? "budget 80%"
      : kind === "budget-100" ? "budget exhausted"
        : problem.count > 1 ? `${problem.count} lanes failed`
          : "lane failed";
  const title = line(`${kind === "budget-100" || kind === "lane-failure" ? g.failure : g.warning} ${titleSubject}${g.sep}${snapshot.name}`, options);
  const label = cleanText(problem.label || problem.callId || "workflow", 28);
  const reason = cleanText(problem.reason || snapshot.error || "needs attention", 42);
  const attempt = Number.isInteger(problem.attempt) && Number.isInteger(problem.maxAttempts)
    ? ` (attempt ${problem.attempt}/${problem.maxAttempts})`
    : "";
  const lines = [
    `${label}${g.dash}${reason}${attempt}`,
  ];
  if (Number.isFinite(problem.retryInMs)) lines.push(`retrying in ${compactDuration(problem.retryInMs)}${problem.ordinal ? `${g.sep}${problem.ordinal}` : ""}`);
  if (kind === "stall" && Number.isFinite(problem.idleMs)) lines.push(`no progress ${compactDuration(problem.idleMs)}${g.sep}${problem.idleLaneCount ?? 0} lanes idle`);
  if (kind.startsWith("budget") && Number.isFinite(snapshot.budgetPercent)) lines.push(`budget ${snapshot.budgetPercent}%${g.sep}${snapshot.tokenLabel} tok`);
  lines.push(`${g.phase} ${snapshot.phase.name}: ${statusCounters(snapshot, g)}`);
  lines.push(...inspectLines(snapshot));
  return {
    variant: severity,
    title,
    message: lines.map((item) => line(item, options)).join("\n"),
  };
}

function terminalTitleStatus(snapshot, g) {
  if (snapshot.status === "completed" || snapshot.status === "applied") return `${g.success} ${snapshot.name} done`;
  if (snapshot.status === "awaiting-diff-approval") return `${g.warning} ${snapshot.name} awaits apply`;
  if (snapshot.status === "review-required") return `${g.warning} ${snapshot.name} review`;
  if (snapshot.status === "apply-failed" || snapshot.status === "failed-with-diff-plan" || snapshot.status === "failed") return `${g.failure} ${snapshot.name} failed`;
  return `${g.warning} ${snapshot.name} ${snapshot.status}`;
}

function phaseBreadcrumb(snapshot, g) {
  const phases = snapshot.phase.phases;
  if (!phases.length) return `${g.phase} ${snapshot.phase.name}`;
  // Current phase name has no match in meta.phases (phaseSnapshot leaves index undefined for
  // that case): render just the phase name rather than guessing it's the last declared one.
  if (snapshot.phase.index === undefined) return `${g.phase} ${snapshot.phase.name}`;
  const failed = ["failed", "apply-failed", "failed-with-diff-plan", "timed-out", "cancelled", "budget_stopped"].includes(snapshot.status);
  const current = snapshot.phase.index;
  return phases.map((phase, index) => {
    const mark = failed && index === current ? g.failure : index <= current || !failed ? g.success : g.queued;
    return `${mark} ${phase}`;
  }).join(" ");
}

function renderWorkflowTerminalCard(snapshot, options = {}) {
  const g = glyphs(options);
  const title = line(`${terminalTitleStatus(snapshot, g)}${g.sep}${snapshot.elapsed}`, options);
  const laneTotal = Object.values(snapshot.outcomes).reduce((sum, value) => sum + (Number(value) || 0), 0);
  const laneLine = `${laneTotal} lanes: ${g.success}${snapshot.done} ${g.failure}${snapshot.failed}${snapshot.recoveredCount ? ` (${snapshot.recoveredCount} recovered)` : ""}`;
  const usage = [`${snapshot.tokenLabel} tok`, `$${snapshot.costLabel}`];
  if (Number.isFinite(snapshot.budgetPercent)) usage.push(`${snapshot.budgetPercent}% of budget`);
  const lines = [
    phaseBreadcrumb(snapshot, g),
    laneLine,
    usage.join(g.sep),
  ];
  if (snapshot.recentLog) lines.push(`${g.log} ${snapshot.recentLog}`);
  lines.push(...inspectLines(snapshot));
  const variant = snapshot.status === "completed" || snapshot.status === "applied" ? "success"
    : snapshot.status === "failed" || snapshot.status === "apply-failed" ? "error"
      : "warning";
  return {
    variant,
    title,
    message: lines.map((item) => line(item, options)).join("\n"),
  };
}

function renderWorkflowApplyCard(snapshot, options = {}) {
  const g = glyphs(options);
  const descriptor = snapshot.status === "apply-running" ? { variant: "info", label: "apply running" }
    : snapshot.status === "applied" ? { variant: "success", label: "applied" }
      : snapshot.status === "review-required" ? { variant: "warning", label: "apply review" }
        : snapshot.status === "apply-failed" ? { variant: "error", label: "apply failed" }
          : { variant: "warning", label: snapshot.status };
  const patchCount = snapshot.patchCount;
  const lines = [
    `${g.root} ${descriptor.label}`,
  ];
  if (Number.isFinite(patchCount)) lines.push(`  patches ${patchCount}`);
  if (snapshot.diffPlanHash) lines.push(`  diff ${String(snapshot.diffPlanHash).slice(0, 12)}`);
  if (snapshot.error) lines.push(`${g.warning} ${snapshot.error}`);
  lines.push(...inspectLines(snapshot));
  return {
    variant: descriptor.variant,
    title: line(`${g.play} ${snapshot.name}${g.sep}${descriptor.label}`, options),
    message: lines.map((item) => line(item, options)).join("\n"),
  };
}

function inspectLines(snapshot) {
  const id = String(snapshot.id ?? "");
  const oneLine = `inspect: workflow_status runId=${id}`;
  if (oneLine.length <= CARD_LINE_MAX) return [oneLine];
  return ["inspect: workflow_status", `  runId=${id}`];
}

function workflowToastCardSignature(snapshot) {
  return stableStringify({
    status: snapshot.status,
    phase: snapshot.phase.label,
    elapsedBucket: snapshot.elapsedBucket,
    agents: [snapshot.activeAgents, snapshot.queuedAgents, snapshot.agentsStarted],
    outcomes: snapshot.outcomes,
    dropped: snapshot.droppedLaneCount,
    budgetPercent: snapshot.budgetPercent,
    itemProgress: snapshot.itemProgress ? [snapshot.itemProgress.done, snapshot.itemProgress.total, snapshot.itemProgress.currentStage, snapshot.itemProgress.totalStages] : null,
    recentLog: snapshot.recentLog,
    lanes: snapshot.activeLanes.map((lane) => [lane.callId, lane.status, lane.age, lane.idle, lane.label]),
  });
}

export {
  CARD_LINE_MAX,
  CARD_MAX_LANES,
  laneRecordsForCards,
  workflowToastCardSnapshot,
  workflowToastCardSignature,
  renderWorkflowHeartbeatCard,
  renderWorkflowProblemCard,
  renderWorkflowTerminalCard,
  renderWorkflowApplyCard,
};
