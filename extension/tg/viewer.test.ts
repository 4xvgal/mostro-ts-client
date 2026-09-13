// Offline checks for fetchSocialIndex + TrustGraphViewer composition.
//   npx tsx --test extension/tg/viewer.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { generateMnemonic, deriveIdentityKeys, newSmallOrder, Kind, Status } from "../../src/protocol/index.js";
import { TrustGraphViewer } from "./viewer.js";
import { buildOrderBinding } from "./api.js";
import { buildSocialIndex, fetchSocialIndex } from "./social.js";
import { buildAttestation } from "./attest.js";
import { BOOT, HINT, StubEventSource } from "./testkit.js";

const viewer = deriveIdentityKeys(generateMnemonic());
const maker = deriveIdentityKeys(generateMnemonic());
const mostro = deriveIdentityKeys(generateMnemonic());

test("fetchSocialIndex returns the latest revision per author", async () => {
  const store = new Map([
    [
      BOOT,
      [
        buildSocialIndex({ identitySecretHex: maker.secret, entries: [{ order_id: "o1", mostro_pubkey: mostro.pubkey, relay: BOOT }], createdAt: 10 }),
        buildSocialIndex({ identitySecretHex: maker.secret, entries: [{ order_id: "o2", mostro_pubkey: mostro.pubkey, relay: BOOT }], createdAt: 20 }),
      ],
    ],
  ]);
  const events = await fetchSocialIndex({ pool: new StubEventSource(store), relays: [BOOT] });
  assert.equal(events.length, 1);
  assert.equal(events[0]!.created_at, 20);
});

test("TrustGraphViewer wires 30501 + 30500 into annotate", async () => {
  const { pm } = buildOrderBinding({ identitySecretHex: maker.secret, mostroPubkey: mostro.pubkey, kind: "sell", fiatCode: "USD", premium: 0, basePaymentMethod: "SEPA", fiatAmount: 25 });
  const order = newSmallOrder({ id: "o1", kind: Kind.Sell, status: Status.Pending, amount: 0, fiat_code: "USD", fiat_amount: 25, payment_method: pm, premium: 0 });
  const store = new Map([
    [
      BOOT,
      [
        buildSocialIndex({ identitySecretHex: maker.secret, entries: [{ order_id: "o1", mostro_pubkey: mostro.pubkey, relay: BOOT }], createdAt: 10 }),
        buildAttestation({ trusterSecretHex: viewer.secret, trustee: maker.pubkey, weight: 90, hint: HINT, createdAt: 10 }),
      ],
    ],
  ]);
  const v = new TrustGraphViewer({
    pool: new StubEventSource(store),
    relays: [BOOT],
    root: viewer.pubkey,
    mostroPubkey: mostro.pubkey,
    seed: [{ to: maker.pubkey, weight: 90, hint: HINT }],
  });
  await v.refresh();
  const [a] = v.annotate([order]);
  assert.ok(a);
  assert.equal(a.identity, maker.pubkey);
  assert.equal(a.binding?.ok, true);
  assert.ok(a.signals.verified);
  assert.ok((v.score(maker.pubkey) ?? 0) > 0);
});
