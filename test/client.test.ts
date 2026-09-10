// MostroClient createOrder/takeOrder -> NextStep mapping and waitForOrderLive.
//
// Uses the exact reply shapes observed from the regtest daemon (new-order,
// pay-bond-invoice, pay-invoice, add-invoice), so the e2e bond/take flows are
// covered offline: only the private roundtrip/router/fetchOrders are stubbed.

import test from "node:test";
import assert from "node:assert/strict";

import { MostroClient, generateMnemonic, mnemonicToSeed } from "../src/protocol/index.js";
import type { Message, MessageKind, SmallOrder } from "../src/protocol/index.js";
import { openNodeSqliteStore } from "../src/protocol/node-store.js";

const MOSTRO = "6c4b8b42b8bda8e59a155788271ba54febe8bd1dbf1319f3ff0a68d9770ecbbe";

function smallOrder(over: Record<string, unknown> = {}): SmallOrder {
  return {
    id: "order-1",
    kind: "sell",
    status: "pending",
    amount: 0,
    fiat_code: "USD",
    min_amount: null,
    max_amount: null,
    fiat_amount: 25,
    payment_method: "SEPA",
    premium: 0,
    buyer_trade_pubkey: null,
    seller_trade_pubkey: null,
    buyer_invoice: null,
    created_at: 1,
    expires_at: 2,
    ...over,
  } as unknown as SmallOrder;
}

/** Build a reply echoing the request_id the client generated. */
function reply(message: Message, over: Partial<MessageKind>): MessageKind {
  return {
    version: 2,
    request_id: message.value.request_id ?? 0,
    trade_index: 2,
    id: "order-1",
    action: "new-order",
    payload: null,
    ...over,
  } as MessageKind;
}

function makeClient(
  onMessage: (message: Message) => MessageKind = () => {
    throw new Error("roundtrip not stubbed for this test");
  },
): MostroClient {
  const client = new MostroClient({
    seed: mnemonicToSeed(generateMnemonic()),
    mostroPubkey: MOSTRO,
    relays: ["ws://localhost:1"],
    store: openNodeSqliteStore(),
  });
  // No network: stub the router (trackOrder) and the DM roundtrip.
  (client as unknown as { router: { trackOrder(): void } }).router = { trackOrder() {} };
  (client as unknown as { roundtrip: (t: string, m: Message) => Promise<MessageKind> }).roundtrip =
    async (_tradeSecret, message) => onMessage(message);
  return client;
}

const createInput = { kind: "sell" as const, fiatAmount: 25, paymentMethod: "SEPA" };

test("createOrder: order-created -> next none", async () => {
  const client = makeClient((m) =>
    reply(m, { action: "new-order", payload: { variant: "order", value: smallOrder() } }),
  );
  try {
    const res = await client.createOrder(createInput);
    assert.equal(res.orderId, "order-1");
    assert.equal(res.status, "pending");
    assert.deepEqual(res.next, { type: "none" });
  } finally {
    await client.stop();
  }
});

test("createOrder: pay-bond-invoice -> pay-bond(maker)", async () => {
  const order = smallOrder({ id: "bond-1", amount: 1000 });
  const client = makeClient((m) =>
    reply(m, {
      id: "bond-1",
      action: "pay-bond-invoice",
      payload: { variant: "payment_request", value: [order, "lnbcrt1", 1000] },
    }),
  );
  try {
    const res = await client.createOrder(createInput);
    assert.equal(res.orderId, "bond-1");
    assert.equal(res.status, "waiting-maker-bond");
    assert.deepEqual(res.next, { type: "pay-bond", role: "maker", invoice: "lnbcrt1", amount: 1000 });
  } finally {
    await client.stop();
  }
});

test("createOrder: bond amount falls back to order.amount when tuple is null", async () => {
  const order = smallOrder({ id: "bond-2", amount: 1000 });
  const client = makeClient((m) =>
    reply(m, {
      id: "bond-2",
      action: "pay-bond-invoice",
      payload: { variant: "payment_request", value: [order, "lnbcrt2", null] },
    }),
  );
  try {
    const res = await client.createOrder(createInput);
    assert.deepEqual(res.next, { type: "pay-bond", role: "maker", invoice: "lnbcrt2", amount: 1000 });
  } finally {
    await client.stop();
  }
});

test("takeOrder: pay-invoice -> pay-hold-invoice", async () => {
  const order = smallOrder({ id: "t-1" });
  const client = makeClient((m) =>
    reply(m, {
      id: "t-1",
      action: "pay-invoice",
      payload: { variant: "payment_request", value: [order, "lnbcrt3", 5000] },
    }),
  );
  try {
    const res = await client.takeOrder(order);
    assert.equal(res.orderId, "t-1");
    assert.deepEqual(res.next, { type: "pay-hold-invoice", invoice: "lnbcrt3", amount: 5000 });
  } finally {
    await client.stop();
  }
});

test("takeOrder: pay-bond-invoice -> pay-bond(taker)", async () => {
  const order = smallOrder({ id: "t-2" });
  const client = makeClient((m) =>
    reply(m, {
      id: "t-2",
      action: "pay-bond-invoice",
      payload: { variant: "payment_request", value: [order, "lnbcrt4", 1000] },
    }),
  );
  try {
    const res = await client.takeOrder(order);
    assert.equal(res.orderId, "t-2");
    assert.deepEqual(res.next, { type: "pay-bond", role: "taker", invoice: "lnbcrt4", amount: 1000 });
  } finally {
    await client.stop();
  }
});

test("takeOrder: add-invoice -> add-invoice(amount)", async () => {
  const order = smallOrder({ id: "t-3", amount: 21 });
  const client = makeClient((m) =>
    reply(m, { id: "t-3", action: "add-invoice", payload: { variant: "order", value: order } }),
  );
  try {
    const res = await client.takeOrder(order);
    assert.equal(res.orderId, "t-3");
    assert.deepEqual(res.next, { type: "add-invoice", amount: 21 });
  } finally {
    await client.stop();
  }
});

test("waitForOrderLive resolves once the order is in the book", async () => {
  const client = makeClient();
  let calls = 0;
  (client as unknown as { fetchOrders: () => Promise<SmallOrder[]> }).fetchOrders = async () => {
    calls += 1;
    return calls >= 2 ? [smallOrder({ id: "live-1" })] : [];
  };
  try {
    await client.waitForOrderLive("live-1", 5000);
    assert.ok(calls >= 2, "polled until the order appeared");
  } finally {
    await client.stop();
  }
});

test("waitForOrderLive rejects on timeout", async () => {
  const client = makeClient();
  (client as unknown as { fetchOrders: () => Promise<SmallOrder[]> }).fetchOrders = async () => [];
  try {
    await assert.rejects(client.waitForOrderLive("nope", 60), /did not go live within 60ms/);
  } finally {
    await client.stop();
  }
});
