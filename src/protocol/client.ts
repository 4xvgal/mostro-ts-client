// High-level Mostro client facade — the API a UI plugs into.
//
// Wraps the protocol layer (DM router, order book, applicator, restore) into a
// small surface: start/stop, order book subscription, create/take order,
// trade state events, invoice submission, restore. All persistence goes
// through the injected Store.

import { SimplePool } from "nostr-tools/pool";
import type { NostrEvent } from "nostr-tools/core";
import type { Message, MessageKind } from "./message.js";
import type { SmallOrder } from "./order.js";
import { deriveIdentityKeys, deriveTradeKeys } from "./keys.js";
import { openSqliteStore } from "./db.js";
import type { Store, UserRow } from "./store.js";
import { DmRouter, sendDm, FETCH_EVENTS_TIMEOUT_MS } from "./dmRouter.js";
import { unwrapMessageNip44 } from "./transport.js";
import { fetchPublicOrderBook } from "./orderbook.js";
import { applyTradeDm } from "./applicator.js";
import { restoreSession } from "./restore.js";
import { buildNewOrder, buildTradeMessage, buildTakeOrderPayload, takeActionForOrder, newRequestId, handleNewOrderResponse, handleTakeOrderResponse, buildDisputeMessage } from "./flow.js";
import { buildInvoiceMessage, handleAddInvoiceResponse } from "./invoice.js";
import { mostroInfoFromTags } from "./mostroInfo.js";
import type { MostroInstanceInfo } from "./mostroInfo.js";
import { NOSTR_INFO_EVENT_KIND } from "./constants.js";

export interface MostroClientOptions {
  /** BIP-39 mnemonic; derives identity + trade keys. */
  mnemonic: string;
  /** The Mostro instance pubkey (hex). */
  mostroPubkey: string;
  /** Nostr relay URLs. */
  relays: string[];
  /** Optional store; defaults to an in-memory SQLite store. */
  store?: Store;
  /** Fiat currency filter for the order book (empty = all). */
  currencies?: string[];
}

export type OrderBookHandler = (orders: SmallOrder[]) => void;
export type TradeHandler = (orderId: string, state: AppliedTradeState) => void;

export interface AppliedTradeState {
  action: string;
  status: string | null;
  disputeId: string | null;
}

export interface CreateOrderResult {
  orderId: string;
  status: string | null;
}

export interface TakeOrderResult {
  /** "hold-invoice" | "bond-invoice" | "add-invoice" — the next UI step. */
  next: "hold-invoice" | "bond-invoice" | "add-invoice" | "ok";
  invoice?: string;
  amount?: number | null;
}

/**
 * MostroClient — the UI-facing entry point.
 *
 * Usage:
 *   const client = new MostroClient({ mnemonic, mostroPubkey, relays });
 *   await client.start();
 *   client.onOrders((orders) => renderBook(orders));
 *   client.onTrade((id, state) => renderTrade(id, state));
 *   const res = await client.createOrder({ kind: "sell", fiatAmount: 100, ... });
 *   await client.stop();
 */
export class MostroClient {
  private opts: MostroClientOptions;
  private pool: SimplePool;
  private store: Store;
  private router: DmRouter | null = null;
  private orderBookHandler: OrderBookHandler | null = null;
  private tradeHandlers = new Map<string, TradeHandler>();
  private orderBookTimer: ReturnType<typeof setInterval> | null = null;
  private started = false;
  /** order_id → trade secret for routing DMs. */
  private trades = new Map<string, string>();

  // Identity/trade keys derived from the mnemonic.
  private identitySecret: string;
  private identityPubkey: string;
  private lastTradeIndex = 0;

  constructor(opts: MostroClientOptions) {
    this.opts = opts;
    this.pool = new SimplePool();
    this.store = opts.store ?? openSqliteStore();
    const identity = deriveIdentityKeys(opts.mnemonic);
    this.identitySecret = identity.secret;
    this.identityPubkey = identity.pubkey;
  }

