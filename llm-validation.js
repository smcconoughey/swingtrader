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

  return {
    approve: value.approve,
    confidence,
    concerns: value.concerns.slice(0, 20),
    reasoning: value.reasoning.trim(),
    suggestion: value.suggestion.trim(),
    ...(candidateCount > 0 ? { contractIdx } : {}),
  };
}
