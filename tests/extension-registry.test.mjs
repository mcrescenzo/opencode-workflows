import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { createExtensionRegistry } from "../workflow-kernel/extension-registry.js";

function fakeDef(overrides = {}) {
  return {
    id: "beads",
    drainAdapters: {
      beads: {
        createAdapter: () => ({}),
        supportsAutoApply: true,
        mutationOperations: ["beads.close"],
      },
    },
    mutationHandlers: { "beads.close": () => ({ ok: true }) },
    assetDirs: { workflows: "./workflows", commands: "./commands", skills: "./skills" },
    ...overrides,
  };
}

test("register exposes drain adapter and mutation handler lookups", () => {
  const reg = createExtensionRegistry();
  reg.register(fakeDef(), { baseDir: "/ext/beads" });
  assert.equal(reg.drainAdapter("beads").supportsAutoApply, true);
  assert.equal(typeof reg.mutationHandler("beads.close"), "function");
  assert.equal(reg.drainAdapter("missing"), undefined);
  assert.equal(reg.mutationHandler("missing.op"), undefined);
});

test("rejects a definition without an id", () => {
  const reg = createExtensionRegistry();
  assert.throws(() => reg.register({ drainAdapters: {} }, { baseDir: "/x" }), /id/i);
});

test("rejects a conflicting duplicate adapter name from a different extension", () => {
  const reg = createExtensionRegistry();
  reg.register(fakeDef({ id: "beads" }), { baseDir: "/a" });
  assert.throws(
    () => reg.register(fakeDef({ id: "other" }), { baseDir: "/b" }),
    /duplicate|already/i,
  );
});

test("idempotent when the same extension id re-registers", () => {
  const reg = createExtensionRegistry();
  const def = fakeDef({ id: "beads" });
  reg.register(def, { baseDir: "/a" });
  assert.doesNotThrow(() => reg.register(def, { baseDir: "/a" }));
  assert.equal(reg.drainAdapter("beads").supportsAutoApply, true);
});

test("rejects a conflicting duplicate mutation operation from a different extension", () => {
  const reg = createExtensionRegistry();
  reg.register({ id: "a", mutationHandlers: { "x.op": () => {} } }, { baseDir: "/a" });
  assert.throws(
    () => reg.register({ id: "b", mutationHandlers: { "x.op": () => {} } }, { baseDir: "/b" }),
    /duplicate|already/i,
  );
});

test("assetDirs resolves extension dirs relative to the extension module dir", () => {
  const reg = createExtensionRegistry();
  reg.register(fakeDef(), { baseDir: "/ext/beads" });
  const dirs = reg.assetDirs();
  assert.deepEqual(dirs.workflows, [path.join("/ext/beads", "workflows")]);
  assert.deepEqual(dirs.commands, [path.join("/ext/beads", "commands")]);
  assert.deepEqual(dirs.skills, [path.join("/ext/beads", "skills")]);
});

test("loadExtensions resolves a relative module path against the config dir, imports, and registers", async () => {
  const reg = createExtensionRegistry();
  const configDir = "/home/u/.config/opencode";
  const seen = [];
  const importer = async (resolved) => {
    seen.push(resolved);
    return { default: fakeDef() };
  };
  await reg.loadExtensions(["./workflow-extensions/beads/beads-extension.js"], { configDir, importer });
  assert.equal(seen[0], path.join(configDir, "workflow-extensions/beads/beads-extension.js"));
  assert.equal(reg.drainAdapter("beads").supportsAutoApply, true);
  // asset dirs resolve relative to the extension module's own dir, not the config dir root:
  assert.deepEqual(reg.assetDirs().workflows, [
    path.join(configDir, "workflow-extensions/beads", "workflows"),
  ]);
});

test("loadExtensions accepts an absolute module path as-is", async () => {
  const reg = createExtensionRegistry();
  const seen = [];
  const importer = async (resolved) => {
    seen.push(resolved);
    return { default: fakeDef() };
  };
  await reg.loadExtensions(["/abs/ext/beads-extension.js"], { configDir: "/cfg", importer });
  assert.equal(seen[0], "/abs/ext/beads-extension.js");
});

test("loadExtensions supports a factory-function default export", async () => {
  const reg = createExtensionRegistry();
  const importer = async () => ({ default: () => fakeDef() });
  await reg.loadExtensions(["/abs/x.js"], { configDir: "/cfg", importer });
  assert.equal(reg.drainAdapter("beads").supportsAutoApply, true);
});

test("loadExtensions fails loud when an extension cannot be imported", async () => {
  const reg = createExtensionRegistry();
  const importer = async () => {
    throw new Error("boom");
  };
  await assert.rejects(
    reg.loadExtensions(["/abs/x.js"], { configDir: "/cfg", importer }),
    /\/abs\/x\.js/,
  );
});

test("loadExtensions fails loud on an invalid definition", async () => {
  const reg = createExtensionRegistry();
  const importer = async () => ({ default: {} }); // no id
  await assert.rejects(reg.loadExtensions(["/abs/x.js"], { configDir: "/cfg", importer }), /id/i);
});

test("tools(): a tools factory is called with the toolKit and merged", () => {
  const reg = createExtensionRegistry();
  let seenKit;
  reg.register({ id: "t", tools: (kit) => { seenKit = kit; return { my_tool: { from: kit.marker } }; } }, { baseDir: "/t" });
  const kit = { marker: "KIT" };
  const merged = reg.tools(kit);
  assert.equal(seenKit, kit, "factory received the toolKit");
  assert.deepEqual(merged.my_tool, { from: "KIT" });
});

test("tools(): a plain-object tools manifest is merged as-is", () => {
  const reg = createExtensionRegistry();
  reg.register({ id: "t", tools: { my_tool: { ok: true } } }, { baseDir: "/t" });
  assert.deepEqual(reg.tools({}).my_tool, { ok: true });
});

test("tools(): rejects a reserved (core) tool name", () => {
  const reg = createExtensionRegistry();
  reg.register({ id: "t", tools: { workflow_run: {} } }, { baseDir: "/t" });
  assert.throws(() => reg.tools({}, ["workflow_run"]), /workflow_run|reserved/i);
});

test("tools(): rejects a duplicate tool name across extensions", () => {
  const reg = createExtensionRegistry();
  reg.register({ id: "a", tools: { dupe: {} } }, { baseDir: "/a" });
  reg.register({ id: "b", tools: { dupe: {} } }, { baseDir: "/b" });
  assert.throws(() => reg.tools({}), /dupe|duplicate|already/i);
});

test("register(): rejects a tools field that is neither object nor function", () => {
  const reg = createExtensionRegistry();
  assert.throws(() => reg.register({ id: "t", tools: 42 }, { baseDir: "/t" }), /tools/i);
});

test("independent registries do not interfere (double-instantiation safety)", () => {
  const a = createExtensionRegistry();
  const b = createExtensionRegistry();
  a.register(fakeDef(), { baseDir: "/a" });
  b.register(fakeDef(), { baseDir: "/b" }); // same id+adapter, different registry → no throw
  assert.equal(a.drainAdapter("beads").supportsAutoApply, true);
  assert.equal(b.drainAdapter("beads").supportsAutoApply, true);
});
