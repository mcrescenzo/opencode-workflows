# repo-* Review Leaf Contract

> Named contract artifact for all `repo-*` review workflows in this plugin.
> Status: **active**. Canonical exemplar: `workflows/repo-bughunt.js` + `tests/repo-bughunt.test.mjs`.
> Port lineage: internal Claude workflow suite contract, adapted to OpenCode QuickJS guest execution with no fs and tier-based models.
> Every `repo-*` leaf engine and its command wrapper MUST conform to this document.

The seven other leaf-port beads (`repo-security-audit`, `repo-test-gaps`, `repo-cleanup`,
`repo-modernize`, `repo-perf`, `repo-complexity`, `repo-deps`) and several follow-up beads cite
and conform to what is defined here. This is the foundation: it is the single source of truth for
the leaf envelope, finding shape, fingerprint, counts, size-fit semantics, the meta-to-leaf
injection arg contract, and the structured-output policy.

## 1. Engine-vs-wrapper boundary (the key rule)

Adapted from SUITE-CONTRACT § Enforcement boundary.

- **Engine (the `.js` guest source under `workflows/`)** runs inside the QuickJS guest. It has **NO
  Bash/fs/git** and **cannot `import`** any module. It is a pure orchestrator: it does read-only
  analysis via `agent()` lanes, ranks/synthesizes in pure JS, and returns a structured envelope.
  - The engine is a **leaf**: it NEVER calls `workflow()`. The meta calls leaves via `workflow()`;
    nesting is one level only.
  - Because guests cannot import, every shared piece defined here (the `envelope()` helper,
    `fingerprintOf`, `RECON_SCHEMA`, `formatRecon`, the size-fit `fitWithinBudget`) is
    **duplicated verbatim** into each engine. See § "How later leaves conform".
- **Wrapper (the `.md` command under `commands/`)** has Bash and is the enforcement point. It mints
  the run dir, classifies repo state, passes scope args, and **persists the report**. It NEVER
  trusts the engine's self-report; it validates claims post-hoc.
- In OpenCode the guest cannot write files, so the engine's `reportPath` is always **null** (see
  §2). Only the wrapper persists `.repo-review/runs/<run-id>-<domain>-report.md` (rendered from the
  returned `reportMarkdown`). This is the OpenCode-specific reversal of the Claude port, where the
  engine wrote the report itself.

## 2. Leaf envelope (exact top-level fields)

Every exit path (abort / empty / ok) returns an object with EXACTLY these top-level fields, built
via the shared `envelope(status, extra)` helper. Types and nullability:

| Field | Type | Nullable | Notes |
| --- | --- | --- | --- |
| `domain` | `string` | no | The leaf domain (see §6). Constant per engine. |
| `schemaVersion` | `integer` | no | Currently `1`. Bump only on a breaking envelope change. |
| `status` | `enum` | no | `ok` \| `empty` \| `aborted` (see §6). |
| `abortReason` | `string` \| `null` | yes | `null` unless `status === "aborted"`, in which case it is a non-empty string. |
| `reportPath` | `null` | — | **Always `null` in OpenCode.** The QuickJS guest cannot write files. The command wrapper persists the report (§1). |
| `summary` | `string` | no | One-line human summary. For ok: counts + "Report-only — nothing applied." |
| `counts` | `object` | no | Always the 5-tier shape (§4). |
| `findings` | `array` | no | Ranked findings (§3). Empty array for `empty`/`aborted`. |
| `truncatedFindings` | `boolean` | no | `true` when the findings array was truncated to fit the host cap (§7). |
| `reportMarkdown` | `string` \| `null` | yes | Full markdown report, or `null` when dropped to fit the cap (§7) / for `empty`/`aborted`. |

Reference helper (duplicated into each engine):

```js
function envelope(status, extra) {
  return { domain: DOMAIN, schemaVersion: SCHEMA_VERSION, status, abortReason: null, reportPath: null, ...extra };
}
const emptyCounts = { total: 0, critical: 0, high: 0, medium: 0, low: 0 };
```

Optional envelope extension fields (vocabulary established here; populated by follow-up beads, see
§12): `shellCoverage` (enum `{none, partial, full}`, default `none` for read-only-review leaves) and
`coverageLimitations` (`string|null`; when coverage tools/tests/profilers were NOT run, state why;
`null` when coverage was actually exercised). `repo-bughunt` v1 does not emit these yet; they are
forward-looking and a follow-up coverage bead extends them. They MUST NOT break the table above.

### Per-domain top-level extras (carve-outs)

Some domains carry additional REQUIRED top-level fields (cited from SUITE-CONTRACT § Per-domain
carve-outs). Do NOT flatten these into findings:

| Domain | Top-level extra | Meaning |
| --- | --- | --- |
| `cleanup` | `staleDocs` | List of stale/dead documentation paths. |
| `modernize` | `migrationPlan` | Migration narrative for the modernization targets. |
| `deps` | `upgradePlan` | Dependency upgrade ordering/risks. |
| `complexity` | (shell-coverage decision) | May populate `shellCoverage`/`coverageLimitations`. |
| `security` | (critical tier allowed) | The only domain that populates `counts.critical` and `severity:"critical"`. |

## 3. Finding fields (required vs optional)

After synthesis, every element of `findings` carries the **common required** set plus optional
domain-specific action fields.

**Common required (every domain, every finding):**

