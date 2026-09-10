// Session restore — recover orders/disputes for this identity from Mostro.
// Ported from mostrix `src/util/order_utils/execute_restore.rs` +
// `src/util/sync_trade_index.rs`.

import { SimplePool } from "nostr-tools/pool";
import type { NostrEvent } from "nostr-tools/core";
import { newRestoreMessage } from "./message.js";
import { newOrderMessage } from "./message.js";
import type { Message, Payload, RestoreSessionInfo } from "./message.js";
import { sendDm } from "./dmRouter.js";
import { unwrapMessageNip44, verifyEventSignature } from "./transport.js";
import { deriveTradeKeys } from "./keys.js";
import { isTerminalTradeStatus } from "./stateMachine.js";
import type { Store } from "./store.js";

export interface RestoreSummary {
  restored: number;
  alreadyKnown: number;
  missingDetails: number;
  roleUnknown: number;
  failed: number;
  disputes: number;
  disputeStatusFailed: number;
}

export interface LastTradeIndexInfo {
  lastUsedIndex: number;
  noHistory: boolean;
}

/**
 * Ask Mostro for this identity's session state (`Action::RestoreSession`) and
 * rebuild the local database. The whole exchange runs on the identity keys
 * (a trade key looks like an unknown user). No request id is sent — the
 * response is validated by action + sender (anti-forgery).
 */
export async function restoreSession(params: {
  pool: SimplePool;
  relays: string[];
  mostroPubkeyHex: string;
  mnemonic: string;
  store: Store;
}): Promise<RestoreSummary> {
  const { pool, relays, mostroPubkeyHex, mnemonic, store } = params;
  const identity = deriveTradeKeys(mnemonic, 0);

  // Stage 1: RestoreSession.
  const message = newRestoreMessage(null);
  const reply = await roundtripDm({
    pool,
    relays,
    mostroPubkeyHex,
    identitySecretHex: identity.secret,
    tradeSecretHex: identity.secret,
    message,
    expectedAction: "restore-session",
  });

  if (reply.sender !== mostroPubkeyHex) {
    throw new Error(`Restore response signed by ${reply.sender}, expected the configured Mostro instance`);
  }
  const kind = reply.message.value;
  if (kind.payload?.variant === "cant_do") {
    throw new Error(`Mostro refused restore: ${kind.payload.value ?? "unknown"}`);
  }
  if (kind.action !== "restore-session") {
    throw new Error(`Unexpected action in response: ${kind.action}`);
  }
  const payload = kind.payload;
  if (!payload || payload.variant !== "restore_data") {
    throw new Error("No restore data payload in response");
  }
  const restoreData: RestoreSessionInfo = payload.value;

  // Stage 3: authoritative last trade index.
  const mostroLast = await fetchLastTradeIndex({
    pool,
    relays,
    mostroPubkeyHex,
    identitySecretHex: identity.secret,
  });

  const summary: RestoreSummary = {
    restored: 0,
    alreadyKnown: 0,
    missingDetails: 0,
    roleUnknown: 0,
    failed: 0,
    disputes: restoreData.disputes.length,
    disputeStatusFailed: 0,
  };

  // Advance last_trade_index BEFORE writing rows (index is authoritative).
  let restoreMax = 0;
  for (const o of restoreData.orders) {
    if (o.trade_index > restoreMax) restoreMax = o.trade_index;
  }
  for (const d of restoreData.disputes) {
    if (d.trade_index > restoreMax) restoreMax = d.trade_index;
  }
  const effectiveLast = Math.max(restoreMax, mostroLast.lastUsedIndex);
  const user = await store.getUser();
  const currentLast = user?.last_trade_index ?? 0;
  if (effectiveLast > currentLast) {
    await store.upsertUser({
      i0_pubkey: identity.pubkey,
      mnemonic,
      last_trade_index: effectiveLast,
      created_at: user?.created_at ?? Math.floor(Date.now() / 1000),
    });
  }

  for (const info of restoreData.orders) {
    const idStr = info.order_id;
    const existing = await store.getOrder(idStr);
    const tradeKeys = deriveTradeKeys(mnemonic, info.trade_index);

    if (existing && existing.fiat_code) {
      // Already known with real details: refresh status only.
      await store.updateOrderStatus(idStr, info.status);
      summary.alreadyKnown += 1;
    } else {
      const isMine = info.status === "pending" || info.status === "waiting-maker-bond";
      await store.saveOrder({
        id: idStr,
        kind: null,
        status: info.status,
        amount: 0,
        fiat_code: "",
        min_amount: null,
        max_amount: null,
        fiat_amount: 0,
        payment_method: "",
        premium: 0,
        trade_keys: tradeKeys.secret,
        counterparty_pubkey: null,
        is_mine: isMine,
        buyer_invoice: null,
        request_id: null,
        trade_index: info.trade_index,
        created_at: null,
        expires_at: null,
      });
      summary.restored += 1;
      summary.missingDetails += 1;
      if (!isMine) {
        summary.roleUnknown += 1;
      }
    }
  }

  // Disputed orders: mark status + persist dispute id + solver chat key.
  for (const dispute of restoreData.disputes) {
    const idStr = dispute.order_id;
    const order = await store.getOrder(idStr);
    if (!order) {
      summary.disputeStatusFailed += 1;
      continue;
    }
    await store.updateOrderStatus(idStr, "dispute");
    await store.updateDisputeId(idStr, dispute.dispute_id);
    if (dispute.solver_pubkey) {
      const tradeKeys = deriveTradeKeys(mnemonic, dispute.trade_index);
      const { deriveChatKeys } = await import("./chatKeys.js");
      const chat = deriveChatKeys(tradeKeys.secret, dispute.solver_pubkey);
      await store.updateSolverChat(idStr, dispute.solver_pubkey, chat.convSecretHex);
    }
  }

  return summary;
}

