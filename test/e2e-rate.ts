// E2E rate-user test against the local regtest daemon.
//
// Reuses an active order's trade keys to send RateUser; Mostro either
// answers RateReceived (when the trade is rateable) or CantDo.
//
// Run: npx tsx test/e2e-rate.ts

import { SimplePool } from "nostr-tools/pool";
import {
  deriveTradeKeys,
  generateMnemonic,
  buildNewOrder,
  buildRateUserMessage,
  serializeMessage,
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

  // Maker identity: create an order to have a rateable trade.
  const makerMn = generateMnemonic();
  const makerIdentity = deriveTradeKeys(makerMn, 0);
  const makerTrade = deriveTradeKeys(makerMn, 1);

  const router = new DmRouter({
    pool,
    relays: RELAYS,
    mostroPubkeyHex: mostroPubkey,
    transport: "nip44",
  });

  // Create order (need order id + trade keys).
  const { message, requestId } = buildNewOrder(
    { lastTradeIndex: null },
    { kind: "sell", fiatCode: "USD", amount: 0, fiatAmount: 25, paymentMethod: "SEPA", expirationDays: 1 },
  );
  const orderWait = router.waitForDm(makerTrade.secret);
  await sendDm({
    pool,
    relays: RELAYS,
    identitySecretHex: makerIdentity.secret,
    tradeSecretHex: makerTrade.secret,
    receiverPubkeyHex: mostroPubkey,
    message,
  });
  const orderReply = await Promise.race([
    orderWait,
    new Promise((_, rej) => setTimeout(() => rej(new Error("order timeout")), 15_000)),
  ]);
  const unwrapped = unwrapMessageNip44({
    event: { kind: orderReply.kind, pubkey: orderReply.pubkey, content: orderReply.content },
    receiverSecretHex: makerTrade.secret,
  });
  if (!unwrapped) throw new Error("order reply did not decrypt");
  const orderKind = unwrapped.message.value;
  const order = orderKind.payload && orderKind.payload.variant === "order" ? orderKind.payload.value : null;
  const orderId = order?.id;
  if (!orderId) throw new Error("no order id in reply");
  console.log("order created:", orderId, "status:", order?.status);

  // Send RateUser. A pending (not-completed) order is NOT rateable — Mostro
  // should answer CantDo(NotAllowedByStatus). That still validates the full
  // roundtrip (wrap → publish → decrypt → request_id match).
  const rateRequestId = Math.floor(Math.random() * 2 ** 48);
  const rateMsg = buildRateUserMessage({ orderId, requestId: rateRequestId, rating: 5 });
  const rateWait = router.waitForDm(makerTrade.secret);
  await sendDm({
    pool,
    relays: RELAYS,
    identitySecretHex: makerIdentity.secret,
    tradeSecretHex: makerTrade.secret,
    receiverPubkeyHex: mostroPubkey,
    message: rateMsg,
  });
  console.log("RateUser sent (rating 5), waiting...");

  const rateReply = await Promise.race([
    rateWait,
    new Promise((_, rej) => setTimeout(() => rej(new Error("rate timeout")), 15_000)),
  ]);
  const rateUnwrapped = unwrapMessageNip44({
    event: { kind: rateReply.kind, pubkey: rateReply.pubkey, content: rateReply.content },
    receiverSecretHex: makerTrade.secret,
  });
  if (!rateUnwrapped) throw new Error("rate reply did not decrypt");
  const rateKind = rateUnwrapped.message.value;
  console.log("rate reply action:", rateKind.action);
  console.log("rate request_id match:", rateKind.request_id === rateRequestId);

  if (rateKind.payload?.variant === "cant_do") {
    console.log("CantDo reason:", rateKind.payload.value);
  } else if (rateKind.action === "rate-received") {
    console.log("RateReceived OK");
  }

  pool.close(RELAYS);
  console.log("E2E-RATE OK");
}

main().catch((e) => {
  console.error("E2E-RATE FAIL:", e);
  process.exit(1);
});