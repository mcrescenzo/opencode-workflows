import fs from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import path from "node:path";

export const DEFAULT_SECRET_GLOBS = [
  "**/.env",
  "**/.env.*",
  ".env",
  ".env.*",
  "**/.aws/credentials",
  "**/.aws/config",
  "**/.kube/config",
  "**/.ssh/id_ecdsa",
  "**/.ssh/id_dsa",
  "**/.netrc",
  "**/.pgpass",
  "**/.config/gcloud/credentials.db",
  "**/.docker/config.json",
  "**/*.pem",
  "**/*.key",
  "**/*credentials*",
  "**/*secret*",
  "**/id_rsa",
  "**/id_ed25519",
];

const CONTROL_PATH_SEGMENTS = new Set([".git", ".opencode"]);

// O_NOFOLLOW guarantees only that the *final* path component is not a symlink.
// O_DIRECTORY makes the open fail unless the component resolves to a directory.
const NOFOLLOW_DIR_FLAGS = fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_DIRECTORY;
// Create-or-truncate the final file, but refuse to follow a symlink at the final
// component. A swapped-in symlink (e.g. target replaced by a link to /etc/passwd)
// makes this open fail with ELOOP/ENOTDIR instead of redirecting the write.
const NOFOLLOW_WRITE_FLAGS =
  fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC | fsConstants.O_NOFOLLOW;

function escapeRegex(value) {
  return value.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
}

export function normalizePolicyPath(filePath) {
  return String(filePath ?? "").replace(/\\/g, "/").replace(/^\.\/+/, "");
}

function globToRegExp(glob) {
  const pattern = normalizePolicyPath(glob);
  let output = "^";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    const next = pattern[index + 1];
    if (char === "*" && next === "*") {
      const after = pattern[index + 2];
      if (after === "/") {
        output += "(?:.*/)?";
        index += 2;
      } else {
        output += ".*";
        index += 1;
      }
      continue;
    }
    if (char === "*") {
      output += "[^/]*";
      continue;
    }
    if (char === "?") {
      output += "[^/]";
      continue;
    }
    output += escapeRegex(char);
  }
  return new RegExp(`${output}$`, "i");
}

export function matchesPolicyGlob(relativePath, glob) {
  return globToRegExp(glob).test(normalizePolicyPath(relativePath));
}

export function protectedPathReason(relativePath, options = {}) {
  const normalized = normalizePolicyPath(relativePath);
  const segments = normalized.split("/");
  if (segments.some((segment) => CONTROL_PATH_SEGMENTS.has(segment.toLowerCase()))) return "control-path";
  const secretGlobs = Array.isArray(options.secretGlobs) ? options.secretGlobs : DEFAULT_SECRET_GLOBS;
  if (secretGlobs.some((glob) => matchesPolicyGlob(normalized, glob))) return "secret-path";
  return undefined;
}

export function assertWritableWorkflowPath(relativePath, options = {}) {
  const reason = protectedPathReason(relativePath, options);
  if (reason) throw new Error(`Patch target is protected (${reason}): ${relativePath}`);
}

export function pathContains(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!!relative && !relative.startsWith("..") && !path.isAbsolute(relative));
}

// Resolve the real path that an *already-open* file descriptor points at, so we can
// re-confirm containment against the kernel's view of where the fd actually landed
// (after all symlink/.. resolution) rather than re-resolving a path string that an
// attacker could swap again. Linux exposes this via /proc/self/fd/<fd>.
async function fdRealPath(handle) {
  try {
    return await fs.readlink(`/proc/self/fd/${handle.fd}`);
  } catch {
    return undefined;
  }
}

async function requiredFdRealPath(handle, target) {
  const real = await fdRealPath(handle);
  if (real === undefined) {
    throw new Error(`Patch write requires fd realpath support for TOCTOU-safe containment: ${target}`);
  }
  return real;
}

