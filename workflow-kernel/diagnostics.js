import { createHash } from "node:crypto";
import { appendFile, chmod, mkdir, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { redactFreeTextSecrets } from "./free-text-redactor.js";

const SCHEMA = "opencode.plugin.diagnostic.v1";
const PLUGIN = "opencode-workflows";
const LEVELS = new Set(["debug", "info", "warn", "error"]);
const MAX_STRING = 4_000;
const MAX_RECORD = 16_000;
const MAX_DEPTH = 6;
const MAX_ENTRIES = 100;
const SECRET_KEY_RE = /(^|_|-|\.)(authorization|cookie|password|passwd|secret|token|api[_-]?key|apikey|access[_-]?key|private[_-]?key|refresh[_-]?token|serverPassword)($|_|-|\.)/i;

const EVENT_MAP = new Map([
  ["run.started", { level: "info", event: "workflow_run_started", message: "Workflow run started", outcome: "started" }],
  ["run.completed", { level: "info", event: "workflow_run_completed", message: "Workflow run completed", outcome: "success" }],
  ["run.awaiting_diff_approval", { level: "warn", event: "workflow_run_awaiting_diff_approval", message: "Workflow run awaits diff approval", outcome: "blocked" }],
  ["run.failed_with_diff_plan", { level: "warn", event: "workflow_run_failed_with_diff_plan", message: "Workflow run failed with a diff plan for review", outcome: "failure" }],
  ["run.apply_failed", { level: "error", event: "workflow_apply_failed", message: "Workflow auto-apply failed", outcome: "failure" }],
  ["run.failed", { level: "error", event: "workflow_run_failed", message: "Workflow run failed", outcome: "failure" }],
  ["run.cancelled", { level: "warn", event: "workflow_run_cancelled", message: "Workflow run cancelled", outcome: "cancelled" }],
  ["run.paused", { level: "warn", event: "workflow_run_paused", message: "Workflow run paused", outcome: "paused" }],
  ["agent.failure", { level: "error", event: "workflow_lane_failed", message: "Workflow child lane failed", outcome: "failure" }],
  ["agent.timeout", { level: "error", event: "workflow_lane_timed_out", message: "Workflow child lane timed out", outcome: "timeout" }],
  ["agent.cancelled", { level: "warn", event: "workflow_lane_cancelled", message: "Workflow child lane cancelled", outcome: "cancelled" }],
  ["agent.budget_stopped", { level: "warn", event: "workflow_lane_budget_stopped", message: "Workflow child lane stopped by budget", outcome: "budget_stopped" }],
  ["agent.salvageable_dirty_failure", { level: "warn", event: "workflow_lane_salvageable_dirty_failure", message: "Workflow lane failed with dirty salvageable worktree", outcome: "failure" }],
  ["cache.checkpoint_write_failed", { level: "warn", event: "workflow_checkpoint_write_failed", message: "Workflow checkpoint write failed", outcome: "degraded" }],
  ["fanout.lane_dropped", { level: "warn", event: "workflow_fanout_lane_dropped", message: "Workflow fanout lane was dropped", outcome: "failure" }],
  ["fanout.sequential", { level: "info", event: "workflow_fanout_sequential", message: "Workflow fanout intentionally ran sequentially", outcome: "success" }],
  ["integration.review_required", { level: "warn", event: "workflow_integration_review_required", message: "Workflow integration requires review", outcome: "blocked" }],
]);

function redactText(value) {
  if (value === undefined || value === null) return "";
  const text = redactFreeTextSecrets(String(value));
  if (text.length <= MAX_STRING) return text;
  return `${text.slice(0, MAX_STRING)}\n[truncated ${text.length - MAX_STRING} chars]`;
}

function redactValue(value, seen = new WeakSet(), depth = 0) {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return redactText(value);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return String(value);
  if (typeof value === "function") return "[function]";
  if (typeof value !== "object") return redactText(String(value));
  if (seen.has(value)) return "[circular]";
  if (depth >= MAX_DEPTH) return "[max-depth]";
  seen.add(value);
  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_ENTRIES).map((item) => redactValue(item, seen, depth + 1));
    if (value.length > MAX_ENTRIES) items.push(`[${value.length - MAX_ENTRIES} more items]`);
    return items;
  }
  const out = {};
  let count = 0;
  for (const [key, item] of Object.entries(value)) {
    if (count >= MAX_ENTRIES) {
      out.__truncated_entries = Object.keys(value).length - MAX_ENTRIES;
      break;
    }
    out[key] = SECRET_KEY_RE.test(String(key)) ? "[redacted]" : redactValue(item, seen, depth + 1);
    count += 1;
  }
  return out;
}

