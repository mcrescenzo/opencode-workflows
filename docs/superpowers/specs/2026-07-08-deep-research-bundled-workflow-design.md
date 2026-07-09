# Deep-Research Bundled Workflow — Design

> Status: Approved design (2026-07-08) — implementation planned in
> `docs/superpowers/plans/2026-07-08-deep-research-bundled-workflow.md`.

**Date:** 2026-07-08
**Status:** Approved (Michael, 2026-07-08) — all recommendations accepted
**Scope:** First bundled workflow for `@mcrescenzo/opencode-workflows`: a faithful port of Claude Code's bundled `deep-research` workflow, hardened to house gold-standard conventions, plus a bundled `/deep-research` command and one small kernel enhancement (`meta.whenToUse`).

---

## 1. Context and goals

The plugin is a pure workflow engine. As of 0.2.0 it deliberately ships **zero bundled
workflows and zero bundled commands** (`package.json:3-4` description; enforced by
`tests/publish-completeness.test.mjs:113`), while keeping the bundled discovery tier fully
wired: `workflow_run`'s `name` resolution searches project → global → extension →
**bundled** (`BUNDLED_WORKFLOW_DIR = <plugin-root>/workflows`, `workflow-kernel/constants.js:44-46`;
resolution order in `workflow-kernel/workflow-source.js:333-367`), and the config hook
auto-registers any `commands/*.md` via `registerCommandsFromDir(cfg, BUNDLED_COMMAND_DIR)`
(`workflow-kernel/workflow-plugin.js:296-324`).

**Goal:** ship one flagship, gold-standard workflow that doubles as living documentation of
the engine — reversing the zero-bundled stance deliberately and visibly (README/CHANGELOG
reframe), not accidentally.

