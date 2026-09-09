import { test } from "node:test";
import assert from "node:assert/strict";

import { applyTradeDm, TERMINAL_DM_STATUSES } from "../../src/protocol/index.js";
import { openNodeSqliteStore } from "../../src/protocol/node-store.js";
import type { Message, MessageKind, Store } from "../../src/protocol/index.js";

const UUID = "308e1272-d5f4-47e6-bd97-3504baea9c23";
const TRADE_SECRET =
  "548f68890c49fa42f104c60352395e60ff030b0b407e955f1eed1400d6c0347a";

async function seedOrder(store: Store, status = "in-progress") {
  await store.saveOrder({
    id: UUID,
    kind: "sell",
    status,
    amount: 100,
    fiat_code: "USD",
    min_amount: null,
    max_amount: null,
    fiat_amount: 50,
    payment_method: "SEPA",
    premium: 0,
    trade_keys: TRADE_SECRET,
    counterparty_pubkey: null,
    is_mine: true,
    buyer_invoice: null,
    request_id: 1,
    trade_index: 2,
    created_at: 100,
    expires_at: null,
  });
}

function msg(action: string, payload: MessageKind["payload"], id: string = UUID): Message {
  return {
    variant: "order",
    value: { version: 2, request_id: 1, trade_index: 2, id, action: action as never, payload },
  };
}

function orderPayload(overrides: Record<string, unknown> = {}) {
  return {
    variant: "order" as const,
    value: {
      id: UUID,
      kind: "sell",
      status: "waiting-buyer-invoice",
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
      ...overrides,
    },
  };
}

test("add-invoice upserts order with monotonic status", async () => {
  const store = openNodeSqliteStore();
  const result = await applyTradeDm({
    store,
    orderId: UUID,
    tradeSecretHex: TRADE_SECRET,
    message: msg("add-invoice", orderPayload()),
  });
  assert.ok(result.orderUpserted);
  assert.equal(result.status, "waiting-buyer-invoice");

  const order = await store.getOrder(UUID);
  assert.equal(order?.status, "waiting-buyer-invoice");
  assert.equal(order?.kind, "sell");
  assert.equal(order?.trade_index, 2);
});

test("backward status is rejected", async () => {
  const store = openNodeSqliteStore();
  // Seed at success.
  await store.saveOrder({
    id: UUID,
    kind: "sell",
    status: "success",
    amount: 100,
    fiat_code: "USD",
    min_amount: null,
    max_amount: null,
    fiat_amount: 50,
    payment_method: "SEPA",
    premium: 0,
    trade_keys: "x",
    counterparty_pubkey: null,
    is_mine: true,
    buyer_invoice: null,
    request_id: 1,
    trade_index: 2,
    created_at: 100,
    expires_at: null,
  });

  // Stale DM tries to regress to pending — must be rejected.
  const result = await applyTradeDm({
    store,
    orderId: UUID,
    tradeSecretHex: TRADE_SECRET,
    message: msg("new-order", orderPayload({ status: "pending" })),
  });
  assert.equal(result.status, null);
  assert.equal((await store.getOrder(UUID))?.status, "success");
});

test("post-retry AddInvoice reopens success → settled-hold-invoice", async () => {
  const store = openNodeSqliteStore();
  await store.saveOrder({
    id: UUID,
    kind: "sell",
    status: "success",
    amount: 100,
    fiat_code: "USD",
    min_amount: null,
    max_amount: null,
    fiat_amount: 50,
    payment_method: "SEPA",
    premium: 0,
    trade_keys: "x",
    counterparty_pubkey: null,
    is_mine: true,
    buyer_invoice: null,
    request_id: 1,
    trade_index: 2,
    created_at: 100,
    expires_at: null,
  });
  const result = await applyTradeDm({
    store,
    orderId: UUID,
    tradeSecretHex: TRADE_SECRET,
    message: msg("add-invoice", orderPayload({ status: "settled-hold-invoice" })),
  });
  assert.equal(result.status, "settled-hold-invoice");
});

test("dispute-initiated-by-you persists dispute id", async () => {
  const store = openNodeSqliteStore();
  await seedOrder(store);
  const result = await applyTradeDm({
    store,
    orderId: UUID,
    tradeSecretHex: TRADE_SECRET,
    message: msg("dispute-initiated-by-you", {
      variant: "dispute",
      value: ["dispute-uuid-9", null],
    }),
  });
  assert.equal(result.disputeId, "dispute-uuid-9");
  assert.equal((await store.getOrder(UUID))?.dispute_id, "dispute-uuid-9");
});

test("admin-took-dispute derives and persists solver chat key", async () => {
  const store = openNodeSqliteStore();
  await seedOrder(store, "dispute");

  const solverPubkey = "f671551574daa8c6e5f35865a5596d131a0412f7d04bae0305538c8f46f90ed1";
  const result = await applyTradeDm({
    store,
    orderId: UUID,
    tradeSecretHex: TRADE_SECRET,
    message: msg("admin-took-dispute", {
      variant: "peer",
      value: { pubkey: solverPubkey, reputation: null },
    }),
  });
  assert.equal(result.solver?.pubkey, solverPubkey);
  assert.ok(result.solver?.sharedKeyHex);

  const order = await store.getOrder(UUID);
  assert.equal(order?.solver_pubkey, solverPubkey);
  assert.equal(order?.dispute_chat_shared_key_hex, result.solver?.sharedKeyHex);
});

test("cant-do never applies payload status", async () => {
  const store = openNodeSqliteStore();
  const result = await applyTradeDm({
    store,
    orderId: UUID,
    tradeSecretHex: TRADE_SECRET,
    message: msg("cant-do", { variant: "cant_do", value: "not_allowed_by_status" }),
  });
  assert.equal(result.status, null);
  assert.equal(result.orderUpserted, false);
});
