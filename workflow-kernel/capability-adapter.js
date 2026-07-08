import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { hasFunction } from "./text-json.js";
import { WorkflowAuthorityError } from "./errors.js";
import {
  DEFAULT_CONCURRENCY,
  DEFAULT_CONCURRENCY_PROBE_LIMIT,
  HARD_CONCURRENCY_LIMIT,
  normalizeHardConcurrencyLimit,
} from "./constants.js";
import {
  AD_HOC_AUTHORITY_PROFILE,
  assertWriteWorkflowAllowed,
  normalizeRequiredGates,
} from "./authority-policy.js";
import { sessionApi } from "./session-access.js";
import { hasWorkflowToast } from "./notification-toast.js";
// Gate-shape constructors live in gate-shapes.js; re-exported below so the public
// CapabilityAdapter surface (and the kernel barrel) is unchanged after the split.
import {
  forcedGate,
  gateAvailableUnverified,
  gateBlocked,
  shapeGate,
} from "./gate-shapes.js";
// Live-gate probe functions live in live-gate-probes.js. liveGateReport /
// promoteCapabilities below fan them out.
import {
  probeBackgroundContinuationGate,
  probeCancellationGate,
  probeCommandScopedBash,
  probeConcurrencyCapacityGate,
  probeDeniedBash,
  probeDirectoryRootingGate,
  probeIntegrationWorktreeIsolationGate,
  probeMcpAccessGate,
  probeSecretReadDeny,
  probeStructuredOutput,
  probeStructuredOutputGate,
  probeWorkflowNotificationGate,
  probeWorktreeEditIsolationGate,
  probeWorktreeGate,
} from "./live-gate-probes.js";

// R32 (opencode-workflows-6ti): a verified gate may carry a weak evidenceStrength.
// `in-process-smoke` exercises NOTHING of the target subsystem — it only yields the
// event loop (used by backgroundContinuation, which awaits a 0ms timeout and never
// touches the OpenCode background subsystem or proves restart survival). It must NOT
// satisfy a *required* authority gate on its own; an operator who adds such a gate to
// requiredGates must explicitly accept the weak strength via acceptWeakEvidence.
// Note: `no-attempt-fallback` is intentionally NOT down-ranked here — it is a
// compatibility fallback that still observes the real session API (retained deny rules)
// and the required permissionEnforcement gate depends on it passing.
// R31 (opencode-workflows-8w8): directoryRooting no longer produces a verified
// `model-text-only` strength at all — a model echoing the cwd in text is reported as
// available-unverified (verified=false), so it can never satisfy the required gate.
const NON_BEHAVIORAL_EVIDENCE_STRENGTHS = new Set([
  "in-process-smoke",
]);

// Module-level cache of in-flight / verified capability probe promises, keyed by
// redacted serverUrl + resolved directory. Each entry is `{ promise, verified, ts }`.
//
// R14: only *verified* probe results are retained for the process lifetime. A
// non-verified outcome (model answered from memory, transient server/transport
// error, timeout) is treated as ephemeral: the cache entry is dropped once it
// resolves so the next elevated workflow re-probes instead of inheriting a stale
// "available-unverified" / "blocked" that would otherwise lock out promotion until
// an OpenCode restart. We also coalesce concurrent in-flight probes (only one probe
// per key runs at a time) and apply a short TTL to verified entries so a long-lived
// process eventually re-confirms a previously-verified capability.
//
// The individual probe fields inside each entry self-expire via VERIFIED_PROBE_TTL_MS,
// but that only shrinks each entry's field set — it never removes the OUTER
// key -> cache binding. Without a cap on the outer map, a long-lived host that serves
// many projects/worktrees would accumulate one entry per distinct (serverUrl,
// directory) pair forever (AGENTS.md bounded-map invariant). So capabilityProbes is an
// LRU-bounded Map (analogous to BoundedTimestampSet in lifecycle-control.js): capped at
// CAPABILITY_PROBE_CACHE_MAX distinct keys with least-recently-used eviction on overflow.
const CAPABILITY_PROBE_CACHE_MAX = 200;

// LRU Map: consumed exactly like a plain Map (get/set/has/delete/clear/size/iteration),
// but capped at CAPABILITY_PROBE_CACHE_MAX distinct keys. Map preserves insertion order,
// so the first key is the least-recently-used; get() and set() re-insert their key to
// mark it most-recently-used, and set() evicts from the front once the cap is exceeded.
class BoundedProbeCache extends Map {
  constructor(max = CAPABILITY_PROBE_CACHE_MAX) {
    super();
    this.max = max;
  }

