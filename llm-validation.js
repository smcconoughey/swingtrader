export function validateEntryDecision(value, { candidateCount = 0 } = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("entry validation must be a JSON object");
  }
  if (typeof value.approve !== "boolean") throw new TypeError("approve must be boolean");
  const confidence = Number(value.confidence);
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 100) {
    throw new TypeError("confidence must be a number from 0 to 100");
  }
  if (!Array.isArray(value.concerns) || value.concerns.some(item => typeof item !== "string")) {
    throw new TypeError("concerns must be an array of strings");
  }
  if (typeof value.reasoning !== "string" || typeof value.suggestion !== "string") {
    throw new TypeError("reasoning and suggestion must be strings");
  }

  let contractIdx = null;
  if (candidateCount > 0) {
    const requested = Number(value.contractIdx);
    if (!Number.isInteger(requested) || requested < 1 || requested > candidateCount) {
      throw new TypeError(`contractIdx must be an integer from 1 to ${candidateCount}`);
    }
    contractIdx = requested - 1;
  }

  let tradePlan = null;
  if (value.tradePlan != null) {
    if (!value.tradePlan || typeof value.tradePlan !== "object" || Array.isArray(value.tradePlan)) {
      throw new TypeError("tradePlan must be an object");
    }
    const text = key => typeof value.tradePlan[key] === "string" ? value.tradePlan[key].trim() : "";
    tradePlan = {
      thesis: text("thesis"),
      entryTrigger: text("entryTrigger"),
      invalidation: text("invalidation"),
      firstTarget: text("firstTarget"),
      stretchTarget: text("stretchTarget"),
      timeHorizon: text("timeHorizon"),
      uncertainty: text("uncertainty"),
    };
    if (!tradePlan.thesis || !tradePlan.invalidation || !tradePlan.firstTarget || !tradePlan.timeHorizon) {
      throw new TypeError("tradePlan requires thesis, invalidation, firstTarget, and timeHorizon");
    }
  }

  return {
    approve: value.approve,
    confidence,
    concerns: value.concerns.slice(0, 20),
    reasoning: value.reasoning.trim(),
    suggestion: value.suggestion.trim(),
    ...(tradePlan ? { tradePlan } : {}),
    ...(candidateCount > 0 ? { contractIdx } : {}),
  };
}
