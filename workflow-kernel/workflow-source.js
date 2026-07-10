import { parse } from "acorn";
import fs from "node:fs/promises";
import path from "node:path";

import { BUNDLED_WORKFLOW_DIR, GLOBAL_WORKFLOW_DIR, MAX_SOURCE_BYTES } from "./constants.js";
import { hash } from "./text-json.js";

export function literalValue(node) {
  if (!node) throw new Error("Invalid metadata literal");
  if (node.type === "Literal") return node.value;
  if (node.type === "ArrayExpression") return node.elements.map(literalValue);
  if (node.type === "ObjectExpression") {
    const object = {};
    for (const prop of node.properties) {
      if (prop.type !== "Property" || prop.computed) {
        throw new Error("Workflow meta must be a static object literal");
      }
      const key = prop.key.type === "Identifier" ? prop.key.name : prop.key.value;
      object[key] = literalValue(prop.value);
    }
    return object;
  }
  if (node.type === "UnaryExpression" && node.operator === "-" && node.argument.type === "Literal") {
    return -node.argument.value;
  }
  throw new Error("Workflow meta may only contain JSON-compatible literals");
}

// Minimal, permissive meta field validator. Validates TYPES/SHAPES of recognized
// fields the kernel actually consumes WHEN they are present. It does NOT require any optional
// field (name/description may be omitted), does NOT reject unknown keys (display/documentation
// metadata passes through), and does NOT validate argsSchema internals (already AJV-compiled at
// preview). meta.lanes ownership lives in the lane-declaration validator; this base validator
// only checks lanes is an array when present so a non-array lanes fails here instead of
// confusing the lane-declaration renderer.
//
// metaDiagnostics() returns a non-throwing array (reused by the workflow_lint collector);
// validateMeta() throws on the first diagnostic for the existing throw-based preview/
// save path. The two stay in lockstep so a workflow that previews also lints identically.
// maxAgents and concurrency allow 0: many read-only/review workflows declare maxAgents: 0 for
// synchronous single-lane execution, and a meta.concurrency of 0 is falsy (falls back to the
// default) so it is harmless. The runtime clamps concurrency to >= 1 regardless.
const META_NON_NEGATIVE_INT_FIELDS = ["maxAgents", "concurrency", "maxTokens", "maxRuntimeMs", "guestDeadlineMs"];
const META_STRING_FIELDS = [
  "name", "description", "harness", "profile", "authorityProfile",
  "childModel", "defaultChildModel", "category", "whenToUse", "notes",
];
const META_OBJECT_FIELDS = ["authority", "modelTiers", "argsSchema"];

export function metaDiagnostics(meta) {
  const diagnostics = [];
  if (meta === null || meta === undefined) return diagnostics;
  if (typeof meta !== "object" || Array.isArray(meta)) {
    diagnostics.push({ field: "meta", message: "must be an object literal" });
    return diagnostics;
  }
  const checkString = (field) => {
    if (field in meta && typeof meta[field] !== "string") {
      diagnostics.push({ field, message: `must be a string when present (got ${Array.isArray(meta[field]) ? "array" : typeof meta[field]})` });
    }
  };
  for (const field of META_STRING_FIELDS) checkString(field);
  for (const field of META_OBJECT_FIELDS) {
    if (field in meta && (typeof meta[field] !== "object" || meta[field] === null || Array.isArray(meta[field]))) {
      diagnostics.push({ field, message: `must be an object when present (got ${Array.isArray(meta[field]) ? "array" : meta[field] === null ? "null" : typeof meta[field]})` });
    }
  }
  if ("phases" in meta) {
    if (!Array.isArray(meta.phases) || meta.phases.some((item) => typeof item !== "string")) {
      diagnostics.push({ field: "phases", message: "must be an array of strings when present" });
    }
  }
  if ("examples" in meta) {
    if (!Array.isArray(meta.examples)) {
      diagnostics.push({ field: "examples", message: "must be an array when present" });
    }
  }
  if ("lanes" in meta) {
    if (!Array.isArray(meta.lanes)) {
      diagnostics.push({ field: "lanes", message: "must be an array when present" });
    }
  }
  for (const field of META_NON_NEGATIVE_INT_FIELDS) {
    if (field in meta && (!Number.isInteger(meta[field]) || meta[field] < 0)) {
      diagnostics.push({ field, message: `must be a non-negative integer when present (got ${meta[field]})` });
    }
  }
  if ("maxCost" in meta && (typeof meta.maxCost !== "number" || !Number.isFinite(meta.maxCost) || meta.maxCost < 0)) {
    diagnostics.push({ field: "maxCost", message: `must be a finite non-negative number when present (got ${meta.maxCost})` });
  }
  if ("recommendBackground" in meta && typeof meta.recommendBackground !== "boolean") {
    diagnostics.push({ field: "recommendBackground", message: `must be a boolean when present (got ${typeof meta.recommendBackground})` });
  }
  if ("modelTiers" in meta && typeof meta.modelTiers === "object" && meta.modelTiers !== null && !Array.isArray(meta.modelTiers)) {
    for (const tier of ["fast", "deep"]) {
      if (tier in meta.modelTiers && typeof meta.modelTiers[tier] !== "string") {
        diagnostics.push({ field: `modelTiers.${tier}`, message: `must be a string when present (got ${typeof meta.modelTiers[tier]})` });
      }
    }
  }
  return diagnostics;
}