function diagnosticsRoot() {
  if (process.env.OPENCODE_PLUGIN_DIAGNOSTICS_DIR) return path.resolve(process.env.OPENCODE_PLUGIN_DIAGNOSTICS_DIR);
  const base = process.env.XDG_STATE_HOME ? path.resolve(process.env.XDG_STATE_HOME) : path.join(os.homedir(), ".local", "state");
  return path.join(base, "opencode", "plugin-diagnostics");
}

function safeName(value, fallback = "project") {
  return (String(value || fallback).replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 40) || fallback);
}

function projectFromRunDir(runDir) {
  const marker = `${path.sep}.opencode${path.sep}workflows${path.sep}runs${path.sep}`;
  const index = String(runDir || "").indexOf(marker);
  return index > 0 ? String(runDir).slice(0, index) : undefined;
}

async function projectKey(directory) {
  const resolved = path.resolve(directory || process.cwd());
  let canonical = resolved;
  try { canonical = await realpath(resolved); } catch {}
  return `${safeName(path.basename(canonical || resolved))}-${createHash("sha256").update(canonical).digest("hex").slice(0, 16)}`;
}

function jsonLine(record) {
  let text = JSON.stringify(record);
  if (text.length <= MAX_RECORD) return `${text}\n`;
  text = JSON.stringify({ ...record, data: record.data === undefined ? undefined : "[omitted: record too large]" });
  return `${text}\n`;
}

function summaryData(event) {
  return redactValue({
    type: event.type,
    callId: event.callId,
    childID: event.childID,
    reason: event.reason,
    culpritLane: event.culpritLane,
    conflictCount: event.conflictCount,
    changedFileCount: event.changedFileCount,
    drainStatus: event.drainStatus,
    diffPlanHash: event.diffPlanHash,
    error: event.error,
    kind: event.kind,
    // Lane failure taxonomy (transient / transient_exhausted / terminal) so the diagnostic
    // sink distinguishes a rate-limit/overload lane that exhausted its retries from a terminal
    // one (bad model id, auth, schema). Set on agent.* failure/retry events (jbs3.2).
    failureClass: event.failureClass,
  });
}

export async function emitWorkflowDiagnostic(run, event) {
  if (process.env.OPENCODE_PLUGIN_DIAGNOSTICS_DISABLED === "1") return;
  const mapped = EVENT_MAP.get(event?.type);
  if (!mapped) return;
  try {
    const directory = run?.projectDirectory || projectFromRunDir(run?.dir) || process.cwd();
    const dir = path.join(diagnosticsRoot(), await projectKey(directory), PLUGIN);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await chmod(dir, 0o700).catch(() => {});
    const record = redactValue({
      schema: SCHEMA,
      ts: new Date().toISOString(),
      plugin: PLUGIN,
      level: LEVELS.has(mapped.level) ? mapped.level : "info",
      event: mapped.event,
      message: mapped.message,
      runID: run?.id,
      childID: event.childID,
      operation: event.type,
      outcome: mapped.outcome,
      error: event.error ? { message: event.error } : undefined,
      data: summaryData(event),
    });
    const file = path.join(dir, `${PLUGIN}-${new Date().toISOString().slice(0, 10)}-${process.pid}.jsonl`);
    await appendFile(file, jsonLine(record), { mode: 0o600 });
    await chmod(file, 0o600).catch(() => {});
  } catch {
    // Diagnostics are best effort and must never affect workflow execution.
  }
}
