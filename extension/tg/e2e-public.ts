// Real public-relay test (default nos.lol): publish kind 30501 + 30500, then
// run the full viewer pipeline — fetch the social index, resolve the order's
// identity, verify the pm binding, score it, and receive a live attestation.
//
//   TG_RELAY=wss://nos.lol npx tsx extension/tg/e2e-public.ts
//
// Publishes a few throwaway events and revokes them at the end.

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { SimplePool } from "nostr-tools/pool";
import { generateMnemonic, deriveIdentityKeys, newSmallOrder, Kind, Status } from "../../src/protocol/index.js";
import { TrustGraphViewer } from "./viewer.js";
import { buildOrderBinding } from "./api.js";
import { buildSocialIndex } from "./social.js";
import { buildAttestation, buildRevoke } from "./attest.js";
import { MemoryTelemetrySink, summarizeTelemetry, formatSummary } from "./telemetry.js";

const RELAY = process.env.TG_RELAY ?? "wss://nos.lol";
const RELAYS = [RELAY];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const pool = new SimplePool();
  const viewer = deriveIdentityKeys(generateMnemonic());
  const maker = deriveIdentityKeys(generateMnemonic());
  const mostro = deriveIdentityKeys(generateMnemonic());
  const orderId = `pilot-${randomUUID()}`;

  // maker builds an order with a binding token and publishes its social index.
  const { pm } = buildOrderBinding({
    identitySecretHex: maker.secret,
    mostroPubkey: mostro.pubkey,
    kind: "sell",
    fiatCode: "USD",
    premium: 0,
    basePaymentMethod: "bank transfer",
    fiatAmount: 25,
  });
  const order = newSmallOrder({ id: orderId, kind: Kind.Sell, status: Status.Pending, amount: 0, fiat_code: "USD", fiat_amount: 25, payment_method: pm, premium: 0 });

  const social = buildSocialIndex({ identitySecretHex: maker.secret, entries: [{ order_id: orderId, mostro_pubkey: mostro.pubkey, relay: RELAY }] });
  const viewerToMaker = buildAttestation({ trusterSecretHex: viewer.secret, trustee: maker.pubkey, weight: 90, hint: RELAY });

  const published = await Promise.allSettled([...pool.publish([RELAY], social), ...pool.publish([RELAY], viewerToMaker)]);
  const acks = published.filter((r) => r.status === "fulfilled").length;
  console.log(`[pub] 30501 + 30500 -> ${RELAY}: ${acks}/${published.length} acks`);
  if (acks === 0) throw new Error("relay rejected our events");
  await sleep(2000);

  // viewer: social index -> identity -> binding verify -> score.
  const telemetry = new MemoryTelemetrySink();
  const v = new TrustGraphViewer({ pool, relays: RELAYS, root: viewer.pubkey, mostroPubkey: mostro.pubkey, telemetry });
  await v.refresh();
  await sleep(500);
  const [a] = v.annotate([order]);
  assert.ok(a, "annotated order");
  console.log(`[viewer] identity=${a.identity?.slice(0, 12) ?? "null"} verified=${a.signals.verified} badge=${a.badge.state} score=${v.score(maker.pubkey)?.toFixed(4) ?? "n/a"}`);
  assert.equal(a.identity, maker.pubkey, "social index must resolve the maker identity");
  assert.equal(a.binding?.ok, true, "pm binding must verify");
  assert.ok((v.score(maker.pubkey) ?? 0) > 0, "viewer->maker edge must score");

  // live: a new attestation arrives without polling.
  v.start();
  await sleep(1000);
  const makerToOther = buildAttestation({ trusterSecretHex: maker.secret, trustee: mostro.pubkey, weight: 50, hint: RELAY });
  await Promise.allSettled(pool.publish([RELAY], makerToOther));
  let live = false;
  for (let i = 0; i < 24 && !live; i++) {
    await sleep(500);
    live = v.graph.attestations().some((x) => x.truster === maker.pubkey && x.trustee === mostro.pubkey);
  }
  console.log(`[viewer] live attestation received=${live}`);
  assert.ok(live, "live 30500 must arrive over the subscription");

  console.log("\n--- telemetry ---");
  console.log(formatSummary(summarizeTelemetry(telemetry.events)));

  // be a good citizen: revoke the throwaway events.
  v.stop();
  const revokes = [
    buildRevoke({ trusterSecretHex: viewer.secret, trustee: maker.pubkey, hint: RELAY }),
    buildRevoke({ trusterSecretHex: maker.secret, trustee: mostro.pubkey, hint: RELAY }),
    buildSocialIndex({ identitySecretHex: maker.secret, entries: [] }),
  ];
  await Promise.allSettled(revokes.flatMap((ev) => pool.publish([RELAY], ev)));
  console.log("\n[pub] revoked throwaway events");

  pool.close(RELAYS);
  console.log("PUBLIC RELAY E2E PASS");
}

main().catch((e) => {
  console.error("PUBLIC E2E FAIL:", e);
  process.exit(1);
});