export function validateMeta(meta) {
  const diagnostics = metaDiagnostics(meta);
  if (diagnostics.length > 0) {
    throw new Error(`Invalid workflow meta: ${diagnostics.map((entry) => `${entry.field} ${entry.message}`).join("; ")}`);
  }
}

function sourceLocationSuffix(nodeOrError) {
  const loc = nodeOrError?.loc?.start ?? nodeOrError?.loc;
  if (!loc || !Number.isInteger(loc.line) || !Number.isInteger(loc.column)) return "";
  return ` at line ${loc.line}, column ${loc.column + 1}`;
}

function workflowSourceError(message, nodeOrError) {
  return new Error(`${message}${sourceLocationSuffix(nodeOrError)}`);
}

function parseWorkflowAst(source, purpose) {
  try {
    return parse(source, {
      ecmaVersion: "latest",
      sourceType: "module",
      allowAwaitOutsideFunction: true,
      allowReturnOutsideFunction: true,
      locations: true,
      ranges: false,
    });
  } catch (error) {
    throw workflowSourceError(`Workflow ${purpose} parse error: ${error.message}`, error);
  }
}

function visitAst(node, visitor) {
  if (!node || typeof node !== "object") return;
  visitor(node);
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) {
      for (const child of value) {
        if (child && typeof child.type === "string") visitAst(child, visitor);
      }
    } else if (value && typeof value.type === "string") {
      visitAst(value, visitor);
    }
  }
}

function fanoutCalleeName(node) {
  if (node?.type === "Identifier" && (node.name === "parallel" || node.name === "pipeline")) return node.name;
  if (node?.type === "MemberExpression" && !node.computed && (node.property?.name === "parallel" || node.property?.name === "pipeline")) return node.property.name;
  return null;
}

function propertyLiteralValue(objectNode, name) {
  if (objectNode?.type !== "ObjectExpression") return undefined;
  for (const prop of objectNode.properties ?? []) {
    if (prop.type !== "Property" || prop.computed) continue;
    const key = prop.key.type === "Identifier" ? prop.key.name : prop.key.value;
    if (key === name && prop.value?.type === "Literal") return prop.value.value;
  }
  return undefined;
}

function fanoutOptionsOptOut(optionsNode) {
  return propertyLiteralValue(optionsNode, "sequential") === true || propertyLiteralValue(optionsNode, "scoped") === true;
}

function functionRuntimeArity(node) {
  if (node?.type !== "ArrowFunctionExpression" && node?.type !== "FunctionExpression") return null;
  let arity = 0;
  for (const param of node.params ?? []) {
    if (param.type === "AssignmentPattern" || param.type === "RestElement") return arity;
    arity += 1;
  }
  return arity;
}

function firstReturnedExpression(functionNode) {
  if (!functionNode || functionRuntimeArity(functionNode) === null) return null;
  if (functionNode.body?.type !== "BlockStatement") return functionNode.body;
  const returned = functionNode.body.body?.find((statement) => statement.type === "ReturnStatement");
  return returned?.argument ?? null;
}

function collectSimpleBindings(ast) {
  const bindings = new Map();
  visitAst(ast, (node) => {
    if (node.type !== "VariableDeclaration") return;
    for (const declaration of node.declarations ?? []) {
      if (declaration.id?.type === "Identifier" && declaration.init) bindings.set(declaration.id.name, declaration.init);
    }
  });
  return bindings;
}

function mapCallbackResult(node, bindings, seen) {
  if (node?.type !== "CallExpression") return null;
  const callee = node.callee;
  if (callee?.type !== "MemberExpression" || callee.computed || callee.property?.name !== "map") return null;
  const mapper = resolveExpression(node.arguments?.[0], bindings, seen);
  const returned = firstReturnedExpression(mapper);
  return functionRuntimeArity(returned) !== null ? returned : null;
}

function resolveExpression(node, bindings, seen = new Set()) {
  if (node?.type !== "Identifier") return node;
  if (seen.has(node.name)) return node;
  const bound = bindings.get(node.name);
  if (!bound) return node;
  seen.add(node.name);
  return resolveExpression(bound, bindings, seen);
}

function fanoutCallbacksFromExpression(node, bindings, seen = new Set()) {
  const resolved = resolveExpression(node, bindings, seen);
  if (!resolved) return [];
  if (functionRuntimeArity(resolved) !== null) return [{ node: resolved, index: "0" }];
  if (resolved.type === "ArrayExpression") {
    const callbacks = [];
    for (let index = 0; index < resolved.elements.length; index += 1) {
      const element = resolved.elements[index];
      if (!element) continue;
      if (element.type === "SpreadElement") {
        callbacks.push(...fanoutCallbacksFromExpression(element.argument, bindings, seen));
      } else {
        callbacks.push(...fanoutCallbacksFromExpression(element, bindings, seen).map((entry) => ({ ...entry, index: String(index) })));
      }
    }
    return callbacks;
  }
  const mapped = mapCallbackResult(resolved, bindings, seen);
  if (mapped) return [{ node: mapped, index: "map()" }];
  return [];
}

function splitPipelineStages(args) {
  if (args.length === 0) return { stages: [], options: null };
  const last = args[args.length - 1];
  if (last?.type === "ObjectExpression") return { stages: args.slice(0, -1), options: last };
  return { stages: args, options: null };
}

