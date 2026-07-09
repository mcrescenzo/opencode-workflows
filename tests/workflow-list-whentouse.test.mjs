import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { makeHarness } from "./helpers/harness.mjs";

const WORKFLOW_WITH_WHENTOUSE = `export const meta = {
  name: "wt-probe",
  description: "probe",
  whenToUse: "When the user wants a whenToUse surfacing probe. ${"x".repeat(300)}",
};
return { ok: true };
`;

test("workflow_list surfaces meta.whenToUse, truncated to 240 chars", async () => {
  const { tools, context, directory } = await makeHarness(async () => ({ data: { parts: [], info: {} } }));
  try {
    const projDir = path.join(directory, ".opencode", "workflows");
    await fs.mkdir(projDir, { recursive: true });
    await fs.writeFile(path.join(projDir, "wt-probe.js"), WORKFLOW_WITH_WHENTOUSE, "utf8");

    const listing = JSON.parse(await tools.workflow_list.execute({ format: "json" }, context));
    const entries = Array.isArray(listing) ? listing : listing.workflows ?? listing.entries;
    const probe = entries.find((e) => e.name === "wt-probe");
    assert.ok(probe, "wt-probe must be listed");
    assert.ok(probe.invocation.whenToUse.startsWith("When the user wants a whenToUse surfacing probe."));
    assert.ok(probe.invocation.whenToUse.length <= 240, "whenToUse must truncate to 240 chars");
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("workflow_list omits whenToUse when the meta does not declare it", async () => {
  const { tools, context, directory } = await makeHarness(async () => ({ data: { parts: [], info: {} } }));
  try {
    const projDir = path.join(directory, ".opencode", "workflows");
    await fs.mkdir(projDir, { recursive: true });
    await fs.writeFile(path.join(projDir, "no-wt.js"), `export const meta = { name: "no-wt" };\nreturn 1;\n`, "utf8");

    const listing = JSON.parse(await tools.workflow_list.execute({ format: "json" }, context));
    const entries = Array.isArray(listing) ? listing : listing.workflows ?? listing.entries;
    const probe = entries.find((e) => e.name === "no-wt");
    assert.ok(probe, "no-wt must be listed");
    assert.equal(Object.hasOwn(probe.invocation, "whenToUse"), false);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
