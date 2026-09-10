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

test("connect binds the client sink into the store", () => {
  const store = createMostroStore();
  let sink: {
    setOrders: (o: unknown[]) => void;
    upsertTrade: (id: string, row: unknown) => void;
    setUser: (u: { pubkey: string; lastTradeIndex: number }) => void;
    upsertChatMessage: (id: string, scope: "order" | "dispute", msg: unknown) => void;
  } | null = null;
  store.connect({
    bind: (s: typeof sink) => {
      sink = s;
    },
  } as never);
  assert.equal(store.state.status, "connecting");
  sink!.setOrders([sampleOrder("o1")]);
  assert.equal(store.state.orders.length, 1);
  sink!.setUser({ pubkey: "pk", lastTradeIndex: 2 });
  assert.equal(store.state.status, "ready");
  assert.equal(store.state.user?.pubkey, "pk");
  sink!.upsertChatMessage("o1", "order", {
    content: "hi",
    sender: "s",
    created_at: 1,
    innerEventId: "",
    outerEventId: "e1",
  });
  assert.equal(store.state.chats.o1?.order.length, 1);
  assert.equal(store.state.chats.o1?.order[0]?.content, "hi");
});