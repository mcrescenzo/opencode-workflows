import fs from "node:fs/promises";
import path from "node:path";
import {
  BUNDLED_WORKFLOW_DIR,
  GLOBAL_WORKFLOW_DIR,
  MAX_CHILD_PROMPT_TIMEOUT_MS,
  MAX_SOURCE_BYTES,
  ROLE_DIR,
  TEMPLATE_DIR,
} from "./constants.js";
import { extractTextFromError, hash, truncateText, redactValue } from "./text-json.js";
import { assertWriteWorkflowAllowed, resolveRunAuthority, authoritySummary, AD_HOC_AUTHORITY_PROFILE, VALID_TIERS } from "./authority-policy.js";
import { normalizeLaneEffort } from "./lane-effort-policy.js";
import { parseWorkflowSource, projectWorkflowDir, workflowFileName } from "./workflow-source.js";
import { pathExists, readJsonFile, writeJsonAtomic } from "./run-store-status.js";

const ROLE_MANIFEST = path.join(ROLE_DIR, "manifest.json");
const ROLE_DEFAULTS_MANIFEST = path.join(ROLE_DIR, "roles.json");

const DEFAULT_ROLES = {
  explorer: "Explore the assigned surface area. Return concrete files, facts, and uncertainty, not guesses.",
  skeptic: "Challenge assumptions and look for failure modes, regressions, security issues, and missing verification.",
  verifier: "Verify claims with direct evidence. Prefer commands, files, and reproducible checks over opinion.",
  synthesizer: "Combine lane outputs into a concise decision-ready summary with evidence and remaining risks.",
  implementer: "Make the smallest correct implementation change, preserve existing style, and include verification evidence.",
};
const DEFAULT_ROLE_DEFAULTS = Object.freeze({
  roles: Object.freeze(Object.fromEntries(Object.keys(DEFAULT_ROLES).map((name) => [name, Object.freeze({})]))),
});
const ALLOWED_ROLE_DEFAULT_KEYS = new Set([
  "model",
  "tier",
  "tools",
  "readOnly",
  "retryCount",
  "correctiveRetries",
  "timeoutMs",
  "mcpPolicy",
  "secretGlobs",
  "effort",
]);

// Minimal first-run slice. The smallest safe shape for a fresh agent to validate one
// read-only slice before building a larger fanout or nested workflow: profile
// read-only-review, 1-2 scoped parallel lanes, pure-JS synthesis (zero extra agent
// slots), bounded maxAgents/concurrency, and no filesystem or domain writes. Inner code
// avoids backticks and ${} so it can live verbatim in this backtick literal; see
// docs/workflow-recipes.md "Recipe: first-run read-only slice" for the walkthrough.
const FIRST_RUN_SLICE_TEMPLATE = `export const meta = {
  name: "first-run-slice",
  description: "Minimal read-only first-run slice: 1-2 scoped parallel lanes, pure-JS synthesis, no writes.",
  profile: "read-only-review",
  maxAgents: 2,
  concurrency: 2,
};

// Edit \`question\` and \`slices\` (1-2) for your surface, then preview -> approve.
const question = (args && args.question) || "Summarize what this slice does";
const rawSlices = (args && Array.isArray(args.slices) && args.slices.length > 0) ? args.slices : ["primary"];
const slices = rawSlices.slice(0, 2);

// Per-lane contract: every claim must carry concrete evidence.
const findingSchema = {
  type: "object",
  required: ["slice", "claim", "evidence"],
  properties: {
    slice: { type: "string" },
    claim: { type: "string" },
    evidence: { type: "string" },
  },
};

// Scoped read-only lanes. read-only-review denies edit/shell/network/mcp, so a lane
// can read/glob/grep/list but cannot run commands, reach the network, or write.
const laneResults = await parallel(slices.map((slice) => async ({ agent }) =>
  agent(
    "Read-only slice \\"" + slice + "\\" for: " + question +
      ". Use only read/glob/grep/list. Return one claim with concrete evidence " +
      "(file:line or exact text). Say \\"unknown\\" rather than guess.",
    { role: "explorer", schema: findingSchema, label: "slice:" + slice },
  ),
));

// Pure-JS synthesis: no agent() call, zero extra slots. The controller already holds
// every validated lane result. Drop evidence-free claims into an honesty ledger.
const grounded = [];
const dropped = [];
for (const result of laneResults) {
  const hasEvidence = result && typeof result.evidence === "string" && result.evidence.trim().length > 0;
  if (hasEvidence) grounded.push(result);
  else if (result) dropped.push({ slice: result.slice, claim: result.claim, reason: "no evidence" });
}

return {
  question,
  slices,
  groundedFindings: grounded,
  droppedUnsupportedClaims: dropped,
  note: "First-run read-only slice. No edits, no domain mutation, no files written.",
};
`;

