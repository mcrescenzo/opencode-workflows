import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, mkdtempSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = new URL("../", import.meta.url);
const pkg = JSON.parse(readFileSync(new URL("package.json", root), "utf8"));

function npmPackDryRunJson() {
  const npmCache = mkdtempSync(join(tmpdir(), "opencode-workflows-npm-cache-"));
  return spawnSync("npm", ["pack", "--dry-run", "--json"], {
    cwd: fileURLToPath(root),
    encoding: "utf8",
    shell: false,
    maxBuffer: 10 * 1024 * 1024,
    env: {
      ...process.env,
      npm_config_cache: npmCache,
    },
  });
}

test("package is publishable (not private)", () => {
  assert.notEqual(pkg.private, true);
});

test("scoped package is configured for public publish", () => {
  assert.equal(pkg.publishConfig?.access, "public");
  assert.ok(pkg.engines?.node, "must declare an engines.node floor");
});

test("files[] ships every runtime-loaded asset dir", () => {
  for (const dir of ["skills/", "workflows/", "commands/"]) {
    assert.ok(pkg.files.includes(dir), `files[] must include ${dir}`);
  }
});

test("files[] ships only the docs a shipped command/skill/workflow instructs an agent to read at runtime", () => {
  // Amended files[] policy (2026-07-07): a shipped doc must be reachable from a shipped
  // runtime asset via an AGENT-FACING instruction string (prompt text a running agent will
  // follow), not merely cited from a code comment or README prose. docs/workflow-plugin.md
  // is the only doc in this repo that clears that bar: as of version 0.3.0 (which restored
  // one bundled flagship workflow/command pair, deep-research), it ships as the canonical
  // workflow_* tool reference for the kernel API itself (workflow-kernel/), which every
  // extension/skill/agent invoking workflow_run|workflow_apply|workflow_status directly
  // depends on — no bundled command indirection is required for that dependency to hold.
  assert.ok(pkg.files.includes("docs/workflow-plugin.md"), "files[] must include docs/workflow-plugin.md");
  assert.equal(pkg.files.includes("docs/"), false, "files[] must not blanket-include docs/ (ships internal planning docs)");
  assert.ok(pkg.files.includes("CONTRIBUTING.md"), "CONTRIBUTING.md must be included when README references it");
});

test("files[] does not ship docs whose only references are code comments or README/GitHub-only prose", () => {
  // These docs are real and git-tracked, but no shipped command/skill/workflow points an
  // agent at them at runtime: their only in-repo references are either README prose (a
  // human-facing doc map, not agent instructions) or bare `//` code comments inside
  // workflows/*.js (contract citations for maintainers, never sent to an agent). Per the
  // amended files[] policy those references do not qualify the doc for shipping.
  const githubOnlyDocs = [
    "docs/workflow-recipes.md",           // only a `//` comment in workflow-kernel/role-template-loading.js
    "docs/plugin-system-tests.md",        // only README.md / AGENTS.md prose
    "docs/run-audit-playbook.md",         // only README.md prose
    "docs/goal-supervision-autonomous-drains.md", // only README.md / planning-doc prose
    "docs/workflow-extensions.md",        // only README.md prose
  ];
  for (const doc of githubOnlyDocs) {
    assert.equal(pkg.files.includes(doc), false, `files[] must not include GitHub-only doc ${doc}`);
    assert.ok(existsSync(new URL(doc, root)), `${doc} should still exist in git (just not packed)`);
  }
});

test("files[] does not ship historical/roadmap-only planning docs", () => {
  const internalDocs = [
    "docs/dogfood-rollout-2026-06-16.md",
    "docs/release-gate-validation-2026-06-16.md",
    "docs/review-2026-06-19-bug-robustness-remediation-plan.md",
    "docs/workflow-autonomous-harness-design.md",
    "docs/workflow-autonomous-harness-plan.md",
    "docs/general-purpose-harness-extraction-plan.md",
    "docs/claude-parity-roadmap.md",
  ];
  for (const doc of internalDocs) {
    assert.equal(pkg.files.includes(doc), false, `files[] must not include internal planning doc ${doc}`);
    assert.ok(existsSync(new URL(doc, root)), `${doc} should still exist in git (just not packed)`);
  }
});

test("files[] ships the public security policy", () => {
  assert.ok(pkg.files.includes("SECURITY.md"), "SECURITY.md must be included in the published package");
  assert.ok(existsSync(new URL("SECURITY.md", root)), "SECURITY.md must exist on disk");
});

test("package metadata and community-health files are present for public release", () => {
  assert.equal(pkg.homepage, "https://github.com/mcrescenzo/opencode-workflows#readme");
  assert.equal(pkg.bugs?.url, "https://github.com/mcrescenzo/opencode-workflows/issues");
  assert.match(pkg.author, /Michael Crescenzo/);
  for (const file of [
    "CODE_OF_CONDUCT.md",
    "CHANGELOG.md",
    ".editorconfig",
    ".github/ISSUE_TEMPLATE/bug_report.md",
    ".github/ISSUE_TEMPLATE/feature_request.md",
    ".github/PULL_REQUEST_TEMPLATE.md",
  ]) {
    assert.ok(existsSync(new URL(file, root)), `${file} must exist on disk`);
  }
  assert.ok(pkg.files.includes("CODE_OF_CONDUCT.md"), "CODE_OF_CONDUCT.md must be included in the published package");
  assert.ok(pkg.files.includes("CHANGELOG.md"), "CHANGELOG.md must be included in the published package");
});

