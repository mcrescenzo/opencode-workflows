import path from "node:path";
import { pathToFileURL } from "node:url";

// Trusted extension registry (Stage 1 of the harness extraction).
//
// One instance per pluginContext: opencode double-instantiates plugin factories, so keeping
// the registry per-instance (not a module-level singleton) avoids duplicate-name throws across
// instantiations. The registry confers TRUST on host-side capabilities — drain adapters and
// domain-mutation finalizers — and collects extension-owned asset dirs that the caller merges
// into the existing project/global/extension/bundled resolution. It does NOT resolve assets
// itself, and it is a strict import-leaf (only node:path) so it can be threaded into
// sandbox-executor / event-journal without creating an import cycle.

const ASSET_KINDS = ["workflows", "commands", "skills"];

function asPlainObject(value, label) {
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) throw new Error(`extension ${label} must be an object`);
  return value;
}

export function createExtensionRegistry() {
  const extensions = []; // { id, baseDir }
  const adapters = new Map(); // name -> { ...adapter, __extId }
  const handlers = new Map(); // operation -> { fn, __extId }
  const toolFactories = new Map(); // extId -> tools object | (toolKit) => tools object
  const assetDirs = { workflows: [], commands: [], skills: [] };

  function register(def, opts = {}) {
    if (!def || typeof def !== "object" || Array.isArray(def)) throw new Error("extension definition must be an object");
    const id = def.id;
    if (typeof id !== "string" || id.length === 0) throw new Error("extension definition requires a non-empty string `id`");

    // Per-id idempotency: re-registering the same extension (e.g. the same module imported twice)
    // is a no-op. Cross-extension name clashes below still throw.
    if (extensions.some((e) => e.id === id)) return;

    const baseDir = opts.baseDir;

    const drainAdapters = asPlainObject(def.drainAdapters, `${id}.drainAdapters`);
    for (const [name, adapter] of Object.entries(drainAdapters)) {
      const existing = adapters.get(name);
      if (existing && existing.__extId !== id) {
        throw new Error(`duplicate drain adapter "${name}" (already registered by extension "${existing.__extId}")`);
      }
    }

    const mutationHandlers = asPlainObject(def.mutationHandlers, `${id}.mutationHandlers`);
    for (const [op, fn] of Object.entries(mutationHandlers)) {
      if (typeof fn !== "function") throw new Error(`mutation handler "${op}" must be a function`);
      const existing = handlers.get(op);
      if (existing && existing.__extId !== id) {
        throw new Error(`duplicate mutation operation "${op}" (already registered by extension "${existing.__extId}")`);
      }
    }

    const declaredDirs = asPlainObject(def.assetDirs, `${id}.assetDirs`);
    for (const kind of ASSET_KINDS) {
      const rel = declaredDirs[kind];
      if (rel === undefined || rel === null) continue;
      if (typeof rel !== "string") throw new Error(`assetDirs.${kind} must be a string path`);
    }

    const toolsDef = def.tools;
    if (toolsDef !== undefined && toolsDef !== null) {
      const ok = typeof toolsDef === "function" || (typeof toolsDef === "object" && !Array.isArray(toolsDef));
      if (!ok) throw new Error(`extension ${id}.tools must be an object map or a (toolKit) => object factory`);
    }

    // All validation passed — commit (freeze adapter definitions so guests cannot mutate them).
    for (const [name, adapter] of Object.entries(drainAdapters)) {
      adapters.set(name, Object.freeze({ ...adapter, __extId: id }));
    }
    for (const [op, fn] of Object.entries(mutationHandlers)) {
      handlers.set(op, { fn, __extId: id });
    }
    for (const kind of ASSET_KINDS) {
      const rel = declaredDirs[kind];
      if (typeof rel !== "string") continue;
      assetDirs[kind].push(path.isAbsolute(rel) ? rel : path.join(baseDir ?? ".", rel));
    }
    if (toolsDef !== undefined && toolsDef !== null) toolFactories.set(id, toolsDef);
    extensions.push(Object.freeze({ id, baseDir }));
  }

  async function loadExtensions(paths = [], { configDir, importer = (p) => import(pathToFileURL(p).href) } = {}) {
    for (const entry of paths) {
      // Extension MODULE paths resolve relative to the opencode config dir (where opencode.json
      // lives); the extension's own asset dirs resolve relative to the module's dir (baseDir below).
      const modulePath = path.isAbsolute(entry) ? entry : path.join(configDir ?? ".", entry);
      let mod;
      try {
        mod = await importer(modulePath);
      } catch (cause) {
        throw new Error(`failed to load workflow extension ${modulePath}: ${cause?.message ?? cause}`, { cause });
      }
      let def = mod?.default ?? mod;
      if (typeof def === "function") def = await def();
      try {
        register(def, { baseDir: path.dirname(modulePath) });
      } catch (cause) {
        throw new Error(`invalid workflow extension ${modulePath}: ${cause?.message ?? cause}`, { cause });
      }
    }
  }

  return {
    register,
    loadExtensions,
    drainAdapter(name) {
      const adapter = adapters.get(name);
      if (!adapter) return undefined;
      const { __extId, ...rest } = adapter;
      return rest;
    },
    mutationHandler: (op) => handlers.get(op)?.fn,
    // Resolve every extension's contributed tools into one merged { name: ToolDefinition } map.
    // A factory form is called with `toolKit` (the kernel injects tool/schema/pluginContext/guards
    // so extensions need no @opencode-ai/plugin dependency). Fail closed on a reserved (core) name
    // or a cross-extension duplicate. Import-leaf: no @opencode-ai/plugin import here.
    tools: (toolKit, reservedNames = []) => {
      const reserved = new Set(reservedNames);
      const out = {};
      for (const [id, def] of toolFactories) {
        const resolved = typeof def === "function" ? def(toolKit) : def;
        if (!resolved || typeof resolved !== "object" || Array.isArray(resolved)) {
          throw new Error(`extension "${id}" tools factory must return an object map of tools`);
        }
        for (const [name, toolDef] of Object.entries(resolved)) {
          if (reserved.has(name)) throw new Error(`extension "${id}" tool "${name}" collides with a reserved core tool name`);
          if (Object.hasOwn(out, name)) throw new Error(`duplicate extension tool "${name}" (already contributed by another extension)`);
          out[name] = toolDef;
        }
      }
      return out;
    },
    assetDirs: () => ({
      workflows: [...assetDirs.workflows],
      commands: [...assetDirs.commands],
      skills: [...assetDirs.skills],
    }),
    listExtensions: () => extensions.map((e) => ({ ...e })),
  };
}
