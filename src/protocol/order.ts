// Order types. Ported from mostro-core 0.14.3 `src/order.rs`.

import type { Kind } from "./kind.js";
import type { Status } from "./status.js";

export { Kind, kindFromString, kindToString } from "./kind.js";
export { Status, statusFromString, statusToString } from "./status.js";

/** Persistent representation of a Mostro order (daemon-side record). */
export interface Order {
  id: string;
  kind: string;
  event_id: string;
  hash: string | null;
  preimage: string | null;
  creator_pubkey: string;
  cancel_initiator_pubkey: string | null;
  buyer_pubkey: string | null;
  master_buyer_pubkey: string | null;
  seller_pubkey: string | null;
  master_seller_pubkey: string | null;
  status: string;
  price_from_api: boolean;
  premium: number;
  payment_method: string;
  amount: number;
  min_amount: number | null;
  max_amount: number | null;
  buyer_dispute: boolean;
  seller_dispute: boolean;
  buyer_cooperativecancel: boolean;
  seller_cooperativecancel: boolean;
  fee: number;
  routing_fee: number;
  dev_fee: number;
  dev_fee_paid: boolean;
  dev_fee_payment_hash: string | null;
  fiat_code: string;
  fiat_amount: number;
  buyer_invoice: string | null;
  range_parent_id: string | null;
  invoice_held_at: number;
  taken_at: number;
  created_at: number;
  buyer_sent_rate: boolean;
  seller_sent_rate: boolean;
  failed_payment: boolean;
  payment_attempts: number;
  expires_at: number;
  trade_index_seller: number | null;
  trade_index_buyer: number | null;
  next_trade_pubkey: string | null;
  next_trade_index: number | null;
  cashu_mint_url: string | null;
  cashu_escrow_token: string | null;
  cashu_escrow_locked_at: number | null;
}

/** Maker reputation attached to orderbook events (mostro kind-38383 `rating` tag). */
export interface MakerRating {
  /** Number of received reviews. */
  total_reviews: number;
  /** Weighted rating sum (first vote is weighted 1/2). Average = total_rating / total_reviews. */
  total_rating: number;
  /** Days the maker has been operating. */
  days: number;
}

/** Compact, wire-friendly view of an order. */
export interface SmallOrder {
  id: string | null;
  kind: Kind | null;
  status: Status | null;
  amount: number;
  fiat_code: string;
  min_amount: number | null;
  max_amount: number | null;
  fiat_amount: number;
  payment_method: string;
  premium: number;
  buyer_trade_pubkey: string | null;
  seller_trade_pubkey: string | null;
  buyer_invoice: string | null;
  created_at: number | null;
  expires_at: number | null;
  /** Maker reputation, present only on orderbook events. */
  rating?: MakerRating | null;
}

export function newSmallOrder(params: {
  id?: string | null;
  kind?: Kind | null;
  status?: Status | null;
  amount: number;
  fiat_code: string;
  min_amount?: number | null;
  max_amount?: number | null;
  fiat_amount: number;
  payment_method: string;
  premium: number;
  buyer_trade_pubkey?: string | null;
  seller_trade_pubkey?: string | null;
  buyer_invoice?: string | null;
  created_at?: number | null;
  expires_at?: number | null;
  rating?: MakerRating | null;
}): SmallOrder {
  return {
    id: params.id ?? null,
    kind: params.kind ?? null,
    status: params.status ?? null,
    amount: params.amount,
    fiat_code: params.fiat_code,
    min_amount: params.min_amount ?? null,
    max_amount: params.max_amount ?? null,
    fiat_amount: params.fiat_amount,
    payment_method: params.payment_method,
    premium: params.premium,
    buyer_trade_pubkey: params.buyer_trade_pubkey ?? null,
    seller_trade_pubkey: params.seller_trade_pubkey ?? null,
    buyer_invoice: params.buyer_invoice ?? null,
    created_at: params.created_at ?? null,
    expires_at: params.expires_at ?? null,
    rating: params.rating ?? null,
  };
}

/** Return the sats amount as a string, or "Market price" when amount is 0. */
export function satsAmount(order: SmallOrder): string {
  if (order.amount === 0) {
    return "Market price";
  }
  return String(order.amount);
}

/** Assert that the fiat amount is strictly positive. Returns null when valid, reason otherwise. */
export function checkFiatAmount(order: SmallOrder): "invalid_amount" | null {
  return order.fiat_amount <= 0 ? "invalid_amount" : null;
}

/** Assert that the sats amount is non-negative (0 is valid: market-priced). */
export function checkAmount(order: SmallOrder): "invalid_amount" | null {
  return order.amount < 0 ? "invalid_amount" : null;
}

/**
 * Reject orders that set both amount and premium at the same time.
 * Returns "invalid_parameters" when both are non-zero.
 */
export function checkZeroAmountWithPremium(order: SmallOrder): "invalid_parameters" | null {
  const hasPremium = order.premium !== 0;
  const hasAmount = order.amount !== 0;
  if (hasPremium && hasAmount) {
    return "invalid_parameters";
  }
  return null;
}

/**
 * Validate the bounds of a range order. When both min and max are set they
 * must be non-negative, min < max, and amount must be 0. Returns
 * "invalid_amount" on failure, otherwise the [min, max] range (or null).
 */
export function checkRangeOrderLimits(order: SmallOrder): "invalid_amount" | [number, number] | null {
  const { min_amount: min, max_amount: max } = order;
  if (min === null || max === null) {
    return null;
  }
  if (min < 0 || max < 0) {
    return "invalid_amount";
  }
  if (min >= max) {
    return "invalid_amount";
  }
  if (order.amount !== 0) {
    return "invalid_amount";
  }
  return [min, max];
}

/**
 * Verify that the order's fiat code appears in the list of accepted currencies.
 * An empty allowlist disables the check.
 */
export function checkFiatCurrency(order: SmallOrder, accepted: string[]): "invalid_fiat_currency" | null {
  if (!accepted.includes(order.fiat_code) && accepted.length !== 0) {
    return "invalid_fiat_currency";
  }
  return null;
}

/** `true` when this is a range order (both min and max set). */
export function isRangeOrder(order: Order): boolean {
  return order.min_amount !== null && order.max_amount !== null;
}