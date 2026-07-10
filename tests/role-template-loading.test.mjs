import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { resolveRole } from "../workflow-kernel/role-template-loading.js";

// Role-loading error-state regressions split out of the historical bughunt-error-state
// catch-all (opencode-workflows-fnop.9). Covers the error-handling-4 finding: resolveRole()
// leaked a raw fs ENOENT (with absolute path) instead of a clear domain error when a role
// slug had no file on disk.

test("resolveRole throws a clear domain error (not a raw ENOENT) for a role slug with no file", async () => {
  const roleDir = await fs.mkdtemp(path.join(os.tmpdir(), "wf-role-"));
  try {
    await assert.rejects(
      () => resolveRole("totally-made-up-role-name", roleDir),
      (error) => {
        assert.match(error.message, /Workflow role "totally-made-up-role-name" was not found/);
        assert.ok(
          error.message.includes(path.join(roleDir, "totally-made-up-role-name.md")),
          `expected the resolved path in the error message, got: ${error.message}`,
        );
        assert.notEqual(error.code, "ENOENT", "domain error must not carry the raw fs error code");
        assert.doesNotMatch(error.message, /ENOENT/, "raw ENOENT text must not leak into the domain error");
        return true;
      },
    );
  } finally {
    await fs.rm(roleDir, { recursive: true, force: true });
  }
});

test("resolveRole still resolves a real role file normally (no regression on the happy path)", async () => {
  const roleDir = await fs.mkdtemp(path.join(os.tmpdir(), "wf-role-"));
  try {
    const role = await resolveRole("explorer", roleDir);
    assert.equal(role.name, "explorer");
    assert.match(role.content, /Explore the assigned surface area/);
  } finally {
    await fs.rm(roleDir, { recursive: true, force: true });
  }
});
