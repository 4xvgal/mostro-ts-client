// Encrypted file messaging — ChaCha20-Poly1305 blob + Blossom (NIP-24242).
// Ported from mostrix `src/util/blossom.rs` (encrypt_blob / decrypt_blob).
// Blob layout: [nonce:12][ciphertext][auth_tag:16].

import { chacha20poly1305 } from "@noble/ciphers/chacha.js";
import { randomBytes, sha256 } from "./crypto.js";
import { hex } from "@scure/base";
import type { EventTemplate } from "nostr-tools/core";
import { finalizeEvent } from "nostr-tools/pure";

const NONCE_LEN = 12;
const TAG_LEN = 16;
/** Max upload size (mostrix validate_attachment_file: 25 MB). */
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
/** Allowed file extensions (mostrix). */
export const ALLOWED_ATTACHMENT_EXTENSIONS = [
  "jpg",
  "jpeg",
  "png",
  "pdf",
  "mp4",
  "mov",
  "avi",
  "doc",
  "docx",
] as const;

/** Encrypt plaintext: [nonce:12][ciphertext][tag:16]. Key must be 32 bytes. */
export function encryptBlob(key: Uint8Array, plaintext: Uint8Array): Uint8Array {
  if (key.length !== 32) {
    throw new Error(`encryption key must be 32 bytes, got ${key.length}`);
  }
  const nonce = randomBytes(NONCE_LEN);
  const cipher = chacha20poly1305(key, nonce);
  const ciphertext = cipher.encrypt(plaintext);
  const blob = new Uint8Array(nonce.length + ciphertext.length);
  blob.set(nonce, 0);
  blob.set(ciphertext, nonce.length);
  return blob;
}

/**
 * Decrypt a blob. `key` must be 32 bytes; the nonce is read from the first 12
 * bytes. Throws when the blob is too short or the tag fails.
 */
export function decryptBlob(key: Uint8Array, blob: Uint8Array): Uint8Array {
  if (key.length !== 32) {
    throw new Error(`decryption key must be 32 bytes, got ${key.length}`);
  }
  if (blob.length < NONCE_LEN + TAG_LEN) {
    throw new Error(
      `blob too short for nonce+tag (need at least ${NONCE_LEN + TAG_LEN} bytes, got ${blob.length})`,
    );
  }
  const nonce = blob.subarray(0, NONCE_LEN);
  const ciphertext = blob.subarray(NONCE_LEN);
  const cipher = chacha20poly1305(key, nonce);
  return cipher.decrypt(ciphertext);
}

/** SHA-256 hex digest of data (Blossom `x` tag). */
export function sha256Hex(data: Uint8Array): string {
  return hex.encode(sha256(data));
}

/** Extension check against the allowed set (case-insensitive). */
export function isAllowedExtension(filename: string): boolean {
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  return (ALLOWED_ATTACHMENT_EXTENSIONS as readonly string[]).includes(ext);
}

/** Basic validation: size + extension. Returns error string or null when ok. */
export function validateAttachment(data: Uint8Array, filename: string): string | null {
  if (data.length > MAX_ATTACHMENT_BYTES) {
    return `file exceeds ${MAX_ATTACHMENT_BYTES} bytes`;
  }
  if (!isAllowedExtension(filename)) {
    return `extension not allowed: ${filename}`;
  }
  return null;
}

/**
 * Build the Blossom upload auth event (kind 24242, NIP-24242) signed with the
 * order trade key (same pubkey as the chat kind-14 inner signer).
 *
 * Blossom expects a "register" auth event describing the upload (sha256 hash,
 * size, type) so it can authorize the subsequent PUT.
 */
export function buildUploadAuthEvent(params: {
  tradeSecretHex: string;
  blob: Uint8Array;
  filename: string;
  mimeType: string;
}): { event: EventTemplate } {
  const { tradeSecretHex, blob, filename, mimeType } = params;
  const digest = sha256Hex(blob);
  const template: EventTemplate = {
    kind: 24242,
    created_at: Math.floor(Date.now() / 1000),
    content: "",
    tags: [
      ["t", "upload"],
      ["x", digest],
      ["size", String(blob.length)],
      ["type", mimeType],
      ["expiration", String(Math.floor(Date.now() / 1000) + 60)],
      ["description", filename],
    ],
  };
  return { event: template };
}

/** Sign an auth event template with the trade key. */
export function signAuthEvent(template: EventTemplate, tradeSecretHex: string) {
  return finalizeEvent(template, hex.decode(tradeSecretHex));
}

export { randomBytes, sha256, hex };