// Offline unit checks for attestation authoring (build / publish / revoke /
// all-revoke / NIP-02 follow list).
//   npx tsx --test extension/tg/attest.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { generateMnemonic, deriveIdentityKeys } from "../../src/protocol/index.js";
import { TrustGraph } from "./api.js";
import { parseAttestation } from "./graph.js";
import { buildAttestation, buildRevoke, attestationDTag, contextFromDTag, fetchFollowList, verifyHintHolds, auditHints } from "./attest.js";
import { BOOT, HINT, followListEvent, StubEventSource } from "./testkit.js";

const id1 = deriveIdentityKeys(generateMnemonic());
const id2 = deriveIdentityKeys(generateMnemonic());

test("buildAttestation roundtrips through parseAttestation", () => {
  const ev = buildAttestation({ trusterSecretHex: id1.secret, trustee: id2.pubkey, weight: 90, hint: HINT, context: "market", createdAt: 5 });
  const a = parseAttestation(ev);
  assert.ok(a);
  assert.equal(a.truster, id1.pubkey);
  assert.equal(a.trustee, id2.pubkey);
  assert.equal(a.weight, 90);
  assert.equal(a.hint, HINT);
  assert.equal(a.d, attestationDTag(id2.pubkey, "market"));
  assert.equal(contextFromDTag(a.d), "market");
});

test("buildRevoke emits w=0 for the same d tag", () => {
  const live = parseAttestation(buildAttestation({ trusterSecretHex: id1.secret, trustee: id2.pubkey, weight: 50, hint: HINT }));
  const revoke = parseAttestation(buildRevoke({ trusterSecretHex: id1.secret, trustee: id2.pubkey, hint: HINT }));
  assert.ok(live && revoke);
  assert.equal(revoke.d, live.d);
  assert.equal(revoke.weight, 0);
});

test("fetchFollowList returns the latest deduped p tags", async () => {
  const store = new Map([
    [
      BOOT,
      [
        followListEvent(id1.pubkey, ["a", "b", "a"], 10),
        followListEvent(id1.pubkey, ["c"], 20), // newer revision wins
        followListEvent(id2.pubkey, ["z"], 30), // other author ignored
      ],
    ],
  ]);
  const follows = await fetchFollowList({ pool: new StubEventSource(store), relays: [BOOT], pubkey: id1.pubkey });
  assert.deepEqual(follows, ["c"]);
});

test("publishAttestation reflects locally and lists in myAttestations", async () => {
  const src = new StubEventSource(new Map(), true);
  const tg = new TrustGraph({ pool: src, relays: [BOOT], root: id1.pubkey });
  await tg.refresh();
  await tg.publishAttestation({ trusterSecretHex: id1.secret, trustee: id2.pubkey, weight: 90, hint: HINT });
  assert.equal(src.published.length, 1);
  assert.equal(tg.myAttestations().length, 1);
  assert.ok((tg.score(id2.pubkey) ?? 0) > 0);
});

test("revokeAttestation removes the edge locally", async () => {
  const src = new StubEventSource(new Map(), true);
  const tg = new TrustGraph({ pool: src, relays: [BOOT], root: id1.pubkey });
  await tg.refresh();
  await tg.publishAttestation({ trusterSecretHex: id1.secret, trustee: id2.pubkey, weight: 90, hint: HINT });
  assert.ok((tg.score(id2.pubkey) ?? 0) > 0);
  await tg.revokeAttestation({ trusterSecretHex: id1.secret, trustee: id2.pubkey });
  assert.equal(tg.myAttestations().length, 0);
  assert.equal(tg.score(id2.pubkey) ?? 0, 0);
});

test("revokeAll clears all my attestations", async () => {
  const src = new StubEventSource(new Map(), true);
  const others = [id2, deriveIdentityKeys(generateMnemonic()), deriveIdentityKeys(generateMnemonic())];
  const tg = new TrustGraph({ pool: src, relays: [BOOT], root: id1.pubkey });
  await tg.refresh();
  for (const o of others) await tg.publishAttestation({ trusterSecretHex: id1.secret, trustee: o.pubkey, weight: 50, hint: HINT });
  assert.equal(tg.myAttestations().length, 3);
  const revoked = await tg.revokeAll({ trusterSecretHex: id1.secret });
  assert.equal(revoked.length, 3);
  assert.equal(tg.myAttestations().length, 0);
});

test("buildAttestation rejects a live edge without a valid relay hint", () => {
  assert.throws(() => buildAttestation({ trusterSecretHex: id1.secret, trustee: id2.pubkey, weight: 50, hint: "not-a-relay" }));
  assert.throws(() => buildAttestation({ trusterSecretHex: id1.secret, trustee: id2.pubkey, weight: 50, hint: "" }));
  // revoke (w=0) does not require a hint
  assert.doesNotThrow(() => buildRevoke({ trusterSecretHex: id1.secret, trustee: id2.pubkey }));
});

test("verifyHintHolds checks the hint relay for the edge", async () => {
  const ev = buildAttestation({ trusterSecretHex: id1.secret, trustee: id2.pubkey, weight: 50, hint: HINT });
  const src = new StubEventSource(new Map([[HINT, [ev]]]));
  assert.equal(await verifyHintHolds({ pool: src, hint: HINT, truster: id1.pubkey, trustee: id2.pubkey }), true);
  assert.equal(await verifyHintHolds({ pool: src, hint: HINT, truster: id2.pubkey, trustee: id1.pubkey }), false);
  assert.equal(await verifyHintHolds({ pool: src, hint: "http://x", truster: id1.pubkey, trustee: id2.pubkey }), false);
  const audit = await auditHints({ pool: src, attestations: [parseAttestation(ev)!] });
  assert.equal(audit[0]!.ok, true);
});

test("myAttestations excludes local seeds", async () => {
  const tg = new TrustGraph({ pool: new StubEventSource(), relays: [BOOT], root: id1.pubkey });
  tg.seed([{ to: id2.pubkey, weight: 90 }]);
  await tg.refresh();
  assert.equal(tg.myAttestations().length, 0);
  assert.ok((tg.score(id2.pubkey) ?? 0) > 0);
});
