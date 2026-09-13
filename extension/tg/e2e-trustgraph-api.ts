// Demo: the two goals end-to-end on regtest.
//   1) maker creates an order WITH TrustGraph enabled (pm binding token)
//   2) viewer forms the trust graph and scores that order's identity
//
//   MOSTRO_RELAY=ws://localhost:7080 npx tsx extension/tg/e2e-trustgraph-api.ts

import assert from "node:assert/strict";
import { SimplePool } from "nostr-tools/pool";
import {
  deriveTradeKeys,
  generateMnemonic,
  fetchMostroOrderEvents,
  orderFromTags,
  DmRouter,
  type DerivedKeys,
} from "../../src/protocol/index.js";
import { infoFromRelay } from "../../test/lib/relay.js";
import { buildOrderBinding, verifyOrderBinding, TrustGraph } from "./api.js";
import { RELAY, RELAYS, FIAT, createSellOrder, attestationEvent } from "./e2e-kit.js";

async function main() {
  const pool = new SimplePool();
  const mostroPubkey = await infoFromRelay(pool, RELAY);
  if (!mostroPubkey) throw new Error("no mostro info event");
  const router = new DmRouter({ pool, relays: RELAYS, mostroPubkeyHex: mostroPubkey, transport: "nip44" });

  // ---- maker creates an order with TrustGraph enabled ----
  const makerMn = generateMnemonic();
  const maker = deriveTradeKeys(makerMn, 0);
  const makerTrade = deriveTradeKeys(makerMn, 1);
  const { pm } = buildOrderBinding({
    identitySecretHex: maker.secret,
    mostroPubkey,
    kind: "sell",
    fiatCode: FIAT,
    premium: 0,
    basePaymentMethod: "bank transfer,zelle",
    fiatAmount: 25,
  });
  const makerOrderId = await createSellOrder({ pool, router, mostroPubkey, identity: maker, trade: makerTrade, pm, fiatAmount: 25, label: "maker" });
  console.log(`[maker] order ${makerOrderId.slice(0, 8)} created with TgEnabled pm="${pm}"`);

  // privacy order (no token) for contrast
  const privMn = generateMnemonic();
  const privIdentity = deriveTradeKeys(privMn, 0);
  const privTrade = deriveTradeKeys(privMn, 1);
  const privOrderId = await createSellOrder({ pool, router, mostroPubkey, identity: privIdentity, trade: privTrade, pm: "SEPA", fiatAmount: 25, label: "privacy" });
  console.log(`[maker] privacy order ${privOrderId.slice(0, 8)} created WITHOUT token`);

  // ---- viewer publishes its trust edges toward the maker ----
  const viewerMn = generateMnemonic();
  const viewer = deriveTradeKeys(viewerMn, 0);
  const other = deriveTradeKeys(generateMnemonic(), 0);
  for (const [from, to, w] of [
    [viewer, maker, 90],
    [viewer, other, 40],
    [maker, other, 90],
  ] as Array<[DerivedKeys, DerivedKeys, number]>) {
    await Promise.all(pool.publish([RELAY], attestationEvent(from, to, { weight: w, hint: RELAY })));
  }
  await new Promise((r) => setTimeout(r, 1500));

  // ---- viewer forms the graph (root = viewer) and scores ----
  const tg = new TrustGraph({ pool, relays: RELAYS, root: viewer.pubkey, maxHop: 3, alpha: 0.8 });
  const snap = await tg.refresh();
  console.log(`[viewer] graph: nodes=${snap.nodes} edges=${snap.edges} root=${viewer.pubkey.slice(0, 8)}`);
  const makerScore = tg.score(maker.pubkey);
  const makerPct = tg.percentile(maker.pubkey);
  console.log(`[viewer] maker score=${makerScore?.toFixed(4)} percentile=${makerPct?.toFixed(3)}`);

  // ---- fetch the order events and verify the binding against the claimed identity ----
  const events = await fetchMostroOrderEvents({ pool, relays: RELAYS, mostroPubkeyHex: mostroPubkey });
  const byId = new Map(events.map((e) => [e.tags.find((t) => t[0] === "d")?.[1] ?? "", e]));
  const makerEvent = byId.get(makerOrderId);
  assert.ok(makerEvent, "maker order event not found");
  const privEvent = byId.get(privOrderId);
  assert.ok(privEvent, "privacy order event not found");

  // identity comes from the social index / DM in real life; here the maker's pubkey is known.
  const bound = verifyOrderBinding(makerEvent!, maker.pubkey);
  console.log(`[viewer] verifyOrderBinding(maker) -> ${JSON.stringify(bound)}`);
  assert.equal(bound.ok, true, "maker binding must verify");

  // a different identity must fail
  assert.equal(verifyOrderBinding(makerEvent!, other.pubkey).ok, false);
  // privacy order has no token
  const boundPriv = verifyOrderBinding(privEvent!, privIdentity.pubkey);
  console.log(`[viewer] verifyOrderBinding(privacy) -> ${JSON.stringify(boundPriv)}`);
  assert.deepEqual(boundPriv, { ok: false, reason: "no-token" });

  // ---- score the order (badge) ----
  const rating = orderFromTags(makerEvent!.tags).rating;
  const badge = tg.classify({ identity: maker.pubkey, rating: rating ? { count: rating.total_reviews } : null });
  console.log(`[viewer] badge(maker) = ${JSON.stringify({ ...badge, score: badge.score?.toFixed(4) })}`);
  assert.ok(makerScore !== undefined && makerScore > 0, "maker must have a positive score");

  pool.close(RELAYS);
  console.log("TRUSTGRAPH API E2E PASS");
}

main().catch((e) => {
  console.error("TRUSTGRAPH API E2E FAIL:", e);
  process.exit(1);
});
