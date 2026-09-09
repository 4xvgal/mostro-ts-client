// E2E smoke test against the local regtest daemon.
// Sends a NewOrder DM and waits for the Mostro reply (expected: PayBondInvoice
// since bond_enabled is on, or NewOrder/CantDo).
// Run: npx tsx test/e2e.ts

import { SimplePool } from "nostr-tools/pool";
import { deriveTradeKeys, generateMnemonic, buildNewOrder, serializeMessage } from "../src/protocol/index.js";
import { sendDm, DmRouter, filterProtocolDmFromMostro } from "../src/protocol/dmRouter.js";
import { unwrapMessageNip44 } from "../src/protocol/transport.js";
import { infoFromRelay } from "./lib/relay.js";

const RELAY = "ws://localhost:7080";
const RELAYS = [RELAY];

async function main() {
  const pool = new SimplePool();

  // Discover the daemon's mostro pubkey from its kind-38385 info event.
  const mostroPubkey = await infoFromRelay(pool, RELAY);
  if (!mostroPubkey) {
    throw new Error("no mostro info event found on relay");
  }
  console.log("mostro pubkey:", mostroPubkey);

  // Fresh user identity for this test.
  const mnemonic = generateMnemonic();
  const identity = deriveTradeKeys(mnemonic, 0);
  const trade = deriveTradeKeys(mnemonic, 1);
  console.log("identity pubkey:", identity.pubkey);
  console.log("trade pubkey:", trade.pubkey);

  // Build NewOrder message.
  const { message, requestId, tradeIndex } = buildNewOrder(
    { lastTradeIndex: null },
    {
      kind: "sell",
      fiatCode: "USD",
      amount: 0, // market price
      fiatAmount: 50,
      paymentMethod: "SEPA",
      expirationDays: 1,
    },
  );
  console.log(`sending NewOrder request_id=${requestId} trade_index=${tradeIndex}`);

  // Router: waiter + tracked order.
  const router = new DmRouter({
    pool,
    relays: RELAYS,
    mostroPubkeyHex: mostroPubkey,
    transport: "nip44",
    onOrderMessage: (orderId, msg, ev) => {
      console.log(`[tracked] order=${orderId} action=${msg.value.action}`);
    },
  });

  // Register waiter BEFORE sending to avoid missing the reply.
  const waiterPromise = router.waitForDm(trade.secret);

  await sendDm({
    pool,
    relays: RELAYS,
    identitySecretHex: identity.secret,
    tradeSecretHex: trade.secret,
    receiverPubkeyHex: mostroPubkey,
    message,
  });
  console.log("DM sent, waiting for reply...");

  const reply = await Promise.race([
    waiterPromise,
    new Promise((_, rej) => setTimeout(() => rej(new Error("timeout waiting for reply")), 15_000)),
  ]);
  const unwrapped = unwrapMessageNip44({
    event: { kind: reply.kind, pubkey: reply.pubkey, content: reply.content },
    receiverSecretHex: trade.secret,
  });
  if (!unwrapped) {
    throw new Error("reply did not decrypt");
  }
  const msg = unwrapped.message;
  console.log("=== REPLY ===");
  console.log("action:", msg.value.action);
  console.log("request_id:", msg.value.request_id, "(expected", requestId, ")");
  if (msg.value.payload) {
    if (msg.value.payload.variant === "payment_request") {
      console.log("payload: payment_request, invoice:", msg.value.payload.value[1].slice(0, 30) + "...");
    } else {
      console.log("payload variant:", msg.value.payload.variant);
    }
  }

  pool.close(RELAYS);
  console.log("E2E OK");
}

main().catch((e) => {
  console.error("E2E FAIL:", e);
  process.exit(1);
});