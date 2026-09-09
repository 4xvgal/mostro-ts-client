// Order flow helpers. Ported from mostrix `src/util/order_utils/send_new_order.rs`
// and `execute_send_msg.rs`. Nostr transport (send_dm / wait_for_dm) is
// deferred to the DM router phase; this module builds wire messages and
// dispatches Mostro responses.

import type { Action } from "./action.js";
import { Kind, Status, newSmallOrder } from "./order.js";
import type { SmallOrder } from "./order.js";
import { newOrderMessage } from "./message.js";
import type { Message, MessageKind, Payload } from "./message.js";
import { verifyMessageKind, getRating } from "./verify.js";

/**
 * Create a request_id safe for JS Number precision.
 *
 * Mostro treats request_id as u64 and echoes it back unchanged, so any value
 * works — but a >2^53 value would lose precision in JS (JSON parse + SQLite
 * INTEGER storage). Use 48 random bits (< 2^53), collision-safe for any
 * realistic concurrent request count.
 */
export function newRequestId(): number {
  return Math.floor(Math.random() * 2 ** 48);
}

export interface NewOrderInput {
  /** "buy" or "sell". Defaults to "buy". */
  kind?: string;
  /** ISO fiat code. Defaults to "USD". */
  fiatCode?: string;
  /** Sats amount. 0 (default) = derived from market price. */
  amount?: number;
  /** Fiat amount of the trade (or 0 for a range order). */
  fiatAmount: number;
  /** Range order bounds. Both must be set for a range order. */
  minAmount?: number;
  maxAmount?: number;
  /** Free-form payment method description. */
  paymentMethod: string;
  /** Premium percentage. Mutually exclusive with a fixed amount. */
  premium?: number;
  /** Buyer's Lightning payout invoice, if known. */
  buyerInvoice?: string;
  /** Expiry in days. Defaults to 1. */
  expirationDays?: number;
}

export interface NewOrderOutcome {
  message: Message;
  smallOrder: SmallOrder;
  requestId: number;
  tradeIndex: number;
}

/**
 * Build a Message::Order(NewOrder) exactly as mostrix does: reserve the next
 * trade index, assemble the SmallOrder (status pending, created_at 0),
 * stamp a fresh request_id.
 *
 * @param state current lastTradeIndex (use null on first run)
 * @param mnemonic used to derive the trade key for this order
 * @param input order form data
 */
export function buildNewOrder(
  state: { lastTradeIndex: number | null },
  input: NewOrderInput,
): { message: Message; smallOrder: SmallOrder; requestId: number; tradeIndex: number } {
  const kindStr = (input.kind ?? "buy").trim().toLowerCase();
  const kind = kindStr === "sell" ? Kind.Sell : Kind.Buy;
  const fiatCode = (input.fiatCode ?? "USD").trim().toUpperCase();
  const amount = input.amount ?? 0;
  const premium = input.premium ?? 0;

  const expirationDays = input.expirationDays ?? 1;
  if (expirationDays < 1) {
    throw new Error("Minimum expiration time is 1 day");
  }
  const expiresAt = Math.floor(Date.now() / 1000) + expirationDays * 86400;

  const isRange = input.minAmount !== undefined && input.maxAmount !== undefined && input.maxAmount > 0;
  const fiatAmount = isRange ? 0 : input.fiatAmount;
  const minAmount = isRange ? input.minAmount : null;
  const maxAmount = isRange ? input.maxAmount : null;

  const tradeIndex = (state.lastTradeIndex ?? 1) + 1;
  const requestId = newRequestId();

  const smallOrder = newSmallOrder({
    id: null,
    kind,
    status: Status.Pending,
    amount,
    fiat_code: fiatCode,
    min_amount: minAmount ?? null,
    max_amount: maxAmount ?? null,
    fiat_amount: fiatAmount,
    payment_method: input.paymentMethod,
    premium,
    buyer_trade_pubkey: null,
    seller_trade_pubkey: null,
    buyer_invoice: input.buyerInvoice ?? null,
    created_at: 0,
    expires_at: expiresAt,
  });

  const message = newOrderMessage(null, requestId, tradeIndex, "new-order", {
    variant: "order",
    value: smallOrder,
  });

  if (!verifyMessageKind(message.value)) {
    throw new Error("built new-order message failed verification");
  }

  return { message, smallOrder, requestId, tradeIndex };
}

export type NewOrderResponse =
  | { type: "order-created"; order: SmallOrder; requestId: number }
  | { type: "bond-invoice"; order: SmallOrder | null; invoice: string; amount: number | null; requestId: number };

/**
 * Dispatch the first Mostro reply to a new-order send, mirroring
 * send_new_order.rs: Action::NewOrder → success, Action::PayBondInvoice →
 * bond popup. Throws on unexpected action, null request_id, or request_id
 * mismatch.
 */
