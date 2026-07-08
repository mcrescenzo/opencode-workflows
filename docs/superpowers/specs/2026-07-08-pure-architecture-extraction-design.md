# Pure-Architecture Extraction — Design

> Status: Approved design (2026-07-08). Implemented on branch `pure-architecture-extraction`.

**Date:** 2026-07-08
**Status:** Approved
**Decision:** The plugin ships zero pre-built workflows, zero commands, and zero
domain logic. It becomes pure workflow architecture (kernel + generic skills).
The repo-* review suite moves to the user's global workflow registry; the beads
domain is deprecated and deleted.

## Approved decisions

1. **Destination for the nine repo-* workflows:** `/home/hermes/code/opencode-config/workflows/`
   — the directory the kernel already resolves as `GLOBAL_WORKFLOW_DIR` on this
   machine (legacy-monorepo branch of `resolveGlobalWorkflowDir`). Zero kernel
   changes needed for resolution; `workflow_run({name})` finds them at the
   `global` tier (project > global > extension > bundled).
2. **The two slash commands** (`/repo-bughunt`, `/repo-review`) move to
   `/home/hermes/code/opencode-config/commands/`, alongside the existing
   config-root commands (`init-project.md`, etc.). The
   `repo-review-command-protocol` skill they reference moves to
   `/home/hermes/code/opencode-config/skills/`.
3. **Beads domain deprecated and deleted** — `workflow-domains/` is removed
   entirely (beads-drain workflow, host adapters, `/review-materialize`,
   `beads-drain` skill, crosswalk doc). The beads workflows are unused. The
   extension *mechanism* (`extension-registry.js`, generic `drain-runtime.js`)
   stays: it is architecture. The explicit extension wiring at
   `opencode-config/opencode.json` (plugin `extensions` option pointing at
   `beads-extension.js`) is removed; the plugin entry collapses to a plain
   string.
4. **Suite tests and docs are deleted, not moved** — the 30 suite test files,
   `tests/helpers/repo-review-leaf-harness.mjs`, and the three suite docs
   (`docs/repo-review.md`, `docs/repo-review-leaf-contract.md`,
   `docs/repo-review-parity-matrix.md`). The workflows become personal tools
   validated by use; git history is the archive.
5. **Sequencing:** single branch in the plugin repo, ordered commits, every
   commit leaves both repos working. The repos are separate nested git repos
   (opencode-config and plugins/opencode-workflows each have their own `.git`);
   config-repo changes are committed in the config repo in lockstep steps.

## End state

**Plugin repo** (`plugins/opencode-workflows`) ships: `opencode-workflows.js`,
`workflow-kernel/`, three generic skills (`opencode-workflow-authoring`,
`workflow-model-tiering`, `workflow-plan-review`), kernel docs, community
files. `workflows/` and `commands/` directories are deleted and removed from
`package.json` `files[]`. The bundled-tier mechanism (`BUNDLED_WORKFLOW_DIR`,
`BUNDLED_COMMAND_DIR`, `registerCommandsFromDir`) remains and must tolerate
the directories' absence.

**Config repo** (`opencode-config`) gains: nine `workflows/repo-*.js`
(content unchanged — nested `workflow("repo-*")` calls resolve at the global
tier), two `commands/*.md` (edited: materialization-offer /
`review-materialize` references stripped, since beads no longer exists), and
`skills/repo-review-command-protocol/`.

## Work inventory

### Moves (plugin → config repo)

| From | To | In-flight edit |
|---|---|---|
| `workflows/*.js` (9 files) | `workflows/` | none |
| `commands/repo-review.md` | `commands/` | strip §4 materialization offer + `review-materialize` refs; drop bundled-registration phrasing if any |
| `commands/repo-bughunt.md` | `commands/` | same treatment (check for materialization/offer language) |
| `skills/repo-review-command-protocol/` | `skills/` | none |

### Deletions (plugin repo)

- `workflow-domains/` (entire tree).
- Beads/materialize tests: `beads-bd-util`, `beads-drain-adapter`,
  `beads-drain-assets`, `beads-drain-scratch`, `beads-drain-workflow`,
  `review-materialize-adapter`, `review-materialize-command-assets`
  (`.test.mjs` each).
- 30 suite test files (`repo-*.test.mjs`, all `repo-review-*.test.mjs`) +
  `tests/helpers/repo-review-leaf-harness.mjs`.
