// Wire JSON (de)serialization mirroring serde behavior in mostro-core.
//
// Faithful details:
// - Message variants (kebab-case): order, dispute, cant-do, rate, dm, restore.
// - MessageKind fields in declaration order; `id` omitted when null
//   (skip_serializing_if), request_id/trade_index/payload emit null.
// - Payload variants (snake_case), tuple payloads serialize as JSON arrays.
// - SmallOrder: id/buyer_trade_pubkey/seller_trade_pubkey/buyer_invoice
//   omitted when null; kind/status/min_amount/max_amount/created_at/expires_at
//   emit null (no skip_serializing_if).

import type { Kind } from "./kind.js";
import type { Status } from "./status.js";
import type {
  BondPayoutRequest,
  BondResolution,
  CashuLockProof,
  CashuProofSignature,
  Message,
  MessageKind,
  Payload,
  Peer,
  RestoreSessionInfo,
} from "./message.js";
import type { SolverDisputeInfo, UserInfo } from "./dispute.js";
import type { CantDoReason } from "./cantDo.js";
import type { SmallOrder } from "./order.js";

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------

export function serializeMessage(message: Message): string {
  return JSON.stringify(messageToJson(message));
}

export function messageToJson(message: Message): Record<string, unknown> {
  return { [message.variant]: messageKindToJson(message.value) };
}

export function messageKindToJson(kind: MessageKind): Record<string, unknown> {
  const out: Record<string, unknown> = {
    version: kind.version,
    request_id: kind.request_id,
    trade_index: kind.trade_index,
  };
  if (kind.id !== null) {
    out.id = kind.id;
  }
  out.action = kind.action;
  out.payload = kind.payload === null ? null : payloadToJson(kind.payload);
  return out;
}

export function payloadToJson(payload: Payload): unknown {
  switch (payload.variant) {
    case "order":
      return { order: smallOrderToJson(payload.value) };
    case "payment_request": {
      const [order, invoice, amount] = payload.value;
      return {
        payment_request: [order === null ? null : smallOrderToJson(order), invoice, amount],
      };
    }
    case "text_message":
      return { text_message: payload.value };
    case "peer":
      return { peer: peerToJson(payload.value) };
    case "rating_user":
      return { rating_user: payload.value };
    case "amount":
      return { amount: payload.value };
    case "dispute": {
      const [id, info] = payload.value;
      return { dispute: [id, info === null ? null : solverDisputeInfoToJson(info)] };
    }
    case "cant_do":
      return { cant_do: payload.value };
    case "next_trade":
      return { next_trade: [payload.value[0], payload.value[1]] };
    case "payment_failed":
      return { payment_failed: { ...payload.value } };
    case "restore_data":
      return { restore_data: restoreSessionInfoToJson(payload.value) };
    case "ids":
      return { ids: [...payload.value] };
    case "orders":
      return { orders: payload.value.map(smallOrderToJson) };
    case "bond_resolution":
      return { bond_resolution: { ...payload.value } };
    case "bond_payout_request":
      return { bond_payout_request: bondPayoutRequestToJson(payload.value) };
    case "cashu_lock_proof":
      return { cashu_lock_proof: cashuLockProofToJson(payload.value) };
    case "cashu_signatures":
      return { cashu_signatures: payload.value.map(cashuProofSignatureToJson) };
  }
}

function peerToJson(peer: Peer): Record<string, unknown> {
  const out: Record<string, unknown> = { pubkey: peer.pubkey };
  if (peer.reputation !== null) {
    out.reputation = userInfoToJson(peer.reputation);
  }
  return out;
}

export function smallOrderToJson(order: SmallOrder): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (order.id !== null) {
    out.id = order.id;
  }
  out.kind = order.kind;
  out.status = order.status;
  out.amount = order.amount;
  out.fiat_code = order.fiat_code;
  out.min_amount = order.min_amount;
  out.max_amount = order.max_amount;
  out.fiat_amount = order.fiat_amount;
  out.payment_method = order.payment_method;
  out.premium = order.premium;
  if (order.buyer_trade_pubkey !== null) {
    out.buyer_trade_pubkey = order.buyer_trade_pubkey;
  }
  if (order.seller_trade_pubkey !== null) {
    out.seller_trade_pubkey = order.seller_trade_pubkey;
  }
  if (order.buyer_invoice !== null) {
    out.buyer_invoice = order.buyer_invoice;
  }
  out.created_at = order.created_at;
  out.expires_at = order.expires_at;
  return out;
}

function userInfoToJson(info: UserInfo): Record<string, unknown> {
  return { ...info };
}

