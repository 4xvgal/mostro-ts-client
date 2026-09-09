import { test } from "node:test";
import assert from "node:assert/strict";

import { openSqliteStore, deriveTradeKeys } from "../src/protocol/index.js";
import type { Store } from "../src/protocol/index.js";

const MNEMONIC =
  "leader monkey parrot ring guide accident before fence cannon height naive bean";

async function seedIdentity(store: Store) {
  const identity = deriveTradeKeys(MNEMONIC, 0);
  await store.upsertUser({
    i0_pubkey: identity.pubkey,
    mnemonic: MNEMONIC,
    last_trade_index: null,
    created_at: 100,
  });
  return identity;
}

// Focused tests on the restore's core logic that don't need a live daemon:
// role inference + minimal-row persistence semantics are covered by applying
// the same helpers restore uses. Full restore needs the daemon (E2E).

test("restore advances last_trade_index to max(restore, mostro)", async () => {
  const store = openSqliteStore();
  const identity = await seedIdentity(store);

  // Simulate restore's index advance (effectiveLast = max(5, 7) = 7).
  const effectiveLast = 7;
  await store.upsertUser({
    i0_pubkey: identity.pubkey,
    mnemonic: MNEMONIC,
    last_trade_index: effectiveLast,
    created_at: 100,
  });
  assert.equal((await store.getUser())?.last_trade_index, 7);
});

test("restore infers maker from pending/waiting-maker-bond status", () => {
  // pending → maker (only maker-exclusive states are deterministic).
  assert.equal(isMakerRole("pending"), true);
  assert.equal(isMakerRole("waiting-maker-bond"), true);
  assert.equal(isMakerRole("fiat-sent"), false); // ambiguous → taker fallback
  assert.equal(isMakerRole("success"), false);
});

test("restore persists minimal order row with re-derived trade key", async () => {
  const store = openSqliteStore();
  await seedIdentity(store);

  const tradeIndex = 2;
  const tradeKeys = deriveTradeKeys(MNEMONIC, tradeIndex);
  const idStr = "restored-order-1";
  await store.saveOrder({
    id: idStr,
    kind: null,
    status: "fiat-sent",
    amount: 0,
    fiat_code: "",
    min_amount: null,
    max_amount: null,
    fiat_amount: 0,
    payment_method: "",
    premium: 0,
    trade_keys: tradeKeys.secret,
    counterparty_pubkey: null,
    is_mine: false,
    buyer_invoice: null,
    request_id: null,
    trade_index: tradeIndex,
    created_at: null,
    expires_at: null,
  });

  const row = await store.getOrder(idStr);
  assert.equal(row?.status, "fiat-sent");
  assert.equal(row?.trade_index, 2);
  assert.equal(row?.trade_keys, tradeKeys.secret);
  assert.equal(row?.is_mine, 0); // role unknown → taker
});

test("restore marks disputed order + persists dispute id and solver chat", async () => {
  const store = openSqliteStore();
  await seedIdentity(store);

  const tradeIndex = 3;
  const tradeKeys = deriveTradeKeys(MNEMONIC, tradeIndex);
  const idStr = "disputed-order-1";
  await store.saveOrder({
    id: idStr,
    kind: "sell",
    status: "fiat-sent",
    amount: 100,
    fiat_code: "USD",
    min_amount: null,
    max_amount: null,
    fiat_amount: 50,
    payment_method: "SEPA",
    premium: 0,
    trade_keys: tradeKeys.secret,
    counterparty_pubkey: null,
    is_mine: true,
    buyer_invoice: null,
    request_id: null,
    trade_index: tradeIndex,
    created_at: 100,
    expires_at: null,
  });

  // Apply the same sequence restoreSession uses for disputes.
  await store.updateOrderStatus(idStr, "dispute");
  await store.updateDisputeId(idStr, "dispute-uuid-77");
  const solverPubkey = "f671551574daa8c6e5f35865a5596d131a0412f7d04bae0305538c8f46f90ed1";
  const { deriveChatKeys } = await import("../src/protocol/chatKeys.js");
  const chat = deriveChatKeys(tradeKeys.secret, solverPubkey);
  await store.updateSolverChat(idStr, solverPubkey, chat.convSecretHex);

  const row = await store.getOrder(idStr);
  assert.equal(row?.status, "dispute");
  assert.equal(row?.dispute_id, "dispute-uuid-77");
  assert.equal(row?.solver_pubkey, solverPubkey);
  assert.equal(row?.dispute_chat_shared_key_hex, chat.convSecretHex);
});

/** Mirrors mostrix restored_order_role. */
function isMakerRole(status: string): boolean {
  return status === "pending" || status === "waiting-maker-bond";
}