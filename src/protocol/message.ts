// Protocol message envelope exchanged between clients and a Mostro node.
// Ported from mostro-core 0.14.3 `src/message.rs`.

import { PROTOCOL_VER } from "./constants.js";
import type { Action } from "./action.js";
import type { SmallOrder } from "./order.js";
import type { CantDoReason } from "./cantDo.js";
import type { SolverDisputeInfo, UserInfo } from "./dispute.js";

// ---------------------------------------------------------------------------
// Auxiliary structs
// ---------------------------------------------------------------------------

/** Identity of a counterpart in a trade. */
export interface Peer {
  /** Trade public key of the peer (hex or npub). */
  pubkey: string;
  /** Optional reputation snapshot. Absent in full privacy mode. */
  reputation: UserInfo | null;
}

export function newPeer(pubkey: string, reputation: UserInfo | null): Peer {
  return { pubkey, reputation };
}

/** Retry configuration for a failed Lightning payment. */
export interface PaymentFailedInfo {
  payment_attempts: number;
  payment_retries_interval: number;
}

/** Minimal per-order information returned on session restore. */
export interface RestoredOrdersInfo {
  order_id: string;
  trade_index: number;
  status: string;
}

/** Identifies which party of an order opened a dispute (serde lowercase). */
export const DisputeInitiator = {
  Buyer: "buyer",
  Seller: "seller",
} as const;

export type DisputeInitiator = (typeof DisputeInitiator)[keyof typeof DisputeInitiator];

/** Minimal per-dispute information returned on session restore. */
export interface RestoredDisputesInfo {
  dispute_id: string;
  order_id: string;
  trade_index: number;
  status: string;
  initiator: DisputeInitiator | null;
  solver_pubkey: string | null;
}

/** Bundle of orders and disputes returned on a session restore. */
export interface RestoreSessionInfo {
  orders: RestoredOrdersInfo[];
  disputes: RestoredDisputesInfo[];
}

/** Bond resolution carried by AdminSettle / AdminCancel. */
export interface BondResolution {
  slash_seller: boolean;
  slash_buyer: boolean;
}

/** Outbound side of the bond payout invoice request (AddBondInvoice). */
export interface BondPayoutRequest {
  order: SmallOrder;
  /** Unix timestamp (seconds, UTC) at which Mostro recorded the slash. */
  slashed_at: number;
}

/** Cashu 2-of-3 multisig escrow lock submitted by the seller. */
export interface CashuLockProof {
  token: string;
  mint_url: string;
  buyer_pubkey: string;
  seller_pubkey: string;
  mostro_pubkey: string;
  /** Optional fee token; omitted from the wire form when absent. */
  fee_token: string | null;
}

/** Mostro's P_M signature for a single escrowed proof. */
export interface CashuProofSignature {
  secret: string;
  signature: string;
}

// ---------------------------------------------------------------------------
// Payload
// ---------------------------------------------------------------------------

/** Typed payload attached to a MessageKind. Serialized as snake_case. */
export type Payload =
  | { variant: "order"; value: SmallOrder }
  | { variant: "payment_request"; value: [SmallOrder | null, string, number | null] }
  | { variant: "text_message"; value: string }
  | { variant: "peer"; value: Peer }
  | { variant: "rating_user"; value: number }
  | { variant: "amount"; value: number }
  | { variant: "dispute"; value: [string, SolverDisputeInfo | null] }
  | { variant: "cant_do"; value: CantDoReason | null }
  | { variant: "next_trade"; value: [string, number] }
  | { variant: "payment_failed"; value: PaymentFailedInfo }
  | { variant: "restore_data"; value: RestoreSessionInfo }
  | { variant: "ids"; value: string[] }
  | { variant: "orders"; value: SmallOrder[] }
  | { variant: "bond_resolution"; value: BondResolution }
  | { variant: "bond_payout_request"; value: BondPayoutRequest }
  | { variant: "cashu_lock_proof"; value: CashuLockProof }
  | { variant: "cashu_signatures"; value: CashuProofSignature[] };

// ---------------------------------------------------------------------------
// MessageKind & Message
// ---------------------------------------------------------------------------

/** Body shared by every Message variant. */
export interface MessageKind {
  /** Mostro protocol version. */
  version: number;
  /** Client-chosen correlation id, echoed back on responses. */
  request_id: number | null;
  /** Trade index attached to this message. */
  trade_index: number | null;
  /** Optional target identifier (order or dispute id). */
  id: string | null;
  /** Verb of the message. */
  action: Action;
  /** Payload attached to the action. */
  payload: Payload | null;
}

/** Top-level Mostro message. Tagged union, serialized as kebab-case. */
export type Message =
  | { variant: "order"; value: MessageKind }
  | { variant: "dispute"; value: MessageKind }
  | { variant: "cant-do"; value: MessageKind }
  | { variant: "rate"; value: MessageKind }
  | { variant: "dm"; value: MessageKind }
  | { variant: "restore"; value: MessageKind };

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

export function newMessageKind(
  id: string | null,
  requestId: number | null,
  tradeIndex: number | null,
  action: Action,
  payload: Payload | null,
): MessageKind {
  return {
    version: PROTOCOL_VER,
    request_id: requestId,
    trade_index: tradeIndex,
    id,
    action,
    payload,
  };
}

export function newOrderMessage(
  id: string | null,
  requestId: number | null,
  tradeIndex: number | null,
  action: Action,
  payload: Payload | null,
): Message {
  return { variant: "order", value: newMessageKind(id, requestId, tradeIndex, action, payload) };
}

export function newDisputeMessage(
  id: string | null,
  requestId: number | null,
  tradeIndex: number | null,
  action: Action,
  payload: Payload | null,
): Message {
  return { variant: "dispute", value: newMessageKind(id, requestId, tradeIndex, action, payload) };
}

/** Build a new Message::Restore with Action::RestoreSession. Payload must be null. */
export function newRestoreMessage(payload: Payload | null): Message {
  return { variant: "restore", value: newMessageKind(null, null, null, "restore-session", payload) };
}

/** Build a new Message::CantDo message (a structured refusal sent by Mostro). */
export function cantDoMessage(id: string | null, requestId: number | null, payload: Payload | null): Message {
  return { variant: "cant-do", value: newMessageKind(id, requestId, null, "cant-do", payload) };
}

/** Build a new Message::Dm carrying a direct message between users. */
export function newDmMessage(
  id: string | null,
  requestId: number | null,
  action: Action,
  payload: Payload | null,
): Message {
  return { variant: "dm", value: newMessageKind(id, requestId, null, action, payload) };
}

/** Borrow the inner MessageKind regardless of the variant. */
export function getInnerMessageKind(message: Message): MessageKind {
  return message.value;
}

/** Return the Action of the inner MessageKind. */
export function innerAction(message: Message): Action {
  return message.value.action;
}