const DEFAULT_TEMPLATES = {
  "first-run-slice": FIRST_RUN_SLICE_TEMPLATE,
  "scoped-parallel": "export const meta = { name: \"scoped-parallel\", description: \"V2 scoped-helper parallel template\", maxAgents: 4 };\n\nconst items = args?.items ?? [\"one\", \"two\"];\nconst results = await parallel(items.map((item) => async ({ agent }) => {\n  return await agent(`Inspect ${item}`, { role: \"explorer\" });\n}));\n\nreturn { results };\n",
  "edit-review": `export const meta = { name: "edit-review", description: "V2 edit/apply template", authority: { edit: true }, maxAgents: 1 };\n\nreturn await agent("Prepare an edit plan", { role: "implementer", edit: true, schema: { type: "object", properties: { patches: { type: "array" } }, required: ["patches"] } });\n`,
};

function roleFileName(name) {
  if (typeof name !== "string" || !/^[a-z][a-z0-9-]{0,62}$/.test(name)) {
    throw new Error(`Invalid workflow role name: ${String(name)}`);
  }
  return `${name}.md`;
}

function roleManifestPath(roleDir = ROLE_DIR) {
  return path.join(roleDir, "manifest.json");
}

function roleDefaultsManifestPath(roleDir = ROLE_DIR) {
  return path.join(roleDir, "roles.json");
}

function isPlainObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function cloneJson(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

function normalizeStringList(value, label) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error(`${label} must be an array of non-empty strings`);
  const out = [];
  for (const item of value) {
    if (typeof item !== "string" || item.trim() === "") throw new Error(`${label} entries must be non-empty strings`);
    out.push(item.trim());
  }
  return [...new Set(out)];
}

function normalizePolicyDefaults(value, label) {
  if (value === undefined) return undefined;
  if (!isPlainObject(value)) throw new Error(`${label} must be an object`);
  const unknown = Object.keys(value).filter((key) => key !== "allow" && key !== "deny");
  if (unknown.length > 0) throw new Error(`${label} has unsupported key${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}`);
  const out = {};
  if (Object.hasOwn(value, "allow")) out.allow = normalizeStringList(value.allow, `${label}.allow`);
  if (Object.hasOwn(value, "deny")) out.deny = normalizeStringList(value.deny, `${label}.deny`);
  return out;
}

function normalizeToolDefaults(value, roleName) {
  if (value === undefined) return undefined;
  if (!isPlainObject(value)) throw new Error(`Role ${roleName} default tools must be an object`);
  const out = {};
  for (const [name, enabled] of Object.entries(value)) {
    if (typeof name !== "string" || name.trim() === "") throw new Error(`Role ${roleName} default tools has an empty tool name`);
    if (typeof enabled !== "boolean") throw new Error(`Role ${roleName} default tools.${name} must be a boolean`);
    out[name] = enabled;
  }
  return out;
}

