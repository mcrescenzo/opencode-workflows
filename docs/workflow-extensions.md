# Workflow Extensions (Trusted Domain Adapters)

> Status: **implemented** (the generic-harness extraction shipped; the core package
> ships zero bundled domain extensions as of the pure-architecture cut). The core
> plugin is a domain-neutral workflow harness; domain-specific autonomous-drain
> behavior (e.g. a ticket-tracker backlog drain) is supplied by **trusted
> extensions** loaded by explicit config.

## The three trust tiers

`where a file lives` is independent of `how much the kernel trusts it`:

1. **Untrusted guest workflows** — the scripts resolved from project, global, or
   extension `workflows/` directories (the bundled tier remains a resolution
   mechanism for downstream packagers; this repo ships none there). They run
   in a sandboxed QuickJS VM with only injected globals
   (`args`, `agent`, `parallel`, `pipeline`, `phase`, `log`, `budget`, `workflow`,
   `drain`, `persistArtifacts`, `inventoryFiles`). No `fs`, `bd`, `child_process`,
   or `require`. Trust does **not** depend
   on where the file came from — running one confers no host power.
2. **Trusted host extensions** — privileged Node modules loaded **only** from
   explicit config (never auto-discovered). They register the things a guest can't
   be: **drain adapters**, **domain-mutation finalizers**, and auto-apply authority.
3. **The core kernel** (`workflow-kernel/`) — the harness itself; ships no domain
   logic. The only in-tree adapter is `test-fix-drain-adapter.js`, a contract fixture.

Two principles follow:

- **Auto-discovery is safe only for sandboxed artifacts; trusted host code must be
  explicitly configured.** An extension module gets host trust the instant it is
  imported, so it is opt-in via `opencode.json`, never discovered by a dir scan.
- **The extension seam confers trust; it does not distribute files.** Workflow/
  command/skill files are ordinary assets resolved by the existing
  project > global > extension > bundled search; only *capabilities* (adapters +
  finalizers) are registered.

## What a guest can't do, and why `drain()` exists

