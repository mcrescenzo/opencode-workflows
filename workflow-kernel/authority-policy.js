import { SECRET_GLOBS } from "./constants.js";
import { WorkflowAuthorityError } from "./errors.js";
import { redactValue } from "./text-json.js";
import { auditedShellPermissionPatterns } from "./audited-shell-policy.js";

export const AD_HOC_AUTHORITY_PROFILE = "ad-hoc";
export const AUTO_APPROVE_TIERS = Object.freeze(["readOnly", "worktree", "all"]);
const AUTO_APPROVE_TIER_RANK = Object.freeze({ readOnly: 1, worktree: 2, all: 3 });
const AUTO_APPROVE_TIER_BY_RANK = Object.freeze({ 1: "readOnly", 2: "worktree", 3: "all" });
export const WORKFLOW_AUTHORITY_PROFILES = Object.freeze({
  "read-only-review": Object.freeze({
    authority: Object.freeze({ readOnly: true }),
  }),
  "inspect-with-shell": Object.freeze({
    authority: Object.freeze({ readOnly: true, shell: true }),
  }),
  "drain-dry-run": Object.freeze({
    authority: Object.freeze({ readOnly: true }),
  }),
  "drain-autonomous-local": Object.freeze({
    authority: Object.freeze({ integration: true, network: false, mcp: false }),
  }),
  "edit-plan-only": Object.freeze({
    authority: Object.freeze({ worktreeEdit: true }),
  }),
  "apply-approved-plan": Object.freeze({
    authority: Object.freeze({ edit: true }),
  }),
});

export function normalizeAutoApproveTier(value) {
  return AUTO_APPROVE_TIERS.includes(value) ? value : false;
}

export function autoApproveTierRank(value) {
  const tier = normalizeAutoApproveTier(value);
  return tier ? AUTO_APPROVE_TIER_RANK[tier] : 0;
}

export function authorityAutoApproveTier(authority = {}) {
  if (authority.integration || authority.network || authority.mcp) return "all";
  if (authority.edit || authority.worktreeEdit) return "worktree";
  return "readOnly";
}

// Rendered into every child lane's system prompt so a lane knows its tool
// ceiling up front instead of discovering it through permission denials.
export function laneAuthorityInstruction(authority = {}) {
  const granted = [];
  const denied = [];
  if (authority.edit) granted.push("edit");
  else if (authority.worktreeEdit) granted.push("worktree edit (isolated worktree only)");
  else denied.push("edit");
  if (authority.shell) granted.push("shell");
  else denied.push("shell");
  if (authority.network) granted.push("network");
  else denied.push("network");
  if (authority.mcp) granted.push("mcp");
  else denied.push("mcp");
  // Integration is enforced only for edit-capable lanes (resolveLanePolicy strips it from the
  // permission ruleset otherwise) — never advertise a grant the ruleset will deny.
  if (authority.integration && (authority.edit || authority.worktreeEdit)) granted.push("integration");
  const grantText = granted.length ? `read/search plus ${granted.join(", ")}` : "read/search only";
  const denyText = denied.length
    ? ` Not permitted: ${denied.join(", ")} — such tool calls are denied by policy; do not retry them.`
    : "";
  return `Lane authority: ${grantText}.${denyText}`;
}

export function effectiveAutoApproveCeiling(configured, requested) {
  const configuredRank = autoApproveTierRank(configured);
  if (configuredRank <= 0) return false;
  if (requested === undefined || requested === null) return AUTO_APPROVE_TIER_BY_RANK[configuredRank] ?? false;
  const requestedRank = autoApproveTierRank(requested);
  if (requestedRank <= 0) return false;
  return AUTO_APPROVE_TIER_BY_RANK[Math.min(configuredRank, requestedRank)] ?? false;
}

export function autoApproveCovers(ceiling, tier) {
  const ceilingRank = autoApproveTierRank(ceiling);
  const tierRank = autoApproveTierRank(tier);
  return ceilingRank > 0 && tierRank > 0 && ceilingRank >= tierRank;
}
export const OPENCODE_CHILD_TOOL_IDS = Object.freeze([
  "oc_child_start",
  "oc_child_status",
  "oc_child_stop",
  "oc_child_restart",
  "oc_session_create",
  "oc_prompt",
  "oc_inspect",
  "oc_events",
  "oc_command",
  "oc_shell",
  "oc_permission",
  "oc_plugin_smoke_test",
]);