  /** The user's identity pubkey (index-0 trade key). */
  get identity(): string {
    return this.identityPubkey;
  }

  /** The underlying store (for direct reads in UIs). */
  get storeRef(): Store {
    return this.store;
  }

  /**
   * Connect to relays, load instance info, start the order-book poller and
   * the DM router (restoring active orders from the store).
   */
  async start(): Promise<void> {
    if (this.started) {
      return;
    }
    // Load instance info to resolve transport + fee + bond config.
    const infoEvent = await this.pool.get(this.opts.relays, {
      kinds: [NOSTR_INFO_EVENT_KIND],
      authors: [this.opts.mostroPubkey],
      limit: 1,
    });
    const info: MostroInstanceInfo = infoEvent
      ? mostroInfoFromTags(infoEvent.tags)
      : { protocol_version: 2 } as MostroInstanceInfo;

    this.router = new DmRouter({
      pool: this.pool,
      relays: this.opts.relays,
      mostroPubkeyHex: this.opts.mostroPubkey,
      transport: info.protocol_version === 2 ? "nip44" : "gift-wrap",
      onOrderMessage: (orderId, message, event) => this.handleInboundDm(orderId, message),
    });

    // Restore in-flight orders from the store so DMs route correctly.
    const { TERMINAL_DM_STATUSES } = await import("./statusSets.js");
    const active = await this.store.getActiveOrders(TERMINAL_DM_STATUSES);
    for (const order of active) {
      if (order.trade_keys && order.trade_index !== null) {
        this.trades.set(order.id, order.trade_keys);
        this.router.trackOrder(order.id, order.trade_keys);
      }
    }

    // Order-book poller.
    this.orderBookTimer = setInterval(() => this.refreshOrderBook(), 30_000);
    await this.refreshOrderBook();

    this.started = true;
  }

  /** Stop background tasks. */
  async stop(): Promise<void> {
    if (this.orderBookTimer) {
      clearInterval(this.orderBookTimer);
      this.orderBookTimer = null;
    }
    this.started = false;
    this.pool.close(this.opts.relays);
  }

  /** Subscribe to order-book updates. */
  onOrders(handler: OrderBookHandler): void {
    this.orderBookHandler = handler;
  }

  /** Subscribe to trade-state updates for an order. */
  onTrade(orderId: string, handler: TradeHandler): void {
    this.tradeHandlers.set(orderId, handler);
  }

  /** Fetch the current pending order book (for UIs that prefer explicit polls). */
  async fetchOrders(): Promise<SmallOrder[]> {
    return fetchPublicOrderBook({
      pool: this.pool,
      relays: this.opts.relays,
      mostroPubkeyHex: this.opts.mostroPubkey,
      currencies: this.opts.currencies,
    });
  }

  /** Create an order and return the resulting order id + status. */
  async createOrder(input: {
    kind: "buy" | "sell";
    fiatAmount: number;
    fiatCode?: string;
    amount?: number;
    paymentMethod: string;
    minAmount?: number;
    maxAmount?: number;
    expirationDays?: number;
  }): Promise<CreateOrderResult> {
    const tradeIndex = ++this.lastTradeIndex;
    const tradeKeys = deriveTradeKeys(this.opts.mnemonic, tradeIndex);

    const { message, requestId } = buildNewOrder(
      { lastTradeIndex: this.lastTradeIndex - 1 },
      {
        kind: input.kind,
        fiatAmount: input.fiatAmount,
        fiatCode: input.fiatCode,
        amount: input.amount,
        paymentMethod: input.paymentMethod,
        minAmount: input.minAmount,
        maxAmount: input.maxAmount,
        expirationDays: input.expirationDays,
      },
    );

    const reply = await this.roundtrip(tradeKeys.secret, message, "new-order");
    const kind = reply;
    const result = handleNewOrderResponse(kind, requestId);

    let orderId: string;
    let status: string | null;
    if (result.type === "order-created") {
      orderId = result.order.id!;
      status = result.order.status;
    } else if (result.type === "bond-invoice") {
      // Order id may be in the payload order or the message id.
      orderId = result.order?.id ?? kind.id ?? "";
      status = kind.id ? "waiting-maker-bond" : null;
    } else {
      throw new Error("unexpected create-order result");
    }

    // Register the trade + persist.
    this.trades.set(orderId, tradeKeys.secret);
    this.router!.trackOrder(orderId, tradeKeys.secret);
    await this.persistOrder(orderId, kind, tradeKeys.secret, tradeIndex, true);
    await this.store.upsertUser({
      i0_pubkey: this.identityPubkey,
      mnemonic: this.opts.mnemonic,
      last_trade_index: tradeIndex,
      created_at: Math.floor(Date.now() / 1000),
    });

    return { orderId, status };
  }

