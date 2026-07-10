import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import WorkflowPlugin from "../workflow-kernel/index.js";
import { pendingNotificationPaths } from "../workflow-kernel/lifecycle-control.js";

// Notification-delivery regressions split out of durable-state.test.mjs
// (opencode-workflows-fnop.9): the session.idle event hook drives
// deliverWorkflowNotifications -> rehydratePendingNotifications, which must stay robust against
// transient fs failures (permission-restricted root, hidepid, sandbox).

async function tempDir(name) {
  return await fs.mkdtemp(path.join(os.tmpdir(), `${name}-`));
}

// The event hook is fire-and-forget and must never throw (AGENTS.md). rehydratePendingNotifications
// scans run roots with fs.readdir, which can reject with EPERM/EACCES (permission-restricted root,
// hidepid, sandbox). Such an error must be swallowed rather than propagated out of the event hook.
test("event hook returns normally when readdir rejects with EPERM", async (t) => {
  const dir = await tempDir("workflow-event-eperm");
  const savedPending = new Set(pendingNotificationPaths);
  pendingNotificationPaths.clear();
  const readdirMock = t.mock.method(fs, "readdir", async () => {
    const error = new Error("operation not permitted");
    error.code = "EPERM";
    throw error;
  });
  try {
    const pluginContext = {
      directory: dir,
      worktree: dir,
      client: { session: { promptAsync: async () => ({}) } },
    };
    const hooks = await WorkflowPlugin(pluginContext);
    // The session.idle event drives deliverWorkflowNotifications -> rehydratePendingNotifications,
    // which calls fs.readdir on each run root. The mock makes every root reject with EPERM.
    await assert.doesNotReject(() =>
      hooks.event({ event: { type: "session.idle", properties: { sessionID: "eperm-session" } } }),
    );
  } finally {
    // Restore readdir before cleanup so the recursive rm is not affected by the EPERM mock.
    readdirMock.mock.restore();
    pendingNotificationPaths.clear();
    for (const value of savedPending) pendingNotificationPaths.add(value);
    await fs.rm(dir, { recursive: true, force: true });
  }
});
