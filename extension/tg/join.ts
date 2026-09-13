// Viewer join layer: order book + identity index + trust graph -> annotated
// orders. Returns RAW signals so the UI can interpret/render freely; the badge
// on each item is only a reference default.
//
// Pure and order-agnostic: the graph never owns orders.

import type { NostrEvent } from "nostr-tools/core";
import type { SmallOrder } from "../../src/protocol/index.js";
import { verifyOrderBindingFromOrder, type OrderBindingResult, type TrustBadge, type TrustState } from "./api.js";
import { SOCIAL_INDEX_KIND } from "./social.js";
import type { TelemetrySink } from "./telemetry.js";


/** Minimal graph surface the join needs (TrustGraph satisfies it structurally). */
export interface TrustScorer {
  score(identity: string): number | undefined;
  percentile(identity: string): number | undefined;
}

export interface IdentityClaim {
  identity: string;
  mostroPubkey?: string;
  relay?: string;
  source: "social-index" | "dm";
}

/**
 * order_id -> claimed identity. Claims are HINTS: `annotateOrders` still
 * verifies each candidate against the order's pm binding token.
 */
export class IdentityIndex {
  private byOrder = new Map<string, IdentityClaim[]>();
  private seen = new Set<string>();

  addClaim(orderId: string, claim: IdentityClaim): void {
    const key = `${orderId}\n${claim.identity}`;
    if (this.seen.has(key)) return;
    this.seen.add(key);
    const list = this.byOrder.get(orderId) ?? [];
    list.push(claim);
    this.byOrder.set(orderId, list);
  }

  /** Parse a kind-30501 social index; returns the number of claims added. */
  addSocialIndex(event: Pick<NostrEvent, "kind" | "pubkey" | "content">): number {
    if (event.kind !== SOCIAL_INDEX_KIND) return 0;
    let entries: unknown;
    try {
      entries = JSON.parse(event.content);
    } catch {
      return 0;
    }
    if (!Array.isArray(entries)) return 0;
    let added = 0;
    for (const e of entries) {
      if (!e || typeof e !== "object") continue;
      const rec = e as Record<string, unknown>;
      if (typeof rec.order_id !== "string" || rec.order_id === "") continue;
      this.addClaim(rec.order_id, {
        identity: event.pubkey,
        mostroPubkey: typeof rec.mostro_pubkey === "string" ? rec.mostro_pubkey : undefined,
        relay: typeof rec.relay === "string" ? rec.relay : undefined,
        source: "social-index",
      });
      added++;
    }
    return added;
  }

  addDmPayload(p: { order_id: string; identity_pubkey: string; mostro_pubkey?: string; relay?: string }): void {
    this.addClaim(p.order_id, {
      identity: p.identity_pubkey,
      mostroPubkey: p.mostro_pubkey,
      relay: p.relay,
      source: "dm",
    });
  }

  candidates(orderId: string): IdentityClaim[] {
    return this.byOrder.get(orderId) ?? [];
  }
}

export interface TrustSignals {
  /** pm binding token verified against a claimed identity. */
  verified: boolean;
  /** PPR score (root-relative), null if not verified or unreachable. */
  score: number | null;
  /** Percentile of the score within the graph, null if unavailable. */
  percentile: number | null;
  /** Mostro rating count (total_reviews) from the order. */
  ratingCount: number;
  /** Raw reasons: no-identity | unverified | rating-0 | ppr-high | farm-suspect. */
  flags: string[];
}

export interface AnnotatedOrder {
  order: SmallOrder;
  /** Verified identity, or null. */
  identity: string | null;
  /** Last binding-verify result (null when there was no candidate). */
  binding: OrderBindingResult | null;
  signals: TrustSignals;
  /** Reference badge only — the UI may ignore and interpret `signals` itself. */
  badge: TrustBadge;
}

export interface TrustThresholds {
  /** Score percentile at/above which "ppr-high" is flagged. Default 0.9. */
  pprHighPercentile: number;
  /** Minimum rating count for the gate to pass. Default 1. */
  minRatingCount: number;
}

