import { test } from "node:test";
import assert from "node:assert/strict";

import {
  computeNextTradePayload,
  buildTradeCompletionMessage,
  deriveTradeKeys,
} from "../src/protocol/index.js";
import type { SmallOrder } from "../src/protocol/index.js";

const MNEMONIC =
  "leader monkey parrot ring guide accident before fence cannon height naive bean";

function rangeOrder(overrides: Partial<SmallOrder> = {}): SmallOrder {
  return {
    id: "o1",
    kind: "sell",
    status: "in-progress",
    amount: 0,
    fiat_code: "USD",
    min_amount: 100,
    max_amount: 300,
    fiat_amount: 0,
    payment_method: "SEPA",
    premium: 0,
    buyer_trade_pubkey: null,
    seller_trade_pubkey: null,
    buyer_invoice: null,
    created_at: 0,
    expires_at: null,
    ...overrides,
  };
}

test("range order with remaining amount produces NextTrade", () => {
  const keys = deriveTradeKeys(MNEMONIC, 2);
  const payload = computeNextTradePayload({
    order: rangeOrder({ fiat_amount: 100 }), // remaining 200 >= min 100
    reserveNext: () => ({ nextIndex: 2, keys }),
  });
  assert.deepEqual(payload, {
    variant: "next_trade",
    value: [keys.pubkey, 2],
  });
});

test("range order exhausted → null (no NextTrade)", () => {
  // remaining = 300 - 250 = 50 < min 100
  const payload = computeNextTradePayload({
    order: rangeOrder({ fiat_amount: 250 }),
    reserveNext: () => {
      throw new Error("should not reserve");
    },
  });
  assert.equal(payload, null);
});

test("fixed order (no min/max) → null", () => {
  const fixed = { ...rangeOrder(), min_amount: null, max_amount: null };
  const payload = computeNextTradePayload({
    order: fixed,
    reserveNext: () => {
      throw new Error("should not reserve");
    },
  });
  assert.equal(payload, null);
});

test("buildTradeCompletionMessage carries NextTrade or null", () => {
  const keys = deriveTradeKeys(MNEMONIC, 1);
  const nextTrade = {
    variant: "next_trade" as const,
    value: [keys.pubkey, 2] as [string, number],
  };
  const withNext = buildTradeCompletionMessage({
    orderId: "o1",
    requestId: 42,
    action: "release",
    nextTrade,
  });
  assert.equal(withNext.value.action, "release");
  assert.deepEqual(withNext.value.payload, nextTrade);

  const without = buildTradeCompletionMessage({
    orderId: "o1",
    requestId: 43,
    action: "fiat-sent",
    nextTrade: null,
  });
  assert.equal(without.value.action, "fiat-sent");
  assert.equal(without.value.payload, null);
});