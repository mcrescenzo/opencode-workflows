import test from "node:test";

import { assert, path, __test, mkTempDir, tokens, makeHarness } from "./live-gates-harness.mjs";

test("background continuation gate evidence explicitly disclaims restart survival", async () => {
  const harness = await makeHarness();
  const report = JSON.parse(await harness.tools.workflow_live_gates.execute({
    format: "json",
    approvalIntent: "probe",
    probeBackgroundContinuation: true,
  }, harness.context));

  assert.equal(report.gates.backgroundContinuation.state, "verified");
  assert.equal(report.gates.backgroundContinuation.verified, true);
  assert.equal(report.gates.backgroundContinuation.evidenceStrength, "in-process-smoke");
  assert.match(report.gates.backgroundContinuation.evidence, /in-process smoke only/i);
  assert.match(report.gates.backgroundContinuation.evidence, /restart survival not implied/i);
});

test("concurrency-capacity live gate honors the requested probe limit", async () => {
  const harness = await makeHarness();
  const report = JSON.parse(await harness.tools.workflow_live_gates.execute({
    format: "json",
    approvalIntent: "probe",
    probeConcurrencyCapacity: true,
    concurrencyProbeLimit: 3,
  }, harness.context));

  assert.equal(report.gates.concurrencyCapacity.state, "verified");
  assert.equal(report.gates.concurrencyCapacity.verified, true);
  assert.match(report.gates.concurrencyCapacity.evidence, /completed 3\/3 concurrent session\.prompt calls/);
  assert.equal(harness.calls.create.length, 3);
  assert.equal(harness.calls.prompt.length, 3);
});

// R32 (opencode-workflows-6ti): the backgroundContinuation probe is a trivial event-loop
// yield that returns gateVerified with the non-behavioral "in-process-smoke" strength. It
// must NOT auto-satisfy a *required* authority gate.
test("weakEvidenceGateBlockers flags verified in-process-smoke gates unless explicitly accepted", () => {
  // in-process-smoke is non-behavioral: it must be down-ranked even though verified===true.
  const inProcessSmoke = {
    backgroundContinuation: { state: "verified", verified: true, evidence: "smoke", evidenceStrength: "in-process-smoke" },
  };
  const blockers = __test.weakEvidenceGateBlockers(inProcessSmoke, []);
  assert.equal(blockers.length, 1);
  assert.match(blockers[0], /backgroundContinuation=verified\(in-process-smoke\) is non-behavioral/);

  // Explicit acceptance opts the strength back in.
  assert.deepEqual(__test.weakEvidenceGateBlockers(inProcessSmoke, ["in-process-smoke"]), []);

  // weakEvidenceGateBlockers only down-ranks NON_BEHAVIORAL_EVIDENCE_STRENGTHS
  // (in-process-smoke today). no-attempt-fallback (permissionEnforcement) is a
  // compatibility fallback that still observes the real session API, so it is not blocked.
  // NB: post-R31 the directoryRooting probe no longer *produces* a verified model-text-only
  // gate (a model cwd echo is reported available-unverified), but the down-ranker itself is
  // strength-agnostic beyond the non-behavioral set, so a hypothetical forced model-text-only
  // gate is still not blocked here — that is asserted to lock the down-ranker's scope.
  const compatFallbacks = {
    directoryRooting: { state: "verified", verified: true, evidence: "x", evidenceStrength: "model-text-only" },
    permissionEnforcement: { state: "verified", verified: true, evidence: "y", evidenceStrength: "no-attempt-fallback" },
    structuredOutput: { state: "verified", verified: true, evidence: "z", evidenceStrength: "observed" },
  };
  assert.deepEqual(__test.weakEvidenceGateBlockers(compatFallbacks, []), []);

  // Only "in-process-smoke" is treated as non-behavioral today.
  assert.deepEqual([...__test.NON_BEHAVIORAL_EVIDENCE_STRENGTHS], ["in-process-smoke"]);
});

test("verifyRequiredAuthorityGates rejects backgroundContinuation satisfied only by the in-process-smoke probe", async () => {
  const directory = await mkTempDir();
  const pluginContext = {
    directory,
    client: {
      session: {
        async create(input) { return { data: { id: "child-bg", permission: input.permission } }; },
        async prompt(input) { return { data: { parts: [{ type: "text", text: input.query?.directory ?? "ok" }], info: { tokens: tokens(), cost: 0 } } }; },
        async abort() { return { data: { ok: true } }; },
      },
    },
  };
  const context = { directory, worktree: directory, sessionID: "parent", agent: "build" };
  const adapter = { diagnostics: {} };
  // The real no-op probe runs (probeBackgroundContinuation flag is derived from the
  // required gate) and returns verified/in-process-smoke; verify must still reject it.
  await assert.rejects(
    __test.verifyRequiredAuthorityGates(pluginContext, context, adapter, {
      profile: "ad-hoc",
      requiredGates: ["backgroundContinuation"],
    }),
    /requires verified live gates.*backgroundContinuation=verified\(in-process-smoke\) is non-behavioral/s,
  );
  // The blocker is recorded in adapter diagnostics for observability.
  assert.equal(adapter.diagnostics.liveGates.backgroundContinuation.evidenceStrength, "in-process-smoke");
});

