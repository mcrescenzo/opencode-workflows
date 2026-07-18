// R08 regression: deep-research URL dedup must not collapse distinct documents.
//
// normURL lives in workflows/deep-research.js, which is a QuickJS sandbox workflow source
// (it declares `export const meta` and uses sandbox-only globals like agent/pipeline). The
// workflow-source parser (workflow-source.js:473-479,598) rejects any export other than
// `export const meta`, so normURL cannot be exported for direct import, and importing the file
// under Node would execute top-level sandbox calls and throw. To test the REAL function
// (not a replica that could drift), we read the source, extract the normURL declaration plus
// the module-level constants it closes over (WEB_URL_SCHEME, TRACKING_QUERY_KEYS), and build
// it via the Function constructor. If the function moves/disappears the extraction fails loudly.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEEP_RESEARCH_PATH = path.resolve(__dirname, "..", "workflows", "deep-research.js");

// Extract a contiguous `<const decls>\nfunction <name>(...) { ... }` block from source by
// brace-counting from the function keyword to its matching close brace. `startAnchor` must
// occur before the function keyword on a line that begins the constant declarations normURL
// depends on. Returns the source slice ready to eval.
function extractFn(source, startAnchor, fnName) {
  const start = source.indexOf(startAnchor);
  if (start === -1) throw new Error(`regression harness: anchor "${startAnchor}" not found in deep-research.js — was it refactored?`);
  const fnAt = source.indexOf(`function ${fnName}`, start);
  if (fnAt === -1) throw new Error(`regression harness: function ${fnName} not found after anchor — was it renamed?`);
  let i = source.indexOf("{", fnAt);
  if (i === -1) throw new Error(`regression harness: no opening brace for ${fnName}`);
  let depth = 0;
  for (; i < source.length; i++) {
    const ch = source[i];
    if (ch === "{") depth++;
    else if (ch === "}") { depth--; if (depth === 0) break; }
  }
  if (depth !== 0) throw new Error(`regression harness: unbalanced braces for ${fnName}`);
  // Trim leading blank lines/comments before the anchor are kept; slice from anchor through close.
  return source.slice(start, i + 1);
}

// Load the REAL normURL source text before any test runs. Top-level await in a module is
// evaluated fully before node --test dispatches the registered tests, so normURL is assigned.
const source = await fs.readFile(DEEP_RESEARCH_PATH, "utf8");
const __block = extractFn(source, "const WEB_URL_SCHEME", "normURL");
// new Function body is its own scope: const/function declarations are local, `return normURL`
// hands the real function back. This runs the ACTUAL source text, not a copy.
const normURL = new Function(__block + "\n; return normURL;")();

// Each case: [label, inputA, inputB, shouldDedup]. shouldDedup means normURL(A) === normURL(B).
const CASES = [
  // --- MUST survive (distinct documents) ---
  {
    label: "case-differing path is distinct (path case is significant)",
    a: "https://example.com/Wiki/Page",
    b: "https://example.com/wiki/page",
    dedup: false,
  },
  {
    label: "distinct non-tracking query param value is distinct (?id=N)",
    a: "https://example.com/doc?id=1",
    b: "https://example.com/doc?id=2",
    dedup: false,
  },
  {
    label: "distinct non-tracking query param key is distinct",
    a: "https://example.com/list?page=1",
    b: "https://example.com/list?page=1&sort=asc",
    dedup: false,
  },
  {
    label: "distinct paths are distinct",
    a: "https://example.com/alpha",
    b: "https://example.com/beta",
    dedup: false,
  },
  {
    label: "mixed-case path with query preserved distinctly",
    a: "https://example.com/Article?entry=42",
    b: "https://example.com/article?entry=42",
    dedup: false,
  },

  // --- MUST dedupe (same document, cosmetic/transport/tracking variants) ---
  {
    label: "host case differs only -> dedupe (host is case-insensitive)",
    a: "https://Example.COM/page",
    b: "https://example.com/page",
    dedup: true,
  },
  {
    label: "scheme case differs only -> dedupe",
    a: "HTTPS://example.com/page",
    b: "https://example.com/page",
    dedup: true,
  },
  {
    label: "leading www. stripped -> dedupe",
    a: "https://www.example.com/page",
    b: "https://example.com/page",
    dedup: true,
  },
  {
    label: "trailing slash differs -> dedupe",
    a: "https://example.com/page/",
    b: "https://example.com/page",
    dedup: true,
  },
  {
    label: "multiple trailing slashes collapse -> dedupe",
    a: "https://example.com/page///",
    b: "https://example.com/page",
    dedup: true,
  },
  {
    label: "fragment differs/absent -> dedupe",
    a: "https://example.com/page#section",
    b: "https://example.com/page",
    dedup: true,
  },
  {
    label: "fragment + query: non-tracking query kept, fragment dropped -> dedupe",
    a: "https://example.com/page?id=5#top",
    b: "https://example.com/page?id=5",
    dedup: true,
  },
  {
    label: "utm_* tracking params stripped -> dedupe",
    a: "https://example.com/page?utm_source=twitter&utm_medium=social",
    b: "https://example.com/page",
    dedup: true,
  },
  {
    label: "tracking params stripped but real query kept -> dedupe to same real query",
    a: "https://example.com/page?id=9&utm_source=fb&gclid=xxx&fbclid=yyy",
    b: "https://example.com/page?id=9",
    dedup: true,
  },
  {
    label: "the canonical existing dedup-fixture (www + trailing slash, 3-angle style)",
    a: "https://www.same.example/page/",
    b: "https://same.example/page",
    dedup: true,
  },
];

for (const c of CASES) {
  test(`R08 normURL: ${c.label}`, () => {
    assert.equal(typeof normURL, "function", "harness failed to load normURL");
    const ka = normURL(c.a);
    const kb = normURL(c.b);
    assert.ok(ka && kb, `normURL must not return empty for real URLs (${c.label}): got ${JSON.stringify([ka, kb])}`);
    if (c.dedup) {
      assert.equal(ka, kb, `expected DEDUP but keys differ (${c.label}): ${JSON.stringify(ka)} !== ${JSON.stringify(kb)}`);
    } else {
      assert.notEqual(ka, kb, `expected SURVIVE but keys matched (${c.label}): ${JSON.stringify(ka)}`);
    }
  });
}

// Pin the exact normalized form for a few representative inputs so future regressions in the
// key SHAPE (not just collision behavior) are caught. These document the contract precisely.
test("R08 normURL: pinned key shapes (path case + non-tracking query preserved)", () => {
  assert.equal(normURL("https://Example.COM/Wiki/Page?id=7&utm_source=x#frag"), "example.com/Wiki/Page?id=7");
  assert.equal(normURL("https://www.example.com/a/b/c/"), "example.com/a/b/c");
  assert.equal(normURL("HTTPS://WWW.Example.Com/X?Q=1"), "example.com/X?Q=1");
  assert.equal(normURL("https://example.com/page?utm_medium=m&id=4&gclid=z"), "example.com/page?id=4");
});

test("R08 normURL: invalid/empty input normalizes to empty (callers skip)", () => {
  assert.equal(normURL(""), "");
  assert.equal(normURL(null), "");
  assert.equal(normURL(undefined), "");
  assert.equal(normURL("   "), "");
});
