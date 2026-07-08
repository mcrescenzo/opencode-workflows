// Deterministic replacement for the deleted live-gate probe preflight (Design C).
// One memoized GET /global/health per serverUrl answers "which opencode is this?";
// elevated authority refuses servers older than MIN_OPENCODE_SERVER_VERSION, where
// the typed Session.directory echo and session permission config are unverified.
// Liveness is intentionally NOT this module's job: an unreachable server fails loud
// at the first session.create, so "unreachable"/"unknown" do not block launch.
import { WorkflowAuthorityError } from "./errors.js";
import { MIN_OPENCODE_SERVER_VERSION } from "./constants.js";

const fingerprintCache = new Map(); // serverUrl -> Promise<fingerprint>
const FINGERPRINT_CACHE_MAX = 8;

export function compareServerVersion(a, b) {
  const parse = (v) => {
    const [core, pre] = String(v).split("-", 2);
    return { parts: core.split(".").map((n) => Number.parseInt(n, 10) || 0), pre };
  };
  const va = parse(a), vb = parse(b);
  for (let i = 0; i < Math.max(va.parts.length, vb.parts.length); i += 1) {
    const d = (va.parts[i] ?? 0) - (vb.parts[i] ?? 0);
    if (d !== 0) return d;
  }
  if (Boolean(va.pre) !== Boolean(vb.pre)) return va.pre ? -1 : 1;
  return 0;
}

export function classifyHealthResult(result, minimum) {
  // HeyAPI v2 client envelope: on success, `{ data, request, response }`; on a
  // non-2xx response, `{ error, request, response }` where `response` is the raw
  // fetch Response (status lives on response.status, not on the parsed error
  // body) — see resolveWorktreeClient in capability-adapter.js and
  // node_modules/@opencode-ai/sdk/dist/v2/gen/client/client.gen.js.
  const status = result?.response?.status ?? result?.error?.status;
  if (result?.error !== undefined) {
    if (status === 404) {
      return { state: "too-old", minimum, evidence: `GET /global/health returned 404; servers >= ${minimum} implement it` };
    }
    return { state: "unknown", minimum, evidence: `GET /global/health errored (status=${status ?? "none"})` };
  }
  const version = result?.data?.version;
  if (typeof version !== "string" || version === "") {
    return { state: "unknown", minimum, evidence: "health payload had no version string" };
  }
  if (compareServerVersion(version, minimum) < 0) {
    return { state: "too-old", version, minimum, evidence: `server ${version} < required ${minimum}` };
  }
  return { state: "ok", version, minimum, evidence: `server ${version} >= ${minimum}` };
}

export async function serverFingerprint(pluginContext) {
  const key = String(pluginContext?.serverUrl ?? "");
  if (!fingerprintCache.has(key)) {
    if (fingerprintCache.size >= FINGERPRINT_CACHE_MAX) fingerprintCache.clear();
    fingerprintCache.set(key, probeHealth(pluginContext).catch((error) => {
      fingerprintCache.delete(key);
      return { state: "unreachable", minimum: MIN_OPENCODE_SERVER_VERSION, evidence: String(error?.message ?? error) };
    }));
  }
  return fingerprintCache.get(key);
}

async function probeHealth(pluginContext) {
  // Test seam mirrors __workflowCapabilities: lets unit tests inject a health result.
  const forced = pluginContext?.__workflowServerHealth;
  if (forced !== undefined) return classifyHealthResult(forced, MIN_OPENCODE_SERVER_VERSION);
  const { createOpencodeClient } = await import("@opencode-ai/sdk/v2/client");
  const v2 = createOpencodeClient({ baseUrl: new URL(String(pluginContext.serverUrl)).origin });
  const result = await v2.global.health();
  return classifyHealthResult(result, MIN_OPENCODE_SERVER_VERSION);
}

export function assertServerSupportsElevatedAuthority(fingerprint) {
  if (fingerprint?.state === "too-old") {
    throw new WorkflowAuthorityError(
      `Elevated workflow authority requires opencode server >= ${fingerprint.minimum}; detected ${fingerprint.version ?? "pre-/global/health server"} (${fingerprint.evidence}). Upgrade opencode or run a read-only profile.`,
    );
  }
}

export function __resetFingerprintCacheForTests() {
  fingerprintCache.clear();
}
