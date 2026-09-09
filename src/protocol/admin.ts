// Admin dispute actions — messages sent over the Mostro dispute channel.
// Ported from mostrix `src/util/order_utils/execute_admin_*.rs` and
// `execute_take_dispute.rs`.

import type { Action } from "./action.js";
import { newDisputeMessage } from "./message.js";
import type { Message, MessageKind, Payload } from "./message.js";
import { verifyMessageKind } from "./verify.js";
import { hexToNpub } from "./npub.js";

/** Slash decisions carried by AdminSettle / AdminCancel. */
export interface BondSlash {
  slashSeller: boolean;
  slashBuyer: boolean;
}

/** No bond slashed (release-by-default). */
export const NO_SLASH: BondSlash = { slashSeller: false, slashBuyer: false };

/** Convert a BondSlash choice to an optional payload (null = no slash). */
export function bondSlashToPayload(bond: BondSlash): Payload | null {
  if (!bond.slashSeller && !bond.slashBuyer) {
    return null;
  }
  return {
    variant: "bond_resolution",
    value: { slash_seller: bond.slashSeller, slash_buyer: bond.slashBuyer },
  };
}

/** Build a Message::Dispute for admin actions. */
function buildAdminMessage(
  id: string,
  requestId: number | null,
  action: Action,
  payload: Payload | null,
): Message {
  const message = newDisputeMessage(id, requestId, null, action, payload);
  if (!verifyMessageKind(message.value)) {
    throw new Error(`built ${action} message failed verification`);
  }
  return message;
}

/** Build AdminTakeDispute (solver takes ownership of a dispute). */
export function buildTakeDisputeMessage(disputeId: string): Message {
  return buildAdminMessage(disputeId, null, "admin-take-dispute", null);
}

/** Build AdminSettle (pay buyer; optional bond slash). */
export function buildAdminSettleMessage(orderId: string, requestId: number, bond?: BondSlash): Message {
  return buildAdminMessage(orderId, requestId, "admin-settle", bond ? bondSlashToPayload(bond) : null);
}

/** Build AdminCancel (refund seller; optional bond slash). */
export function buildAdminCancelMessage(orderId: string, requestId: number, bond?: BondSlash): Message {
  return buildAdminMessage(orderId, requestId, "admin-cancel", bond ? bondSlashToPayload(bond) : null);
}

/**
 * Build AdminAddSolver. Payload is `TextMessage("<npub>:read" | "<npub>")`;
 * a `:read` suffix means read-only permission, otherwise read-write.
 * Hex pubkeys are converted to npub (the daemon only accepts bech32 here).
 */
export function buildAddSolverMessage(
  solverPubkey: string,
  requestId: number,
  permission: "read" | "read-write",
): Message {
  const normalized = solverPubkey.startsWith("npub1") ? solverPubkey : hexToNpub(solverPubkey) ?? solverPubkey;
  const text = permission === "read" ? `${normalized}:read` : normalized;
  return buildAdminMessage(cryptoRandomUuid(), requestId, "admin-add-solver", {
    variant: "text_message",
    value: text,
  });
}

/** Random v4 UUID (id for AddSolver dispute message). */
function cryptoRandomUuid(): string {
  return crypto.randomUUID();
}

/**
 * Validate the reply to an admin settle/cancel. Mostro answers AdminSettled /
 * AdminCanceled, or CooperativeCancelAccepted when already canceled.
 */
export function handleAdminFinalizeResponse(
  kind: MessageKind,
  expectedRequestId: number,
  expected: "admin-settled" | "admin-canceled",
): "confirmed" | "already-cooperatively-canceled" {
  if (kind.request_id === null) {
    throw new Error("Response with null request_id");
  }
  if (kind.request_id !== expectedRequestId) {
    throw new Error("Mismatched request_id");
  }
  if (kind.action === expected) {
    return "confirmed";
  }
  if (kind.action === "cooperative-cancel-accepted") {
    return "already-cooperatively-canceled";
  }
  throw new Error(`Unexpected action in response: ${kind.action}`);
}

/** Validate the reply to AdminTakeDispute: expected AdminTookDispute. */
export function handleTakeDisputeResponse(kind: MessageKind): void {
  if (kind.action !== "admin-took-dispute") {
    throw new Error(`Unexpected action in response: ${kind.action}`);
  }
}