// Public order book — Mostro kind-38383 addressable order events.
// Ported from mostrix `src/util/order_utils/helper.rs`
// (order_from_tags, aggregate_latest_orders_by_id, parse_orders_events,
// pending_orders_for_book, fetch_mostro_order_events).

import { SimplePool } from "nostr-tools/pool";
import { kindFromString } from "./kind.js";
import { statusFromString } from "./status.js";
import type { SmallOrder, Kind, Status, MakerRating } from "./order.js";
import { NOSTR_ORDER_EVENT_KIND } from "./constants.js";
import { FETCH_EVENTS_TIMEOUT_MS } from "./dmRouter.js";

/** Relay fetch cap for Mostro order/dispute list snapshots (mostrix). */
export const MOSTRO_LIST_FETCH_EVENT_LIMIT = 500;

/**
 * Parse a maker `rating` tag value into a `MakerRating`.
 *
 * Mostro serializes it as `["rating",{"total_reviews":N,"total_rating":F,"days":N}]`
 * (a JSON array) or `"{}"` when the maker has no reputation yet.
 */
export function parseMakerRating(raw: string): MakerRating | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    const data = Array.isArray(parsed) ? parsed[1] : parsed;
    if (data && typeof data === "object") {
      const obj = data as Record<string, unknown>;
      if (typeof obj.total_reviews === "number" || typeof obj.total_rating === "number") {
        return {
          total_reviews: Number(obj.total_reviews) || 0,
          total_rating: Number(obj.total_rating) || 0,
          days: Number(obj.days) || 0,
        };
      }
    }
  } catch {
    // fall through
  }
  return null;
}

/** Build a SmallOrder from the tags of a kind-38383 event. */
export function orderFromTags(tags: string[][]): SmallOrder {
  const order: SmallOrder = {
    id: null,
    kind: null,
    status: null,
    amount: 0,
    fiat_code: "",
    min_amount: null,
    max_amount: null,
    fiat_amount: 0,
    payment_method: "",
    premium: 0,
    buyer_trade_pubkey: null,
    seller_trade_pubkey: null,
    buyer_invoice: null,
    created_at: null,
    expires_at: null,
  };

  for (const tag of tags) {
    if (tag.length === 0) {
      continue;
    }
    const key = tag[0];
    const values = tag.slice(1);
    const v = values[0] ?? "";

    switch (key) {
      case "d":
        order.id = v || null;
        break;
      case "k":
        order.kind = kindFromString(v);
        break;
      case "f":
        order.fiat_code = v;
        break;
      case "s":
        order.status = statusFromString(v) ?? "pending";
        break;
      case "amt":
        order.amount = parseIntSafe(v) ?? 0;
        break;
      case "fa":
        // Range orders carry two values: min and max. Decimals are ignored.
        if (v.includes(".")) {
          break;
        }
        if (values.length >= 2) {
          order.min_amount = parseIntSafe(v);
          order.max_amount = parseIntSafe(values[1]!);
        } else {
          order.fiat_amount = parseIntSafe(v) ?? 0;
        }
        break;
      case "pm":
        order.payment_method = values.join(",");
        break;
      case "premium":
        order.premium = parseIntSafe(v) ?? 0;
        break;
      case "rating": {
        const rating = parseMakerRating(v);
        if (rating) {
          order.rating = rating;
        }
        break;
      }
      default:
        break;
    }
  }
  return order;
}

function parseIntSafe(v: string): number | null {
  if (!/^-?\d+$/.test(v)) {
    return null;
  }
  return Number.parseInt(v, 10);
}

export interface OrderEvent {
  id: string;
  pubkey: string;
  created_at: number;
  tags: string[][];
}

/**
 * Aggregate the latest snapshot per order id, keeping the newest by created_at.
 * Mirrors `aggregate_latest_orders_by_id`.
 */
export function aggregateLatestOrdersById(events: OrderEvent[]): Map<string, SmallOrder> {
  const latest = new Map<string, SmallOrder>();
  for (const event of events) {
    const order = orderFromTags(event.tags);
    const orderId = order.id;
    if (!orderId || order.kind === null) {
      continue;
    }
    order.created_at = event.created_at;
    const existing = latest.get(orderId);
    if (!existing || (event.created_at ?? 0) > (existing.created_at ?? 0)) {
      latest.set(orderId, order);
    }
  }
  return latest;
}

export interface OrdersFilter {
  currencies?: string[] | null;
  status?: Status | null;
  kind?: Kind | null;
}

/** Parse orders from events with optional filters. Mirrors parse_orders_events. */
export function parseOrdersEvents(
  events: OrderEvent[],
  filter: OrdersFilter = {},
): SmallOrder[] {
  const latest = aggregateLatestOrdersById(events);
  const currencies = filter.currencies ?? null;
  const status = filter.status ?? null;
  const kind = filter.kind ?? null;

  const orders: SmallOrder[] = [];
  for (const order of latest.values()) {
    if (status !== null && order.status !== status) {
      continue;
    }
    if (
      currencies !== null &&
      currencies.length > 0 &&
      !currencies.includes(order.fiat_code)
    ) {
      continue;
    }
    if (kind !== null && order.kind !== kind) {
      continue;
    }
    orders.push(order);
  }
  orders.sort((a, b) => (b.created_at ?? 0) - (a.created_at ?? 0));
  return orders;
}

/** Pending listings for the public order book. Mirrors pending_orders_for_book. */
export function pendingOrdersForBook(
  latest: Map<string, SmallOrder>,
  currencies: string[] | null,
): SmallOrder[] {
  const orders: SmallOrder[] = [];
  for (const order of latest.values()) {
    if (order.status !== "pending") {
      continue;
    }
    if (currencies !== null && currencies.length > 0 && !currencies.includes(order.fiat_code)) {
      continue;
    }
    orders.push(order);
  }
  orders.sort((a, b) => (b.created_at ?? 0) - (a.created_at ?? 0));
  return orders;
}

/** Fetch the latest order-book snapshot from relays. */
export async function fetchMostroOrderEvents(params: {
  pool: SimplePool;
  relays: string[];
  mostroPubkeyHex: string;
}): Promise<OrderEvent[]> {
  const { pool, relays, mostroPubkeyHex } = params;
  const events = await pool.querySync(relays, {
    kinds: [NOSTR_ORDER_EVENT_KIND],
    authors: [mostroPubkeyHex],
    limit: MOSTRO_LIST_FETCH_EVENT_LIMIT,
  });
  // Client-side author re-check (relay author filters are untrusted).
  return events.filter((e) => e.pubkey === mostroPubkeyHex);
}

/** Convenience: fetch + aggregate + pending-only view for a UI order book. */
export async function fetchPublicOrderBook(params: {
  pool: SimplePool;
  relays: string[];
  mostroPubkeyHex: string;
  currencies?: string[];
}): Promise<SmallOrder[]> {
  const events = await fetchMostroOrderEvents(params);
  const latest = aggregateLatestOrdersById(events);
  return pendingOrdersForBook(latest, params.currencies ?? null);
}