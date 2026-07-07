// Trusted Beads adapter for the host-owned drain runtime. It owns local bd reads,
// controller-owned Beads mutations, validation, closeout staging, and final dry
// proof for the bundled beads-drain workflow.
import path from "node:path";
import { runDomainMutation, stageDomainMutation } from "../../workflow-kernel/event-journal.js";
import { redactFreeTextSecrets } from "../../workflow-kernel/free-text-redactor.js";
import { hash } from "../../workflow-kernel/text-json.js";
import { defaultRunBd, parseBdJson } from "./beads-bd-util.js";

// Re-exported: tests/beads-drain-scratch.test.mjs imports defaultRunBd from this adapter.
export { defaultRunBd };

const DEFAULT_READY_LIMIT = 1000;
const EPIC_TYPE = "epic";
const HUMAN_LABELS = new Set(["needs-human", "human-gated", "blocked"]);

function redactNoteText(value) {
  return redactFreeTextSecrets(String(value ?? ""));
}

function redactNoteList(values, separator) {
  return Array.isArray(values) && values.length > 0
    ? values.map((value) => redactNoteText(value)).join(separator)
    : "";
}

export function normalizeIssue(raw) {
  if (!raw || typeof raw !== "object") throw new Error("Invalid Beads issue payload");
  const labels = Array.isArray(raw.labels) ? raw.labels : typeof raw.labels === "string" ? raw.labels.split(/[,\s]+/).filter(Boolean) : [];
  return {
    ...raw,
    id: raw.id ?? raw.issue_id ?? raw.issueId,
    issue_type: raw.issue_type ?? raw.type ?? raw.kind,
    status: raw.status ?? raw.state,
    assignee: raw.assignee ?? raw.assigned_to,
    owner: raw.owner,
    title: raw.title ?? "",
    description: raw.description ?? raw.body ?? "",
    acceptance_criteria: raw.acceptance_criteria ?? raw.acceptance ?? raw.acceptanceCriteria ?? "",
    notes: raw.notes ?? "",
    labels,
  };
}

export function issueId(issue) {
  const id = normalizeIssue(issue).id;
  if (typeof id !== "string" || !id) throw new Error("Beads issue requires string id");
  return id;
}

export function issueType(issue) {
  return normalizeIssue(issue).issue_type;
}

export function issueStatus(issue) {
  return normalizeIssue(issue).status;
}

export function isEpic(issue) {
  return issueType(issue) === EPIC_TYPE;
}

export function isClosed(issue) {
  return issueStatus(issue) === "closed";
}

export function isInProgress(issue) {
  return issueStatus(issue) === "in_progress";
}

export function isAssignedToActor(issue, actor) {
  const normalized = normalizeIssue(issue);
  return typeof actor === "string" && actor !== "" && (normalized.assignee === actor || normalized.owner === actor);
}

export function isLlmReady(issue) {
  const normalized = normalizeIssue(issue);
  return normalized.labels.includes("ready-for-agent") && Boolean(normalized.description) && Boolean(normalized.acceptance_criteria);
}

function issueTypesFromScope(scope = {}) {
  const requested = scope.issueTypes ?? scope.issue_type ?? scope.issueType;
  if (!requested) return undefined;
  const values = Array.isArray(requested) ? requested : [requested];
  const normalized = values.map((value) => String(value).trim()).filter(Boolean);
  return normalized.length > 0 ? normalized : undefined;
}

export function filterReadyIssues(items, scope = {}, options = {}) {
  const includeEpics = scope.includeEpics === true || issueTypesFromScope(scope)?.includes(EPIC_TYPE);
  const types = issueTypesFromScope(scope);
  const labels = Array.isArray(scope.labels) ? scope.labels : scope.label ? [scope.label] : [];
  const excludeLabels = Array.isArray(scope.excludeLabels) ? scope.excludeLabels : [];
  const statuses = Array.isArray(options.statuses) ? options.statuses : undefined;
  return (Array.isArray(items) ? items : [])
    .map(normalizeIssue)
    .filter((issue) => !statuses || statuses.includes(issue.status))
    .filter((issue) => includeEpics || issue.issue_type !== EPIC_TYPE)
    .filter((issue) => !types || types.includes(issue.issue_type))
    .filter((issue) => labels.every((label) => issue.labels.includes(label)))
    .filter((issue) => excludeLabels.every((label) => !issue.labels.includes(label)));
}

function stdoutFrom(result) {
  return typeof result === "string" ? result : result?.stdout ?? "";
}

function firstIssue(payload) {
  const value = Array.isArray(payload) ? payload[0] : payload?.issue ?? payload;
  return value ? normalizeIssue(value) : undefined;
}

function mergeIssues(groups) {
  const byId = new Map();
  for (const group of groups) {
    for (const issue of Array.isArray(group) ? group.map(normalizeIssue) : []) {
      if (issue.id && !byId.has(issue.id)) byId.set(issue.id, issue);
    }
  }
  return [...byId.values()];
}

