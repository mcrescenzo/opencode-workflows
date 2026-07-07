# Comprehensive Toast Status Cards — Design

> Status: **approved design snapshot**. Approved on 2026-07-07 and retained for
> toast/notification system provenance.

**Date:** 2026-07-07
**Status:** Approved (brainstormed + user-validated in session)
**Scope:** opencode-workflows toast/notification system

## Goal

Make workflow toasts a "simplified /workflows inspector": minimal, high-transparency
status cards that keep the user in the loop about what is actually running — phases,
active agents and what they're working on, progress, problems — using **toasts only**.

Explicitly out of scope (considered and rejected in brainstorming):

- **Status file / STATUS.md pull surface** — rejected: toasts can't carry clickable
  links; users won't chase a file.
- **Plugin-hosted local web dashboard** — deferred; no opencode-API risk but more code
  to own than the value justifies right now.
- **TUI plugin (`export.tui`) sidebar/route inspector** — real in shipped code
  (`@opencode-ai/plugin` `dist/tui.d.ts`: Dialog*, slots, routes) but **entirely
  undocumented** at opencode.ai/docs, mid v1→v2 migration (`@deprecated` markers),
  unannounced. Watch-item only; revisit when documented/stable.
- **Hijacked `/wf` slash command → user-only toast burst** — feasible
  (`command.execute.before` + splice `output.parts` empty; precedent
  `goals/goal.js:2538`), deferred as a possible follow-up, not part of this epic.

## Constraints (verified against opencode.ai/docs + local SDK types)

- Server plugins can only paint via `client.tui.showToast` (title, message, variant,
  duration). No custom dialogs/panels/panes; no in-place toast replacement or stable
  IDs — consecutive toasts **stack**, so cards must stay short and scannable.
- All existing toast safety properties are preserved: `redactFreeTextSecrets()` before
  truncation, 1000-char message cap, 1s delivery timeout raced with AbortController,
  best-effort try/catch (toasts never affect workflow correctness), `hasWorkflowToast`
  capability gate, in-flight dedup WeakSet.

## Data inventory (what exists vs what's new)

Already on the `run` object / kernel (no new plumbing needed):

- `status`, `currentPhase`, `meta.phases` (declared phase list → position n/N)
- `agentsStarted`, `activeAgents`, `queuedAgents`, `laneOutcomes`, `droppedLaneCount`
- `laneRecords` per lane: label/taskSummary, model, `startedAt`, `lastActivityAt`,
  ageMs/idleMs, tokens; staleness signal (`stalenessSignal`) already computed for
  `workflow_status`
- tokens/cost/budget ceilings; retry events (`agent.retry` with attempt/nextAttempt)
- Pipeline/parallel structure encoded in lane `callId` scope paths
  (`pipeline:0/item:3/stage:1`) — currently rendered nowhere

New kernel additions (small):

1. **`run.eventSink`** — optional per-run observer invoked (try/catch, best-effort)
   from `appendEvent()` (`event-journal.js`), set by `workflow-plugin.js` at run start,
   cleared in the same `finally` that stops progress toasts. Gives push semantics for
   problem/phase cards without an EventEmitter.
2. **`run.recentLogs`** — ring buffer (last 3 narrator `log()` lines) fed by the `log`
   host op (`sandbox-executor.js`) alongside its existing `events.jsonl` append.
3. **Scope-path parser** — pure helper deriving `items N/M` (and stage position) from
   lane callId scope paths.

## Card set

Four card types, all in the **indented-outline** style (box-drawing tree; chosen over
glyph-breadcrumb and plain-ASCII variants).

### 1. Heartbeat / phase card (info)

Fires on the existing 45s interval AND immediately on phase change (via eventSink).
Signature-deduped as today; 75s force-refresh retained (toast duration is 90s).

```
Title: ▶ repo-bughunt · 4m12s
└ Verify (2/3)
  ├ ⟳ verify:auth-token 38s
  ├ ⟳ verify:sql-inject 12s
  └ ⟳ review:perf 2m ⚠idle
  done 14 · queued 5 · fail 1
  items 6/10 · budget 61%
» 7/10 verified so far
```

- Phase line: current phase name + `(n/N)` from `meta.phases`.
- Lane rows: up to 4 active lanes, longest-running first; idle-flagged lanes always
  included; label + age (+ `⚠idle` marker).
- Counters: done/queued/fail (fail only when > 0; dropped only when > 0).
- `items N/M` only when pipeline/parallel scope paths detected.
- Footer `»` line: latest narrator `log()` message.

### 2. Problem card (warning/error) — event-driven, immediate

```
Title: ✗ lane failed · repo-bughunt
verify:auth-token — timeout (attempt 2/3)
retrying in 8s · 2nd failure this run
▸ Verify: ✓14 ⟳3 ⧗5
inspect: workflow_status wf_x1
```

Same shape for:
- **Stalls** — reuses existing staleness signal ("no progress 4m · 2 lanes idle").
- **Budget crossings** — 80% (warning), 100% (error); once per threshold per run.

### 3. Terminal card (success/warning/error)

```
Title: ✓ repo-bughunt done · 12m40s
✓ Scan ✓ Verify ✓ Fix
22 lanes: ✓20 ✗2 (2 recovered)
188k tok · $0.84 · 71% of budget
» 9 confirmed bugs
inspect: workflow_status wf_x1
```

Replaces the shared message at the six existing terminal call sites in
`workflow-plugin.js` (completed / awaiting-diff-approval / review-required /
failed-with-diff-plan / apply-failed / catch-block statuses). "Recovered" = lanes that
retried then succeeded.

### 4. Apply-flow cards

Keep the existing four apply toasts (`apply-running`/`applied`/`review-required`/
`apply-failed` via `workflowApplyToastDescriptor`) but re-render bodies in the same
outline style.

## Cut from current cards

- Run-ID body line (kept only inside `inspect:` hint on problem/terminal cards)
- Dollar cost during run (terminal card only); replayed-token/cost stats entirely
- concurrency/maxAgents; cache stats
- `inspect:` hint on heartbeat cards
- dropped-lane count when zero; explicit "status:" word (title glyph + variant carry it)

## Firing policy guards

- **Per-category cooldowns + batching**: a lane-failure storm collapses to one card
  ("3 lanes failed in Verify") instead of stacking.
- Budget-threshold cards fire once per threshold per run.
- Heartbeat signature dedup + 75s force refresh unchanged.

## Structure & testing

- Renderers + firing policy live in pure modules (e.g. `notification-toast-cards.js`),
  no `@opencode-ai/plugin` import, per repo core-module convention.
- `node:test` coverage: golden-string tests per card layout; policy tests for
  cooldown/batching/threshold/dedup; ring-buffer and scope-parser unit tests.
- Existing `notification-toast.js` delivery mechanics (timeout, redaction, truncation,
  capability gate) unchanged.

## VERIFY-LIVE gate (first implementation step)

Render one real toast with box-drawing glyphs + multi-line body in the actual opencode
TUI and confirm alignment/wrapping before building all four cards on the layout.
Plain-ASCII fallback behind a config flag if glyphs misrender.

Result on 2026-07-07: normal OpenCode TUI rendered the probe toast with multiline
box-drawing content aligned inside the toast frame. The observed body included
`└`, `├`, `⟳`, `⚠`, `✓`, `»`, and a near-44-character lane line without glyph
misrendering. Decision: ship the indented-outline default and keep the ASCII
flag as a fallback, not as the default.