// TOCTOU-safe write for a workflow patch target.
//
// validatePatchTargets lstat-checks ancestors + target up front, but the write
// happens later; a concurrent local actor with tree-write access can swap a
// validated dir/file for a symlink to /etc between validation and write, landing
// the write outside `root` (R18 / opencode-workflows-994). The per-run advisory
// lock does not protect against external processes.
//
// Defense, immediately at write time (no exploitable window):
//   1. Re-validate each ancestor directory with O_NOFOLLOW|O_DIRECTORY opens, and
//      confirm each opened dir fd's real path still lies inside `root`. A swapped-in
//      ancestor symlink makes its O_NOFOLLOW open fail (ELOOP/ENOTDIR); a redirected
//      ancestor makes the fd realpath escape `root`.
//   2. Open the final component with O_NOFOLLOW|O_CREAT|O_WRONLY|O_TRUNC so a
//      symlinked final component is rejected at open (it is never followed).
//   3. Open-then-validate-fd: re-confirm the opened *target* fd's real path is still
//      inside `root` before writing a byte; bail (and close) on any escape.
//   4. Write + fsync-free flush through that exact fd — never re-resolving the path.
export async function safeWriteFileWithinRoot(root, target, content) {
  const rootReal = await fs.realpath(root);
  let rootHandle;
  try {
    rootHandle = await fs.open(rootReal, NOFOLLOW_DIR_FLAGS);
    const real = await requiredFdRealPath(rootHandle, target);
    if (!pathContains(rootReal, real)) throw new Error(`Patch root escapes primary root: ${target}`);
  } finally {
    await rootHandle?.close();
  }
  // Resolve the target against the *realpathed* root, not the raw `root`. Call sites
  // derive root via path.resolve(context.worktree||directory), which normalizes ./..
  // but does NOT resolve symlinks, so when the apply root has a symlinked ancestor
  // (macOS /tmp->/private/tmp, symlinked $HOME/worktree parent — see
  // tests/drain-runtime.test.mjs R15 and worktree-adapter realpath handling) the
  // un-realpathed targetAbs would diverge from rootReal and the containment check
  // below would reject every legitimate write (R18-followup / opencode-workflows-2gs).
  // Resolving against rootReal keeps the .. / absolute-target escape check intact
  // (path.resolve still collapses ../ and absolute targets) while letting legit
  // nested writes through under a symlinked-ancestor root.
  const targetAbs = path.resolve(rootReal, target);
  if (!pathContains(rootReal, targetAbs)) {
    throw new Error(`Patch target escapes primary root: ${target}`);
  }

  // Walk + create ancestors with O_NOFOLLOW dir opens so no ancestor component can be
  // a freshly swapped-in symlink redirecting the write tree.
  const relParts = path.relative(rootReal, targetAbs).split(path.sep).filter(Boolean);
  if (relParts.length === 0) {
    throw new Error(`Patch target must name a file: ${target}`);
  }
  const dirParts = relParts.slice(0, -1);
  let currentReal = rootReal;
  for (const part of dirParts) {
    const childPath = path.join(currentReal, part);
    let dirHandle;
    try {
      dirHandle = await fs.open(childPath, NOFOLLOW_DIR_FLAGS);
    } catch (error) {
      if (error && error.code === "ENOENT") {
        // Create the missing directory (mkdir refuses to follow/replace, and a racing
        // symlink at this name makes the subsequent O_NOFOLLOW open below fail).
        await fs.mkdir(childPath);
        dirHandle = await fs.open(childPath, NOFOLLOW_DIR_FLAGS);
      } else if (error && (error.code === "ELOOP" || error.code === "ENOTDIR")) {
        throw new Error(`Patch ancestor is a symlink: ${target}`);
      } else {
        throw error;
      }
    }
    try {
      const real = await requiredFdRealPath(dirHandle, target);
      if (!pathContains(rootReal, real)) {
        throw new Error(`Patch ancestor escapes primary root: ${target}`);
      }
      currentReal = real;
    } finally {
      await dirHandle.close();
    }
  }

  const finalPath = path.join(currentReal, relParts.at(-1));
  let handle;
  try {
    handle = await fs.open(finalPath, NOFOLLOW_WRITE_FLAGS, 0o644);
  } catch (error) {
    if (error && (error.code === "ELOOP" || error.code === "ENOTDIR")) {
      throw new Error(`Patch target is a symlink: ${target}`);
    }
    throw error;
  }
  try {
    const real = await requiredFdRealPath(handle, target);
    if (!pathContains(rootReal, real)) {
      // An ancestor was redirected after our per-ancestor checks; the fd points
      // outside root. Abort before writing a single byte.
      throw new Error(`Patch target escapes primary root after open: ${target}`);
    }
    await handle.writeFile(content, "utf8");
  } finally {
    await handle.close();
  }
}
