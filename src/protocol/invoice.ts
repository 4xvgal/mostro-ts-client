// Invoice submission — bolt11/LNURL disambiguation + AddInvoice/AddBondInvoice.
// Ported from mostrix `src/util/order_utils/execute_add_invoice.rs`
// (payment_request_payload_for_invoice, execute_payment_request_reply,
// execute_bond_payment_request_reply) and `src/util/ln_address.rs`.

import type { Action } from "./action.js";
import type { Message, MessageKind, Payload } from "./message.js";
import { newOrderMessage } from "./message.js";
import { verifyMessageKind } from "./verify.js";

/** Invoice kinds accepted for bolt11 validation. */
export type InvoiceKind = "bolt11" | "lnurl" | "ln-address";

/**
 * Classify an invoice string. Lightweight heuristics — no full bolt11 parse
 * (that needs the `lightning-invoice` crate; consumers can add it later).
 * Returns the kind, or null when it matches none.
 */
export function classifyInvoice(input: string): InvoiceKind | null {
  const trimmed = input.trim();
  if (trimmed.startsWith("lnbc") || trimmed.startsWith("lnbcrt") || trimmed.startsWith("lntb")) {
    return "bolt11";
  }
  if (trimmed.startsWith("lnurl1")) {
    return "lnurl";
  }
  if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(trimmed)) {
    return "ln-address";
  }
  return null;
}

/**
 * Basic bolt11 validation: must match the HRP shape and have a plausible size.
 * Amount/expiry are read by bolt11AmountMsat / invoiceExpired below; full
 * signature checks still belong to a real bolt11 parser.
 */
export function isProbablyValidBolt11(paymentRequest: string): boolean {
  const trimmed = paymentRequest.trim();
  return /^ln(bc|tb|bcrt|sb)[0-9a-z]+$/i.test(trimmed) && trimmed.length > 20;
}

const BOLT11_HRP = /^ln(?:bc|tb|bcrt|sb)(\d*)([munp]?)1/i;
const BECH32_CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
const BOLT11_SIG_CHARS = 104;

/**
 * Decode the amount encoded in a bolt11 invoice's human-readable part.
 * Returns millisatoshis, or null for an amountless/invalid invoice.
 */
export function bolt11AmountMsat(paymentRequest: string): number | null {
  const m = BOLT11_HRP.exec(paymentRequest.trim().toLowerCase());
  if (!m || m[1] === "") {
    return null;
  }
  const amount = Number(m[1]);
  if (!Number.isFinite(amount) || amount <= 0) {
    return null;
  }
  switch (m[2]) {
    case "":
      return Math.round(amount * 1e11);
    case "m":
      return Math.round(amount * 1e8);
    case "u":
      return Math.round(amount * 1e5);
    case "n":
      return Math.round(amount * 1e2);
    case "p":
      return Math.round(amount * 0.1);
    default:
      return null;
  }
}

/** Decode the 35-bit creation timestamp from a bolt11 invoice, or null. */
export function bolt11Timestamp(paymentRequest: string): number | null {
  const s = paymentRequest.trim().toLowerCase();
  const m = BOLT11_HRP.exec(s);
  if (!m) {
    return null;
  }
  const data = s.slice(m[0].length);
  if (data.length < 7) {
    return null;
  }
  let acc = 0;
  for (let i = 0; i < 7; i++) {
    const v = BECH32_CHARSET.indexOf(data[i]!);
    if (v < 0) {
      return null;
    }
    acc = acc * 32 + v;
  }
  return acc;
}

/** Best-effort expiry check using the `x` tag, defaulting to 3600s. */
export function invoiceExpired(
  paymentRequest: string,
  now = Math.floor(Date.now() / 1000),
): boolean | null {
  const ts = bolt11Timestamp(paymentRequest);
  if (ts === null) {
    return null;
  }
  return now > ts + (bolt11ExpirySeconds(paymentRequest) ?? 3600);
}