  get(key) {
    const value = super.get(key);
    // Touch on access: re-inserting moves the key to the most-recently-used end so it
    // is not the next eviction victim. Returns the same cache object, so callers that
    // mutate cache[field] are unaffected.
    if (value !== undefined && super.delete(key)) super.set(key, value);
    return value;
  }

  set(key, value) {
    if (super.has(key)) super.delete(key);
    super.set(key, value);
    while (this.size > this.max) {
      const oldest = super.keys().next().value;
      if (oldest === undefined) break;
      super.delete(oldest);
    }
    return this;
  }
}

const capabilityProbes = new BoundedProbeCache();

// Verified probe results are trusted for this long before a re-probe is allowed.
// Non-verified results are never cached past their in-flight resolution.
const VERIFIED_PROBE_TTL_MS = 10 * 60 * 1000;

const require = createRequire(import.meta.url);

// Resolve the package ENTRY (its "." export) then walk up to its package.json.
// We CANNOT require.resolve(`${packageName}/package.json`): @opencode-ai/plugin and
// @opencode-ai/sdk omit "./package.json" from their "exports" map, so that form throws
// ERR_PACKAGE_PATH_NOT_EXPORTED. Their "." export also declares ONLY an "import"
// condition (no "require"), so even require.resolve(packageName) throws
// ERR_PACKAGE_PATH_NOT_EXPORTED under CJS conditions — when it does, fall back to
// import.meta.resolve, which honors the "import" condition and yields the entry file.
// Resolution is anchored at THIS module's location (the plugin's own dependency tree),
// so it never depends on the monorepo root.
function resolvePackageEntry(packageName) {
  try {
    return require.resolve(packageName);
  } catch (error) {
    if (error?.code !== "ERR_PACKAGE_PATH_NOT_EXPORTED") return undefined;
    try {
      return fileURLToPath(import.meta.resolve(packageName));
    } catch {
      return undefined;
    }
  }
}

// Used by createCapabilityAdapter's worktree create/remove paths below, and by the
// live-gate probe functions in live-gate-probes.js (imported back from there).
export function unwrapClientResult(result, label) {
  if (result?.error !== undefined) {
    const error = result.error;
    throw new Error(`${label} failed: ${error?.message || error?.error || JSON.stringify(error)}`);
  }
  return result;
}

