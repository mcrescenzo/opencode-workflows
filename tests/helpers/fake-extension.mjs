import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// Test fixture helper for the trusted-extension seam.
//
// Creates a temp extension directory, writes an extension module (default export) and any
// declared asset dirs (workflows/commands/skills) with file content. Mirrors how a real
// trusted extension is laid out so resolution/registration/auto-apply tests can exercise the
// asset-dir merge without depending on the real beads extension.

export async function makeExtensionDir(prefix = "wf-ext-") {
  return await fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

const MINIMAL_WORKFLOW = 'export const meta = { name: "NAME", description: "fixture" };\nreturn "ok";\n';

/**
 * Write a fixture extension into `dir`.
 *
 * @param {string} dir   extension module dir (the manifest's baseDir)
 * @param {object} opts
 *   - id            extension id (default "fake")
 *   - assetDirs     { workflows?, commands?, skills? } relative dir names to declare in the manifest
 *   - workflows     { name: body } files to write into the workflows asset dir
 *   - commands      { name: markdown } .md files to write into the commands asset dir
 *   - skills        { name: markdown } SKILL.md files written under <skills>/<name>/SKILL.md
 *   - source        raw module source string (overrides the JSON manifest; for function fields)
 * @returns {Promise<string>} the absolute extension module path
 */
export async function writeFakeExtension(dir, opts = {}) {
  const { id = "fake", assetDirs, workflows, commands, skills, source } = opts;
  const extPath = path.join(dir, "extension.js");

  if (source !== undefined) {
    await fs.writeFile(extPath, source);
  } else {
    const manifest = { id };
    if (assetDirs) manifest.assetDirs = assetDirs;
    await fs.writeFile(extPath, `export default ${JSON.stringify(manifest, null, 2)};\n`);
  }

  if (workflows && assetDirs?.workflows) {
    const wfDir = path.join(dir, assetDirs.workflows);
    await fs.mkdir(wfDir, { recursive: true });
    for (const [name, body] of Object.entries(workflows)) {
      await fs.writeFile(path.join(wfDir, `${name}.js`), body ?? MINIMAL_WORKFLOW.replace("NAME", name));
    }
  }
  if (commands && assetDirs?.commands) {
    const cmdDir = path.join(dir, assetDirs.commands);
    await fs.mkdir(cmdDir, { recursive: true });
    for (const [name, md] of Object.entries(commands)) {
      await fs.writeFile(path.join(cmdDir, `${name}.md`), md ?? `Run the ${name} workflow.\n`);
    }
  }
  if (skills && assetDirs?.skills) {
    const skillRoot = path.join(dir, assetDirs.skills);
    for (const [name, md] of Object.entries(skills)) {
      const skillDir = path.join(skillRoot, name);
      await fs.mkdir(skillDir, { recursive: true });
      await fs.writeFile(path.join(skillDir, "SKILL.md"), md ?? `---\nname: ${name}\n---\n${name} skill.\n`);
    }
  }
  return extPath;
}

export function defaultWorkflowBody(name, extra = "") {
  return `export const meta = { name: ${JSON.stringify(name)}, description: "fixture" };\n${extra}return "ok";\n`;
}
