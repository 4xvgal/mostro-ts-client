import { test } from "node:test";
import assert from "node:assert/strict";

import {
  encryptBlob,
  decryptBlob,
  sha256Hex,
  isAllowedExtension,
  validateAttachment,
  buildUploadAuthEvent,
  signAuthEvent,
  parseChatAttachment,
  generateSharedKey,
  deriveTradeKeys,
  MAX_ATTACHMENT_BYTES,
} from "../src/protocol/index.js";

const MNEMONIC =
  "leader monkey parrot ring guide accident before fence cannon height naive bean";

test("blob encrypt/decrypt roundtrip", () => {
  const key = new Uint8Array(32).fill(7);
  const plaintext = new TextEncoder().encode("hello encrypted file");
  const blob = encryptBlob(key, plaintext);

  // Layout: [nonce:12][ciphertext][tag:16]
  assert.ok(blob.length >= 12 + 16 + plaintext.length);

  const decrypted = decryptBlob(key, blob);
  assert.equal(new TextDecoder().decode(decrypted), "hello encrypted file");
});

test("decrypt with wrong key throws", () => {
  const key = new Uint8Array(32).fill(1);
  const wrong = new Uint8Array(32).fill(2);
  const blob = encryptBlob(key, new TextEncoder().encode("secret"));
  assert.throws(() => decryptBlob(wrong, blob));
});

test("decrypt too-short blob throws", () => {
  assert.throws(() => decryptBlob(new Uint8Array(32), new Uint8Array(10)), /too short/);
});

test("blobs differ across encrypts (random nonce)", () => {
  const key = new Uint8Array(32).fill(9);
  const data = new TextEncoder().encode("same payload");
  const a = encryptBlob(key, data);
  const b = encryptBlob(key, data);
  assert.notDeepEqual(a, b);
});

test("sha256Hex matches known digest", () => {
  const digest = sha256Hex(new TextEncoder().encode("abc"));
  // SHA-256("abc") well-known value.
  assert.equal(digest, "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
});

test("extension validation", () => {
  assert.ok(isAllowedExtension("photo.jpg"));
  assert.ok(isAllowedExtension("doc.PDF"));
  assert.ok(!isAllowedExtension("evil.exe"));
  assert.ok(!isAllowedExtension("noext"));

  assert.equal(validateAttachment(new Uint8Array(10), "a.jpg"), null);
  assert.match(validateAttachment(new Uint8Array(10), "a.exe") ?? "", /extension/);
  assert.match(
    validateAttachment(new Uint8Array(MAX_ATTACHMENT_BYTES + 1), "a.jpg") ?? "",
    /exceeds/,
  );
});

test("upload auth event structure", () => {
  const trade = deriveTradeKeys(MNEMONIC, 1);
  const blob = new TextEncoder().encode("file-content");
  const { event } = buildUploadAuthEvent({
    tradeSecretHex: trade.secret,
    blob,
    filename: "doc.pdf",
    mimeType: "application/pdf",
  });
  assert.equal(event.kind, 24242);
  const x = event.tags.find((t) => t[0] === "x")?.[1];
  assert.equal(x, sha256Hex(blob));
  assert.equal(event.tags.find((t) => t[0] === "size")?.[1], String(blob.length));

  const signed = signAuthEvent(event, trade.secret);
  assert.equal(signed.pubkey, trade.pubkey);
});
test("parseChatAttachment reads the mostro mobile schema", () => {
  const json = JSON.stringify({
    type: "image_encrypted",
    blossom_url: "https://blossom.primal.net/abc",
    nonce: "00112233445566778899aabb",
    filename: "pic.png",
    mime_type: "image/png",
    original_size: 1234,
    encrypted_size: 1262,
  });
  const att = parseChatAttachment(json);
  assert.equal(att?.type, "image_encrypted");
  assert.equal(att?.filename, "pic.png");
  assert.equal(att?.blossom_url, "https://blossom.primal.net/abc");
  assert.equal(parseChatAttachment("just text"), null);
  assert.equal(parseChatAttachment('{"type":"other"}'), null);
});

test("attachment encrypt/decrypt via the order chat shared key", () => {
  const a = deriveTradeKeys(MNEMONIC, 1);
  const b = deriveTradeKeys(MNEMONIC, 2);
  const sharedA = generateSharedKey(a.secret, b.pubkey);
  const sharedB = generateSharedKey(b.secret, a.pubkey);
  assert.equal(Buffer.from(sharedA).toString("hex"), Buffer.from(sharedB).toString("hex"));

  const data = new TextEncoder().encode("secret file bytes");
  const blob = encryptBlob(sharedA, data);
  const json = JSON.stringify({
    type: "file_encrypted",
    blossom_url: "https://example.com/x",
    nonce: Buffer.from(blob.subarray(0, 12)).toString("hex"),
    filename: "doc.pdf",
  });
  const att = parseChatAttachment(json)!;
  assert.equal(att.filename, "doc.pdf");
  const decrypted = decryptBlob(sharedB, blob);
  assert.equal(new TextDecoder().decode(decrypted), "secret file bytes");
});
