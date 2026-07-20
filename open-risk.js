const TERMINAL_ORDER_STATES = new Set([
  "filled", "canceled", "cancelled", "rejected", "expired", "error", "failed",
]);

const finitePositive = value => Number.isFinite(Number(value)) && Number(value) > 0;
const own = (object, key) => Object.prototype.hasOwnProperty.call(object ?? {}, key);

function rounded(value, places = 6) {
  return Number.isFinite(value) ? +value.toFixed(places) : null;
}

function firstPositive(...values) {
  for (const value of values) if (finitePositive(value)) return Number(value);
  return null;
}

function normalizedExpiry(value) {
  if (value == null || value === "") return null;
  if (typeof value === "number") {
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? date.toISOString().slice(0, 10) : null;
  }
  const match = String(value).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (match) return `${match[1]}-${match[2]}-${match[3]}`;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString().slice(0, 10) : null;
}

function occFromParts(record) {
  const ctx = record?.entryOrderCtx ?? {};
  const ticker = String(record?.ticker ?? record?.symbol ?? record?.underlying
    ?? ctx.ticker ?? ctx.symbol ?? "").trim().toUpperCase();
  const optionType = String(record?.optionType ?? record?.option_type ?? record?.type
    ?? ctx.optionType ?? ctx.option_type ?? "").toLowerCase();
  const expiry = normalizedExpiry(record?.expiration ?? record?.expirationDate
    ?? record?.expiry ?? record?.expiryDate ?? record?.expStr ?? ctx.expStr
    ?? ctx.expiration ?? ctx.expirationDate);
  const strike = firstPositive(record?.strike, record?.strikePrice, record?.strike_price,
    ctx.strike, ctx.strikePrice, ctx.strike_price);

  if (!ticker || !expiry || !strike || (optionType !== "call" && optionType !== "put")) return null;
  const yymmdd = expiry.slice(2).replaceAll("-", "");
  const strikeMillis = Math.round(strike * 1000);
  if (!Number.isSafeInteger(strikeMillis) || strikeMillis < 1 || strikeMillis > 99_999_999) return null;
  return `${ticker}${yymmdd}${optionType === "call" ? "C" : "P"}${String(strikeMillis).padStart(8, "0")}`;
}

function normalizedExplicitKey(value) {
  if (value == null || value === "") return null;
  const raw = String(value).trim();
  if (!raw) return null;
  const compact = raw.replaceAll(" ", "").toUpperCase();
  if (/^[A-Z0-9.]+\d{6}[CP]\d{8}$/.test(compact)) return `OCC:${compact}`;

  const uuid = raw.match(/(?:rhopt:|options\/instruments\/)?([0-9a-f]{8}-[0-9a-f-]{27,})\/?$/i);
  if (uuid) return `ID:${uuid[1].toLowerCase()}`;
  if (/^rhopt:/i.test(raw)) return `ID:${raw.slice(6).toLowerCase()}`;
  return null;
}

/**
 * Return a canonical key only when the row identifies an exact option contract.
 * A ticker by itself is intentionally never a key: contracts on the same underlying may have
 * different expirations, strikes, or rights and must not offset one another in risk accounting.
 */
export function longOptionContractKey(record = {}, fallbackKey = null) {
  const explicitCandidates = [
    record?.occSymbol, record?.occ, record?.optionSymbol, record?.option_symbol,
    record?.contractKey, record?.optionMetaKey, fallbackKey,
  ];
  for (const value of explicitCandidates) {
    const normalized = normalizedExplicitKey(value);
    if (normalized) return normalized;
  }

  const builtOcc = occFromParts(record);
  if (builtOcc) return `OCC:${builtOcc}`;

  const instrumentCandidates = [
    record?.instrumentId, record?.instrument_id, record?.instrumentUrl,
    record?.instrument, record?.optionId, record?.option_id,
  ];
  for (const value of instrumentCandidates) {
    const normalized = normalizedExplicitKey(value);
    if (normalized) return normalized;
  }
  return null;
}

function isOptionRow(record, fallbackKey = null) {
  const type = String(record?.type ?? record?.optionType ?? record?.option_type
    ?? record?.entryOrderCtx?.optionType ?? "").toLowerCase();
  if (type === "equity" || type === "stock") return false;
  if (type === "call" || type === "put" || type === "option") return true;
  const assetClass = String(record?.assetClass ?? record?.asset_class ?? record?.class ?? "").toLowerCase();
  return assetClass === "option" || longOptionContractKey(record, fallbackKey) != null;
}

