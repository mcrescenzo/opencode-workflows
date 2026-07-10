import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import workflowPlugin from "../../workflow-kernel/index.js";

// Domain-mutation finalization is owned by trusted extensions. The kernel harness wires none by
// default; tests that exercise staged domain mutations pass explicit handlers via
// options.pluginContext.__workflowDomainMutationHandlers.
const DEFAULT_DOMAIN_MUTATION_HANDLERS = {};

const DEFAULT_CAPABILITIES = {
  childSession: "available",
  worktree: "available",
  toast: "available",
};

async function makeTempDir(prefix = "workflow-harness-") {
  return await fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

function defaultContext(directory) {
  return {
    directory,
    worktree: directory,
    sessionID: "parent-session",
    messageID: "parent-message",
    agent: "build",
    abort: new AbortController().signal,
    metadata() {},
  };
}

function resolveCapabilities(option) {
  if (option === false) return undefined;
  if (option === undefined) return DEFAULT_CAPABILITIES;
  return option;
}

function defaultSession(prompt, options, calls) {
  return {
    async create(input) {
      calls.create.push(input);
      return { data: { id: "child-1" } };
    },
    async prompt(input) {
      calls.prompt.push(input);
      return await prompt(input);
    },
    async abort(input) {
      calls.abort.push(input);
      options.onAbort?.(input);
      return { data: { ok: true } };
    },
  };
}

function defaultWorktree(calls) {
  return {
    async create(input) {
      calls.worktreeCreate.push(input);
      return { data: { id: "worktree-1", path: input.body.path } };
    },
    async remove(input) {
      calls.worktreeRemove.push(input);
      return { data: { ok: true } };
    },
  };
}

function defaultTui() {
  return {
    async showToast() {
      return { data: true };
    },
  };
}

// A fixture provider/model string used as the harness default session model. The plugin no longer
// carries a hard-coded model fallback (the DEFAULT_CHILD_MODEL literal was removed), so a suite that
// exercises a real run must see *some* session model; this stands in for "the session is on a model".
const HARNESS_DEFAULT_MODEL = "opencode/harness-default";

// Mock client.config used by readActiveSessionModel / buildWorkflowModels.
// Defaults to HARNESS_DEFAULT_MODEL as the session model so suites that do not opt in still resolve
// a child model. Pass an explicit `sessionModel` to override, or `config: false` to exercise the
// unreadable-session-model path (where the plugin now fails explicitly instead of guessing a model).
function defaultConfig(options) {
  return {
    async get() {
      return { data: { model: options.sessionModel ?? HARNESS_DEFAULT_MODEL, small_model: options.smallModel ?? null } };
    },
    async providers() {
      return { data: { providers: options.providers ?? [], default: options.providerDefault ?? {} } };
    },
  };
}

/**
 * Shared fake plugin-context harness factory.
 *
 * Two calling conventions are supported so both the main workflow regression
 * suite and the live-gate suites can share one factory:
 *   - makeHarness(promptFn, options)  // workflows.test.mjs convention
 *   - makeHarness(options)            // live-gate harness convention
 *
 * Options:
 *   - session:      object | function(prompt, options, calls) | false
 *   - worktree:     object | function(options, calls) | false
 *   - tui:          object | false
 *   - capabilities: object | false (false => undefined capabilities)
 *   - pluginContext: extra fields merged onto the fake plugin context
 *   - serverUrl:    URL | false
 *   - onAbort:      hook invoked from the default session.abort
 */
async function makeHarness(promptOrOptions, maybeOptions = {}) {
  const promptProvided = typeof promptOrOptions === "function";
  const options = promptProvided ? maybeOptions : (promptOrOptions ?? {});
  const prompt = promptProvided
    ? promptOrOptions
    : (options.prompt ?? (async () => ({ data: { parts: [], info: {} } })));

  const directory = options.directory ?? (await makeTempDir());
  const calls = {
    create: [],
    prompt: [],
    promptAsync: [],
    abort: [],
    messages: [],
    shell: [],
    worktreeCreate: [],
    worktreeRemove: [],
  };

  let session;
  if (options.session === false) {
    session = undefined;
  } else if (typeof options.session === "function") {
    session = options.session(prompt, options, calls, directory);
  } else if (options.session) {
    session = options.session;
  } else {
    session = defaultSession(prompt, options, calls);
  }

  let worktree;
  if (options.worktree === false) {
    worktree = undefined;
  } else if (typeof options.worktree === "function") {
    worktree = options.worktree(options, calls, directory);
  } else if (options.worktree) {
    worktree = options.worktree;
  } else {
    worktree = defaultWorktree(calls);
  }

  let tui;
  if (options.tui === false) {
    tui = undefined;
  } else if (options.tui) {
    tui = options.tui;
  } else {
    tui = defaultTui();
  }

  let config;
  if (options.config === false) {
    config = undefined;
  } else if (options.config) {
    config = options.config;
  } else {
    config = defaultConfig(options);
  }

  const pluginContext = {
    // The workflows convention historically omitted `directory`/`serverUrl`
    // from the fake plugin context; the live-gate convention sets them. Only
    // include them when explicitly requested so existing behavior is preserved.
    ...(options.includeDirectory ? { directory } : {}),
    __workflowCapabilities: resolveCapabilities(options.capabilities),
    __workflowDomainMutationHandlers: DEFAULT_DOMAIN_MUTATION_HANDLERS,
    client: { tui, session, worktree, config },
    ...(options.serverUrl !== undefined && options.serverUrl !== false
      ? { serverUrl: options.serverUrl }
      : {}),
    ...(options.pluginContext ?? {}),
  };

  // The factory loads configured extensions in its body, so the registry is populated on the await
  // below (no separate config-hook step needed). Absolute paths make configDir irrelevant.
  const extensions = options.extensions ?? [];
  const registered = await workflowPlugin(pluginContext, { ...(options.pluginOptions ?? {}), extensions });
  return {
    directory,
    tools: registered.tool,
    context: defaultContext(directory),
    calls,
  };
}

export { makeHarness, makeTempDir, defaultContext, DEFAULT_CAPABILITIES, HARNESS_DEFAULT_MODEL };
