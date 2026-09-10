// IndexedDB Store implementation (browser). Same Store interface as the
// SQLite backend (db.ts) — the rest of the client is backend-agnostic.
//
// IndexedDB has no SQL: three object stores mirror the SQLite tables. All
// operations are inherently async, matching the Store interface. Trade-index
// reservation is atomic within a tab because a single JS thread serializes
// the read-modify-write (no interleaved reservations between awaits).

import { deriveTradeKeys } from "./keys.js";
import type { Store, UserRow, OrderRow, SaveOrderInput, ReservedTradeIndex, ChatMessageRow } from "./store.js";

const STORE_USERS = "users";
const STORE_ORDERS = "orders";
const STORE_DISPUTES = "admin_disputes";
const STORE_CHAT = "chat_messages";

interface OrdersDb {
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
  dispute_id: string | null;
  solver_pubkey: string | null;
  dispute_chat_shared_key_hex: string | null;
}

/** The single identity row (IndexedDB stores it under a fixed key). */
const USER_KEY = "identity";

function openDb(dbName: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(dbName, 2);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_USERS)) {
        db.createObjectStore(STORE_USERS, { keyPath: "i0_pubkey" });
      }
      if (!db.objectStoreNames.contains(STORE_ORDERS)) {
        db.createObjectStore(STORE_ORDERS, { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains(STORE_DISPUTES)) {
        db.createObjectStore(STORE_DISPUTES, { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains(STORE_CHAT)) {
        db.createObjectStore(STORE_CHAT, { keyPath: "outer_event_id" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** Generic IDB helper: run an operation in a transaction. */
function txn<T>(
  db: IDBDatabase,
  storeName: string,
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => IDBRequest<T> | void,
): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, mode);
    const store = tx.objectStore(storeName);
    let result: T | undefined;
    try {
      const req = fn(store) as IDBRequest<T> | undefined;
      if (req) {
        req.onsuccess = () => {
          result = req.result;
        };
      }
    } catch (e) {
      reject(e);
      return;
    }
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

/** Open (or create) the IndexedDB-backed store. */
export function openIndexedDbStore(opts: { dbName?: string } = {}): Store {
  const dbName = opts.dbName ?? "mostro";
  let dbPromise: Promise<IDBDatabase> | null = null;

  const db = (): Promise<IDBDatabase> => {
    if (!dbPromise) {
      dbPromise = openDb(dbName);
    }
    return dbPromise;
  };

  const getUser = async (): Promise<UserRow | null> => {
    const database = await db();
    const all = await txn<UserRow[]>(database, STORE_USERS, "readonly", (s) => s.getAll());
    return all && all.length > 0 ? all[0]! : null;
  };

  const upsertUser = async (user: UserRow): Promise<void> => {
    const database = await db();
    // Monotonic last_trade_index (mirrors the sqlite MAX() upsert).
    const existing = await getUser();
    const row =
      existing && user.last_trade_index !== null && existing.last_trade_index !== null
        ? {
            ...user,
            last_trade_index: Math.max(existing.last_trade_index, user.last_trade_index),
          }
        : user;
    await txn(database, STORE_USERS, "readwrite", (s) => s.put(row));
  };

  return {
    upsertUser,

    getUser,

    async reserveNextTradeIndex(mnemonic: string, noneBase: number): Promise<ReservedTradeIndex> {
      // Single JS thread: no interleaved reservations between awaits.
      const user = await getUser();
      const nextIndex = (user?.last_trade_index ?? noneBase) + 1;
      if (user) {
        await upsertUser({ ...user, last_trade_index: nextIndex });
      } else {
        const identity = deriveTradeKeys(mnemonic, 0);
        await upsertUser({
          i0_pubkey: identity.pubkey,
          mnemonic,
          last_trade_index: nextIndex,
          created_at: Math.floor(Date.now() / 1000),
        });
      }
      return { nextIndex, keys: deriveTradeKeys(mnemonic, nextIndex) };
    },

    async saveOrder(order: SaveOrderInput): Promise<{ inserted: boolean }> {
      const database = await db();
      const existing = await txn<OrdersDb>(database, STORE_ORDERS, "readonly", (s) => s.get(order.id));
      const row: OrdersDb = {
        id: order.id,
        kind: order.kind,
        status: order.status,
        amount: order.amount,
        fiat_code: order.fiat_code,
        min_amount: order.min_amount,
        max_amount: order.max_amount,
        fiat_amount: order.fiat_amount,
        payment_method: order.payment_method,
        premium: order.premium,
        trade_keys: order.trade_keys,
        counterparty_pubkey: order.counterparty_pubkey,
        is_mine: order.is_mine ? 1 : 0,
        buyer_invoice: order.buyer_invoice,
        request_id: order.request_id,
        trade_index: order.trade_index,
        created_at: existing?.created_at ?? order.created_at,
        expires_at: order.expires_at,
        last_seen_dm_ts: existing?.last_seen_dm_ts ?? null,
        dispute_id: existing?.dispute_id ?? null,
        solver_pubkey: existing?.solver_pubkey ?? null,
        dispute_chat_shared_key_hex: existing?.dispute_chat_shared_key_hex ?? null,
      };
      await txn(database, STORE_ORDERS, "readwrite", (s) => s.put(row));
      return { inserted: existing === undefined };
    },

    async updateOrderStatus(orderId: string, status: string): Promise<void> {
      const database = await db();
      const existing = await txn<OrdersDb>(database, STORE_ORDERS, "readonly", (s) => s.get(orderId));
      if (existing) {
        await txn(database, STORE_ORDERS, "readwrite", (s) => s.put({ ...existing, status }));
      }
    },

    async getOrder(orderId: string): Promise<OrderRow | null> {
      const database = await db();
      const row = await txn<OrdersDb>(database, STORE_ORDERS, "readonly", (s) => s.get(orderId));
      return row ? (row as unknown as OrderRow) : null;
    },

    async getActiveOrders(terminalStatuses: readonly string[]): Promise<OrderRow[]> {
      const database = await db();
      const rows = (await txn<OrdersDb[]>(database, STORE_ORDERS, "readonly", (s) => s.getAll())) ?? [];
      return rows.filter(
        (r) =>
          r.trade_keys !== null &&
          r.trade_keys !== "" &&
          (r.status === null || !terminalStatuses.includes(r.status.toLowerCase())),
      ) as unknown as OrderRow[];
    },

    async updateLastSeenDmTs(orderId: string, ts: number): Promise<void> {
      const database = await db();
      const existing = await txn<OrdersDb>(database, STORE_ORDERS, "readonly", (s) => s.get(orderId));
      if (existing) {
        const last = existing.last_seen_dm_ts;
        await txn(database, STORE_ORDERS, "readwrite", (s) =>
          s.put({ ...existing, last_seen_dm_ts: last === null || ts > last ? ts : last }),
        );
      }
    },

    async updateDisputeId(orderId: string, disputeId: string): Promise<void> {
      const database = await db();
      const existing = await txn<OrdersDb>(database, STORE_ORDERS, "readonly", (s) => s.get(orderId));
      if (existing) {
        await txn(database, STORE_ORDERS, "readwrite", (s) => s.put({ ...existing, dispute_id: disputeId }));
      }
    },

    async updateSolverChat(orderId: string, solverPubkey: string, sharedKeyHex: string): Promise<void> {
      const database = await db();
      const existing = await txn<OrdersDb>(database, STORE_ORDERS, "readonly", (s) => s.get(orderId));
      if (existing) {
        await txn(database, STORE_ORDERS, "readwrite", (s) =>
          s.put({ ...existing, solver_pubkey: solverPubkey, dispute_chat_shared_key_hex: sharedKeyHex }),
        );
      }
    },

    async close(): Promise<void> {
      const database = await db();
      database.close();
    },

    async saveChatMessage(row: ChatMessageRow): Promise<void> {
      const database = await db();
      await txn(database, STORE_CHAT, "readwrite", (s) => s.put(row));
    },

    async getChatMessages(orderId: string, scope: string): Promise<ChatMessageRow[]> {
      const database = await db();
      const all = await txn<ChatMessageRow[]>(database, STORE_CHAT, "readonly", (s) => s.getAll());
      return (all ?? [])
        .filter((m) => m.order_id === orderId && m.scope === scope)
        .sort((a, b) => a.created_at - b.created_at);
    },

    async wipe(): Promise<void> {
      const database = await db();
      for (const store of [STORE_CHAT, STORE_ORDERS, STORE_DISPUTES, STORE_USERS]) {
        await txn(database, store, "readwrite", (s) => s.clear());
      }
    },
  };
}