function solverDisputeInfoToJson(info: SolverDisputeInfo): Record<string, unknown> {
  const out: Record<string, unknown> = {
    id: info.id,
    kind: info.kind,
    status: info.status,
    hash: info.hash,
    preimage: info.preimage,
    order_previous_status: info.order_previous_status,
    initiator_pubkey: info.initiator_pubkey,
    buyer_pubkey: info.buyer_pubkey,
    seller_pubkey: info.seller_pubkey,
    initiator_full_privacy: info.initiator_full_privacy,
    counterpart_full_privacy: info.counterpart_full_privacy,
    initiator_info: info.initiator_info === null ? null : userInfoToJson(info.initiator_info),
    counterpart_info: info.counterpart_info === null ? null : userInfoToJson(info.counterpart_info),
    premium: info.premium,
    payment_method: info.payment_method,
    amount: info.amount,
    fiat_amount: info.fiat_amount,
    fee: info.fee,
    routing_fee: info.routing_fee,
    buyer_invoice: info.buyer_invoice,
    invoice_held_at: info.invoice_held_at,
    taken_at: info.taken_at,
    created_at: info.created_at,
  };
  return out;
}

function restoreSessionInfoToJson(info: RestoreSessionInfo): Record<string, unknown> {
  return {
    orders: info.orders.map((o) => ({ ...o })),
    disputes: info.disputes.map((d) => ({ ...d })),
  };
}

function bondPayoutRequestToJson(r: BondPayoutRequest): Record<string, unknown> {
  return { order: smallOrderToJson(r.order), slashed_at: r.slashed_at };
}

function cashuLockProofToJson(p: CashuLockProof): Record<string, unknown> {
  const out: Record<string, unknown> = {
    token: p.token,
    mint_url: p.mint_url,
    buyer_pubkey: p.buyer_pubkey,
    seller_pubkey: p.seller_pubkey,
    mostro_pubkey: p.mostro_pubkey,
  };
  if (p.fee_token !== null) {
    out.fee_token = p.fee_token;
  }
  return out;
}

function cashuProofSignatureToJson(s: CashuProofSignature): Record<string, unknown> {
  return { secret: s.secret, signature: s.signature };
}

// ---------------------------------------------------------------------------
// Deserialization
// ---------------------------------------------------------------------------

export function deserializeMessage(json: string): Message {
  const parsed: unknown = JSON.parse(json);
  return messageFromJson(parsed);
}

export function messageFromJson(parsed: unknown): Message {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Message must be a JSON object");
  }
  const keys = Object.keys(parsed as Record<string, unknown>);
  if (keys.length !== 1) {
    throw new Error("Message must have exactly one variant key");
  }
  const variant = keys[0]!;
  const value = (parsed as Record<string, unknown>)[variant];
  const kind = messageKindFromJson(value);
  switch (variant) {
    case "order":
    case "dispute":
    case "cant-do":
    case "rate":
    case "dm":
    case "restore":
      return { variant, value: kind } as Message;
    default:
      throw new Error(`Unknown message variant: ${variant}`);
  }
}

export function messageKindFromJson(parsed: unknown): MessageKind {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("MessageKind must be an object");
  }
  const obj = parsed as Record<string, unknown>;
  const version = obj.version;
  const action = obj.action;
  const request_id = obj.request_id ?? null;
  const trade_index = obj.trade_index ?? null;
  const id = obj.id ?? null;
  if (typeof version !== "number") {
    throw new Error("MessageKind.version must be a number");
  }
  if (typeof action !== "string") {
    throw new Error("MessageKind.action must be a string");
  }
  return {
    version,
    request_id: (request_id as number | null) ?? null,
    trade_index: (trade_index as number | null) ?? null,
    id: (id as string | null) ?? null,
    action: action as MessageKind["action"],
    payload: obj.payload === null || obj.payload === undefined ? null : payloadFromJson(obj.payload),
  };
}

