# repo-* Leaf Cross-Domain Parity Matrix

> Status: **active technical contract**. This matrix records shipped repo-review
> parity constraints; it is not a future roadmap.

> **Purpose:** the cross-domain parity audit for the `repo-*` review suite (Bead
> `opencode-workflows-rrev.12`). Maps every domain to its workflow, test, contract
> attributes, and flags the INTENTIONAL OpenCode differences from the Claude port.
> This matrix is the evidence that the `repo-review` meta (`rrev.13`) can integrate
> all eight leaves without an unresolved contract gap.
>
> **Sources cross-checked:**
> - Shared contract: `docs/repo-review-leaf-contract.md` (the OpenCode source of truth).
> - Reusable harness: `tests/helpers/repo-review-leaf-harness.mjs`.
> - OpenCode leaves: `workflows/repo-bughunt|repo-security-audit|repo-test-gaps|repo-cleanup|repo-modernize|repo-perf|repo-complexity|repo-deps.js`.
> - Port lineage: internal Claude workflow suite contract + repo-* domain sources.
>
> **Verification (re-run for this audit):** `npm run test:workflows` = `# tests 497,
> # pass 497, # fail 0`; `node --test tests/repo-review-leaf-contract.test.mjs` =
> `# tests 9, # pass 9, # fail 0`; discovery grep confirms all 8 `meta.name` + 8
> `DOMAIN` constants resolve. (iui1.x scale/exhaustiveness overhaul: maximal defaults,
> deterministic inventory + sharding, artifactized full output, lane coverage telemetry,
> Map-based merge + cross-domain corroboration key, observability, and optional deep modes.)

Every domain below is a LEAF: it NEVER calls `workflow()`, has no Bash/fs/git,
cannot `import` any module, and duplicates the shared contract pieces
(`envelope`, `emptyCounts`, `RECON_SCHEMA`, `formatRecon`, `fingerprintOf`,
`fitWithinBudget`, the arg-coercion preamble) verbatim per contract §11.

---

## A. Identity & categories (one row per domain)

| Domain | Workflow | Test | `DOMAIN` | `meta.name` | `maxAgents`/`concurrency` | Categories |
| --- | --- | --- | --- | --- | --- | --- |
| bughunt | `workflows/repo-bughunt.js` | `tests/repo-bughunt.test.mjs` (9) | `bughunt` | `repo-bughunt` | 4096 / 16 | concurrency, error-handling, boundary, null-empty, resource-leak, api-misuse, bad-state (7) |
| security | `workflows/repo-security-audit.js` | `tests/repo-security-audit.test.mjs` (12) | `security` | `repo-security-audit` | 4096 / 16 | injection, authz, secrets, unsafe-deserialization, ssrf, crypto-misuse, input-validation, dep-cve, insecure-default, sensitive-logging (10) |
| test-gaps | `workflows/repo-test-gaps.js` | `tests/repo-test-gaps.test.mjs` (15) | `test-gaps` | `repo-test-gaps` | 4096 / 16 | uncovered-public, untested-error-path, missing-edge-case, branch-no-assertion, weak-critical-path, untested-seam (6) |
| cleanup | `workflows/repo-cleanup.js` | `tests/repo-cleanup.test.mjs` (11) | `cleanup` | `repo-cleanup` | 4096 / 16 | dead-code, unused-deps, duplication, stale-markers, simplification, best-practice, doc-drift (7) |
| modernize | `workflows/repo-modernize.js` | `tests/repo-modernize.test.mjs` (10) | `modernize` | `repo-modernize` | 4096 / 16 | deprecated-api, outdated-idiom, legacy-pattern, unneeded-polyfill, config-upgrade (5) |
| perf | `workflows/repo-perf.js` | `tests/repo-perf.test.mjs` (15) | `perf` | `repo-perf` | 4096 / 16 | n-plus-one, quadratic, hot-alloc, sync-blocking, missing-caching, inefficient-structure, redundant-compute (7) |
| complexity | `workflows/repo-complexity.js` | `tests/repo-complexity.test.mjs` (10) | `complexity` | `repo-complexity` | 4096 / 16 | god-object, long-function, deep-nesting, tangled-module, high-churn-hotspot (5) |
| deps | `workflows/repo-deps.js` | `tests/repo-deps.test.mjs` (12) | `deps` | `repo-deps` | 4096 / 16 | outdated, cve, unused, undeclared, license, version-conflict, deprecated (7) |

