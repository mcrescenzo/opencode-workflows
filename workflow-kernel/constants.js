import path from "node:path";
import { existsSync } from "node:fs";
import os from "node:os";

import { DEFAULT_SECRET_GLOBS } from "./path-policy.js";

export const PLUGIN_DIR = path.resolve(import.meta.dirname, "..");

// Detect the in-monorepo copy STRUCTURALLY: it lives at <root>/plugins/opencode-workflows/. Standalone
// it lives under <project>/node_modules/@mcrescenzo/opencode-workflows, whose parent dir is the npm
// scope ("@mcrescenzo"), never "plugins" — so this can't false-match a user project that merely has
// opencode.json + a workflows/ dir (the [Major] false-positive the advisor flagged).
export function detectLegacyConfigDir(startDir = PLUGIN_DIR) {
  const pluginsDir = path.dirname(path.resolve(startDir)); // candidate <root>/plugins
  if (path.basename(pluginsDir) !== "plugins") return null;
  const root = path.dirname(pluginsDir);                   // candidate <root>
  if (existsSync(path.join(root, "opencode.json")) && existsSync(path.join(root, "workflows"))) return root;
  return null;
}

// opencode's config dir (where opencode.json lives). Order: explicit OPENCODE_CONFIG_DIR →
// $XDG_CONFIG_HOME/opencode → <home>/.config/opencode. PluginInput exposes no config dir, and
// (verified on the opencode 1.17.11 runtime) no OPENCODE_CONFIG* env var is set, so we derive it.
// Cross-platform via os.homedir()/path.join; the env override is the escape hatch for any platform
// whose opencode config dir is not <home>/.config/opencode (e.g. Windows %APPDATA%).
export function resolveOpencodeConfigDir(env = process.env, home = os.homedir()) {
  if (env.OPENCODE_CONFIG_DIR) return path.resolve(env.OPENCODE_CONFIG_DIR);
  const configHome = env.XDG_CONFIG_HOME ? path.resolve(env.XDG_CONFIG_HOME) : path.join(home, ".config");
  return path.join(configHome, "opencode");
}

// Global/shared workflow dir (user-authored global workflows, runs, materialized roles/templates).
// Order: explicit env → legacy monorepo (marker-gated) → opencode config dir.
// User-authored content lives in the CONFIG dir (~/.config/opencode/workflows), not XDG state.
// ⚠️ To force the config-dir branch even inside the monorepo, move its return above the legacy block.
export function resolveGlobalWorkflowDir(env = process.env, startDir = PLUGIN_DIR, home = os.homedir()) {
  if (env.OPENCODE_WORKFLOWS_DIR) return path.resolve(env.OPENCODE_WORKFLOWS_DIR);
  const legacy = detectLegacyConfigDir(startDir);
  if (legacy) return path.join(legacy, "workflows");
  return path.join(resolveOpencodeConfigDir(env, home), "workflows");
}

export const GLOBAL_WORKFLOW_DIR = resolveGlobalWorkflowDir();
export const BUNDLED_WORKFLOW_DIR = path.join(PLUGIN_DIR, "workflows");
export const BUNDLED_COMMAND_DIR = path.join(PLUGIN_DIR, "commands");
export const BUNDLED_SKILL_DIR = path.join(PLUGIN_DIR, "skills");
export const ROLE_DIR = path.join(GLOBAL_WORKFLOW_DIR, "roles");
export const TEMPLATE_DIR = path.join(GLOBAL_WORKFLOW_DIR, "templates");
export const MAX_SOURCE_BYTES = 512 * 1024;
export const MAX_RESULT_BYTES = 256 * 1024;
export const MAX_INLINE_RESULT_BYTES = 32 * 1024;
export const MAX_RESULT_READBACK_BYTES = MAX_RESULT_BYTES;
export const MAX_RESULT_READ_FILE_BYTES = 16 * 1024 * 1024;
export const OPENCODE_WORKFLOWS_DEBUG_CAPTURE_ENV = "OPENCODE_WORKFLOWS_DEBUG_CAPTURE";
export const MAX_DEBUG_CAPTURE_FILE_BYTES = MAX_RESULT_READ_FILE_BYTES;
export const MAX_EVENT_MESSAGE_CHARS = 4000;
export const MAX_STATUS_STRING_CHARS = 600;
export const DEFAULT_WORKFLOW_EVENTS_LIMIT = 100;
export const MAX_WORKFLOW_EVENTS_LIMIT = 500;
export const MAX_ARGS_PREVIEW_CHARS = 2000;
export const MAX_HOST_CALLS = 10000;
export const MAX_PENDING_JOB_DRAIN_ITERATIONS = 10000;
export const HOST_CALLS_PER_MAX_AGENT = 1;
export const HOST_CALL_MARGIN = 1000;
export const MAX_EVENTS = 200000;
export const MAX_JOURNAL_RECORDS = 200000;
export const DEFAULT_MAX_AGENTS = 64;
export const DEFAULT_HARD_CONCURRENCY_LIMIT = 64;
export const MAX_CONFIGURABLE_CONCURRENCY_LIMIT = 100000;
export const HARD_CONCURRENCY_LIMIT_ENV = "OPENCODE_WORKFLOWS_HARD_CONCURRENCY_LIMIT";

