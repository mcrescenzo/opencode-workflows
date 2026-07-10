import test from "node:test";
import assert from "node:assert/strict";

import { renderWorkflowTerminalCard, workflowToastCardSnapshot } from "../workflow-kernel/notification-toast-cards.js";

// Terminal toast-card phase-breadcrumb regressions split out of the historical
// bughunt-error-state catch-all (opencode-workflows-fnop.9). Covers the null-empty-7 finding:
// phaseBreadcrumb() mislabeled a run whose current phase name is absent from meta.phases by
// substituting `phases.length - 1` (the last declared phase) for the "not found" index, instead
// of falling back to the bare phase name.

test("terminal card falls back to the bare phase name when the current phase isn't in meta.phases", () => {
  const run = {
    id: "wf_phase_drift",
    meta: { name: "fixture-phase-drift", phases: ["scan", "verify", "fix"] },
    // "cleanup" was never declared in meta.phases (typo, ad-hoc phase(), or capitalization
    // drift) -- phaseSnapshot() resolves this to index: undefined.
    currentPhase: "cleanup",
    status: "failed",
    startedAt: "2026-07-07T12:00:00Z",
    finishedAt: "2026-07-07T12:01:00Z",
  };
  const snapshot = workflowToastCardSnapshot(run, { now: Date.parse("2026-07-07T12:01:00Z") });
  assert.equal(snapshot.phase.index, undefined);

  const card = renderWorkflowTerminalCard(snapshot);
  const firstLine = card.message.split("\n")[0];
  // Must render just the phase name (mirroring the `!phases.length` early-return branch), never
  // guess "current == last declared phase" and mark scan/verify as falsely done.
  assert.equal(firstLine, "▸ cleanup");
});

test("terminal card still renders the normal done/failed breadcrumb when the phase IS declared", () => {
  const run = {
    id: "wf_phase_ok",
    meta: { name: "fixture-phase-ok", phases: ["scan", "verify", "fix"] },
    currentPhase: "verify",
    status: "failed",
    startedAt: "2026-07-07T12:00:00Z",
    finishedAt: "2026-07-07T12:01:00Z",
  };
  const snapshot = workflowToastCardSnapshot(run, { now: Date.parse("2026-07-07T12:01:00Z") });
  assert.equal(snapshot.phase.index, 1);

  const card = renderWorkflowTerminalCard(snapshot);
  const firstLine = card.message.split("\n")[0];
  assert.equal(firstLine, "✓ scan ✗ verify ⧗ fix");
});