> Every leaf declares `maxAgents:4096, concurrency:16`. Per `rrev.13`, nested leaves
> share the PARENT (meta) run budget, so each leaf's own declared `maxAgents` is
> advisory/ignored at runtime. The meta's parent `maxAgents:100000, concurrency:16`
> covers the sum of active leaf lanes (one recon + eight leaves' finder/verifier
> fan-out + the coverage auditor). Cross-domain findings are RANKED and LINKED
> (relatesTo via a corroboration key), not merged — only intra-domain identical
> fingerprints merge (iui1.6).

---

## B. Finding fields & top-level extras (one row per domain)

Common required on EVERY finding of EVERY domain (contract §3):
`id`, `fingerprint`, `rank`, `category`, `file`, `line`, `severity`, `description`,
`confidence` (0–100), `effort` (`small|medium|large`). The "domain action fields"
below are ADDITIONAL required fields for that domain.

| Domain | Domain action fields (beyond common) | Top-level envelope extra | Notes |
| --- | --- | --- | --- |
| bughunt | `reproSketch`, `fixSketch`, `proposedChange`, `docImpact` | — | Exemplar; the action-field set others are measured against. |
| security | `cwe`, `attackVector`, `exploitability` (`high\|medium\|low`), `proposedChange`, `docImpact` | — (critical tier allowed) | SAFETY directive: detect secret RISK by location only; never embed raw secret values; credential files off-limits. |
| test-gaps | `targetUnderTest`, `suggestedTest`, `proposedChange`, `docImpact` | — | Coverage-aware. |
| cleanup | `proposedChange`, `docImpact` | `staleDocs` (`string[]`) | `staleDocs` = doc paths from surviving doc-drift findings; `[]` when none survive. Behavior-preserving simplification only. |
| modernize | `deprecatedSince`, `replacement`, `targetVersion`, `proposedChange`, `docImpact` | `migrationPlan` (`string[]`) | `migrationPlan` ordered defects-first then effort-ascending; `[]` on empty. Defects = deprecated-api + legacy-pattern. No installs/codemods. |
| perf | `hotness` (`hot\|warm\|cold`), `estimatedImpact`, `complexityBefore`, `complexityAfter`, `proposedChange`, `docImpact` | — (coverage fields) | Observed-evidence vs suspected-hot-path-risk wording baked into prompts + confidence. |
| complexity | `churn`, `complexityScore`, `hotspotScore`, `refactorSuggestion`, `proposedChange`, `docImpact` | `shellCoverage`/`coverageLimitations` (carve-out) | Per-directory scorer. `hotspotScore` approximates `complexityScore` when churn unavailable. |
| deps | `package`, `currentVersion`, `targetVersion`, `breaking`, `cve` (`string[]`), `advisory`, `proposedChange`, `docImpact` | `upgradePlan` (`{safeBatch[], breakingChanges[]}`) | dedup key is `category::package::file` (manifest-level, not `file::line`). DEPS_POLICY: no network/installs/mutation. |

---

## C. Severity, counts & coverage disclosure (one row per domain)

`counts` is ALWAYS the 5-tier shape `{total,critical,high,medium,low}` with
`total === critical+high+medium+low`. Contract §4/§6: the six non-security domains
keep `critical:0` AND never emit `severity:"critical"`.

