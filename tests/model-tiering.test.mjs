// Session-aware model tiering (epic opencode-workflows-ce3i):
//   - ce3i.3 default child model inherits the invoking session model
//   - ce3i.6 read-only workflow_models discovery tool
// Mirrors the plan docs/superpowers/plans/2026-06-23-session-aware-model-tiering-plan.md
// (Tasks 2 and 5), adapted to the post-split test layout (the former
// tests/workflows.test.mjs monolith no longer exists).

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { makeHarness } from "./helpers/harness.mjs";
import workflowPlugin from "../workflow-kernel/index.js";

const { __test } = workflowPlugin;

test("ce3i.3: default child model inherits the active session model", async () => {
  const { tools, context, directory } = await makeHarness(
    async () => ({ data: { parts: [], info: {} } }),
    { sessionModel: "zai-coding-plan/glm-5.2" },
  );
  try {
    const source = `export const meta = { name: "model-inherit", profile: "read-only-review" };\nreturn { ok: true };`;
    const preview = await tools.workflow_run.execute({ source }, context);
    assert.match(preview, /Default child model: zai-coding-plan\/glm-5\.2/);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("ce3i.3: workflow_run fails explicitly when no child model can be resolved (no session model, no childModel)", async () => {
  // The hard-coded DEFAULT_CHILD_MODEL fallback was removed (AGENTS.md: model IDs from config, never
  // literals). With config:false the session model is unreadable and no childModel is supplied, so
  // planning must fail explicitly and prompt the caller for a model rather than guessing a provider.
  const { tools, context, directory } = await makeHarness(
    async () => ({ data: { parts: [], info: {} } }),
    { config: false },
  );
  try {
    const source = `export const meta = { name: "model-fallback", profile: "read-only-review" };\nreturn { ok: true };`;
    await assert.rejects(
      tools.workflow_run.execute({ source }, context),
      (err) => {
        assert.match(err.message, /No child model could be resolved/);
        assert.match(err.message, /childModel/);
        return true;
      },
    );
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("ce3i.3: an explicit childModel still overrides the inherited session model", async () => {
  const { tools, context, directory } = await makeHarness(
    async () => ({ data: { parts: [], info: {} } }),
    { sessionModel: "zai-coding-plan/glm-5.2" },
  );
  try {
    const source = `export const meta = { name: "model-explicit", profile: "read-only-review" };\nreturn { ok: true };`;
    const preview = await tools.workflow_run.execute({ source, childModel: "openai/gpt-5.5" }, context);
    assert.match(preview, /Default child model: openai\/gpt-5\.5/);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

const ZAI_PROVIDERS = [{
  id: "zai-coding-plan",
  name: "Z.AI",
  source: "config",
  models: { "glm-5.2": { id: "glm-5.2", name: "GLM 5.2", variants: { high: {}, max: {} } } },
}];

function countedConfig({
  sessionModel = "zai-coding-plan/glm-5.2",
  providers = ZAI_PROVIDERS,
  providerDefault = { "zai-coding-plan": "glm-5.2" },
} = {}) {
  const counter = { providers: 0 };
  const config = {
    async get() {
      return { data: { model: sessionModel } };
    },
    async providers() {
      counter.providers += 1;
      return { data: { providers, default: providerDefault } };
    },
  };
  return { config, counter };
}

async function approvedArgs(tools, context, request) {
  const preview = await tools.workflow_run.execute(request, context);
  const match = preview.match(/approvalHash: ([a-f0-9]{64})/);
  assert.ok(match, `missing approvalHash in preview: ${preview}`);
  return { ...request, approve: true, approvalHash: match[1] };
}

test("ce3i.6: workflow_models (json) returns the session model, providers, and a no-deviation suggestion", async () => {
  const { tools, context, directory } = await makeHarness(
    async () => ({ data: { parts: [], info: {} } }),
    { sessionModel: "zai-coding-plan/glm-5.2", providers: ZAI_PROVIDERS, providerDefault: { "zai-coding-plan": "glm-5.2" } },
  );
  try {
    const out = JSON.parse(await tools.workflow_models.execute({ format: "json" }, context));
    assert.equal(out.session.model, "zai-coding-plan/glm-5.2");
    assert.equal(out.session.providerID, "zai-coding-plan");
    assert.equal(out.session.modelID, "glm-5.2");
    assert.equal(out.session.family, "zai-coding-plan");
    const zai = out.providers.find((p) => p.id === "zai-coding-plan");
    assert.ok(zai, "zai provider present");
    const glm = zai.models.find((m) => m.id === "glm-5.2");
    assert.ok(glm, "glm-5.2 model present");
    assert.deepEqual(glm.variants, ["high", "max"]);
    // No-deviation default: both tiers stay on the session model.
    assert.equal(out.suggested.fast, "zai-coding-plan/glm-5.2");
    assert.equal(out.suggested.deep, "zai-coding-plan/glm-5.2");
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("mfv9.5: provider list is cached across workflow_models, preview, and approve until reset", async () => {
  __test.invalidateWorkflowProviderListCache("all");
  const { config, counter } = countedConfig();
  const { tools, context, directory } = await makeHarness(
    async () => ({ data: { parts: [], info: {} } }),
    { config, serverUrl: "http://provider-cache.test" },
  );
  try {
    const source = `export const meta = { name: "provider-cache", profile: "read-only-review" };\nreturn { ok: true };`;

    const models = JSON.parse(await tools.workflow_models.execute({ format: "json" }, context));
    assert.equal(models.providers[0].id, "zai-coding-plan");
    assert.equal(counter.providers, 1, "workflow_models should perform the first provider fetch");

    const approve = await approvedArgs(tools, context, { source, childModel: "zai-coding-plan/glm-5.2" });
    assert.equal(counter.providers, 1, "workflow_run preview should reuse the cached provider list");

    const output = await tools.workflow_run.execute(approve, context);
    assert.match(output, /Workflow .* completed/);
    assert.equal(counter.providers, 1, "workflow_run approval should reuse the cached provider list");

    await tools.workflow_live_gates.execute({ format: "json", approvalIntent: "probe", resetProbeCache: true }, context);
    assert.equal(__test.workflowProviderListCache.size, 0, "resetProbeCache should clear cached provider lists too");

    await tools.workflow_models.execute({ format: "json" }, context);
    assert.equal(counter.providers, 2, "provider list should be refetched after reset");
  } finally {
    __test.invalidateWorkflowProviderListCache("all");
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("mfv9.5: provider list cache expires on the probe TTL", async () => {
  __test.invalidateWorkflowProviderListCache("all");
  const realNow = Date.now;
  let now = 1_000_000;
  Date.now = () => now;
  const { config, counter } = countedConfig();
  const { tools, context, directory } = await makeHarness(
    async () => ({ data: { parts: [], info: {} } }),
    { config, serverUrl: "http://provider-cache-ttl.test" },
  );
  try {
    await tools.workflow_models.execute({ format: "json" }, context);
    assert.equal(counter.providers, 1);

    now += __test.WORKFLOW_PROVIDER_LIST_TTL_MS - 1;
    await tools.workflow_models.execute({ format: "json" }, context);
    assert.equal(counter.providers, 1, "provider fetch should stay cached just inside the TTL");

    now += 2;
    await tools.workflow_models.execute({ format: "json" }, context);
    assert.equal(counter.providers, 2, "provider fetch should refresh after the TTL");
  } finally {
    Date.now = realNow;
    __test.invalidateWorkflowProviderListCache("all");
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("ce3i.6: workflow_models (summary) lists the session model and providers as text", async () => {
  const { tools, context, directory } = await makeHarness(
    async () => ({ data: { parts: [], info: {} } }),
    { sessionModel: "zai-coding-plan/glm-5.2", providers: ZAI_PROVIDERS, providerDefault: { "zai-coding-plan": "glm-5.2" } },
  );
  try {
    const text = await tools.workflow_models.execute({}, context);
    assert.match(text, /Session model: zai-coding-plan\/glm-5\.2/);
    assert.match(text, /Suggested: fast=zai-coding-plan\/glm-5\.2 deep=zai-coding-plan\/glm-5\.2/);
    assert.match(text, /zai-coding-plan \[config\] -> glm-5\.2/);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("jbs3.5: launching with a non-existent child model is rejected at plan time with the available-models list", async () => {
  const { tools, context, directory } = await makeHarness(
    async () => ({ data: { parts: [], info: {} } }),
    { sessionModel: "zai-coding-plan/glm-5.2", providers: ZAI_PROVIDERS, providerDefault: { "zai-coding-plan": "glm-5.2" } },
  );
  try {
    const source = `export const meta = { name: "bad-model", profile: "read-only-review" };\nreturn { ok: true };`;
    await assert.rejects(
      tools.workflow_run.execute({ source, childModel: "zai-coding-plan/does-not-exist" }, context),
      (err) => {
        assert.match(err.message, /not available/);
        assert.match(err.message, /does-not-exist/);
        // The available-models list is surfaced in the rejection.
        assert.match(err.message, /zai-coding-plan: glm-5\.2/);
        return true;
      },
    );
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("jbs3.5: an unknown provider is rejected at plan time with the available-models list", async () => {
  const { tools, context, directory } = await makeHarness(
    async () => ({ data: { parts: [], info: {} } }),
    { sessionModel: "zai-coding-plan/glm-5.2", providers: ZAI_PROVIDERS, providerDefault: { "zai-coding-plan": "glm-5.2" } },
  );
  try {
    const source = `export const meta = { name: "bad-provider", profile: "read-only-review" };\nreturn { ok: true };`;
    await assert.rejects(
      tools.workflow_run.execute({ source, childModel: "no-such-provider/whatever" }, context),
      (err) => {
        assert.match(err.message, /not available/);
        assert.match(err.message, /no-such-provider/);
        assert.match(err.message, /zai-coding-plan: glm-5\.2/);
        return true;
      },
    );
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("jbs3.5: a non-existent fast tier model is rejected at plan time", async () => {
  const { tools, context, directory } = await makeHarness(
    async () => ({ data: { parts: [], info: {} } }),
    { sessionModel: "zai-coding-plan/glm-5.2", providers: ZAI_PROVIDERS, providerDefault: { "zai-coding-plan": "glm-5.2" } },
  );
  try {
    const source = `export const meta = { name: "bad-tier", profile: "read-only-review" };\nreturn { ok: true };`;
    await assert.rejects(
      tools.workflow_run.execute({ source, modelTiers: { fast: "zai-coding-plan/ghost" } }, context),
      (err) => {
        assert.match(err.message, /not available/);
        assert.match(err.message, /fast tier/);
        assert.match(err.message, /ghost/);
        return true;
      },
    );
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("jbs3.5: a valid model passes plan-time validation unchanged", async () => {
  const { tools, context, directory } = await makeHarness(
    async () => ({ data: { parts: [], info: {} } }),
    { sessionModel: "zai-coding-plan/glm-5.2", providers: ZAI_PROVIDERS, providerDefault: { "zai-coding-plan": "glm-5.2" } },
  );
  try {
    const source = `export const meta = { name: "good-model", profile: "read-only-review" };\nreturn { ok: true };`;
    const preview = await tools.workflow_run.execute({ source, childModel: "zai-coding-plan/glm-5.2" }, context);
    assert.match(preview, /Default child model: zai-coding-plan\/glm-5\.2/);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("jbs3.5: validation degrades gracefully when the provider list is unavailable (unknown model is not rejected)", async () => {
  const { tools, context, directory } = await makeHarness(
    async () => ({ data: { parts: [], info: {} } }),
    { sessionModel: "zai-coding-plan/glm-5.2" },
  );
  try {
    // No providers configured => buildWorkflowModels returns [] => validation is
    // skipped rather than rejecting every model (transient-provider-gap policy).
    const source = `export const meta = { name: "no-providers", profile: "read-only-review" };\nreturn { ok: true };`;
    const preview = await tools.workflow_run.execute({ source, childModel: "zai-coding-plan/anything-goes" }, context);
    assert.match(preview, /Default child model: zai-coding-plan\/anything-goes/);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("ce3i.6: workflow_models degrades gracefully when providers are unavailable", async () => {
  const { tools, context, directory } = await makeHarness(
    async () => ({ data: { parts: [], info: {} } }),
    { config: false },
  );
  try {
    const out = JSON.parse(await tools.workflow_models.execute({ format: "json" }, context));
    assert.equal(out.session.model, null);
    assert.deepEqual(out.providers, []);
    assert.equal(out.suggested.fast, null);
    assert.equal(out.suggested.deep, null);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
