// E2E admin test — inject the daemon's nsec as admin key, run AdminAddSolver.
//
// Mostro requires the admin's event.identity == daemon pubkey. In v2 the
// identity is proven in-ciphertext, so the admin sends with identitySecretHex
// = tradeSecretHex = daemon nsec secret (full-privacy: identity == trade key,
// which equals my_keys.public_key()).
//
// Run: npx tsx test/e2e-admin.ts

import { SimplePool } from "nostr-tools/pool";
import { bech32 } from "@scure/base";
import {
  deriveTradeKeys,
  generateMnemonic,
  buildAddSolverMessage,
  pubkeyFromSecret,
  hexToNpub,
} from "../src/protocol/index.js";
import { sendDm, DmRouter } from "../src/protocol/dmRouter.js";
import { unwrapMessageNip44 } from "../src/protocol/transport.js";
import { infoFromRelay } from "./lib/relay.js";

const RELAY = "ws://localhost:7080";
const RELAYS = [RELAY];
// The daemon's nsec from docker/regtest/config/settings.toml.
const DAEMON_NSEC = "nsec10s5gr2qm3r6vsjl0dkzjfr9ntynnkzmzc04vqqxx59r96vv3j25qw8uxer";

function nsecToSecretHex(nsec: string): string {
  const { words } = bech32.decode(nsec);
  const bytes = new Uint8Array(bech32.fromWords(words));
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function main() {
  const pool = new SimplePool();
  const mostroPubkey = await infoFromRelay(pool, RELAY);
  if (!mostroPubkey) throw new Error("no mostro info event");
  console.log("mostro pubkey:", mostroPubkey);

  const adminSecret = nsecToSecretHex(DAEMON_NSEC);
  const adminPubkey = pubkeyFromSecret(adminSecret);
  console.log("admin pubkey (from daemon nsec):", adminPubkey);

  const router = new DmRouter({
    pool,
    relays: RELAYS,
    mostroPubkeyHex: mostroPubkey,
    transport: "nip44",
  });

  // A new solver identity (some pubkey to register as solver).
  const solverMn = generateMnemonic();
  const solver = deriveTradeKeys(solverMn, 0);
  const npub = hexToNpub(solver.pubkey) ?? solver.pubkey;

  const requestId = Math.floor(Math.random() * 2 ** 48);
  const msg = buildAddSolverMessage(npub, requestId, "read-write");
  console.log("sending AdminAddSolver for:", npub.slice(0, 16) + "...");

  // Admin identity = daemon nsec (full-privacy: identity == trade key).
  const wait = router.waitForDm(adminSecret);
  await sendDm({
    pool,
    relays: RELAYS,
    identitySecretHex: adminSecret,
    tradeSecretHex: adminSecret,
    receiverPubkeyHex: mostroPubkey,
    message: msg,
    router,
  });

  const reply = await Promise.race([
    wait,
    new Promise((_, rej) => setTimeout(() => rej(new Error("admin timeout")), 15_000)),
  ]);
  const unwrapped = unwrapMessageNip44({
    event: { kind: reply.kind, pubkey: reply.pubkey, content: reply.content },
    receiverSecretHex: adminSecret,
  });
  if (!unwrapped) throw new Error("admin reply did not decrypt");
  const kind = unwrapped.message.value;
  console.log("admin reply action:", kind.action);
  console.log("identity proven:", unwrapped.identity);

  pool.close(RELAYS);
  console.log("E2E-ADMIN OK");
}

main().catch((e) => {
  console.error("E2E-ADMIN FAIL:", e);
  process.exit(1);
});