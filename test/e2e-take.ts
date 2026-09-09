// E2E take-order test against the local regtest daemon.
//
// Flow: maker creates a sell order → gets order id from the reply → taker
// sends TakeSell → Mostro replies with PayBondInvoice (taker bond) or a
// hold invoice / CantDo.
//
// Run: npx tsx test/e2e-take.ts

import { SimplePool } from "nostr-tools/pool";
import {
  deriveTradeKeys,
  generateMnemonic,
  buildNewOrder,
  buildTakeOrderPayload,
  takeActionForOrder,
  serializeMessage,
  unwrapMessageNip44,
  getOrder,
} from "../src/protocol/index.js";
import { sendDm, DmRouter } from "../src/protocol/dmRouter.js";
import { infoFromRelay } from "./lib/relay.js";

const RELAY = "ws://localhost:7080";
const RELAYS = [RELAY];

async function main() {
  const pool = new SimplePool();
  const mostroPubkey = await infoFromRelay(pool, RELAY);
  if (!mostroPubkey) throw new Error("no mostro info event");
  console.log("mostro pubkey:", mostroPubkey);

  const makerMn = generateMnemonic();
  const makerIdentity = deriveTradeKeys(makerMn, 0);
  const makerTrade = deriveTradeKeys(makerMn, 1);

  // ---- 1. Maker: create a sell order ----
  const makerRouter = new DmRouter({
    pool,
    relays: RELAYS,
    mostroPubkeyHex: mostroPubkey,
    transport: "nip44",
  });
  const { message, requestId } = buildNewOrder(
    { lastTradeIndex: null },
    { kind: "sell", fiatCode: "USD", amount: 0, fiatAmount: 30, paymentMethod: "SEPA", expirationDays: 1 },
  );
  const makerWait = makerRouter.waitForDm(makerTrade.secret);
  await sendDm({
    pool,
    relays: RELAYS,
    identitySecretHex: makerIdentity.secret,
    tradeSecretHex: makerTrade.secret,
    receiverPubkeyHex: mostroPubkey,
    message,
  });
  const makerReply = await Promise.race([
    makerWait,
    new Promise((_, rej) => setTimeout(() => rej(new Error("maker timeout")), 15_000)),
  ]);
  const makerUnwrapped = unwrapMessageNip44({
    event: { kind: makerReply.kind, pubkey: makerReply.pubkey, content: makerReply.content },
    receiverSecretHex: makerTrade.secret,
  });
  if (!makerUnwrapped) throw new Error("maker reply did not decrypt");
  const makerKind = makerUnwrapped.message.value;
  console.log("maker reply action:", makerKind.action, "request_id:", makerKind.request_id, "(exp", requestId + ")");

  const order = getOrder(makerKind);
  if (!order) throw new Error("maker reply has no order payload");
  const orderId = order.id!;
  console.log("order id:", orderId, "kind:", order.kind, "status:", order.status);

  // ---- 2. Taker: take the sell order ----
  const takerMn = generateMnemonic();
  const takerIdentity = deriveTradeKeys(takerMn, 0);
  const takerTrade = deriveTradeKeys(takerMn, 1);

  const takerRouter = new DmRouter({
    pool,
    relays: RELAYS,
    mostroPubkeyHex: mostroPubkey,
    transport: "nip44",
  });
  const takeAction = takeActionForOrder(order);
  console.log("take action:", takeAction);
  const payload = buildTakeOrderPayload({ action: takeAction });
  const takeMsg = {
    variant: "order" as const,
    value: {
      version: 2,
      request_id: Math.floor(Math.random() * 2 ** 48),
      trade_index: 2,
      id: orderId,
      action: takeAction,
      payload,
    },
  };
  const takerWait = takerRouter.waitForDm(takerTrade.secret);
  await sendDm({
    pool,
    relays: RELAYS,
    identitySecretHex: takerIdentity.secret,
    tradeSecretHex: takerTrade.secret,
    receiverPubkeyHex: mostroPubkey,
    message: takeMsg,
  });
  console.log("TakeSell sent, waiting...");

  const takerReply = await Promise.race([
    takerWait,
    new Promise((_, rej) => setTimeout(() => rej(new Error("taker timeout")), 15_000)),
  ]);
  const takerUnwrapped = unwrapMessageNip44({
    event: { kind: takerReply.kind, pubkey: takerReply.pubkey, content: takerReply.content },
    receiverSecretHex: takerTrade.secret,
  });
  if (!takerUnwrapped) throw new Error("taker reply did not decrypt");
  const takerKind = takerUnwrapped.message.value;
  console.log("taker reply action:", takerKind.action);
  if (takerKind.payload) {
    if (takerKind.payload.variant === "payment_request") {
      console.log("payload: payment_request invoice:", takerKind.payload.value[1].slice(0, 40) + "...");
    } else if (takerKind.payload.variant === "cant_do") {
      console.log("payload: cant_do", takerKind.payload.value);
    } else {
      console.log("payload variant:", takerKind.payload.variant);
    }
  }

  pool.close(RELAYS);
  console.log("E2E-TAKE OK");
}

main().catch((e) => {
  console.error("E2E-TAKE FAIL:", e);
  process.exit(1);
});