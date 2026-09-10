// Field-encryption helper roundtrip + SQLite integration.

import test from "node:test";
import assert from "node:assert/strict";
import {
  decryptString,
  decryptStringOrNull,
  encryptString,
  encryptStringOrNull,
  lazyPassphraseEncryptor,
  rawKeyEncryptor,
  isEncryptedFormat,
} from "../src/protocol/encryption.js";
import { openNodeSqliteStore } from "../src/protocol/node-store.js";

const original = "12-word-mnemonic phrase placeholder secret";

test("encrypt/decrypt roundtrip via generic helpers", async () => {
  const enc = lazyPassphraseEncryptor("passphrase-root");
  const stored = await encryptString(enc, original);
  assert.ok(isEncryptedFormat(stored));
  const plain = await decryptString(enc, stored);
  assert.equal(plain, original);
  enc.close();
});

test("pass-through when no encryptor supplied", async () => {
  const stored = await encryptString(undefined, original);
  assert.equal(stored, original);
  const plain = await decryptString(undefined, stored);
  assert.equal(plain, original);
});

test("value-sensitivee null handling", async () => {
  assert.equal(await encryptStringOrNull(undefined, null), null);
  assert.equal(await decryptStringOrNull(undefined, null), null);
  const enc = lazyPassphraseEncryptor("strong");
  const stored = await encryptStringOrNull(enc, "chat-key-hex");
  assert.ok(stored !== null && isEncryptedFormat(stored));
  const plain = await decryptStringOrNull(enc, stored);
  assert.equal(plain, "chat-key-hex");
  enc.close();
});

test("wrong passphrase raises (not silent)", async () => {
  const right = lazyPassphraseEncryptor("right");
  const stored = await encryptString(right, original);
  const wrong = lazyPassphraseEncryptor("wrong");
  await assert.rejects(decryptString(wrong, stored));
  right.close();
  wrong.close();
});

test("rawKeyEncryptor: wallet-injected key roundtrip, key not zeroed", async () => {
  const key = new Uint8Array(32).fill(7);
  const enc = rawKeyEncryptor(key);
  const stored = await encryptString(enc, original);
  assert.ok(stored.startsWith("b1x"));
  assert.equal(await decryptString(enc, stored), original);
  enc.close();
  // caller's buffer must be untouched (wallet owns it)
  assert.equal(key[0], 7);
  assert.equal(key[31], 7);
});

test("raw key cannot open a passphrase envelope", async () => {
  const pass = lazyPassphraseEncryptor("pw");
  const stored = await encryptString(pass, original);
  const raw = rawKeyEncryptor(new Uint8Array(32).fill(1));
  await assert.rejects(decryptString(raw, stored));
  pass.close();
  raw.close();
});

test("sqlite store encrypts sensitive columns (trade_keys + solver chat key)", async () => {
  const enc = lazyPassphraseEncryptor("pw");
  const store = openNodeSqliteStore(":memory:", { encryptor: enc });
  await store.upsertUser({ i0_pubkey: "p0p", last_trade_index: 0, created_at: 1 });

  const fetched = await store.getUser();
  assert.ok(fetched !== null);
  assert.equal(fetched!.i0_pubkey, "p0p");

  const order = {
    id: "o1",
    kind: "buy",
    status: "pending",
    amount: 100,
    fiat_code: "USD",
    min_amount: null,
    max_amount: null,
    fiat_amount: 50,
    payment_method: "cash",
    premium: 0,
    trade_keys: "deadbeef",
    counterparty_pubkey: null,
    is_mine: true,
    buyer_invoice: null,
    request_id: 1,
    trade_index: 1,
    created_at: 1,
    expires_at: 1,
  };
  await store.saveOrder(order);
  const got = await store.getOrder("o1");
  assert.equal(got!.trade_keys, "deadbeef");
  await store.updateSolverChat("o1", "solverpub", "chathex");
  const got2 = await store.getOrder("o1");
  assert.equal(got2!.dispute_chat_shared_key_hex, "chathex");
  enc.close();
  await store.close();
});
