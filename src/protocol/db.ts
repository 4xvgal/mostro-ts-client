// SQLite Store implementation (Node). Ported schema from mostrix
// `docs/DATABASE.md` (src/db.rs + src/models.rs). Synchronous under the
// hood; the Store interface is async so a browser IndexedDB backend can
// implement it identically.

import { DatabaseSync } from "node:sqlite";
import { deriveTradeKeys } from "./keys.js";
import type { Store, UserRow, OrderRow, SaveOrderInput, ReservedTradeIndex } from "./store.js";

/** Open (or create) the local SQLite store and ensure the schema exists. */
export function openSqliteStore(path = ":memory:"): Store {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      i0_pubkey char(64) PRIMARY KEY,
      mnemonic TEXT,
      last_trade_index INTEGER,
      created_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS orders (
      id TEXT PRIMARY KEY,
      kind TEXT,
      status TEXT,
      amount INTEGER NOT NULL,
      fiat_code TEXT NOT NULL,
      min_amount INTEGER,
      max_amount INTEGER,
      fiat_amount INTEGER NOT NULL,
      payment_method TEXT NOT NULL,
      premium INTEGER NOT NULL,
      trade_keys TEXT,
      counterparty_pubkey TEXT,
      is_mine INTEGER NOT NULL,
      buyer_invoice TEXT,
      request_id INTEGER,
      trade_index INTEGER,
      created_at INTEGER,
      expires_at INTEGER,
      last_seen_dm_ts INTEGER
    );
    CREATE TABLE IF NOT EXISTS admin_disputes (
      id TEXT PRIMARY KEY,
      dispute_id TEXT NOT NULL,
      kind TEXT,
      status TEXT,
      hash TEXT,
      preimage TEXT,
      order_previous_status TEXT,
      initiator_pubkey TEXT NOT NULL,
      buyer_pubkey TEXT,
      seller_pubkey TEXT,
      initiator_full_privacy INTEGER NOT NULL,
      counterpart_full_privacy INTEGER NOT NULL,
      initiator_info TEXT,
      counterpart_info TEXT,
      premium INTEGER NOT NULL,
      payment_method TEXT NOT NULL,
      amount INTEGER NOT NULL,
      fiat_amount INTEGER NOT NULL,
      fiat_code TEXT NOT NULL,
      fee INTEGER NOT NULL,
      routing_fee INTEGER NOT NULL,
      buyer_invoice TEXT,
      invoice_held_at INTEGER,
      taken_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      buyer_chat_last_seen INTEGER,
      seller_chat_last_seen INTEGER,
      buyer_shared_key_hex TEXT,
      seller_shared_key_hex TEXT
    );
  `);

  return {
    async upsertUser(user: UserRow): Promise<void> {
      db.prepare(
        `INSERT INTO users (i0_pubkey, mnemonic, last_trade_index, created_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(i0_pubkey) DO UPDATE SET
           mnemonic = excluded.mnemonic,
           last_trade_index = MAX(COALESCE(users.last_trade_index, 0), COALESCE(excluded.last_trade_index, 0)),
           created_at = excluded.created_at`,
      ).run(user.i0_pubkey, user.mnemonic, user.last_trade_index, user.created_at);
    },

    async getUser(): Promise<UserRow | null> {
      const row = db
        .prepare(`SELECT i0_pubkey, mnemonic, last_trade_index, created_at FROM users LIMIT 1`)
        .get() as Record<string, unknown> | undefined;
      return row ? (row as unknown as UserRow) : null;
    },

    async reserveNextTradeIndex(mnemonic: string, noneBase: number): Promise<ReservedTradeIndex> {
      const user = db
        .prepare(`SELECT i0_pubkey, mnemonic, last_trade_index, created_at FROM users LIMIT 1`)
        .get() as Record<string, unknown> | undefined;
      const pubkey = (user?.i0_pubkey as string | undefined) ?? "";
      const last = (user?.last_trade_index as number | null | undefined) ?? null;
      const nextIndex = (last ?? noneBase) + 1;
      db.prepare(`UPDATE users SET last_trade_index = ? WHERE i0_pubkey = ?`).run(nextIndex, pubkey);
      return { nextIndex, keys: deriveTradeKeys(mnemonic, nextIndex) };
    },

    async saveOrder(order: SaveOrderInput): Promise<{ inserted: boolean }> {
      const existing = db
        .prepare(`SELECT id FROM orders WHERE id = ? LIMIT 1`)
        .get(order.id) as Record<string, unknown> | undefined;
      db.prepare(
        `INSERT INTO orders (id, kind, status, amount, fiat_code, min_amount, max_amount,
           fiat_amount, payment_method, premium, trade_keys, counterparty_pubkey, is_mine,
           buyer_invoice, request_id, trade_index, created_at, expires_at, last_seen_dm_ts)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
         ON CONFLICT(id) DO UPDATE SET
           kind = excluded.kind, status = excluded.status, amount = excluded.amount,
           fiat_code = excluded.fiat_code, min_amount = excluded.min_amount,
           max_amount = excluded.max_amount, fiat_amount = excluded.fiat_amount,
           payment_method = excluded.payment_method, premium = excluded.premium,
           trade_keys = excluded.trade_keys, counterparty_pubkey = excluded.counterparty_pubkey,
           is_mine = excluded.is_mine, buyer_invoice = excluded.buyer_invoice,
           request_id = excluded.request_id, trade_index = excluded.trade_index,
           created_at = COALESCE(orders.created_at, excluded.created_at),
           expires_at = excluded.expires_at`,
      ).run(
        order.id,
        order.kind,
        order.status,
        order.amount,
        order.fiat_code,
        order.min_amount,
        order.max_amount,
        order.fiat_amount,
        order.payment_method,
        order.premium,
        order.trade_keys,
        order.counterparty_pubkey,
        order.is_mine ? 1 : 0,
        order.buyer_invoice,
        order.request_id,
        order.trade_index,
        order.created_at,
        order.expires_at,
      );
      return { inserted: existing === undefined };
    },

    async updateOrderStatus(orderId: string, status: string): Promise<void> {
      db.prepare(`UPDATE orders SET status = ? WHERE id = ?`).run(status, orderId);
    },

    async getOrder(orderId: string): Promise<OrderRow | null> {
      const row = db.prepare(`SELECT * FROM orders WHERE id = ? LIMIT 1`).get(orderId) as
        | Record<string, unknown>
        | undefined;
      return row ? (row as unknown as OrderRow) : null;
    },

    async getActiveOrders(terminalStatuses: readonly string[]): Promise<OrderRow[]> {
      const placeholders = terminalStatuses.map(() => "?").join(", ");
      const rows = db
        .prepare(
          `SELECT * FROM orders
           WHERE trade_keys IS NOT NULL AND trade_keys != ''
             AND (status IS NULL OR lower(status) NOT IN (${placeholders}))`,
        )
        .all(...terminalStatuses) as unknown as Record<string, unknown>[];
      return rows.map((r) => r as unknown as OrderRow);
    },

    async updateLastSeenDmTs(orderId: string, ts: number): Promise<void> {
      db.prepare(
        `UPDATE orders SET last_seen_dm_ts = CASE
           WHEN last_seen_dm_ts IS NULL OR ? > last_seen_dm_ts THEN ? ELSE last_seen_dm_ts END
         WHERE id = ?`,
      ).run(ts, ts, orderId);
    },

    async close(): Promise<void> {
      db.close();
    },
  };
}