- Suite docs: `docs/repo-review.md`, `docs/repo-review-leaf-contract.md`,
  `docs/repo-review-parity-matrix.md`; beads doc:
  `docs/beads-tool-asset-externalization-plan.md`.
- npm scripts: `test:beads-drain` and the 19 `test:repo-*` scripts;
  `test:workflows` composite trimmed to its three generic files
  (`workflow-run`, `workflow-apply`, `model-tiering`); audit
  `test:workflow-adapters` / `test:extension-seam` for beads references.
- README sections: **Repo Review Suite**, **Beads Drain**; Documentation Map
  rows for the deleted docs; the bundled-commands sentence in **Command And
  Skill Registration**; beads examples in **Extension Trust Boundary**
  replaced with generic wording (mechanism stays documented).

### Surgical edits (plugin repo)

- `tests/workflow-run.test.mjs` — two `ux.1` tests hardcoding the ten-name
  bundled+extension list; rewrite fixture-based (empty bundled tier or
  fixture workflows).
- `tests/workflow-docs.test.mjs` — drop the two command-file entries.
- `tests/publish-completeness.test.mjs` — rewrite in mirror-image: assert the
  tarball ships **no** `workflows/`, **no** `commands/`, no
  `workflow-domains/`; keep community-file floor checks. (Existing
  beads-exclusion assertions are the template.)
- `tests/fake-credential-scanner-safety.test.mjs` — remove deleted files from
  `SCAN_TARGETS`.
- `tests/extension-command-skill-registration.test.mjs`,
  `tests/extension-tool-contribution.test.mjs`,
  `tests/test-fix-drain-adapter.test.mjs` — rewire onto synthetic fixtures.
  `tests/helpers/` already has `fake-extension.mjs`, `fake-drain-adapter.mjs`,
  `mock-bd.mjs`; extend rather than invent.
- `workflow-kernel/test-fix-drain-adapter.js` — a test fixture shipping inside
  the published kernel; relocate to `tests/fixtures/` (or `tests/helpers/`)
  and update imports (`workflow-kernel/index.js` barrel included, if it
  re-exports it).
- Generic skills `workflow-model-tiering`, `workflow-plan-review` — swap
  `repo-bughunt` examples for neutral ones.
- `notification-toast*.test.mjs` — cosmetic fixture-string rename (optional,
  do for hygiene).
- `workflow-kernel/audited-shell-policy.js` — comment-only trim (module is
  generic).
- `package.json` — description reworded to architecture-only; `files[]` drops
  `workflows/` and `commands/`; scripts per above.
- `AGENTS.md` line 17 (`test:workflows` description) trimmed.
- `CHANGELOG.md` — new entry documenting the extraction; historical entries
  untouched.
- Kernel keeps: `INVENTORY_ALWAYS_EXCLUDE`'s `.repo-review` entry and
  `.gitignore`'s `.repo-review/` (the relocated commands still write
  `.repo-review/runs/` in target repos).

### Config repo edits

- `opencode.json` — plugin entry `["./plugins/opencode-workflows/opencode-workflows.js", {"extensions": [...]}]`
  collapses to the plain string; beads extension path removed. Must land
  before or with the `workflow-domains/` deletion (opencode load fails on a
  dangling extension path).

## Verification

1. Plugin: full `node --test tests/*.test.mjs` green; `npm run
   release:no-token`; `npm pack --dry-run` lists a kernel-only tarball.
2. Grep sweep: no functional `repo-*`/`beads` references remain in the plugin
   (historical CHANGELOG/docs and swapped examples excepted).
3. Live: restart opencode → `workflow_list` shows the nine workflows at scope
   `global`; `/repo-review` and `/repo-bughunt` registered from config-root
   `commands/`; zero-token `workflow_run` launch preview of `repo-bughunt`
   confirms source resolution + `read-only-review` authority profile.
4. Kernel tolerates missing `workflows/`/`commands/` dirs (add a small test if
   none exists).

## Risks

- A kernel test not yet opened may assume a non-empty bundled tier —
  mitigation: same synthetic-fixture pattern; low blast radius.
- Cross-repo move loses `git log --follow` continuity — accepted; the spec and
  CHANGELOG entry record provenance.

## Follow-ups (out of scope)

- Update saved memories: the harness-extraction memory ("repo-* product,
  beads → external extension") is superseded on both counts.
- Triage pre-OSS epic 5uqd: several beads/ext-trust items are likely mooted by
  the beads deletion (triage, do not auto-close).
