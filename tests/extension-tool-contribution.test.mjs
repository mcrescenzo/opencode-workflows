import test from "node:test";
import assert from "node:assert/strict";
import { rm } from "node:fs/promises";

import WorkflowPlugin from "../workflow-kernel/workflow-plugin.js";
import { makeExtensionDir, writeFakeExtension } from "./helpers/fake-extension.mjs";

function ctx(dir) {
  return { directory: dir, worktree: dir, client: {} };
}

// A fixture extension whose tools FACTORY echoes the injected toolKit shape from execute().
const PROBE_EXT = `export default {
  id: "tool-ext",
  tools: (toolKit) => ({
    ext_probe: toolKit.tool({
      description: "probe toolKit wiring",
      args: { echo: toolKit.schema.string().optional() },
      async execute(args, context) {
        return JSON.stringify({
          echo: args.echo ?? null,
          hasContext: Boolean(context),
          kit: {
            tool: typeof toolKit.tool,
            schemaUsable: typeof toolKit.schema?.string === "function",
            pluginContext: Boolean(toolKit.pluginContext),
            guard: typeof toolKit.assertWriteWorkflowAllowed,
          },
        });
      },
    }),
  }),
};
`;

test("an extension contributes a tool into the plugin's static tool map (factory form)", async () => {
  const dir = await makeExtensionDir();
  const extPath = await writeFakeExtension(dir, { source: PROBE_EXT });
  const pluginContext = ctx(dir);
  const hooks = await WorkflowPlugin(pluginContext, { extensions: [extPath] });

  assert.ok(hooks.tool.ext_probe, "extension tool present in the returned tool map");
  assert.equal(typeof hooks.tool.ext_probe.execute, "function");

  const out = JSON.parse(await hooks.tool.ext_probe.execute({ echo: "hi" }, { sessionID: "s" }));
  assert.equal(out.echo, "hi", "args forwarded to execute");
  assert.equal(out.hasContext, true, "ToolContext forwarded to execute");
  assert.equal(out.kit.tool, "function", "toolKit.tool injected");
  assert.equal(out.kit.schemaUsable, true, "toolKit.schema injected and usable (schema.string())");
  assert.equal(out.kit.pluginContext, true, "toolKit.pluginContext injected");
  assert.equal(out.kit.guard, "function", "toolKit.assertWriteWorkflowAllowed injected");
  await rm(dir, { recursive: true, force: true });
});

test("a plain-object tools manifest is also merged", async () => {
  const dir = await makeExtensionDir();
  const extPath = await writeFakeExtension(dir, {
    source: `export default {
  id: "plain-tool-ext",
  tools: {
    plain_tool: { description: "plain", args: {}, execute: async () => "plain-ok" },
  },
};
`,
  });
  const hooks = await WorkflowPlugin(ctx(dir), { extensions: [extPath] });
  assert.ok(hooks.tool.plain_tool, "plain-object extension tool present");
  assert.equal(await hooks.tool.plain_tool.execute({}, {}), "plain-ok");
  await rm(dir, { recursive: true, force: true });
});

test("an extension tool that collides with a core tool name rejects the factory", async () => {
  const dir = await makeExtensionDir();
  const extPath = await writeFakeExtension(dir, {
    source: `export default {
  id: "collide-core",
  tools: (toolKit) => ({ workflow_run: toolKit.tool({ description: "x", args: {}, execute: async () => "no" }) }),
};
`,
  });
  await assert.rejects(
    WorkflowPlugin(ctx(dir), { extensions: [extPath] }),
    /workflow_run|collision|reserved|already/i,
  );
  await rm(dir, { recursive: true, force: true });
});

test("two extensions claiming the same tool name reject the factory", async () => {
  const dirA = await makeExtensionDir();
  const dirB = await makeExtensionDir();
  const mk = (id) => `export default { id: "${id}", tools: (k) => ({ dupe_tool: k.tool({ description: "d", args: {}, execute: async () => "d" }) }) };\n`;
  const a = await writeFakeExtension(dirA, { source: mk("ext-a") });
  const b = await writeFakeExtension(dirB, { source: mk("ext-b") });
  await assert.rejects(
    WorkflowPlugin(ctx(dirA), { extensions: [a, b] }),
    /dupe_tool|duplicate|already|collision/i,
  );
  await rm(dirA, { recursive: true, force: true });
  await rm(dirB, { recursive: true, force: true });
});
