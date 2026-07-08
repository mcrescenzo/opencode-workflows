# Contributing to opencode-workflows

This is an independently publishable opencode plugin package
(`@mcrescenzo/opencode-workflows`) that can also be developed inside a private
parent monorepo checkout. Runtime package dependencies are declared in
`package.json`; parent-tree integrations are optional test/dev conveniences.
These notes are for contributors running the no-token test matrix and preparing a
public release.

## Prerequisites

The full no-token test matrix needs the following tools on `PATH`:

| Tool | Required for | Notes |
| --- | --- | --- |
| **Node ≥ 20.11** | everything | See `engines` in `package.json`. The test runner is Node's built-in `node --test`. |
| **`git`** | worktree / apply / integration tests | Several suites shell out to `git` to create temporary repos and exercise the worktree + `workflow_apply` paths. |
| **`opencode` binary + local config** | the live child system smoke ONLY | The required system smoke (`npm run release:system-smoke-required`) needs the opencode binary and local opencode config and is intentionally NOT part of the token-free `npm test` / `release:no-token` matrix. |

If a tool is missing, the affected suites fail with a clear message rather than silently
passing — do not treat a skipped/missing-tool run as release evidence.

## Package manager and lockfile policy

- The **canonical lockfile is `bun.lock`** (tracked). Use `bun install` to reproduce the
  locked dependency set.
- All package scripts are invoked with **`npm run <script>`** and are thin `node` wrappers
  (e.g. `node --test tests/*.test.mjs`, `node scripts/...`). They contain no npm-specific
  behavior, so they run identically whether you installed with Bun or npm.
- `package-lock.json` is **gitignored** (see `.gitignore`): npm-using contributors may
  generate one locally, but it is not tracked to avoid maintaining two divergent lockfiles.
  `bun.lock` remains the single source of truth for the locked dependency set.
- CI uses the same policy: `.github/workflows/ci.yml` installs dependencies with
  `bun install --frozen-lockfile`, verifies the prerequisite tool versions, and then
  runs `npm run release:no-token`.

## Running the tests

From this directory:

```sh
npm test                       # full no-token matrix (all suites)
npm run test:workflows         # workflow_run / workflow_apply / repo-* regression
npm run test:workflow-adapters # drain adapter focused suites
npm run test:extension-seam    # extension registration and trusted asset seams
npm run release:no-token       # complete public no-token release gate
```

`npm test`, `npm run test:workflows`, and `npm run release:no-token` are all runnable from
a standalone clone (they do not depend on a private parent monorepo tree). The
optional parent-integration regression lives in a separate, clearly named script:

```sh
npm run test:parent-integration   # OPTIONAL: only runs inside a private parent monorepo tree
```

## Public release readiness

A public release must not equate "skipped" with "verified":

- The public CI workflow (`.github/workflows/ci.yml`) runs on pull requests, pushes to
  `main`, and manual dispatch. It installs Node 22 and Bun, verifies the prerequisite
  tool versions, then runs the no-token release gate.
- `npm run release:no-token` runs lockfile sync, the full token-free `npm test` matrix,
  and package dry-run validation, then explicitly notes that the live child system smoke is
  a **separate required** step.
- `npm run release:system-smoke-required` **fails closed** (non-zero exit) when live
  system-smoke evidence is missing — see `docs/plugin-system-tests.md` for the mandatory
  evidence checklist (child ID/PID/port, trust mode, command + tool registry entries,
  deterministic workflow tool execution, restart/reload, and cleanup `processAlive: false`).

## Style and boundaries

- Pure Node ESM, no new runtime dependencies without review.
- Do not commit local runtime state: `.opencode/`, `.beads/` Dolt DB / sockets / locks /
  credential key, `.remember/`, `node_modules/`, logs, or workflow run dirs.
- After changing plugin code (`opencode-workflows.js`, `workflow-kernel/`, bundled commands,
  skills, or registration), restart opencode (or use a fresh/restarted disposable child) —
  running sessions keep already-loaded config.

## Pull request expectations

- Add or update tests alongside any behavior change, and make sure `npm test`
  (the full no-token matrix) passes before opening a pull request.
- Keep `README.md`, `AGENTS.md`, and the relevant `docs/` file in sync with any
  behavior or configuration change.
- Preserve the kernel invariants in `AGENTS.md` (single plugin export, in-place
  `hooks`/`output.parts` mutation, module-level shared state, bounded maps,
  model IDs from config) — see `AGENTS.md` for the full list.
- Run `npm run test:lockfile-sync` if you changed `package.json` dependencies,
  and keep `bun.lock` (the canonical lockfile) up to date.
