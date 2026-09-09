// E2E: DM applicator applies real Mostro DMs to the store.
//
// Creates an order, takes it, then feeds the real `add-invoice` reply into
// applyTradeDm and verifies the store row reflects the trade state.
//
// Run: npx tsx test/e2e-applicator.ts

import { SimplePool } from "nostr-tools/pool";
import {
  deriveTradeKeys,
  generateMnemonic,
  buildNewOrder,
  buildTradeMessage,
  buildTakeOrderPayload,
  takeActionForOrder,
  openSqliteStore,
  applyTradeDm,
  getOrder,
} from "../src/protocol/index.js";
import { sendDm, DmRouter } from "../src/protocol/dmRouter.js";
import { unwrapMessageNip44 } from "../src/protocol/transport.js";
import { infoFromRelay } from "./lib/relay.js";
import type { Store } from "../src/protocol/index.js";

const RELAY = "ws://localhost:7080";
const RELAYS = [RELAY];

async function main() {
  const pool = new SimplePool();
  const mostroPubkey = await infoFromRelay(pool, RELAY);
  if (!mostroPubkey) throw new Error("no mostro info event");

  const store = openSqliteStore();

  // Maker creates a sell order; persist the maker's trade secret.
  const makerMn = generateMnemonic();
  const makerIdentity = deriveTradeKeys(makerMn, 0);
  const makerTrade = deriveTradeKeys(makerMn, 1);
  const router = new DmRouter({ pool, relays: RELAYS, mostroPubkeyHex: mostroPubkey, transport: "nip44" });

  const { message } = buildNewOrder(
    { lastTradeIndex: null },
    { kind: "sell", fiatCode: "USD", fiatAmount: 30, paymentMethod: "SEPA", expirationDays: 1 },
  );
  const orderWait = router.waitForDm(makerTrade.secret);
  await sendDm({ pool, relays: RELAYS, identitySecretHex: makerIdentity.secret, tradeSecretHex: makerTrade.secret, receiverPubkeyHex: mostroPubkey, message, router });
  const orderReply = await Promise.race([orderWait, new Promise((_, r) => setTimeout(() => r(new Error("order timeout")), 15_000))]);
  const ow = unwrapMessageNip44({ event: { kind: orderReply.kind, pubkey: orderReply.pubkey, content: orderReply.content }, receiverSecretHex: makerTrade.secret });
  if (!ow) throw new Error("order reply did not decrypt");
  const order = getOrder(ow.message.value);
  const orderId = order?.id;
  if (!orderId) throw new Error("no order id");

  // Persist the maker's order row (as create-order flow would).
  await store.saveOrder({
    id: orderId,
    kind: order?.kind ?? "sell",
    status: order?.status ?? "pending",
    amount: order?.amount ?? 0,
    fiat_code: order?.fiat_code ?? "USD",
    min_amount: order?.min_amount ?? null,
    max_amount: order?.max_amount ?? null,
    fiat_amount: order?.fiat_amount ?? 30,
    payment_method: order?.payment_method ?? "SEPA",
    premium: order?.premium ?? 0,
    trade_keys: makerTrade.secret,
    counterparty_pubkey: null,
    is_mine: true,
    buyer_invoice: null,
    request_id: null,
    trade_index: 2,
    created_at: order?.created_at ?? 0,
    expires_at: order?.expires_at ?? null,
  });
  console.log("maker order persisted:", orderId, "status:", (await store.getOrder(orderId))?.status);

  // Taker takes the order (fresh identity).
  const takerMn = generateMnemonic();
  const takerIdentity = deriveTradeKeys(takerMn, 0);
  const takerTrade = deriveTradeKeys(takerMn, 1);
  const takeAction = takeActionForOrder(order!);
  const takeMsg = buildTradeMessage({ orderId, requestId: Math.floor(Math.random() * 2 ** 48), action: takeAction, tradeIndex: 2, payload: buildTakeOrderPayload({ action: takeAction }) });
  const takeWait = router.waitForDm(takerTrade.secret);
  await sendDm({ pool, relays: RELAYS, identitySecretHex: takerIdentity.secret, tradeSecretHex: takerTrade.secret, receiverPubkeyHex: mostroPubkey, message: takeMsg, router });
  const takeReply = await Promise.race([takeWait, new Promise((_, r) => setTimeout(() => r(new Error("take timeout")), 15_000))]);
  const tw = unwrapMessageNip44({ event: { kind: takeReply.kind, pubkey: takeReply.pubkey, content: takeReply.content }, receiverSecretHex: takerTrade.secret });
  if (!tw) throw new Error("take reply did not decrypt");
  const takerKind = tw.message.value;
  console.log("taker reply action:", takerKind.action);

  // Feed the real reply into the applicator (as a UI router would).
  const applied = await applyTradeDm({
    store,
    orderId,
    tradeSecretHex: takerTrade.secret,
    message: tw.message,
  });
  console.log("applied:", JSON.stringify({ action: applied.action, status: applied.status, upserted: applied.orderUpserted }));
  const updated = await store.getOrder(orderId);
  console.log("store status after apply:", updated?.status);
  console.log("counterparty set:", updated?.counterparty_pubkey ? "yes" : "no");

  store.close();
  pool.close(RELAYS);
  console.log("E2E-APPLICATOR OK");
}

main().catch((e) => {
  console.error("E2E-APPLICATOR FAIL:", e);
  process.exit(1);
});