// High-level Mostro client facade — the API a UI plugs into.
//
// Wraps the protocol layer (DM router, order book, applicator, restore) into a
// small surface: start/stop, order book subscription, create/take order,
// trade state events, invoice submission, restore. All persistence goes
// through the injected Store.

import { SimplePool } from "nostr-tools/pool";
import type { NostrEvent } from "nostr-tools/core";
import type { Message, MessageKind, Payload } from "./message.js";
import type { SmallOrder } from "./order.js";
import { deriveIdentityKeys } from "./keys.js";
import type { Store, UserRow } from "./store.js";
import { DmRouter, sendDm, FETCH_EVENTS_TIMEOUT_MS } from "./dmRouter.js";
import { unwrapMessageNip44, pubkeyFromSecret } from "./transport.js";
import { deriveChatKeys } from "./chatKeys.js";
import { wrapChatMessage, unwrapChatMessage } from "./chat.js";
import type { ChatMessage } from "./chat.js";
import { fetchPublicOrderBook } from "./orderbook.js";
import { applyTradeDm } from "./applicator.js";
import { restoreSession } from "./restore.js";
import { buildNewOrder, buildTradeMessage, buildTakeOrderPayload, takeActionForOrder, newRequestId, handleNewOrderResponse, handleTakeOrderResponse, buildDisputeMessage, handleDisputeNotification, computeNextTradePayload } from "./flow.js";
import { buildInvoiceMessage, handleAddInvoiceResponse } from "./invoice.js";
import { buildRateUserMessage, handleRateUserResponse } from "./flow.js";
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
  /** Persistence backend — inject openNodeSqliteStore / openBunSqliteStore /
   * openIndexedDbStore. Required (no implicit runtime choice). */
  store: Store;
  /** Fiat currency filter for the order book (empty = all). */
  currencies?: string[];
}

/** Minimal reactive-store binding the client pushes into (see react/store.ts). */
export interface ClientStoreSink {
  setOrders: (orders: import("./order.js").SmallOrder[]) => void;
  upsertTrade: (orderId: string, row: { status?: string | null; lastAction?: string | null; disputeId?: string | null }) => void;
  setInstanceInfo?: (info: import("./mostroInfo.js").MostroInstanceInfo | null) => void;
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
  /** Optional reactive sink (React store) the client pushes into. */
  private sink: ClientStoreSink | null = null;
  /** order_id → inbound DM history (for Messages-style UIs). */
  private messageHistory = new Map<string, Array<{ timestamp: number; message: Message }>>();
  /** order_id → callback when a new DM arrives for that order. */
  private messageHandlers = new Map<string, (dm: { timestamp: number; message: Message }) => void>();
  /** Global inbound-DM callback (any order), for invoice extraction UIs. */
  private anyMessageHandler: ((orderId: string, dm: { timestamp: number; message: Message }) => void) | null = null;
  /** order_id → user↔solver dispute chat history. */
  private disputeChatHistory = new Map<string, ChatMessage[]>();
  /** order_id → callback on a new dispute chat message. */
  private disputeChatHandlers = new Map<string, (msg: ChatMessage) => void>();
  /** order_id → user↔user (peer) order chat history. */
  private orderChatHistory = new Map<string, ChatMessage[]>();
  /** order_id → callback on a new peer chat message. */
  private orderChatHandlers = new Map<string, (msg: ChatMessage) => void>();
  /** Dedupe: conversation pubkey → subscribed. */
  private chatSubscribed = new Set<string>();
  /** Dedupe: outer chat event id → recorded. */
  private chatSeen = new Set<string>();

  // Identity/trade keys derived from the mnemonic.
  private identitySecret: string;
  private identityPubkey: string;

