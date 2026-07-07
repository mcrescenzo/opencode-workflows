import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const packagePath = path.join(root, "package.json");
const lockPath = path.join(root, "bun.lock");

function parseBunLock(source) {
  return JSON.parse(source.replace(/,\s*([}\]])/g, "$1"));
}

const pkg = JSON.parse(fs.readFileSync(packagePath, "utf8"));
const lock = parseBunLock(fs.readFileSync(lockPath, "utf8"));
const manifestDeps = pkg.dependencies ?? {};
const lockDeps = lock.workspaces?.[""]?.dependencies ?? {};
const problems = [];

function packageRecordVersion(name) {
  const record = lock.packages?.[name];
  if (!Array.isArray(record) || typeof record[0] !== "string") return null;
  const prefix = `${name}@`;
  return record[0].startsWith(prefix) ? record[0].slice(prefix.length) : null;
}

function parseVersionTriple(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version ?? "");
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function compareTriples(a, b) {
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

// bun.lock's per-package record always stores the resolved concrete version, never a
// range. Most deps here are exact-pinned (resolved === declared). A few (currently
// @opencode-ai/plugin and @opencode-ai/sdk) are declared as caret ranges, so the
// resolved version only needs to satisfy that range (same major, >= the base version).
function satisfiesDeclaredRange(resolvedVersion, declaredRange) {
  if (resolvedVersion === declaredRange) return true;
  const caretMatch = /^\^(\d+\.\d+\.\d+.*)$/.exec(declaredRange);
  if (!caretMatch) return false;
  const base = parseVersionTriple(caretMatch[1]);
  const resolved = parseVersionTriple(resolvedVersion);
  if (!base || !resolved) return false;
  if (base[0] !== resolved[0]) return false;
  return compareTriples(resolved, base) >= 0;
}

for (const [name, version] of Object.entries(manifestDeps)) {
  if (lockDeps[name] !== version) {
    problems.push(`root dependency mismatch for ${name}: package.json=${version} bun.lock=${lockDeps[name] ?? "<missing>"}`);
  }
  const lockedVersion = packageRecordVersion(name);
  if (!lockedVersion || !satisfiesDeclaredRange(lockedVersion, version)) {
    problems.push(`package record mismatch for ${name}: package.json=${version} bun.lock=${lockedVersion ?? "<missing>"} (does not satisfy declared range)`);
  }
}

for (const name of Object.keys(lockDeps)) {
  if (!Object.hasOwn(manifestDeps, name)) {
    problems.push(`bun.lock root dependency ${name} is not declared in package.json`);
  }
}

if (problems.length > 0) {
  console.error("[lockfile-sync] bun.lock is out of sync with package.json:");
  for (const problem of problems) console.error(`- ${problem}`);
  process.exit(1);
}

console.log("[lockfile-sync] package.json dependencies match bun.lock");
