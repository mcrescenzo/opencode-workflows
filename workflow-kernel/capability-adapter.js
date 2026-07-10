import path from "node:path";
import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { hasFunction } from "./text-json.js";
import { hasWorkflowToast } from "./notification-toast.js";

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

// Used by createCapabilityAdapter's worktree create/remove paths below, and by
// readRawTranscript's salvage path in workflow-plugin.js.
export function unwrapClientResult(result, label) {
  if (result?.error !== undefined) {
    const error = result.error;
    throw new Error(`${label} failed: ${error?.message || error?.error || JSON.stringify(error)}`);
  }
  return result;
}

// Recursively flattens a session-message-shaped value's text parts into `parts`. Kept here
// (rather than deleted with live-gate-probes.js) because salvage's extractFinalAssistantText
// in workflow-plugin.js still needs it to recover a child's final assistant text.
export function collectTextParts(value, parts = []) {
  if (value == null) return parts;
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

export function redactServerUrl(value) {
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

// Design C (2026-07-07): capabilities are shape-only (client/session API surface present or
// not); there is no live-gate probe layer promoting them to a verified state anymore. Elevated
// authority is instead gated deterministically at launch by server-fingerprint.js
// (assertServerSupportsElevatedAuthority) plus per-lane permission/directory-echo assertions
// in child-agent-runner.js. See docs/superpowers/plans/2026-07-07-design-c-gate-simplification.md.
export async function createCapabilityAdapter(pluginContext) {
  const forced = pluginContext.__workflowCapabilities ?? {};
  const session = pluginContext.client?.session ?? {};
  const worktreeClient = pluginContext.client?.worktree ?? pluginContext.client?.experimental?.worktree ?? {};
  const diagnostics = {
    opencodeVersion: forced.opencodeVersion ?? "unknown",
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
  const worktree = forced.worktree ?? (diagnostics.clientShape.worktreeCreate && diagnostics.clientShape.worktreeRemove ? "available" : "unavailable");
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
      worktree,
      toast,
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