  /** Take an order; resolves to the next UI step (invoice needed, etc.). */
  async takeOrder(order: SmallOrder, input: { invoice?: string; amount?: number } = {}): Promise<TakeOrderResult> {
    const tradeIndex = ++this.lastTradeIndex;
    const tradeKeys = deriveTradeKeys(this.opts.mnemonic, tradeIndex);
    const action = takeActionForOrder(order);
    const payload = buildTakeOrderPayload({
      action,
      invoice: input.invoice,
      amount: input.amount,
    });

    const message = buildTradeMessage({
      orderId: order.id!,
      requestId: newRequestId(),
      action,
      tradeIndex,
      payload,
    });
    const reply = await this.roundtrip(
      tradeKeys.secret,
      message,
      "take-sell",
      "take-buy",
      "pay-invoice",
      "pay-bond-invoice",
      "add-invoice",
    );
    const result = handleTakeOrderResponse(reply, message.value.request_id!);

    this.trades.set(order.id!, tradeKeys.secret);
    this.router!.trackOrder(order.id!, tradeKeys.secret);

    if (result.type === "add-invoice") {
      await this.persistOrder(order.id!, reply, tradeKeys.secret, tradeIndex, false);
      return { next: "add-invoice", amount: result.order.amount };
    }
    return {
      next: result.type,
      invoice: result.invoice,
      amount: result.amount,
    };
  }

  /** Submit a payout invoice for an order (AddInvoice). */
  async submitInvoice(orderId: string, invoice: string): Promise<"accepted"> {
    const tradeSecret = this.requireTradeSecret(orderId);
    const requestId = newRequestId();
    const message = buildInvoiceMessage({ orderId, requestId, action: "add-invoice", invoice });
    const reply = await this.roundtrip(tradeSecret, message, "waiting-seller-to-pay", "hold-invoice-payment-accepted");
    return handleAddInvoiceResponse(reply, requestId);
  }

  /** Send FiatSent or Release for an order. */
  async sendTradeAction(orderId: string, action: "fiat-sent" | "release"): Promise<void> {
    const tradeSecret = this.requireTradeSecret(orderId);
    const message = buildTradeMessage({ orderId, requestId: newRequestId(), action, payload: null });
    await this.roundtrip(tradeSecret, message, "fiat-sent-ok", "hold-invoice-payment-settled");
  }

  /** Open a dispute on an order. */
  async openDispute(orderId: string): Promise<void> {
    const tradeSecret = this.requireTradeSecret(orderId);
    const message = buildDisputeMessage({ orderId, requestId: newRequestId() });
    await this.roundtrip(tradeSecret, message, "dispute-initiated-by-you", "dispute-initiated-by-peer");
  }