function normalizeRoleDefaults(roleName, rawDefaults) {
  roleFileName(roleName);
  if (!isPlainObject(rawDefaults)) throw new Error(`Role ${roleName} defaults must be an object`);
  const unknown = Object.keys(rawDefaults).filter((key) => !ALLOWED_ROLE_DEFAULT_KEYS.has(key));
  if (unknown.length > 0) {
    throw new Error(
      `Unsupported role default option${unknown.length === 1 ? "" : "s"} for ${roleName}: ${unknown.join(", ")}. ` +
      `Allowed defaults: ${[...ALLOWED_ROLE_DEFAULT_KEYS].sort().join(", ")}.`,
    );
  }
  const defaults = {};
  if (Object.hasOwn(rawDefaults, "model")) {
    if (typeof rawDefaults.model !== "string" || rawDefaults.model.trim() === "") throw new Error(`Role ${roleName} default model must be a non-empty provider/model string`);
    defaults.model = rawDefaults.model.trim();
  }
  if (Object.hasOwn(rawDefaults, "tier")) {
    if (!VALID_TIERS.includes(rawDefaults.tier)) throw new Error(`Role ${roleName} default tier must be one of ${VALID_TIERS.join(", ")}`);
    defaults.tier = rawDefaults.tier;
  }
  if (Object.hasOwn(rawDefaults, "readOnly")) {
    if (typeof rawDefaults.readOnly !== "boolean") throw new Error(`Role ${roleName} default readOnly must be a boolean`);
    defaults.readOnly = rawDefaults.readOnly;
  }
  if (Object.hasOwn(rawDefaults, "retryCount")) {
    if (!Number.isInteger(rawDefaults.retryCount) || rawDefaults.retryCount < 0) throw new Error(`Role ${roleName} default retryCount must be a non-negative integer`);
    defaults.retryCount = rawDefaults.retryCount;
  }
  if (Object.hasOwn(rawDefaults, "correctiveRetries")) {
    if (!Number.isInteger(rawDefaults.correctiveRetries) || rawDefaults.correctiveRetries < 0) throw new Error(`Role ${roleName} default correctiveRetries must be a non-negative integer`);
    defaults.correctiveRetries = rawDefaults.correctiveRetries;
  }
  if (Object.hasOwn(rawDefaults, "timeoutMs")) {
    if (!Number.isInteger(rawDefaults.timeoutMs) || rawDefaults.timeoutMs <= 0 || rawDefaults.timeoutMs > MAX_CHILD_PROMPT_TIMEOUT_MS) {
      throw new Error(`Role ${roleName} default timeoutMs must be a positive integer no greater than ${MAX_CHILD_PROMPT_TIMEOUT_MS}`);
    }
    defaults.timeoutMs = rawDefaults.timeoutMs;
  }
  if (Object.hasOwn(rawDefaults, "tools")) defaults.tools = normalizeToolDefaults(rawDefaults.tools, roleName);
  if (Object.hasOwn(rawDefaults, "mcpPolicy")) defaults.mcpPolicy = normalizePolicyDefaults(rawDefaults.mcpPolicy, `Role ${roleName} default mcpPolicy`);
  if (Object.hasOwn(rawDefaults, "secretGlobs")) defaults.secretGlobs = normalizeStringList(rawDefaults.secretGlobs, `Role ${roleName} default secretGlobs`);
  if (Object.hasOwn(rawDefaults, "effort")) defaults.effort = normalizeLaneEffort(rawDefaults.effort);
  return defaults;
}

function roleDefaultsRoot(rawManifest) {
  if (rawManifest === undefined) return DEFAULT_ROLE_DEFAULTS.roles;
  if (!isPlainObject(rawManifest)) throw new Error("roles.json must contain an object");
  if (Object.hasOwn(rawManifest, "roles")) {
    const extra = Object.keys(rawManifest).filter((key) => key !== "roles");
    if (extra.length > 0) throw new Error(`roles.json has unsupported top-level key${extra.length === 1 ? "" : "s"}: ${extra.join(", ")}`);
    if (!isPlainObject(rawManifest.roles)) throw new Error("roles.json `roles` must be an object");
    return rawManifest.roles;
  }
  return rawManifest;
}

function normalizeRoleDefaultsManifest(rawManifest) {
  const roles = {};
  for (const [roleName, rawDefaults] of Object.entries(roleDefaultsRoot(rawManifest))) {
    roles[roleName] = normalizeRoleDefaults(roleName, rawDefaults);
  }
  return roles;
}

async function ensureRoleDefaultsManifest(roleDir = ROLE_DIR) {
  const filePath = roleDefaultsManifestPath(roleDir);
  try {
    await fs.access(filePath);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    await writeJsonAtomic(filePath, DEFAULT_ROLE_DEFAULTS);
  }
}

async function loadRoleDefaultsManifest(roleDir = ROLE_DIR, options = {}) {
  if (options.ensureDefault === true) await ensureRoleDefaultsManifest(roleDir);
  const filePath = roleDefaultsManifestPath(roleDir);
  const rawManifest = await readJsonFile(filePath, DEFAULT_ROLE_DEFAULTS);
  return normalizeRoleDefaultsManifest(rawManifest);
}

