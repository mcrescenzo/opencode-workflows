# Workflow Companion TUI and Claude-Style Inspector Implementation Plan

> Status: **proposed implementation plan**. Nothing in this document is shipped
> unless a task is later marked complete and the corresponding code, tests, and
> active documentation are updated.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a separate terminal application that gives users a Claude
Code-like workflow inspector for `opencode-workflows`, while preserving the
plugin's existing approval, authority, durability, privacy, and apply boundaries.

**Architecture:** The OpenCode server plugin remains the workflow controller and
writes the authoritative run artifacts. A same-package Node CLI runs in a separate
terminal and reads those local artifacts through one shared observer module. The
companion does not modify OpenCode core, inject UI into the OpenCode TUI, connect
to the OpenCode HTTP server, or subscribe to its SSE endpoint. Toasts remain the
small ambient notification surface. Run-level companion controls **extend the
kernel's existing durable lifecycle-request transport** (`cancel-request.json` /
`pause-request.json` / `kill-request.json`) rather than adding a second polling
channel; a net-new protocol surface is designed only for what that transport
lacks (acknowledgements, request IDs, lane-level targeting, save). The companion
grows in explicit milestones: monitor, read-only hierarchical inspector, run
controller, selected-lane controller, then full companion-UI parity.

**Tech stack:** Node 20.11+ ESM, Node built-in `fs`, `readline`, `tty`, and
`node:test`; the existing workflow run store and redaction helpers; no new runtime
dependency unless a later renderer spike proves Node's built-ins insufficient.

**User decisions already made (2026-07-17):**

- Product direction: **full companion-UI parity roadmap**, delivered in stages.
- First shippable UI: **read-only inspector** before lifecycle controls.
- Agent detail: **sanitized detail by default**: task/prompt summary, tool names
  and states, and bounded redacted result previews; never raw reasoning, tool
  arguments, or tool output.
- Runtime boundary: a **separate terminal process**, not an OpenCode TUI plugin.
- Data boundary: read the plugin's canonical local run artifacts through shared
  projection code; do **not** add duplicate persisted `observer.json` snapshots
  unless measurement or a future separately versioned consumer justifies them.
- Approval remains in OpenCode. The companion starts observing after a run ID
  exists and does not replace `workflow_run` or `workflow_apply` approval.

**User decisions added after plan review (2026-07-18):**

- Control plane: run-level controls **reuse and extend the existing
  lifecycle-request transport**; the new protocol spec covers only what that
  transport genuinely lacks. No parallel run-level control channel.
- The read-only inspector milestone is gated on a **live end-to-end integration
  task** (Task 11); the toast reframe (Task 12) is a parallel track, not the
  milestone gate.
- Queued-lane persistence uses a **single compact queued-lanes projection**, not
  one durable file per queued lane, to bound the fan-out write burst and the
  observer's per-refresh read cost.
- Plan style: every Modify target carries `file:line` anchors and every
  implementation task sequences failing tests before implementation. The task
  structure is otherwise retained (Task 11 inserted; later tasks renumbered).

## Evidence Base

This plan uses the detailed product documentation as the behavior contract and
treats the announcement blog as product context, not a complete runtime spec.

- Anthropic announcement, May 28, 2026:
  https://claude.com/blog/introducing-dynamic-workflows-in-claude-code
- Claude Code workflows documentation, retrieved 2026-07-17:
  https://code.claude.com/docs/en/workflows
- OpenCode public plugin documentation, retrieved 2026-07-17:
  https://opencode.ai/docs/plugins/
- OpenCode public SDK documentation, retrieved 2026-07-17:
  https://opencode.ai/docs/sdk/
- OpenCode public TUI documentation, retrieved 2026-07-17:
  https://opencode.ai/docs/tui/
- Node 20 file-watching documentation:
  https://nodejs.org/docs/latest-v20.x/api/fs.html#fswatchfilename-options-listener
- Node 20 TTY and readline documentation:
  https://nodejs.org/docs/latest-v20.x/api/tty.html
  https://nodejs.org/docs/latest-v20.x/api/readline.html#readlineemitkeypresseventsstream-interface

All `file:line` anchors below were verified against the working tree on
2026-07-18. Re-verify anchors before editing if intervening commits land.

## Grounded Product Contract

### What Claude Code documents

Claude Code's `/workflows` experience has four relevant surfaces:

1. A one-line progress summary in the task panel below the input.
2. A run list containing running and completed workflows.
3. A hierarchical progress view: run -> phase -> agent.
4. A control footer with pause/resume, stop, restart, and save actions.

The detailed workflow view documents these fields and actions:

| Level | Documented information or action |
| --- | --- |
| Run | Status, phases, aggregate activity, completion into the originating session |
| Phase | Agent count, token total, elapsed time |
| Agent list | Agent status and status filtering |
| Agent detail | Prompt, recent tool calls, result, scrolling |
| Navigation | Up/down, Enter/right to drill in, Esc/left to return |
| Controls | Pause/resume run, stop run or selected agent, restart selected running agent, save script |

Claude's detailed docs also qualify several announcement-level claims:

- A workflow may schedule hundreds of agents, but at most 16 run concurrently.
- Resume works within the same Claude Code session. Exiting Claude Code and
  starting another session starts the workflow fresh.
- A running workflow accepts no arbitrary mid-run user input. Permission prompts
  are the documented exception.
- The approval prompt varies by permission mode. It is not universally a
  first-run-only prompt.

### What this plugin can and cannot reproduce

The attainable target is **functional parity in a companion terminal**, not
literal integration parity.

| Claude surface | Companion equivalent | Constraint |
| --- | --- | --- |
| Task-panel progress line | Short start/phase/problem/terminal toasts | Toasts are transient and cannot be replaced in place |
| `/workflows` run list | Companion root view | Fully feasible from durable run roots |
| Phase progress view | Companion run view | Requires first-class lane-to-phase persistence |
| Agent list/detail | Companion phase/agent views | Requires queued state, activity, and result-preview projections |
| Pause/resume/stop/restart/save | Later companion control mode | Run-level actions ride the existing lifecycle-request transport; lane-level actions and acknowledgements need new protocol surface and runtime semantics |
| Approval card | Existing `workflow_run` preview in OpenCode | Deliberate divergence; do not split approval across terminals |
| Final report in session | Existing idle-gated completion notification and result readback | Already shipped, best effort while owner process lives |

The companion must never claim that it keeps a workflow alive. The plugin remains
in-process: a live run stops when its owning OpenCode process exits. Existing
reconcile/resume can recover completed work, but the companion is an observer or
controller, not a detached supervisor.

## Current Implementation Baseline

The current repository already provides most run-level facts:

- Project run root: `<worktree>/.opencode/workflows/runs` (`runRoot`,
  `run-store-fs.js:160-162`; `projectWorkflowDir`, `workflow-source.js:806-808`).
- Deterministic global fallback run root keyed by a 16-char hash of the resolved
  worktree (`globalRunRoot`, `run-store-fs.js:164-167`; both roots deduplicated
  via `runRoots`, `run-store-fs.js:169-171`).
- Private directories/files (`0700`/`0600`, `run-store-fs.js:16-17`) and atomic
  JSON replacement via temp-file-then-rename (`writeJsonAtomic`,
  `run-store-fs.js:61-72`).
- Persisted `script.js` (`workflow-plugin.js:2240`), `state.json`
  (`run-store-state.js:136`), `events.jsonl` / `journal.jsonl`
  (`event-journal.js:91,96-102`), lane projections under `lanes/<callId>.json`
  (`doWriteLaneProjection`, `run-store-projections.js:198-216`), lane
  checkpoints co-located as `lanes/<callId>.request.json` / `.result.json`
  (`run-store-projections.js:315-325`), locks (`run.lock` / `apply.lock`,
  `run-store-locks.js:22-26`), lifecycle requests (below), and closeout data
  (`writeDurableProjections`, `run-store-projections.js:233-268`).
- Run status, current phase, declared phases, authority, counters, aggregate
  usage, budgets, cache accounting, staleness, errors, and next actions
  (`run-store-state.js:56-121`; compact/full formatting and derived
  `nextActions`/staleness in `run-store-status-format.js:206-327,342-359,578-875`).
- Lane task summary, role, model, start/completion timing, outcome, terminal
  tokens/cost, and bounded error summary (`recordLaneOutcome`,
  `run-store-projections.js:61-122`; bounding/redaction at the write layer,
  `run-store-projections.js:198-216`).
- Durable pause, cancel, kill, reconcile, and resume mechanisms exposed through
  existing workflow tools (`lifecycle-control.js:543-645`).
- **A durable, cross-process, file-based run-level control transport already
  ships.** `workflow_cancel`/`workflow_pause`/`workflow_kill` requests persist as
  `cancel-request.json` / `pause-request.json` / `kill-request.json` in the run
  dir (`run-store-locks.js:28-32`; `writeLifecycleRequest`,
  `run-store-locks.js:143-153`; `readLifecycleRequests`,
  `run-store-locks.js:155-162`). A non-owning process writes the request file
  (`interruptRun`, `lifecycle-control.js:543-568`, durable write at `:550`;
  `killRun`, `lifecycle-control.js:609-645`), and the live owner picks it up at
  lane-launch boundaries with no OpenCode event required
  (`checkDurableLifecycleRequest`, `workflow-plugin.js:346-386`, called at
  `child-agent-runner.js:837,845`). Cross-process pause/cancel is tested
  (`tests/workflow-lifecycle.test.mjs:476`). The transport has **no
  acknowledgement channel, no request IDs, no lane-level targeting**, and is
  polled only while the owner is launching lanes.
- An existing observer seam fires on every durable event append:
  `notifyRunEventSink` (`run-observability.js:23-34`), invoked from
  `appendEvent` (`event-journal.js:93`) and wired to the toast event sink
  (`workflow-plugin.js:2341`).
- Existing toast renderers and event-driven problem/phase notification policy
  (`notification-toast.js`, `notification-toast-policy.js`,
  `notification-toast-cards.js`).
