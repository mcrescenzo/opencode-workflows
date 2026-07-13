import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import plugin from "../opencode-workflows.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");

async function read(rel) {
  return await fs.readFile(path.join(ROOT, rel), "utf8");
}

async function markdownFiles(dirRel) {
  const dir = path.join(ROOT, dirRel);
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const rel = path.join(dirRel, entry.name);
    if (entry.isDirectory()) files.push(...await markdownFiles(rel));
    if (entry.isFile() && entry.name.endsWith(".md")) files.push(rel);
  }
  return files.sort();
}

test("README documentation map names active, historical, roadmap, and operator-reference docs", async () => {
  const text = await read("README.md");
  assert.match(text, /## Documentation Map/);
  for (const phrase of [
    "Active operator references",
    "Active technical contracts",
    "Historical snapshots / audits",
    "Roadmap / planning",
    "workflow_list({ format: \"json\" })",
    "docs/workflow-plugin.md#workflow-tool-reference",
  ]) {
    assert.ok(text.includes(phrase), `README documentation map missing ${phrase}`);
  }
});

test("all docs markdown files have explicit status labels or README map coverage", async () => {
  const readme = await read("README.md");
  for (const rel of await markdownFiles("docs")) {
    const text = await read(rel);
    const hasStatus = /^> Status:/m.test(text);
    const mapped = readme.includes(rel);
    assert.ok(hasStatus || mapped, `${rel} must have a Status banner or be named in the README docs map`);
  }
});

test("workflow tool reference lists every registered workflow tool and approval terms", async () => {
  const hooks = await plugin({}, {});
  const registered = Object.keys(hooks.tool).filter((k) => k.startsWith("workflow_")).sort();
  assert.ok(registered.length > 0, "plugin factory must register workflow_* tools");

  const doc = await read("docs/workflow-plugin.md");
  assert.match(doc, /## Workflow Tool Reference/);

  const documented = [...new Set([...doc.matchAll(/`(workflow_\w+)`/g)].map((m) => m[1]))].sort();

  for (const tool of registered) {
    assert.ok(documented.includes(tool), `registered tool ${tool} must appear as a backticked code span in the tool reference`);
  }
  for (const tool of documented) {
    assert.ok(registered.includes(tool), `documented tool ${tool} must be registered by the plugin factory`);
  }

  // Design C deleted the live-gate probe subsystem and its `approvalIntent: "probe"` vocabulary
  // along with the `workflow_live_gates` tool; "probe" is no longer a valid approvalIntent value
  // anywhere in the kernel, so it is intentionally absent from this list.
  for (const term of [
    "approvalHash",
    "approvedSourceHash",
    "baseCommit",
    "diffPlanHash",
    "domainMutationHash",
    'approvalIntent: "apply"',
  ]) {
    assert.ok(doc.includes(term), `tool reference missing ${term}`);
  }
});
