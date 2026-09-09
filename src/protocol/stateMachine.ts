// Order status state machine — actor-aware phase graph.
// Ported from mostrix `src/util/order_utils/helper.rs`
// (should_apply_status_transition, status_phase_rank_for_actor,
// is_terminal_trade_status, inferred_status_from_trade_action,
// map_action_to_status).

import type { Action } from "./action.js";
import type { Kind, Status, SmallOrder } from "./order.js";
import { statusFromString } from "./status.js";
import { kindFromString } from "./kind.js";

/** Statuses that are sticky once reached. */
export function isTerminalTradeStatus(status: Status): boolean {
  switch (status) {
    case "canceled":
    case "canceled-by-admin":
    case "settled-by-admin":
    case "completed-by-admin":
    case "expired":
    case "cooperatively-canceled":
    case "success":
      return true;
    default:
      return false;
  }
}

/**
 * Phase rank per actor (maker/taker share the same order — kind decides the
 * waiting-* ordering). Mirrors `status_phase_rank_for_actor`.
 */
export function statusPhaseRankForActor(status: Status, kind: Kind | null): number | null {
  switch (status) {
    case "pending":
    case "waiting-taker-bond":
    case "waiting-maker-bond":
      return 0;
    case "waiting-payment":
      return kind === "buy" ? 1 : kind === "sell" ? 2 : null;
    case "waiting-buyer-invoice":
      return kind === "buy" ? 2 : kind === "sell" ? 1 : null;
    case "in-progress":
    case "active":
      return 3;
    case "fiat-sent":
      return 4;
    case "settled-hold-invoice":
      return 5;
    case "success":
      return 6;
    default:
      return null;
  }
}

/**
 * Returns true when `candidate` is equal/newer than `current` in the
 * actor-aware phase graph. Terminal states are sticky: once terminal, only
 * the same terminal status is accepted — except post-retry AddInvoice, which
 * may reopen Success → SettledHoldInvoice.
 *
 * `action` comes from the DM being applied. Relay reconcile (no action) must
 * pass `null` so completed orders are never reopened from snapshots alone.
 */
export function shouldApplyStatusTransition(
  current: Status | null,
  candidate: Status,
  kind: Kind | null,
  action: Action | null,
): boolean {
  if (current === null) {
    return true;
  }
  if (current === candidate) {
    return true;
  }
  if (isTerminalTradeStatus(current)) {
    // Only the post-retry replacement-invoice DM may reopen Success →
    // SettledHoldInvoice. Release / Released / HoldInvoicePaymentSettled
    // must stay blocked.
    return (
      action === "add-invoice" &&
      current === "success" &&
      candidate === "settled-hold-invoice"
    );
  }
  if (isTerminalTradeStatus(candidate)) {
    return true;
  }
  const curRank = statusPhaseRankForActor(current, kind);
  const candRank = statusPhaseRankForActor(candidate, kind);
  if (curRank !== null && candRank !== null) {
    return candRank >= curRank;
  }
  // Unknown transition edge: keep existing status (safer than downgrade).
  return false;
}

/**
 * Like shouldApplyStatusTransition, but never treats equal status as an
 * advance. Use when an older Nostr timestamp must not replace the row unless
 * strictly newer.
 */
export function shouldStrictlyAdvanceStatus(
  current: Status | null,
  candidate: Status,
  kind: Kind | null,
  action: Action | null,
): boolean {
  if (current !== null && current === candidate) {
    return false;
  }
  return shouldApplyStatusTransition(current, candidate, kind, action);
}

/**
 * Infer Status from the message action when there is no SmallOrder payload
 * (e.g. daemon sends action "canceled" with payload null but id on the kind).
 */
export function inferredStatusFromTradeAction(action: Action): Status | null {
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
      // Seller release settles the hold invoice and starts the buyer payout.
      return "settled-hold-invoice";
    case "purchase-completed":
      return "success";
    default:
      return null;
  }
}

/**
 * Map a Mostro Action plus the current SmallOrder into a new Status when the
 * transition is clear. If the order carries an explicit status from Mostro,
 * prefer that.
 */
export function mapActionToStatus(action: Action, order: SmallOrder): Status | null {
  if (order.status) {
    return order.status;
  }
  return inferredStatusFromTradeAction(action);
}

/** Parse a kebab-case status string; null when unknown. */
export function parseStatus(s: string | null | undefined): Status | null {
  if (!s) {
    return null;
  }
  return statusFromString(s);
}

/** Parse a kebab-case kind string; null when unknown. */
export function parseKind(s: string | null | undefined): Kind | null {
  if (!s) {
    return null;
  }
  return kindFromString(s);
}