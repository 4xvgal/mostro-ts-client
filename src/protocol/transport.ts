// Protocol-v2 NIP-44 direct transport (kind 14).
// Ported from mostro-core 0.14.3 `src/transport.rs` (wrap_message_nip44 /
// unwrap_message_nip44) and `src/message.rs` (Message::sign /
// verify_signature).
//
// Wire content is the NIP-44 encryption of a 3-element JSON tuple:
//   [Message, trade_sig | null, [identity_pubkey, identity_sig] | null]
// The event is signed by the per-trade key. `trade_sig` binds the message
// JSON to the trade key; `identity_sig` proves identity key possession via a
// domain-tagged payload that includes the trade pubkey.

import { schnorr } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { hex } from "@scure/base";
import { verifyEvent } from "nostr-tools/pure";
import type { NostrEvent } from "nostr-tools/core";
import { v2 as nip44V2, encrypt as nip44Encrypt, decrypt as nip44Decrypt } from "nostr-tools/nip44";
import { utf8Encoder, utf8Decoder } from "nostr-tools/utils";
import { serializeMessage, messageToJson } from "./wire.js";
import { messageFromJson } from "./wire.js";
import type { Message } from "./message.js";
import { identityProofPayload } from "./proof.js";

// Transport selection re-exported here (kept in this file so index.ts has a
// single source). Ported from mostro-core `src/transport.rs`.

export const Transport = {
  /** Protocol v1 — NIP-59 GiftWrap (kind 1059). DEPRECATED. */
  GiftWrap: "gift-wrap",
  /** Protocol v2 — NIP-44 direct message (kind 14). */
  Nip44Direct: "nip44",
} as const;

export type Transport = (typeof Transport)[keyof typeof Transport];

export function transportFromString(s: string): Transport | null {
  switch (s) {
    case Transport.GiftWrap:
      return Transport.GiftWrap;
    case Transport.Nip44Direct:
      return Transport.Nip44Direct;
    default:
      return null;
  }
}

export function transportToString(t: Transport): string {
  return t;
}

/** The Nostr event kind this transport publishes and subscribes to. */
export function transportEventKind(t: Transport): number {
  switch (t) {
    case Transport.GiftWrap:
      return 1059;
    case Transport.Nip44Direct:
      return 14;
  }
}

/** The Mostro protocol version this transport carries. */
export function transportProtocolVersion(t: Transport): number {
  switch (t) {
    case Transport.GiftWrap:
      return 1;
    case Transport.Nip44Direct:
      return 2;
  }
}

// ---------------------------------------------------------------------------
// Message signing (mostro-core Message::sign / verify_signature)
// ---------------------------------------------------------------------------

/** SHA-256 digest of `message` (bytes), as used by Message::sign. */
export function messageDigest(messageJson: string): Uint8Array {
  return sha256(utf8Encoder.encode(messageJson));
}

/**
 * Schnorr signature over the SHA-256 digest of the message JSON using the
 * trade key. Mirrors `Message::sign(message, keys)`.
 */
export function signMessage(messageJson: string, secretKeyHex: string): string {
  const digest = messageDigest(messageJson);
  const sig = schnorr.sign(digest, hex.decode(secretKeyHex));
  return hex.encode(sig);
}

/**
 * Verify a Schnorr signature produced by signMessage. Mirrors
 * `Message::verify_signature`.
 */
