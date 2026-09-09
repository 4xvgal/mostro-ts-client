import { test } from "node:test";
import assert from "node:assert/strict";

import { openSqliteStore, TERMINAL_DM_STATUSES } from "../src/protocol/index.js";
import type { Store } from "../src/protocol/index.js";

const MNEMONIC =
  "leader monkey parrot ring guide accident before fence cannon height naive bean";

async function freshStore(path?: string): Promise<Store> {
  return openSqliteStore(path ?? ":memory:");
}

test("users: upsert, get, atomic index reservation", async () => {
  const store = await freshStore();
  await store.upsertUser({
    i0_pubkey: "abc",
    mnemonic: MNEMONIC,
    last_trade_index: null,
    created_at: 100,
  });

  const user = await store.getUser();
  assert.equal(user?.i0_pubkey, "abc");
  assert.equal(user?.last_trade_index, null);

  // Reserve: noneBase 1 → first is 2.
  const first = await store.reserveNextTradeIndex(MNEMONIC, 1);
  assert.equal(first.nextIndex, 2);
  assert.equal((await store.getUser())?.last_trade_index, 2);

  // Monotonic: never decreases on upsert with stale counter.
  await store.upsertUser({
    i0_pubkey: "abc",
    mnemonic: MNEMONIC,
    last_trade_index: 1,
    created_at: 100,
  });
  assert.equal((await store.getUser())?.last_trade_index, 2);

  const second = await store.reserveNextTradeIndex(MNEMONIC, 1);
  assert.equal(second.nextIndex, 3);
});

test("orders: save, get, status update, active hydration", async () => {
  const store = await freshStore();
  const base = {
    kind: "sell" as const,
    status: "pending" as const,
    amount: 100,
    fiat_code: "USD",
    min_amount: null,
    max_amount: null,
    fiat_amount: 50,
    payment_method: "SEPA",
    premium: 0,
    trade_keys: "deadbeef",
    counterparty_pubkey: null,
    is_mine: true,
    buyer_invoice: null,
    request_id: 42,
    trade_index: 2,
    created_at: 100,
    expires_at: 200,
  };
  const { inserted } = await store.saveOrder({ id: "order-1", ...base });
  assert.ok(inserted);

  let order = await store.getOrder("order-1");
  assert.ok(order);
  assert.equal(order?.status, "pending");
  assert.equal(order?.is_mine, 1);
  assert.equal(order?.trade_index, 2);

  await store.updateOrderStatus("order-1", "fiat-sent");
  assert.equal((await store.getOrder("order-1"))?.status, "fiat-sent");

  // A terminal order must not appear in startup active hydration.
  await store.saveOrder({ ...base, id: "order-2", status: "canceled", trade_keys: "cafebabe" });

  const active = await store.getActiveOrders(TERMINAL_DM_STATUSES);
  assert.deepEqual(
    active.map((o) => o.id).sort(),
    ["order-1"],
  );

  await store.updateLastSeenDmTs("order-1", 500);
  await store.updateLastSeenDmTs("order-1", 300); // older → ignored
  assert.equal((await store.getOrder("order-1"))?.last_seen_dm_ts, 500);
});

test("orders: upsert on id collision preserves created_at", async () => {
  const store = await freshStore();
  const base = {
    kind: "sell" as const,
    status: "pending" as const,
    amount: 100,
    fiat_code: "USD",
    min_amount: null,
    max_amount: null,
    fiat_amount: 50,
    payment_method: "SEPA",
    premium: 0,
    trade_keys: "deadbeef",
    counterparty_pubkey: null,
    is_mine: true,
    buyer_invoice: null,
    request_id: 42,
    trade_index: 2,
    created_at: 100,
    expires_at: 200,
  };
  await store.saveOrder({ ...base, id: "o" });
  const second = await store.saveOrder({ ...base, id: "o", created_at: 222, expires_at: 300 });
  assert.ok(!second.inserted);

  const order = await store.getOrder("o");
  assert.equal(order?.created_at, 100, "created_at preserved on conflict");
  assert.equal(order?.expires_at, 300, "expires_at updated");
});

test("persistence across reopen (sqlite file)", async () => {
  const path = "/tmp/mostro-ts-store-test.db";
  const first = await freshStore(path);
  await first.upsertUser({ i0_pubkey: "abc", mnemonic: MNEMONIC, last_trade_index: 5, created_at: 1 });
  await first.saveOrder({
    id: "persist-1",
    kind: "sell",
    status: "pending",
    amount: 100,
    fiat_code: "USD",
    min_amount: null,
    max_amount: null,
    fiat_amount: 50,
    payment_method: "SEPA",
    premium: 0,
    trade_keys: "abc123",
    counterparty_pubkey: null,
    is_mine: true,
    buyer_invoice: null,
    request_id: 1,
    trade_index: 2,
    created_at: 1,
    expires_at: 2,
  });
  await first.close();

  const reopened = await freshStore(path);
  assert.equal((await reopened.getUser())?.last_trade_index, 5);
  assert.ok(await reopened.getOrder("persist-1"));
  await reopened.close();
});