export function readInstalledVersion(packageName) {
  const entry = resolvePackageEntry(packageName);
  if (!entry) return "unavailable";
  let dir = path.dirname(entry);
  for (let i = 0; i < 12; i++) {
    const pj = path.join(dir, "package.json");
    if (existsSync(pj)) {
      try {
        const parsed = JSON.parse(readFileSync(pj, "utf8"));
        if (parsed.name === packageName) return parsed.version ?? "unavailable";
      } catch { /* keep ascending */ }
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return "unavailable";
}

function redactServerUrl(value) {
  if (!value) return "unavailable";
  try {
    const parsed = new URL(String(value));
    parsed.username = "";
    parsed.password = "";
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return "present";
  }
}

async function createCapabilityAdapter(pluginContext) {
  const forced = pluginContext.__workflowCapabilities ?? {};
  const session = pluginContext.client?.session ?? {};
  const worktreeClient = pluginContext.client?.worktree ?? pluginContext.client?.experimental?.worktree ?? {};
  const diagnostics = {
    opencodeVersion: forced.opencodeVersion ?? "not-probed",
    pluginPackageVersion: readInstalledVersion("@opencode-ai/plugin"),
    sdkPackageVersion: readInstalledVersion("@opencode-ai/sdk"),
    serverUrl: redactServerUrl(pluginContext.serverUrl),
    clientShape: {
      sessionCreate: hasFunction(session, "create"),
      sessionPrompt: hasFunction(session, "prompt"),
      sessionAbort: hasFunction(session, "abort"),
      sessionGet: hasFunction(session, "get"),
      sessionUpdate: hasFunction(session, "update"),
      sessionMessages: hasFunction(session, "messages"),
      sessionShell: hasFunction(session, "shell"),
      worktreeCreate: hasFunction(worktreeClient, "create"),
      worktreeRemove: hasFunction(worktreeClient, "remove"),
      worktreeReset: hasFunction(worktreeClient, "reset"),
      worktreeList: hasFunction(worktreeClient, "list"),
    },
  };

  const childSession = forced.childSession ?? (diagnostics.clientShape.sessionCreate && diagnostics.clientShape.sessionPrompt ? "available" : "unavailable");
  const permissions = forced.permissions ?? (diagnostics.clientShape.sessionCreate ? "available-unverified" : "unavailable");
  const structuredOutput = forced.structuredOutput ?? (diagnostics.clientShape.sessionPrompt ? "available-unverified" : "unavailable");
  const worktree = forced.worktree ?? (diagnostics.clientShape.worktreeCreate && diagnostics.clientShape.worktreeRemove ? "available-unverified" : "unavailable");
  const directoryRooting = forced.directoryRooting ?? (diagnostics.clientShape.sessionCreate ? "available-unverified" : "unavailable");
  const worktreeEditIsolation = forced.worktreeEditIsolation ?? (forced.worktree === "available" && forced.directoryRooting === "available" ? "available" : diagnostics.clientShape.worktreeCreate && diagnostics.clientShape.sessionCreate ? "available-unverified" : "unavailable");
  const toast = forced.toast ?? (hasWorkflowToast(pluginContext) ? "available" : "unavailable");

  let worktreeClientResolution;
  async function resolveWorktreeClient() {
    const injected = pluginContext.client?.worktree ?? pluginContext.client?.experimental?.worktree;
    if (injected && hasFunction(injected, "create")) return { client: injected, kind: "injected" };
    if (!worktreeClientResolution) {
      worktreeClientResolution = (async () => {
        // Production receives the v1 SDK client, which has no worktree resource. The
        // worktree API lives on the v2 client, so build one lazily against the server URL.
        try {
          if (!pluginContext.serverUrl) return undefined;
          const mod = await import("@opencode-ai/sdk/v2/client");
          const createClient = mod.createOpencodeClient ?? mod.default?.createOpencodeClient;
          if (typeof createClient !== "function") return undefined;
          const v2 = createClient({ baseUrl: new URL(String(pluginContext.serverUrl)).origin });
          return v2?.worktree && hasFunction(v2.worktree, "create") ? v2.worktree : undefined;
        } catch {
          return undefined;
        }
      })();
    }
    const v2 = await worktreeClientResolution;
    return v2 ? { client: v2, kind: "v2" } : undefined;
  }

  return {
    forced,
    diagnostics,
    capabilities: {
      childSession,
      permissions,
      structuredOutput,
      structuredOutputField: forced.structuredOutputField ?? "data.info.structured",
      worktree,
      directoryRooting,
      worktreeEditIsolation,
      backgroundContinuation: forced.backgroundContinuation ?? "available",
      toast,
      modelListing: forced.modelListing ?? "unavailable",
      agentListing: forced.agentListing ?? "unavailable",
    },
    getStructured(result) {
      const candidates = [
        // `info.structured` is the field used by the installed @opencode-ai/sdk; keep it
        // first. `info.structured_output` is accepted defensively in case a future SDK
        // renames it, so schema lanes do not silently break on upgrade.
        result?.data?.info?.structured,
        result?.data?.info?.structured_output,
        result?.data?.structured,
        result?.data?.output,
        result?.data?.result,
      ];
      return candidates.find((candidate) => candidate !== undefined);
    },
    async hasWorktreeClient() {
      return Boolean(await resolveWorktreeClient());
    },
    async createWorktree(input) {
      if (typeof forced.createWorktree === "function") return await forced.createWorktree(input);
      const resolved = await resolveWorktreeClient();
      if (!resolved) throw new Error("Native Worktree API is unavailable");
      // The real v2 client uses { directory, worktreeCreateInput }; an injected client
      // (tests / legacy) uses the { body, query } shape. Shape the call per client kind.
      const params = resolved.kind === "v2"
        ? { directory: input.directory, worktreeCreateInput: { name: input.name } }
        : { body: { name: input.name, path: input.path, branch: input.branch }, query: { directory: input.directory } };
      const result = unwrapClientResult(await resolved.client.create(params), "Worktree create");
      return result?.data ?? result;
    },
    async removeWorktree(input) {
      if (typeof forced.removeWorktree === "function") return await forced.removeWorktree(input);
      const resolved = await resolveWorktreeClient();
      if (!resolved || !hasFunction(resolved.client, "remove")) return undefined;
      const params = resolved.kind === "v2"
        ? { worktreeRemoveInput: input?.directory ? { directory: input.directory } : undefined }
        : { body: input?.body ?? (input?.id ? { id: input.id } : {}), query: input?.query };
      const result = unwrapClientResult(await resolved.client.remove(params), "Worktree remove");
      return result?.data ?? result;
    },
  };
}

// Runs (or reuses) a single capability probe under `cache[field]`. `runProbe`
// produces the probe promise; `isVerified` inspects the resolved value to decide
// whether it earns a cache slot. Non-verified results — and any thrown probe — leave
// no cached entry, so a transient failure cannot permanently block later workflows.
async function cachedProbe(cache, field, runProbe, isVerified) {
  const existing = cache[field];
  if (existing) {
    if (existing.verified) {
      if (Date.now() - existing.ts < VERIFIED_PROBE_TTL_MS) return await existing.promise;
      delete cache[field];
    } else {
      // A prior non-verified probe is still in flight; reuse it to coalesce rather
      // than firing a duplicate. It self-evicts below once it resolves.
      return await existing.promise;
    }
  }
  const entry = { verified: false, ts: Date.now(), promise: undefined };
  entry.promise = (async () => {
    try {
      const result = await runProbe();
      if (isVerified(result)) {
        entry.verified = true;
        entry.ts = Date.now();
      } else if (cache[field] === entry) {
        delete cache[field];
      }
      return result;
    } catch (error) {
      if (cache[field] === entry) delete cache[field];
      throw error;
    }
  })();
  cache[field] = entry;
  return await entry.promise;
}

// Drops cached capability probes so the next promotion / live-gate report re-probes
// from scratch. With no key, clears the whole module-level cache. Exposed through the
// workflow_live_gates tool (resetProbeCache) so an operator can recover after a
// transient probe failure without restarting OpenCode.
function invalidateCapabilityProbes(key) {
  if (key === undefined) {
    const count = capabilityProbes.size;
    capabilityProbes.clear();
    return count;
  }
  return capabilityProbes.delete(key) ? 1 : 0;
}

// Promote shape-derived "available-unverified" capabilities to verified "available" only
// via behavioral probes. Skips any capability the caller forced (tests use forced
// capabilities as explicit evidence). Runs on the approved execution path before any lane,
// so run.capabilities is settled and lane signatures stay deterministic.
async function promoteCapabilities(pluginContext, toolContext, adapter, authority, options = {}) {
  const forced = adapter.forced ?? {};
  const key = `${redactServerUrl(pluginContext.serverUrl)}:${path.resolve(toolContext.worktree || toolContext.directory || ".")}`;
  let cache = capabilityProbes.get(key);
  if (!cache) {
    cache = {};
    capabilityProbes.set(key, cache);
  }
  // Any run that can launch child lanes needs verified per-session permission
  // enforcement: read-only child lanes are contained by a deny-by-default
  // permission ruleset (see resolveLanePolicy in authority-policy.js), so the
  // runtime must prove it enforces child-session permission rules before the
  // first lane spawns. This is independent of elevated authority — a read-only
  // child-capable run needs the gate just as much as a shell/edit run. Elevated
  // authority adds the same requirement for the usual containment reasons.
  const elevated = authority.shell || authority.network || authority.mcp || authority.edit || authority.worktreeEdit || authority.integration;
  const needsPermissions = elevated || options.childLanesAllowed === true;
  const needsWorktree = authority.edit || authority.worktreeEdit || authority.integration;

  // A gate counts as a cacheable success only when it is actually verified; an
  // "available-unverified" / "blocked" / "failed" gate is transient and re-probed.
  const gateVerifiedResult = (gate) => gate?.verified === true;
  // Honor forced gates (tests, or a prior in-process verification) before
  // live-probing, consistent with liveGateReport's probeOrShape. This lets tests
  // fake the gate via pluginContext.__workflowLiveGates and avoids a redundant
  // live probe when a gate value is already known.
  const forcedGates = pluginContext.__workflowLiveGates ?? {};
  async function resolvePermissionGate() {
    const forcedValue = forcedGate(forcedGates.permissionEnforcement);
    if (forcedValue) return forcedValue;
    return await cachedProbe(cache, "permissionEnforcement", () => probeDeniedBash(pluginContext, toolContext), gateVerifiedResult);
  }

  if (forced.structuredOutput === undefined && adapter.capabilities.structuredOutput === "available-unverified") {
    adapter.capabilities.structuredOutput = await cachedProbe(
      cache,
      "structuredOutput",
      () => probeStructuredOutput(pluginContext, adapter),
      (result) => result === "available",
    );
  }
  if (needsPermissions && forced.permissions === undefined && adapter.capabilities.permissions === "available-unverified") {
    const gate = await resolvePermissionGate();
    setLiveGateDiagnostic(adapter, "permissionEnforcement", gate);
    adapter.capabilities.permissions = gateCapability(gate);
  }
  if (needsWorktree && forced.worktree === undefined && adapter.capabilities.worktree === "available-unverified") {
    const gate = await cachedProbe(cache, "worktreeApi", () => probeWorktreeGate(pluginContext, adapter), gateVerifiedResult);
    setLiveGateDiagnostic(adapter, "worktreeApi", gate);
    adapter.capabilities.worktree = gateCapability(gate);
  }
  if (needsWorktree && forced.directoryRooting === undefined && adapter.capabilities.directoryRooting === "available-unverified") {
    const gate = await cachedProbe(cache, "directoryRooting", () => probeDirectoryRootingGate(pluginContext, toolContext), gateVerifiedResult);
    setLiveGateDiagnostic(adapter, "directoryRooting", gate);
    adapter.capabilities.directoryRooting = gateCapability(gate);
  }
  if (needsWorktree && forced.worktreeEditIsolation === undefined && adapter.capabilities.worktreeEditIsolation === "available-unverified") {
    const gate = await cachedProbe(cache, "worktreeEditIsolation", () => probeWorktreeEditIsolationGate(pluginContext, toolContext, adapter), gateVerifiedResult);
    setLiveGateDiagnostic(adapter, "worktreeEditIsolation", gate);
    adapter.capabilities.worktreeEditIsolation = gateCapability(gate);
  }
}

const VERIFIED_GATE_CAPABILITY_MAP = {
  permissionEnforcement: "permissions",
  structuredOutput: "structuredOutput",
  worktreeApi: "worktree",
  directoryRooting: "directoryRooting",
  worktreeEditIsolation: "worktreeEditIsolation",
};

function promoteVerifiedGateCapabilities(adapter, gateStatus = {}) {
  for (const [gateName, capabilityName] of Object.entries(VERIFIED_GATE_CAPABILITY_MAP)) {
    if (gateStatus[gateName]?.verified === true) adapter.capabilities[capabilityName] = "available";
  }
}

// R32 (opencode-workflows-6ti): a gate that is `verified: true` but whose evidence is
// non-behavioral (currently only `in-process-smoke`) does NOT prove the target subsystem
// works. Surface it as a blocker for *required* authority gates so that adding e.g.
// backgroundContinuation to requiredGates is not auto-satisfied by a trivial event-loop
// yield. The operator can opt in per-strength via acceptWeakEvidence.
function weakEvidenceGateBlockers(gateStatus, acceptedStrengths) {
  const accepted = new Set(acceptedStrengths ?? []);
  return Object.entries(gateStatus)
    .filter(([, gate]) => gate?.verified === true
      && NON_BEHAVIORAL_EVIDENCE_STRENGTHS.has(gate?.evidenceStrength)
      && !accepted.has(gate.evidenceStrength))
    .map(([name, gate]) => `${name}=verified(${gate.evidenceStrength}) is non-behavioral and not accepted`);
}

async function verifyRequiredAuthorityGates(pluginContext, toolContext, adapter, authority, options = {}) {
  const skipped = new Set(options.skipGates ?? []);
  const required = normalizeRequiredGates((authority.requiredGates ?? []).filter((name) => !skipped.has(name)));
  if (required.length === 0) return {};
  const report = JSON.parse(await liveGateReport(pluginContext, toolContext, liveGateProbeArgsForNames(required)));
  const gateStatus = compactLiveGateStatus(report, required);
  adapter.diagnostics.liveGates = { ...(adapter.diagnostics.liveGates ?? {}), ...gateStatus };
  const blockers = [
    ...nonVerifiedGateSummaries(gateStatus),
    ...weakEvidenceGateBlockers(gateStatus, options.acceptWeakEvidence),
  ];
  if (blockers.length > 0) {
    throw new Error(`Workflow authority profile ${authority.profile || AD_HOC_AUTHORITY_PROFILE} requires verified live gates: ${blockers.join(", ")}`);
  }
  return gateStatus;
}

// Historical compatibility hook for network/MCP live-gate diagnostics. Launch-time
// enforcement for webfetch/websearch/mcp is owned by permissionRulesForAuthority
// plus the verified permissionEnforcement gate; networkAccess remains informational
// until a real behavioral probe exists. mcpAccess has an explicit opt-in live probe.
async function verifyNetworkMcpAuthorityGates() {
  return {};
}

function hasLiveGateProbeFlags(args = {}) {
  return [
    "probePermissionEnforcement",
    "probeDeniedBash",
    "probeCommandScopedBash",
    "probeSecretReadDeny",
    "probeStructuredOutput",
    "probeWorktreeApi",
    "probeDirectoryRooting",
    "probeWorktreeEditIsolation",
    "probeIntegrationWorktreeIsolation",
    "probeBackgroundContinuation",
    "probeConcurrencyCapacity",
    "probeCancellation",
    "probeWorkflowNotification",
    "probeNetworkAccess",
    "probeMcpAccess",
  ].some((key) => args[key] === true);
}

function hardConcurrencyLimitForContext(pluginContext) {
  return normalizeHardConcurrencyLimit(pluginContext?.__workflowHardConcurrencyLimit, HARD_CONCURRENCY_LIMIT);
}

function concurrencyProbeLimitForArgs(pluginContext, args = {}) {
  const hardLimit = hardConcurrencyLimitForContext(pluginContext);
  const requested = Number.isInteger(args.concurrencyProbeLimit) && args.concurrencyProbeLimit > 0
    ? args.concurrencyProbeLimit
    : Math.min(DEFAULT_CONCURRENCY_PROBE_LIMIT, hardLimit);
  return Math.max(1, Math.min(requested, hardLimit));
}

function assertLiveGateProbeAllowed(context, args = {}) {
  // resetProbeCache mutates shared module state (forces re-probing), so it is gated
  // exactly like a live probe: write-allowed context + explicit probe approvalIntent.
  if (!hasLiveGateProbeFlags(args) && args.resetProbeCache !== true) return;
  assertWriteWorkflowAllowed(context, "workflow_live_gates probes");
  if (args.approvalIntent !== "probe") {
    throw new WorkflowAuthorityError('workflow_live_gates probe flags require approvalIntent: "probe"');
  }
}

async function liveGateReport(pluginContext, context, args = {}) {
  const adapter = await createCapabilityAdapter(pluginContext);
  const forced = pluginContext.__workflowLiveGates ?? {};
  const session = sessionApi(pluginContext);
  // R14 recovery hook: invalidate any cached probe promises so a subsequent
  // promotion / probe re-runs from scratch instead of inheriting a stale transient
  // failure. Scope to this runtime's serverUrl+directory key by default; a truthy
  // non-"key" value (e.g. "all") clears the whole module cache.
  let probeCacheCleared;
  if (args.resetProbeCache === true) {
    const key = `${redactServerUrl(pluginContext.serverUrl)}:${path.resolve(context.worktree || context.directory || ".")}`;
    probeCacheCleared = args.resetProbeCacheScope === "all"
      ? { scope: "all", cleared: invalidateCapabilityProbes() }
      : { scope: "runtime", key, cleared: invalidateCapabilityProbes(key) };
  }
  async function probeOrShape(name, probeFlag, available, evidence, probe) {
    const forcedValue = forcedGate(forced[name]);
    if (forcedValue) return forcedValue;
    if (probeFlag) return await probe();
    return shapeGate(undefined, available, evidence);
  }

  const gates = {
    permissionEnforcement: await probeOrShape(
      "permissionEnforcement",
      args.probePermissionEnforcement === true || args.probeDeniedBash === true,
      adapter.capabilities.permissions !== "unavailable",
      "session.create can accept permission rules; enforcement still needs a live denial probe",
      () => probeDeniedBash(pluginContext, context),
    ),
    commandScopedBash: await probeOrShape(
      "commandScopedBash",
      args.probeCommandScopedBash === true,
      adapter.capabilities.permissions !== "unavailable",
      "permission rules can be configured; command-scoped bash denial still needs a live probe",
      () => probeCommandScopedBash(pluginContext, context),
    ),
    secretReadDeny: await probeOrShape(
      "secretReadDeny",
      args.probeSecretReadDeny === true,
      adapter.capabilities.permissions !== "unavailable",
      "read deny rules can be configured; secret-read denial still needs a live probe",
      () => probeSecretReadDeny(pluginContext, context),
    ),
    structuredOutput: await probeOrShape(
      "structuredOutput",
      args.probeStructuredOutput === true,
      adapter.capabilities.structuredOutput !== "unavailable",
      "session.prompt can accept format; schema compliance still needs a live structured-output probe",
      () => probeStructuredOutputGate(pluginContext, adapter),
    ),
    worktreeApi: await probeOrShape(
      "worktreeApi",
      args.probeWorktreeApi === true,
      adapter.capabilities.worktree !== "unavailable",
      "worktree create/remove API shape is present; isolation still needs a live worktree probe",
      () => probeWorktreeGate(pluginContext, adapter),
    ),
    directoryRooting: await probeOrShape(
      "directoryRooting",
      args.probeDirectoryRooting === true,
      adapter.capabilities.directoryRooting !== "unavailable",
      "child session directory rooting appears available; edit isolation still needs a live rooted child probe",
      () => probeDirectoryRootingGate(pluginContext, context),
    ),
    worktreeEditIsolation: await probeOrShape(
      "worktreeEditIsolation",
      args.probeWorktreeEditIsolation === true,
      adapter.capabilities.worktree !== "unavailable" && adapter.capabilities.directoryRooting !== "unavailable",
      "worktree and directory-rooting API shapes are present; edit isolation still needs a live worktree probe",
      () => probeWorktreeEditIsolationGate(pluginContext, context, adapter),
    ),
    integrationWorktreeIsolation: await probeOrShape(
      "integrationWorktreeIsolation",
      args.probeIntegrationWorktreeIsolation === true,
      adapter.capabilities.directoryRooting !== "unavailable",
      "local Git integration worktree isolation still needs a live scratch-repo probe",
      () => probeIntegrationWorktreeIsolationGate(pluginContext, context),
    ),
    backgroundContinuation: await probeOrShape(
      "backgroundContinuation",
      args.probeBackgroundContinuation === true,
      adapter.capabilities.backgroundContinuation === "available",
      "plugin can schedule background work in-process; long-run survival still needs live observation",
      () => probeBackgroundContinuationGate(),
    ),
    concurrencyCapacity: await probeOrShape(
      "concurrencyCapacity",
      args.probeConcurrencyCapacity === true,
      session.has("create") && session.has("prompt"),
      `session.create/session.prompt APIs are present; DEFAULT_CONCURRENCY remains ${DEFAULT_CONCURRENCY} until a live burst probe characterizes this runtime`,
      () => probeConcurrencyCapacityGate(pluginContext, context, { limit: concurrencyProbeLimitForArgs(pluginContext, args) }),
    ),
    cancellation: await probeOrShape(
      "cancellation",
      args.probeCancellation === true,
      session.has("abort"),
      "session.abort API shape is present; active-child cancellation still needs a live probe",
      () => probeCancellationGate(pluginContext, context),
    ),
    workflowCompletionNotification: await probeOrShape(
      "workflowCompletionNotification",
      args.probeWorkflowNotification === true,
      session.has("promptAsync"),
      "session.promptAsync API shape is present; idle-gated workflow notification delivery still needs an explicit probe",
      () => probeWorkflowNotificationGate(pluginContext, context),
    ),
    networkAccess: forcedGate(forced.networkAccess) ?? (args.probeNetworkAccess === true
      ? gateBlocked("network behavioral live-gate probe is reserved; networked authority cannot be verified by this runtime yet")
      : gateAvailableUnverified("network permission policy can allow webfetch/websearch, but no behavioral live-gate probe exists yet; networked profiles remain reserved")),
    mcpAccess: await probeOrShape(
      "mcpAccess",
      args.probeMcpAccess === true,
      adapter.capabilities.permissions !== "unavailable",
      "MCP permission rules can be configured; MCP allow/deny still needs a live probe",
      () => probeMcpAccessGate(pluginContext, context),
    ),
  };
  const configured = Object.values(gates).every((value) => value.state !== "blocked");
  const verified = Object.values(gates).every((value) => value.verified === true);
  const report = {
    configured,
    verified,
    ...(probeCacheCleared ? { probeCacheCleared } : {}),
    gates,
    diagnostics: adapter.diagnostics,
    note: "available-unverified means the API shape is present only; it is not live proof. Use explicit live probes to mark gates verified. A verified gate's evidenceStrength field distinguishes directly-observed target behavior (\"observed\") from weaker evidence: \"no-attempt-fallback\" verifies only that retained deny rules held and no successful tool call occurred (not equivalent to an observed denial); \"in-process-smoke\" verifies only in-process event-loop yield and does not exercise the OpenCode background subsystem or imply restart survival (used by background-continuation). None of the weaker strengths are equivalent to an observed denial, an observed tool result, or observed OpenCode continuation. directory-rooting verifies ONLY on a deterministic sentinel read tool result; a child that merely echoes the cwd in text is reported as available-unverified (verified=false) and does not satisfy the required directoryRooting gate.",
  };
  if (args.format === "json") return JSON.stringify(report, null, 2);
  const lines = Object.entries(gates).map(([key, value]) => `${key}: ${value.state}${value.verified ? " (verified)" : ""}`);
  if (probeCacheCleared) lines.unshift(`probe cache cleared: ${probeCacheCleared.cleared} entr${probeCacheCleared.cleared === 1 ? "y" : "ies"} (${probeCacheCleared.scope})`);
  return lines.join("\n");
}

function compactLiveGateStatus(report, names = Object.keys(report?.gates ?? {})) {
  return Object.fromEntries(names.map((name) => {
    const gate = report?.gates?.[name] ?? gateBlocked("gate missing from live-gate report");
    const summary = { state: gate.state, verified: gate.verified === true, evidence: gate.evidence };
    if (gate.evidenceStrength !== undefined) summary.evidenceStrength = gate.evidenceStrength;
    return [name, summary];
  }));
}

function gateCapability(gate) {
  if (gate?.verified === true) return "available";
  if (gate?.state === "blocked") return "unavailable";
  return "available-unverified";
}

function setLiveGateDiagnostic(adapter, name, gate) {
  adapter.diagnostics.liveGates = { ...(adapter.diagnostics.liveGates ?? {}), [name]: gate };
}

function liveGateProbeArgsForNames(names) {
  const args = { format: "json" };
  for (const name of names) {
    if (name === "permissionEnforcement") args.probePermissionEnforcement = true;
    else if (name === "commandScopedBash") args.probeCommandScopedBash = true;
    else if (name === "secretReadDeny") args.probeSecretReadDeny = true;
    else if (name === "structuredOutput") args.probeStructuredOutput = true;
    else if (name === "worktreeApi") args.probeWorktreeApi = true;
    else if (name === "directoryRooting") args.probeDirectoryRooting = true;
    else if (name === "worktreeEditIsolation") args.probeWorktreeEditIsolation = true;
    else if (name === "integrationWorktreeIsolation") args.probeIntegrationWorktreeIsolation = true;
    else if (name === "backgroundContinuation") args.probeBackgroundContinuation = true;
    else if (name === "concurrencyCapacity") args.probeConcurrencyCapacity = true;
    else if (name === "cancellation") args.probeCancellation = true;
    else if (name === "workflowCompletionNotification") args.probeWorkflowNotification = true;
    else if (name === "networkAccess") args.probeNetworkAccess = true;
    else if (name === "mcpAccess") args.probeMcpAccess = true;
  }
  return args;
}

function nonVerifiedGateSummaries(gateStatus) {
  return Object.entries(gateStatus).filter(([, gate]) => gate?.verified !== true)
    .map(([name, gate]) => `${name}=${gate?.state ?? "missing"}`);
}

export {
  NON_BEHAVIORAL_EVIDENCE_STRENGTHS,
  capabilityProbes,
  BoundedProbeCache,
  CAPABILITY_PROBE_CACHE_MAX,
  VERIFIED_PROBE_TTL_MS,
  redactServerUrl,
  createCapabilityAdapter,
  cachedProbe,
  invalidateCapabilityProbes,
  promoteCapabilities,
  promoteVerifiedGateCapabilities,
  weakEvidenceGateBlockers,
  verifyRequiredAuthorityGates,
  verifyNetworkMcpAuthorityGates,
  hasLiveGateProbeFlags,
  assertLiveGateProbeAllowed,
  liveGateReport,
  compactLiveGateStatus,
  gateCapability,
  setLiveGateDiagnostic,
  liveGateProbeArgsForNames,
  nonVerifiedGateSummaries,
};

// Re-export the gate-shape constructors (now in gate-shapes.js) and the live-gate
// probe functions + probe-only helpers (now in live-gate-probes.js) so the public
// CapabilityAdapter surface and the kernel barrel (index.js `export *`) are unchanged.
export {
  forcedGate,
  gateAvailableUnverified,
  gateBlocked,
  gateFailed,
  gateVerified,
  shapeGate,
  transportFailureGate,
} from "./gate-shapes.js";

export {
  collectTextParts,
  collectToolParts,
  createdSessionRetainedPermission,
  denialProbeResult,
  deterministicToolProbeResult,
  initScratchGitRepo,
  isDenialEvidence,
  liveProbeTimeoutMs,
  opencodeChildPermissionDenyRules,
  probeBackgroundContinuationGate,
  probeCancellationGate,
  probeCommandScopedBash,
  probeConcurrencyCapacityGate,
  probeDeniedBash,
  probeDirectoryRootingGate,
  probeIntegrationWorktreeIsolationGate,
  probeMcpAccessGate,
  probeSecretReadDeny,
  probeStructuredOutput,
  probeStructuredOutputGate,
  probeWorkflowNotificationGate,
  probeWorktree,
  probeWorktreeEditIsolationGate,
  probeWorktreeGate,
  removeGitWorktreeForce,
  sessionMessagesPayloadForProbe,
  toolPartName,
  valueContainsString,
  withLiveProbeTimeout,
} from "./live-gate-probes.js";
