// Domain-separated chat key derivation (K_conv / K_sign).
// Ported from mostro-core 0.14.3 `src/chat/keys.rs`.

import { sha256 } from "@noble/hashes/sha2.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { hex } from "@scure/base";

/** HKDF info for K_conv. Changing this changes the wire format. */
const CHAT_CONV_INFO = new TextEncoder().encode("mostro:chat:conv:v1");
/** HKDF info for K_sign. Changing this changes the wire format. */
const CHAT_SIGN_INFO = new TextEncoder().encode("mostro:chat:sign:v1");

export interface ChatKeys {
  /** K_conv — NIP-44 encryption + outer `p` tag. */
  convSecretHex: string;
  /** K_conv x-only pubkey. */
  convPubkeyHex: string;
  /** K_sign — signs the outer kind-14 event (author filter). */
  signSecretHex: string;
  /** K_sign x-only pubkey. */
  signPubkeyHex: string;
}

/**
 * Raw x25519-style ECDH shared secret (even-parity assumption, per
 * NIP-04/44). Mirrors mostro-core `generate_shared_key`.
 */
export function generateSharedKey(secretKeyHex: string, publicKeyHex: string): Uint8Array {
  // 0x02 prefix + x-only pubkey → compressed point (even parity).
  const compressed = new Uint8Array(33);
  compressed[0] = 0x02;
  compressed.set(hex.decode(publicKeyHex), 1);

  const point = secp256k1.getSharedSecret(hex.decode(secretKeyHex), compressed);
  // shared_secret_point returns the point; take the x coordinate (first 32 bytes).
  return point.subarray(1, 33);
}

/** Derive (K_conv, K_sign) from an already-computed 32-byte ECDH secret. */
export function deriveChatKeysFromShared(shared: Uint8Array): ChatKeys {
  if (shared.length !== 32) {
    throw new Error(`chat shared secret must be 32 bytes, got ${shared.length}`);
  }

  const derive = (info: Uint8Array): string => {
    // Retry with a counter byte on the negligible chance the output is not a
    // valid secp256k1 secret key (spec requirement).
    for (let counter = 0; counter <= 255; counter++) {
      const labelled = counter === 0 ? info : new Uint8Array([...info, counter]);
      const out = hkdf(sha256, shared, new Uint8Array(0), labelled, 32);
      // Valid secp256k1 scalar? (non-zero, < curve order)
      try {
        const pub = secp256k1.getPublicKey(out, true);
        if (pub.length === 33) {
          return hex.encode(out);
        }
      } catch {
        // invalid scalar, retry with next counter
      }
    }
    throw new Error("HKDF failed to produce a valid secret key");
  };

  const convSecretHex = derive(CHAT_CONV_INFO);
  const signSecretHex = derive(CHAT_SIGN_INFO);
  return {
    convSecretHex,
    convPubkeyHex: xOnlyPubkey(convSecretHex),
    signSecretHex,
    signPubkeyHex: xOnlyPubkey(signSecretHex),
  };
}

/**
 * Derive (K_conv, K_sign) from a party's trade secret and the peer's trade
 * pubkey. Both peers obtain the same pair by swapping arguments.
 */
export function deriveChatKeys(ownTradeSecretHex: string, peerTradePubkeyHex: string): ChatKeys {
  const shared = generateSharedKey(ownTradeSecretHex, peerTradePubkeyHex);
  return deriveChatKeysFromShared(shared);
}

/** x-only pubkey from a secret key hex. */
function xOnlyPubkey(secretHex: string): string {
  const compressed = secp256k1.getPublicKey(hex.decode(secretHex), true);
  return hex.encode(compressed.subarray(1));
}