export const OPENCODE_CHILD_PERMISSION_KEYS = Object.freeze([
  "opencode-child.start",
  "opencode-child.status",
  "opencode-child.stop",
  "opencode-child.stop.registry-pid-signal",
  "opencode-child.restart",
  "opencode-child.command",
  "opencode-child.shell",
  "opencode-child.permission",
]);

export const WORKFLOW_INSPECT_TOOLS = [
  "workflow_status",
  "workflow_events",
  "workflow_list",
  "workflow_roles",
  "workflow_templates",
];
export const WORKFLOW_MUTATING_TOOLS = [
  "workflow_run",
  "workflow_cancel",
  "workflow_pause",
  "workflow_reconcile",
  "workflow_save",
  "workflow_cleanup",
  "workflow_apply",
  "workflow_template_save",
  "workflow_salvage",
];
export const WORKFLOW_TOOLS = [...WORKFLOW_INSPECT_TOOLS, ...WORKFLOW_MUTATING_TOOLS];

export function parseModel(model) {
  if (!model) return undefined;
  if (typeof model === "object" && model.providerID && (model.modelID || model.id)) {
    return { providerID: String(model.providerID), modelID: String(model.modelID ?? model.id) };
  }
  if (typeof model !== "string") return undefined;
  const slash = model.indexOf("/");
  if (slash <= 0 || slash === model.length - 1) return undefined;
  return { providerID: model.slice(0, slash), modelID: model.slice(slash + 1) };
}

export function modelKey(model) {
  if (!model) return undefined;
  if (typeof model === "string") return model;
  return `${model.providerID}/${model.modelID}`;
}

export function allowTools(permission, tools) {
  if (!permission || typeof permission !== "object" || Array.isArray(permission)) return;
  for (const name of tools) permission[name] = "allow";
}

export function denyTools(permission, tools) {
  if (!permission || typeof permission !== "object" || Array.isArray(permission)) return;
  for (const name of tools) permission[name] = "deny";
}

export function configureWorkflowPermissions(cfg) {
  if (!cfg.permission) cfg.permission = {};
  allowTools(cfg.permission, WORKFLOW_TOOLS);

  cfg.agent = cfg.agent ?? {};
  for (const [name, agent] of Object.entries(cfg.agent)) {
    if (!agent || typeof agent !== "object") continue;
    if (name !== "build" && name !== "plan") continue;
    if (!agent.permission) agent.permission = {};
    if (name === "build") allowTools(agent.permission, WORKFLOW_TOOLS);
    if (name === "plan") {
      allowTools(agent.permission, WORKFLOW_INSPECT_TOOLS);
      denyTools(agent.permission, WORKFLOW_MUTATING_TOOLS);
    }
  }
}

export function assertWriteWorkflowAllowed(context, toolName) {
  if (context?.agent === "plan") {
    throw new WorkflowAuthorityError(`${toolName} is not available in plan mode`);
  }
}

export function resolveRequestedModel(model, label) {
  if (!model) return undefined;
  const parsed = parseModel(model);
  if (!parsed) throw new Error(`Invalid ${label} model. Expected provider/model, got: ${String(model)}`);
  return parsed;
}

export const VALID_TIERS = ["fast", "deep"];

// Resolve a lane's model string BEFORE provider/model validation.
// Precedence: explicit opts.model > run.modelTiers[tier] > run.defaultChildModel.
// A declared tier with no map entry degrades to the run default (the session model),
// so legacy lanes (no tier, no model) behave exactly as before.
export function resolveLaneModel(run, opts = {}) {
  if (typeof opts.model === "string" && opts.model.length > 0) return opts.model;
  const tier = opts.tier;
  if (tier !== undefined) {
    if (!VALID_TIERS.includes(tier)) {
      throw new Error(`Invalid lane tier: ${String(tier)}. Expected one of ${VALID_TIERS.join(", ")}.`);
    }
    const mapped = run.modelTiers && run.modelTiers[tier];
    if (typeof mapped === "string" && mapped.length > 0) return mapped;
  }
  return run.defaultChildModel;
}

