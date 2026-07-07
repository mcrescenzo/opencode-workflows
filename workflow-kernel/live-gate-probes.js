// Live-gate probe functions: each `probe*` actively exercises a capability of the live
// OpenCode runtime (denied bash, secret-read isolation, directory rooting, worktree
// isolation, structured output, background continuation, cancellation, notification
// delivery) and returns a gate-shape result. The CapabilityAdapter / liveGateReport
// orchestrator in capability-adapter.js fans these out; this module owns the probes and
// their probe-only helpers. It imports gate-shape constructors from gate-shapes.js and
// otherwise depends only on leaf runtime modules, so it does not import capability-adapter.js
// back (capability-adapter.js imports this module, not the reverse).
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { setImmediate as immediatePromise } from "node:timers/promises";
import { promisify } from "node:util";
import {
  DEFAULT_CONCURRENCY_PROBE_LIMIT,
  DEFAULT_LIVE_PROBE_TIMEOUT_MS,
  DEFAULT_SUBPROCESS_MAX_BUFFER,
  DEFAULT_SUBPROCESS_TIMEOUT_MS,
  MAX_STATUS_STRING_CHARS,
} from "./constants.js";
import { extractTextFromError, textPart, truncateText } from "./text-json.js";
import { WorkflowProbeStructuralError } from "./errors.js";
import { structuredFormat } from "./structured-output.js";
import { OPENCODE_CHILD_PERMISSION_KEYS, permissionRulesForAuthority } from "./authority-policy.js";
import { pathExists, readJsonFile, writeJsonAtomic } from "./run-store-status.js";
import { sessionApi } from "./session-access.js";
import { withTimeout } from "./async-util.js";
import {
  NOTIFICATION_STATE_VERSION,
  abortChild,
  deliverWorkflowNotifications,
  pendingNotificationPaths,
} from "./lifecycle-control.js";
import { createWorktreeAdapter } from "./worktree-adapter.js";
import { changedPathsSinceBase } from "./integration-mode.js";
import {
  gateAvailableUnverified,
  gateBlocked,
  gateFailed,
  gateVerified,
  transportFailureGate,
} from "./gate-shapes.js";

const execFileAsync = promisify(execFile);

function liveProbeTimeoutMs(pluginContext) {
  return Number.isFinite(pluginContext.__workflowLiveProbeTimeoutMs) && pluginContext.__workflowLiveProbeTimeoutMs > 0
    ? pluginContext.__workflowLiveProbeTimeoutMs
    : DEFAULT_LIVE_PROBE_TIMEOUT_MS;
}

async function withLiveProbeTimeout(pluginContext, label, factory, onTimeout) {
  return await withTimeout(factory, {
    timeoutMs: liveProbeTimeoutMs(pluginContext),
    label,
    onTimeout,
  });
}

function toolPartName(part) {
  return String(part?.tool || part?.name || "");
}

function toolPartEvidence(part) {
  return [
    toolPartName(part),
    part?.state?.status,
    part?.state?.error,
    part?.state?.input,
    part?.state?.content,
    part?.state?.structured,
  ].map((item) => typeof item === "string" ? item : item === undefined ? "" : JSON.stringify(item)).filter(Boolean).join(" ");
}

function toolPartDenied(part) {
  return part?.state?.status === "error" && isDenialEvidence(toolPartEvidence(part));
}

function isDenialEvidence(error) {
  return /permission|denied|deny|not allowed|forbidden|unavailable/i.test(extractTextFromError(error));
}

function denialProbeResult(error, label) {
  const transport = transportFailureGate(error, label);
  if (transport) return transport;
  const evidence = extractTextFromError(error);
  if (isDenialEvidence(error)) return gateVerified(`${label} was rejected: ${truncateText(evidence, MAX_STATUS_STRING_CHARS)}`);
  return gateFailed(`${label} failed without denial evidence: ${truncateText(evidence, MAX_STATUS_STRING_CHARS)}`);
}

function unwrapClientResult(result, label) {
  if (result?.error !== undefined) {
    const error = result.error;
    throw new Error(`${label} failed: ${error?.message || error?.error || JSON.stringify(error)}`);
  }
  return result;
}

function valueContainsString(value, needle, seen = new Set()) {
  if (!needle) return false;
  if (typeof value === "string") return value.includes(needle);
  if (!value || typeof value !== "object") return false;
  if (seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) return value.some((item) => valueContainsString(item, needle, seen));
  return Object.values(value).some((item) => valueContainsString(item, needle, seen));
}

function createdSessionRetainedPermission(created, expectedRules) {
  const retained = created?.data?.permission ?? created?.permission;
  if (!Array.isArray(retained)) return false;
  return expectedRules.every((rule) => retained.some((item) => item?.permission === rule.permission && item?.pattern === rule.pattern && item?.action === rule.action));
}

function deterministicToolProbeResult({ label, toolNames, directAllowed, toolParts, denialText = "", noAttemptEvidence = "" }) {
  if (directAllowed) return gateFailed(`${label} command completed; permission denial was not enforced`);
  const names = new Set(toolNames.map((name) => name.toLowerCase()));
  const matching = toolParts.filter((part) => names.has(toolPartName(part).toLowerCase()));
  if (matching.some(toolPartDenied)) {
    return gateVerified(`${label} observed denied ${[...names].join("/")} tool evidence`);
  }
  if (matching.length > 0) {
    return gateFailed(`${label} observed ${matching.map(toolPartName).join(", ")} tool attempt without denial evidence`);
  }
  if (isDenialEvidence(denialText)) {
    return gateVerified(`${label} observed denial text without an exposed ${[...names].join("/")} tool part: ${truncateText(denialText, MAX_STATUS_STRING_CHARS)}`);
  }
  if (noAttemptEvidence) return gateVerified(noAttemptEvidence, "no-attempt-fallback");
  return gateBlocked(`${label} completed without an observable ${[...names].join("/")} tool attempt; deterministic permission evidence is unavailable`);
}