// Static lane-shape introspection. A read-only AST visitor (sibling to lintFanoutCallbacks)
// that enumerates agent()/parallel()/pipeline() call sites and extracts per-call-site role/tier/
// authority/schema presence from literal or const-bound opts. It produces a lane BLUEPRINT (shape),
// never a roster or exact total: fan-out call sites (parallel/pipeline, or dynamic agent arrays)
// are marked runtime-determined and their staticCount is advisory only. Dynamic/spread/conditional
// option shapes render uncertain rather than asserting completeness — production workflows derive
// lane counts from earlier agent outputs at runtime, so a static total would mislead.
//
// Each blueprint lane site carries a `shapes` array (one resolved agent-callback shape per
// statically-enumerable callback; advisory, NOT a count guarantee) consumed by the preview renderer
// and validated by the meta.lanes subset check.

function agentCalleeName(callee) {
  if (callee?.type === "Identifier" && callee.name === "agent") return "agent";
  if (callee?.type === "MemberExpression" && !callee.computed && callee.property?.name === "agent") return "agent";
  return null;
}

function isAgentCall(node) {
  return node?.type === "CallExpression" && agentCalleeName(node.callee) !== null;
}

function stringPropertyValue(optsNode, name) {
  if (optsNode?.type !== "ObjectExpression") return null;
  for (const prop of optsNode.properties ?? []) {
    const key = propertyKeyName(prop);
    if (key !== name) continue;
    if (prop.value?.type === "Literal" && typeof prop.value.value === "string") return prop.value.value;
    return null; // present but non-literal/dynamic
  }
  return null;
}

function booleanPropertyValue(optsNode, name) {
  if (optsNode?.type !== "ObjectExpression") return null;
  for (const prop of optsNode.properties ?? []) {
    const key = propertyKeyName(prop);
    if (key !== name) continue;
    if (prop.value?.type === "Literal" && typeof prop.value.value === "boolean") return prop.value.value;
    return null; // present but non-literal-boolean -> unknown
  }
  return null;
}

function hasOptsKey(optsNode, name) {
  if (optsNode?.type !== "ObjectExpression") return false;
  return (optsNode.properties ?? []).some((prop) => propertyKeyName(prop) === name);
}

// Resolve the agent() call's opts to a literal ObjectExpression when possible; returns null for
// agent() with no args (defaults), a dynamic opts object, or a non-object arg.
// Canonical runtime/authoring form is agent(prompt, opts): when two arguments are present, opts
// is the SECOND argument (fnop.3). The legacy one-object form (a single ObjectExpression) is
// still recognized statically for compatibility, but the runtime itself is agent(prompt, opts).
function agentOptsNode(agentCall, bindings) {
  const args = agentCall.arguments ?? [];
  if (args.length >= 2) {
    const opts = resolveExpression(args[1], bindings);
    if (opts && opts.type === "ObjectExpression") return opts;
    return null;
  }
  if (args.length === 1) {
    const arg = resolveExpression(args[0], bindings);
    if (arg && arg.type === "ObjectExpression") return arg;
  }
  return null;
}

function agentShapeFromOpts(optsNode) {
  return {
    role: stringPropertyValue(optsNode, "role"),
    tier: stringPropertyValue(optsNode, "tier"),
    readOnly: booleanPropertyValue(optsNode, "readOnly"),
    edit: booleanPropertyValue(optsNode, "edit"),
    worktreeEdit: booleanPropertyValue(optsNode, "worktreeEdit"),
    integration: booleanPropertyValue(optsNode, "integration"),
    schema: hasOptsKey(optsNode, "schema"),
    optsResolved: true,
  };
}

function emptyAgentShape() {
  return { role: null, tier: null, readOnly: null, edit: null, worktreeEdit: null, integration: null, schema: false, optsResolved: false };
}

// Find agent() calls directly within a callback function body (does not descend into nested
// parallel/pipeline, which would conflate fan-out levels).
function agentCallsInScope(scopeNode) {
  const calls = [];
  if (!scopeNode) return calls;
  visitAst(scopeNode, (node) => {
    if (isAgentCall(node)) calls.push(node);
  });
  return calls;
}

function parallelCallbackSources(node) {
  const { stages, options } = splitPipelineStages((node.arguments ?? []).slice(1));
  return {
    options,
    sources: node.callee?.type === "Identifier" && node.callee.name === "parallel"
      ? [node.arguments?.[0]]
      : stages,
    literalArray: node.callee?.type === "Identifier" && node.callee.name === "parallel"
      ? node.arguments?.[0]?.type === "ArrayExpression"
      : stages.some((stage) => stage?.type === "ArrowFunctionExpression" || stage?.type === "FunctionExpression"),
  };
}

