// IndexedDB Store tests, run in Node via fake-indexeddb.
// Mirrors the sqlite Store tests (db.test.ts) to prove interface parity.

import { test, before } from "node:test";
import assert from "node:assert/strict";

before(async () => {
  const { indexedDB, IDBKeyRange } = await import("fake-indexeddb");
  // @ts-expect-error installing global IndexedDB for the store under test
  globalThis.indexedDB = indexedDB;
  // @ts-expect-error IDBKeyRange used by fake-indexeddb internally
  globalThis.IDBKeyRange = IDBKeyRange;
});

import { openIndexedDbStore, TERMINAL_DM_STATUSES } from "../src/protocol/index.js";
import type { Store } from "../src/protocol/index.js";

const MNEMONIC =
  "leader monkey parrot ring guide accident before fence cannon height naive bean";

function freshStore(): Store {
  return openIndexedDbStore({ dbName: `test-${Date.now()}-${Math.random()}` });
}

test("idb: users upsert, get, atomic index reservation", async () => {
  const store = freshStore();
  await store.upsertUser({
    i0_pubkey: "abc",
    mnemonic: MNEMONIC,
    last_trade_index: null,
    created_at: 100,
  });

  const user = await store.getUser();
  assert.equal(user?.i0_pubkey, "abc");
  assert.equal(user?.last_trade_index, null);

  const first = await store.reserveNextTradeIndex(MNEMONIC, 1);
  assert.equal(first.nextIndex, 2);
  assert.equal((await store.getUser())?.last_trade_index, 2);

  await store.upsertUser({ i0_pubkey: "abc", mnemonic: MNEMONIC, last_trade_index: 1, created_at: 100 });
  assert.equal((await store.getUser())?.last_trade_index, 2, "monotonic");
});

test("idb: orders save, get, status update, active hydration", async () => {
  const store = freshStore();
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
  assert.equal(order?.status, "pending");
  assert.equal(order?.is_mine, 1);

  await store.updateOrderStatus("order-1", "fiat-sent");
  assert.equal((await store.getOrder("order-1"))?.status, "fiat-sent");

  await store.saveOrder({ ...base, id: "order-2", status: "canceled" });
  const active = await store.getActiveOrders(TERMINAL_DM_STATUSES);
  assert.deepEqual(active.map((o) => o.id).sort(), ["order-1"]);
});

test("idb: upsert preserves created_at", async () => {
  const store = freshStore();
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
    trade_keys: "x",
    counterparty_pubkey: null,
    is_mine: true,
    buyer_invoice: null,
    request_id: 1,
    trade_index: 2,
    created_at: 100,
    expires_at: 200,
  };
  await store.saveOrder({ ...base, id: "o" });
  const second = await store.saveOrder({ ...base, id: "o", created_at: 999, expires_at: 300 });
  assert.ok(!second.inserted);
  const order = await store.getOrder("o");
  assert.equal(order?.created_at, 100, "created_at preserved");
  assert.equal(order?.expires_at, 300);
});

test("idb: dispute id + solver chat persistence", async () => {
  const store = freshStore();
  const base = {
    kind: "sell" as const,
    status: "in-progress" as const,
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
    request_id: 1,
    trade_index: 2,
    created_at: 100,
    expires_at: 200,
  };
  await store.saveOrder({ ...base, id: "d-1" });
  await store.updateDisputeId("d-1", "dispute-uuid-9");
  assert.equal((await store.getOrder("d-1"))?.dispute_id, "dispute-uuid-9");

  await store.updateSolverChat("d-1", "solver-pub", "shared-hex");
  const row = await store.getOrder("d-1");
  assert.equal(row?.solver_pubkey, "solver-pub");
  assert.equal(row?.dispute_chat_shared_key_hex, "shared-hex");
});

test("idb: last_seen_dm_ts only advances", async () => {
  const store = freshStore();
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
    trade_keys: "x",
    counterparty_pubkey: null,
    is_mine: true,
    buyer_invoice: null,
    request_id: 1,
    trade_index: 2,
    created_at: 100,
    expires_at: 200,
  };
  await store.saveOrder({ ...base, id: "o" });
  await store.updateLastSeenDmTs("o", 500);
  await store.updateLastSeenDmTs("o", 300);
  assert.equal((await store.getOrder("o"))?.last_seen_dm_ts, 500);
});