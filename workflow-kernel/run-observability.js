const RECENT_LOG_LIMIT = 3;

function boundedString(value) {
  return String(value ?? "");
}

function normalizeRecentLogs(logs, options = {}) {
  const limit = Number.isInteger(options.limit) && options.limit > 0 ? options.limit : RECENT_LOG_LIMIT;
  if (!Array.isArray(logs)) return [];
  return logs.map(boundedString).filter((line) => line.length > 0).slice(-limit);
}

function recordRecentLog(run, message, options = {}) {
  if (!run || typeof run !== "object") return [];
  const limit = Number.isInteger(options.limit) && options.limit > 0 ? options.limit : RECENT_LOG_LIMIT;
  const logs = normalizeRecentLogs(run.recentLogs, { limit });
  const text = boundedString(message);
  if (text) logs.push(text);
  run.recentLogs = logs.slice(-limit);
  return run.recentLogs;
}

function notifyRunEventSink(run, record) {
  const sink = run?.eventSink;
  if (typeof sink !== "function") return;
  try {
    const result = sink(record, run);
    if (result && typeof result.then === "function") {
      result.catch(() => {
        // Event sinks are observers; rejected delivery must not affect journaling.
      });
    }
  } catch {
    // Event sinks are observers; thrown delivery must not affect journaling.
  }
}

export {
  RECENT_LOG_LIMIT,
  normalizeRecentLogs,
  recordRecentLog,
  notifyRunEventSink,
};