// A change is "doc-only" when every changed file is documentation/prose. Doc-only lanes have no
// executable surface for the central verifier to re-run, so pure-prose acceptanceEvidence is
// allowed to accept them (the deliberate doc-only path). A change that touches even one non-doc
// (code/config) file is NOT doc-only and must carry at least one verifier-passed command — prose
// alone is not re-verifiable proof for code.
const DOC_FILE_EXTENSIONS = new Set([".md", ".markdown", ".mdx", ".rst", ".adoc", ".txt", ".text"]);
const DOC_FILE_BASENAMES = new Set(["license", "licence", "copying", "notice", "authors", "changelog", "changes", "readme", "contributing", "codeowners"]);
function isDocPath(filePath) {
  const raw = String(filePath ?? "").trim();
  if (!raw) return false;
  const normalized = raw.replace(/\\/g, "/").toLowerCase();
  const base = normalized.split("/").pop() ?? "";
  const dotIdx = base.lastIndexOf(".");
  const ext = dotIdx > 0 ? base.slice(dotIdx) : "";
  if (DOC_FILE_EXTENSIONS.has(ext)) return true;
  const baseNoExt = dotIdx > 0 ? base.slice(0, dotIdx) : base;
  if (DOC_FILE_BASENAMES.has(baseNoExt)) return true;
  // Files under a docs/ directory segment are treated as documentation.
  if (normalized.split("/").slice(0, -1).includes("docs")) return true;
  return false;
}
function normalizeChangedFiles(filesChanged) {
  return (Array.isArray(filesChanged) ? filesChanged : [])
    .map((entry) => (entry && typeof entry === "object" ? entry.path ?? entry.file ?? "" : entry))
    .map((entry) => String(entry ?? "").trim())
    .filter(Boolean);
}
// Resolve doc-vs-code scope from CONTROLLER GROUND TRUTH first, falling back to the lane's
// self-reported manifest only when no ground truth is available.
//
// opencode-workflows-qga: the doc-only decision used to derive from laneReport.filesChanged, a
// self-reported claim in the same trust class R11 closed for commandsRun. A fabricating lane could
// reach the prose-only accept path three ways: mislabel a code file as `.md`, place it under a
// `docs/` segment, or omit filesChanged entirely (empty manifest was treated as doc-only by design).
//
// Fix: when the controller provides the integrated diff's name-only paths (git ground truth the lane
// cannot spoof), classify scope from THOSE. The `.md`/`docs/` mislabels are defeated because git
// reports the real path. When no ground truth is available (e.g. autonomous-local without an
// integration worktree), an ABSENT or EMPTY manifest is treated as UNKNOWN scope (NOT doc-only), so
// it can no longer auto-qualify for prose-only accept — it must carry a verifier-passed command.
function resolveChangeScope({ controllerChangedPaths, laneFilesChanged } = {}) {
  const controllerFiles = normalizeChangedFiles(controllerChangedPaths);
  if (controllerFiles.length > 0) {
    return { docOnly: controllerFiles.every(isDocPath), scopeSource: "controller-diff", manifestPresent: true };
  }
  const laneFiles = normalizeChangedFiles(laneFilesChanged);
  if (laneFiles.length === 0) {
    // Absent/empty manifest with no controller ground truth: scope is unknown. Fail closed (treat as
    // non-doc) so an omitted manifest cannot reach the prose-only accept path on a non-failed lane.
    return { docOnly: false, scopeSource: "unknown-no-manifest", manifestPresent: false };
  }
  return { docOnly: laneFiles.every(isDocPath), scopeSource: "lane-manifest", manifestPresent: true };
}

function hasFindings(value) {
  if (Array.isArray(value)) return value.length > 0;
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value.issues)) return value.issues.length > 0;
  if (Array.isArray(value.items)) return value.items.length > 0;
  if (Number.isFinite(value.count)) return value.count > 0;
  if (Number.isFinite(value.total)) return value.total > 0;
  if (Number.isFinite(value.issues)) return value.issues > 0;
  return Object.keys(value).length > 0 && value.ok !== true && value.clean !== true;
}

function filterStagedDuplicateFindings(value, stagedClosedIds) {
  if (!value || typeof value !== "object" || !Array.isArray(value.pairs)) return value;
  const pairs = value.pairs.filter((pair) => !stagedClosedIds.has(pair.issue_a_id) || !stagedClosedIds.has(pair.issue_b_id));
  return { ...value, pairs, count: pairs.length };
}

