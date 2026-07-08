// Design C live-server end-to-end driver (bd task-12).
//
// Unit tests exercise the plugin against fake clients/adapters; this script proves the same
// code paths against a REAL opencode server (spawned via `opencode serve`) and a REAL SDK
// client bound to it, mirroring scripts/parent-integration.mjs / scripts/child-system-smoke.mjs's
// convention of driving the plugin factory directly rather than through opencode's own plugin
// autoloader. It does not rely on the live server having loaded this plugin itself: the plugin
// factory is called in-process, with pluginContext.client/serverUrl pointed at the live server,
// so tool calls hit real HTTP endpoints (config, session, health) end to end.
//
// Ladder:
//   Rung A: server starts; in-process factory load; tool surface shape (16 tools, no
//           workflow_live_gates).
//   Rung B: serverFingerprint() against the real server -> { state: "ok", version }.
//   Rung C: real beads-drain dry-run preview + approval against a scratch bd repo (real `bd`
//           CLI, no fakes) -- approvalHash present, no requiredGates, capabilities shape-only,
//           then approved run completes with a truthful stop_reason and workflow_status.
//   Rung D (best-effort): one real child lane through a real model, asserting the actual
//           HTTP session.create request carried the directory + permission ruleset, the
//           directory echo did not mismatch, and a structured-text schema lane parses.
//
// Usage: node scripts/design-c-e2e.mjs
// Exits non-zero if rung A, B, or C fails. Rung D failure/timeout is recorded but never fails
// the process (best-effort by design). Cleans up its own server process and temp dirs always.

import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { setTimeout as sleep } from "node:timers/promises";
import http from "node:http";
import net from "node:net";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";

const execFileAsync = promisify(execFile);
const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const BEADS_EXT_PATH = path.join(REPO_ROOT, "workflow-domains", "beads", "beads-extension.js");
const OPENCODE_BIN = process.env.OPENCODE_E2E_BIN || "opencode";
const ACTOR = "design-c-e2e@example.com";
const FREE_MODEL = "opencode/big-pickle";
const FREE_MODEL_FALLBACK = "opencode/deepseek-v4-flash-free";
const START_PORT = Number.parseInt(process.env.OPENCODE_E2E_PORT || "41967", 10);

function log(...args) {
  console.log("[design-c-e2e]", ...args);
}

const tempDirs = [];
let serverProc;
let serverOutput = "";

async function tempDir(prefix) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `${prefix}-`));
  tempDirs.push(dir);
  return dir;
}

async function findFreePort(start) {
  for (let port = start; port < start + 200; port += 1) {
    const free = await new Promise((resolve) => {
      const srv = net.createServer();
      srv.once("error", () => resolve(false));
      srv.listen(port, "127.0.0.1", () => srv.close(() => resolve(true)));
    });
    if (free) return port;
  }
  throw new Error(`no free port found starting at ${start}`);
}

// Health polling deliberately uses node:http (a fresh socket per attempt), NOT global fetch.
// Empirically on this stack (node 22 undici + a bun server child), firing global-fetch attempts
// at the origin BEFORE the child is listening (ECONNREFUSED) can leave the process's undici
// pool for that origin in a state where every later request to it hangs indefinitely — even
// though curl/other processes reach the same server fine. http.get with a per-attempt socket
// has no shared pool, so it observes the server the moment it truly listens; global fetch (the
// SDK's transport) is only exercised after health passes, via verifyFetchTransport below.
function httpGetJson(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      let body = "";
      res.on("data", (d) => { body += d; });
      res.on("end", () => {
        try { resolve({ status: res.statusCode, json: JSON.parse(body) }); }
        catch (error) { reject(error); }
      });
    });
    req.on("error", reject);
    req.setTimeout(timeoutMs, () => { req.destroy(new Error(`http.get timed out after ${timeoutMs}ms`)); });
  });
}