function mergeRoleDefaults(defaults = {}, explicitOpts = {}) {
  if (!defaults || Object.keys(defaults).length === 0) return { ...explicitOpts };
  return { ...cloneJson(defaults), ...explicitOpts };
}

async function ensureRoleFiles(roleDir = ROLE_DIR) {
  await fs.mkdir(roleDir, { recursive: true });
  const manifestPath = roleManifestPath(roleDir);
  const manifest = await readJsonFile(manifestPath, { roles: {} });
  let changed = false;
  for (const [name, content] of Object.entries(DEFAULT_ROLES)) {
    const filePath = path.join(roleDir, roleFileName(name));
    const shippedHash = hash(content);
    let current;
    try {
      current = await fs.readFile(filePath, "utf8");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      await fs.writeFile(filePath, content, "utf8");
      manifest.roles[name] = { shippedHash, currentHash: shippedHash, updatedAt: new Date().toISOString() };
      changed = true;
      continue;
    }
    const currentHash = hash(current);
    const previous = manifest.roles[name];
    if (!previous || previous.currentHash === previous.shippedHash) {
      if (currentHash !== shippedHash) {
        manifest.roles[name] = { shippedHash, currentHash, userModified: true, updatedAt: new Date().toISOString() };
      } else {
        manifest.roles[name] = { shippedHash, currentHash, updatedAt: previous?.updatedAt ?? new Date().toISOString() };
      }
      changed = true;
    }
  }
  if (changed) await writeJsonAtomic(manifestPath, manifest);
  await ensureRoleDefaultsManifest(roleDir);
  return manifest;
}

async function resolveRole(roleName, roleDir = ROLE_DIR) {
  if (!roleName) return undefined;
  const manifest = await ensureRoleFiles(roleDir);
  const defaults = await loadRoleDefaultsManifest(roleDir);
  const filePath = path.join(roleDir, roleFileName(roleName));
  const content = await fs.readFile(filePath, "utf8");
  const contentHash = hash(content);
  const shippedHash = DEFAULT_ROLES[roleName] ? hash(DEFAULT_ROLES[roleName]) : manifest.roles?.[roleName]?.shippedHash;
  return {
    name: roleName,
    filePath,
    content,
    contentHash,
    shippedHash,
    userModified: shippedHash ? contentHash !== shippedHash : undefined,
    defaults: defaults[roleName] ? cloneJson(defaults[roleName]) : {},
  };
}

