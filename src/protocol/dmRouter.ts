// DM router: request/response waiters + tracked-order subscription routing.
// Ported from mostrix `src/util/dm_utils/mod.rs` (listen_for_order_messages,
// wait_for_dm, send_dm) without the SQLite/TUI coupling.
//
// Responsibilities:
// - `sendDm`: wrap a Message into a kind-14 event and publish it.
// - `waitForDm`: register a waiter, send, then wait for the first decryptable
//   protocol DM addressed to the trade key (15s default).
// - `DmRouter`: background listener that subscribes to protocol DMs for
//   tracked trade keys + waiters, decrypts, and dispatches.

import { SimplePool } from "nostr-tools/pool";
import { finalizeEvent } from "nostr-tools/pure";
import type { NostrEvent, EventTemplate } from "nostr-tools/core";
import type { Filter } from "nostr-tools/filter";
import { hex } from "@scure/base";
import { Transport, transportEventKind } from "./transport.js";
import {
  unwrapMessageNip44,
  wrapMessageNip44,
  pubkeyFromSecret,
  verifyEventSignature,
} from "./transport.js";
import type { Message } from "./message.js";
import { identityProofPayload } from "./proof.js";

/** Default wait timeout for Mostro replies (mostrix FETCH_EVENTS_TIMEOUT). */
export const FETCH_EVENTS_TIMEOUT_MS = 15_000;
/** Cap on concurrently pending waiters (mostrix MAX_PENDING_WAITERS). */
const MAX_PENDING_WAITERS = 16;

export interface DmSendParams {
  pool: SimplePool;
  relays: string[];
  /** Identity key (index 0). Falls back to trade key for full-privacy. */
  identitySecretHex?: string;
  tradeSecretHex: string;
  receiverPubkeyHex: string;
  message: Message;
  /** NIP-40 expiration (unix seconds). Defaults to now + 30 days on v2. */
  expiration?: number;
  /** NIP-13 proof-of-work difficulty. */
  pow?: number;
  /** When set, the published event id is registered as own outbound. */
  router?: DmRouter;
}

/** Wrap + sign + publish a protocol DM as a kind-14 event. */
export async function sendDm(params: DmSendParams): Promise<string> {
  const { pool, relays, tradeSecretHex, receiverPubkeyHex, message } = params;
  const identitySecretHex = params.identitySecretHex ?? tradeSecretHex;
  const expiration = params.expiration ?? Math.floor(Date.now() / 1000) + 30 * 86400;

  const wrapped = wrapMessageNip44({
    message,
    identitySecretHex,
    tradeSecretHex,
    receiverPubkeyHex,
    opts: { signed: true },
  });

  const template: EventTemplate = {
    kind: 14,
    created_at: Math.floor(Date.now() / 1000),
    content: wrapped.content,
    tags: [["p", receiverPubkeyHex]],
  };
  if (expiration) {
    template.tags.push(["expiration", String(expiration)]);
  }

  const event = finalizeEvent(template, hex.decode(tradeSecretHex));
  await pool.publish(relays, event);
  // Register as our own outbound so the router never mistakes the relay echo
  // of this request for a daemon reply.
  params.router?.noteOutbound(event.id);
  return event.id;
}

/** Filter for inbound protocol DMs from Mostro on the active transport. */
export function filterProtocolDmFromMostro(
  transport: Transport,
  mostroPubkeyHex: string,
  tradePubkeyHex: string,
): Filter {
  const kind = transportEventKind(transport);
  if (transport === Transport.Nip44Direct && mostroPubkeyHex === tradePubkeyHex) {
    return { kinds: [kind], authors: [mostroPubkeyHex] };
  }
  return { kinds: [kind], authors: [mostroPubkeyHex], "#p": [tradePubkeyHex] };
}

/** A waiter awaiting the next protocol DM decryptable by its trade key. */
interface PendingWaiter {
  tradeSecretHex: string;
  resolve: (event: NostrEvent) => void;
  closed: () => boolean;
}

export interface DmRouterOptions {
  pool: SimplePool;
  relays: string[];
  mostroPubkeyHex: string;
  transport: Transport;
  /** Known trade secrets to subscribe immediately (order_id → trade_secret). */
  initialTrades?: Map<string, string>;
  /** Callback for tracked-order DMs (after waiter consumption). */
  onOrderMessage?: (orderId: string, message: Message, event: NostrEvent) => void;
  /**
   * Raw inbound DM callback for every decrypted protocol DM (including ones
   * that also satisfy a waiter). Use for message-history UIs (Messages tab);
   * distinct from onOrderMessage which fires for tracked orders only.
   */
  onMessage?: (orderId: string | null, message: Message, event: NostrEvent) => void;
}

