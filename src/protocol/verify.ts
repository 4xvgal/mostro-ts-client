// MessageKind::verify() — payload/id/trade_index consistency per action.
// Ported from mostro-core 0.14.3 `src/message.rs` `MessageKind::verify`.

import type { Action } from "./action.js";
import type { MessageKind, Payload } from "./message.js";

// Actions that require an id and forbid BondResolution/BondPayoutRequest payloads.
const OTHER_ACTIONS: readonly Action[] = [
  "take-sell",
  "take-buy",
  "fiat-sent",
  "fiat-sent-ok",
  "release",
  "released",
  "dispute",
  "admin-canceled",
  "admin-settled",
  "rate",
  "rate-received",
  "admin-take-dispute",
  "admin-took-dispute",
  "dispute-initiated-by-you",
  "dispute-initiated-by-peer",
  "waiting-buyer-invoice",
  "purchase-completed",
  "bond-payout-completed",
  "bond-slashed",
  "hold-invoice-payment-accepted",
  "hold-invoice-payment-settled",
  "hold-invoice-payment-canceled",
  "waiting-seller-to-pay",
  "buyer-took-order",
  "buyer-invoice-accepted",
  "bond-invoice-accepted",
  "cooperative-cancel-initiated-by-you",
  "cooperative-cancel-initiated-by-peer",
  "cooperative-cancel-accepted",
  "cancel",
  "invoice-updated",
  "admin-add-solver",
  "send-dm",
  "trade-pubkey",
  "cashu-escrow-locked",
  "canceled",
];

/**
 * Check that the payload, id and trade index are consistent with the action.
 * Returns true when the combination is well-formed, false otherwise.
 */
export function verifyMessageKind(kind: MessageKind): boolean {
  switch (kind.action) {
    case "new-order":
      return kind.payload !== null && kind.payload.variant === "order";

    case "pay-invoice":
    case "pay-bond-invoice":
    case "add-invoice":
      if (kind.id === null) {
        return false;
      }
      return kind.payload !== null && kind.payload.variant === "payment_request";

    case "add-bond-invoice":
      if (kind.id === null) {
        return false;
      }
      return (
        kind.payload !== null &&
        (kind.payload.variant === "bond_payout_request" ||
          kind.payload.variant === "payment_request")
      );

    case "admin-settle":
    case "admin-cancel":
      if (kind.id === null) {
        return false;
      }
      return (
        kind.payload === null || kind.payload.variant === "bond_resolution"
      );

    case "add-cashu-escrow":
      if (kind.id === null) {
        return false;
      }
      return kind.payload !== null && kind.payload.variant === "cashu_lock_proof";

    case "cashu-pm-signature":
      if (kind.id === null) {
        return false;
      }
      return (
        kind.payload !== null &&
        kind.payload.variant === "cashu_signatures" &&
        kind.payload.value.length > 0
      );

    case "last-trade-index":
    case "restore-session":
      return kind.payload === null;

    case "payment-failed":
      if (kind.id === null) {
        return false;
      }
      return kind.payload !== null && kind.payload.variant === "payment_failed";

    case "rate-user":
      return kind.payload !== null && kind.payload.variant === "rating_user";

    case "cant-do":
      return kind.payload !== null && kind.payload.variant === "cant_do";

    case "orders":
      return (
        kind.payload !== null &&
        (kind.payload.variant === "ids" || kind.payload.variant === "orders")
      );

    default: {
      if (!OTHER_ACTIONS.includes(kind.action)) {
        return false;
      }
      if (kind.id === null) {
        return false;
      }
      return !(
        kind.payload !== null &&
        (kind.payload.variant === "bond_resolution" ||
          kind.payload.variant === "bond_payout_request")
      );
    }
  }
}

/** Validate that a Message is consistent with its Action. Delegates to verifyMessageKind. */
export function verifyMessage(message: { value: MessageKind }): boolean {
  return verifyMessageKind(message.value);
}

/**
 * Extract the (next_trade_pubkey, next_trade_index) pair from a next_trade payload.
 * Returns null when there is no payload; throws TypeError on wrong variant.
 */
export function getNextTradeKey(kind: MessageKind): [string, number] | null {
  if (kind.payload === null) {
    return null;
  }
  if (kind.payload.variant === "next_trade") {
    return kind.payload.value;
  }
  throw new TypeError("payload is not a next_trade variant");
}

/**
 * Extract the rating value from a rating_user payload, validating 1..=5.
 * Returns the rating or throws.
 */
export function getRating(kind: MessageKind): number {
  if (kind.payload === null || kind.payload.variant !== "rating_user") {
    throw new Error("invalid rating payload");
  }
  const v = kind.payload.value;
  if (v < 1 || v > 5) {
    throw new Error("invalid rating value");
  }
  return v;
}

/** Return the SmallOrder carried by a new-order message, or null. */
export function getOrder(kind: MessageKind): import("./order.js").SmallOrder | null {
  if (kind.action !== "new-order") {
    return null;
  }
  if (kind.payload !== null && kind.payload.variant === "order") {
    return kind.payload.value;
  }
  return null;
}

/** Return the Lightning payment request embedded in a message, or null. */
export function getPaymentRequest(kind: MessageKind): string | null {
  if (
    kind.action !== "take-sell" &&
    kind.action !== "add-invoice" &&
    kind.action !== "add-bond-invoice" &&
    kind.action !== "new-order"
  ) {
    return null;
  }
  if (kind.payload === null) {
    return null;
  }
  switch (kind.payload.variant) {
    case "payment_request":
      return kind.payload.value[1];
    case "order":
      return kind.payload.value.buyer_invoice;
    default:
      return null;
  }
}

/** Return the amount override embedded in a take-sell/take-buy message, or null. */
export function getAmount(kind: MessageKind): number | null {
  if (kind.action !== "take-sell" && kind.action !== "take-buy") {
    return null;
  }
  if (kind.payload === null) {
    return null;
  }
  switch (kind.payload.variant) {
    case "payment_request":
      return kind.payload.value[2];
    case "amount":
      return kind.payload.value;
    default:
      return null;
  }
}

/** Return (has_trade_index, trade_index). */
export function hasTradeIndex(kind: MessageKind): [boolean, number] {
  if (kind.trade_index !== null) {
    return [true, kind.trade_index];
  }
  return [false, 0];
}

export type { Payload };