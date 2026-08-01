const normalizeTicker = value => String(value || "").trim().toUpperCase();

function mentionedOpenTickers(text, openTickers = []) {
  const upper = String(text || "").toUpperCase();
  return [...new Set(openTickers.map(normalizeTicker).filter(Boolean))]
    .filter(ticker => new RegExp(`(^|[^A-Z0-9])${ticker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^A-Z0-9]|$)`).test(upper));
}

/**
 * Authoritative trading instructions are parsed deterministically. The LLM may explain them, but
 * it is never the component that decides whether a user instruction is enforceable.
 */
export function parseOperatorDirectives(text, { openTickers = [] } = {}) {
  const rawText = String(text || "").trim();
  if (!rawText) return [];
  const lower = rawText.toLowerCase().replace(/[’]/g, "'");
  const targets = mentionedOpenTickers(rawText, openTickers);
  const scopes = targets.length ? targets : ["*"];

  const forbidLossExit = /\b(?:do\s*not|don't|dont|never)\s+(?:auto(?:matically)?\s+)?(?:sell|close|exit)\b/.test(lower)
    && /\b(?:for|at|with)\s+(?:a\s+)?loss\b|\bwhile\s+(?:down|red|losing)\b/.test(lower);
  const allowLossExit = /\b(?:allow|resume|enable)\b.{0,30}\b(?:sell|close|exit)(?:ing|s)?\b.{0,25}\b(?:loss|down|red|losing)\b/.test(lower)
    || /\b(?:clear|remove|cancel)\b.{0,30}\b(?:no[- ]loss|loss[- ]exit|don't sell|dont sell)\b/.test(lower);
  const manualOnly = /\b(?:i(?:'ll| will) manage|manual(?:ly)? manage|advice only|do not automate|don't automate|dont automate)\b/.test(lower);
  const resumeAutomation = /\b(?:resume|enable|allow)\s+(?:automatic|automated|auto)\s+(?:management|exits?|trading)\b/.test(lower);

  if (forbidLossExit) {
    return scopes.map(scope => ({ kind: "no_realized_loss", scope, enabled: true, rawText }));
  }
  if (allowLossExit) {
    return scopes.map(scope => ({ kind: "no_realized_loss", scope, enabled: false, rawText }));
  }
  if (manualOnly) {
    return scopes.map(scope => ({ kind: "manual_only", scope, enabled: true, rawText }));
  }
  if (resumeAutomation) {
    return scopes.map(scope => ({ kind: "manual_only", scope, enabled: false, rawText }));
  }
  return [];
}

export function applyOperatorDirectives(state, directives, now = Date.now()) {
  if (!state || !Array.isArray(directives) || directives.length === 0) return [];
  if (!state.operatorDirectives || typeof state.operatorDirectives !== "object") {
    state.operatorDirectives = {};
  }
  const applied = [];
  for (const directive of directives) {
    const scope = normalizeTicker(directive.scope) || "*";
    const key = `${scope}:${directive.kind}`;
    if (directive.enabled === false) {
      if (state.operatorDirectives[key]) delete state.operatorDirectives[key];
      applied.push({ ...directive, scope, cleared: true });
      continue;
    }
    const stored = {
      kind: directive.kind,
      scope,
      source: "user",
      rawText: directive.rawText || "",
      createdAt: now,
      expiresAt: null,
    };
    state.operatorDirectives[key] = stored;
    applied.push(stored);
  }
  return applied;
}

export function activeDirectivesFor(state, ticker) {
  const directives = state?.operatorDirectives && typeof state.operatorDirectives === "object"
    ? Object.values(state.operatorDirectives) : [];
  const normalized = normalizeTicker(ticker);
  return directives.filter(directive => directive
    && directive.source === "user"
    && (directive.scope === "*" || normalizeTicker(directive.scope) === normalized)
    && (directive.expiresAt == null || directive.expiresAt > Date.now()));
}

export function automatedExitBlock({ state, ticker, entryPremium, proposedExitPrice } = {}) {
  const directives = activeDirectivesFor(state, ticker);
  const manualOnly = directives.find(directive => directive.kind === "manual_only");
  if (manualOnly) {
    return {
      reasonCode: "HOLD_USER_MANUAL_ONLY",
      reason: `operator directive: ${ticker} is advice-only; no automated exit is allowed`,
      directive: manualOnly,
    };
  }
  const noLoss = directives.find(directive => directive.kind === "no_realized_loss");
  if (noLoss && Number(entryPremium) > 0 && Number(proposedExitPrice) < Number(entryPremium)) {
    return {
      reasonCode: "HOLD_USER_NO_LOSS",
      reason: `operator directive: do not sell ${ticker} below $${Number(entryPremium).toFixed(2)} basis (proposed $${Number(proposedExitPrice).toFixed(2)})`,
      directive: noLoss,
    };
  }
  return null;
}

export function describeOperatorDirectives(state) {
  const rows = state?.operatorDirectives && typeof state.operatorDirectives === "object"
    ? Object.values(state.operatorDirectives) : [];
  return rows.map(row => `${row.scope} ${row.kind}`).join(", ");
}
