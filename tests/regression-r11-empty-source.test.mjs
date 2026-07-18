import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { makeExtensionDir, writeFakeExtension } from "./helpers/fake-extension.mjs";

// R11 regression: writeFakeExtension must honor an intentionally empty source
// override (source: "") rather than treating it as falsy and falling through to
// manifest generation. The previous `if (source)` truthiness check dropped the
// explicit empty-module request.

test("writeFakeExtension writes an empty extension module when source is the empty string", async () => {
  const dir = await makeExtensionDir();
  try {
    const extPath = await writeFakeExtension(dir, { id: "empty", source: "" });
    const written = await fs.readFile(extPath, "utf8");
    assert.equal(written, "");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("writeFakeExtension still generates a default manifest when source is omitted (undefined)", async () => {
  const dir = await makeExtensionDir();
  try {
    const extPath = await writeFakeExtension(dir, { id: "generated", assetDirs: { workflows: "./workflows" } });
    const written = await fs.readFile(extPath, "utf8");
    assert.match(written, /export default/);
    assert.match(written, /"id": "generated"/);
    assert.match(written, /"workflows": "\.\/workflows"/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("writeFakeExtension honors a non-empty source override unchanged", async () => {
  const dir = await makeExtensionDir();
  try {
    const extPath = await writeFakeExtension(dir, { id: "custom", source: "export default { id: 'custom' };\n" });
    const written = await fs.readFile(extPath, "utf8");
    assert.equal(written, "export default { id: 'custom' };\n");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
