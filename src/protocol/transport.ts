// Wire transport selection for Mostro protocol messages.
// Ported from mostro-core 0.14.3 `src/transport.rs` (Transport, serde rename).

export const Transport = {
  /** Protocol v1 — NIP-59 GiftWrap (kind 1059). DEPRECATED, being phased out. */
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
      return 1059; // Kind::GiftWrap
    case Transport.Nip44Direct:
      return 14; // Kind::PrivateDirectMessage
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