async function waitForHealth(serverUrl, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    if (serverProc.exitCode !== null || serverProc.signalCode !== null) {
      throw new Error(`opencode serve exited early (code=${serverProc.exitCode}, signal=${serverProc.signalCode}); output:\n${serverOutput}`);
    }
    try {
      const { status, json } = await httpGetJson(`${serverUrl}/global/health`, 3000);
      if (status === 200 && json?.healthy) return json;
      lastError = new Error(`health returned status=${status} body=${JSON.stringify(json)}`);
    } catch (error) {
      lastError = error;
    }
    await sleep(250);
  }
  throw new Error(`server did not become healthy within ${timeoutMs}ms: ${lastError?.message ?? "unknown"}\noutput:\n${serverOutput}`);
}

// One guarded global-fetch round-trip AFTER health passes: everything downstream (SDK client,
// serverFingerprint) rides on global fetch, so prove that transport against this origin works
// before entering the rungs — a hang here fails loud with the undici-pool diagnosis instead of
// masquerading as a rung C/D timeout.
async function verifyFetchTransport(serverUrl) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new Error("global fetch to the healthy server timed out (undici origin-pool poisoning?)")), 10000);
  try {
    const res = await fetch(`${serverUrl}/global/health`, { signal: ac.signal });
    const json = await res.json();
    if (!json?.healthy) throw new Error(`global fetch health readback not healthy: ${JSON.stringify(json)}`);
    return json;
  } finally {
    clearTimeout(timer);
  }
}

async function startServer() {
  const port = await findFreePort(START_PORT);
  const serverUrl = `http://127.0.0.1:${port}`;
  const serverProjectDir = await tempDir("design-c-e2e-server-project");
  // --pure: run without external plugins. Rungs A-D drive the plugin factory in-process against
  // this server's URL/client, so the live server itself does not need (and should not load) the
  // full set of plugins configured in the user's global opencode.json -- that would introduce
  // unrelated network/plugin failure modes into a test whose subject is THIS plugin's code.
  serverProc = spawn(OPENCODE_BIN, ["serve", "--port", String(port), "--hostname", "127.0.0.1", "--pure", "--print-logs"], {
    cwd: serverProjectDir,
    stdio: ["ignore", "pipe", "pipe"],
  });
  serverProc.stdout.on("data", (chunk) => { serverOutput += chunk.toString(); });
  serverProc.stderr.on("data", (chunk) => { serverOutput += chunk.toString(); });
  const health = await waitForHealth(serverUrl);
  await verifyFetchTransport(serverUrl);
  log(`server healthy on ${serverUrl} (http + fetch transports verified):`, JSON.stringify(health));
  return { port, serverUrl };
}

async function stopServer() {
  if (!serverProc) return { killed: false };
  if (serverProc.exitCode !== null || serverProc.signalCode !== null) return { killed: true, alreadyExited: true };
  serverProc.kill("SIGTERM");
  const exited = await Promise.race([
    new Promise((resolve) => serverProc.once("exit", () => resolve(true))),
    sleep(4000).then(() => false),
  ]);
  if (!exited) {
    try { serverProc.kill("SIGKILL"); } catch { /* already gone */ }
    await Promise.race([
      new Promise((resolve) => serverProc.once("exit", () => resolve(true))),
      sleep(2000).then(() => false),
    ]);
  }
  return { killed: true, forcedKill: !exited };
}

async function cleanupTempDirs() {
  const dirs = tempDirs.splice(0);
  await Promise.all(dirs.map((dir) => fs.rm(dir, { recursive: true, force: true }).catch(() => {})));
  return dirs;
}

// --- Scratch bd repo helpers (pattern: tests/beads-drain-scratch.test.mjs) ---

async function bd(cwd, args) {
  const { stdout } = await execFileAsync("bd", [...args, "--actor", ACTOR], { cwd, encoding: "utf8", maxBuffer: 10 * 1024 * 1024 });
  return stdout;
}

function parseJson(stdout) {
  const text = stdout.trim();
  return text ? JSON.parse(text) : null;
}

function firstIssue(payload) {
  return Array.isArray(payload) ? payload[0] : payload?.issue ?? payload;
}