export function payloadFromJson(parsed: unknown): Payload {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Payload must be an object");
  }
  const obj = parsed as Record<string, unknown>;
  const keys = Object.keys(obj);
  if (keys.length !== 1) {
    throw new Error("Payload must have exactly one variant key");
  }
  const variant = keys[0]!;
  const value = obj[variant];

  switch (variant) {
    case "order":
      return { variant: "order", value: smallOrderFromJson(value) };
    case "payment_request":
      return {
        variant: "payment_request",
        value: paymentRequestFromJson(value),
      };
    case "text_message":
      return { variant: "text_message", value: requireString(value) };
    case "peer":
      return { variant: "peer", value: peerFromJson(value) };
    case "rating_user":
      return { variant: "rating_user", value: requireNumber(value) };
    case "amount":
      return { variant: "amount", value: requireNumber(value) };
    case "dispute":
      return { variant: "dispute", value: disputeTupleFromJson(value) };
    case "cant_do":
      return {
        variant: "cant_do",
        value: value === null ? null : (requireString(value) as CantDoReason),
      };
    case "next_trade":
      return { variant: "next_trade", value: nextTradeFromJson(value) };
    case "payment_failed":
      return { variant: "payment_failed", value: paymentFailedFromJson(value) };
    case "restore_data":
      return { variant: "restore_data", value: restoreSessionInfoFromJson(value) };
    case "ids":
      return { variant: "ids", value: stringArrayFromJson(value) };
    case "orders":
      return { variant: "orders", value: smallOrderArrayFromJson(value) };
    case "bond_resolution":
      return { variant: "bond_resolution", value: bondResolutionFromJson(value) };
    case "bond_payout_request":
      return { variant: "bond_payout_request", value: bondPayoutRequestFromJson(value) };
    case "cashu_lock_proof":
      return { variant: "cashu_lock_proof", value: cashuLockProofFromJson(value) };
    case "cashu_signatures":
      return { variant: "cashu_signatures", value: cashuProofSignatureArrayFromJson(value) };
    default:
      throw new Error(`Unknown payload variant: ${variant}`);
  }
}

function smallOrderFromJson(parsed: unknown): SmallOrder {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("SmallOrder must be an object");
  }
  const o = parsed as Record<string, unknown>;
  return {
    id: (o.id as string | null) ?? null,
    kind: (o.kind as Kind | null) ?? null,
    status: (o.status as Status | null) ?? null,
    amount: requireNumber(o.amount),
    fiat_code: requireString(o.fiat_code),
    min_amount: (o.min_amount as number | null) ?? null,
    max_amount: (o.max_amount as number | null) ?? null,
    fiat_amount: requireNumber(o.fiat_amount),
    payment_method: requireString(o.payment_method),
    premium: requireNumber(o.premium),
    buyer_trade_pubkey: (o.buyer_trade_pubkey as string | null) ?? null,
    seller_trade_pubkey: (o.seller_trade_pubkey as string | null) ?? null,
    buyer_invoice: (o.buyer_invoice as string | null) ?? null,
    created_at: (o.created_at as number | null) ?? null,
    expires_at: (o.expires_at as number | null) ?? null,
  };
}

function paymentRequestFromJson(parsed: unknown): [SmallOrder | null, string, number | null] {
  if (!Array.isArray(parsed) || parsed.length !== 3) {
    throw new Error("payment_request must be a 3-element array");
  }
  const [order, invoice, amount] = parsed;
  return [
    order === null ? null : smallOrderFromJson(order),
    requireString(invoice),
    amount === null ? null : requireNumber(amount),
  ];
}

function peerFromJson(parsed: unknown): Peer {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("peer must be an object");
  }
  const p = parsed as Record<string, unknown>;
  return {
    pubkey: requireString(p.pubkey),
    reputation:
      p.reputation === null || p.reputation === undefined
        ? null
        : userInfoFromJson(p.reputation),
  };
}

function userInfoFromJson(parsed: unknown): UserInfo {
  const o = parsed as Record<string, unknown>;
  return {
    rating: requireNumber(o.rating),
    reviews: requireNumber(o.reviews),
    operating_days: requireNumber(o.operating_days),
  };
}

function disputeTupleFromJson(parsed: unknown): [string, SolverDisputeInfo | null] {
  if (!Array.isArray(parsed) || parsed.length !== 2) {
    throw new Error("dispute payload must be a 2-element array");
  }
  const [id, info] = parsed;
  return [requireString(id), info === null ? null : solverDisputeInfoFromJson(info)];
}