function isLongOpeningRow(record) {
  const side = String(record?.side ?? record?.orderSide ?? record?.order_side ?? "").toLowerCase();
  if (["sell", "sell_to_close", "sell_to_open", "buy_to_close"].includes(side)) return false;
  const positionSide = String(record?.positionSide ?? record?.position_side ?? "").toLowerCase();
  if (positionSide === "short") return false;
  return true;
}

function isWorkingOrder(record) {
  const status = String(record?.status ?? record?.state ?? record?.orderStatus ?? "").toLowerCase();
  return !TERMINAL_ORDER_STATES.has(status);
}

function quantityDetails(record, { localIntent = false } = {}) {
  const remainderFields = [
    "remainingQty", "remainingQuantity", "remaining_quantity", "leavesQty", "leaves_qty",
    "pendingQuantity", "pending_quantity", "pending_buy_quantity", "quantityRemaining",
    "quantity_remaining",
  ];
  for (const field of remainderFields) {
    if (!own(record, field)) continue;
    const value = Number(record[field]);
    if (Number.isFinite(value)) return { quantity: Math.max(0, value), kind: "remaining" };
  }

  const requested = firstPositive(
    record?.requestedQty, record?.requestedQuantity, record?.requested_quantity,
    record?.quantity, record?.qty, record?.entryOrderCtx?.qty,
  );
  if (!requested) return { quantity: 0, kind: localIntent ? "requested" : "remaining" };

  const filledFields = [
    "filledQty", "filledQuantity", "filled_quantity", "executedQty", "executed_quantity",
    "execQuantity", "exec_quantity", "processedQuantity", "processed_quantity",
    "cumulativeQuantity", "cumulative_quantity",
  ];
  for (const field of filledFields) {
    if (!own(record, field)) continue;
    const filled = Number(record[field]);
    if (Number.isFinite(filled)) {
      return { quantity: Math.max(0, requested - Math.max(0, filled)), kind: "remaining" };
    }
  }

  const executions = [
    ...(Array.isArray(record?.executions) ? record.executions : []),
    ...(Array.isArray(record?.legs)
      ? record.legs.flatMap(leg => Array.isArray(leg?.executions) ? leg.executions : [])
      : []),
  ];
  if (executions.length > 0) {
    const filled = executions.reduce((sum, execution) => {
      const quantity = Number(execution?.quantity ?? execution?.qty);
      return sum + (Number.isFinite(quantity) && quantity > 0 ? quantity : 0);
    }, 0);
    return { quantity: Math.max(0, requested - filled), kind: "remaining" };
  }
  return { quantity: requested, kind: localIntent ? "requested" : "remaining" };
}

function activeLocalIntent(record) {
  if (!record || !record.entryOrderCtx) return false;
  if (record._pendingEntry === false || record.entryPending === false || record.active === false) return false;
  return record._pendingEntry === true || record.entryPending === true || record.active === true
    || finitePositive(record.entryOrderPlacedAt) || record.entryOrderId != null
    || record.entryOrderRefId != null;
}

function plannedQuantity(record) {
  return firstPositive(
    record?.plannedRiskQuantity, record?.riskQuantity, record?.risk_quantity,
    record?.originalQty, record?.originalQuantity, record?.original_quantity,
    record?.entryOrderCtx?.qty, record?.requestedQty, record?.requestedQuantity,
    record?.quantity, record?.qty,
  );
}

function persistedRiskPerContract(record) {
  if (!record) return null;
  const maxLoss = firstPositive(
    record?.maxLossPerContract,
    record?.riskGovernor?.maxLossPerContract,
    record?.risk_governor?.maxLossPerContract,
  );
  if (maxLoss) return { riskPerContract: maxLoss, method: "persisted-max-loss-per-contract" };

  const plannedRisk = firstPositive(
    record?.plannedRiskDollars, record?.planned_risk_dollars,
    record?.expectedMaxLossDollars, record?.expected_max_loss_dollars,
  );
  const quantity = plannedQuantity(record);
  if (plannedRisk && quantity) {
    return {
      riskPerContract: plannedRisk / quantity,
      method: "persisted-planned-risk",
    };
  }
  return null;
}