**Why deep-research:** it is domain-free (does not compete with the repo-* suite that moved
to the operator's global registry at 0.2.0, `CHANGELOG.md:51-55`), works in any directory,
and exercises the engine's distinctive surfaces end to end: the network-authority approval
handshake, model tiering, structured output with corrective retries, salvageable read-only
lanes, artifacts spill, toast phases, and resume.

## 2. Decisions (all approved)

| # | Decision | Choice |
|---|---|---|
| D1 | Shipping mechanism | **Bundled tier** — `workflows/deep-research.js` in the plugin package |
| D2 | Deliverable scope | **Workflow + bundled command** (`commands/deep-research.md`) |
| D3 | Port approach | **Faithful port + house hardening** (architecture identical to the Claude Code original; house machinery layered on) |
| D4 | Default depth | `thorough` — CC-faithful 3-vote verification is the default; `normal`/`quick` are cheaper opt-downs |
| D5 | `URL` gap | **Workflow-local** pure-string `normURL` (no kernel `URL` polyfill; revisit only if web workflows multiply) |
| D6 | Kernel change | **Add `meta.whenToUse`** as a cosmetic meta field surfaced by `workflow_list` (CC discovery parity) |
| D7 | Lane least-privilege | Scope and Synthesize lanes set `readOnly: true` to narrow below the run's network authority |
| D8 | Report persistence | Command persists exactly one report to `.deep-research/runs/<run-id>-report.md` (guest cannot write files) |
| D9 | Version | Bump to **0.3.0** with stance-reframe CHANGELOG entry |
| D10 | Release gate | Live end-to-end smoke test of `/deep-research` before publishing (§10) |
| D11 | Kernel change #2 | **Plain-string args passthrough**: `workflow_run` string args that do not look like JSON (`{`/`[` prefix) pass through to the guest verbatim instead of throwing at plan time; JSON-looking strings still normalize to the object they encode (hash-drift fix preserved). Required for the CC-faithful `args: "<question>"` form; `meta.argsSchema` remains the per-workflow gate. |

### Deviation from the presented design (surfaced, not silent)

The presented design said "populate `CURATED_INVOCATION_HINTS`". During grounding this
turned out to be dead code for our case: explicit `meta.examples`/`category`/`notes` **win
over** curated hints (`workflow-kernel/role-template-loading.js:488-493` — curated values
are fallbacks only), and the gold-standard workflow declares all of these in its own meta
(that is the point of a gold standard: author-owned metadata). `CURATED_INVOCATION_HINTS`
stays empty; its comment is updated to note that the bundled deep-research workflow
demonstrates the preferred author-owned path.

## 3. Reference architecture (what we are porting)

The Claude Code bundled `deep-research` workflow (extracted from the CC 2.1.205 binary for
reference during design; **not** vendored into this repo — see §9 Provenance):

- **Scope** — 1 agent decomposes the question into ~5 complementary search angles
  (label/query/rationale), with domain-appropriate angle examples in the prompt.
- **Search → Dedup → Fetch (pipeline, no barrier)** — one searcher per angle returns top
  4–6 results ranked by relevance to the *original question*; a pure-JS stage normalizes
  URLs, drops duplicates, enforces a fetch budget (relevance-ranked: when slots run out,
  only `high`-relevance results still fetch), and streams novel URLs into parallel
  fetch+extract lanes that pull the page and extract 2–5 **falsifiable claims**, each with a
  direct supporting quote, an importance rating (central/supporting/tangential), and a
  source-quality rating (primary/secondary/blog/forum/unreliable).
- **Rank + cap (pure JS, deliberate barrier)** — claims ranked by importance ×
  source-quality, capped for verification.
- **Verify** — per-claim adversarial vote panel (3 votes at `thorough`); each voter is
  instructed to REFUTE (checklist: quote overreach, contradicting evidence via web search,
  source-quality vs claim strength, staleness, marketing fluff; default refuted when
  uncertain). **Three outcomes**: `confirmed` (quorum of valid votes, refutations below
  threshold), `refuted` (refutations ≥ threshold), `unverified` (too few valid votes —
  verifier infra errors must never read as refutation).
- **Synthesize** — 1 agent merges semantic duplicates, groups claims into findings with
  per-finding confidence (high/medium/low by source quality + vote unanimity), writes an
  executive summary, caveats, and 2–4 open questions.
- **Salvage paths at every stage**: no scope → explicit error; zero claims → early honest
  return with stats; zero confirmed → distinguish "all refuted on merit" from "verifiers
  failed (infra)" in the summary; synthesis failure → return confirmed claims unmerged.
- **Honest stats** in every return: angles, sources fetched, claims extracted/verified,
  confirmed/killed/unverified, URL dupes, budget-dropped, total agent calls.

Constants at CC parity (= our `thorough`): 5 angles, 15 fetch budget, 25 verify cap,
3 votes/claim, 2 refutations kill.

## 4. The workflow: `workflows/deep-research.js`

### 4.1 Meta

```js
export const meta = {
  name: "deep-research",
  description: "Deep research harness — fan-out web searches, fetch sources, adversarially verify claims, synthesize a cited report.",
  whenToUse: "When the user wants a deep, multi-source, fact-checked research report on any topic. Refine an underspecified question first; pass it as args.question (or args as a plain string).",
  category: "research",
  notes: "Network-authorized read-only research. No shell, no MCP, no edits.",
  examples: [
    { args: { question: "What are the current best practices for passkey rollout in consumer apps?" } },
    { args: { question: "Is fish oil supplementation effective for ADHD?", depth: "quick" } },
  ],
  profile: "read-only-review",
  authority: { readOnly: true, network: true },
  argsSchema: { /* permissive anyOf: object | string | null — see 4.2 */ },
  phases: ["Scope", "Search", "Fetch", "Verify", "Synthesize"],
  maxAgents: 160,
  concurrency: 8,
};
```

- `meta.phases` are **plain strings** (house exemplar: `repo-bughunt.js` declares
  `phases: ["recon", "find", "verify", "synthesize"]`), matching literal `await phase(...)` calls.
- No `childModel`/`modelTiers` in meta — the command supplies `modelTiers` at run time per
  the workflow-model-tiering skill; meta stays environment-neutral.
- Authority = the documented "network-authorized research" tier
  (`docs/workflow-recipes.md:230`): profile `read-only-review` + declared
  `authority: { readOnly: true, network: true }` (merge semantics:
  `workflow-kernel/authority-policy.js:360-399`). No shell, no MCP, no edit/worktree.

### 4.2 Args contract

Accepted forms (defensively re-parsed in the body, house pattern from `repo-bughunt.js`):

1. **Plain string** → the whole string is the question (CC-faithful:
   `workflow_run({ name: "deep-research", args: "why is the sky blue?" })`).
   Requires kernel change D11: today `workflow-plugin.js:1711-1713` JSON-parses every
   string args bag via `parseRuntimeArgsString` (`authority-policy.js:448-462`) and throws
   on non-JSON strings before the guest ever runs.
2. **Object** `{ question, depth?, maxSources?, seedUrls? }`.
3. **JSON string** encoding form 2 (agents sometimes stringify args).

`meta.argsSchema` is a permissive `anyOf` (object with optional-typed fields / string /
null) because the kernel Ajv-validates it **before** the body's defensive parsing runs
(`workflow-kernel/workflow-plugin.js:1652-1679`); the body then enforces the real
requirement (a non-empty question) and returns an explicit error envelope otherwise.

| Arg | Type | Default | Meaning |
|---|---|---|---|
| `question` | string (required after parsing) | — | The research question |
| `depth` | `"quick" \| "normal" \| "thorough"` | `"thorough"` | Preset: see 4.3 |
| `maxSources` | integer 3–30 | preset value | Fetch budget override |
| `seedUrls` | string[] ≤ 10 | `[]` | Known-good sources; fetched ahead of search results, exempt from search availability |

### 4.3 Depth presets

| Preset | Angles | Fetch budget | Verify cap | Votes/claim | Refutes to kill | Verified set |
|---|---|---|---|---|---|---|
| `thorough` (default, CC parity) | 5 | 15 | 25 | 3 | 2 | all ranked claims |
| `normal` | 4 | 10 | 15 | 1 | 1 | all ranked claims |
| `quick` | 3 | 6 | 8 | 1 | 1 | `central`-importance claims only |

Generalized vote rule: `confirmed` requires `validVotes >= refutesRequired && refutedVotes < refutesRequired`;
`refuted` requires `refutedVotes >= refutesRequired`; anything else is `unverified`
(infra-error accounting, identical to CC's three-outcome semantics).

Lane arithmetic at `thorough`: 1 scope + 5 search + ≤15 fetch + ≤75 votes + 1 synthesize
≈ 97 ≤ `maxAgents: 160` (headroom for seedUrls fetches). `concurrency: 8` (kernel default 4
— `workflow-kernel/constants.js:87-96` — would make ~97 lanes crawl; 8 is still conservative
for blocking `session.prompt` calls; the user can retune at approval time).

### 4.4 Model tiering (in-source tier constants, house pattern)

| Lane | Tier constant | Why |
|---|---|---|
| Scope | `deep` | One lane that feeds the entire funnel — wrong angles poison everything downstream |
| Search | `fast` | Mechanical: run a web search, rank results |
| Fetch+Extract | `fast` | Analytical but bounded: fetch page, extract quoted claims |
| Verify | `deep` | Subtle adversarial judgment (quote overreach, source-quality vs claim strength) |
| Synthesize | `deep` | Terminal synthesis; quality compounds into the deliverable |

Tier resolution: `opts.tier` → `run.modelTiers[tier]` → `run.defaultChildModel`
(`workflow-kernel/authority-policy.js:187-204`). Pure-JS stages (dedup, rank, report
rendering) cost zero agent lanes.

### 4.5 Per-lane authority narrowing (D7)

Scope and Synthesize lanes pass `readOnly: true`, which strips network/shell/mcp from
their effective authority (`workflow-kernel/authority-policy.js:578-599` carries run
authority into every lane *unless* the lane sets `readOnly: true`). Search/Fetch/Verify
lanes inherit the run's `network: true` (verifiers need `websearch` for contradicting
evidence). Lanes can only narrow, never escalate (`authority-policy.js:614-629`).

### 4.6 Fan-out shapes (verified against the sandbox)

All fan-out callbacks use **scoped-callback arity** — the kernel rejects zero-param
callbacks (`sandbox-executor.js:875-889`):

- Search→Dedup→Fetch is a `pipeline(angles, searchStage, dedupFetchStage)`. Scoped pipeline
  stages are invoked as `(prev, context, item, itemIndex, stageIndex)` where `context`
  spreads the scoped api (`sandbox-executor.js:947-953`) — the dedup stage is pure JS that
  ends by returning `context.parallel(novelUrls.map(...))`; **nested fan-out inside scoped
  callbacks is natively supported** (`__makeApi` exposes `parallel`/`pipeline`,
  `sandbox-executor.js:836-846`). No barrier between search and fetch (CC-faithful).
- Verify is `parallel(claims.map(claim => async ({ parallel }) => parallel(votes.map(...))))`
  — parallel-of-parallels, hierarchical resume-safe callIds.
- Streaming dedup state (`seen` Map, `fetchSlots`, `dupes`, `budgetDropped`) lives at the
  top level of the body. Known property (same as CC): dedup winners depend on lane
  completion order, so a resume may re-run some fetch lanes as cache misses
  (signature-based replay, `workflow-kernel/event-journal.js:46-61`). Cost-only, never
  correctness.

### 4.7 Failure semantics per lane group

| Lane | On failure | Rationale |
|---|---|---|
| Scope | `onFailure: "returnNull"` → explicit error envelope | CC salvage path ("cannot decompose") |
| Search | fan-out auto-null (`sandbox-executor.js:891-895`) + `filter(Boolean)` | A dead angle degrades coverage, doesn't abort |
| Fetch | `.catch(...)` on the agent promise → `{ sourceQuality: "unreliable", claims: [] }` placeholder | CC-faithful; `.catch` intercepts before the fan-out handler |
| Verify votes | fan-out auto-null; null votes counted as "no vote cast" | Feeds the three-outcome rule |
| Synthesize | `onFailure: "returnNull"` → salvage confirmed claims unmerged | CC salvage path |

`agent()` failures **throw by default** in this kernel; null-on-failure is opt-in via
`onFailure: "returnNull"` (`workflow-kernel/child-agent-runner.js:1306-1318`) — hence the
explicit opt-ins above.

### 4.8 `normURL` (D5 — the one real porting gap)

QuickJS has no `URL` global (prelude installs no Web APIs; `sandbox-executor.js:798-807`).
Pure-string replacement with CC-equivalent behavior: lowercase; strip scheme and leading
`www.`; keep host + path; drop query/fragment; strip trailing slashes. Unit-tested (§7).

### 4.9 Schemas

The five CC schemas port as-is (plain JSON Schema; the shared Ajv is `strict: false`,
`workflow-kernel/structured-output.js:1-97`): `SCOPE_SCHEMA` (question, summary, 3–6
angles with label/query/rationale), `SEARCH_SCHEMA` (≤6 results: url/title/snippet/
relevance enum), `EXTRACT_SCHEMA` (sourceQuality enum, publishDate, ≤5 claims:
claim/quote/importance enum), `VERDICT_SCHEMA` (refuted/evidence/confidence/counterSource),
`REPORT_SCHEMA` (summary, findings[claim/confidence/sources/evidence/vote], caveats,
openQuestions). Prompts are rewritten for opencode tool names (`websearch`/`webfetch`,
lowercase) and keep the structured-output instruction (the kernel appends its own
structured-TEXT contract; `workflow-kernel/child-agent-runner.js:648-663`).

### 4.10 Return contract (house envelope)

```js
{
  domain: "deep-research", schemaVersion: 1,
  status: "ok" | "degraded" | "failed",       // repo-bughunt status conventions
  abortReason: string | null,                  // e.g. "websearch-unavailable-or-empty"
  question, summary, findings, refuted, unverified, sources, openQuestions, caveats,
  stats: { angles, sourcesFetched, claimsExtracted, claimsVerified, confirmed, killed,
           unverified, afterSynthesis, urlDupes, budgetDropped, agentCalls },
  laneCoverage,                                // tallyPhase per-phase expected/completed/dropped
  reportPath: null,                            // guest cannot write files; command persists
  reportMarkdown,                              // rendered in pure JS; dropped first by size-fit
  truncatedFindings: boolean,
  artifacts: { ok, dir, files } | null,        // persistArtifacts outcome (lossless spill)
}
```

- **Honesty rules:** every dropped lane appears in `laneCoverage`; all-search-lanes-empty
  with errors and no seedUrls → `status: "failed"`, explicit websearch-unavailable
  `abortReason` (never an empty-but-plausible report); partial lane drops → `"degraded"`.
- **Kernel interaction (deliberate):** the kernel generically treats a returned object with
  top-level `status: "failed"` as a failed run (`DRAIN_FAILURE_STATUSES` check,
  `workflow-plugin.js:1068-1071`, applied to every workflow at `:1279`), so the terminal
  message reads "Workflow <id> failed" for those envelopes. That is the honest signal we
  want; `workflow_status detail:"result"` still returns the full envelope either way.
- **Size-fit:** stay under a 230,000-byte budget (headroom below `MAX_RESULT_BYTES` =
  256 KiB, `workflow-kernel/constants.js:53`): drop `reportMarkdown` first, then halve
  `findings`, flagging `truncatedFindings` (house pattern, `repo-bughunt.js:326-359`).
- **Artifacts:** full data spilled via
  `persistArtifacts({ namespace: "deep-research", files: [findings.full.json, sources.json, report.md] })`
  so size-fitting is lossless.
- **Report markdown** is rendered deterministically in guest JS (no `Date` — the command
  stamps the persisted file): executive summary; findings grouped by confidence with
  sources and verifier evidence; refuted claims (transparency); unverified claims (infra
  honesty); caveats; open questions; method/stats appendix.

## 5. Kernel change: `meta.whenToUse` (D6)

Today `whenToUse` is silently ignored (unknown meta keys are ignored; no kernel read).
Change: treat it as a cosmetic meta field like `category`/`notes` —

- `buildInvocationMetadata` (`workflow-kernel/role-template-loading.js:488-493`) surfaces
  `meta.whenToUse` (truncated like `notes`, 240 chars), with `curated?.whenToUse` as the
  bundled-scope fallback.
- `workflow_list` output includes it per entry.
- Docs: authoring `SKILL.md` meta-fields list, `docs/workflow-plugin.md` meta table.
- Tests: `listWorkflows` unit test asserting `whenToUse` surfaces (and truncates).

Rationale: this is CC's discovery mechanism for bundled workflows ("when should the model
reach for this"), it is author-owned (vs the kernel-curator-owned hints map), and the
flagship workflow should model it.

## 6. The bundled command: `commands/deep-research.md`

Auto-registered by the existing config hook (`workflow-plugin.js:296-324`; name =
basename, description parsed from the markdown). Protocol (repo-* command shape,
`skills/repo-review-command-protocol` analog, but self-contained in the command file — no
new skill, per approved scope):

1. **Clarify** — if the question is underspecified (CC heuristic: "what car to buy" with no
   budget/use-case/region), ask 2–3 narrowing questions; weave answers into `args.question`.
2. **Resolve models** — `workflow_models` + the bundled workflow-model-tiering skill:
   `fast` = cheap session-family model, `deep` = the session family's reasoning model.
3. **Launch by name** — `workflow_run({ name: "deep-research", args, modelTiers, format: "json" })`;
   present the approval preview human-first per the bundled workflow-plan-review skill —
   the `network: true` authority grant is the headline item.
4. **Read back** — `workflow_status({ runId, detail: "result" })`; if `reportMarkdown` was
   size-dropped, recover `report.md` from the run's `artifacts/deep-research/` spill.
5. **Persist exactly one report** — `.deep-research/runs/<run-id>-report.md`, stamped with
   date, question, depth, model tiers, and the confirmed/refuted/unverified stats. Ensure
   `.deep-research/` is gitignored when in a git repo (mirroring `.repo-review/` handling).
6. **Report back** — concise chat summary: answer, confidence spread, notable refuted
   claims, caveats.
7. **Follow-ups (offer, don't do)** — deeper pass on an open question; re-verify a specific
   claim; re-run at `thorough` if a cheaper depth was used. Read-only boundary footer.

## 7. Tests

All via `node --test tests/*.test.mjs`, using the existing harness
(`tests/helpers/harness.mjs` — real kernel against a scripted fake `session.prompt`).

1. **`tests/deep-research-workflow.test.mjs`** (new, E2E through the kernel):
   happy path (scripted lane responses → envelope shape, findings, stats, reportMarkdown);
   scope failure → error envelope; all searchers empty+errored → `failed` +
   websearch-unavailable abortReason; all claims refuted → inconclusive summary + refuted
   list; verifier infra-nulls → `unverified` accounting and infra-honest summary; synthesize
   failure → unmerged confirmed-claims salvage; URL dedup (two angles return the same URL →
   one fetch); fetch-budget drop accounting; depth presets (quick verifies central-only,
   vote counts per preset); args as string/object/JSON-string; missing question → explicit
   error; per-lane authority narrowing (scope/synthesize `session.create` permission rules
   deny `webfetch`/`websearch`; search/fetch/verify allow them — the harness records
   `calls.create` inputs); size-fit truncation flags.
2. **`normURL` and helper unit coverage** — exercised through the E2E fixtures (helpers are
   guest-internal); dedicated cases for scheme/www/query/fragment/trailing-slash/invalid-URL
   inputs via crafted search-result URLs.
3. **`tests/publish-completeness.test.mjs`** — invert the zero-bundled assertion (line 113)
   to: exactly one bundled workflow (`deep-research.js`) and one bundled command
   (`deep-research.md`) exist, both ship in `package.json` `files[]`, and the workflow
   parses via `parseWorkflowSource` with a valid meta/argsSchema.
4. **`meta.whenToUse`** — unit tests on `listWorkflows`/`buildInvocationMetadata` (surfaces,
   truncates, curated fallback for bundled scope).
5. **Existing suites stay green** (686 tests today, all green once this spec/plan carry
   their `> Status:` banners — `tests/workflow-docs.test.mjs:41` requires one on every
   `docs/` markdown file; extension/command registration suites already cover
   `registerCommandsFromDir` precedence).

## 8. Packaging and docs

- `package.json`: add `"workflows/"` and `"commands/"` to `files[]` (`package.json:15-25`);
  version → `0.3.0`.
- **README**: replace "ships zero workflows/commands" (`README.md:53-55`) with the stance
  reframe: *the engine ships one flagship workflow — deep-research — which doubles as the
  living gold-standard exemplar*; document the workflow, the command, args, depths, and
  the network-authority approval story.
- **CHANGELOG**: 0.3.0 entry explicitly noting the stance reversal and why.
- **`docs/workflow-recipes.md`**: the existing repo-centric recipe named `deep-research`
  (lines 261-274) is renamed (e.g. `repo-deep-research`) and cross-references the bundled
  workflow to avoid the name collision.
- **`docs/workflow-plugin.md`** + authoring `SKILL.md`: add `whenToUse` to the meta-field
  tables; update the "zero bundled" claims (`SKILL.md:225-236`).

## 9. Provenance

The bundled workflow is an **original implementation** of the deep-research architecture,
written for this kernel's API, authority model, and house conventions, with prompts
rewritten for opencode tools. The Claude Code script extracted from the binary was used as
a design reference only and is **not** vendored into the repo. The spec (§3) captures the
architecture self-containedly so implementation does not require the extracted script.

## 10. Known properties and risks

- **Websearch environment dependence**: opencode 1.17.13 ships native `websearch`
  (Exa/parallel.ai-backed) and `webfetch`; whether they reach the internet in a given
  install is outside plugin control. Mitigations: honest `failed`/degraded envelope,
  `seedUrls` escape hatch, and a live smoke test at implementation time (D10 below).
- **Server floor**: network-granting authority requires opencode ≥ 1.17.13
  (`workflow-kernel/server-fingerprint.js:72-78`); the installed server is exactly 1.17.13.
- **Resume cache-miss on dedup order** (§4.6): cost-only, documented in-source.
- **Wall-clock at thorough**: ~97 lanes at concurrency 8; the approval preview surfaces
  this and every knob (`concurrency`, `depth`, `maxSources`) is user-tunable per run.
- **Live smoke (D10)**: before release, run `/deep-research` end-to-end on a simple
  question in a real session; verify Exa reachability, approval UX, toast phases, report
  persistence.
