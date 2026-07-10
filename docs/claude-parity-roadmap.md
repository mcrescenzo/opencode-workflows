# Claude Code Parity Roadmap

> Status: **roadmap / planning**. Except where a bullet is explicitly marked
> **[shipped]**, items below are proposed and not the current implementation contract.

Strategic direction for bringing the `opencode-workflows` plugin closer to Claude
Code's extensibility model (hooks, custom subagents, durable background agents,
settings/rules/skills scope), **without** cloning features that OpenCode already
provides or that this plugin does not need.

This is a roadmap, not a changelog. Except where a bullet is explicitly marked
**[shipped]** under "Shipped today", every item below is **proposed and not yet
implemented**.

## Shipped Today (Grounded In Current Code)

Statements here are backed by the plugin's actual behavior, not aspiration.

- **In-process background workflows** **[shipped]**: `workflow_run({ background: true })`
  returns immediately and continues in the current OpenCode process. The kernel
  records the owning process pid + start time (`run-store-fs.js`:
  `processAppearsAlive`, `selfProcessStartTime`) and detects cross-process
  staleness. There is **no detached supervisor, no respawn, and no attach**;
  background runs die with the owning process (`docs/workflow-plugin.md`,
  "Background execution is not durable across process death").
- **Child-session lanes** **[shipped]**: implementation lanes run as OpenCode child
  sessions via the server API (`child-agent-runner.js`: `runChildAgent`, slot
  accounting; `sandbox-executor.js`: `runNestedWorkflow`). These reuse OpenCode's **native agent
  registry**; the plugin has **no custom-subagent registry of its own**.
- **Deterministic runtime trust model** **[shipped]**: there is no LLM-probe
  live-gate subsystem. Elevated (`edit`/`worktreeEdit`/`integration`/
  `shell`/`network`/`mcp`-granting) authority is checked once per server via a memoized
  `GET /global/health` fingerprint that refuses servers below opencode
  `1.17.13`; lane rooting and worktree isolation are asserted from typed API
  fields at creation time; and each lane's deny-by-default permission ruleset
  is sent with the session and re-checked against the create echo (README
  "Safety & privacy"; deep contract in `docs/workflow-plugin.md`).
- **Hash-gated apply boundary** **[shipped]**: `workflow_apply` is the only
  primary-tree write path, gated by approved source hash, base commit, diff-plan
  hash, domain-mutation hash, and clean primary dirty state.
- **Durable lifecycle + recovery** **[shipped]**: cancel/pause write durable
  request files; `workflow_reconcile` recovers stale runs/locks; cleanup
  preserves active/locked/ambiguous/apply-running runs.
- **Config-time skill + command registration** **[shipped]**: the plugin config
  hook pushes this directory's `skills/` into `cfg.skills.paths` and scans a
  bundled `commands/` directory to auto-register any command file found there
  (`configureWorkflowEntrypoints`, `workflow-plugin.js`). The package ships the
  bundled `/deep-research` command; configured extensions may contribute
  additional, non-shadowing command names through the same registration seam.
- **Reliance on OpenCode's native config model** **[shipped]**: the plugin does
  not manage rules, permissions, or agent scope itself; it inherits OpenCode's
  global/project scope and permission system.

## Parity Bands

Priority uses MUST / SHOULD / LATER. Each item states the Claude Code capability,
the gap in this plugin, and a proposed shape.

### MUST — Material Parity Gaps

- **Lane-level hook contract.** Claude Code exposes a broad lifecycle
  (`PreToolUse`, `PostToolUse`, `UserPromptSubmit`, `Stop`, `SubagentStart`,
  `SubagentStop`, `PreCompact`, etc.) with matchers and multiple handler types
  (command/http/mcp_tool/prompt/agent). OpenCode's plugin layer already provides
  `tool.execute.before`/`tool.execute.after`, `event` subscriptions
  (`session.idle`, `file.edited`, `permission.asked`, ...), and
  `experimental.session.compacting`. The gap is that **this plugin does not
  expose any hook surface to its workflow lanes** — lanes are opaque prompt
  dispatches. Propose: a minimal lane lifecycle hook set (pre-lane, post-lane,
  on-failure) wired through the existing OpenCode plugin hook primitives, so a
  workflow author can run a command or handler when a lane starts/stops/fails
  without recompiling the kernel.
