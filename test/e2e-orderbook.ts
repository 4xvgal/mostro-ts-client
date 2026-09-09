// E2E: fetch the public order book from the local regtest daemon.
//
// Creates fresh orders so the book has entries, then fetches/aggregates them.
//
// Run: npx tsx test/e2e-orderbook.ts

import { SimplePool } from "nostr-tools/pool";
import {
  deriveTradeKeys,
  generateMnemonic,
  buildNewOrder,
  fetchPublicOrderBook,
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

  // Create two sell orders so the book has entries (buy orders need an
  // invoice — keep this E2E focused on the order book).
  for (const [fiatCode, fiatAmount] of [
    ["USD", 15],
    ["EUR", 10],
  ] as const) {
    const mn = generateMnemonic();
    const identity = deriveTradeKeys(mn, 0);
    const trade = deriveTradeKeys(mn, 1);
    const router = new DmRouter({ pool, relays: RELAYS, mostroPubkeyHex: mostroPubkey, transport: "nip44" });
    const { message } = buildNewOrder(
      { lastTradeIndex: null },
      { kind: "sell", fiatCode, fiatAmount, paymentMethod: "SEPA", expirationDays: 1 },
    );
    const wait = router.waitForDm(trade.secret);
    await sendDm({ pool, relays: RELAYS, identitySecretHex: identity.secret, tradeSecretHex: trade.secret, receiverPubkeyHex: mostroPubkey, message, router });
    const reply = await Promise.race([wait, new Promise((_, r) => setTimeout(() => r(new Error("timeout")), 15_000))]);
    const unwrapped = unwrapMessageNip44({ event: { kind: reply.kind, pubkey: reply.pubkey, content: reply.content }, receiverSecretHex: trade.secret });
    if (!unwrapped) throw new Error("reply did not decrypt");
    console.log(`created sell ${fiatCode} ${fiatAmount}`);
  }

  // Give the daemon a moment to publish the order events.
  await new Promise((r) => setTimeout(r, 2000));

  // Fetch the public book.
  const book = await fetchPublicOrderBook({ pool, relays: RELAYS, mostroPubkeyHex: mostroPubkey });
  console.log(`\n=== public order book: ${book.length} pending orders ===`);
  for (const o of book) {
    console.log(
      `${o.kind} ${o.fiat_amount} ${o.fiat_code} ${o.payment_method} id=${o.id?.slice(0, 8)}`,
    );
  }
  if (book.length === 0) {
    throw new Error("order book is empty — orders not published");
  }

  pool.close(RELAYS);
  console.log("E2E-ORDERBOOK OK");
}

main().catch((e) => {
  console.error("E2E-ORDERBOOK FAIL:", e);
  process.exit(1);
});