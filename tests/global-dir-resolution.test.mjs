import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { detectLegacyConfigDir, resolveGlobalWorkflowDir, resolveOpencodeConfigDir } from "../workflow-kernel/constants.js";

test("env override wins outright", () => {
  const dir = resolveGlobalWorkflowDir({ OPENCODE_WORKFLOWS_DIR: "/tmp/wf" }, "/anywhere");
  assert.equal(dir, path.resolve("/tmp/wf"));
});

test("detectLegacyConfigDir finds an ancestor with opencode.json + workflows/", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "wf-root-"));
  await writeFile(path.join(root, "opencode.json"), "{}");
  await mkdir(path.join(root, "workflows"), { recursive: true });
  const deep = path.join(root, "plugins", "opencode-workflows");
  await mkdir(deep, { recursive: true });
  assert.equal(detectLegacyConfigDir(deep), root);
  await rm(root, { recursive: true, force: true });
});

test("standalone (no marker) falls to the opencode CONFIG dir (XDG_CONFIG_HOME), not XDG state", async () => {
  const fakeInstall = await mkdtemp(path.join(tmpdir(), "wf-nm-"));
  const deep = path.join(fakeInstall, "node_modules", "@mcrescenzo", "opencode-workflows");
  await mkdir(deep, { recursive: true });
  // XDG_STATE_HOME must be ignored now; config dir is the home for user-authored workflows.
  const dir = resolveGlobalWorkflowDir({ XDG_CONFIG_HOME: "/xdgcfg", XDG_STATE_HOME: "/xdgstate" }, deep, "/home/u");
  assert.equal(dir, path.join("/xdgcfg", "opencode", "workflows"));
  await rm(fakeInstall, { recursive: true, force: true });
});

test("standalone (no marker, no XDG_CONFIG_HOME) falls to <home>/.config/opencode/workflows", async () => {
  const fakeInstall = await mkdtemp(path.join(tmpdir(), "wf-nm2-"));
  const deep = path.join(fakeInstall, "node_modules", "@mcrescenzo", "opencode-workflows");
  await mkdir(deep, { recursive: true });
  const dir = resolveGlobalWorkflowDir({}, deep, "/home/u");
  assert.equal(dir, path.join("/home/u", ".config", "opencode", "workflows"));
  await rm(fakeInstall, { recursive: true, force: true });
});

test("monorepo (marker present) resolves to <root>/workflows", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "wf-mono-"));
  await writeFile(path.join(root, "opencode.json"), "{}");
  await mkdir(path.join(root, "workflows"), { recursive: true });
  const plugin = path.join(root, "plugins", "opencode-workflows");
  await mkdir(plugin, { recursive: true });
  const dir = resolveGlobalWorkflowDir({}, plugin); // no env, marker present
  assert.equal(dir, path.join(root, "workflows"));
  await rm(root, { recursive: true, force: true });
});

test("resolveOpencodeConfigDir: XDG_CONFIG_HOME wins over the home default", () => {
  assert.equal(
    resolveOpencodeConfigDir({ XDG_CONFIG_HOME: "/xdgcfg" }, "/home/u"),
    path.join("/xdgcfg", "opencode"),
  );
});

test("resolveOpencodeConfigDir: falls back to <home>/.config/opencode", () => {
  assert.equal(resolveOpencodeConfigDir({}, "/home/u"), path.join("/home/u", ".config", "opencode"));
});

test("resolveOpencodeConfigDir: explicit OPENCODE_CONFIG_DIR wins outright", () => {
  assert.equal(
    resolveOpencodeConfigDir({ OPENCODE_CONFIG_DIR: "/explicit/cfg", XDG_CONFIG_HOME: "/xdgcfg" }, "/home/u"),
    path.resolve("/explicit/cfg"),
  );
});