function solverDisputeInfoFromJson(parsed: unknown): SolverDisputeInfo {
  const o = parsed as Record<string, unknown>;
  return {
    id: requireString(o.id),
    kind: requireString(o.kind),
    status: requireString(o.status),
    hash: (o.hash as string | null) ?? null,
    preimage: (o.preimage as string | null) ?? null,
    order_previous_status: requireString(o.order_previous_status),
    initiator_pubkey: requireString(o.initiator_pubkey),
    buyer_pubkey: (o.buyer_pubkey as string | null) ?? null,
    seller_pubkey: (o.seller_pubkey as string | null) ?? null,
    initiator_full_privacy: requireBoolean(o.initiator_full_privacy),
    counterpart_full_privacy: requireBoolean(o.counterpart_full_privacy),
    initiator_info: o.initiator_info === null ? null : userInfoFromJson(o.initiator_info),
    counterpart_info: o.counterpart_info === null ? null : userInfoFromJson(o.counterpart_info),
    premium: requireNumber(o.premium),
    payment_method: requireString(o.payment_method),
    amount: requireNumber(o.amount),
    fiat_amount: requireNumber(o.fiat_amount),
    fee: requireNumber(o.fee),
    routing_fee: requireNumber(o.routing_fee),
    buyer_invoice: (o.buyer_invoice as string | null) ?? null,
    invoice_held_at: requireNumber(o.invoice_held_at),
    taken_at: requireNumber(o.taken_at),
    created_at: requireNumber(o.created_at),
  };
}

function nextTradeFromJson(parsed: unknown): [string, number] {
  if (!Array.isArray(parsed) || parsed.length !== 2) {
    throw new Error("next_trade must be a 2-element array");
  }
  return [requireString(parsed[0]), requireNumber(parsed[1])];
}

function paymentFailedFromJson(parsed: unknown) {
  const o = parsed as Record<string, unknown>;
  return {
    payment_attempts: requireNumber(o.payment_attempts),
    payment_retries_interval: requireNumber(o.payment_retries_interval),
  };
}

function restoreSessionInfoFromJson(parsed: unknown): RestoreSessionInfo {
  const o = parsed as Record<string, unknown>;
  const orders = (o.orders as unknown[] | null) ?? [];
  const disputes = (o.disputes as unknown[] | null) ?? [];
  return {
    orders: orders.map((x: unknown) => {
      const r = x as Record<string, unknown>;
      return {
        order_id: requireString(r.order_id),
        trade_index: requireNumber(r.trade_index),
        status: requireString(r.status),
      };
    }),
    disputes: disputes.map((x: unknown) => {
      const r = x as Record<string, unknown>;
      return {
        dispute_id: requireString(r.dispute_id),
        order_id: requireString(r.order_id),
        trade_index: requireNumber(r.trade_index),
        status: requireString(r.status),
        initiator: (r.initiator as import("./message.js").DisputeInitiator | null) ?? null,
        solver_pubkey: (r.solver_pubkey as string | null) ?? null,
      };
    }),
  };
}

function stringArrayFromJson(parsed: unknown): string[] {
  if (!Array.isArray(parsed)) {
    throw new Error("expected a JSON array");
  }
  return parsed.map((x) => requireString(x));
}

function smallOrderArrayFromJson(parsed: unknown): SmallOrder[] {
  if (!Array.isArray(parsed)) {
    throw new Error("expected a JSON array");
  }
  return parsed.map(smallOrderFromJson);
}

function bondResolutionFromJson(parsed: unknown): BondResolution {
  const o = parsed as Record<string, unknown>;
  return {
    slash_seller: requireBoolean(o.slash_seller),
    slash_buyer: requireBoolean(o.slash_buyer),
  };
}

function bondPayoutRequestFromJson(parsed: unknown): BondPayoutRequest {
  const o = parsed as Record<string, unknown>;
  return { order: smallOrderFromJson(o.order), slashed_at: requireNumber(o.slashed_at) };
}

function cashuLockProofFromJson(parsed: unknown): CashuLockProof {
  const o = parsed as Record<string, unknown>;
  return {
    token: requireString(o.token),
    mint_url: requireString(o.mint_url),
    buyer_pubkey: requireString(o.buyer_pubkey),
    seller_pubkey: requireString(o.seller_pubkey),
    mostro_pubkey: requireString(o.mostro_pubkey),
    fee_token: (o.fee_token as string | null) ?? null,
  };
}

function cashuProofSignatureArrayFromJson(parsed: unknown): CashuProofSignature[] {
  if (!Array.isArray(parsed)) {
    throw new Error("expected a JSON array");
  }
  return parsed.map((x) => {
    const o = x as Record<string, unknown>;
    return { secret: requireString(o.secret), signature: requireString(o.signature) };
  });
}

function requireString(v: unknown): string {
  if (typeof v !== "string") {
    throw new Error(`expected string, got ${typeof v}`);
  }
  return v;
}

function requireNumber(v: unknown): number {
  if (typeof v !== "number") {
    throw new Error(`expected number, got ${typeof v}`);
  }
  return v;
}

function requireBoolean(v: unknown): boolean {
  if (typeof v !== "boolean") {
    throw new Error(`expected boolean, got ${typeof v}`);
  }
  return v;
}