export function classifyVerifier({
  failed,
  unableToVerify,
  verifierTruncated,
  unprovenProse,
  allUnableToRun,
  verifierEvidence = [],
  claimedCommands = [],
  verifierRunCommands = 0,
  verifierTotalCommands = 0,
}) {
  if (unableToVerify) {
    return {
      classification: "unable-to-verify",
      reason: `central verifier inert: no validation runner wired, cannot re-check ${claimedCommands.length} claimed command(s) (fabricated-evidence guard)`,
    };
  }
  if (failed) {
    return {
      classification: "fail",
      reason: `central verifier failed: ${failed.command} -> ${failed.detail || "non-zero exit"}`,
    };
  }
  if (verifierTruncated) {
    return {
      classification: "truncated",
      reason: `central verifier truncated: ran ${verifierRunCommands} of ${verifierTotalCommands} reported command(s); unverified tail cannot silently pass (raise maxVerifierCommands or split the lane)`,
    };
  }
  if (unprovenProse) {
    return {
      classification: "unproven-prose",
      reason: "code/config change has no verifier-passed command: pure-prose acceptanceEvidence is not re-verifiable proof (run a validation command, or scope the lane to doc-only changes)",
    };
  }
  if (allUnableToRun) {
    return {
      classification: "unable-to-run",
      reason: `central verifier proved nothing: all ${verifierEvidence.length} re-run command(s) were unable-to-run (tool missing / wrong cwd); a passing command is required to accept`,
    };
  }
  if (verifierEvidence.length > 0) return { classification: "pass", reason: "central verifier passed" };
  return { classification: "skipped", reason: "central verifier skipped" };
}