| Domain | Severity enum | `counts.critical` | `shellCoverage` | `coverageLimitations` | Severity scoring |
| --- | --- | --- | --- | --- | --- |
| bughunt | high/medium/low | 0 | (not emitted — v1) | (not emitted — v1) | sev × conf × effort |
| security | **critical/high/medium/low** | **real count** | `none` | stated (no scanners/dynamic analysis; dep-CVEs from knowledge) | sev × exploitability × conf × effort |
| test-gaps | high/medium/low | 0 | `none` | stated (no coverage tool/suite run; no percentages claimed) | sev × conf × effort |
| cleanup | high/medium/low | 0 | (not emitted) | (not emitted) | sev × conf × effort |
| modernize | high/medium/low | 0 | (not emitted) | (not emitted) | sev × conf × effort |
| perf | high/medium/low | 0 | `none` | stated (no profiler/benchmark/metrics; hotness inferred, not measured) | sev × conf × effort |
| complexity | high/medium/low | 0 | `none` | stated (git churn unavailable; hotspotScore ≈ complexityScore) | hotspotScore → sev → conf (composite) |
| deps | high/medium/low | 0 | (not emitted) | (not emitted — uses DEPS_POLICY + reduced confidence instead) | sev × conf × effort |

**Notable (intentional, non-blocking):** `deps` CVEs are reported at
high/medium/low — never `critical` — because deps is a non-security domain
(contract §6). This is the documented "critical:0 for deps cves" choice.

**Coverage-field normalization note (forward-looking):** `shellCoverage`/
`coverageLimitations` are contract §2 optional extension fields. security,
test-gaps, perf, and complexity emit them; bughunt, cleanup, modernize, deps do
NOT. This is an envelope-extension inconsistency (not a merge hazard — they are
top-level extras, not per-finding). Bead `rrev.24` will normalize degraded-
coverage disclosure across all leaves + the meta; it is not a blocker for `rrev.13`.

---

## D. Depth / verification behavior (one row per domain)

`depth ∈ {quick, normal, thorough}` (default `thorough`). All verification uses the
deep tier with `onFailure:"returnNull"`; refuted candidates are dropped and
survivors keep the skeptic's `adjustedConfidence`.

| Domain | quick | normal | thorough (always adds a 2nd find round) |
| --- | --- | --- | --- |
| bughunt | verify high only, 1 skeptic | verify ALL, 1 skeptic | verify ALL, **3-skeptic majority** (keep unless ≥2 refute) |
| security | verify critical+high, 1 skeptic | verify ALL, 1 skeptic | verify ALL, **3-skeptic majority** (keep unless ≥2 refute) |
| test-gaps | no verification | verify HIGH_RISK (uncovered-public, untested-error-path, weak-critical-path), 1 skeptic | verify ALL, 1 skeptic |
| cleanup | no verification | verify HIGH_RISK (dead-code, unused-deps), 1 skeptic | verify ALL, 1 skeptic |
| modernize | no verification | verify HIGH_RISK (deprecated-api, legacy-pattern), 1 skeptic | verify ALL, 1 skeptic |
| perf | verify high only, 1 skeptic | verify ALL, 1 skeptic | verify ALL, **3-skeptic majority** (keep unless ≥2 refute) |
| complexity | no verification | verify high-severity, 1 skeptic | verify ALL, 1 skeptic (no 2nd round — directory-based fan-out, not category lenses) |
| deps | no verification | verify HIGH_RISK (unused, undeclared), 1 skeptic | verify ALL, 1 skeptic |

---

## E. Uniform invariants (identical across all 8 domains)

These hold for every leaf and are what the `repo-review` meta relies on.