/** Stage 3: fetch the daemon's authoritative last trade index. */
export async function fetchLastTradeIndex(params: {
  pool: SimplePool;
  relays: string[];
  mostroPubkeyHex: string;
  identitySecretHex: string;
}): Promise<LastTradeIndexInfo> {
  const { pool, relays, mostroPubkeyHex, identitySecretHex } = params;
  const message = newOrderMessage(null, null, null, "last-trade-index", null);
  const reply = await roundtripDm({
    pool,
    relays,
    mostroPubkeyHex,
    identitySecretHex,
    tradeSecretHex: identitySecretHex,
    message,
    expectedAction: "last-trade-index",
  });
  const kind = reply.message.value;
  // CantDo (e.g. not_found for an identity with only completed history) means
  // "no history" — the index is whatever restore reported. mostrix treats this
  // as no_history.
  if (kind.payload?.variant === "cant_do") {
    return { lastUsedIndex: 0, noHistory: true };
  }
  // LastTradeIndex answers with Payload::Amount (the index).
  const index = kind.payload?.variant === "amount" ? kind.payload.value : 0;
  return { lastUsedIndex: index, noHistory: kind.action !== "last-trade-index" };
}

/** Match a reply action against expectation; CantDo is always accepted. */
function actionMatchesExpected(action: string, expected?: string): boolean {
  if (action === "cant-do") {
    return true;
  }
  return !expected || action === expected;
}

/** Send a DM on identity keys and wait for the reply matching expectedAction. */
async function roundtripDm(params: {
  pool: SimplePool;
  relays: string[];
  mostroPubkeyHex: string;
  identitySecretHex: string;
  tradeSecretHex: string;
  message: Message;
  expectedAction?: string;
}): Promise<{ sender: string; message: Message }> {
  const { pool, relays, mostroPubkeyHex, identitySecretHex, tradeSecretHex, message } = params;
  const { DmRouter, filterProtocolDmFromMostro } = await import("./dmRouter.js");
  const { pubkeyFromSecret } = await import("./transport.js");
  const router = new DmRouter({
    pool,
    relays,
    mostroPubkeyHex,
    transport: "nip44",
  });

  const wait = router.waitForDm(tradeSecretHex);
  await sendDm({
    pool,
    relays,
    identitySecretHex,
    tradeSecretHex,
    receiverPubkeyHex: mostroPubkeyHex,
    message,
    router,
  });

  // Wait for a live event matching the expected action; fall back to a relay
  // history query on timeout (restore replies are small and the live
  // subscription may miss a fast reply before the relay connect completes).
  const tradePubkey = pubkeyFromSecret(tradeSecretHex);
  const filter = filterProtocolDmFromMostro("nip44", mostroPubkeyHex, tradePubkey);
  filter.limit = 10;

  const start = Date.now();
  while (Date.now() - start < 15_000) {
    const event = (await Promise.race([
      wait,
      new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 1000)),
    ])) as NostrEvent | "timeout";

    let candidate: NostrEvent | null = null;
    if (event !== "timeout" && event.pubkey === mostroPubkeyHex && verifyEventSignature(event)) {
      const u = unwrapMessageNip44({
        event: { kind: event.kind, pubkey: event.pubkey, content: event.content },
        receiverSecretHex: tradeSecretHex,
        requireSignature: true,
      });
      if (u && actionMatchesExpected(u.message.value.action, params.expectedAction)) {
        candidate = event;
      }
    }
    if (!candidate) {
      // Poll the relay history for a matching reply (e.g. restore response).
      const evs = await pool.querySync(relays, filter);
      for (const e of evs) {
        if (e.pubkey !== mostroPubkeyHex || !verifyEventSignature(e)) {
          continue;
        }
        const u = unwrapMessageNip44({
          event: { kind: e.kind, pubkey: e.pubkey, content: e.content },
          receiverSecretHex: tradeSecretHex,
          requireSignature: true,
        });
        if (u && actionMatchesExpected(u.message.value.action, params.expectedAction)) {
          candidate = e;
          break;
        }
      }
    }
    if (candidate) {
      const u = unwrapMessageNip44({
        event: { kind: candidate.kind, pubkey: candidate.pubkey, content: candidate.content },
        receiverSecretHex: tradeSecretHex,
        requireSignature: true,
      });
      if (u) {
        return { sender: candidate.pubkey, message: u.message };
      }
    }
  }
  throw new Error("timeout waiting for Mostro reply");
}