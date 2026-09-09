// Inbound trade-DM applicator — applies a decrypted Mostro DM to local state.
// Ported from mostrix `src/util/dm_utils/mod.rs` (handle_trade_dm_for_order,
// upsert_order_from_trade_dm). TUI/messages-list concerns are omitted; this
// keeps the Store authoritative.

import type { Message, MessageKind, Payload, SmallOrder } from "./index.js";
import type { Action } from "./action.js";
import type { Store } from "./store.js";
import {
  shouldApplyStatusTransition,
  mapActionToStatus,
  parseStatus,
  parseKind,
} from "./stateMachine.js";
import { deriveChatKeys } from "./chatKeys.js";
import type { Kind } from "./kind.js";

/** Order payloads that carry an order snapshot to upsert. */
function smallOrderFromPayload(action: string, payload: Payload | null): SmallOrder | null {
  switch (action) {
    case "add-invoice":
    case "buyer-took-order":
    case "hold-invoice-payment-accepted":
    case "new-order":
      return payload?.variant === "order" ? payload.value : null;
    case "pay-invoice":
    case "pay-bond-invoice":
      return payload?.variant === "payment_request" ? payload.value[0] : null;
    case "add-bond-invoice":
      return payload?.variant === "bond_payout_request" ? payload.value.order : null;
    default:
      return null;
  }
}

/** Resolve a candidate status from action + payload (mostrix resolved_status_candidate). */
function resolvedStatusCandidate(action: Action, payload: Payload | null): string | null {
  const order = smallOrderFromPayload(action, payload);
  if (order) {
    return mapActionToStatus(action, order) ?? order.status;
  }
  switch (action) {
    case "canceled":
      return "canceled";
    case "cooperative-cancel-accepted":
      return "cooperatively-canceled";
    case "waiting-buyer-invoice":
    case "add-invoice":
      return "waiting-buyer-invoice";
    case "waiting-seller-to-pay":
    case "pay-invoice":
      return "waiting-payment";
    case "pay-bond-invoice":
      return "waiting-taker-bond";
    case "admin-canceled":
      return "canceled-by-admin";
    case "fiat-sent-ok":
      return "fiat-sent";
    case "release":
    case "released":
    case "hold-invoice-payment-settled":
      return "settled-hold-invoice";
    case "purchase-completed":
      return "success";
    default:
      return null;
  }
}

export interface AppliedDmResult {
  orderId: string;
  action: string;
  /** Status applied to the order (null when none). */
  status: string | null;
  /** Dispute id persisted (when the DM carried one). */
  disputeId: string | null;
  /** Solver pubkey + derived chat key persisted (AdminTookDispute). */
  solver: { pubkey: string; sharedKeyHex: string } | null;
  /** True when the DM carried an order snapshot and it was persisted. */
  orderUpserted: boolean;
}

/**
 * Apply a Mostro trade DM to the Store. Handles:
 * - order upsert from order-carrying payloads (monotonic status guard)
 * - dispute_id persistence on DisputeInitiatedByYou/Peer
 * - solver chat key derivation on AdminTookDispute
 *
 * Returns what was applied so callers can drive UI updates.
 */
export async function applyTradeDm(params: {
  store: Store;
  orderId: string;
  /** Trade secret for this order (for solver chat key derivation). */
  tradeSecretHex: string;
  message: Message;
}): Promise<AppliedDmResult> {
  const { store, orderId, tradeSecretHex, message } = params;
  const kind: MessageKind = message.value;
  const action = kind.action;

  const existing = await store.getOrder(orderId);
  const currentStatus = existing ? parseStatus(existing.status) : null;
  const kindType: Kind | null = existing ? parseKind(existing.kind) : null;

  const statusCandidate = action === "cant-do" ? null : resolvedStatusCandidate(action, kind.payload);
  const candidate = statusCandidate ? parseStatus(statusCandidate) : null;

  // Decide the status this DM may apply (monotonic guard), BEFORE persisting so
  // the saved row never regresses. CantDo carries no status.
  const transitionOk =
    candidate !== null &&
    (action === "cant-do" ||
      shouldApplyStatusTransition(currentStatus, candidate, kindType, action));
  const appliedStatus = transitionOk ? statusCandidate : null;

  let orderUpserted = false;
  // Persist order snapshot (skip CantDo — never apply its payload status).
  const smallOrder = smallOrderFromPayload(action, kind.payload);
  if (smallOrder && smallOrder.id) {
    await store.saveOrder({
      id: orderId,
      kind: smallOrder.kind,
      status: appliedStatus ?? existing?.status ?? null,
      amount: smallOrder.amount,
      fiat_code: smallOrder.fiat_code,
      min_amount: smallOrder.min_amount,
      max_amount: smallOrder.max_amount,
      fiat_amount: smallOrder.fiat_amount,
      payment_method: smallOrder.payment_method,
      premium: smallOrder.premium,
      trade_keys: existing?.trade_keys ?? "",
      counterparty_pubkey: existing?.counterparty_pubkey ?? null,
      is_mine: existing?.is_mine === 1,
      buyer_invoice: smallOrder.buyer_invoice,
      request_id: kind.request_id,
      trade_index: existing?.trade_index ?? kind.trade_index ?? 0,
      created_at: existing?.created_at ?? smallOrder.created_at,
      expires_at: smallOrder.expires_at,
    });
    orderUpserted = true;
  } else if (transitionOk && appliedStatus) {
    // No order payload but a status transition applies (e.g. canceled with
    // null payload).
    await store.updateOrderStatus(orderId, appliedStatus);
  }

  // Dispute id persistence.
  let disputeId: string | null = null;
  if (
    (action === "dispute-initiated-by-you" || action === "dispute-initiated-by-peer") &&
    kind.payload?.variant === "dispute"
  ) {
    disputeId = kind.payload.value[0];
    await store.updateDisputeId(orderId, disputeId);
  }

  // Solver chat key on AdminTookDispute (peer = solver pubkey).
  let solver: { pubkey: string; sharedKeyHex: string } | null = null;
  if (action === "admin-took-dispute" && kind.payload?.variant === "peer") {
    const solverPubkey = kind.payload.value.pubkey;
    const chat = deriveChatKeys(tradeSecretHex, solverPubkey);
    solver = { pubkey: solverPubkey, sharedKeyHex: chat.convSecretHex };
    // Persist solver pubkey + shared key for user<->solver dispute chat.
    await store.updateSolverChat(orderId, solverPubkey, chat.convSecretHex);
  }

  return { orderId, action, status: appliedStatus, disputeId, solver, orderUpserted };
}