/**
 * Background DM router.
 *
 * - `waitForDm(tradeSecretHex)` registers a waiter and returns a promise that
 *   resolves with the first decryptable protocol DM for that trade key.
 * - `trackOrder(orderId, tradeSecretHex)` subscribes the trade key and routes
 *   subsequent DMs to `onOrderMessage`.
 */
export class DmRouter {
  private pool: SimplePool;
  private relays: string[];
  private mostroPubkeyHex: string;
  private transport: Transport;
  private onOrderMessage?: (orderId: string, message: Message, event: NostrEvent) => void;
  private onMessage?: (orderId: string | null, message: Message, event: NostrEvent) => void;

  private waiters: PendingWaiter[] = [];
  private subscribedSecrets = new Set<string>();
  private orderBySubscription: Map<string, { orderId: string; tradeSecretHex: string }> =
    new Map();
  private subscriptionByPubkey = new Map<string, string>();
  private running = false;
  /** Event ids we published ourselves — never treated as daemon replies. */
  private ownOutboundIds = new Set<string>();

  constructor(opts: DmRouterOptions) {
    this.pool = opts.pool;
    this.relays = opts.relays;
    this.mostroPubkeyHex = opts.mostroPubkeyHex;
    this.transport = opts.transport;
    this.onOrderMessage = opts.onOrderMessage;
    this.onMessage = opts.onMessage;
    for (const [orderId, secret] of opts.initialTrades ?? []) {
      this.ensureSubscription(orderId, secret);
    }
  }

  /** Register a waiter for the next protocol DM decryptable by this trade key. */
  waitForDm(tradeSecretHex: string): Promise<NostrEvent> {
    return new Promise((resolve, reject) => {
      this.waiters.push({
        tradeSecretHex,
        resolve,
        closed: () => false,
      });
      this.subscribePubkey(tradeSecretHex).catch((e) => reject(e));
    });
  }

  /** Subscribe a trade key for ongoing tracked-order DMs. */
  trackOrder(orderId: string, tradeSecretHex: string): void {
    this.ensureSubscription(orderId, tradeSecretHex);
  }

  private ensureSubscription(orderId: string, tradeSecretHex: string): void {
    if (this.subscribedSecrets.has(tradeSecretHex)) {
      return;
    }
    this.subscribedSecrets.add(tradeSecretHex);
    this.subscribePubkey(tradeSecretHex).then((subscriptionId) => {
      if (subscriptionId) {
        this.orderBySubscription.set(subscriptionId, { orderId, tradeSecretHex });
      }
    });
  }

  private async subscribePubkey(tradeSecretHex: string): Promise<string | null> {
    const tradePubkey = pubkeyFromSecret(tradeSecretHex);
    if (this.subscriptionByPubkey.has(tradePubkey)) {
      return this.subscriptionByPubkey.get(tradePubkey)!;
    }
    const filter = filterProtocolDmFromMostro(this.transport, this.mostroPubkeyHex, tradePubkey);
    // Self-addressed admin (mostro nsec as trade key): daemon omits #p on
    // replies, so subscribe by author+kind only — matches mostrix.
    this.pool.subscribeMany(this.relays, filter, {
      onevent: (event) => this.handleEvent(event),
    });
    // Simplification: nostr-tools subscribeMany returns the subscription with
    // an `id` via `sub.sub` after connection; we key by a synthetic id we own.
    const syntheticId = `mostro-dm-${tradePubkey.slice(0, 16)}`;
    this.subscriptionByPubkey.set(tradePubkey, syntheticId);
    return syntheticId;
  }

  /** Register an event id we published (own outbound request). */
  noteOutbound(eventId: string): void {
    this.ownOutboundIds.add(eventId);
  }

