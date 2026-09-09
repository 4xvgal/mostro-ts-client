// Storage abstraction for client state.
//
// The rest of the protocol layer depends only on this interface, never on a
// concrete backend. Two implementations exist:
//   - `sqliteStore` (Node) — node:sqlite, synchronous.
//   - `indexedDbStore` (browser) — IndexedDB, asynchronous (planned).
//
// Trade-index reservation is atomic in every backend (single user row).

import type { DerivedKeys } from "./keys.js";

export interface UserRow {
  i0_pubkey: string;
  mnemonic: string;
  last_trade_index: number | null;
  created_at: number;
}

export interface OrderRow {
  id: string;
  kind: string | null;
  status: string | null;
  amount: number;
  fiat_code: string;
  min_amount: number | null;
  max_amount: number | null;
  fiat_amount: number;
  payment_method: string;
  premium: number;
  trade_keys: string | null;
  counterparty_pubkey: string | null;
  is_mine: number;
  buyer_invoice: string | null;
  request_id: number | null;
  trade_index: number | null;
  created_at: number | null;
  expires_at: number | null;
  last_seen_dm_ts: number | null;
}

export interface AdminDisputeRow {
  id: string;
  dispute_id: string;
  kind: string | null;
  status: string | null;
  hash: string | null;
  preimage: string | null;
  order_previous_status: string | null;
  initiator_pubkey: string;
  buyer_pubkey: string | null;
  seller_pubkey: string | null;
  initiator_full_privacy: number;
  counterpart_full_privacy: number;
  initiator_info: string | null;
  counterpart_info: string | null;
  premium: number;
  payment_method: string;
  amount: number;
  fiat_amount: number;
  fiat_code: string;
  fee: number;
  routing_fee: number;
  buyer_invoice: string | null;
  invoice_held_at: number | null;
  taken_at: number;
  created_at: number;
  buyer_chat_last_seen: number | null;
  seller_chat_last_seen: number | null;
  buyer_shared_key_hex: string | null;
  seller_shared_key_hex: string | null;
}

/** Input to persist a new/updated order. */
export interface SaveOrderInput {
  id: string;
  kind: string | null;
  status: string | null;
  amount: number;
  fiat_code: string;
  min_amount: number | null;
  max_amount: number | null;
  fiat_amount: number;
  payment_method: string;
  premium: number;
  trade_keys: string;
  counterparty_pubkey: string | null;
  is_mine: boolean;
  buyer_invoice: string | null;
  request_id: number | null;
  trade_index: number;
  created_at: number | null;
  expires_at: number | null;
}

/** Result of an atomic trade-index reservation. */
export interface ReservedTradeIndex {
  nextIndex: number;
  keys: DerivedKeys;
}

/** Result of a single-order persistence op. */
export interface OrderStoreResult {
  /** True when the row was inserted, false when it was an update. */
  inserted: boolean;
}

/** Async storage backend for client state. */
export interface Store {
  // users
  upsertUser(user: UserRow): Promise<void>;
  getUser(): Promise<UserRow | null>;
  /** Atomically increment last_trade_index and derive the next trade keys. */
  reserveNextTradeIndex(mnemonic: string, noneBase: number): Promise<ReservedTradeIndex>;

  // orders
  saveOrder(order: SaveOrderInput): Promise<OrderStoreResult>;
  updateOrderStatus(orderId: string, status: string): Promise<void>;
  getOrder(orderId: string): Promise<OrderRow | null>;
  /** Non-terminal orders with persisted trade keys (startup hydration source). */
  getActiveOrders(terminalStatuses: readonly string[]): Promise<OrderRow[]>;
  updateLastSeenDmTs(orderId: string, ts: number): Promise<void>;

  close(): Promise<void>;
}