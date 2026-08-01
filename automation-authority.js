export const PROFIT_ONLY_MODE = "profit_only";

export function automationEntryBlock(config = {}) {
  return config.automationMode === PROFIT_ONLY_MODE
    ? "Profit-only automation is active; new entries are analysis-only"
    : null;
}

export function isProfitTakingExit(position = {}, decision = {}) {
  if (decision.action !== "close" && decision.action !== "trim") return false;
  const entry = Number(position.entryPremium);
  const exit = Number(decision.executionPrice);
  const pnl = Number(decision.metrics?.exitPnlPct);
  if (!(entry > 0) || !(exit > 0)) return false;
  if (Number.isFinite(pnl)) return pnl > 0 && exit > entry;
  return exit > entry;
}

export function applyAutomationAuthority(config = {}, position = {}, decision = {}) {
  if (config.automationMode !== PROFIT_ONLY_MODE || decision.action === "hold") return decision;
  if (isProfitTakingExit(position, decision)) return decision;
  return {
    ...decision,
    action: "hold",
    reasonCode: "HOLD_PROFIT_ONLY_MODE",
    reason: `profit-only automation: ${decision.reason || decision.reasonCode || "non-profit exit"} is advisory; no broker order sent`,
    qty: 0,
    urgency: "routine",
    priceMode: "none",
  };
}
