import { test } from "node:test";
import assert from "node:assert/strict";

import { deriveChatKeys, deriveChatKeysFromShared, generateSharedKey } from "../src/protocol/index.js";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { hex } from "@scure/base";

function xOnlyPubkey(secretHex: string): string {
  const compressed = secp256k1.getPublicKey(hex.decode(secretHex), true);
  return hex.encode(compressed.subarray(1));
}

test("protocol test vector: K_conv / K_sign derived pubkeys", () => {
  const alice = "548f68890c49fa42f104c60352395e60ff030b0b407e955f1eed1400d6c0347a";
  const bob = "f258e73f07386d37133718b6127f873dd7c391b8f43b331ff8254034a13d2943";

  // mostro-core asserts these exact pubkeys before deriving chat keys.
  assert.equal(xOnlyPubkey(alice), "000053c3b4773182e7c4c1b72b272d34be01bf4414a6a25c998977c516a46a01");
  assert.equal(xOnlyPubkey(bob), "000009ae5cff9f6ba9b05159ec5ed58c187f5882ea77c81ed5dd19163272a5d7");

  const aliceKeys = deriveChatKeys(alice, xOnlyPubkey(bob));
  const bobKeys = deriveChatKeys(bob, xOnlyPubkey(alice));

  // Both peers must derive identical keys by swapping arguments.
  assert.equal(aliceKeys.convPubkeyHex, bobKeys.convPubkeyHex);
  assert.equal(aliceKeys.signPubkeyHex, bobKeys.signPubkeyHex);
  assert.equal(aliceKeys.convPubkeyHex, "bceb1cd2a8e98ee9729122a1693edcc39c3ace04582ff96a26705c5e4078a6f2");
  assert.equal(aliceKeys.signPubkeyHex, "1dba04571059183f76b148119cfa6f8004dad30cb4e810180a6df17386a7f0b4");
});

test("derive from shared secret matches ECDH path", () => {
  const alice = "548f68890c49fa42f104c60352395e60ff030b0b407e955f1eed1400d6c0347a";
  const bob = "f258e73f07386d37133718b6127f873dd7c391b8f43b331ff8254034a13d2943";
  const shared = generateSharedKey(alice, xOnlyPubkey(bob));
  assert.equal(hex.encode(shared), "def6633a53d07d1e829484c4d4bdbbeed2f4b14c21743e63871c174338e39475");

  const fromShared = deriveChatKeysFromShared(shared);
  const direct = deriveChatKeys(alice, xOnlyPubkey(bob));
  assert.equal(fromShared.convPubkeyHex, direct.convPubkeyHex);
  assert.equal(fromShared.signPubkeyHex, direct.signPubkeyHex);
});

test("K_conv cannot derive K_sign (observer read-only)", () => {
  const alice = "548f68890c49fa42f104c60352395e60ff030b0b407e955f1eed1400d6c0347a";
  const bob = "f258e73f07386d37133718b6127f873dd7c391b8f43b331ff8254034a13d2943";
  const keys = deriveChatKeys(alice, xOnlyPubkey(bob));
  assert.notEqual(keys.convSecretHex, keys.signSecretHex);
  assert.notEqual(keys.convPubkeyHex, keys.signPubkeyHex);
});

test("wrong length shared secret rejected", () => {
  assert.throws(() => deriveChatKeysFromShared(new Uint8Array(16)));
});