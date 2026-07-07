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
  return { meta, body };
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
    // jbs3.3 edit-and-resume: by default a resume MUST run the exact approved body — a silent body
    // swap is rejected here (the whole-run source-hash gate). With an explicit `editAndResume: true`
    // opt-in the operator may resume with an EDITED body: the changed source flows through with a NEW
    // sourceHash, which re-keys the approval envelope (approvalHash binds sourceHash) and forces fresh
    // two-phase approval before any lane executes. Lane reuse is content-addressed per lane
    // (event-journal.laneSignature no longer mixes in the whole-file hash), so unchanged lanes still
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