function deterministicAllowedToolResult({ label, toolNames, toolParts, expectedText = "" }) {
  const names = new Set(toolNames.map((name) => name.toLowerCase()));
  const matching = toolParts.filter((part) => names.has(toolPartName(part).toLowerCase()));
  if (matching.some((part) => part?.state?.status === "completed" && (!expectedText || toolPartEvidence(part).includes(expectedText)))) {
    return gateVerified(`${label} observed allowed ${[...names].join("/")} tool completion`);
  }
  if (matching.some(toolPartDenied)) return gateFailed(`${label} was denied; allow rule was not enforced`);
  if (matching.length > 0) return gateFailed(`${label} observed ${matching.map(toolPartName).join(", ")} without completed allowed evidence`);
  return gateBlocked(`${label} completed without an observable ${[...names].join("/")} tool attempt; deterministic allow evidence is unavailable`);
}

function secretReadClassCoverageResult({ toolParts, denialText, sentinelContent }) {
  const required = ["read", "grep", "glob", "list"];
  const missing = [];
  for (const toolName of required) {
    const matching = toolParts.filter((part) => toolPartName(part).toLowerCase() === toolName);
    if (matching.some((part) => valueContainsString(part, sentinelContent))) {
      return gateFailed(`secret-read isolation probe observed sentinel secret content in ${toolName} output; permission denial was not enforced`);
    }
    if (matching.some(toolPartDenied)) continue;
    if (new RegExp(`${toolName}[^\n]*(permission|denied|deny|not allowed|forbidden|unavailable)`, "i").test(denialText)) continue;
    missing.push(toolName);
  }
  const lspMatching = toolParts.filter((part) => toolPartName(part).toLowerCase() === "lsp");
  const lspDenied = lspMatching.some(toolPartDenied) || /lsp[^\n]*(permission|denied|deny|not allowed|forbidden|unavailable|unsupported|not exposed)/i.test(denialText);
  if (missing.length === 0) {
    const lspEvidence = lspDenied ? "; lsp denied or explicitly unsupported" : "; lsp coverage unsupported/not observed";
    return gateVerified(`secret-read isolation probe observed denial coverage for read/grep/glob/list${lspEvidence}`);
  }
  return gateBlocked(`secret-read isolation probe lacked deterministic denial evidence for ${missing.join(", ")}; lsp ${lspDenied ? "denied/unsupported" : "unsupported/not observed"}`);
}

async function sessionMessagesPayloadForProbe(pluginContext, childID, directory) {
  const session = sessionApi(pluginContext);
  if (!session.has("messages")) return [];
  const result = await withLiveProbeTimeout(pluginContext, "permission probe message list", () => session.messages({ sessionID: childID, directory, limit: 20 }));
  return unwrapClientResult(result, "Permission probe message list");
}

async function initScratchGitRepo(directory) {
  const execOptions = { cwd: directory, encoding: "utf8", timeout: DEFAULT_SUBPROCESS_TIMEOUT_MS, maxBuffer: DEFAULT_SUBPROCESS_MAX_BUFFER };
  await execFileAsync("git", ["init"], execOptions);
  await execFileAsync("git", ["config", "user.email", "workflow-probe@example.com"], execOptions);
  await execFileAsync("git", ["config", "user.name", "Workflow Probe"], execOptions);
  await fs.writeFile(path.join(directory, "README.md"), "workflow probe\n", "utf8");
  await execFileAsync("git", ["add", "README.md"], execOptions);
  await execFileAsync("git", ["commit", "-m", "initial"], execOptions);
}

async function removeGitWorktreeForce(root, worktreePath) {
  if (!root || !worktreePath) return;
  try {
    await execFileAsync("git", ["worktree", "remove", "--force", worktreePath], { cwd: root, encoding: "utf8", timeout: DEFAULT_SUBPROCESS_TIMEOUT_MS, maxBuffer: DEFAULT_SUBPROCESS_MAX_BUFFER });
  } catch {
    // Probe cleanup is best effort.
  }
}

function collectTextParts(value, parts = []) {
  if (!value) return parts;
  if (Array.isArray(value)) {
    for (const item of value) collectTextParts(item, parts);
    return parts;
  }
  if (typeof value !== "object") return parts;
  if (value.type === "text" && typeof value.text === "string") parts.push(value.text);
  if (Array.isArray(value.parts)) collectTextParts(value.parts, parts);
  if (Array.isArray(value.content)) collectTextParts(value.content, parts);
  if (value.data) collectTextParts(value.data, parts);
  return parts;
}

function collectToolParts(value, parts = []) {
  if (!value) return parts;
  if (Array.isArray(value)) {
    for (const item of value) collectToolParts(item, parts);
    return parts;
  }
  if (typeof value !== "object") return parts;
  if (value.type === "tool") parts.push(value);
  if (Array.isArray(value.parts)) collectToolParts(value.parts, parts);
  if (Array.isArray(value.content)) collectToolParts(value.content, parts);
  if (value.data) collectToolParts(value.data, parts);
  return parts;
}

function opencodeChildPermissionDenyRules() {
  return OPENCODE_CHILD_PERMISSION_KEYS.map((permission) => ({ permission, pattern: "*", action: "deny" }));
}