export function laneBlueprint(source) {
  const ast = typeof source === "string" ? parseWorkflowAst(source, "blueprint") : source;
  const bindings = collectSimpleBindings(ast);
  const sites = [];
  const consumedAgentNodes = new Set();

  // Pass 1: parallel()/pipeline() fan-out sites. Resolve their callbacks' agent() calls into
  // advisory per-callback shapes and record the consumed agent nodes so pass 2 does not re-count
  // them as direct lanes.
  visitAst(ast, (node) => {
    if (node.type !== "CallExpression") return;
    const helper = fanoutCalleeName(node.callee);
    if (!helper) return;
    const { sources, literalArray } = parallelCallbackSources(node);
    const callbacks = (sources ?? []).flatMap((src) => fanoutCallbacksFromExpression(src, bindings));
    const shapes = [];
    let certain = true;
    for (const entry of callbacks) {
      const agentCalls = agentCallsInScope(entry.node);
      if (agentCalls.length === 0) { certain = false; continue; }
      for (const ac of agentCalls) {
        consumedAgentNodes.add(ac);
        const optsNode = agentOptsNode(ac, bindings);
        shapes.push(optsNode ? agentShapeFromOpts(optsNode) : emptyAgentShape());
      }
    }
    if (callbacks.length === 0) certain = false;
    // Consume EVERY agent() call within this fan-out subtree so pass 2 does not re-emit them as
    // direct lanes — even when the callbacks could not be statically resolved into shapes (e.g.
    // a items.map(...) fan-out), the nested agent calls belong to this site, not the top level.
    for (const ac of agentCallsInScope(node)) consumedAgentNodes.add(ac);
    sites.push({
      _start: node.start ?? 0,
      kind: helper,
      fanOut: true,
      staticCount: callbacks.length > 0 && literalArray ? callbacks.length : null,
      certain,
      shapes,
    });
  });

  // Pass 2: direct agent() calls not already attributed to a fan-out site.
  visitAst(ast, (node) => {
    if (!isAgentCall(node)) return;
    if (consumedAgentNodes.has(node)) return;
    const optsNode = agentOptsNode(node, bindings);
    sites.push({
      _start: node.start ?? 0,
      kind: "agent",
      fanOut: false,
      staticCount: null,
      certain: true,
      shapes: [optsNode ? agentShapeFromOpts(optsNode) : emptyAgentShape()],
    });
  });

  sites.sort((a, b) => a._start - b._start);
  const lanes = sites.map((site, index) => {
    const { _start, ...rest } = site;
    return { label: `lane-${index + 1}`, ...rest };
  });
  return { lanes };
}

function lintFanoutCallbacks(ast) {
  const bindings = collectSimpleBindings(ast);
  visitAst(ast, (node) => {
    if (node.type !== "CallExpression") return;
    const helper = fanoutCalleeName(node.callee);
    if (!helper) return;
    if (helper === "parallel") {
      const [thunks, options] = node.arguments ?? [];
      if (fanoutOptionsOptOut(options)) return;
      const bad = fanoutCallbacksFromExpression(thunks, bindings)
        .filter((entry) => functionRuntimeArity(entry.node) === 0);
      if (bad.length > 0) {
        throw workflowSourceError(
          `parallel() callback(s) at index ${bad.map((entry) => entry.index).join(", ")} declare 0 parameters. ` +
            "Declare a scope parameter, e.g. `(api) => api.agent(...)`, for concurrent resume-safe execution. " +
            "Default/rest parameters such as `(api = {}) => ...` or `(...args) => ...` also count as 0 at runtime. " +
            "Use the injected api/context inside fan-out callbacks, or pass `{ sequential: true }` to intentionally run serially.",
          bad[0].node,
        );
      }
      return;
    }
    const { stages, options } = splitPipelineStages((node.arguments ?? []).slice(1));
    if (fanoutOptionsOptOut(options)) return;
    const bad = [];
    for (let index = 0; index < stages.length; index += 1) {
      for (const entry of fanoutCallbacksFromExpression(stages[index], bindings)) {
        if (functionRuntimeArity(entry.node) === 0) bad.push({ ...entry, index: String(index) });
      }
    }
    if (bad.length > 0) {
      throw workflowSourceError(
        `pipeline() callback(s) at index ${bad.map((entry) => entry.index).join(", ")} declare 0 parameters. ` +
          "Declare a scope/context parameter, e.g. `(item, context) => context.agent(...)`, for concurrent resume-safe execution. " +
          "Default/rest parameters such as `(context = {}) => ...` or `(...args) => ...` also count as 0 at runtime. " +
          "Use the injected api/context inside fan-out callbacks, or pass `{ sequential: true }` to intentionally run serially.",
        bad[0].node,
      );
    }
  });
}

export function parseWorkflowSource(source) {
  const ast = parseWorkflowAst(source, "source");
  lintFanoutCallbacks(ast);

  let meta = {};
  let removeStart = -1;
  let removeEnd = -1;

  for (const node of ast.body) {
    if (node.type === "ImportDeclaration") {
      throw new Error("Workflow scripts may not import modules");
    }
    if (node.type === "ExportDefaultDeclaration" || node.type === "ExportAllDeclaration") {
      // Only `export const meta` is allowed. Any other export (notably `export default`) would be
      // left in the body and then rejected by QuickJS at execution with a cryptic "unsupported
      // keyword: export" — after the user already approved. Fail here (preview/save time) instead.
      throw workflowSourceError(
        "Workflow scripts may only `export const meta = {...}`. Put workflow logic in top-level " +
        "statements ending in `return` (available globals: agent, parallel, pipeline, workflow, drain, " +
        "phase, log, budget, persistArtifacts, inventoryFiles, args) — do not use `export default` or wrap the body in a function.",
        node,
      );
    }
    if (node.type === "ExportNamedDeclaration") {
      const declaration = node.declaration;
      const declarations = declaration?.declarations ?? [];
      const metaDecl = declarations.find((decl) => decl.id?.name === "meta");
      if (!metaDecl) throw workflowSourceError("Only `export const meta = {...}` is allowed", node);
      const stray = declarations.filter((decl) => decl !== metaDecl);
      if (stray.length > 0) {
        const names = stray
          .map((decl) => decl.id?.name ?? "(complex pattern)")
          .join(", ");
        throw workflowSourceError(
          "Workflow scripts may only `export const meta = {...}`. Rejecting additional exports in the same declaration: " +
            names,
          node,
        );
      }
      meta = literalValue(metaDecl.init);
      removeStart = node.start;
      removeEnd = node.end;
    }
  }

  const body = removeStart >= 0 ? source.slice(0, removeStart) + source.slice(removeEnd) : source;
  // Permissive meta field validation runs at every parse (preview and save) so a
  // wrong-typed recognized field fails closed before approval, but unknown keys and omitted
  // optional fields continue to parse (preserving existing workflows).
  validateMeta(meta);
  return { meta, body };
}