  private handleEvent(event: NostrEvent): void {
    if (event.kind !== transportEventKind(this.transport)) {
      return;
    }
    // Outer event signature is mandatory: a relay or WebSocket peer can push
    // arbitrary events, so never trust event.pubkey without verifying it.
    if (!verifyEventSignature(event)) {
      return;
    }
    // Enforce the Mostro author filter client-side too (not just in the filter).
    if (event.pubkey !== this.mostroPubkeyHex) {
      return;
    }
    // Skip our own published request echo — the daemon reply is always a
    // different event id (covers self-addressed admin where author matches).
    if (this.ownOutboundIds.has(event.id)) {
      return;
    }
    // Consume waiters first (a waiter DM can also be a tracked-order DM).
    const remaining: PendingWaiter[] = [];
    for (const waiter of this.waiters) {
      if (waiter.closed()) {
        continue;
      }
      const unwrapped = tryUnwrap(event, waiter.tradeSecretHex);
      if (unwrapped !== null) {
        waiter.resolve(event);
      } else {
        remaining.push(waiter);
      }
    }
    this.waiters = remaining;

    // Route tracked-order DMs.
    const routed = this.routeTracked(event);
    if (routed) {
      this.onOrderMessage?.(routed.orderId, routed.message, event);
      this.onMessage?.(routed.orderId, routed.message, event);
      return;
    }
    // Untracked inbound DM: fire onMessage with orderId null (message-history
    // UIs can still render it); only if it decrypts with any known key.
    if (this.onMessage) {
      for (const { orderId, tradeSecretHex } of this.orderBySubscription.values()) {
        const unwrapped = tryUnwrap(event, tradeSecretHex);
        if (unwrapped !== null) {
          this.onMessage(orderId, unwrapped.message, event);
          return;
        }
      }
    }
  }

  private routeTracked(event: NostrEvent): { orderId: string; message: Message } | null {
    // Try each subscribed trade secret; first that decrypts wins.
    for (const { orderId, tradeSecretHex } of this.orderBySubscription.values()) {
      const unwrapped = tryUnwrap(event, tradeSecretHex);
      if (unwrapped !== null) {
        return { orderId, message: unwrapped.message };
      }
    }
    return null;
  }

  start(): void {
    if (this.running) {
      return;
    }
    this.running = true;
  }

  stop(): void {
    this.running = false;
  }
}

/** Try unwrap; null when not addressed to this key, throw propagates for malformed. */
function tryUnwrap(
  event: NostrEvent,
  tradeSecretHex: string,
): ReturnType<typeof unwrapMessageNip44> {
  try {
    return unwrapMessageNip44({
      event: { kind: event.kind, pubkey: event.pubkey, content: event.content },
      receiverSecretHex: tradeSecretHex,
      requireSignature: true,
    });
  } catch {
    return null;
  }
}

export { identityProofPayload };

// ---------------------------------------------------------------------------
// Restart recovery — relay DM replay (mostrix fetch_and_replay_startup_trade_dms)
// ---------------------------------------------------------------------------

export interface ReplayedDm {
  orderId: string;
  tradeSecretHex: string;
  message: Message;
  created_at: number;
}

/**
 * Replay protocol DMs for a set of (order_id → trade_secret) pairs from the
 * relay, decrypting each with its trade key. Used at startup to reconstruct
 * in-flight trade state without a local message DB (stateless recovery).
 */
export async function replayTradeDms(params: {
  pool: SimplePool;
  relays: string[];
  mostroPubkeyHex: string;
  transport: Transport;
  /** order_id → trade secret hex (from DB active orders). */
  trades: Map<string, string>;
  /** Fetch only DMs newer than this unix timestamp (seconds). */
  since?: number;
}): Promise<ReplayedDm[]> {
  const { pool, relays, mostroPubkeyHex, transport, trades, since } = params;
  const results: ReplayedDm[] = [];

  for (const [orderId, tradeSecretHex] of trades) {
    const tradePubkey = pubkeyFromSecret(tradeSecretHex);
    const filter = filterProtocolDmFromMostro(transport, mostroPubkeyHex, tradePubkey);
    if (since) {
      filter.since = since;
    }
    const events = await pool.querySync(relays, filter);
    for (const event of events) {
      if (event.kind !== transportEventKind(transport)) {
        continue;
      }
      if (!verifyEventSignature(event) || event.pubkey !== mostroPubkeyHex) {
        continue;
      }
      const unwrapped = tryUnwrap(event, tradeSecretHex);
      if (unwrapped === null) {
        continue;
      }
      results.push({
        orderId,
        tradeSecretHex,
        message: unwrapped.message,
        created_at: event.created_at,
      });
    }
  }

  results.sort((a, b) => a.created_at - b.created_at);
  return results;
}