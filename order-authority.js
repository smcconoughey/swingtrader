const orderId = order => order?.id || order?.order_id || null;
const orderRef = order => order?.ref_id || order?.refId || order?.client_order_id
  || order?.clientOrderId || order?.client_ref_id || null;
const normalizeInstrumentId = value => {
  const raw = String(value || "").trim().replace(/\/+$/, "");
  return raw ? raw.split("/").pop() : null;
};

export function automationOrderIdentity(metaByContract = {}) {
  const ids = new Set();
  const refs = new Set();
  for (const meta of Object.values(metaByContract || {})) {
    for (const id of [meta?.entryOrderId, meta?.exitOrderId]) if (id != null) ids.add(String(id));
    for (const ref of [meta?.entryOrderRefId, meta?.exitOrderRefId]) if (ref != null) refs.add(String(ref));
  }
  return { ids, refs };
}

export function classifyBrokerOrderOwner(order, metaByContract = {}) {
  const identity = automationOrderIdentity(metaByContract);
  const id = orderId(order);
  const ref = orderRef(order);
  if ((id != null && identity.ids.has(String(id))) || (ref != null && identity.refs.has(String(ref)))) {
    return "automation";
  }
  return "operator";
}

export function exactOrderContractKey(order = {}) {
  const instrumentId = order.option_id || order.instrument_id || order.instrumentId
    || order.option_instrument_id || order.legs?.[0]?.option_id || order.legs?.[0]?.instrument_id;
  if (instrumentId) return `id:${normalizeInstrumentId(instrumentId)}`;
  const occ = order.occ_symbol || order.occSymbol || order.option_symbol || order.legs?.[0]?.symbol;
  if (occ) return `occ:${String(occ).toUpperCase()}`;
  return null;
}

export function classifyWorkingOptionOrders(orders = [], metaByContract = {}, isTerminal = () => false) {
  return (Array.isArray(orders) ? orders : [])
    .filter(order => !isTerminal(order))
    .map(order => ({
      order,
      owner: classifyBrokerOrderOwner(order, metaByContract),
      contractKey: exactOrderContractKey(order),
      ticker: String(order.chain_symbol || order.symbol || "").toUpperCase() || null,
      side: String(order.side || order.direction || "").toLowerCase(),
      orderId: orderId(order),
      refId: orderRef(order),
    }));
}

export function mayMutateBrokerOrder(classification) {
  return classification?.owner === "automation";
}