// Non-throwing multi-diagnostic collector. Mirrors the throw-based parseWorkflowSource
// checks but returns ALL diagnostics at once instead of failing on the first, and adds NEW static
// checks not present in the throw path: top-level `return` presence and agent() call-site arity.
// It also surfaces the meta-schema diagnostics. It does NOT execute the workflow; a clean
// lint does NOT prove the workflow runs (QuickJS runtime success cannot be shown statically).
function locLine(node) {
  const loc = node?.loc?.start;
  if (!loc || !Number.isInteger(loc.line)) return undefined;
  return loc.line;
}

function collectFanoutArityDiagnostics(ast, diagnostics) {
  const bindings = collectSimpleBindings(ast);
  visitAst(ast, (node) => {
    if (node.type !== "CallExpression") return;
    const helper = fanoutCalleeName(node.callee);
    if (!helper) return;
    if (helper === "parallel") {
      const [thunks, options] = node.arguments ?? [];
      if (fanoutOptionsOptOut(options)) return;
      const bad = fanoutCallbacksFromExpression(thunks, bindings).filter((entry) => functionRuntimeArity(entry.node) === 0);
      for (const entry of bad) {
        diagnostics.push({
          rule: "fanout-callback-arity",
          severity: "error",
          line: locLine(entry.node),
          message: `parallel() callback at index ${entry.index} declares 0 parameters. Declare a scope parameter, e.g. (api) => api.agent(...), or pass { sequential: true }.`,
        });
      }
      return;
    }
    const { stages, options } = splitPipelineStages((node.arguments ?? []).slice(1));
    if (fanoutOptionsOptOut(options)) return;
    for (let index = 0; index < stages.length; index += 1) {
      for (const entry of fanoutCallbacksFromExpression(stages[index], bindings)) {
        if (functionRuntimeArity(entry.node) === 0) {
          diagnostics.push({
            rule: "fanout-callback-arity",
            severity: "error",
            line: locLine(entry.node),
            message: `pipeline() callback at stage ${index} declares 0 parameters. Declare a scope/context parameter, e.g. (item, context) => context.agent(...), or pass { sequential: true }.`,
          });
        }
      }
    }
  });
}

// agent(prompt, opts = {}): valid call-site arity is 1 or 2. agent() with no prompt, or with too
// many positional args, is a structural mistake the runtime would surface cryptically.
function collectAgentArityDiagnostics(ast, diagnostics) {
  visitAst(ast, (node) => {
    if (!isAgentCall(node)) return;
    const argCount = (node.arguments ?? []).length;
    if (argCount === 0) {
      diagnostics.push({ rule: "agent-arity", severity: "error", line: locLine(node), message: "agent() called with no arguments; it requires a prompt and optional opts. Use agent(\"prompt\", { ... })." });
    } else if (argCount > 2) {
      diagnostics.push({ rule: "agent-arity", severity: "error", line: locLine(node), message: `agent() called with ${argCount} arguments; it accepts at most (prompt, opts).` });
    }
  });
}

export function collectDiagnostics(source) {
  const diagnostics = [];
  let ast;
  try {
    ast = parseWorkflowAst(source, "lint");
  } catch (error) {
    diagnostics.push({ rule: "parse", severity: "error", message: error.message });
    return { diagnostics, ok: false, meta: null };
  }
  let meta = {};
  for (const node of ast.body) {
    if (node.type === "ImportDeclaration") {
      diagnostics.push({ rule: "no-imports", severity: "error", line: locLine(node), message: "Workflow scripts may not import modules." });
    } else if (node.type === "ExportDefaultDeclaration" || node.type === "ExportAllDeclaration") {
      diagnostics.push({ rule: "exports", severity: "error", line: locLine(node), message: "Workflow scripts may only `export const meta = {...}`; do not use `export default` or `export *`." });
    } else if (node.type === "ExportNamedDeclaration") {
      const declarations = node.declaration?.declarations ?? [];
      const metaDecl = declarations.find((decl) => decl.id?.name === "meta");
      if (!metaDecl) {
        diagnostics.push({ rule: "exports", severity: "error", line: locLine(node), message: "Only `export const meta = {...}` is allowed." });
      } else {
        const stray = declarations.filter((decl) => decl !== metaDecl);
        if (stray.length > 0) {
          diagnostics.push({ rule: "exports", severity: "error", line: locLine(node), message: `Workflow scripts may only export meta; rejecting additional exports: ${stray.map((d) => d.id?.name ?? "(complex)").join(", ")}.` });
        }
        try {
          meta = literalValue(metaDecl.init);
        } catch (error) {
          diagnostics.push({ rule: "meta-literal", severity: "error", line: locLine(metaDecl.init ?? metaDecl), message: `Workflow meta must be a static JSON-compatible object literal: ${error.message}` });
        }
      }
    }
  }
  // Meta-schema diagnostics (non-throwing).
  for (const d of metaDiagnostics(meta)) {
    diagnostics.push({ rule: "meta-schema", severity: "error", field: d.field, message: `meta.${d.field} ${d.message}.` });
  }
  // NEW: top-level return presence.
  const hasTopLevelReturn = ast.body.some((node) => node.type === "ReturnStatement");
  if (!hasTopLevelReturn) {
    diagnostics.push({ rule: "top-level-return", severity: "error", message: "Workflow body must end in a top-level `return` statement (the workflow result). A body without return yields undefined." });
  }
  // Fanout callback arity (non-throwing mirror of lintFanoutCallbacks).
  collectFanoutArityDiagnostics(ast, diagnostics);
  // NEW: agent() call-site arity.
  collectAgentArityDiagnostics(ast, diagnostics);
  return { diagnostics, ok: diagnostics.length === 0, meta };
}

