// E2E: live subscription against the regtest relay. Publishes a kind-30500 from
// another identity and confirms the viewer receives it live (no poll/refresh).
//
//   MOSTRO_RELAY=ws://localhost:7080 npx tsx extension/tg/e2e-live.ts

import assert from "node:assert/strict";
import { SimplePool } from "nostr-tools/pool";
import { generateMnemonic, deriveIdentityKeys } from "../../src/protocol/index.js";
import { TrustGraph } from "./api.js";
import { buildAttestation } from "./attest.js";
import { RELAY, RELAYS } from "./e2e-kit.js";

async function main() {
  const pool = new SimplePool();
  const viewer = deriveIdentityKeys(generateMnemonic());
  const author = deriveIdentityKeys(generateMnemonic());
  const trustee = deriveIdentityKeys(generateMnemonic());

  const tg = new TrustGraph({ pool, relays: RELAYS, root: viewer.pubkey, liveDebounceMs: 0, seed: [{ to: author.pubkey, weight: 90, hint: RELAY }] });
  await tg.refresh();
  tg.start({ live: true, intervalMs: 3_600_000 });
  await new Promise((r) => setTimeout(r, 500)); // let the subscription open

  const ev = buildAttestation({ trusterSecretHex: author.secret, trustee: trustee.pubkey, weight: 90, hint: RELAY });
  await Promise.all(pool.publish([RELAY], ev));
  console.log(`published 30500 ${author.pubkey.slice(0, 8)} -> ${trustee.pubkey.slice(0, 8)}`);

  let received = false;
  for (let i = 0; i < 20 && !received; i++) {
    await new Promise((r) => setTimeout(r, 250));
    received = tg.attestations().some((a) => a.truster === author.pubkey);
  }
  assert.ok(received, "attestation must arrive over the live subscription");
  assert.ok((tg.score(trustee.pubkey) ?? 0) > 0, "live edge scored via viewer->author->trustee");

  tg.stop();
  pool.close(RELAYS);
  console.log("LIVE SUBSCRIPTION E2E PASS");
}

main().catch((e) => {
  console.error("LIVE E2E FAIL:", e);
  process.exit(1);
});