// Tiny structured-output round-trip: confirms the runtime actually returns structured
// data for a `format` request. Promotes only on a real structured response; otherwise
// leaves the capability unverified so schema lanes stay fail-closed (status quo).
async function probeStructuredOutput(pluginContext, adapter, options = {}) {
  const session = sessionApi(pluginContext);
  if (!session.has("create") || !session.has("prompt")) return "unavailable";
  let childID;
  try {
    const created = unwrapClientResult(await withLiveProbeTimeout(pluginContext, "structured-output probe session create", () => session.create({
      title: "workflow capability probe",
      directory: pluginContext.directory,
      // Test under the SAME deny-by-default permission rules that actual workflow schema
      // lanes use. Without this, the probe gives a false positive: StructuredOutput is
      // visible in unrestricted sessions but hidden when `*` deny rules are enforced.
      permission: permissionRulesForAuthority({ readOnly: true }),
    })), "probe session create");
    childID = created?.data?.id;
    if (!childID) return "available-unverified";
    const schema = { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"], additionalProperties: false };
    const result = unwrapClientResult(await withLiveProbeTimeout(pluginContext, "structured-output probe prompt", () => session.prompt({
      sessionID: childID,
      directory: pluginContext.directory,
      body: { system: "Reply only with the requested JSON object.", format: structuredFormat(schema), parts: [textPart('Return {"ok": true}')] },
    }), () => abortChild(pluginContext, childID, pluginContext.directory)), "probe prompt");
    const structured = adapter.getStructured(result);
    return structured && typeof structured === "object" ? "available" : "available-unverified";
  } catch (error) {
    if (options.returnError) return { error };
    return "available-unverified";
  } finally {
    await abortChild(pluginContext, childID, pluginContext.directory);
  }
}

// Live create+remove of a throwaway worktree via the (v2) worktree client.
async function probeWorktree(pluginContext, adapter) {
  try {
    if (!(await adapter.hasWorktreeClient())) return { worktree: "unavailable" };
    const created = await adapter.createWorktree({ name: "workflow-capability-probe", directory: pluginContext.directory });
    const dir = created?.path || created?.directory || created?.dir;
    try { await adapter.removeWorktree({ directory: dir, id: created?.id }); } catch (error) {
      return { worktree: "available-unverified", directoryRooting: "available-unverified", cleanupError: error, directory: dir };
    }
    return { worktree: "available", directoryRooting: "available" };
  } catch {
    return { worktree: "available-unverified" };
  }
}

async function probeDeniedBash(pluginContext, context) {
  const session = sessionApi(pluginContext);
  if (!session.has("create") || !session.has("prompt")) {
    return gateBlocked("session.create/session.prompt are unavailable for a live blocked-bash prompt-path probe");
  }

  const directory = context.directory || context.worktree;
  let childID;
  try {
    const permission = [
      { permission: "*", pattern: "*", action: "deny" },
      { permission: "read", pattern: "*", action: "allow" },
      { permission: "bash", pattern: "*", action: "deny" },
      ...opencodeChildPermissionDenyRules(),
    ];
    const created = unwrapClientResult(await withLiveProbeTimeout(pluginContext, "blocked-bash probe session create", () => session.create({
      parentID: context.sessionID,
      title: "workflow live blocked-bash probe",
      permission,
      directory,
    })), "Blocked-bash live probe session creation");
    childID = created?.data?.id;
    if (!childID) throw new WorkflowProbeStructuralError("OpenCode returned no child session id for the blocked-bash probe");
    if (!createdSessionRetainedPermission(created, permission)) {
      return gateBlocked("blocked-bash live probe could not verify that child session retained permission rules; active session API may not support per-session permissions");
    }

    const result = unwrapClientResult(await withLiveProbeTimeout(pluginContext, "blocked-bash probe prompt", () => session.prompt({
      sessionID: childID,
      directory,
      body: {
        parts: [textPart("Use the bash tool to run exactly `pwd`. Do not answer from memory; report the tool result or rejection briefly.")],
      },
    }), () => abortChild(pluginContext, childID, directory)), "Blocked-bash live probe prompt");
    const messagePayload = await sessionMessagesPayloadForProbe(pluginContext, childID, directory);
    const toolParts = [...collectToolParts(result), ...collectToolParts(messagePayload)];
    const denialText = [...collectTextParts(result), ...collectTextParts(messagePayload)].join("\n");
    return deterministicToolProbeResult({
      label: "blocked-bash live probe",
      toolNames: ["bash", "oc_shell"],
      directAllowed: false,
      toolParts,
      denialText,
      noAttemptEvidence: "blocked-bash live probe verified retained bash block rules and observed no successful bash tool part; blocked tool appears hidden/unavailable",
    });
  } catch (error) {
    return denialProbeResult(error, "blocked-bash live probe");
  } finally {
    if (childID && session.has("abort")) {
      try {
        await withLiveProbeTimeout(pluginContext, "blocked-bash probe abort", () => session.abort({ sessionID: childID, directory }));
      } catch {
        // Probe cleanup is best effort.
      }
    }
  }
}

async function probeCommandScopedBash(pluginContext, context) {
  const session = sessionApi(pluginContext);
  if (!session.has("create") || !session.has("prompt")) {
    return gateBlocked("session.create/session.prompt are unavailable for a command-scoped bash prompt-path probe");
  }

  const directory = context.directory || context.worktree;
  let childID;
  try {
    const permission = [
      { permission: "*", pattern: "*", action: "deny" },
      { permission: "read", pattern: "*", action: "allow" },
      { permission: "bash", pattern: "*", action: "allow" },
      { permission: "bash", pattern: "pwd", action: "deny" },
      ...opencodeChildPermissionDenyRules(),
    ];
    const created = unwrapClientResult(await withLiveProbeTimeout(pluginContext, "command-scoped bash probe session create", () => session.create({
      parentID: context.sessionID,
      title: "workflow command-scoped bash probe",
      permission,
      directory,
    })), "Command-scoped bash probe session creation");
    childID = created?.data?.id;
    if (!childID) throw new WorkflowProbeStructuralError("OpenCode returned no child session id for the command-scoped bash probe");
    if (!createdSessionRetainedPermission(created, permission)) {
      return gateBlocked("command-scoped bash probe could not verify that child session retained permission rules; active session API may not support per-session permissions");
    }

    const allowSentinel = "workflow-bash-allow-probe";
    const allowedResult = unwrapClientResult(await withLiveProbeTimeout(pluginContext, "command-scoped bash allow probe prompt", () => session.prompt({
      sessionID: childID,
      directory,
      body: {
        parts: [textPart(`Use the bash tool to run exactly \`printf ${allowSentinel}\`. Do not answer from memory; report the tool result briefly.`)],
      },
    }), () => abortChild(pluginContext, childID, directory)), "Command-scoped bash allow probe prompt");
    const allowedMessages = await sessionMessagesPayloadForProbe(pluginContext, childID, directory);
    const allowedToolParts = [...collectToolParts(allowedResult), ...collectToolParts(allowedMessages)];
    const allowedGate = deterministicAllowedToolResult({ label: "command-scoped bash allow probe", toolNames: ["bash", "oc_shell"], toolParts: allowedToolParts, expectedText: allowSentinel });
    if (allowedGate.verified !== true) return allowedGate;

    const result = unwrapClientResult(await withLiveProbeTimeout(pluginContext, "command-scoped bash deny probe prompt", () => session.prompt({
      sessionID: childID,
      directory,
      body: {
        parts: [textPart("Use the bash tool to run exactly `pwd`. Do not answer from memory; report the tool result or denial briefly.")],
      },
    }), () => abortChild(pluginContext, childID, directory)), "Command-scoped bash deny probe prompt");
    const messagePayload = await sessionMessagesPayloadForProbe(pluginContext, childID, directory);
    const toolParts = [...collectToolParts(result), ...collectToolParts(messagePayload)];
    const denialText = [...collectTextParts(result), ...collectTextParts(messagePayload)].join("\n");
    const deniedGate = deterministicToolProbeResult({ label: "command-scoped bash deny probe", toolNames: ["bash", "oc_shell"], directAllowed: false, toolParts, denialText });
    if (deniedGate.verified !== true) return deniedGate;
    return gateVerified("command-scoped bash probe observed one allowed command and one denied command");
  } catch (error) {
    return denialProbeResult(error, "command-scoped bash probe");
  } finally {
    if (childID && session.has("abort")) {
      try { await withLiveProbeTimeout(pluginContext, "command-scoped bash probe abort", () => session.abort({ sessionID: childID, directory })); } catch {
        // Probe cleanup is best effort.
      }
    }
  }
}

async function probeMcpAccessGate(pluginContext, context) {
  const session = sessionApi(pluginContext);
  if (!session.has("create") || !session.has("prompt")) {
    return gateBlocked("session.create/session.prompt are unavailable for an MCP access prompt-path probe");
  }

  const directory = context.directory || context.worktree;
  const allowPattern = "workflow-mcp-allow-probe";
  const denyPattern = "workflow-mcp-deny-probe";
  const allowToolNames = ["mcp", "mcp__workflow_mcp_allow_probe", "mcp__workflow-mcp-allow-probe", allowPattern];
  const denyToolNames = ["mcp", "mcp__workflow_mcp_deny_probe", "mcp__workflow-mcp-deny-probe", denyPattern];
  let childID;
  let phase = "setup";
  try {
    const permission = [
      { permission: "*", pattern: "*", action: "deny" },
      { permission: "read", pattern: "*", action: "allow" },
      { permission: "mcp", pattern: allowPattern, action: "allow" },
      { permission: "mcp", pattern: `mcp__${allowPattern.replaceAll("-", "_")}`, action: "allow" },
      { permission: "mcp", pattern: denyPattern, action: "deny" },
      { permission: "mcp", pattern: `mcp__${denyPattern.replaceAll("-", "_")}`, action: "deny" },
      ...opencodeChildPermissionDenyRules(),
    ];
    const created = unwrapClientResult(await withLiveProbeTimeout(pluginContext, "MCP access probe session create", () => session.create({
      parentID: context.sessionID,
      title: "workflow MCP access probe",
      permission,
      directory,
    })), "MCP access probe session creation");
    childID = created?.data?.id;
    if (!childID) throw new WorkflowProbeStructuralError("OpenCode returned no child session id for the MCP access probe");
    if (!createdSessionRetainedPermission(created, permission)) {
      return gateBlocked("MCP access probe could not verify that child session retained permission rules; active session API may not support per-session permissions");
    }

    phase = "allow";
    const allowedResult = unwrapClientResult(await withLiveProbeTimeout(pluginContext, "MCP access allow probe prompt", () => session.prompt({
      sessionID: childID,
      directory,
      body: {
        parts: [textPart(`Use an MCP tool from the ${allowPattern} probe server/tool, then report the exact tool result text ${allowPattern}. Do not answer from memory; if the tool is unavailable, report the tool rejection briefly.`)],
      },
    }), () => abortChild(pluginContext, childID, directory)), "MCP access allow probe prompt");
    const allowedMessages = await sessionMessagesPayloadForProbe(pluginContext, childID, directory);
    const allowedToolParts = [...collectToolParts(allowedResult), ...collectToolParts(allowedMessages)];
    const allowedGate = deterministicAllowedToolResult({
      label: "MCP access allow probe",
      toolNames: allowToolNames,
      toolParts: allowedToolParts,
      expectedText: allowPattern,
    });
    if (allowedGate.verified !== true) return allowedGate;

    phase = "deny";
    const deniedResult = unwrapClientResult(await withLiveProbeTimeout(pluginContext, "MCP access deny probe prompt", () => session.prompt({
      sessionID: childID,
      directory,
      body: {
        parts: [textPart(`Use an MCP tool from the ${denyPattern} probe server/tool. Do not answer from memory; report the tool result or denial briefly.`)],
      },
    }), () => abortChild(pluginContext, childID, directory)), "MCP access deny probe prompt");
    const deniedMessages = await sessionMessagesPayloadForProbe(pluginContext, childID, directory);
    const deniedToolParts = [...collectToolParts(deniedResult), ...collectToolParts(deniedMessages)];
    const denialText = [...collectTextParts(deniedResult), ...collectTextParts(deniedMessages)].join("\n");
    const deniedGate = deterministicToolProbeResult({
      label: "MCP access deny probe",
      toolNames: denyToolNames,
      directAllowed: false,
      toolParts: deniedToolParts,
      denialText,
    });
    if (deniedGate.verified !== true) return deniedGate;
    return gateVerified("MCP access probe observed one allowed MCP tool completion and one denied MCP tool attempt");
  } catch (error) {
    if (phase === "deny") return denialProbeResult(error, "MCP access probe");
    const transport = transportFailureGate(error, "MCP access probe");
    if (transport) return transport;
    return gateFailed(`MCP access probe failed before denied tool verification: ${truncateText(extractTextFromError(error), MAX_STATUS_STRING_CHARS)}`);
  } finally {
    if (childID && session.has("abort")) {
      try { await withLiveProbeTimeout(pluginContext, "MCP access probe abort", () => session.abort({ sessionID: childID, directory })); } catch {
        // Probe cleanup is best effort.
      }
    }
  }
}

async function probeSecretReadDeny(pluginContext, context) {
  const session = sessionApi(pluginContext);
  if (!session.has("create") || !session.has("prompt")) {
    return gateBlocked("session.create/session.prompt are unavailable for a secret-read isolation probe");
  }

  const directory = context.directory || context.worktree;
  const sentinelPath = path.join(directory, "__workflow_secret_read_probe__");
  const sentinelName = path.basename(sentinelPath);
  const sentinelContent = `workflow-secret-probe-${crypto.randomUUID()}`;
  let childID;
  let wroteSentinel = false;
  try {
    await fs.writeFile(sentinelPath, `${sentinelContent}\n`, { encoding: "utf8", flag: "wx" });
    wroteSentinel = true;
    const permission = [
      { permission: "*", pattern: "*", action: "deny" },
      ...["read", "grep", "glob", "list", "lsp"].flatMap((permissionName) => [
        { permission: permissionName, pattern: "*", action: "allow" },
        { permission: permissionName, pattern: sentinelPath, action: "deny" },
        { permission: permissionName, pattern: sentinelName, action: "deny" },
        { permission: permissionName, pattern: `**/${sentinelName}`, action: "deny" },
      ]),
    ];
    const created = unwrapClientResult(await withLiveProbeTimeout(pluginContext, "secret-read isolation probe session create", () => session.create({
      parentID: context.sessionID,
      title: "workflow secret-read isolation probe",
      permission,
      directory,
    })), "Secret-read isolation probe session creation");
    childID = created?.data?.id;
    if (!childID) throw new WorkflowProbeStructuralError("OpenCode returned no child session id for the secret-read isolation probe");
    if (!createdSessionRetainedPermission(created, permission)) {
      return gateBlocked("secret-read isolation probe could not verify that child session retained permission rules; active session API may not support per-session permissions");
    }

    const result = unwrapClientResult(await withLiveProbeTimeout(pluginContext, "secret-read isolation probe prompt", () => session.prompt({
      sessionID: childID,
      directory,
        body: { parts: [textPart(`Attempt secret-denial checks against ${sentinelPath}: use read, grep, glob, and list on the sentinel path/name, and use lsp if that tool is exposed. Report each tool as denied or unavailable; do not include file contents if any access succeeds.`)] },
    }), () => abortChild(pluginContext, childID, directory)), "Secret-read isolation probe prompt");
    const messagePayload = await sessionMessagesPayloadForProbe(pluginContext, childID, directory);
    if (valueContainsString(result, sentinelContent) || valueContainsString(messagePayload, sentinelContent)) {
      return gateFailed("secret-read isolation probe observed sentinel secret content in prompt-path output; permission denial was not enforced");
    }
    const toolParts = [...collectToolParts(result), ...collectToolParts(messagePayload)];
    const denialText = [...collectTextParts(result), ...collectTextParts(messagePayload)].join("\n");
    return secretReadClassCoverageResult({ toolParts, denialText, sentinelContent });
  } catch (error) {
    if (valueContainsString(error, sentinelContent) || extractTextFromError(error).includes(sentinelContent)) {
      return gateFailed("secret-read isolation probe error exposed sentinel secret content; permission denial was not enforced");
    }
    return denialProbeResult(error, "secret-read isolation probe");
  } finally {
    if (childID && session.has("abort")) {
      try { await withLiveProbeTimeout(pluginContext, "secret-read isolation probe abort", () => session.abort({ sessionID: childID, directory })); } catch {
        // Probe cleanup is best effort.
      }
    }
    try { if (wroteSentinel) await fs.rm(sentinelPath, { force: true }); } catch {
      // Probe sentinel cleanup is best effort.
    }
  }
}

async function probeStructuredOutputGate(pluginContext, adapter) {
  const result = await probeStructuredOutput(pluginContext, adapter, { returnError: true });
  if (result?.error) return gateFailed(`structured-output probe failed: ${truncateText(extractTextFromError(result.error), MAX_STATUS_STRING_CHARS)}`);
  if (result === "available") return gateVerified("structured-output live probe returned schema-shaped data");
  if (result === "unavailable") return gateBlocked("session.prompt is unavailable for structured-output probe");
  return gateFailed("structured-output probe ran but did not return structured data");
}

async function probeWorktreeGate(pluginContext, adapter) {
  const result = await probeWorktree(pluginContext, adapter);
  if (result?.worktree === "available") return gateVerified("worktree create/remove live probe completed");
  if (result?.worktree === "unavailable") return gateBlocked("worktree create/remove API is unavailable");
  if (result?.cleanupError) {
    const where = result.directory ? ` at ${truncateText(result.directory, MAX_STATUS_STRING_CHARS)}` : "";
    return gateFailed(`worktree create/remove probe created a worktree${where}, but cleanup failed: ${truncateText(extractTextFromError(result.cleanupError), MAX_STATUS_STRING_CHARS)}`);
  }
  return gateFailed("worktree create/remove probe did not produce verified evidence");
}

async function probeDirectoryRootingGate(pluginContext, context) {
  const session = sessionApi(pluginContext);
  if (!session.has("create") || !session.has("prompt")) {
    return gateBlocked("session.create/session.prompt are unavailable for a directory-rooting probe");
  }
  const directory = context.directory || context.worktree;
  if (!directory) return gateBlocked("directory-rooting probe requires a target directory in context");
  const sentinelName = `__workflow_dir_root_probe__${crypto.randomUUID()}`;
  const sentinelPath = path.join(directory, sentinelName);
  const sentinelContent = `workflow-dir-root-probe:${crypto.randomUUID()}`;
  let childID;
  let wroteSentinel = false;
  try {
    await fs.writeFile(sentinelPath, sentinelContent, { encoding: "utf8", flag: "wx" });
    wroteSentinel = true;
    const created = unwrapClientResult(await withLiveProbeTimeout(pluginContext, "directory-rooting probe session create", () => session.create({ parentID: context.sessionID, title: "workflow directory-rooting probe", directory })), "Directory-rooting probe session creation");
    childID = created?.data?.id;
    if (!childID) throw new Error("OpenCode did not return a child session id for directory-rooting probe");
    const result = await withLiveProbeTimeout(pluginContext, "directory-rooting probe prompt", () => session.prompt({ sessionID: childID, directory, body: { parts: [textPart(`Use the read tool to read the relative path \`${sentinelName}\` and reply with its exact content.`)] } }), () => abortChild(pluginContext, childID, directory));
    const messagePayload = await sessionMessagesPayloadForProbe(pluginContext, childID, directory);
    const toolParts = [...collectToolParts(result), ...collectToolParts(messagePayload)].filter((part) => toolPartName(part).toLowerCase() === "read");
    const observed = toolParts.some((part) => {
      if (part?.state?.status !== "completed") return false;
      const inputPath = String(part?.state?.input?.filePath ?? part?.state?.input?.path ?? "");
      const content = String(part?.state?.content ?? "");
      return (inputPath === sentinelName || inputPath === sentinelPath || inputPath === `./${sentinelName}`)
        && content.includes(sentinelContent);
    });
    if (observed) {
      return gateVerified(`directory-rooting probe observed completed read of sentinel ${sentinelName} returning unique content under ${directory}`);
    }
    // R31 (opencode-workflows-8w8): model-reported cwd text is NOT verification.
    // A child can echo the target directory in plain text without ever rooting there
    // (e.g. it parrots the path from the prompt). Only the deterministic sentinel read
    // above — a completed `read` tool part returning unique on-disk content under the
    // expected directory — proves the child session is actually rooted. Text-only echo
    // is therefore reported as available-unverified (verified=false), which maps to the
    // "available-unverified" capability and does NOT satisfy the required directoryRooting
    // authority gate. Previously this returned gateVerified(..., "model-text-only"), which
    // fail-open verified the required gate on a model echo alone.
    const text = [...collectTextParts(result), ...collectTextParts(messagePayload)].join("\n").trim();
    if (text.includes(directory)) {
      return gateAvailableUnverified(
        `directory-rooting probe observed only model-reported cwd text matching ${directory}; no deterministic read tool evidence under the expected directory, so rooting is unverified`,
      );
    }
    return gateFailed(`directory-rooting probe observed neither a completed sentinel read nor matching cwd text; response=${truncateText(text || JSON.stringify(result?.data ?? {}), MAX_STATUS_STRING_CHARS)}`);
  } catch (error) {
    return gateFailed(`directory-rooting probe failed: ${truncateText(extractTextFromError(error), MAX_STATUS_STRING_CHARS)}`);
  } finally {
    if (childID && session.has("abort")) {
      try { await withLiveProbeTimeout(pluginContext, "directory-rooting probe abort", () => session.abort({ sessionID: childID, directory })); } catch {
        // Probe cleanup is best effort.
      }
    }
    if (wroteSentinel) {
      try { await fs.rm(sentinelPath, { force: true }); } catch {
        // Probe cleanup is best effort.
      }
    }
  }
}

async function probeWorktreeEditIsolationGate(pluginContext, context, adapter) {
  try {
    if (!(await adapter.hasWorktreeClient())) return gateBlocked("worktree API is unavailable for edit-isolation probe");
    const primary = path.resolve(context.worktree || context.directory);
    const created = await adapter.createWorktree({ name: "workflow-edit-isolation-probe", directory: primary });
    const rawPath = created?.path || created?.directory || created?.dir;
    // Validate the RAW extracted path before resolving. resolve('') falls back to the
    // process cwd (truthy and typically != primary), which would falsely verify isolation
    // when the worktree API omits all path fields. Mirror normalizeCreatedWorktree, which
    // only resolves once it has a concrete path to resolve.
    if (!rawPath) {
      try { await adapter.removeWorktree({ id: created?.id }); } catch {
        // Probe cleanup is best effort.
      }
      return gateFailed("worktree edit-isolation probe did not produce a worktree path");
    }
    const dir = path.resolve(rawPath);
    try { await adapter.removeWorktree({ directory: dir, id: created?.id }); } catch {
      // Probe cleanup is best effort.
    }
    if (dir !== primary) return gateVerified(`worktree edit-isolation probe created distinct worktree ${dir}`);
    return gateFailed("worktree edit-isolation probe did not produce a distinct worktree path");
  } catch (error) {
    return gateFailed(`worktree edit-isolation probe failed: ${truncateText(extractTextFromError(error), MAX_STATUS_STRING_CHARS)}`);
  }
}

async function probeIntegrationWorktreeIsolationGate(pluginContext, context, options = {}) {
  const session = sessionApi(pluginContext);
  if (!session.has("create") || !session.has("prompt")) {
    return gateBlocked("session.create/session.prompt are unavailable for an integration-worktree rooting probe");
  }

  const tempRoot = options.primaryDirectory ? undefined : await fs.mkdtemp(path.join("/tmp", "workflow-integration-worktree-probe-"));
  const primary = path.resolve(options.primaryDirectory || path.join(tempRoot, "primary"));
  const worktreeRoot = path.resolve(options.worktreeRoot || path.join(tempRoot || path.dirname(primary), "worktrees"));
  let childID;
  let cleanWorktree;
  let dirtyWorktree;
  let adapter;
  let rootingSentinelPath;
  try {
    if (!options.primaryDirectory) {
      await fs.mkdir(primary, { recursive: true });
      await initScratchGitRepo(primary);
    }
    const baseCommit = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: primary, encoding: "utf8", timeout: DEFAULT_SUBPROCESS_TIMEOUT_MS, maxBuffer: DEFAULT_SUBPROCESS_MAX_BUFFER })).stdout.trim();
    adapter = await createWorktreeAdapter({ directory: primary, worktreeRoot });

    cleanWorktree = await adapter.createIntegrationWorktree({ runId: "live-gate-probe-clean", branch: "workflow/live-gate-probe/clean" });
    const cleanPath = path.resolve(cleanWorktree.path);
    if (cleanPath === primary) return gateFailed("integration-worktree probe created the primary worktree path");

    const created = unwrapClientResult(await withLiveProbeTimeout(pluginContext, "integration-worktree probe session create", () => session.create({ parentID: context.sessionID, title: "workflow integration-worktree rooting probe", directory: cleanPath })), "Integration-worktree rooting probe session creation");
    childID = created?.data?.id;
    if (!childID) throw new Error("OpenCode did not return a child session id for integration-worktree rooting probe");
    // Tool-observed child-rooting proof (mirrors probeDirectoryRootingGate / R31). The
    // integration gate's prior check asked the child to "reply with the current working
    // directory" and accepted a model-text echo of cleanPath. A child can parrot cleanPath
    // (it is passed to session.create/prompt) without ever rooting there, so model text is
    // not verification. Instead write a unique-content sentinel under cleanPath and require a
    // completed `read` tool part returning that content; a text-only echo downgrades to
    // available-unverified (verified=false), matching the directoryRooting gate's discipline.
    const rootingSentinelName = `__workflow_int_root_probe__${crypto.randomUUID()}`;
    rootingSentinelPath = path.join(cleanPath, rootingSentinelName);
    const rootingSentinelContent = `workflow-int-root-probe:${crypto.randomUUID()}`;
    await fs.writeFile(rootingSentinelPath, rootingSentinelContent, { encoding: "utf8", flag: "wx" });
    const rooted = await withLiveProbeTimeout(pluginContext, "integration-worktree rooting probe prompt", () => session.prompt({
      sessionID: childID,
      directory: cleanPath,
      body: { parts: [textPart(`Use the read tool to read the relative path \`${rootingSentinelName}\` and reply with its exact content.`)] },
    }), () => abortChild(pluginContext, childID, cleanPath));
    const rootedMessages = await sessionMessagesPayloadForProbe(pluginContext, childID, cleanPath);
    const rootedToolParts = [...collectToolParts(rooted), ...collectToolParts(rootedMessages)].filter((part) => toolPartName(part).toLowerCase() === "read");
    const rootedObserved = rootedToolParts.some((part) => {
      if (part?.state?.status !== "completed") return false;
      const inputPath = String(part?.state?.input?.filePath ?? part?.state?.input?.path ?? "");
      const content = String(part?.state?.content ?? "");
      return (inputPath === rootingSentinelName || inputPath === rootingSentinelPath || inputPath === `./${rootingSentinelName}`)
        && content.includes(rootingSentinelContent);
    });
    // Remove the rooting sentinel before the Git isolation checks below: an untracked file
    // in cleanPath would make the worktree "dirty" and defeat the clean-removal proof.
    try { await fs.rm(rootingSentinelPath, { force: true }); } catch {
      // Probe sentinel cleanup is best effort.
    }
    rootingSentinelPath = undefined;
    if (!rootedObserved) {
      const rootedText = [...collectTextParts(rooted), ...collectTextParts(rootedMessages)].join("\n").trim();
      if (rootedText.includes(cleanPath)) {
        return gateAvailableUnverified(
          `integration-worktree probe observed only model-reported cwd text matching ${cleanPath}; no deterministic read tool evidence under the integration worktree, so child rooting is unverified`,
        );
      }
      return gateFailed(`integration-worktree probe observed neither a completed sentinel read nor matching cwd text; response=${truncateText(rootedText || JSON.stringify(rooted?.data ?? {}), MAX_STATUS_STRING_CHARS)}`);
    }

    const sentinel = "integration-only.txt";
    await fs.writeFile(path.join(cleanPath, sentinel), "integration worktree only\n", "utf8");
    const committed = await adapter.commit({ directory: cleanPath, message: "integration probe change" });
    if (committed.committed !== true) return gateFailed("integration-worktree probe could not commit sentinel change");
    const changes = await changedPathsSinceBase(cleanPath, baseCommit);
    if (!changes.some((change) => change.path === sentinel)) return gateFailed("integration-worktree probe did not detect sentinel as an integration changed path");
    if (await pathExists(path.join(primary, sentinel))) return gateFailed("integration-worktree probe sentinel appeared in the primary worktree");

    const cleanRemoval = await adapter.remove(cleanWorktree);
    if (cleanRemoval.removed !== true) return gateFailed(`integration-worktree clean cleanup did not remove worktree: ${cleanRemoval.reason || "unknown"}`);
    cleanWorktree = undefined;

    dirtyWorktree = await adapter.createIntegrationWorktree({ runId: "live-gate-probe-dirty", branch: "workflow/live-gate-probe/dirty" });
    await fs.writeFile(path.join(dirtyWorktree.path, "dirty.txt"), "preserve dirty worktree\n", "utf8");
    const dirtyRemoval = await adapter.remove(dirtyWorktree);
    if (dirtyRemoval.preserved !== true || dirtyRemoval.reason !== "dirty") {
      return gateFailed(`integration-worktree dirty cleanup was not preserved: ${dirtyRemoval.reason || "unknown"}`);
    }

    return gateVerified("local Git integration-worktree probe created a scratch worktree, rooted a child session there, isolated changed paths, removed clean worktrees, and preserved dirty worktrees");
  } catch (error) {
    const evidence = truncateText(extractTextFromError(error), MAX_STATUS_STRING_CHARS);
    if (/rev-parse --verify HEAD|rev-parse HEAD|requires a Git repository|not a git repository/i.test(evidence)) {
      return gateBlocked(`local Git integration-worktree probe requires a Git repository with HEAD: ${evidence}`);
    }
    return gateFailed(`integration-worktree probe failed: ${evidence}`);
  } finally {
    if (childID && session.has("abort")) {
      try { await withLiveProbeTimeout(pluginContext, "integration-worktree probe abort", () => session.abort({ sessionID: childID, directory: cleanWorktree?.path || dirtyWorktree?.path || primary })); } catch {
        // Probe cleanup is best effort.
      }
    }
    if (rootingSentinelPath) {
      try { await fs.rm(rootingSentinelPath, { force: true }); } catch {
        // Probe sentinel cleanup is best effort.
      }
    }
    await removeGitWorktreeForce(adapter?.root || primary, cleanWorktree?.path);
    await removeGitWorktreeForce(adapter?.root || primary, dirtyWorktree?.path);
    if (tempRoot) {
      try { await fs.rm(tempRoot, { recursive: true, force: true }); } catch {
        // Probe cleanup is best effort.
      }
    }
  }
}