- **Arg contract (contract §8):** every leaf accepts `paths` (default `["."]`),
  `exclude` (default `node_modules,dist,build,.git,vendor,target,*.min.*,*.map`),
  `depth` (default `thorough`), `categories` (filtered to the domain's known set),
  `recon` (when present, the leaf SKIPS self-profiling and reuses the injected
  recon — this is the meta's shared-recon injection point), and `maxReturnFindings`
  (default `1000000`). Args may arrive as a JSON string; non-object/arrays are coerced
  to `{}`/defaults. **Domain clamp:** `complexity` additionally accepts `maxDirs`
  (positive int, default `40`).
- **Fingerprint basis (contract §5):** identical across all 8 — djb2
  (`5381`, `h=(h*33)^char >>> 0`) over `${DOMAIN}|${norm(file)}|${norm(category)}|${norm(description).slice(0,160)}`,
  rendered `${DOMAIN}-${hex}`. **NO line number** in the basis (line-independent;
  verified by the contract test). This is the cross-domain dedupe / materialization
  key the meta merge keys on.
- **Partial-failure behavior:** every fan-out uses arity-1 thunks
  `(api) => api.agent(..., { onFailure: "returnNull" })` for concurrent
  `parallel()` execution, then `.filter(Boolean)` drops failed lanes. A failed
  recon/finder/verifier lane degrades to fewer findings (or, for `complexity`
  only, a failed domain-specific recon returns `status:"aborted"` with an
  `abortReason`). No leaf crashes on a null lane result.
- **Size-fitting:** every leaf defines `fitWithinBudget(status, summary)` that
  caps returned findings to `maxReturnFindings`, renders `reportMarkdown`, then
  (under the ~230 KiB headroom below the 256 KiB `MAX_RESULT_BYTES` host cap)
  drops `reportMarkdown` to `null` first, then halves the returned findings array
  (floor 10) setting `truncatedFindings=true`. `counts.total` ALWAYS reflects the
  full ranked set and is never reduced to match a truncated array.
- **Envelope (contract §2):** every exit path returns an object with EXACTLY the
  top-level fields via the shared `envelope(status, extra)` helper: `domain`,
  `schemaVersion:1`, `status` (`ok|empty|aborted`), `abortReason` (`null` unless
  aborted), `reportPath` (**always `null`** — the QuickJS guest cannot write; the
  command wrapper persists `.repo-review/runs/<run-id>-<domain>-report.md`),
  `summary`, `counts` (5-tier), `findings`, `truncatedFindings`, `reportMarkdown`
  (`null` for empty/aborted or when dropped to fit).
- **Profile:** every leaf ships under `profile:"read-only-review"` (authority
  readOnly; the profile carries no gate vocabulary at all — Design C deleted
  `requiredGates`). The `inspect-with-shell` profile is NOT used by
  any shipped leaf (a deferred product-scope decision, not a runtime limitation — see F.4/F.6).
- **Structured-output policy (contract §9):** every schema lane is declared via
  `agent(prompt, { schema, tier, onFailure:"returnNull" })`. The guest source is
  IDENTICAL for both paths: native structured output (when
  `capabilities.structuredOutput === "available"`) and the structured-text
  fallback (the production default). Every leaf test covers the structured-text fallback path and
  the fingerprint sentinel.
- **Guest purity:** every leaf is import-free (no `import`/`require`, no
  `tests/helpers/` reference) — enforced by the contract test's no-import proof.
  Synthesis is PURE JS (no model) in every leaf.

---

## F. INTENTIONAL OpenCode differences from the Claude port

These are deliberate adaptations to the OpenCode QuickJS guest / tier-based /
read-only runtime. None break the meta's shared-recon injection or conservative
merge. (Sources: each OpenCode workflow header comment + `SUITE-CONTRACT.md`.)

1. **Model selection — tier vs concrete model.** Claude pins `model:'sonnet'`
   (recon/finders/skeptics) and `model:'opus'` (terminal synthesis). OpenCode
   declares intent only: `tier:"fast"` (recon, finders) / `tier:"deep"` (skeptics);
   the kernel resolves `tier -> concrete model` from `run.modelTiers`. Synthesis is
   not a lane at all (see #2).
2. **Synthesis is PURE JS, not an opus agent.** Claude delegates the final
   rank/render/counts to an `opus` synthesizer agent. OpenCode does dedup, scoring,
   counts, `reportMarkdown`, and the domain-extra build (staleDocs/migrationPlan/
   upgradePlan) entirely in pure JavaScript inside the guest — no model tokens.
3. **`reportPath` is always `null` (engine-vs-wrapper reversal).** Claude engines
   write the report themselves (`reportPath` = a real on-disk path, gated by the
   C3 absolute-`outDir` rule). OpenCode's QuickJS guest cannot write files, so the
   ENGINE returns `reportMarkdown` in the envelope with `reportPath:null`, and the
   COMMAND WRAPPER persists `.repo-review/runs/<run-id>-<domain>-report.md`. This is
   the documented OpenCode-specific reversal of the Claude engine/wrapper boundary.
4. **`deps` — no network, no installs, no audit tooling (reversed).** Claude
   instructed lanes to run package-manager audit/outdated tools. OpenCode ships a
   read-only lockfile/manifest inspection policy (`DEPS_POLICY`): no network, no
   installs, no package-manager mutation, no advisory-database fetch. CVE/outdated
   claims not provable from local files are reported at REDUCED confidence with the
   gap noted. The optional `inspect-with-shell` read-only-command allowlist for deps
   remains DEFERRED as a product-scope decision (see F above), not a runtime-verification gap.
5. **`deps` CVEs are non-critical.** `deps` keeps `critical:0`; CVE findings are
   reported at high/medium/low. Consistent with the contract's "only `security`
   populates critical" rule (a deliberate suite-wide normalization, not a bug).
6. **`complexity` churn lens DEFERRED (shell deferred).** Claude complexity uses
   `git log` churn. OpenCode ships under `read-only-review` (no Bash), so churn is
   best-effort/0 and `hotspotScore` approximates `complexityScore`; the engine emits
   `shellCoverage:"none"` + a `coverageLimitations` string explaining git churn was
   not measured. Enabling the shell/churn lens is a future, separately-approved
   change that would run under the `inspect-with-shell` profile (one-time launch
   approval, the audited read-only command allowlist enforced at the
   permission-rule level, and the server version floor) — not a gate to verify,
   since the profile carries no gate vocabulary at all (Design C deleted
   `requiredGates`, consistent with F above).
7. **Concurrency primitive.** OpenCode uses arity-1 thunks `(api) => ...` so
   `parallel()` runs them CONCURRENTLY. Zero-arg thunks now fail fast unless the
   call explicitly passes `{ sequential: true }`; default/rest parameters also
   count as zero at runtime. Claude uses `parallel()` directly.
8. **`complexity` computes a second domain-specific recon.** Even when the meta
   injects shared `args.recon`, complexity runs a `COMPLEXITY_RECON_SCHEMA` lane
   (`profile`/`dirs`/`gitAvailable`) because the shared recon does not carry source
   directories. This is by design (the meta recon cannot supply it); it costs one
   extra recon lane but does not block integration.
9. **Meta composition (rrev.13, not yet shipped).** The Claude meta
   (`repo-review.js`) loads engines by dynamic `${WF_DIR}/repo-*.js` path and uses
   an `opus` synthesis phase. The OpenCode meta will use ONLY static literal
   `workflow("repo-<domain>", args)` calls (no dynamic names, one nesting level) and
   a pure-JS merge — per `rrev.13`. (Out of scope for this leaf audit; recorded for
   parity completeness.)

---

## G. Conclusion — meta (`rrev.13`) integration readiness

**No blocking contract gap.** Every domain maps to a `workflows/repo-*.js` engine
and a `tests/repo-*.test.mjs` suite; all eight resolve by `meta.name`/`DOMAIN` and
pass under `npm run test:workflows` (497/497) and the shared contract test (9/9).

On every dimension the `repo-review` meta's shared-recon + conservative merge
depends on, the eight leaves are uniform and contract-conformant:
- Shared-recon injection: all eight accept `args.recon` and skip self-profiling.
- Envelope shape: all eight return the contract §2 envelope on every exit path.
- Common finding fields: all eight carry `id/fingerprint/rank/category/file/line/
  severity/description/confidence/effort` for UnifiedFinding normalization.
- Cross-domain dedupe key: the djb2 fingerprint basis is byte-identical across all
  eight (DOMAIN|file|category|desc[:160], no line).
- Status ledger: all eight return `ok|empty|aborted`.
- Per-domain top-level extras (`staleDocs`/`migrationPlan`/`upgradePlan`) are
  surfaced, not merged, so they cannot break cross-domain ranking.

The flagged items are intentional OpenCode differences (§F) and one forward-looking
normalization (`shellCoverage`/`coverageLimitations` not yet uniform — owned by
`rrev.24`); neither category blocks `rrev.13`. The `deps` dedup-key and
`complexity` second-recon differences are internal to those leaves and do not
affect the returned envelope or the meta merge.