test("verifyRequiredAuthorityGates accepts backgroundContinuation when in-process-smoke is explicitly accepted", async () => {
  const directory = await mkTempDir();
  const pluginContext = {
    directory,
    client: {
      session: {
        async create(input) { return { data: { id: "child-bg", permission: input.permission } }; },
        async prompt(input) { return { data: { parts: [{ type: "text", text: input.query?.directory ?? "ok" }], info: { tokens: tokens(), cost: 0 } } }; },
        async abort() { return { data: { ok: true } }; },
      },
    },
  };
  const context = { directory, worktree: directory, sessionID: "parent", agent: "build" };
  const adapter = { diagnostics: {} };
  const gateStatus = await __test.verifyRequiredAuthorityGates(pluginContext, context, adapter, {
    profile: "ad-hoc",
    requiredGates: ["backgroundContinuation"],
  }, { acceptWeakEvidence: ["in-process-smoke"] });
  assert.equal(gateStatus.backgroundContinuation.verified, true);
  assert.equal(gateStatus.backgroundContinuation.evidenceStrength, "in-process-smoke");
});

// R14 (opencode-workflows-bzm): a transient/unverified capability probe must NOT be
// cached for the process lifetime. A non-verified structured-output probe leaves no
// cache entry, so the next elevated workflow re-probes and can promote once the runtime
// actually returns structured data — instead of being locked out until an OpenCode
// restart. A *verified* probe is cached (and reused) so the happy path stays cheap.
test("R14: transient capability probe failure is not cached and re-probes; verified result is cached", async () => {
  const directory = await mkTempDir();
  const calls = { create: 0, prompt: 0 };
  // promptMode flips per test phase: "transient" => no structured data
  // (available-unverified), "verified" => real structured payload (available).
  let promptMode = "transient";
  const pluginContext = {
    directory,
    serverUrl: new URL("http://127.0.0.1:4096/?token=secret"),
    client: {
      session: {
        async create(input) { calls.create += 1; return { data: { id: `child-${calls.create}`, permission: input.permission } }; },
        async prompt() {
          calls.prompt += 1;
          if (promptMode === "verified") {
            return { data: { info: { structured: { ok: true }, tokens: tokens(), cost: 0 } } };
          }
          // Transient: model answered from memory / server returned no structured output.
          return { data: { parts: [{ type: "text", text: "ok" }], info: { tokens: tokens(), cost: 0 } } };
        },
        async abort() { return { data: { ok: true } }; },
      },
    },
  };
  const toolContext = { directory, worktree: directory, sessionID: "parent", agent: "build" };
  const authority = __test.resolveRunAuthority({ profile: "ad-hoc" }, {});
  const key = `${__test.redactServerUrl(pluginContext.serverUrl)}:${path.resolve(directory)}`;
  // Start clean so prior tests' cached probes don't bleed in.
  __test.invalidateCapabilityProbes(key);

  // Phase 1: transient probe => available-unverified, and nothing cached.
  const adapter1 = await __test.createCapabilityAdapter(pluginContext);
  await __test.promoteCapabilities(pluginContext, toolContext, adapter1, authority);
  assert.equal(adapter1.capabilities.structuredOutput, "available-unverified");
  const promptsAfterPhase1 = calls.prompt;
  assert.ok(promptsAfterPhase1 >= 1, "first promotion must actually probe");
  assert.equal(__test.capabilityProbes.get(key)?.structuredOutput, undefined, "transient probe must not be cached");

  // Phase 2: runtime now returns structured data => re-probe runs and verifies.
  promptMode = "verified";
  const adapter2 = await __test.createCapabilityAdapter(pluginContext);
  await __test.promoteCapabilities(pluginContext, toolContext, adapter2, authority);
  assert.equal(adapter2.capabilities.structuredOutput, "available", "transient failure must not permanently block promotion");
  assert.ok(calls.prompt > promptsAfterPhase1, "phase 2 must re-probe, not reuse the transient result");
  const promptsAfterPhase2 = calls.prompt;
  assert.ok(__test.capabilityProbes.get(key)?.structuredOutput?.verified === true, "verified probe must be cached");

  // Phase 3: verified result is reused from cache (no additional probe).
  const adapter3 = await __test.createCapabilityAdapter(pluginContext);
  await __test.promoteCapabilities(pluginContext, toolContext, adapter3, authority);
  assert.equal(adapter3.capabilities.structuredOutput, "available");
  assert.equal(calls.prompt, promptsAfterPhase2, "verified probe must be served from cache without re-probing");

  __test.invalidateCapabilityProbes(key);
});

// R14: explicit cache-invalidation entry point via workflow_live_gates. resetProbeCache
// is gated like a live probe (write context + approvalIntent "probe") and clears the
// cached probe promises so a later promotion re-probes from scratch.
test("R14: workflow_live_gates resetProbeCache clears cached probes and is approval-gated", async () => {
  const harness = await makeHarness();
  // Seed a cache entry so we can observe it being cleared by the invalidation entry point.
  __test.capabilityProbes.set("r14-seed-entry", { structuredOutput: { verified: true, ts: Date.now(), promise: Promise.resolve("available") } });
  assert.ok(__test.capabilityProbes.has("r14-seed-entry"));

  // Missing approvalIntent must be rejected (state-mutating action is gated like a probe).
  await assert.rejects(
    harness.tools.workflow_live_gates.execute({ format: "json", resetProbeCache: true }, harness.context),
    /approvalIntent: "probe"/,
  );

  const report = JSON.parse(await harness.tools.workflow_live_gates.execute(
    { format: "json", approvalIntent: "probe", resetProbeCache: true, resetProbeCacheScope: "all" },
    harness.context,
  ));
  assert.ok(report.probeCacheCleared, "report must surface that the cache was cleared");
  assert.equal(report.probeCacheCleared.scope, "all");
  assert.ok(report.probeCacheCleared.cleared >= 1);
  assert.equal(__test.capabilityProbes.has("r14-seed-entry"), false, "resetProbeCache must drop cached probe entries");
});