export function verifyMessageSignature(
  messageJson: string,
  pubkeyHex: string,
  sigHex: string,
): boolean {
  const digest = messageDigest(messageJson);
  try {
    return schnorr.verify(hex.decode(sigHex), digest, hex.decode(pubkeyHex));
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Wrap (outbound) — mostro-core wrap_message_nip44
// ---------------------------------------------------------------------------

export interface WrapOptions {
  /** NIP-13 proof-of-work difficulty (leading zero bits). 0 = off. */
  pow?: number;
  /** NIP-40 expiration timestamp (unix seconds). */
  expiration?: number;
  /** Emit an inner trade signature (`trade_sig` tuple element). */
  signed?: boolean;
}

export interface WrapResult {
  /** kind-14 event to publish. */
  event: {
    kind: 14;
    pubkey: string;
    created_at: number;
    content: string;
    tags: string[][];
    id?: string;
    sig?: string;
  };
}

/**
 * Build the plaintext 3-element tuple `[Message, trade_sig, identity_proof]`
 * then NIP-44 encrypt it, producing a signed kind-14 event.
 *
 * Mirrors `wrap_message_nip44`: identity proof included only when the
 * identity key differs from the trade key (reputation mode).
 */
export function wrapMessageNip44(params: {
  message: Message;
  identitySecretHex: string;
  tradeSecretHex: string;
  receiverPubkeyHex: string;
  opts?: WrapOptions;
}): { content: string; messageJson: string } {
  const { message, identitySecretHex, tradeSecretHex, receiverPubkeyHex } = params;
  const opts = params.opts ?? {};

  const messageJson = serializeMessage(message);

  const tradePubkey = pubkeyFromSecret(tradeSecretHex);
  const identityPubkey = pubkeyFromSecret(identitySecretHex);

  const tradeSig = opts.signed === false ? null : signMessage(messageJson, tradeSecretHex);

  const identityProof: [string, string] | null =
    identityPubkey !== tradePubkey
      ? [
          identityPubkey,
          signMessage(identityProofPayload(tradePubkey, messageJson), identitySecretHex),
        ]
      : null;

  const tuple: [Record<string, unknown>, string | null, [string, string] | null] = [
    messageToJson(message),
    tradeSig,
    identityProof,
  ];
  const content = JSON.stringify(tuple);

  // NIP-44 conversation key: trade secret (bytes) + receiver pubkey (hex string).
  const conversationKey = nip44V2.utils.getConversationKey(
    hex.decode(tradeSecretHex),
    receiverPubkeyHex,
  );
  const encrypted = nip44Encrypt(content, conversationKey);

  return { content: encrypted, messageJson };
}

// ---------------------------------------------------------------------------
// Unwrap (inbound) — mostro-core unwrap_message_nip44
// ---------------------------------------------------------------------------

export interface UnwrappedMessage {
  message: Message;
  /** trade_sig if present and verified, hex. */
  signature: string | null;
  /** Event author (trade key), hex. */
  sender: string;
  /** Proven identity pubkey, or sender when full-privacy mode, hex. */
  identity: string;
  created_at: number;
}

/**
 * Try to open an incoming kind-14 event with the receiver's trade secret.
 *
 * Returns null when the content could not be decrypted ("not addressed to
 * me"). Throws on invalid event signature, malformed tuple, or non-verifying
 * inner signatures. Mirrors `unwrap_message_nip44`.
 */
export function unwrapMessageNip44(params: {
  event: {
    kind: number;
    pubkey: string;
    content: string;
  };
  receiverSecretHex: string;
  /** Protocol paths set this: reject messages with no inner trade signature. */
  requireSignature?: boolean;
}): UnwrappedMessage | null {
  const { event, receiverSecretHex } = params;

  if (event.kind !== 14) {
    throw new Error("event is not a direct message");
  }

  // Event signature = trade-key authorship proof (verified by relay in
  // nostr-tools; here we only decrypt and check inner signatures).

  // Decrypt with (receiver_secret, event.pubkey). Failure = not addressed to me.
  const conversationKey = nip44V2.utils.getConversationKey(
    hex.decode(receiverSecretHex),
    event.pubkey,
  );
  let plaintext: string;
  try {
    plaintext = nip44Decrypt(event.content, conversationKey);
  } catch {
    return null;
  }

  const tuple: [Message, string | null, [string, string] | null] = JSON.parse(plaintext);
  if (!Array.isArray(tuple) || tuple.length !== 3) {
    throw new Error("malformed direct-message tuple");
  }
  const [messageObj, tradeSig, identityProof] = tuple;

  // The wire form of the message (for signature binding and identity proof)
  // must be byte-identical to what the sender signed.
  const messageJson = JSON.stringify(messageObj);

  if (params.requireSignature && typeof tradeSig !== "string") {
    throw new Error("missing required trade signature");
  }
  let signature: string | null = null;
  if (typeof tradeSig === "string") {
    if (!verifyMessageSignature(messageJson, event.pubkey, tradeSig)) {
      throw new Error("trade signature does not verify against event author");
    }
    signature = tradeSig;
  }

  let identity = event.pubkey;
  if (Array.isArray(identityProof)) {
    const [identityPubkey, identitySig] = identityProof;
    const payload = identityProofPayload(event.pubkey, messageJson);
    if (!verifyMessageSignature(payload, identityPubkey, identitySig)) {
      throw new Error("identity signature does not verify against identity pubkey");
    }
    identity = identityPubkey;
  }

  return {
    message: messageFromJson(messageObj),
    signature,
    sender: event.pubkey,
    identity,
    created_at: 0,
  };
}

/** Derive x-only pubkey (hex) from a secret key hex. */
export function pubkeyFromSecret(secretHex: string): string {
  const pub = schnorr.getPublicKey(hex.decode(secretHex));
  return hex.encode(pub);
}

/**
 * Verify the outer Nostr event signature (id + schnorr sig). Callers receiving
 * events from relays must run this before trusting `event.pubkey`; a relay or
 * WebSocket peer can hand the client arbitrary unsigned/forged events.
 * Returns false on any malformed input instead of throwing.
 */
export function verifyEventSignature(event: {
  id?: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig?: string;
}): boolean {
  const { id, sig } = event;
  if (!id || !sig) {
    return false;
  }
  try {
    return verifyEvent(event as NostrEvent);
  } catch {
    return false;
  }
}

export { utf8Encoder, utf8Decoder };