export function createBeadsDrainAdapter(options = {}) {
  const cwd = options.cwd ?? process.cwd();
  const runBd = options.runBd ?? defaultRunBd;
  const actor = options.actor;
  const baseScope = options.scope ?? {};
  const commandEvidence = [];
  const stagedClosedIds = new Set();
  const claimedIds = new Set();
  const releasedClaimIds = new Set();

  async function bd(args, { json = true, readonly = true, operation = "read" } = {}) {
    const finalArgs = [...args];
    if (json && !finalArgs.includes("--json")) finalArgs.push("--json");
    if (readonly && !finalArgs.includes("--readonly")) finalArgs.push("--readonly");
    if (actor && !finalArgs.includes("--actor")) finalArgs.push("--actor", actor);
    if (options.allowGlobal !== true && finalArgs.includes("--global")) throw new Error("Beads adapter is local-only by default; --global is not allowed");
    commandEvidence.push({ args: finalArgs, readonly, operation });
    const result = await runBd(finalArgs, { cwd, operation, readonly, json, signal: options.signal, timeoutMs: options.timeoutMs, maxBuffer: options.maxBuffer });
    return json ? parseBdJson(stdoutFrom(result), `bd ${args.join(" ")}`) : stdoutFrom(result);
  }

  async function showIssue(id) {
    return firstIssue(await bd(["show", "--id", id, "--long"]));
  }

  function assertControllerMutation(operation) {
    if (options.controller === false || options.laneAuthority === "child" || options.laneAuthority === "lane" || options.laneAuthority === "worker") {
      throw new Error(`Beads mutation ${operation} is controller-only`);
    }
    if (!options.run) throw new Error(`Beads mutation ${operation} requires a durable domain ledger run`);
  }

  async function mutate(mutationKey, operation, execute, readback) {
    assertControllerMutation(operation);
    const result = await runDomainMutation(options.run, { mutationKey, operation, execute, readback });
    return result.readback ?? result.result;
  }

  async function stage(mutationKey, operation, payload) {
    assertControllerMutation(operation);
    return await stageDomainMutation(options.run, { mutationKey, operation, payload: { cwd, actor, ...payload } });
  }

  function effectiveScope(scope) {
    return { ...baseScope, ...(scope ?? {}) };
  }

  function repoRootFromWhere(stdout) {
    const firstLine = String(stdout ?? "").split(/\r?\n/)[0]?.trim();
    if (!firstLine) return "";
    // `bd where` prints the .beads directory first; the project repo root is its parent.
    return path.dirname(firstLine);
  }

  async function preflightRepo(scoped) {
    const whereStdout = await bd(["where"], { json: false, readonly: true });
    const actualRepo = repoRootFromWhere(whereStdout);
    if (!actualRepo) {
      throw new Error("beads-drain preflight could not resolve a Beads database via `bd where`; refusing to run a silent no-op drain");
    }
    if (scoped.repo !== undefined && scoped.repo !== null && String(scoped.repo).trim() !== "") {
      const expected = path.resolve(String(scoped.repo));
      if (expected !== path.resolve(actualRepo)) {
        throw new Error(
          `beads-drain preflight rejected wrong repo: args.repo=${expected} does not match bd where repo=${path.resolve(actualRepo)} (stop_reason: human_decision_required). Point the drain at a single concrete project repo.`,
        );
      }
    }
    return actualRepo;
  }

  // Central verifier (R11/.4): re-run the lane's reported validation commands instead of trusting
  // self-reported evidence ("validation theater"). A lane report is a CLAIM, not proof.
  //
  // Two distinct "cannot prove it" states, which must NOT be conflated:
  //   - verifierEnabled === false: NO runner is wired (the shipped autonomous-local default).
  //     The verifier is inert, so a lane that fabricates commandsRun cannot be re-checked. If the
  //     lane claims it ran commands, that claim is unverifiable and acceptance MUST fail closed.
  //   - "unable-to-run": a runner IS wired but a specific command could not execute (tool missing,
  //     spawn error). That is a per-command runtime gap, not a fabrication surface, and keeps the
  //     existing non-fatal behavior so a flaky local tool does not strand the queue.
  //
  // Returns { verifierEnabled, evidence, truncated, totalCommands, runCommands } where each
  // evidence entry is {command, result, detail} and result is "pass" | "fail" | "unable-to-run".
  //
  // F5 fail-closed: the verifier only re-runs the first MAX_VERIFIER_COMMANDS of the lane's
  // commandsRun. A lane that pads many passing commands before a real failing check (or simply
  // reports more than the cap) would otherwise leave the failing/unchecked tail unverified while
  // the lane still passed silently. On truncation we (a) record full-attempted vs actually-run
  // counts, (b) append a synthetic "unable-to-run" entry naming the unverified tail, and
  // (c) set truncated=true so validate() can fail acceptance closed instead of silently passing.
  const DEFAULT_MAX_VERIFIER_COMMANDS = 8;
  function maxVerifierCommands() {
    const configured = options.maxVerifierCommands;
    return Number.isInteger(configured) && configured > 0 ? configured : DEFAULT_MAX_VERIFIER_COMMANDS;
  }
  function verifierEnabled() {
    return typeof options.runValidationCommand === "function";
  }
  async function runVerifierEvidence(laneReport) {
    const enabled = verifierEnabled();
    const commands = Array.isArray(laneReport?.commandsRun)
      ? laneReport.commandsRun.filter((cmd) => typeof cmd === "string" && cmd.trim())
      : [];
    if (!enabled) return { verifierEnabled: false, evidence: [], truncated: false, totalCommands: commands.length, runCommands: 0 };
    const runner = options.runValidationCommand;
    const cap = maxVerifierCommands();
    const toRun = commands.slice(0, cap);
    const truncated = commands.length > cap;
    const evidence = [];
    for (const command of toRun) {
      try {
        const result = await runner(command);
        const exitCode = Number.isInteger(result?.exitCode) ? result.exitCode : result?.ok === false ? 1 : 0;
        const detail = String(result?.stdout ?? result?.stderr ?? result?.detail ?? "").replace(/\s+/g, " ").trim().slice(0, 200);
        evidence.push({ command, result: exitCode === 0 ? "pass" : "fail", exitCode, detail });
      } catch (error) {
        evidence.push({ command, result: "unable-to-run", detail: String(error?.message ?? error).replace(/\s+/g, " ").trim().slice(0, 200) });
      }
    }
    if (truncated) {
      // Name the unverified tail so the synthetic entry is not silent. This entry flips the
      // verifier off "pass" and validate() rejects on `truncated`, so the unchecked commands
      // (which could contain a failure) can never auto-close the issue.
      evidence.push({
        command: `[${commands.length - cap} more command(s) not run]`,
        result: "unable-to-run",
        detail: `exceeded MAX_VERIFIER_COMMANDS (cap=${cap}, reported=${commands.length}); unverified: ${commands.slice(cap).join(", ")}`.slice(0, 200),
      });
    }
    return { verifierEnabled: true, evidence, truncated, totalCommands: commands.length, runCommands: toRun.length };
  }


  function readyArgs(scope) {
    const args = ["ready", "--limit", String(Number.isInteger(scope.limit) ? scope.limit : DEFAULT_READY_LIMIT)];
    const types = issueTypesFromScope(scope);
    if (types?.length === 1) args.push("--type", types[0]);
    if (!(scope.includeEpics === true || types?.includes(EPIC_TYPE))) args.push("--exclude-type", EPIC_TYPE);
    if (scope.parent) args.push("--parent", String(scope.parent));
    for (const label of Array.isArray(scope.labels) ? scope.labels : []) args.push("--label", label);
    for (const label of Array.isArray(scope.excludeLabels) ? scope.excludeLabels : []) args.push("--exclude-label", label);
    return args;
  }

  const adapter = {
    name: "beads",
    commands: commandEvidence,
    async discover(scope) {
      const scoped = effectiveScope(scope);
      await preflightRepo(scoped);
      await bd(["status"], { json: true, readonly: true });
      const ready = await bd(readyArgs(scoped), { json: true, readonly: true });
      const inProgress = await bd(["list", "--status", "in_progress", "--limit", "0"], { json: true, readonly: true });
      return mergeIssues([filterReadyIssues(ready, scoped, { statuses: ["open"] }), filterReadyIssues(inProgress, scoped, { statuses: ["in_progress"] })])
        .filter((issue) => !stagedClosedIds.has(issue.id));
    },
    async classify(item) {
      const issue = normalizeIssue(item);
      if (isClosed(issue)) return { status: "done", reason: "issue is closed" };
      if (isEpic(issue)) return { status: "external", reason: "epics are not autonomous implementation work" };
      if (issue.status === "blocked") return { status: "blocked", reason: "issue status is blocked" };
      if (issue.labels.some((label) => HUMAN_LABELS.has(label))) return { status: "human-gated", reason: "issue has human/blocking labels" };
      if (isInProgress(issue) && !isAssignedToActor(issue, actor)) return { status: "human-gated", reason: "in-progress issue is not assigned to this controller" };
      if (!isLlmReady(issue)) return { status: "human-gated", reason: "issue is missing ready-for-agent label, description, or acceptance criteria" };
      return { status: "ready", reason: isInProgress(issue) ? "continuing issue assigned to this controller" : "issue is LLM-ready" };
    },
    async claim(item) {
      const id = issueId(item);
      const result = await mutate(
        `bd-claim:${id}`,
        "claim",
        async () => await bd(["update", id, "--claim"], { json: false, readonly: false, operation: "claim" }),
        async () => await showIssue(id),
      );
      // Assert the fresh readback like releaseClaim does: a `bd update --claim` that no-ops, or a
      // TOCTOU race where another actor already owns the item, must NOT be treated as a successful
      // claim. Without this the controller would dispatch a lane for an item it does not own
      // (fail-open at the ownership boundary).
      const readback = normalizeIssue(result ?? {});
      if (readback.id !== id) throw new Error(`Beads claim readback returned a different issue for ${id} (got ${readback.id ?? "no id"})`);
      if (readback.status !== "in_progress") throw new Error(`Beads claim readback did not show in_progress status for ${id} (got ${readback.status ?? "no status"})`);
      if (actor && !isAssignedToActor(readback, actor)) throw new Error(`Beads claim readback is not assigned to this controller for ${id} (got ${readback.assignee ?? "unassigned"})`);
      claimedIds.add(id);
      return readback;
    },
    async buildLanePacket(item) {
      const id = issueId(item);
      const issue = await showIssue(id);
      return {
        adapter: "beads",
        item: issue,
        instructions: [
          "Implement only the assigned issue scope.",
          "Do not run Beads mutation commands such as bd update, bd create, bd close, or bd dep add from the child lane.",
          "Return a generic lane report with commands, acceptance evidence, residual risks, and followups.",
        ],
        expectedReport: "LaneReport",
      };
    },
    async validate(item, integrationState, context = {}) {
      const id = issueId(item);
      const issue = await showIssue(id);
      const laneReport = context.laneReport ?? {};
      const claimedCommands = Array.isArray(laneReport.commandsRun)
        ? laneReport.commandsRun.filter((cmd) => typeof cmd === "string" && cmd.trim())
        : [];
      const evidenceCount = (laneReport.acceptanceEvidence?.length ?? 0) + (laneReport.commandsRun?.length ?? 0);
      const diffScopeOk = integrationState?.status !== "review-required" && integrationState?.status !== "conflict";

      // Central verifier: re-run the lane's validation commands. A self-reported-evidence lane
      // whose commands actually fail must NOT be closed.
      const { verifierEnabled: verifierIsEnabled, evidence: verifierEvidence, truncated: verifierTruncated, totalCommands: verifierTotalCommands, runCommands: verifierRunCommands } = await runVerifierEvidence(laneReport);

      // R11 fail-closed: when no validation runner is wired, the verifier is inert and cannot
      // re-check the lane's claimed commandsRun. A lane that fabricates commandsRun would otherwise
      // be accepted on `evidenceCount > 0` alone. Treat "claims commands but cannot be verified" as
      // unable-to-verify and reject, so fabricated evidence is never auto-applied.
      const unableToVerify = !verifierIsEnabled && claimedCommands.length > 0;

      const failed = verifierEvidence.find((entry) => entry.result === "fail");
      const verifierProvenCommand = verifierEvidence.some((entry) => entry.result === "pass");

      // R11-followup (opencode-workflows-1aw): close the prose channel of validation theater.
      // R11 shut the commandsRun channel (claimed-but-unverifiable commands -> unable-to-verify).
      // But a lane could still report acceptanceEvidence:['looks good'] with commandsRun:[], so
      // claimedCommands.length===0 -> unableToVerify=false -> verifierPassed=true, and it was
      // accepted on evidenceCount>0 with ZERO re-verifiable proof. For a non-doc (code/config)
      // change we now require at least one verifier-passed command: pure-prose acceptanceEvidence
      // is not re-verifiable proof.
      //
      // R11-followup-2 (opencode-workflows-qga): the doc-vs-code decision itself must not derive from
      // the lane's self-reported filesChanged (same trust class). Prefer the controller's integrated
      // diff (git name-only ground truth, passed as context.controllerChangedPaths) so a lane that
      // mislabels a code file as .md / under a docs/ segment cannot spoof doc-only. When no ground
      // truth is available, an absent/empty manifest is treated as unknown scope (NOT doc-only), so it
      // can no longer reach the prose-only accept path on a non-failed lane.
      const { docOnly, scopeSource: changeScopeSource } = resolveChangeScope({
        controllerChangedPaths: context.controllerChangedPaths,
        laneFilesChanged: laneReport.filesChanged,
      });
      const unprovenProse = !docOnly && !verifierProvenCommand;

      // R12 fail-closed: when a runner IS wired and the lane reported commands, but EVERY entry is
      // "unable-to-run" (binary missing / wrong cwd / spawn error), the verifier re-ran nothing
      // successfully — there is zero real verification. For a non-doc change `unprovenProse` already
      // catches this, but a doc-only lane (unprovenProse=false) would otherwise pass with no proof.
      // Require: verifierEvidence empty (nothing claimed to re-run) OR at least one entry passed.
      // A non-empty evidence set with no pass and no fail is all-unable-to-run and must not accept.
      const allUnableToRun = verifierEvidence.length > 0 && !verifierProvenCommand && !failed;

      // F5 fail-closed: truncation means the verifier did NOT re-run the full reported command set,
      // so an unverified tail (which could contain a failing check) cannot silently pass. This is a
      // distinct state from per-command "unable-to-run" (a wired runner hitting a missing tool),
      // which stays non-fatal so a flaky local tool does not strand the queue.
      const verifierResult = classifyVerifier({
        failed,
        unableToVerify,
        verifierTruncated,
        unprovenProse,
        allUnableToRun,
        verifierEvidence,
        claimedCommands,
        verifierRunCommands,
        verifierTotalCommands,
      });
      const verifierClassification = verifierResult.classification;
      const verifierPassed = !failed && !unableToVerify && !verifierTruncated && !unprovenProse && !allUnableToRun;

      const accepted = issue.id === id && laneReport.readyForIntegration === true && diffScopeOk && evidenceCount > 0 && verifierPassed;
      const checklist = ["fresh bd show readback", "lane evidence present", "integration scope accepted"];
      checklist.push(`central verifier: ${verifierClassification}${verifierIsEnabled ? "" : " (runner not wired)"}`);
      checklist.push(`change scope: ${docOnly ? "doc-only (prose evidence allowed)" : "code/config (verifier-passed command required)"} [source: ${changeScopeSource}]`);
      return {
        itemId: id,
        accepted,
        reason: accepted
          ? "fresh Beads readback and central-verifier-accepted lane evidence"
          : ["unable-to-verify", "fail", "truncated", "unproven-prose", "unable-to-run"].includes(verifierClassification)
            ? verifierResult.reason
            : "missing lane evidence, readback, or clean integration proof",
        diffScopeOk,
        followupsHandled: true,
        acceptanceChecklist: checklist,
        validationCommands: [`bd show --id ${id} --long --json --readonly`, ...verifierEvidence.map((entry) => entry.command)],
        followups: [],
        verifierEnabled: verifierIsEnabled,
        verifierEvidence,
        verifierClassification,
        verifierTruncated,
        verifierTotalCommands,
        verifierRunCommands,
        docOnly,
        changeScopeSource,
      };
    },
    async close(item, evidence = {}) {
      const id = issueId(item);
      const lane = evidence.laneReport ?? {};
      const validation = evidence.validationReport ?? {};
      const verifierLines = Array.isArray(validation.verifierEvidence) && validation.verifierEvidence.length > 0
        ? validation.verifierEvidence.map((entry) => {
          const command = redactNoteText(entry.command);
          const detail = entry.detail ? ` (${redactNoteText(entry.detail)})` : "";
          return `  - ${command}: ${entry.result}${detail}`;
        })
        : [];
      const note = [
        "VALIDATION: Beads drain closeout",
        `Lane summary: ${lane.summary ?? "not provided"}`,
        `Validation reason: ${validation.reason ?? "not provided"}`,
        `Commands: ${redactNoteList(lane.commandsRun, ", ") || "not recorded"}`,
        `Acceptance evidence: ${redactNoteList(lane.acceptanceEvidence, "; ") || "not recorded"}`,
        verifierLines.length > 0 ? `Central verifier (${validation.verifierClassification ?? "skipped"}):\n${verifierLines.join("\n")}` : "",
      ].filter((line) => line !== "").join("\n");
      await stage(
        `bd-note:${id}:${hash(note)}`,
        "beads.append-notes",
        { issueId: id, note },
      );
      await stage(
        `bd-close:${id}:${hash(validation.reason ?? lane.summary ?? id)}`,
        "beads.close",
        { issueId: id, reason: `Completed by beads drain: ${validation.reason ?? "validated"}` },
      );
      stagedClosedIds.add(id);
      return { id, status: "staged-close", staged: true };
    },
    async releaseClaim(item, context = {}) {
      const id = issueId(item);
      const reason = String(context.reason ?? context.outcome ?? "lane failed or cancelled");
      const salvage = context.salvage ?? context.laneReport?.salvage;
      const salvageFiles = Array.isArray(salvage?.changedFiles)
        ? salvage.changedFiles.map((entry) => entry.path ?? entry).filter(Boolean)
        : [];
      const note = [
        "DRAIN CLEANUP: controller released a failed/cancelled claim.",
        `Reason: ${reason}`,
        salvage?.dirty ? "Salvage: dirty lane worktree was preserved for review." : "",
        salvage?.worktreePath ? `Salvage worktree: ${salvage.worktreePath}` : "",
        salvageFiles.length > 0 ? `Salvage changed files: ${salvageFiles.join(", ")}` : "",
        "The issue was reopened and unassigned for re-classification; it was NOT closed by this drain.",
        "Re-run the drain or re-scope the work; do not assume this issue is complete.",
      ].filter(Boolean).join("\n");
      const issue = await mutate(
        `bd-release:${id}:${hash(note)}`,
        "beads.release-claim",
        async (idempotencyKey) => {
          const marker = idempotencyKey ? `[ocw-idem:${idempotencyKey}]` : "";
          if (marker) {
            const existing = await showIssue(id);
            if (String(existing?.notes ?? "").includes(marker)) return existing;
          }
          const markedNote = marker ? `${note}\n${marker}` : note;
          await bd(["update", id, "--append-notes", markedNote, "--status", "open", "--assignee", ""], { json: false, readonly: false, operation: "release-claim" });
          return await showIssue(id);
        },
        async () => await showIssue(id),
      );
      const resolved = issue && typeof issue === "object" ? issue : await showIssue(id);
      const readback = resolved ? normalizeIssue(resolved) : null;
      if (readback?.status !== undefined && readback.status !== "open") throw new Error(`Beads release readback did not show open status for ${id}`);
      if (actor && readback?.assignee === actor) throw new Error(`Beads release readback still shows controller assignee for ${id}`);
      releasedClaimIds.add(id);
      return { id, status: "released", staged: false, reason, issue: readback };
    },
    async createFollowup(followup = {}) {
      const title = String(followup.title ?? "Follow-up from drain");
      const description = String(followup.description ?? followup.summary ?? "Follow-up created by drain adapter.");
      const type = String(followup.type ?? "task");
      const priority = Number.isInteger(followup.priority) ? followup.priority : 2;
      const dependsOn = followup.dependsOn ?? followup.dependency;
      const dependencyType = followup.dependencyType ?? "discovered-from";
      const identity = { title, description, type, priority, dependsOn, dependencyType };
      const identityHash = hash(JSON.stringify(identity));
      const createKey = `bd-create:${identityHash}`;
      await stage(
        createKey,
        "beads.create-followup",
        { title, description, type, priority, dependsOn, dependencyType },
      );
      return { id: `staged-followup:${identityHash}`, title, description, issue_type: type, priority, staged: true };
    },
    async proveDry(scope) {
      const scoped = effectiveScope(scope);
      const ready = filterReadyIssues(await bd(readyArgs(scoped), { json: true, readonly: true }), scoped, { statuses: ["open"] }).filter((issue) => !stagedClosedIds.has(issue.id));
      // R7: pass --limit 0 (no truncation), mirroring discover. Without it, bd defaults to 50 rows,
      // so >50 in_progress items get truncated; unsafeInProgress/controllerOwnedIncomplete would be
      // computed from the first 50 only and proveDry could return dry=true while in_progress work
      // still exists -> drain-runtime sets status=complete (false complete).
      const inProgress = (await bd(["list", "--status", "in_progress", "--limit", "0"], { json: true, readonly: true }) ?? []).map(normalizeIssue).filter((issue) => !stagedClosedIds.has(issue.id));
      // R6: dry-ness is judged against the SAME scope discover uses. Scope-filter the in_progress
      // list (matching discover's filterReadyIssues(inProgress, scoped, {in_progress})) so an
      // out-of-scope in_progress item (e.g. a human-owned epic under a task-only scope) cannot keep
      // a finished scoped drain reporting not_dry forever. unsafeInProgress (externally-owned work
      // we must not touch) is therefore measured WITHIN scope.
      const scopedInProgress = filterReadyIssues(inProgress, scoped, { statuses: ["in_progress"] });
      const cycles = await bd(["dep", "cycles"], { json: true, readonly: true });
      const lint = await bd(["lint"], { json: true, readonly: true });
      const orphans = await bd(["orphans"], { json: true, readonly: true });
      const duplicates = filterStagedDuplicateFindings(await bd(["find-duplicates"], { json: true, readonly: true }), stagedClosedIds);
      const unsafeInProgress = scopedInProgress.filter((issue) => !isAssignedToActor(issue, actor));
      // Controller-owned claims that were claimed but never closed (failed/cancelled lanes)
      // are NOT silently safe. They keep the queue non-dry and are reported distinctly from
      // externally human-gated in-progress work so operators can see stranded claims. These are
      // measured against the UNSCOPED list: a stranded claim this controller created is a liability
      // it must clear regardless of scope, so scope narrowing must never hide it.
      const controllerOwnedIncomplete = inProgress.filter(
        (issue) => isAssignedToActor(issue, actor) && claimedIds.has(issue.id) && !stagedClosedIds.has(issue.id),
      );
      return {
        dry: ready.length === 0 && unsafeInProgress.length === 0 && controllerOwnedIncomplete.length === 0 && !hasFindings(cycles) && !hasFindings(lint) && !hasFindings(orphans) && !hasFindings(duplicates),
        ready,
        inProgress,
        unsafeInProgress,
        controllerOwnedIncomplete,
        releasedClaimIds: [...releasedClaimIds],
        cycles,
        lint,
        orphans,
        duplicates,
        commands: [...commandEvidence],
      };
    },
  };
  return adapter;
}

