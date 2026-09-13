// Offline unit checks for the pm order-binding token.
//   npx tsx --test extension/tg/token.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { schnorr } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { base64urlnopad, hex } from "@scure/base";
import { generateMnemonic, deriveIdentityKeys } from "../../src/protocol/index.js";
import {
  buildPmToken,
  verifyPmToken,
  parseTgToken,
  canonicalBase,
  splitPm,
  insertToken,
  extractTokenFromSegments,
  type TgChallengeInput,
} from "./token.js";

const alice = deriveIdentityKeys(generateMnemonic());
const mallory = deriveIdentityKeys(generateMnemonic());

const MOSTRO_A = schnorr.getPublicKey(hex.decode(mallory.secret));
const MOSTRO_B = schnorr.getPublicKey(hex.decode(alice.secret));
const hexA = hex.encode(MOSTRO_A);
const hexB = hex.encode(MOSTRO_B);

const FIXED: TgChallengeInput = {
  mostroPubkey: hexA,
  kind: "sell",
  fiatCode: "VES",
  premium: 0,
  basePaymentMethod: "bank transfer,zelle",
  fiatAmount: 150,
};

const RANGE: TgChallengeInput = {
  variant: "v1r",
  mostroPubkey: hexA,
  kind: "buy",
  fiatCode: "USD",
  premium: -1,
  basePaymentMethod: "sepa",
  minAmount: 10,
  maxAmount: 50,
};

test("v1 fixed-price token round-trips", () => {
  const token = buildPmToken(FIXED, alice.secret);
  assert.match(token, /^tg:v1~[A-Za-z0-9_-]{22}\.[0-9a-f]{128}$/);
  assert.equal(verifyPmToken(FIXED, token, alice.pubkey), true);
});

test("v1r range token round-trips (negative premium)", () => {
  const token = buildPmToken(RANGE, alice.secret);
  assert.ok(token.startsWith("tg:v1r~"));
  assert.equal(verifyPmToken(RANGE, token, alice.pubkey), true);
});

test("variant mismatch is rejected (v1 token, v1r fields)", () => {
  const token = buildPmToken(FIXED, alice.secret);
  assert.equal(verifyPmToken(RANGE, token, alice.pubkey), false);
});

test("tampered fields and wrong signer are rejected", () => {
  const token = buildPmToken(FIXED, alice.secret);
  const variants: TgChallengeInput[] = [
    { ...FIXED, fiatAmount: 151 },
    { ...FIXED, premium: 1 },
    { ...FIXED, fiatCode: "EUR" },
    { ...FIXED, kind: "buy" },
    { ...FIXED, basePaymentMethod: "zelle" },
    { ...FIXED, mostroPubkey: hexB },
  ];
  for (const v of variants) {
    assert.equal(verifyPmToken(v, token, alice.pubkey), false, JSON.stringify(v));
  }
  assert.equal(verifyPmToken(FIXED, token, mallory.pubkey), false);
});

test("cross-instance copy is rejected by mostro_pubkey binding", () => {
  const token = buildPmToken(FIXED, alice.secret); // signed for instance A
  // Replayed on instance B with identical parameters.
  assert.equal(verifyPmToken({ ...FIXED, mostroPubkey: hexB }, token, alice.pubkey), false);
});

test("buildPmToken uses a fresh nonce each call", () => {
  const a = buildPmToken(FIXED, alice.secret);
  const b = buildPmToken(FIXED, alice.secret);
  assert.notEqual(a, b);
  assert.equal(verifyPmToken(FIXED, a, alice.pubkey), true);
  assert.equal(verifyPmToken(FIXED, b, alice.pubkey), true);
});

test("parseTgToken rejects malformed tokens", () => {
  assert.equal(parseTgToken("tg:v1~short.zz"), null);
  assert.equal(parseTgToken("plain zelle"), null);
  assert.equal(parseTgToken("tg:v2~AAAAAAAAAAAAAAAAAAAAAA.00"), null);
});

test("canonicalBase matches mostrod split semantics (no trim, drop empties)", () => {
  assert.deepEqual(splitPm("a,,b"), ["a", "b"]);
  assert.equal(canonicalBase("a,,b"), "a,b");
  assert.equal(canonicalBase("bank transfer, zelle"), "bank transfer, zelle");
  assert.equal(canonicalBase(",a"), "a");
  const token = buildPmToken(FIXED, alice.secret);
  assert.equal(canonicalBase(insertToken(FIXED.basePaymentMethod, token)), FIXED.basePaymentMethod);
});

test("extractTokenFromSegments requires exactly one token", () => {
  const t1 = buildPmToken(FIXED, alice.secret);
  const t2 = buildPmToken(FIXED, alice.secret);
  assert.deepEqual(extractTokenFromSegments(["bank transfer", "zelle", t1]), {
    token: t1,
    base: "bank transfer,zelle",
  });
  assert.equal(extractTokenFromSegments(["bank transfer", t1, t2]), null);
  assert.equal(extractTokenFromSegments(["bank transfer"]), null);
});

test("challenge fields are newline-joined with no trailing newline", () => {
  const token = buildPmToken(FIXED, alice.secret);
  const parsed = parseTgToken(token)!;
  const enc = base64urlnopad.encode(parsed.nonce);
  const fields = ["mostro-ppr-v1", hexA, "sell", "VES", "150", "0", "bank transfer,zelle", enc];
  const pub = hex.decode(alice.pubkey);
  assert.equal(schnorr.verify(parsed.sig, sha256(new TextEncoder().encode(fields.join("\n"))), pub), true);
  assert.equal(schnorr.verify(parsed.sig, sha256(new TextEncoder().encode(fields.join("\n") + "\n")), pub), false);
});
