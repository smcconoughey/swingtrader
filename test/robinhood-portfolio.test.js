import test from "node:test";
import assert from "node:assert/strict";

import {
  diffRobinhoodTradeHistory,
  extractRobinhoodPortfolioFields,
  parseMoneyAmount,
} from "../robinhood-portfolio.js";

test("parseMoneyAmount accepts strings, numbers, and {amount} objects", () => {
  assert.equal(parseMoneyAmount("665.16"), 665.16);
  assert.equal(parseMoneyAmount(100), 100);
  assert.equal(parseMoneyAmount({ amount: "12.50", currency: "USD" }), 12.5);
  assert.equal(parseMoneyAmount(null), null);
  assert.equal(parseMoneyAmount("abc"), null);
});

test("extractRobinhoodPortfolioFields prefers total_value over zero equity_value", () => {
  const fields = extractRobinhoodPortfolioFields({
    data: {
      total_value: "665.16",
      equity_value: "0",
      options_value: "0",
      cash: "665.16",
      buying_power: { buying_power: "665.1600", display_currency: "USD" },
    },
  });
  assert.equal(fields.totalEquity, 665.16);
  assert.equal(fields.buyingPower, 665.16);
  assert.equal(fields.equityValue, 0);
  assert.equal(fields.source, "total_value");
});

test("extractRobinhoodPortfolioFields does not treat equity_value string zero as account value", () => {
  // Regression: `equity_value ?? total_value` and `equity_value || total_value` both
  // incorrectly selected "0" because nullish coalescing keeps 0 and || keeps truthy "0".
  const fields = extractRobinhoodPortfolioFields({
    equity_value: "0",
    total_value: "1316.00",
    buying_power: "800",
  });
  assert.equal(fields.totalEquity, 1316);
  assert.equal(fields.buyingPower, 800);
});

test("extractRobinhoodPortfolioFields derives total from sleeves when total_value absent", () => {
  const fields = extractRobinhoodPortfolioFields({
    equity_value: "100",
    options_value: "250",
    cash: "50",
    buying_power: "50",
  });
  assert.equal(fields.totalEquity, 400);
  assert.equal(fields.source, "derived");
});

test("diffRobinhoodTradeHistory flags broker trades missing locally", () => {
  const local = [{
    ticker: "PATH",
    type: "call",
    strike: 12,
    occSymbol: "PATH260807C00012000",
    qty: 1,
    closeDate: "2026-07-21",
    pnlDollar: -60,
  }];
  const broker = {
    results: [
      {
        symbol: "PATH",
        option_type: "call",
        strike_price: 12,
        occ_symbol: "PATH260807C00012000",
        quantity: 1,
        close_date: "2026-07-21",
        realized_pnl: "-60",
      },
      {
        symbol: "NVDA",
        option_type: "call",
        strike_price: 180,
        occ_symbol: "NVDA260815C00180000",
        quantity: 1,
        close_date: "2026-07-15",
        realized_pnl: "40",
      },
    ],
  };
  const diff = diffRobinhoodTradeHistory(local, broker);
  assert.equal(diff.localTradeCount, 1);
  assert.equal(diff.brokerTradeCount, 2);
  assert.equal(diff.missingLocally.length, 1);
  assert.equal(diff.missingLocally[0].ticker, "NVDA");
  assert.equal(diff.missingAtBroker.length, 0);
  assert.equal(diff.pnlGap, 40);
});