async function listRoles(args = {}, options = {}) {
  const roleDir = options.roleDir || args.roleDir || ROLE_DIR;
  const defaults = await loadRoleDefaultsManifest(roleDir);
  const dirNames = [];
  try {
    for (const dirent of await fs.readdir(roleDir, { withFileTypes: true })) {
      if (dirent.isFile() && dirent.name.endsWith(".md")) dirNames.push(dirent.name.replace(/\.md$/, ""));
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const names = [
    ...Object.keys(DEFAULT_ROLES),
    ...Object.keys(defaults).filter((name) => !Object.hasOwn(DEFAULT_ROLES, name)).sort(),
    ...dirNames.filter((name) => !Object.hasOwn(DEFAULT_ROLES, name) && !Object.hasOwn(defaults, name)).sort(),
  ];
  const entries = [];
  for (const name of names) {
    const filePath = path.join(roleDir, roleFileName(name));
    let content = DEFAULT_ROLES[name];
    let exists = false;
    try {
      content = await fs.readFile(filePath, "utf8");
      exists = true;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    const shippedHash = DEFAULT_ROLES[name] ? hash(DEFAULT_ROLES[name]) : undefined;
    const contentHash = typeof content === "string" ? hash(content) : undefined;
    entries.push({
      name,
      filePath,
      exists,
      contentHash,
      shippedHash,
      userModified: shippedHash ? contentHash !== shippedHash : undefined,
      defaults: defaults[name] ? cloneJson(defaults[name]) : {},
    });
  }
  if (args.format === "json") return JSON.stringify(entries, null, 2);
  return entries.map((entry) => {
    const provenance = entry.shippedHash ? (entry.userModified ? "user-modified" : "shipped") : "custom";
    const defaultsSummary = Object.keys(entry.defaults).length > 0 ? ` defaults=${JSON.stringify(entry.defaults)}` : "";
    const contentHash = entry.contentHash ? entry.contentHash.slice(0, 12) : "no-prompt";
    return `${entry.name} ${contentHash} ${provenance}${entry.exists ? "" : " default-not-written"}${defaultsSummary} ${entry.filePath}`;
  }).join("\n");
}

async function listTemplates(args = {}) {
  const entries = [];
  for (const [name, source] of Object.entries(DEFAULT_TEMPLATES)) {
    if (args.template && args.template !== name) continue;
    const entry = {
      name,
      filePath: path.join(TEMPLATE_DIR, workflowFileName(name)),
      sourceHash: hash(source),
      byteLength: Buffer.byteLength(source, "utf8"),
      lineCount: source.split(/\r\n|\r|\n/).length,
    };
    if (args.includeSource === true) entry.source = source;
    entries.push(entry);
  }
  if (args.template && entries.length === 0) throw new Error(`Unknown workflow template: ${args.template}`);
  if (args.format === "json") return JSON.stringify(entries, null, 2);
  return entries.map((entry) => {
    const lines = [`${entry.name} ${entry.sourceHash.slice(0, 12)} ${entry.lineCount} lines ${entry.byteLength} bytes ${entry.filePath}`];
    if (args.includeSource === true) lines.push(entry.source);
    return lines.join("\n");
  }).join("\n");
}

async function saveTemplate(context, args) {
  assertWriteWorkflowAllowed(context, "workflow_template_save");
  const source = DEFAULT_TEMPLATES[args.template];
  if (!source) throw new Error(`Unknown workflow template: ${args.template}`);
  return await saveWorkflow(context, {
    name: args.name || args.template,
    source,
    scope: args.scope || "project",
    overwrite: args.overwrite,
    globalScopeIntent: args.globalScopeIntent,
  });
}

async function saveWorkflow(context, args) {
  assertWriteWorkflowAllowed(context, "workflow_save");
  if (!args.source || typeof args.source !== "string") throw new Error("workflow_save requires `source`");
  const scope = args.scope || "project";
  if (scope === "global" && args.globalScopeIntent !== "save-global-workflow") {
    throw new Error("workflow_save global scope requires globalScopeIntent: \"save-global-workflow\"");
  }
  if (Buffer.byteLength(args.source, "utf8") > MAX_SOURCE_BYTES) {
    throw new Error(`Workflow source exceeds ${MAX_SOURCE_BYTES} bytes`);
  }
  parseWorkflowSource(args.source);

  const directory = scope === "project" ? projectWorkflowDir(context) : GLOBAL_WORKFLOW_DIR;
  const filePath = path.join(directory, workflowFileName(args.name));
  await fs.mkdir(directory, { recursive: true });

  try {
    await fs.access(filePath);
    if (args.overwrite !== true) {
      throw new Error(`Workflow already exists: ${filePath}. Pass overwrite: true to replace it.`);
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }

  await fs.writeFile(filePath, args.source, "utf8");
  return [`Saved workflow ${args.name}.`, `Path: ${filePath}`, `sourceHash: ${hash(args.source)}`].join("\n");
}

// Curated, built-in invocation hints for BUNDLED workflows only. This is the single place
// where example args / category / notes that are not read verbatim from a workflow's own
// `meta` are attached. Keyed by workflow name and applied only to the bundled scope so a
// same-named saved/global workflow never inherits curated examples it did not declare.
// Curated per-workflow invocation hints (keyed by workflow name), merged over a workflow's own
// meta in workflow_list. Domain-specific workflows supply their examples via their own meta.examples;
// this stays empty in the core kernel (no bundled domain workflows).
const CURATED_INVOCATION_HINTS = {};

const MAX_INVOCATION_EXAMPLES = 4;

// Only accept example args that are explicit, plain JSON objects. redactValue bounds depth,
// string length, and array width and masks sensitive keys, so a malformed or oversized
// `meta.examples` entry can never leak secrets or blow up the listing.
function sanitizeArgsExamples(rawExamples) {
  if (!Array.isArray(rawExamples)) return [];
  const out = [];
  for (const item of rawExamples) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const candidateArgs = item.args;
    if (!candidateArgs || typeof candidateArgs !== "object" || Array.isArray(candidateArgs)) continue;
    const example = { args: redactValue(candidateArgs, { maxDepth: 4 }) };
    if (typeof item.label === "string") example.label = truncateText(item.label, 120);
    out.push(example);
    if (out.length >= MAX_INVOCATION_EXAMPLES) break;
  }
  return out;
}

// jbs3.10: render a one-line, human-readable summary of a workflow's declared meta.argsSchema so
// `workflow_list` advertises the args contract (which keys are accepted, which are required) without
// dumping the whole schema. Returns undefined when no usable object schema is declared.
function summarizeArgsSchema(schema) {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return undefined;
  const properties = schema.properties && typeof schema.properties === "object" && !Array.isArray(schema.properties)
    ? schema.properties
    : undefined;
  const required = new Set(Array.isArray(schema.required) ? schema.required.filter((k) => typeof k === "string") : []);
  if (!properties) {
    // No property map (e.g. a bare type constraint); still surface the declared top-level type.
    return typeof schema.type === "string" ? `type=${schema.type}` : "declared";
  }
  const fields = Object.keys(properties).slice(0, 16).map((key) => {
    const propType = properties[key] && typeof properties[key].type === "string" ? properties[key].type : undefined;
    const label = propType ? `${key}:${propType}` : key;
    return required.has(key) ? `${label}*` : label;
  });
  if (fields.length === 0) return schema.additionalProperties === false ? "{} (no args)" : "declared";
  return `{ ${fields.join(", ")} }${Object.keys(properties).length > fields.length ? " …" : ""} (*=required)`;
}

function renderRunExample(name, argsExample) {
  const parts = [`workflow_run name=${JSON.stringify(name)}`];
  if (argsExample && argsExample.args && Object.keys(argsExample.args).length > 0) {
    parts.push(`args=${truncateText(JSON.stringify(argsExample.args), 200)}`);
  }
  return parts.join(" ");
}

// Build runnable invocation metadata for one workflow entry. Only explicit `meta` fields
// (examples/category/notes/modelTiers) and the curated bundled defaults above are surfaced;
// nothing is inferred from the workflow body.
function buildInvocationMetadata(entry, meta) {
  const curated = entry.scope === "bundled" ? CURATED_INVOCATION_HINTS[entry.name] : undefined;
  // Explicit meta.examples win over curated defaults; never infer args from the source body.
  let argsExamples = sanitizeArgsExamples(meta.examples);
  if (argsExamples.length === 0 && curated) argsExamples = sanitizeArgsExamples(curated.argsExamples);
  const category = typeof meta.category === "string" ? truncateText(meta.category, 80) : curated?.category;
  const notes = typeof meta.notes === "string" ? truncateText(meta.notes, 240) : curated?.notes;
  const runExamples = argsExamples.length > 0
    ? argsExamples.map((example) => renderRunExample(entry.name, example))
    : [renderRunExample(entry.name)];
  const defaultModel = entry.childModel;
  const modelTier = {
    default: defaultModel,
    fast: (meta.modelTiers && typeof meta.modelTiers.fast === "string") ? meta.modelTiers.fast : defaultModel,
    deep: (meta.modelTiers && typeof meta.modelTiers.deep === "string") ? meta.modelTiers.deep : defaultModel,
  };
  const nextSteps = [
    "workflow_status detail=compact   # poll run progress",
    "workflow_status detail=result    # read redacted lane results after completion",
  ];
  if (entry.authority?.editGate && entry.authority.editGate !== "not-requested") {
    nextSteps.push("workflow_apply                   # approve staged writes before they land");
  }
  const invocation = {
    category,
    profile: entry.authority?.profile || AD_HOC_AUTHORITY_PROFILE,
    authorityMode: entry.authority?.mode,
    maxAgents: entry.maxAgents ?? null,
    concurrency: entry.concurrency ?? null,
    modelTier,
    runExamples,
    argsExamples,
    nextSteps,
  };
  if (notes) invocation.notes = notes;
  return invocation;
}

// `sessionModel` is the invoking session's resolved model (provider/model) or null. It is the
// display fallback for a workflow that declares no childModel/defaultChildModel: the child default
// is "whatever the session is on at run time". When the session model is unreadable this stays
// null (the listing surfaces no model rather than substituting a hard-coded one).
async function listWorkflows(context, args = {}, sessionModel = null, extensionWorkflowDirs = []) {
  const dirs = [
    { scope: "project", directory: projectWorkflowDir(context) },
    { scope: "global", directory: GLOBAL_WORKFLOW_DIR },
    ...extensionWorkflowDirs.map((directory) => ({ scope: "extension", directory })),
    { scope: "bundled", directory: BUNDLED_WORKFLOW_DIR },
  ];
  const entries = [];
  for (const { scope, directory } of dirs) {
    if (!(await pathExists(directory))) continue;
    const dirents = await fs.readdir(directory, { withFileTypes: true });
    for (const dirent of dirents) {
      if (!dirent.isFile() || !dirent.name.endsWith(".js")) continue;
      const sourcePath = path.join(directory, dirent.name);
      try {
        const source = await fs.readFile(sourcePath, "utf8");
        const { meta } = parseWorkflowSource(source);
        const authority = resolveRunAuthority(meta, {});
        const entry = {
          name: dirent.name.replace(/\.js$/, ""),
          scope,
          sourcePath,
          sourceHash: hash(source),
          description: meta.description,
          phases: meta.phases,
          maxAgents: meta.maxAgents,
          concurrency: meta.concurrency,
          childModel: meta.childModel || meta.defaultChildModel || sessionModel || null,
          authority,
        };
        entry.invocation = buildInvocationMetadata(entry, meta);
        const argsShape = summarizeArgsSchema(meta.argsSchema);
        if (argsShape) {
          entry.argsSchema = redactValue(meta.argsSchema, { maxDepth: 4 });
          entry.invocation.argsShape = argsShape;
        }
        entries.push(entry);
      } catch (error) {
        entries.push({ name: dirent.name.replace(/\.js$/, ""), scope, sourcePath, status: "malformed", error: extractTextFromError(error) });
      }
    }
  }
  entries.sort((a, b) => `${a.scope}:${a.name}`.localeCompare(`${b.scope}:${b.name}`));
  if (args.format === "json") return JSON.stringify(entries, null, 2);
  if (entries.length === 0) return "No saved workflows found.";
  return entries.map((entry) => {
    if (entry.status === "malformed") return `${entry.scope}/${entry.name} malformed: ${truncateText(entry.error, 160)}`;
    const lines = [`${entry.scope}/${entry.name} ${entry.sourceHash.slice(0, 12)} ${entry.description || "no description"} authority=${authoritySummary(entry.authority)}`];
    const inv = entry.invocation;
    if (inv) {
      if (inv.category) lines.push(`  category: ${inv.category}`);
      if (inv.argsShape) lines.push(`  args: ${truncateText(inv.argsShape, 200)}`);
      lines.push(`  run: ${inv.runExamples[0]}`);
      for (const extra of inv.runExamples.slice(1)) lines.push(`       ${extra}`);
      lines.push(`  profile=${inv.profile} maxAgents=${inv.maxAgents ?? "default"} concurrency=${inv.concurrency ?? "default"} model=${inv.modelTier.default} fast=${inv.modelTier.fast} deep=${inv.modelTier.deep}`);
      lines.push(`  next: ${inv.nextSteps.join(" | ")}`);
      if (inv.notes) lines.push(`  notes: ${truncateText(inv.notes, 160)}`);
    }
    return lines.join("\n");
  }).join("\n");
}

export {
  ROLE_MANIFEST,
  ROLE_DEFAULTS_MANIFEST,
  DEFAULT_ROLES,
  DEFAULT_ROLE_DEFAULTS,
  ALLOWED_ROLE_DEFAULT_KEYS,
  DEFAULT_TEMPLATES,
  roleFileName,
  roleManifestPath,
  roleDefaultsManifestPath,
  ensureRoleFiles,
  loadRoleDefaultsManifest,
  normalizeRoleDefaults,
  normalizeRoleDefaultsManifest,
  mergeRoleDefaults,
  resolveRole,
  listRoles,
  listTemplates,
  saveTemplate,
  saveWorkflow,
  listWorkflows,
};
