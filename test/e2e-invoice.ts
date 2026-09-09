// E2E: AddInvoice submission against the local regtest daemon.
//
// Flow: maker creates sell → taker takes (gets add-invoice) → taker submits a
// real bolt11 from lnd-bob → Mostro replies (waiting-seller-to-pay / hold
// invoice payment accepted / CantDo).
//
// Run: npx tsx test/e2e-invoice.ts

import { SimplePool } from "nostr-tools/pool";
import {
  deriveTradeKeys,
  generateMnemonic,
  buildNewOrder,
  buildTradeMessage,
  buildTakeOrderPayload,
  takeActionForOrder,
  buildInvoiceMessage,
  getOrder,
} from "../src/protocol/index.js";
import { sendDm, DmRouter } from "../src/protocol/dmRouter.js";
import { unwrapMessageNip44 } from "../src/protocol/transport.js";
import { infoFromRelay } from "./lib/relay.js";
import { execSync } from "node:child_process";

const RELAY = "ws://localhost:7080";
const RELAYS = [RELAY];

/** Create a bolt11 invoice on lnd-bob for the given sats. */
function bobInvoice(sats: number): string {
  const out = execSync(
    `docker exec mostro-regtest-lnd-bob lncli --lnddir=/home/lnd/.lnd --network=regtest --rpcserver=localhost:11009 addinvoice --amt ${sats} --memo "test"`,
    { encoding: "utf8" },
  );
  const match = out.match(/"payment_request":\s*"([^"]+)"/);
  if (!match) throw new Error("no invoice in lncli output: " + out);
  return match[1]!;
}

async function main() {
  const pool = new SimplePool();
  const mostroPubkey = await infoFromRelay(pool, RELAY);
  if (!mostroPubkey) throw new Error("no mostro info event");

  const router = new DmRouter({ pool, relays: RELAYS, mostroPubkeyHex: mostroPubkey, transport: "nip44" });

  // Maker creates sell order.
  const makerMn = generateMnemonic();
  const makerIdentity = deriveTradeKeys(makerMn, 0);
  const makerTrade = deriveTradeKeys(makerMn, 1);
  const { message: orderMsg } = buildNewOrder(
    { lastTradeIndex: null },
    { kind: "sell", fiatCode: "USD", fiatAmount: 30, paymentMethod: "SEPA", expirationDays: 1 },
  );
  const orderWait = router.waitForDm(makerTrade.secret);
  await sendDm({ pool, relays: RELAYS, identitySecretHex: makerIdentity.secret, tradeSecretHex: makerTrade.secret, receiverPubkeyHex: mostroPubkey, message: orderMsg, router });
  const orderReply = await Promise.race([orderWait, new Promise((_, r) => setTimeout(() => r(new Error("order timeout")), 15_000))]);
  const ow = unwrapMessageNip44({ event: { kind: orderReply.kind, pubkey: orderReply.pubkey, content: orderReply.content }, receiverSecretHex: makerTrade.secret });
  const order = getOrder(ow!.message.value);
  const orderId = order?.id;
  if (!orderId) throw new Error("no order id");
  console.log("order:", orderId.slice(0, 8), "amount sats:", order?.amount);

  // Taker takes it.
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
  console.log("take reply:", tw.message.value.action, "(expected add-invoice)");

  // Taker submits a real invoice (from lnd-bob).
  const invoice = bobInvoice(order?.amount ?? 1000);
  console.log("bob invoice:", invoice.slice(0, 30) + "...");
  const invMsg = buildInvoiceMessage({ orderId, requestId: Math.floor(Math.random() * 2 ** 48), action: "add-invoice", invoice });
  const invWait = router.waitForDm(takerTrade.secret);
  await sendDm({ pool, relays: RELAYS, identitySecretHex: takerIdentity.secret, tradeSecretHex: takerTrade.secret, receiverPubkeyHex: mostroPubkey, message: invMsg, router });
  console.log("AddInvoice sent, waiting...");
  const invReply = await Promise.race([invWait, new Promise((_, r) => setTimeout(() => r(new Error("invoice timeout")), 15_000))]);
  const iw = unwrapMessageNip44({ event: { kind: invReply.kind, pubkey: invReply.pubkey, content: invReply.content }, receiverSecretHex: takerTrade.secret });
  if (!iw) throw new Error("invoice reply did not decrypt");
  const ik = iw.message.value;
  console.log("invoice reply action:", ik.action);
  if (ik.payload?.variant === "cant_do") {
    console.log("CantDo:", ik.payload.value);
  }

  pool.close(RELAYS);
  console.log("E2E-INVOICE OK");
}

main().catch((e) => {
  console.error("E2E-INVOICE FAIL:", e);
  process.exit(1);
});