import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import {
  DURABLE_LEDGER_FILES,
  LANE_OUTCOMES,
  MAX_EVENTS,
  MAX_EVENT_MESSAGE_CHARS,
  MAX_JOURNAL_RECORDS,
} from "./constants.js";
import {
  extractTextFromError,
  hash,
  hasFunction,
  jsonLine,
  redactDurableValue,
  redactValue,
  stableStringify,
} from "./text-json.js";
import { normalizeAgentOptions } from "./authority-policy.js";
import { classifyLaneError } from "./errors.js";
import { emitWorkflowDiagnostic } from "./diagnostics.js";
import { appendFilePrivate, ensurePrivateDir, writeFilePrivate } from "./run-store-fs.js";
import { notifyRunEventSink } from "./run-observability.js";

function laneOutcomeForError(error) {
  if (error?.outcome && LANE_OUTCOMES.includes(error.outcome)) return error.outcome;
  if (error?.code === "WORKFLOW_CANCELLED") return "cancelled";
  if (error?.code === "WORKFLOW_TIMEOUT") return "timeout";
  if (error?.code === "WORKFLOW_BUDGET_STOPPED") return "budget_stopped";
  return "failure";
}

// Failure-class taxonomy carried alongside the LANE_OUTCOMES bucket so diagnostics and
// status can distinguish a transient-but-exhausted lane (rate-limit/overload that ran out
// of backed-off retries) or validation_exhausted lane (corrective turns spent) from a
// terminal one (bad model id, auth, schema with corrective retry disabled). The lane retry
// loop tags errors it gave up on with `error.laneFailureClass`.
// everything else is derived from the transient/terminal taxonomy in errors.js. Returns one
// of: "transient_exhausted" | "validation_exhausted" | "transient" | "terminal".
function laneFailureClassForError(error) {
  if (typeof error?.laneFailureClass === "string") return error.laneFailureClass;
  return classifyLaneError(error) === "transient" ? "transient" : "terminal";
}

function laneSignature(run, prompt, resolved) {
  return hash(stableStringify({
    // jbs3.3 (edit-and-resume / prefix reuse): the lane signature is CONTENT-ADDRESSED per lane —
    // it hashes only this lane's own effective inputs (resolved prompt + model + agent/role/system +
    // schema/outputFormat + permission policy + lane options + signatureVersion + runtimeArgs). The
    // whole-file `run.sourceHash` is deliberately NOT mixed in: a lane's output is fully determined
    // by the inputs above, so an edit to an UNRELATED part of the body must not invalidate this lane.
    // This lets an operator edit a workflow body and resume reusing every lane whose resolved inputs
    // are unchanged (served from the journal cache at zero re-spend) while only the edited lane and
    // its dependents — whose resolved prompt changed because it incorporates the edited upstream
    // output — re-run. Soundness: the journal is keyed by the deterministic callId (loadJournal),
    // not by signature, so two lanes with identical inputs never collide; the signature is a
    // per-callId VALIDATION field. The two-phase approval invariant is preserved independently — an
    // edited body yields a new sourceHash, which changes approvalHash and forces re-approval before
    // any lane (cached or re-run) executes.
    runtimeArgs: run.runtimeArgs,
    prompt,
    resolvedModel: resolved.modelKey,
    agent: resolved.agent,
    role: resolved.role,
    system: resolved.system,
    outputFormat: resolved.outputFormat,
    schema: resolved.schema,
    permissionPolicy: resolved.policy,
    laneOptions: normalizeAgentOptions(resolved.opts),
    // v2: capability probes removed (Design C); bumping the version invalidates pre-C
    // resume caches once, deliberately.
    signatureVersion: 2,
    // runtimeDiagnostics (SDK/plugin versions, server URL, client-shape booleans) is
    // deliberately excluded: it does not affect a child agent's output and is volatile
    // across processes (the server URL/port is randomized on each OpenCode start), so
    // including it would invalidate the entire resume cache on every cross-process resume.
  }));
}