// Optional meta.lanes declaration validation + merge. Authors may declare human-curated
// lane descriptions that OVERRIDE the preview rendering when present. Safety decisions always use
// resolved runtime authority / introspected blueprint facts, never author prose. Structural
// validation rejects: missing roles, exact fan-out counts, and authority/tier/schema escalation
// beyond the introspected call-site facts. Absent or partial meta.lanes remains valid. Display-only.

function matchDeclarationToLane(decl, index, lanes) {
  if (!decl || typeof decl !== "object") return null;
  if (typeof decl.id === "string") return lanes.find((lane) => lane.label === decl.id) ?? null;
  if (typeof decl.label === "string") {
    const byLabel = lanes.find((lane) => lane.label === decl.label);
    if (byLabel) return byLabel;
  }
  return lanes[index] ?? null;
}

function laneAuthorityBounds(lane) {
  const shapes = lane.shapes ?? [];
  const resolved = shapes.filter((s) => s.optsResolved);
  const hasUnresolved = shapes.some((s) => !s.optsResolved);
  // For authority flags: among resolved shapes, a flag is "true" if any call site explicitly sets
  // it true. If none do but an unresolved shape exists, the bound is unknown (null); otherwise the
  // call sites definitively do NOT grant that authority (false) — an absent edit flag means no edit.
  const flag = (key) => {
    if (resolved.length === 0) return hasUnresolved ? null : false;
    if (resolved.some((s) => s[key] === true)) return true;
    return hasUnresolved ? null : false;
  };
  const knownTiers = [...new Set(resolved.map((s) => s.tier).filter(Boolean))];
  const tierUnknown = hasUnresolved || resolved.some((s) => s.tier === null);
  const schemaTrue = resolved.some((s) => s.schema);
  return {
    edit: flag("edit"),
    worktreeEdit: flag("worktreeEdit"),
    integration: flag("integration"),
    schema: schemaTrue ? true : (hasUnresolved ? null : (resolved.length === 0 ? null : false)),
    knownTiers,
    tierUnknown,
  };
}

export function validateMetaLanes(declarations, blueprint, knownRoles = null) {
  const diagnostics = [];
  if (!Array.isArray(declarations)) return diagnostics;
  const lanes = (blueprint ?? { lanes: [] }).lanes ?? [];
  declarations.forEach((decl, index) => {
    if (!decl || typeof decl !== "object") {
      diagnostics.push({ declaration: index, message: "lane declaration must be an object" });
      return;
    }
    const lane = matchDeclarationToLane(decl, index, lanes);
    if (!lane) {
      diagnostics.push({ declaration: index, message: "no matching blueprint lane (more declarations than detected lanes)" });
      return;
    }
    if (decl.role != null) {
      if (typeof decl.role !== "string") {
        diagnostics.push({ declaration: index, message: "role must be a string" });
      } else if (knownRoles && !knownRoles.has(decl.role)) {
        diagnostics.push({ declaration: index, message: `references missing role "${decl.role}"` });
      }
    }
    if ("count" in decl) {
      diagnostics.push({ declaration: index, message: "lane declarations must not claim exact fan-out counts (remove `count`); describe the call-site shape, not a runtime total" });
    }
    if (decl.tier != null && !["fast", "deep"].includes(decl.tier)) {
      diagnostics.push({ declaration: index, message: `tier must be "fast" or "deep" (got ${decl.tier})` });
    }
    const bounds = laneAuthorityBounds(lane);
    const overclaim = (declVal, bound, name) => {
      if (declVal === true && bound === false) {
        diagnostics.push({ declaration: index, message: `escalates beyond introspected call-site authority: ${name}:true but no detected lane declares ${name}` });
      }
    };
    overclaim(decl.edit, bounds.edit, "edit");
    overclaim(decl.worktreeEdit, bounds.worktreeEdit, "worktreeEdit");
    overclaim(decl.integration, bounds.integration, "integration");
    overclaim(decl.schema, bounds.schema, "schema");
    if (decl.tier && bounds.knownTiers.length > 0 && !bounds.tierUnknown && !bounds.knownTiers.includes(decl.tier)) {
      diagnostics.push({ declaration: index, message: `tier "${decl.tier}" does not match detected lane tier(s): ${bounds.knownTiers.join(", ")}` });
    }
  });
  return diagnostics;
}

