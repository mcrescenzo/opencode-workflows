import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { DEFAULT_SUBPROCESS_MAX_BUFFER, DEFAULT_SUBPROCESS_TIMEOUT_MS } from "./constants.js";

const execFileAsync = promisify(execFile);

export const DEFAULT_GIT_TIMEOUT_MS = DEFAULT_SUBPROCESS_TIMEOUT_MS;
export const DEFAULT_GIT_MAX_BUFFER = DEFAULT_SUBPROCESS_MAX_BUFFER;

async function execGit(directory, args, options = {}) {
  return await execFileAsync("git", args, {
    cwd: directory,
    encoding: "utf8",
    timeout: DEFAULT_GIT_TIMEOUT_MS,
    maxBuffer: DEFAULT_GIT_MAX_BUFFER,
    ...options,
  });
}

export async function git(directory, args, options = {}) {
  try {
    return await execGit(directory, args, options);
  } catch (error) {
    const detail = error.stderr || error.stdout || error.message || String(error);
    throw new Error(`git ${args.join(" ")} failed in ${directory}: ${detail.trim()}`);
  }
}

export async function gitSucceeds(directory, args, options = {}) {
  try {
    await execGit(directory, args, options);
    return true;
  } catch {
    return false;
  }
}

export async function gitCapture(directory, args, options = {}) {
  try {
    const result = await execGit(directory, args, options);
    return { ok: true, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
  } catch (error) {
    return { ok: false, stdout: error.stdout ?? "", stderr: error.stderr ?? "", message: error.message ?? String(error) };
  }
}
