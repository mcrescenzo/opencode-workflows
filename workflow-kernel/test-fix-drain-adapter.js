import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const DEFAULT_COMMAND_TIMEOUT_MS = 2 * 60 * 1000;
const DEFAULT_COMMAND_MAX_BUFFER = 10 * 1024 * 1024;

export async function defaultRunCommand(command, options = {}) {
  const [bin, ...args] = Array.isArray(command) ? command : String(command).split(/\s+/).filter(Boolean);
  if (!bin) throw new Error("test-fix adapter requires a test command");
  try {
    const result = await execFileAsync(bin, args, {
      cwd: options.cwd,
      encoding: "utf8",
      timeout: Number.isFinite(options.timeoutMs) ? options.timeoutMs : DEFAULT_COMMAND_TIMEOUT_MS,
      maxBuffer: Number.isFinite(options.maxBuffer) ? options.maxBuffer : DEFAULT_COMMAND_MAX_BUFFER,
      signal: options.signal,
    });
    return { exitCode: 0, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
  } catch (error) {
    return { exitCode: Number.isInteger(error.code) ? error.code : 1, stdout: error.stdout ?? "", stderr: error.stderr ?? error.message ?? "" };
  }
}

function commandText(command) {
  return Array.isArray(command) ? command.join(" ") : String(command);
}

export function groupTestFailures(output) {
  const text = String(output ?? "");
  const failures = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const failMatch = trimmed.match(/^(?:FAIL|not ok)\s+(.+?)(?::\s*(.+))?$/i);
    if (failMatch) {
      const target = failMatch[1].trim();
      failures.push({ id: `test:${target}`, target, summary: failMatch[2]?.trim() || trimmed, raw: trimmed });
    }
  }
  if (failures.length === 0 && text.trim()) failures.push({ id: "test:unknown", target: "unknown", summary: text.trim().slice(0, 300), raw: text.trim() });
  return failures;
}

export function createTestFixDrainAdapter(options = {}) {
  const cwd = options.cwd ?? process.cwd();
  const testCommand = options.testCommand ?? ["npm", "test"];
  const runCommand = options.runCommand ?? defaultRunCommand;
  const createdFollowups = [];
  const commandRuns = [];

  async function runTests(context = {}) {
    const result = await runCommand(testCommand, { cwd, phase: context.phase ?? "test", signal: options.signal, timeoutMs: options.timeoutMs, maxBuffer: options.maxBuffer });
    commandRuns.push({ command: commandText(testCommand), phase: context.phase ?? "test", exitCode: result.exitCode });
    return result;
  }

  return {
    name: "test-fix",
    commandRuns,
    async discover() {
      const result = await runTests({ phase: "discover" });
      if (result.exitCode === 0) return [];
      return groupTestFailures(`${result.stdout}\n${result.stderr}`).map((failure) => ({
        ...failure,
        status: "open",
        issue_type: "test-failure",
        output: `${result.stdout}\n${result.stderr}`.trim(),
      }));
    },
    async classify(item) {
      if (!item?.target || item.target === "unknown") return { status: "human-gated", reason: "failure target could not be isolated" };
      if (item.humanGated === true) return { status: "human-gated", reason: "failure marked human-gated" };
      return { status: "ready", reason: "isolated failing test target" };
    },
    async claim(item) {
      return { itemId: item.id, claimed: true, target: item.target };
    },
    async buildLanePacket(item, context = {}) {
      return {
        itemId: item.id,
        target: item.target,
        summary: item.summary,
        failingOutput: item.output,
        attempt: context.attempt,
        instructions: [
          "Repair only the failing test target and directly related implementation.",
          "Return a generic lane report with changed files, commands, evidence, risks, and followups.",
        ],
      };
    },
    async validate(item, integrationState, context = {}) {
      const result = await runTests({ phase: "validate" });
      const accepted = result.exitCode === 0 && context.laneReport?.readyForIntegration === true;
      return {
        itemId: item.id,
        accepted,
        reason: accepted ? "test command passed after repair" : "test command still fails after repair",
        diffScopeOk: integrationState?.status !== "review-required",
        followupsHandled: true,
        acceptanceChecklist: ["test command rerun", "lane report ready for integration"],
        validationCommands: [commandText(testCommand)],
        followups: accepted ? [] : [{ title: `Unresolved test failure: ${item.target}`, description: `${result.stdout}\n${result.stderr}`.trim() }],
      };
    },
    async close(item, evidence = {}) {
      return { itemId: item.id, status: "closed", reason: evidence.validationReport?.reason ?? "test repaired" };
    },
    async createFollowup(followup = {}) {
      const created = { id: `test-followup-${createdFollowups.length + 1}`, ...followup };
      createdFollowups.push(created);
      return created;
    },
    async proveDry() {
      const result = await runTests({ phase: "proveDry" });
      return { dry: result.exitCode === 0, command: commandText(testCommand), output: `${result.stdout}\n${result.stderr}`.trim() };
    },
  };
}