// Merge human-curated lane declarations into the blueprint for richer preview rendering. Each
// matched lane gains a `declaration` field with its display fields. Unmatched/partial declarations
// are ignored for rendering (the introspected shape still renders). Display-only.
export function mergeLaneDeclarations(blueprint, declarations) {
  const lanes = (blueprint ?? { lanes: [] }).lanes ?? [];
  if (!Array.isArray(declarations) || declarations.length === 0) return blueprint;
  return {
    ...blueprint,
    lanes: lanes.map((lane, index) => {
      const decl = matchDeclarationToLane(declarations[index] ?? {}, index, lanes) === lane
        ? declarations[index]
        : declarations.find((d) => matchDeclarationToLane(d, index, lanes) === lane);
      if (!decl) return lane;
      const declaration = {};
      for (const key of ["label", "title", "description", "role", "tier"]) {
        if (typeof decl[key] === "string") declaration[key] = decl[key];
      }
      return Object.keys(declaration).length > 0 ? { ...lane, declaration } : lane;
    }),
  };
}

function propertyKeyName(prop) {
  if (!prop || prop.computed) return null;
  if (prop.key?.type === "Identifier") return prop.key.name;
  if (prop.key?.type === "Literal") return prop.key.value;
  return null;
}

function staticNestedWorkflowRefFromCall(node) {
  const first = node.arguments?.[0];
  if (!first) throw workflowSourceError("workflow() nested calls must use a static string name or source", node);
  if (first.type === "Literal" && typeof first.value === "string") {
    return { kind: "string", value: first.value };
  }
  if (first.type !== "ObjectExpression") {
    throw workflowSourceError("workflow() nested calls must use a static string name/source or workflow({ source: \"...\" })", first);
  }

  let source = null;
  let name = null;
  for (const prop of first.properties ?? []) {
    if (prop.type !== "Property") {
      throw workflowSourceError("workflow() nested source form must be a static object literal", prop);
    }
    const key = propertyKeyName(prop);
    if (key !== "source" && key !== "name") continue;
    if (prop.value?.type !== "Literal" || typeof prop.value.value !== "string") {
      throw workflowSourceError(`workflow({ ${key} }) must use a static string literal`, prop.value);
    }
    if (key === "source") source = prop.value.value;
    if (key === "name") name = prop.value.value;
  }
  if (Boolean(source) === Boolean(name)) {
    throw workflowSourceError("workflow() nested source form must include exactly one static source or name", first);
  }
  return source !== null ? { kind: "source", value: source } : { kind: "name", value: name };
}

export function staticNestedWorkflowRefsDetailed(source) {
  const refs = [];
  const ast = parseWorkflowAst(source, "nested workflow scan");
  function visit(node) {
    if (!node || typeof node !== "object") return;
    if (node.type === "CallExpression" && node.callee?.type === "Identifier" && node.callee.name === "workflow") {
      refs.push(staticNestedWorkflowRefFromCall(node));
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) for (const child of value) visit(child);
      else if (value && typeof value === "object" && typeof value.type === "string") visit(value);
    }
  }
  visit(ast);
  return refs;
}

export function staticNestedWorkflowRefs(source) {
  return staticNestedWorkflowRefsDetailed(source).map((ref) => ref.value);
}

export async function buildNestedSnapshots(context, source, extensionWorkflowDirs = []) {
  const snapshots = new Map();
  for (const ref of staticNestedWorkflowRefsDetailed(source)) {
    const nested = ref.kind === "source" || (ref.kind === "string" && (ref.value.includes("\n") || ref.value.includes("export const meta")))
      ? await resolveWorkflowSource(context, { source: ref.value }, extensionWorkflowDirs)
      : await resolveWorkflowSource(context, { name: ref.value }, extensionWorkflowDirs);
    const nestedHash = hash(nested.source);
    const snapshot = { sourcePath: nested.sourcePath, sourceHash: nestedHash, source: nested.source };
    // Inline sources all share the "<inline>" sourcePath sentinel, so keying by it
    // would let a later inline workflow overwrite an earlier one. Key inline sources
    // purely by hash; only path-backed sources get the path key.
    if (nested.sourcePath !== "<inline>") snapshots.set(nested.sourcePath, snapshot);
    snapshots.set(nestedHash, snapshot);
  }
  return snapshots;
}

export function projectWorkflowDir(context) {
  return path.join(context.worktree || context.directory, ".opencode", "workflows");
}