A workflow script runs sandboxed, so it cannot read/write a domain store (e.g. a
ticket tracker's database) or touch the filesystem. The host-owned `drain()`
primitive is the trust boundary: a guest calls `drain({ adapter: "my-domain", mode })`,
which marshals across to `runHostDrain` in the trusted host. The host creates the registered adapter and
runs the controller loop (discover → claim → orchestrate lanes → validate → stage
mutations → finalize), all in trusted code. The verified-autonomous-drain safety
guarantees (staged → finalized idempotent mutation ledger; gate enforcement;
verified auto-apply) depend on this code being trusted, not guest script logic.

## Writing a drain-adapter extension

An extension is an ES module whose default export is a definition object:

```js
// my-domain-extension.js
import { createMyAdapter, finalizeMyMutation } from "./my-adapter.js";

export default {
  id: "my-domain",
  drainAdapters: {
    "my-domain": {
      // Called by the host with the live run context; build your adapter from it.
      createAdapter: ({ pluginContext, toolContext, run, options }) => ({
        ...createMyAdapter({ /* cwd, actor, scope, signal, ... */ }),
      }),
      supportsAutoApply: true,        // opt into in-run auto-apply (autonomous-local)
      // Informational only: the kernel never reads this field. Finalizers are
      // resolved by the exact operation-name keys in mutationHandlers below.
      mutationOperations: ["my-domain.close", "my-domain.note"],
    },
  },
  // Finalizers run AFTER a verified primary-tree apply, resolved by exact operation name.
  mutationHandlers: {
    "my-domain.close": (payload) => finalizeMyMutation(payload),
    "my-domain.note": (payload) => finalizeMyMutation(payload),
  },
};
```

The adapter instance must implement the drain contract validated by
`drain-runtime.js:validateAdapter()`: `discover`, `classify`, `claim`,
`buildLanePacket`, `validate`, `close`, `createFollowup`, `proveDry` (+ optional
`releaseClaim`). Domain-specific lane prohibitions belong in `buildLanePacket()`
instructions (the core lane prompt is domain-neutral).

## Registering an extension

In `opencode.json`, use the `[path, options]` tuple form for the plugin entry
(verified to forward `options` on opencode 1.17.11+; note the plugin's
elevated-authority server floor is 1.17.13, so in practice run opencode
≥ 1.17.13). Extension paths resolve
relative to the **opencode config dir** (where `opencode.json` lives), so the same
entry works on any machine:

```json
{
  "plugin": [
    ["@mcrescenzo/opencode-workflows", {
      "extensions": ["./workflow-extensions/my-domain/my-domain-extension.js"]
    }]
  ]
}
```

Restart opencode after editing config. A missing/unloadable configured extension
fails loud at startup; with no extension configured the core behaves identically
(the seam is dormant).

## Authoring a thin drain workflow

The workflow script stays thin — it configures the harness, it does not reimplement
domain control:

```js
export const meta = {
  name: "my-domain-drain",
  harness: "drain",          // the trigger: generic drain mode/profile/background/auto-apply
  adapter: "my-domain",
  profile: "drain-autonomous-local",  // authority ceiling for display; run authority follows mode
};
const mode = args?.mode ?? "dry-run";
return await drain({ adapter: "my-domain", dryRun: mode === "dry-run", scope: args?.scope ?? {} });
```

Modes: omitted/`dry-run` → read-only `drain-dry-run`; `autonomous-local` →
integration-capable `drain-autonomous-local`. Top-level `profile` and `args.mode`
are reconciled to one canonical form (conflicts reject; the two equivalent forms
produce the same approval hash).

## Contributing assets (workflows / commands / skills)

An extension can ship its own thin guest workflows, command markdown, and skills via
`assetDirs` (paths relative to the extension module's dir). They merge into the kernel's
existing resolution search — the seam confers trust on host capabilities, it does not
copy files into the core package.

```js
export default {
  id: "my-domain",
  // ...drainAdapters / mutationHandlers...
  assetDirs: { workflows: "./workflows", commands: "./commands", skills: "./skills" },
};
```

Resolution order is **project > global > extension > bundled** for workflow files
(`workflow_run` by name, `workflow_list` shows `scope: "extension"`, trusted-path and
nested-snapshot resolution all honor this order). Command registration is the one
deliberate inversion — **bundled > extension**: bundled commands register first and an
extension may only contribute NET-NEW command names (it can never shadow a bundled
command). Skill dirs are appended to `cfg.skills.paths`.

An extension-resident workflow IS a trusted auto-apply origin (see Security model); a
same-named project/global shadow that wins resolution is still denied auto-apply because
trust is a separate predicate on the resolved path, not derived from resolution order.

## Contributing plugin tools

opencode's `Hooks.tool` is a static map built when the plugin factory returns, so the
plugin loads configured extensions in the factory body (before building that map). An
extension contributes tools via a `tools` field — either a plain `{ name: ToolDefinition }`
map or a `(toolKit) => map` factory:

```js
export default {
  id: "my-domain",
  tools: (toolKit) => ({
    my_tool: toolKit.tool({
      description: "...",
      args: { repo: toolKit.schema.string() },
      async execute(args, context) {
        toolKit.assertWriteWorkflowAllowed(context, "my_tool");
        // ...
      },
    }),
  }),
};
```

`toolKit` injects the kernel's single `tool` + `schema` (one zod instance — no
`@opencode-ai/plugin` dependency in the extension), `pluginContext`, and
`assertWriteWorkflowAllowed`. Tool names are fail-closed: an extension may not reuse a
core tool name or a name another extension already contributed.
`tests/extension-tool-contribution.test.mjs` exercises this contract end-to-end
against a synthetic `ext_probe` tool (factory form) and a `plain_tool` (plain-object
form).

## Security model

- Workflow source is untrusted and approval-bound; extension modules are trusted
  host code, loaded only from explicit config.
- Child lanes never get domain-mutation authority; the controller owns all domain
  writes.
- Non-dry drains launch through the same deterministic checks as any other
  elevated run: the server-fingerprint version floor, and per-lane
  rooting/permission-echo assertions — there is no separate adapter-declared
  gate list.
- Auto-apply (in-run primary-tree write + domain finalization, no second approval)
  requires: `harness === "drain"`, autonomous-local authority (read from persisted
  state — resume-safe), a **trusted source** (core-bundled or extension-registered,
  not a project/global shadow), and `supportsAutoApply: true`.
- Domain mutations are staged and finalized only after a successful primary apply,
  through a durable idempotent ledger.

## The in-tree reference example

The core package ships zero bundled domain extensions; there is no
`workflow-domains/` directory in this repo. Instead, this repository's own test
suite is the reference example for the seam described above:

- `tests/fixtures/drain-extension/extension.js` is a minimal extension
  (`{ id: "fixture-drain-ext", assetDirs: { workflows: "./workflows" } }`) whose
  `assetDirs.workflows` contributes
  `tests/fixtures/drain-extension/workflows/fixture-drain.js`, a thin
  `harness: "drain"` workflow exercised end-to-end (including auto-apply) in
  `tests/workflow-run.test.mjs`.
- `tests/extension-wiring.test.mjs`, `tests/extension-registry.test.mjs`, and
  `tests/extension-auto-apply-trust.test.mjs` register synthetic extension
  definitions (`id`, `drainAdapters`, `mutationHandlers`) directly against
  `WorkflowPlugin` / `createExtensionRegistry`, covering the same contract the
  `my-domain` examples above describe.
- `tests/extension-tool-contribution.test.mjs` exercises the `tools(toolKit)`
  factory form and the plain-object form end-to-end.

This scaffolding is domain-neutral test fixture code, not a bundled domain
extension — it proves the seam works without shipping any domain logic. A real
extension for your own domain follows the same shape (`id`, `assetDirs`,
`drainAdapters`, `mutationHandlers`, and/or `tools`) and loads the same way, via
the explicit `extensions` config shown above.