test("the plugin ships exactly one bundled workflow and one bundled command (deep-research)", () => {
  // 0.3.0 deliberately reversed the 0.2.0 zero-bundled stance for exactly one flagship
  // workflow + command pair (see CHANGELOG 0.3.0). Anything else appearing in these dirs
  // must be a deliberate decision that updates this list.
  assert.equal(existsSync(new URL("workflows/", root)), true);
  assert.deepEqual(
    readdirSync(fileURLToPath(new URL("workflows/", root))).sort(),
    ["deep-research.js"],
  );
  assert.equal(existsSync(new URL("commands/", root)), true);
  assert.deepEqual(
    readdirSync(fileURLToPath(new URL("commands/", root))).sort(),
    ["deep-research.md"],
  );
  assert.ok((pkg.files ?? []).includes("workflows/"), "files[] must ship workflows/");
  assert.ok((pkg.files ?? []).includes("commands/"), "files[] must ship commands/");
});

test("no domain extension assets exist in the repo (pure-architecture invariant)", () => {
  assert.equal(existsSync(new URL("workflow-domains/", root)), false);
  assert.equal((pkg.files ?? []).includes("workflow-domains/"), false);
});

test("npm pack --dry-run tarball excludes any domain extension dir entirely", () => {
  const res = npmPackDryRunJson();
  assert.equal(res.status, 0, `npm pack --dry-run failed: ${res.error?.message ?? res.stderr}`);
  // --json prints a JSON array of pack manifests on stdout (notices go to stderr).
  const manifests = JSON.parse(res.stdout);
  const files = manifests.flatMap((m) => (m.files ?? []).map((f) => f.path));
  const offenders = files.filter(
    (p) =>
      p.startsWith("workflow-domains/") ||
      p.startsWith("skills/repo-review-command-protocol") ||
      p.startsWith("skills/beads-drain"),
  );
  assert.deepEqual(offenders, [], `tarball must not ship domain extension assets, found: ${offenders.join(", ")}`);
  assert.ok(files.includes("workflows/deep-research.js"), "tarball must ship the bundled deep-research workflow");
  assert.ok(files.includes("commands/deep-research.md"), "tarball must ship the bundled deep-research command");
  assert.ok(files.includes("SECURITY.md"), "tarball must ship SECURITY.md");
});

test("packed README and command docs have no missing package-local references", () => {
  const res = npmPackDryRunJson();
  assert.equal(res.status, 0, `npm pack --dry-run failed: ${res.error?.message ?? res.stderr}`);
  const manifests = JSON.parse(res.stdout);
  const files = new Set(manifests.flatMap((m) => (m.files ?? []).map((f) => f.path)));
  const docs = ["README.md"];
  const missing = [];

  function normalizeRef(ref) {
    let target = ref.replace(/^\.?\//, "").split("#")[0];
    target = target.replace(/^\.\//, "");
    return target;
  }

  // The "Documentation Map" table and "Roadmap" section deliberately reference
  // git-only historical/roadmap docs that are NOT part of the published tarball
  // (see the files[] allowlist policy). Their inline `docs/...` mentions are
  // source-checkout context, not package-resolvable links, so exclude those two
  // sections from the bare-backtick existence check. Real markdown links
  // (`[text](path)`) are still checked everywhere since neither section uses them.
  function stripNonShippedSections(markdown) {
    return markdown
      .replace(/^## Documentation Map\n[\s\S]*?(?=\n## )/m, "")
      .replace(/^## Roadmap\n[\s\S]*$/m, "");
  }

  for (const rel of docs) {
    const text = readFileSync(new URL(rel, root), "utf8");
    assert.doesNotMatch(text, /workflow-domains\//, `${rel} must not point package users at the unpublished extension dir`);

    const linkRefs = [];
    for (const match of text.matchAll(/\]\((?!https?:|mailto:|#)([^)\s]+)\)/g)) linkRefs.push(match[1]);

    const backtickScanText = rel === "README.md" ? stripNonShippedSections(text) : text;
    const backtickRefs = [];
    for (const match of backtickScanText.matchAll(/`((?:docs|commands|skills)\/[^`#\s)]+|CONTRIBUTING\.md|SECURITY\.md|README\.md)`/g)) {
      backtickRefs.push(match[1]);
    }

    for (const raw of [...linkRefs, ...backtickRefs]) {
      if (raw.includes("*")) continue;
      const target = normalizeRef(raw);
      if (!target || target.endsWith("/")) continue;
      if (!files.has(target)) missing.push(`${rel} -> ${raw}`);
    }
  }

  assert.deepEqual(missing, [], `package-local docs references must be packed: ${missing.join(", ")}`);
});

test("package-visible verification docs mark test scripts as source-checkout-only", () => {
  const readme = readFileSync(new URL("README.md", root), "utf8");

  assert.match(readme, /## Source Checkout Verification/);
  assert.match(readme, /not for an installed package tarball/);
  assert.match(readme, /does not ship this repository's `tests\/`, `scripts\/`, or reference\s+extension source/s);
  assert.match(readme, /does not ship the "Historical snapshots \/ audits" or\s+"Roadmap \/ planning" docs/s);
});
