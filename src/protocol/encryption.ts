// Field-level encryption for sensitive Store columns.
// Argon2id(passphrase) → XChaCha20-Poly1305(AES-GCM-compatible TK).
// Envelope: MAGIC | salt(16) | nonce(12) | ciphertext | tag(16).
// Derive once at first access, cache until close().

import { argon2id } from "hash-wasm";
import { chacha20poly1305 } from "@noble/ciphers/chacha.js";
import { hex } from "@scure/base";
import { utf8Encoder, utf8Decoder } from "nostr-tools/utils";
import { randomBytes } from "./crypto.js";

/** Optional passphrase wrapper: null stays null. */
export function encryptStringOrNull(
  enc: FieldEncryptor | undefined,
  value: string | null,
): Promise<string | null> {
  if (value === null || value === "") {
    return Promise.resolve(value);
  }
  return enc ? enc.encryptUtf8(value) : Promise.resolve(value);
}

/** Optional passphrase unwrapper: decrypts only when clearly encrypted. Otherwise pass-through. */
export function decryptStringOrNull(
  enc: FieldEncryptor | undefined,
  value: string | null,
): Promise<string | null> {
  if (value === null || value === "") {
    return Promise.resolve(value);
  }
  if (enc && isEncryptedFormat(value)) {
    return enc.decryptToUtf8(value);
  }
  return Promise.resolve(value);
}

/** Mandatory wrap/unwrap for non-null strings. */
export function encryptString(enc: FieldEncryptor | undefined, value: string): Promise<string> {
  return enc ? enc.encryptUtf8(value) : Promise.resolve(value);
}

export function decryptString(enc: FieldEncryptor | undefined, value: string): Promise<string> {
  if (enc && isEncryptedFormat(value)) {
    return enc.decryptToUtf8(value);
  }
  return Promise.resolve(value);
}

const MAGIC = new Uint8Array([0x76, 0x31]); // "v1" — passphrase (Argon2id) envelope
const RAW_MAGIC = new Uint8Array([0x62, 0x31]); // "b1" — caller-injected raw key envelope
const SALT_LEN = 16;
const NONCE_LEN = 12;

// RFC 9106 second recommendation — browser-safe memory; WASM single-thread.
const ARGON2 = {
  iterations: 3,
  parallelism: 1,
  memorySize: 32 * 1024, // KiB
  hashLength: 32,
} as const;

/** Encrypt/decrypt sensitive UTF-8 column values. */
export interface FieldEncryptor {
  encryptUtf8(plain: string): Promise<string>;
  decryptToUtf8(data: string): Promise<string>;
  close(): void;
}

/** Create a lazy encryptor: derives the key on first use. */
export function lazyPassphraseEncryptor(passphrase: string): FieldEncryptor {
  let cached: { salt: Uint8Array; key: Uint8Array } | null = null;

  const keyFor = async (envelopeSalt: Uint8Array | null): Promise<Uint8Array> => {
    if (envelopeSalt === null) {
      if (!cached) {
        const salt = randomBytes(SALT_LEN);
        const key = new Uint8Array(await argon2id({ password: passphrase, salt, ...ARGON2, outputType: "binary" }));
        cached = { salt, key };
      }
      return cached.key;
    }
    if (cached && sameBytes(cached.salt, envelopeSalt)) {
      return cached.key;
    }
    const key = new Uint8Array(await argon2id({ password: passphrase, salt: envelopeSalt, ...ARGON2, outputType: "binary" }));
    cached = { salt: envelopeSalt, key };
    return key;
  };

  const encryptUtf8 = async (plain: string): Promise<string> => {
    const { salt, key } = await ensureCache();
    const nonce = randomBytes(NONCE_LEN);
    const ct = chacha20poly1305(key, nonce).encrypt(utf8Encoder.encode(plain));
    return pack(salt, nonce, ct);
  };

  const decryptToUtf8 = async (data: string): Promise<string> => {
    const [salt, nonce, ct] = unpack(data);
    const key = await keyFor(salt);
    return utf8Decoder.decode(chacha20poly1305(key, nonce).decrypt(ct));
  };

  const ensureCache = async (): Promise<{ salt: Uint8Array; key: Uint8Array }> => {
    await keyFor(null);
    return cached!;
  };

  return {
    encryptUtf8,
    decryptToUtf8,
    close: () => {
      cached?.key.fill(0);
      cached = null;
    },
  };
}

