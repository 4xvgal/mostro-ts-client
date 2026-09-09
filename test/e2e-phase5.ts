// Phase 5 E2E: dispute + admin actions against the local regtest daemon.
//
// Flow: maker creates a sell order → taker takes it → taker opens a dispute
// → (admin would take/settle — requires the daemon's own nsec as admin key,
// so here we validate that the dispute DM roundtrip works and the daemon
// responds).
//
// Run: npx tsx test/e2e-phase5.ts

import { SimplePool } from "nostr-tools/pool";
import {
  deriveTradeKeys,
  generateMnemonic,
  buildNewOrder,
  buildTakeOrderPayload,
  takeActionForOrder,
  buildTradeMessage,
  getOrder,
} from "../src/protocol/index.js";
import { sendDm, DmRouter } from "../src/protocol/dmRouter.js";
import { unwrapMessageNip44 } from "../src/protocol/transport.js";
import { infoFromRelay } from "./lib/relay.js";

const RELAY = "ws://localhost:7080";
const RELAYS = [RELAY];

async function main() {
  const pool = new SimplePool();
  const mostroPubkey = await infoFromRelay(pool, RELAY);
  if (!mostroPubkey) throw new Error("no mostro info event");
  console.log("mostro pubkey:", mostroPubkey);

  // ---- Maker creates a sell order ----
  const makerMn = generateMnemonic();
  const makerIdentity = deriveTradeKeys(makerMn, 0);
  const makerTrade = deriveTradeKeys(makerMn, 1);
  const router = new DmRouter({ pool, relays: RELAYS, mostroPubkeyHex: mostroPubkey, transport: "nip44" });

  const { message, requestId: orderReq } = buildNewOrder(
    { lastTradeIndex: null },
    { kind: "sell", fiatCode: "USD", amount: 0, fiatAmount: 20, paymentMethod: "SEPA", expirationDays: 1 },
  );
  const orderWait = router.waitForDm(makerTrade.secret);
  await sendDm({ pool, relays: RELAYS, identitySecretHex: makerIdentity.secret, tradeSecretHex: makerTrade.secret, receiverPubkeyHex: mostroPubkey, message });
  const orderReply = await Promise.race([orderWait, new Promise((_, r) => setTimeout(() => r(new Error("order timeout")), 15_000))]);
  const ow = unwrapMessageNip44({ event: { kind: orderReply.kind, pubkey: orderReply.pubkey, content: orderReply.content }, receiverSecretHex: makerTrade.secret });
  if (!ow) throw new Error("order reply did not decrypt");
  const order = getOrder(ow.message.value);
  const orderId = order?.id;
  if (!orderId) throw new Error("no order id");
  console.log("order:", orderId, order?.status);

  // ---- Taker takes it ----
  const takerMn = generateMnemonic();
  const takerIdentity = deriveTradeKeys(takerMn, 0);
  const takerTrade = deriveTradeKeys(takerMn, 1);
  const takeAction = takeActionForOrder(order!);
  const takeMsg = buildTradeMessage({ orderId, requestId: Math.floor(Math.random() * 2 ** 48), action: takeAction, tradeIndex: 2, payload: buildTakeOrderPayload({ action: takeAction }) });
  const takeWait = router.waitForDm(takerTrade.secret);
  await sendDm({ pool, relays: RELAYS, identitySecretHex: takerIdentity.secret, tradeSecretHex: takerTrade.secret, receiverPubkeyHex: mostroPubkey, message: takeMsg });
  const takeReply = await Promise.race([takeWait, new Promise((_, r) => setTimeout(() => r(new Error("take timeout")), 15_000))]);
  const tw = unwrapMessageNip44({ event: { kind: takeReply.kind, pubkey: takeReply.pubkey, content: takeReply.content }, receiverSecretHex: takerTrade.secret });
  if (!tw) throw new Error("take reply did not decrypt");
  console.log("take reply:", tw.message.value.action);

  // ---- Taker opens a dispute ----
  const disputeMsg = buildTradeMessage({ orderId, requestId: Math.floor(Math.random() * 2 ** 48), action: "dispute", payload: null });
  const disputeWait = router.waitForDm(takerTrade.secret);
  await sendDm({ pool, relays: RELAYS, identitySecretHex: takerIdentity.secret, tradeSecretHex: takerTrade.secret, receiverPubkeyHex: mostroPubkey, message: disputeMsg });
  console.log("Dispute sent, waiting...");
  const disputeReply = await Promise.race([disputeWait, new Promise((_, r) => setTimeout(() => r(new Error("dispute timeout")), 15_000))]);
  const dw = unwrapMessageNip44({ event: { kind: disputeReply.kind, pubkey: disputeReply.pubkey, content: disputeReply.content }, receiverSecretHex: takerTrade.secret });
  if (!dw) throw new Error("dispute reply did not decrypt");
  const dk = dw.message.value;
  console.log("dispute reply action:", dk.action);
  if (dk.payload?.variant === "cant_do") {
    console.log("CantDo:", dk.payload.value);
  }

  pool.close(RELAYS);
  console.log("E2E-PHASE5 OK");
}

main().catch((e) => {
  console.error("E2E-PHASE5 FAIL:", e);
  process.exit(1);
});