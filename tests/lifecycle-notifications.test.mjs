import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import WorkflowPlugin from "../workflow-kernel/index.js";
import {
  NOTIFICATION_SENDING_STALE_MS,
  acquireNotificationDeliveryLock,
  notificationDeliveryLockIsStale,
  notificationDeliveryLockPath,
  pendingNotificationPaths,
} from "../workflow-kernel/lifecycle-control.js";

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

test("notification lock staleness uses mtimeMs directly", async (t) => {
  const nowMs = 123_456;
  t.mock.method(fs, "stat", async () => ({ mtime: new Date("invalid"), mtimeMs: nowMs - NOTIFICATION_SENDING_STALE_MS }));
  assert.equal(await notificationDeliveryLockIsStale("unused", nowMs), true);
});

test("a delayed stale reclaimer rechecks the live lock after acquiring the reclaim mutex", async (t) => {
  const dir = await tempDir("workflow-stale-lock-race");
  const notificationPath = path.join(dir, "notification.json");
  const lockPath = notificationDeliveryLockPath(notificationPath);
  const tombstonePath = `${lockPath}.stale`;
  try {
    await fs.writeFile(lockPath, "stale", "utf8");
    const past = new Date(Date.now() - NOTIFICATION_SENDING_STALE_MS - 1000);
    await fs.utimes(lockPath, past, past);

    const originalStat = fs.stat.bind(fs);
    const originalMkdir = fs.mkdir.bind(fs);
    const originalRename = fs.rename.bind(fs);
    let releaseInitialChecks;
    const initialChecksComplete = new Promise((resolve) => { releaseInitialChecks = resolve; });
    let initialChecks = 0;
    t.mock.method(fs, "stat", async (...args) => {
      const stat = await originalStat(...args);
      if (args[0] === lockPath && initialChecks < 2) {
        initialChecks += 1;
        if (initialChecks === 2) releaseInitialChecks();
        await initialChecksComplete;
      }
      return stat;
    });

    let releaseSecondReclaimer;
    const firstReclaimerFinished = new Promise((resolve) => { releaseSecondReclaimer = resolve; });
    let tombstoneMkdirCalls = 0;
    t.mock.method(fs, "mkdir", async (...args) => {
      if (args[0] === tombstonePath) {
        tombstoneMkdirCalls += 1;
        if (tombstoneMkdirCalls === 2) await firstReclaimerFinished;
      }
      return await originalMkdir(...args);
    });

    let renameCalls = 0;
    t.mock.method(fs, "rename", async (...args) => {
      renameCalls += 1;
      return await originalRename(...args);
    });

    const observeClaim = async (promise) => {
      const claim = await promise;
      if (claim.acquired) releaseSecondReclaimer();
      return claim;
    };
    const claims = await Promise.all([
      observeClaim(acquireNotificationDeliveryLock(notificationPath)),
      observeClaim(acquireNotificationDeliveryLock(notificationPath)),
    ]);

    assert.equal(initialChecks, 2, "both reclaimers observed the original stale lock before either proceeded");
    assert.equal(tombstoneMkdirCalls, 2, "the delayed reclaimer acquired the mutex after the winner released it");
    assert.equal(claims.filter((claim) => claim.acquired).length, 1);
    assert.equal(renameCalls, 1, "the delayed reclaimer must not rename the winner's fresh lock");
    await Promise.all(claims.map((claim) => claim.release()));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