function estimateRiskPerContract(record, metadata, defaults) {
  const premium = firstPositive(
    record?.entryPremium, record?.entryPrice, record?.entry_price,
    record?.limitPrice, record?.limit_price, record?.price,
    metadata?.entryPremium, metadata?.entryPrice, metadata?.entryOrderLimit,
    metadata?.limitPrice, metadata?.price,
  );
  const rawStop = [
    record?.stopLossPct, record?.stopLoss, record?.managementPlan?.stopLoss,
    metadata?.stopLossPct, metadata?.stopLoss, metadata?.managementPlan?.stopLoss,
    defaults.stopLossPct,
  ].find(value => Number.isFinite(Number(value)) && Math.abs(Number(value)) > 0);
  const stop = rawStop == null ? null : Math.abs(Number(rawStop));
  if (!premium || !stop || stop > 1) return null;

  const multiplier = firstPositive(record?.contractMultiplier, metadata?.contractMultiplier,
    defaults.contractMultiplier) ?? 100;
  const notional = premium * multiplier;
  const entryFrictionPct = Math.max(0, Number(record?.entryFrictionPct
    ?? metadata?.entryFrictionPct ?? defaults.entryFrictionPct) || 0);
  const totalFrictionOverride = firstPositive(
    record?.frictionDollarsPerContract, metadata?.frictionDollarsPerContract,
    defaults.frictionDollarsPerContract,
  );
  const frictionDollars = totalFrictionOverride ?? (
    Math.max(0, Number(record?.entryFrictionDollarsPerContract
      ?? metadata?.entryFrictionDollarsPerContract ?? defaults.entryFrictionDollarsPerContract) || 0)
    + Math.max(0, Number(record?.exitFrictionDollarsPerContract
      ?? metadata?.exitFrictionDollarsPerContract ?? defaults.exitFrictionDollarsPerContract) || 0)
  );
  const totalFeesOverride = firstPositive(
    record?.feesPerContract, metadata?.feesPerContract, defaults.feesPerContract,
  );
  const fees = totalFeesOverride ?? (
    Math.max(0, Number(record?.entryFeePerContract
      ?? metadata?.entryFeePerContract ?? defaults.entryFeePerContract) || 0)
    + Math.max(0, Number(record?.exitFeePerContract
      ?? metadata?.exitFeePerContract ?? defaults.exitFeePerContract) || 0)
  );
  return {
    riskPerContract: (notional * stop) + (notional * entryFrictionPct) + frictionDollars + fees,
    method: "estimated-premium-stop-costs",
  };
}

function riskBasis(record, metadataRows, defaults) {
  const direct = persistedRiskPerContract(record);
  if (direct) return direct;
  for (const metadata of metadataRows) {
    const persisted = persistedRiskPerContract(metadata);
    if (persisted) return persisted;
  }
  return estimateRiskPerContract(record, metadataRows[0], defaults);
}

function normalizeMetadata(metadata) {
  if (Array.isArray(metadata)) return metadata.map((record, index) => ({ record, fallbackKey: null, index }));
  if (!metadata || typeof metadata !== "object") return [];
  return Object.entries(metadata).map(([fallbackKey, record], index) => ({ record, fallbackKey, index }));
}

function orderIdentity(record) {
  const id = record?.orderId ?? record?.order_id ?? record?.id
    ?? record?.entryOrderId ?? record?.entryOrderRefId ?? record?.refId ?? record?.ref_id;
  return id == null || id === "" ? null : String(id);
}

function componentRisk(component, metadataByKey, defaults) {
  const metadataRows = metadataByKey.get(component.contractKey) ?? [];
  const basis = riskBasis(component.record, metadataRows, defaults);
  if (!basis || !finitePositive(basis.riskPerContract)) {
    return { ...component, riskPerContract: null, riskDollars: null, method: "unresolved" };
  }
  return {
    ...component,
    riskPerContract: rounded(basis.riskPerContract),
    riskDollars: rounded(component.quantity * basis.riskPerContract),
    method: basis.method,
  };
}

function pendingView(rows, view, metadataByKey, defaults, ignored) {
  const byContract = new Map();
  const seenOrderIds = new Set();
  rows.forEach((record, index) => {
    if (!record || !isOptionRow(record) || !isLongOpeningRow(record) || !isWorkingOrder(record)) {
      ignored.push({ source: view, index, reason: "not-active-long-option-entry" });
      return;
    }
    const { quantity } = quantityDetails(record);
    if (!(quantity > 0)) {
      ignored.push({ source: view, index, reason: "no-remaining-quantity" });
      return;
    }
    const exactKey = longOptionContractKey(record);
    const contractKey = exactKey ?? `UNKEYED:${view}:${index}`;
    const orderId = orderIdentity(record);
    if (orderId) {
      const identity = `${contractKey}|${orderId}`;
      if (seenOrderIds.has(identity)) return;
      seenOrderIds.add(identity);
    }
    const component = componentRisk({
      contractKey, exactIdentity: exactKey != null, source: "working", view,
      quantity, orderId, record, index,
    }, metadataByKey, defaults);
    if (!byContract.has(contractKey)) byContract.set(contractKey, []);
    byContract.get(contractKey).push(component);
  });
  return byContract;
}

