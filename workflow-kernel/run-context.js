// RunContext: the mutable per-run state object that threads through the workflow
// orchestrator (workflow-plugin.js) and every extracted boundary it dispatches to
// (sandbox-executor.js, child-agent-runner.js, run-store-status.js, lifecycle-control.js,
// event-journal.js, budget-accounting.js, ...).
//
// This module is intentionally type-only: it carries NO runtime logic. Its single job is
// to document the coupling surface — the ~70-property "run" object that threads through the
// orchestrator and its extracted boundaries. Extracted modules import
// the {@link RunContext} typedef so the property contract each boundary reads/writes is
// explicit rather than implicit, and so the natural module split points (which subset of
// these properties a concern actually touches) become visible.
//
// The canonical construction site is startWorkflow() in workflow-plugin.js. resume seeds a
// subset from prior on-disk state via rehydrateRunFromPriorState (run-store-status.js).
// Mutation here is deliberate: the run object IS the orchestrator's shared mutable state;
// typing it does not freeze it.

/**
 * Per-lane abort wiring tracked for in-flight child agents, keyed by callId.
 *
 * @typedef {object} ActiveLaneAbort
 * @property {AbortController} abortController Lane-scoped controller, chained to run.abortController.
 * @property {string|undefined} childID Child session id once session.create returns.
 * @property {string|undefined} directory Working directory (worktree path or tool directory).
 */

/**
 * A pending concurrency-slot waiter (see acquireAgentSlot / releaseAgentSlot).
 *
 * @typedef {object} WaitingAgent
 * @property {() => void} resolve Hand off the slot to this waiter.
 * @property {(error: Error) => void} reject Reject the waiter (cancellation / fanout abort).
 * @property {string} callId Lane call id, used by fanout cancellation to target waiters.
 */

/**
 * Token accounting bucket (live or replayed).
 *
 * @typedef {object} TokenUsage
 * @property {number} input
 * @property {number} output
 * @property {number} reasoning
 */

