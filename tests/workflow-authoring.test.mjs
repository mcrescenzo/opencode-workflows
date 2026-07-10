// workflow_save / workflow_roles / workflow_templates / workflow_template_save /
// first-run template / public tool-registration schema / external & trusted scriptPath
// admission.
//
// Split out of the former tests/workflow-run.test.mjs monolith (bd opencode-workflows-fnop.18).
// These tests exercise the authoring / registration / admission surface: saving workflows,
// role and template catalog tooling, the public tool-registration schema shapes, the shipped
// first-run template contract, and scriptPath trusted-source admission.

import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { makeHarness, makeTempDir } from "./helpers/harness.mjs";
import { projectWorkflowDir, parseWorkflowSource } from "../workflow-kernel/workflow-source.js";
import { resolveRunAuthority } from "../workflow-kernel/authority-policy.js";
import { hash } from "../workflow-kernel/text-json.js";
import { MAX_SOURCE_BYTES } from "../workflow-kernel/constants.js";
import { DEFAULT_TEMPLATES, listTemplates } from "../workflow-kernel/role-template-loading.js";

async function tempDir() {
  return await fs.mkdtemp(path.join(os.tmpdir(), "workflow-apply-security-"));
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function runIdFrom(output) {
  const match = output.match(/Workflow ([0-9a-f-]{36}) (?:completed|started|awaiting diff approval|review-required)/);
  assert.ok(match, `missing run id in output: ${output}`);
  return match[1];
}

async function runApprovedRequest(tools, context, request) {
  const preview = await tools.workflow_run.execute(request, context);
  const match = preview.match(/approvalHash: ([a-f0-9]{64})/);
  assert.ok(match, `missing approvalHash in preview: ${preview}`);
  return await tools.workflow_run.execute({ ...request, approve: true, approvalHash: match[1] }, context);
}

const EXTERNAL_WORKFLOW_SOURCE = `export const meta = { name: "external-source", profile: "read-only-review" };
return true;`;

async function writeExternalWorkflow() {
  const outsideDir = await tempDir();
  const externalFile = path.join(outsideDir, "external-workflow.js");
  await fs.writeFile(externalFile, EXTERNAL_WORKFLOW_SOURCE, "utf8");
  return { outsideDir, externalFile };
}

test("external scriptPath fails closed without allowExternalScriptPath", async () => {
  const { tools, context, directory } = await makeHarness(async () => {
    throw new Error("external scriptPath must fail before any child prompt");
  });
  const { outsideDir, externalFile } = await writeExternalWorkflow();
  try {
    await assert.rejects(
      tools.workflow_run.execute({ scriptPath: externalFile }, context),
      /scriptPath resolves outside trusted workflow roots/,
    );
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
    await fs.rm(outsideDir, { recursive: true, force: true });
  }
});

test("external scriptPath fails closed even when the target file does not exist", async () => {
  const { tools, context, directory } = await makeHarness(async () => {
    throw new Error("missing external file must fail closed on trust, not on stat");
  });
  const { outsideDir } = await writeExternalWorkflow();
  try {
    const missing = path.join(outsideDir, "does-not-exist.js");
    await assert.rejects(
      tools.workflow_run.execute({ scriptPath: missing }, context),
      /scriptPath resolves outside trusted workflow roots/,
    );
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
    await fs.rm(outsideDir, { recursive: true, force: true });
  }
});

test("external scriptPath with traversal segments fails closed after normalization", async () => {
  const { tools, context, directory } = await makeHarness(async () => {
    throw new Error("traversal scriptPath must fail before any child prompt");
  });
  const { outsideDir, externalFile } = await writeExternalWorkflow();
  try {
    // Relative path with leading ".." that resolves out of the project root into outsideDir.
    const traversalScriptPath = path.relative(context.directory, externalFile);
    assert.ok(traversalScriptPath.startsWith(".."), `expected a traversal relative path, got ${traversalScriptPath}`);
    await assert.rejects(
      tools.workflow_run.execute({ scriptPath: traversalScriptPath }, context),
      new RegExp(`scriptPath resolves outside trusted workflow roots: ${escapeRegExp(externalFile.replace(/\\/g, "/"))}`),
    );
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
    await fs.rm(outsideDir, { recursive: true, force: true });
  }
});

test("external scriptPath with allowExternalScriptPath opt-in previews path + hash and runs", async () => {
  const { tools, context, directory } = await makeHarness(async () => {
    throw new Error("read-only external workflow should not call child prompts");
  });
  const { outsideDir, externalFile } = await writeExternalWorkflow();
  try {
    const request = { scriptPath: externalFile, allowExternalScriptPath: true };
    const preview = await tools.workflow_run.execute(request, context);

    assert.match(preview, new RegExp(`Source: ${escapeRegExp(externalFile.replace(/\\/g, "/"))}`));
    assert.match(preview, /sourceHash: [a-f0-9]{64}/);
    assert.match(preview, /External source \(allowExternalScriptPath opt-in\): true/);
    assert.equal(hash(EXTERNAL_WORKFLOW_SOURCE), preview.match(/sourceHash: ([a-f0-9]{64})/)[1]);

    const output = await runApprovedRequest(tools, context, request);
    assert.match(output, /completed/);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
    await fs.rm(outsideDir, { recursive: true, force: true });
  }
});

test("scriptPath inside the trusted project workflow root runs without opt-in", async () => {
  const { tools, context, directory } = await makeHarness(async () => {
    throw new Error("trusted project-root workflow should not call child prompts");
  });
  try {
    const projectRoot = projectWorkflowDir(context);
    await fs.mkdir(projectRoot, { recursive: true });
    const trustedFile = path.join(projectRoot, "trusted-project.js");
    await fs.writeFile(trustedFile, EXTERNAL_WORKFLOW_SOURCE, "utf8");

    const output = await runApprovedRequest(tools, context, {
      scriptPath: ".opencode/workflows/trusted-project.js",
    });
    assert.match(output, /completed/);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("named project workflow resolves from a trusted root without opt-in (no regression)", async () => {
  const { tools, context, directory } = await makeHarness(async () => {
    throw new Error("named workflow should not call child prompts");
  });
  try {
    const projectRoot = projectWorkflowDir(context);
    await fs.mkdir(projectRoot, { recursive: true });
    await fs.writeFile(path.join(projectRoot, "named-project.js"), EXTERNAL_WORKFLOW_SOURCE, "utf8");

    const preview = await tools.workflow_run.execute({ name: "named-project" }, context);
    assert.match(preview, new RegExp(`Source: ${escapeRegExp(path.join(projectRoot, "named-project.js").replace(/\\/g, "/"))}`));
    assert.match(preview, /sourceHash: [a-f0-9]{64}/);
    assert.doesNotMatch(preview, /External source/);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("by-name preview reports approveByReference: false (approve-by-reference is inline-source only)", async () => {
  const { tools, context, directory } = await makeHarness(async () => {
    throw new Error("named workflow should not call child prompts");
  });
  try {
    const projectRoot = projectWorkflowDir(context);
    await fs.mkdir(projectRoot, { recursive: true });
    await fs.writeFile(path.join(projectRoot, "named-project.js"), EXTERNAL_WORKFLOW_SOURCE, "utf8");

    const preview = JSON.parse(await tools.workflow_run.execute({ name: "named-project", format: "json" }, context));
    assert.equal(preview.approveByReference, false);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("workflow_save rejects duplicates and invalid sources", async () => {
  const { tools, context, directory } = await makeHarness(async () => {
    throw new Error("workflow_save validation must not prompt a model");
  });
  try {
    const source = `export const meta = { name: "saved-test", profile: "read-only-review" };
return { ok: true };`;
    const saved = await tools.workflow_save.execute({ name: "saved-test", source, scope: "project" }, context);
    assert.match(saved, /Saved workflow saved-test/);

    await assert.rejects(
      () => tools.workflow_save.execute({ name: "saved-test", source, scope: "project" }, context),
      /Workflow already exists: .*saved-test\.js\. Pass overwrite: true to replace it\./,
    );
    await assert.rejects(
      () => tools.workflow_save.execute({ name: "missing-source", scope: "project" }, context),
      /workflow_save requires `source`/,
    );
    await assert.rejects(
      () => tools.workflow_save.execute({ name: "too-large", source: "x".repeat(MAX_SOURCE_BYTES + 1), scope: "project" }, context),
      /Workflow source exceeds 524288 bytes/,
    );
    await assert.rejects(
      () => tools.workflow_save.execute({ name: "bad-syntax", source: "export const meta = {", scope: "project" }, context),
      /Unexpected|Unterminated|Parse error/i,
    );
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("workflow_save defaults to project scope and requires explicit global intent", async () => {
  const { tools, context, directory } = await makeHarness(async () => {
    throw new Error("workflow_save validation must not prompt a model");
  });
  try {
    const name = `default-project-${crypto.randomUUID().slice(0, 8)}`;
    const source = `export const meta = { name: ${JSON.stringify(name)}, profile: "read-only-review" };
return { ok: true };`;
    const saved = await tools.workflow_save.execute({ name, source }, context);
    const projectPath = path.join(projectWorkflowDir(context), `${name}.js`);
    assert.match(saved, new RegExp(`Path: ${escapeRegExp(projectPath)}`));
    assert.equal(await fs.readFile(projectPath, "utf8"), source);

    await assert.rejects(
      () => tools.workflow_save.execute({ name: `${name}-global`, source, scope: "global" }, context),
      /global scope requires globalScopeIntent: "save-global-workflow"/,
    );
    await assert.rejects(
      () => tools.workflow_save.execute({
        name: `${name}-global-invalid`,
        source: "export const meta = {",
        scope: "global",
        globalScopeIntent: "save-global-workflow",
      }, context),
      /Unexpected|Unterminated|Parse error/i,
    );
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("workflow_roles surfaces roles.json defaults with prompt hash provenance", async () => {
  const directory = await makeTempDir("workflow-roles-defaults-");
  const roleDir = path.join(directory, "roles");
  await fs.mkdir(roleDir, { recursive: true });
  await fs.writeFile(path.join(roleDir, "implementer.md"), "custom implementer role", "utf8");
  await fs.writeFile(path.join(roleDir, "roles.json"), JSON.stringify({
    roles: {
      implementer: { tier: "deep", readOnly: true, timeoutMs: 3000 },
    },
  }), "utf8");
  const { tools, context } = await makeHarness(async () => {
    throw new Error("workflow_roles must not prompt a model");
  }, {
    directory,
    pluginContext: { __workflowRoleDir: roleDir },
  });

  try {
    const roles = JSON.parse(await tools.workflow_roles.execute({ format: "json" }, context));
    const implementer = roles.find((entry) => entry.name === "implementer");
    assert.ok(implementer, "missing implementer role");
    assert.equal(implementer.userModified, true);
    assert.equal(typeof implementer.contentHash, "string");
    assert.equal(typeof implementer.shippedHash, "string");
    assert.deepEqual(implementer.defaults, { tier: "deep", readOnly: true, timeoutMs: 3000 });
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("public workflow tool schemas describe non-obvious arguments", async () => {
  const { tools, directory } = await makeHarness(async () => {
    throw new Error("schema metadata inspection must not prompt a model");
  });
  try {
    assert.match(tools.workflow_apply.description, /workflow_status/);
    assert.match(tools.workflow_apply.description, /workflow_apply_approval_mismatch/);
    assert.ok(
      !/apply-preview/.test(tools.workflow_apply.description),
      "workflow_apply must not cite the nonexistent workflow_run apply-preview",
    );
    assert.ok(
      !("reconcile" in tools.workflow_status.args),
      "workflow_status must not expose the always-rejected reconcile arg",
    );
    for (const [toolName, fields] of Object.entries({
      workflow_apply: ["runId", "approvedSourceHash", "baseCommit", "diffPlanHash", "domainMutationHash", "approvalIntent"],
      workflow_cleanup: ["dryRun", "keep", "interruptedTtlMs"],
      workflow_salvage: ["runId", "callIds", "approve", "approvalHash"],
      workflow_template_save: ["template", "name", "scope", "overwrite"],
      workflow_run: ["profile", "authority", "autoApprove", "background", "maxCost", "maxTokens", "maxRuntimeMs", "resumeRunId", "resumePolicy", "editAndResume"],
      workflow_save: ["name", "source", "scope", "globalScopeIntent", "overwrite"],
    })) {
      for (const field of fields) {
        assert.equal(
          typeof tools[toolName].args[field].description,
          "string",
          `${toolName}.${field} must expose a schema description`,
        );
        assert.ok(
          tools[toolName].args[field].description.length > 12,
          `${toolName}.${field} description should be useful`,
        );
      }
    }
    assert.ok(
      !/\bv2\b/i.test(tools.workflow_templates.description) && !/\bv2\b/i.test(tools.workflow_template_save.description),
      "template tool descriptions must not use undefined v2 jargon",
    );
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("first-run-slice template is a bounded read-only listing surface", async () => {
  // Surface contract for bd opencode-workflows-ux.2: the shipped first-run slice must
  // stay the smallest safe shape — read-only-review, bounded agents, no edit gate — so a
  // fresh agent can validate one slice before fanning out.
  const source = DEFAULT_TEMPLATES["first-run-slice"];
  assert.equal(typeof source, "string", "first-run-slice template must ship in DEFAULT_TEMPLATES");

  const { meta, body } = parseWorkflowSource(source);
  assert.equal(meta.name, "first-run-slice");
  assert.equal(meta.profile, "read-only-review");
  assert.ok(meta.maxAgents >= 1 && meta.maxAgents <= 2, `maxAgents must stay small, got ${meta.maxAgents}`);
  assert.ok(meta.concurrency >= 1 && meta.concurrency <= 2, `concurrency must stay small, got ${meta.concurrency}`);
  // Pure-JS synthesis: at most the lane fanout uses agent(); the return is plain JS.
  assert.ok(body.includes("await parallel("), "template must fan out scoped parallel lanes");
  assert.ok(/return\s*{/.test(body), "template must synthesize and return a plain-JS envelope");

  // read-only-review denies edits and requests no apply gate, so no guest write can land.
  const authority = resolveRunAuthority(meta, {});
  assert.equal(authority.readOnly, true);
  assert.equal(authority.edit, false);
  assert.equal(authority.mode, "readOnly");
  assert.equal(authority.editGate, "not-requested");

  const templates = JSON.parse(await listTemplates({ format: "json" }));
  const entry = templates.find((item) => item.name === "first-run-slice");
  assert.ok(entry, "first-run-slice must appear in workflow_templates listing");
  assert.match(entry.sourceHash, /^[a-f0-9]{12,}$/);
  assert.equal(typeof entry.byteLength, "number");
  assert.equal(typeof entry.lineCount, "number");
  assert.equal(entry.source, undefined);
});

test("workflow_templates retrieves shipped template source explicitly", async () => {
  const { tools, context, directory } = await makeHarness(async () => {
    throw new Error("template listing must not prompt a model");
  });
  try {
    const templates = JSON.parse(await tools.workflow_templates.execute({ format: "json", template: "first-run-slice", includeSource: true }, context));
    assert.equal(templates.length, 1);
    assert.equal(templates[0].name, "first-run-slice");
    assert.equal(templates[0].source, DEFAULT_TEMPLATES["first-run-slice"]);
    assert.equal(templates[0].byteLength, Buffer.byteLength(templates[0].source, "utf8"));
    assert.ok(templates[0].lineCount > 1);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("workflow_template_save saves templates, rejects unsafe calls, and honors overwrite", async () => {
  const { tools, context, directory } = await makeHarness(async () => {
    throw new Error("template save must not prompt a model");
  });
  try {
    const saved = await tools.workflow_template_save.execute({
      template: "first-run-slice",
      name: "saved-template",
      scope: "project",
    }, context);
    const filePath = path.join(projectWorkflowDir(context), "saved-template.js");
    assert.match(saved, /Saved workflow saved-template/);
    assert.equal(await fs.readFile(filePath, "utf8"), DEFAULT_TEMPLATES["first-run-slice"]);

    await assert.rejects(
      () => tools.workflow_template_save.execute({
        template: "first-run-slice",
        name: "saved-template",
        scope: "project",
      }, context),
      /Workflow already exists: .*saved-template\.js\. Pass overwrite: true to replace it\./,
    );

    const overwritten = await tools.workflow_template_save.execute({
      template: "scoped-parallel",
      name: "saved-template",
      scope: "project",
      overwrite: true,
    }, context);
    assert.match(overwritten, /Saved workflow saved-template/);
    assert.equal(await fs.readFile(filePath, "utf8"), DEFAULT_TEMPLATES["scoped-parallel"]);

    await assert.rejects(
      () => tools.workflow_template_save.execute({ template: "does-not-exist", scope: "project" }, context),
      /Unknown workflow template: does-not-exist/,
    );
    await assert.rejects(
      () => tools.workflow_template_save.execute({ template: "first-run-slice", scope: "project" }, { ...context, agent: "plan" }),
      /workflow_template_save is not available in plan mode/,
    );
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("first-run-slice template runs read-only, synthesizes in pure JS, and writes no files", async () => {
  // Lanes echo a structured finding keyed off the slice in their prompt. The "blank"
  // slice returns empty evidence so we can prove the pure-JS synthesis drops
  // unsupported claims rather than promoting them.
  const { tools, context, directory, calls } = await makeHarness(async (input) => {
    const text = String(input?.body?.parts?.[0]?.text ?? "");
    const match = text.match(/Read-only slice "([^"]+)"/);
    const slice = match ? match[1] : "primary";
    const laneResult = {
      slice,
      claim: `slice ${slice} does X`,
      evidence: slice === "blank" ? "" : "file.js:10",
    };
    return { data: { parts: [{ type: "text", text: JSON.stringify(laneResult) }], info: { structured: laneResult, tokens: { input: 1, output: 1, reasoning: 0 }, cost: 0 } } };
  });
  try {
    const source = DEFAULT_TEMPLATES["first-run-slice"].replace(
      `{ role: "explorer", schema: findingSchema, label: "slice:" + slice }`,
      `{ schema: findingSchema, label: "slice:" + slice }`,
    );
    const request = { source, args: { question: "What does this slice do?", slices: ["alpha", "blank"] } };

    const output = await runApprovedRequest(tools, context, request);
    // A read-only run completes directly; it never enters "awaiting diff approval".
    assert.doesNotMatch(output, /awaiting diff approval/);
    const runId = runIdFrom(output);

    const status = JSON.parse(await tools.workflow_status.execute({ runId, format: "json", detail: "result" }, context));
    assert.equal(status.status, "completed");
    const result = status.result.output;
    assert.deepEqual(result.slices, ["alpha", "blank"]);
    // alpha had evidence -> grounded; blank had none -> dropped, not promoted.
    assert.equal(result.groundedFindings.length, 1);
    assert.equal(result.groundedFindings[0].slice, "alpha");
    assert.equal(result.droppedUnsupportedClaims.length, 1);
    assert.equal(result.droppedUnsupportedClaims[0].slice, "blank");
    assert.match(result.note, /No edits, no domain mutation, no files written/);

    // Two slices -> two scoped lanes, one prompt each; synthesis adds no agent calls.
    assert.equal(calls.prompt.length, 2);

    // The QuickJS guest has no filesystem; the only thing in the working dir is the
    // workflow run store. Nothing the guest produced was written to the tree.
    const entries = await fs.readdir(directory);
    assert.deepEqual(entries.filter((name) => name !== ".opencode"), []);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
