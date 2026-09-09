import { test } from "node:test";
import assert from "node:assert/strict";

import {
  deriveTradeKeys,
  deriveIdentityKeys,
} from "../src/protocol/keys.js";
import { newOrderMessage } from "../src/protocol/message.js";
import { serializeMessage } from "../src/protocol/wire.js";
import {
  wrapMessageNip44,
  unwrapMessageNip44,
  signMessage,
  verifyMessageSignature,
  Transport,
  transportEventKind,
  transportProtocolVersion,
} from "../src/protocol/transport.js";
import { identityProofPayload } from "../src/protocol/proof.js";
import { encrypt } from "nostr-tools/nip44";
import { v2 as nip44V2 } from "nostr-tools/nip44";
import { hex } from "@scure/base";

const MNEMONIC =
  "leader monkey parrot ring guide accident before fence cannon height naive bean";

function orderMessage() {
  return newOrderMessage(null, 1, 2, "new-order", {
    variant: "order",
    value: {
      id: null,
      kind: "sell",
      status: "pending",
      amount: 100,
      fiat_code: "eur",
      min_amount: null,
      max_amount: null,
      fiat_amount: 100,
      payment_method: "SEPA",
      premium: 1,
      buyer_trade_pubkey: null,
      seller_trade_pubkey: null,
      buyer_invoice: null,
      created_at: 0,
      expires_at: null,
    },
  });
}

test("Message::sign / verify_signature roundtrip", () => {
  const trade = deriveTradeKeys(MNEMONIC, 1);
  const msg = orderMessage();
  const json = serializeMessage(msg);
  const sig = signMessage(json, trade.secret);
  assert.ok(verifyMessageSignature(json, trade.pubkey, sig));
  assert.ok(!verifyMessageSignature(json + "x", trade.pubkey, sig));
  assert.ok(!verifyMessageSignature(json, "00".repeat(32), sig));
});

test("wrap/unwrap NIP-44 roundtrip (reputation mode)", () => {
  const identity = deriveIdentityKeys(MNEMONIC);
  const trade = deriveTradeKeys(MNEMONIC, 1);
  const receiver = deriveTradeKeys(MNEMONIC, 2);
  const msg = orderMessage();

  const wrapped = wrapMessageNip44({
    message: msg,
    identitySecretHex: identity.secret,
    tradeSecretHex: trade.secret,
    receiverPubkeyHex: receiver.pubkey,
    opts: { signed: true },
  });

  const unwrapped = unwrapMessageNip44({
    event: { kind: 14, pubkey: trade.pubkey, content: wrapped.content },
    receiverSecretHex: receiver.secret,
  });

  assert.ok(unwrapped);
  assert.equal(unwrapped.sender, trade.pubkey);
  assert.equal(unwrapped.identity, identity.pubkey);
  assert.ok(unwrapped.signature);
  assert.equal(serializeMessage(unwrapped.message), serializeMessage(msg));
});

test("wrap/unwrap full-privacy mode (identity == trade key)", () => {
  const trade = deriveTradeKeys(MNEMONIC, 1);
  const receiver = deriveTradeKeys(MNEMONIC, 2);
  const msg = orderMessage();

  const wrapped = wrapMessageNip44({
    message: msg,
    identitySecretHex: trade.secret, // same as trade → no identity proof
    tradeSecretHex: trade.secret,
    receiverPubkeyHex: receiver.pubkey,
    opts: { signed: false },
  });

  const unwrapped = unwrapMessageNip44({
    event: { kind: 14, pubkey: trade.pubkey, content: wrapped.content },
    receiverSecretHex: receiver.secret,
  });

  assert.ok(unwrapped);
  assert.equal(unwrapped.identity, trade.pubkey);
  assert.equal(unwrapped.signature, null);
});

test("unwrap with wrong receiver returns null (not addressed to me)", () => {
  const trade = deriveTradeKeys(MNEMONIC, 1);
  const receiver = deriveTradeKeys(MNEMONIC, 2);
  const stranger = deriveTradeKeys(MNEMONIC, 3);
  const msg = orderMessage();

  const wrapped = wrapMessageNip44({
    message: msg,
    identitySecretHex: trade.secret,
    tradeSecretHex: trade.secret,
    receiverPubkeyHex: receiver.pubkey,
  });

  const result = unwrapMessageNip44({
    event: { kind: 14, pubkey: trade.pubkey, content: wrapped.content },
    receiverSecretHex: stranger.secret,
  });
  assert.equal(result, null);
});

test("unwrap with forged identity proof throws", () => {
  const trade = deriveTradeKeys(MNEMONIC, 1);
  const receiver = deriveTradeKeys(MNEMONIC, 2);
  const attacker = deriveTradeKeys(MNEMONIC, 3);
  const msg = orderMessage();
  const msgJson = serializeMessage(msg);

  // Build a plaintext tuple with a bogus identity proof (attacker signs the
  // wrong payload), then encrypt manually like wrap does.
  const bogusSig = signMessage("not the real message", attacker.secret);
  const tuple = [msg, null, [attacker.pubkey, bogusSig]];
  const ck = nip44V2.utils.getConversationKey(hex.decode(trade.secret), receiver.pubkey);
  const content = encrypt(JSON.stringify(tuple), ck);

  assert.throws(() =>
    unwrapMessageNip44({
      event: { kind: 14, pubkey: trade.pubkey, content },
      receiverSecretHex: receiver.secret,
    }),
  );
});

test("transport enum preserved", () => {
  assert.equal(Transport.Nip44Direct, "nip44");
  assert.equal(transportEventKind(Transport.Nip44Direct), 14);
  assert.equal(transportProtocolVersion(Transport.Nip44Direct), 2);
});