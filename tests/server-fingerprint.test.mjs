import test from "node:test";
import assert from "node:assert/strict";
import {
  compareServerVersion,
  classifyHealthResult,
  assertServerSupportsElevatedAuthority,
} from "../workflow-kernel/server-fingerprint.js";
import { MIN_OPENCODE_SERVER_VERSION } from "../workflow-kernel/constants.js";

test("compareServerVersion orders dotted versions numerically", () => {
  assert.equal(compareServerVersion("1.17.13", "1.17.13"), 0);
  assert.ok(compareServerVersion("1.17.12", "1.17.13") < 0);
  assert.ok(compareServerVersion("1.18.0", "1.17.13") > 0);
  assert.ok(compareServerVersion("1.17.13-beta.1", "1.17.13") < 0);
});

test("classifyHealthResult maps health payloads to fingerprint states", () => {
  assert.deepEqual(
    classifyHealthResult({ data: { healthy: true, version: "1.17.13" } }, MIN_OPENCODE_SERVER_VERSION).state,
    "ok",
  );
  assert.equal(
    classifyHealthResult({ data: { healthy: true, version: "1.16.0" } }, MIN_OPENCODE_SERVER_VERSION).state,
    "too-old",
  );
  // 404 / route-missing => the server predates /global/health => too old to verify.
  // HeyAPI v2 client envelope: on a non-2xx response, the status lives on
  // result.response.status (the fetch Response), not on result.error (the parsed
  // error body) — see workflow-kernel/capability-adapter.js's resolveWorktreeClient
  // and node_modules/@opencode-ai/sdk/dist/v2/gen/client/client.gen.js.
  assert.equal(
    classifyHealthResult({ error: { message: "not found" }, response: { status: 404 } }, MIN_OPENCODE_SERVER_VERSION).state,
    "too-old",
  );
  // Malformed payload => unknown (do not block; not proof of age).
  assert.equal(classifyHealthResult({ data: { healthy: true } }, MIN_OPENCODE_SERVER_VERSION).state, "unknown");
});

test("assertServerSupportsElevatedAuthority throws only on too-old", () => {
  assert.throws(
    () => assertServerSupportsElevatedAuthority({ state: "too-old", version: "1.16.0", minimum: MIN_OPENCODE_SERVER_VERSION, evidence: "x" }),
    /requires opencode server >= /,
  );
  assertServerSupportsElevatedAuthority({ state: "ok", version: "1.17.13", minimum: MIN_OPENCODE_SERVER_VERSION, evidence: "x" });
  assertServerSupportsElevatedAuthority({ state: "unreachable", minimum: MIN_OPENCODE_SERVER_VERSION, evidence: "x" });
  assertServerSupportsElevatedAuthority({ state: "unknown", minimum: MIN_OPENCODE_SERVER_VERSION, evidence: "x" });
});
