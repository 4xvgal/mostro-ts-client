// Shared constants ported from mostro-core prelude.rs.
// Source: mostro-core 0.14.3 `src/prelude.rs`.

/** Maximum rating value a user can receive. */
export const MAX_RATING = 5;
/** Minimum rating value a user can receive. */
export const MIN_RATING = 1;

/** Nostr event kind used by Mostro to publish orders (NIP-33 addressable). */
export const NOSTR_ORDER_EVENT_KIND = 38383;
/** Nostr event kind used to publish user ratings. */
export const NOSTR_RATING_EVENT_KIND = 38384;
/** Nostr event kind used to publish node information events. */
export const NOSTR_INFO_EVENT_KIND = 38385;
/** Nostr event kind used to publish disputes. */
export const NOSTR_DISPUTE_EVENT_KIND = 38386;

/**
 * Current Mostro protocol version. Embedded in every outgoing MessageKind.
 * Version 2 introduces the NIP-44 direct transport (kind 14).
 */
export const PROTOCOL_VER = 2;