/**
 * Caller-injected 32-byte key encryptor. Skips Argon2 — use when the wallet
 * owns the (derived) storage key and only hands it to this library.
 * `key` is copied internally; `close()` zeroes the copy, never the caller's buffer.
 */
export function rawKeyEncryptor(key: Uint8Array): FieldEncryptor {
  if (key.length !== 32) {
    throw new Error(`raw key must be 32 bytes, got ${key.length}`);
  }
  const local = key.slice();
  return {
    async encryptUtf8(plain: string): Promise<string> {
      const nonce = randomBytes(NONCE_LEN);
      const ct = chacha20poly1305(local, nonce).encrypt(utf8Encoder.encode(plain));
      return "b1x" + toHex(concat(RAW_MAGIC, nonce, ct));
    },
    async decryptToUtf8(data: string): Promise<string> {
      const [nonce, ct] = unpackRaw(data);
      return utf8Decoder.decode(chacha20poly1305(local, nonce).decrypt(ct));
    },
    close(): void {
      local.fill(0);
    },
  };
}

/** Sentinel prefix for encrypted payloads (passphrase or raw-key envelope). */
export function isEncryptedFormat(value: string | null | undefined): boolean {
  return typeof value === "string" && (value.startsWith("v1x") || value.startsWith("b1x"));
}

function pack(salt: Uint8Array, nonce: Uint8Array, ct: Uint8Array): string {
  return "v1x" + toHex(concat(MAGIC, salt, nonce, ct));
}

function unpack(data: string): [Uint8Array, Uint8Array, Uint8Array] {
  if (!data.startsWith("v1x")) {
    throw new Error("not a passphrase-envelope column value");
  }
  const bytes = fromHex(data.slice(3));
  if (bytes.length < MAGIC.length + SALT_LEN + NONCE_LEN + 1 + 16) {
    throw new Error("encrypted column too short");
  }
  assertMagic(bytes, MAGIC);
  const salt = bytes.subarray(MAGIC.length, MAGIC.length + SALT_LEN);
  const nonce = bytes.subarray(MAGIC.length + SALT_LEN, MAGIC.length + SALT_LEN + NONCE_LEN);
  const ct = bytes.subarray(MAGIC.length + SALT_LEN + NONCE_LEN);
  return [salt, nonce, ct];
}

function unpackRaw(data: string): [Uint8Array, Uint8Array] {
  if (!data.startsWith("b1x")) {
    throw new Error("not a raw-key-envelope column value");
  }
  const bytes = fromHex(data.slice(3));
  if (bytes.length < RAW_MAGIC.length + NONCE_LEN + 1 + 16) {
    throw new Error("encrypted column too short");
  }
  assertMagic(bytes, RAW_MAGIC);
  const nonce = bytes.subarray(RAW_MAGIC.length, RAW_MAGIC.length + NONCE_LEN);
  const ct = bytes.subarray(RAW_MAGIC.length + NONCE_LEN);
  return [nonce, ct];
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

function toHex(bytes: Uint8Array): string {
  return hex.encode(bytes);
}

function fromHex(raw: string): Uint8Array {
  try {
    return hex.decode(raw);
  } catch {
    throw new Error("malformed encrypted column value");
  }
}

function assertMagic(bytes: Uint8Array, magic: Uint8Array): void {
  if (bytes[0] !== magic[0] || bytes[1] !== magic[1]) {
    throw new Error("bad magic on encrypted column");
  }
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) {
      return false;
    }
  }
  return true;
}
