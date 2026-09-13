// Offline unit checks for the viewer join layer.
//   npx tsx --test extension/tg/join.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  generateMnemonic,
  deriveIdentityKeys,
  newSmallOrder,
  Kind,
  Status,
} from "../../src/protocol/index.js";
import { buildOrderBinding } from "./api.js";
import {
  IdentityIndex,
  annotateOrders,
  filterByTrust,
  sortByTrust,
  badgeFrom,
  type TrustScorer,
} from "./join.js";
import { SOCIAL_INDEX_KIND } from "./social.js";

const maker = deriveIdentityKeys(generateMnemonic());
const other = deriveIdentityKeys(generateMnemonic());
const mostroPubkey = other.pubkey; // daemon key for the challenge

const scorer: TrustScorer = {
  score: (id) => (id === maker.pubkey ? 0.1 : id === other.pubkey ? 0.5 : undefined),
  percentile: (id) => (id === maker.pubkey ? 0.95 : id === other.pubkey ? 0.3 : undefined),
};

function boundOrder(id: string, identitySecret: string, fiatAmount: number, rating?: { total_reviews: number; total_rating: number; days: number }) {
  const { pm } = buildOrderBinding({
    identitySecretHex: identitySecret,
    mostroPubkey,
    kind: "sell",
    fiatCode: "USD",
    premium: 0,
    basePaymentMethod: "SEPA",
    fiatAmount,
  });
  return newSmallOrder({ id, kind: Kind.Sell, status: Status.Pending, amount: 0, fiat_code: "USD", fiat_amount: fiatAmount, payment_method: pm, premium: 0, rating });
}

test("annotate verifies the binding and exposes raw signals + farm flag", () => {
  const idx = new IdentityIndex();
  idx.addClaim("o1", { identity: maker.pubkey, source: "social-index" });
  const [a] = annotateOrders([boundOrder("o1", maker.secret, 25)], { graph: scorer, mostroPubkey, identityIndex: idx });
  assert.ok(a);
  assert.equal(a.identity, maker.pubkey);
  assert.equal(a.binding?.ok, true);
  assert.equal(a.signals.verified, true);
  assert.equal(a.signals.score, 0.1);
  assert.equal(a.signals.percentile, 0.95);
  assert.equal(a.signals.ratingCount, 0);
  assert.deepEqual(a.signals.flags, ["rating-0", "ppr-high", "farm-suspect"]);
  assert.equal(a.badge.state, "farm-suspect");
});

test("rating present -> gate passes (도달), no farm flag", () => {
  const idx = new IdentityIndex();
  idx.addClaim("o2", { identity: other.pubkey, source: "dm" });
  const order = boundOrder("o2", other.secret, 30, { total_reviews: 12, total_rating: 48, days: 90 });
  const [a] = annotateOrders([order], { graph: scorer, mostroPubkey, identityIndex: idx });
  assert.ok(a);
  assert.equal(a.signals.ratingCount, 12);
  assert.equal(a.badge.state, "도달");
  assert.deepEqual(a.signals.flags, []);
});

test("wrong claimed identity -> unverified, no score", () => {
  const idx = new IdentityIndex();
  idx.addClaim("o3", { identity: other.pubkey, source: "social-index" }); // lies: order signed by maker
  const [a] = annotateOrders([boundOrder("o3", maker.secret, 25)], { graph: scorer, mostroPubkey, identityIndex: idx });
  assert.ok(a);
  assert.equal(a.identity, null);
  assert.equal(a.binding?.ok, false);
  assert.ok(a.signals.flags.includes("unverified"));
  assert.equal(a.signals.score, null);
  assert.equal(a.badge.state, "UNRATED");
});

test("no claim -> no-identity", () => {
  const [a] = annotateOrders([boundOrder("o4", maker.secret, 25)], { graph: scorer, mostroPubkey, identityIndex: new IdentityIndex() });
  assert.ok(a);
  assert.ok(a.signals.flags.includes("no-identity"));
});

test("addSocialIndex parses kind-30501 content", () => {
  const idx = new IdentityIndex();
  const n = idx.addSocialIndex({
    kind: SOCIAL_INDEX_KIND,
    pubkey: maker.pubkey,
    content: JSON.stringify([{ order_id: "o9", mostro_pubkey: mostroPubkey, relay: "wss://r" }]),
  });
  assert.equal(n, 1);
  assert.deepEqual(idx.candidates("o9"), [{ identity: maker.pubkey, mostroPubkey, relay: "wss://r", source: "social-index" }]);
  assert.equal(idx.addSocialIndex({ kind: SOCIAL_INDEX_KIND, pubkey: maker.pubkey, content: "not json" }), 0);
});

test("filterByTrust and sortByTrust work on raw signals", () => {
  const idx = new IdentityIndex();
  idx.addClaim("o1", { identity: maker.pubkey, source: "social-index" }); // 0.1, farm-suspect
  idx.addClaim("o2", { identity: other.pubkey, source: "dm" }); // 0.5, rating
  const items = annotateOrders(
    [boundOrder("o1", maker.secret, 25), boundOrder("o2", other.secret, 30, { total_reviews: 5, total_rating: 20, days: 30 })],
    { graph: scorer, mostroPubkey, identityIndex: idx },
  );
  assert.equal(filterByTrust(items, { states: ["farm-suspect"] }).length, 1);
  assert.equal(filterByTrust(items, { onlyVerified: true }).length, 2);
  assert.equal(filterByTrust(items, { excludeFlags: ["farm-suspect"] }).length, 1);
  assert.deepEqual(sortByTrust(items).map((i) => i.order.id), ["o2", "o1"]);
});

test("badgeFrom honors UI-supplied thresholds", () => {
  const sig = { verified: true, score: 0.1, percentile: 0.8, ratingCount: 0, flags: ["rating-0", "ppr-high"] };
  assert.equal(badgeFrom(sig, { pprHighPercentile: 0.9, minRatingCount: 1 }).state, "UNRATED");
  assert.equal(badgeFrom(sig, { pprHighPercentile: 0.7, minRatingCount: 1 }).state, "farm-suspect");
});
