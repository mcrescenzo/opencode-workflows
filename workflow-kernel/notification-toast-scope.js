const SCOPE_KIND_PATTERN = /^(pipeline|parallel):(\d+)$/;
const ITEM_PATTERN = /^item:(\d+)$/;
const STAGE_PATTERN = /^stage:(\d+)$/;
const DONE_STATUSES = new Set(["completed", "success", "applied"]);
const TERMINAL_STATUSES = new Set(["completed", "success", "applied", "failure", "failed", "timeout", "cancelled", "budget_stopped"]);

function laneRecordsArray(input) {
  if (input instanceof Map) return [...input.values()];
  return Array.isArray(input) ? input : [];
}

function parseScopePath(callId) {
  const segments = String(callId ?? "").split("/").filter(Boolean);
  let scopeEnd = -1;
  let itemIndex;
  let stageIndex;
  for (let index = 0; index < segments.length; index += 1) {
    if (SCOPE_KIND_PATTERN.test(segments[index])) scopeEnd = index;
    const item = ITEM_PATTERN.exec(segments[index]);
    if (item && scopeEnd >= 0 && itemIndex === undefined) itemIndex = Number(item[1]);
    const stage = STAGE_PATTERN.exec(segments[index]);
    if (stage && itemIndex !== undefined && stageIndex === undefined) stageIndex = Number(stage[1]);
  }
  if (scopeEnd < 0 || !Number.isInteger(itemIndex)) return null;
  const containerPath = segments.slice(0, scopeEnd + 1).join("/");
  return {
    containerPath,
    itemIndex,
    itemKey: `${containerPath}/item:${itemIndex}`,
    stageIndex: Number.isInteger(stageIndex) ? stageIndex : undefined,
  };
}

function laneDone(record) {
  return DONE_STATUSES.has(String(record?.outcome ?? record?.status ?? ""));
}

function laneTerminal(record) {
  return TERMINAL_STATUSES.has(String(record?.outcome ?? record?.status ?? ""));
}

function deriveScopeItemProgress(laneRecords) {
  const items = new Map();
  const scoped = [];
  for (const record of laneRecordsArray(laneRecords)) {
    const parsed = parseScopePath(record?.callId);
    if (!parsed) continue;
    scoped.push({ record, parsed });
    const item = items.get(parsed.itemKey) ?? {
      key: parsed.itemKey,
      containerPath: parsed.containerPath,
      itemIndex: parsed.itemIndex,
      laneCount: 0,
      doneLaneCount: 0,
      terminalLaneCount: 0,
      maxStageIndex: undefined,
      activeStageIndex: undefined,
    };
    item.laneCount += 1;
    if (laneDone(record)) item.doneLaneCount += 1;
    if (laneTerminal(record)) item.terminalLaneCount += 1;
    if (Number.isInteger(parsed.stageIndex)) {
      item.maxStageIndex = Number.isInteger(item.maxStageIndex) ? Math.max(item.maxStageIndex, parsed.stageIndex) : parsed.stageIndex;
      if (!laneTerminal(record)) {
        item.activeStageIndex = Number.isInteger(item.activeStageIndex)
          ? Math.min(item.activeStageIndex, parsed.stageIndex)
          : parsed.stageIndex;
      }
    }
    items.set(parsed.itemKey, item);
  }
  if (scoped.length === 0) return null;
  const itemList = [...items.values()].sort((a, b) => a.containerPath.localeCompare(b.containerPath) || a.itemIndex - b.itemIndex);
  const done = itemList.filter((item) => item.laneCount > 0 && item.doneLaneCount === item.laneCount).length;
  const failed = itemList.filter((item) => item.terminalLaneCount === item.laneCount && item.doneLaneCount < item.laneCount).length;
  const activeStages = itemList
    .map((item) => item.activeStageIndex)
    .filter(Number.isInteger);
  const maxStageIndex = itemList.reduce((max, item) => Number.isInteger(item.maxStageIndex) ? Math.max(max, item.maxStageIndex) : max, -1);
  const currentStageIndex = activeStages.length > 0 ? Math.min(...activeStages) : undefined;
  return {
    done,
    total: itemList.length,
    failed,
    currentStage: Number.isInteger(currentStageIndex) ? currentStageIndex + 1 : undefined,
    totalStages: maxStageIndex >= 0 ? maxStageIndex + 1 : undefined,
    items: itemList.map((item) => ({
      key: item.key,
      containerPath: item.containerPath,
      itemIndex: item.itemIndex,
      done: item.laneCount > 0 && item.doneLaneCount === item.laneCount,
      failed: item.terminalLaneCount === item.laneCount && item.doneLaneCount < item.laneCount,
    })),
  };
}

export {
  deriveScopeItemProgress,
  parseScopePath,
};
