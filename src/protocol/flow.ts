// Order flow helpers. Ported from mostrix `src/util/order_utils/send_new_order.rs`
// and `execute_send_msg.rs`. Nostr transport (send_dm / wait_for_dm) is
// deferred to the DM router phase; this module builds wire messages and
// dispatches Mostro responses.

import { randomUUID } from "node:crypto";
import type { Action } from "./action.js";
import { Kind, Status, newSmallOrder } from "./order.js";
import type { SmallOrder } from "./order.js";
import { newOrderMessage } from "./message.js";
import type { Message, MessageKind, Payload } from "./message.js";
import { verifyMessageKind } from "./verify.js";

/** Create a request_id: top 64 bits of a v4 UUID, as in mostrix. */
export function newRequestId(): number {
  const id = randomUUID();
  const bytes = id.replace(/-/g, "");
  return Number.parseInt(bytes.slice(0, 16), 16);
}

export interface NewOrderInput {
  /** "buy" or "sell". Defaults to "buy". */
  kind?: string;
  /** ISO fiat code. Defaults to "USD". */
  fiatCode?: string;
  /** Sats amount. 0 = derived from market price. */
  amount: number;
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
  const amount = input.amount;
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