async function probeBackgroundContinuationGate() {
  await immediatePromise();
  return gateVerified(
    "background continuation smoke probe observed in-process smoke only; restart survival not implied (probe yields the event loop and does not exercise the OpenCode background subsystem)",
    "in-process-smoke",
  );
}

async function probeConcurrencyCapacityGate(pluginContext, context, options = {}) {
  const session = sessionApi(pluginContext);
  if (!session.has("create") || !session.has("prompt")) {
    return gateBlocked("session.create/session.prompt are unavailable for a concurrency-capacity probe");
  }
  const limit = Number.isInteger(options.limit) && options.limit > 0 ? options.limit : DEFAULT_CONCURRENCY_PROBE_LIMIT;
  const directory = context.directory || context.worktree || pluginContext.directory;
  if (!directory) return gateBlocked("concurrency-capacity probe requires a target directory in context");

  const childIDs = [];
  const startedAt = Date.now();
  try {
    const created = await Promise.all(Array.from({ length: limit }, async (_item, index) => {
      const result = unwrapClientResult(await withLiveProbeTimeout(pluginContext, `concurrency-capacity probe session create ${index + 1}/${limit}`, () => session.create({
        parentID: context.sessionID,
        title: `workflow concurrency-capacity probe ${index + 1}/${limit}`,
        directory,
      })), `Concurrency-capacity probe session creation ${index + 1}/${limit}`);
      const childID = result?.data?.id;
      if (!childID) throw new WorkflowProbeStructuralError(`OpenCode returned no child session id for concurrency-capacity probe ${index + 1}/${limit}`);
      return childID;
    }));
    childIDs.push(...created);

    await withLiveProbeTimeout(
      pluginContext,
      `concurrency-capacity probe ${limit} concurrent prompts`,
      () => Promise.all(childIDs.map((childID, index) => {
        const sentinel = `workflow-concurrency-probe-${index + 1}-of-${limit}`;
        return session.prompt({
          sessionID: childID,
          directory,
          body: { parts: [textPart(`Reply with exactly ${sentinel}. Do not call tools.`)] },
        }).then((result) => unwrapClientResult(result, `Concurrency-capacity probe prompt ${index + 1}/${limit}`));
      })),
      () => Promise.allSettled(childIDs.map((childID) => abortChild(pluginContext, childID, directory))),
    );

    return gateVerified(`concurrency-capacity live probe completed ${limit}/${limit} concurrent session.prompt calls in ${Date.now() - startedAt}ms`);
  } catch (error) {
    const transport = transportFailureGate(error, "concurrency-capacity probe");
    if (transport) return transport;
    return gateFailed(`concurrency-capacity probe failed at ${limit} concurrent prompts: ${truncateText(extractTextFromError(error), MAX_STATUS_STRING_CHARS)}`);
  } finally {
    await Promise.allSettled(childIDs.map((childID) => abortChild(pluginContext, childID, directory)));
  }
}