/**
 * The mutable run context threaded through the orchestrator and its boundaries.
 *
 * Grouped by concern to make the split surface legible. The grouping is documentation
 * only; at runtime this is one flat object.
 *
 * @typedef {object} RunContext
 *
 * --- identity / source / approval envelope ---
 * @property {string} id Run id (resume id or a fresh uuid).
 * @property {string} dir Durable run directory (state.json, journal.jsonl, lanes/, worktrees/).
 * @property {string} sourcePath Resolved workflow source path ("<inline>" for inline sources).
 * @property {string} sourceHash Content hash of the workflow source (approval-bound).
 * @property {object} meta Parsed workflow meta (name, description, phases, ...).
 * @property {object} authority Resolved authority profile (edit/worktreeEdit/integration, gates, isolation).
 * @property {*} runtimeArgs Caller-supplied runtime args (approval-bound).
 * @property {string} argsPreview Redacted preview of runtimeArgs for approval/status text.
 * @property {Map<string, object>} nestedSnapshots Approved nested-workflow source snapshots, by path and hash.
 * @property {boolean} [externalSource] True when the source was loaded via allowExternalScriptPath opt-in.
 *
 * --- lifecycle / status ---
 * @property {string} status running | cancelling | pausing | paused | interrupted | completed | failed | ...
 * @property {string} startedAt ISO start timestamp (preserved across resume).
 * @property {string|undefined} resumedAt ISO timestamp set when a run resumes.
 * @property {string|undefined} finishedAt ISO completion timestamp.
 * @property {string|undefined} currentPhase Most recent phase() name.
 * @property {Error|string|undefined} error Terminal error, if any.
 * @property {{enabled: boolean, source?: string}|undefined} debugCapture Opt-in prompt/schema/transcript capture state.
 * @property {string|undefined} firstResultAt First successful lane completion timestamp.
 * @property {number|undefined} timeToFirstResultMs Duration from run start to first successful lane.
 * @property {{startedAt?: string, completedAt?: string, durationMs?: number, diffPlanHash?: string}|undefined} approvalWait Diff-approval wait metric.
 * @property {string[]} recentLogs Last narrator log() lines, bounded for toast/status display.
 * @property {object|undefined} lifecycleRequests Last-read durable cancel/pause request envelope.
 * @property {boolean} pauseRequested Set when a durable pause request is observed.
 * @property {boolean} background True for fire-and-forget background runs.
 * @property {boolean} ignoreToolAbort True when the run must ignore the tool-call abort signal (background).
 * @property {Promise<*>} [done] Background run completion promise.
 *
 * --- budget / concurrency / model plan ---
 * @property {number} agentsStarted Child agents launched (carried across resume).
 * @property {number} maxAgents Hard cap on agents started.
 * @property {number} concurrency Max concurrent active agents.
 * @property {number} activeAgents Currently running agents (gated by concurrency).
 * @property {WaitingAgent[]} waitingAgents FIFO queue of agents awaiting a concurrency slot.
 * @property {number} laneTimeoutMs Default per-lane prompt timeout.
 * @property {string} defaultChildModel Fallback child model.
 * @property {{fast?: string, deep?: string}|undefined} modelTiers Lane model tier map.
 * @property {TokenUsage} tokens Live token usage accumulated this session.
 * @property {TokenUsage} replayedTokens Token usage carried forward from prior segments at resume.
 * @property {number} cost Live cost accumulated this session.
 * @property {number} replayedCost Cost carried forward from prior segments at resume.
 * @property {{maxCost?: number, maxTokens?: number}|undefined} budgetCeilings Budget stop ceilings.
 * @property {{hits: number, misses: number, invalidated: number}} cacheStats Resume cache-hit accounting.
 * @property {Object<string, number>} laneOutcomes Per-outcome lane counters.
 * @property {number} droppedLaneCount Fanout lanes dropped (non-failFast failures).
 * @property {number} guestDeadlineMs Interrupt deadline budget for synchronous guest bursts.
 * @property {number} hostCalls Host-op call counter (per-run scaled host-call guard).
 *
 * --- capability / adapter surface ---
 * @property {object} capabilities Resolved shape-only client capabilities (childSession, worktree, toast).
 * @property {object} diagnostics Capability diagnostics (incl. serverFingerprint).
 * @property {object} adapter Capability adapter (createWorktree, removeWorktree, ...).
 * @property {object} [worktreeAdapter] Native integration worktree adapter (lazily created).
 *
 * --- edit / integration / worktrees ---
 * @property {object[]} editWorktrees Throwaway edit-lane worktree records.
 * @property {object|undefined} editPlan Accumulated diff plan (patches, baseCommit) for edit authority.
 * @property {object|undefined} integrationPlan Integration plan (lanes, baseCommit, integrationResult).
 * @property {object[]} integrationWorktrees Integration-lane worktree records.
 * @property {object} [worktreeCleanup] Worktree cleanup summary ledger.
 *
 * --- lanes / journal / children ---
 * @property {Map<string, object>} laneRecords In-memory lane outcome records, by callId.
 * @property {Map<string, string>} children Active child session ids -> directory.
 * @property {Map<string, ActiveLaneAbort>} activeLaneAbortControllers In-flight lane abort wiring.
 * @property {Set<string>} cancelledFanoutScopes Fanout scopes cancelled by failFast.
 * @property {Map<string, object>} resumeJournal Prior-segment journal entries consulted on resume.
 * @property {Map<string, Map<string, object[]>>} resumeSignatureIndex Prior successful journal entries by lane signature and fallback scope.
 * @property {Set<string>} resumeSignatureClaims Prior callIds already consumed by exact or signature resume replay.
 * @property {number} eventCount Append-only events.jsonl line count (MAX guard).
 * @property {number} journalRecords Append-only journal.jsonl line count (MAX guard).
 * @property {(record: object, run: RunContext) => (Promise<void>|void)|undefined} eventSink Optional best-effort observer invoked after events append.
 * @property {number} nestingDepth Current nested-workflow recursion depth (max 1).
 *
 * --- control / notification ---
 * @property {AbortController} abortController Run-wide abort controller; lane controllers chain to it.
 * @property {object|undefined} notificationTarget Background completion-notification target.
 * @property {object} [notification] Completion-notification record/state.
 * @property {() => Promise<void>|void} [releaseRunLock] Release the durable run lock.
 */

// No runtime exports: this module exists purely to host the shared typedef. A named export
// keeps it a valid ES module and gives importers a stable specifier to attach the
// `@typedef {import("./run-context.js").RunContext}` reference to.
export const RUN_CONTEXT_TYPEDEF = "RunContext";