- Run listing has **no lightweight enumerate path**: `listRunEntries`
  (`run-store-status-format.js:908-928`) fully reads and parses every run's
  `state.json` plus locks and lifecycle requests (`readRunEntry`,
  `run-store-status-format.js:56-111`), and loads the **entire** journal for
  interrupted/stale-active runs (`attachSalvageCandidates`,
  `run-store-projections.js:397-407` -> `loadJournal`,
  `event-journal.js:104-124`), before any display limit applies
  (`run-store-status-format.js:1012-1016`). This cost profile constrains the
  observer and watcher designs below.

Important current gaps:

- Lanes do not persist the phase occurrence to which they belong
  (`recordLaneOutcome` writes no phase field, `run-store-projections.js:61-122`).
- Repeated phase names cannot be distinguished as separate occurrences
  (`phase(name)` only overwrites `run.currentPhase`,
  `sandbox-executor.js:749-754`).
- A queued lane has no durable detailed projection before it acquires a slot
  (first projection write is `status: "running"` after slot acquisition,
  `child-agent-runner.js:1054`).
- A running lane normally changes only at start and completion, so
  `lastActivityAt` is not proof of child-session activity.
- Recent child tool activity is not persisted into the workflow run store.
- Lane results exist in the journal but are deliberately absent from lane status
  projections.
- Live per-agent token use is not available from the current runner until a child
  prompt completes.
- There is no operator-facing selected-lane stop/restart contract.
- A disconnected companion process cannot invoke `workflow_run` (or any tool):
  tools execute only inside OpenCode's tool-calling machinery
  (`workflow-plugin.js:3047`), and the companion is barred from server/SDK
  connections. Note carefully what the kernel's resume path actually checks —
  it is **process-agnostic**: persisted status in `RESUMABLE_STATUSES`
  (`workflow-plugin.js:195`; `assertResumableState`,
  `workflow-plugin.js:405-436`), `run.lock` not held by a live process
  (`acquireWorkflowLock`, `run-store-locks.js:69-104`; liveness via
  `processAppearsAlive`, `run-store-fs.js:120-154`), and a matching resume
  envelope. Any OpenCode session can resume a paused run; there is **no**
  "original invocation context" requirement, and later tasks must not invent
  one.

## Non-Negotiable Constraints

- Do not modify OpenCode core or depend on undocumented TUI routes, slots,
  sidebars, or panels.
- Do not connect the companion to the OpenCode server, SDK client, random TUI
  port, or SSE stream.
- Do not parse OpenCode's general internal logs or transcript store as a product
  API. Persist workflow-specific UI facts into this plugin's run store.
- Preserve the existing hash-gated launch and apply boundaries.
- Preserve deny-by-default lane authority (`authority-policy.js:499-500`) and
  worktree isolation (`worktree-adapter.js:54-95`; containment,
  `run-store-fs.js:186-198`).
- Run-level control delivery must **extend the existing lifecycle-request
  transport** (`writeLifecycleRequest` / `checkDurableLifecycleRequest`). Never
  create a second polling channel for actions the kernel already delivers.
- Do not let an observer projection or UI action become a second apply path.
- Never label a lane "idle" from a missing workflow-state transition. Use "last
  persisted transition" until child activity has been proven and correlated.
- Never label a token total "live" unless the event spike proves a reliable live
  usage source. Otherwise use "reported" or "partial".
- Keep raw reasoning, tool arguments, tool output, and unbounded prompts/results
  out of the default companion UI.
- Treat persisted run data as a compatibility surface. Add fields; do not silently
  reinterpret existing fields or make old runs unreadable.
- The renderer must not own workflow semantics. It consumes a typed observer
  read model produced by the kernel.
- A failed toast or companion read must never affect workflow execution.
- Every docs file under `docs/` must satisfy the enforced status check: carry a
  `> Status:` banner **or** be named in README's Documentation Map
  (`tests/workflow-docs.test.mjs:43-51`). All current docs files carry banners;
  prefer a banner on new files for consistency.

## Target Information Model

### Run view model

```js
{
  schemaVersion,        // observer schema version, independent of stateVersion
  stateVersion,         // as read from state.json (DURABLE_STATE_VERSION today)
  runId,
  runRoot,              // which root (project|global) this entry resolved from
  name,
  status,
  sourcePath,
  sourceHash,
  effectiveProfile,
  authoritySummary,
  startedAt,
  finishedAt,
  elapsedMs,
  owner: { state, pid },
  background,
  currentPhaseId,
  currentPhaseName,
  phaseCount,
  laneCounts,
  usage: {
    reportedTokens,
    replayedTokens,
    reportedCost,
    completeness,
    costTrackingWarning,
  },
  budgets,
  largeRunWarnings,
  nextActions,
}
```

`owner.state` is one of `owned-here`, `active-other-process`, `stale`, or
`terminal`. In a separate companion process, a live OpenCode-owned run normally
appears as `active-other-process`; this is expected, not an error.

Version-skew rules (the durable `stateVersion` is currently written but never
read back for validation — `DURABLE_STATE_VERSION`, `constants.js:119`; default
fill only at `run-store-status-format.js:89`):

- `stateVersion` **greater** than the observer's known maximum -> return a marked
  `unsupported-state-version` entry carrying only id, path, and version. Never
  throw, never guess fields.
- `stateVersion` missing or lower -> read normally under the additive-fields
  policy, synthesizing legacy shapes (e.g. a legacy phase occurrence) in the
  observer.
- `runRoot` makes duplicate run IDs across project/global roots visible: the
  detail path resolves first-match project-root-first (`readRunById`,
  `run-store-status-format.js:1157-1163`) and the observer must surface which
  root won.

### Phase occurrence

Use occurrence identity, not a phase name as an ID:

```js
{
  phaseId,          // stable within this run
  name,
  ordinal,          // call order, including repeated names
  declaredIndex,    // optional position in meta.phases
  startedAt,
  completedAt,
  status,
}
```

Rules:

- Calling `phase(name)` closes the preceding active occurrence and opens a new
  one, even when `name` repeats.
- Occurrence identity is the **monotonic ordinal in call order**. The sandbox is
  deterministic (`Date.now`/`Math.random` disabled,
  `sandbox-executor.js:824-826`), so a resumed body re-executes `phase()` calls
  in the same order with the same names. On resume, a re-executed `phase()`
  whose ordinal falls **within** rehydrated history *claims* the existing
  occurrence (a name mismatch at the same ordinal is a corruption error, not a
  new occurrence); only beyond-history ordinals append new occurrences. This
  mirrors the replay-safe carried-forward `agentsStarted` counter model
  (`child-agent-runner.js:705-724`).
- Terminal run settlement closes the last active occurrence.
- A lane snapshots the current `phaseId` when it is enqueued.
- Lanes created before any explicit phase are grouped by the observer into a
  synthetic display-only `Workflow` phase. Do not mutate workflow execution to
  create that phase.
- On resume, persisted phase history and the active occurrence are rehydrated
  with identical `phaseId`s, so cache-hit lanes' snapshotted `phaseId`s still
  resolve.

### Lane projection

```js
{
  callId,
  phaseId,
  phaseName,
  label,                 // durable: persisted by Task 3 from the existing opts
                         // label/title alias (authority-policy.js:217,225;
                         // child-agent-runner.js:186,558)
  taskSummary,
  role,
  model,
  status,
  attempt,
  enqueuedAt,
  startedAt,
  completedAt,
  lastTransitionAt,      // durable: stamped by Task 3 on every status write
  childID,
  recentTools: [
    { name, status, startedAt, completedAt }
  ],
  lastToolName,
  tokens,
  cost,
  usageCompleteness,     // observer-derived per lane (Task 4), not durable
  outcome,
  failureClass,
  retryable,
  replayed,
  recovered,
  resultPreview,
  resultPreviewState,
  errorSummary,
}
```

Lane status transitions should be explicit:

```text
queued -> creating -> running -> retrying -> completed
                                    |       -> failed
                                    |       -> cancelled
                                    |       -> timeout
                                    |       -> budget_stopped
                                    +-------< manual restart
```

Do not introduce a new terminal outcome solely for UI wording until resume,
cache, budget, and integration behavior are specified for it.

### Sanitized agent detail

Default detail may include:

- Bounded task/prompt summary already produced by `laneTaskSummary`.
- Role, model, attempt, phase, status, and timing.
- Tool names and coarse states only.
- Reported tokens/cost with completeness labeling.
- A bounded, redacted terminal result preview.
- Bounded redacted failure detail.

Default detail must exclude:

- Chain-of-thought or reasoning text.
- Raw tool arguments, commands, URLs with credentials, and tool output.
- Full child transcripts.
- Unbounded prompts or results.
- Raw runtime arguments.
- Apply bundles and hidden approval material.

These exclusions are **structural**: excluded categories are never read into the
observer's return objects (allowlist projection), not scrubbed out by pattern
matching after the fact. The redaction helpers applied to the free-text fields
that *are* included mask **credential shapes and sensitive key names only**
(`redactFreeTextSecrets`, `free-text-redactor.js:31-53,76-89`; `redactValue`
key-name masking with mask-before-truncate ordering, `text-json.js:93-111`).
They are not semantic redaction: a free-form result preview can still contain
non-credential sensitive prose (paths, hostnames, names). That bounded residual
exposure is accepted for previews and must be documented honestly, never denied.

## Target Companion Navigation

### Root: run list

```text
STATUS    WORKFLOW          PHASE          AGENTS       TOKENS    ELAPSED
running   deep-research     Verify 4/5     3/12         84k+      8m12s
paused    repo-review       Review 2/3     0/18         121k      14m
failed    migration         Transform 3/4  17/20        205k      22m
```

### Run: phase list

```text
deep-research / 8f9c...

PHASE          STATUS      AGENTS               TOKENS    ELAPSED
Scope          complete    1/1                  8k        32s
Search         complete    6/6                  39k       2m10s
Fetch          complete    8/8                  21k       1m45s
Verify         running     7 done, 3 active     16k+      3m45s
Synthesize     waiting     0/1                  -         -
```

### Phase: agent list

