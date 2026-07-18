# Run Audit Playbook

> Status: active operator playbook. Use this when a completed or interrupted
> workflow run needs post-hoc forensics, not just result readback.

Prefer sanctioned readers first:

```js
workflow_status({ runId, format: "json", detail: "full" })
workflow_events({ runId, format: "json", typePrefix: "cache." })
workflow_events({ runId, format: "json", typePrefix: "agent." })
```

Raw files under `.opencode/workflows/runs/<runId>/` can contain sensitive local
evidence. Read them only when the sanctioned tools do not expose the needed
field, and do not paste raw prompts, transcripts, or secrets into reports.

## Question Map

| Question | Primary source | Notes |
| --- | --- | --- |
| What was the final result? | `workflow_status({ detail: "result" })` | Redacted result readback, bounded for display. |
| Which lanes ran, failed, retried, or timed out? | `workflow_status({ detail: "full" }).laneRecords` | Each lane record includes outcome, childID, model, role, timestamps, and error summary. |
| Which lanes hit corrective structured-output retries? | `laneRecords[].correctiveAttempts` and `workflow_events({ typePrefix: "agent.corrective_retry" })` | Journal entries may also include `rawInvalidStructuredOutput` on exhaustion. |
| Which lanes were cache-served on the last resume? | `workflow_events({ typePrefix: "cache." })` | Plain `cache.hit` is event-only; lane projections are not rewritten on cache hits. |
| Which child session produced a lane? | `laneRecords[].childID` | Child sessions are diagnostic evidence and can be GC'd by OpenCode. |
| Where did wall-clock time go? | `laneRecords[].queueWaitMs`, `operatorMetrics.timeToFirstResultMs`, `operatorMetrics.approvalWaitMs` | Queue wait is stamped before slot acquisition; approval wait is present for diff-plan runs. |
| What was a lane asked? | `debug/<lane>/prompt.md` when debug capture was enabled | Debug capture is opt-in. Without it, prompts may be represented only by summaries and hashes. |
| Why did a lane fail or retry? | `laneRecords[].failureClass`, `retryable`, `errorSummary`, and `workflow_events({ typePrefix: "agent." })` | `failureClass` distinguishes terminal, transient, exhausted transient, and validation-exhausted failures. |

## Lane Forensics Hop

1. Start with `workflow_status({ runId, format: "json", detail: "full" })`.
2. Pick the lane from `laneRecords[]` by `callId`, role, outcome, or error.
3. Use its `childID`, `signatureHash`, `startedAt`, `completedAt`, `queueWaitMs`,
   model, role, and `correctiveAttempts`.
4. Use `workflow_events` with `typePrefix: "agent."`, `"cache."`,
   `"debug_capture."`, or `"fanout."` to reconstruct lifecycle context.
5. If `debugCapture.enabled` is true, inspect `debug/<safe lane id>/prompt.md`,
   `schema.json`, and `transcript.jsonl` locally. These files are redacted and
   private, but still sensitive.
6. Treat child-session transcript evidence as weaker than controller-owned
   journal/result evidence. A transcript can explain behavior, but it should not
   finalize domain work or primary-tree writes by itself.

## Marker Glossary

| Marker | Meaning |
| --- | --- |
| `recoveredFromCheckpoint` | The controller recovered a validated result from its own `lanes/<callId>.result.json` crash-window checkpoint. |
| `matchedViaSignatureFallback` | Resume reused a prior successful lane with the same content-addressed signature under a compatible scope. |
| `correctiveAttempts` | Structured-output validation needed one or more corrective prompts before success or exhaustion. |
| `rawInvalidStructuredOutput` | Final structured-output parsing/validation failed; the bounded redacted raw output was captured for diagnosis. |
| `salvagedFromTranscript` | `workflow_salvage` recovered an orphaned read-only lane from child transcript evidence. Treat as weaker than normal capture. |
| `[REDACTED:secret]` | A credential-like value was detected and replaced. The value existed but is intentionally unavailable. |
| `[truncated N chars]` | Content was captured but bounded. The omitted portion existed and was not silently dropped. |

## Cache Provenance

Use event types to distinguish cache paths:

- `cache.hit`: a normal journal replay; the lane was not re-run and its
  projection is not rewritten.
- `cache.signature_hit`: a compatible prior callId was reused through a matching
  lane signature.
- `cache.checkpoint_hit`: a same-run controller checkpoint supplied the result
  after a crash window.
- `cache.salvaged_hit`: a prior transcript-salvaged result replayed. This is
  weaker provenance than normal controller capture.
- `cache.miss` / `cache.invalidated`: the lane did not replay and had to run
  again.

The important trap: plain `cache.hit` is visible in `events.jsonl` through
`workflow_events`; it does not rewrite `lanes/<callId>.json`. Do not conclude a
lane re-ran merely because the projection timestamp did not change on resume.

## Worked Example

For a completed run:

```js
const status = JSON.parse(await workflow_status({
  runId,
  format: "json",
  detail: "full"
}))

const retries = status.laneRecords.filter((lane) => lane.correctiveAttempts > 0)
const failed = status.laneRecords.filter((lane) => lane.outcome !== "success")
const slowestQueued = [...status.laneRecords]
  .filter((lane) => Number.isFinite(lane.queueWaitMs))
  .sort((a, b) => b.queueWaitMs - a.queueWaitMs)[0]

const cacheEvents = JSON.parse(await workflow_events({
  runId,
  format: "json",
  typePrefix: "cache.",
  order: "oldest",
  limit: 100
}))
```

Answer the core audit questions from those objects:

- Corrective retries: `retries.map(lane => [lane.callId, lane.correctiveAttempts])`
- Cache-served lanes: `cacheEvents.events.filter(e => e.type === "cache.hit" || e.type === "cache.signature_hit")`
- Failed child sessions: `failed.map(lane => [lane.callId, lane.childID, lane.failureClass])`
- Wall-clock friction: `slowestQueued?.queueWaitMs ?? null` (null when no lane
  had a finite `queueWaitMs`, e.g. an empty or non-queued run),
  `status.operatorMetrics.timeToFirstResultMs`, and
  `status.operatorMetrics.approvalWaitMs`

This playbook was checked against the current run-state schema, the
`run-auditability` fixture suite, and the checkout's existing run roots with
`node scripts/analyze-runs.mjs --format json` on 2026-07-07. The fixture suite covers
event pagination, corrupt trailing JSONL lines, debug-capture artifacts, queue
wait, approval wait, and notification latency.
