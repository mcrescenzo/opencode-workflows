import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";

import {
  assertWriteWorkflowAllowed,
  configureWorkflowPermissions,
  WORKFLOW_INSPECT_TOOLS,
  WORKFLOW_MUTATING_TOOLS,
  WORKFLOW_TOOLS,
} from "../workflow-kernel/authority-policy.js";
import { sessionPermissionEchoStatus } from "../workflow-kernel/child-agent-runner.js";
import { makeHarness } from "./helpers/harness.mjs";

async function runApproved(tools, context, source) {
  const preview = await tools.workflow_run.execute({ source }, context);
  const match = preview.match(/approvalHash: ([a-f0-9]{64})/);
  assert.ok(match, `missing approvalHash in preview: ${preview}`);
  return await tools.workflow_run.execute({ source, approve: true, approvalHash: match[1] }, context);
}

function runIdFrom(output) {
  const match = output.match(/Workflow ([0-9a-f-]{36}) /);
  assert.ok(match, `missing run id in output: ${output}`);
  return match[1];
}

async function statusForRunOutput(tools, context, output) {
  return JSON.parse(await tools.workflow_status.execute({ runId: runIdFrom(output), format: "json", detail: "full" }, context));
}

function permissionEchoSource(name) {
  return `export const meta = { name: ${JSON.stringify(name)}, profile: "read-only-review", maxAgents: 1 };
return await agent("inspect safely", { readOnly: true });`;
}

function textPromptResult(text = "ok") {
  return { data: { parts: [{ type: "text", text }], info: { tokens: { input: 1, output: 1, reasoning: 0 }, cost: 0 } } };
}

test("workflow write guard blocks plan but permits write-capable non-build callers", () => {
  assert.throws(
    () => assertWriteWorkflowAllowed({ agent: "plan" }, "workflow_run"),
    /workflow_run is not available in plan mode/,
  );

  assert.doesNotThrow(() => assertWriteWorkflowAllowed({ agent: "build" }, "workflow_run"));
  assert.doesNotThrow(() => assertWriteWorkflowAllowed({ agent: "proxy" }, "workflow_run"));
  assert.doesNotThrow(() => assertWriteWorkflowAllowed({}, "workflow_run"));
});

test("workflow permission config preserves plan inspect-only safety without requiring build callers", () => {
  const cfg = {
    permission: { read: "allow" },
    agent: {
      build: { permission: {} },
      plan: { permission: { edit: "deny" } },
      proxy: { permission: { workflow_run: "allow", workflow_status: "allow" } },
      summary: { permission: {} },
    },
  };

  configureWorkflowPermissions(cfg);

  for (const name of WORKFLOW_TOOLS) {
    assert.equal(cfg.permission[name], "allow", `top-level ${name}`);
    assert.equal(cfg.agent.build.permission[name], "allow", `build ${name}`);
  }
  for (const name of WORKFLOW_INSPECT_TOOLS) {
    assert.equal(cfg.agent.plan.permission[name], "allow", `plan inspect ${name}`);
  }
  for (const name of WORKFLOW_MUTATING_TOOLS) {
    assert.equal(cfg.agent.plan.permission[name], "deny", `plan mutating ${name}`);
  }

  assert.equal(cfg.agent.proxy.permission.workflow_run, "allow");
  assert.equal(cfg.agent.proxy.permission.workflow_status, "allow");
  assert.equal(cfg.agent.proxy.permission.workflow_apply, undefined);
  assert.equal(cfg.agent.summary.permission.workflow_run, undefined);
});

test("real child lane records verified permission echo before prompting", async () => {
  const { tools, context, directory, calls } = await makeHarness(async () => textPromptResult(), {
    session: (_prompt, _options, callLog) => ({
      async create(input) {
        callLog.create.push(input);
        return { data: { id: "child-verified", permission: input.body.permission.map((rule) => ({ ...rule })) } };
      },
      async prompt(input) {
        callLog.prompt.push(input);
        return textPromptResult("verified");
      },
      async abort(input) {
        callLog.abort.push(input);
        return { data: { ok: true } };
      },
    }),
  });
  try {
    const output = await runApproved(tools, context, permissionEchoSource("permission-echo-verified"));
    const status = await statusForRunOutput(tools, context, output);
    const lane = status.laneRecords.find((record) => record.childID === "child-verified");

    assert.equal(calls.prompt.length, 1);
    assert.equal(lane.permissionEcho.state, "verified");
    assert.equal(lane.permissionEcho.expectedCount, calls.create[0].body.permission.length);
    assert.equal(lane.permissionEcho.echoedCount, calls.create[0].body.permission.length);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("real child lane fails closed on explicit permission echo mismatch before prompt", async () => {
  const { tools, context, directory, calls } = await makeHarness(async () => textPromptResult(), {
    session: (_prompt, _options, callLog) => ({
      async create(input) {
        callLog.create.push(input);
        return { data: { id: "child-mismatch", permission: [{ permission: "bash", pattern: "*", action: "allow" }] } };
      },
      async prompt(input) {
        callLog.prompt.push(input);
        return textPromptResult("must not run");
      },
      async abort(input) {
        callLog.abort.push(input);
        return { data: { ok: true } };
      },
    }),
  });
  try {
    await assert.rejects(
      runApproved(tools, context, permissionEchoSource("permission-echo-mismatch")),
      /permission echo mismatch/i,
    );

    assert.equal(calls.create.length, 1);
    assert.equal(calls.prompt.length, 0, "mismatched permissions must fail before session.prompt");

    const statuses = JSON.parse(await tools.workflow_status.execute({ format: "json", detail: "compact", limit: 50 }, context));
    const failed = statuses.find((entry) => entry.meta?.name === "permission-echo-mismatch");
    assert.ok(failed, "failed workflow should be visible in status");
    const status = JSON.parse(await tools.workflow_status.execute({ runId: failed.id, format: "json", detail: "full" }, context));
    const lane = status.laneRecords.find((record) => record.childID === "child-mismatch");
    assert.equal(lane.outcome, "failure");
    assert.equal(lane.permissionEcho.state, "mismatch");
    assert.ok(lane.permissionEcho.missing.length > 0, "expected rules removed by the runtime should be surfaced");
    assert.ok(lane.permissionEcho.unexpected.length > 0, "unexpected broad grants should be surfaced");
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("real child lane surfaces no-echo permission runtime without blocking compatible clients", async () => {
  const { tools, context, directory, calls } = await makeHarness(async () => textPromptResult("no echo"));
  try {
    const output = await runApproved(tools, context, permissionEchoSource("permission-echo-not-echoed"));
    const status = await statusForRunOutput(tools, context, output);
    const lane = status.laneRecords.find((record) => record.childID === "child-1");

    assert.equal(calls.prompt.length, 1);
    assert.equal(lane.outcome, "success");
    assert.equal(lane.permissionEcho.state, "not-echoed");
    assert.equal(lane.permissionEcho.expectedCount, calls.create[0].body.permission.length);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("sessionPermissionEchoStatus treats extra broad grants as a mismatch", () => {
  const expected = [{ permission: "bash", pattern: "*", action: "deny" }];
  const actual = { data: { id: "child", permission: [...expected, { permission: "edit", pattern: "*", action: "allow" }] } };
  const status = sessionPermissionEchoStatus(actual, expected);

  assert.equal(status.state, "mismatch");
  assert.deepEqual(status.unexpected, [{ permission: "edit", pattern: "*", action: "allow" }]);
});