  /** Restore session state from Mostro (rebuilds store + trade routing). */
  async restore(): Promise<void> {
    await this.store.upsertUser({
      i0_pubkey: this.identityPubkey,
      mnemonic: this.opts.mnemonic,
      last_trade_index: this.lastTradeIndex,
      created_at: Math.floor(Date.now() / 1000),
    });
    await restoreSession({
      pool: this.pool,
      relays: this.opts.relays,
      mostroPubkeyHex: this.opts.mostroPubkey,
      mnemonic: this.opts.mnemonic,
      store: this.store,
    });
    // Re-track restored active orders.
    const { TERMINAL_DM_STATUSES } = await import("./statusSets.js");
    const active = await this.store.getActiveOrders(TERMINAL_DM_STATUSES);
    for (const order of active) {
      if (order.trade_keys && order.trade_index !== null) {
        this.trades.set(order.id, order.trade_keys);
        this.router?.trackOrder(order.id, order.trade_keys);
      }
    }
  }

  // -------------------------------------------------------------------------
  // internals
  // -------------------------------------------------------------------------

  private async refreshOrderBook(): Promise<void> {
    if (!this.orderBookHandler) {
      return;
    }
    const orders = await this.fetchOrders().catch(() => []);
    this.orderBookHandler(orders);
  }

  private async handleInboundDm(orderId: string, message: Message): Promise<void> {
    const tradeSecret = this.trades.get(orderId);
    if (!tradeSecret) {
      return;
    }
    const result = await applyTradeDm({ store: this.store, orderId, tradeSecretHex: tradeSecret, message });
    const handler = this.tradeHandlers.get(orderId);
    if (handler) {
      handler(orderId, {
        action: result.action,
        status: result.status,
        disputeId: result.disputeId,
      });
    }
  }

  private async persistOrder(
    orderId: string,
    kind: MessageKind,
    tradeSecret: string,
    tradeIndex: number,
    isMine: boolean,
  ): Promise<void> {
    const payload = kind.payload;
    const small = payload && payload.variant === "order" ? payload.value : null;
    await this.store.saveOrder({
      id: orderId,
      kind: small?.kind ?? null,
      status: small?.status ?? kind.id ? "pending" : null,
      amount: small?.amount ?? 0,
      fiat_code: small?.fiat_code ?? "",
      min_amount: small?.min_amount ?? null,
      max_amount: small?.max_amount ?? null,
      fiat_amount: small?.fiat_amount ?? 0,
      payment_method: small?.payment_method ?? "",
      premium: small?.premium ?? 0,
      trade_keys: tradeSecret,
      counterparty_pubkey: null,
      is_mine: isMine,
      buyer_invoice: small?.buyer_invoice ?? null,
      request_id: null,
      trade_index: tradeIndex,
      created_at: small?.created_at ?? Math.floor(Date.now() / 1000),
      expires_at: small?.expires_at ?? null,
    });
  }

  private requireTradeSecret(orderId: string): string {
    const secret = this.trades.get(orderId);
    if (!secret) {
      throw new Error(`no active trade for order ${orderId}`);
    }
    return secret;
  }

  private async roundtrip(
    tradeSecret: string,
    message: Message,
    ...expectedActions: string[]
  ): Promise<MessageKind> {
    if (!this.router) {
      throw new Error("client not started");
    }
    const identity = this.identitySecret;
    const wait = this.router.waitForDm(tradeSecret);
    await sendDm({
      pool: this.pool,
      relays: this.opts.relays,
      identitySecretHex: identity,
      tradeSecretHex: tradeSecret,
      receiverPubkeyHex: this.opts.mostroPubkey,
      message,
      router: this.router,
    });

    // Wait for a reply matching one of the expected actions (or CantDo).
    for (;;) {
      const event = (await Promise.race([
        wait,
        new Promise<never>((_, rej) =>
          setTimeout(() => rej(new Error("timeout waiting for Mostro reply")), FETCH_EVENTS_TIMEOUT_MS),
        ),
      ])) as NostrEvent;
      const unwrapped = unwrapMessageNip44({
        event: { kind: event.kind, pubkey: event.pubkey, content: event.content },
        receiverSecretHex: tradeSecret,
      });
      if (!unwrapped) {
        continue;
      }
      const action = unwrapped.message.value.action;
      if (action === "cant-do" || expectedActions.includes(action)) {
        return unwrapped.message.value;
      }
    }
  }
}

export type { Store, UserRow };