// The complete set of keys an agent() / parallel-thunk / pipeline-stage opts object may declare.
// Anything else is a typo (e.g. `onFailur` for `onFailure`, `readonly` for `readOnly`) that would
// otherwise be silently dropped and leave the lane running with unintended defaults — most
// dangerously a write/edit/network toggle that never takes effect, or an `onFailure` swallow that
// silently turns into a hard run failure. Keep this in lock-step with every opts consumer:
//   - resolveLaneModel:        model, tier
//   - computeLaneAuthority:    readOnly, edit, allowEdits, worktreeEdit, shell, allowShell,
//                              network, allowNetwork, mcp, allowMcp, mcpPolicy, tools, secretGlobs
  //   - runChildAgent:           agent, agentType, role, effort, retryCount, correctiveRetries, schema,
//                              timeoutMs, system, onFailure
//   - laneTaskSummary:         taskSummary, summary, label, title
//   - sandbox phase tagging:   phase, label (stripped by normalizeAgentOptions below)
export const ALLOWED_AGENT_OPTION_KEYS = new Set([
  "model", "tier",
  "readOnly", "edit", "allowEdits", "worktreeEdit",
  "shell", "allowShell", "network", "allowNetwork", "mcp", "allowMcp", "mcpPolicy",
  "tools", "secretGlobs",
  "agent", "agentType", "role", "effort", "retryCount", "correctiveRetries", "schema", "timeoutMs", "system", "onFailure",
  "taskSummary", "summary", "label", "title", "phase",
]);

// Reject unknown agent() option keys so a misspelled opt fails loudly at run time instead of being
// silently ignored. Strictly additive safety: it narrows nothing about a VALID opts object, it only
// rejects keys no consumer reads. Authority is still capped downstream by computeLaneAuthority.
export function assertKnownAgentOptions(opts = {}) {
  if (!opts || typeof opts !== "object" || Array.isArray(opts)) return;
  const unknown = Object.keys(opts).filter((key) => !ALLOWED_AGENT_OPTION_KEYS.has(key));
  if (unknown.length > 0) {
    throw new WorkflowAuthorityError(
      `Unknown agent() option${unknown.length > 1 ? "s" : ""}: ${unknown.join(", ")}. ` +
      `Allowed options: ${[...ALLOWED_AGENT_OPTION_KEYS].sort().join(", ")}.`,
    );
  }
}

export function normalizeAgentOptions(opts = {}) {
  assertKnownAgentOptions(opts);
  const normalized = { ...opts };
  delete normalized.label;
  delete normalized.phase;
  return normalized;
}

export function normalizePatternList(value, label) {
  const values = value === undefined ? [] : Array.isArray(value) ? value : [value];
  const normalized = [];
  for (const item of values) {
    if (typeof item !== "string" || item.trim() === "") {
      throw new WorkflowAuthorityError(`${label} entries must be non-empty strings`);
    }
    normalized.push(item.trim());
  }
  return [...new Set(normalized)];
}

export function resolveShellPolicy(declaredShell, full = false) {
  if (declaredShell && typeof declaredShell === "object" && !Array.isArray(declaredShell)) {
    const allow = normalizePatternList(declaredShell.allow, "shell.allow");
    return {
      allow: allow.length > 0 ? allow : full ? ["*"] : [],
      deny: normalizePatternList(declaredShell.deny, "shell.deny"),
    };
  }
  if (declaredShell === true || full) return { allow: ["*"], deny: [] };
  return { allow: [], deny: [] };
}

export function shellPolicyForAuthority(authority) {
  if (authority?.shellPolicy) {
    return {
      allow: normalizePatternList(authority.shellPolicy.allow, "shell.allow"),
      deny: normalizePatternList(authority.shellPolicy.deny, "shell.deny"),
    };
  }
  return { allow: authority?.shell ? ["*"] : [], deny: [] };
}

export function resolveMcpPolicy(declaredMcp, full = false) {
  if (declaredMcp && typeof declaredMcp === "object" && !Array.isArray(declaredMcp)) {
    const allow = normalizePatternList(declaredMcp.allow, "mcp.allow");
    return {
      allow: allow.length > 0 ? allow : full ? ["*"] : [],
      deny: normalizePatternList(declaredMcp.deny, "mcp.deny"),
    };
  }
  if (declaredMcp === true || full) return { allow: ["*"], deny: [] };
  return { allow: [], deny: [] };
}

