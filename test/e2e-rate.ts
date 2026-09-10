// E2E rate-user test against the local regtest daemon.
//
// Sends RateUser for an unknown order id; Mostro answers CantDo(NotFound).
// This validates the full RateUser roundtrip (wrap → publish → decrypt →
// request_id/action match). A successful RateReceived requires a completed,
// settled trade, which needs LND orchestration and is out of scope here.
//
// Run: npx tsx test/e2e-rate.ts

import { SimplePool } from "nostr-tools/pool";
import {
  deriveTradeKeys,
  generateMnemonic,
  buildRateUserMessage,
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

  const mn = generateMnemonic();
  const identity = deriveTradeKeys(mn, 0);
  const trade = deriveTradeKeys(mn, 1);

  const router = new DmRouter({
    pool,
    relays: RELAYS,
    mostroPubkeyHex: mostroPubkey,
    transport: "nip44",
  });

  // Unknown order id → deterministic CantDo(NotFound). A pending order makes
  // the daemon error silently ("Invalid pubkey - inner message No message"),
  // so it is not usable to exercise the reply path.
  const requestId = Math.floor(Math.random() * 2 ** 48);
  const rateMsg = buildRateUserMessage({
    orderId: "00000000-0000-0000-0000-000000000000",
    requestId,
    rating: 5,
  });

  const wait = router.waitForDm(trade.secret);
  await sendDm({
    pool,
    relays: RELAYS,
    identitySecretHex: identity.secret,
    tradeSecretHex: trade.secret,
    receiverPubkeyHex: mostroPubkey,
    message: rateMsg,
  });
  console.log("RateUser sent (rating 5, unknown order id), waiting...");

  const reply = await Promise.race([
    wait,
    new Promise((_, rej) => setTimeout(() => rej(new Error("rate timeout")), 15_000)),
  ]);
  const unwrapped = unwrapMessageNip44({
    event: { kind: reply.kind, pubkey: reply.pubkey, content: reply.content },
    receiverSecretHex: trade.secret,
    requireSignature: false,
  });
  if (!unwrapped) throw new Error("rate reply did not decrypt");
  const kind = unwrapped.message.value;
  console.log("rate reply action:", kind.action);
  console.log("rate request_id match:", kind.request_id === requestId);

  if (kind.request_id !== requestId) throw new Error("request_id mismatch");
  if (kind.payload?.variant !== "cant_do" || kind.payload.value !== "not_found") {
    throw new Error(`expected cant-do(not_found), got ${kind.action} ${JSON.stringify(kind.payload)}`);
  }

  pool.close(RELAYS);
  console.log("E2E-RATE OK");
}

main().catch((e) => {
  console.error("E2E-RATE FAIL:", e);
  process.exit(1);
});
