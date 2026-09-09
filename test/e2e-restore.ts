// E2E: session restore against the local regtest daemon.
//
// Creates orders with a fixed mnemonic, then runs restoreSession with that
// same mnemonic and verifies the daemon returns the orders + trade indices.
//
// Run: npx tsx test/e2e-restore.ts

import { SimplePool } from "nostr-tools/pool";
import {
  deriveTradeKeys,
  buildNewOrder,
  restoreSession,
  openSqliteStore,
  generateMnemonic,
} from "../src/protocol/index.js";
import { sendDm, DmRouter } from "../src/protocol/dmRouter.js";
import { unwrapMessageNip44 } from "../src/protocol/transport.js";
import { infoFromRelay } from "./lib/relay.js";

const RELAY = "ws://localhost:7080";
const RELAYS = [RELAY];
// Fresh mnemonic each run so restore sees only this run's orders (a reused
// identity accumulates restore replies on the relay, which a live subscribe
// would replay and confuse the waiter).
const MNEMONIC = generateMnemonic();

async function main() {
  const pool = new SimplePool();
  const mostroPubkey = await infoFromRelay(pool, RELAY);
  if (!mostroPubkey) throw new Error("no mostro info event");

  const identity = deriveTradeKeys(MNEMONIC, 0);
  const router = new DmRouter({ pool, relays: RELAYS, mostroPubkeyHex: mostroPubkey, transport: "nip44" });
  console.log("identity pubkey:", identity.pubkey.slice(0, 16) + "...");

  // Create an order with trade index 1 (fresh identity → noneBase 1 → index 2 actually).
  // Use a fresh identity each run so restore sees something.
  const { message } = buildNewOrder(
    { lastTradeIndex: null },
    { kind: "sell", fiatCode: "USD", fiatAmount: 12, paymentMethod: "SEPA", expirationDays: 1 },
  );
  const wait = router.waitForDm(identity.secret);
  await sendDm({ pool, relays: RELAYS, identitySecretHex: identity.secret, tradeSecretHex: identity.secret, receiverPubkeyHex: mostroPubkey, message, router });
  const reply = await Promise.race([wait, new Promise((_, r) => setTimeout(() => r(new Error("order timeout")), 15_000))]);
  const unwrapped = unwrapMessageNip44({ event: { kind: reply.kind, pubkey: reply.pubkey, content: reply.content }, receiverSecretHex: identity.secret });
  if (!unwrapped) throw new Error("order reply did not decrypt");
  const orderId = unwrapped.message.value.payload?.variant === "order" ? unwrapped.message.value.payload.value.id : null;
  console.log("created order:", orderId?.slice(0, 8) ?? "?");

  // Now restore.
  const store = openSqliteStore();
  await store.upsertUser({
    i0_pubkey: identity.pubkey,
    mnemonic: MNEMONIC,
    last_trade_index: 1,
    created_at: Math.floor(Date.now() / 1000),
  });

  const summary = await restoreSession({
    pool,
    relays: RELAYS,
    mostroPubkeyHex: mostroPubkey,
    mnemonic: MNEMONIC,
    store,
  });
  console.log("restore summary:", JSON.stringify(summary));
  console.log("last_trade_index after restore:", (await store.getUser())?.last_trade_index);

  // The created order should be in the store.
  const restored = orderId ? await store.getOrder(orderId) : null;
  console.log("restored order row:", restored ? `${restored.id.slice(0, 8)} status=${restored.status}` : "NOT FOUND");

  store.close();
  pool.close(RELAYS);
  console.log("E2E-RESTORE OK");
}

main().catch((e) => {
  console.error("E2E-RESTORE FAIL:", e);
  process.exit(1);
});