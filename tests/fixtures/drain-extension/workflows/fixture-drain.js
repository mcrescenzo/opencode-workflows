export const meta = {
  name: "fixture-drain",
  description: "Synthetic drain workflow fixture. Host-owned controller loop: discovery, validation, mutation staging, and dry proof stay in the trusted adapter; implementation lanes are isolated worktrees. Stands in for a trusted extension's drain workflow so the kernel drain mechanism stays covered without any domain extension.",
  harness: "drain",
  adapter: "fake",
  // Authority ceiling for display/listing. At run time the canonical drain normalization sets the
  // mode-appropriate profile (drain-dry-run for the default dry-run, drain-autonomous-local for live),
  // which shadows this value — so the actual authority always matches the resolved mode.
  profile: "drain-autonomous-local",
  maxAgents: 16,
  concurrency: 4,
  phases: ["preflight", "snapshot", "claim", "spawn_lanes", "validate", "close", "final_audit", "complete"],
  category: "autonomous-backlog-drain",
  notes: "Machine invocation source of truth for fixture-drain. Defaults to safe dry-run; autonomous-local mutates local domain state only after verified gates and approval.",
  examples: [
    { label: "safe dry-run preview", args: { mode: "dry-run", scope: { priority: "P0" }, expectedReady: 4 } },
    { label: "local autonomous drain", args: { mode: "autonomous-local", scope: { label: "ready-for-agent" }, maxWaves: 8 } },
  ],
  argsSchema: {
    type: "object",
    properties: {
      mode: {},
      dryRun: {},
      scope: {},
      repo: {},
      expectedReady: {},
      maxWaves: {},
      maxAttempts: {},
      actor: {},
    },
  },
};

if (args !== undefined && args !== null && (typeof args !== "object" || Array.isArray(args))) {
  throw new Error('fixture-drain workflow args must be a JSON object when provided; omit args or pass an object such as {"mode":"dry-run"} or {"mode":"autonomous-local"}');
}

const runtimeArgs = args ?? {};
const mode = runtimeArgs.mode ?? (runtimeArgs.dryRun === false ? "autonomous-local" : "dry-run");
if (!["dry-run", "autonomous-local"].includes(mode)) {
  throw new Error('fixture-drain mode must be "dry-run" or "autonomous-local"');
}

const dryRun = mode === "dry-run";
if (runtimeArgs.scope !== undefined && runtimeArgs.scope !== null
  && (typeof runtimeArgs.scope !== "object" || Array.isArray(runtimeArgs.scope))) {
  // Throw a string, not an Error: the host sandbox serializes a rejected guest Error to the
  // useless "[object Object]" (String(vm.dump(error))), but preserves a thrown string verbatim,
  // so the clear reason survives the sandbox boundary to the caller.
  throw 'fixture-drain scope must be a JSON object when provided; a string/array would silently spread to a meaningless char-indexed scope and run an UNFILTERED drain — pass an object such as {"scope":{"priority":"P0"}} or omit it';
}
const scope = { ...(runtimeArgs.scope ?? {}) };
if (runtimeArgs.repo !== undefined && runtimeArgs.repo !== null) scope.repo = runtimeArgs.repo;

const expectedReady = Number.isInteger(runtimeArgs.expectedReady) && runtimeArgs.expectedReady > 0 ? runtimeArgs.expectedReady : 4;
const maxWaves = Number.isInteger(runtimeArgs.maxWaves) && runtimeArgs.maxWaves > 0
  ? runtimeArgs.maxWaves
  : Math.max(50, expectedReady * 16);
const maxAttempts = Number.isInteger(runtimeArgs.maxAttempts) && runtimeArgs.maxAttempts > 0 ? runtimeArgs.maxAttempts : 2;

const report = await drain({
  adapter: "fake",
  dryRun,
  scope,
  maxWaves,
  maxAttempts,
  ...(typeof runtimeArgs.actor === "string" ? { actor: runtimeArgs.actor } : {}),
});

const plannedIds = (report.planned ?? []).map((item) => item.itemId ?? item.id).filter(Boolean);
const closedIds = (report.closed ?? []).map((item) => item.itemId ?? item.id).filter(Boolean);
const failedIds = (report.failed ?? []).map((item) => item.itemId ?? item.id).filter(Boolean);
const stopReason = dryRun
  ? (plannedIds.length > 0 ? "dry_run_plan" : report.dryProof?.dry === true ? "queue_empty" : "not_dry")
  : report.status === "complete"
    ? "queue_empty"
    : report.status;

return {
  ...report,
  mode,
  dryRun,
  remote_sync: "local-only",
  stop_reason: stopReason,
  planned_ids: plannedIds,
  closed_ids: closedIds,
  failed_ids: failedIds,
};
