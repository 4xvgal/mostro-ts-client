// Offline checks: publish reporting/retry, social index, follow list,
// NIP-17 DM payload, expiration, and reputation-mode disclosure.
//   npx tsx --test extension/tg/social.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import type { NostrEvent } from "nostr-tools/core";
import { generateMnemonic, deriveIdentityKeys } from "../../src/protocol/index.js";
import { publishEvent } from "./publish.js";
import { buildAttestation, publishAll } from "./attest.js";
import {
  buildSocialIndex,
  parseSocialIndex,
  publishSocialIndex,
  revokeSocialIndex,
  buildFollowList,
  publishFollowList,
  buildTrustGraphDm,
  parseTrustGraphDm,
  disclosureFor,
  PUBLIC_REPUTATION_DISCLOSURE,
  SOCIAL_INDEX_KIND,
  type SocialIndexEntry,
  type TrustGraphDmPayload,
} from "./social.js";
import { adjacencyFromAttestations, parseAttestation } from "./graph.js";
import { BOOT, HINT, StubEventSource } from "./testkit.js";

const id1 = deriveIdentityKeys(generateMnemonic());
const id2 = deriveIdentityKeys(generateMnemonic());

class FlakyPublisher {
  calls: string[][] = [];
  constructor(private readonly fail: Set<string>) {}
  publish(relays: string[], event: NostrEvent): Array<Promise<string>> {
    this.calls.push([...relays]);
    return relays.map((r) => (this.fail.has(r) ? Promise.reject(new Error("nope")) : Promise.resolve(event.id)));
  }
}

test("publishEvent reports per-relay outcomes and ok=any", async () => {
  const ev = buildAttestation({ trusterSecretHex: id1.secret, trustee: id2.pubkey, weight: 50, hint: HINT });
  const flaky = new FlakyPublisher(new Set(["wss://b"]));
  const report = await publishEvent(flaky, ["wss://a", "wss://b"], ev);
  assert.equal(report.ok, true);
  assert.deepEqual(report.relays.map((r) => [r.relay, r.ok]), [["wss://a", true], ["wss://b", false]]);

  const all = new FlakyPublisher(new Set(["wss://a", "wss://b"]));
  assert.equal((await publishEvent(all, ["wss://a", "wss://b"], ev)).ok, false);
});

test("publishEvent retries failed relays", async () => {
  const ev = buildAttestation({ trusterSecretHex: id1.secret, trustee: id2.pubkey, weight: 50, hint: HINT });
  const flaky = new FlakyPublisher(new Set(["wss://b"]));
  await publishEvent(flaky, ["wss://a", "wss://b"], ev, { retries: 2 });
  assert.deepEqual(flaky.calls, [["wss://a", "wss://b"], ["wss://b"], ["wss://b"]]);
});

test("publishAll publishes many edges at once", async () => {
  const src = new StubEventSource();
  const results = await publishAll({
    pool: src,
    relays: [BOOT],
    trusterSecretHex: id1.secret,
    edges: [
      { trustee: "a", weight: 50, hint: HINT },
      { trustee: "b", weight: 90, hint: HINT },
    ],
  });
  assert.equal(results.length, 2);
  assert.ok(results.every((r) => r.report.ok));
  assert.equal(src.published.length, 2);
});

test("social index builds, parses, publishes and revokes entries", async () => {
  const e1: SocialIndexEntry = { order_id: "o1", mostro_pubkey: "m", relay: "wss://r" };
  const e2: SocialIndexEntry = { order_id: "o2", mostro_pubkey: "m", relay: "wss://r" };
  const ev = buildSocialIndex({ identitySecretHex: id1.secret, entries: [e1, e2], createdAt: 5 });
  assert.equal(ev.kind, SOCIAL_INDEX_KIND);
  assert.deepEqual(parseSocialIndex(ev), [e1, e2]);

  const src = new StubEventSource();
  assert.equal((await publishSocialIndex({ pool: src, relays: [BOOT], identitySecretHex: id1.secret, entries: [e1] })).report.ok, true);

  const rev = await revokeSocialIndex({ pool: src, relays: [BOOT], identitySecretHex: id1.secret, currentEntries: [e1, e2], orderIds: ["o1"] });
  assert.deepEqual(parseSocialIndex(rev.event), [e2]);
  const wipe = await revokeSocialIndex({ pool: src, relays: [BOOT], identitySecretHex: id1.secret, currentEntries: [e1, e2] });
  assert.deepEqual(parseSocialIndex(wipe.event), []);
});

test("follow list (kind 3) builds and publishes", async () => {
  const ev = buildFollowList({ secretHex: id1.secret, follows: ["a", "b"], createdAt: 5 });
  assert.equal(ev.kind, 3);
  assert.deepEqual(ev.tags, [["p", "a"], ["p", "b"]]);
  const src = new StubEventSource();
  const { report } = await publishFollowList({ pool: src, relays: [BOOT], secretHex: id1.secret, follows: ["a"] });
  assert.equal(report.ok, true);
});

test("NIP-17 verification DM round-trips for the recipient", () => {
  const payload: TrustGraphDmPayload = { type: "mostro-trust-graph-v1", identity_pubkey: id1.pubkey, order_id: "o", mostro_pubkey: "m", relay: "wss://r" };
  const wrap = buildTrustGraphDm({ senderSecretHex: id1.secret, recipientPubkey: id2.pubkey, payload });
  assert.deepEqual(parseTrustGraphDm({ event: wrap, recipientSecretHex: id2.secret }), payload);
  assert.equal(parseTrustGraphDm({ event: wrap, recipientSecretHex: id1.secret }), null);
});

test("expiration (NIP-40) drops the edge after ttl", () => {
  const ev = buildAttestation({ trusterSecretHex: id1.secret, trustee: id2.pubkey, weight: 50, hint: HINT, ttlSec: 100, createdAt: 1000 });
  const a = parseAttestation(ev)!;
  assert.equal(a.expiresAt, 1100);
  assert.ok(adjacencyFromAttestations([a], { now: 1050 }).get(id1.pubkey));
  assert.equal(adjacencyFromAttestations([a], { now: 1200 }).get(id1.pubkey), undefined);
});

test("disclosure is returned only for public-reputation mode", () => {
  assert.equal(disclosureFor("full-privacy"), null);
  assert.equal(disclosureFor("reputation"), null);
  assert.equal(disclosureFor("public-reputation"), PUBLIC_REPUTATION_DISCLOSURE);
});
