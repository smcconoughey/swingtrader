import test from "node:test";
import assert from "node:assert/strict";

let transportMockAvailable = false;

async function loadRobinhood() {
  try {
    const { registerHooks } = await import("node:module");
    if (typeof registerHooks === "function") {
      globalThis.__robinhoodTransportFetchStub = async () => {
        throw new Error("unexpected Robinhood network call");
      };
      registerHooks({
        resolve(specifier, context, nextResolve) {
          if (specifier === "node-fetch") return { url: "test:robinhood-node-fetch", shortCircuit: true };
          return nextResolve(specifier, context);
        },
        load(url, context, nextLoad) {
          if (url === "test:robinhood-node-fetch") {
            return {
              format: "module",
              shortCircuit: true,
              source: "export default (...args) => globalThis.__robinhoodTransportFetchStub(...args);",
            };
          }
          return nextLoad(url, context);
        },
      });
      transportMockAvailable = true;
      return (await import("../robinhood.js?transport-test-stub=1")).default;
    }
  } catch { }

  return (await import("../robinhood.js")).default;
}

const robinhood = await loadRobinhood();

test("read-only health probe fails closed and exposes failure telemetry when unauthenticated", async () => {
  assert.equal(robinhood.healthStatus, "unknown");
  assert.equal(robinhood.health.lastCheckAt, null);

  const [first, concurrent] = await Promise.all([
    robinhood.healthCheck(),
    robinhood.healthCheck(),
  ]);

  assert.equal(first, false);
  assert.equal(concurrent, false);
  assert.equal(robinhood.isConnected, false);
  assert.equal(robinhood.healthStatus, "unhealthy");
  assert.equal(robinhood.health.checking, false);
  assert.equal(robinhood.health.initialized, false);
  assert.equal(robinhood.health.probe, "get_accounts");
  assert.match(robinhood.lastHealthError, /not authenticated/i);
  assert.equal(typeof robinhood.lastHealthCheckAt, "number");
  assert.equal(robinhood.lastHealthFailureAt, robinhood.lastHealthCheckAt);
  assert.equal(robinhood.lastHealthSuccessAt, null);
});

test("probe alias preserves the boolean health-check contract", async () => {
  assert.equal(await robinhood.probe(), false);
  assert.equal(robinhood.healthStatus, "unhealthy");
  assert.equal(robinhood.health.checking, false);
});

test("read-only probe state and caller idempotency fail closed against discovered schemas", {
  skip: !transportMockAvailable && "module transport hooks unavailable on this Node runtime",
}, async () => {
  const originalToken = process.env.ROBINHOOD_ACCESS_TOKEN;
  let optionPlacementCalls = 0;
  let placedRefId = null;
  let placementSupportsRefId = false;
  let failAccountProbe = false;

  const response = (payload, status = 200, extraHeaders = {}) => ({
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get(name) {
        if (String(name).toLowerCase() === "content-type") return "application/json";
        return extraHeaders[String(name).toLowerCase()] || null;
      },
    },
    async json() { return payload; },
    async text() { return typeof payload === "string" ? payload : JSON.stringify(payload); },
  });

  globalThis.__robinhoodTransportFetchStub = async (_url, request = {}) => {
    const body = JSON.parse(request.body || "{}");
    if (body.method === "initialize") {
      return response({ jsonrpc: "2.0", id: body.id, result: { serverInfo: { name: "test-mcp" } } }, 200, {
        "mcp-session-id": "test-session",
      });
    }
    if (body.method === "notifications/initialized") return response({}, 202);
    if (body.method === "tools/list") {
      return response({
        jsonrpc: "2.0",
        id: body.id,
        result: {
          tools: [
            { name: "get_accounts", inputSchema: { type: "object", properties: {} } },
            { name: "get_option_positions", inputSchema: { type: "object", properties: { account_number: {} } } },
            {
              name: "place_option_order",
              inputSchema: {
                type: "object",
                properties: {
                  account_number: {}, legs: {}, type: {}, quantity: {}, time_in_force: {}, price: {},
                  ...(placementSupportsRefId ? { ref_id: {} } : {}),
                },
                additionalProperties: false,
              },
            },
          ],
        },
      });
    }
    if (body.method === "tools/call" && body.params?.name === "get_accounts") {
      if (failAccountProbe) return response("test probe unavailable", 503);
      return response({
        jsonrpc: "2.0",
        id: body.id,
        result: {
          content: [{ type: "text", text: JSON.stringify([{ account_number: "TEST-ACCOUNT", agentic_allowed: true }]) }],
        },
      });
    }
    if (body.method === "tools/call" && body.params?.name === "place_option_order") {
      optionPlacementCalls += 1;
      placedRefId = body.params.arguments?.ref_id || null;
      return response({ jsonrpc: "2.0", id: body.id, result: { content: [] } });
    }
    throw new Error(`unexpected test MCP method ${body.method}/${body.params?.name || ""}`);
  };

  process.env.ROBINHOOD_ACCESS_TOKEN = "test-access-token";
  try {
    assert.equal(await robinhood.init(), true);
    assert.equal(await robinhood.healthCheck(), true);
    assert.equal(robinhood.healthStatus, "healthy");
    assert.equal(robinhood.health.lastSuccessAt, robinhood.lastHealthCheckAt);
    assert.equal(robinhood.isConnected, true);

    await assert.rejects(
      robinhood.getPortfolio("UNSELECTED-ACCOUNT"),
      /account safety block/i,
    );

    await assert.rejects(
      robinhood.placeOptionOrder({
        symbol: "SPY",
        expirationDate: "2026-08-21",
        strikePrice: 700,
        optionType: "call",
        side: "buy_to_open",
        quantity: 1,
        type: "limit",
        limitPrice: "1.00",
        refId: "persistent-recovery-key",
        optionId: "test-option-id",
      }),
      error => error?.code === "RH_IDEMPOTENCY_UNSUPPORTED" && error?.idempotencyUnsupported === true,
    );
    assert.equal(optionPlacementCalls, 0);

    placementSupportsRefId = true;
    assert.equal(await robinhood.init({ reload: false }), true);
    await robinhood.placeOptionOrder({
      symbol: "SPY",
      expirationDate: "2026-08-21",
      strikePrice: 700,
      optionType: "call",
      side: "buy_to_open",
      quantity: 1,
      type: "limit",
      limitPrice: "1.00",
      refId: "preserved-recovery-key",
      optionId: "test-option-id",
    });
    assert.equal(optionPlacementCalls, 1);
    assert.equal(placedRefId, "preserved-recovery-key");

    failAccountProbe = true;
    assert.equal(await robinhood.healthCheck(), false);
    assert.equal(robinhood.isConnected, false);
    assert.equal(robinhood.healthStatus, "unhealthy");
    assert.match(robinhood.lastHealthError, /MCP HTTP 503/i);
    assert.equal(robinhood.lastHealthFailureAt, robinhood.lastHealthCheckAt);
  } finally {
    if (originalToken === undefined) delete process.env.ROBINHOOD_ACCESS_TOKEN;
    else process.env.ROBINHOOD_ACCESS_TOKEN = originalToken;
  }
});