export function mcpPolicyForAuthority(authority) {
  if (authority?.mcpPolicy) {
    return {
      allow: normalizePatternList(authority.mcpPolicy.allow, "mcp.allow"),
      deny: normalizePatternList(authority.mcpPolicy.deny, "mcp.deny"),
    };
  }
  return { allow: authority?.mcp ? ["*"] : [], deny: [] };
}

function wildcardPatternToRegExp(pattern) {
  let regex = "^";
  for (const char of String(pattern)) {
    if (char === "*") regex += ".*";
    else if (char === "?") regex += ".";
    else regex += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  regex += "$";
  return new RegExp(regex);
}

function policyAllowsPattern(parentPolicy, pattern) {
  return parentPolicy.allow.some((parentPattern) => {
    if (parentPattern === "*" || parentPattern === pattern) return true;
    if (!pattern.includes("*") && !pattern.includes("?")) {
      return wildcardPatternToRegExp(parentPattern).test(pattern);
    }
    const firstWildcard = parentPattern.search(/[*?]/);
    if (firstWildcard < 0) return false;
    const prefix = parentPattern.slice(0, firstWildcard);
    const suffix = parentPattern.slice(firstWildcard + 1);
    return suffix === "" && pattern.startsWith(prefix);
  });
}

export function narrowMcpPolicy(parentPolicy, declaredMcpPolicy = {}) {
  const parent = {
    allow: normalizePatternList(parentPolicy?.allow, "mcp.allow"),
    deny: normalizePatternList(parentPolicy?.deny, "mcp.deny"),
  };
  const declared = declaredMcpPolicy && typeof declaredMcpPolicy === "object" && !Array.isArray(declaredMcpPolicy)
    ? declaredMcpPolicy
    : {};
  const allow = Object.hasOwn(declared, "allow")
    ? normalizePatternList(declared.allow, "mcp.allow")
    : parent.allow;
  for (const pattern of allow) {
    if (!policyAllowsPattern(parent, pattern)) {
      throw new WorkflowAuthorityError(`Lane mcpPolicy allow pattern "${pattern}" exceeds approved workflow mcpPolicy`);
    }
  }
  return {
    allow,
    deny: [...new Set([...parent.deny, ...normalizePatternList(declared.deny, "mcp.deny")])],
  };
}

export function resolveAuthorityProfile(meta = {}, args = {}) {
  const profileName = args.profile ?? meta.profile ?? meta.authorityProfile ?? meta.authority?.profile ?? AD_HOC_AUTHORITY_PROFILE;
  if (profileName === AD_HOC_AUTHORITY_PROFILE) return { name: profileName, authority: {} };
  const profile = WORKFLOW_AUTHORITY_PROFILES[profileName];
  if (!profile) throw new WorkflowAuthorityError(`Unknown workflow authority profile: ${profileName}`);
  return { name: profileName, authority: profile.authority };
}

export function resolveRunAuthority(meta = {}, args = {}) {
  const profile = resolveAuthorityProfile(meta, args);
  const declared = {
    ...profile.authority,
    ...(typeof meta.authority === "object" && meta.authority ? meta.authority : {}),
    ...(typeof args.authority === "object" && args.authority ? args.authority : {}),
  };
  delete declared.profile;
  for (const key of ["readOnly", "shell", "network", "mcp", "mcpPolicy", "edit", "worktreeEdit", "integration"] ) {
    if (Object.hasOwn(meta, key)) declared[key] = meta[key];
  }
  // Precedence for the shell policy:
  //   1. An explicit caller-supplied shell object (authority.shell = { allow, deny }) wins — it is
  //      a deliberate per-run override and is honored verbatim via resolveShellPolicy's object branch.
  //   2. Otherwise, when the profile is inspect-with-shell, the audited command-scoped allowlist +
  //      denylist is enforced as the runtime permission ruleset (opencode-workflows-public-inspect-
  //      shell-scope). This keeps shell:true (the lane gets the bash tool) but narrows it to the
  //      documented read-only inspection commands, denying chaining/mutation/network at the rule level.
  //   3. Otherwise the legacy behavior applies (["*"] when shell/full, else []).
  const explicitShellOverride = declared.shell && typeof declared.shell === "object" && !Array.isArray(declared.shell);
  const shellPolicy = (profile.name === "inspect-with-shell" && !explicitShellOverride)
    ? auditedShellPermissionPatterns()
    : resolveShellPolicy(declared.shell, declared.full === true);
  const mcpPolicy = resolveMcpPolicy(declared.mcpPolicy ?? declared.mcp, declared.full === true);
  const authority = {
    readOnly: declared.readOnly !== false && declared.full !== true,
    shell: shellPolicy.allow.length > 0,
    shellPolicy,
    network: declared.network === true || declared.full === true,
    mcp: mcpPolicy.allow.length > 0,
    mcpPolicy,
    edit: declared.edit === true,
    worktreeEdit: declared.worktreeEdit === true,
    integration: declared.integration === true,
    profile: profile.name,
  };
  authority.mode = authority.integration ? "integrationMode" : authority.edit || authority.worktreeEdit ? "editMode" : authority.readOnly ? "readOnly" : "full";
  authority.editGate = authority.edit || authority.worktreeEdit || authority.integration ? "requires workflow_apply approval before primary writes" : "not-requested";
  return authority;
}

const DRAIN_PROFILE_FOR_MODE = Object.freeze({ "dry-run": "drain-dry-run", "autonomous-local": "drain-autonomous-local" });
const DRAIN_MODE_FOR_PROFILE = Object.freeze({ "drain-dry-run": "dry-run", "drain-autonomous-local": "autonomous-local" });

// Canonicalize a drain-harness invocation into one consistent form, so the approval hash, resolved
// authority, background default, and the workflow body all agree. Reconciles a top-level authority
// `profile` with args.mode (rejecting conflicts), injects the mode-appropriate profile
// (drain-dry-run | drain-autonomous-local), and writes the resolved mode back into args.args.mode.
// Non-drain workflows pass through untouched. Generic over any meta.harness==="drain" workflow.
export function authorityArgsForWorkflow(meta = {}, args = {}) {
  if (meta.harness !== "drain") return args;
  let rawRuntime = args.args;
  // Tolerate a JSON-encoded string emitted by a model under a permissive tool schema: parse it once
  // into an object so the agent can reach the preview/launch path instead of being rejected. A
  // non-JSON string, or a non-string non-object (array/boolean/number), still falls through to the
  // rejection below. This is a normalization at the authority edge only; the script-body scope guard
  // in a drain workflow is preserved unchanged (it guards the sharper risk of a string scope spreading
  // into a char-indexed unfiltered drain).
  if (typeof rawRuntime === "string" && rawRuntime.trim() !== "") {
    try {
      rawRuntime = JSON.parse(rawRuntime);
    } catch {
      // leave rawRuntime as the original string so the type check below rejects it
    }
  }
  if (rawRuntime !== undefined && rawRuntime !== null && (typeof rawRuntime !== "object" || Array.isArray(rawRuntime))) {
    throw new WorkflowAuthorityError('drain workflow args must be a JSON object when provided; omit args or pass {"mode":"dry-run"} or {"mode":"autonomous-local"}');
  }
  const runtimeArgs = rawRuntime && typeof rawRuntime === "object" && !Array.isArray(rawRuntime) ? rawRuntime : {};
  const hasExplicitMode = Object.hasOwn(runtimeArgs, "mode") || Object.hasOwn(runtimeArgs, "dryRun");
  const modeFromArgs = hasExplicitMode ? resolveDrainMode(runtimeArgs) : undefined;
  const profile = args.profile;
  if (profile !== undefined && !Object.hasOwn(DRAIN_MODE_FOR_PROFILE, profile)) {
    throw new WorkflowAuthorityError(`drain workflow profile must be "drain-dry-run" or "drain-autonomous-local"; got "${String(profile)}"`);
  }
  const modeFromProfile = profile !== undefined ? DRAIN_MODE_FOR_PROFILE[profile] : undefined;
  if (modeFromArgs !== undefined && modeFromProfile !== undefined && modeFromArgs !== modeFromProfile) {
    throw new WorkflowAuthorityError(`conflicting drain invocation: profile "${profile}" implies mode "${modeFromProfile}" but args mode is "${modeFromArgs}"`);
  }
  const mode = modeFromArgs ?? modeFromProfile ?? "dry-run";
  return { ...args, profile: DRAIN_PROFILE_FOR_MODE[mode], args: { ...runtimeArgs, mode } };
}

export function resolveDrainMode(runtimeArgs = {}) {
  const mode = runtimeArgs.mode ?? (runtimeArgs.dryRun === false ? "autonomous-local" : "dry-run");
  if (mode !== "dry-run" && mode !== "autonomous-local") throw new WorkflowAuthorityError('drain mode must be "dry-run" or "autonomous-local"');
  return mode;
}

function patternPolicySummary(policy = {}) {
  const allow = Array.isArray(policy.allow) ? policy.allow : [];
  const deny = Array.isArray(policy.deny) ? policy.deny : [];
  if (allow.includes("*") && deny.length === 0) return "UNRESTRICTED(*)";
  if (allow.length > 0 && deny.length === 0) return `allow:${allow.length},deny:0(empty-deny)`;
  return `allow:${allow.length},deny:${deny.length}`;
}

export function authoritySummary(authority) {
  const flags = [
    `mode=${authority.mode}`,
    `readOnly=${authority.readOnly}`,
    `shell=${authority.shell}`,
    `shellPolicy=${patternPolicySummary(authority.shellPolicy)}`,
    `network=${authority.network}`,
    `mcp=${authority.mcp}`,
    `mcpPolicy=${patternPolicySummary(authority.mcpPolicy)}`,
    `edit=${authority.edit}`,
    `worktreeEdit=${authority.worktreeEdit}`,
    `integration=${authority.integration}`,
    `profile=${authority.profile || AD_HOC_AUTHORITY_PROFILE}`,
  ];
  if (authority.editGate !== "not-requested") flags.push(authority.editGate);
  return flags.join(", ");
}

export function permissionRulesForAuthority(authority, extraSecretGlobs = []) {
  const rules = [{ permission: "*", pattern: "*", action: "deny" }];
  for (const permission of ["read", "glob", "grep", "list", "lsp"]) {
    rules.push({ permission, pattern: "*", action: "allow" });
  }
  // StructuredOutput is an internal OpenCode tool injected when `format` is set on a
  // prompt. The catch-all `*` deny above hides it from child sessions, which prevents
  // schema-constrained workflow lanes from producing structured results and causes them
  // to time out. The `structured_output` permission key allows the tool under
  // deny-by-default permission rulesets. (Historical provenance: found in the
  // OpenCode binary and confirmed accepted by the server's permission system in
  // the 1.17.7 investigation.)
  rules.push({ permission: "structured_output", pattern: "*", action: "allow" });
  const secretGlobs = [...new Set([...SECRET_GLOBS, ...extraSecretGlobs])];
  for (const glob of secretGlobs) {
    // lsp is granted a broad allow:* above (it is a read-class tool), so it must
    // carry the same secret-glob deny rules as read/grep/glob/list. Otherwise an
    // LSP response that surfaces fragments of .env/credentials/secret/id_rsa files
    // would be reachable by a read-only lane even though direct reads are denied.
    for (const permission of ["read", "grep", "glob", "list", "lsp"]) {
      rules.push({ permission, pattern: glob, action: "deny" });
    }
  }
  rules.push({ permission: "edit", pattern: "*", action: authority.edit || authority.worktreeEdit || authority.integration ? "allow" : "deny" });
  // apply_patch is a separate built-in OpenCode tool (distinct from `edit`) that the
  // GPT/Codex system prompt mandates for manual code edits ("Always use apply_patch for
  // manual code edits"). It carries its own `apply_patch` permission key, so the catch-all
  // `*` deny above hides it from child lanes even when edit authority is granted — a
  // Codex-family lane then follows its prompt, finds no callable apply_patch, and blocks
  // instead of falling back to `edit`. Gate it on the same authority as `edit`. (Same
  // deny-by-default tool-hiding class as the structured_output allow above.)
  rules.push({ permission: "apply_patch", pattern: "*", action: authority.edit || authority.worktreeEdit || authority.integration ? "allow" : "deny" });
  const shellPolicy = shellPolicyForAuthority(authority);
  if (shellPolicy.allow.length === 0) rules.push({ permission: "bash", pattern: "*", action: "deny" });
  for (const pattern of shellPolicy.allow) rules.push({ permission: "bash", pattern, action: "allow" });
  for (const pattern of shellPolicy.deny) rules.push({ permission: "bash", pattern, action: "deny" });
  rules.push({ permission: "webfetch", pattern: "*", action: authority.network ? "allow" : "deny" });
  rules.push({ permission: "websearch", pattern: "*", action: authority.network ? "allow" : "deny" });
  const mcpPolicy = mcpPolicyForAuthority(authority);
  if (mcpPolicy.allow.length === 0) rules.push({ permission: "mcp", pattern: "*", action: "deny" });
  for (const pattern of mcpPolicy.allow) rules.push({ permission: "mcp", pattern, action: "allow" });
  for (const pattern of mcpPolicy.deny) rules.push({ permission: "mcp", pattern, action: "deny" });
  for (const permission of ["task", "skill", "question", "todowrite"]) {
    rules.push({ permission, pattern: "*", action: "deny" });
  }
  rules.push({ permission: "external_directory", pattern: "*", action: "deny" });
  for (const permission of OPENCODE_CHILD_TOOL_IDS) {
    rules.push({ permission, pattern: "*", action: "deny" });
  }
  for (const permission of OPENCODE_CHILD_PERMISSION_KEYS) {
    rules.push({ permission, pattern: "*", action: "deny" });
  }
  return rules;
}

export function toolAuthority(toolName) {
  if (toolName === "bash") return "shell";
  if (toolName === "webfetch" || toolName === "websearch") return "network";
  if (toolName === "mcp" || toolName.startsWith("mcp")) return "mcp";
  if (toolName === "edit") return "edit";
  // apply_patch is the GPT/Codex file-edit tool; treat it as edit-class so an edit-authorized
  // lane that enumerates it is not rejected as an "unknown" tool authority.
  if (toolName === "apply_patch") return "edit";
  if (OPENCODE_CHILD_TOOL_IDS.includes(toolName)) return "delegation";
  if (["task", "skill", "question", "todowrite", "external_directory"].includes(toolName)) return "delegation";
  if (["read", "glob", "grep", "list", "lsp"].includes(toolName)) return "read";
  return "unknown";
}

function laneMcpPolicyOption(opts = {}) {
  if (opts.mcpPolicy !== undefined) {
    if (!opts.mcpPolicy || typeof opts.mcpPolicy !== "object" || Array.isArray(opts.mcpPolicy)) {
      throw new WorkflowAuthorityError("agent() option mcpPolicy must be an object with optional allow/deny arrays");
    }
    return opts.mcpPolicy;
  }
  if (opts.mcp && typeof opts.mcp === "object" && !Array.isArray(opts.mcp)) return opts.mcp;
  return undefined;
}

export function resolveLanePolicy(run, opts = {}) {
  const authority = { ...run.authority, shellPolicy: shellPolicyForAuthority(run.authority), mcpPolicy: mcpPolicyForAuthority(run.authority) };
  authority.edit = false;
  authority.worktreeEdit = false;
  authority.mode = authority.readOnly ? "readOnly" : "full";
  if (opts.readOnly === true) {
    authority.readOnly = true;
    authority.shell = false;
    authority.shellPolicy = { allow: [], deny: [] };
    authority.network = false;
    authority.mcp = false;
    authority.mcpPolicy = { allow: [], deny: [] };
    authority.edit = false;
    authority.worktreeEdit = false;
    // integration also grants edit:* allow in permissionRulesForAuthority, so a
    // readOnly lane on an integration-approved run would otherwise leak edit
    // permission even though tools.edit is false. Zero it so the permission
    // ruleset (the authoritative enforcement) denies edit too.
    authority.integration = false;
    authority.mode = "readOnly";
  }

  const requested = [];
  if (opts.allowEdits === true || opts.edit === true) requested.push("edit");
  if (opts.worktreeEdit === true) requested.push("worktreeEdit");
  if (opts.shell === true || opts.allowShell === true) requested.push("shell");
  if (opts.network === true || opts.allowNetwork === true) requested.push("network");
  const laneMcpPolicy = laneMcpPolicyOption(opts);
  if (opts.mcp === true || opts.allowMcp === true || laneMcpPolicy) requested.push("mcp");
  for (const [name, enabled] of Object.entries(opts.tools ?? {})) {
    if (enabled !== true) continue;
    const dimension = toolAuthority(name);
    if (dimension === "read") continue;
    requested.push(dimension);
  }

  for (const dimension of requested) {
    if (dimension === "delegation" || dimension === "unknown") {
      throw new WorkflowAuthorityError(`Lane requested unapproved ${dimension} tool authority`);
    }
    // opts.readOnly is authoritative defense-in-depth narrowing: a lane that
    // explicitly opts into readOnly cannot re-enable shell/network/mcp/edit even
    // if the parent run was approved for them. Silently drop the escalation
    // request (readOnly wins) rather than fail the lane.
    if (opts.readOnly === true && ["shell", "network", "mcp", "edit", "worktreeEdit"].includes(dimension)) {
      continue;
    }
    if (!run.authority[dimension] && !(dimension === "worktreeEdit" && run.authority.integration)) {
      throw new WorkflowAuthorityError(`Lane requested ${dimension} authority beyond approved workflow authority`);
    }
    authority[dimension] = true;
  }
  if (laneMcpPolicy && opts.readOnly !== true) {
    if (!run.authority.mcp) {
      throw new WorkflowAuthorityError("Lane requested mcpPolicy beyond approved workflow authority");
    }
    authority.mcpPolicy = narrowMcpPolicy(mcpPolicyForAuthority(run.authority), laneMcpPolicy);
    authority.mcp = authority.mcpPolicy.allow.length > 0;
  }
  if ((authority.edit || authority.worktreeEdit) && opts.readOnly !== true) {
    authority.mode = run.authority.integration ? "integrationMode" : "editMode";
    authority.readOnly = false;
  }

  const tools = {
    edit: authority.edit || authority.worktreeEdit,
    apply_patch: authority.edit || authority.worktreeEdit,
    bash: authority.shell,
    webfetch: authority.network,
    websearch: authority.network,
    task: false,
    skill: false,
    todowrite: false,
    question: false,
    ...Object.fromEntries(OPENCODE_CHILD_TOOL_IDS.map((name) => [name, false])),
    ...(opts.tools ?? {}),
  };
  if (opts.readOnly === true) {
    // readOnly is authoritative: strip any escalation tool the caller passed via
    // opts.tools so a readOnly lane can never regain shell/network/mcp/edit (and
    // so the validation loop below cannot throw on a contradictory request).
    for (const name of Object.keys(tools)) {
      if (tools[name] !== true) continue;
      const dimension = toolAuthority(name);
      if (["shell", "network", "mcp", "edit", "worktreeEdit"].includes(dimension)) {
        tools[name] = false;
      }
    }
  }
  for (const [name, enabled] of Object.entries(tools)) {
    if (enabled !== true) continue;
    const dimension = toolAuthority(name);
    if (dimension === "read") continue;
    if (dimension === "delegation" || dimension === "unknown") {
      throw new WorkflowAuthorityError(`Tool ${name} is denied by the workflow authority policy`);
    }
    if ((name === "edit" || name === "apply_patch") && authority.worktreeEdit) continue;
    if (!authority[dimension]) {
      throw new WorkflowAuthorityError(`Tool ${name} requires ${dimension} authority that was not approved`);
    }
  }

  // Design C: permission rules are a typed platform contract (session.create body); the plugin
  // trusts its host and verifies delivery per-lane via sessionPermissionEchoStatus (mismatch =>
  // throw). Version floor enforced by server-fingerprint at launch.

  const extraSecretGlobs = Array.isArray(opts.secretGlobs) ? opts.secretGlobs : [];
  // Run-level integration authority approves integration MODE (path-disjoint lanes
  // merged by the controller through workflow_apply); it must NOT grant primary-tree
  // edit/apply_patch to an ordinary child lane. Only a lane that is itself an
  // edit/worktreeEdit lane — i.e. the controller created a real edit/integration
  // worktree for it — may edit. A default lane in an integration run keeps
  // authority.integration as run-level metadata, but the permission ruleset (the
  // authoritative session-level enforcement) denies edit/apply_patch so the child
  // session cannot write to the primary tree. (Public-release hardening:
  // opencode-workflows-public-integration-lane-edit-leak.)
  const laneEditCapable = Boolean(authority.edit || authority.worktreeEdit);
  const permissionAuthority = laneEditCapable ? authority : { ...authority, integration: false };
  const permissionRules = permissionRulesForAuthority(permissionAuthority, extraSecretGlobs);
  return {
    mode: authority.mode,
    authority: redactValue(authority),
    shellPolicy: authority.shellPolicy,
    tools,
    permissionRules,
    policyMode: "permission-ruleset",
    mcpPolicy: authority.mcpPolicy,
    secretGlobs: [...new Set([...SECRET_GLOBS, ...extraSecretGlobs])],
  };
}
