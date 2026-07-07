import { hasFunction } from "./text-json.js";

export function sessionShape(pluginContext) {
  return pluginContext.__workflowSessionShape ?? pluginContext.client?.__workflowSessionShape ?? "v1";
}

export function sessionApi(pluginContext) {
  const session = pluginContext.client?.session ?? {};
  const useV2 = sessionShape(pluginContext) === "v2";
  return {
    raw: session,
    has(name) {
      return hasFunction(session, name);
    },
    async create(input = {}) {
      const body = {
        ...(input.parentID ? { parentID: input.parentID } : {}),
        ...(input.title ? { title: input.title } : {}),
        ...(input.agent ? { agent: input.agent } : {}),
        ...(input.model ? { model: input.model } : {}),
        ...(input.permission ? { permission: input.permission } : {}),
      };
      return useV2
        ? await session.create({ directory: input.directory, ...body })
        : await session.create({ body, query: { directory: input.directory } });
    },
    async prompt(input = {}) {
      const body = input.body ?? {};
      return useV2
        ? await session.prompt({ sessionID: input.sessionID, directory: input.directory, ...body })
        : await session.prompt({ path: { id: input.sessionID }, query: { directory: input.directory }, body });
    },
    async promptAsync(input = {}) {
      const body = input.body ?? {};
      return useV2
        ? await session.promptAsync({ sessionID: input.sessionID, directory: input.directory, ...body })
        : await session.promptAsync({ path: { id: input.sessionID }, query: { directory: input.directory }, body });
    },
    async abort(input = {}) {
      return useV2
        ? await session.abort({ sessionID: input.sessionID, directory: input.directory })
        : await session.abort({ path: { id: input.sessionID }, query: { directory: input.directory } });
    },
    async messages(input = {}) {
      return useV2
        ? await session.messages({ sessionID: input.sessionID, directory: input.directory, limit: input.limit })
        : await session.messages({ path: { id: input.sessionID }, query: { directory: input.directory, limit: input.limit } });
    },
    async shell(input = {}) {
      const body = input.body ?? {};
      return useV2
        ? await session.shell({ sessionID: input.sessionID, directory: input.directory, ...body })
        : await session.shell({ path: { id: input.sessionID }, query: { directory: input.directory }, body });
    },
  };
}