export function handleNewOrderResponse(
  kind: MessageKind,
  expectedRequestId: number,
): NewOrderResponse {
  if (kind.request_id === null) {
    throw new Error("Response with null request_id");
  }
  if (kind.request_id !== expectedRequestId) {
    throw new Error("Mismatched request_id");
  }
  switch (kind.action) {
    case "new-order": {
      const payload = kind.payload;
      if (!payload || payload.variant !== "order") {
        throw new Error("Mostro replied with NewOrder but no order payload was provided");
      }
      return { type: "order-created", order: payload.value, requestId: kind.request_id };
    }
    case "pay-bond-invoice": {
      const payload = kind.payload;
      if (!payload || payload.variant !== "payment_request") {
        throw new Error("Mostro replied with PayBondInvoice but no PaymentRequest payload was provided");
      }
      const [order, invoice, amount] = payload.value;
      return {
        type: "bond-invoice",
        order,
        invoice,
        amount,
        requestId: kind.request_id,
      };
    }
    default:
      throw new Error(`Unexpected action: ${kind.action}`);
  }
}

/** Build a Message::Order for trade actions (fiat-sent, release, cancel, rate-user, ...). */
export function buildTradeMessage(input: {
  orderId: string;
  requestId: number;
  action: Action;
  payload: Payload | null;
  tradeIndex?: number | null;
}): Message {
  const message = newOrderMessage(
    input.orderId,
    input.requestId,
    input.tradeIndex ?? null,
    input.action,
    input.payload,
  );
  if (!verifyMessageKind(message.value)) {
    throw new Error(`built ${input.action} message failed verification`);
  }
  return message;
}

// ---------------------------------------------------------------------------
// Take order (mostrix take_order.rs)
// ---------------------------------------------------------------------------

/**
 * Build the payload for a take-order action. Mirrors
 * `create_take_order_payload`:
 * - TakeBuy: `Payload::Amount(amount)` when amount is set, else null.
 * - TakeSell: `Payload::PaymentRequest` when an invoice is provided (with
 *   optional range amount), else `Payload::Amount(amount ?? 0)`.
 */
export function buildTakeOrderPayload(input: {
  action: "take-buy" | "take-sell";
  invoice?: string | null;
  amount?: number | null;
}): Payload | null {
  switch (input.action) {
    case "take-buy":
      return input.amount != null ? { variant: "amount", value: input.amount } : null;
    case "take-sell": {
      if (input.invoice) {
        return {
          variant: "payment_request",
          value: [null, input.invoice, input.amount ?? null],
        };
      }
      return { variant: "amount", value: input.amount ?? 0 };
    }
  }
}

/**
 * Determine the take action from an order's kind, as mostrix does:
 * taking a Buy order → TakeBuy (we sell sats); taking a Sell order →
 * TakeSell (we buy sats).
 */
export function takeActionForOrder(order: SmallOrder): "take-buy" | "take-sell" {
  switch (order.kind) {
    case "buy":
      return "take-buy";
    case "sell":
      return "take-sell";
    default:
      throw new Error("Order kind is not specified");
  }
}

/**
 * Dispatch the first Mostro reply to a take-order send.
 *
 * Expected outcomes (mostrix take_order):
 * - Buy order taken (we sell): PayInvoice + PaymentRequest → hold invoice popup.
 * - Sell order taken (we buy): order status update / PaymentRequest.
 * - PayBondInvoice → taker bond popup.
 * - CantDo → structured refusal.
 */
export function handleTakeOrderResponse(
  kind: MessageKind,
  expectedRequestId: number,
): TakeOrderResponse {
  if (kind.request_id === null) {
    throw new Error("Response with null request_id");
  }
  if (kind.request_id !== expectedRequestId) {
    throw new Error("Mismatched request_id");
  }
  switch (kind.action) {
    case "pay-invoice":
    case "pay-bond-invoice": {
      const payload = kind.payload;
      if (!payload || payload.variant !== "payment_request") {
        throw new Error(`Mostro replied with ${kind.action} but no PaymentRequest payload`);
      }
      const [order, invoice, amount] = payload.value;
      return {
        type: kind.action === "pay-bond-invoice" ? "bond-invoice" : "hold-invoice",
        order,
        invoice,
        amount,
        requestId: kind.request_id,
      };
    }
    case "cant-do": {
      const reason = kind.payload && kind.payload.variant === "cant_do" ? kind.payload.value : null;
      throw new CantDoError(reason, kind.request_id);
    }
    case "add-invoice": {
      // Take-sell without a buyer invoice: Mostro asks for the payout bolt11.
      const payload = kind.payload;
      if (!payload || payload.variant !== "order") {
        throw new Error("Mostro replied with AddInvoice but no order payload");
      }
      return {
        type: "add-invoice",
        order: payload.value,
        requestId: kind.request_id,
      };
    }
    default:
      throw new Error(`Unexpected action: ${kind.action}`);
  }
}

export type TakeOrderResponse =
  | { type: "hold-invoice"; order: SmallOrder | null; invoice: string; amount: number | null; requestId: number }
  | { type: "bond-invoice"; order: SmallOrder | null; invoice: string; amount: number | null; requestId: number }
  | { type: "add-invoice"; order: SmallOrder; requestId: number };

