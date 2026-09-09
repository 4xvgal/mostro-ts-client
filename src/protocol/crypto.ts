// Cross-platform crypto helpers (Node + browser).
//
// Node 26 has globalThis.crypto (WebCrypto). WebCrypto's getRandomValues
// covers randomBytes; digest via crypto.subtle is async — so sha256 here
// uses @noble/hashes (sync, same API everywhere).

import { sha256 as nobleSha256 } from "@noble/hashes/sha2.js";

/** CSPRNG bytes (12/32-byte nonces, keys). Browser + Node via globalThis.crypto. */
export function randomBytes(length: number): Uint8Array {
  const g = globalThis.crypto;
  if (!g?.getRandomValues) {
    throw new Error("crypto.getRandomValues unavailable");
  }
  const out = new Uint8Array(length);
  g.getRandomValues(out);
  return out;
}

/** SHA-256. Sync (via @noble/hashes) so it works in both environments. */
export function sha256(data: Uint8Array): Uint8Array {
  return nobleSha256(data);
}