function bolt11ExpirySeconds(paymentRequest: string): number | null {
  const s = paymentRequest.trim().toLowerCase();
  const m = BOLT11_HRP.exec(s);
  if (!m) {
    return null;
  }
  const data = s.slice(m[0].length);
  const end = data.length - BOLT11_SIG_CHARS;
  let pos = 7;
  while (pos + 3 <= end) {
    const tag = BECH32_CHARSET.indexOf(data[pos]!);
    const len = BECH32_CHARSET.indexOf(data[pos + 1]!) * 32 + BECH32_CHARSET.indexOf(data[pos + 2]!);
    if (tag < 0 || len < 0) {
      return null;
    }
    const start = pos + 3;
    const stop = start + len;
    if (stop > end) {
      return null;
    }
    if (tag === BECH32_CHARSET.indexOf("x")) {
      let acc = 0;
      for (let i = start; i < stop; i++) {
        const v = BECH32_CHARSET.indexOf(data[i]!);
        if (v < 0) {
          return null;
        }
        acc = acc * 32 + v;
      }
      return acc;
    }
    pos = stop;
  }
  return null;
}

/**
 * Build the PaymentRequest payload for an invoice string, mirroring
 * `payment_request_payload_for_invoice`: LNURL/LN-address are sent as-is
 * (after reachability is checked by the caller), bolt11 is normalized.
 *
 * Returns null when the input matches no invoice kind.
 */
export function invoicePayload(invoice: string): Payload | null {
  const trimmed = invoice.trim();
  const kind = classifyInvoice(trimmed);
  if (kind === null) {
    return null;
  }
  if (kind === "bolt11" && !isProbablyValidBolt11(trimmed)) {
    return null;
  }
  return { variant: "payment_request", value: [null, trimmed, null] };
}

/** Build a Message::Order(AddInvoice | AddBondInvoice) carrying the invoice. */
export function buildInvoiceMessage(input: {
  orderId: string;
  requestId: number;
  action: "add-invoice" | "add-bond-invoice";
  invoice: string;
}): Message {
  const payload = invoicePayload(input.invoice);
  if (!payload) {
    throw new Error("Invalid invoice: expected bolt11, lnurl, or lightning address");
  }
  const message = newOrderMessage(input.orderId, input.requestId, null, input.action, payload);
  if (!verifyMessageKind(message.value)) {
    throw new Error(`built ${input.action} message failed verification`);
  }
  return message;
}

/**
 * Validate the reply to an AddInvoice submit. Mostro must answer
 * `WaitingSellerToPay` or `HoldInvoicePaymentAccepted`; anything else is an
 * error (timeout is NOT treated as success). Mirrors execute_payment_request_reply.
 */
export function handleAddInvoiceResponse(
  kind: MessageKind,
  expectedRequestId: number,
): "accepted" {
  if (kind.request_id === null) {
    throw new Error("Response with null request_id");
  }
  if (kind.request_id !== expectedRequestId) {
    throw new Error("Mismatched request_id");
  }
  if (kind.action !== "waiting-seller-to-pay" && kind.action !== "hold-invoice-payment-accepted") {
    throw new Error(`Unexpected action: ${kind.action}`);
  }
  return "accepted";
}

/**
 * Validate the reply to an AddBondInvoice submit and map it to the next UI
 * step. Mirrors `operation_result_from_bond_invoice_reply`:
 * - PayInvoice/PayBondInvoice + invoice → hold/bond invoice popup
 * - WaitingBuyerInvoice/AddInvoice/WaitingSellerToPay/... → open invoice popup
 * - timeout/empty → success ack (bond reply is async)
 */
export function handleAddBondInvoiceResponse(
  kind: MessageKind,
  expectedRequestId: number,
): "ack" | "hold-invoice" | "open-invoice" {
  if (kind.request_id !== null && kind.request_id !== expectedRequestId) {
    throw new Error("Mismatched request_id");
  }
  switch (kind.action) {
    case "pay-invoice":
    case "pay-bond-invoice":
      return "hold-invoice";
    case "waiting-buyer-invoice":
    case "add-invoice":
    case "waiting-seller-to-pay":
    case "hold-invoice-payment-accepted":
    case "buyer-invoice-accepted":
      return "open-invoice";
    default:
      return "ack";
  }
}

export type { Action };