/** Structured refusal from Mostro (`Payload::CantDo`). */
export class CantDoError extends Error {
  reason: string | null;
  requestId: number | null;

  constructor(reason: string | null, requestId: number | null) {
    super(reason ? `CantDo: ${reason}` : "CantDo");
    this.name = "CantDoError";
    this.reason = reason;
    this.requestId = requestId;
  }
}

// ---------------------------------------------------------------------------
// Rate user (mostrix execute_rate_user)
// ---------------------------------------------------------------------------

/** Build a Message::Order(RateUser) with the given rating (1..=5). */
export function buildRateUserMessage(input: {
  orderId: string;
  requestId: number;
  rating: number;
}): Message {
  if (input.rating < 1 || input.rating > 5) {
    throw new Error(`Rating must be between 1 and 5, got ${input.rating}`);
  }
  const message = newOrderMessage(input.orderId, input.requestId, null, "rate-user", {
    variant: "rating_user",
    value: input.rating,
  });
  if (!verifyMessageKind(message.value)) {
    throw new Error("built rate-user message failed verification");
  }
  return message;
}

/** Validate the reply to a RateUser send; Mostro must answer RateReceived. */
export function handleRateUserResponse(kind: MessageKind, expectedRequestId: number): void {
  if (kind.request_id === null) {
    throw new Error("Response with null request_id");
  }
  if (kind.request_id !== expectedRequestId) {
    throw new Error("Mismatched request_id");
  }
  if (kind.action !== "rate-received") {
    throw new Error(`Unexpected action in response: ${kind.action}`);
  }
}

// ---------------------------------------------------------------------------
// Range orders — NextTrade payload (mostrix RANGE_ORDERS.md)
// ---------------------------------------------------------------------------

/**
 * Compute the NextTrade payload for a FiatSent/Release on a range order.
 *
 * Mirrors mostrix `create_msg_payload`: when the order is a range order and
 * the remaining amount (max - current fiat_amount) still covers min_amount,
 * the maker announces its next trade key so Mostro creates a fresh pending
 * order for the remainder. The next trade index is reserved with `noneBase 0`.
 *
 * Returns null when no NextTrade is needed (fixed order, or range exhausted).
 */
export function computeNextTradePayload(input: {
  /** Current order (must carry min_amount/max_amount/fiat_amount). */
  order: SmallOrder;
  /** Reserve the next trade key for the range continuation. */
  reserveNext: (noneBase: 0) => { nextIndex: number; keys: { pubkey: string } };
}): Payload | null {
  const { order, reserveNext } = input;
  const { min_amount: min, max_amount: max, fiat_amount: fiat } = order;
  if (min === null || max === null) {
    return null; // not a range order
  }
  if (max - fiat < min) {
    return null; // remaining amount below the next trade minimum
  }
  const { nextIndex, keys } = reserveNext(0);
  return {
    variant: "next_trade",
    value: [keys.pubkey, nextIndex],
  };
}

/** Build a FiatSent or Release message, optionally carrying a NextTrade payload. */
export function buildTradeCompletionMessage(input: {
  orderId: string;
  requestId: number;
  action: "fiat-sent" | "release";
  /** NextTrade payload when the range order continues; null otherwise. */
  nextTrade?: Payload | null;
}): Message {
  return buildTradeMessage({
    orderId: input.orderId,
    requestId: input.requestId,
    action: input.action,
    payload: input.nextTrade ?? null,
  });
}

// ---------------------------------------------------------------------------
// Disputes — client-side state handling
// ---------------------------------------------------------------------------

/** Build a Message::Order(Dispute) to open a dispute on an order. */
export function buildDisputeMessage(input: { orderId: string; requestId: number }): Message {
  const message = newOrderMessage(input.orderId, input.requestId, null, "dispute", null);
  if (!verifyMessageKind(message.value)) {
    throw new Error("built dispute message failed verification");
  }
  return message;
}

export interface DisputeNotification {
  /** The order the dispute was opened on. */
  orderId: string;
  /** The dispute id assigned by Mostro (Payload::Dispute tuple element 0). */
  disputeId: string;
  /** True when this client is the dispute initiator. */
  initiatedByYou: boolean;
}

/**
 * Handle the dispute notification from Mostro: after a dispute action, the
 * daemon notifies the initiator with `DisputeInitiatedByYou` and the peer with
 * `DisputeInitiatedByPeer`, both carrying `Payload::Dispute(dispute_id, None)`.
 */
export function handleDisputeNotification(kind: MessageKind): DisputeNotification {
  const action = kind.action;
  if (action !== "dispute-initiated-by-you" && action !== "dispute-initiated-by-peer") {
    throw new Error(`Unexpected action in dispute notification: ${action}`);
  }
  if (kind.id === null) {
    throw new Error("Dispute notification missing order id");
  }
  const payload = kind.payload;
  if (!payload || payload.variant !== "dispute") {
    throw new Error("Dispute notification missing dispute payload");
  }
  return {
    orderId: kind.id,
    disputeId: payload.value[0],
    initiatedByYou: action === "dispute-initiated-by-you",
  };
}