async function probeCancellationGate(pluginContext, context) {
  const session = sessionApi(pluginContext);
  if (!session.has("create") || !session.has("abort")) {
    return gateBlocked("session.create/session.abort are unavailable for a cancellation probe");
  }
  const directory = context.directory || context.worktree;
  let childID;
  try {
    const created = unwrapClientResult(await withLiveProbeTimeout(pluginContext, "cancellation probe session create", () => session.create({ parentID: context.sessionID, title: "workflow cancellation probe", directory })), "Cancellation probe session creation");
    childID = created?.data?.id;
    if (!childID) throw new Error("OpenCode did not return a child session id for cancellation probe");
    await withLiveProbeTimeout(pluginContext, "cancellation probe abort", () => session.abort({ sessionID: childID, directory }));
    childID = undefined;
    return gateVerified("session.abort live probe completed for a child session");
  } catch (error) {
    return gateFailed(`cancellation probe failed: ${truncateText(extractTextFromError(error), MAX_STATUS_STRING_CHARS)}`);
  } finally {
    await abortChild(pluginContext, childID, directory);
  }
}

async function probeWorkflowNotificationGate(pluginContext, context) {
  if (!sessionApi(pluginContext).has("promptAsync")) return gateBlocked("session.promptAsync is unavailable for workflow notification delivery");
  const dir = await fs.mkdtemp(path.join("/tmp", "workflow-notification-probe-"));
  const notificationPath = path.join(dir, "notification.json");
  try {
    await writeJsonAtomic(notificationPath, {
      stateVersion: NOTIFICATION_STATE_VERSION,
      runId: "workflow-notification-probe",
      status: "completed",
      sessionID: context.sessionID,
      directory: context.directory || context.worktree,
      agent: context.agent || "build",
      resultPath: path.join(dir, "result.json"),
      sentAt: null,
      delivery: { attempts: 0, lastAttemptAt: null, lastError: null },
      notificationPath,
    });
    pendingNotificationPaths.add(notificationPath);
    const result = await deliverWorkflowNotifications(pluginContext, { type: "session.idle", properties: { sessionID: context.sessionID } });
    const record = await readJsonFile(notificationPath, {});
    if (result.delivered === 1 && record.sentAt) return gateVerified("workflow completion notification probe delivered one promptAsync continuation after session.idle");
    return gateFailed(`workflow notification probe did not deliver: ${JSON.stringify(result)}`);
  } catch (error) {
    return gateFailed(`workflow notification probe failed: ${truncateText(extractTextFromError(error), MAX_STATUS_STRING_CHARS)}`);
  } finally {
    pendingNotificationPaths.delete(notificationPath);
    try { await fs.rm(dir, { recursive: true, force: true }); } catch {
      // Probe cleanup is best effort.
    }
  }
}

export {
  liveProbeTimeoutMs,
  withLiveProbeTimeout,
  toolPartName,
  toolPartEvidence,
  toolPartDenied,
  isDenialEvidence,
  denialProbeResult,
  unwrapClientResult,
  valueContainsString,
  createdSessionRetainedPermission,
  deterministicToolProbeResult,
  deterministicAllowedToolResult,
  secretReadClassCoverageResult,
  sessionMessagesPayloadForProbe,
  initScratchGitRepo,
  removeGitWorktreeForce,
  collectTextParts,
  collectToolParts,
  opencodeChildPermissionDenyRules,
  probeStructuredOutput,
  probeWorktree,
  probeDeniedBash,
  probeCommandScopedBash,
  probeMcpAccessGate,
  probeSecretReadDeny,
  probeStructuredOutputGate,
  probeWorktreeGate,
  probeDirectoryRootingGate,
  probeWorktreeEditIsolationGate,
  probeIntegrationWorktreeIsolationGate,
  probeBackgroundContinuationGate,
  probeConcurrencyCapacityGate,
  probeCancellationGate,
  probeWorkflowNotificationGate,
};