```text
VERIFY

STATE       AGENT                     MODEL       TOKENS   ELAPSED
complete    verify claim: omega-3     sonnet      8.2k     42s
running     verify claim: dosage      sonnet      3.1k+    31s
retrying    verify claim: age group   sonnet      -        18s
queued      verify claim: safety      sonnet      -        -
```

### Agent detail

```text
verify claim: dosage

Status: running
Phase: Verify
Model: anthropic/claude-sonnet-4-6
Attempt: 1/2
Elapsed: 31s
Last activity: webfetch running

Task
Check whether the claimed effective dosage is supported by the cited sources.

Recent tools
[done] websearch
[done] webfetch
[run ] webfetch

Result
Not available until the lane completes.
```

When live child activity is unavailable (Task 6 spike failed or Task 7 not
landed), the detail view must degrade explicitly: no `Last activity` line
implying liveness, and the `Recent tools` block replaced by a single
`Activity: not tracked (last persisted transition <time>)` line. Golden fixtures
must cover this variant; the layout must not reserve permanently empty sections.

### Navigation keys

Match Claude's documented navigation where it does not conflict with terminal
conventions:

| Key | Read-only milestone | Controller milestones |
| --- | --- | --- |
| Up/down | Select | Same |
| Enter/right | Drill in | Same |
| Esc/left | Back out | Same |
| `j`/`k` | Scroll detail | Same |
| `f` | Cycle agent-status filter | Same |
| `?` | Help | Same |
| `q` | Quit companion only | Same |
| `p` | Not registered | Pause/resume when supported (Task 15) |
| `x` | Not registered | Resumable stop, run (Task 15) or selected lane (Task 17) |
| `r` | Not registered | Restart selected running lane (Task 17) |
| `s` | Not registered | Save script after explicit confirmation (Task 13) |

Do not display control keys before their runtime behavior exists.

## Milestone Names and Claim Rules

Use these names consistently in docs and release notes:

| Milestone | Allowed claim | Completes after |
| --- | --- | --- |
| Monitor | Separate live view of existing run/lane state | Rollout step 2 |
| Read-only inspector | Claude-like run/phase/agent navigation with sanitized detail | Task 11 (live integration gate) |
| Run controller | Inspector plus pause/resume/resumable-stop and save | Task 15 |
| Lane controller | Inspector plus selected-running-lane stop/restart | Task 17 |
| Full companion-UI parity | All documented companion-equivalent hierarchy and controls, with explicit approval/integration differences | Task 18 |

Never call the initial monitor or read-only inspector "full workflow UI parity."

---

## Task 0: Correct the parity record before implementation

**Files:**

- Modify: `docs/claude-parity-roadmap.md:73-77`
- Modify: `README.md` only if it repeats the inaccurate claim
- Test: `tests/workflow-docs.test.mjs`

**Purpose:** Correct the roadmap's background-durability comparison and
distinguish runtime persistence from live process survival before new UI copy
spreads the error.