- **Truthful "not implemented" labeling on background durability.** Claude Code
  CLI/SDK background agents support resume/continuation across invocations. This
  plugin's background is explicitly in-process and dies with the owner. This is
  documented here and in the README, but any future claim of "durable background"
  must not be made until a supervisor exists (see SHOULD).

### SHOULD — High-Value But Not Blocking

- **Durable background supervisor (attach / logs / respawn).** Today, when the
  owning OpenCode process exits, an active background run is detected as stale by
  the next process and surfaced for `workflow_reconcile`; it is **not** resumed
  automatically. Proposed: an optional detached supervisor process (or
  server-attached lifecycle) that owns long-running drains, persists a log
  stream, allows `attach` from a later session, and can respawn a failed lane
  within budget. Must preserve the existing fail-closed model — a supervisor
  must never bypass `workflow_apply` hash gates or the deterministic
  launch-time checks (server-fingerprint version floor, permission/rooting
  assertions).
- **Plugin-local custom-subagent registry.** Claude Code subagents are defined as
  markdown files with frontmatter (model, tools, description) and surface via
  `SubagentStart`/`SubagentStop`. This plugin currently dispatches every lane
  through OpenCode's native agent registry with lane-specific prompts. Proposed:
  an optional registry (e.g. `agents/*.md` or a kernel map) that lets a workflow
  name a typed subagent (model + tool subset + system prompt) per lane, while
  still running through the existing child-session runner. This is a convenience
  layer over native agents, not a replacement for them.

### LATER — Speculative / Low-Pressure

- **Named lifecycle hook breadth.** Mirror more of Claude Code's named events
  (`SessionStart`, `SessionEnd`, `Notification`, `FileChanged`) as first-class
  workflow hook points only if a concrete workflow needs them. Do not build the
  full event catalog speculatively.
- **Managed/policy settings tier.** Claude Code supports an admin-controlled
  managed-settings tier for hooks. OpenCode has its own permission/policy model;
  revisit only if enterprise distribution of this plugin becomes a real
  requirement.
- **Agent-teams / teammate model.** Claude Code's agent-teams and `TeammateIdle`
  imply peer agents. This plugin's model is controller-owned lanes, which is a
  different topology; do not adopt peer semantics unless a workflow genuinely
  needs peer coordination.

## Not Needed / Do Not Clone

- **Do not reimplement OpenCode's plugin hook primitives.** `tool.execute.*`,
  `event`, `shell.env`, custom `tool`, and `experimental.session.compacting`
  already exist at the OpenCode layer (see OpenCode Plugins docs). The plugin
  should compose them, not duplicate them.
- **Do not clone Claude Code's settings.json file hierarchy verbatim.** OpenCode
  already has a global/project config scope, `skills.paths`, commands, rules, and
  permissions. Parity means interop with OpenCode's scope model, not a parallel
  `.claude/settings.json`-style file.
- **Do not replicate Claude Code's matcher DSL (`if:` permission-rule syntax)
  inside this plugin.** OpenCode has its own permission rule system; a lane-hook
  contract should reuse it rather than inventing a second matcher language.
- **No `--resume`-style CLI reentry into this plugin.** Background durability
  should be solved by a supervisor bound to the OpenCode server, not by a
  separate CLI surface that competes with `opencode serve` / the TUI.
- **No broad "feature-parity" import of Claude events that no workflow uses.**
  Each hook point must be justified by a real workflow need; speculative event
  coverage is explicitly out of scope.

## Implementation Status

None of the roadmap items (hook contract, durable supervisor, custom-subagent
registry, expanded lifecycle hooks) are implemented. Only the capabilities listed
under "Shipped Today" above are currently available. This document is planning
material and must not be cited as evidence that any proposed feature exists.

## References

- OpenCode Plugins (hook primitives, events, custom tools):
  https://opencode.ai/docs/plugins/
- OpenCode Server (sessions, prompt_async, agents, events): https://opencode.ai/docs/server/
- OpenCode Agents: https://opencode.ai/docs/agents/
- Claude Code Hooks reference (lifecycle events, matchers, handler types):
  https://docs.claude.com/en/docs/claude-code/hooks
