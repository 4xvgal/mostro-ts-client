import { test } from "node:test";
import assert from "node:assert/strict";

import {
  mostroInfoFromTags,
  emptyMostroInstanceInfo,
  isInstanceInfoStale,
  nostrPowFromInstance,
  effectivePowFirstContactFromInstance,
  nostrPowForProtocolDm,
  instanceBondsEnabled,
  transportFromInstance,
  isV2FirstContactProtocolAction,
  instanceInfoEventIsAuthentic,
  selectAuthenticInstanceInfoEvent,
} from "../src/protocol/index.js";
import { Transport } from "../src/protocol/transport.js";

// Real tags observed from the public relay kind-38385 event (2026-09-09).
const REAL_TAGS: string[][] = [
  ["d", "82fa8cb978b43c79b2156585bac2c011176a21d2aead6d9f7c575c005be88390"],
  ["mostro_version", "0.18.7"],
  ["mostro_commit_hash", "afc39a2c6a1a447c977b0d6bc401837d71436e79"],
  ["max_order_amount", "1000000"],
  ["min_order_amount", "1000"],
  ["expiration_hours", "24"],
  ["expiration_seconds", "900"],
  ["fiat_currencies_accepted", ""],
  ["max_orders_per_response", "20"],
  ["fee", "0.01"],
  ["pow", "6"],
  ["pow_first_contact", "6"],
  ["protocol_version", "2"],
  ["bond_enabled", "true"],
  ["lnd_version", "0.21.2-beta commit=v0.21.2-beta"],
  ["lnd_node_pubkey", "02809440c31fca9933af0ee4b5af472fcddedaa3f4eab6e77ad1b40783415c6e5f"],
  ["lnd_node_alias", "Mostro"],
  ["lnd_chains", "bitcoin"],
  ["lnd_networks", "mainnet"],
  ["lnd_uris", "02809440c31fca9933af0ee4b5af472fcddedaa3f4eab6e77ad1b40783415c6e5f@104.248.230.224:9735"],
  ["z", "info"],
];

test("parses real public instance tags", () => {
  const info = mostroInfoFromTags(REAL_TAGS);
  assert.equal(info.mostro_version, "0.18.7");
  assert.equal(info.max_order_amount, 1_000_000);
  assert.equal(info.min_order_amount, 1_000);
  assert.equal(info.expiration_hours, 24);
  assert.equal(info.pow, 6);
  assert.equal(info.pow_first_contact, 6);
  assert.equal(info.protocol_version, 2);
  assert.equal(info.bond_enabled, true);
  assert.equal(info.fee, 0.01);
  assert.equal(info.lnd_node_alias, "Mostro");
  assert.deepEqual(info.lnd_networks, ["mainnet"]);
  assert.deepEqual(info.lnd_uris, [
    "02809440c31fca9933af0ee4b5af472fcddedaa3f4eab6e77ad1b40783415c6e5f@104.248.230.224:9735",
  ]);
});

test("empty fiat tag → empty list", () => {
  const info = mostroInfoFromTags([["fiat_currencies_accepted", ""]]);
  assert.deepEqual(info.fiat_currencies_accepted, []);
});

test("csv split trims and drops empties", () => {
  const info = mostroInfoFromTags([["fiat_currencies_accepted", "USD, EUR, ,ARS ,  "]]);
  assert.deepEqual(info.fiat_currencies_accepted, ["USD", "EUR", "ARS"]);
});

test("malformed numbers → null", () => {
  const info = mostroInfoFromTags([
    ["max_order_amount", "not-a-number"],
    ["fee", "invalid"],
    ["expiration_hours"], // no value
    ["unknown_tag", "ignored"],
  ]);
  assert.equal(info.max_order_amount, null);
  assert.equal(info.fee, null);
  assert.equal(info.expiration_hours, null);
});

test("bond_enabled parsing", () => {
  assert.equal(mostroInfoFromTags([["bond_enabled", "true"]]).bond_enabled, true);
  assert.equal(mostroInfoFromTags([["bond_enabled", "TRUE"]]).bond_enabled, true);
  assert.equal(mostroInfoFromTags([["bond_enabled", "false"]]).bond_enabled, false);
  assert.equal(mostroInfoFromTags([["bond_enabled", "invalid"]]).bond_enabled, null);
});

