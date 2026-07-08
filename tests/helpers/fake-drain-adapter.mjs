// Shared drain-adapter test doubles for the workflow run/apply test suites.
//
// These factories implement the host-owned drain-adapter contract consumed by
// the workflow engine (discover -> classify -> claim -> buildLanePacket ->
// validate -> close, plus createFollowup / proveDry). Tests inject them via
// `pluginContext.__workflowDrainAdapters`. The `calls` array records the
// adapter's interaction trace so tests can assert ordering and gating.

// fakeDrainAdapter: a full, single-item drain double with a `closed` state
// machine. `options` toggles behavior:
//   - validationAccepted: false  -> validate() rejects the lane
//   - forceNotDry: true          -> proveDry() reports new work remains
//   - releaseClaim: fn           -> exposes a releaseClaim hook
export function fakeDrainAdapter(calls, options = {}) {
  const item = { id: "item-1", title: "Fake drain item", status: "open", issue_type: "task" };
  let closed = false;
  return {
    name: "fake",
    async discover() {
      calls.push("discover");
      return closed ? [] : [item];
    },
    async classify(discovered) {
      calls.push(["classify", discovered.id]);
      return { status: "ready", reason: "fake ready" };
    },
    async claim(discovered) {
      calls.push(["claim", discovered.id]);
      return { id: discovered.id, status: "in_progress" };
    },
    async buildLanePacket(discovered) {
      calls.push(["buildLanePacket", discovered.id]);
      return {
        item: discovered,
        instructions: ["Change only files needed by the fake item."],
        expectedReport: "LaneReport",
      };
    },
    async validate(discovered, integrationState) {
      calls.push(["validate", discovered.id, integrationState.status]);
      const accepted = options.validationAccepted !== false && integrationState.status === "integrated";
      return {
        itemId: discovered.id,
        accepted,
        reason: accepted ? "accepted fake lane" : "rejected fake lane",
        diffScopeOk: accepted,
        followupsHandled: true,
        acceptanceChecklist: ["fake validation"],
        validationCommands: ["fake validate"],
        followups: [],
      };
    },
    async close(discovered) {
      calls.push(["close", discovered.id]);
      closed = true;
      return { id: discovered.id, status: "closed" };
    },
    ...(options.releaseClaim ? { releaseClaim: options.releaseClaim } : {}),
    async createFollowup() {
      throw new Error("followups are not expected in fake drain tests");
    },
    async proveDry() {
      calls.push(["proveDry", closed]);
      if (options.forceNotDry === true) return { dry: false, reason: "new work remains" };
      return { dry: closed };
    },
  };
}

// emptyDrainAdapter: discovers nothing and proves dry immediately. Any lane
// method beyond discover/proveDry being invoked is a contract violation, so
// they throw.
export function emptyDrainAdapter(calls = []) {
  return {
    name: "beads",
    async discover() { calls.push("discover"); return []; },
    async classify() { throw new Error("classify should not be called with no items"); },
    async claim() { throw new Error("claim should not be called with no items"); },
    async buildLanePacket() { throw new Error("buildLanePacket should not be called with no items"); },
    async validate() { throw new Error("validate should not be called with no items"); },
    async close() { throw new Error("close should not be called with no items"); },
    async createFollowup() { throw new Error("followups are not expected with no items"); },
    async proveDry() { calls.push("proveDry"); return { dry: true }; },
  };
}
