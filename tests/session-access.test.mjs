import test from "node:test";
import assert from "node:assert/strict";

import { sessionApi, sessionShape } from "../workflow-kernel/session-access.js";

function makeContext(shape) {
  const calls = [];
  const session = Object.fromEntries(["create", "prompt", "promptAsync", "abort", "messages", "shell"].map((name) => [name, async (input) => {
    calls.push({ name, input });
    return { data: { ok: true, name, input } };
  }]));
  return {
    calls,
    pluginContext: {
      __workflowSessionShape: shape,
      client: { session },
    },
  };
}

const input = {
  parentID: "parent-session",
  title: "child title",
  agent: "build",
  model: "openai/test-model",
  permission: [{ permission: "bash", pattern: "*", action: "deny" }],
  sessionID: "child-session",
  directory: "/tmp/project",
  limit: 20,
  body: { parts: [{ type: "text", text: "hello" }], format: { type: "json" } },
};

test("sessionApi routes v1 session envelopes", async () => {
  const { pluginContext, calls } = makeContext("v1");
  const api = sessionApi(pluginContext);

  assert.equal(sessionShape(pluginContext), "v1");
  assert.equal(api.has("create"), true);
  await api.create(input);
  await api.prompt(input);
  await api.promptAsync(input);
  await api.abort(input);
  await api.messages(input);
  await api.shell(input);

  assert.deepEqual(calls, [
    {
      name: "create",
      input: {
        body: { parentID: input.parentID, title: input.title, agent: input.agent, model: input.model, permission: input.permission },
        query: { directory: input.directory },
      },
    },
    { name: "prompt", input: { path: { id: input.sessionID }, query: { directory: input.directory }, body: input.body } },
    { name: "promptAsync", input: { path: { id: input.sessionID }, query: { directory: input.directory }, body: input.body } },
    { name: "abort", input: { path: { id: input.sessionID }, query: { directory: input.directory } } },
    { name: "messages", input: { path: { id: input.sessionID }, query: { directory: input.directory, limit: input.limit } } },
    { name: "shell", input: { path: { id: input.sessionID }, query: { directory: input.directory }, body: input.body } },
  ]);
});

test("sessionApi routes v2 session envelopes", async () => {
  const { pluginContext, calls } = makeContext("v2");
  const api = sessionApi(pluginContext);

  assert.equal(sessionShape(pluginContext), "v2");
  await api.create(input);
  await api.prompt(input);
  await api.promptAsync(input);
  await api.abort(input);
  await api.messages(input);
  await api.shell(input);

  assert.deepEqual(calls, [
    { name: "create", input: { directory: input.directory, parentID: input.parentID, title: input.title, agent: input.agent, model: input.model, permission: input.permission } },
    { name: "prompt", input: { sessionID: input.sessionID, directory: input.directory, ...input.body } },
    { name: "promptAsync", input: { sessionID: input.sessionID, directory: input.directory, ...input.body } },
    { name: "abort", input: { sessionID: input.sessionID, directory: input.directory } },
    { name: "messages", input: { sessionID: input.sessionID, directory: input.directory, limit: input.limit } },
    { name: "shell", input: { sessionID: input.sessionID, directory: input.directory, ...input.body } },
  ]);
});
