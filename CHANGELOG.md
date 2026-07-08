# Changelog

All notable changes to this project will be documented in this file.

This project follows the spirit of [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and uses semantic versioning for published package releases.

## [Unreleased]

### Changed
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
