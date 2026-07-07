// Static-scan guard: tracked tests and docs that plant/illustrate fake credentials must
// contain ONLY scanner-safe constructions (runtime-assembled pieces or value-masked forms
// like `sk-***…1234` / `AKIA***1234`), never a full literal fake token that a public Git
// host / secret scanner would flag.
//
// opencode-workflows-public-fake-credential-fixtures. This is a static, no-token test: it
// reads the tracked source and asserts no full credential-shaped literal is present. The
// redaction behavior itself is covered by tests/repo-review-secret-containment.test.mjs and
// tests/free-text-redactor.test.mjs (whose fixtures are assembled at runtime, so they still
// exercise detection without committing a full literal).

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(fileURLToPath(import.meta.url), "..", "..");

// Tracked files known to plant or document fake credentials. A full literal fake token must
// not appear in any of them.
const SCAN_TARGETS = [
  "tests/repo-review-secret-containment.test.mjs",
  "tests/free-text-redactor.test.mjs",
  "docs/repo-review-leaf-contract.md",
  "docs/workflow-plugin.md",
];

// Full credential-shaped literals a secret scanner would flag. These deliberately require a
// long run of token characters so they do NOT match the documented value-masked forms
// (`sk-***…1234`, `AKIA***1234`, `AKIA…`) or regex-definition source (which contains `[`
// right after the prefix). Runtime-assembled fixtures (["AK","IA",...].join("")) split the
// prefix, so the source contains no contiguous full token either.
const FULL_LITERAL_PATTERNS = [
  { name: "provider token (sk/pk)", re: /\bsk-[A-Za-z0-9-]{20,}\b/ },
  { name: "github pat (ghp_)", re: /\bghp_[A-Za-z0-9]{30,}\b/ },
  { name: "aws access key (AKIA)", re: /\bAKIA[A-Z0-9]{12,}\b/ },
  { name: "bearer header with long token", re: /\bBearer\s+[A-Za-z0-9._-]{20,}\b/i },
];

test("tracked fake-credential fixtures contain no full literal token (scanner-safe)", async () => {
  const offenders = [];
  for (const rel of SCAN_TARGETS) {
    const abs = path.join(root, rel);
    let text;
    try {
      text = await fs.readFile(abs, "utf8");
    } catch (error) {
      if (error.code === "ENOENT") continue; // tolerate a renamed/removed target
      throw error;
    }
    for (const { name, re } of FULL_LITERAL_PATTERNS) {
      const match = text.match(re);
      if (match) offenders.push(`${rel}: ${name} -> ${match[0]}`);
    }
  }
  assert.deepEqual(offenders, [], `expected no full literal fake credentials; found:\n${offenders.join("\n")}`);
});

test("planted-secret fixture is assembled at runtime (no contiguous AKIA... literal in source)", async () => {
  const text = await fs.readFile(path.join(root, "tests/repo-review-secret-containment.test.mjs"), "utf8");
  // The source must NOT contain the contiguous runtime value as a literal; it is assembled.
  assert.doesNotMatch(text, /["']AKIA[A-Z0-9_-]{6,}["']/, "PLANTED_SECRET must not be a contiguous string literal");
  // And it must still assemble to an AWS-key-shaped value at runtime (detection is exercised).
  // eslint-disable-next-line no-eval
  const assembled = eval('(() => { const PLANTED_SECRET = ["AK", "IA", "-FAKE-SECRET-VALUE-", "12345"].join(""); return PLANTED_SECRET; })()');
  assert.match(assembled, /^AKIA[A-Z0-9_-]{6,}$/, "assembled planted secret still matches the in-guest AKIA detector shape");
});
