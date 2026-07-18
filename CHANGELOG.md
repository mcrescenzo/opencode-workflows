# Changelog

All notable changes to this project will be documented in this file.

This project follows the spirit of [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and uses semantic versioning for published package releases.

## [Unreleased]

### Added
- Trusted drain-adapter factories now receive a run-bound `stageDomainMutation`
  capability so `close` and `createFollowup` can durably stage domain intent for
  finalization only after the verified primary-tree apply.

### Changed
- Removed obsolete probe-era helpers, a superseded toast-formatting island, dead
  test scaffolding, and redundant kernel facades while preserving the owning
  module exports through the kernel barrel.
- Agent-facing workflow guidance now opts into `background: true`, yields for the
  idle-gated completion prompt, and reserves status polling for explicit
  progress/control or the no-notification fallback.

### Fixed
- Resuming without an explicit args override now restores the approved runtime
  args, model tiers, and guest deadline from durable state instead of silently
  replanning with a null args payload or current defaults.
- Current-facing docs now describe the bundled `deep-research` workflow/command,
  text-only schema validation, package contents, and historical plans accurately.

## [0.4.0] - 2026-07-09

### Added
- **`meta.recommendBackground`** — a workflow may declare `recommendBackground: true`
  to ask the kernel to default its runs to background; an explicit `background: true` /
  `background: false` on the `workflow_run` call still wins.
- **Sticky cost-tracking warning.** When a lane reports tokens with `cost: 0`, the run is
  flagged cost-unreliable (persisted + rehydrated on resume) and surfaces as a preview
  "Cost-ceiling caveat:" line (when `maxCost` is set), a `costTrackingWarning` string in
  `workflow_status` (both compact and full), and a terminal warning line. Warning-only;
  `checkBudgetBeforeLaunch` does not throw.
- **Important-lines-first `workflow_run` output** — both the review-required and terminal
  return paths now lift status/abortReason/summary/stats/artifacts lines, the readback
  command, and trailers ahead of the raw redacted JSON body (now last), so tail-truncated
  clients lose only the JSON dump. Lifted fields read the redacted projection.
- **`argsSummary` in status meta** — a one-line args-shape view derived from `argsSchema`,
  included in the `workflow_status` meta projection.
- **deep-research `fitWarning`** — a first-class envelope field (string | null) carrying
  harness-fit caveats; prefixes the report Caveats when present.
- **`stats.claimsDroppedByCap` + `droppedByCap` artifact** — the verify-cap drop count is
  now an explicit stat, and the cap-dropped claims are spilled into `findings.full.json`
  as a `droppedByCap` array (lossless spill).
- **Optional report `title`** (≤ 80 chars) in `REPORT_SCHEMA`; the report H1 renders the
  title when present, else the question bounded to 80 (77 + ellipsis; byte-identical for
  questions ≤ 80).
- **Fetch-phase `laneCoverage`** — fetch lanes are now tallied in the per-phase coverage.
- **In-guest artifact secret masking** — common secret patterns (AKIA/sk-/ghp_/xox/PEM/
  Bearer) are masked over `report.md`, `findings.full.json`, and `sources.json` before
  persistence.

### Changed
- **deep-research runs default to background** (declared `meta.recommendBackground: true`);
  an explicit `background: false` restores foreground execution.
- **`workflow_status` compact/result meta is now an allowlisted projection**
  (`compactMetaProjection`). Full frontmatter/meta remains on `detail: "full"`; sensitive
  meta keys (`apiKey`/`prompt`/`argsSchema`/`examples`/nested) are dropped (undefined) from
  compact/result, not redacted in place. External consumers reading dropped keys from
  compact must switch to `detail: "full"`.
- **A crashed fetch lane now degrades deep-research run status** (it counts as a dropped
  Fetch lane) instead of being invisible.
- **An explicit `maxSources` is a hard fetch cap.** Presets keep their soft high-relevance
  bypass; a user-supplied `maxSources` overrides the preset and is enforced as a hard
  ceiling with no soft bypass.
- **New abortReason `no-central-claims`** replaces a misdiagnosed `no-claims-extracted` at
  `centralOnly` depths (claims existed but the `centralOnly` filter emptied the verify set).

### Fixed
- centralOnly abort misreporting `claimsExtracted: 0` (now reports an honest
  `claimsExtracted` count with `abortReason: "no-central-claims"`).
- `truncatedFindings` staying `false` when refuted/unverified claim sets overflowed and
  relied on the kernel backstop (now set `true` whenever the floor-5 trim or kernel
  backstop engages).
- verifier default-refuting claims sourced from local files (a directly-read local source
  is no longer default-refuted; the default-refute-on-uncertainty posture applies to
  web-sourced claims).

## [0.3.0] - 2026-07-09

### Added
- **First bundled workflow: `deep-research`** — deep multi-source web research with
  adversarial claim verification (Scope → Search → Fetch → Verify → Synthesize), depth
  presets (`quick`/`normal`/`thorough`), seed-URL fallback, lane-coverage telemetry,
  artifact spill, and an honest failure taxonomy (websearch-unavailable, verifiers-failed,
  synthesis salvage). Ships with the `/deep-research` command (clarify → tier models →
  approve → persist report). This deliberately reverses 0.2.0's zero-bundled stance for
  exactly one flagship exemplar; the bundled tier remains otherwise empty.
- `meta.whenToUse` — an author-owned, one-line discovery hint surfaced by `workflow_list`
  (Claude Code parity), alongside `category`/`examples`/`notes`.
- Approve-by-reference: a `workflow_run` approve call for an inline-source preview may present
  only `approve: true` + `approvalHash`; the previewed source bytes are reused from a bounded
  module-level pending store (cleared on dispose/restart). Eliminates the byte-identical
  re-transmission requirement that made inline approvals oscillate between two hashes.
- Approval mismatches now return `changedFields` (field-level envelope diff vs the supplied
  hash's recorded preview) and an inline re-transmission-drift `hint`.

### Changed
- Plain-string `workflow_run` args that do not look like JSON now pass through to the guest
  verbatim (gated by `meta.argsSchema`); JSON-looking strings still normalize to the object
  they encode, preserving the 0.2.x approval-hash drift fix.
- The live child-system smoke is demoted from a required public-release gate
  to a recommended, opt-in strict check: `release:system-smoke-required`
  keeps its fail-closed behavior, but the automated release workflow gates on
  the token-free suite only, and the docs/scripts now say so consistently.

### Fixed
- Approval envelope (`version` 2 → 3): distinct nested **inline** workflows no longer collapse
  to one snapshot in the hash (they dedup by hash instead of the shared `"<inline>"` path).
- A JSON-string `args` bag is decoded and normalized for every workflow (previously drain-only),
  so string and object emissions of the same payload hash to the same `approvalHash`.
- Normalized JSON-string `args` now propagate to the guest and drain-mode resolution too
  (previously only the approval hash saw the normalized object, so the guest could see a raw
  string while the hash was computed over the parsed form).
- Known one-time effect: runs persisted before this fix with JSON-string args will take a spurious "runtime args changed" cache miss on their first post-upgrade resume (cost-only; lanes re-run, correctness unaffected).

## [0.2.0] - 2026-07-08

### Added
- Child lanes now receive a one-line authority disclosure in their system
  prompt (`laneAuthorityInstruction`), so a lane knows its tool ceiling up
  front instead of discovering it through permission denials.

### Changed
- Tool-surface accuracy and completeness pass (2026-07-08 agent-surface review):
  per-argument schema docs for `workflow_run`, `workflow_save`, and
  `workflow_status`; `workflow_apply` no longer cites a nonexistent
  "workflow_run apply-preview"; `workflow_cleanup` documents its real
  protection set and exposes `interruptedTtlMs`; `workflow_status` drops its
  always-rejected `reconcile` arg; salvage hints point at `workflow_salvage`
  instead of the unshipped `session_read`; toast inspect lines use `runId=`;
  "v2" template jargon renamed to "starter".
- Bundled skills corrected and extended: full injected-globals list
  (`drain`, `persistArtifacts`, `inventoryFiles`), live extension-only
  trusted-source wording, precise sandbox stub semantics, new Meta Fields /
  Authority Profiles / Artifacts-Inventory-Drain reference sections, and the
  fabricated `DEFAULT_CHILD_MODEL` fallback removed from model tiering.
- **BREAKING:** the plugin ships zero bundled workflows and commands. The
  repo-* review suite (eight leaves + the repo-review meta, plus the
  /repo-bughunt and /repo-review commands and the repo-review-command-protocol
  skill) moved to the operator's global workflow registry. The bundled-tier
  discovery mechanism remains for downstream packagers.
- Replaced the LLM-probe live-gate subsystem with a deterministic runtime
  trust model (Design C): a memoized `GET /global/health` server-version
  fingerprint gates elevated (`edit`/`worktreeEdit`/`integration`/`shell`/
  `network`/`mcp`-granting) authority at launch and refuses opencode servers
  older than `1.17.13`; lane rooting and worktree isolation are asserted from
  typed API fields at creation time instead of a behavioral probe; and each
  lane's deny-by-default permission ruleset is sent with the session and
  re-checked against the create echo.
- Schema-bearing lanes are structured-text only: the kernel injects a
  JSON-schema instruction into the prompt and parses the model's JSON text
  back. The native `outputFormat: { type: "json_schema" }` path — never
  production-proven and previously gated behind the probe subsystem — is gone.
- `beads-drain` reports truthful failure status: a failed autonomous drain
  with no applied patch is reported as failed, not completed.

### Removed
- The deprecated beads domain (`workflow-domains/`): beads-drain workflow,
  host drain adapter, review-materialize tool/command, beads-drain skill.
  The trusted-extension mechanism itself is unchanged and now tested against
  synthetic fixtures only.
- The `workflow_live_gates` tool, the `/workflow-live-gates-release-check`
  command, and the `requiredGates` authority vocabulary (profiles, constant,
  preview field, and the drain gate funnel). There is no probe consent flow,
  opt-in release-check step, or `unsafeAcceptUnverifiedPermissions` escape
  hatch any more.

## [0.1.0] - 2026-07-07

### Added

- Initial public package surface for the opencode workflows plugin.
- Durable workflow run store, approval-gated apply flow, bundled repo-review
  workflows, live-gate probes, workflow templates, and extension seams.