const DEFAULT_THRESHOLDS: TrustThresholds = { pprHighPercentile: 0.9, minRatingCount: 1 };

/** Reference badge from raw signals (UI may supply its own thresholds). */
export function badgeFrom(signals: TrustSignals, th: TrustThresholds = DEFAULT_THRESHOLDS): TrustBadge {
  const score = signals.score ?? undefined;
  if (!signals.verified) return { state: "UNRATED", score, reasons: signals.flags };
  if (signals.ratingCount < th.minRatingCount) {
    if (signals.percentile !== null && signals.percentile >= th.pprHighPercentile) {
      return { state: "farm-suspect", score, reasons: ["rating-0", "ppr-high"] };
    }
    return { state: "UNRATED", score, reasons: ["rating-0"] };
  }
  if (signals.score !== null && signals.score > 0) return { state: "도달", score, reasons: [] };
  return { state: "미도달", reasons: [] };
}

export interface AnnotateParams {
  graph: TrustScorer;
  mostroPubkey: string;
  identityIndex: IdentityIndex;
  thresholds?: TrustThresholds;
  telemetry?: TelemetrySink;
}

function annotateOne(order: SmallOrder, p: AnnotateParams): AnnotatedOrder {
  const candidates = order.id ? p.identityIndex.candidates(order.id) : [];
  let identity: string | null = null;
  let binding: OrderBindingResult | null = null;
  for (const c of candidates) {
    const r = verifyOrderBindingFromOrder(order, p.mostroPubkey, c.identity);
    binding = r;
    if (r.ok) {
      identity = c.identity;
      break;
    }
  }

  const th = p.thresholds ?? DEFAULT_THRESHOLDS;
  const ratingCount = order.rating?.total_reviews ?? 0;
  const score = identity ? (p.graph.score(identity) ?? null) : null;
  const percentile = identity ? (p.graph.percentile(identity) ?? null) : null;

  const flags: string[] = [];
  if (!identity) flags.push(candidates.length > 0 ? "unverified" : "no-identity");
  if (ratingCount < th.minRatingCount) flags.push("rating-0");
  if (percentile !== null && percentile >= th.pprHighPercentile) flags.push("ppr-high");
  if (flags.includes("rating-0") && flags.includes("ppr-high")) flags.push("farm-suspect");

  const signals: TrustSignals = { verified: identity !== null, score, percentile, ratingCount, flags };
  const badge = badgeFrom(signals, th);
  p.telemetry?.emit({ ev: "annotate", ts: Date.now(), state: badge.state, resolved: signals.verified, ratingCount: signals.ratingCount, score: signals.score, percentile: signals.percentile, flags: signals.flags });
  return { order, identity, binding, signals, badge };
}

/** Join orders with the graph. Pure; does not mutate inputs. */
export function annotateOrders(orders: SmallOrder[], p: AnnotateParams): AnnotatedOrder[] {
  return orders.map((o) => annotateOne(o, p));
}

export interface TrustQuery {
  states?: TrustState[];
  minScore?: number;
  minPercentile?: number;
  onlyVerified?: boolean;
  excludeFlags?: string[];
}

/** Optional helper. The UI can do the same with raw signals. */
export function filterByTrust(items: AnnotatedOrder[], q: TrustQuery): AnnotatedOrder[] {
  return items.filter((it) => {
    if (q.states && !q.states.includes(it.badge.state)) return false;
    if (q.onlyVerified && !it.signals.verified) return false;
    if (q.minScore !== undefined && (it.signals.score ?? Number.NEGATIVE_INFINITY) < q.minScore) return false;
    if (q.minPercentile !== undefined && (it.signals.percentile ?? Number.NEGATIVE_INFINITY) < q.minPercentile) return false;
    if (q.excludeFlags && q.excludeFlags.some((f) => it.signals.flags.includes(f))) return false;
    return true;
  });
}

/** Optional helper. Sorts by score desc, unscored last. */
export function sortByTrust(items: AnnotatedOrder[]): AnnotatedOrder[] {
  return [...items].sort((a, b) => (b.signals.score ?? -1) - (a.signals.score ?? -1));
}