async function appendEvent(run, event) {
  if (run.eventCount >= MAX_EVENTS) return;
  run.eventCount += 1;
  const record = {
    ts: new Date().toISOString(),
    runId: run.id,
    ...redactValue(event, { maxString: MAX_EVENT_MESSAGE_CHARS }),
  };
  run.lastEventAt = record.ts;
  run.lastEventType = typeof event?.type === "string" ? event.type : undefined;
  await appendFilePrivate(path.join(run.dir, "events.jsonl"), jsonLine(record), "utf8");
  await emitWorkflowDiagnostic(run, event);
  notifyRunEventSink(run, record);
}

async function appendJournal(run, record) {
  if (run.journalRecords >= MAX_JOURNAL_RECORDS) {
    throw new Error(`Workflow journal exceeded ${MAX_JOURNAL_RECORDS} records`);
  }
  run.journalRecords += 1;
  await appendFilePrivate(path.join(run.dir, "journal.jsonl"), jsonLine(redactDurableValue(record)), "utf8");
}

async function loadJournal(runDir) {
  const entries = new Map();
  try {
    const content = await fs.readFile(path.join(runDir, "journal.jsonl"), "utf8");
    for (const line of content.split(/\r?\n/)) {
      if (!line.trim()) continue;
      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        // A crash during the non-atomic appendFile can leave a truncated final line;
        // skip it rather than failing the whole resume.
        continue;
      }
      if (entry.callId) entries.set(entry.callId, entry);
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  return entries;
}

function signatureFallbackScope(callId) {
  const value = String(callId ?? "");
  const agentIndex = value.lastIndexOf("/agent:");
  const laneScope = agentIndex === -1 ? value : value.slice(0, agentIndex);
  const segments = laneScope.split("/").filter(Boolean);
  const lastItemIndex = segments.findLastIndex((segment) => /^item:\d+$/.test(segment));
  if (lastItemIndex > 0) return segments.slice(0, lastItemIndex).join("/");
  return laneScope;
}

function buildResumeSignatureIndex(resumeJournal) {
  const index = new Map();
  if (!(resumeJournal instanceof Map)) return index;
  for (const [mapCallId, entry] of resumeJournal.entries()) {
    if (!entry || typeof entry !== "object") continue;
    if (entry.outcome !== "success" || !entry.signatureHash) continue;
    const callId = String(entry.callId ?? mapCallId ?? "");
    if (!callId) continue;
    if (!entry.callId) entry.callId = callId;
    const scope = signatureFallbackScope(callId);
    let byScope = index.get(entry.signatureHash);
    if (!byScope) {
      byScope = new Map();
      index.set(entry.signatureHash, byScope);
    }
    let candidates = byScope.get(scope);
    if (!candidates) {
      candidates = [];
      byScope.set(scope, candidates);
    }
    candidates.push(entry);
  }
  return index;
}

function markResumeSignatureClaimed(run, callId) {
  if (!run || !callId) return;
  run.resumeSignatureClaims ??= new Set();
  run.resumeSignatureClaims.add(String(callId));
}

function claimResumeSignatureFallback(run, callId, signatureHash) {
  if (!run || !signatureHash) return null;
  const byScope = run.resumeSignatureIndex?.get(signatureHash);
  if (!byScope) return null;
  const candidates = byScope.get(signatureFallbackScope(callId));
  if (!Array.isArray(candidates) || candidates.length === 0) return null;
  run.resumeSignatureClaims ??= new Set();
  for (const entry of candidates) {
    const originalCallId = String(entry?.callId ?? "");
    if (!originalCallId || originalCallId === String(callId)) continue;
    if (run.resumeSignatureClaims.has(originalCallId)) continue;
    run.resumeSignatureClaims.add(originalCallId);
    return entry;
  }
  return null;
}

async function compactJournal(runDir, entries) {
  const values = entries instanceof Map ? [...entries.values()] : [...(entries ?? [])];
  const journalPath = path.join(runDir, "journal.jsonl");
  const tmp = `${journalPath}.${process.pid}.${Date.now()}.${crypto.randomUUID()}.tmp`;
  try {
    await writeFilePrivate(tmp, values.map((entry) => jsonLine(redactDurableValue(entry))).join(""), "utf8");
    await fs.rename(tmp, journalPath);
    return values.length;
  } catch (error) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw error;
  }
}

