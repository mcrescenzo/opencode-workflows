import { WorkflowAuthorityError } from "./errors.js";

export const LANE_EFFORT_VALUES = Object.freeze(["minimal", "low", "medium", "high"]);
export const LANE_EFFORT_PROVIDER_OPTIONS = Object.freeze({
  openai: Object.freeze({
    providerOptionsKey: "openai",
    optionKey: "reasoningEffort",
    values: LANE_EFFORT_VALUES,
  }),
});
export const LANE_EFFORT_POLICY_MAX = 1000;

class BoundedLaneEffortMap extends Map {
  constructor(max = LANE_EFFORT_POLICY_MAX) {
    super();
    this.max = max;
  }

  get(key) {
    const value = super.get(key);
    if (value !== undefined && super.delete(key)) super.set(key, value);
    return value;
  }

  set(key, value) {
    if (super.has(key)) super.delete(key);
    super.set(key, value);
    while (this.size > this.max) {
      const oldest = super.keys().next().value;
      if (oldest === undefined) break;
      super.delete(oldest);
    }
    return this;
  }
}

export const laneEffortPolicies = new BoundedLaneEffortMap();

function normalizedID(value) {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.toLowerCase();
}

export function providerID(value) {
  if (typeof value === "string") return normalizedID(value.split("/")[0]);
  if (!value || typeof value !== "object") return undefined;
  return normalizedID(value.providerID)
    ?? normalizedID(value.providerId)
    ?? normalizedID(value.id)
    ?? normalizedID(value.name);
}

export function modelProviderID(model) {
  if (typeof model === "string") return providerID(model);
  if (!model || typeof model !== "object") return undefined;
  return normalizedID(model.providerID)
    ?? normalizedID(model.providerId)
    ?? providerID(model.provider);
}

export function normalizeLaneEffort(value) {
  if (value === undefined || value === null || value === false) return undefined;
  if (typeof value !== "string" || value.trim() === "") {
    throw new WorkflowAuthorityError(`agent() option effort must be one of ${LANE_EFFORT_VALUES.join(", ")}`);
  }
  const effort = value.trim().toLowerCase();
  if (!LANE_EFFORT_VALUES.includes(effort)) {
    throw new WorkflowAuthorityError(`Invalid agent() option effort: ${value}. Expected one of ${LANE_EFFORT_VALUES.join(", ")}.`);
  }
  return effort;
}

export function laneEffortPolicyForModel(effort, model) {
  const normalized = normalizeLaneEffort(effort);
  if (!normalized) return undefined;
  const modelProvider = modelProviderID(model);
  const mapping = LANE_EFFORT_PROVIDER_OPTIONS[modelProvider];
  if (!mapping) {
    throw new WorkflowAuthorityError(
      `agent() option effort is currently supported only for OpenAI providers via chat.params; ` +
      `model provider ${modelProvider ? `"${modelProvider}"` : "could not be determined"}.`,
    );
  }
  if (!mapping.values.includes(normalized)) {
    throw new WorkflowAuthorityError(`Provider ${modelProvider} does not support effort "${normalized}"`);
  }
  return {
    effort: normalized,
    providerID: modelProvider,
    providerOptionsKey: mapping.providerOptionsKey,
    optionKey: mapping.optionKey,
  };
}

export function registerLaneEffort(childID, policy) {
  if (!childID || !policy) return;
  laneEffortPolicies.set(String(childID), { ...policy });
}

export function clearLaneEffort(childID) {
  if (!childID) return false;
  return laneEffortPolicies.delete(String(childID));
}

export function laneEffortPolicyForChild(childID) {
  return childID ? laneEffortPolicies.get(String(childID)) : undefined;
}

export function applyLaneEffortParams(input = {}, output = {}) {
  const policy = laneEffortPolicyForChild(input.sessionID);
  if (!policy) return false;

  const existingOptions = output.options && typeof output.options === "object" ? output.options : {};
  const existingProviderOptions = existingOptions.providerOptions && typeof existingOptions.providerOptions === "object"
    ? existingOptions.providerOptions
    : {};
  const existingProvider = existingProviderOptions[policy.providerOptionsKey] && typeof existingProviderOptions[policy.providerOptionsKey] === "object"
    ? existingProviderOptions[policy.providerOptionsKey]
    : {};

  output.options = {
    ...existingOptions,
    providerOptions: {
      ...existingProviderOptions,
      [policy.providerOptionsKey]: {
        ...existingProvider,
        [policy.optionKey]: policy.effort,
      },
    },
  };
  return true;
}
