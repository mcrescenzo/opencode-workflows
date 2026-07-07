// Live-gate result shape constructors. These pure helpers build the canonical
// `{ state, verified, evidence, evidenceStrength? }` gate objects consumed by the
// CapabilityAdapter / liveGateReport orchestrator and the live-gate probes. Kept in a
// focused leaf module (no probe or adapter dependencies) so both the adapter and the
// probe functions can share them without an import cycle.
import { MAX_STATUS_STRING_CHARS } from "./constants.js";
import { extractTextFromError, truncateText } from "./text-json.js";
import {
  WorkflowCancelledError,
  WorkflowProbeStructuralError,
  WorkflowTimeoutError,
} from "./errors.js";

function gateBlocked(evidence) {
  return { state: "blocked", verified: false, evidence };
}

function gateAvailableUnverified(evidence) {
  return { state: "available-unverified", verified: false, evidence };
}

// Evidence contract for verified gates: `evidenceStrength` distinguishes directly-observed
// target behavior ("observed", the default) from a compatibility fallback that verifies only
// via retained deny rules plus an absent tool attempt ("no-attempt-fallback"). The latter is
// not equivalent to an observed denial and must be explicitly accepted before release-
// readiness messaging treats it as enforcement proof.
function gateVerified(evidence, evidenceStrength = "observed") {
  return { state: "verified", verified: true, evidence, evidenceStrength };
}

function gateFailed(evidence) {
  return { state: "failed-with-evidence", verified: false, evidence };
}

function forcedGate(value) {
  if (value && typeof value === "object") {
    const verified = value.verified === true;
    const result = {
      state: value.state || (verified ? "verified" : "available-unverified"),
      verified,
      evidence: value.evidence || "forced test input",
    };
    if (verified) result.evidenceStrength = value.evidenceStrength ?? "observed";
    return result;
  }
  if (value === "verified" || value === "passed") return gateVerified("forced test input");
  if (typeof value === "string") return { state: value, verified: false, evidence: "forced test input" };
  return undefined;
}

function shapeGate(forcedValue, available, evidence) {
  return forcedGate(forcedValue) ?? (available ? gateAvailableUnverified(evidence) : gateBlocked(evidence));
}

// A transport/structural probe failure is NOT denial evidence: the probe could not
// be run, so it must never verify the gate. We discriminate these by typed error
// (code/instanceof) BEFORE the denial-text regex, because the regex also matches
// the probe's own label text (e.g. a "denied-bash probe ... timed out" message),
// which would otherwise silently escalate authority on latency / API-shape anomalies.
function transportFailureGate(error, label) {
  const evidence = truncateText(extractTextFromError(error), MAX_STATUS_STRING_CHARS);
  if (error instanceof WorkflowTimeoutError || error?.code === "WORKFLOW_TIMEOUT") {
    return gateFailed(`${label} could not be verified: probe timed out before observing enforcement: ${evidence}`);
  }
  if (error instanceof WorkflowCancelledError || error?.code === "WORKFLOW_CANCELLED") {
    return gateBlocked(`${label} could not be verified: probe was cancelled before observing enforcement: ${evidence}`);
  }
  if (error instanceof WorkflowProbeStructuralError || error?.code === "WORKFLOW_PROBE_STRUCTURAL") {
    return gateBlocked(`${label} could not be verified: ${evidence}`);
  }
  return undefined;
}

export {
  gateBlocked,
  gateAvailableUnverified,
  gateVerified,
  gateFailed,
  forcedGate,
  shapeGate,
  transportFailureGate,
};
