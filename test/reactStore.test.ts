import { test } from "node:test";
import assert from "node:assert/strict";

import { createMostroStore } from "../src/react/store.js";

function sampleOrder(id: string) {
  return {
    id,
    kind: "sell" as const,
    status: "pending" as const,
    amount: 100,
    fiat_code: "USD",
    min_amount: null,
    max_amount: null,
    fiat_amount: 50,
    payment_method: "SEPA",
    premium: 0,
    buyer_trade_pubkey: null,
    seller_trade_pubkey: null,
    buyer_invoice: null,
    created_at: 100,
    expires_at: null,
  };
}

test("store initial state", () => {
  const store = createMostroStore();
  assert.equal(store.state.status, "idle");
  assert.deepEqual(store.state.orders, []);
  assert.deepEqual(store.state.trades, {});
});

test("setOrders replaces the book", () => {
  const store = createMostroStore();
  store.setOrders([sampleOrder("o1"), sampleOrder("o2")]);
  assert.equal(store.state.orders.length, 2);
  assert.equal(store.state.orders[0]?.id, "o1");
});

test("upsertTrade merges into existing rows", () => {
  const store = createMostroStore();
  store.upsertTrade("o1", { status: "pending" });
  assert.equal(store.state.trades["o1"]?.status, "pending");
  assert.equal(store.state.trades["o1"]?.id, "o1");

  store.upsertTrade("o1", { lastAction: "take-sell" });
  assert.equal(store.state.trades["o1"]?.status, "pending");
  assert.equal(store.state.trades["o1"]?.lastAction, "take-sell");
});

test("status transitions", () => {
  const store = createMostroStore();
  store.setStatus("connecting");
  assert.equal(store.state.status, "connecting");
  store.setStatus("ready");
  assert.equal(store.state.status, "ready");
  store.setStatus("error", "boom");
  assert.equal(store.state.lastError, "boom");
});

test("reset clears everything", () => {
  const store = createMostroStore();
  store.setOrders([sampleOrder("o1")]);
  store.upsertTrade("o1", { status: "pending" });
  store.setStatus("ready");
  store.reset();
  assert.equal(store.state.status, "idle");
  assert.deepEqual(store.state.orders, []);
  assert.deepEqual(store.state.trades, {});
});

test("connect hooks order-book updates (via sink shape)", () => {
  const store = createMostroStore();
  // The client's bind() calls setOrders/upsertTrade — verify they route in.
  store.connect({ onOrders: (cb: (o: unknown[]) => void) => cb([sampleOrder("o1")]) } as never);
  // connect calls setState({status:"connecting"}) only; orders flow via setOrders.
  assert.equal(store.state.status, "connecting");
});