The target sentence (`docs/claude-parity-roadmap.md:73-77`) is about **Claude
Code CLI/SDK background agents** ("CLI/SDK background agents support
resume/continuation across invocations"), which the roadmap contrasts with this
plugin's in-process background execution. It is **not** a claim about the
`/workflows` dynamic-workflows product — the strings "dynamic workflow" and
"/workflows" appear nowhere in that file. The dynamic-workflows same-session
resume fact is separately and correctly sourced in this plan's Grounded Product
Contract from Claude's own workflow docs. Do not conflate the two features when
editing, and do not "correct" the CLI/SDK claim itself (this plan has not
verified it against Claude's SDK docs); scope the edit to how the roadmap frames
this plugin's own durability against it.

- [ ] Rewrite `docs/claude-parity-roadmap.md:73-77` so it (a) names the Claude
  feature it compares against precisely (CLI/SDK background agents), (b) states
  this plugin's model accurately: live execution is in-process and dies with the
  owner, while completed lane results persist and an explicit later
  reconcile/resume flow recovers them, and (c) does not imply Claude *dynamic
  workflows* survive a session exit (their documented resume is same-session).
- [ ] Distinguish total scheduled agents from concurrent agents anywhere the
  roadmap compares scale.
- [ ] Add the companion UI roadmap as a separate parity band instead of folding
  it into the detached-supervisor item.
- [ ] Check `README.md` for the same conflation; fix if present.
- [ ] Machine-check the acceptance: `grep -n "across invocations" docs/ README.md -r`
  returns no hit that attributes cross-invocation resume to Claude dynamic
  workflows or to this plugin, and `grep -rni "daemon" docs/ README.md` returns
  no claim that this plugin is one. Record both grep outputs in the task
  handoff (the listed docs test does **not** assert on this wording; these greps
  are the actual acceptance check).
- [ ] Run `node --test tests/workflow-docs.test.mjs` (banner/doc-map hygiene
  only).

**Acceptance:** No active doc claims Claude dynamic workflow execution survives a
Claude Code process/session exit, no active doc attributes this plugin's
persistence to a daemon, and the greps above (not just the docs test) prove it.

---

## Task 1: Freeze observer interfaces and compatibility policy

**Files:**

- Add: `workflow-kernel/workflow-observer.js`
- Modify: `workflow-kernel/index.js` (exports)
- Modify: `workflow-kernel/run-context.js`
- Reuse (read-only): `runRoots` (`run-store-fs.js:169-171`), `readRunEntry`
  (`run-store-status-format.js:56-111`), `readLaneProjections`
  (`run-store-projections.js:272-296`), redaction (`text-json.js:93-111`,
  `free-text-redactor.js:76-89`), staleness/next-actions
  (`run-store-status-format.js:206-359`)
- Test: `tests/workflow-observer.test.mjs` (new)

**Interfaces:**

```js
observeRuns(context, options) -> Promise<ObserverRunSummary[]>
observeRun(context, runId, options) -> Promise<ObserverRunDetail>
observePhase(context, runId, phaseId, options) -> Promise<ObserverPhaseDetail>
observeLane(context, runId, callId, options) -> Promise<ObserverLaneDetail>
```

- [ ] Write the failing tests first: fixture tests for valid, partial, corrupt,
  stale-owner, active-other-process, paused, interrupted, terminal,
  `unsupported-state-version`, and `run-removed` runs. Run
  `node --test tests/workflow-observer.test.mjs` and confirm they fail before
  implementing.
- [ ] Make the observer reuse `runRoots`, `readRunEntry`, containment checks
  (`run-store-fs.js:186-198`), lane projection reads, redaction, staleness, and
  next-action logic. Do not fork read logic.
- [ ] Define an observer schema version independent of the durable state
  version, and implement the version-skew rules from the Target Information
  Model: `stateVersion` above the known maximum returns a marked
  `unsupported-state-version` entry (id/path/version only); missing/older reads
  normally with legacy synthesis.
- [ ] Surface `runRoot` on every entry so duplicate run IDs across
  project/global roots (`readRunById` first-match,
  `run-store-status-format.js:1157-1163`) are visible.
- [ ] Keep raw artifacts inside the observer module. Return allowlisted objects.
- [ ] The observer's read set is a positive allowlist: `state.json`, `lanes/`
  projections, and a bounded `events.jsonl`/`journal.jsonl` tail. It must
  **never open** `debug/` capture trees (`child-agent-runner.js:286`),
  `diff-plan.json` (the apply bundle, written at `workflow-plugin.js:1474`),
  lock files, or `lanes/*.request.json` / `lanes/*.result.json` checkpoints
  (already skipped by `readLaneProjections`,
  `run-store-projections.js:280-284`). Encode this list in a test.
- [ ] Any observer field sourced from a journal `agent` entry must route through
  the Task 5 bounding function before it reaches any observer return value or
  CLI `--json` output — journal `result` values are redacted but **unbounded**
  (`redactDurableValue` uses Infinity limits, `text-json.js:113-119`). Add a
  test asserting no observer output string can exceed the preview ceiling.
- [ ] Add explicit `unavailable`, `truncated`, and `partial` markers.
- [ ] Read state, lane projections, and a bounded event/journal tail without
  loading an entire maximum-size ledger on every refresh. Note: only the
  salvage path currently forces a full journal load, and only for
  interrupted/stale-active runs (`run-store-projections.js:397-407`); the
  observer must not inherit that on routine refreshes of active runs.
- [ ] Handle a run directory disappearing during cleanup as a normal
  `run-removed` result, not a crash.
- [ ] Retry once when state changes during a multi-file read; otherwise return a
  marked eventually-consistent snapshot and refresh on the next watcher tick.
  Specify the change-detection primitive: re-stat the full watched set
  (`state.json` mtime/size plus the `lanes/` dir mtime), not `state.json`
  alone — lane-projection writes are chained separately from state writes
  (`run-store-projections.js:218-231` vs `run-store-state.js:23,140-141`) and a
  lane-only write advances nothing in `state.json`.
- [ ] Build a maximum-size measurement fixture — journal at
  `MAX_JOURNAL_RECORDS` (`constants.js:69`), a 64-lane run
  (`DEFAULT_MAX_AGENTS`, `constants.js:70`) and an adversarial 500-lane run —
  and time `observeRuns`/`observeRun` against it. Record the numbers in the
  task handoff; they are the input to Task 4's aggregate bounds and Task 9's
  poll cadence.
- [ ] Do not create `observer.json` or a second persisted event stream.
- [ ] Run `node --test tests/workflow-observer.test.mjs` and confirm all pass.

**Acceptance:** Tests demonstrate that renderer-facing values are bounded and
redacted, old fixture state remains readable, a newer-than-known `stateVersion`
yields a marked entry rather than a throw, malformed runs are represented
without throwing the whole run list, the never-read file list holds, and the
module performs no writes. Measurement numbers for the max-size fixture are
recorded.

---

## Task 2: Persist phase occurrences

**Files:**

- Modify: `workflow-kernel/sandbox-executor.js:749-754` (host `phase` op) and
  the shared guest API (`sandbox-executor.js:847-848,864,877`)
- Modify: `workflow-kernel/run-context.js`
- Modify: `workflow-kernel/run-store-state.js` (`writeState` choke point,
  `run-store-state.js:136,140-141`; persisted fields `:56-121`)
- Modify: `workflow-kernel/run-store-rehydrate.js`
- Modify: `workflow-kernel/workflow-plugin.js` settlement paths
  (`runWorkflowExecution` settlement sites, `workflow-plugin.js:1435-1542`;
  durable-request pickup, `workflow-plugin.js:346-386`)
- Modify: `workflow-kernel/lifecycle-control.js` (cancel `:581`, pause `:599`,
  kill `:635` — kill stamps a resumable-terminal `interrupted` + `finishedAt`
  durably without awaiting settle, the sharpest dangling-occurrence exposure)
- Modify: `workflow-kernel/run-store-status-format.js`
- Modify: `CHANGELOG.md` (Unreleased entry), `docs/workflow-plugin.md`
  (persisted-shape documentation)
- Test: `tests/sandbox-executor.test.mjs`, `tests/durable-state.test.mjs`,
  `tests/workflow-observer.test.mjs`

- [ ] Write the failing tests first (occurrence append, repeated names, resume
  claim-by-ordinal, terminal close on every settlement path including kill);
  run them and confirm failure before implementing.
- [ ] Add `run.phaseHistory`, `run.currentPhaseId`, and a monotonic phase
  ordinal.
- [ ] On `phase(name)`, close the preceding occurrence and append a new durable
  occurrence before the event append notifies the existing sink
  (`notifyRunEventSink` via `event-journal.js:93`,
  `run-observability.js:23-34`).
- [ ] Preserve the existing `currentPhase` field
  (`run-store-state.js:89`) for compatibility.
- [ ] Permit repeated phase names and prove they receive distinct IDs.
- [ ] Implement the resume claim rule from the Target Information Model:
  rehydrated history + ordinal counter; a re-executed `phase()` within history
  claims the existing occurrence (name mismatch = corruption error); only
  beyond-history ordinals append.
- [ ] Close the final active occurrence from a **single choke point**: inside
  the per-run-serialized `writeState` when `run.status` transitions into a
  settled/non-active status — not a per-site checklist. This automatically
  covers every writer, including `checkDurableLifecycleRequest`
  (`workflow-plugin.js:346-386`), the `runWorkflowExecution` settlement sites,
  and `lifecycle-control.js`'s cancel/pause/kill paths. Add a regression test
  for the kill path specifically.
- [ ] Rehydrate history and active occurrence during resume.
- [ ] Keep old runs with only `currentPhase` readable by synthesizing a legacy
  occurrence in the observer, not by rewriting status reads.
- [ ] Expose phase history in compact/full status only if doing so remains
  bounded; otherwise expose it through the observer only.
- [ ] Update `docs/workflow-plugin.md`'s persisted-state documentation and add a
  CHANGELOG Unreleased bullet.
- [ ] Run the three listed suites and confirm all pass.

**Acceptance:** A workflow that executes `Scan -> Verify -> Fix -> Verify` yields
four ordered occurrences, lanes can refer to the correct occurrence, resume does
not duplicate prior occurrences (claim-by-ordinal proven by test), a killed run
has no dangling occurrence, and terminal elapsed time is stable.

---

## Task 3: Persist queued and transitional lane state

**Files:**

- Modify: `workflow-kernel/child-agent-runner.js` (enqueue timestamp + slot
  wait, `child-agent-runner.js:839-840`; `session.create` at `:926`; first
  projection write today at `:1054`; retry loop `:904-1243`; outer failure path
  `:1362-1374`)
- Modify: `workflow-kernel/run-store-projections.js` (`writeLaneProjection`
  chain, `run-store-projections.js:218-231`; `recordLaneOutcome`, `:61-122`)
- Modify: `workflow-kernel/run-store-state.js`
- Modify: `workflow-kernel/run-store-rehydrate.js`
- Modify: `CHANGELOG.md`, `docs/workflow-plugin.md`
- Test: `tests/child-agent-runner.test.mjs`, `tests/durable-state.test.mjs`,
  `tests/workflow-observer.test.mjs`

**Scaling constraint (drives the design):** a scoped `parallel()` starts every
thunk immediately (`sandbox-executor.js:940-950`); only `acquireAgentSlot`
blocks on concurrency (`workflow-plugin.js:628-658`). Per-queued-lane durable
files would therefore burst O(total scheduled lanes) atomic temp+rename writes
at fan-out start (`DEFAULT_MAX_AGENTS = 64`, `constants.js:70`; authors may
raise it), and the observer's refresh would inherit an O(total lanes)
readdir+parse (`readLaneProjections`, `run-store-projections.js:272-296`).

- [ ] Write the failing tests first (queued visibility at concurrency 1, state
  monotonicity, queued cancellation, burst bound); run and confirm failure.
- [ ] Snapshot `phaseId`/`phaseName` at lane enqueue
  (`child-agent-runner.js:839`), before waiting for a slot.
- [ ] Persist queued state in **one compact `lanes/queued.json` projection**
  (bounded entries: callId, phaseId, label, taskSummary, requested role/model
  tier, enqueuedAt), written through a single serialized, debounced writer —
  not one durable file per queued lane. A lane leaves the queued projection at
  `creating` and gains its individual `lanes/<callId>.json` file from that
  transition onward.
- [ ] Transition to `creating` before `session.create`
  (`child-agent-runner.js:926`) and `running` only after the child
  session/directory/permission echo checks succeed (today's single write site,
  `child-agent-runner.js:1054`).
- [ ] Persist `label` (from the existing opts label/title alias,
  `child-agent-runner.js:186,558`; field set `authority-policy.js:217,225`) and
  stamp `lastTransitionAt` on **every** lane status write, so the Target
  Information Model's durable fields all have a producing site.
- [ ] Persist retry attempt and `retrying` state before backoff or child
  recreation.
- [ ] Preserve one logical lane identity across transient/corrective attempts.
- [ ] Ensure queued cancellation, fail-fast cancellation
  (`cancelFanoutSiblings`, `sandbox-executor.js:152,772`), run pause, run
  cancel, timeout, and budget stop each leave a truthful terminal or resumable
  projection (including removal from `lanes/queued.json`).
- [ ] Keep individual lane projection writes serialized through the existing
  per-lane write chain (`run-store-projections.js:218-231`).
- [ ] Do not change resume signatures merely for display-only phase/label
  fields.
- [ ] Update `docs/workflow-plugin.md` and CHANGELOG.
- [ ] Run the three listed suites and confirm all pass.

**Acceptance:** A concurrency-1 fixture with three lanes shows one running lane
file and two named entries in the queued projection; every state transition is
monotonic with `lastTransitionAt` advancing; cancellation while queued removes
the entry without a ghost active lane; a 500-lane enqueue produces a bounded
number of queued-projection writes (debounce proven by test), not 500 files.

---

## Task 4: Build phase aggregates in the observer

**Files:**

- Modify: `workflow-kernel/workflow-observer.js`
- Test: `tests/workflow-observer.test.mjs`

- [ ] Write the failing golden-fixture tests first; run and confirm failure.
- [ ] Group lanes by `phaseId`; group legacy/unphased lanes under display-only
  `Workflow`.
- [ ] Compute queued, creating, running, retrying, success, failure, timeout,
  cancelled, and budget-stopped counts per phase (queued counts read from the
  compact queued projection).
- [ ] Sum only reported terminal/live usage and return `usageCompleteness` as
  `complete`, `partial`, `unavailable`, or `unreliable-cost` — at the phase
  level **and derived per lane** (a queued/running lane is `unavailable`; a
  terminal lane with reported tokens is `complete`), so the lane view model's
  `usageCompleteness` field has a producing site.
- [ ] Compute phase elapsed time from phase occurrence timestamps, never from
  current wall time after terminal completion.
- [ ] Preserve replayed/recovered distinctions without double-counting totals.
- [ ] Bound per-refresh lane materialization: cap lanes returned per phase
  (active plus most-recent terminal up to a fixed cap) with an explicit
  truncation marker and total count. Validate the cap against the Task 1
  max-size fixture timings; lane-file **count** — not just journal size — is a
  first-class scaling axis.
- [ ] Expose large-run warnings from truthful signals: actual scheduled/started
  agents, configured advisory threshold, actual reported tokens, absent token
  ceiling, and unreliable cost tracking.
- [ ] Do not call `maxTokens` a projection; label it a ceiling.
- [ ] Run `node --test tests/workflow-observer.test.mjs` and confirm all pass.

**Acceptance:** Golden observer fixtures cover empty phases, repeated phases,
straddling active lanes, partial usage, replay, failure, a large queued run, and
the per-phase lane cap with truncation marker; per-lane and per-phase
`usageCompleteness` are both asserted.

---

## Task 5: Add sanitized terminal result previews

**Files:**

- Modify: `workflow-kernel/run-store-projections.js`
- Modify: `workflow-kernel/child-agent-runner.js` (result production,
  `child-agent-runner.js:1150-1189`)
- Modify: `workflow-kernel/workflow-observer.js`
- Reuse: `workflow-kernel/text-json.js` (`redactValue`, `text-json.js:93-111`)
- Modify: `CHANGELOG.md`, `docs/workflow-plugin.md`
- Test: `tests/child-agent-runner.test.mjs`, `tests/workflow-observer.test.mjs`

Scope note: the "validated" lane result is schema-**shape** validated only
(`validateStructuredResult`, `structured-output.js:99-103`) — its content is
arbitrary child-model output. The reused redaction helpers provide
credential-shape and sensitive-key-name masking plus size/depth bounding, not
general semantic redaction (see Sanitized agent detail). The preview's privacy
guarantee is therefore: bounded, secret-masked, sourced only from the validated
result — never "contains nothing sensitive."

- [ ] Write the failing tests first (text, structured JSON, oversized output,
  common secret patterns, nested sensitive keys, Unicode boundaries, null
  result, malformed legacy journal entries); run and confirm failure.
- [ ] Define a conservative result-preview byte/character ceiling (at or below
  `MAX_STATUS_STRING_CHARS = 600`, `constants.js:60`; the full result cap is
  `MAX_RESULT_BYTES`, `constants.js:53`).
- [ ] Produce the preview from the validated/redacted lane result, never from
  raw transcript text.
- [ ] Persist preview state as `available`, `unavailable`, `redacted`, or
  `truncated`.
- [ ] Keep the authoritative full result in the existing journal/checkpoint
  locations; do not duplicate it into lane projections.
- [ ] For structured objects, favor high-value scalar fields and bounded arrays
  over a blind prefix when practical.
- [ ] Ensure secret masking happens before truncation (the reused
  `redactValue` already orders mask-then-truncate, `text-json.js:95` — preserve
  that ordering for any new code path).
- [ ] Export the bounding function for observer use (Task 1's journal-tail
  routing rule depends on it).
- [ ] Ensure failed, cancelled, and timed-out lanes show bounded error summaries
  rather than invented results.
- [ ] Update `docs/workflow-plugin.md` and CHANGELOG.
- [ ] Run the listed suites and confirm all pass.

**Acceptance:** Tests cover text, structured JSON, oversized output, common secret
patterns, nested sensitive keys, Unicode boundaries, null result, and malformed
legacy journal entries — and assert the documented guarantee wording (bounded +
secret-masked, not semantically filtered).

---

## Task 6: Live child-event capability spike

**Files:** none for the initial spike; record results in the implementation
handoff (repo precedent for spike gates: the model-tiering and bughunt-port
plans). If the control-protocol work proceeds, also append the results as an
appendix to the Task 14 spec document so they survive the handoff.

**Why this is a gate:** OpenCode's public plugin docs expose `event` hooks, but
this repo's own API reference marks only `session.idle`/`session.status` as
verified-by-usage. The pinned SDK types deliver tool activity embedded in
message-part update events whose `ToolPart.state` carries **raw `input`,
`output`, and `error` inline** — there is no separate coarse "tool event" to
subscribe to. Completeness and ordering of child-session delivery to this
plugin are unverified.

- [ ] Start a disposable OpenCode child session using the documented plugin
  system-test procedure.
- [ ] Run a deterministic workflow lane that reads a file and invokes at least
  one tool.
- [ ] Capture event **types** received by the plugin without capturing prompt or
  tool contents.
- [ ] Verify child session IDs correlate with IDs returned by `session.create`
  in **100%** of a >=20-lane sample.
- [ ] Verify ordering (session created < first tool state < message completion <
  session idle) holds in **>=95%** of the sample; record every violation class.
- [ ] Measure sustained event volume for text and reasoning deltas at
  concurrency 4 (`DEFAULT_CONCURRENCY`, `constants.js:96`); record
  events/second and payload sizes.
- [ ] Verify whether token/cost updates are observable before lane completion
  (usable if seen in >=1 run of the sample).
- [ ] Repeat for a transient retry that creates a new child session.
- [ ] Repeat on the minimum supported OpenCode version.

**Decision (keyed to the recorded numbers, not adjectives):**

- Correlation 100% and ordering >=95% -> continue to Task 7.
- Correlation holds but ordering/volume fail their bars -> persist only coarse
  session-state transitions; no per-tool activity.
- Correlation below 100% or events absent -> skip Task 7 and keep UI wording at
  `last persisted transition`; do not poll child transcripts or connect the
  companion to the server as a workaround.

---

## Task 7: Persist bounded child activity, conditional on Task 6

**Files:**

- Modify: `workflow-kernel/workflow-plugin.js` event hook
- Modify: `workflow-kernel/run-observability.js` (existing event-sink seam,
  `run-observability.js:23-34` — extend it; do not add a parallel notifier)
- Modify: `workflow-kernel/run-context.js`
- Modify: `workflow-kernel/child-agent-runner.js`
- Modify: `workflow-kernel/run-store-projections.js`
- Modify: `workflow-kernel/event-journal.js` if a new safe event type is needed
- Modify: `CHANGELOG.md`
- Test: `tests/workflow-run.test.mjs`, `tests/child-agent-runner.test.mjs`,
  `tests/workflow-observer.test.mjs`

- [ ] Write the failing tests first (correlation index add/remove on every lane
  path, unrelated-session filtering, storm bounding, field stripping); run and
  confirm failure.
- [ ] Maintain a bounded in-memory `childID -> { runId, callId, attempt }` index.
- [ ] Register only after child creation succeeds and remove it in every lane
  cleanup/failure path (including the outer failure path,
  `child-agent-runner.js:1362-1374`).
- [ ] Filter unrelated parent and non-workflow session events in constant time.
- [ ] Convert raw events into an allowlisted taxonomy such as `tool_started`,
  `tool_completed`, `tool_failed`, `generating`, `retrying`, and
  `session_error`.
- [ ] Persist tool **name and coarse state only**. Strip by field name at the
  conversion boundary: `state.input`, `state.output`, `state.error`, `raw`,
  and all text/reasoning deltas — these arrive inline on the same tool-state
  payloads (see Task 6's SDK note); there is no pre-sanitized event to consume.
- [ ] Bound `recentTools` per lane and deduplicate repeated identical updates.
- [ ] Persist on meaningful transitions, not every token/text delta.
- [ ] Keep the event hook best effort and unable to fail workflow execution.
- [ ] Make stale/idle UI copy depend on proven activity timestamps only.
- [ ] If live usage is supported, label it separately from final reported usage
  and reconcile at completion without double counting.
- [ ] Run the listed suites and confirm all pass.

**Acceptance:** A live system test shows the expected tool state in the companion
projection, unrelated sessions do not alter it, event storms stay bounded, and no
raw command/prompt/output text enters workflow activity records (asserted by a
test that feeds a synthetic event carrying `state.input`/`state.output` and
proves both are absent from everything persisted).

---

## Task 8: Implement the read-only terminal renderer

**Files:**

- Add: `workflow-cli/workflow-watch-renderer.js`
- Add: `workflow-cli/workflow-watch-state.js`
- Test: `tests/workflow-watch-renderer.test.mjs` (new)

- [ ] Write the failing golden tests first (all dimension fixtures below plus
  the degraded-activity variant); run and confirm failure.
- [ ] Implement run list, phase list, agent list, and agent detail renderers as
  pure functions over observer objects.
- [ ] Implement Up/down, Enter/right, Esc/left, `j`/`k`, `f`, `?`, and `q`.
- [ ] Implement the degraded agent-detail layout for absent live activity
  (single `Activity: not tracked` line; no `Last activity`/`Recent tools`
  sections) so the renderer does not presuppose Task 6/7 succeeding.
- [ ] Handle terminal resize: re-render on `process.stdout` `resize` events with
  the new dimensions; golden-test a mid-session dimension change through the
  injected dimension source.
- [ ] Support terminal widths from 60 columns upward and degrade to a compact
  summary below the full-table threshold.
- [ ] Use text labels in addition to color; color must never carry status alone.
- [ ] Respect `NO_COLOR`, non-color terminals, and an explicit ASCII mode.
- [ ] Show partial/unavailable/truncated/redacted markers clearly, including the
  per-phase lane-cap truncation marker from Task 4.
- [ ] Show owner death and stale state prominently without implying the companion
  can continue execution.
- [ ] Render elapsed time from timestamps locally without causing disk writes.
- [ ] Keep renderer output deterministic under injected width, height, and clock.
- [ ] Run `node --test tests/workflow-watch-renderer.test.mjs` and confirm all
  pass.

**Acceptance:** Golden tests cover 60x20, 80x24, 120x40, narrow non-TTY output, a
mid-session resize, and the degraded-activity variant; long labels and results do
not corrupt layout; every state remains legible without color.

---

## Task 9: Implement robust local file watching

**Files:**

- Add: `workflow-cli/workflow-watch-source.js`
- Test: `tests/workflow-watch-source.test.mjs` (new)

Watch-scope contract: the watcher watches run-root directories, selected run
directories, and selected `lanes/` directories for **change signals**, and its
only raw-file read is the append-only `events.jsonl` byte-offset tail. All other
content flows through the Task 1 observer, which enforces the never-read
allowlist (`debug/`, `diff-plan.json`, locks, and lane checkpoints are never
opened — see Task 1). "Refresh everything relevant" means re-invoke the
observer, not open changed files directly.

- [ ] Write the failing temp-directory tests first (every scenario in the
  acceptance line); run and confirm failure.
- [ ] Watch directories rather than individual atomically replaced files
  (`writeJsonAtomic` is temp-then-rename, `run-store-fs.js:61-72`, so a file
  watch dies on every state write).
- [ ] Treat a missing `filename` from `fs.watch` as "refresh everything
  relevant."
- [ ] Debounce event bursts and enforce a maximum render rate.
- [ ] Poll modification metadata every 1-2 seconds as a fallback, re-statting
  the full watched set (see Task 1's skew rule), with the cadence sanity-checked
  against the Task 1 max-size measurement numbers.
- [ ] Reattach watchers after rename, replacement, delayed directory creation, or
  selected-run change.
- [ ] Tail append-only `events.jsonl` by byte offset (`appendFilePrivate`,
  `event-journal.js:91`); handle a partial final JSONL line and retry when more
  bytes arrive.
- [ ] Detect truncation/rotation and restart the tail safely. Known trigger:
  resume rewrites `journal.jsonl` via temp+rename (`compactJournal`,
  `event-journal.js:184-196`, called at `workflow-plugin.js:2241-2242`) — the
  journal is **not** byte-offset-tailed for exactly this reason (bounded
  re-read only, per Task 1); the same rename-detection must still guard the
  events tail against any future rotation.
- [ ] Cleanly abort watchers and timers on `q`, Ctrl+C, process signals, and
  errors.
- [ ] Restore terminal raw mode and cursor visibility in every exit path.
- [ ] Run `node --test tests/workflow-watch-source.test.mjs` and confirm all
  pass.

**Acceptance:** Temp-directory tests simulate atomic state replacement, lane file
creation, rapid event bursts, missing filenames, partial JSONL, journal
rename-replacement (resume compaction), run cleanup, and watcher failure. The
observer refreshes and the process exits cleanly.

---

## Task 10: Add and package the companion CLI

**Files:**

- Add: `bin/opencode-workflows.js`
- Add: `workflow-cli/workflow-watch.js`
- Modify: `package.json` (`bin` field, `files[]`)
- Modify: `README.md`, `docs/workflow-plugin.md`
- Modify: `docs/conventions.md` and `docs/publishing.md` (parent directory
  standards) or `docs/standardization-backlog.md` — see the reconciliation
  checkbox
- Test: `tests/workflow-watch-cli.test.mjs` (new)

**Command contract:**

```text
opencode-workflows watch [runId]
opencode-workflows watch --json [runId]
opencode-workflows watch --ascii [runId]
opencode-workflows watch --root <project-or-worktree>
```

- [ ] Write the failing CLI fixture tests first (every scenario in the
  acceptance line); run and confirm failure.
- [ ] Add a Node shebang and npm `bin` mapping.
- [ ] Reconcile the packaging shape with the plugin-family standard: no plugin
  in this workspace ships a `bin` entry today, and neither `AGENTS.md`,
  `docs/conventions.md`, nor `docs/publishing.md` accommodates one. Either
  extend those normative docs with an explicit CLI/bin convention or record the
  deviation in `docs/standardization-backlog.md` (the family's existing
  mechanism for per-plugin exceptions) — do not ship an undocumented exception.
- [ ] Discover project and global run roots using the same package helpers as
  the plugin (`runRoots`, `run-store-fs.js:169-171`).
- [ ] With no run ID, show running/recent runs; auto-select only when exactly one
  active run exists and the behavior is documented.
- [ ] Reject unsafe run IDs using the existing validator.
- [ ] Require a TTY for interactive mode; provide bounded text/JSON one-shot
  output when stdout is not a TTY (routed through the same observer bounding —
  `--json` output obeys the Task 5 preview ceiling).
- [ ] Add `--version` and observer-schema compatibility diagnostics, including
  the `unsupported-state-version` behavior from Task 1.
- [ ] **Verify before documenting** the Bun-cache PATH claim: register this
  package by name in a scratch project the way OpenCode auto-installs plugins,
  and record where the package lands and whether its `bin` is linked onto any
  PATH. Only then write the install/invocation guidance for OpenCode-cache
  users, npm, and Bun (mirroring Task 6's spike-before-claim structure).
- [ ] Extend the packaging gates for the new shape: `files[]` includes `bin/`
  and `workflow-cli/`, and the packed-tarball assertion added here must live in
  `tests/workflow-watch-cli.test.mjs` (which `npm test` globs —
  `package.json:46`) so it runs as a permanent gate alongside
  `tests/publish-completeness.test.mjs` and
  `tests/published-entrypoint.test.mjs`.
- [ ] Run `node --test tests/workflow-watch-cli.test.mjs` and confirm all pass.

**Acceptance:** CLI fixture tests cover cwd discovery, explicit root, explicit run
ID, no runs, multiple active runs, malformed runs, non-TTY JSON, unsupported state
version, SIGINT cleanup, and exit codes. A package dry run contains every required
CLI module, asserted by a permanent test. The documented install paths were
exercised, not inferred.

---

## Task 11: Read-only inspector integration gate

**Files:**

- Add: `tests/workflow-watch-integration.test.mjs` (new; may be gated like the
  existing child-system smoke)
- Modify: `docs/plugin-system-tests.md`

This task exists so the read-only-inspector milestone is not declared from
fixtures alone: Tasks 1-10 verify observer, renderer, watcher, and CLI in
isolation; nothing before this point wires them together against a real run.
(The run-controller milestone already gates on live tests; this closes the same
gap for the inspector.)

- [ ] Write the integration test first as a failing/skipped scaffold; run and
  confirm it fails or is explicitly gated before implementing the harness.
- [ ] Launch a real background workflow (disposable OpenCode child per
  `docs/plugin-system-tests.md`), run the assembled CLI against the live run
  dir, and assert: run appears in the root list, phases advance, lanes appear
  with queued->running->terminal transitions, sanitized detail renders, and no
  raw prompt/tool/result text appears anywhere in captured output.
- [ ] Kill the owning OpenCode process mid-run and assert the companion reports
  owner death truthfully without implying it can continue execution.
- [ ] Assert clean terminal restoration after `q` and after SIGINT.
- [ ] Document the procedure in `docs/plugin-system-tests.md`.

**Acceptance:** The live integration test passes against a real background run.
**Read-only inspector milestone complete after this task.** At this point the
product may claim Claude-like run/phase/agent inspection in a separate terminal,
but not lifecycle-control parity.

---

## Task 12: Reframe toasts as the ambient progress surface (parallel track)

**Files:**

- Modify: `workflow-kernel/notification-toast-policy.js`
- Modify: `workflow-kernel/notification-toast.js` (delivery gate:
  `activeToastDeliveries` WeakSet, `notification-toast.js:28`, gate and
  `.finally()` cleanup at `:43-50` — a hung `tui.showToast` that never settles
  permanently suppresses all future toasts for that plugin context; existing
  test: `tests/notification-toast.test.mjs:24-46`)
- Modify: `workflow-kernel/notification-toast-cards.js`
- Modify: `workflow-kernel/constants.js`
- Modify: `CHANGELOG.md`
- Test: `tests/notification-toast-policy.test.mjs`,
  `tests/notification-toast.test.mjs`, `tests/notification-toast-cards.test.mjs`

This task is a **parallel track**: it does not gate the read-only inspector
milestone (Task 11 does). Land it any time after Task 7's outcome is known.

- [ ] Write the failing tests first (storm coalescing, delivery-state recovery,
  terminal-card once-only); run and confirm failure.
- [ ] Keep immediate run-start, phase, problem, approval-wait, and terminal cards.
- [ ] Coalesce lane start/completion storms into bounded milestone summaries.
- [ ] Keep a sparse heartbeat only as a liveness fallback; do not simulate a
  continuously refreshing panel with stacked toasts.
- [ ] Add a short companion-watch hint only when the CLI is documented and
  realistically invokable (per Task 10's verified install paths).
- [ ] Replace the permanent hung-delivery suppression (the `activeToastDeliveries`
  gate above) with an explicit delivery state that cannot accumulate unbounded
  unresolved calls, records diagnostics, and can recover after a hung delivery.
- [ ] Add user-selectable `alerts`, `balanced`, and `off` modes only if plugin
  option configuration has a tested, documented shape.
- [ ] Remove or rename `idle` wording unless Task 7 established real activity.
- [ ] Run the three toast suites and confirm all pass.

**Acceptance:** Event storms produce bounded cards, a hung toast API cannot affect
workflow correctness and no longer permanently mutes future toasts, terminal
cards fire once, and toast tests make no claim of in-place replacement or
interaction.

---

## Task 13: Factor a safe save-script operation

**Files:**

- Modify or extract from: `workflow-kernel/role-template-loading.js`
  (`saveWorkflow`, `role-template-loading.js:393-420`; global-scope-intent
  guard `:397-399`; overwrite guard `:411-413`)
- Dependency only: `workflow-kernel/workflow-source.js` (`parseWorkflowSource`,
  called for validation at `role-template-loading.js:403` — the save logic does
  **not** live here)
- Modify: `workflow-kernel/workflow-plugin.js` (`workflow_save` adapter,
  `workflow-plugin.js:3165-3175`; import site `:165-172`)
- Modify: `workflow-kernel/workflow-observer.js`
- Modify: `workflow-cli/workflow-watch-state.js`
- Modify: `CHANGELOG.md`
- Test: `tests/workflow-save.test.mjs` (new), `tests/workflow-watch-cli.test.mjs`

- [ ] Write the failing tests first (scope containment, tampered-script
  rejection, overwrite confirmation, global-intent); run and confirm failure.
- [ ] Extract a host-side save function from `saveWorkflow` that validates
  source, destination scope, name, containment, and overwrite policy without
  depending on a model tool call.
- [ ] Keep `workflow_save`'s write-permission guard at its adapter boundary.
- [ ] Let the explicit human CLI action call the same validated save function.
- [ ] Read source from the run's contained `script.js` and verify its hash against
  the persisted run source hash before saving.
- [ ] Require an explicit name, project/global destination, and overwrite
  confirmation.
- [ ] Preserve the existing global-scope intent requirement
  (`globalScopeIntent !== "save-global-workflow"` rejection,
  `role-template-loading.js:397-399`) or define an equally explicit CLI
  confirmation.
- [ ] Document the threat-model boundary honestly: the hash check is
  **tamper-evidence** against accidental drift and stale scripts, not a defense
  against a co-located same-user process that can rewrite `script.js` and
  `state.json` (same 0600 owner) consistently — that adversary is outside the
  plugin's existing trust model (see Task 14's trust statement) and gets a
  documentation caveat, not a mechanism.
- [ ] Refresh OpenCode documentation to remind users that newly saved commands
  require OpenCode restart before discovery.
- [ ] Run the listed suites and confirm all pass.

**Acceptance:** The `s` action cannot write outside an allowed workflow registry,
cannot save a tampered script under the approved hash, and never overwrites
without confirmation.

---

## Task 14: Specify the companion control protocol (extend, do not reinvent)

**Files:**

- Add: `docs/superpowers/specs/<date>-workflow-companion-control-protocol.md`
- Add later (Task 15/17): `workflow-kernel/workflow-control.js`
- Test later (Task 15/17): `tests/workflow-control.test.mjs`

This task is design-first. Do not add `p`, `x`, or `r` keybindings until the
spec is approved.

**Scope decision (2026-07-18):** run-level delivery **reuses the existing
lifecycle-request transport** — `writeLifecycleRequest` /
`readLifecycleRequests` (`run-store-locks.js:143-162`) with owner pickup via
`checkDurableLifecycleRequest` (`workflow-plugin.js:346-386`) and owner-claim
via the runs map + `run.lock` liveness (`lifecycle-control.js:543-568`,
`run-store-fs.js:120-154`). Those solved problems are **out of scope** for this
spec. The spec designs only what the existing transport lacks:

- [ ] Acknowledgement/completion records (the existing transport has none, and
  Task 15's pending/accepted/completed companion state requires them): schema
  versions, file locations under the contained run dir, retention and cleanup.
- [ ] Request IDs and at-most-once processing with idempotent retries, layered
  onto the existing request-file envelope
  (`{stateVersion, type, requestedAt, reason, process}`) as additive fields.
- [ ] Result taxonomy: accepted, rejected, completed, raced, stale-owner,
  unsupported.
- [ ] Lane-level targeting: request carries `{callId, expected attempt,
  expected childID, expected status}` so stale selections are rejected as
  harmless no-ops.
- [ ] Concurrent-writer arbitration, including **two companion instances (or two
  human operators) issuing conflicting requests** for the same run or lane:
  single-owner serialization plus expected-status/attempt preconditions resolve
  the loser as `raced`; spell this scenario out as a named race with a named
  test.
- [ ] `x` (resumable stop) maps onto an **existing** resumable lifecycle type —
  pause (cooperative, `pausing -> paused`) or kill (forced,
  `interrupted`) — chosen and justified here. No new terminal status is
  introduced for UI wording (consistent with the lane-transition rule above).
- [ ] How the live owner notices requests between lane-launch boundaries (the
  existing poll fires only at `child-agent-runner.js:837,845`): a bounded
  control-watcher interval tied to plugin lifecycle, specified so it cannot
  keep a dead workflow alive.
- [ ] Validation that only the live run-lock owner executes active-run controls,
  reusing the existing liveness check — restated, not redesigned.
- [ ] Trust statement: control files are same-user-writable, exactly like the
  **already shipped** `cancel/pause/kill-request.json` files, which any
  co-located process (including a shell-authority lane running in the project
  directory) can already forge today. The OS user is the existing trust
  boundary; the human-confirmation marker is UX/idempotency plumbing, **not**
  authentication. State explicitly why this channel does not weaken workflow
  launch/apply approval or lane authority: every reachable action is either
  already reachable via the shipped request files (pause/cancel/kill) or is
  gated behind the same kernel invariants (restart budget/identity rules,
  save-hash checks).
- [ ] Why the resume gate cannot be widened from the companion: the accurate
  mechanics from the baseline (kernel resume is process-agnostic; the
  companion simply cannot invoke tools), not an invented
  "original invocation context" requirement.

**Approval is operationalized:** this spec document carries its own `> Status:`
banner. The user flips it from `proposed` to `approved` in a recorded commit
touching the spec. Tasks 15 and 17 are blocked until the sections they
implement are `approved`.

**Acceptance:** The approved spec maps every action to a kernel invariant, has
defined race behavior (including the two-companion race) before implementation
starts, and adds zero run-level delivery machinery that duplicates the existing
lifecycle-request transport.

---

## Task 15: Implement run-level companion controls

**Files:**

- Add: `workflow-kernel/workflow-control.js` (acks, request IDs, watcher — per
  approved Task 14 spec)
- Modify: `workflow-kernel/workflow-plugin.js`
  (`checkDurableLifecycleRequest`, `workflow-plugin.js:346-386`)
- Modify: `workflow-kernel/lifecycle-control.js:543-645`
- Modify: `workflow-kernel/run-store-locks.js:143-162` (additive envelope
  fields only)
- Modify: `workflow-kernel/run-context.js`
- Modify: `workflow-cli/workflow-watch.js`, `workflow-cli/workflow-watch-state.js`
- Modify: `CHANGELOG.md`
- Test: `tests/workflow-control.test.mjs` (new), `tests/workflow-lifecycle.test.mjs`

- [ ] Write the failing tests first (request->ack lifecycle, duplicate
  idempotency, dead-owner rejection, pause-vs-completion race); run and confirm
  failure.
- [ ] Implement request creation, owner claim, validation, acknowledgement, and
  completion records from the approved Task 14 spec — the companion writes the
  **existing** pause/cancel/kill request files (with additive ID fields); only
  the ack/result records are new files. One polling path: the owner's existing
  lifecycle check plus the spec's bounded control-watcher interval; never two
  parallel channels for the same action.
- [ ] Add `p` for pause/resume only when each selected status has a valid action.
- [ ] Add `x` at run focus as the spec's chosen resumable-stop mapping
  (existing pause or kill semantics — no new status), matching the companion UI
  wording.
- [ ] Preserve existing `workflow_cancel` as a distinct terminal operation.
- [ ] Gate companion-initiated resume on the **actual** kernel requirements:
  persisted status in `RESUMABLE_STATUSES` (`workflow-plugin.js:195,405-436`),
  `run.lock` not held by a live process (`run-store-locks.js:69-104`), and a
  live owner plugin process whose control watcher can act on the request. When
  no live owner exists, reject with the existing OpenCode resume instruction
  (any OpenCode session can resume via `workflow_run({resumeRunId})`; the
  companion itself cannot invoke tools). Do **not** implement an
  "original invocation context" check — the kernel has none.
- [ ] Never auto-reconcile, auto-apply, or start a new owner process.
- [ ] Show request pending/accepted/completed state in the companion.
- [ ] Make duplicate keypresses idempotent.
- [ ] Resolve pause-vs-completion and stop-vs-failure races deterministically,
  and the two-companion conflicting-request race per the spec (loser surfaces
  as `raced` in both companions).
- [ ] Run the listed suites and confirm all pass.

**Acceptance:** System tests prove pause/resume and resumable stop on a live
background run, reject dead-owner control without mutation, prove the
two-companion race resolves with one winner and one `raced` result, preserve
completed lane cache hits, and leave approval/apply behavior unchanged.

**Run controller milestone complete after Task 15.**

---

## Task 16: Specify selected-lane stop and restart semantics

**Files:**

- Extend: `docs/superpowers/specs/<date>-workflow-companion-control-protocol.md`
  (same approval mechanism as Task 14: section banner flips to `approved`)

Resolve these questions before code:

- [ ] What result does the awaiting workflow script receive after manual lane
  stop?
- [ ] Is manual stop represented as cancellation, failure, resumable
  interruption, or a new outcome?
- [ ] Do fail-fast siblings continue or abort
  (`cancelFanoutSiblings`, `sandbox-executor.js:152,772`)?
- [ ] Does restart preserve the logical call ID and increment an attempt ID?
- [ ] Does restart consume `maxAgents`, or is that budget logical-lane based?
- [ ] How is already-spent token/cost usage retained?
- [ ] Does restart create a new child session and worktree?
- [ ] How are partial edit/integration worktrees salvaged or discarded?
- [ ] Can only running lanes restart, matching Claude's documented UI?
- [ ] What happens when completion races stop/restart?
- [ ] What happens when **two operators** stop/restart the same lane
  concurrently (expected-attempt/childID preconditions reject the stale one)?
- [ ] How are schema corrective retries distinguished from a human restart?
- [ ] How does resume replay see manually restarted attempts?
- [ ] What runner restructuring does restart require? Today one latched
  `laneAbortController` spans all attempts of a lane
  (`child-agent-runner.js:585-588`) and the retry loop advances only via
  classified errors (`child-agent-runner.js:904-1243`); restart-in-place needs
  a per-attempt abort scope and an operator-restart classification path —
  budget that runner work explicitly in Task 17.

Recommended initial semantics to evaluate, not yet approve:

- Stop targets the exact `{ callId, attempt, childID }` and aborts only that
  attempt.
- The logical lane returns through the existing cancelled/failure path, honoring
  the fan-out's existing `failFast` policy.
- Restart is valid only while the logical lane is still awaiting a result; it
  aborts the exact current child and starts a new child attempt inside the same
  `runChildAgent` invocation.
- All spend remains counted; restart does not refund budget.
- Worktree reuse is forbidden unless dirty-state and integration invariants prove
  it safe.

**Acceptance:** An approved semantic state machine covers all listed races and
edit/read-only variants, recorded in the spec with its section banner flipped to
`approved` by the user.

---

## Task 17: Implement selected-lane controls

**Files:**

- Modify: `workflow-kernel/workflow-control.js`
- Modify: `workflow-kernel/child-agent-runner.js` (per-attempt abort scope —
  see Task 16's runner note; current single controller at
  `child-agent-runner.js:585-588`)
- Modify: `workflow-kernel/lifecycle-control.js`
- Modify: `workflow-kernel/run-store-projections.js`
- Modify: `workflow-cli/workflow-watch.js`
- Modify: `CHANGELOG.md`
- Test: `tests/workflow-control.test.mjs`, `tests/child-agent-runner.test.mjs`,
  `tests/sandbox-executor.test.mjs`

- [ ] Write the failing adversarial tests first (full list in acceptance); run
  and confirm failure.
- [ ] Add `x` for the selected running lane and `r` for selected-running-lane
  restart according to Task 16's approved state machine.
- [ ] Target exact attempt/child identity and reject stale selections.
- [ ] Journal operator action, accepted target, final attempt outcome, and new
  attempt identity without recording raw prompts/results.
- [ ] Preserve budget, slot, cache, checkpoint, schema, fail-fast, worktree, and
  integration invariants.
- [ ] Show a raced completion as a harmless rejected/no-op control result.
- [ ] Keep terminal and queued lanes non-restartable unless a later contract is
  designed.
- [ ] Run the listed suites and confirm all pass.

**Acceptance:** Adversarial tests cover read-only success, transient retry,
corrective retry, fail-fast siblings, queued/running race, completion race,
timeout race, edit worktree dirty state, pause race, two-operator race, and
owner death.

**Lane controller milestone complete after Task 17.**

---

## Task 18: Full system verification, packaging, and release documentation

**Files:**

- Modify: `README.md`, `docs/workflow-plugin.md`, `docs/plugin-system-tests.md`,
  `docs/claude-parity-roadmap.md`, `CHANGELOG.md`
- Modify: package metadata as required
- Test: all new and existing suites

- [ ] Document the companion as a separate process and show its exact data/control
  boundary (including that run-level controls ride the existing
  lifecycle-request transport).
- [ ] Document monitor, inspector, run-controller, and lane-controller capability
  levels without collapsing them into one claim.
- [ ] Document install/invocation for OpenCode cache users, npm, and Bun, from
  Task 10's **verified** results only.
- [ ] Document privacy defaults and excluded raw data, using Task 5's honest
  guarantee wording (bounded + secret-masked, not semantically filtered).
- [ ] Document process-death behavior and recovery actions.
- [ ] Document approval as a deliberate OpenCode-only interaction.
- [ ] Re-run the Task 11 integration test plus a control-mode variant: exercise
  supported controls on a live background run and confirm cleanup.
- [ ] Test two simultaneous runs and two OpenCode processes sharing the same
  project/global run roots, plus two companion instances on one run.
- [ ] Test Linux as the required release platform; record Windows/macOS status
  honestly rather than claiming portability from Node APIs alone.
- [ ] Run focused suites first, then the full no-token plugin matrix:

```bash
node --test tests/workflow-observer.test.mjs
node --test tests/workflow-watch-renderer.test.mjs
node --test tests/workflow-watch-source.test.mjs
node --test tests/workflow-watch-cli.test.mjs
node --test tests/workflow-control.test.mjs
npm test
```

- [ ] Run the plugin system smoke in a fresh/restarted OpenCode child as documented
  in `docs/plugin-system-tests.md`.
- [ ] Inspect packed package contents and exercise the documented installed CLI,
  not only the source-tree entrypoint (the permanent packed-contents assertion
  lives in `tests/workflow-watch-cli.test.mjs`, per Task 10).
- [ ] Confirm the conventions reconciliation from Task 10 landed
  (`docs/conventions.md`/`docs/publishing.md` extension or
  `docs/standardization-backlog.md` entry).
- [ ] Restart OpenCode before claiming plugin/config-time behavior is verified.

**Acceptance:** The exact release commands pass; the installed package exposes the
companion; a live run demonstrates the documented hierarchy and controls; no raw
reasoning/tool payload appears; owner death is reported truthfully; all unsupported
platform or event behavior remains explicitly caveated.

**Full companion-UI parity milestone complete only after Task 18 and only for the
documented companion equivalents.** Approval remains in OpenCode and the ambient
surface remains toast-based, so release copy must continue to call this companion
parity rather than native OpenCode TUI parity.

## Verification Strategy

Every implementation task sequences its listed tests **first** (write, run,
confirm failure) before implementing — the per-task checkboxes encode this.

### Pure tests

- Observer projections and compatibility fixtures (including
  `unsupported-state-version` and `runRoot` disambiguation).
- Phase occurrence and aggregate calculations (including resume
  claim-by-ordinal and the per-phase lane cap).
- Lane transition state machine (including `lastTransitionAt` monotonicity and
  the compact queued projection).
- Redaction, truncation, result previews, and activity taxonomy (including the
  journal-tail bounding rule and field-name stripping).
- Renderer golden output under injected dimensions/clock, resize, and the
  degraded-activity variant.
- Navigation and filter reducer.
- Control request/ack state machine.

### Fake-filesystem/temp-directory tests

- Atomic replacement and cross-file skew (full watched-set re-stat).
- Partial/corrupt JSONL and journal rename-replacement (resume compaction).
- Run directory creation/removal.
- Stale PID and lock state.
- Multiple run roots and duplicate run IDs (root surfaced, first-match
  documented).
- Control claims, duplicate requests, and the two-companion conflicting-request
  race.
- Max-size measurement fixture (journal at cap, 500-lane run) with recorded
  timings.

### Mocked OpenCode integration tests

- Child event correlation and filtering (including synthetic events carrying
  `state.input`/`state.output`, asserted stripped).
- Live usage reconciliation if available.
- Pause/resume/stop dispatch over the extended lifecycle-request envelope.
- Selected-lane abort/restart races.
- Notification and completion behavior unchanged.

### Live child-system tests

- Plugin restart/loading.
- Child tool activity delivery (Task 6 spike with numeric bars).
- Background run while the primary session remains responsive.
- Companion observation with no SDK/server connection (Task 11 gate).
- Process death and stale reporting.
- Installed package CLI invocation (verified install paths).
- Terminal cleanup after normal exit and interruption.

## Rollout Plan

1. Dogfood the observer and read-only renderer behind an undocumented CLI command.
2. Publish the **monitor** label after run-list and flat detail prove stable.
3. Publish the **read-only inspector** label only after Task 11's live
   integration gate passes.
4. Keep controls disabled until the Task 14/16 spec sections are `approved`
   (banner flip recorded in a commit) and tested.
5. Publish the **run controller** and **lane controller** labels independently.
6. Claim **full companion-UI parity** only after installed-package and live-system
   proof of all documented equivalent actions.

## Explicit Non-Goals

- Native OpenCode TUI panels, routes, sidebars, dialogs, or task-panel injection.
- OpenCode core patches or a private fork.
- Companion connection to the OpenCode HTTP server or event stream.
- A second run-level control transport parallel to the existing
  lifecycle-request files.
- Detached workflow supervision or automatic process respawn.
- Automatic reconcile, resume, apply, cleanup, or approval.
- Mid-run conversational steering of a workflow or lane.
- Raw chain-of-thought display.
- Parsing undocumented OpenCode transcript/log storage as a stable API.
- Exact visual copying of Claude Code branding or layout.
- Claiming cross-platform support without runtime tests.

## Risks and Stop Conditions

| Risk | Required response |
| --- | --- |
| Child events are incomplete or cannot be correlated | Ship coarse transition data; do not poll transcripts or connect companion to server |
| Event volume threatens run performance | Reduce to semantic transitions; disable live activity before affecting execution |
| Phase calls overlap active lanes unexpectedly | Preserve lane's enqueue-time phase; show straddling lanes honestly |
| Observer reads become expensive at maximum journals **or lane counts** | Bound reads per the Task 1 measurement numbers and the Task 4 lane cap; do not add duplicate snapshots preemptively |
| Queued-lane persistence bursts writes at fan-out start | Compact single queued projection with a debounced serialized writer (Task 3); never one durable file per queued lane |
| TUI library appears necessary | Stop for dependency safety/review before adding it |
| No live owner process exists to act on a companion resume request | Reject with the existing OpenCode resume instruction; never fake `p` parity or invent an owner |
| Selected-lane restart breaks budget/cache/worktree invariants | Do not ship `r`; keep lane controller milestone open |
| Control protocol permits non-owner execution | Fail closed and keep companion read-only |
| Renderer exposes raw prompt/tool/result data | Block release until projection tests and live capture prove bounded sanitized output |
| Installed plugin does not expose the CLI on PATH | Document only the Task 10-verified npm/Bun invocation; do not print a broken toast hint |

## Claim Ledger

| Claim | Evidence | Confidence | Caveat |
| --- | --- | --- | --- |
| OpenCode server plugins can show toasts but public docs do not expose custom persistent panels | OpenCode plugin/SDK/TUI docs linked above | High | Undocumented package types exist but are intentionally excluded |
| A separate Node terminal watcher is feasible | Node `fs`, `readline`, and `tty` docs; existing local run artifacts | High on Linux | `fs.watch` requires directory watching and polling fallback; other OSes need runtime tests |
| Current files support a run list and coarse lane view | `run-store-status-format.js:908-928`; `run-store-projections.js:61-122` | High | **No lightweight enumerate path exists**: every listing fully parses every run's state/locks/requests, plus the entire journal for interrupted runs, before any limit applies (`run-store-status-format.js:1012-1016`) — this constrains observer/watcher cadence |
| Current files do not reliably support per-phase agent totals | Lanes lack phase identity in current projections (`run-store-projections.js:61-122`) | High | Timestamp reconstruction would be an inference |
| Run-level pause/cancel/kill already have a durable cross-process file transport | `run-store-locks.js:143-162`; `workflow-plugin.js:346-386`; `lifecycle-control.js:543-568`; `tests/workflow-lifecycle.test.mjs:476` | High | No acknowledgement channel, no request IDs, no lane targeting; polled only at lane-launch boundaries |
| Safe recent tool names may be feasible through plugin events | OpenCode event hook docs and pinned SDK event shapes | Medium | Tool state arrives with raw input/output inline on message-part updates; delivery/order must pass Task 6's numeric bars |
| Claude exposes run/phase/agent drill-down and controls | Claude workflow docs `Watch the run` | High | Visual details are not treated as a contract |
| Claude dynamic workflow resume is same-session, not process-durable | Claude workflow docs `Resume after a pause` | High | Announcement wording is broader and therefore not used for this claim |
| This plugin can recover persisted completed work after owner interruption | Existing journal/checkpoint/reconcile/resume implementation and active docs | High | Live execution still dies with OpenCode; resume is explicit |
| Kernel resume is process-agnostic (status + stale lock + envelope; no original-context check) | `workflow-plugin.js:195,388-436`; `run-store-locks.js:69-104` | High | The companion's limitation is tool invocation, not resume semantics; Task 15 must not invent a stricter check |
| Full companion control parity requires new runtime semantics | No lane-level control or acknowledgement channel exists; `run-store-locks.js:155-162` handles only cancel/pause/kill | High | Run-level delivery is already solved; save is simpler and can land before run/lane controls |

## Completion Definition

This plan is complete only when:

- The installed companion presents run -> phase -> agent navigation.
- Phase membership and queued/running state come from durable first-class data,
  not timestamp guesses.
- Agent detail is sanitized, bounded, and explicit about unavailable/partial data.
- Toasts function as ambient alerts rather than a simulated dashboard.
- The companion performs no OpenCode server/SDK/TUI connection.
- Run-level controls ride the extended existing lifecycle-request transport;
  lane controls obey the approved, tested state machine.
- Approval and apply remain in OpenCode and retain all hash/authority gates.
- Owner death and resume limitations are displayed truthfully, using the
  kernel's actual resume requirements.
- Exact tests and live installed-package checks pass, including the Task 11
  integration gate.
- Active docs distinguish native OpenCode TUI integration from companion parity.
