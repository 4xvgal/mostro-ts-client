// First-seen uniqueness for (identity_pubkey, nonce) — spec §12.
// Same-instance copy defence: the pm token binds identity+params but not the
// server-generated order_id, so a copied token verifies by Schnorr on both
// orders. The order that saw the pair first wins; the later one is rejected.
//
// Ceiling (spec §15/§16): relies on the earliest revision's created_at. NIP-33
// replacement can erase older revisions — measured on nostr-rs-relay
// (probe-revisions.ts): only the max-created_at revision survives, and an older
// revision published later is rejected. So a snapshot cannot recover an order's
// birth time; first-seen must be observed live (subscribe) and cached locally.
// Upgrade path: hard-bind order_id in mostrod.

import { hex } from "@scure/base";

export type SeenVerdict = "valid" | "invalid";

export class FirstSeenTracker {
  /** order_id -> earliest created_at seen (event timestamp bumps per revision). */
  private birth = new Map<string, number>();
  /** (identity, nonce) -> first order that claimed it. */
  private first = new Map<string, { orderId: string; ts: number }>();

  check(
    identityPubkeyHex: string,
    nonce: Uint8Array,
    orderId: string,
    eventCreatedAt: number,
  ): SeenVerdict {    const ts = Math.min(this.birth.get(orderId) ?? Number.POSITIVE_INFINITY, eventCreatedAt);
    this.birth.set(orderId, ts);

    const key = `${identityPubkeyHex}\n${hex.encode(nonce)}`;
    const prev = this.first.get(key);
    if (!prev) {
      this.first.set(key, { orderId, ts });
      return "valid";
    }
    if (prev.orderId === orderId) return "valid";
    if (ts > prev.ts) return "invalid";
    // A genuinely earlier order surfaced: adopt it and honour it.
    this.first.set(key, { orderId, ts });
    return "valid";
  }

  /** Serializable state for a TrustGraphStore (first-seen ledger only). */
  exportState(): Record<string, { orderId: string; ts: number }> {
    return Object.fromEntries(this.first);
  }

  importState(state: Record<string, { orderId: string; ts: number }>): void {
    for (const [key, value] of Object.entries(state)) this.first.set(key, value);
  }

  /** Record when an order was first observed (local clock). */
  noteOrder(orderId: string, observedAt: number): void {
    const prev = this.birth.get(orderId);
    if (prev === undefined || observedAt < prev) this.birth.set(orderId, observedAt);
  }

  /** Earliest local observation time for an order, if known. */
  birthOf(orderId: string): number | undefined {
    return this.birth.get(orderId);
  }
}
