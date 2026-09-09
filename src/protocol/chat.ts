// Mostro P2P chat envelope (kind 14 signed by K_sign, NIP-44 self-encrypted
// under K_conv). Ported from mostro-core 0.14.3 `src/chat/wrap.rs` +
// `src/chat/unwrap.rs`.

import { sha256 } from "@noble/hashes/sha2.js";
import { schnorr } from "@noble/curves/secp256k1.js";
import { hex } from "@scure/base";
import { encrypt as nip44Encrypt, decrypt as nip44Decrypt, v2 as nip44V2 } from "nostr-tools/nip44";
import { finalizeEvent } from "nostr-tools/pure";
import type { NostrEvent, EventTemplate } from "nostr-tools/core";
import { utf8Encoder } from "nostr-tools/utils";

/** Tolerance for clock skew between inner/outer timestamps (spec default 60s). */
export const CHAT_MAX_CLOCK_SKEW_SECS = 60;
/** Upper bound on the encrypted outer content (spec default 64 KiB). */
export const CHAT_MAX_CONTENT_BYTES = 64 * 1024;

export interface ChatMessage {
  /** Plain-text body of the inner kind 1 event. */
  content: string;
  /** Trade (or admin) public key of the sender — from the verified inner event. */
  sender: string;
  /** created_at of the inner kind 1 event. */
  created_at: number;
  /** Verified inner event id — retain durably for replay protection. */
  innerEventId: string;
  /** Outer event id — suitable for a bounded LRU against duplicate deliveries. */
  outerEventId: string;
}

/**
 * Wrap a plain-text chat message into a kind-14 event signed by K_sign.
 * Mirrors `wrap_chat_message`.
 */
export function wrapChatMessage(params: {
  senderTradeSecretHex: string;
  convSecretHex: string;
  convPubkeyHex: string;
  signSecretHex: string;
  message: string;
}): { event: NostrEvent } {
  const { senderTradeSecretHex, convSecretHex, convPubkeyHex, signSecretHex, message } = params;
  const now = Math.floor(Date.now() / 1000);

  // Inner: kind 1 TextNote signed by sender trade key.
  const innerTemplate: EventTemplate = {
    kind: 1,
    created_at: now,
    content: message,
    tags: [],
  };
  const inner = finalizeEvent(innerTemplate, hex.decode(senderTradeSecretHex));

  // NIP-44 self-encryption: K_conv is both sides of the key exchange.
  const convKey = nip44V2.utils.getConversationKey(
    hex.decode(convSecretHex),
    convPubkeyHex,
  );
  const content = nip44Encrypt(JSON.stringify(inner), convKey);

  // Outer: kind 14, p = pub(K_conv), signed by K_sign.
  const outerTemplate: EventTemplate = {
    kind: 14,
    created_at: now,
    content,
    tags: [["p", convPubkeyHex]],
  };
  const outer = finalizeEvent(outerTemplate, hex.decode(signSecretHex));

  return { event: outer };
}

/**
 * Unwrap a kind-14 chat event signed by K_sign. Mirrors
 * `unwrap_chat_message` mandatory checks.
 *
 * @param params.convSecretHex K_conv (decrypt)
 * @param params.signPubkeyHex expected pub(K_sign) outer author
 * @param params.allowedSigners accepted inner pubkeys (buyer+seller trade keys)
 * @param params.outer received kind-14 event
 * @param params.now recipient clock (unix seconds)
 */
export function unwrapChatMessage(params: {
  convSecretHex: string;
  convPubkeyHex: string;
  signPubkeyHex: string;
  allowedSigners: string[];
  outer: { kind: number; pubkey: string; content: string; tags: string[][]; created_at: number };
  now: number;
}): ChatMessage {
  const { convSecretHex, convPubkeyHex, signPubkeyHex, allowedSigners, outer, now } = params;

  // 1. Author + kind.
  if (outer.pubkey !== signPubkeyHex) {
    throw new Error("outer event is not authored by the conversation signing key");
  }
  if (outer.kind !== 14) {
    throw new Error("outer event is not kind 14");
  }

  // 2. Exactly one `p` tag equal to pub(K_conv).
  const pTags = outer.tags.filter((t) => t[0] === "p");
  if (pTags.length !== 1 || pTags[0]![1] !== convPubkeyHex) {
    throw new Error("outer event must carry exactly one p tag for this conversation");
  }

  // 3. Absolute timestamp bound against local clock.
  if (outer.created_at > now + CHAT_MAX_CLOCK_SKEW_SECS) {
    throw new Error("outer event is dated too far in the future");
  }

  // 4. Size before crypto.
  if (utf8Encoder.encode(outer.content).length > CHAT_MAX_CONTENT_BYTES) {
    throw new Error("encrypted payload exceeds the accepted size");
  }

  // 5. Outer signature (verified by relay in nostr-tools; re-checked here is
  //    optional — skip since SimplePool verifies).

  // 6. Decrypt with K_conv self key exchange.
  const convKey = nip44V2.utils.getConversationKey(hex.decode(convSecretHex), convPubkeyHex);
  const decrypted = nip44Decrypt(outer.content, convKey);

  // 7. Inner auth.
  const inner = JSON.parse(decrypted) as NostrEvent;
  if (!allowedSigners.includes(inner.pubkey)) {
    throw new Error("inner event is signed by a key that is not a party to this conversation");
  }
  if (inner.kind !== 1) {
    throw new Error("inner chat event is not a TextNote");
  }

  // 8. Relative timestamp bound.
  const skew = Math.abs(inner.created_at - outer.created_at);
  if (skew > CHAT_MAX_CLOCK_SKEW_SECS) {
    throw new Error("inner and outer timestamps disagree — stale re-wrap");
  }

  // Verify inner signature.
  const innerDigest = eventIdDigest(inner);
  const ok = schnorr.verify(
    hex.decode(inner.sig ?? ""),
    innerDigest,
    hex.decode(inner.pubkey),
  );
  if (!ok) {
    throw new Error("invalid inner chat signature");
  }

  return {
    content: inner.content,
    sender: inner.pubkey,
    created_at: inner.created_at,
    innerEventId: inner.id ?? "",
    outerEventId: computeEventId(outer as unknown as NostrEvent),
  };
}

/** Compute the nostr event id (SHA-256 of the serialized event). */
function eventIdDigest(event: {
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
}): Uint8Array {
  const serialized = JSON.stringify([
    0,
    event.pubkey,
    event.created_at,
    event.kind,
    event.tags,
    event.content,
  ]);
  return sha256(utf8Encoder.encode(serialized));
}

function computeEventId(event: NostrEvent): string {
  return hex.encode(eventIdDigest(event));
}