export function normalizeHardConcurrencyLimit(value, fallback = DEFAULT_HARD_CONCURRENCY_LIMIT) {
  const parsed = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  if (Number.isInteger(parsed) && parsed >= 1 && parsed <= MAX_CONFIGURABLE_CONCURRENCY_LIMIT) return parsed;
  const fallbackParsed = typeof fallback === "string" && fallback.trim() !== "" ? Number(fallback) : fallback;
  if (Number.isInteger(fallbackParsed) && fallbackParsed >= 1 && fallbackParsed <= MAX_CONFIGURABLE_CONCURRENCY_LIMIT) return fallbackParsed;
  return DEFAULT_HARD_CONCURRENCY_LIMIT;
}

export function resolveHardConcurrencyLimit(env = process.env, fallback = DEFAULT_HARD_CONCURRENCY_LIMIT) {
  return normalizeHardConcurrencyLimit(env?.[HARD_CONCURRENCY_LIMIT_ENV], fallback);
}

// Conservative default. Concurrent blocking child prompts (session.prompt) have been
// observed stalling as an entire wave at high fan-out (12 lanes all timed out at the lane
// limit with 0 tokens, while single lanes completed). 4 remains the default pending live
// evidence. The ceiling is a separate operator policy knob: set
// OPENCODE_WORKFLOWS_HARD_CONCURRENCY_LIMIT or plugin option `hardConcurrencyLimit` to
// raise/lower the schema/runtime clamp. Larger bursts can amplify provider rate limits or
// reproduce the 2026-06-22 stall, so use workflow_live_gates({probeConcurrencyCapacity})
// to characterize a runtime before treating higher values as safe production headroom.
export const DEFAULT_CONCURRENCY = 4;
export const HARD_CONCURRENCY_LIMIT = resolveHardConcurrencyLimit();
export const DEFAULT_CONCURRENCY_PROBE_LIMIT = 16;
export const DEFAULT_RETRY_COUNT = 1;
export const DEFAULT_CORRECTIVE_RETRY_COUNT = 1;
export const MAX_CORRECTIVE_RETRY_COUNT = 2;
export const DEFAULT_CHILD_CREATE_TIMEOUT_MS = 30_000;
export const DEFAULT_CHILD_PROMPT_TIMEOUT_MS = 10 * 60 * 1000;
export const MAX_CHILD_PROMPT_TIMEOUT_MS = 60 * 60 * 1000;
export const DEFAULT_LIVE_PROBE_TIMEOUT_MS = 60_000;
// Floor verified against a live opencode 1.17.13: GET /global/health exists and
// returns {healthy,version}; Session.directory is a typed required create echo.
export const MIN_OPENCODE_SERVER_VERSION = "1.17.13";
export const DEFAULT_SUBPROCESS_TIMEOUT_MS = 2 * 60 * 1000;
export const DEFAULT_SUBPROCESS_MAX_BUFFER = 10 * 1024 * 1024;
export const DEFAULT_KEEP_RUNS = 30;
export const DEFAULT_GUEST_DEADLINE_MS = 5_000;
export const WORKFLOW_TOAST_DURATION_MS = 90_000;
export const WORKFLOW_PROGRESS_TOAST_INTERVAL_MS = 45_000;
export const WORKFLOW_PROGRESS_TOAST_FORCE_MS = 75_000;
export const RUN_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;

export const ACTIVE_STATUSES = new Set(["running", "cancelling", "pausing", "apply-running", "active-unknown", "stale-active"]);
export const AMBIGUOUS_EDIT_STATUSES = new Set(["awaiting-diff-approval", "apply-running", "review-required", "failed-with-diff-plan"]);
export const LANE_OUTCOMES = ["success", "failure", "cancelled", "timeout", "budget_stopped"];
export const DURABLE_STATE_VERSION = 2;
export const DURABLE_LEDGER_FILES = ["integration-ledger.jsonl", "validation-ledger.jsonl", "domain-ledger.jsonl", "apply-ledger.jsonl"];
export const SENSITIVE_KEY_RE = /(api[_-]?key|authorization|credential|password|secret|token)/i;
export const SECRET_GLOBS = DEFAULT_SECRET_GLOBS;