function sumComponents(components) {
  return components.reduce((sum, component) => sum + component.quantity, 0);
}

function knownRisk(components) {
  return components.reduce((sum, component) => sum + (component.riskDollars ?? 0), 0);
}

/**
 * Compute planned maximum loss for filled and in-flight long-option exposure.
 *
 * `positions` may contain both holdings and `_pending` dashboard rows. `pendingOrders` is an
 * optional broker-order view. When both views mirror the same exact contract, the larger view is
 * retained instead of summing both. Distinct orders within one broker view are still summed.
 * Active local metadata is a last-resort ledger: only the requested quantity not already visible
 * as a holding or working remainder is added.
 *
 * The result is fail-closed: `totalRiskDollars` is null when any counted exposure lacks enough
 * data for a risk basis. `knownRiskDollars`, `unresolved`, and `breakdown` remain available for
 * diagnostics. Callers should not substitute zero when `complete` is false.
 */
export function computeLongOptionOpenRisk(input = {}) {
  const positions = Array.isArray(input?.positions) ? input.positions : [];
  const pendingOrders = Array.isArray(input?.pendingOrders) ? input.pendingOrders : [];
  const metadataEntries = normalizeMetadata(input?.metadata ?? input?.meta);
  const defaults = {
    stopLossPct: input?.stopLossPct ?? -0.20,
    contractMultiplier: input?.contractMultiplier ?? 100,
    entryFrictionPct: input?.entryFrictionPct ?? 0,
    frictionDollarsPerContract: input?.frictionDollarsPerContract,
    entryFrictionDollarsPerContract: input?.entryFrictionDollarsPerContract ?? 0,
    exitFrictionDollarsPerContract: input?.exitFrictionDollarsPerContract ?? 0,
    feesPerContract: input?.feesPerContract,
    entryFeePerContract: input?.entryFeePerContract ?? 0,
    exitFeePerContract: input?.exitFeePerContract ?? 0,
  };
  const ignored = [];
  const metadataByKey = new Map();
  for (const entry of metadataEntries) {
    if (!entry.record || typeof entry.record !== "object") continue;
    const key = longOptionContractKey(entry.record, entry.fallbackKey);
    if (!key) continue;
    if (!metadataByKey.has(key)) metadataByKey.set(key, []);
    metadataByKey.get(key).push(entry.record);
  }

  const filledComponents = [];
  const pendingPositionRows = [];
  positions.forEach((record, index) => {
    if (record?._pending === true || record?._pendingEntryRow === true) {
      pendingPositionRows.push(record);
      return;
    }
    if (!record || !isOptionRow(record) || !isLongOpeningRow(record)) {
      ignored.push({ source: "filled", index, reason: "not-long-option-position" });
      return;
    }
    const quantity = firstPositive(record?.qty, record?.quantity);
    if (!quantity) {
      ignored.push({ source: "filled", index, reason: "no-held-quantity" });
      return;
    }
    const exactKey = longOptionContractKey(record);
    const contractKey = exactKey ?? `UNKEYED:filled:${index}`;
    filledComponents.push(componentRisk({
      contractKey, exactIdentity: exactKey != null, source: "filled", view: "positions",
      quantity, orderId: null, record, index,
    }, metadataByKey, defaults));
  });

  const pendingPositionView = pendingView(
    pendingPositionRows, "pending-positions", metadataByKey, defaults, ignored,
  );
  const pendingOrderView = pendingView(
    pendingOrders, "pending-orders", metadataByKey, defaults, ignored,
  );

  const pendingComponents = [];
  const pendingKeys = new Set([...pendingPositionView.keys(), ...pendingOrderView.keys()]);
  for (const key of pendingKeys) {
    const positionView = pendingPositionView.get(key) ?? [];
    const orderView = pendingOrderView.get(key) ?? [];
    if (positionView.length === 0) pendingComponents.push(...orderView);
    else if (orderView.length === 0) pendingComponents.push(...positionView);
    else {
      const positionQty = sumComponents(positionView);
      const orderQty = sumComponents(orderView);
      // These are two snapshots of broker working orders, not two independent order books.
      // Prefer the view with greater remaining exposure; use known risk as a conservative tie-break.
      pendingComponents.push(...(
        orderQty > positionQty || (orderQty === positionQty && knownRisk(orderView) >= knownRisk(positionView))
          ? orderView : positionView
      ));
    }
  }

  const heldQtyByKey = new Map();
  for (const component of filledComponents) {
    if (!component.exactIdentity) continue;
    heldQtyByKey.set(component.contractKey,
      (heldQtyByKey.get(component.contractKey) ?? 0) + component.quantity);
  }
  const workingQtyByKey = new Map();
  for (const component of pendingComponents) {
    if (!component.exactIdentity) continue;
    workingQtyByKey.set(component.contractKey,
      (workingQtyByKey.get(component.contractKey) ?? 0) + component.quantity);
  }

  const localGroups = new Map();
  for (const entry of metadataEntries) {
    const record = entry.record;
    if (!activeLocalIntent(record) || !isOptionRow(record, entry.fallbackKey) || !isLongOpeningRow(record)) continue;
    const exactKey = longOptionContractKey(record, entry.fallbackKey);
    const contractKey = exactKey ?? `UNKEYED:local:${entry.index}`;
    const details = quantityDetails(record, { localIntent: true });
    if (!(details.quantity > 0)) continue;
    if (!localGroups.has(contractKey)) localGroups.set(contractKey, []);
    localGroups.get(contractKey).push({ ...entry, contractKey, exactIdentity: exactKey != null, details });
  }

  const localComponents = [];
  for (const [contractKey, entries] of localGroups) {
    const exactIdentity = entries[0].exactIdentity;
    const heldQuantity = exactIdentity ? (heldQtyByKey.get(contractKey) ?? 0) : 0;
    const workingQuantity = exactIdentity ? (workingQtyByKey.get(contractKey) ?? 0) : 0;
    const requestedTotal = entries
      .filter(entry => entry.details.kind === "requested")
      .reduce((sum, entry) => sum + entry.details.quantity, 0);
    const explicitRemainingTotal = entries
      .filter(entry => entry.details.kind === "remaining")
      .reduce((sum, entry) => sum + entry.details.quantity, 0);
    const expectedOutstanding = explicitRemainingTotal + Math.max(0, requestedTotal - heldQuantity);
    const residualQuantity = Math.max(0, expectedOutstanding - workingQuantity);
    if (!(residualQuantity > 0)) continue;

    // A contract key normally has one local entry intent. If recovery left multiple snapshots,
    // choose the highest persisted/estimated per-contract loss so cleanup cannot lower open risk.
    const candidates = entries.map(entry => componentRisk({
      contractKey, exactIdentity, source: "local", view: "metadata",
      quantity: residualQuantity, orderId: orderIdentity(entry.record),
      record: entry.record, index: entry.index,
    }, metadataByKey, defaults));
    candidates.sort((a, b) => (b.riskPerContract ?? -1) - (a.riskPerContract ?? -1));
    localComponents.push(candidates[0]);
  }

  const components = [...filledComponents, ...pendingComponents, ...localComponents];
  const groups = new Map();
  for (const component of components) {
    if (!groups.has(component.contractKey)) groups.set(component.contractKey, []);
    groups.get(component.contractKey).push(component);
  }

  const breakdown = [...groups.entries()].map(([contractKey, rows]) => {
    const quantities = { filled: 0, working: 0, local: 0, total: 0 };
    let riskDollars = 0;
    let resolved = true;
    for (const row of rows) {
      quantities[row.source] += row.quantity;
      quantities.total += row.quantity;
      if (row.riskDollars == null) resolved = false;
      else riskDollars += row.riskDollars;
    }
    return {
      contractKey,
      exactIdentity: rows.every(row => row.exactIdentity),
      quantities,
      riskDollars: resolved ? rounded(riskDollars) : null,
      knownRiskDollars: rounded(riskDollars),
      complete: resolved,
      components: rows.map(({ record, ...row }) => row),
    };
  }).sort((a, b) => a.contractKey.localeCompare(b.contractKey));

  const unresolved = components
    .filter(component => component.riskDollars == null)
    .map(({ record, ...component }) => component);
  const knownRiskDollars = rounded(components.reduce(
    (sum, component) => sum + (component.riskDollars ?? 0), 0,
  ));
  const complete = unresolved.length === 0;
  return {
    totalRiskDollars: complete ? knownRiskDollars : null,
    knownRiskDollars,
    complete,
    quantities: {
      filled: rounded(filledComponents.reduce((sum, row) => sum + row.quantity, 0)),
      working: rounded(pendingComponents.reduce((sum, row) => sum + row.quantity, 0)),
      local: rounded(localComponents.reduce((sum, row) => sum + row.quantity, 0)),
      total: rounded(components.reduce((sum, row) => sum + row.quantity, 0)),
    },
    breakdown,
    unresolved,
    ignored,
  };
}

export const calculateLongOptionOpenRisk = computeLongOptionOpenRisk;