export async function finalizeBeadsDomainMutation(payload = {}, options = {}) {
  const runBd = options.runBd ?? defaultRunBd;
  const cwd = payload.cwd ?? process.cwd();
  const actor = payload.actor;

  async function bd(args, { json = true, readonly = true, operation = "read" } = {}) {
    const finalArgs = [...args];
    if (json && !finalArgs.includes("--json")) finalArgs.push("--json");
    if (readonly && !finalArgs.includes("--readonly")) finalArgs.push("--readonly");
    if (actor && !finalArgs.includes("--actor")) finalArgs.push("--actor", actor);
    const result = await runBd(finalArgs, { cwd, operation, readonly, json, signal: options.signal, timeoutMs: options.timeoutMs, maxBuffer: options.maxBuffer });
    return json ? parseBdJson(stdoutFrom(result), `bd ${args.join(" ")}`) : stdoutFrom(result);
  }

  async function showIssue(id) {
    return firstIssue(await bd(["show", "--id", id, "--long"]));
  }

  // R16: deterministic idempotency marker. A crash between execute() completing the bd mutation and
  // the durable "executed" ledger record being written causes runDomainMutation to replay execute on
  // resume. bd append/create are not idempotent on their own, so the same idempotencyKey is woven
  // into the resource (a hidden note marker for append; an external-ref for create) and checked first
  // on each run, turning the replay into a no-op that returns the already-applied resource.
  const idempotencyKey = payload.idempotencyKey ? String(payload.idempotencyKey) : "";

  if (payload.operation === "beads.append-notes") {
    const id = String(payload.issueId ?? "");
    if (!id) throw new Error("beads.append-notes requires issueId");
    const baseNote = String(payload.note ?? "");
    const marker = idempotencyKey ? `[ocw-idem:${idempotencyKey}]` : "";
    if (marker) {
      const existing = await showIssue(id);
      if (String(existing?.notes ?? "").includes(marker)) return existing;
    }
    const note = marker ? `${baseNote}\n${marker}` : baseNote;
    await bd(["update", id, "--append-notes", note], { json: false, readonly: false, operation: "append-notes" });
    return await showIssue(id);
  }

  if (payload.operation === "beads.close") {
    const id = String(payload.issueId ?? "");
    if (!id) throw new Error("beads.close requires issueId");
    const existing = await showIssue(id);
    if (isClosed(existing)) return existing;
    await bd(["close", id, "--reason", String(payload.reason ?? "Completed by beads drain")], { json: false, readonly: false, operation: "close" });
    const closed = await showIssue(id);
    if (!isClosed(closed)) throw new Error(`Beads close readback did not show closed status for ${id}`);
    return closed;
  }

  if (payload.operation === "beads.create-followup") {
    const title = String(payload.title ?? "Follow-up from drain");
    const description = String(payload.description ?? "Follow-up created by drain adapter.");
    const type = String(payload.type ?? "task");
    const priority = Number.isInteger(payload.priority) ? payload.priority : 2;
    // R16: stamp the deterministic idempotency key as the create's external-ref and look it up first.
    // If a prior (pre-crash) attempt already created the follow-up, the same external-ref is present,
    // so we adopt that existing issue instead of creating a duplicate.
    const externalRef = idempotencyKey;
    if (externalRef) {
      const existingList = await bd(["list", "--limit", "0"], { json: true, readonly: true, operation: "list" });
      const match = (Array.isArray(existingList) ? existingList : []).map(normalizeIssue).find((issue) => issue.external_ref === externalRef);
      if (match?.id) {
        if (payload.dependsOn) {
          await bd(["dep", "add", match.id, String(payload.dependsOn), "--type", String(payload.dependencyType ?? "discovered-from")], { json: false, readonly: false, operation: "dep-add" });
        }
        return await showIssue(match.id);
      }
    }
    const createArgs = ["create", "--title", title, "--description", description, "--type", type, "--priority", String(priority)];
    if (externalRef) createArgs.push("--external-ref", externalRef);
    const createdPayload = await bd(createArgs, { json: true, readonly: false, operation: "create" });
    const created = firstIssue(createdPayload) ?? createdPayload;
    const createdId = created?.id;
    if (!createdId) throw new Error("bd create did not return a follow-up id");
    if (payload.dependsOn) {
      await bd(["dep", "add", createdId, String(payload.dependsOn), "--type", String(payload.dependencyType ?? "discovered-from")], { json: false, readonly: false, operation: "dep-add" });
    }
    return await showIssue(createdId);
  }

  throw new Error(`Unsupported Beads domain mutation operation: ${String(payload.operation)}`);
}
