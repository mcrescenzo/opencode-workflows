// Shared bd helpers for the beads adapters (drain + review-materialize). Only the genuinely
// identical helpers live here. normalizeIssue is deliberately NOT shared: the drain adapter throws
// on an invalid payload and carries the full issue shape, while the review-materialize adapter
// returns null and a leaner shape — merging them would change behavior.
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const DEFAULT_BD_TIMEOUT_MS = 2 * 60 * 1000;
const DEFAULT_BD_MAX_BUFFER = 10 * 1024 * 1024;

export async function defaultRunBd(args, options = {}) {
  const result = await execFileAsync("bd", args, {
    cwd: options.cwd,
    encoding: "utf8",
    timeout: Number.isFinite(options.timeoutMs) ? options.timeoutMs : DEFAULT_BD_TIMEOUT_MS,
    maxBuffer: Number.isFinite(options.maxBuffer) ? options.maxBuffer : DEFAULT_BD_MAX_BUFFER,
    signal: options.signal,
  });
  return { stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

export function parseBdJson(stdout, command = "bd") {
  const text = typeof stdout === "string" ? stdout.trim() : "";
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${command} returned invalid JSON: ${error.message}`);
  }
}
