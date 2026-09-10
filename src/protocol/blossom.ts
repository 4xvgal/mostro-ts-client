// Encrypted file messaging — ChaCha20-Poly1305 blob + Blossom (NIP-24242).
// Ported from mostrix `src/util/blossom.rs` (encrypt_blob / decrypt_blob).
// Blob layout: [nonce:12][ciphertext][auth_tag:16].

import { chacha20poly1305 } from "@noble/ciphers/chacha.js";
import { randomBytes, sha256 } from "./crypto.js";
import { hex } from "@scure/base";
import type { EventTemplate } from "nostr-tools/core";
import { finalizeEvent } from "nostr-tools/pure";
import { assertSafeFetchUrl, fetchWithTimeout } from "./net.js";
import type { UrlPolicy } from "./net.js";

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

/** Default Blossom servers (mostrix `DEFAULT_BLOSSOM_SERVERS`). */
export const DEFAULT_BLOSSOM_SERVERS = [
  "https://blossom.primal.net",
  "https://blossom.band",
  "https://nostr.media",
  "https://blossom.sector01.com",
  "https://24242.io",
  "https://otherstuff.shaving.kiwi",
  "https://blossom.f7z.io",
  "https://nosto.re",
  "https://blossom.poster.place",
] as const;

/** Parsed Mostro Mobile attachment message (`image_encrypted` / `file_encrypted`). */
export interface ChatAttachment {
  type: "image_encrypted" | "file_encrypted";
  blossom_url: string;
  filename: string;
  mime_type: string | null;
  nonce: string | null;
  original_size: number | null;
  encrypted_size: number | null;
}

/** Parse a chat message body as an attachment JSON; null when it is plain text. */
export function parseChatAttachment(content: string): ChatAttachment | null {
  const trimmed = content.trim();
  if (!trimmed.startsWith("{")) return null;
  try {
    const obj = JSON.parse(trimmed) as Record<string, unknown>;
    if (obj.type !== "image_encrypted" && obj.type !== "file_encrypted") return null;
    const url = typeof obj.blossom_url === "string" ? obj.blossom_url.trim() : "";
    if (!url) return null;
    return {
      type: obj.type,
      blossom_url: url,
      filename: typeof obj.filename === "string" ? obj.filename : "attachment",
      mime_type: typeof obj.mime_type === "string" ? obj.mime_type : null,
      nonce: typeof obj.nonce === "string" ? obj.nonce : null,
      original_size: typeof obj.original_size === "number" ? obj.original_size : null,
      encrypted_size: typeof obj.encrypted_size === "number" ? obj.encrypted_size : null,
    };
  } catch {
    return null;
  }
}

/** Upload an encrypted blob to a Blossom server; returns `{base}/{sha256}`. */
export async function uploadBlob(params: {
  servers: readonly string[];
  blob: Uint8Array;
  tradeSecretHex: string;
  filename: string;
  mimeType: string;
  /** Scheme/host policy for outbound requests (default: https only, no private hosts). */
  policy?: UrlPolicy;
}): Promise<string> {
  const { servers, blob, tradeSecretHex, filename, mimeType } = params;
  const policy = params.policy ?? {};
  const hash = sha256Hex(blob);
  const signed = signAuthEvent(
    buildUploadAuthEvent({ tradeSecretHex, blob, filename, mimeType }).event,
    tradeSecretHex,
  );
  const auth = `Nostr ${btoa(JSON.stringify(signed))}`;
  let lastErr: Error | null = null;
  for (const raw of servers) {
    const base = raw.trim().replace(/\/+$/, "");
    if (!base) continue;
    try {
      assertSafeFetchUrl(`${base}/upload`, policy);
      const res = await fetchWithTimeout(`${base}/upload`, {
        method: "PUT",
        headers: {
          Authorization: auth,
          "Content-Type": "application/octet-stream",
          "User-Agent": "mostro-ts-client",
        },
        body: blob as unknown as BodyInit,
      });
      if (!res.ok) {
        lastErr = new Error(`Blossom upload returned ${res.status}`);
        continue;
      }
      return `${base}/${hash}`;
    } catch (e) {
      lastErr = e as Error;
    }
  }
  throw lastErr ?? new Error("no Blossom server accepted the upload");
}

export interface DownloadBlobOptions {
  /** Reject larger payloads before reading the body into memory. Default 25 MB. */
  maxBytes?: number;
  /** Abort the request after this many ms. Default 15s. */
  timeoutMs?: number;
  /** Allowlist of Blossom host names (e.g. DEFAULT_BLOSSOM_SERVERS). */
  allowedHosts?: readonly string[];
  /** Scheme/host policy passed through to assertSafeFetchUrl. */
  policy?: UrlPolicy;
}

/**
 * Download a blob from a URL. Attachment URLs are counterparty-controlled, so
 * this enforces https, blocks private hosts, an optional host allowlist, a size
 * cap and a timeout.
 */
export async function downloadBlob(url: string, opts: DownloadBlobOptions = {}): Promise<Uint8Array> {
  const maxBytes = opts.maxBytes ?? MAX_ATTACHMENT_BYTES;
  const parsed = assertSafeFetchUrl(url, opts.policy ?? {});
  if (opts.allowedHosts && opts.allowedHosts.length > 0) {
    const host = parsed.hostname.toLowerCase();
    const allowed = opts.allowedHosts.some((h) => {
      try {
        return new URL(h).hostname.toLowerCase() === host;
      } catch {
        return h.toLowerCase() === host;
      }
    });
    if (!allowed) {
      throw new Error(`blob host not in allowlist: ${parsed.hostname}`);
    }
  }
  const res = await fetchWithTimeout(parsed.toString(), {}, opts.timeoutMs ?? 15_000);
  if (!res.ok) {
    throw new Error(`Blossom download returned ${res.status}`);
  }
  const declared = Number(res.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new Error(`blob exceeds ${maxBytes} bytes (content-length ${declared})`);
  }
  const buf = new Uint8Array(await res.arrayBuffer());
  if (buf.length > maxBytes) {
    throw new Error(`blob exceeds ${maxBytes} bytes`);
  }
  return buf;
}

export { randomBytes, sha256, hex };