// Shared storage contract — run against every Store backend.
//
// Each runtime adapter (node / bun / browser) passes its own runner
// ({ test, assert }) so this file stays runner-agnostic.

import type { Store } from "../src/protocol/store.js";
import { TERMINAL_DM_STATUSES } from "../src/protocol/index.js";

export const MNEMONIC =
  "leader monkey parrot ring guide accident before fence cannon height naive bean";

type Runner = {
  test: (name: string, fn: () => Promise<void> | void) => void;
  assert: {
    equal: (actual: unknown, expected: unknown, msg?: string) => void;
    ok: (value: unknown, msg?: string) => void;
  };
};

function baseOrder(id: string) {
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
    trade_keys: "deadbeef",
    counterparty_pubkey: null,
    is_mine: true,
    buyer_invoice: null,
    request_id: 42,
    trade_index: 2,
    created_at: 100,
    expires_at: 200,
  };
}

/** Run the full storage contract against `open` (a fresh-store factory). */
export function storageContract(runner: Runner, open: () => Store): void {
  const { test, assert } = runner;

  test("users: upsert, get, atomic index reservation", async () => {
    const store = open();
    await store.upsertUser({ i0_pubkey: "abc", mnemonic: MNEMONIC, last_trade_index: null, created_at: 100 });
    const user = await store.getUser();
    assert.equal(user?.i0_pubkey, "abc");
    assert.equal(user?.last_trade_index, null);

    const first = await store.reserveNextTradeIndex(MNEMONIC, 1);
    assert.equal(first.nextIndex, 2);
    assert.equal((await store.getUser())?.last_trade_index, 2);

    await store.upsertUser({ i0_pubkey: "abc", mnemonic: MNEMONIC, last_trade_index: 1, created_at: 100 });
    assert.equal((await store.getUser())?.last_trade_index, 2, "monotonic");
    await store.close();
  });

  test("orders: save, get, status update, active hydration", async () => {
    const store = open();
    const { inserted } = await store.saveOrder(baseOrder("order-1"));
    assert.equal(inserted, true);

    const order = await store.getOrder("order-1");
    assert.equal(order?.status, "pending");
    assert.equal(order?.is_mine, 1);

    await store.updateOrderStatus("order-1", "fiat-sent");
    assert.equal((await store.getOrder("order-1"))?.status, "fiat-sent");

    await store.saveOrder({ ...baseOrder("order-2"), status: "canceled" });
    const active = await store.getActiveOrders(TERMINAL_DM_STATUSES);
    assert.equal(active.map((o) => o.id).sort().join(","), "order-1");
    await store.close();
  });

  test("orders: upsert preserves created_at", async () => {
    const store = open();
    await store.saveOrder(baseOrder("o"));
    const second = await store.saveOrder({ ...baseOrder("o"), created_at: 999, expires_at: 300 });
    assert.equal(second.inserted, false);
    const order = await store.getOrder("o");
    assert.equal(order?.created_at, 100, "created_at preserved");
    assert.equal(order?.expires_at, 300);
    await store.close();
  });

  test("dispute id + solver chat persistence", async () => {
    const store = open();
    await store.saveOrder(baseOrder("d-1"));
    await store.updateDisputeId("d-1", "dispute-uuid-9");
    assert.equal((await store.getOrder("d-1"))?.dispute_id, "dispute-uuid-9");

    await store.updateSolverChat("d-1", "solver-pub", "shared-hex");
    const row = await store.getOrder("d-1");
    assert.equal(row?.solver_pubkey, "solver-pub");
    assert.equal(row?.dispute_chat_shared_key_hex, "shared-hex");
    await store.close();
  });

  test("last_seen_dm_ts only advances", async () => {
    const store = open();
    await store.saveOrder(baseOrder("o"));
    await store.updateLastSeenDmTs("o", 500);
    await store.updateLastSeenDmTs("o", 300);
    assert.equal((await store.getOrder("o"))?.last_seen_dm_ts, 500);
    await store.close();
  });

  void assert;
}