async function scratchBdRepo() {
  const dir = await tempDir("design-c-e2e-bd-repo");
  await execFileAsync("git", ["init"], { cwd: dir });
  await execFileAsync("git", ["config", "user.email", ACTOR], { cwd: dir });
  await execFileAsync("git", ["config", "user.name", "Design C E2E"], { cwd: dir });
  await bd(dir, ["init", "--prefix", "e2e", "--non-interactive", "--skip-agents", "--skip-hooks", "--quiet"]);
  return dir;
}

async function createIssue(cwd, overrides = {}) {
  const args = [
    "create",
    "--title", overrides.title ?? "Scratch task",
    "--description", overrides.description ?? "Implement the scratch task.",
    "--acceptance", overrides.acceptance ?? "Validation evidence is recorded.",
    "--type", overrides.type ?? "task",
    "--priority", String(overrides.priority ?? 1),
    "--json",
  ];
  return firstIssue(parseJson(await bd(cwd, args)));
}

// --- Assertion helpers ---

const results = { rungA: null, rungB: null, rungC: null, rungD: null };

async function main() {
  const { serverUrl } = await startServer();

  const { createOpencodeClient } = await import("@opencode-ai/sdk");
  const realClient = createOpencodeClient({ baseUrl: serverUrl });

  // Spy wrapper: preserves real request/response behavior (Object.create keeps prototype-chain
  // `this` bindings intact for the HeyAPI-generated client) while recording every session.create
  // call so rung D can assert on the ACTUAL HTTP request body sent to the real server.
  const sessionCreateCalls = [];
  const realSession = realClient.session;
  const spySession = Object.create(realSession);
  spySession.create = async (input) => {
    const result = await realSession.create(input);
    sessionCreateCalls.push({ input, result });
    return result;
  };
  const client = Object.create(realClient);
  client.session = spySession;

  const workflowKernelIndexUrl = new URL("../workflow-kernel/index.js", import.meta.url);
  const { default: workflowPlugin } = await import(workflowKernelIndexUrl);
  const { serverFingerprint } = await import(new URL("../workflow-kernel/server-fingerprint.js", import.meta.url));
  const { sessionDirectoryEchoStatus } = await import(workflowKernelIndexUrl);

  const pluginContext = { client, serverUrl };
  // Two registrations against the same live server/client: the core one (no extensions) is the
  // plugin's own bundled tool surface (the "16 tools" contract); the beads-loaded one additionally
  // carries the beads extension's review_materialize tool plus beads-drain workflow/command/skill
  // resolution, needed for rung C/D. Both are real in-process factory calls against the live server.
  const registeredCore = await workflowPlugin(pluginContext, {});
  const registered = await workflowPlugin(pluginContext, { extensions: [BEADS_EXT_PATH] });
  const tools = registered.tool;

  // ---------------- Rung A ----------------
  log("Rung A: in-process factory load against live server...");
  const coreToolNames = Object.keys(registeredCore.tool).sort();
  assert.equal(coreToolNames.length, 16, `expected 16 core tools, got ${coreToolNames.length}: ${coreToolNames.join(", ")}`);
  for (const name of ["workflow_run", "workflow_status", "workflow_apply"]) {
    assert.equal(typeof registeredCore.tool[name]?.execute, "function", `missing executable tool ${name}`);
  }
  assert.equal(registeredCore.tool.workflow_live_gates, undefined, "workflow_live_gates must not be registered");
  assert.equal(tools.workflow_live_gates, undefined, "workflow_live_gates must not be registered (beads-loaded registration)");
  results.rungA = { pass: true, coreToolCount: coreToolNames.length, coreToolNames, beadsLoadedToolNames: Object.keys(tools).sort() };
  log("Rung A PASS:", JSON.stringify(results.rungA));

  // ---------------- Rung B ----------------
  log("Rung B: serverFingerprint against live server...");
  const fingerprint = await serverFingerprint({ serverUrl });
  assert.equal(fingerprint.state, "ok", `expected fingerprint state "ok", got ${JSON.stringify(fingerprint)}`);
  assert.equal(fingerprint.version, "1.17.13", `expected version 1.17.13, got ${JSON.stringify(fingerprint)}`);
  results.rungB = { pass: true, fingerprint };
  log("Rung B PASS:", JSON.stringify(results.rungB));

  // ---------------- Rung C ----------------
  log("Rung C: real beads-drain dry-run preview + approval against scratch bd repo...");
  const bdRepo = await scratchBdRepo();
  const issue1 = await createIssue(bdRepo, { title: "E2E scratch task one" });
  const issue2 = await createIssue(bdRepo, { title: "E2E scratch task two", priority: 2 });
  log(`scratch bd repo ${bdRepo} seeded with issues ${issue1.id}, ${issue2.id}`);

  const toolContext = {
    directory: bdRepo,
    worktree: bdRepo,
    sessionID: "design-c-e2e-parent-session",
    messageID: "design-c-e2e-parent-message",
    agent: "build",
    abort: new AbortController().signal,
    metadata() {},
  };

  const runArgs = {
    name: "beads-drain",
    args: { mode: "dry-run", repo: bdRepo },
    childModel: FREE_MODEL,
    background: false,
  };

  const previewRaw = await tools.workflow_run.execute({ ...runArgs, format: "json" }, toolContext);
  const preview = JSON.parse(previewRaw);
  assert.equal(typeof preview.approvalHash, "string", `expected approvalHash string, preview: ${previewRaw}`);
  assert.match(preview.approvalHash, /^[a-f0-9]{64}$/, "approvalHash must be a 64-char hex digest");
  assert.equal(Object.hasOwn(preview, "requiredGates"), false, "preview must not carry a requiredGates key");
  assert.equal(previewRaw.includes("requiredGates"), false, "preview JSON text must not mention requiredGates anywhere");
  assert.deepEqual(Object.keys(preview.capabilities).sort(), ["childSession", "worktree"], `capabilities must be exactly {childSession, worktree}, got ${JSON.stringify(preview.capabilities)}`);

  const approveRaw = await tools.workflow_run.execute({ ...runArgs, approve: true, approvalHash: preview.approvalHash }, toolContext);
  const runIdMatch = approveRaw.match(/Workflow ([0-9a-f-]{36})/);
  assert.ok(runIdMatch, `missing run id in approved output: ${approveRaw}`);
  const runId = runIdMatch[1];
  const resultPathMatch = approveRaw.match(/Result file: (.+)/);
  assert.ok(resultPathMatch, `missing result file in approved output: ${approveRaw}`);
  const resultPath = resultPathMatch[1].trim();
  const resultJson = JSON.parse(await fs.readFile(resultPath, "utf8"));
  const stopReason = resultJson.output?.stop_reason;
  assert.ok(
    ["dry_run_plan", "queue_empty", "not_dry"].includes(stopReason),
    `stop_reason must be one of dry_run_plan/queue_empty/not_dry, got ${JSON.stringify(stopReason)}`,
  );

  const statusRaw = await tools.workflow_status.execute({ runId, format: "json", detail: "full" }, toolContext);
  const status = JSON.parse(statusRaw);
  assert.equal(status.id, runId, "workflow_status must report the same run id");
  assert.equal(status.authority.integration, false, "a dry-run must not carry integration authority");
  assert.ok(["completed", "failed"].includes(status.status), `expected a terminal status, got ${status.status}`);

  results.rungC = {
    pass: true,
    bdRepo,
    issues: [issue1.id, issue2.id],
    approvalHash: preview.approvalHash,
    capabilities: preview.capabilities,
    runId,
    stopReason,
    reportStatus: resultJson.output?.status,
    plannedIds: resultJson.output?.planned_ids,
    remoteSync: resultJson.output?.remote_sync,
    workflowStatus: status.status,
    authorityIntegration: status.authority.integration,
    sessionCreateCallsDuringDryRun: sessionCreateCalls.length,
  };
  // Dry-run never spawns lanes (drain-runtime.js short-circuits to plan/proveDry before any
  // adapter.claim or child agent launch), so no real session should have been created yet.
  assert.equal(sessionCreateCalls.length, 0, "beads-drain dry-run must not create any child sessions");
  log("Rung C PASS:", JSON.stringify(results.rungC));

  // ---------------- Rung D (best-effort) ----------------
  results.rungD = await runRungD({ tools, client: realClient, sessionCreateCalls, sessionDirectoryEchoStatus });
  log(`Rung D ${results.rungD.pass ? "PASS" : "NOT RUN"}:`, JSON.stringify(results.rungD));

  return results;
}

