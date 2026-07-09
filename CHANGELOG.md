# Changelog

All notable changes to this project will be documented in this file.

This project follows the spirit of [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and uses semantic versioning for published package releases.

## [Unreleased]

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
