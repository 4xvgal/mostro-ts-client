import { test } from "node:test";
import assert from "node:assert/strict";

import {
  deriveChatKeys,
  wrapChatMessage,
  unwrapChatMessage,
} from "../src/protocol/index.js";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { hex } from "@scure/base";

function xOnlyPubkey(secretHex: string): string {
  const compressed = secp256k1.getPublicKey(hex.decode(secretHex), true);
  return hex.encode(compressed.subarray(1));
}

test("chat wrap/unwrap roundtrip (both peers)", () => {
  const aliceTrade = "548f68890c49fa42f104c60352395e60ff030b0b407e955f1eed1400d6c0347a";
  const bobTrade = "f258e73f07386d37133718b6127f873dd7c391b8f43b331ff8254034a13d2943";
  const alicePub = xOnlyPubkey(aliceTrade);
  const bobPub = xOnlyPubkey(bobTrade);

  // Both derive the same K_conv / K_sign.
  const aliceChat = deriveChatKeys(aliceTrade, bobPub);
  const bobChat = deriveChatKeys(bobTrade, alicePub);
  assert.equal(aliceChat.convPubkeyHex, bobChat.convPubkeyHex);
  assert.equal(aliceChat.signPubkeyHex, bobChat.signPubkeyHex);

  const now = Math.floor(Date.now() / 1000);
  const { event } = wrapChatMessage({
    senderTradeSecretHex: aliceTrade,
    convSecretHex: aliceChat.convSecretHex,
    convPubkeyHex: aliceChat.convPubkeyHex,
    signSecretHex: aliceChat.signSecretHex,
    message: "Hello from Alice!",
  });

  assert.equal(event.kind, 14);
  assert.equal(event.pubkey, aliceChat.signPubkeyHex);
  assert.deepEqual(event.tags, [["p", aliceChat.convPubkeyHex]]);

  // Bob receives and unwraps.
  const msg = unwrapChatMessage({
    convSecretHex: bobChat.convSecretHex,
    convPubkeyHex: bobChat.convPubkeyHex,
    signPubkeyHex: bobChat.signPubkeyHex,
    allowedSigners: [alicePub, bobPub],
    outer: event,
    now,
  });
  assert.equal(msg.content, "Hello from Alice!");
  assert.equal(msg.sender, alicePub);
  assert.equal(msg.created_at, event.created_at);
  assert.ok(msg.innerEventId);
});

test("unwrap rejects wrong signer", () => {
  const aliceTrade = "548f68890c49fa42f104c60352395e60ff030b0b407e955f1eed1400d6c0347a";
  const bobTrade = "f258e73f07386d37133718b6127f873dd7c391b8f43b331ff8254034a13d2943";
  const alicePub = xOnlyPubkey(aliceTrade);
  const bobPub = xOnlyPubkey(bobTrade);
  const aliceChat = deriveChatKeys(aliceTrade, bobPub);
  const bobChat = deriveChatKeys(bobTrade, alicePub);
  const strangerTrade = "11".repeat(32);
  const strangerPub = xOnlyPubkey(strangerTrade);

  const { event } = wrapChatMessage({
    senderTradeSecretHex: strangerTrade,
    convSecretHex: aliceChat.convSecretHex,
    convPubkeyHex: aliceChat.convPubkeyHex,
    signSecretHex: aliceChat.signSecretHex,
    message: "intruder",
  });

  assert.throws(() =>
    unwrapChatMessage({
      convSecretHex: bobChat.convSecretHex,
      convPubkeyHex: bobChat.convPubkeyHex,
      signPubkeyHex: bobChat.signPubkeyHex,
      allowedSigners: [alicePub, bobPub],
      outer: event,
      now: Math.floor(Date.now() / 1000),
    }),
  );
});

test("unwrap rejects wrong K_sign author", () => {
  const aliceTrade = "548f68890c49fa42f104c60352395e60ff030b0b407e955f1eed1400d6c0347a";
  const bobTrade = "f258e73f07386d37133718b6127f873dd7c391b8f43b331ff8254034a13d2943";
  const alicePub = xOnlyPubkey(aliceTrade);
  const bobPub = xOnlyPubkey(bobTrade);
  const aliceChat = deriveChatKeys(aliceTrade, bobPub);
  const bobChat = deriveChatKeys(bobTrade, alicePub);

  const { event } = wrapChatMessage({
    senderTradeSecretHex: aliceTrade,
    convSecretHex: aliceChat.convSecretHex,
    convPubkeyHex: aliceChat.convPubkeyHex,
    signSecretHex: aliceChat.signSecretHex,
    message: "signed by alice",
  });

  assert.throws(() =>
    unwrapChatMessage({
      convSecretHex: bobChat.convSecretHex,
      convPubkeyHex: bobChat.convPubkeyHex,
      // wrong: expect stranger as K_sign
      signPubkeyHex: xOnlyPubkey("11".repeat(32)),
      allowedSigners: [alicePub, bobPub],
      outer: event,
      now: Math.floor(Date.now() / 1000),
    }),
  );
});