test("transport resolution from protocol_version", () => {
  assert.equal(transportFromInstance(null), Transport.GiftWrap);
  assert.equal(transportFromInstance(emptyMostroInstanceInfo()), Transport.GiftWrap);
  assert.equal(
    transportFromInstance({ ...emptyMostroInstanceInfo(), protocol_version: 2 }),
    Transport.Nip44Direct,
  );
  assert.equal(
    transportFromInstance({ ...emptyMostroInstanceInfo(), protocol_version: 1 }),
    Transport.GiftWrap,
  );
  assert.equal(
    transportFromInstance({ ...emptyMostroInstanceInfo(), protocol_version: 99 }),
    Transport.GiftWrap,
  );
});

test("pow helpers", () => {
  assert.equal(nostrPowFromInstance(null), 0);
  assert.equal(nostrPowFromInstance({ ...emptyMostroInstanceInfo(), pow: 8 }), 8);
  assert.equal(
    effectivePowFirstContactFromInstance({ ...emptyMostroInstanceInfo(), pow: 8 }),
    8,
  );
  assert.equal(
    effectivePowFirstContactFromInstance({
      ...emptyMostroInstanceInfo(),
      pow: 8,
      pow_first_contact: 16,
    }),
    16,
  );
});

test("nostrPowForProtocolDm uses max toll on v2 first-contact", () => {
  const info = {
    ...emptyMostroInstanceInfo(),
    pow: 8,
    pow_first_contact: 16,
    protocol_version: 2,
  };
  assert.equal(nostrPowForProtocolDm(info, "new-order"), 16);
  assert.equal(nostrPowForProtocolDm(info, "take-sell"), 16);
  assert.equal(nostrPowForProtocolDm(info, "add-invoice"), 8);

  const v1 = { ...info, protocol_version: 1 };
  assert.equal(nostrPowForProtocolDm(v1, "new-order"), 8);
});

test("first-contact actions", () => {
  assert.ok(isV2FirstContactProtocolAction("new-order"));
  assert.ok(isV2FirstContactProtocolAction("take-buy"));
  assert.ok(isV2FirstContactProtocolAction("take-sell"));
  assert.ok(!isV2FirstContactProtocolAction("add-invoice"));
});

test("instanceBondsEnabled requires explicit true", () => {
  assert.equal(instanceBondsEnabled(null), false);
  assert.equal(instanceBondsEnabled(emptyMostroInstanceInfo()), false);
  assert.equal(instanceBondsEnabled({ ...emptyMostroInstanceInfo(), bond_enabled: false }), false);
  assert.equal(instanceBondsEnabled({ ...emptyMostroInstanceInfo(), bond_enabled: true }), true);
});

test("instanceInfoEventIsAuthentic + selection (MOSTRO-075)", () => {
  const mostro = "82fa8cb978b43c79b2156585bac2c011176a21d2aead6d9f7c575c005be88390";
  const attacker = "11".repeat(32);

  const authentic = {
    kind: 38385,
    pubkey: mostro,
    tags: [["d", mostro]],
    created_at: 1000,
  };
  const forgedNewer = {
    kind: 38385,
    pubkey: attacker,
    tags: [["d", mostro]],
    created_at: 9999,
  };
  const wrongD = {
    kind: 38385,
    pubkey: mostro,
    tags: [["d", "not-the-mostro-pubkey"]],
    created_at: 2000,
  };

  assert.ok(instanceInfoEventIsAuthentic(authentic, mostro));
  assert.ok(!instanceInfoEventIsAuthentic(forgedNewer, mostro));
  assert.ok(!instanceInfoEventIsAuthentic(wrongD, mostro));

  const selected = selectAuthenticInstanceInfoEvent([forgedNewer, wrongD, authentic], mostro);
  assert.equal(selected?.created_at, 1000);
});

test("stale detection", () => {
  const fresh = { ...emptyMostroInstanceInfo(), last_updated: Math.floor(Date.now() / 1000) };
  assert.ok(!isInstanceInfoStale(fresh));
  const old = { ...emptyMostroInstanceInfo(), last_updated: Math.floor(Date.now() / 1000) - 700_000 };
  assert.ok(isInstanceInfoStale(old));
  assert.ok(isInstanceInfoStale(emptyMostroInstanceInfo()));
});