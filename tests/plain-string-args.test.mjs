import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { makeHarness } from "./helpers/harness.mjs";

const STRING_OK_SOURCE = `export const meta = {
  name: "string-args-probe",
  argsSchema: { type: ["object", "string", "null"], properties: { a: { type: "integer" } } },
};
return { gotType: typeof args, value: args };
`;
const OBJECT_ONLY_SOURCE = `export const meta = {
  name: "object-args-probe",
  argsSchema: { type: "object", properties: { a: { type: "integer" } } },
};
return { value: args };
`;

async function runApproved(tools, context, request) {
  const preview = await tools.workflow_run.execute(request, context);
  const match = preview.match(/approvalHash: ([a-f0-9]{64})/);
  assert.ok(match, `missing approvalHash in preview: ${preview}`);
  const output = await tools.workflow_run.execute({ ...request, approve: true, approvalHash: match[1] }, context);
  const runId = output.match(/Workflow ([0-9a-f-]{36}) (?:completed|failed)/);
  assert.ok(runId, `run did not finish: ${output}`);
  const status = JSON.parse(await tools.workflow_status.execute({ runId: runId[1], format: "json", detail: "result" }, context));
  return status.result?.output ?? status.result;
}

test("a plain (non-JSON) string args passes through to the guest verbatim when argsSchema allows strings", async () => {
  const { tools, context, directory } = await makeHarness(async () => ({ data: { parts: [], info: {} } }));
  try {
    const result = await runApproved(tools, context, { source: STRING_OK_SOURCE, args: "why is the sky blue?" });
    assert.equal(result.gotType, "string");
    assert.equal(result.value, "why is the sky blue?");
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("a JSON-object string args is still normalized to the object it encodes (hash-drift fix preserved)", async () => {
  const { tools, context, directory } = await makeHarness(async () => ({ data: { parts: [], info: {} } }));
  try {
    const result = await runApproved(tools, context, { source: STRING_OK_SOURCE, args: '{"a": 1}' });
    assert.equal(result.gotType, "object");
    assert.deepEqual(result.value, { a: 1 });
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("a JSON-looking but invalid string args still fails loudly at plan time", async () => {
  const { tools, context, directory } = await makeHarness(async () => ({ data: { parts: [], info: {} } }));
  try {
    await assert.rejects(
      tools.workflow_run.execute({ source: STRING_OK_SOURCE, args: "{oops" }, context),
      /not valid JSON/,
    );
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("a plain string args is rejected by an object-only argsSchema (argsSchema stays the gate)", async () => {
  const { tools, context, directory } = await makeHarness(async () => ({ data: { parts: [], info: {} } }));
  try {
    await assert.rejects(
      tools.workflow_run.execute({ source: OBJECT_ONLY_SOURCE, args: "not an object" }, context),
      (err) => /args/i.test(err.message),
    );
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