async function runRungD({ tools, client, sessionCreateCalls, sessionDirectoryEchoStatus }) {
  const RUNG_D_BUDGET_MS = 8 * 60 * 1000; // stay well under the ~10 minute cap
  const deadline = Date.now() + RUNG_D_BUDGET_MS;
  const models = [FREE_MODEL, FREE_MODEL_FALLBACK];
  const attempts = [];

  const laneDirectory = await tempDir("design-c-e2e-rung-d-dir");
  // The lane's session.create sends parentID = the invoking session's id. Against the REAL server
  // that parent must actually exist (a fabricated id 400s and the lane dies in milliseconds), so
  // create a genuine parent session on the live server first and best-effort delete it afterwards.
  const parentCreated = await client.session.create({
    body: { title: "design-c-e2e rung D parent (disposable)" },
    query: { directory: laneDirectory },
  });
  if (parentCreated?.error !== undefined || !parentCreated?.data?.id) {
    return { pass: false, notRun: true, reason: `could not create a real parent session on the live server: ${JSON.stringify(parentCreated?.error ?? parentCreated)}`, attempts };
  }
  const parentSessionID = parentCreated.data.id;
  const toolContext = {
    directory: laneDirectory,
    worktree: laneDirectory,
    sessionID: parentSessionID,
    messageID: "design-c-e2e-rung-d-message",
    agent: "build",
    abort: new AbortController().signal,
    metadata() {},
  };

  const source = `export const meta = {
  name: "design-c-e2e-rung-d",
  description: "Design C E2E rung D: one real child lane, structured-text schema fallback.",
  profile: "read-only-review",
  maxAgents: 1,
};

return await agent(
  "Reply ONLY with JSON matching the schema. The value of \\"word\\" must be exactly: pong",
  {
    role: "explorer",
    schema: { type: "object", required: ["word"], properties: { word: { type: "string" } } },
    retryCount: 0,
    correctiveRetries: 0,
    timeoutMs: 45000,
    onFailure: "returnNull",
  },
);
`;

  // Failure forensics: the lane converts its error to null (onFailure: "returnNull"), so pull the
  // run's event journal to see WHY a lane died instead of reporting a bare null result.
  async function laneFailureEvidence(runId) {
    try {
      const eventsRaw = await tools.workflow_events.execute({ runId, format: "json" }, toolContext);
      const events = JSON.parse(eventsRaw);
      const list = Array.isArray(events) ? events : events?.events ?? [];
      return list
        .filter((event) => /failed|error|mismatch|denied/i.test(String(event?.type ?? "")) || event?.error !== undefined)
        .slice(-5)
        .map((event) => ({ type: event.type, error: truncate(event.error ?? "", 300), callId: event.callId }));
    } catch (error) {
      return [{ type: "evidence-read-failed", error: String(error?.message ?? error) }];
    }
  }

  try {
    for (const model of models) {
      if (Date.now() >= deadline) {
        attempts.push({ model, outcome: "skipped", reason: "rung D time budget exhausted before this attempt" });
        break;
      }
      const remainingMs = deadline - Date.now();
      const callsBefore = sessionCreateCalls.length;
      const attemptStartedAt = Date.now();
      try {
        const runArgs = {
          source,
          childModel: model,
          background: false,
          laneTimeoutMs: 45000,
        };
        const previewRaw = await withTimeout(
          tools.workflow_run.execute({ ...runArgs, format: "json" }, toolContext),
          Math.min(remainingMs, 60000),
          "preview",
        );
        const preview = JSON.parse(previewRaw);
        const approveRaw = await withTimeout(
          tools.workflow_run.execute({ ...runArgs, approve: true, approvalHash: preview.approvalHash }, toolContext),
          Math.min(deadline - Date.now(), 120000),
          "approve",
        );
        const runIdMatch = approveRaw.match(/Workflow ([0-9a-f-]{36})/);
        const resultPathMatch = approveRaw.match(/Result file: (.+)/);
        if (!runIdMatch || !resultPathMatch) {
          attempts.push({ model, outcome: "failed", reason: `no run id / result path in output: ${truncate(approveRaw, 400)}`, durationMs: Date.now() - attemptStartedAt });
          continue;
        }
        const resultJson = JSON.parse(await fs.readFile(resultPathMatch[1].trim(), "utf8"));
        const laneResult = resultJson.output;
        const newCalls = sessionCreateCalls.slice(callsBefore);
        if (newCalls.length === 0) {
          attempts.push({ model, outcome: "failed", reason: "no real session.create call observed", durationMs: Date.now() - attemptStartedAt });
          continue;
        }
        const { input, result } = newCalls[0];
        const requestDirectory = input?.query?.directory ?? input?.directory;
        const requestPermission = input?.body?.permission ?? input?.permission;
        const directoryEcho = sessionDirectoryEchoStatus(result, laneDirectory);
        // "verified" is the positive echo state; "not-echoed" is tolerated by the same rule the
        // kernel applies (Session.directory is typed-required on >= MIN_OPENCODE_SERVER_VERSION).
        const directoryEchoOk = directoryEcho.state === "verified" || directoryEcho.state === "not-echoed";
        const requestCarriedDirectory = requestDirectory !== undefined
          && path.resolve(String(requestDirectory)) === path.resolve(laneDirectory);
        const requestCarriedPermission = Array.isArray(requestPermission) && requestPermission.length > 0;
        const parsedWord = laneResult && typeof laneResult === "object" ? laneResult.word : undefined;
        const structuredResultOk = typeof parsedWord === "string" && parsedWord.length > 0;

        if (!requestCarriedDirectory || !requestCarriedPermission || !directoryEchoOk || !structuredResultOk) {
          attempts.push({
            model,
            outcome: "failed",
            reason: "assertions did not all hold",
            requestCarriedDirectory,
            requestCarriedPermission,
            directoryEcho,
            structuredResultOk,
            parsedResult: laneResult,
            laneEvents: await laneFailureEvidence(runIdMatch[1]),
            durationMs: Date.now() - attemptStartedAt,
          });
          continue;
        }

        return {
          pass: true,
          model,
          parentSessionID,
          childSessionID: result?.data?.id ?? null,
          directoryEcho,
          requestCarriedDirectory,
          requestCarriedPermission,
          structuredResult: laneResult,
          durationMs: Date.now() - attemptStartedAt,
          attempts,
        };
      } catch (error) {
        attempts.push({ model, outcome: "error", reason: String(error?.message ?? error), durationMs: Date.now() - attemptStartedAt });
      }
    }

    return {
      pass: false,
      notRun: true,
      reason: `no model produced a usable real child-lane result within the rung D budget; attempts: ${JSON.stringify(attempts)}`,
      attempts,
    };
  } finally {
    // Best-effort: remove the disposable rung D sessions (parent + any lane children) from the
    // live server's shared store so repeated driver runs do not accumulate session records.
    const createdIds = [parentSessionID, ...sessionCreateCalls.map((call) => call.result?.data?.id).filter(Boolean)];
    for (const id of createdIds) {
      try { await client.session.delete({ path: { id } }); } catch { /* best-effort cleanup */ }
    }
  }
}

function truncate(text, max) {
  const s = String(text);
  return s.length > max ? `${s.slice(0, max)}...(truncated)` : s;
}

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    sleep(ms).then(() => { throw new Error(`${label} timed out after ${ms}ms`); }),
  ]);
}

let exitCode = 0;
try {
  const finalResults = await main();
  console.log("\n=== design-c-e2e RESULTS ===");
  console.log(JSON.stringify(finalResults, null, 2));
} catch (error) {
  exitCode = 1;
  console.error("\n[design-c-e2e] FAILED:", error?.stack ?? error);
  console.log("\n=== design-c-e2e PARTIAL RESULTS ===");
  console.log(JSON.stringify(results, null, 2));
} finally {
  const stopOutcome = await stopServer();
  const removedDirs = await cleanupTempDirs();
  log("cleanup:", JSON.stringify({ stopOutcome, removedDirCount: removedDirs.length }));
}
process.exit(exitCode);