  constructor(opts: MostroClientOptions) {
    this.opts = opts;
    this.pool = new SimplePool();
    this.store = opts.store;
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
    if (this.sink?.setInstanceInfo) {
      this.sink.setInstanceInfo(info);
    }

    this.router = new DmRouter({
      pool: this.pool,
      relays: this.opts.relays,
      mostroPubkeyHex: this.opts.mostroPubkey,
      transport: info.protocol_version === 2 ? "nip44" : "gift-wrap",
      onOrderMessage: (orderId, message, event) => this.handleInboundDm(orderId, message),
      onMessage: (orderId, message, event) => {
        this.recordMessage(orderId, message, event.created_at);
        // Order payloads carry the counterpart trade pubkey; subscribe peer
        // chat once it is recorded.
        if (orderId) void this.trackOrderChat(orderId);
      },
    });

    // Restore in-flight orders from the store so DMs route correctly.
    const { TERMINAL_DM_STATUSES } = await import("./statusSets.js");
    const active = await this.store.getActiveOrders(TERMINAL_DM_STATUSES);
    for (const order of active) {
      if (order.trade_keys && order.trade_index !== null) {
        this.trades.set(order.id, order.trade_keys);
        this.router.trackOrder(order.id, order.trade_keys);
      }
      if (order.solver_pubkey) {
        await this.trackDisputeChat(order.id);
      }
      await this.hydrateChat(order.id);
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

  /**
   * Subscribe to per-order inbound DMs (Messages tab). The handler fires for
   * every new protocol DM routed to this order; history is also retained so a
   * fresh tab can render the full timeline.
   */
  onMessage(orderId: string, handler: (dm: { timestamp: number; message: Message }) => void): void {
    this.messageHandlers.set(orderId, handler);
  }

  /** Subscribe to inbound DMs for every order (e.g. to surface payment requests). */
  onAnyMessage(handler: (orderId: string, dm: { timestamp: number; message: Message }) => void): void {
    this.anyMessageHandler = handler;
  }

  /** The inbound DM timeline for an order (chronological). */
  getMessages(orderId: string): Array<{ timestamp: number; message: Message }> {
    return this.messageHistory.get(orderId) ?? [];
  }

  private recordMessage(orderId: string | null, message: Message, timestamp: number): void {
    if (!orderId) {
      return;
    }
    const list = this.messageHistory.get(orderId) ?? [];
    list.push({ timestamp, message });
    this.messageHistory.set(orderId, list);
    this.messageHandlers.get(orderId)?.({
      timestamp,
      message,
    });
    this.anyMessageHandler?.(orderId, { timestamp, message });
  }

  /** Register an event id we published (own outbound request). */
  noteOutbound(eventId: string): void {
    this.router?.noteOutbound(eventId);
  }

  /**
   * Bind a reactive sink (e.g. the React zustand store). The client pushes
   * order-book snapshots and trade-state updates into it. Use instead of
   * manual onOrders/onTrade when a UI store is present.
   */
  bind(sink: ClientStoreSink): void {
    this.sink = sink;
    if (this.orderBookHandler) {
      this.orderBookHandler = null; // sink owns the book now
    }
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
    /** Premium percentage over market price (defaults to 0). */
    premium?: number;
  }): Promise<CreateOrderResult> {
    const { nextIndex: tradeIndex, keys: tradeKeys } = await this.store.reserveNextTradeIndex(
      this.opts.mnemonic,
      1,
    );

    const { message, requestId } = buildNewOrder(
      { lastTradeIndex: tradeIndex - 1 },
      {
        kind: input.kind,
        fiatAmount: input.fiatAmount,
        fiatCode: input.fiatCode,
        amount: input.amount,
        paymentMethod: input.paymentMethod,
        minAmount: input.minAmount,
        maxAmount: input.maxAmount,
        expirationDays: input.expirationDays,
        premium: input.premium,
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
    const { nextIndex: tradeIndex, keys: tradeKeys } = await this.store.reserveNextTradeIndex(
      this.opts.mnemonic,
      1,
    );
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

  /** Send FiatSent or Release for an order. For a maker range order with
   * remaining amount, attaches the NextTrade payload so Mostro republishes the
   * remainder as a fresh pending order. */
  async sendTradeAction(orderId: string, action: "fiat-sent" | "release"): Promise<void> {
    const tradeSecret = this.requireTradeSecret(orderId);
    const order = await this.store.getOrder(orderId);
    let payload: Payload | null = null;
    if (order?.is_mine === 1 && order.min_amount != null && order.max_amount != null) {
      payload = await computeNextTradePayload({
        order: {
          min_amount: order.min_amount,
          max_amount: order.max_amount,
          fiat_amount: order.fiat_amount,
          // computeNextTradePayload only reads the range fields above.
        } as unknown as import("./order.js").SmallOrder,
        reserveNext: async (noneBase) => {
          const r = await this.store.reserveNextTradeIndex(this.opts.mnemonic, noneBase);
          return { nextIndex: r.nextIndex, keys: { pubkey: r.keys.pubkey } };
        },
      });
    }
    const message = buildTradeMessage({ orderId, requestId: newRequestId(), action, payload });
    await this.roundtrip(tradeSecret, message, "fiat-sent-ok", "hold-invoice-payment-settled");
  }

  /**
   * Cancel an order. Both parties send this to cooperatively cancel an active
   * trade; a maker (or taker) may also cancel a not-yet-active (pending) order
   * unilaterally, where Mostro answers `canceled`.
   */
  async cancelOrder(orderId: string): Promise<void> {
    const tradeSecret = this.requireTradeSecret(orderId);
    const message = buildTradeMessage({ orderId, requestId: newRequestId(), action: "cancel", payload: null });
    await this.roundtrip(
      tradeSecret,
      message,
      "cooperative-cancel-initiated-by-you",
      "cooperative-cancel-accepted",
      "canceled",
    );
  }

  /** Open a dispute on an order. */
  async openDispute(orderId: string): Promise<string> {
    const tradeSecret = this.requireTradeSecret(orderId);
    const message = buildDisputeMessage({ orderId, requestId: newRequestId() });
    const reply = await this.roundtrip(tradeSecret, message, "dispute-initiated-by-you", "dispute-initiated-by-peer");
    return handleDisputeNotification(reply).disputeId;
  }

  /** Rate the counterpart of a completed trade (1..=5). */
  async rateUser(orderId: string, rating: number): Promise<void> {
    const tradeSecret = this.requireTradeSecret(orderId);
    const requestId = newRequestId();
    const message = buildRateUserMessage({ orderId, requestId, rating });
    const reply = await this.roundtrip(tradeSecret, message, "rate-received");
    handleRateUserResponse(reply, requestId);
  }

  /** Subscribe to user↔solver dispute chat for an order. */
  onDisputeChat(orderId: string, handler: (msg: ChatMessage) => void): void {
    this.disputeChatHandlers.set(orderId, handler);
  }

  /** Subscribe to user↔user (peer) order chat for an order. */
  onOrderChat(orderId: string, handler: (msg: ChatMessage) => void): void {
    this.orderChatHandlers.set(orderId, handler);
  }

  /** Peer chat history for an order (session-scoped). */
  getOrderChat(orderId: string): ChatMessage[] {
    return this.orderChatHistory.get(orderId) ?? [];
  }

  /** Send a message to the trade counterpart (encrypted user↔user chat). */
  async sendOrderChat(orderId: string, message: string): Promise<void> {
    const peer = await this.peerTradeKeys(orderId);
    if (!peer) {
      throw new Error(`no counterpart trade key known yet for order ${orderId}`);
    }
    const chat = deriveChatKeys(peer.secret, peer.pubkey);
    const { event } = wrapChatMessage({
      senderTradeSecretHex: peer.secret,
      convSecretHex: chat.convSecretHex,
      convPubkeyHex: chat.convPubkeyHex,
      signSecretHex: chat.signSecretHex,
      message,
    });
    await this.pool.publish(this.opts.relays, event);
    this.recordOrderChat(orderId, {
      content: message,
      sender: pubkeyFromSecret(peer.secret),
      created_at: event.created_at,
      innerEventId: "",
      outerEventId: event.id,
    });
  }

  /**
   * Resolve the counterpart trade pubkey for an order from the protocol DMs
   * already seen (order payloads carry buyer/seller trade pubkeys).
   */
  private async peerTradeKeys(orderId: string): Promise<{ secret: string; pubkey: string } | null> {
    const secret = this.trades.get(orderId);
    if (!secret) return null;
    const order = await this.store.getOrder(orderId);
    if (order?.counterparty_pubkey) {
      return { secret, pubkey: order.counterparty_pubkey };
    }
    const myPub = pubkeyFromSecret(secret);
    for (const dm of this.messageHistory.get(orderId) ?? []) {
      const p = dm.message.value.payload;
      if (p && p.variant === "order") {
        const o = p.value;
        if (o.buyer_trade_pubkey && o.buyer_trade_pubkey !== myPub) {
          return { secret, pubkey: o.buyer_trade_pubkey };
        }
        if (o.seller_trade_pubkey && o.seller_trade_pubkey !== myPub) {
          return { secret, pubkey: o.seller_trade_pubkey };
        }
      }
    }
    return null;
  }

  /** Whether the counterpart trade key is known yet (peer chat available). */
  async canOrderChat(orderId: string): Promise<boolean> {
    return (await this.peerTradeKeys(orderId)) !== null;
  }

  /** Subscribe the user↔user chat conversation for an order, once the peer is known. */
  private async trackOrderChat(orderId: string): Promise<void> {
    const peer = await this.peerTradeKeys(orderId);
    if (!peer) return;
    const chat = deriveChatKeys(peer.secret, peer.pubkey);
    if (this.chatSubscribed.has(chat.convPubkeyHex)) return;
    this.chatSubscribed.add(chat.convPubkeyHex);
    const myTradePubkey = pubkeyFromSecret(peer.secret);
    const peerPubkey = peer.pubkey;
    this.pool.subscribeMany(this.opts.relays, { kinds: [14], authors: [chat.signPubkeyHex], since: Math.floor(Date.now() / 1000) - 7 * 86400 }, {
      onevent: (event) => {
        try {
          const msg = unwrapChatMessage({
            convSecretHex: chat.convSecretHex,
            convPubkeyHex: chat.convPubkeyHex,
            signPubkeyHex: chat.signPubkeyHex,
            allowedSigners: [myTradePubkey, peerPubkey],
            outer: event,
            now: Math.floor(Date.now() / 1000),
          });
          this.recordOrderChat(orderId, msg);
        } catch {
          // Not a valid conversation message.
        }
      },
    });
  }

  private recordOrderChat(orderId: string, msg: ChatMessage): void {
    if (msg.outerEventId && this.chatSeen.has(msg.outerEventId)) return;
    if (msg.outerEventId) this.chatSeen.add(msg.outerEventId);
    const list = this.orderChatHistory.get(orderId) ?? [];
    list.push(msg);
    this.orderChatHistory.set(orderId, list);
    void this.store.saveChatMessage({
      outer_event_id: msg.outerEventId,
      order_id: orderId,
      scope: "order",
      sender: msg.sender,
      content: msg.content,
      created_at: msg.created_at,
      inner_event_id: msg.innerEventId,
    });
    this.orderChatHandlers.get(orderId)?.(msg);
  }

  /** Dispute chat history for an order (session-scoped). */
  getDisputeChat(orderId: string): ChatMessage[] {
    return this.disputeChatHistory.get(orderId) ?? [];
  }

  /** Send a message to the dispute solver (encrypted user↔solver chat). */
  async sendDisputeChat(orderId: string, message: string): Promise<void> {
    const tradeSecret = this.requireTradeSecret(orderId);
    const order = await this.store.getOrder(orderId);
    if (!order?.solver_pubkey || !order.dispute_chat_shared_key_hex) {
      throw new Error(`no solver assigned to order ${orderId}`);
    }
    const chat = deriveChatKeys(tradeSecret, order.solver_pubkey);
    const { event } = wrapChatMessage({
      senderTradeSecretHex: tradeSecret,
      convSecretHex: chat.convSecretHex,
      convPubkeyHex: chat.convPubkeyHex,
      signSecretHex: chat.signSecretHex,
      message,
    });
    await this.pool.publish(this.opts.relays, event);
    this.recordDisputeChat(orderId, {
      content: message,
      sender: pubkeyFromSecret(tradeSecret),
      created_at: event.created_at,
      innerEventId: "",
      outerEventId: event.id,
    });
  }

  /**
   * Subscribe the user↔solver chat conversation for a disputed order. The
   * solver pubkey + shared key come from the AdminTookDispute DM (applicator)
   * or a prior restore.
   */
  private async trackDisputeChat(orderId: string): Promise<void> {
    const tradeSecret = this.trades.get(orderId);
    const order = await this.store.getOrder(orderId);
    if (!tradeSecret || !order?.solver_pubkey || !order.dispute_chat_shared_key_hex) {
      return;
    }
    const chat = deriveChatKeys(tradeSecret, order.solver_pubkey);
    if (this.chatSubscribed.has(chat.convPubkeyHex)) {
      return;
    }
    this.chatSubscribed.add(chat.convPubkeyHex);
    const myTradePubkey = pubkeyFromSecret(tradeSecret);
    const solverPubkey = order.solver_pubkey;
    this.pool.subscribeMany(this.opts.relays, { kinds: [14], authors: [chat.signPubkeyHex], since: Math.floor(Date.now() / 1000) - 7 * 86400 }, {
      onevent: (event) => {
        try {
          const msg = unwrapChatMessage({
            convSecretHex: chat.convSecretHex,
            convPubkeyHex: chat.convPubkeyHex,
            signPubkeyHex: chat.signPubkeyHex,
            allowedSigners: [myTradePubkey, solverPubkey],
            outer: event,
            now: Math.floor(Date.now() / 1000),
          });
          this.recordDisputeChat(orderId, msg);
        } catch {
          // Not a valid conversation message (replay / other channel).
        }
      },
    });
  }

  private recordDisputeChat(orderId: string, msg: ChatMessage): void {
    if (msg.outerEventId && this.chatSeen.has(msg.outerEventId)) return;
    if (msg.outerEventId) this.chatSeen.add(msg.outerEventId);
    const list = this.disputeChatHistory.get(orderId) ?? [];
    list.push(msg);
    this.disputeChatHistory.set(orderId, list);
    void this.store.saveChatMessage({
      outer_event_id: msg.outerEventId,
      order_id: orderId,
      scope: "dispute",
      sender: msg.sender,
      content: msg.content,
      created_at: msg.created_at,
      inner_event_id: msg.innerEventId,
    });
    this.disputeChatHandlers.get(orderId)?.(msg);
  }

  /** Load persisted chat for an order into memory (idempotent). */
  private async hydrateChat(orderId: string): Promise<void> {
    if (this.orderChatHistory.has(orderId)) return;
    const [order, dispute] = await Promise.all([
      this.store.getChatMessages(orderId, "order"),
      this.store.getChatMessages(orderId, "dispute"),
    ]);
    const toMsg = (r: { sender: string; content: string; created_at: number; inner_event_id: string; outer_event_id: string }): ChatMessage => ({
      content: r.content,
      sender: r.sender,
      created_at: r.created_at,
      innerEventId: r.inner_event_id,
      outerEventId: r.outer_event_id,
    });
    this.orderChatHistory.set(orderId, order.map(toMsg));
    this.disputeChatHistory.set(orderId, dispute.map(toMsg));
    for (const r of [...order, ...dispute]) this.chatSeen.add(r.outer_event_id);
  }

  /** Restore session state from Mostro (rebuilds store + trade routing). */
  async restore(): Promise<void> {
    const existing = await this.store.getUser();
    await this.store.upsertUser({
      i0_pubkey: this.identityPubkey,
      mnemonic: this.opts.mnemonic,
      last_trade_index: existing?.last_trade_index ?? 0,
      created_at: existing?.created_at ?? Math.floor(Date.now() / 1000),
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
      if (order.solver_pubkey) {
        await this.trackDisputeChat(order.id);
      }
      await this.hydrateChat(order.id);
    }
  }

  // -------------------------------------------------------------------------
  // internals
  // -------------------------------------------------------------------------

  private async refreshOrderBook(): Promise<void> {
    const orders = await this.fetchOrders().catch(() => []);
    if (this.sink) {
      this.sink.setOrders(orders);
    }
    this.orderBookHandler?.(orders);
  }

  private async handleInboundDm(orderId: string, message: Message): Promise<void> {
    const tradeSecret = this.trades.get(orderId);
    if (!tradeSecret) {
      return;
    }
    const result = await applyTradeDm({ store: this.store, orderId, tradeSecretHex: tradeSecret, message });
    if (result.solver) {
      await this.trackDisputeChat(orderId);
    }
    if (this.sink) {
      this.sink.upsertTrade(orderId, {
        status: result.status,
        lastAction: result.action,
        disputeId: result.disputeId,
      });
    }
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
    // Register a fresh waiter per iteration: a non-matching DM (e.g. a state
    // update racing the reply) consumes the previous waiter, so re-using it
    // would loop forever on the same event.
    for (;;) {
      const wait = this.router.waitForDm(tradeSecret);
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