async function countNonEmptyLines(filePath) {
  try {
    const content = await fs.readFile(filePath, "utf8");
    let count = 0;
    for (const line of content.split(/\r?\n/)) if (line.trim()) count += 1;
    return count;
  } catch (error) {
    if (error.code === "ENOENT") return 0;
    throw error;
  }
}

function ledgerFilePath(runDir, fileName) {
  if (!DURABLE_LEDGER_FILES.includes(fileName) && !/^[a-z0-9_.-]+\.jsonl$/.test(fileName)) {
    throw new Error(`Invalid ledger file name: ${String(fileName)}`);
  }
  return path.join(runDir, fileName);
}

async function appendLedger(runOrDir, fileName, record) {
  const runDir = typeof runOrDir === "string" ? runOrDir : runOrDir?.dir;
  if (!runDir) throw new Error("appendLedger requires a run directory");
  await ensurePrivateDir(runDir);
  await appendFilePrivate(ledgerFilePath(runDir, fileName), jsonLine(redactDurableValue({ ts: new Date().toISOString(), ...record })), "utf8");
}

async function readJsonlLedger(filePath) {
  const records = [];
  try {
    const content = await fs.readFile(filePath, "utf8");
    for (const line of content.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        records.push(JSON.parse(line));
      } catch {
        // A crash during appendFile can truncate the final line; prior complete lines are still valid.
      }
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  return records;
}

function completedLedgerRecord(records, key, keyField = "mutationKey") {
  for (const record of [...records].reverse()) {
    if (record?.[keyField] === key && record.phase === "completed") return record;
  }
  return undefined;
}

function latestLedgerRecord(records, key, phase, keyField = "mutationKey") {
  for (const record of [...records].reverse()) {
    if (record?.[keyField] === key && record.phase === phase) return record;
  }
  return undefined;
}

function incompleteLedgerKeys(records, keyField) {
  const phases = new Map();
  for (const record of records) {
    const key = record?.[keyField];
    if (!key) continue;
    if (!phases.has(key)) phases.set(key, new Set());
    phases.get(key).add(record.phase || record.status || "unknown");
  }
  return [...phases.entries()]
    .filter(([, seen]) => !seen.has("completed") && !seen.has("failed"))
    .map(([key]) => key);
}

async function durableLedgerSummary(runDir) {
  const ledgers = {};
  for (const fileName of DURABLE_LEDGER_FILES) {
    const records = await readJsonlLedger(ledgerFilePath(runDir, fileName));
    const phases = {};
    for (const record of records) {
      const phase = record.phase || record.status || "unknown";
      phases[phase] = (phases[phase] || 0) + 1;
    }
    ledgers[fileName.replace(/\.jsonl$/, "")] = { records: records.length, phases };
  }
  return ledgers;
}

async function appendIntegrationLedger(run, record) {
  await appendLedger(run, "integration-ledger.jsonl", record);
}

async function appendValidationLedger(run, record) {
  await appendLedger(run, "validation-ledger.jsonl", record);
}

async function appendDomainLedger(run, record) {
  await appendLedger(run, "domain-ledger.jsonl", record);
}

// R16: stable, fixed-length, prefixed idempotency key derived purely from the (already deterministic)
// mutationKey. Same mutationKey -> same key across crashes/resumes, with no dependence on wall clock,
// random, or attempt count, so a replay can recognize an already-applied bd mutation.
function domainMutationIdempotencyKey(mutationKey) {
  return `ocw-idem-${hash(String(mutationKey)).slice(0, 24)}`;
}

async function runDomainMutation(run, options) {
  const mutationKey = String(options?.mutationKey ?? "");
  if (!mutationKey) throw new Error("runDomainMutation requires mutationKey");
  if (!hasFunction(options, "execute")) throw new Error("runDomainMutation requires execute");
  const ledgerPath = ledgerFilePath(run.dir, "domain-ledger.jsonl");
  const prior = await readJsonlLedger(ledgerPath);
  const completed = completedLedgerRecord(prior, mutationKey);
  if (completed) return { replayed: true, result: completed.result, readback: completed.readback };
  const executed = latestLedgerRecord(prior, mutationKey, "executed");
  if (executed) {
    const readback = hasFunction(options, "readback") ? await options.readback(executed.result) : undefined;
    await appendDomainLedger(run, { phase: "completed", mutationKey, operation: executed.operation ?? options.operation ?? "domain-mutation", result: redactValue(executed.result), readback: redactValue(readback) });
    return { replayed: true, result: executed.result, readback };
  }
  const operation = options.operation || "domain-mutation";
  // R16: derive a deterministic client-side idempotency key from the mutationKey and persist it in
  // the started record BEFORE execute runs. The window between execute returning (the bd mutation
  // already happened) and the executed record being durably appended is a crash point: on resume the
  // executed record is absent, so a naive replay re-runs execute and duplicates the bd resource
  // (a non-idempotent domain create/append would duplicate the resource on replay). Passing this stable
  // key into execute lets the adapter make the underlying create/append idempotent (external-ref
  // dedupe on create; marker dedupe on append), so the re-run is a no-op that returns the existing
  // resource instead of creating a duplicate.
  const idempotencyKey = options.idempotencyKey ? String(options.idempotencyKey) : domainMutationIdempotencyKey(mutationKey);
  await appendDomainLedger(run, { phase: "started", mutationKey, operation, idempotencyKey });
  try {
    const result = await options.execute(idempotencyKey);
    await appendDomainLedger(run, { phase: "executed", mutationKey, operation, idempotencyKey, result: redactValue(result) });
    const readback = hasFunction(options, "readback") ? await options.readback(result) : undefined;
    await appendDomainLedger(run, { phase: "completed", mutationKey, operation, result: redactValue(result), readback: redactValue(readback) });
    return { replayed: false, result, readback };
  } catch (error) {
    await appendDomainLedger(run, { phase: "failed", mutationKey, operation, error: extractTextFromError(error) });
    throw error;
  }
}

async function stageDomainMutation(run, options) {
  const mutationKey = String(options?.mutationKey ?? "");
  if (!mutationKey) throw new Error("stageDomainMutation requires mutationKey");
  const operation = options.operation || "domain-mutation";
  const ledgerPath = ledgerFilePath(run.dir, "domain-ledger.jsonl");
  const prior = await readJsonlLedger(ledgerPath);
  if (completedLedgerRecord(prior, mutationKey) || latestLedgerRecord(prior, mutationKey, "staged")) {
    return { staged: true, replayed: true, mutationKey, operation, payload: options.payload };
  }
  const record = { phase: "staged", mutationKey, operation, payload: options.payload };
  await appendDomainLedger(run, record);
  return { staged: true, replayed: false, mutationKey, operation, payload: options.payload };
}

function stagedDomainMutations(records) {
  const staged = new Map();
  for (const record of records) {
    const mutationKey = record?.mutationKey;
    if (!mutationKey) continue;
    if (record.phase === "staged") staged.set(mutationKey, record);
    if (record.phase === "completed") staged.delete(mutationKey);
  }
  return [...staged.values()];
}

function formatMutationManifestEntries(records) {
  return records
    .map((record) => ({
      mutationKey: record.mutationKey,
      operation: record.operation,
      payloadHash: hash(stableStringify(record.payload ?? null)),
    }))
    .sort((left, right) => String(left.mutationKey).localeCompare(String(right.mutationKey)) || String(left.operation).localeCompare(String(right.operation)));
}

function domainMutationManifest(records) {
  return formatMutationManifestEntries(stagedDomainMutations(records));
}

function domainMutationApprovalManifest(records) {
  const approved = new Map();
  for (const record of records) {
    const mutationKey = record?.mutationKey;
    if (!mutationKey) continue;
    if (record.phase === "staged") approved.set(mutationKey, record);
  }
  return formatMutationManifestEntries([...approved.values()]);
}

function computeDomainMutationHash(manifest) {
  return hash(stableStringify(Array.isArray(manifest) ? manifest : []));
}

async function stagedDomainMutationManifest(runDir) {
  return domainMutationManifest(await readJsonlLedger(ledgerFilePath(runDir, "domain-ledger.jsonl")));
}

async function domainMutationApprovalManifestForRun(runDir) {
  return domainMutationApprovalManifest(await readJsonlLedger(ledgerFilePath(runDir, "domain-ledger.jsonl")));
}

async function executeStagedDomainMutation(record, idempotencyKey, resolveMutationHandler) {
  const operation = String(record.operation ?? "");
  // Domain mutation finalization is owned by trusted extensions, resolved by exact operation name.
  // The resolver is threaded from the caller (which holds the per-pluginContext extension registry),
  // so event-journal stays domain-neutral and no longer imports any domain adapter.
  const handler = typeof resolveMutationHandler === "function" ? resolveMutationHandler(operation) : undefined;
  if (typeof handler !== "function") throw new Error(`Unsupported staged domain mutation operation: ${operation}`);
  // R16: forward the deterministic idempotency key so the adapter can dedupe a crash-resume re-run
  // of a non-idempotent create/append against an already-applied mutation.
  return await handler({ operation: record.operation, idempotencyKey, ...(record.payload ?? {}) });
}

async function finalizeStagedDomainMutations(runDir, state = {}, resolveMutationHandler) {
  const records = await readJsonlLedger(ledgerFilePath(runDir, "domain-ledger.jsonl"));
  const staged = stagedDomainMutations(records);
  if (staged.length === 0) return { finalized: 0, pending: 0, results: [] };
  const run = { id: state.id, dir: runDir };
  const results = [];
  for (const record of staged) {
    const result = await runDomainMutation(run, {
      mutationKey: record.mutationKey,
      operation: record.operation,
      execute: async (idempotencyKey) => await executeStagedDomainMutation(record, idempotencyKey, resolveMutationHandler),
    });
    results.push({ mutationKey: record.mutationKey, operation: record.operation, replayed: result.replayed, result: result.result });
  }
  return { finalized: results.length, pending: 0, results };
}

async function appendApplyLedger(runDir, record) {
  await appendLedger(runDir, "apply-ledger.jsonl", record);
}

// Idempotency source-of-truth for apply: a whole, last-written `completed` record whose
// diffPlanHash matches the approved plan. The completed-ledger append precedes the
// state.json=applied write, so a crash in that window leaves on-disk status apply-running
// (reconciled to interrupted/stale-active). Detecting the completed record here is what
// lets the apply gate admit those recovery statuses onto the idempotent finalize path
// instead of wedging the run permanently out of workflow_apply.
async function applyLedgerHasCompleted(runDir, diffPlanHash) {
  const records = await readJsonlLedger(ledgerFilePath(runDir, "apply-ledger.jsonl"));
  return records.some((record) => record.phase === "completed" && record.diffPlanHash === diffPlanHash);
}

export {
  laneOutcomeForError,
  laneFailureClassForError,
  laneSignature,
  appendEvent,
  appendJournal,
  loadJournal,
  signatureFallbackScope,
  buildResumeSignatureIndex,
  markResumeSignatureClaimed,
  claimResumeSignatureFallback,
  compactJournal,
  countNonEmptyLines,
  ledgerFilePath,
  appendLedger,
  readJsonlLedger,
  completedLedgerRecord,
  latestLedgerRecord,
  incompleteLedgerKeys,
  durableLedgerSummary,
  appendIntegrationLedger,
  appendValidationLedger,
  appendDomainLedger,
  domainMutationIdempotencyKey,
  runDomainMutation,
  stageDomainMutation,
  stagedDomainMutations,
  domainMutationManifest,
  domainMutationApprovalManifest,
  computeDomainMutationHash,
  stagedDomainMutationManifest,
  domainMutationApprovalManifestForRun,
  executeStagedDomainMutation,
  finalizeStagedDomainMutations,
  appendApplyLedger,
  applyLedgerHasCompleted,
};
