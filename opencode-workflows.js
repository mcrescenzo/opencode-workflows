// Plugin entry. The kernel barrel (workflow-kernel/index.js) owns the orchestrator
// export and the aggregated __test surface; the entry just re-exports the plugin factory
// so opencode loads exactly one factory here. Unit tests import the barrel (or the real
// modules) directly rather than this entry, so the entry no longer wires __test.
export { default } from "./workflow-kernel/index.js";