| Field | Type | Notes |
| --- | --- | --- |
| `id` | `string` | Positional, in-run reference, e.g. `${category}-${i+1}`. NOT stable across runs. |
| `fingerprint` | `string` | Stable cross-run dedupe/materialization key (§5). Required. |
| `rank` | `integer` | 1-based rank after synthesis scoring (`severity * confidence * effort`). Contiguous 1..N. |
| `category` | `string` | Domain-specific category (filtered to the engine's known category set). |
| `file` | `string` | Repo-relative path. |
| `line` | `integer` | 1-based line (best effort; `0` acceptable when unknown). NOT in the fingerprint basis. |
| `severity` | `enum` | `critical` \| `high` \| `medium` \| `low` (§6). `critical` only for `security`. |
| `description` | `string` | What the issue is. First 160 normalized chars feed the fingerprint. |
| `confidence` | `integer` | 0–100. Required for ranking; skeptics/verification may adjust it. |
| `effort` | `enum` | `small` \| `medium` \| `large` (§6). Required for ranking. |

**Optional / domain-specific action fields** (the bughunt exemplar's set; other domains define
their own via §2 carve-outs):

| Field | Type | Required for | Meaning |
| --- | --- | --- | --- |
| `reproSketch` | `string` | `bughunt` | How to trigger the bug. |
| `fixSketch` | `string` | `bughunt` | Sketch of the fix. |
| `proposedChange` | `string` | `bughunt` | Concrete proposed change. |
| `docImpact` | `string` | `bughunt` | Documentation impact (may be empty string). |

The `repo-review` meta preserves implementation-relevant optional fields from every leaf under a
curated `domainDetails` object on each unified finding before writing `findings.full.json`. This
prevents `/review-materialize` from losing data needed for Beads `design` and `acceptance` fields.
Examples include bughunt `reproSketch`/`fixSketch`, security `cwe`/`attackVector`, test-gap
`targetUnderTest`/`suggestedTest`, dependency package/version/advisory fields, perf impact fields,
and complexity/refactor fields. The meta does not dump arbitrary raw lane output; the field set is
curated to preserve useful context without expanding the artifact surface unnecessarily.

## 4. counts shape (always 5-tier)

```js
counts: { total, critical, high, medium, low }   // all integers >= 0
```

- `total === critical + high + medium + low` (always).
- The six **non-security** domains keep `critical: 0`. Only `security` populates `critical`
  (its severity enum is the real 4-tier set).
- `empty`/`aborted` use `emptyCounts` (all zero).

## 5. Fingerprint contract (deterministic, line-independent)

Every finding MUST carry a `fingerprint` computed by the shared `fingerprintOf` (duplicated
verbatim into each engine). It is the **cross-run dedupe / materialization key**, distinct from the
positional `id`.

- **Algorithm:** djb2 (seed `5381`, `h = (h*33) ^ char) >>> 0`), rendered as `${DOMAIN}-${hex}`.
- **Basis:** `${DOMAIN}|${norm(file)}|${norm(category)}|${norm(description).slice(0,160)}` where
  `norm` lowercases and collapses whitespace.
- **NO line number** in the basis. Line numbers drift between runs; including them would defeat
  cross-run dedupe. (Verified by the contract test: same file/category/description at different
  lines produce the same fingerprint.)
- **Stability caveat (H6):** the hash includes the first 160 chars of the *synthesizer's* prose, so
  if the synthesizer paraphrases between runs the crosswalk can miss and re-materialize a
  duplicate. Accepted for now (re-runs are rare; the materializer's verify pass flags duplicates).

Reference (canonical, from `repo-bughunt.js`):

```js
// <suite:fingerprintOf>
function fingerprintOf(f) {
  const norm = (s) => (s || "").toString().toLowerCase().replace(/\s+/g, " ").trim();
  const basis = `${DOMAIN}|${norm(f.file)}|${norm(f.category)}|${norm(f.description).slice(0, 160)}`;
  let h = 5381;
  for (let i = 0; i < basis.length; i++) h = ((h * 33) ^ basis.charCodeAt(i)) >>> 0;
  return `${DOMAIN}-${h.toString(16)}`;
}
// </suite:fingerprintOf>
```

The sentinel comments `// <suite:fingerprintOf>` … `// </suite:fingerprintOf>` wrap the canonical
copy so the contract test can extract and exercise it without importing the guest.

## 6. Enums

- `status` ∈ { `ok`, `empty`, `aborted` }.
- `severity` ∈ { `critical`, `high`, `medium`, `low` }. Rule: the six non-security domains keep
  `critical: 0` in counts AND never emit `severity: "critical"` on a finding. Only `security`
  populates critical.
- `confidence` ∈ integer `0..100`.
- `effort` ∈ { `small`, `medium`, `large` }.

## 7. Truncation / reportMarkdown / size-fit semantics

The host caps workflow output at `MAX_RESULT_BYTES = 256 KiB` (256 * 1024; `workflow-kernel/constants.js`),
enforced by `assertResultSize` (`workflow-kernel/structured-output.js`). Leaves MUST size-fit their
own return value so the run completes rather than aborting on an oversized result.

`fitWithinBudget` (duplicated per engine) does this, in order:

1. Cap the returned findings to `maxReturnFindings` (default 1000000) — `counts.total` still reflects
   the FULL ranked set; only the returned array is capped.
2. Render `reportMarkdown`.
3. If the serialized envelope exceeds a headroom budget (~230 KiB under the 256 KiB cap, leaving
   room for the `{output:...}` wrapper + envelope fields), **drop `reportMarkdown` to `null`**.
4. While it still exceeds the budget and the returned findings count > 10, **halve the returned
   findings array** and set `truncatedFindings = true`.

Semantics:

- `truncatedFindings === true` means the returned `findings` array is a strict subset of the full
  ranked set (either via `maxReturnFindings` cap or the halving loop). `counts.total` is ALWAYS the
  full count and MUST NOT be reduced to match the truncated array.
- `reportMarkdown === null` means the markdown was dropped to fit (or the status is `empty`/`aborted`).
- `MAX_SOURCE_BYTES = 512 KiB` bounds guest SOURCE size; it is unrelated to result truncation.

## 8. Arg contract (meta-to-leaf injection)

Accepted `args` (passed via `workflow_run({ name, args })` or injected by the `/repo-review` meta):

| Arg | Type | Default | Meaning |
| --- | --- | --- | --- |
| `paths` | `string[]` | `["."]` | Repo-relative paths to review. |
| `exclude` | `string[]` | `["node_modules","dist","build",".git","vendor","target","*.min.*","*.map"]` | Paths NOT scanned/reported. Lockfiles are intentionally not excluded by default. |
| `depth` | `enum` `{quick, normal, thorough}` | `thorough` | Verification depth profile. quick = high-severity only, 1 skeptic; normal = all, 1 skeptic; thorough = all + 2nd find round, 3-skeptic majority (keep unless ≥2 refute). |
| `categories` | `string[]` | domain's full set | Subset of the domain's known categories; filtered to the known set (unknown categories dropped). |
| `recon` | `object` \| `string` | (absent) | **When present, the leaf SKIPS self-profiling** and uses the injected recon directly. Tolerates a prose string via `formatRecon`. The meta-side delivery rule (recon computed ONCE, identical injection into every leaf) is specified in §14. |
| `maxReturnFindings` | `integer` | `1000000` | Cap on the returned findings array (counts.total still reflects the full set). |

Defensive parsing: `args` may arrive as a JSON string; engines coerce to `{}` on parse failure.
Non-object/arrays are rejected to `{}`/defaults. This arg shape IS the meta-to-leaf injection
contract.

## 9. Structured-output policy (BOTH paths supported)

Leaves declare schema lanes via `agent(prompt, { schema, tier, onFailure: "returnNull" })`. `tier`
is `"fast"` (recon, finders — bulk work) or `"deep"` (skeptics — subtle correctness); synthesis is
pure JS (no model). The kernel (`workflow-kernel/child-agent-runner.js`) resolves `tier -> concrete
model` from `run.modelTiers`.

**Both structured-output paths are supported and the guest source is identical for both:**

1. **Native structured output** — when `run.capabilities.structuredOutput === "available"`: the
   kernel sets `outputFormat: { type: "json_schema", schema }` and reads the result from
   `data.info.structured` (`run.adapter.getStructured`). (child-agent-runner.js lines 334, 347, 562-563.)
2. **Structured-text fallback** — otherwise: the kernel injects `structuredTextInstruction(schema)`
   into the system prompt, sets `outputFormat: { type: "text" }`, and parses the model's JSON text
   back with `parseStructuredTextResult` (extracts the outermost `{...}`). (child-agent-runner.js
   lines 335, 342, 347, 565-568; `workflow-kernel/structured-output.js`.)

**Production reality:** native structured output is NOT available in the current runtime, so the
**fallback is the DEFAULT path**. Leaves MUST therefore author schemas that are
**text-JSON-parse-friendly**:

- Prefer plain `object`/`array`/`string`/`integer`/`boolean` and `enum` constraints.
- Avoid regex/`oneOf`-heavy constructs and complex constraints the model cannot reliably emit as
  raw JSON text. The fallback extracts the outermost JSON object and, by default, gives the same child
  session one corrective turn with the validation error before a still-malformed response fails the lane;
  `onFailure: "returnNull"` then converts that exhausted validation failure to a dropped result.
- `structuredFormat()` omits `retryCount` (the OpenCode server adds its own; including it caused a
  `getSessionMessages` readback rejection `Expected OutputFormatJsonSchema`).

The contract test exercises BOTH paths against the same leaf and asserts the returned envelope is
identical in shape.

## 10. Shared RECON_SCHEMA

Identical across the suite and duplicated into each engine (engines cannot import). Tolerates a
prose string via `formatRecon(recon)`. When `args.recon` is present the leaf reuses it; otherwise it
self-profiles once via an `agent` lane using this schema.

```js
const RECON_SCHEMA = {
  type: "object", additionalProperties: false,
  properties: {
    languages: { type: "array", items: { type: "string" } },
    frameworks: { type: "array", items: { type: "string" } },
    packageManagers: { type: "array", items: { type: "string" } },
    entryPoints: { type: "array", items: { type: "string" } },
    testLayout: { type: "string" },
    buildTooling: { type: "string" },
    concurrencyModel: { type: "string" },
    errorHandling: { type: "string" },
    externalResources: { type: "array", items: { type: "string" } },
    notes: { type: "string" },
  },
  required: ["languages", "notes"],
};
```

## 11. How later leaves conform

Every `repo-*` leaf:

1. **Cites this document** in its header comment as the contract source of truth.
2. **Duplicates the shared pieces verbatim** into its guest source — `const DOMAIN =
   '<domain>'`, `const SCHEMA_VERSION = 1`, `envelope()`, `emptyCounts`, `RECON_SCHEMA`,
   `formatRecon()`, `fingerprintOf()` (wrapped in the `// <suite:fingerprintOf>` sentinel), the
   arg-coercion preamble, and `fitWithinBudget()`. Guests are QuickJS-injected and CANNOT `import`
   any module (enforced by the contract test: a guest source must not reference `tests/helpers/` or
   any `.mjs` module, and must contain no `import`/`require`).
3. **Declares domain categories** (its own `ALL_CATEGORIES`) and **per-domain carve-outs** (§2
   extras; e.g. `cleanup` emits top-level `staleDocs`, `deps` emits `upgradePlan`).
4. **Keeps `critical: 0`** in counts unless the domain is `security`.
5. **Reuses the test harness** `tests/helpers/repo-review-leaf-harness.mjs` (zero-token): import
   `makeHarness`, `runApprovedRequest`/`resultOutput`/`runLeafEnvelope`, the response shapers
   `structured`/`textStructured`, `makeLeafPromptRouter`, and the contract assertions
   `assertLeafEnvelope`/`assertLeafCounts`/`assertLeafFinding`/`assertLeafFindings`. The harness is
   test-only; it is never imported by a guest.

## 12. Extension points (deferred to follow-up beads — do NOT implement here)

This contract intentionally leaves clean extension points:

- **recon-meta-behavior:** how the `/repo-review` meta computes shared recon ONCE and injects
  `args.recon` across all leaves, plus budget-guarded batched `parallel()` orchestration. The
  leaf-side acceptance (`args.recon` skips self-profiling) is defined in §8; the meta-side delivery
  contract (recon-once, identical injection, parent-budget awareness, static literal leaf refs, one
  nesting level, read-only preserved) is now specified in §14. Open meta-implementation work
  (`workflows/repo-review.js`, rrev.13) must satisfy §14; enforcement against the real meta source
  is verified when rrev.13 lands.
- **secret-containment / redaction policy** for finding prose and report markdown before
  persistence/display. **Now specified in §15** (evidence-safety / secret-value
  containment): secret-class findings surface location + fingerprint/masked snippet, never
  the raw value, enforced IN-GUEST at synthesis (the engine masks detected secret values
  before they enter the returned envelope).
- **cost / model-tier policy:** concrete tier→model resolution is set by the operator/planning
  agent via `run.modelTiers`. The per-lane tier policy, recommended meta sizing, and the
  budgeted-concurrency reservation behavior are now specified in **§16**.
- **degraded-coverage:** `shellCoverage`/`coverageLimitations` semantics for coverage-aware domains
  (`test-gaps`, `complexity`, `perf`, `security`) — vocabulary established in §2; **the partial-failure
  / degraded-coverage disclosure RULE (leaf + meta) is now specified in §17**.

## 13. Verification

The contract is enforced by zero-token tests:

- `tests/repo-review-leaf-contract.test.mjs` — validates a REAL `repo-bughunt` run and synthetic
  envelopes against this contract; proves guest sources import nothing; proves the fingerprint is
  deterministic and line-independent.
- `tests/helpers/repo-review-leaf-harness.mjs` — the reusable harness + `assertLeafEnvelope` family.
- Run: `npm run test:repo-review-contract` (focused) and `npm run test:workflows` (with the suite).

## 14. Meta-to-leaf arg contract (recon-once, identical injection)

> Status: **active** (contract + leaf-side + meta-side spec enforced). Satisfied on the leaf side by
> all eight engines; the meta implementation itself (`workflows/repo-review.js`, bead rrev.13) is
> gated on this section and is verified against it when rrev.13 lands.
>
> §8 defines the **leaf-side** accepted args. This section defines the **meta-side** delivery rules:
> how the `/repo-review` meta computes shared recon ONCE and threads the SAME recon+scope+depth into
> every nested leaf so all eight domains analyze a consistent file inventory and cross-domain dedupe
> stays coherent. It reconciles rrev.13's stated "shared recon" design with the per-leaf beads.

### 14.1 Accepted args (recap of §8, meta perspective)

The meta builds ONE args object and injects it (by reference) into every nested leaf call:

| Arg | Type | Meaning in the meta |
| --- | --- | --- |
| `recon` | `object` \| `string` | **When present, every leaf SKIPS self-profiling** and reuses this value verbatim. Tolerates a prose string via `formatRecon`. |
| `paths` | `string[]` | Shared scan scope (repo-relative paths). Same value reaches every leaf. |
| `exclude` | `string[]` | Shared exclude list. Same value reaches every leaf. |
| `depth` | `enum` `{quick, normal, thorough}` | Shared verification-depth profile. Same value reaches every leaf. |
| `categories` | `string[]` | Optional per-leaf category subset. When the meta injects a shared `categories` it MUST be a value valid for every leaf (engines filter unknown categories to their own known set), so omitting it is the safe default. |

Meta-only args are normalized before leaf injection:

- `mode` accepts `"exhaustive"` (default) or `"bounded"`. Exhaustive mode selects
  `depth: "thorough"`, `maxReturnFindings: 1000000`, and runs the coverage-auditor
  lane. Bounded mode preserves the legacy normal-depth pass without the auditor.
- `mode` itself is not forwarded to leaves; leaves receive the normalized
  `depth`/`maxReturnFindings` values.

### 14.2 Recon is computed ONCE, then identically injected

- The meta computes recon **exactly once** — either a single `agent` recon lane (tier `fast`) or a
  pure-JS profiling pass — and stores it in one value.
- That **same** recon value (reference-identical, not a re-computed copy) is injected, together with
  the same `paths`/`exclude`/`depth`, into **every** literal one-level `workflow("repo-X", args)`
  call. All eight domains therefore analyze the SAME file inventory; cross-domain merge/dedupe
  (rrev.18) operates over one coherent scope rather than eight independently-profiled ones.
- If the shared recon comes back null/invalid, the meta logs a loud warning; leaves then self-profile
  (the ~8× recon cost is the documented degraded mode, never a silent failure).

### 14.3 Static literal leaf refs, one nesting level only

- The meta calls each engine via a **static literal** name — `workflow("repo-bughunt", args)`,
  `workflow("repo-security-audit", args)`, … — for all of: `repo-bughunt`, `repo-cleanup`,
  `repo-complexity`, `repo-deps`, `repo-modernize`, `repo-perf`, `repo-security-audit`,
  `repo-test-gaps`.
- **No dynamic workflow names.** The leaf name MUST be a literal in the source; it MUST NOT be
  computed, concatenated, read from a variable that holds arbitrary input, or driven by a loop
  variable over caller-supplied data. (The kernel rejects dynamic `workflow(name)` refs; this section
  makes that a contract requirement, not just a runtime check.)
- **No recursion beyond one level.** Leaves are leaves (they never call `workflow()`); the meta is
  one level above them and MUST NOT itself be invoked via `workflow()` by another workflow.

### 14.4 Parent-run budget awareness

- Nested `workflow()` calls **share the parent run's budget**, including its `maxAgents`. A nested
  meta's own `meta.maxAgents` is **ignored at runtime**; the parent's `maxAgents` MUST cover the
  full fan-out: **N leaf fanouts + 1 recon lane** (plus each leaf's internal finder/verify fan-out).
- Concretely: the meta's `maxAgents`/concurrency headroom must be sized for one recon lane plus up to
  eight leaves, each of which is itself a fan-out workflow (recon-skipped, but still finders +
  skeptics). Budget-guarded batched `parallel()` orchestration keeps peak concurrency bounded.

### 14.5 Read-only preserved

- The meta inherits the `read-only-review` profile. It performs **no** filesystem writes, no
  `workflow_apply`, no `git` writes, no Beads mutation, and no chaining into `materialize` or
  `beads-drain` (those run at L0 in the wrapper, after the meta returns). The meta only orchestrates
  read-only leaves and merges their envelopes in pure JS.

### 14.6 Verification (no-token)

This section is enforced by `tests/repo-review-meta-arg-contract.test.mjs` (run via
`npm run test:repo-review-meta-args`, also enrolled in `test:workflows`):

- **Leaf-side:** all eight leaves honor an injected `args.recon` — when it is present the shared
  recon lane is NOT invoked (the mocked prompt router sees no recon prompt), and the leaf still
  returns a contract-valid envelope. A contrast run without `args.recon` confirms the recon lane IS
  invoked, proving the skip is specifically caused by injection.
- **Meta-side spec (enforced when rrev.13 lands):** a structural assertion that this section exists
  and documents the recon-once + identical-injection rule, the parent-budget rule, the static-literal
  / one-level rules, and read-only preservation; plus a stub-based test that a meta-shaped function
  computes recon once and injects reference-identical recon/scope/depth into all eight leaves. Full
  enforcement against the real `workflows/repo-review.js` source is verified when rrev.13 lands.

## 15. Evidence-safety / secret-value containment

> Status: **active**. Enforced **IN-GUEST** at leaf synthesis (the engine masks detected
> credential/secret values before they enter the returned envelope), at kernel durable/display
> boundaries through value masking, and re-stated at the **command wrapper** (which must not
> paste raw values into `.repo-review/runs` reports). This section keeps report-level evidence
> useful without exposing raw credentials.

### 15.1 The rule (secret-class findings)

Any finding that detects a credential/secret (in any domain, but most commonly `security`)
MUST surface the risk by **location + a non-reversible fingerprint or a value-masked
snippet**, **NEVER the raw secret value**. Concretely:

- Reference the secret by `file`:`line` (location) plus the finding `fingerprint` (the stable,
  non-reversible djb2 hash from §5) — or, when a snippet is needed for triage, a **value-masked**
  form such as `sk-***…1234` / `AKIA***1234` (keep at most a short prefix + a short suffix;
  never the identifying middle).
- Raw secret values (API keys, passwords, tokens, private keys, connection strings) MUST NOT
  appear in **any** field of a finding (`description`, `attackVector`, `proposedChange`,
  `docImpact`, …) nor in the rendered `reportMarkdown`.

### 15.2 Layered enforcement boundary

The workflow kernel now applies both key-based redaction and free-text value masking at
durable/display boundaries:

1. persisted `result.json` (written by `workflow-plugin.js`),
2. append-only journal/checkpoint/ledger records used for durable resume, and
3. `workflow_status({ runId, detail: "result" })`, which applies `redactValue` before returning
   the stored result (`run-store-status-format.js`).

Leaves still MUST mask findings in guest code. Kernel value masking is a defense-in-depth
backstop for common credential shapes, not permission to emit raw secret values. Containment is
therefore enforced at three layers:

- **IN-GUEST (leaf synthesis):** each leaf that can detect secrets masks detected secret
  patterns in finding prose *before* ranking, rendering `reportMarkdown`, and returning the
  envelope. The engine is the only place that sees the model's raw prose; it must not echo
  secret values.
- **Kernel value masking:** durable result/journal/checkpoint writes and status readbacks mask
  common credential-shaped string values and redact sensitive object keys.
- **Command wrapper (`.md`):** the wrapper renders the report from the (already-masked) returned
  `reportMarkdown` and MUST NOT paste raw secret values into
  `.repo-review/runs/<run-id>-<domain>-report.md` itself. The wrapper trusts the engine's
  masking for prose and adds no new secret content of its own.

### 15.3 Reference masking helper

The canonical, self-contained masking helper is duplicated (under the
`// <suite:maskSecrets>` … `// </suite:maskSecrets>` sentinel) into each leaf that can detect
secrets — currently `repo-security-audit.js`. It masks well-known credential shapes (AWS
`AKIA…`, provider tokens `sk-` / `pk-` / `ghp_` / `xox…`, PEM private keys) and generic
`key=value` / `token: value` assignments, replacing the match with a non-reversible
`<prefix>***<suffix>` form. The finding prose fields (`description`, `attackVector`,
`proposedChange`, `docImpact`) are passed through it during synthesis; the `fingerprint`
(§5) is a non-reversible hash and needs no masking.

### 15.4 Verification (no-token)

This section is enforced by `tests/repo-review-secret-containment.test.mjs` (run via
`node --test tests/repo-review-secret-containment.test.mjs`, also enrolled in `npm test`):

- **End-to-end (repo-security-audit):** a mocked finder returns a finding whose prose fields
  carry a planted fake secret (an AWS-key-shaped synthetic value assembled at runtime in the test
  so no full fake credential literal is committed to source); the test asserts the raw secret
  does NOT appear in the structured result envelope, in the `workflow_status detail:"result"`
  output, or in the rendered `reportMarkdown`, while the finding still survives (masking, not
  dropping).
- **Kernel redaction proof:** `redactValue` is shown to scrub a secret-shaped string embedded
  in a `description` value while still redacting a `password` *key* by key name.
- **Durable-result proof:** a workflow returning a secret-shaped string under a non-sensitive
  key is persisted to `result.json` and read through `workflow_status detail:"result"` without
  the raw value.
- **Generic envelope containment:** the extracted `maskSecretsInText` helper masks a planted
  secret in a synthetic finding's prose fields and leaves plain prose untouched.

## 16. Cost guardrails + model-tier policy

> Status: **active**. The suite's token/cost economics are a tested contract, not prose. This
> section pins the per-lane model-tier expectation, the meta's recommended sizing, and the
> cost-ceiling→serial trade-off. Enforced by `tests/repo-review-cost-model-tier.test.mjs`
> (run via `node --test tests/repo-review-cost-model-tier.test.mjs`, enrolled in `test:workflows`
> by the parent repo).

### 16.1 Per-lane model-tier expectation (fast=finder/recon, deep=skeptic)

Every lane declares a **tier intent** (`"fast"` or `"deep"`); the kernel resolves `tier -> concrete
model` from `run.modelTiers`. The assignment is **deliberate and uniform across all eight leaves** —
it is NOT one blanket session-model lane:

| Lane role | Declared tier | Constant | Why |
| --- | --- | --- | --- |
| recon (repo profiler; meta's shared recon) | `fast` | `TIER_RECON = "fast"` | Bulk read-only profiling; breadth over depth. |
| finder / scorer (candidate generation) | `fast` | `TIER_FINDER = "fast"` | High-volume fan-out; breadth over depth. |
| skeptic / verify / judge (adversarial verdict) | `deep` | `TIER_VERIFY = "deep"` | Subtle correctness reasoning; narrow, high-stakes. |

- Verified at the source: each of `repo-bughunt`, `repo-security-audit`, `repo-test-gaps`,
  `repo-cleanup`, `repo-modernize`, `repo-perf`, `repo-complexity`, `repo-deps` declares
  `TIER_RECON = "fast"`, `TIER_FINDER = "fast"`, `TIER_VERIFY = "deep"`, and every `agent(...)`
  lane passes one of them as `tier:`. The meta's own shared recon lane is `tier: "fast"`
  (`workflows/repo-review.js`).
- **Resolution precedence** (`resolveLaneModel`, `workflow-kernel/authority-policy.js`):
  explicit `opts.model` > `run.modelTiers[tier]` > `run.defaultChildModel`. A declared tier with
  **no** map entry degrades to `run.defaultChildModel` (the session-inherited model), so legacy /
  tierless lanes behave exactly as before. This is the ONLY path by which the session model is
  inherited — and it is the absence of a tier mapping, never a silent override of a declared tier.
- The point of tiering: the bulk fan-out (recon + finders) runs on the **fast** tier while the
  narrow adversarial verification (skeptic/judge) runs on the **deep** tier. When the operator
  supplies **distinct** `modelTiers` (fast ≠ deep), the approval surface reports
  `Model plan: fast=<fastModel> deep=<deepModel>` and the per-lane records resolve finders→fast,
  skeptics→deep — proving the split is real and not blanket session-model inheritance. (When no
  `modelTiers` are supplied, every tier degrades to the session model and the plan reads
  `fast=<sessionModel> deep=<sessionModel>`; that uniform map is the explicit "no deviation"
  default, not a contract violation.)

### 16.2 Recommended meta sizing

The meta (`workflows/repo-review.js`) ships with the default parallel posture documented in §14.4:

- **`maxAgents: 100000`** — intentionally over-provisions one shared recon lane, the
  coverage auditor, and the cumulative cold-run fan-out of all eight leaves under
  batched `parallel()` (≈50 finder lanes for an empty run; ≈150+ at thorough depth
  with skeptics; potentially more in large repos). Nested
  `workflow()` lanes share the parent run budget; a nested leaf's own `maxAgents` is ignored at
  runtime (§14.4), so the parent MUST be sized for the full tree.
- **`concurrency: 16`** — bounds peak concurrent child sessions across the whole fan-out. This is
  an explicit repo-review posture, not the kernel-wide hard ceiling; operators can configure that
  ceiling higher or lower and should use the concurrency-capacity live probe before treating larger
  bursts as production-safe.
- **`modelTiers`: not declared on the meta.** The meta deliberately does NOT pin concrete models
  (the epic constraint: "use model tier intents tier fast and tier deep, never hard-code provider
  models"). The operator sets `modelTiers` at launch via `workflow_run({ modelTiers: { fast, deep } })`,
  guided by `workflow_models` (the no-deviation suggestion keeps both tiers on the session model;
  deviate to map fast→a cheaper/faster model and deep→a stronger model). See the
  `workflow-model-tiering` skill for the selection procedure.

### 16.3 Cost ceilings: concurrent reservations, default is fast-parallel

A cost or token ceiling **does not serialize the run**. `workflow-kernel/workflow-plugin.js`
preserves the resolved `concurrency` value, while `workflow-kernel/budget-accounting.js`
uses in-flight reservations to keep concurrent lane admission inside the ceiling:

```js
checkBudgetBeforeLaunch(run);
const laneReservation = reserveLaneBudget(run);
```

Declaring `maxCost` or `maxTokens` keeps the meta's declared `concurrency: 16`. Each launching
lane synchronously reserves a conservative slice of the remaining headroom before `session.prompt`
starts; later lanes see those reservations in `checkBudgetBeforeLaunch` and budget-stop instead of
launching past the admitted headroom. Reservations reconcile when the lane reports real spend or
fails before spend.

- **Default posture (fast-parallel):** `repo-review` ships with **NO** `maxCost`/`maxTokens`
  ceiling. It runs fast-parallel (`concurrency: 16`) and is bounded only by `maxAgents` (lane-count)
  and the optional `maxRuntimeMs` wall-clock deadline. This is the recommended default for an
  interactive review.
- **Operator choice (bounded-cost-parallel):** setting `maxCost`/`maxTokens` is an explicit operator
  decision that adds a spend ceiling without changing the declared concurrency. The approval preview
  surfaces both values:
  `Concurrency: 16` and `Budget ceilings: maxCost=<n>, maxTokens=<n>`.

### 16.4 Graceful budget stop (no crash; coherent partial result)

A budget stop is **graceful at two layers**, never a crash:

1. **Per-lane (`onFailure: "returnNull"`):** every recon/finder/verify lane is declared with
   `onFailure: "returnNull"`. When `checkBudgetBeforeLaunch` (`workflow-kernel/budget-accounting.js`)
   throws `WorkflowBudgetStoppedError` (outcome `budget_stopped`, `event-journal.js`), the lane
   runner's catch converts it to `null` because `laneOutcomeForError(error) !== "cancelled"`
   (`workflow-kernel/child-agent-runner.js`). The stopped lane is journaled as `budget_stopped` and
   the workflow body sees a `null` result — exactly the same shape a failed finder/skeptic already
   tolerates. Subsequent lanes re-check the (now-exhausted) ceiling and also return `null`.
2. **Meta/leaf envelope:** because every lane swallows the budget stop via `returnNull`, **no**
   error propagates to the run-level controller. The run therefore **completes** (status
   `completed`, NOT `failed`) with `run.laneOutcomes.budget_stopped > 0`, and the leaf/meta returns
   a **coherent partial envelope**: finders that never ran contribute no candidates; skeptics that
   returned `null` drop their candidates (repo-bughunt treats a null verdict as `keep:false`,
   `workflows/repo-bughunt.js`), so the surviving set is a strict, contract-valid subset. Under
   total exhaustion a leaf returns `status:"empty"`; the meta merges whatever survived into a
   unified envelope with `partialCoverage` reflecting dropped coverage. (If a lane ever lacked
   `returnNull`, the same throw would instead terminate the run as a resumable `budget_stopped`
   with a persisted partial result — also graceful, also non-crashing. The suite does not rely on
   that path because every lane declares `returnNull`.)

### 16.5 Verification (no-token)

This section is enforced by `tests/repo-review-cost-model-tier.test.mjs`:

- **Model-tier correctness (approval/model-plan surface):** with distinct `modelTiers` supplied,
  the approval preview reports `Model plan: fast=<fastModel> deep=<deepModel>` (fast ≠ deep) for
  both `repo-bughunt` and the `repo-review` meta; without `modelTiers` it reports
  `fast=<defaultChildModel> deep=<defaultChildModel>` (the blanket no-deviation default). This
  proves the tier policy is the resolution mechanism, not blanket session-model inheritance.
- **Model-tier correctness (per-lane resolution):** running `repo-bughunt` and the meta with
  distinct `modelTiers` and inspecting `workflow_status({detail:"full"}).laneRecords[].model`
  proves recon + finder lanes resolved to the **fast** model and skeptic/verify lanes resolved to
  the **deep** model; a contrast run without `modelTiers` shows every lane on the single
  session/default model.
- **Cost-ceiling concurrency:** supplying `maxCost`/`maxTokens` preserves `Concurrency: 16` in the
  preview and `concurrency === 16` in the persisted run state; budget reservations, not
  serialization, bound concurrent lane admission.
- **Graceful budget stop:** a tight `maxTokens` ceiling causes lanes to budget-stop
  (`laneOutcomes.budget_stopped > 0`) while the run **completes without crashing** and the
  leaf/meta returns a contract-valid partial envelope (`status` ∈ {`ok`,`empty`,`aborted`}).
- **Contract rule present:** this section's rule is asserted to exist in the contract doc.

## 17. Partial-failure / degraded-coverage disclosure

> Status: **active**. Degraded output MUST be explicit so a user never mistakes incomplete
> coverage for a clean / exhaustive result. Enforced by
> `tests/repo-review-degraded-coverage.test.mjs` (run via
> `node --test tests/repo-review-degraded-coverage.test.mjs`, enrolled in `test:workflows`
> by the parent repo).

### 17.1 The rule (every envelope discloses its own degradation)

Every **leaf** envelope AND the **meta** envelope MUST disclose when — and only when — the
returned output is degraded. There are three independent degradation signals; any one that
applies MUST be surfaced honestly rather than silently shrinking the result:

1. **A lane or leaf failed / aborted (partial run).** A leaf that could not complete
   (`status: "aborted"`, or a nested `workflow()` that threw) MUST NOT be silently dropped.
   The meta surfaces this in two places:
   - **`partialCoverage: true`** on the meta envelope — set whenever
     `failed.length > 0 || ran.length < activeDomains.length` (a domain failed OR did not
     reach an ok/empty state; an aborted leaf falls in the latter clause).
   - **`leafOutcomes[]`** — the per-domain ledger; the degraded domain appears with a
     **non-ok** `status` (`"aborted"` or `"failed"`) and its (zero) `counts`. A user
     inspecting the ledger sees exactly which domain did not complete.
   - On the leaf envelope itself, the abort is disclosed via `status: "aborted"` plus a
     non-empty `abortReason` (§2, §6).

2. **Coverage was not measured (no shell / profiler / test-runner).** A leaf that infers
   findings from read-only agent review instead of running a coverage tool MUST say so, so
   its findings are not mistaken for measured coverage:
   - **`shellCoverage: "none"`** — no shell / profiler / test-runner was executed.
   - **`coverageLimitations: <non-empty string>`** — a plain-language explanation of what
     was NOT measured and why (e.g. "No coverage tool or test suite was executed … line /
     branch coverage was not measured.").
   - **Findings MUST NEVER be mistaken for exhaustive coverage when `shellCoverage` is
     `"none"`;** the `coverageLimitations` string is the disclosure that prevents that
     misread. Currently emitted on every exit path by the coverage-aware domains:
     `test-gaps`, `perf`, `security`, `complexity`. The remaining leaves (`bughunt`,
     `cleanup`, `modernize`, `deps`) do not measure coverage either and are tracked as a
     non-blocking parity gap by rrev.12; they neither claim coverage nor emit the wording.

3. **Findings were truncated for size.** When the returned `findings` array is a strict
   subset of the full ranked set (capped by `maxReturnFindings` or halved to fit the host
   cap), the envelope MUST set **`truncatedFindings: true`** (§7). `counts.total` always
   reflects the FULL set, so the truncation is visible as `counts.total > findings.length`.

### 17.2 What "non-degraded" looks like (the absence is also honest)

When none of the three signals apply, the envelope is honest by NOT claiming degradation:
`partialCoverage: false` (meta), every `leafOutcomes[].status` ∈ {`ok`, `empty`}, and
`truncatedFindings: false`. A leaf that DID measure coverage would set
`shellCoverage: "partial" | "full"` with `coverageLimitations: null`; under the current
`read-only-review` profile every coverage-aware leaf sets `shellCoverage: "none"` with a
non-null limitation (the shell / profiler lens is a separately-approved `inspect-with-shell`
change — see the shell-lens decision in `repo-complexity.js` and §2).

### 17.3 Verification (no-token)

This section is enforced by `tests/repo-review-degraded-coverage.test.mjs`:

- **Meta partial-coverage disclosure:** force one nested leaf (`repo-complexity`) to abort
  by starving its domain-local recon lane; assert the meta envelope carries
  `partialCoverage: true` and the aborted domain appears in `leafOutcomes` with a non-ok
  status. A contrast run with all leaves completing asserts `partialCoverage: false`,
  proving the flag is caused by the degradation (not unconditionally set).
- **Coverage-aware leaf wording:** the four coverage-aware leaves (`test-gaps`, `perf`,
  `security`, `complexity`) each emit `shellCoverage: "none"` and a non-empty
  `coverageLimitations` on every exit path.
- **Size truncation:** a leaf returning more findings than `maxReturnFindings` sets
  `truncatedFindings: true` while `counts.total` reflects the full ranked set.
- **Contract rule present:** this section is asserted to exist in the contract doc
  (source-scan).