export async function resolveWorkflowSource(context, args, extensionWorkflowDirs = []) {
  if (args.source) {
    if (Buffer.byteLength(args.source, "utf8") > MAX_SOURCE_BYTES) {
      throw new Error(`Workflow source exceeds ${MAX_SOURCE_BYTES} bytes`);
    }
    return { source: args.source, sourcePath: "<inline>" };
  }

  let sourcePath = args.scriptPath;
  const fromScriptPath = Boolean(args.scriptPath);
  let unresolvedName = null;
  let searchedRegistries = [];
  if (!sourcePath && args.name) {
    const workflowName = args.name.endsWith(".js") ? args.name.slice(0, -3) : args.name;
    const fileName = workflowFileName(workflowName);
    unresolvedName = workflowName;
    // Resolution order: project > global > extension > bundled. Extension dirs are
    // explicitly-configured trusted host asset dirs (merged ahead of bundled).
    const candidates = [
      { label: "project", filePath: path.join(projectWorkflowDir(context), fileName) },
      { label: "global", filePath: path.join(GLOBAL_WORKFLOW_DIR, fileName) },
      ...extensionWorkflowDirs.map((dir) => ({ label: "extension", filePath: path.join(dir, fileName) })),
      { label: "bundled", filePath: path.join(BUNDLED_WORKFLOW_DIR, fileName) },
    ];
    searchedRegistries = candidates.map(({ label, filePath }) => `${label}: ${filePath}`);
    for (const { filePath } of candidates) {
      try {
        await fs.access(filePath);
        sourcePath = filePath;
        break;
      } catch {
        // Try the next registry location.
      }
    }
  }

  if (!sourcePath && unresolvedName) {
    throw new Error(
      `Workflow name "${unresolvedName}" was not found. Searched registries: ${searchedRegistries.join("; ")}`,
    );
  }
  if (!sourcePath) throw new Error("Provide `source`, `scriptPath`, or `name`");
  const absolute = path.resolve(context.directory, sourcePath);
  // Explicit scriptPath outside trusted workflow roots fails closed unless allowExternalScriptPath opts in.
  if (fromScriptPath && !isTrustedWorkflowPath(absolute, context, extensionWorkflowDirs) && args.allowExternalScriptPath !== true) {
    throw new Error(
      `scriptPath resolves outside trusted workflow roots: ${absolute}. ` +
        "Set allowExternalScriptPath: true to opt in; the resolved path and source hash will appear in the approval preview.",
    );
  }
  const stat = await fs.stat(absolute);
  if (!stat.isFile()) throw new Error(`Workflow path is not a file: ${absolute}`);
  if (stat.size > MAX_SOURCE_BYTES) throw new Error(`Workflow source exceeds ${MAX_SOURCE_BYTES} bytes`);
  return { source: await fs.readFile(absolute, "utf8"), sourcePath: absolute };
}

export function hasExplicitWorkflowSource(args = {}) {
  return Boolean(args.source || args.scriptPath || args.name);
}

export async function resolveWorkflowSourceForStart(context, args, resumeEntry, extensionWorkflowDirs = []) {
  if (!resumeEntry || hasExplicitWorkflowSource(args)) {
    const resolved = await resolveWorkflowSource(context, args, extensionWorkflowDirs);
    const expectedHash = resumeEntry?.state?.sourceHash;
    // By default a resume MUST run the exact approved body — a silent body swap is rejected here
    // (the whole-run source-hash gate). With an explicit `editAndResume: true` opt-in the operator
    // may resume with an EDITED body: the changed source flows through with a NEW sourceHash, which
    // re-keys the approval envelope (approvalHash binds sourceHash) and forces fresh two-phase
    // approval before any lane executes. Lane reuse is content-addressed per lane
    // (event-journal.laneSignature does not mix in the whole-file hash), so unchanged lanes still
    // cache-hit at zero re-spend while edited/dependent lanes re-run. Only the BODY may change on an
    // edit-and-resume — the model/budget/authority/maxAgents envelope stays pinned to the prior run.
    if (expectedHash && args.editAndResume !== true && hash(resolved.source) !== expectedHash) throw new Error("resumeRunId source hash mismatch");
    return resolved;
  }

  const scriptPath = path.join(resumeEntry.dir, "script.js");
  let stat;
  try {
    stat = await fs.stat(scriptPath);
  } catch (error) {
    if (error.code === "ENOENT") throw new Error(`Workflow run ${resumeEntry.state?.id ?? "unknown"} cannot resume: missing script.js`);
    throw error;
  }
  if (!stat.isFile()) throw new Error(`Workflow run ${resumeEntry.state?.id ?? "unknown"} cannot resume: missing script.js`);
  if (stat.size > MAX_SOURCE_BYTES) throw new Error(`Workflow source exceeds ${MAX_SOURCE_BYTES} bytes`);
  const source = await fs.readFile(scriptPath, "utf8");
  const expectedHash = resumeEntry.state?.sourceHash;
  if (expectedHash && hash(source) !== expectedHash) throw new Error("resumeRunId persisted source hash mismatch");
  return { source, sourcePath: resumeEntry.state?.sourcePath ?? scriptPath };
}

function isPathUnderRoot(filePath, root) {
  const resolvedFile = path.resolve(filePath);
  const resolvedRoot = path.resolve(root);
  return resolvedFile === resolvedRoot || resolvedFile.startsWith(`${resolvedRoot}${path.sep}`);
}

export function trustedWorkflowRoots(context, extensionWorkflowDirs = []) {
  return [projectWorkflowDir(context), GLOBAL_WORKFLOW_DIR, ...extensionWorkflowDirs, BUNDLED_WORKFLOW_DIR];
}

export function isTrustedWorkflowPath(filePath, context, extensionWorkflowDirs = []) {
  return trustedWorkflowRoots(context, extensionWorkflowDirs).some((root) => isPathUnderRoot(filePath, root));
}

export function workflowFileName(name) {
  if (typeof name !== "string" || !/^[a-z0-9][a-z0-9-]{0,62}$/i.test(name)) {
    throw new Error("Workflow name must be a simple slug: letters, numbers, hyphens, max 63 chars");
  }
  return `${name}.js`;
}
